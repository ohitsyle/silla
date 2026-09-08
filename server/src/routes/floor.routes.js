import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import Reservation from "../models/Reservation.js";
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
 * requireAuth: the map itself is readable without a session for now,
 * matching /api/organizations/:id/config, because no member login
 * screen exists yet (AUTH-1 has a route, no client). Swap this for
 * requireAuth once the member session lands.
 */
function readRole(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET).role;
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
    .select("name order grid site")
    .sort({ order: 1, name: 1 });

  res.json({
    floors: floors.map((f) => ({
      id: f._id.toString(),
      name: f.name,
      order: f.order,
      grid: f.grid,
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

  const floor = await Floor.findById(id).select("name order grid site");
  if (!floor) return res.status(404).json({ error: "Floor not found" });

  // Resource carries `organization` directly, but zones/labels/catalog
  // all scope by org too — resolve it once from the floor's site.
  const site = await Site.findById(floor.site).select("organization name");
  if (!site) return res.status(404).json({ error: "Floor's site not found" });
  const organizationId = site.organization;

  const [resources, zones, labels, resourceTypes] = await Promise.all([
    Resource.find({ floor: floor._id }).select("resourceType position units").sort({ createdAt: 1 }),
    Zone.find({ floor: floor._id }).select("name bounds").sort({ name: 1 }),
    Label.find({ floor: floor._id }).select("text position"),
    ResourceType.find({ organization: organizationId }).select(
      "key label footprint seatCount reservable icon hasServiceStatus"
    ),
  ]);

  const staff = isStaff(readRole(req));

  const status = {};
  for (const resource of resources) {
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
      resources: resources.map((r) => ({
        id: r._id.toString(),
        resourceType: r.resourceType.toString(),
        position: r.position,
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
router.post(
  "/",
  requireAuth,
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const { siteId, name, order, grid } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "A floor name is required" });

    const cols = grid?.cols ?? 20;
    const rows = grid?.rows ?? 12;
    const gridError = validateGrid(cols, rows);
    if (gridError) return res.status(400).json({ error: gridError });

    // Default to the org's first site — multi-site is in the data model
    // but its management UI is fast-follow (spec §2).
    const site = siteId && mongoose.isValidObjectId(siteId)
      ? await Site.findOne({ _id: siteId, organization: req.user.organizationId })
      : await Site.findOne({ organization: req.user.organizationId }).sort({ createdAt: 1 });
    if (!site) return res.status(404).json({ error: "No site found for this organization" });

    // Append to the end unless an explicit order is given.
    const last = await Floor.findOne({ site: site._id }).sort({ order: -1 }).select("order");
    const nextOrder = Number.isInteger(order) ? order : (last?.order ?? -1) + 1;

    const floor = await Floor.create({
      site: site._id,
      name: name.trim(),
      order: nextOrder,
      grid: { cols, rows },
    });

    res.status(201).json({
      floor: {
        id: floor._id.toString(),
        name: floor.name,
        order: floor.order,
        grid: floor.grid,
        site: { id: site._id.toString(), name: site.name },
      },
    });
  })
);

/**
 * PATCH /api/floors/:id
 * Body: { name?, order?, grid?: { cols, rows } }
 *
 * Shrinking a grid is refused while anything sits outside the new
 * bounds. Silently orphaning pieces off the edge of the map would leave
 * bookable seats nobody can see.
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid floor id" });
    }
    const floor = await Floor.findById(req.params.id);
    if (!floor) return res.status(404).json({ error: "Floor not found" });

    const site = await Site.findById(floor.site).select("organization name");
    if (!site || site.organization.toString() !== req.user.organizationId) {
      return res.status(404).json({ error: "Floor not found" });
    }

    const { name, order, grid } = req.body || {};

    if (grid) {
      const cols = grid.cols ?? floor.grid.cols;
      const rows = grid.rows ?? floor.grid.rows;
      const gridError = validateGrid(cols, rows);
      if (gridError) return res.status(400).json({ error: gridError });

      if (cols < floor.grid.cols || rows < floor.grid.rows) {
        const offenders = await findOutsideGrid(floor._id, cols, rows);
        if (offenders.length) {
          return res.status(409).json({
            error:
              `Shrinking to ${cols}×${rows} would leave ${offenders.length} item(s) outside the grid. ` +
              `Move or remove them first.`,
            outside: offenders.slice(0, 10),
          });
        }
      }
      floor.grid = { cols, rows };
    }

    if (name?.trim()) floor.name = name.trim();
    if (Number.isInteger(order)) floor.order = order;
    await floor.save();

    res.json({
      floor: {
        id: floor._id.toString(),
        name: floor.name,
        order: floor.order,
        grid: floor.grid,
        site: { id: site._id.toString(), name: site.name },
      },
    });
  })
);

/**
 * DELETE /api/floors/:id
 * Refuses while the floor holds live reservations, and requires the
 * layout to be cleared first — deleting a populated floor by accident is
 * not something a confirmation dialog should be the only guard against.
 */
router.delete(
  "/:id",
  requireAuth,
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid floor id" });
    }
    const floor = await Floor.findById(req.params.id);
    if (!floor) return res.status(404).json({ error: "Floor not found" });

    const site = await Site.findById(floor.site).select("organization");
    if (!site || site.organization.toString() !== req.user.organizationId) {
      return res.status(404).json({ error: "Floor not found" });
    }

    const resources = await Resource.find({ floor: floor._id }).select("_id");
    const live = resources.length
      ? await Reservation.countDocuments({
          resource: { $in: resources.map((r) => r._id) },
          status: { $in: LIVE_STATUSES },
        })
      : 0;
    if (live > 0) {
      return res.status(409).json({ error: `That floor has ${live} active or upcoming reservation(s).` });
    }
    if (resources.length) {
      return res.status(409).json({
        error: `That floor still has ${resources.length} placed item(s). Remove them first.`,
      });
    }

    const remaining = await Floor.countDocuments({ site: floor.site });
    if (remaining <= 1) {
      return res.status(409).json({ error: "A site must keep at least one floor." });
    }

    await Promise.all([Zone.deleteMany({ floor: floor._id }), Label.deleteMany({ floor: floor._id })]);
    await Floor.deleteOne({ _id: floor._id });
    res.json({ ok: true });
  })
);

/** Pieces, zones or labels that would fall outside a proposed grid. */
async function findOutsideGrid(floorId, cols, rows) {
  const [resources, zones, labels] = await Promise.all([
    Resource.find({ floor: floorId }).select("position resourceType"),
    Zone.find({ floor: floorId }).select("name bounds"),
    Label.find({ floor: floorId }).select("text position"),
  ]);
  const types = await ResourceType.find({
    _id: { $in: [...new Set(resources.map((r) => r.resourceType.toString()))] },
  }).select("footprint label");
  const typeById = new Map(types.map((t) => [t._id.toString(), t]));

  const outside = [];
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
