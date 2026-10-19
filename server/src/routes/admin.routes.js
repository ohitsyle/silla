import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Organization from "../models/Organization.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import Room from "../models/Room.js";
import { applyRoomStates, pieceBounds, roomContents, roomForResource, withSpaceTransaction, SpaceError } from "../services/spaces.js";
import { contains, regionAreas } from "../lib/cells.js";
import Zone from "../models/Zone.js";
import User from "../models/User.js";
import Reservation from "../models/Reservation.js";
import Closure from "../models/Closure.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ReservationError, cancelReservation, syncUnitStatus } from "../services/reservations/index.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";
import { normalizeCardUid } from "../services/checkin/rfid.js";
import { ValidationError } from "../services/checkin/errors.js";
import { sendEmail } from "../services/email/index.js";
import { gracePeriodChangedEmail, staffOnboardingEmail } from "../services/email/templates.js";
import { generateVerificationCode } from "../lib/identity.js";
import { emitDayChanged, emitOrgNotice } from "../services/realtime.js";
import { FEATURES, LIMITS } from "../lib/plans.js";
import {
  assertFeature,
  assertWithinLimit,
  hasFeature,
  isOperational,
  limitOf,
  publicEntitlements,
  requireFeature,
  usageOf,
} from "../services/entitlements.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Spec §14: the admin surface is staff-and-above, desktop-only.
router.use(requireAuth, requireRole("staff", "superadmin"));

/**
 * Tells every open map of the organization (or of one site) that its day
 * has changed: opening hours moved, or a closure was added or taken away.
 * Bookings announce themselves through the reservation engine; these do
 * not touch a booking, so they have to say so here.
 */
async function announceDayChange(req, organizationId, siteId = null) {
  const sites = siteId ? [siteId] : (await Site.find({ organization: organizationId }).select("_id")).map((s) => s._id);
  const floors = await Floor.find({ site: { $in: sites } }).select("_id");
  emitDayChanged(req.app.get("io"), floors.map((floor) => floor._id));
}

/* ═══════════════════════ Plan & usage ═══════════════════════ */

/**
 * GET /api/admin/plan
 *
 * What this organization's plan allows and how much of it is in use —
 * the console's "Plan & usage" page, and what the staff screen reads to
 * offer an upgrade prompt instead of a Create button that would fail.
 *
 * `limits` and `features` are the SERVER's reading of the snapshot
 * (services/entitlements.js is its only interpreter), so the page never
 * re-derives a rule and can never disagree with what is enforced.
 */
router.get(
  "/plan",
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.user.organizationId).select("name entitlements terminology").lean();
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const usage = await usageOf(org._id);
    res.json({
      entitlements: publicEntitlements(org),
      operational: isOperational(org),
      usage,
      limits: Object.entries(LIMITS).map(([key, label]) => ({ key, label, max: limitOf(org, key), used: usage[key] })),
      features: Object.entries(FEATURES).map(([key, label]) => ({ key, label, included: hasFeature(org, key) })),
    });
  })
);

/**
 * Which limit an account counts against while it exists: active members
 * against `members`, active staff and superadmins against `staff`
 * (the same rule services/entitlements.js counts with), and a
 * deactivated account against nothing.
 */
const countsAgainst = ({ role, active }) => (active === false ? null : role === "member" ? "members" : "staff");

/* ═══════════════════════ ADM-1 — Dashboard ═══════════════════════ */

/**
 * GET /api/admin/dashboard?floorId=
 *
 * "Metrics: occupied, open / total, overstays; live map per floor;
 * Overstay flagged for staff; metric click highlights resource."
 *
 * The overstay list carries resource ids so the client can jump straight
 * to the piece on the map — that is what makes the metric clickable.
 */
router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const orgId = req.user.organizationId;
    const sites = await Site.find({ organization: orgId }).select("_id");
    const floors = await Floor.find({ site: { $in: sites.map((s) => s._id) } }).sort({ order: 1 });

    const scope = req.query.floorId && mongoose.isValidObjectId(req.query.floorId)
      ? { floor: req.query.floorId }
      : { floor: { $in: floors.map((f) => f._id) } };

    const resources = await Resource.find({ organization: orgId, kind: { $ne: "room" }, ...scope });

    await applyRoomStates(resources);
    let total = 0;
    const counts = { available: 0, reserved: 0, occupied: 0, unavailable: 0 };
    let outOfService = 0;
    const overstays = [];

    for (const resource of resources) {
      for (const unit of resource.viewUnits || resource.units) {
        total += 1;
        if (counts[unit.status] !== undefined) counts[unit.status] += 1;
        if (unit.serviceStatus === "out_of_service") outOfService += 1;
        if (unit.overstay) {
          overstays.push({
            resourceId: resource._id.toString(),
            floorId: resource.floor.toString(),
            unitLabel: unit.label,
            position: resource.position,
          });
        }
      }
    }

    const activeNow = await Reservation.countDocuments({ organization: orgId, status: "active" });
    const heldNow = await Reservation.countDocuments({ organization: orgId, status: "held" });

    res.json({
      floors: floors.map((f) => ({ id: f._id.toString(), name: f.name, order: f.order })),
      metrics: {
        total,
        open: counts.available,
        occupied: counts.occupied,
        reserved: counts.reserved,
        unavailable: counts.unavailable,
        outOfService,
        overstays: overstays.length,
        activeSessions: activeNow,
        upcomingHolds: heldNow,
      },
      overstays,
    });
  })
);

/* ═════════════════ ADM-2 — Resources & Rules ═════════════════ */

/**
 * GET /api/admin/resources?floorId=
 * "grouped-by-zone list; per-resource schedule + history."
 * Zone membership is DERIVED from position (spec §12), never stored.
 */
router.get(
  "/resources",
  asyncHandler(async (req, res) => {
    const orgId = req.user.organizationId;
    const filter = { organization: orgId, kind: { $ne: "room" } };
    if (req.query.floorId && mongoose.isValidObjectId(req.query.floorId)) filter.floor = req.query.floorId;

    const [resources, types, zones] = await Promise.all([
      Resource.find(filter).sort({ "position.row": 1, "position.col": 1 }),
      ResourceType.find({ organization: orgId }),
      Zone.find(filter.floor ? { floor: filter.floor } : { organization: orgId }),
    ]);
    await applyRoomStates(resources);
    const typeById = new Map(types.map((t) => [t._id.toString(), t]));

    // Wholly inside the zone's shape: every cell of the footprint is one of
    // the zone's cells, so a piece in either arm of an L-shaped zone counts.
    const inZone = (zone, resource, type) => contains(regionAreas(zone), pieceBounds(resource, type));

    const grouped = new Map();
    for (const resource of resources) {
      const type = typeById.get(resource.resourceType.toString());
      const zone = zones.find((z) => inZone(z, resource, type));
      const key = resource.roomId || (zone ? zone._id.toString() : "__unzoned");
      if (!grouped.has(key)) {
        grouped.set(key, { zoneId: resource.roomId || zone?._id?.toString() || null, zoneName: resource.roomName || zone?.name || "Unzoned", resources: [] });
      }
      grouped.get(key).resources.push({
        id: resource._id.toString(),
        typeLabel: type?.label || null,
        typeKey: type?.key || null,
        hasServiceStatus: Boolean(type?.hasServiceStatus),
        position: resource.position,
        units: (resource.viewUnits || resource.units).map((u) => ({
          label: u.label,
          status: u.status,
          serviceStatus: u.serviceStatus,
          overstay: u.overstay,
        })),
      });
    }

    res.json({ groups: [...grouped.values()] });
  })
);

/**
 * GET /api/admin/resources/:id/history
 * "per-resource schedule + history view."
 */
router.get(
  "/resources/:id/history",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid resource id" });

    const resource = await Resource.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!resource) return res.status(404).json({ error: "Resource not found" });
    const room = resource.kind === "room" ? await Room.findById(resource.room) : null;
    const children = room ? await roomContents(room) : [];
    const target = { organization: req.user.organizationId, resource: { $in: [resource._id, ...children.map((r) => r._id)] } };
    const upcoming = await Reservation.find({ ...target, status: { $in: LIVE_STATUSES } })
      .sort({ startTime: 1 })
      .populate("member", "firstName lastName memberId email");
    const past = await Reservation.find({ ...target, status: { $nin: LIVE_STATUSES } })
      .sort({ startTime: -1 })
      .limit(50)
      .populate("member", "firstName lastName memberId email");

    const shape = (r) => ({
      id: r._id.toString(),
      unitLabel: r.unitLabel,
      resourceLabel: r.targetLabel || r.unitLabel,
      startTime: r.startTime,
      endTime: r.endTime,
      status: r.status,
      overstay: r.overstay,
      member: r.member
        ? { id: r.member._id.toString(), name: `${r.member.firstName} ${r.member.lastName}`, memberId: r.member.memberId }
        : null,
    });

    res.json({ schedule: upcoming.map(shape), history: past.map(shape) });
  })
);

/**
 * PATCH /api/admin/resources/:id/units/:label
 * Body: { status?: "available"|"unavailable", serviceStatus?: "working"|"out_of_service" }
 * "Toggle availability; mark a computer out-of-service."
 */
router.patch(
  "/resources/:id/units/:label",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid resource id" });
    const { status, serviceStatus } = req.body || {};
    if (status && !["available", "unavailable"].includes(status)) {
      return res.status(400).json({ error: "Only 'available' and 'unavailable' can be set directly; occupied and reserved are derived from reservations." });
    }
    if (serviceStatus && !["working", "out_of_service"].includes(serviceStatus)) {
      return res.status(400).json({ error: "serviceStatus must be working or out_of_service" });
    }
    const resource = await withSpaceTransaction(req.user.organizationId, async (session) => {
      const current = await Resource.findOne({ _id: req.params.id, organization: req.user.organizationId }).session(session);
      if (!current) throw new SpaceError("Resource not found", 404);
      if (current.kind === "room") throw new SpaceError("Change room availability using the room controls.");
      const unit = current.units.find((u) => u.label === req.params.label);
      if (!unit) throw new SpaceError("Unit not found", 404);
      if (serviceStatus) {
        const type = await ResourceType.findById(current.resourceType).session(session);
        if (!type?.hasServiceStatus) throw new SpaceError("That resource type doesn't carry a service status.");
      }
      if (status === "unavailable" || serviceStatus === "out_of_service") {
        const room = await roomForResource(current, session);
        const conflicts = [{ resource: current._id, unitLabel: unit.label }, ...(room ? [{ resource: room.resource }] : [])];
        if (await Reservation.exists({ organization: req.user.organizationId, $or: conflicts, status: { $in: LIVE_STATUSES } }).session(session)) {
          throw new SpaceError("Cancel the active or upcoming reservation before taking this resource out of service.", 409);
        }
      }
      if (serviceStatus) unit.serviceStatus = serviceStatus;
      if (status) unit.status = status;
      await current.save({ session });
      return current;
    });
    const unit = resource.units.find((u) => u.label === req.params.label);
    await syncUnitStatus(resource._id, unit.label, { io: req.app.get("io") });

    const fresh = await Resource.findById(resource._id);
    res.json({ ok: true, unit: fresh.units.find((u) => u.label === req.params.label) });
  })
);

/** ADM-2 — staff cancellation, with a reason recorded. */
router.delete(
  "/reservations/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid reservation id" });
    await cancelReservation({
      reservationId: req.params.id,
      organizationId: req.user.organizationId,
      reason: req.body?.reason || "Cancelled by staff",
      io: req.app.get("io"),
    });
    res.json({ ok: true });
  })
);

/* ═════════════════ ADM-3 — Members & Cards ═════════════════ */

/**
 * GET /api/admin/members?q=
 * "Search; table with current session."
 */
router.get(
  "/members",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const filter = { organization: req.user.organizationId, role: "member" };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { memberId: rx }];
    }

    const members = await User.find(filter).sort({ lastName: 1 }).limit(100);
    const live = await Reservation.find({
      member: { $in: members.map((m) => m._id) },
      status: { $in: LIVE_STATUSES },
    });
    const sessionByMember = new Map(live.map((r) => [r.member.toString(), r]));

    res.json({
      members: members.map((m) => {
        const session = sessionByMember.get(m._id.toString());
        return {
          id: m._id.toString(),
          name: `${m.firstName} ${m.lastName}`.trim(),
          email: m.email,
          memberId: m.memberId,
          cardUid: m.cardUid,
          verified: m.verified,
          active: m.active,
          lockedUntil: m.lockedUntil,
          currentSession: session
            ? { id: session._id.toString(), status: session.status, startTime: session.startTime, endTime: session.endTime }
            : null,
        };
      }),
    });
  })
);

/** ADM-3 — a member's reservation history. */
router.get(
  "/members/:id/history",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid member id" });
    // Scoped to the caller's organization in the QUERY: a bare member id
    // let staff of one organization read another's member history once
    // more than one organization shared this database.
    const history = await Reservation.find({ member: req.params.id, organization: req.user.organizationId })
      .sort({ startTime: -1 })
      .limit(100);
    res.json({
      history: history.map((r) => ({
        id: r._id.toString(),
        resourceId: r.resource.toString(),
        unitLabel: r.unitLabel,
        startTime: r.startTime,
        endTime: r.endTime,
        status: r.status,
        overstay: r.overstay,
      })),
    });
  })
);

/**
 * POST /api/admin/members/:id/reset-pin
 * Staff-initiated PIN reset — issues a temporary PIN the member must
 * change on next login (the same forced-change path as staff onboarding).
 */
router.post(
  "/members/:id/reset-pin",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid member id" });
    const member = await User.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!member) return res.status(404).json({ error: "Member not found" });

    const temporaryPin = generateVerificationCode();
    member.pinHash = await bcrypt.hash(temporaryPin, 10);
    member.mustChangePin = true;
    member.failedPinAttempts = 0;
    member.lockedUntil = null;
    await member.save();

    const org = await Organization.findById(req.user.organizationId);
    sendEmail(staffOnboardingEmail({ org, user: member, temporaryPin }));

    res.json({
      ok: true,
      ...(process.env.NODE_ENV !== "production" ? { temporaryPin } : {}),
    });
  })
);

/**
 * POST /api/admin/members/:id/reissue-card
 * Body: { cardUid }
 *
 * ADM-3 / spec §7 — "Reissue: tap new card, duplicate check, confirm,
 * invalidate old." Rebinding to the same account preserves the member's
 * history; the old UID stops resolving the moment this succeeds, which
 * is the defence against a lost or stolen card.
 */
router.post(
  "/members/:id/reissue-card",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid member id" });
    const member = await User.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!member) return res.status(404).json({ error: "Member not found" });

    const normalized = normalizeCardUid(req.body?.cardUid);

    // Duplicate check first (spec §7: "refuses if the card already
    // belongs to someone").
    const holder = await User.findOne({ organization: req.user.organizationId, cardUid: normalized });
    if (holder && holder._id.toString() !== member._id.toString()) {
      return res.status(409).json({
        error: `That card already belongs to ${holder.firstName} ${holder.lastName}.`,
      });
    }

    const previousUid = member.cardUid;
    member.cardUid = normalized;
    await member.save();

    res.json({ ok: true, previousUid, cardUid: normalized });
  })
);

/* ═══════════ ADM-4 — Staff management (superadmin only) ═══════════ */

router.get(
  "/staff",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const staff = await User.find({
      organization: req.user.organizationId,
      role: { $in: ["staff", "superadmin"] },
    }).sort({ role: 1, lastName: 1 });

    res.json({
      staff: staff.map((s) => ({
        id: s._id.toString(),
        name: `${s.firstName} ${s.lastName}`.trim(),
        email: s.email,
        role: s.role,
        active: s.active,
        termsAccepted: Boolean(s.termsAcceptedAt),
        mustChangePin: Boolean(s.mustChangePin),
      })),
    });
  })
);

/**
 * POST /api/admin/staff
 * "Create staff (role, name, email → OTP); forced first-login PIN change."
 * Spec §6 — staff are email-provisioned, no card, no kiosk tap.
 */
router.post(
  "/staff",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email, role = "staff" } = req.body || {};
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "First name, last name and email are required." });
    }
    if (!["staff", "superadmin"].includes(role)) {
      return res.status(400).json({ error: "Role must be staff or superadmin." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (await User.findOne({ organization: req.user.organizationId, email: normalizedEmail })) {
      return res.status(409).json({ error: "That email address is already in use." });
    }

    // The plan's staff cap (PLAN_LIMIT). Checked last, immediately before
    // the create, so a typo or a duplicate is reported as what it is.
    await assertWithinLimit(req.user.organizationId, "staff");

    const temporaryPin = generateVerificationCode();
    const user = await User.create({
      organization: req.user.organizationId,
      role,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      pinHash: await bcrypt.hash(temporaryPin, 10),
      verified: true, // provisioned, not self-registered — no email code step
      mustChangePin: true, // forced first-login change
      termsAcceptedAt: null, // AUTH-3 gate still applies
      cardUid: null,
      memberId: null,
    });

    const org = await Organization.findById(req.user.organizationId);
    sendEmail(staffOnboardingEmail({ org, user, temporaryPin }));

    res.status(201).json({
      staff: { id: user._id.toString(), email: user.email, role: user.role },
      ...(process.env.NODE_ENV !== "production" ? { temporaryPin } : {}),
    });
  })
);

/**
 * PATCH /api/admin/staff/:id — change role or deactivate.
 * "The seeded superadmin cannot be deleted or demoted" (spec §3).
 */
router.patch(
  "/staff/:id",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid staff id" });
    const target = await User.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!target) return res.status(404).json({ error: "Staff account not found" });

    // The founding superadmin is the org's undeletable root account.
    const firstSuperadmin = await User.findOne({
      organization: req.user.organizationId,
      role: "superadmin",
    }).sort({ createdAt: 1 });
    const isFounder = firstSuperadmin && firstSuperadmin._id.toString() === target._id.toString();

    const { role, active } = req.body || {};

    if (isFounder && (role === "staff" || active === false)) {
      return res.status(403).json({ error: "The founding superadmin cannot be demoted or deactivated." });
    }
    if (target._id.toString() === req.user.id && (role === "staff" || active === false)) {
      return res.status(403).json({ error: "You cannot demote or deactivate yourself." });
    }

    if (role && !["staff", "superadmin"].includes(role)) {
      return res.status(400).json({ error: "Role must be staff or superadmin." });
    }

    // Reactivating an account, or promoting a member, brings an account
    // back under a plan limit just as creating one does — otherwise the
    // staff cap could be walked around by deactivating and reactivating.
    // A downgrade still takes nothing away: only the change that would
    // ADD to a count is refused.
    const before = countsAgainst(target);
    const after = countsAgainst({ role: role || target.role, active: active === undefined ? target.active : Boolean(active) });
    if (after && after !== before) await assertWithinLimit(req.user.organizationId, after);

    if (role) target.role = role;
    if (active !== undefined) target.active = Boolean(active);
    await target.save();

    res.json({ ok: true, staff: { id: target._id.toString(), role: target.role, active: target.active } });
  })
);

/* ═══════════ ADM-5 — Settings (superadmin only) ═══════════ */

const BRANDING_GROUPS = {
  surface: ["page", "pageEnd", "card", "panel", "line"],
  ink: ["primary", "secondary", "muted"],
  states: ["available", "reserved", "occupied", "unavailable", "overstay"],
};

/**
 * Whether applying `patch` the way PATCH /settings does (a shallow merge:
 * a group that is sent replaces the whole group) would change any colour
 * or the logo. Compared value by value, case- and blank-insensitively, so
 * "#ffd41c" and "#FFD41C" are the same colour and unset is unset.
 */
function brandingWouldChange(current, patch) {
  if (!patch || typeof patch !== "object") return false;
  const next = { ...current, ...patch };
  const norm = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim().toLowerCase());
  const differs = (a, b) => norm(a) !== norm(b);
  if (["primaryColor", "accentTextColor", "logoUrl"].some((key) => differs(current?.[key], next[key]))) return true;
  return Object.entries(BRANDING_GROUPS).some(([group, keys]) =>
    keys.some((key) => differs(current?.[group]?.[key], next[group]?.[key]))
  );
}

router.get(
  "/settings",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.user.organizationId);
    if (!org) return res.status(404).json({ error: "Organization not found" });
    const closures = await Closure.find({ organization: org._id }).sort({ startTime: 1 });
    res.json({
      organization: {
        name: org.name,
        status: org.status,
        branding: org.branding,
        terminology: org.terminology,
        identity: org.identity,
        policy: org.policy,
        privacy: org.privacy,
        termsOfServiceText: org.termsOfServiceText,
      },
      closures: closures.map((c) => ({
        id: c._id.toString(),
        startTime: c.startTime,
        endTime: c.endTime,
        reason: c.reason,
        appliedAt: c.appliedAt,
      })),
    });
  })
);

/**
 * PATCH /api/admin/settings
 *
 * ADM-5 — status, hours, policy numbers, branding, terminology, terms.
 * RES-6 rides along here: changing the grace period "posts a notice and
 * emails that day's reservers" (spec §11).
 */
router.patch(
  "/settings",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.user.organizationId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const { status, policy, branding, terminology, identity, termsOfServiceText, name } = req.body || {};

    // Custom colours and logo are a plan feature (customBranding). Only an
    // actual CHANGE is refused, and it is checked before anything else is
    // touched: a form may send the branding it was given straight back,
    // and an organization downgraded after setting its colours keeps them
    // — a downgrade never takes anything away.
    if (branding && brandingWouldChange(org.branding.toObject(), branding)) {
      await assertFeature(org, "customBranding");
    }

    if (status) {
      if (!["open", "limited", "closed"].includes(status)) {
        return res.status(400).json({ error: "Status must be open, limited or closed." });
      }
      org.status = status;
    }

    const previousGrace = org.policy?.gracePeriodMinutes;
    const previousHours = JSON.stringify(org.policy?.operatingHours || {});

    if (policy) {
      for (const key of ["gracePeriodMinutes", "maxStayHours", "pinLockoutThreshold", "verificationCodeExpiryMinutes"]) {
        if (policy[key] !== undefined) {
          const value = Number(policy[key]);
          if (!Number.isFinite(value) || value <= 0) {
            return res.status(400).json({ error: `${key} must be a positive number.` });
          }
          org.policy[key] = value;
        }
      }
      if (policy.operatingHours) {
        const { open, close } = policy.operatingHours;
        const valid = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ""));
        if (open !== undefined) {
          if (!valid(open)) return res.status(400).json({ error: "operatingHours.open must be HH:mm" });
          org.policy.operatingHours.open = open;
        }
        if (close !== undefined) {
          if (!valid(close)) return res.status(400).json({ error: "operatingHours.close must be HH:mm" });
          org.policy.operatingHours.close = close;
        }
      }
    }

    if (name) org.name = String(name).trim();
    if (branding) org.branding = { ...org.branding.toObject(), ...branding };
    if (terminology) org.terminology = { ...org.terminology.toObject(), ...terminology };
    if (identity) org.identity = { ...org.identity.toObject(), ...identity };
    if (termsOfServiceText !== undefined) org.termsOfServiceText = String(termsOfServiceText);

    await org.save();

    // New opening hours redraw every timeline: the day starts and ends elsewhere.
    if (JSON.stringify(org.policy?.operatingHours || {}) !== previousHours || status) {
      await announceDayChange(req, org._id);
    }

    // RES-6 — a grace change is consequential for anyone booked today,
    // so post a notice and tell them (spec §11).
    const newGrace = org.policy?.gracePeriodMinutes;
    if (previousGrace !== undefined && newGrace !== previousGrace) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);

      const todays = await Reservation.find({
        organization: org._id,
        status: { $in: LIVE_STATUSES },
        startTime: { $gte: dayStart, $lt: dayEnd },
      }).populate("member", "firstName email");

      for (const reservation of todays) {
        if (reservation.member) {
          sendEmail(gracePeriodChangedEmail({ org, user: reservation.member, minutes: newGrace }));
        }
      }
      emitOrgNotice(req.app.get("io"), {
        organizationId: org._id.toString(),
        type: "grace-period",
        message: `The check-in grace period is now ${newGrace} minutes.`,
      });
    }

    res.json({ ok: true, organization: { name: org.name, status: org.status, policy: org.policy } });
  })
);

/**
 * POST /api/admin/closures
 * ADM-5 / NOT-5 — "scheduled closure with reason, cancellation, and emails".
 * The worker applies it (cancels + emails) on its next pass.
 */
router.post(
  "/closures",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    const { startTime, endTime, reason, siteId } = req.body || {};
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({ error: "A valid startTime and a later endTime are required." });
    }
    if (!reason?.trim()) return res.status(400).json({ error: "A reason is required." });

    const closure = await Closure.create({
      organization: req.user.organizationId,
      site: siteId && mongoose.isValidObjectId(siteId) ? siteId : null,
      startTime: start,
      endTime: end,
      reason: reason.trim(),
      createdBy: req.user.id,
    });

    // The closure shows on every timeline at once; the bookings inside it
    // are cancelled (and announced) by the worker's next pass.
    await announceDayChange(req, req.user.organizationId, closure.site);
    res.status(201).json({ closure: { id: closure._id.toString(), startTime, endTime, reason: closure.reason } });
  })
);

router.delete(
  "/closures/:id",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid closure id" });
    const closure = await Closure.findOneAndDelete({ _id: req.params.id, organization: req.user.organizationId });
    if (closure) await announceDayChange(req, req.user.organizationId, closure.site);
    res.json({ ok: true });
  })
);

/* ═══════════════ RPT-1 — Basic usage reports ═══════════════ */

/**
 * GET /api/admin/reports?days=30
 * "Peak hours, average occupancy, no-show / overstay rate."
 *
 * Reports and the CSV export are a plan feature (`reports`): a plan
 * without it answers PLAN_FEATURE here, and the console shows an upgrade
 * prompt instead of a page that fails.
 */
router.get(
  "/reports",
  requireFeature("reports"),
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);

    const reservations = await Reservation.find({
      organization: req.user.organizationId,
      startTime: { $gte: since },
    });

    const byHour = Array.from({ length: 24 }, () => 0);
    let noShows = 0;
    let overstays = 0;
    let completed = 0;
    let totalMinutes = 0;

    for (const r of reservations) {
      byHour[new Date(r.startTime).getHours()] += 1;
      if (r.status === "expired") noShows += 1;
      if (r.overstay) overstays += 1;
      if (r.checkedInAt) {
        completed += 1;
        const out = r.checkedOutAt || r.endTime;
        totalMinutes += Math.max(0, (new Date(out) - new Date(r.checkedInAt)) / 60_000);
      }
    }

    const peak = byHour.reduce((best, count, hour) => (count > best.count ? { hour, count } : best), { hour: null, count: 0 });
    const totalUnits = (await Resource.find({ organization: req.user.organizationId, kind: { $ne: "room" } })).reduce(
      (sum, r) => sum + r.units.length,
      0
    );

    res.json({
      windowDays: days,
      totalReservations: reservations.length,
      peakHour: peak.hour === null ? null : `${String(peak.hour).padStart(2, "0")}:00`,
      reservationsByHour: byHour,
      noShowRate: reservations.length ? +(noShows / reservations.length).toFixed(3) : 0,
      overstayRate: reservations.length ? +(overstays / reservations.length).toFixed(3) : 0,
      averageSessionMinutes: completed ? Math.round(totalMinutes / completed) : 0,
      totalUnits,
    });
  })
);

/**
 * GET /api/admin/export?days=30
 * ADM-5 — "manual filtered export". CSV, generated on demand. Part of
 * the `reports` plan feature, like the page it is exported from.
 */
router.get(
  "/export",
  requireFeature("reports"),
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);

    const reservations = await Reservation.find({
      organization: req.user.organizationId,
      startTime: { $gte: since },
    })
      .sort({ startTime: -1 })
      .populate("member", "firstName lastName memberId email");

    const escape = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = [
      "reservation_id", "member_id", "member_name", "email", "resource_id", "unit",
      "start_time", "end_time", "status", "checked_in_at", "checked_out_at", "overstay",
    ];
    const rows = reservations.map((r) =>
      [
        r._id, r.member?.memberId, r.member ? `${r.member.firstName} ${r.member.lastName}` : "",
        r.member?.email, r.resource, r.unitLabel, r.startTime?.toISOString(), r.endTime?.toISOString(),
        r.status, r.checkedInAt?.toISOString(), r.checkedOutAt?.toISOString(), r.overstay,
      ].map(escape).join(",")
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reservations-${days}d.csv"`);
    res.send([header.join(","), ...rows].join("\n"));
  })
);

router.use((err, req, res, next) => {
  if (err instanceof ValidationError || err instanceof ReservationError || err instanceof SpaceError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return next(err);
});

export default router;
