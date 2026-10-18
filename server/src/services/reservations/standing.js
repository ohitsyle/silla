/**
 * What a member may hold at once — RES-3, revised.
 *
 *   at most ONE current session    checked in, or a held booking whose
 *                                  check-in window is open right now
 *   at most ONE upcoming booking   a held booking whose window opens later,
 *                                  today or on any later day
 *   and the two never overlap.
 *
 * It used to be ONE live reservation of any kind. That stopped hoarding,
 * but it also meant a member who booked 3–5 PM at 7 AM could not sit
 * anywhere at 8 AM, although they would be gone hours before their booking
 * began. Splitting "now" from "later" lets them, and still stops anyone
 * from holding two places at once or stockpiling the week: one place now,
 * one place later, never overlapping.
 *
 * Enforced inside the claim's space transaction (index.js claimInSession),
 * after the organization's spaceRevision write. That is what makes it hold
 * under concurrency: two requests for the same member — two tabs, or the
 * website racing the kiosk — cannot both read "nothing held" and both
 * commit. The loser retries on a fresh snapshot, sees the winner's booking
 * and is refused here.
 *
 * The check-in window is the one occupancy.js enforces at the tap: it
 * opens EARLIEST_CHECK_IN_MINUTES before the start and closes when the
 * grace period runs out (or the booking ends, if that is sooner). A held
 * booking past its grace is neither current nor upcoming — it is a no-show
 * the minute worker is about to expire, and nothing can check into it.
 */
import Reservation from "../../models/Reservation.js";
import { LIVE_STATUSES } from "./availability.js";
import { ReservationError } from "./errors.js";

const MINUTE = 60_000;

/** How early a member may tap in for a booking (OCC-1). */
export const EARLIEST_CHECK_IN_MINUTES = 15;

/** The organization's grace period, in minutes (RES-5). */
export const graceOf = (org) => org?.policy?.gracePeriodMinutes ?? 10;

/** When a held booking's check-in window opens and closes. */
export function checkInWindow(reservation, graceMinutes) {
  const start = new Date(reservation.startTime).getTime();
  const end = new Date(reservation.endTime).getTime();
  return {
    opens: new Date(start - EARLIEST_CHECK_IN_MINUTES * MINUTE),
    closes: new Date(Math.min(start + graceMinutes * MINUTE, end)),
  };
}

/**
 * "current", "upcoming", or null for a reservation that holds nothing any
 * more (finished, or a held booking whose grace has run out).
 *
 * The boundaries match checkIn exactly: a tap at `closes` still checks in,
 * one a moment later expires the booking.
 */
export function phaseOf(reservation, now, graceMinutes) {
  if (reservation.status === "active") return "current";
  if (reservation.status !== "held") return null;
  const { opens, closes } = checkInWindow(reservation, graceMinutes);
  if (now < opens) return "upcoming";
  if (now <= closes && now < new Date(reservation.endTime)) return "current";
  return null;
}

/**
 * The time a live reservation keeps its holder busy. A session in progress
 * runs at least until now — someone overstaying is still there — and from
 * whenever they actually arrived, which may be before the booked start.
 */
export function busyInterval(reservation, now) {
  const start = new Date(reservation.startTime);
  const end = new Date(reservation.endTime);
  if (reservation.status !== "active") return { start, end };
  const arrived = reservation.checkedInAt ? new Date(reservation.checkedInAt) : start;
  return {
    start: arrived < start ? arrived : start,
    end: end > now ? end : now,
  };
}

/**
 * The member's live reservations, sorted and sorted out.
 *
 *   current   checked in first, then a held booking whose window is open
 *   upcoming  held bookings whose window has not opened, earliest first
 *   lapsed    held bookings past their grace, waiting for the worker
 *
 * Read with the transaction's session when called from inside one, so the
 * answer is the snapshot the claim will commit against.
 */
export async function memberStanding(memberId, { organizationId = null, now = new Date(), graceMinutes = 10, session = null } = {}) {
  const live = await Reservation.find({
    member: memberId,
    ...(organizationId ? { organization: organizationId } : {}),
    status: { $in: LIVE_STATUSES },
  })
    .sort({ startTime: 1 })
    .session(session);

  const standing = { live, current: [], upcoming: [], lapsed: [] };
  for (const reservation of live) {
    const phase = phaseOf(reservation, now, graceMinutes);
    if (phase === "current") standing.current.push(reservation);
    else if (phase === "upcoming") standing.upcoming.push(reservation);
    else standing.lapsed.push(reservation);
  }
  // Somebody checked in is the current session whatever else is open.
  standing.current.sort((a, b) => (a.status === "active" ? -1 : 0) - (b.status === "active" ? -1 : 0));
  return standing;
}

/* ───────────────────────────── the refusals ───────────────────────────── */

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const TIME = { hour: "numeric", minute: "2-digit" };
const clock = (date) => new Date(date).toLocaleTimeString(undefined, TIME);

/**
 * "3:00 – 5:00 PM today", "3:00 – 5:00 PM on Thu, Oct 22": when a
 * reservation is, said briefly. formatRange writes the range the locale's
 * way, so a 24-hour locale reads "15:00–17:00" and AM/PM is said once.
 */
export function describeSpan(start, end, now = new Date()) {
  const times = new Intl.DateTimeFormat(undefined, TIME).formatRange(new Date(start), new Date(end));
  if (sameDay(start, now)) return `${times} today`;
  return `${times} on ${new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

/**
 * Throws unless the member may also hold [start, end).
 *
 *   activate   a walk-in, checked in at once: always the current session
 *   ignoreId   a reservation being replaced in the same transaction
 *
 * A new booking is current or upcoming by the same window as everything
 * else. One whose check-in window has already closed could never be
 * checked into — the worker would mark it a no-show within the minute —
 * so it is refused as having started, rather than created to fail.
 */
export function assertMayHold(standing, { start, end, activate = false, now = new Date(), graceMinutes = 10, noun = "resource", ignoreId = null }) {
  const phase = activate ? "current" : phaseOf({ status: "held", startTime: start, endTime: end }, now, graceMinutes);
  if (!phase) {
    throw new ReservationError("That start time has already passed. Choose a time from now on.", 409, "STARTED");
  }

  const others = (list) => list.filter((reservation) => !ignoreId || String(reservation._id) !== String(ignoreId));
  const current = others(standing.current);
  const upcoming = others(standing.upcoming);
  const where = (reservation) => reservation.targetLabel || `your ${noun}`;

  if (phase === "current" && current.length) {
    const [held] = current;
    throw new ReservationError(
      held.status === "active"
        ? `You're already checked in at ${where(held)}. Check out before taking another ${noun} now.`
        : `You already have a reservation for now: ${where(held)}, ${describeSpan(held.startTime, held.endTime, now)}. ` +
            "Check in to it, or cancel it to book this instead.",
      409,
      "ALREADY_HOLDING"
    );
  }
  if (phase === "upcoming" && upcoming.length) {
    const [next] = upcoming;
    throw new ReservationError(
      `You already have a reservation coming up: ${where(next)}, ${describeSpan(next.startTime, next.endTime, now)}. ` +
        "You can hold one booking ahead at a time — cancel it to book this instead.",
      409,
      "ALREADY_HOLDING"
    );
  }

  for (const reservation of [...current, ...upcoming]) {
    const busy = busyInterval(reservation, now);
    if (busy.start < end && busy.end > start) {
      throw new ReservationError(
        `That overlaps your reservation for ${where(reservation)} (${describeSpan(busy.start, busy.end, now)}). ` +
          `Choose a time that ends by ${clock(busy.start)} or starts at ${clock(busy.end)} or later.`,
        409,
        "OWN_OVERLAP"
      );
    }
  }
  return phase;
}
