import { Router } from "express";
import mongoose from "mongoose";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Floor from "../models/Floor.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import Reservation from "../models/Reservation.js";
import Site from "../models/Site.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Structural map editing is SUPERADMIN-ONLY.
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
 */
async function floorInOrg(floorId, organizationId) {
  const floor = await Floor.findById(floorId);
  if (!floor) return null;
  const site = await Site.findById(floor.site).select("organization");
  if (!site || site.organization.toString() !== String(organizationId)) return null;
  return floor;
}

/**
 * MAP-3 — "Pick from catalog; click cell to place / remove; Overlap
 * prevented by occupied-cell check."
 *
 * The overlap check is the load-bearing rule (spec §8): fixed footprints
 * and no free-shaping are exactly what make it a simple cell test rather
 * than polygon intersection. It runs on the server because the client's
 * copy of the layout can be stale.
 */
async function findOverlap({ floorId, col, row, w, h, excludeResourceId = null }) {
  const filter = { floor: floorId };
  if (excludeResourceId) filter._id = { $ne: excludeResourceId };

  const existing = await Resource.find(filter);
  const types = await ResourceType.find({
    _id: { $in: [...new Set(existing.map((r) => r.resourceType.toString()))] },
  });
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
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { floorId, resourceTypeKey, col, row } = req.body || {};
    if (!floorId || !mongoose.isValidObjectId(floorId)) {
      return res.status(400).json({ error: "A valid floorId is required" });
    }
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) {
      return res.status(400).json({ error: "col and row must be non-negative integers (spec §12: integer cells only)" });
    }

    const floor = await floorInOrg(floorId, req.user.organizationId);
    if (!floor) return res.status(404).json({ error: "Floor not found" });

    const type = await ResourceType.findOne({
      organization: req.user.organizationId,
      key: resourceTypeKey,
    });
    if (!type) return res.status(404).json({ error: `No catalog type "${resourceTypeKey}" for this organization` });

    const { w, h } = type.footprint;
    if (col + w > floor.grid.cols || row + h > floor.grid.rows) {
      return res.status(400).json({
        error: `A ${w}x${h} piece at (${col},${row}) falls outside the ${floor.grid.cols}x${floor.grid.rows} grid.`,
      });
    }

    const clash = await findOverlap({ floorId, col, row, w, h });
    if (clash) {
      return res.status(409).json({
        error: `That would overlap a ${clash.type?.label || "piece"} at (${clash.resource.position.col},${clash.resource.position.row}).`,
      });
    }

    const resource = await Resource.create({
      organization: req.user.organizationId,
      floor: floorId,
      resourceType: type._id,
      zone: null, // derived from position (spec §12)
      position: { col, row },
      units: Array.from({ length: type.seatCount }, (_, i) => ({
        label: String(i + 1),
        status: "available",
        serviceStatus: "working",
        overstay: false,
      })),
    });

    res.status(201).json({
      resource: {
        id: resource._id.toString(),
        resourceType: type._id.toString(),
        position: resource.position,
        units: resource.units.map((u) => ({ label: u.label })),
      },
    });
  })
);

/**
 * DELETE /api/resources/:id
 * MAP-3 — "click-then-delete". Refuses while the piece is holding live
 * reservations: silently deleting a booked seat would strand whoever
 * booked it with no record and no notification.
 */
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid resource id" });

    const resource = await Resource.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!resource) return res.status(404).json({ error: "Resource not found" });

    const live = await Reservation.countDocuments({
      resource: resource._id,
      status: { $in: LIVE_STATUSES },
    });
    if (live > 0) {
      return res.status(409).json({
        error: `That resource has ${live} active or upcoming reservation(s). Cancel them first.`,
        liveReservations: live,
      });
    }

    await Resource.deleteOne({ _id: resource._id });
    res.json({ ok: true });
  })
);

/* ══════════════════ MAP-4 — Zones ══════════════════ */

/**
 * POST /api/resources/zones
 * Body: { floorId, name, col, row, w, h }
 *
 * "Drag rectangle; name it; Membership derived from position."
 * No membership is stored — a zone is a rectangle and nothing more
 * (spec §12).
 */
router.post(
  "/zones",
  asyncHandler(async (req, res) => {
    const { floorId, name, col, row, w, h } = req.body || {};
    if (!floorId || !mongoose.isValidObjectId(floorId)) {
      return res.status(400).json({ error: "A valid floorId is required" });
    }
    if (!name?.trim()) return res.status(400).json({ error: "A zone name is required" });
    if (![col, row, w, h].every((n) => Number.isInteger(n)) || w < 1 || h < 1 || col < 0 || row < 0) {
      return res.status(400).json({ error: "col/row must be >= 0 and w/h >= 1, all integers" });
    }

    const floor = await floorInOrg(floorId, req.user.organizationId);
    if (!floor) return res.status(404).json({ error: "Floor not found" });
    if (col + w > floor.grid.cols || row + h > floor.grid.rows) {
      return res.status(400).json({ error: "That zone falls outside the grid." });
    }

    const zone = await Zone.create({
      organization: req.user.organizationId,
      floor: floorId,
      name: name.trim(),
      bounds: { col, row, w, h },
    });

    res.status(201).json({ zone: { id: zone._id.toString(), name: zone.name, bounds: zone.bounds } });
  })
);

router.patch(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid zone id" });
    const zone = await Zone.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!zone) return res.status(404).json({ error: "Zone not found" });
    if (req.body?.name?.trim()) zone.name = req.body.name.trim();
    await zone.save();
    res.json({ zone: { id: zone._id.toString(), name: zone.name, bounds: zone.bounds } });
  })
);

router.delete(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid zone id" });
    await Zone.deleteOne({ _id: req.params.id, organization: req.user.organizationId });
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

    const floor = await floorInOrg(floorId, req.user.organizationId);
    if (!floor) return res.status(404).json({ error: "Floor not found" });
    if (col >= floor.grid.cols || row >= floor.grid.rows) {
      return res.status(400).json({ error: "That label falls outside the grid." });
    }

    const label = await Label.create({
      organization: req.user.organizationId,
      floor: floorId,
      text: text.trim(),
      position: { col, row },
    });

    res.status(201).json({ label: { id: label._id.toString(), text: label.text, position: label.position } });
  })
);

router.delete(
  "/labels/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid label id" });
    await Label.deleteOne({ _id: req.params.id, organization: req.user.organizationId });
    res.json({ ok: true });
  })
);

export default router;
