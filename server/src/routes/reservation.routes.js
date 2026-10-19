import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Organization from "../models/Organization.js";
import Reservation from "../models/Reservation.js";
import Resource from "../models/Resource.js";
import Room from "../models/Room.js";
import ResourceType from "../models/ResourceType.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import {
  ReservationError,
  cancelReservation,
  claimReservation,
  reservationAvailability,
  roomBookingOptions,
} from "../services/reservations/index.js";
import { LIVE_STATUSES } from "../services/reservations/availability.js";
import { graceOf, memberStanding } from "../services/reservations/standing.js";
import { floorNames, labelOf, unitLabels } from "../services/pieceNames.js";
import { SpaceError } from "../services/spaces.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * POST /api/reservations
 * Body: { resourceId, unitLabel, startTime, endTime, pin }
 *
 * RES-1 — "Select available resource + time; card + PIN confirm;
 * Resource held on confirm."
 *
 * The PIN re-confirmation is deliberate (spec §5: "Reserving a resource
 * requires card plus PIN"). A live session alone isn't enough to spend
 * someone's bookings — an unattended logged-in phone shouldn't be able to
 * book on their behalf.
 *
 * The website books for now AND for later; the kiosk only ever seats
 * people from now on (checkin.routes.js).
 */
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { resourceId, unitLabel, startTime, endTime, pin } = req.body || {};

    if (!resourceId || !mongoose.isValidObjectId(resourceId)) {
      return res.status(400).json({ error: "A valid resourceId is required" });
    }
    if (unitLabel === undefined || unitLabel === null || `${unitLabel}`.trim() === "") {
      return res.status(400).json({ error: "unitLabel is required" });
    }

    const user = await User.findById(req.user.id);
    if (!user || !user.active) return res.status(401).json({ error: "Account is no longer active" });

    if (!/^[0-9]{6}$/.test(String(pin || ""))) {
      return res.status(400).json({ error: "Confirm with your 6-digit PIN." });
    }
    if (!(await bcrypt.compare(String(pin), user.pinHash))) {
      return res.status(401).json({ error: "That PIN is not correct." });
    }

    const reservation = await claimReservation({
      organizationId: req.user.organizationId,
      memberId: user._id,
      resourceId,
      unitLabel,
      startTime,
      endTime,
      io: req.app.get("io"),
    });

    res.status(201).json({ reservation: shape(reservation) });
  })
);

/**
 * GET /api/reservations/availability?resourceId&unitLabel&startTime&endTime
 *
 * "Could I book this?" for the booking form — the same rules as the
 * committed claim, including what the caller already holds (RES-3),
 * answered without revealing who holds what. Guidance only: the claim
 * checks everything again when it commits.
 */
router.get("/availability", requireAuth, asyncHandler(async (req, res) => {
  const { resourceId, unitLabel, startTime, endTime } = req.query;
  if (typeof resourceId !== "string" || !mongoose.isValidObjectId(resourceId) || typeof unitLabel !== "string") {
    return res.status(400).json({ error: "Choose a valid resource and unit." });
  }
  res.json(await reservationAvailability({
    organizationId: req.user.organizationId, resourceId, unitLabel, startTime, endTime, memberId: req.user.id,
  }));
}));

/**
 * GET /api/reservations/rooms/:roomId/options?startTime&endTime
 *
 * What one room offers for a window, for the member's room panel: the
 * room as a whole (null when it is only booked unit by unit) and every
 * bookable unit inside it on every level, each with whether it is free
 * and, if not, why — and `you`, whether the CALLER may take that window on
 * top of what they already hold (RES-3), so the panel never offers "Book
 * it" to someone the claim will refuse. One request instead of one per
 * unit — a room of twenty desks must not cost twenty round trips.
 * Guidance only, like /availability above.
 */
router.get("/rooms/:roomId/options", requireAuth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.roomId)) return res.status(400).json({ error: "Invalid room id" });
  const { startTime, endTime } = req.query;
  res.json(await roomBookingOptions({
    organizationId: req.user.organizationId, roomId: req.params.roomId, startTime, endTime, memberId: req.user.id,
  }));
}));

/**
 * GET /api/reservations/mine
 *
 * What the caller holds (RES-3) plus recent history (spec §9):
 *
 *   holding   their current session and their upcoming booking — at most
 *             one of each — earliest first, each with its `phase`
 *   live      the first of those, for clients written when a member could
 *             hold only one
 *
 * A held booking whose grace has run out is left out: it can no longer
 * be checked into, and the minute worker is about to expire it.
 */
router.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const org = await Organization.findById(req.user.organizationId).select("policy");
    const standing = await memberStanding(req.user.id, {
      organizationId: req.user.organizationId, graceMinutes: graceOf(org),
    });
    const history = await Reservation.find({ member: req.user.id, status: { $nin: LIVE_STATUSES } })
      .sort({ startTime: -1 })
      .limit(20);

    const holding = [
      ...standing.current.map((reservation) => ({ reservation, phase: "current" })),
      ...standing.upcoming.map((reservation) => ({ reservation, phase: "upcoming" })),
    ];
    // Named as the map names them now ("Long Table 2 · Seat 3").
    const labels = await unitLabels(holding.map(({ reservation }) => reservation));
    const shaped = [];
    for (const { reservation, phase } of holding) {
      shaped.push({ ...(await withResource(reservation)), label: labelOf(reservation, labels), phase });
    }

    res.json({
      holding: shaped,
      live: shaped[0] || null,
      history: history.map(shape),
    });
  })
);

/**
 * DELETE /api/reservations/:id
 * Self-cancellation. Staff cancellation lives on the admin router
 * (ADM-2), which additionally records a reason.
 */
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid reservation id" });
    }
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return res.status(404).json({ error: "Reservation not found" });

    // Self-only (spec §9) — a member may only cancel their own.
    if (reservation.member.toString() !== req.user.id) {
      return res.status(403).json({ error: "You can only cancel your own reservation." });
    }

    await cancelReservation({ reservationId: reservation._id, organizationId: req.user.organizationId, io: req.app.get("io") });
    res.json({ ok: true });
  })
);

function shape(reservation) {
  return {
    id: reservation._id.toString(),
    resourceId: reservation.resource.toString(),
    unitLabel: reservation.unitLabel,
    resourceLabel: reservation.targetLabel,
    // What it was booked as; /mine replaces it with the name the map uses now.
    label: reservation.targetLabel || null,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    status: reservation.status,
    checkedInAt: reservation.checkedInAt,
    checkedOutAt: reservation.checkedOutAt,
    overstay: reservation.overstay,
  };
}

/** Enriches a live reservation with enough map context to render it. */
async function withResource(reservation) {
  const base = shape(reservation);
  const resource = await Resource.findById(reservation.resource).select("resourceType position floor kind room");
  if (!resource) return base;
  const room = resource.kind === "room" ? await Room.findById(resource.room) : null;
  const type = await ResourceType.findById(resource.resourceType).select("label key");
  const piece = room ? null : (await floorNames([resource.floor])).get(String(resource._id));
  return {
    ...base,
    floorId: resource.floor.toString(),
    position: resource.position,
    // The piece ("Long Table 2") or the room; `label` is the unit's full name.
    resourceLabel: room?.name || piece?.name || type?.label || null,
    roomId: room ? String(room._id) : null,
    roomLevels: room?.levels.map((l) => ({ floorId: String(l.floor), name: l.name })) || [],
  };
}

router.use((err, req, res, next) => {
  if (err instanceof ReservationError || err instanceof SpaceError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  return next(err);
});

export default router;
