/**
 * Availability rules for the reservation engine (spec §9–§11, §14).
 *
 * Pure-ish query helpers, kept separate from the claim itself so the
 * atomic path in index.js stays short enough to reason about — a claim
 * you can't read is a claim you can't trust.
 */
import Reservation from "../../models/Reservation.js";
import Closure from "../../models/Closure.js";

/** Reservation statuses that still hold a unit. Terminal ones don't. */
export const LIVE_STATUSES = ["held", "active"];

/**
 * Two ranges overlap iff each starts before the other ends. Written as a
 * Mongo query fragment so the check happens in the database rather than
 * after loading every reservation for the resource.
 */
export function overlapQuery(startTime, endTime) {
  return { startTime: { $lt: endTime }, endTime: { $gt: startTime } };
}

/** Live reservations on a specific unit that overlap the requested window. */
export function findConflicts({ resource, unitLabel, startTime, endTime, excludeId = null }, session = null) {
  const query = {
    resource,
    unitLabel,
    status: { $in: LIVE_STATUSES },
    ...overlapQuery(startTime, endTime),
  };
  if (excludeId) query._id = { $ne: excludeId };
  return Reservation.find(query).session(session);
}

/**
 * RES-3 — self-only, one active reservation at a time. "Active" here
 * means any live reservation, held or checked in: a member holding a
 * seat for later has used up their one slot.
 */
export function findMemberLiveReservation(memberId, session = null) {
  return Reservation.findOne({ member: memberId, status: { $in: LIVE_STATUSES } }).session(session);
}

/**
 * RES-7 — the organization's status gate. "limited" still permits
 * booking (it's an advisory state for staff); "closed" does not.
 */
export function assertOrganizationBookable(org) {
  if (org.status === "closed") {
    return `${org.name} is currently closed and is not accepting reservations.`;
  }
  return null;
}

/**
 * RES-7 — scheduled closures. A requested window must not intersect one.
 */
export async function findClosureConflict({ organizationId, siteId, startTime, endTime }, session = null) {
  return Closure.findOne({
    organization: organizationId,
    $or: [{ site: null }, { site: siteId }],
    ...overlapQuery(startTime, endTime),
  }).session(session);
}

/**
 * Spec §10 — the maximum-stay cap is a per-organization policy value,
 * not a fixed four hours. A booking may not exceed it.
 */
export function assertWithinMaxStay(org, startTime, endTime) {
  const maxHours = org.policy?.maxStayHours ?? 4;
  const hours = (endTime - startTime) / 3_600_000;
  if (hours <= 0) return "The end time must be after the start time.";
  if (hours > maxHours) {
    return `Reservations cannot exceed the ${maxHours}-hour maximum stay.`;
  }
  return null;
}

/**
 * Spec §10 — operating hours. A reservation must fall inside the
 * organization's configured open window, in the org's local day.
 *
 * Times are stored as "HH:mm" strings; this compares against the
 * server's local clock, which is correct for a single-site deployment
 * and is the documented v1 limitation (a per-site timezone field is the
 * multi-site fast-follow).
 */
export function assertWithinOperatingHours(org, startTime, endTime) {
  const open = org.policy?.operatingHours?.open;
  const close = org.policy?.operatingHours?.close;
  if (!open || !close) return null;

  const minutesOf = (date) => date.getHours() * 60 + date.getMinutes();
  const parse = (hhmm) => {
    const [h, m] = String(hhmm).split(":").map(Number);
    return h * 60 + (m || 0);
  };

  const openMin = parse(open);
  const closeMin = parse(close);

  if (minutesOf(startTime) < openMin || minutesOf(endTime) > closeMin) {
    return `Reservations must fall between ${open} and ${close}.`;
  }
  // A window that crosses midnight would silently pass the check above,
  // so reject it explicitly rather than booking a nonsense range.
  if (startTime.toDateString() !== endTime.toDateString()) {
    return "A reservation cannot span more than one day.";
  }
  return null;
}
