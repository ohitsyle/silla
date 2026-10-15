/**
 * The control-plane API: what SILLA's commerce service (vendor/) may do
 * to this deployment. Every route here is signed with
 * CONTROL_PLANE_SECRET (lib/controlPlane.js) and never reachable with a
 * user's token. See docs/control-plane.md §3 for the contract.
 *
 *   GET  /ping                                  is the channel working?
 *   GET  /slugs/:slug                           may an organization have this address?
 *   POST /organizations                         provision one from a profile
 *   GET  /organizations/:id                     plan, usage, activity, owners
 *   PUT  /organizations/:id/entitlements        what its plan allows now
 *   POST /organizations/:id/owner-access        re-issue a superadmin's PIN
 *
 * The answers are written for a program first (stable `code`s, field
 * lists) and for the staff member reading them in the console second —
 * the `error` strings end up on their screen, so they say what to do.
 */
import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { requireControlPlane } from "../lib/controlPlane.js";
import Organization from "../models/Organization.js";
import Reservation from "../models/Reservation.js";
import User from "../models/User.js";
import { usageOf } from "../services/entitlements.js";
import {
  ProvisioningError,
  provisionFromProfile,
  readEntitlementSnapshot,
  slugAvailability,
} from "../services/provisioning.js";
import { generateVerificationCode } from "../lib/identity.js";
import { sendEmail } from "../services/email/index.js";
import { organizationUrl, ownerAccessResetEmail } from "../services/email/templates.js";

const router = Router();
router.use(requireControlPlane);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ACTIVITY_WINDOW_DAYS = 30;

/** Lets the control plane check the channel (secret, clock, routing) before relying on it. */
router.get("/ping", (_req, res) => res.json({ ok: true, service: "silla-server" }));

/**
 * GET /api/internal/slugs/:slug → { available, problem, suggestion }
 *
 * Asked by the console while staff type an address, so the answer is the
 * one provisioning would give: the same shape rules, the same reserved
 * words, and a free alternative when the answer is no.
 */
router.get(
  "/slugs/:slug",
  asyncHandler(async (req, res) => {
    res.json(await slugAvailability(req.params.slug));
  })
);

/**
 * POST /api/internal/organizations
 * Body: { profile, slug?, entitlements?, source?: { orderId } }
 *
 * 201 { organizationId, slug, owner: { email, temporaryPin }, summary }
 * 400 { error, code, fields }               a bad profile, address or snapshot
 * 409 { error, code: "SLUG_TAKEN", suggestion }
 * 409 { error, code: "ALREADY_PROVISIONED", organizationId, slug }
 *
 * The temporary PIN is in this answer ONCE, as the fallback for a founder
 * email that never arrives (sending is fire-and-forget, spec §15). It is
 * bcrypt hashed the moment it is stored, so nothing can produce it again;
 * a lost one is replaced with owner-access below, not recovered.
 */
router.post(
  "/organizations",
  asyncHandler(async (req, res) => {
    const { profile, slug, entitlements, source } = req.body || {};
    if (profile === undefined || profile === null) {
      return res.status(400).json({
        error: "A profile is required.",
        code: "INVALID_PROFILE",
        fields: [{ field: "profile", message: "is required: the configuration the portal exported" }],
      });
    }

    let snapshot = null;
    if (entitlements !== undefined && entitlements !== null) {
      const read = readEntitlementSnapshot(entitlements);
      if (!read.ok) return res.status(400).json(snapshotRefusal(read, "entitlements."));
      snapshot = read.snapshot;
    }

    const result = await provisionFromProfile(profile, {
      slug,
      entitlements: snapshot,
      source: source && typeof source === "object" ? source : null,
      requireOwner: true,
    });

    const units = result.summaries.reduce((sum, floor) => sum + floor.units, 0);
    res.status(201).json({
      organizationId: String(result.organization._id),
      slug: result.slug,
      owner: { email: result.owner.email, temporaryPin: result.owner.temporaryPin },
      summary: {
        name: result.organization.name,
        deploymentUrl: result.deploymentUrl,
        catalog: result.profile.catalog.length,
        floors: result.summaries.map(({ id, name, grid, resources, units: floorUnits, zones, labels }) => ({
          id, name, grid, pieces: resources, units: floorUnits, zones, labels,
        })),
        units,
        managed: Boolean(snapshot?.managed),
        warnings: result.warnings,
      },
    });
  })
);

/**
 * GET /api/internal/organizations/:id
 *
 * What staff need to look after a customer without signing in to their
 * deployment: the plan as stored, live usage against it, whether anyone
 * is actually using the thing, and who owns it.
 */
router.get(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const org = await findOrganization(req.params.id, "name slug createdAt entitlements");
    if (!org) return res.status(404).json({ error: "No organization with that id on this deployment.", code: "ORG_NOT_FOUND" });

    const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86_400_000);
    const [usage, reservations30d, checkIns30d, latest, owners] = await Promise.all([
      usageOf(org._id),
      Reservation.countDocuments({ organization: org._id, createdAt: { $gte: since } }),
      Reservation.countDocuments({ organization: org._id, checkedInAt: { $gte: since } }),
      Reservation.findOne({ organization: org._id }).sort({ createdAt: -1 }).select("createdAt").lean(),
      // Oldest first, so owners[0] is the founding superadmin.
      User.find({ organization: org._id, role: "superadmin", active: { $ne: false } })
        .sort({ createdAt: 1 })
        .select("email firstName lastName mustChangePin")
        .lean(),
    ]);

    res.json({
      organization: { id: String(org._id), name: org.name, slug: org.slug || null, createdAt: org.createdAt },
      // An organization older than subscriptions has no stored snapshot
      // at all; that reads the same as an explicit unmanaged one.
      entitlements: org.entitlements || { managed: false, version: 0 },
      usage,
      activity: {
        reservations30d,
        checkIns30d,
        lastReservationAt: latest?.createdAt || null,
      },
      owners: owners.map((u) => ({
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        mustChangePin: Boolean(u.mustChangePin),
      })),
    });
  })
);

/**
 * PUT /api/internal/organizations/:id/entitlements
 * Body: the snapshot (docs/control-plane.md §2)
 *
 * → { entitlements }                     applied
 * → { entitlements, ignored: true, ... } an equal or newer one is already here
 *
 * Pushes can arrive out of order — the vendor retries failed ones from a
 * job while newer changes are pushed directly — so the write is
 * conditional on the stored version being OLDER, in the same statement
 * as the write. Read-then-write would let two pushes both pass the check
 * and the older one land last.
 */
router.put(
  "/organizations/:id/entitlements",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "No organization with that id on this deployment.", code: "ORG_NOT_FOUND" });
    }
    const read = readEntitlementSnapshot(req.body);
    if (!read.ok) return res.status(400).json(snapshotRefusal(read));

    const applied = await Organization.findOneAndUpdate(
      {
        _id: req.params.id,
        // An organization that predates subscriptions has no stored
        // version at all, which `$lt` alone would never match.
        $or: [{ "entitlements.version": { $lt: read.snapshot.version } }, { "entitlements.version": { $exists: false } }],
      },
      { $set: { entitlements: { ...read.snapshot, syncedAt: new Date() } } },
      { new: true, runValidators: true, projection: { entitlements: 1 } }
    ).lean();

    const unknown = read.ignored.length ? { unknownKeys: read.ignored } : {};
    if (applied) return res.json({ entitlements: applied.entitlements, ...unknown });

    const current = await findOrganization(req.params.id, "entitlements");
    if (!current) return res.status(404).json({ error: "No organization with that id on this deployment.", code: "ORG_NOT_FOUND" });
    res.json({
      entitlements: current.entitlements,
      ignored: true,
      reason: `Version ${read.snapshot.version} is not newer than the stored version ${current.entitlements?.version ?? 0}, so nothing changed.`,
      ...unknown,
    });
  })
);

/**
 * POST /api/internal/organizations/:id/owner-access
 * Body: { email? } — default: the founding (earliest) superadmin
 *
 * → { email, temporaryPin }
 *
 * For a founder who never got their welcome, or lost their PIN with no
 * colleague who can reset it. A new temporary PIN from the same
 * generator AUTH-4 and ADM-4 use, a forced change at next sign-in, any
 * lockout and outstanding reset code cleared, and an email saying SILLA
 * did it. The PIN comes back once, for the same reason as provisioning.
 */
router.post(
  "/organizations/:id/owner-access",
  asyncHandler(async (req, res) => {
    const org = await findOrganization(req.params.id, "name slug branding terminology", { lean: false });
    if (!org) return res.status(404).json({ error: "No organization with that id on this deployment.", code: "ORG_NOT_FOUND" });

    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const owner = email
      ? await User.findOne({ organization: org._id, role: "superadmin", email })
      : await User.findOne({ organization: org._id, role: "superadmin", active: { $ne: false } }).sort({ createdAt: 1 });

    if (!owner) {
      return res.status(404).json({
        error: email ? `${email} is not a superadmin of ${org.name}.` : `${org.name} has no superadmin to reset.`,
        code: "OWNER_NOT_FOUND",
      });
    }
    if (owner.active === false) {
      // The organization's own administrators switched this account off.
      // Support quietly switching it back on would override them.
      return res.status(409).json({
        error: `${owner.email} has been deactivated by ${org.name}. Reset another superadmin, or ask them to reactivate it.`,
        code: "OWNER_DEACTIVATED",
      });
    }

    const temporaryPin = generateVerificationCode();
    owner.pinHash = await bcrypt.hash(temporaryPin, 10);
    owner.mustChangePin = true;
    owner.failedPinAttempts = 0;
    owner.lockedUntil = null;
    // One live credential: a reset code requested earlier must not still
    // work alongside the PIN support has just issued.
    owner.pinResetCode = null;
    owner.pinResetExpiresAt = null;
    await owner.save();

    sendEmail(ownerAccessResetEmail({ org, user: owner, temporaryPin, deploymentUrl: organizationUrl(org) }));

    res.json({ email: owner.email, temporaryPin });
  })
);

/* ───────────────────────────── helpers ───────────────────────────── */

async function findOrganization(id, fields, { lean = true } = {}) {
  if (!mongoose.isValidObjectId(id)) return null;
  const query = Organization.findById(id).select(fields);
  return lean ? query.lean() : query;
}

function snapshotRefusal(read, prefix = "") {
  return {
    error: "That entitlement snapshot can't be stored — fix the fields listed.",
    code: "INVALID_ENTITLEMENTS",
    fields: read.errors.map(({ field, message }) => ({ field: `${prefix}${field}`, message })),
  };
}

// A provisioning refusal carries its own status and a message written for
// the staff member who will read it; anything else is the app's 500.
router.use((err, _req, res, next) => {
  if (err instanceof ProvisioningError) return res.status(err.status).json(err.toJSON());
  return next(err);
});

export default router;
