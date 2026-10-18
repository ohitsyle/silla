/**
 * Occupancy — the physical loop (spec §10, §13; OCC-1..OCC-6).
 *
 * ARCHITECTURAL NOTE, and the reason this file exists separately:
 *
 * Everything here sits DOWNSTREAM of the check-in interface. INF-3's
 * whole point (spec §13) is that resolving a credential to a member is
 * one swappable step, and that reservation logic is not wired into it.
 * So `services/checkin/` answers "who is this?" and stops; this module
 * takes that answer and decides what happens next — activate a held
 * reservation, offer walk-in selection, or check out.
 *
 * When QR check-in lands as a fast-follow, it becomes a second resolver
 * behind that interface and NOTHING in this file changes. If occupancy
 * logic had been written inside the resolver, it would all have to be
 * duplicated. Keep it that way.
 */
import Organization from "../../models/Organization.js";
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import { ReservationError, announceUnitStatus, assertActivationAvailable, claimReservation, transact } from "./index.js";
import { assertWithinOperatingHours } from "./availability.js";
import { EARLIEST_CHECK_IN_MINUTES, graceOf, memberStanding } from "./standing.js";

const MINUTE = 60_000;

/**
 * OCC-6 — duplicate taps within 5 seconds are ignored, so an accidental
 * double-tap doesn't check someone straight back out again.
 *
 * In-memory is the right scope: the window is 5 seconds, and the guard
 * exists to absorb hardware bounce at one kiosk, not to coordinate
 * across a cluster.
 */
const DUPLICATE_TAP_WINDOW_MS = 5000;
const recentTaps = new Map(); // credential -> timestamp

const sweeper = setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_TAP_WINDOW_MS * 2;
  for (const [key, at] of recentTaps) if (at < cutoff) recentTaps.delete(key);
}, 30_000);
sweeper.unref?.();

export function isDuplicateTap(credential) {
  const now = Date.now();
  const last = recentTaps.get(credential);
  if (last && now - last < DUPLICATE_TAP_WINDOW_MS) {
    return { duplicate: true, retryInMs: DUPLICATE_TAP_WINDOW_MS - (now - last) };
  }
  recentTaps.set(credential, now);
  return { duplicate: false };
}

/** Test hook so suites don't leak tap history into each other. */
export function __resetTapHistory() {
  recentTaps.clear();
}

/**
 * The member's current standing: are they checked in somewhere, or
 * holding a reservation they could check into now?
 */
export async function getMemberSession(memberId) {
  const active = await Reservation.findOne({ member: memberId, status: "active" });
  if (active) return { kind: "active", reservation: active };

  const held = await Reservation.findOne({ member: memberId, status: "held" }).sort({ startTime: 1 });
  if (held) return { kind: "held", reservation: held };

  return { kind: "none" };
}

/**
 * OCC-1 — check in by tap. "Tap resolves via the check-in interface;
 * within grace → occupied; Handled per resource."
 *
 * Inside the space transaction, because activating can conflict: someone
 * arriving early for a whole room must not occupy it while a seat inside
 * is still in use. A tap after the grace period expires the booking
 * instead, and that expiry is committed even though the tap is refused.
 */
export async function checkIn({ organizationId, memberId, io = null }) {
  const outcome = await transact(organizationId, async (session, org) => {
    const held = await Reservation.findOne({ organization: organizationId, member: memberId, status: "held" })
      .sort({ startTime: 1 })
      .session(session);
    if (!held) throw new ReservationError("No reservation to check in to.", 404, "NO_RESERVATION");

    const now = new Date();
    const graceMinutes = graceOf(org);
    if (held.startTime - now > EARLIEST_CHECK_IN_MINUTES * MINUTE) {
      throw new ReservationError(
        `You can check in from ${EARLIEST_CHECK_IN_MINUTES} minutes before the reservation starts.`,
        409,
        "TOO_EARLY"
      );
    }

    const graceEnds = new Date(held.startTime.getTime() + graceMinutes * MINUTE);
    if (now > graceEnds || now >= held.endTime) {
      held.status = "expired";
      await held.save({ session });
      return { reservation: held, expired: true, graceMinutes };
    }

    // One current session (RES-3): nobody is checked in two places at
    // once. The tap checks a member out before it checks them in, so this
    // only ever refuses a race — two taps, or a walk-in landing at the
    // same moment — and the transaction makes sure one of them sees the other.
    const elsewhere = await Reservation.exists({
      organization: organizationId, member: memberId, status: "active", _id: { $ne: held._id },
    }).session(session);
    if (elsewhere) {
      throw new ReservationError("You're already checked in somewhere else. Check out there first.", 409, "ALREADY_HOLDING");
    }

    await assertActivationAvailable(held, org, now, session);
    held.status = "active";
    held.checkedInAt = now;
    await held.save({ session });
    return { reservation: held };
  });

  // Committed either way; the map hears about it, but cannot fail the tap.
  await announceUnitStatus(outcome.reservation.resource, outcome.reservation.unitLabel, { io });
  if (outcome.expired) {
    throw new ReservationError(
      `That reservation expired — the ${outcome.graceMinutes}-minute grace period has passed.`,
      409,
      "GRACE_EXPIRED"
    );
  }
  return outcome.reservation;
}

/**
 * OCC-3 — check out by tap. "Tap out frees the resource; Map updates
 * immediately."
 *
 * One conditional update rather than read-then-save: the scheduler may be
 * releasing this very session for overstaying at the same moment, and a
 * read-then-save on either side would overwrite the other. Whichever lands
 * first wins; the second finds nothing still active and changes nothing.
 */
export async function checkOut({ memberId, io = null }) {
  const completed = await Reservation.findOneAndUpdate(
    { member: memberId, status: "active" },
    { $set: { status: "completed", checkedOutAt: new Date() } },
    { new: true }
  );
  if (!completed) throw new ReservationError("You're not checked in anywhere.", 404, "NOT_CHECKED_IN");

  await announceUnitStatus(completed.resource, completed.unitLabel, { io });
  return completed;
}

/**
 * OCC-2 — walk-in. "No reservation → map shown; Selected open resource
 * assigned on the spot."
 *
 * A walk-in is a reservation created and activated in the same step: it
 * runs from now to the maximum stay, and is checked in immediately. That
 * keeps ONE occupancy model rather than a parallel "walk-in session"
 * concept that every later query would have to remember to union in.
 */
export async function assignWalkIn({ organizationId, memberId, resourceId, unitLabel, io = null }) {
  const org = await Organization.findById(organizationId);
  if (!org) throw new ReservationError("Organization not found", 404);
  if (org.status === "closed") {
    throw new ReservationError(`${org.name} is currently closed.`, 409, "ORG_CLOSED");
  }

  // A walk-in is still a reservation, so it is subject to the same gates
  // a booked one is. Without this, the operating-hours rule applied to
  // RES-1 could be sidestepped entirely by tapping in at the kiosk.
  const now = new Date();
  const outsideHours = assertWithinOperatingHours(org, now, now);
  if (outsideHours) throw new ReservationError(outsideHours, 409, "OPERATING_HOURS");

  // One current session (RES-3). A booking for LATER does not stop a
  // walk-in now — the walk-in simply ends before it starts (below). The
  // claim enforces the whole rule again inside its transaction.
  const standing = await memberStanding(memberId, { organizationId, now, graceMinutes: graceOf(org) });
  const [current] = standing.current;
  if (current) {
    throw new ReservationError(
      current.status === "active"
        ? "You're already checked in. Tap out first."
        : "You already have a reservation for now. Check into that instead.",
      409,
      "ALREADY_HOLDING"
    );
  }

  // A quick answer for the kiosk; the claim below checks everything again.
  const resource = await Resource.findById(resourceId);
  if (!resource) throw new ReservationError("Resource not found", 404);
  const unit = resource.units.find((candidate) => candidate.label === String(unitLabel));
  if (!unit) throw new ReservationError(`No unit "${unitLabel}" on that resource`, 404);
  if (unit.status !== "available") {
    throw new ReservationError("That resource isn't available.", 409, "UNAVAILABLE");
  }

  // Never into the member's own next booking: one place now, one later.
  let end = walkInEnd(org, now);
  const [next] = standing.upcoming;
  if (next && next.startTime < end) end = new Date(next.startTime);
  // Walk-ins share the same committed room/unit claim path as online bookings.
  return claimReservation({
    organizationId, memberId, resourceId, unitLabel,
    startTime: now, endTime: end, activate: true, notify: false, io,
  });
}

/**
 * When a walk-in session starting `now` ends: the maximum stay, but never
 * past closing — a walk-in at 18:00 with a 4-hour cap must not claim a
 * seat until 22:00 in a building that shuts at 19:00 (spec §10).
 *
 * Inside the closing minute itself the opening-hours check above still
 * says "open" (it reads whole minutes), but there is nothing left to
 * book; the max stay would run past midnight and be refused for the
 * wrong reason. Say what is actually true instead.
 */
function walkInEnd(org, now) {
  const maxStay = new Date(now.getTime() + (org.policy?.maxStayHours ?? 4) * 60 * MINUTE);
  const close = org.policy?.operatingHours?.close;
  if (!close) return maxStay;

  const [hours, minutes] = String(close).split(":").map(Number);
  const closesAt = new Date(now);
  closesAt.setHours(hours, minutes || 0, 0, 0);
  if (closesAt <= now) {
    throw new ReservationError(`Walk-ins have finished for today: we close at ${close}.`, 409, "OPERATING_HOURS");
  }
  return closesAt < maxStay ? closesAt : maxStay;
}
