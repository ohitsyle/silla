import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Building from "../models/Building.js";
import Room from "../models/Room.js";
import { pieceBounds, roomHolds, shapeRoom, withSpaceTransaction } from "../services/spaces.js";
import {
  areasOf, cellKey, cellsOf, contains, floorCells, intersection, normaliseAreas, plainAreas, regionAreas,
} from "../lib/cells.js";
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
import { floorDay } from "../services/reservations/day.js";
import { ReservationError } from "../services/reservations/errors.js";
import { EntitlementError, assertWithinLimit } from "../services/entitlements.js";

const router = Router();

/**
 * Express 4 does not catch rejected promises from async handlers — an
 * unhandled DB error would hang the request instead of erroring. Wrap
 * every async handler so failures reach app.js's error middleware.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Who is looking, if anyone: { id, role } for an active account in this
 * organization, else null.
 *
 * Staff-only fields (overstay, spec §10/§14; who holds a booking) are
 * included when the caller presents a staff token and omitted otherwise.
 * This is not requireAuth: the map itself is readable for the kiosk and
 * home preview. Staff-only details still require an active account in this
 * organization, and a member's own bookings are recognised by the id.
 */
async function readViewer(req, organizationId) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (String(claims.organizationId) !== String(organizationId)) return null;
    const account = await User.findOne({ _id: claims.id, organization: organizationId, active: true }).select("role");
    return account ? { id: String(account._id), role: account.role } : null;
  } catch {
    return null;
  }
}

const readRole = async (req, organizationId) => (await readViewer(req, organizationId))?.role || null;

const isStaff = (role) => role === "staff" || role === "superadmin";

/**
 * A floor's outline as the API returns it: `areas`, the rectangles whose
 * cells are the floor. Empty means the whole grid, which is every floor
 * drawn before outlines existed and every plain rectangle since; readers
 * resolve it with floorAreas() in lib/cells.js.
 */
const shapeOf = (floor) => ({ areas: plainAreas(floor.shape?.areas) });

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
    .select("name order grid shape site building")
    .sort({ order: 1, name: 1 });

  res.json({
    floors: floors.map((f) => ({
      id: f._id.toString(),
      name: f.name,
      order: f.order,
      grid: f.grid,
      shape: shapeOf(f),
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
 *   layout — the slow-changing half: grid, outline, placed pieces,
 *            rooms, zones, labels. Fetched once; only changes when an
 *            admin edits the map. Rooms and zones carry `areas`, their
 *            shape; the floor carries `shape.areas`, its outline.
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

  const floor = await Floor.findById(id).select("name order grid shape site building");
  if (!floor) return res.status(404).json({ error: "Floor not found" });

  // Resource carries `organization` directly, but zones/labels/catalog
  // all scope by org too — resolve it once from the floor's site.
  const site = await Site.findById(floor.site).select("organization name");
  if (!site) return res.status(404).json({ error: "Floor's site not found" });
  const organizationId = site.organization;

  const [resources, zones, labels, resourceTypes, rooms, building] = await Promise.all([
    Resource.find({ floor: floor._id, kind: { $ne: "room" } }).select("floor resourceType position units").sort({ createdAt: 1 }),
    Zone.find({ floor: floor._id }).select("name bounds areas").sort({ name: 1 }),
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
      shape: shapeOf(floor),
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
        // Membership is derived from the room's shape, never stored.
        roomId: rooms.find((room) => roomHolds(room, r, resourceTypes.find((t) => String(t._id) === String(r.resourceType))))?._id?.toString() || null,
        // Only the unit's identity lives in layout; its status lives in
        // `status` above.
        units: r.units.map((u) => ({ label: u.label })),
      })),
      zones: zones.map((z) => ({ id: z._id.toString(), name: z.name, bounds: plainAreas([z.bounds])[0], areas: regionAreas(z) })),
      labels: labels.map((l) => ({ id: l._id.toString(), text: l.text, position: l.position })),
    },
    status,
    viewerIsStaff: staff,
  });
}));

/**
 * GET /api/floors/:id/day?date=YYYY-MM-DD
 *
 * The rest of the picture the layout's `status` cannot give: for one date
 * (today when none is given), every bookable unit's booked stretches from
 * opening to closing, whether it is free now and until when, and a day
 * state — free, partial, full, or closed — for the map's ring. Rooms'
 * whole-room targets are included, keyed by their resource id like the
 * layout's `status`. See services/reservations/day.js.
 *
 * Readable like the layout: the kiosk has no session. A signed-in member's
 * own bookings come back marked `mine`; only staff and superadmins of this
 * organization see who holds the rest.
 */
router.get("/:id/day", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid floor id" });
  const floor = await Floor.findById(id).select("site");
  if (!floor) return res.status(404).json({ error: "Floor not found" });
  const site = await Site.findById(floor.site).select("organization");
  if (!site) return res.status(404).json({ error: "Floor's site not found" });
  const viewer = await readViewer(req, site.organization);
  try {
    res.json(await floorDay({ floorId: id, date: req.query.date, viewer }));
  } catch (err) {
    if (err instanceof ReservationError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
}));

/* ══════════════════════════════════════════════════════════════════
 * Floor management — SUPERADMIN ONLY.
 *
 * Adding a floor and changing how big a room is are structural changes
 * to what the deployment *is*, so they sit with the rest of the
 * layout-editing powers rather than with day-to-day operation (spec §14:
 * the superadmin manages system settings).
 *
 * A floor is a grid of whole cells and, for a building that is not a
 * rectangle, an outline: `shape.areas`, the rectangles whose cells ARE the
 * floor. Without one, the whole grid is floor. Whatever changes the floor's
 * cells (a new outline, a smaller grid) is refused while anything on the
 * floor would be left outside them, and the refusal says what — the same
 * doctrine as everywhere else: an error message beats silently stranding
 * bookable furniture off the edge of the map.
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
 * A floor's outline as sent, checked against its grid and ready to store:
 * the canonical rectangles of the floor's cells, or [] for the whole grid.
 *
 * No shape, `shape: null`, no `areas` and an empty `areas` all mean the whole grid;
 * that is how "Reset to rectangle" is said. An outline covering every cell
 * of the grid is stored as [] too, so it keeps the meaning a plain floor
 * has always had: grow the grid and the floor grows with it.
 */
function outlineFrom(shape, grid) {
  if (shape === null || shape === undefined) return [];
  if (typeof shape !== "object" || Array.isArray(shape)) {
    throw bad("Send the floor's outline as { areas: [{ col, row, w, h }, …] }.");
  }
  if (shape.areas === undefined || shape.areas === null || (Array.isArray(shape.areas) && !shape.areas.length)) return [];
  const { areas, cells, error } = normaliseAreas(shape.areas, grid, { noun: "floor outline" });
  if (error) throw bad(error);
  return cells.size === grid.cols * grid.rows ? [] : areas;
}

/**
 * A shaped floor's outline after its grid is resized: whatever of it is
 * inside the new edge. Growing the grid only adds room to draw into;
 * shrinking trims the outline, and anything standing in the trimmed part is
 * refused like any other removal. A plain floor is its whole grid at any
 * size, so it has nothing to trim.
 */
function trimOutline(outline, grid) {
  if (!outline.length) return [];
  const kept = intersection(cellsOf(outline), cellsOf([{ col: 0, row: 0, w: grid.cols, h: grid.rows }]));
  if (!kept.size) {
    throw bad("None of the floor's outline would be left at that size. Choose a larger size, or reset the outline to a rectangle first.", 409);
  }
  return kept.size === grid.cols * grid.rows ? [] : areasOf(kept);
}

/**
 * POST /api/floors
 * Body: { siteId?, buildingId?, name, order?, grid: { cols, rows }, shape?: { areas } }
 */
const floorShape = (f, site) => ({ id: String(f._id), name: f.name, order: f.order, grid: f.grid, shape: shapeOf(f), buildingId: f.building ? String(f.building) : null, site: { id: String(site._id), name: site.name } });
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function ownedFloor(id, orgId, session) {
  if (!mongoose.isValidObjectId(id)) throw bad("Invalid floor id");
  const floor = await Floor.findById(id).session(session);
  const site = floor && await Site.findOne({ _id: floor.site, organization: orgId }).session(session);
  if (!site) throw bad("Floor not found", 404);
  return { floor, site };
}
router.post("/", requireAuth, requireRole("superadmin"), asyncHandler(async (req, res) => {
  const result = await withSpaceTransaction(req.user.organizationId, async (session, org) => {
    const { siteId, buildingId, name, order, grid, shape } = req.body || {};
    if (typeof name !== "string" || !name.trim()) throw bad("A floor name is required");
    const cols = grid?.cols ?? 20, rows = grid?.rows ?? 12;
    const error = validateGrid(cols, rows); if (error) throw bad(error);
    const outline = outlineFrom(shape, { cols, rows });
    if (siteId && !mongoose.isValidObjectId(siteId)) throw bad("Invalid site id");
    let site = await Site.findOne({ organization: req.user.organizationId, ...(siteId ? { _id: siteId } : {}) }).session(session);
    if (!site) throw bad("Site not found", 404);
    if (buildingId && !mongoose.isValidObjectId(buildingId)) throw bad("Invalid building id");
    const building = await Building.findOne({ organization: req.user.organizationId, ...(buildingId ? { _id: buildingId } : { site: site._id }) }).session(session);
    if (buildingId && !building) throw bad("Building not found", 404);
    if (building) site = await Site.findById(building.site).session(session);
    // The plan's floor limit, checked inside the transaction like every create.
    await assertWithinLimit(org, "floors");
    const count = await Floor.countDocuments({ site: site._id, building: building?._id || null }).session(session);
    const [floor] = await Floor.create([{
      site: site._id, building: building?._id || null, name: name.trim().slice(0, 120),
      order: Number.isInteger(order) ? order : count, grid: { cols, rows },
      ...(outline.length ? { shape: { areas: outline } } : {}),
    }], { session });
    return floorShape(floor, site);
  });
  res.status(201).json({ floor: result });
}));
/**
 * PATCH /api/floors/:id
 * Body: any of { name, order, buildingId, grid: { cols, rows }, shape: { areas } | null }
 *
 * `shape` replaces the outline (null or empty areas: the whole grid). A new
 * grid alone keeps a shaped floor's outline, trimmed to the new edge.
 */
router.patch("/:id", requireAuth, requireRole("superadmin"), asyncHandler(async (req, res) => {
  const result = await withSpaceTransaction(req.user.organizationId, async (session) => {
    const { floor, site } = await ownedFloor(req.params.id, req.user.organizationId, session);
    const { name, order, grid, buildingId, shape } = req.body || {};
    if (grid || shape !== undefined) {
      const size = { cols: grid?.cols ?? floor.grid.cols, rows: grid?.rows ?? floor.grid.rows };
      const error = validateGrid(size.cols, size.rows); if (error) throw bad(error);
      const outline = shape !== undefined ? outlineFrom(shape, size) : trimOutline(plainAreas(floor.shape?.areas), size);
      const stranded = await findStranded(floor._id, floorCells({ grid: size, shape: { areas: outline } }), session);
      if (stranded.length) throw Object.assign(bad(strandedMessage(stranded), 409), { outside: stranded.slice(0, 10) });
      floor.grid = size;
      // Unset rather than store [] for a plain floor: absent is what every
      // rectangular floor has always looked like.
      floor.set("shape.areas", outline.length ? outline : undefined);
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
// Plan refusals go on to app.js, which answers them with their full detail
// (limit, max, used); everything else with a status is this router's own.
router.use((err, req, res, next) => {
  if (err instanceof EntitlementError || !err.status) return next(err);
  res.status(err.status).json({
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.outside ? { outside: err.outside } : {}),
  });
});

/**
 * Everything on the floor that would be left outside `cells`, the floor's
 * proposed cells: room levels, pieces, zones and labels, each with its id so
 * the editor can point at it.
 *
 * Read one after another, never in parallel: they share the transaction's
 * session, and operations on one session must not run concurrently.
 */
async function findStranded(floorId, cells, session) {
  const rooms = await Room.find({ "levels.floor": floorId }).select("name levels").session(session);
  const resources = await Resource.find({ floor: floorId, kind: { $ne: "room" } }).select("position resourceType").session(session);
  const zones = await Zone.find({ floor: floorId }).select("name bounds areas").session(session);
  const labels = await Label.find({ floor: floorId }).select("text position").session(session);
  const types = await ResourceType.find({
    _id: { $in: [...new Set(resources.map((r) => r.resourceType.toString()))] },
  }).select("footprint label").session(session);
  const typeById = new Map(types.map((t) => [t._id.toString(), t]));
  const at = ({ col, row }) => ({ col, row });

  const stranded = [];
  for (const room of rooms) {
    const level = room.levels.find((l) => String(l.floor) === String(floorId));
    if (!contains(cells, regionAreas(level))) stranded.push({ kind: "room", id: String(room._id), name: room.name });
  }
  for (const piece of resources) {
    const type = typeById.get(piece.resourceType.toString());
    if (!contains(cells, pieceBounds(piece, type))) {
      stranded.push({ kind: "resource", id: String(piece._id), at: at(piece.position), label: type?.label });
    }
  }
  for (const zone of zones) {
    if (!contains(cells, regionAreas(zone))) stranded.push({ kind: "zone", id: String(zone._id), at: at(zone.bounds), label: zone.name });
  }
  for (const label of labels) {
    if (!cells.has(cellKey(label.position.col, label.position.row))) {
      stranded.push({ kind: "label", id: String(label._id), at: at(label.position), label: label.text });
    }
  }
  return stranded;
}

/**
 * The refusal, said for the person reshaping the floor: "3 pieces and the
 * room “Commons” are in the part you're removing. Move or remove them
 * first." Pieces are counted (a floor can hold hundreds); rooms, zones and
 * labels are named while there are few enough to read.
 */
function strandedMessage(stranded) {
  const of = (kind) => stranded.filter((item) => item.kind === kind);
  const parts = [];
  const pieces = of("resource").length;
  if (pieces) parts.push(`${pieces} ${pieces === 1 ? "piece" : "pieces"}`);
  for (const [kind, one, many, nameOf] of [
    ["room", "room", "rooms", (item) => item.name],
    ["zone", "zone", "zones", (item) => item.label],
    ["label", "label", "labels", (item) => item.label],
  ]) {
    const items = of(kind);
    if (!items.length) continue;
    const names = items.map((item) => `“${nameOf(item)}”`);
    parts.push(items.length === 1 ? `the ${one} ${names[0]}` : items.length <= 3 ? `the ${many} ${listOf(names)}` : `${items.length} ${many}`);
  }
  const sentence = listOf(parts);
  const one = stranded.length === 1;
  return `${sentence[0].toUpperCase()}${sentence.slice(1)} ${one ? "is" : "are"} in the part you're removing. Move or remove ${one ? "it" : "them"} first.`;
}

/** "a", "a and b", "a, b and c". */
const listOf = (items) => (items.length <= 1 ? items[0] || "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export default router;
