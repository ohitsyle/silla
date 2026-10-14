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
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import { withSpaceTransaction } from "../spaces.js";
import Organization from "../../models/Organization.js";
import { ReservationError, syncUnitStatus, claimReservation, assertActivationAvailable } from "./index.js";
import { assertWithinOperatingHours, LIVE_STATUSES } from "./availability.js";

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
 */
export async function checkIn({ organizationId, memberId, io = null }) {
  const outcome = await withSpaceTransaction(organizationId, async (session, org) => {
    const held = await Reservation.findOne({ organization: organizationId, member: memberId, status: "held" }).sort({ startTime: 1 }).session(session);
    if (!held) throw new ReservationError("No reservation to check in to.", 404, "NO_RESERVATION");
    const now = new Date();
    const graceMinutes = org.policy?.gracePeriodMinutes ?? 10;
    if (now < held.startTime && held.startTime - now > 15 * 60000) throw new ReservationError("You can check in from 15 minutes before the reservation starts.", 409, "TOO_EARLY");
    if (now > new Date(+held.startTime + graceMinutes * 60000) || now >= held.endTime) {
      held.status = "expired"; await held.save({ session });
      return { reservation: held, expired: true, graceMinutes };
    }
    await assertActivationAvailable(held, org, now, session);
    held.status = "active"; held.checkedInAt = now;
    await held.save({ session });
    return { reservation: held };
  });
  await syncUnitStatus(outcome.reservation.resource, outcome.reservation.unitLabel, { io });
  if (outcome.expired) throw new ReservationError("That reservation expired — the " + outcome.graceMinutes + "-minute grace period has passed.", 409, "GRACE_EXPIRED");
  return outcome.reservation;
}

/**
 * OCC-3 — check out by tap. "Tap out frees the resource; Map updates
 * immediately."
 */
export async function checkOut({ memberId, io = null }) {
  const active = await Reservation.findOne({ member: memberId, status: "active" });
  if (!active) throw new ReservationError("You're not checked in anywhere.", 404, "NOT_CHECKED_IN");

  active.status = "completed";
  active.checkedOutAt = new Date();
  await active.save();

  await syncUnitStatus(active.resource, active.unitLabel, { io });
  return active;
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
  const now0 = new Date();
  const outsideHours = assertWithinOperatingHours(org, now0, now0);
  if (outsideHours) throw new ReservationError(outsideHours, 409, "OPERATING_HOURS");

  const session = await getMemberSession(memberId);
  if (session.kind !== "none") {
    throw new ReservationError(
      session.kind === "active"
        ? "You're already checked in. Tap out first."
        : "You already have a reservation. Check into that instead.",
      409,
      "ALREADY_HOLDING"
    );
  }

  const resource = await Resource.findById(resourceId);
  if (!resource) throw new ReservationError("Resource not found", 404);
  const unit = resource.units.find((u) => u.label === String(unitLabel));
  if (!unit) throw new ReservationError(`No unit "${unitLabel}" on that resource`, 404);
  if (unit.status !== "available") {
    throw new ReservationError("That resource isn't available.", 409, "UNAVAILABLE");
  }

  const now = new Date();
  // The session runs to the max-stay cap, but never past closing — a
  // walk-in at 18:00 with a 4-hour cap must not claim a seat until
  // 22:00 in a building that shuts at 19:00 (spec §10).
  let end = new Date(now.getTime() + (org.policy?.maxStayHours ?? 4) * 3_600_000);
  const close = org.policy?.operatingHours?.close;
  if (close) {
    const [ch, cm] = String(close).split(":").map(Number);
    const closesAt = new Date(now);
    closesAt.setHours(ch, cm || 0, 0, 0);
    if (closesAt > now && closesAt < end) end = closesAt;
  }

  // Walk-ins share the same committed room/unit claim path as online bookings.
  return claimReservation({ organizationId, memberId, resourceId, unitLabel, startTime: now, endTime: end, activate: true, notify: false, io });
}
