/**
 * Buildings and rooms — the structural half of the map (INF-1, MAP-3).
 * Floors are in floor.routes.js; furniture, zones and labels in
 * resource.routes.js.
 *
 *   GET    /api/spaces?organizationId=          the hierarchy, buildings → floors → rooms
 *   POST   /api/spaces/buildings                create one, optionally adopting loose floors   superadmin
 *   PATCH  /api/spaces/buildings/:id            rename                                         superadmin
 *   DELETE /api/spaces/buildings/:id            remove an empty one                            superadmin
 *   POST   /api/spaces/rooms                    draw a room and choose its booking mode        superadmin
 *   PATCH  /api/spaces/rooms/:id                rename, change mode, redraw levels             superadmin
 *   DELETE /api/spaces/rooms/:id                remove; furniture and history stay             superadmin
 *   PATCH  /api/spaces/rooms/:id/availability   close or reopen                                staff
 *   GET    /api/spaces/usage                    plan usage for the editor's steps              superadmin
 *
 * Every write runs inside withSpaceTransaction (services/spaces.js), the
 * same guard the reservation engine uses, so a room can never be redrawn
 * around a booking that is being made at the same moment.
 *
 * Staff OPERATE the space — they close and reopen rooms. Only a superadmin
 * DEFINES it: buildings, boundaries and booking modes.
 *
 * Plan limits (docs/control-plane.md §2) are checked only through
 * services/entitlements.js, inside the same transaction as the create:
 * every space write takes the organization's revision first, so two
 * creations cannot both pass a count of "one left". A refusal is an
 * EntitlementError (403 PLAN_LIMIT / PLAN_FEATURE), answered by app.js.
 * Limits block NEW things only — nothing here hides or removes what an
 * organization already has after a downgrade.
 */
import { Router } from "express";
import mongoose from "mongoose";
import Building from "../models/Building.js";
import Floor from "../models/Floor.js";
import Reservation from "../models/Reservation.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Room from "../models/Room.js";
import Site from "../models/Site.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { assertFeature, assertWithinLimit, countUsage } from "../services/entitlements.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";
import { announceUnitStatus } from "../services/reservations/index.js";
import {
  SpaceError, pieceBounds, roomContents, shapeRoom, withSpaceTransaction,
} from "../services/spaces.js";
import { boundingBox, contains, floorCells, intersects, normaliseAreas, plainAreas, regionAreas } from "../lib/cells.js";

const router = Router();
const run = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const superadmin = [requireAuth, requireRole("superadmin")];

const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);
const nameOf = (value) => (typeof value === "string" ? value.trim().slice(0, 120) : "");

const BOOKING_MODES = ["individual", "whole", "either"];

/** A room may span at most this many floors of its building. */
const MAX_LEVELS = 30;

/* ───────────────────────────── the hierarchy ───────────────────────────── */

/**
 * MAP-1 / INF-1. Ids are stable, so deep links into the map survive.
 *
 * Floors created before buildings existed have none. They are shown under
 * an "unassigned" building named after their site — "needs setup" in the
 * editor — until a superadmin adopts them. This read never migrates
 * anything: adoption is an explicit action (POST /buildings with
 * adoptExisting), so nothing moves without someone choosing it.
 */
router.get("/", run(async (req, res) => {
  const organizationId = req.query.organizationId;
  if (!validId(organizationId)) throw new SpaceError("A valid organizationId is required");

  const sites = await Site.find({ organization: organizationId }).sort({ createdAt: 1 }).lean();
  const buildings = await Building.find({ organization: organizationId }).sort({ order: 1, name: 1 }).lean();
  const floors = await Floor.find({ site: { $in: sites.map((site) => site._id) } }).sort({ order: 1, name: 1 }).lean();
  const rooms = await Room.find({ organization: organizationId }).sort({ name: 1 });

  const shapeFloor = (floor) => ({
    id: String(floor._id),
    name: floor.name,
    order: floor.order,
    grid: floor.grid,
    // The outline: empty is the whole grid (see floor.routes.js shapeOf).
    shape: { areas: plainAreas(floor.shape?.areas) },
    rooms: rooms
      .filter((room) => room.levels.some((level) => String(level.floor) === String(floor._id)))
      .map(shapeRoom),
  });

  const shaped = sites.flatMap((site) => {
    const onSite = (doc) => String(doc.site) === String(site._id);
    const shapeBuilding = (building, buildingFloors, unassigned = false) => ({
      id: String(building._id),
      name: building.name,
      siteId: String(site._id),
      siteName: site.name,
      unassigned,
      floors: buildingFloors.map(shapeFloor),
    });

    const assigned = buildings
      .filter(onSite)
      .map((building) => shapeBuilding(building, floors.filter((floor) => String(floor.building) === String(building._id))));
    const loose = floors.filter((floor) => onSite(floor) && !floor.building);
    if (loose.length) {
      assigned.push(shapeBuilding({ _id: `unassigned:${site._id}`, name: site.name }, loose, true));
    }
    return assigned;
  });

  res.json({ sites: sites.map((site) => ({ id: String(site._id), name: site.name })), buildings: shaped });
}));

/* ─────────────────────────────── buildings ─────────────────────────────── */

/**
 * Body: { name, siteId?, adoptExisting? }. With adoptExisting, the site's
 * floors that have no building move into this one — keeping their ids,
 * furniture, zones, labels and booking history.
 */
router.post("/buildings", ...superadmin, run(async (req, res) => {
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this building a name.");
  if (req.body.siteId && !validId(req.body.siteId)) throw new SpaceError("A valid siteId is required");

  const building = await withSpaceTransaction(req.user.organizationId, async (session, org) => {
    await assertWithinLimit(org, "buildings");
    const site = await Site.findOne({
      organization: req.user.organizationId,
      ...(req.body.siteId ? { _id: req.body.siteId } : {}),
    }).session(session);
    if (!site) throw new SpaceError("Site not found", 404);

    const [created] = await Building.create([{ organization: req.user.organizationId, site: site._id, name }], { session });
    if (req.body.adoptExisting === true) {
      await Floor.updateMany({ site: site._id, building: null }, { $set: { building: created._id } }, { session });
    }
    return created;
  });
  res.status(201).json({ building: { id: String(building._id), name: building.name } });
}));

router.patch("/buildings/:id", ...superadmin, run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid building id");
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this building a name.");
  const building = await Building.findOneAndUpdate(
    { _id: req.params.id, organization: req.user.organizationId },
    { name },
    { new: true, runValidators: true }
  );
  if (!building) throw new SpaceError("Building not found", 404);
  res.json({ building: { id: String(building._id), name: building.name } });
}));

router.delete("/buildings/:id", ...superadmin, run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid building id");
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const building = await Building.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!building) throw new SpaceError("Building not found", 404);
    if (await Floor.exists({ building: building._id }).session(session)) {
      throw new SpaceError("Remove this building's floors first.", 409);
    }
    await building.deleteOne({ session });
  });
  res.json({ ok: true });
}));

/* ───────────────────────────────── rooms ───────────────────────────────── */

/**
 * Checks a room's proposed levels and returns them ready to store.
 *
 * Each level is a shape of whole cells on a different floor of the room's
 * own building: `areas`, a list of rectangles whose union is the room
 * there (an L-shaped room is two), or the single `bounds` rectangle a
 * client that predates shapes sends. It must lie on the floor (inside its
 * outline, not just its grid), must not share a cell with another room on
 * that floor, and must not cut through a placed piece — a piece is either
 * wholly inside a room or wholly outside it, which is what lets membership
 * be derived from position instead of stored.
 *
 * Stored, a level always has `areas` (canonical: the same shape always
 * stores the same rectangles) and `bounds`, their bounding box, so a
 * reader that predates shapes still finds the room.
 */
async function validateLevels(input, building, excludeRoomId, session) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_LEVELS) {
    throw new SpaceError(`A room needs between 1 and ${MAX_LEVELS} levels.`);
  }

  const otherRooms = await Room.find({
    organization: building.organization,
    ...(excludeRoomId ? { _id: { $ne: excludeRoomId } } : {}),
  }).session(session);
  const types = await ResourceType.find({ organization: building.organization }).session(session);
  const typeById = new Map(types.map((type) => [String(type._id), type]));

  const seen = new Set();
  const levels = [];
  for (const item of input) {
    if (!validId(item?.floorId) || seen.has(item.floorId)) {
      throw new SpaceError("Choose a different building floor for each level.");
    }
    seen.add(item.floorId);

    const floor = await Floor.findOne({ _id: item.floorId, building: building._id, site: building.site }).session(session);
    if (!floor) throw new SpaceError("Every room level must be on a floor in this building.", 404);

    const drawn = Array.isArray(item.areas) && item.areas.length ? item.areas : item.bounds ? [item.bounds] : item.areas;
    const { areas, cells, error } = normaliseAreas(drawn, floor.grid, { noun: "room" });
    if (error) throw new SpaceError(error);
    // Inside the building, not just the grid: an L-shaped floor's missing
    // corner is in the grid but is not floor.
    if (!contains(floorCells(floor), cells)) throw new SpaceError("That room reaches outside the floor's outline.");

    // Sharing a single cell is an overlap: rooms tile a floor, never stack.
    const overlapping = otherRooms.some((room) =>
      room.levels.some((level) => String(level.floor) === item.floorId && intersects(regionAreas(level), cells))
    );
    if (overlapping) throw new SpaceError("Rooms cannot overlap on the same floor.", 409);

    const pieces = await Resource.find({ organization: building.organization, floor: floor._id, kind: { $ne: "room" } })
      .session(session);
    for (const piece of pieces) {
      const footprint = pieceBounds(piece, typeById.get(String(piece.resourceType)));
      if (intersects(cells, footprint) && !contains(cells, footprint)) {
        throw new SpaceError(
          "A room boundary cuts through a placed item. Include the entire item or move the boundary.",
          409
        );
      }
    }

    levels.push({
      floor: floor._id,
      name: nameOf(item.name).slice(0, 80),
      bounds: boundingBox(cells),
      areas,
    });
  }
  return levels;
}

/**
 * Refuses a change while the room, or anything inside it, has a live
 * booking. Redrawing a room under a booking would silently change what
 * that booking covers; better to ask for it to be cancelled first.
 */
async function assertNoBookings(room, session) {
  const contents = await roomContents(room, session);
  const booked = await Reservation.exists({
    resource: { $in: [room.resource, ...contents.map((piece) => piece._id)] },
    status: { $in: LIVE_STATUSES },
  }).session(session);
  if (booked) {
    throw new SpaceError(
      "This room or an item inside has an active or upcoming reservation. Cancel it before changing the room.",
      409
    );
  }
}

/**
 * Where a room's booking target is anchored: the top-left cell of its first
 * level's first rectangle. That cell is always inside the room, which the
 * corner of the bounding box is not for every shape (an L lying the other
 * way round has nothing in that corner).
 */
function anchorOf(level) {
  const [first] = regionAreas(level);
  return { col: first.col, row: first.row };
}

/**
 * The internal catalog type every room's booking target uses. Hidden
 * from the catalog (internal) and never drawn as furniture; created the
 * first time an organization draws a room.
 */
async function roomTargetType(organizationId, session) {
  const existing = await ResourceType.findOne({ organization: organizationId, key: "__room" }).session(session);
  if (existing) return existing;
  const [created] = await ResourceType.create(
    [{
      organization: organizationId, key: "__room", label: "Room", footprint: { w: 1, h: 1 },
      seatCount: 1, internal: true, icon: "DoorOpen",
    }],
    { session }
  );
  return created;
}

/**
 * Body: { name, buildingId, bookingMode, levels: [{ floorId, name?, areas }] },
 * where `areas` is a list of { col, row, w, h } (one for a rectangular room,
 * two for an L). A single `bounds` in place of `areas` is still accepted.
 *
 * A room is two documents: the Room (its boundary and rules) and one
 * internal Resource with a single unit, "room" — its booking target, so
 * the existing reservation engine, check-in and workers handle whole-room
 * bookings with no parallel lifecycle.
 */
router.post("/rooms", ...superadmin, run(async (req, res) => {
  const name = nameOf(req.body?.name);
  if (!name) throw new SpaceError("Give this room a name.");
  if (!validId(req.body.buildingId)) throw new SpaceError("Choose a building first.");
  if (!BOOKING_MODES.includes(req.body.bookingMode)) throw new SpaceError("Choose individual, whole, or either booking.");

  const organizationId = req.user.organizationId;
  const room = await withSpaceTransaction(organizationId, async (session, org) => {
    const building = await Building.findOne({ _id: req.body.buildingId, organization: organizationId }).session(session);
    if (!building) throw new SpaceError("Building not found", 404);
    if (req.body.bookingMode !== "individual") await assertFeature(org, "wholeRoomBooking");
    await assertWithinLimit(org, "rooms");

    const levels = await validateLevels(req.body.levels, building, null, session);
    // Furniture already inside the new boundary may have bookings of its own.
    await assertNoBookings({ organization: organizationId, levels, resource: new mongoose.Types.ObjectId() }, session);

    const type = await roomTargetType(organizationId, session);
    const roomId = new mongoose.Types.ObjectId();
    const [target] = await Resource.create(
      [{
        organization: organizationId, floor: levels[0].floor, resourceType: type._id, kind: "room", room: roomId,
        position: anchorOf(levels[0]), units: [{ label: "room" }],
      }],
      { session }
    );
    const [created] = await Room.create(
      [{
        _id: roomId, organization: organizationId, building: building._id, name,
        bookingMode: req.body.bookingMode, levels, resource: target._id,
      }],
      { session }
    );
    return created;
  });
  res.status(201).json({ room: shapeRoom(room) });
}));

/** Body: any of { name, bookingMode, levels }. */
router.patch("/rooms/:id", ...superadmin, run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  const organizationId = req.user.organizationId;

  const room = await withSpaceTransaction(organizationId, async (session, org) => {
    const current = await Room.findOne({ _id: req.params.id, organization: organizationId }).session(session);
    if (!current) throw new SpaceError("Room not found", 404);
    await assertNoBookings(current, session);

    if (req.body.name !== undefined) {
      current.name = nameOf(req.body.name);
      if (!current.name) throw new SpaceError("Give this room a name.");
    }
    if (req.body.bookingMode !== undefined) {
      if (!BOOKING_MODES.includes(req.body.bookingMode)) throw new SpaceError("Invalid booking mode");
      // Only a CHANGE to whole-room booking needs the feature: a room booked
      // whole before a downgrade can still be renamed or redrawn as it is.
      if (req.body.bookingMode !== current.bookingMode && req.body.bookingMode !== "individual") {
        await assertFeature(org, "wholeRoomBooking");
      }
      current.bookingMode = req.body.bookingMode;
    }
    if (req.body.levels !== undefined) {
      const building = await Building.findOne({ _id: current.building, organization: organizationId }).session(session);
      current.levels = await validateLevels(req.body.levels, building, current._id, session);
      // The new boundary may take in furniture that is booked.
      await assertNoBookings(current, session);
      // The booking target sits on the first level, where the map anchors it.
      await Resource.updateOne(
        { _id: current.resource },
        { floor: current.levels[0].floor, position: anchorOf(current.levels[0]) },
        { session }
      );
    }
    await current.save({ session });
    return current;
  });
  res.json({ room: shapeRoom(room) });
}));

/** The room's boundary and booking target go; its furniture and booking history stay. */
router.delete("/rooms/:id", ...superadmin, run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const room = await Room.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!room) throw new SpaceError("Room not found", 404);
    await assertNoBookings(room, session);
    await Resource.deleteOne({ _id: room.resource }, { session });
    await room.deleteOne({ session });
  });
  res.json({ ok: true });
}));

/**
 * ADM-2: staff close and reopen a room. Its boundary and booking mode are
 * the superadmin's; whether it is open today is operations.
 */
router.patch("/rooms/:id/availability", requireAuth, requireRole("staff", "superadmin"), run(async (req, res) => {
  if (!validId(req.params.id)) throw new SpaceError("Invalid room id");
  if (!["available", "unavailable"].includes(req.body?.status)) throw new SpaceError("Choose available or unavailable.");

  const room = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const current = await Room.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
    if (!current) throw new SpaceError("Room not found", 404);
    await assertNoBookings(current, session);
    await Resource.updateOne({ _id: current.resource }, { "units.0.status": req.body.status }, { session });
    return current;
  });
  await announceUnitStatus(room.resource, "room", { io: req.app.get("io") });
  res.json({ ok: true });
}));

/**
 * What the editor's setup steps show as "3 of 5 rooms": the organization's
 * usage of each map limit, counted exactly as the limits are enforced
 * (services/entitlements.js countUsage) so the two can never disagree.
 */
router.get("/usage", ...superadmin, run(async (req, res) => {
  const keys = ["buildings", "floors", "rooms", "resources"];
  const counts = await Promise.all(keys.map((key) => countUsage(req.user.organizationId, key)));
  res.json({ usage: Object.fromEntries(keys.map((key, i) => [key, counts[i]])) });
}));

/* Errors written for the person who caused them; anything else is app.js's to answer. */
router.use((err, req, res, next) => {
  if (!(err instanceof SpaceError)) return next(err);
  res.status(err.status).json({ error: err.message, code: err.code });
});

export default router;
