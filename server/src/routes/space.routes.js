import { Router } from "express";
import mongoose from "mongoose";
import Building from "../models/Building.js";
import Room from "../models/Room.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Reservation from "../models/Reservation.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { SpaceError, withSpaceTransaction, shapeRoom, roomContents, contains, intersects, pieceBounds } from "../services/spaces.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";
import { syncUnitStatus } from "../services/reservations/index.js";

const router = Router();
const run = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);
const nameOf = (value) => typeof value === "string" ? value.trim().slice(0, 120) : "";
const modes = ["individual", "whole", "either"];

// MAP-1 / INF-1: stable ids preserve deep links. Legacy floors are read in an
// unassigned building until a superadmin adopts them; this GET never migrates data.
router.get("/", run(async (req, res) => {
  const orgId = req.query.organizationId;
  if (!validId(orgId)) throw new SpaceError("A valid organizationId is required");
  const sites = await Site.find({ organization: orgId }).sort({ createdAt: 1 }).lean();
  const buildings = await Building.find({ organization: orgId }).sort({ order: 1, name: 1 }).lean();
  const floors = await Floor.find({ site: { $in: sites.map((s) => s._id) } }).sort({ order: 1, name: 1 }).lean();
  const rooms = await Room.find({ organization: orgId }).sort({ name: 1 });
  res.json({ sites: sites.map((s) => ({ id: String(s._id), name: s.name })), buildings: sites.flatMap((site) => {
    const assigned = buildings.filter((b) => String(b.site) === String(site._id));
    const legacy = floors.filter((f) => String(f.site) === String(site._id) && !f.building);
    return [...assigned, ...(legacy.length ? [{ _id: "unassigned:" + site._id, site: site._id, name: site.name, unassigned: true }] : [])].map((b) => ({
      id: String(b._id), name: b.name, siteId: String(site._id), siteName: site.name, unassigned: Boolean(b.unassigned),
      floors: (b.unassigned ? legacy : floors.filter((f) => String(f.building) === String(b._id))).map((f) => ({
        id: String(f._id), name: f.name, order: f.order, grid: f.grid,
        rooms: rooms.filter((r) => r.levels.some((l) => String(l.floor) === String(f._id))).map(shapeRoom),
      })),
    }));
  }) });
}));

router.post("/buildings", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this building a name.");
  const building = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const query = { organization: req.user.organizationId };
    if (req.body.siteId) {
      if (!validId(req.body.siteId)) throw new SpaceError("A valid siteId is required");
      query._id = req.body.siteId;
    }
    const site = await Site.findOne(query).session(session);
    if (!site) throw new SpaceError("Site not found", 404);
    const [b] = await Building.create([{ organization: req.user.organizationId, site: site._id, name }], { session });
    if (req.body.adoptExisting === true) await Floor.updateMany({ site: site._id, building: null }, { $set: { building: b._id } }, { session });
    return b;
  });
  res.status(201).json({ building: { id: String(building._id), name: building.name } });
}));
router.patch("/buildings/:id", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid building id");
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this building a name.");
  const b = await Building.findOneAndUpdate({ _id: req.params.id, organization: req.user.organizationId }, { name }, { new: true, runValidators: true });
  if (!b) throw new SpaceError("Building not found", 404);
  res.json({ building: { id: String(b._id), name: b.name } });
}));
router.delete("/buildings/:id", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid building id");
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const b = await Building.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!b) throw new SpaceError("Building not found", 404);
    if (await Floor.exists({ building: b._id }).session(session)) throw new SpaceError("Remove this building's floors first.", 409);
    await b.deleteOne({ session });
  });
  res.json({ ok: true });
}));

async function validateLevels(input, building, excludeId, session) {
  if (!Array.isArray(input) || !input.length || input.length > 30) throw new SpaceError("A room needs between 1 and 30 levels.");
  const seen = new Set();
  const levels = [];
  const otherRooms = await Room.find({ organization: building.organization, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).session(session);
  const types = await ResourceType.find({ organization: building.organization }).session(session);
  const typeById = new Map(types.map((t) => [String(t._id), t]));
  for (const item of input) {
    if (!validId(item?.floorId) || seen.has(item.floorId)) throw new SpaceError("Choose a different building floor for each level.");
    seen.add(item.floorId);
    const floor = await Floor.findOne({ _id: item.floorId, building: building._id, site: building.site }).session(session);
    if (!floor) throw new SpaceError("Every room level must be on a floor in this building.", 404);
    const bounds = item.bounds;
    if (!bounds || ![bounds.col, bounds.row, bounds.w, bounds.h].every(Number.isInteger) || bounds.col < 0 || bounds.row < 0 || bounds.w < 1 || bounds.h < 1) throw new SpaceError("Draw a room using whole grid cells.");
    if (bounds.col + bounds.w > floor.grid.cols || bounds.row + bounds.h > floor.grid.rows) throw new SpaceError("That room extends beyond the floor.");
    if (otherRooms.some((r) => r.levels.some((l) => String(l.floor) === item.floorId && intersects(l.bounds, bounds)))) throw new SpaceError("Rooms cannot overlap on the same floor.", 409);
    const pieces = await Resource.find({ organization: building.organization, floor: floor._id, kind: { $ne: "room" } }).session(session);
    for (const p of pieces) {
      const rect = pieceBounds(p, typeById.get(String(p.resourceType)));
      if (intersects(bounds, rect) && !contains(bounds, rect)) throw new SpaceError("A room boundary cuts through a placed item. Include the entire item or move the boundary.", 409);
    }
    levels.push({ floor: floor._id, name: nameOf(item.name).slice(0, 80), bounds: { col: bounds.col, row: bounds.row, w: bounds.w, h: bounds.h } });
  }
  return levels;
}
async function assertNoBookings(room, session) {
  const contents = await roomContents(room, session);
  if (await Reservation.exists({ resource: { $in: [room.resource, ...contents.map((p) => p._id)] }, status: { $in: LIVE_STATUSES } }).session(session)) throw new SpaceError("This room or an item inside has an active or upcoming reservation. Cancel it before changing the room.", 409);
}

router.post("/rooms", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this room a name.");
  if (!validId(req.body.buildingId)) throw new SpaceError("Choose a building first.");
  if (!modes.includes(req.body.bookingMode)) throw new SpaceError("Choose individual, whole, or either booking.");
  const room = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const building = await Building.findOne({ _id: req.body.buildingId, organization: req.user.organizationId }).session(session);
    if (!building) throw new SpaceError("Building not found", 404);
    const levels = await validateLevels(req.body.levels, building, null, session);
    const proposed = { organization: req.user.organizationId, levels, resource: new mongoose.Types.ObjectId() };
    await assertNoBookings(proposed, session);
    let type = await ResourceType.findOne({ organization: req.user.organizationId, key: "__room" }).session(session);
    if (!type) [type] = await ResourceType.create([{ organization: req.user.organizationId, key: "__room", label: "Room", footprint: { w: 1, h: 1 }, seatCount: 1, internal: true, icon: "DoorOpen" }], { session });
    const roomId = new mongoose.Types.ObjectId();
    const [resource] = await Resource.create([{ organization: req.user.organizationId, floor: levels[0].floor, resourceType: type._id, kind: "room", room: roomId, position: { col: levels[0].bounds.col, row: levels[0].bounds.row }, units: [{ label: "room" }] }], { session });
    const [created] = await Room.create([{ _id: roomId, organization: req.user.organizationId, building: building._id, name, bookingMode: req.body.bookingMode, levels, resource: resource._id }], { session });
    return created;
  });
  res.status(201).json({ room: shapeRoom(room) });
}));
router.patch("/rooms/:id", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  const room = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const r = await Room.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!r) throw new SpaceError("Room not found", 404);
    await assertNoBookings(r, session);
    if (req.body.name !== undefined) { r.name = nameOf(req.body.name); if (!r.name) throw new SpaceError("Give this room a name."); }
    if (req.body.bookingMode !== undefined) { if (!modes.includes(req.body.bookingMode)) throw new SpaceError("Invalid booking mode"); r.bookingMode = req.body.bookingMode; }
    if (req.body.levels !== undefined) {
      const b = await Building.findOne({ _id: r.building, organization: req.user.organizationId }).session(session);
      r.levels = await validateLevels(req.body.levels, b, r._id, session);
      await assertNoBookings(r, session);
      await Resource.updateOne({ _id: r.resource }, { floor: r.levels[0].floor, position: { col: r.levels[0].bounds.col, row: r.levels[0].bounds.row } }, { session });
    }
    await r.save({ session });
    return r;
  });
  res.json({ room: shapeRoom(room) });
}));
router.delete("/rooms/:id", requireAuth, requireRole("superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const r = await Room.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!r) throw new SpaceError("Room not found", 404);
    await assertNoBookings(r, session);
    await Resource.deleteOne({ _id: r.resource }, { session });
    await r.deleteOne({ session });
  });
  res.json({ ok: true });
}));
// ADM-2: staff can close/reopen a room, but cannot redefine its booking boundary.
router.patch("/rooms/:id/availability", requireAuth, requireRole("staff", "superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  if (!["available", "unavailable"].includes(req.body?.status)) throw new SpaceError("Choose available or unavailable.");
  const r = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const room = await Room.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!room) throw new SpaceError("Room not found", 404);
    await assertNoBookings(room, session);
    await Resource.updateOne({ _id: room.resource }, { "units.0.status": req.body.status }, { session });
    return room;
  });
  await syncUnitStatus(r.resource, "room", { io: req.app.get("io") });
  res.json({ ok: true });
}));
router.use((err, req, res, next) => err instanceof SpaceError ? res.status(err.status).json({ error: err.message, code: err.code }) : next(err));
export default router;
