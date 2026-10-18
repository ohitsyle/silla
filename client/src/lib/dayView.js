/**
 * Reading a floor's day (GET /api/floors/:id/day) — the answer behind the
 * map's rings, the panel's timeline, the When picker and the kiosk's
 * walk-in choices.
 *
 * The server does the counting (services/reservations/day.js): which
 * stretches are booked, by the unit, by its room, or inside a room booked
 * whole; when a unit is free until; whether its day is free, partial, full
 * or closed. Everything here only ASKS that answer questions — is this unit
 * free for 3–5 PM, how long could a booking from 1 PM run — and says the
 * result in words, so the map, the panel and the kiosk agree.
 *
 * It is guidance, like every availability read: the claim checks
 * everything again when it commits.
 */

const MINUTE = 60_000;

/** The timeline's step, and the shortest stretch worth calling free (the server's own). */
export const SLOT_MINUTES = 30;
export const MINIMUM_MINUTES = 30;

/** "2026-10-19" for a local date. */
export function dateKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TIME = { hour: "numeric", minute: "2-digit" };

/** "3:00 PM" — or "15:00" where the locale says so. */
export const clock = (date) => new Date(date).toLocaleTimeString(undefined, TIME);

/** "3:00 – 5:00 PM", written the locale's way (AM/PM said once). */
export function clockRange(start, end) {
  try {
    return new Intl.DateTimeFormat(undefined, TIME).formatRange(new Date(start), new Date(end));
  } catch {
    return `${clock(start)} – ${clock(end)}`;
  }
}

/** "Tue, Oct 20". */
export const shortDate = (date) =>
  new Date(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** One unit's entry in a day answer, or null. Rooms are under their resource id with label "room". */
export function entryFor(day, resourceId, unitLabel) {
  return day?.units?.[resourceId]?.find((unit) => unit.label === String(unitLabel)) || null;
}

const overlaps = (a, b) => new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end);

/**
 * Whether `entry` is free for the whole of [start, end): bookable, inside
 * opening hours, clear of every booking and every closure.
 */
export function isFreeFor(entry, day, start, end) {
  if (!entry?.bookable || !day?.bookable) return false;
  const window = { start, end };
  if (new Date(start) < new Date(day.opensAt) || new Date(end) > new Date(day.closesAt)) return false;
  if ((day.closures || []).some((closure) => overlaps(closure, window))) return false;
  return !(entry.blocks || []).some((block) => overlaps(block, window));
}

/**
 * The latest a booking of `entry` starting at `start` may end: the maximum
 * stay, closing time, the next booking and the next closure, whichever
 * comes first — with the reason it stops there.
 *
 *   reason  "booking" | "closure" | "closing" | "max-stay"
 */
export function latestEnd(entry, day, start, maxStayHours) {
  const from = new Date(start);
  const limits = [
    { at: new Date(from.getTime() + maxStayHours * 60 * MINUTE), reason: "max-stay" },
    { at: new Date(day.closesAt), reason: "closing" },
  ];
  const nextBlock = (entry?.blocks || [])
    .filter((block) => new Date(block.end) > from)
    .map((block) => new Date(block.start))
    .sort((a, b) => a - b)[0];
  if (nextBlock) limits.push({ at: nextBlock < from ? from : nextBlock, reason: "booking" });
  const nextClosure = (day.closures || [])
    .filter((closure) => new Date(closure.end) > from)
    .map((closure) => new Date(closure.start))
    .sort((a, b) => a - b)[0];
  if (nextClosure) limits.push({ at: nextClosure < from ? from : nextClosure, reason: "closure" });
  // Earliest first; on a tie the booking is the more useful thing to say.
  const order = ["booking", "closure", "closing", "max-stay"];
  limits.sort((a, b) => a.at - b.at || order.indexOf(a.reason) - order.indexOf(b.reason));
  return limits[0];
}

/** The 30-minute steps of a day, from opening to closing. */
export function slotsOf(day) {
  if (!day) return [];
  const slots = [];
  const close = new Date(day.closesAt).getTime();
  for (let at = new Date(day.opensAt).getTime(); at < close; at += SLOT_MINUTES * MINUTE) {
    slots.push({ start: new Date(at), end: new Date(Math.min(at + SLOT_MINUTES * MINUTE, close)) });
  }
  return slots;
}

/** Why a unit cannot be booked at all, in a member's words. */
export function unbookableReason(entry, { noun = "resource", roomName = null } = {}) {
  switch (entry?.reason) {
    case "out-of-service":
      return "Out of service";
    case "unavailable":
      return `Closed by staff`;
    case "room-closed":
      return `${roomName || "The room"} is closed`;
    case "with-room":
      return `Comes with ${roomName || "its room"} — book the room`;
    case "individual":
      return `Booked one ${noun} at a time`;
    case "plan":
      return "Booking a whole room isn't available here";
    default:
      return "Can't be booked";
  }
}

/**
 * One plain sentence about a unit's day — the panel's headline and the
 * map's spoken label:
 *
 *   today    "Free until 3:00 PM", "Free for the rest of today",
 *            "Booked until 11:00 AM", "Booked for the rest of today",
 *            "Closed for the rest of today"
 *   another  "Free all day", "Booked 3:00 – 5:00 PM", "Booked all day"
 *
 * `later` is the booked stretches still to come, for a second line.
 */
export function describeDay(entry, day, { noun = "resource", roomName = null, now = new Date() } = {}) {
  if (!entry || !day) return { headline: null, later: [] };
  if (!entry.bookable) return { headline: unbookableReason(entry, { noun, roomName }), later: [], unbookable: true };
  const blocks = (entry.blocks || []).map((block) => ({ ...block, start: new Date(block.start), end: new Date(block.end) }));
  const later = blocks.filter((block) => !day.isToday || block.end > now);
  const spans = (list) => list.map((block) => clockRange(block.start, block.end));

  if (!day.isToday) {
    if (entry.day === "closed") return { headline: "Closed that day", later: [] };
    if (entry.day === "full") return { headline: "Booked all day", later: spans(later) };
    if (!later.length) return { headline: "Free all day", later: [] };
    return { headline: `Booked ${spans(later).slice(0, 2).join(", ")}${later.length > 2 ? ` and ${later.length - 2} more` : ""}`, later: [] };
  }

  if (entry.day === "closed") return { headline: "Closed for the rest of today", later: [] };
  const nowBlock = blocks.find((block) => block.start <= now && now < block.end);
  if (entry.day === "full") return { headline: "Booked for the rest of today", later: spans(later.filter((b) => b !== nowBlock)) };
  if (nowBlock) {
    return { headline: `Booked until ${clock(nowBlock.end)}`, later: spans(later.filter((block) => block !== nowBlock)) };
  }
  if (entry.freeNow) {
    const headline = entry.freeUntil
      ? `Free until ${clock(entry.freeUntil)}`
      : "Free for the rest of today";
    return { headline, later: spans(later) };
  }
  return { headline: later.length ? `Booked ${spans(later)[0]}` : "Free for the rest of today", later: spans(later.slice(1)) };
}

/**
 * Counts for the When picker's summary: of the units a member could book
 * on their own, how many are free for the window.
 */
export function countFree(day, layout, start, end) {
  let free = 0;
  let total = 0;
  for (const resource of layout?.resources || []) {
    for (const unit of resource.units) {
      const entry = entryFor(day, resource.id, unit.label);
      if (!entry || entry.reason === "with-room" || entry.reason === "not-bookable") continue;
      total += 1;
      if (isFreeFor(entry, day, start, end)) free += 1;
    }
  }
  return { free, total };
}
