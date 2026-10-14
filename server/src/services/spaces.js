import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import Room from "../models/Room.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";

export class SpaceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// RES-2 / INF-1 extension. Transactions alone permit write skew. All claims,
// room changes and structural map writes first contend on this actual write.
// Mongo retries a write conflict against a fresh snapshot; no tentative booking
// is exposed before commit. One organization is serialized, others are independent.
export async function withSpaceTransaction(organizationId, fn) {
  return mongoose.connection.transaction(async (session) => {
    const org = await Organization.findOneAndUpdate(
      { _id: organizationId }, { $inc: { spaceRevision: 1 } }, { new: true, session },
    );
    if (!org) throw new SpaceError("Organization not found", 404);
    return fn(session, org);
  });
}

export const intersects = (a, b) => a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row;
export const contains = (a, b) => b.col >= a.col && b.row >= a.row && b.col + b.w <= a.col + a.w && b.row + b.h <= a.row + a.h;
export const pieceBounds = (resource, type) => ({ ...resource.position.toObject?.() || resource.position, ...type?.footprint.toObject?.() || type?.footprint || { w: 1, h: 1 } });

export function shapeRoom(room) {
  return {
    id: String(room._id), name: room.name, buildingId: String(room.building),
    bookingMode: room.bookingMode, resourceId: String(room.resource),
    levels: room.levels.map((l) => ({ floorId: String(l.floor), name: l.name, bounds: { col: l.bounds.col, row: l.bounds.row, w: l.bounds.w, h: l.bounds.h } })),
  };
}

export async function roomForResource(resource, session = null) {
  if (resource.kind === "room") return Room.findOne({ _id: resource.room, organization: resource.organization }).session(session);
  const rooms = await Room.find({ organization: resource.organization, "levels.floor": resource.floor }).session(session);
  const type = await ResourceType.findById(resource.resourceType).session(session);
  const bounds = pieceBounds(resource, type);
  return rooms.find((r) => r.levels.some((l) => String(l.floor) === String(resource.floor) && contains(l.bounds, bounds))) || null;
}

export async function roomContents(room, session = null) {
  const pieces = await Resource.find({ organization: room.organization, floor: { $in: room.levels.map((l) => l.floor) }, kind: { $ne: "room" } }).session(session);
  const types = await ResourceType.find({ organization: room.organization }).session(session);
  const byId = new Map(types.map((t) => [String(t._id), t]));
  return pieces.filter((p) => room.levels.some((l) => String(l.floor) === String(p.floor) && contains(l.bounds, pieceBounds(p, byId.get(String(p.resourceType))))));
}

// Painting a room lock must never overwrite a resource's manual availability.
// Compose it for the view, so cancelling a room restores each child's own state.
export function effectiveRoomState(unit, roomUnit, mode) {
  if (roomUnit?.status === "unavailable") return { ...unit, status: "unavailable", roomBlocked: true };
  if (roomUnit && ["reserved", "occupied"].includes(roomUnit.status)) return { ...unit, status: roomUnit.status, roomBlocked: true };
  if (mode === "whole") return { ...unit, status: "unavailable", roomBlocked: true };
  return unit;
}

export async function applyRoomStates(resources) {
  if (!resources.length) return;
  const orgIds = [...new Set(resources.map((r) => String(r.organization)))];
  const rooms = await Room.find({ organization: { $in: orgIds } });
  const targets = await Resource.find({ _id: { $in: rooms.map((r) => r.resource) } });
  const types = await ResourceType.find({ organization: { $in: orgIds } });
  const byId = new Map(types.map((t) => [String(t._id), t]));
  for (const p of resources) {
    const room = rooms.find((r) => String(r.organization) === String(p.organization) && r.levels.some((l) => String(l.floor) === String(p.floor) && contains(l.bounds, pieceBounds(p, byId.get(String(p.resourceType))))));
    if (!room) continue;
    const target = targets.find((t) => String(t._id) === String(room.resource));
    p.roomName = room.name;
    p.roomId = String(room._id);
    p.viewUnits = p.units.map((u) => effectiveRoomState(u.toObject(), target?.units[0], room.bookingMode));
  }
}
