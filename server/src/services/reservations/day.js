/**
 * A floor's day — what every bookable unit on it is booked for, from
 * opening to closing, read in one go (the map's rings and timelines).
 *
 * The map's colours say what each unit is doing RIGHT NOW, which is what
 * the kiosk and a walk-in need. They cannot say that a desk free all
 * morning is booked from 3 PM, so a member planning the afternoon tried
 * 2–4 PM, was refused, and had no way to see why. This is the rest of the
 * picture: for one date, every unit's booked stretches, whether it is free
 * now and until when, and whether any useful time is left in its day.
 *
 * It answers with the same rules the claim enforces (index.js checkTarget),
 * read in bulk — ONE reservation query for the floor, never one per unit:
 *
 *   - a whole-room booking blocks every unit inside the room, on every
 *     level it reaches;
 *   - any booking inside a room blocks booking the room whole;
 *   - a session still checked in past its end (an overstay) keeps blocking
 *     the slot it is in, until they check out — the claim refuses anything
 *     starting while someone is still sitting there;
 *   - opening hours and closures bound the day.
 *
 * Like every other availability read it is guidance: the claim checks
 * everything again when it commits.
 *
 * Privacy: a member sees that time is booked, never by whom. Their own
 * bookings are marked `mine`. Staff and superadmins also get the holder's
 * name, as they do in the console's schedule.
 */
import Closure from "../../models/Closure.js";
import Floor from "../../models/Floor.js";
import Organization from "../../models/Organization.js";
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import ResourceType from "../../models/ResourceType.js";
import Room from "../../models/Room.js";
import Site from "../../models/Site.js";
import { hasFeature } from "../entitlements.js";
import { roomHolds } from "../spaces.js";
import { LIVE_STATUSES } from "./availability.js";
import { ReservationError } from "./errors.js";

const MINUTE = 60_000;

/** The timeline's step, and the shortest stretch worth calling free. */
export const SLOT_MINUTES = 30;
export const MINIMUM_MINUTES = 30;

const isStaff = (role) => role === "staff" || role === "superadmin";

/* ─────────────────────────────── the day itself ─────────────────────────────── */

/** "2026-10-19" -> local midnight that day; nothing -> today. */
export function dayFrom(date, now = new Date()) {
  if (date === undefined || date === null || date === "") {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return today;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const day = match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!day || day.getMonth() !== Number(match[2]) - 1 || day.getDate() !== Number(match[3])) {
    throw new ReservationError("Choose a date as YYYY-MM-DD.", 400, "BAD_DATE");
  }
  return day;
}

/** The YYYY-MM-DD a local date falls on. */
export function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `hhmm` ("08:30") on `day`. */
function onDay(day, hhmm) {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  const at = new Date(day);
  at.setHours(hours, minutes || 0, 0, 0);
  return at;
}

/**
 * When the organization opens and closes on `day`. Without hours, the
 * whole day — up to 23:59, since a booking may not cross midnight.
 */
export function hoursOn(org, day) {
  const open = org.policy?.operatingHours?.open;
  const close = org.policy?.operatingHours?.close;
  const opensAt = open ? onDay(day, open) : new Date(day);
  const closesAt = onDay(day, close || "23:59");
  return { opensAt, closesAt: closesAt > opensAt ? closesAt : opensAt };
}

/**
 * The end of the slot `now` is in, slots counted from opening. An overstay
 * blocks at least this far: the claim refuses a booking that starts while
 * somebody is still sitting there, so the slot they are in is not free.
 */
function slotEndAfter(now, opensAt) {
  const slot = SLOT_MINUTES * MINUTE;
  const into = Math.max(0, now - opensAt);
  return new Date(opensAt.getTime() + (Math.floor(into / slot) + 1) * slot);
}

/* ─────────────────────────────── intervals ─────────────────────────────── */

/** Sorted, merged copies of [{ start, end }]. */
function merge(intervals) {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: new Date(i.start), end: new Date(i.end) }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else out.push(interval);
  }
  return out;
}

/** `from` minus `cut`, both merged lists. */
function subtract(from, cut) {
  const out = [];
  for (const piece of from) {
    let pieces = [piece];
    for (const hole of cut) {
      pieces = pieces.flatMap((p) => {
        if (hole.end <= p.start || hole.start >= p.end) return [p];
        const kept = [];
        if (hole.start > p.start) kept.push({ start: p.start, end: hole.start });
        if (hole.end < p.end) kept.push({ start: hole.end, end: p.end });
        return kept;
      });
    }
    out.push(...pieces);
  }
  return out;
}

/** `a` ∩ `b`, both merged lists. */
function intersect(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const start = x.start > y.start ? x.start : y.start;
      const end = x.end < y.end ? x.end : y.end;
      if (end > start) out.push({ start, end });
    }
  }
  return merge(out);
}

const minutesIn = (list) => list.reduce((sum, i) => sum + (i.end - i.start) / MINUTE, 0);

/* ─────────────────────────────── one unit ─────────────────────────────── */

/**
 * One unit's day, from its blocks.
 *
 *   day        "free"     nothing booked in the time left
 *              "partial"  something booked, and a free stretch of at least
 *                         MINIMUM_MINUTES remains
 *              "full"     booked, with no stretch that long left
 *              "closed"   no stretch that long left even with nothing booked:
 *                         closed, after hours, or closing in a few minutes —
 *                         not "booked", so the map draws no ring for it
 *   fraction   how much of the time left is booked, 0..1 — the ring's length
 *   freeNow    today only: nothing booked or closed at this moment
 *   freeUntil  when free now: the start of the next booking or closure, or
 *              null when nothing comes before closing
 */
function describeUnit({ blocks, open, now, isToday, closures }) {
  const busy = merge(blocks);
  const booked = intersect(busy, open);
  const free = subtract(open, busy);
  const openMinutes = minutesIn(open);
  const bookedMinutes = minutesIn(booked);
  const longestFree = free.reduce((best, i) => Math.max(best, (i.end - i.start) / MINUTE), 0);
  const longestOpen = open.reduce((best, i) => Math.max(best, (i.end - i.start) / MINUTE), 0);

  let day = "free";
  if (longestOpen < MINIMUM_MINUTES) day = "closed";
  else if (bookedMinutes > 0) day = longestFree >= MINIMUM_MINUTES ? "partial" : "full";

  const result = {
    day,
    fraction: openMinutes ? Math.min(1, Math.round((bookedMinutes / openMinutes) * 100) / 100) : 0,
    bookedMinutes: Math.round(bookedMinutes),
    freeNow: false,
    freeUntil: null,
    freeUntilReason: null,
  };

  if (isToday) {
    const openNow = open.some((i) => i.start <= now && now < i.end);
    const busyNow = busy.some((i) => i.start <= now && now < i.end);
    if (openNow && !busyNow) {
      result.freeNow = true;
      const nextBooking = busy.find((i) => i.start > now)?.start || null;
      const nextClosure = closures.find((c) => c.start > now)?.start || null;
      if (nextBooking && (!nextClosure || nextBooking <= nextClosure)) {
        result.freeUntil = nextBooking;
        result.freeUntilReason = "booking";
      } else if (nextClosure) {
        result.freeUntil = nextClosure;
        result.freeUntilReason = "closure";
      }
    }
  }
  return result;
}

/* ─────────────────────────────── the floor ─────────────────────────────── */

/**
 * GET /api/floors/:id/day's answer.
 *
 * @param viewer  { id, role } of a signed-in account in this organization,
 *                or null for the kiosk and anyone signed out
 */
export async function floorDay({ floorId, date, viewer = null, now = new Date() }) {
  const floor = await Floor.findById(floorId).select("site");
  if (!floor) throw new ReservationError("Floor not found", 404);
  const site = await Site.findById(floor.site).select("organization");
  if (!site) throw new ReservationError("Floor not found", 404);
  const org = await Organization.findById(site.organization);
  if (!org) throw new ReservationError("Organization not found", 404);

  const day = dayFrom(date, now);
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const today = dayFrom(null, now);
  const isToday = day.getTime() === today.getTime();
  const isPast = day < today;
  const { opensAt, closesAt } = hoursOn(org, day);

  /* ── what is on the floor, and in the rooms that reach it ── */
  const types = await ResourceType.find({ organization: org._id });
  const typeById = new Map(types.map((type) => [String(type._id), type]));
  const pieces = await Resource.find({ floor: floor._id, kind: { $ne: "room" } }).sort({ createdAt: 1 });
  const rooms = await Room.find({ organization: org._id, "levels.floor": floor._id });
  const targets = await Resource.find({ _id: { $in: rooms.map((room) => room.resource) } });
  // A desk on a room's balcony blocks booking the room whole, so a room's
  // answer needs its contents on every level, not only this floor's.
  const otherLevels = [...new Set(rooms.flatMap((room) => room.levels.map((level) => String(level.floor))))]
    .filter((id) => id !== String(floor._id));
  const elsewhere = otherLevels.length
    ? await Resource.find({ floor: { $in: otherLevels }, kind: { $ne: "room" } })
    : [];
  const roomOf = (piece) => rooms.find((room) => roomHolds(room, piece, typeById.get(String(piece.resourceType)))) || null;
  const contents = new Map(rooms.map((room) => [String(room._id), []]));
  for (const piece of [...pieces, ...elsewhere]) {
    const room = roomOf(piece);
    if (room) contents.get(String(room._id)).push(piece);
  }

  /* ── every live booking that touches the day: ONE query for the floor ── */
  const ids = [
    ...pieces.map((piece) => piece._id),
    ...targets.map((target) => target._id),
    ...[...contents.values()].flat().filter((piece) => !pieces.includes(piece)).map((piece) => piece._id),
  ];
  const staffView = isStaff(viewer?.role);
  const query = Reservation.find({
    organization: org._id,
    resource: { $in: ids },
    status: { $in: LIVE_STATUSES },
    startTime: { $lt: dayEnd },
    // A session still checked in is still there, whenever it was due to end.
    $or: [{ endTime: { $gt: day } }, { status: "active" }],
  }).select("resource unitLabel targetLabel startTime endTime status checkedInAt member");
  // Names are read only for staff; a member's answer never carries them.
  if (staffView) query.populate("member", "firstName lastName");
  const reservations = await query;

  const closureDocs = await Closure.find({
    organization: org._id,
    $or: [{ site: null }, { site: site._id }],
    startTime: { $lt: dayEnd },
    endTime: { $gt: day },
  }).sort({ startTime: 1 });

  /* ── the time there is to book ── */
  const windowStart = isToday ? (now > opensAt ? now : opensAt) : opensAt;
  const window = isPast || org.status === "closed" || windowStart >= closesAt ? [] : [{ start: windowStart, end: closesAt }];
  const closed = merge(closureDocs.map((c) => ({ start: c.startTime, end: c.endTime })));
  const open = subtract(window, closed);
  const closures = closureDocs.map((c) => ({ start: c.startTime, end: c.endTime, reason: c.reason }));

  /** One reservation as a block on the day, said for this viewer. */
  const blockOf = (reservation, kind) => {
    let start = reservation.startTime;
    let end = reservation.endTime;
    const overstay = reservation.status === "active" && isToday && end <= now;
    if (reservation.status === "active") {
      if (reservation.checkedInAt && reservation.checkedInAt < start) start = reservation.checkedInAt;
      if (overstay) end = slotEndAfter(now, opensAt);
    }
    if (start < day) start = day;
    if (end > dayEnd) end = dayEnd;
    const memberId = String(reservation.member?._id || reservation.member);
    const block = { start, end, status: reservation.status, kind };
    if (viewer?.id && memberId === String(viewer.id)) block.mine = true;
    if (staffView) {
      const who = reservation.member;
      block.holder = who?.firstName ? `${who.firstName} ${who.lastName}`.trim() : null;
      block.what = reservation.targetLabel || null;
      if (overstay) block.overstay = true;
    }
    return block;
  };

  const group = (keyOf) => {
    const map = new Map();
    for (const reservation of reservations) {
      const key = keyOf(reservation);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(reservation);
    }
    return map;
  };
  const byUnit = group((r) => `${r.resource}:${r.unitLabel}`);
  const byResource = group((r) => String(r.resource));
  const bookingsOf = (resourceId, unitLabel) => byUnit.get(`${resourceId}:${unitLabel}`) || [];
  const bookingsOfResource = (resourceId) => byResource.get(String(resourceId)) || [];

  /**
   * A unit as the answer carries it. One that cannot be booked at all —
   * out of service, closed by staff, part of a room booked only whole —
   * has no day to describe: `day` is null, and the map draws no ring.
   */
  const shape = (label, reason, blocks) => ({
    label,
    bookable: !reason,
    ...(reason
      ? { reason, day: null, fraction: 0, bookedMinutes: 0, freeNow: false, freeUntil: null, freeUntilReason: null }
      : describeUnit({ blocks, open, now, isToday, closures: closed })),
    blocks: blocks.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start),
  });

  /* ── units: their own bookings, and their room's ── */
  const units = {};
  for (const piece of pieces) {
    const type = typeById.get(String(piece.resourceType));
    const room = roomOf(piece);
    const target = room && targets.find((candidate) => String(candidate._id) === String(room.resource));
    const roomClosed = target?.units[0]?.status === "unavailable";
    units[String(piece._id)] = piece.units.map((unit) => {
      let reason = null;
      if (!type?.reservable) reason = "not-bookable";
      else if (unit.serviceStatus === "out_of_service") reason = "out-of-service";
      else if (unit.status === "unavailable") reason = "unavailable";
      else if (roomClosed) reason = "room-closed";
      else if (room?.bookingMode === "whole") reason = "with-room";
      const blocks = [
        ...bookingsOf(piece._id, unit.label).map((r) => blockOf(r, "unit")),
        ...(room ? bookingsOfResource(room.resource).map((r) => blockOf(r, "room")) : []),
      ];
      return shape(unit.label, reason, blocks);
    });
  }

  /* ── rooms, as a whole: their own bookings, and everything inside ── */
  const wholeAllowed = hasFeature(org, "wholeRoomBooking");
  for (const room of rooms) {
    const target = targets.find((candidate) => String(candidate._id) === String(room.resource));
    if (!target) continue;
    let reason = null;
    if (room.bookingMode === "individual") reason = "individual";
    else if (target.units[0]?.status === "unavailable") reason = "room-closed";
    else if (!wholeAllowed) reason = "plan";
    const blocks = [
      ...bookingsOfResource(target._id).map((r) => blockOf(r, "room")),
      ...contents.get(String(room._id)).flatMap((piece) => bookingsOfResource(piece._id).map((r) => blockOf(r, "inside"))),
    ];
    units[String(target._id)] = [shape("room", reason, blocks)];
  }

  return {
    floorId: String(floor._id),
    date: dateKey(day),
    isToday,
    now,
    opensAt,
    closesAt,
    slotMinutes: SLOT_MINUTES,
    minimumMinutes: MINIMUM_MINUTES,
    maxStayHours: org.policy?.maxStayHours ?? 4,
    bookable: org.status !== "closed",
    closures,
    units,
  };
}
