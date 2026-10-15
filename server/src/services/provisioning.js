/**
 * Provisioning — turning a profile into a running organization.
 *
 * There are two ways an organization comes into being, and they used to
 * be one script:
 *
 *   npm run seed / seed:file      an operator at a terminal
 *   POST /api/internal/organizations
 *                                 SILLA's control plane (vendor/), when
 *                                 staff provision a buyer's order
 *
 * Both call provisionFromProfile() below, so the CLI and the API cannot
 * drift: a profile the importer accepts provisions the same organization
 * whichever door it came through. The profile is validated by
 * scripts/importProfile.js first — it is untrusted input, and a cast
 * error halfway through creation is the worst possible error message —
 * and a creation that fails part-way is rolled back rather than leaving
 * half an organization holding an address.
 *
 * This module also decides an organization's ADDRESS (its slug, the
 * `harborview` in <product>/harborview/map — see lib/slug.js), and reads
 * the entitlement snapshot the control plane hands over, because both are
 * things the control plane gives this deployment and both must be checked
 * before anything is written.
 */
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import Organization from "../models/Organization.js";
import Site from "../models/Site.js";
import Building from "../models/Building.js";
import Floor from "../models/Floor.js";
import Room from "../models/Room.js";
import ResourceType from "../models/ResourceType.js";
import Resource from "../models/Resource.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import User from "../models/User.js";
import { generateVerificationCode, memberIdExample } from "../lib/identity.js";
import { RESERVED_SLUGS, slugProblem, slugify } from "../lib/slug.js";
import { ENTITLEMENT_STATUS, FEATURES, LIMITS } from "../lib/plans.js";
import { sendEmail } from "./email/index.js";
import { founderWelcomeEmail, organizationUrl } from "./email/templates.js";
import { normalizeCardUid } from "./checkin/rfid.js";
import { registerProfile, validateProfile } from "../scripts/importProfile.js";
import { VERTICAL_PROFILES } from "../scripts/profiles.js";
import { seedFloorLayouts } from "../scripts/seedLayout.js";

/**
 * A refusal the caller can act on: `status` is the HTTP answer, `code` is
 * stable for programs, and `fields` names what to fix — the same
 * { field, message } pairs importProfile.js reports, so the console and
 * the CLI describe a bad profile in identical words.
 */
export class ProvisioningError extends Error {
  constructor(message, { status = 400, code = "PROVISIONING_FAILED", ...details } = {}) {
    super(message);
    this.name = "ProvisioningError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, ...this.details };
  }
}

/* ───────────────────────────── addresses ───────────────────────────── */

const MAX_SLUG = 40;

/** Appends `suffix`, trimming the base so the whole thing still fits in 40 characters. */
function withSuffix(base, suffix) {
  return `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/**
 * slugify() can produce something lib/slug.js would still refuse: "" for
 * a name with no Latin letters at all, two characters for "UP", or a
 * reserved word for an organization literally called "Map". Each gets the
 * smallest change that makes it usable, rather than a random string that
 * reads as nobody's name.
 */
function usableBase(name) {
  let base = slugify(name);
  if (!base) return "organization";
  if (base.length < 3 || RESERVED_SLUGS.has(base)) base = withSuffix(base, "-org");
  return slugProblem(base) ? "organization" : base;
}

/**
 * An unused, valid address derived from `name`: "Harborview Library" →
 * `harborview-library`, then `harborview-library-2`, and so on.
 *
 * `taken` holds addresses already handed out in the same batch (the slug
 * migration's dry run assigns many before writing any), so two
 * organizations called "Main Library" are not both promised the same one.
 *
 * Checking the database is not the guarantee — the unique index on
 * Organization.slug is. This only makes the common case read well.
 */
export async function availableSlug(name, { taken = new Set() } = {}) {
  const base = usableBase(name);
  const free = async (candidate) =>
    !taken.has(candidate) && !slugProblem(candidate) && !(await Organization.exists({ slug: candidate }));

  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : withSuffix(base, `-${n}`);
    if (await free(candidate)) return candidate;
  }
  // Fifty organizations with the same name is not a real case; a random
  // tail is a fine answer to an unreal one, and it still terminates.
  for (;;) {
    const candidate = withSuffix(base, `-${randomInt(1000, 1_000_000)}`);
    if (await free(candidate)) return candidate;
  }
}

/**
 * The control plane's "can I have this address?" — the same answer
 * provisioning will give, asked before staff press the button.
 */
export async function slugAvailability(rawSlug) {
  const slug = String(rawSlug ?? "").trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return { available: false, problem, suggestion: await availableSlug(rawSlug) };
  if (await Organization.exists({ slug })) {
    return { available: false, problem: "That address is already taken.", suggestion: await availableSlug(slug) };
  }
  return { available: true, problem: null, suggestion: null };
}

async function slugTaken(slug) {
  return new ProvisioningError(`The address "${slug}" is already taken.`, {
    status: 409,
    code: "SLUG_TAKEN",
    suggestion: await availableSlug(slug),
  });
}

/* ───────────────────────────── the plan snapshot ───────────────────────────── */

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const NOTICE_MAX = 500;

function readDate(value, field, fail) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (typeof value === "boolean" || Number.isNaN(date.getTime())) {
    fail(field, "must be an ISO date or null");
    return null;
  }
  return date;
}

/**
 * Checks an entitlement snapshot from the control plane against the keys
 * in lib/plans.js and returns the copy to store.
 *
 * Two kinds of wrong are treated differently, on purpose:
 *   - a KNOWN key with a bad value (a limit of -1, a feature of "yes") is
 *     refused outright: storing it would either lock a customer out or
 *     silently give away a limit, and the control plane records a failed
 *     push where staff will see it;
 *   - an UNKNOWN key (a feature the vendor has and this deployment does
 *     not yet) is dropped and reported back in `ignored`. Refusing the
 *     whole snapshot over it would let version skew block a suspension
 *     or a renewal from ever arriving — the exact failure the "absent key
 *     is allowed" rule in services/entitlements.js exists to prevent.
 */
export function readEntitlementSnapshot(raw) {
  const errors = [];
  const ignored = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: "(root)", message: "must be an object" }], ignored, snapshot: null };
  }

  const known = ["managed", "plan", "planName", "status", "features", "limits", "currentPeriodEnd", "graceEndsAt", "notice", "version"];
  for (const key of Object.keys(raw)) if (!known.includes(key)) ignored.push(key);

  const out = {};

  // A snapshot pushed by the control plane is managed unless it says
  // otherwise; `managed: false` is how SILLA lifts every limit at once.
  if (raw.managed === undefined) out.managed = true;
  else if (typeof raw.managed !== "boolean") fail("managed", "must be true or false");
  else out.managed = raw.managed;

  for (const key of ["plan", "planName"]) {
    const value = raw[key];
    if (value === undefined || value === null) out[key] = null;
    else if (typeof value !== "string") fail(key, "must be a string or null");
    else out[key] = value.trim() || null;
  }

  if (raw.status === undefined && out.managed === false) out.status = "active";
  else if (!ENTITLEMENT_STATUS.includes(raw.status)) fail("status", `must be one of ${ENTITLEMENT_STATUS.join(", ")}`);
  else out.status = raw.status;

  out.features = {};
  if (raw.features !== undefined && raw.features !== null) {
    if (!isPlainObject(raw.features)) fail("features", "must be an object of true/false values");
    else {
      for (const [key, value] of Object.entries(raw.features)) {
        if (!FEATURES[key]) ignored.push(`features.${key}`);
        else if (typeof value !== "boolean") fail(`features.${key}`, "must be true or false");
        else out.features[key] = value;
      }
    }
  }

  out.limits = {};
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!isPlainObject(raw.limits)) fail("limits", "must be an object of whole numbers or null");
    else {
      for (const [key, value] of Object.entries(raw.limits)) {
        if (!LIMITS[key]) ignored.push(`limits.${key}`);
        else if (value === null) out.limits[key] = null;
        else if (!Number.isInteger(value) || value < 0) fail(`limits.${key}`, "must be a whole number of 0 or more, or null for no limit");
        else out.limits[key] = value;
      }
    }
  }

  out.currentPeriodEnd = readDate(raw.currentPeriodEnd, "currentPeriodEnd", fail);
  out.graceEndsAt = readDate(raw.graceEndsAt, "graceEndsAt", fail);

  if (raw.notice === undefined || raw.notice === null) out.notice = null;
  else if (typeof raw.notice !== "string") fail("notice", "must be a string or null");
  else if (raw.notice.length > NOTICE_MAX) fail("notice", `must be ${NOTICE_MAX} characters or fewer`);
  else out.notice = raw.notice.trim() || null;

  // The ordering key. Without it a delayed push could undo a newer one,
  // so it is required rather than defaulted.
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version) || raw.version < 0) {
    fail("version", "is required: a number that grows with every change (the vendor uses a timestamp)");
  } else {
    out.version = raw.version;
  }

  const ok = errors.length === 0;
  return { ok, errors, ignored, snapshot: ok ? out : null };
}

/* ───────────────────────────── creating an organization ───────────────────────────── */

// The demo trio. Planted ONLY for a profile that names no owner — the
// built-in verticals, which want a walkable demo. These credentials are
// public (the README prints them), which is why a deployment provisioned
// through the control plane must name an owner instead (requireOwner).
export const DEMO_ACCOUNTS = {
  superadmin: { email: "admin@demo.test", pin: "123456" },
  staff: { email: "staff@demo.test", pin: "654321" },
  member: { email: "member@demo.test", pin: "111111", card: "DEADBEEF" },
};

/**
 * Best-effort removal of an organization this call created, used only
 * when creation fails part-way. Everything here is scoped to an id that
 * was minted moments ago by this module, never to one a caller supplied.
 */
async function discardPartial(organizationId) {
  const organization = organizationId;
  const sites = await Site.find({ organization }).distinct("_id");
  await Promise.all([
    User.deleteMany({ organization }),
    Resource.deleteMany({ organization }),
    Zone.deleteMany({ organization }),
    Label.deleteMany({ organization }),
    Room.deleteMany({ organization }),
    ResourceType.deleteMany({ organization }),
    Floor.deleteMany({ site: { $in: sites } }),
  ]);
  await Building.deleteMany({ organization });
  await Site.deleteMany({ organization });
  await Organization.deleteOne({ _id: organization });
}

/**
 * Creates one organization from a profile.
 *
 * @param {object} input  the profile. A buyer's (portal export, control
 *                        plane) is validated by importProfile.js and
 *                        sanitised before anything is written; a built-in
 *                        vertical from profiles.js is our own data.
 * @param {object} [o]
 * @param {string} [o.slug]          the address; derived from the name when absent
 * @param {object} [o.entitlements]  a snapshot already read by readEntitlementSnapshot
 * @param {object} [o.source]        { orderId } — the order this deployment is for
 * @param {boolean} [o.builtIn]      `input` is one of profiles.js's verticals
 * @param {boolean} [o.requireOwner] refuse a profile with no owner (the API sets it)
 *
 * @returns {{ organization, slug, owner: {email, firstName, lastName, temporaryPin}|null,
 *             demoAccounts: boolean, profile, summaries, warnings, deploymentUrl }}
 */
export async function provisionFromProfile(input, { slug: requested, entitlements = null, source = null, builtIn = false, requireOwner = false } = {}) {
  // ---- 1. the profile ----
  let profile = input;
  let warnings = [];
  if (!builtIn) {
    const result = validateProfile(input);
    if (!result.ok) {
      throw new ProvisioningError(`This profile can't be provisioned — ${result.errors.length} field(s) need fixing.`, {
        status: 400,
        code: "INVALID_PROFILE",
        fields: result.errors,
        warnings: result.warnings,
      });
    }
    profile = result.profile;
    warnings = result.warnings;
  }

  if (requireOwner && !profile.owner) {
    // Without an owner the seeder plants the demo trio, whose PINs are
    // published in the README. Over the control plane that would hand a
    // paying customer's deployment to anyone who has read it.
    throw new ProvisioningError("A deployment provisioned for a customer must name its owner.", {
      status: 400,
      code: "INVALID_PROFILE",
      fields: [{ field: "owner", message: "is required: the founding superadmin's firstName, lastName and email" }],
    });
  }

  // ---- 2. the address ----
  let slug;
  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    slug = String(requested).trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) {
      throw new ProvisioningError(problem, {
        status: 400,
        code: "INVALID_SLUG",
        fields: [{ field: "slug", message: problem }],
        suggestion: await availableSlug(slug),
      });
    }
    if (await Organization.exists({ slug })) throw await slugTaken(slug);
  } else {
    slug = await availableSlug(profile.organizationName);
  }

  // ---- 3. one order, one deployment ----
  // A control-plane call that timed out on the vendor's side may have
  // succeeded here. Answering a retry with a SECOND organization would
  // leave a buyer with two deployments and a founder email for each.
  const orderId = source?.orderId ? String(source.orderId) : null;
  if (orderId) {
    const existing = await Organization.findOne({ "provisioning.orderId": orderId }).select("_id slug").lean();
    if (existing) throw alreadyProvisioned(existing);
  }

  // ---- 4. the organization itself ----
  let org;
  try {
    org = await Organization.create({
      name: profile.organizationName,
      slug,
      branding: profile.branding,
      terminology: profile.terminology,
      identity: profile.identity,
      policy: profile.policy,
      termsOfServiceText: profile.termsText, // AUTH-3 (spec §16 — content config)
      ...(entitlements ? { entitlements: { ...entitlements, syncedAt: new Date() } } : {}),
      ...(orderId ? { provisioning: { orderId, provisionedAt: new Date() } } : {}),
    });
  } catch (err) {
    // The unique indexes are the real guarantee against a race between
    // two provisions; the checks above only make the usual case readable.
    if (err?.code === 11000 && (err.keyPattern?.slug || err.keyValue?.slug)) throw await slugTaken(slug);
    if (err?.code === 11000 && orderId) {
      const existing = await Organization.findOne({ "provisioning.orderId": orderId }).select("_id slug").lean();
      if (existing) throw alreadyProvisioned(existing);
    }
    throw err;
  }

  // From here a failure leaves an organization that owns an address and
  // may own accounts, so it is undone rather than left half-built.
  try {
    const site = await Site.create({ organization: org._id, name: profile.siteName });
    const building = await Building.create({
      organization: org._id,
      site: site._id,
      name: profile.buildingName || "Main Building",
    });

    // The vendor-configured catalog for this vertical (CAT-1, spec §8).
    await ResourceType.insertMany(profile.catalog.map((type) => ({ organization: org._id, ...type })));

    // Floors first; seedFloorLayouts() then fills each one matched by order.
    await Floor.insertMany(
      profile.floors.map((f) => ({ site: site._id, building: building._id, name: f.name, order: f.order, grid: f.grid }))
    );

    const owner = profile.owner ? await createOwner(org, profile.owner) : null;
    if (!owner) await plantDemoAccounts(org, profile);

    // seedFloorLayouts() resolves its profile BY KEY, and a buyer's
    // profile is not one of profiles.js's. It is registered under a key
    // unique to this organization and removed again afterwards: this
    // runs inside a long-lived API process, and two buyers whose names
    // slugify to the same profile key would otherwise race, each laying
    // out the other's floors.
    let layoutKey = profile.key;
    if (!builtIn) layoutKey = registerProfile({ ...profile, key: `provision:${org._id}` });
    let summaries;
    try {
      ({ summaries } = await seedFloorLayouts(org, layoutKey));
    } finally {
      if (!builtIn) delete VERTICAL_PROFILES[layoutKey];
    }

    const deploymentUrl = organizationUrl(org);

    // Sent last, once nothing else can fail: a welcome for an
    // organization that was then rolled back would be worse than none.
    // Fire-and-forget (spec §15), which is why the caller also gets the
    // PIN back — the CLI prints it and the API returns it once.
    if (owner) sendEmail(founderWelcomeEmail({ org, user: owner.user, temporaryPin: owner.temporaryPin, deploymentUrl }));

    return {
      organization: org,
      slug,
      owner: owner
        ? { email: owner.user.email, firstName: owner.user.firstName, lastName: owner.user.lastName, temporaryPin: owner.temporaryPin }
        : null,
      demoAccounts: !owner,
      profile,
      summaries,
      warnings,
      deploymentUrl,
    };
  } catch (err) {
    await discardPartial(org._id).catch((cleanupErr) =>
      console.error(`[provisioning] could not roll back organization ${org._id}:`, cleanupErr.message)
    );
    throw err;
  }
}

function alreadyProvisioned(existing) {
  return new ProvisioningError("This order already has a deployment.", {
    status: 409,
    code: "ALREADY_PROVISIONED",
    organizationId: String(existing._id),
    slug: existing.slug || null,
  });
}

/**
 * The founding superadmin: that person, holding a random temporary PIN
 * from the same generator AUTH-4 and ADM-4 use, forced to change it and
 * to accept the terms on first sign-in.
 */
async function createOwner(org, owner) {
  const temporaryPin = generateVerificationCode();
  const user = await User.create({
    organization: org._id,
    role: "superadmin",
    firstName: owner.firstName,
    lastName: owner.lastName,
    email: owner.email.toLowerCase(),
    pinHash: await bcrypt.hash(temporaryPin, 10),
    verified: true, // provisioned by us, not self-registered at a kiosk
    mustChangePin: true, // forced change on first sign-in
    termsAcceptedAt: null, // AUTH-3 still applies — it is theirs to accept
  });
  return { user, temporaryPin };
}

/**
 * The walkable demo: a superadmin who has accepted the terms, a staff
 * account that has not (so AUTH-3's gate is demonstrable), and a
 * card-bound member for the kiosk. Only for a profile with no owner.
 */
async function plantDemoAccounts(org, profile) {
  await User.create({
    organization: org._id,
    role: "superadmin",
    firstName: "Demo",
    lastName: "Admin",
    email: DEMO_ACCOUNTS.superadmin.email,
    pinHash: await bcrypt.hash(DEMO_ACCOUNTS.superadmin.pin, 10),
    verified: true,
    termsAcceptedAt: new Date(),
  });

  // Staff are email-provisioned with no card and no kiosk tap (spec §6),
  // and land on the terms gate at first login (AUTH-3).
  await User.create({
    organization: org._id,
    role: "staff",
    firstName: "Demo",
    lastName: "Staff",
    email: DEMO_ACCOUNTS.staff.email,
    pinHash: await bcrypt.hash(DEMO_ACCOUNTS.staff.pin, 10),
    verified: true,
    termsAcceptedAt: null,
  });

  // Member IDs are org-configurable (spec §4), so derive one from THIS
  // profile's pattern rather than hardcoding a library-shaped id. The
  // card UID must be hex — the normaliser rejects anything else.
  await User.create({
    organization: org._id,
    role: "member",
    firstName: "Demo",
    lastName: "Member",
    email: DEMO_ACCOUNTS.member.email,
    memberId: memberIdExample(profile.identity.memberIdFormat),
    cardUid: normalizeCardUid(DEMO_ACCOUNTS.member.card),
    pinHash: await bcrypt.hash(DEMO_ACCOUNTS.member.pin, 10),
    verified: true,
    termsAcceptedAt: new Date(),
  });
}
