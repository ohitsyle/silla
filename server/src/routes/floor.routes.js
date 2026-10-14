import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Building from "../models/Building.js";
import Room from "../models/Room.js";
import { shapeRoom, contains, pieceBounds, withSpaceTransaction } from "../services/spaces.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import Reservation from "../models/Reservation.js";
import User from "../models/User.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";

const router = Router();

/**
 * Express 4 does not catch rejected promises from async handlers — an
 * unhandled DB error would hang the request instead of erroring. Wrap
 * every async handler so failures reach app.js's error middleware.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Staff-only fields (overstay, spec §10/§14) are included when the
 * caller presents a staff token and omitted otherwise. This is not
 * requireAuth: the map itself is readable for the kiosk and home preview.
 * Staff-only details still require an active account in this organization.
 */
async function readRole(req, organizationId) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (String(claims.organizationId) !== String(organizationId)) return null;
    const account = await User.findOne({ _id: claims.id, organization: organizationId, active: true }).select("role");
    return account?.role || null;
  } catch {
    return null;
  }
}

const isStaff = (role) => role === "staff" || role === "superadmin";

/**
 * GET /api/floors?organizationId=...
 *
 * The floor switcher's data source (MAP-1: "multi-floor map ... floor
 * switcher"). Floors hang off sites, so this resolves the org's sites
 * first — multi-site is in the data model from the start (spec §2) even
 * though the management UI for it is fast-follow.
 */
router.get("/", asyncHandler(async (req, res) => {
  const { organizationId } = req.query;
  if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
    return res.status(400).json({ error: "A valid organizationId query parameter is required" });
  }

  const sites = await Site.find({ organization: organizationId }).select("_id name");
  if (!sites.length) return res.json({ floors: [] });

  const siteNames = new Map(sites.map((s) => [s._id.toString(), s.name]));
  const floors = await Floor.find({ site: { $in: sites.map((s) => s._id) } })
    .select("name order grid site building")
    .sort({ order: 1, name: 1 });

  res.json({
    floors: floors.map((f) => ({
      id: f._id.toString(),
      name: f.name,
      order: f.order,
      grid: f.grid,
      buildingId: f.building ? String(f.building) : null,
      site: { id: f.site.toString(), name: siteNames.get(f.site.toString()) || null },
    })),
  });
}));

/**
 * GET /api/floors/:id/layout
 *
 * One REST read that boots the map (MAP-1). The response deliberately
 * splits into `layout` and `status`:
 *
 *   layout — the slow-changing half: grid, placed pieces, zones, labels.
 *            Fetched once; only changes when an admin edits the map.
 *   status — the fast-changing half: per-unit availability, keyed by
 *            resource id. This snapshot is what Socket.io will later
 *            patch entry-by-entry (MAP-2, spec §12/§17: "the layout is
 *            stored per floor and kept separate from live occupancy
 *            status, which streams over Socket.io").
 *
 * Keeping the split structural rather than conventional means MAP-2 is
 * a new socket handler replacing entries in `status`, not a refactor of
 * the renderer.
 */
router.get("/:id/layout", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid floor id" });
  }

  const floor = await Floor.findById(id).select("name order grid site building");
  if (!floor) return res.status(404).json({ error: "Floor not found" });

  // Resource carries `organization` directly, but zones/labels/catalog
  // all scope by org too — resolve it once from the floor's site.
  const site = await Site.findById(floor.site).select("organization name");
  if (!site) return res.status(404).json({ error: "Floor's site not found" });
  const organizationId = site.organization;

  const [resources, zones, labels, resourceTypes, rooms, building] = await Promise.all([
    Resource.find({ floor: floor._id, kind: { $ne: "room" } }).select("resourceType position units").sort({ createdAt: 1 }),
    Zone.find({ floor: floor._id }).select("name bounds").sort({ name: 1 }),
    Label.find({ floor: floor._id }).select("text position"),
    ResourceType.find({ organization: organizationId, internal: { $ne: true } }).select(
      "key label footprint seatCount reservable icon hasServiceStatus"
    ),
    Room.find({ organization: organizationId, "levels.floor": floor._id }),
    floor.building ? Building.findById(floor.building) : null,
  ]);

  const staff = isStaff(await readRole(req, organizationId));

  const roomTargets = await Resource.find({ _id: { $in: rooms.map((r) => r.resource) } });
  const status = {};
  for (const resource of [...resources, ...roomTargets]) {
    status[resource._id.toString()] = resource.units.map((unit) => ({
      status: unit.status,
      serviceStatus: unit.serviceStatus,
      // Overstay is a staff-only alert state (spec §10, §14) — never
      // exposed on the member-facing map.
      ...(staff ? { overstay: unit.overstay } : {}),
    }));
  }

  res.json({
    floor: {
      id: floor._id.toString(),
      name: floor.name,
      order: floor.order,
      grid: floor.grid,
      site: { id: site._id.toString(), name: site.name },
      building: building ? { id: String(building._id), name: building.name } : null,
    },
    resourceTypes: resourceTypes.map((t) => ({
      id: t._id.toString(),
      key: t.key,
      label: t.label,
      footprint: t.footprint,
      seatCount: t.seatCount,
      reservable: t.reservable,
      icon: t.icon,
      hasServiceStatus: t.hasServiceStatus,
    })),
    layout: {
      rooms: rooms.map(shapeRoom),
      resources: resources.map((r) => ({
        id: r._id.toString(),
        resourceType: r.resourceType.toString(),
        position: r.position,
        roomId: rooms.find((room) => room.levels.some((l) => String(l.floor) === String(floor._id) && contains(l.bounds, pieceBounds(r, resourceTypes.find((t) => String(t._id) === String(r.resourceType))))))?._id?.toString() || null,
        // Only the unit's identity lives in layout; its status lives in
        // `status` above.
        units: r.units.map((u) => ({ label: u.label })),
      })),
      zones: zones.map((z) => ({ id: z._id.toString(), name: z.name, bounds: z.bounds })),
      labels: labels.map((l) => ({ id: l._id.toString(), text: l.text, position: l.position })),
    },
    status,
    viewerIsStaff: staff,
  });
}));

/* ══════════════════════════════════════════════════════════════════
 * Floor management — SUPERADMIN ONLY.
 *
 * Adding a floor and changing how big a room is are structural changes
 * to what the deployment *is*, so they sit with the rest of the
 * layout-editing powers rather than with day-to-day operation (spec §14:
 * the superadmin manages system settings).
 * ══════════════════════════════════════════════════════════════════ */

const GRID_LIMITS = { min: 1, max: 60 };

function validateGrid(cols, rows) {
  for (const [name, value] of [["cols", cols], ["rows", rows]]) {
    if (!Number.isInteger(value) || value < GRID_LIMITS.min || value > GRID_LIMITS.max) {
      return `grid.${name} must be a whole number between ${GRID_LIMITS.min} and ${GRID_LIMITS.max}`;
    }
  }
  return null;
}

/**
 * POST /api/floors
 * Body: { siteId?, name, order?, grid: { cols, rows } }
 */
const floorShape = (f, site) => ({ id: String(f._id), name: f.name, order: f.order, grid: f.grid, buildingId: f.building ? String(f.building) : null, site: { id: String(site._id), name: site.name } });
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function ownedFloor(id, orgId, session) {
  if (!mongoose.isValidObjectId(id)) throw bad("Invalid floor id");
  const floor = await Floor.findById(id).session(session);
  const site = floor && await Site.findOne({ _id: floor.site, organization: orgId }).session(session);
  if (!site) throw bad("Floor not found", 404);
  return { floor, site };
}
router.post("/", requireAuth, requireRole("superadmin"), asyncHandler(async (req, res) => {
  const result = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const { siteId, buildingId, name, order, grid } = req.body || {};
    if (typeof name !== "string" || !name.trim()) throw bad("A floor name is required");
    const cols = grid?.cols ?? 20, rows = grid?.rows ?? 12;
    const error = validateGrid(cols, rows); if (error) throw bad(error);
    if (siteId && !mongoose.isValidObjectId(siteId)) throw bad("Invalid site id");
    let site = await Site.findOne({ organization: req.user.organizationId, ...(siteId ? { _id: siteId } : {}) }).session(session);
    if (!site) throw bad("Site not found", 404);
    if (buildingId && !mongoose.isValidObjectId(buildingId)) throw bad("Invalid building id");
    const building = await Building.findOne({ organization: req.user.organizationId, ...(buildingId ? { _id: buildingId } : { site: site._id }) }).session(session);
    if (buildingId && !building) throw bad("Building not found", 404);
    if (building) site = await Site.findById(building.site).session(session);
    const count = await Floor.countDocuments({ site: site._id, building: building?._id || null }).session(session);
    const [floor] = await Floor.create([{ site: site._id, building: building?._id || null, name: name.trim().slice(0, 120), order: Number.isInteger(order) ? order : count, grid: { cols, rows } }], { session });
    return floorShape(floor, site);
  });
  res.status(201).json({ floor: result });
}));
router.patch("/:id", requireAuth, requireRole("superadmin"), asyncHandler(async (req, res) => {
  const result = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const { floor, site } = await ownedFloor(req.params.id, req.user.organizationId, session);
    const { name, order, grid, buildingId } = req.body || {};
    if (grid) {
      const cols = grid.cols ?? floor.grid.cols, rows = grid.rows ?? floor.grid.rows;
      const error = validateGrid(cols, rows); if (error) throw bad(error);
      const outside = await findOutsideGrid(floor._id, cols, rows, session);
      if (outside.length) throw Object.assign(bad("Move or remove items and room levels outside the new grid first.", 409), { outside: outside.slice(0, 10) });
      floor.grid = { cols, rows };
    }
    if (buildingId !== undefined && String(floor.building) !== buildingId) {
      if (!mongoose.isValidObjectId(buildingId)) throw bad("Invalid building id");
      const b = await Building.findOne({ _id: buildingId, organization: req.user.organizationId, site: floor.site }).session(session);
      if (!b) throw bad("Choose a building at the same site.", 404);
      if (await Room.exists({ "levels.floor": floor._id }).session(session)) throw bad("Move this floor's room levels before changing its building.", 409);
      floor.building = b._id;
    }
    if (name !== undefined) { if (typeof name !== "string" || !name.trim()) throw bad("A floor name is required"); floor.name = name.trim().slice(0, 120); }
    if (Number.isInteger(order)) floor.order = order;
    await floor.save({ session });
    return floorShape(floor, site);
  });
  res.json({ floor: result });
}));
router.delete("/:id", requireAuth, requireRole("superadmin"), asyncHandler(async (req, res) => {
  await withSpaceTransaction(req.user.organizationId, async (session) => {
    const { floor } = await ownedFloor(req.params.id, req.user.organizationId, session);
    if (await Room.exists({ "levels.floor": floor._id }).session(session)) throw bad("Move or remove this floor's room levels first.", 409);
    const pieces = await Resource.find({ floor: floor._id }).session(session);
    if (pieces.length) throw bad("Remove the placed items before deleting this floor.", 409);
    if (await Floor.countDocuments({ site: floor.site }).session(session) <= 1) throw bad("A site must keep at least one floor.", 409);
    await Zone.deleteMany({ floor: floor._id }).session(session);
    await Label.deleteMany({ floor: floor._id }).session(session);
    await floor.deleteOne({ session });
  });
  res.json({ ok: true });
}));
router.use((err, req, res, next) => err.status ? res.status(err.status).json({ error: err.message, ...(err.outside ? { outside: err.outside } : {}) }) : next(err));

/** Pieces, zones or labels that would fall outside a proposed grid. */
async function findOutsideGrid(floorId, cols, rows, session) {
  const [resources, zones, labels] = await Promise.all([
    Resource.find({ floor: floorId, kind: { $ne: "room" } }).select("position resourceType").session(session),
    Zone.find({ floor: floorId }).select("name bounds").session(session),
    Label.find({ floor: floorId }).select("text position").session(session),
  ]);
  const types = await ResourceType.find({
    _id: { $in: [...new Set(resources.map((r) => r.resourceType.toString()))] },
  }).select("footprint label").session(session);
  const typeById = new Map(types.map((t) => [t._id.toString(), t]));

  const outside = [];
  const rooms = await Room.find({ "levels.floor": floorId }).session(session);
  for (const r of rooms) for (const l of r.levels) if (String(l.floor) === String(floorId) && (l.bounds.col + l.bounds.w > cols || l.bounds.row + l.bounds.h > rows)) outside.push({ kind: "room", name: r.name });
  for (const r of resources) {
    const f = typeById.get(r.resourceType.toString())?.footprint || { w: 1, h: 1 };
    if (r.position.col + f.w > cols || r.position.row + f.h > rows) {
      outside.push({ kind: "resource", at: r.position, label: typeById.get(r.resourceType.toString())?.label });
    }
  }
  for (const z of zones) {
    if (z.bounds.col + z.bounds.w > cols || z.bounds.row + z.bounds.h > rows) {
      outside.push({ kind: "zone", at: { col: z.bounds.col, row: z.bounds.row }, label: z.name });
    }
  }
  for (const l of labels) {
    if (l.position.col >= cols || l.position.row >= rows) {
      outside.push({ kind: "label", at: l.position, label: l.text });
    }
  }
  return outside;
}

export default router;
