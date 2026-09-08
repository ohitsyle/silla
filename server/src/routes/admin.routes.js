import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Organization from "../models/Organization.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
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
import { emitOrgNotice } from "../services/realtime.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Spec §14: the admin surface is staff-and-above, desktop-only.
router.use(requireAuth, requireRole("staff", "superadmin"));

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

    const resources = await Resource.find({ organization: orgId, ...scope });

    let total = 0;
    const counts = { available: 0, reserved: 0, occupied: 0, unavailable: 0 };
    let outOfService = 0;
    const overstays = [];

    for (const resource of resources) {
      for (const unit of resource.units) {
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
    const filter = { organization: orgId };
    if (req.query.floorId && mongoose.isValidObjectId(req.query.floorId)) filter.floor = req.query.floorId;

    const [resources, types, zones] = await Promise.all([
      Resource.find(filter).sort({ "position.row": 1, "position.col": 1 }),
      ResourceType.find({ organization: orgId }),
      Zone.find(filter.floor ? { floor: filter.floor } : { organization: orgId }),
    ]);
    const typeById = new Map(types.map((t) => [t._id.toString(), t]));

    const inZone = (zone, resource, type) => {
      const { col, row } = resource.position;
      const { w, h } = type?.footprint || { w: 1, h: 1 };
      return (
        col >= zone.bounds.col &&
        row >= zone.bounds.row &&
        col + w <= zone.bounds.col + zone.bounds.w &&
        row + h <= zone.bounds.row + zone.bounds.h
      );
    };

    const grouped = new Map();
    for (const resource of resources) {
      const type = typeById.get(resource.resourceType.toString());
      const zone = zones.find((z) => inZone(z, resource, type));
      const key = zone ? zone._id.toString() : "__unzoned";
      if (!grouped.has(key)) {
        grouped.set(key, { zoneId: zone?._id?.toString() || null, zoneName: zone?.name || "Unzoned", resources: [] });
      }
      grouped.get(key).resources.push({
        id: resource._id.toString(),
        typeLabel: type?.label || null,
        typeKey: type?.key || null,
        hasServiceStatus: Boolean(type?.hasServiceStatus),
        position: resource.position,
        units: resource.units.map((u) => ({
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

    const upcoming = await Reservation.find({ resource: req.params.id, status: { $in: LIVE_STATUSES } })
      .sort({ startTime: 1 })
      .populate("member", "firstName lastName memberId email");
    const past = await Reservation.find({ resource: req.params.id, status: { $nin: LIVE_STATUSES } })
      .sort({ startTime: -1 })
      .limit(50)
      .populate("member", "firstName lastName memberId email");

    const shape = (r) => ({
      id: r._id.toString(),
      unitLabel: r.unitLabel,
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
    const resource = await Resource.findOne({ _id: req.params.id, organization: req.user.organizationId });
    if (!resource) return res.status(404).json({ error: "Resource not found" });

    const unit = resource.units.find((u) => u.label === req.params.label);
    if (!unit) return res.status(404).json({ error: "Unit not found" });

    const { status, serviceStatus } = req.body || {};

    if (serviceStatus) {
      const type = await ResourceType.findById(resource.resourceType);
      if (!type?.hasServiceStatus) {
        return res.status(400).json({ error: "That resource type doesn't carry a service status." });
      }
      if (!["working", "out_of_service"].includes(serviceStatus)) {
        return res.status(400).json({ error: "serviceStatus must be working or out_of_service" });
      }
      unit.serviceStatus = serviceStatus;
    }

    if (status) {
      // Staff may only toggle between available and unavailable —
      // occupied/reserved are derived from reservations, and letting an
      // admin set them by hand would desync the map from the bookings.
      if (!["available", "unavailable"].includes(status)) {
        return res.status(400).json({
          error: "Only 'available' and 'unavailable' can be set directly; occupied and reserved are derived from reservations.",
        });
      }
      unit.status = status;
    }

    await resource.save();
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
    const history = await Reservation.find({ member: req.params.id }).sort({ startTime: -1 }).limit(100);
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

    if (role) {
      if (!["staff", "superadmin"].includes(role)) {
        return res.status(400).json({ error: "Role must be staff or superadmin." });
      }
      target.role = role;
    }
    if (active !== undefined) target.active = Boolean(active);
    await target.save();

    res.json({ ok: true, staff: { id: target._id.toString(), role: target.role, active: target.active } });
  })
);

/* ═══════════ ADM-5 — Settings (superadmin only) ═══════════ */

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

    if (status) {
      if (!["open", "limited", "closed"].includes(status)) {
        return res.status(400).json({ error: "Status must be open, limited or closed." });
      }
      org.status = status;
    }

    const previousGrace = org.policy?.gracePeriodMinutes;

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

    res.status(201).json({ closure: { id: closure._id.toString(), startTime, endTime, reason: closure.reason } });
  })
);

router.delete(
  "/closures/:id",
  requireRole("superadmin"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid closure id" });
    await Closure.deleteOne({ _id: req.params.id, organization: req.user.organizationId });
    res.json({ ok: true });
  })
);

/* ═══════════════ RPT-1 — Basic usage reports ═══════════════ */

/**
 * GET /api/admin/reports?days=30
 * "Peak hours, average occupancy, no-show / overstay rate."
 */
router.get(
  "/reports",
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
    const totalUnits = (await Resource.find({ organization: req.user.organizationId })).reduce(
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
 * ADM-5 — "manual filtered export". CSV, generated on demand.
 */
router.get(
  "/export",
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
  if (err instanceof ValidationError || err instanceof ReservationError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return next(err);
});

export default router;
