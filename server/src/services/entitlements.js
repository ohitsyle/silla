/**
 * Plans, limits, and whether an organization is open for business.
 *
 * SILLA's control plane (vendor/) owns subscriptions. It pushes a snapshot
 * of what each organization's plan allows into Organization.entitlements
 * (see routes/internal.routes.js), and THIS module is the only place that
 * snapshot is interpreted. Routes call it at the moment something is
 * created or used — they never read the snapshot themselves — so a rule
 * changes in one place.
 *
 *   isOperational(org)                 subscription in good standing?
 *   hasFeature(org, key)               may it use this feature?
 *   assertWithinLimit(org, key, n)     would creating n more exceed the plan?
 *
 * Defaults are deliberately permissive in exactly two cases:
 *   - `managed: false`: an organization that predates subscriptions (and
 *     the demo) has no limits and every feature, so shipping this breaks
 *     nothing that exists today;
 *   - a feature or limit key the snapshot does not mention: version skew
 *     between the two services must never lock a paying customer out. To
 *     withhold something, the control plane has to say so explicitly.
 *
 * Downgrades never delete anything. An organization over a new limit
 * keeps everything it has and is only refused NEW creations.
 */
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import Building from "../models/Building.js";
import Room from "../models/Room.js";
import Floor from "../models/Floor.js";
import Site from "../models/Site.js";
import Resource from "../models/Resource.js";
import ResourceType from "../models/ResourceType.js";
import User from "../models/User.js";
import { FEATURES, LIMITS, OPERATIONAL_STATUS } from "../lib/plans.js";

export class EntitlementError extends Error {
  /**
   * @param {string} message  shown to the person who hit it — say what the
   *                          limit is and what to do, not just "forbidden"
   * @param {object} o
   * @param {"PLAN_LIMIT"|"PLAN_FEATURE"|"ORG_SUSPENDED"} o.code
   */
  constructor(message, { status = 403, code, details = {} } = {}) {
    super(message);
    this.name = "EntitlementError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, ...this.details };
  }
}

/* ───────────────────────────── reading the snapshot ───────────────────────────── */

const snapshotOf = (org) => (org?.entitlements?.managed ? org.entitlements : null);

export function isOperational(org) {
  const e = snapshotOf(org);
  return !e || OPERATIONAL_STATUS.has(e.status);
}

export function hasFeature(org, key) {
  const e = snapshotOf(org);
  if (!e) return true;
  const value = e.features?.[key];
  return value === undefined ? true : Boolean(value);
}

/** The cap for `key`, or null for no limit. */
export function limitOf(org, key) {
  const e = snapshotOf(org);
  if (!e) return null;
  const value = e.limits?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** What the client is told — the same shape it reads in OrgContext.entitlementsOf. */
export function publicEntitlements(org) {
  const e = snapshotOf(org);
  if (!e) return { managed: false };
  return {
    managed: true,
    plan: e.plan,
    planName: e.planName,
    status: e.status,
    features: e.features || {},
    limits: e.limits || {},
    currentPeriodEnd: e.currentPeriodEnd,
    graceEndsAt: e.graceEndsAt,
    notice: e.notice,
  };
}

/* ───────────────────────────── usage ───────────────────────────── */

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * How many of `key` the organization has right now. Counted live rather
 * than kept as a counter: a counter drifts the first time a write path
 * forgets to bump it, and every one of these is an indexed count.
 */
export async function countUsage(organizationId, key) {
  const organization = oid(organizationId);
  switch (key) {
    case "buildings":
      return Building.countDocuments({ organization });
    case "rooms":
      return Room.countDocuments({ organization });
    case "floors": {
      const sites = await Site.find({ organization }).distinct("_id");
      return Floor.countDocuments({ site: { $in: sites } });
    }
    case "resources": {
      // Bookable units — what a member can actually reserve. A room's own
      // booking target (kind "room") is internal and never counts, and
      // neither do pieces whose type is not reservable (a shelf).
      const [row] = await Resource.aggregate([
        { $match: { organization, kind: { $ne: "room" } } },
        { $lookup: { from: ResourceType.collection.name, localField: "resourceType", foreignField: "_id", as: "type" } },
        { $match: { "type.reservable": { $ne: false } } },
        { $group: { _id: null, units: { $sum: { $max: [1, { $size: { $ifNull: ["$units", []] } }] } } } },
      ]);
      return row?.units || 0;
    }
    case "members":
      return User.countDocuments({ organization, role: "member", active: { $ne: false } });
    case "staff":
      return User.countDocuments({ organization, role: { $in: ["staff", "superadmin"] }, active: { $ne: false } });
    default:
      throw new Error(`Unknown limit "${key}"`);
  }
}

/** Every limit at once, for the plan page and the control plane's summary. */
export async function usageOf(organizationId) {
  const keys = Object.keys(LIMITS);
  const counts = await Promise.all(keys.map((key) => countUsage(organizationId, key)));
  return Object.fromEntries(keys.map((key, i) => [key, counts[i]]));
}

/* ───────────────────────────── assertions ───────────────────────────── */

async function load(orgOrId) {
  if (orgOrId && typeof orgOrId === "object" && orgOrId.entitlements !== undefined) return orgOrId;
  const org = await Organization.findById(orgOrId).select("name entitlements terminology").lean();
  if (!org) throw new EntitlementError("Organization not found", { status: 404, code: "ORG_NOT_FOUND" });
  return org;
}

/** "1 building" / "3 rooms" — in the organization's own words where it has them. */
function counted(org, key, n) {
  const words = {
    buildings: ["building", "buildings"],
    floors: ["floor", "floors"],
    rooms: ["room", "rooms"],
    resources: [org?.terminology?.resourceNoun || "bookable unit", null],
    members: [org?.terminology?.memberNoun || "member", null],
    staff: ["staff or administrator account", "staff and administrator accounts"],
  }[key] || [key, key];
  const [one, many] = words;
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/**
 * Throws EntitlementError (PLAN_LIMIT) if adding `adding` more of `key`
 * would exceed the plan. Call it immediately before the create, inside
 * the same transaction where there is one.
 */
export async function assertWithinLimit(orgOrId, key, adding = 1) {
  if (!LIMITS[key]) throw new Error(`Unknown limit "${key}"`);
  const org = await load(orgOrId);
  const max = limitOf(org, key);
  if (max === null) return;
  const used = await countUsage(org._id, key);
  if (used + adding > max) {
    throw new EntitlementError(
      `Your plan includes ${counted(org, key, max)}, and ${used} ${used === 1 ? "is" : "are"} already in use. ` +
        "Ask SILLA to raise the limit or move you to a larger plan.",
      { code: "PLAN_LIMIT", details: { limit: key, max, used, adding } }
    );
  }
}

/** Throws EntitlementError (PLAN_FEATURE) if the plan withholds `key`. */
export async function assertFeature(orgOrId, key) {
  if (!FEATURES[key]) throw new Error(`Unknown feature "${key}"`);
  const org = await load(orgOrId);
  if (!hasFeature(org, key)) {
    throw new EntitlementError(`${FEATURES[key]} isn't included in your plan. Ask SILLA to add it.`, {
      code: "PLAN_FEATURE",
      details: { feature: key },
    });
  }
}

/** Throws EntitlementError (ORG_SUSPENDED) unless the subscription is in good standing. */
export async function assertOperational(orgOrId) {
  const org = await load(orgOrId);
  if (!isOperational(org)) throw suspendedError(org);
}

function suspendedError(org) {
  const cancelled = org.entitlements?.status === "cancelled";
  return new EntitlementError(
    cancelled
      ? `${org.name} is no longer active. Contact your administrator.`
      : `${org.name} is paused while its subscription is sorted out. You can still look, but changes are on hold. Contact your administrator.`,
    { code: "ORG_SUSPENDED", details: { status: org.entitlements?.status } }
  );
}

/* ───────────────────────────── middleware ───────────────────────────── */

/**
 * Which organization a request acts on: the signed-in user's (from a
 * VALID token — never an unverified claim), else the organizationId a
 * public endpoint names in its body or query (kiosk tap, registration).
 */
export function organizationIdFor(req) {
  if (req.user?.organizationId) return String(req.user.organizationId);
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ") && process.env.JWT_SECRET) {
    try {
      const claims = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      if (claims?.organizationId) return String(claims.organizationId);
    } catch {
      // An invalid token is the route's problem to report, not ours.
    }
  }
  const named = req.body?.organizationId || req.query?.organizationId;
  return named && mongoose.isValidObjectId(named) ? String(named) : null;
}

/** Express middleware form of assertFeature. */
export function requireFeature(key) {
  if (!FEATURES[key]) throw new Error(`Unknown feature "${key}"`);
  return async (req, res, next) => {
    try {
      const id = organizationIdFor(req);
      if (id) await assertFeature(id, key);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Mounted once in app.js, before every router: a suspended or cancelled
 * organization is READ-ONLY. Anyone may still sign in and look — that is
 * how its administrators see why — but nothing changes: no reservations,
 * check-ins, registrations or edits. Sign-in and the first-login gates
 * (/api/auth) and the control plane itself (/api/internal) are exempt.
 */
export function operationalGuard() {
  const exempt = ["/api/auth/", "/api/internal/", "/api/health"];
  return async (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (exempt.some((prefix) => req.path.startsWith(prefix))) return next();
    try {
      const id = organizationIdFor(req);
      if (!id) return next();
      const org = await Organization.findById(id).select("name entitlements").lean();
      if (org && !isOperational(org)) throw suspendedError(org);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For app.js's error handler: answers an EntitlementError, or returns false. */
export function respondToEntitlementError(err, res) {
  if (!(err instanceof EntitlementError)) return false;
  res.status(err.status).json(err.toJSON());
  return true;
}
