import { Router } from "express";
import mongoose from "mongoose";
import Closure from "../models/Closure.js";
import Organization from "../models/Organization.js";
import Resource from "../models/Resource.js";
import Room from "../models/Room.js";
import ResourceType from "../models/ResourceType.js";
import { resolveCheckIn, supportedMethods } from "../services/checkin/index.js";
import { OUTCOME } from "../services/checkin/outcomes.js";
import { ValidationError } from "../services/checkin/errors.js";
import { tapRateLimit } from "../middleware/rateLimit.js";
import {
  checkIn,
  checkOut,
  isDuplicateTap,
  limitSentence,
  tapStanding,
  walkInAtKiosk,
  walkInWindow,
} from "../services/reservations/occupancy.js";
import { ReservationError } from "../services/reservations/index.js";
import { MINIMUM_MINUTES, dayFrom } from "../services/reservations/day.js";
import { EntitlementError, assertWithinLimit, requireFeature } from "../services/entitlements.js";
import { floorNames, labelOf, unitLabels } from "../services/pieceNames.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Whether a card that is not yet registered could register right now.
 *
 * Asked at the TAP, so the kiosk can say "registration is closed" before
 * someone types their name, ID, email and PIN into a form the server
 * would then refuse. /registration/start still enforces both rules on its
 * own — this is the explanation, not the control.
 */
async function registrationAvailability(organizationId) {
  const org = await Organization.findById(organizationId).select("name identity entitlements terminology").lean();
  if (!org) return { open: false, code: "ORG_NOT_FOUND" };
  if (org.identity?.selfServiceRegistration === false) return { open: false, code: "REGISTRATION_DISABLED" };
  try {
    await assertWithinLimit({ ...org, entitlements: org.entitlements || {} }, "members");
  } catch (err) {
    if (err instanceof EntitlementError && err.code === "PLAN_LIMIT") return { open: false, code: "PLAN_LIMIT" };
    throw err;
  }
  return { open: true };
}

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
 *   member       -> the reservation/walk-in flow below (tapStanding)
 *   inactive     -> refer to staff
 *
 * A member's tap, in order (OCC-1..OCC-3):
 *   checked in already             -> checked-out
 *   a booking whose window is open -> checked-in
 *   a booking later today          -> later-today: the kiosk asks whether to
 *                                     check in now and cancel it, check in
 *                                     now and keep it (leaving before it
 *                                     starts), or not now
 *   nothing (or another day's)     -> walk-in
 *
 * The kiosk only ever seats people from now on; bookings for later are
 * made on the website.
 *
 * The kiosk is a plan feature: without `kiosk` this answers PLAN_FEATURE
 * before any credential is resolved, and a suspended organization is
 * refused by app.js's read-only guard (a tap checks people in and out).
 */
router.post(
  "/tap",
  tapRateLimit,
  requireFeature("kiosk"),
  asyncHandler(async (req, res) => {
    const { organizationId, method = "rfid", credential } = req.body || {};
    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId is required" });
    }

    const result = await resolveCheckIn({ organizationId, method, credential });

    const base = { outcome: result.outcome, method: result.method, cardUid: result.cardUid };

    if (result.outcome === OUTCOME.UNREGISTERED) {
      return res.json({ ...base, next: "register", registration: await registrationAvailability(organizationId) });
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

    const org = await Organization.findById(organizationId).select("name status terminology policy entitlements");

    // OCC-6 — swallow an accidental double-tap rather than checking the
    // member straight back out again. Applied only once identity has
    // resolved, so a genuine second person tapping isn't blocked.
    const dupe = isDuplicateTap(result.cardUid);

    // The member is known. What happens next depends on what they
    // currently hold — this is OCC-1/OCC-2/OCC-3's branch point, and it
    // lives here rather than inside the check-in interface (spec §13).
    const now = new Date();
    const session = await tapStanding({ organizationId, memberId: result.member._id, org, now });
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
      const activated = await checkIn({
        organizationId, memberId: result.member._id, reservationId: session.reservation._id, io,
      });
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

    // Org-wide closures today bound every walk-in; a site's own closures
    // are on its floors' day, which the kiosk reads for each unit.
    const dayEnd = dayFrom(null, now);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const closures = await Closure.find({
      organization: organizationId, site: null, startTime: { $lt: dayEnd }, endTime: { $gt: now },
    }).sort({ startTime: 1 });
    const offer = (window) =>
      window.available
        ? { available: true, latestEnd: window.latestEnd, limit: window.limit, sentence: limitSentence(window.limit, window.latestEnd, org) }
        : { available: false, code: window.code, reason: window.reason };

    // A booking later today: the kiosk asks what to do with it. Both ways
    // of checking in now are offered with what they would allow — keeping
    // it ends the stay before it starts, and there must be time for that.
    if (session.kind === "later-today") {
      const later = session.reservation;
      return res.json({
        ...base,
        next: "later-today",
        member: memberPayload,
        maxStayHours: org?.policy?.maxStayHours ?? 4,
        minimumMinutes: MINIMUM_MINUTES,
        upcoming: {
          id: String(later._id),
          startTime: later.startTime,
          endTime: later.endTime,
          label: later.targetLabel || null,
          ...(await describeResource(later.resource, later.unitLabel)),
        },
        options: {
          cancel: offer(walkInWindow({ org, now, closures })),
          keep: offer(walkInWindow({ org, now, ownNext: later, closures })),
        },
      });
    }

    // OCC-2 — nothing held for today: offer the map so they can pick a free
    // unit, with how long a stay could last before any unit is chosen.
    return res.json({
      ...base,
      next: "walk-in",
      member: memberPayload,
      maxStayHours: org?.policy?.maxStayHours ?? 4,
      minimumMinutes: MINIMUM_MINUTES,
      walkIn: offer(walkInWindow({ org, now, ownNext: session.standing.upcoming[0] || null, closures })),
    });
  })
);

/**
 * POST /api/checkin/walkin
 * Body: { organizationId, credential, resourceId, unitLabel,
 *         minutes?, untilLimit?, cancelReservationId? }
 *
 * OCC-2 — "Selected open resource assigned on the spot."
 *
 * The credential is re-presented rather than trusting a client-supplied
 * member id: the kiosk is an unauthenticated, physically-supervised
 * surface, so identity must come from the interface every time. For the
 * same reason the length is a request: the server works out every limit
 * itself (walkInAtKiosk) and refuses a stay that would run past one.
 *
 * `cancelReservationId` is the member's booking later today, given up for
 * this walk-in in the same transaction (the kiosk's option a).
 */
router.post(
  "/walkin",
  tapRateLimit,
  requireFeature("kiosk"),
  asyncHandler(async (req, res) => {
    const {
      organizationId, method = "rfid", credential, resourceId, unitLabel, minutes = null, untilLimit = false,
      cancelReservationId = null,
    } = req.body || {};
    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId is required" });
    }
    if (!resourceId || !mongoose.isValidObjectId(resourceId)) {
      return res.status(400).json({ error: "A valid resourceId is required" });
    }
    if (cancelReservationId !== null && !mongoose.isValidObjectId(cancelReservationId)) {
      return res.status(400).json({ error: "That reservation id isn't valid." });
    }

    const result = await resolveCheckIn({ organizationId, method, credential });
    if (result.outcome !== OUTCOME.MEMBER) {
      return res.status(409).json({ error: "That card isn't a registered, verified member.", outcome: result.outcome });
    }

    const org = await Organization.findById(organizationId).select("policy terminology");
    const { reservation: assigned, cancelled, limit, latestEnd } = await walkInAtKiosk({
      organizationId,
      memberId: result.member._id,
      resourceId,
      unitLabel,
      minutes,
      untilLimit: Boolean(untilLimit),
      cancelReservationId,
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
      // Why the stay ends when it does, when it ends at a limit.
      limit: limit ? { limit, at: latestEnd, sentence: limitSentence(limit, latestEnd, org) } : null,
      cancelled: cancelled
        ? { id: String(cancelled._id), startTime: cancelled.startTime, endTime: cancelled.endTime, label: labelOf(cancelled, await unitLabels([cancelled])) }
        : null,
    });
  })
);

/**
 * Adds the human-readable names so the kiosk can say where to sit: the
 * piece ("Long Table 2", or the room) and the unit's full name, "Long
 * Table 2 · Seat 3" — the same words as the map beside it.
 */
async function describeResource(resourceId, unitLabel) {
  const resource = await Resource.findById(resourceId).select("resourceType position floor kind room");
  if (!resource) return { unitLabel };
  const room = resource.kind === "room" ? await Room.findById(resource.room) : null;
  const type = await ResourceType.findById(resource.resourceType).select("label");
  const piece = room ? null : (await floorNames([resource.floor])).get(String(resource._id));
  const label = (await unitLabels([{ resource: resource._id, unitLabel }])).get(`${resource._id}:${unitLabel}`);
  return {
    unitLabel,
    ...(label ? { label } : {}),
    resourceLabel: room?.name || piece?.name || type?.label || null,
    kind: room ? "room" : "piece",
    roomLevels: room?.levels.length || 0,
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
