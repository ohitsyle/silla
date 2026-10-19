/**
 * Buildings, rooms and the one guard every spatial write shares
 * (INF-1 extension, RES-2).
 *
 * Routes and the reservation engine both need what is in here, and two
 * copies would drift apart:
 *
 *   withSpaceTransaction   the concurrency guard — read its comment first
 *   pieces                 the cells a placed piece covers
 *   rooms                  which room a piece sits in, what a room holds,
 *                          and how a room's lock is shown on its contents
 *
 * Shapes themselves (a room level, a zone, a floor's outline, each a set
 * of grid cells) are lib/cells.js, the one geometry the client shares.
 */
import mongoose from "mongoose";
import { contains, plainAreas, regionAreas } from "../lib/cells.js";
import Organization from "../models/Organization.js";
import Room from "../models/Room.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";

/**
 * An error whose message is written for the person who caused it.
 * `code` is for clients that branch on the reason (BUSY, say) rather than
 * on the wording.
 */
export class SpaceError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "SpaceError";
    this.status = status;
    this.code = code;
  }
}

/* ─────────────────────────── the concurrency guard ─────────────────────────── */

/** How many times a conflicting transaction is tried before the person is told. */
export const MAX_ATTEMPTS = 10;

/** Pause before a retry: full jitter, doubling from `base` up to `cap` (ms). */
const BACKOFF = { base: 10, cap: 200 };

const BUSY_MESSAGE =
  "A lot is changing on the map right now, so nothing was saved. Please try again in a moment.";

/**
 * Runs `fn(session, org)` inside a transaction that has FIRST written the
 * organization's `spaceRevision`.
 *
 * Why the write. Reading the constraints inside a transaction and then
 * inserting is not enough under snapshot isolation: a whole-room booking
 * and a seat booking inside that room each read "nothing overlaps", insert
 * documents with different ids, and both commit. That is write skew, and
 * no unique index can catch it because nothing collides. Making every
 * claim, check-in, cancellation, room change and structural edit write the
 * same document turns it into a write conflict instead: the loser starts
 * again on a fresh snapshot, sees the winner's booking, and is refused.
 * Nothing a loser wrote is ever visible, because it never commits.
 *
 * So one organization's writes queue behind each other, and different
 * organizations never contend at all.
 *
 * Why the bound. Left to itself the driver retries a conflict immediately,
 * over and over, for up to two minutes — under contention that is a
 * request that hangs and then fails with a driver error nobody can act
 * on. Here each retry waits a short, growing, randomised pause (so the
 * contenders spread out instead of colliding again in lockstep), and after
 * MAX_ATTEMPTS the person is told plainly that nothing was saved:
 * SpaceError 503, code BUSY.
 */
export async function withSpaceTransaction(organizationId, fn) {
  let attempt = 0;
  try {
    return await mongoose.connection.transaction(async (session) => {
      attempt += 1;
      // A plain Error, not a driver error: the driver aborts and rethrows
      // it instead of retrying again.
      if (attempt > MAX_ATTEMPTS) throw busy();
      if (attempt > 1) await pause(attempt);

      const org = await Organization.findOneAndUpdate(
        { _id: organizationId },
        { $inc: { spaceRevision: 1 } },
        { new: true, session }
      );
      if (!org) throw new SpaceError("Organization not found", 404);
      return fn(session, org);
    });
  } catch (err) {
    // A conflict can also surface at commit, outside the callback's count.
    // Whichever way it arrives, the person gets the same plain answer.
    if (isTransient(err)) throw busy();
    throw err;
  }
}

const busy = () => new SpaceError(BUSY_MESSAGE, 503, "BUSY");

const isTransient = (err) =>
  typeof err?.hasErrorLabel === "function" && err.hasErrorLabel("TransientTransactionError");

function pause(attempt) {
  const ceiling = Math.min(BACKOFF.cap, BACKOFF.base * 2 ** (attempt - 2));
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/* ──────────────────────────────── pieces ──────────────────────────────── */

/**
 * The cells a placed piece covers, as one rectangle: its position plus its
 * type's footprint (spec §8: fixed footprints, whole cells, no rotation).
 */
export function pieceBounds(resource, type) {
  const { col, row } = resource.position;
  const { w, h } = type?.footprint || { w: 1, h: 1 };
  return { col, row, w, h };
}

/* ────────────────────────────────── rooms ────────────────────────────────── */

/** The room's level on `floorId`, or null if the room does not reach that floor. */
export const levelOn = (room, floorId) =>
  room.levels.find((level) => String(level.floor) === String(floorId)) || null;

/**
 * True when a piece sits wholly inside the room's shape on the piece's
 * floor: every cell of its footprint is one of the level's cells. For an
 * L-shaped room that is either arm, as the room is the union of them.
 *
 * Membership is DERIVED from containment, never stored: there is no second
 * list of "what is in this room" to keep in step with the map, and a
 * boundary is not allowed to cut through a piece, so containment is
 * always a clean yes or no.
 */
export function roomHolds(room, piece, type) {
  const level = levelOn(room, piece.floor);
  return Boolean(level) && contains(regionAreas(level), pieceBounds(piece, type));
}

/**
 * A room as the API returns it. Each level carries `areas`, its shape, and
 * `bounds`, their bounding box; a level written before shapes reports its
 * one bounds as its one area, so a reader only ever needs `areas`.
 */
export function shapeRoom(room) {
  return {
    id: String(room._id),
    name: room.name,
    buildingId: String(room.building),
    bookingMode: room.bookingMode,
    resourceId: String(room.resource),
    levels: room.levels.map((level) => ({
      floorId: String(level.floor),
      name: level.name,
      bounds: plainAreas([level.bounds])[0],
      areas: regionAreas(level),
    })),
  };
}

/**
 * The room a resource belongs to: for a room's own booking target, that
 * room; for a piece, the room whose level contains it; otherwise null.
 */
export async function roomForResource(resource, session = null) {
  if (resource.kind === "room") {
    return Room.findOne({ _id: resource.room, organization: resource.organization }).session(session);
  }
  // Sequential, never Promise.all: operations that share a transaction's
  // session must not run concurrently.
  const rooms = await Room.find({ organization: resource.organization, "levels.floor": resource.floor })
    .session(session);
  if (!rooms.length) return null;
  const type = await ResourceType.findById(resource.resourceType).session(session);
  return rooms.find((room) => roomHolds(room, resource, type)) || null;
}

/** Every piece inside the room, across all of its levels. */
export async function roomContents(room, session = null) {
  const pieces = await Resource.find({
    organization: room.organization,
    floor: { $in: room.levels.map((level) => level.floor) },
    kind: { $ne: "room" },
  }).session(session);
  const types = await ResourceType.find({ organization: room.organization }).session(session);
  const typeById = new Map(types.map((type) => [String(type._id), type]));
  return pieces.filter((piece) => roomHolds(room, piece, typeById.get(String(piece.resourceType))));
}

/**
 * How a unit inside a room should READ, given the room's own state.
 *
 * Composed for display, never written back: painting the room's lock onto
 * each child would overwrite a desk that staff had marked unavailable by
 * hand, and releasing the room would then "restore" it to available.
 * Keeping the two apart means a cancelled room booking gives every child
 * back its own state.
 */
export function effectiveRoomState(unit, roomUnit, mode) {
  if (roomUnit?.status === "unavailable") return { ...unit, status: "unavailable", roomBlocked: true };
  if (roomUnit && ["reserved", "occupied"].includes(roomUnit.status)) {
    return { ...unit, status: roomUnit.status, roomBlocked: true };
  }
  // A room booked only as a whole: its contents are never booked one by
  // one. `includedInRoom` tells this apart from a unit someone switched
  // off — the map calls it "Comes with its room" (client lib/rooms.js
  // sets the same flag), and the dashboard must not count it as broken.
  if (mode === "whole") return { ...unit, status: "unavailable", roomBlocked: true, includedInRoom: true };
  return unit;
}

/**
 * Decorates pieces (in place) with `roomId`, `roomName` and `viewUnits` —
 * the composed state above — for the staff console's dashboard and lists.
 */
export async function applyRoomStates(resources) {
  if (!resources.length) return;
  const organizations = [...new Set(resources.map((resource) => String(resource.organization)))];
  const [rooms, types] = await Promise.all([
    Room.find({ organization: { $in: organizations } }),
    ResourceType.find({ organization: { $in: organizations } }),
  ]);
  const targets = await Resource.find({ _id: { $in: rooms.map((room) => room.resource) } });
  const typeById = new Map(types.map((type) => [String(type._id), type]));
  const targetById = new Map(targets.map((target) => [String(target._id), target]));

  for (const piece of resources) {
    const type = typeById.get(String(piece.resourceType));
    const room = rooms.find(
      (candidate) =>
        String(candidate.organization) === String(piece.organization) && roomHolds(candidate, piece, type)
    );
    if (!room) continue;
    const roomUnit = targetById.get(String(room.resource))?.units[0];
    piece.roomName = room.name;
    piece.roomId = String(room._id);
    piece.viewUnits = piece.units.map((unit) => effectiveRoomState(unit.toObject(), roomUnit, room.bookingMode));
  }
}
