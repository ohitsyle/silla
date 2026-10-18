/**
 * The reservation engine — RES-1, RES-2, RES-3, RES-5, RES-7 (spec §9–§11).
 *
 * One function decides whether a unit can be held for a window,
 * `checkTarget`, and every caller goes through it:
 *
 *   claimReservation           commits a booking (walk-ins share claimInSession,
 *                              via occupancy.js, so they can cancel in the same step)
 *   reservationAvailability    answers "could I?" for the booking form; writes nothing
 *   assertActivationAvailable  re-checks at check-in, for someone arriving early
 *
 * What the MEMBER may hold — one current session, one upcoming booking,
 * never overlapping — is standing.js, checked in the same transaction as
 * the unit's own rules.
 *
 * RES-2: a claim commits inside withSpaceTransaction (services/spaces.js),
 * after a real write to the organization's spaceRevision. Read that comment
 * before changing anything here. A transaction that only READS its
 * constraints still lets a whole-room booking and a seat booking inside the
 * room both commit, because they have different ids and nothing collides —
 * the old lowest-ObjectId tie-break only ever compared identical units.
 *
 * Nothing escapes before commit: the map update and the confirmation email
 * go out only once the transaction has committed, so a claim that is
 * retried or refused never told anybody anything.
 */
import Floor from "../../models/Floor.js";
import Organization from "../../models/Organization.js";
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import ResourceType from "../../models/ResourceType.js";
import Room from "../../models/Room.js";
import User from "../../models/User.js";
import { emitUnitStatus } from "../realtime.js";
import { sendEmail } from "../email/index.js";
import { reservationConfirmedEmail } from "../email/templates.js";
import { EntitlementError, assertFeature } from "../entitlements.js";
import { SpaceError, roomContents, roomForResource, withSpaceTransaction } from "../spaces.js";
import {
  LIVE_STATUSES,
  assertOrganizationBookable,
  assertWithinMaxStay,
  assertWithinOperatingHours,
  findClosureConflict,
} from "./availability.js";
import { ReservationError } from "./errors.js";
import { assertMayHold, graceOf, memberStanding } from "./standing.js";

export { ReservationError };

/** The organization's own word for a bookable unit — never a hardcoded "seat". */
const nounOf = (org) => org?.terminology?.resourceNoun || "resource";

/**
 * withSpaceTransaction, speaking the engine's error type.
 *
 * The kiosk's routes only know ReservationError. A BUSY SpaceError reaching
 * them would surface as a 500 rather than "please try again", so the guard's
 * errors are re-told in the engine's own type, unchanged.
 */
export async function transact(organizationId, fn) {
  try {
    return await withSpaceTransaction(organizationId, fn);
  } catch (err) {
    if (err instanceof SpaceError) throw new ReservationError(err.message, err.status, err.code);
    throw err;
  }
}

/* ─────────────────────────────── map status ─────────────────────────────── */

/** How many times a unit's status is re-derived before the last answer stands. */
const SYNC_ATTEMPTS = 4;

/**
 * Recomputes a unit's map status from its live reservations, writes it to
 * the Resource, and streams the change (MAP-2).
 *
 * The status is DERIVED, never set by hand in two places — that is how
 * "reserved" and "occupied" stay honest as reservations move through their
 * lifecycle. A whole-room target's change goes to every floor the room
 * reaches, since each of them draws it.
 *
 * Derive, write, then derive AGAIN and keep going until two answers agree.
 * Two refreshes of one unit can interleave — a check-in's and the minute
 * worker's, say — and the one that read the reservations FIRST can write
 * LAST, leaving a seat showing "reserved" under somebody sitting in it,
 * with nothing due to correct it. The re-read after the write is what
 * makes the final value right: whichever refresh writes last also reads
 * after writing, so it sees every change committed before that and puts
 * the truth back. Any change committed later runs its own refresh.
 */
export async function syncUnitStatus(resourceId, unitLabel, { io } = {}) {
  let resource = await Resource.findById(resourceId);
  let unit = resource?.units.find((candidate) => candidate.label === unitLabel);
  if (!unit) return null;

  let written = null;
  for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
    const derived = await deriveUnitStatus(resourceId, unit);
    if (written && derived.status === written.status && derived.overstay === written.overstay) break;
    resource = await Resource.findOneAndUpdate(
      { _id: resourceId },
      { $set: { "units.$[unit].status": derived.status, "units.$[unit].overstay": derived.overstay } },
      { arrayFilters: [{ "unit.label": unitLabel }], new: true }
    );
    if (!resource) return null; // removed meanwhile; nothing left to draw
    unit = resource.units.find((candidate) => candidate.label === unitLabel);
    written = derived;
  }

  const units = resource.units.map((u) => ({ status: u.status, serviceStatus: u.serviceStatus, overstay: u.overstay }));
  for (const floorId of await floorsShowing(resource)) {
    emitUnitStatus(io, { floorId, resourceId: String(resource._id), units });
  }
  return resource;
}

/**
 * syncUnitStatus for a change that has ALREADY committed.
 *
 * The reservation stands whether or not the map hears about it, so a
 * failure here is logged rather than thrown. Thrown, it would turn a
 * booking that exists into an error response — and a member told
 * "something went wrong" books again and is refused for already holding
 * one. The next change to the unit, or the minute worker, redraws it.
 */
export async function announceUnitStatus(resourceId, unitLabel, { io } = {}) {
  try {
    return await syncUnitStatus(resourceId, unitLabel, { io });
  } catch (err) {
    console.error(`[reservations] map status for ${resourceId}/${unitLabel} not refreshed:`, err.message);
    return null;
  }
}

/** The status a unit should show now, from its own state and its live reservations. */
async function deriveUnitStatus(resourceId, unit) {
  // A unit taken out of circulation stays unavailable whatever is booked
  // (spec §8: marking a piece unavailable cascades to its units).
  if (unit.serviceStatus === "out_of_service") return { status: "unavailable", overstay: false };

  // One read: anyone checked in, or a booking whose window is open now.
  const now = new Date();
  const live = await Reservation.find({
    resource: resourceId,
    unitLabel: unit.label,
    $or: [{ status: "active" }, { status: "held", startTime: { $lte: now }, endTime: { $gt: now } }],
  }).select("status overstay");
  const active = live.find((reservation) => reservation.status === "active");

  let status = "available";
  if (active) status = "occupied";
  else if (live.length) status = "reserved";
  else if (unit.status === "unavailable") status = "unavailable"; // set by staff, kept
  return { status, overstay: Boolean(active?.overstay) };
}

/** The floors whose map draws this resource: every level of a room, else its own floor. */
async function floorsShowing(resource) {
  if (resource.kind === "room") {
    const room = await Room.findById(resource.room);
    if (room) return room.levels.map((level) => String(level.floor));
  }
  const floor = await Floor.findById(resource.floor).select("_id");
  return floor ? [String(floor._id)] : [];
}

/* ─────────────────────────── the one availability rule ─────────────────────────── */

/**
 * Whether `unitLabel` on `resourceId` can be held from `start` to `end`.
 *
 * Throws a ReservationError for the first rule the window breaks, and
 * returns the label the reservation will carry ("Long Table · 3", or the
 * room's name). The order is deliberate: the organization's policy, then
 * the unit itself, then its room, then closures, then other bookings — so
 * the reason given is the most fundamental one.
 *
 *   maxStayStart  differs from `start` only at check-in: someone arriving
 *                 early occupies from now, but their stay is still measured
 *                 from the time they booked.
 *   excludeId     the reservation being activated, so it never conflicts
 *                 with itself.
 *   newBooking    true for a claim or a preview. A plan without whole-room
 *                 booking refuses NEW whole-room bookings only; one made
 *                 before a downgrade can still be checked into.
 */
async function checkTarget({
  organizationId, resourceId, unitLabel, start, end, org,
  maxStayStart = start, session = null, excludeId = null, newBooking = false,
}) {
  assertPolicy(org, { start, end, maxStayStart });

  const resource = await Resource.findOne({ _id: resourceId, organization: organizationId }).session(session);
  if (!resource) throw new ReservationError("Resource not found", 404);
  const unit = resource.units.find((candidate) => candidate.label === String(unitLabel));
  if (!unit) throw new ReservationError("That unit does not exist.", 404);
  const type = await ResourceType.findById(resource.resourceType).session(session);
  assertUnitUsable(unit, type, org, { isRoom: resource.kind === "room" });

  const room = await roomForResource(resource, session);
  if (resource.kind === "room" && !room) throw new ReservationError("Room not found", 404);
  const scope = room
    ? await roomScope({ resource, unitLabel, room, org, session, newBooking })
    : { resource: resource._id, unitLabel: String(unitLabel) };

  const floor = await Floor.findById(resource.floor).session(session);
  const closure = await findClosureConflict(
    { organizationId, siteId: floor?.site, startTime: start, endTime: end },
    session
  );
  if (closure) throw new ReservationError(`That period is closed: ${closure.reason}`, 409, "CLOSURE");

  if (await findConflict(scope, { start, end, excludeId, session })) {
    throw new ReservationError(
      room
        ? `${room.name}, or something inside it, is already booked for part of that time.`
        : `That ${nounOf(org)} is already booked for part of that time.`,
      409,
      "CONFLICT"
    );
  }

  return resource.kind === "room" ? room.name : `${type.label} · ${unitLabel}`;
}

/** RES-5 / RES-7 — the organization's own rules, which apply to every unit alike. */
function assertPolicy(org, { start, end, maxStayStart }) {
  const closed = assertOrganizationBookable(org);
  if (closed) throw new ReservationError(closed, 409, "ORG_CLOSED");
  const tooLong = assertWithinMaxStay(org, maxStayStart, end);
  if (tooLong) throw new ReservationError(tooLong, 400, "MAX_STAY");
  const outside = assertWithinOperatingHours(org, start, end);
  if (outside) throw new ReservationError(outside, 400, "OPERATING_HOURS");
}

/**
 * The unit's own state. A room's booking target is skipped for
 * "unavailable": for a room that means closed by staff, and roomScope says
 * so in those words rather than calling the room an unavailable resource.
 */
function assertUnitUsable(unit, type, org, { isRoom = false } = {}) {
  const noun = nounOf(org);
  if (!type?.reservable) throw new ReservationError("That item is not bookable.", 409);
  if (unit.serviceStatus === "out_of_service") {
    throw new ReservationError(`That ${noun} is out of service.`, 409, "OUT_OF_SERVICE");
  }
  if (!isRoom && unit.status === "unavailable") {
    throw new ReservationError(`That ${noun} is unavailable.`, 409, "UNAVAILABLE");
  }
}

/**
 * A room's rules, on top of the unit's own. Returns what the window must
 * not overlap:
 *
 *   the whole room   its own target AND every piece inside, on every level
 *   a piece inside   its own unit AND the room's target
 *
 * So a whole-room booking conflicts with everything in it, while two seats
 * in the same room stay independently bookable.
 */
async function roomScope({ resource, unitLabel, room, org, session, newBooking }) {
  const target = resource.kind === "room" ? resource : await Resource.findById(room.resource).session(session);
  if (target?.units[0]?.status === "unavailable") {
    throw new ReservationError(`${room.name} is closed right now.`, 409, "ROOM_CLOSED");
  }

  if (resource.kind !== "room") {
    if (room.bookingMode === "whole") {
      throw new ReservationError(`${room.name} is booked as a whole room, not one ${nounOf(org)} at a time.`, 409, "ROOM_MODE");
    }
    return { $or: [{ resource: resource._id, unitLabel: String(unitLabel) }, { resource: room.resource }] };
  }

  if (room.bookingMode === "individual") {
    throw new ReservationError(`${room.name} is booked one ${nounOf(org)} at a time. Pick one inside it.`, 409, "ROOM_MODE");
  }
  if (newBooking) await assertFeature(org, "wholeRoomBooking");
  const contents = await roomContents(room, session);
  return { resource: { $in: [room.resource, ...contents.map((piece) => piece._id)] } };
}

/**
 * A live booking in `scope` that overlaps the window.
 *
 * A session physically in progress also blocks any window starting now or
 * earlier, whatever its booked end says: someone overstaying is still
 * sitting there until they are released.
 */
function findConflict(scope, { start, end, excludeId, session }) {
  const overlaps = { startTime: { $lt: end }, endTime: { $gt: start } };
  const startsByNow = start <= new Date();
  return Reservation.exists({
    ...scope,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    status: { $in: LIVE_STATUSES },
    // $and, because a room scope brings its own $or.
    $and: [{ $or: [overlaps, ...(startsByNow ? [{ status: "active" }] : [])] }],
  }).session(session);
}

function parseWindow(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (!startTime || !endTime || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ReservationError("Choose valid start and end times.");
  }
  return { start, end };
}

/* ──────────────────────────────── the callers ──────────────────────────────── */

/**
 * OCC-1: an early arrival may not occupy a room while one of its levels or
 * seats is still in use. Called inside check-in's own transaction.
 */
export async function assertActivationAvailable(reservation, org, now, session) {
  return checkTarget({
    organizationId: reservation.organization,
    resourceId: reservation.resource,
    unitLabel: reservation.unitLabel,
    start: now < reservation.startTime ? now : reservation.startTime,
    end: reservation.endTime,
    maxStayStart: reservation.startTime,
    org,
    session,
    excludeId: reservation._id,
  });
}

/**
 * The booking form's "is this free?" — the same rules as the claim, without
 * a transaction and without revealing who holds what. Guidance only: the
 * claim checks everything again when it commits.
 */
export async function reservationAvailability({ organizationId, resourceId, unitLabel, startTime, endTime, memberId = null }) {
  let window;
  try {
    window = parseWindow(startTime, endTime);
  } catch (err) {
    return { bookable: false, error: err.message };
  }
  const org = await Organization.findById(organizationId);
  if (!org) throw new ReservationError("Organization not found", 404);
  try {
    await checkTarget({ organizationId, resourceId, unitLabel, ...window, org, newBooking: true });
    // Asked by a signed-in member, the answer includes what THEY may hold:
    // "free, but you already have a booking coming up" is the truth, and
    // finding it out only after typing the PIN is not.
    if (memberId) {
      const now = new Date();
      const standing = await memberStanding(memberId, { organizationId, now, graceMinutes: graceOf(org) });
      assertMayHold(standing, { ...window, now, graceMinutes: graceOf(org), noun: nounOf(org) });
    }
    return { bookable: true };
  } catch (err) {
    if (err instanceof ReservationError || err instanceof EntitlementError) {
      return { bookable: false, error: err.message, code: err.code };
    }
    throw err;
  }
}

/**
 * What a room offers for one window, for the member's room panel: the room
 * as a whole, and every bookable unit inside it, on every level.
 *
 * The same rules as checkTarget, in the same order, read in bulk: one query
 * for the room's bookings instead of several per unit, because a panel
 * listing twenty desks must not cost two hundred queries. Guidance only,
 * like reservationAvailability — the claim checks everything again — and
 * the spatial suite compares the two answers unit by unit so they cannot
 * quietly drift apart.
 *
 * An option the room does not have is left out rather than refused:
 * `whole` is null for a room booked one unit at a time, and `units` is
 * empty for a room booked only whole.
 */
export async function roomBookingOptions({ organizationId, roomId, startTime, endTime }) {
  const org = await Organization.findById(organizationId);
  if (!org) throw new ReservationError("Organization not found", 404);
  const room = await Room.findOne({ _id: roomId, organization: organizationId });
  if (!room) throw new ReservationError("Room not found", 404);

  const contents = await roomContents(room);
  const types = await ResourceType.find({ _id: { $in: contents.map((piece) => piece.resourceType) } });
  const typeById = new Map(types.map((type) => [String(type._id), type]));
  const candidates = room.bookingMode === "whole" ? [] : contents.flatMap((piece) => {
    const type = typeById.get(String(piece.resourceType));
    return type?.reservable ? piece.units.map((unit) => ({ piece, unit, type })) : [];
  });

  const refusal = (err) => ({ bookable: false, error: err.message, code: err.code || null });
  const refuseAll = (err) => ({
    whole: room.bookingMode === "individual" ? null : refusal(err),
    units: candidates.map((candidate) => ({ ...describe(candidate), ...refusal(err) })),
  });
  const shaped = (whole, units) => ({ roomId: String(room._id), bookingMode: room.bookingMode, whole, units });

  // ── Rules that apply to everything in the room alike ──
  let window;
  try {
    window = parseWindow(startTime, endTime);
    assertPolicy(org, { ...window, maxStayStart: window.start });
  } catch (err) {
    if (!(err instanceof ReservationError)) throw err;
    const all = refuseAll(err);
    return shaped(all.whole, all.units);
  }
  const target = await Resource.findById(room.resource);
  const closedRoom = target?.units[0]?.status === "unavailable"
    ? new ReservationError(`${room.name} is closed right now.`, 409, "ROOM_CLOSED")
    : null;
  const anyFloor = await Floor.findById(room.levels[0]?.floor).select("site");
  const closure = await findClosureConflict({
    organizationId, siteId: anyFloor?.site, startTime: window.start, endTime: window.end,
  });
  const closedPeriod = closure
    ? new ReservationError(`That period is closed: ${closure.reason}`, 409, "CLOSURE")
    : null;

  // ── Every live booking that touches the room in this window ──
  const startsByNow = window.start <= new Date();
  const booked = await Reservation.find({
    resource: { $in: [room.resource, ...contents.map((piece) => piece._id)] },
    status: { $in: LIVE_STATUSES },
    $or: [
      { startTime: { $lt: window.end }, endTime: { $gt: window.start } },
      ...(startsByNow ? [{ status: "active" }] : []),
    ],
  }).select("resource unitLabel");
  const roomBooked = booked.some((r) => String(r.resource) === String(room.resource));
  const unitsBooked = new Set(booked.map((r) => `${r.resource}:${r.unitLabel}`));

  // ── The room as a whole ──
  let whole = null;
  if (room.bookingMode !== "individual") {
    const planRefusal = await assertFeature(org, "wholeRoomBooking").then(() => null, (err) => err);
    const problem = closedRoom || planRefusal || closedPeriod || (booked.length
      ? new ReservationError(`${room.name}, or something inside it, is already booked for part of that time.`, 409, "CONFLICT")
      : null);
    whole = problem ? refusal(problem) : { bookable: true };
  }

  // ── Each unit inside, in checkTarget's order ──
  const units = candidates.map((candidate) => {
    let problem = null;
    try {
      assertUnitUsable(candidate.unit, candidate.type, org);
    } catch (err) {
      problem = err;
    }
    problem ||= closedRoom || closedPeriod;
    if (!problem && (roomBooked || unitsBooked.has(`${candidate.piece._id}:${candidate.unit.label}`))) {
      problem = new ReservationError(
        `${room.name}, or something inside it, is already booked for part of that time.`,
        409,
        "CONFLICT"
      );
    }
    return { ...describe(candidate), ...(problem ? refusal(problem) : { bookable: true }) };
  });

  return shaped(whole, units);
}

/** One unit inside a room, as the room panel lists it. */
function describe({ piece, unit, type }) {
  return {
    resourceId: String(piece._id),
    unitLabel: unit.label,
    floorId: String(piece.floor),
    typeLabel: type.label,
    position: piece.position,
  };
}

/**
 * The claim itself, inside a space transaction the CALLER holds: the unit's
 * rules (checkTarget), then the member's (standing.js), then the insert.
 *
 * Split out of claimReservation so a kiosk walk-in can cancel a member's
 * later booking and seat them in ONE transaction (occupancy.js): if this
 * throws, the cancellation rolls back with it and nothing is lost.
 *
 *   ignoreId  a reservation of the member's being cancelled in the same
 *             transaction, so the rule does not count it
 */
export async function claimInSession({
  session, org, organizationId, memberId, resourceId, unitLabel, start, end,
  activate = false, ignoreId = null,
}) {
  const member = await User.findOne({ _id: memberId, organization: organizationId, active: true })
    .session(session);
  if (!member) throw new ReservationError("Account not found", 404);

  const targetLabel = await checkTarget({
    organizationId, resourceId, unitLabel, start, end, org, session, newBooking: true,
  });

  // RES-3: one current session, one upcoming booking, never overlapping.
  // Read with the transaction's session, after its spaceRevision write, so
  // a member racing themselves is serialised like any other conflict.
  const now = new Date();
  const standing = await memberStanding(memberId, { organizationId, now, graceMinutes: graceOf(org), session });
  assertMayHold(standing, { start, end, activate, now, graceMinutes: graceOf(org), noun: nounOf(org), ignoreId });

  const [created] = await Reservation.create(
    [{
      organization: organizationId,
      member: memberId,
      resource: resourceId,
      targetLabel,
      unitLabel: String(unitLabel),
      startTime: start,
      endTime: end,
      status: activate ? "active" : "held",
      checkedInAt: activate ? start : null,
      checkInMethod: org.identity?.checkInMethod === "qr" ? "qr" : "rfid",
    }],
    { session }
  );
  return { reservation: created, targetLabel };
}

/** RES-1 / RES-2 / RES-3 — claim a unit for a window, atomically. */
export async function claimReservation({
  organizationId, memberId, resourceId, unitLabel, startTime, endTime,
  io = null, activate = false, notify = true,
}) {
  const { start, end } = parseWindow(startTime, endTime);

  const { reservation, targetLabel } = await transact(organizationId, (session, org) =>
    claimInSession({ session, org, organizationId, memberId, resourceId, unitLabel, start, end, activate })
  );

  // Committed — now, and only now, tell the map and the member. Neither
  // may turn a booking that exists into an error response.
  await announceUnitStatus(resourceId, String(unitLabel), { io });
  if (notify) {
    try {
      const [org, member] = await Promise.all([Organization.findById(organizationId), User.findById(memberId)]);
      if (member) {
        sendEmail(reservationConfirmedEmail({ org, user: member, reservation, resourceLabel: targetLabel }));
      }
    } catch (err) {
      console.error("[reservations] confirmation email not queued:", err.message);
    }
  }
  return reservation;
}

/** Member- or staff-initiated cancellation. */
export async function cancelReservation({ reservationId, organizationId, reason = null, io = null }) {
  const filter = { _id: reservationId, ...(organizationId ? { organization: organizationId } : {}) };
  const found = await Reservation.findOne(filter).select("organization");
  if (!found) throw new ReservationError("Reservation not found", 404);

  const reservation = await transact(found.organization, async (session) => {
    const current = await Reservation.findOne(filter).session(session);
    if (!current) throw new ReservationError("Reservation not found", 404);
    if (!LIVE_STATUSES.includes(current.status)) {
      throw new ReservationError(`That reservation is already ${current.status}.`, 409);
    }
    current.status = "cancelled";
    current.cancelReason = reason;
    await current.save({ session });
    return current;
  });

  await announceUnitStatus(reservation.resource, reservation.unitLabel, { io });
  return reservation;
}
