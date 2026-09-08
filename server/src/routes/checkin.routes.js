import { Router } from "express";
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import { resolveCheckIn, supportedMethods } from "../services/checkin/index.js";
import { OUTCOME } from "../services/checkin/outcomes.js";
import { ValidationError } from "../services/checkin/errors.js";
import { tapRateLimit } from "../middleware/rateLimit.js";
import {
  assignWalkIn,
  checkIn,
  checkOut,
  getMemberSession,
  isDuplicateTap,
} from "../services/reservations/occupancy.js";
import { ReservationError } from "../services/reservations/index.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * POST /api/checkin/tap
 * Body: { organizationId, method?, credential }
 *
 * INF-3 / INF-4 — the kiosk's entry point. This route is deliberately
 * thin: it resolves a credential to a member through the check-in
 * interface and reports what it found. It does NOT activate reservations
 * or assign walk-in resources — that is OCC-1/OCC-2 in Sprint 2, and
 * keeping it out of here is the whole point of spec §13's abstraction.
 *
 * What the kiosk does with each outcome:
 *   unregistered -> launch registration (ID-1)
 *   pending      -> resume verification (ID-2)
 *   member       -> Sprint 2 hands off to the reservation/walk-in flow
 *   inactive     -> refer to staff
 */
router.post(
  "/tap",
  tapRateLimit,
  asyncHandler(async (req, res) => {
    const { organizationId, method = "rfid", credential } = req.body || {};
    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId is required" });
    }

    const result = await resolveCheckIn({ organizationId, method, credential });

    const base = { outcome: result.outcome, method: result.method, cardUid: result.cardUid };

    if (result.outcome === OUTCOME.UNREGISTERED) {
      return res.json({ ...base, next: "register" });
    }

    if (result.outcome === OUTCOME.PENDING) {
      return res.json({
        ...base,
        next: "verify",
        registrationId: result.member._id.toString(),
        email: result.member.email,
      });
    }

    if (result.outcome === OUTCOME.INACTIVE) {
      return res.status(403).json({ ...base, next: "see-staff", error: "This account is deactivated." });
    }

    const org = await Organization.findById(organizationId).select("terminology policy");

    // OCC-6 — swallow an accidental double-tap rather than checking the
    // member straight back out again. Applied only once identity has
    // resolved, so a genuine second person tapping isn't blocked.
    const dupe = isDuplicateTap(result.cardUid);

    // The member is known. What happens next depends on what they
    // currently hold — this is OCC-1/OCC-2/OCC-3's branch point, and it
    // lives here rather than inside the check-in interface (spec §13).
    const session = await getMemberSession(result.member._id);
    const io = req.app.get("io");

    const memberPayload = {
      id: result.member._id.toString(),
      firstName: result.member.firstName,
      lastName: result.member.lastName,
      memberId: result.member.memberId,
      noun: org?.terminology?.memberNoun || "member",
    };

    if (dupe.duplicate) {
      return res.json({
        ...base,
        next: "duplicate-tap",
        member: memberPayload,
        retryInMs: dupe.retryInMs,
        message: "Already read — please wait a moment.",
      });
    }

    // OCC-3 — checked in somewhere: this tap checks them out.
    if (session.kind === "active") {
      const completed = await checkOut({ memberId: result.member._id, io });
      return res.json({
        ...base,
        next: "checked-out",
        member: memberPayload,
        reservation: { id: completed._id.toString(), checkedOutAt: completed.checkedOutAt },
      });
    }

    // OCC-1 — holding a reservation: this tap activates it.
    if (session.kind === "held") {
      const activated = await checkIn({ organizationId, memberId: result.member._id, io });
      const enriched = await describeResource(activated.resource, activated.unitLabel);
      return res.json({
        ...base,
        next: "checked-in",
        member: memberPayload,
        reservation: {
          id: activated._id.toString(),
          checkedInAt: activated.checkedInAt,
          endTime: activated.endTime,
          ...enriched,
        },
      });
    }

    // OCC-2 — nothing held: offer the map so they can pick a free unit.
    return res.json({
      ...base,
      next: "walk-in",
      member: memberPayload,
      maxStayHours: org?.policy?.maxStayHours ?? 4,
    });
  })
);

/**
 * POST /api/checkin/walkin
 * Body: { organizationId, credential, resourceId, unitLabel }
 *
 * OCC-2 — "Selected open resource assigned on the spot."
 *
 * The credential is re-presented rather than trusting a client-supplied
 * member id: the kiosk is an unauthenticated, physically-supervised
 * surface, so identity must come from the interface every time.
 */
router.post(
  "/walkin",
  tapRateLimit,
  asyncHandler(async (req, res) => {
    const { organizationId, method = "rfid", credential, resourceId, unitLabel } = req.body || {};
    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId is required" });
    }
    if (!resourceId || !mongoose.isValidObjectId(resourceId)) {
      return res.status(400).json({ error: "A valid resourceId is required" });
    }

    const result = await resolveCheckIn({ organizationId, method, credential });
    if (result.outcome !== OUTCOME.MEMBER) {
      return res.status(409).json({ error: "That card isn't a registered, verified member.", outcome: result.outcome });
    }

    const assigned = await assignWalkIn({
      organizationId,
      memberId: result.member._id,
      resourceId,
      unitLabel,
      io: req.app.get("io"),
    });

    const enriched = await describeResource(assigned.resource, assigned.unitLabel);
    res.status(201).json({
      ok: true,
      reservation: {
        id: assigned._id.toString(),
        checkedInAt: assigned.checkedInAt,
        endTime: assigned.endTime,
        ...enriched,
      },
    });
  })
);

/** Adds the human-readable piece name so the kiosk can say where to sit. */
async function describeResource(resourceId, unitLabel) {
  const resource = await Resource.findById(resourceId).select("resourceType position floor");
  if (!resource) return { unitLabel };
  const type = await ResourceType.findById(resource.resourceType).select("label");
  return {
    unitLabel,
    resourceLabel: type?.label || null,
    position: resource.position,
    floorId: resource.floor.toString(),
  };
}

/**
 * GET /api/checkin/methods
 * Reports which implementations exist behind the interface. Useful to
 * prove INF-3's AC ("RFID is the only implementation in v1") without
 * reading the source.
 */
router.get("/methods", (req, res) => {
  res.json({ implemented: supportedMethods(), plannedFastFollow: ["qr"] });
});

router.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(err.status || 400).json({ error: err.message });
  if (err instanceof ReservationError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return next(err);
});

export default router;
