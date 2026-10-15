import { Router } from "express";
import mongoose from "mongoose";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Floor from "../models/Floor.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import Reservation from "../models/Reservation.js";
import Room from "../models/Room.js";
import { roomHolds, withSpaceTransaction } from "../services/spaces.js";
import {
  boundingBox, cellKey, contains, floorCells, intersects, normaliseAreas, plainAreas, regionAreas,
} from "../lib/cells.js";
import Site from "../models/Site.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";
import { EntitlementError, assertWithinLimit } from "../services/entitlements.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Structural map editing is SUPERADMIN-ONLY.
 *
 * Every write here runs inside withSpaceTransaction (services/spaces.js),
 * like every other structural write, so it cannot interleave with a change
 * to the floor's outline: a piece, zone or label is only ever placed on
 * cells that are floor when it commits. Everything placed must sit inside
 * the floor's outline (lib/cells.js floorCells), not merely its grid.
 *
 * Placing and removing pieces, drawing zones and adding labels change
 * what the space *is* — they are configuration, not operation. Staff run
 * the space day to day and can change any unit's availability or service
 * status (that lives on the admin router, deliberately at staff level),
 * but they cannot redraw the floor.
 *
 * Spec §14 splits the surface this way: staff get the operational views;
 * the superadmin additionally manages "system settings", which is what
 * the layout is.
 */
router.use(requireAuth, requireRole("superadmin"));

/**
 * Resolve a client-supplied floorId, but ONLY within the caller's own
 * organization.
 *
 * Floors hang off sites, and sites carry the organization — so a bare
 * Floor.findById is not org-scoped, it just looks like it is. Without
 * this, a superadmin of one deployment could place pieces, draw zones
 * and drop labels onto ANOTHER deployment's floor by passing its id:
 * the new documents are stamped with the caller's organization, but the
 * map reads by floor, so they render on the victim's map. Worse for
 * pieces, whose resourceType then belongs to a catalog the victim does
 * not have, so their client receives something it cannot draw.
 *
 * 404 rather than 403 on a foreign floor: whether a given id exists in
 * someone else's deployment is not this caller's business.
 *
 * floor.routes.js does exactly this before every structural write; this
 * is the same check, which is where it should have been all along.
 *
 * `session` is the space transaction's, so the floor (and its outline) is
 * read on the same snapshot as everything the write then checks.
 */
async function floorInOrg(floorId, organizationId, session = null) {
  const floor = await Floor.findById(floorId).session(session);
  if (!floor) return null;
  const site = await Site.findById(floor.site).select("organization").session(session);
  if (!site || site.organization.toString() !== String(organizationId)) return null;
  return floor;
}

/** An error this router answers with its own status and message. */
const refuse = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * MAP-3 — "Pick from catalog; click cell to place / remove; Overlap
 * prevented by occupied-cell check."
 *
 * The overlap check is the load-bearing rule (spec §8): fixed footprints
 * and no free-shaping are exactly what make it a simple cell test rather
 * than polygon intersection. It runs on the server because the client's
 * copy of the layout can be stale.
 */
async function findOverlap({ floorId, col, row, w, h, excludeResourceId = null }, session) {
  const filter = { floor: floorId, kind: { $ne: "room" } };
  if (excludeResourceId) filter._id = { $ne: excludeResourceId };

  const existing = await Resource.find(filter).session(session);
  const types = await ResourceType.find({
    _id: { $in: [...new Set(existing.map((r) => r.resourceType.toString()))] },
  }).session(session);
  const typeById = new Map(types.map((t) => [t._id.toString(), t]));

  const wanted = new Set();
  for (let dc = 0; dc < w; dc += 1) {
    for (let dr = 0; dr < h; dr += 1) wanted.add(`${col + dc},${row + dr}`);
  }

  for (const resource of existing) {
    const type = typeById.get(resource.resourceType.toString());
    const fw = type?.footprint?.w ?? 1;
    const fh = type?.footprint?.h ?? 1;
    for (let dc = 0; dc < fw; dc += 1) {
      for (let dr = 0; dr < fh; dr += 1) {
        if (wanted.has(`${resource.position.col + dc},${resource.position.row + dr}`)) {
          return { resource, type };
        }
      }
    }
  }
  return null;
}

/**
 * POST /api/resources
 * Body: { floorId, resourceTypeKey, col, row }
 * MAP-3 — place a catalog piece on an empty cell.
 */
router.post("/", asyncHandler(async (req, res) => {
  const { floorId, resourceTypeKey, col, row } = req.body || {};
  if (!mongoose.isValidObjectId(floorId) || !Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return res.status(400).json({ error: "Choose a floor and an integer grid position." });
  const resource = await withSpaceTransaction(req.user.organizationId, async (session, org) => {
    const floor = await floorInOrg(floorId, req.user.organizationId, session);
    if (!floor) throw refuse("Floor not found", 404);
    const type = await ResourceType.findOne({ organization: req.user.organizationId, key: resourceTypeKey, internal: { $ne: true } }).session(session);
    if (!type) throw refuse("Catalog type not found", 404);
    const { w, h } = type.footprint;
    if (col + w > floor.grid.cols || row + h > floor.grid.rows) throw refuse("That item extends beyond the floor.");
    // Every cell of the footprint must be floor: on an L-shaped floor the
    // missing corner is inside the grid but is not part of the building.
    if (!contains(floorCells(floor), { col, row, w, h })) throw refuse("That item would stand outside the floor's outline.");
    if (await findOverlap({ floorId, col, row, w, h }, session)) throw refuse("That item overlaps an existing piece.", 409);
    const rooms = await Room.find({ organization: req.user.organizationId, "levels.floor": floorId }).session(session);
    for (const room of rooms) {
      // The room's shape on this floor: an L-shaped room is both its arms.
      const level = regionAreas(room.levels.find((l) => String(l.floor) === String(floorId)));
      if (intersects(level, { col, row, w, h }) && !contains(level, { col, row, w, h })) throw refuse("Place the entire item inside or outside the room boundary.", 409);
      if (contains(level, { col, row, w, h }) && await Reservation.exists({ resource: room.resource, status: { $in: LIVE_STATUSES } }).session(session)) throw refuse("This room has a live reservation. Cancel it before changing its contents.", 409);
    }
    // The plan counts bookable units, so a piece adds its seats; one that
    // is not bookable (a shelf) adds none and is never refused for it.
    const adding = type.reservable === false ? 0 : Math.max(1, type.seatCount ?? 1);
    if (adding) await assertWithinLimit(org, "resources", adding);
    const [r] = await Resource.create([{ organization: req.user.organizationId, floor: floorId, resourceType: type._id, position: { col, row }, units: Array.from({ length: type.seatCount }, (_, i) => ({ label: String(i + 1) })) }], { session });
    return r;
  });
  res.status(201).json({ resource: { id: String(resource._id), resourceType: String(resource.resourceType), position: resource.position, units: resource.units.map((u) => ({ label: u.label })) } });
}));
router.delete("/:id", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid resource id" });
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const r = await Resource.findOne({ _id: req.params.id, organization: req.user.organizationId, kind: { $ne: "room" } }).session(session);
    if (!r) throw refuse("Resource not found", 404);
    const type = await ResourceType.findById(r.resourceType).session(session);
    const rooms = await Room.find({ organization: req.user.organizationId, "levels.floor": r.floor }).session(session);
    const related = rooms.filter((room) => roomHolds(room, r, type));
    if (await Reservation.exists({ resource: { $in: [r._id, ...related.map((room) => room.resource)] }, status: { $in: LIVE_STATUSES } }).session(session)) throw refuse("This item or its room has an active or upcoming reservation. Cancel it first.", 409);
    await r.deleteOne({ session });
  });
  res.json({ ok: true });
}));

/* ══════════════════ MAP-4 — Zones ══════════════════ */

/**
 * A zone as the API returns it: `areas` is its shape and `bounds` their
 * bounding box. A zone written before shapes reports its one bounds as its
 * one area, so a reader only ever needs `areas`.
 */
const shapeZone = (zone) => ({
  id: zone._id.toString(),
  name: zone.name,
  bounds: plainAreas([zone.bounds])[0],
  areas: regionAreas(zone),
});

/**
 * A zone's drawn shape, checked against its floor and ready to store.
 * Whole cells inside the grid, and every one of them floor.
 */
function zoneShape(drawn, floor) {
  const { areas, cells, error } = normaliseAreas(drawn, floor.grid, { noun: "zone" });
  if (error) throw refuse(error);
  if (!contains(floorCells(floor), cells)) throw refuse("That zone reaches outside the floor's outline.");
  return { areas, bounds: boundingBox(cells) };
}

/**
 * POST /api/resources/zones
 * Body: { floorId, name, areas: [{ col, row, w, h }, …] }, or the single
 * rectangle as { floorId, name, col, row, w, h }.
 *
 * "Drag rectangle; name it; Membership derived from position."
 * No membership is stored — a zone is a shape and nothing more
 * (spec §12).
 */
router.post(
  "/zones",
  asyncHandler(async (req, res) => {
    const { floorId, name, areas, col, row, w, h } = req.body || {};
    if (!floorId || !mongoose.isValidObjectId(floorId)) {
      return res.status(400).json({ error: "A valid floorId is required" });
    }
    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "A zone name is required" });
    const drawn = Array.isArray(areas) ? areas : [{ col, row, w, h }];

    const zone = await withSpaceTransaction(req.user.organizationId, async (session) => {
      const floor = await floorInOrg(floorId, req.user.organizationId, session);
      if (!floor) throw refuse("Floor not found", 404);
      const [created] = await Zone.create(
        [{ organization: req.user.organizationId, floor: floorId, name: name.trim(), ...zoneShape(drawn, floor) }],
        { session }
      );
      return created;
    });
    res.status(201).json({ zone: shapeZone(zone) });
  })
);

/** Body: any of { name, areas } — rename, or reshape (an L-shaped zone is two areas). */
router.patch(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid zone id" });
    const zone = await withSpaceTransaction(req.user.organizationId, async (session) => {
      const current = await Zone.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
      if (!current) throw refuse("Zone not found", 404);
      if (typeof req.body?.name === "string" && req.body.name.trim()) current.name = req.body.name.trim();
      if (req.body?.areas !== undefined) {
        const floor = await floorInOrg(current.floor, req.user.organizationId, session);
        if (!floor) throw refuse("Floor not found", 404);
        const { areas, bounds } = zoneShape(req.body.areas, floor);
        current.areas = areas;
        current.bounds = bounds;
      }
      await current.save({ session });
      return current;
    });
    res.json({ zone: shapeZone(zone) });
  })
);

router.delete(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid zone id" });
    await withSpaceTransaction(req.user.organizationId, async (session) => {
      await Zone.deleteOne({ _id: req.params.id, organization: req.user.organizationId }, { session });
    });
    res.json({ ok: true });
  })
);

/* ══════════════════ MAP-5 — Labels ══════════════════ */

/**
 * POST /api/resources/labels
 * "Place text anywhere; non-reservable; Excluded from analytics."
 *
 * Labels are the cheapest layer by design — free text at a cell, with no
 * overlap rule, because they are orientation only and never reservable.
 */
router.post(
  "/labels",
  asyncHandler(async (req, res) => {
    const { floorId, text, col, row } = req.body || {};
    if (!floorId || !mongoose.isValidObjectId(floorId)) {
      return res.status(400).json({ error: "A valid floorId is required" });
    }
    if (!text?.trim()) return res.status(400).json({ error: "Label text is required" });
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) {
      return res.status(400).json({ error: "col and row must be non-negative integers" });
    }

    const label = await withSpaceTransaction(req.user.organizationId, async (session) => {
      const floor = await floorInOrg(floorId, req.user.organizationId, session);
      if (!floor) throw refuse("Floor not found", 404);
      if (col >= floor.grid.cols || row >= floor.grid.rows) throw refuse("That label falls outside the grid.");
      if (!floorCells(floor).has(cellKey(col, row))) throw refuse("Place the label on the floor, inside its outline.");
      const [created] = await Label.create(
        [{ organization: req.user.organizationId, floor: floorId, text: text.trim(), position: { col, row } }],
        { session }
      );
      return created;
    });

    res.status(201).json({ label: { id: label._id.toString(), text: label.text, position: label.position } });
  })
);

router.delete(
  "/labels/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid label id" });
    await withSpaceTransaction(req.user.organizationId, async (session) => {
      await Label.deleteOne({ _id: req.params.id, organization: req.user.organizationId }, { session });
    });
    res.json({ ok: true });
  })
);

// Plan refusals go on to app.js, which answers them with their full detail.
router.use((err, req, res, next) => {
  if (err instanceof EntitlementError || !err.status) return next(err);
  res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
});
export default router;
