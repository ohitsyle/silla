/**
 * Piece and unit names, read from the database (the rules are lib/names.js).
 *
 *   floorNames(floorIds)   every piece's number and name on those floors
 *   stampNumbers(floorId)  store the numbers a floor's pieces are shown with
 *   unitLabels(refs)       "Long Table 2 · Seat 3" for (resource, unit) pairs
 *
 * A reservation keeps the name it was made under (`targetLabel`) as its
 * history: a removed table must still say what was booked. Anything that
 * shows a LIVE reservation — the member's panel, the kiosk, a reminder, a
 * schedule — asks unitLabels for the name the map uses now, and falls back
 * to the stored one only when the piece is gone.
 */
import Organization from "../models/Organization.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Room from "../models/Room.js";
import { numberPieces, pieceName, unitName } from "../lib/names.js";

const asPiece = (resource) => ({
  id: String(resource._id),
  type: String(resource.resourceType),
  position: resource.position,
  number: resource.number ?? null,
});

/**
 * Numbers and names for every piece on the given floors.
 *
 * Returns a Map of piece id -> { number, name }. Every piece on each floor
 * is read, not only the ones asked about: a number is a piece's place
 * among ALL the pieces of its type on its floor.
 */
export async function floorNames(floorIds, { session = null } = {}) {
  const ids = [...new Set((floorIds || []).filter(Boolean).map(String))];
  const names = new Map();
  if (!ids.length) return names;
  const pieces = await Resource.find({ floor: { $in: ids }, kind: { $ne: "room" } })
    .select("floor resourceType position number")
    .session(session);
  const types = await ResourceType.find({ _id: { $in: [...new Set(pieces.map((p) => String(p.resourceType)))] } })
    .select("label")
    .session(session);
  const labelOf = new Map(types.map((type) => [String(type._id), type.label]));
  for (const floorId of ids) {
    const onFloor = pieces.filter((piece) => String(piece.floor) === floorId);
    const numbers = numberPieces(onFloor.map(asPiece));
    for (const piece of onFloor) {
      const number = numbers.get(String(piece._id));
      names.set(String(piece._id), { number, name: pieceName(labelOf.get(String(piece.resourceType)), number) });
    }
  }
  return names;
}

/**
 * Stores the number each piece on a floor is shown with, where it is not
 * stored yet. Called inside the space transaction of every write that adds
 * or removes a piece, BEFORE the change: a floor's pieces were numbered by
 * reading order while nothing was stored, and placing a table in front of
 * them, or removing one, would otherwise renumber the rest — "Long Table
 * 3" turning into "Long Table 2" under somebody's reservation.
 */
export async function stampNumbers(floorId, session = null) {
  const pieces = await Resource.find({ floor: floorId, kind: { $ne: "room" } })
    .select("resourceType position number")
    .session(session);
  const numbers = numberPieces(pieces.map(asPiece));
  const writes = pieces
    .filter((piece) => !Number.isInteger(piece.number))
    .map((piece) => ({ updateOne: { filter: { _id: piece._id }, update: { $set: { number: numbers.get(String(piece._id)) } } } }));
  if (writes.length) await Resource.bulkWrite(writes, { session });
  return pieces.map(asPiece).map((piece) => ({ ...piece, number: numbers.get(piece.id) }));
}

/**
 * The current full name of each (resource, unit) pair: a unit's
 * "Long Table 2 · Seat 3", or a room's own name for a whole-room booking.
 *
 * `refs` are anything with `resource` (an id or a document) and
 * `unitLabel` — reservations, typically. Returns a Map keyed
 * `${resourceId}:${unitLabel}`; a pair whose piece no longer exists is
 * absent, so the caller falls back to what it stored.
 */
export async function unitLabels(refs, { session = null } = {}) {
  const labels = new Map();
  const resourceIds = [...new Set((refs || []).map((ref) => String(ref.resource?._id || ref.resource)).filter(Boolean))];
  if (!resourceIds.length) return labels;
  const resources = await Resource.find({ _id: { $in: resourceIds } })
    .select("organization floor kind room units")
    .session(session);
  const byId = new Map(resources.map((resource) => [String(resource._id), resource]));
  const pieces = resources.filter((resource) => resource.kind !== "room");
  const names = await floorNames(pieces.map((piece) => piece.floor), { session });
  const rooms = await Room.find({ _id: { $in: resources.filter((r) => r.kind === "room").map((r) => r.room) } })
    .select("name")
    .session(session);
  const roomName = new Map(rooms.map((room) => [String(room._id), room.name]));
  const orgs = await Organization.find({ _id: { $in: [...new Set(resources.map((r) => String(r.organization)))] } })
    .select("terminology")
    .session(session);
  const nounOf = new Map(orgs.map((org) => [String(org._id), org.terminology?.resourceNoun || "resource"]));

  for (const ref of refs) {
    const resource = byId.get(String(ref.resource?._id || ref.resource));
    if (!resource) continue;
    const key = `${resource._id}:${ref.unitLabel}`;
    if (resource.kind === "room") {
      const name = roomName.get(String(resource.room));
      if (name) labels.set(key, name);
      continue;
    }
    const piece = names.get(String(resource._id));
    if (!piece) continue;
    labels.set(
      key,
      unitName({ piece: piece.name, unitLabel: ref.unitLabel, units: resource.units.length, noun: nounOf.get(String(resource.organization)) })
    );
  }
  return labels;
}

/** A live reservation's name: the current one, else the one it was made under. */
export const labelOf = (reservation, labels) =>
  labels.get(`${reservation.resource?._id || reservation.resource}:${reservation.unitLabel}`) ||
  reservation.targetLabel ||
  reservation.unitLabel;
