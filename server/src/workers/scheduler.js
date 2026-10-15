import cron from "node-cron";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Reservation from "../models/Reservation.js";
import Resource from "../models/Resource.js";
import Floor from "../models/Floor.js";
import Closure from "../models/Closure.js";
import { syncUnitStatus } from "../services/reservations/index.js";
import { hasFeature } from "../services/entitlements.js";
import { sendEmail } from "../services/email/index.js";
import {
  closureCancelledEmail,
  maxStayReleasedEmail,
  noShowReleasedEmail,
  startingSoonEmail,
} from "../services/email/templates.js";

/**
 * The shared scheduled worker referenced throughout the spec
 * (§10 max-stay cap, §11 grace expiry, §14 closing-time release,
 * §15 starting-soon reminder). One worker, several jobs, each reading
 * policy values from the relevant Organization document at runtime
 * rather than a hardcoded interval (spec §16).
 *
 * Every job is idempotent and safe to run every minute: they select on
 * state that the job itself then changes, so a second pass finds
 * nothing. That matters because a restart mid-tick must not double-email
 * or double-release.
 */

// Socket.io instance, set by server.js so released seats stream to the
// map (MAP-2) exactly like a member-triggered change.
let ioRef = null;

export function startScheduler(io = null) {
  ioRef = io;

  const task = cron.schedule("* * * * *", async () => {
    try {
      await purgeAbandonedRegistrations();
      await releaseExpiredGraceHolds();
      await refreshDueHolds();
      await releaseOverstayedSessions();
      await releaseAtClosingTime();
      await sendStartingSoonReminders();
      await applyScheduledClosures();
    } catch (err) {
      // A throwing job must not kill the cron loop.
      console.error("[scheduler] job failed:", err.message);
    }
  });
  console.log("[scheduler] started");
  return task;
}

/** MAP-2: future holds become reserved when their start time arrives. */
export async function refreshDueHolds({ io = ioRef } = {}) {
  const now = new Date();
  const holds = await Reservation.find({ status: "held", startTime: { $lte: now }, endTime: { $gt: now } }).select("resource unitLabel");
  let refreshed = 0;
  const visited = new Set();
  for (const hold of holds) {
    const key = `${hold.resource}:${hold.unitLabel}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const resource = await Resource.findById(hold.resource).select("units");
    const unit = resource?.units.find((u) => u.label === hold.unitLabel);
    if (unit?.status !== "available" || unit.serviceStatus === "out_of_service") continue;
    await syncUnitStatus(hold.resource, hold.unitLabel, { io });
    refreshed++;
  }
  return refreshed;
}

/** Loads the org for a reservation, cached per tick to avoid refetching. */
function orgLoader() {
  const cache = new Map();
  return async (id) => {
    const key = id.toString();
    if (!cache.has(key)) cache.set(key, await Organization.findById(id));
    return cache.get(key);
  };
}

/**
 * ID-2 — spec §4: "an abandoned registration leaves nothing behind."
 * Without this, a walked-away kiosk registration keeps its card UID,
 * member ID and email reserved by the unique indexes forever.
 */
const ABANDONED_GRACE_MS = 60 * 60 * 1000;

export async function purgeAbandonedRegistrations() {
  const cutoff = new Date(Date.now() - ABANDONED_GRACE_MS);
  const result = await User.deleteMany({
    verified: false,
    role: "member", // never touch provisioned staff accounts (spec §6)
    verificationExpiresAt: { $ne: null, $lt: cutoff },
  });
  if (result.deletedCount) {
    console.log(`[scheduler] purged ${result.deletedCount} abandoned registration(s)`);
  }
  return result.deletedCount;
}

/**
 * RES-5 — grace expiry. "Expiry releases resource and marks no-show."
 * A held reservation whose start + grace has passed without a check-in
 * is released.
 */
export async function releaseExpiredGraceHolds() {
  const loadOrg = orgLoader();
  const now = new Date();
  let released = 0;

  const candidates = await Reservation.find({ status: "held", startTime: { $lte: now } });
  for (const reservation of candidates) {
    const org = await loadOrg(reservation.organization);
    const grace = org?.policy?.gracePeriodMinutes ?? 10;
    if (now < reservation.endTime && now - reservation.startTime < grace * 60_000) continue;

    reservation.status = "expired";
    await reservation.save();
    await syncUnitStatus(reservation.resource, reservation.unitLabel, { io: ioRef });
    released += 1;

    const member = await User.findById(reservation.member);
    if (member && org) {
      sendEmail(
        noShowReleasedEmail({
          org,
          user: member,
          reservation,
          resourceLabel: reservation.targetLabel || reservation.unitLabel,
        })
      );
    }
  }

  if (released) console.log(`[scheduler] released ${released} expired hold(s) as no-shows`);
  return released;
}

/**
 * OCC-4 — the maximum-stay cap (spec §10). "Worker releases at the org's
 * configured cap; Member emailed; session flagged overstay."
 *
 * The session is flagged rather than silently freed, because the person
 * is probably still physically sitting there — staff are the enforcement
 * layer, and the flag is what tells them where to look (spec §14).
 */
export async function releaseOverstayedSessions() {
  const loadOrg = orgLoader();
  const now = new Date();
  let released = 0;

  const active = await Reservation.find({ status: "active", checkedInAt: { $ne: null } });
  for (const reservation of active) {
    const org = await loadOrg(reservation.organization);
    const maxHours = org?.policy?.maxStayHours ?? 4;
    if (now - reservation.checkedInAt < maxHours * 3_600_000) continue;

    reservation.status = "released";
    reservation.overstay = true;
    await reservation.save();
    await syncUnitStatus(reservation.resource, reservation.unitLabel, { io: ioRef });
    released += 1;

    const member = await User.findById(reservation.member);
    if (member && org) {
      sendEmail(
        maxStayReleasedEmail({ org, user: member, reservation, resourceLabel: reservation.targetLabel || reservation.unitLabel })
      );
    }
  }

  if (released) console.log(`[scheduler] released ${released} overstayed session(s)`);
  return released;
}

/**
 * OCC-5 — forgotten checkouts released at closing, "using the org's
 * configured operating hours" (spec §10).
 */
export async function releaseAtClosingTime() {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let released = 0;

  for (const org of await Organization.find()) {
    const close = org.policy?.operatingHours?.close;
    if (!close) continue;
    const [h, m] = String(close).split(":").map(Number);
    const closeMinutes = h * 60 + (m || 0);

    // Only fire in the minute the facility closes — this job runs every
    // minute, and re-running it all evening would be wasted work.
    if (nowMinutes !== closeMinutes) continue;

    const stillIn = await Reservation.find({ organization: org._id, status: { $in: ["held", "active"] } });
    for (const reservation of stillIn) {
      reservation.status = reservation.status === "active" ? "released" : "expired";
      await reservation.save();
      await syncUnitStatus(reservation.resource, reservation.unitLabel, { io: ioRef });
      released += 1;
    }
    if (stillIn.length) {
      console.log(`[scheduler] closing time at "${org.name}" — released ${stillIn.length} session(s)`);
    }
  }
  return released;
}

/**
 * NOT-3 — starting-soon reminder. "Worker sends reminder before grace;
 * Sent-once flag prevents duplicates."
 *
 * The flag is the reservation's own `remindedAt`, so a restart can't
 * re-send.
 */
const REMINDER_LEAD_MS = 10 * 60_000;

export async function sendStartingSoonReminders() {
  const loadOrg = orgLoader();
  const now = new Date();
  const horizon = new Date(now.getTime() + REMINDER_LEAD_MS);
  let sent = 0;

  const upcoming = await Reservation.find({
    status: "held",
    remindedAt: null,
    startTime: { $gt: now, $lte: horizon },
  });

  for (const reservation of upcoming) {
    const org = await loadOrg(reservation.organization);
    // Reminder emails are a plan feature (emailReminders). Skipped WITHOUT
    // setting remindedAt: the flag records a reminder that was sent, and
    // an organization that gains the feature inside the lead window
    // should still get this one out before the reservation starts.
    if (org && !hasFeature(org, "emailReminders")) continue;
    const member = await User.findById(reservation.member);
    if (member && org) {
      sendEmail(
        startingSoonEmail({ org, user: member, reservation, resourceLabel: reservation.targetLabel || reservation.unitLabel })
      );
    }
    reservation.remindedAt = now;
    await reservation.save();
    sent += 1;
  }

  if (sent) console.log(`[scheduler] sent ${sent} starting-soon reminder(s)`);
  return sent;
}

/**
 * RES-7 / NOT-5 — a scheduled closure cancels the reservations inside
 * it and emails those members with the staff-entered reason (spec §14).
 *
 * `appliedAt` makes this run-once per closure.
 */
export async function applyScheduledClosures() {
  let cancelled = 0;

  for (const closure of await Closure.find({ appliedAt: null })) {
    const org = await Organization.findById(closure.organization);
    if (!org) continue;

    // Site-scoped closures only affect that site's floors.
    let resourceFilter = {};
    if (closure.site) {
      const floors = await Floor.find({ site: closure.site }).select("_id");
      const resources = await Resource.find({ floor: { $in: floors.map((f) => f._id) } }).select("_id");
      resourceFilter = { resource: { $in: resources.map((r) => r._id) } };
    }

    const affected = await Reservation.find({
      organization: closure.organization,
      status: { $in: ["held", "active"] },
      startTime: { $lt: closure.endTime },
      endTime: { $gt: closure.startTime },
      ...resourceFilter,
    });

    for (const reservation of affected) {
      reservation.status = "cancelled";
      reservation.cancelReason = closure.reason;
      await reservation.save();
      await syncUnitStatus(reservation.resource, reservation.unitLabel, { io: ioRef });
      cancelled += 1;

      const member = await User.findById(reservation.member);
      if (member) {
        sendEmail(
          closureCancelledEmail({
            org,
            user: member,
            reservation,
            resourceLabel: reservation.targetLabel || reservation.unitLabel,
            closure,
          })
        );
      }
    }

    closure.appliedAt = new Date();
    await closure.save();
    if (affected.length) {
      console.log(`[scheduler] closure "${closure.reason}" cancelled ${affected.length} reservation(s)`);
    }
  }
  return cancelled;
}

/** Exposed so scripts and tests can drive one pass without cron. */
export async function runAllJobsOnce(io = null) {
  ioRef = io;
  return {
    purged: await purgeAbandonedRegistrations(),
    graceExpired: await releaseExpiredGraceHolds(),
    overstayed: await releaseOverstayedSessions(),
    closingReleased: await releaseAtClosingTime(),
    reminded: await sendStartingSoonReminders(),
    closureCancelled: await applyScheduledClosures(),
  };
}
