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
import Closure from "../../models/Closure.js";
import Reservation from "../../models/Reservation.js";
import {
  ReservationError, announceUnitStatus, assertActivationAvailable, claimInSession, nextBookingStart, transact,
} from "./index.js";
import { MINIMUM_MINUTES, SLOT_MINUTES, dayFrom, hoursOn } from "./day.js";
import { EARLIEST_CHECK_IN_MINUTES, graceOf, memberStanding } from "./standing.js";

const MINUTE = 60_000;
const clock = (date) => new Date(date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const nounOf = (org) => org?.terminology?.resourceNoun || "resource";

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
 * What a tap at the kiosk finds, in the order the kiosk acts on it:
 *
 *   active       checked in somewhere           -> the tap checks them out
 *   held         a booking whose check-in window -> the tap checks them in
 *                is open — or one whose grace       (or tells them it lapsed)
 *                has just run out
 *   later-today  a booking later today, its      -> the kiosk asks: check in now
 *                window not open yet                and cancel it, check in now
 *                                                   and keep it, or not now
 *   none         nothing, or only a booking on   -> walk in
 *                another day
 *
 * A booking on another day does not prompt: a walk-in today ends at closing
 * at the latest, long before it, so there is nothing to decide.
 */
export async function tapStanding({ organizationId, memberId, org, now = new Date() }) {
  const standing = await memberStanding(memberId, { organizationId, now, graceMinutes: graceOf(org) });
  const active = standing.current.find((reservation) => reservation.status === "active");
  if (active) return { kind: "active", reservation: active, standing };
  const held = standing.current[0] || standing.lapsed[0];
  if (held) return { kind: "held", reservation: held, standing };
  const [next] = standing.upcoming;
  if (next && dayFrom(null, next.startTime).getTime() === dayFrom(null, now).getTime()) {
    return { kind: "later-today", reservation: next, standing };
  }
  return { kind: "none", standing };
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
export async function checkIn({ organizationId, memberId, reservationId = null, io = null }) {
  const outcome = await transact(organizationId, async (session, org) => {
    // The booking the tap found, when it named one; else the earliest held.
    const held = await Reservation.findOne({
      organization: organizationId, member: memberId, status: "held", ...(reservationId ? { _id: reservationId } : {}),
    })
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
 * How long a walk-in starting `now` may last before any unit is chosen:
 * the maximum stay, closing time, the next closure, and the member's own
 * next booking (`ownNext`), whichever comes first. The unit's own next
 * booking is the one limit left, and the walk-in adds it (walkInAtKiosk);
 * the kiosk adds it from the floor's day to show what each unit allows.
 *
 *   { available: true, latestEnd, limit, closesAt }
 *       limit: "max-stay" | "closing" | "closure" | "own"
 *   { available: false, code, reason }   nothing to offer, and why
 *
 * Shorter than MINIMUM_MINUTES is nothing to offer: half an hour is the
 * shortest stay the map calls free, and the shortest the kiosk sells.
 */
export function walkInWindow({ org, now = new Date(), ownNext = null, closures = [] }) {
  const minimum = MINIMUM_MINUTES * MINUTE;
  if (org.status === "closed") {
    return { available: false, code: "ORG_CLOSED", reason: `${org.name} is closed right now.` };
  }
  const { opensAt, closesAt } = hoursOn(org, dayFrom(null, now));
  if (now < opensAt) {
    return { available: false, code: "OPERATING_HOURS", reason: `Check-in opens at ${clock(opensAt)}.` };
  }
  if (closesAt - now < minimum) {
    return {
      available: false,
      code: "OPERATING_HOURS",
      reason: `Walk-ins have finished for today: we close at ${clock(closesAt)}.`,
    };
  }
  const closedNow = closures.find((closure) => closure.startTime <= now && now < closure.endTime);
  if (closedNow) {
    return { available: false, code: "CLOSURE", reason: `We're closed right now: ${closedNow.reason}.` };
  }

  const limits = [
    { at: new Date(now.getTime() + (org.policy?.maxStayHours ?? 4) * 60 * MINUTE), limit: "max-stay" },
    { at: closesAt, limit: "closing" },
    ...closures.filter((closure) => closure.startTime > now).map((closure) => ({ at: closure.startTime, limit: "closure", reason: closure.reason })),
    ...(ownNext ? [{ at: new Date(ownNext.startTime), limit: "own" }] : []),
  ].sort((a, b) => a.at - b.at);
  const [first] = limits;

  if (first.at - now < minimum) {
    if (first.limit === "own") {
      const opens = new Date(first.at.getTime() - EARLIEST_CHECK_IN_MINUTES * MINUTE);
      return {
        available: false,
        code: "TOO_CLOSE",
        reason: `Your reservation starts at ${clock(first.at)}, so there isn't time for a stay before it. ` +
          `You can check in to it from ${clock(opens)}.`,
      };
    }
    return { available: false, code: "CLOSURE", reason: `We close at ${clock(first.at)} today: ${first.reason}.` };
  }
  return { available: true, latestEnd: first.at, limit: first.limit, closesAt };
}

/** Why a walk-in ends when it does, in the words the kiosk uses. */
export function limitSentence(limit, at, org) {
  switch (limit) {
    case "booking":
      return `Free until ${clock(at)}.`;
    case "own":
      return `You'll need to leave by ${clock(at)}.`;
    case "closing":
      return `We close at ${clock(at)}.`;
    case "closure":
      return `We're closed from ${clock(at)}.`;
    default:
      return `Stays are up to ${org?.policy?.maxStayHours ?? 4} hours.`;
  }
}

/**
 * OCC-2 — walk-in. "No reservation → map shown; Selected open resource
 * assigned on the spot."
 *
 * A walk-in is a reservation created and activated in the same step, from
 * now. That keeps ONE occupancy model rather than a parallel "walk-in
 * session" concept that every later query would have to remember to union in.
 *
 * It ends at the SHORTEST of the maximum stay, closing time, the next
 * closure, the unit's next booking and the member's own next booking — the
 * server works every one of them out itself, inside the space transaction.
 * The kiosk only asks for a length:
 *
 *   minutes        how long, in half hours from now
 *   untilLimit     as long as allowed (also what no length means)
 *
 * A length that would run past the limit is refused, saying what the limit
 * is, rather than quietly shortened: someone who chose three hours and got
 * one would find out when they were asked to leave.
 *
 *   cancelReservationId   option (a) at the kiosk: the member's booking
 *                         later today, cancelled in the SAME transaction as
 *                         the walk-in is created. If the walk-in is refused,
 *                         the cancellation rolls back with it — a failure
 *                         never loses the booking.
 *
 * Returns { reservation, cancelled, limit, latestEnd }; `limit` says why
 * the stay ends when it does, when it ends at the limit.
 */
export async function walkInAtKiosk({
  organizationId, memberId, resourceId, unitLabel,
  minutes = null, untilLimit = false, cancelReservationId = null, io = null,
}) {
  const outcome = await transact(organizationId, async (session, org) => {
    const now = new Date();

    // One current session (RES-3). A booking for LATER does not stop a
    // walk-in now; it limits how long the walk-in can last.
    const standing = await memberStanding(memberId, { organizationId, now, graceMinutes: graceOf(org), session });
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

    // Option (a): give up the booking later today for this walk-in.
    let cancelled = null;
    if (cancelReservationId) {
      cancelled = standing.upcoming.find((reservation) => String(reservation._id) === String(cancelReservationId)) || null;
      if (!cancelled) {
        throw new ReservationError(
          "That reservation has changed since you tapped. Please tap your card again.",
          409,
          "NOT_UPCOMING"
        );
      }
      cancelled.status = "cancelled";
      cancelled.cancelReason = "Checked in at the kiosk instead";
      await cancelled.save({ session });
    }
    const ownNext = standing.upcoming.find((reservation) => reservation !== cancelled) || null;

    // The unit's next booking, by the claim's own rules (a seat's room, a
    // room's contents), and the closures where it is.
    const { start: unitNext, siteId } = await nextBookingStart({ organizationId, resourceId, unitLabel, after: now, org, session });
    const dayEnd = dayFrom(null, now);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const closures = await Closure.find({
      organization: organizationId,
      $or: [{ site: null }, { site: siteId }],
      startTime: { $lt: dayEnd },
      endTime: { $gt: now },
    })
      .sort({ startTime: 1 })
      .session(session);

    const window = walkInWindow({ org, now, ownNext, closures });
    if (!window.available) throw new ReservationError(window.reason, 409, window.code);
    let { latestEnd, limit } = window;
    if (unitNext && unitNext < latestEnd) {
      latestEnd = unitNext;
      limit = "booking";
    }
    if (latestEnd - now < MINIMUM_MINUTES * MINUTE) {
      throw new ReservationError(
        `That ${nounOf(org)} is booked from ${clock(latestEnd)}, less than half an hour from now. Please choose another.`,
        409,
        "TOO_SHORT"
      );
    }

    // How long: the kiosk asks, and this decides.
    let end = latestEnd;
    if (!untilLimit && minutes !== null && minutes !== undefined) {
      const asked = Number(minutes);
      if (!Number.isInteger(asked) || asked < MINIMUM_MINUTES || asked % SLOT_MINUTES) {
        throw new ReservationError("Choose how long to stay in half hours.", 400, "BAD_LENGTH");
      }
      const askedEnd = new Date(now.getTime() + asked * MINUTE);
      // The kiosk counted from its own "now", a moment ago: a minute's
      // allowance for that, and no more.
      if (askedEnd - latestEnd > MINUTE) {
        throw new ReservationError(`${limitSentence(limit, latestEnd, org)} Please choose a shorter time.`, 409, "LIMIT");
      }
      if (askedEnd < latestEnd) end = askedEnd;
    }

    // Walk-ins share the same committed claim path as online bookings.
    const { reservation } = await claimInSession({
      session, org, organizationId, memberId, resourceId, unitLabel, start: now, end, activate: true,
    });
    return { reservation, cancelled, limit: end.getTime() === latestEnd.getTime() ? limit : null, latestEnd };
  });

  // Committed — now tell the maps. Neither may turn a walk-in that exists
  // into an error response.
  await announceUnitStatus(outcome.reservation.resource, outcome.reservation.unitLabel, { io });
  if (outcome.cancelled) await announceUnitStatus(outcome.cancelled.resource, outcome.cancelled.unitLabel, { io });
  return outcome;
}

/** walkInAtKiosk, answering with the reservation alone — for callers that want only that. */
export async function assignWalkIn(args) {
  return (await walkInAtKiosk(args)).reservation;
}
