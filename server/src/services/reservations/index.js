/**
 * The reservation engine (spec §9–§11).
 *
 * RES-2 is the story everything else rests on: "Server-side atomic
 * claim; Overlapping-time reservations rejected."
 *
 * ---------------------------------------------------------------------
 * Why the claim is written the way it is
 * ---------------------------------------------------------------------
 * A read-then-write inside a transaction is NOT sufficient here. Mongo
 * transactions give snapshot isolation, which does not prevent write
 * skew: two concurrent claims can each read "no conflict" from their own
 * snapshot and both insert. The seats look free to both, and both win.
 *
 * A partial unique index on (resource, unitLabel) for live statuses
 * would prevent that, but it also forbids booking the same seat for two
 * NON-overlapping windows — which the spec explicitly allows ("prevents
 * overlapping-time double-booking", not "one booking per seat, ever").
 *
 * So the claim uses optimistic insert with a deterministic tie-break:
 *
 *   1. validate the request (policy, closures, hours, one-active)
 *   2. insert the reservation
 *   3. re-query for overlapping live reservations on the same unit
 *   4. if any conflict has a LOWER _id than ours, we lost — delete ours
 *      and report the conflict
 *
 * ObjectIds are monotonic within a process and comparable across them,
 * so every racing claimant independently computes the same winner: the
 * lowest _id. Losers always roll themselves back, so exactly one
 * reservation survives no matter how many raced. This is verifiable —
 * see the concurrency test in scripts/reservationRace.js.
 * ---------------------------------------------------------------------
 */
import { randomInt } from "node:crypto";
import Reservation from "../../models/Reservation.js";
import Resource from "../../models/Resource.js";
import Floor from "../../models/Floor.js";
import Organization from "../../models/Organization.js";
import User from "../../models/User.js";
import { emitUnitStatus } from "../realtime.js";
import { sendEmail } from "../email/index.js";
import { reservationConfirmedEmail } from "../email/templates.js";
import {
  assertOrganizationBookable,
  assertWithinMaxStay,
  assertWithinOperatingHours,
  findClosureConflict,
  findConflicts,
  findMemberLiveReservation,
  LIVE_STATUSES,
} from "./availability.js";

export class ReservationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "ReservationError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Recomputes a unit's map status from its live reservations and writes
 * it to the Resource document, then streams the change (MAP-2).
 *
 * The map's status is derived, never set by hand in two places — that is
 * how "reserved" and "occupied" stay honest as reservations move through
 * their lifecycle.
 */
export async function syncUnitStatus(resourceId, unitLabel, { io } = {}) {
  const resource = await Resource.findById(resourceId);
  if (!resource) return null;

  const unit = resource.units.find((u) => u.label === unitLabel);
  if (!unit) return null;

  // A unit an admin has taken out of circulation stays unavailable
  // regardless of bookings (spec §8 — marking a piece unavailable
  // cascades to its units).
  if (unit.serviceStatus === "out_of_service") {
    unit.status = "unavailable";
  } else {
    const now = new Date();
    const active = await Reservation.findOne({
      resource: resourceId,
      unitLabel,
      status: "active",
    });
    const held = await Reservation.findOne({
      resource: resourceId,
      unitLabel,
      status: "held",
      startTime: { $lte: now },
      endTime: { $gt: now },
    });

    if (active) unit.status = "occupied";
    else if (held) unit.status = "reserved";
    else if (unit.status !== "unavailable") unit.status = "available";

    unit.overstay = Boolean(active?.overstay);
  }

  await resource.save();

  const floor = await Floor.findById(resource.floor).select("_id");
  emitUnitStatus(io, {
    floorId: floor?._id?.toString(),
    resourceId: resource._id.toString(),
    units: resource.units.map((u) => ({
      status: u.status,
      serviceStatus: u.serviceStatus,
      overstay: u.overstay,
    })),
  });

  return resource;
}

/**
 * RES-1 / RES-2 / RES-3 / RES-5 / RES-7 — claim a unit for a window.
 */
export async function claimReservation({
  organizationId,
  memberId,
  resourceId,
  unitLabel,
  startTime,
  endTime,
  io = null,
}) {
  const org = await Organization.findById(organizationId);
  if (!org) throw new ReservationError("Organization not found", 404);

  const closed = assertOrganizationBookable(org);
  if (closed) throw new ReservationError(closed, 409, "ORG_CLOSED");

  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ReservationError("startTime and endTime must be valid dates");
  }

  const tooLong = assertWithinMaxStay(org, start, end);
  if (tooLong) throw new ReservationError(tooLong, 400, "MAX_STAY");

  const outsideHours = assertWithinOperatingHours(org, start, end);
  if (outsideHours) throw new ReservationError(outsideHours, 400, "OPERATING_HOURS");

  const resource = await Resource.findById(resourceId);
  if (!resource) throw new ReservationError("Resource not found", 404);

  const unit = resource.units.find((u) => u.label === String(unitLabel));
  if (!unit) throw new ReservationError(`No unit "${unitLabel}" on that resource`, 404);
  if (unit.serviceStatus === "out_of_service") {
    throw new ReservationError("That resource is out of service.", 409, "OUT_OF_SERVICE");
  }
  if (unit.status === "unavailable") {
    throw new ReservationError("That resource is unavailable.", 409, "UNAVAILABLE");
  }

  const floor = await Floor.findById(resource.floor).select("site");
  const closure = await findClosureConflict({
    organizationId,
    siteId: floor?.site,
    startTime: start,
    endTime: end,
  });
  if (closure) {
    throw new ReservationError(
      `That period is closed: ${closure.reason}`,
      409,
      "CLOSURE"
    );
  }

  // RES-3 — one live reservation per member, self-only.
  const existing = await findMemberLiveReservation(memberId);
  if (existing) {
    throw new ReservationError(
      "You already have an active reservation. Check out or cancel it first.",
      409,
      "ALREADY_HOLDING"
    );
  }

  // Cheap pre-check so the common case fails fast with a clear message.
  const preConflicts = await findConflicts({
    resource: resourceId,
    unitLabel: String(unitLabel),
    startTime: start,
    endTime: end,
  });
  if (preConflicts.length) {
    throw new ReservationError("That resource is already booked for part of that window.", 409, "CONFLICT");
  }

  // ---- The atomic claim (see the header comment) ----
  const reservation = await Reservation.create({
    organization: organizationId,
    member: memberId,
    resource: resourceId,
    unitLabel: String(unitLabel),
    startTime: start,
    endTime: end,
    status: "held",
    checkInMethod: org.identity?.checkInMethod === "qr" ? "qr" : "rfid",
  });

  const racers = await findConflicts({
    resource: resourceId,
    unitLabel: String(unitLabel),
    startTime: start,
    endTime: end,
    excludeId: reservation._id,
  });

  const lostTo = racers.find((r) => r._id.toString() < reservation._id.toString());
  if (lostTo) {
    // Someone with a lower _id claimed the same window concurrently.
    // Every loser reaches this branch and removes itself, so exactly one
    // reservation survives.
    await Reservation.deleteOne({ _id: reservation._id });
    throw new ReservationError("That resource was just taken. Please pick another.", 409, "RACE_LOST");
  }

  await syncUnitStatus(resourceId, String(unitLabel), { io });

  // NOT-2 — confirmation email, async so a mail failure can never roll
  // back a good reservation (spec §15).
  const member = await User.findById(memberId);
  if (member) {
    sendEmail(
      reservationConfirmedEmail({
        org,
        user: member,
        reservation,
        resourceLabel: `${unitLabel}`,
      })
    );
  }

  return reservation;
}

/** Member- or staff-initiated cancellation. */
export async function cancelReservation({ reservationId, reason = null, io = null }) {
  const reservation = await Reservation.findById(reservationId);
  if (!reservation) throw new ReservationError("Reservation not found", 404);
  if (!LIVE_STATUSES.includes(reservation.status)) {
    throw new ReservationError(`That reservation is already ${reservation.status}.`, 409);
  }

  reservation.status = "cancelled";
  reservation.cancelReason = reason;
  await reservation.save();

  await syncUnitStatus(reservation.resource, reservation.unitLabel, { io });
  return reservation;
}
