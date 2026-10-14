/**
 * RES-2: claims commit inside a transaction after an actual shared write to the
 * organization's spaceRevision. Read-then-write transactions ALONE permit write
 * skew. The revision write creates a conflict that Mongo retries with a fresh
 * snapshot, covering room-versus-seat races and one-reservation-per-member races.
 * The previous lowest-ObjectId insert tie-break only compared identical units;
 * a room and its children have different target ids and need one shared guard.
 * No email or socket event escapes until the transaction commits.
 */
import ResourceType from "../../models/ResourceType.js";
import Room from "../../models/Room.js";
import { withSpaceTransaction, roomForResource, roomContents } from "../spaces.js";
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import Floor from "../../models/Floor.js";
import Organization from "../../models/Organization.js";
import User from "../../models/User.js";
import { emitUnitStatus } from "../realtime.js";
import { sendEmail } from "../email/index.js";
import { reservationConfirmedEmail } from "../email/templates.js";
import {
  assertOrganizationBookable,
  assertWithinMaxStay,
  assertWithinOperatingHours,
  findClosureConflict,
  findMemberLiveReservation,
  LIVE_STATUSES,
} from "./availability.js";

export class ReservationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "ReservationError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Recomputes a unit's map status from its live reservations and writes
 * it to the Resource document, then streams the change (MAP-2).
 *
 * The map's status is derived, never set by hand in two places — that is
 * how "reserved" and "occupied" stay honest as reservations move through
 * their lifecycle.
 */
export async function syncUnitStatus(resourceId, unitLabel, { io } = {}) {
  const resource = await Resource.findById(resourceId);
  if (!resource) return null;

  const unit = resource.units.find((u) => u.label === unitLabel);
  if (!unit) return null;

  // A unit an admin has taken out of circulation stays unavailable
  // regardless of bookings (spec §8 — marking a piece unavailable
  // cascades to its units).
  if (unit.serviceStatus === "out_of_service") {
    unit.status = "unavailable";
  } else {
    const now = new Date();
    const active = await Reservation.findOne({
      resource: resourceId,
      unitLabel,
      status: "active",
    });
    const held = await Reservation.findOne({
      resource: resourceId,
      unitLabel,
      status: "held",
      startTime: { $lte: now },
      endTime: { $gt: now },
    });

    if (active) unit.status = "occupied";
    else if (held) unit.status = "reserved";
    else if (unit.status !== "unavailable") unit.status = "available";

    unit.overstay = Boolean(active?.overstay);
  }

  const fresh = await Resource.findOneAndUpdate({ _id: resource._id }, { $set: { "units.$[unit].status": unit.status, "units.$[unit].overstay": unit.overstay } }, { arrayFilters: [{ "unit.label": unitLabel }], new: true });

  const floor = await Floor.findById(resource.floor).select("_id");
  const room = resource.kind === "room" ? await Room.findById(resource.room) : null;
  for (const floorId of room ? room.levels.map((l) => String(l.floor)) : [floor?._id?.toString()]) emitUnitStatus(io, {
    floorId,
    resourceId: resource._id.toString(),
    units: fresh.units.map((u) => ({
      status: u.status,
      serviceStatus: u.serviceStatus,
      overstay: u.overstay,
    })),
  });

  return resource;
}

/**
 * RES-1 / RES-2 / RES-3 / RES-5 / RES-7 — claim a unit for a window.
 */
async function availableTarget({ organizationId, resourceId, unitLabel, start, end, maxStayStart = start, org, session = null, excludeId = null }) {
    const closed = assertOrganizationBookable(org);
    if (closed) throw new ReservationError(closed, 409, "ORG_CLOSED");
    const tooLong = assertWithinMaxStay(org, maxStayStart, end);
    if (tooLong) throw new ReservationError(tooLong, 400, "MAX_STAY");
    const outside = assertWithinOperatingHours(org, start, end);
    if (outside) throw new ReservationError(outside, 400, "OPERATING_HOURS");
    const resource = await Resource.findOne({ _id: resourceId, organization: organizationId }).session(session);
    if (!resource) throw new ReservationError("Resource not found", 404);
    const unit = resource.units.find((u) => u.label === String(unitLabel));
    if (!unit) throw new ReservationError("That unit does not exist.", 404);
    const type = await ResourceType.findById(resource.resourceType).session(session);
    if (!type?.reservable) throw new ReservationError("That item is not bookable.", 409);
    if (unit.serviceStatus === "out_of_service") throw new ReservationError("That resource is out of service.", 409, "OUT_OF_SERVICE");
    if (unit.status === "unavailable") throw new ReservationError("That resource is unavailable.", 409, "UNAVAILABLE");
    const room = await roomForResource(resource, session);
    if (resource.kind === "room" && !room) throw new ReservationError("Room not found", 404);
    let conflictQuery = { resource: resource._id, unitLabel: String(unitLabel) };
    if (room) {
      const target = await Resource.findById(room.resource).session(session);
      if (target?.units[0]?.status === "unavailable") throw new ReservationError("That room is currently unavailable.", 409, "ROOM_CLOSED");
      if (resource.kind === "room") {
        if (room.bookingMode === "individual") throw new ReservationError("This room is booked by individual resource.", 409, "ROOM_MODE");
        const children = await roomContents(room, session);
        conflictQuery = { resource: { $in: [room.resource, ...children.map((c) => c._id)] } };
      } else {
        if (room.bookingMode === "whole") throw new ReservationError("Reserve this room as a whole instead.", 409, "ROOM_MODE");
        conflictQuery = { $or: [{ resource: resource._id, unitLabel: String(unitLabel) }, { resource: room.resource }] };
      }
    }
    const floor = await Floor.findById(resource.floor).session(session);
    const closure = await findClosureConflict({ organizationId, siteId: floor?.site, startTime: start, endTime: end }, session);
    if (closure) throw new ReservationError("That period is closed: " + closure.reason, 409, "CLOSURE");
    const conflict = await Reservation.exists({
      ...conflictQuery, ...(excludeId ? { _id: { $ne: excludeId } } : {}), status: { $in: LIVE_STATUSES },
      $and: [{ $or: [{ startTime: { $lt: end }, endTime: { $gt: start } }, ...(start <= new Date() ? [{ status: "active" }] : [])] }],
    }).session(session);
    if (conflict) throw new ReservationError(room ? "The room or a resource inside is already booked for part of that window." : "That resource is already booked for part of that window.", 409, "CONFLICT");
    const resourceLabel = resource.kind === "room" ? room.name : (type.label + " · " + unitLabel);
    return resourceLabel;
}

// OCC-1: early arrival cannot occupy a room while another level/seat is in use.
export async function assertActivationAvailable(reservation, org, now, session) {
  return availableTarget({ organizationId: reservation.organization, resourceId: reservation.resource, unitLabel: reservation.unitLabel,
    start: now < reservation.startTime ? now : reservation.startTime, maxStayStart: reservation.startTime, end: reservation.endTime, org, session, excludeId: reservation._id });
}

export async function reservationAvailability({ organizationId, resourceId, unitLabel, startTime, endTime }) {
  const start = new Date(startTime), end = new Date(endTime);
  if (!startTime || !endTime || Number.isNaN(+start) || Number.isNaN(+end)) return { bookable: false, error: "Choose valid start and end times." };
  const org = await Organization.findById(organizationId);
  if (!org) throw new ReservationError("Organization not found", 404);
  try { await availableTarget({ organizationId, resourceId, unitLabel, start, end, org }); return { bookable: true }; }
  catch (e) { if (e instanceof ReservationError) return { bookable: false, error: e.message, code: e.code }; throw e; }
}

export async function claimReservation({
  organizationId, memberId, resourceId, unitLabel, startTime, endTime,
  io = null, activate = false, notify = true,
}) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (!startTime || !endTime || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ReservationError("Choose valid start and end times.");
  let resourceLabel;
  const reservation = await withSpaceTransaction(organizationId, async (session, org) => {
    const member = await User.findOne({ _id: memberId, organization: organizationId, active: true }).session(session);
    if (!member) throw new ReservationError("Account not found", 404);
    resourceLabel = await availableTarget({ organizationId, resourceId, unitLabel, start, end, org, session });
    if (await findMemberLiveReservation(memberId, session)) throw new ReservationError("You already have an active reservation. Check out or cancel it first.", 409, "ALREADY_HOLDING");
    const [created] = await Reservation.create([{
      organization: organizationId, member: memberId, resource: resourceId, targetLabel: resourceLabel, unitLabel: String(unitLabel),
      startTime: start, endTime: end, status: activate ? "active" : "held", checkedInAt: activate ? start : null,
      checkInMethod: org.identity?.checkInMethod === "qr" ? "qr" : "rfid",
    }], { session });
    return created;
  });
  await syncUnitStatus(resourceId, String(unitLabel), { io });
  if (notify) {
    const [org, member] = await Promise.all([Organization.findById(organizationId), User.findById(memberId)]);
    if (member) sendEmail(reservationConfirmedEmail({ org, user: member, reservation, resourceLabel }));
  }
  return reservation;
}

/** Member- or staff-initiated cancellation. */
export async function cancelReservation({ reservationId, organizationId, reason = null, io = null }) {
  const filter = { _id: reservationId, ...(organizationId ? { organization: organizationId } : {}) };
  const found = await Reservation.findOne(filter).select("organization");
  if (!found) throw new ReservationError("Reservation not found", 404);
  const reservation = await withSpaceTransaction(found.organization, async (session) => {
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

  await syncUnitStatus(reservation.resource, reservation.unitLabel, { io });
  return reservation;
}
