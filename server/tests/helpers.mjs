/**
 * Shared helpers for the API test suite.
 *
 * These run against a RUNNING server and the configured database, which
 * is deliberate: the things most worth testing here are the atomic claim
 * under real concurrency, the org-scoped unique indexes, and the
 * role gates — all of which are properties of the real stack, not of a
 * mocked one.
 *
 * Every suite is idempotent. Accounts are created under @test.silla so
 * `cleanup()` can remove exactly what the tests made and nothing else.
 */
export const API = process.env.TEST_API_URL || "http://localhost:4000";
export const ORG = process.env.TEST_ORG_ID || "6a8ed2b8587f249ffe338781";

export const TEST_EMAIL_DOMAIN = "@test.silla";

export async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Random hex card UID — must be hex, the normaliser rejects anything else. */
export const uid = () =>
  Array.from({ length: 8 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");

export const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

export async function login(email, pin) {
  const r = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ organizationId: ORG, email, pin }),
  });
  return r.body;
}

/** Registers and verifies a member, returning credentials plus a token. */
export async function makeMember(tag, pin = "111111") {
  const card = uid();
  const email = `${tag}-${unique()}${TEST_EMAIL_DOMAIN}`;
  const memberId = `2099-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

  // Created directly, not through the kiosk flow.
  //
  // It used to register over HTTP and read `devVerificationCode` out of
  // the response — which meant the ENTIRE suite silently required email
  // to be unconfigured. The moment a real provider was set up, that
  // field disappeared (by design) and 26 checks failed for reasons that
  // had nothing to do with what they were testing.
  //
  // Making a member is setup, not the thing under test. ID-2 and AUTH-4
  // still exercise the real code path; everything else just needs a
  // member to exist.
  const mongoose = (await import("mongoose")).default;
  if (mongoose.connection.readyState !== 1) {
    const { connectDB } = await import("../src/config/db.js");
    await connectDB();
  }
  const bcrypt = (await import("bcryptjs")).default;
  const User = (await import("../src/models/User.js")).default;
  const { normalizeCardUid } = await import("../src/services/checkin/rfid.js");

  const created = await User.create({
    organization: ORG,
    role: "member",
    firstName: tag,
    lastName: "Test",
    email,
    memberId,
    cardUid: normalizeCardUid(card),
    pinHash: await bcrypt.hash(pin, 10),
    verified: true,
    // Left pending, exactly as kiosk registration leaves it. AUTH-3
    // asserts a member can accept their own terms, and pre-accepting
    // here quietly removed the thing that test was testing.
    termsAcceptedAt: null,
  });

  const session = await login(email, pin);
  return { token: session.token, id: created._id.toString(), card, email, memberId, pin };
}

/**
 * Marks a pending registration verified without the code.
 *
 * Used only when a real provider carries the code and no test can read
 * an inbox. It substitutes for the ONE step that cannot be asserted, so
 * the checks after it — card resolution, sign-in — still test the real
 * thing instead of being skipped along with it.
 */
export async function verifyOutOfBand(registrationId) {
  const mongoose = (await import("mongoose")).default;
  if (mongoose.connection.readyState !== 1) {
    const { connectDB } = await import("../src/config/db.js");
    await connectDB();
  }
  const User = (await import("../src/models/User.js")).default;
  await User.updateOne(
    { _id: registrationId },
    { verified: true, verificationCode: null, verificationExpiresAt: null }
  );
}

/** True when a real mail provider is configured, so the dev code is gone. */
export async function emailIsLive() {
  const mod = await import("../src/services/email/index.js");
  return Boolean(mod.emailConfigured);
}

/**
 * A booking window on a day unique to this run, so repeated runs never
 * collide with each other's leftover holds.
 */
const RUN_DAY = 2 + (Math.floor(Date.now() / 1000) % 40);
export function window(offsetHours = 0, lengthHours = 2, dayOffset = RUN_DAY) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(10 + offsetHours, 0, 0, 0);
  return {
    startTime: d.toISOString(),
    endTime: new Date(d.getTime() + lengthHours * 3600_000).toISOString(),
  };
}

/** Superadmin token, used by suites that need to change org settings. */
export async function adminToken() {
  const s = await login("admin@demo.test", "123456");
  if (!s?.token) throw new Error(`admin login failed: ${JSON.stringify(s)}`);
  return s.token;
}

/**
 * Widens operating hours for "right now" scenarios and returns a restore
 * function. Check-in and walk-in are time-of-day sensitive by design, so
 * a suite run in the evening would otherwise fail on correct behaviour.
 */
export async function withOpenHours(token) {
  const before = (await req("/api/admin/settings", { headers: auth(token) })).body?.organization?.policy
    ?.operatingHours;
  await req("/api/admin/settings", {
    method: "PATCH",
    headers: auth(token),
    body: JSON.stringify({ policy: { operatingHours: { open: "00:00", close: "23:59" } } }),
  });
  return async () => {
    if (before) {
      await req("/api/admin/settings", {
        method: "PATCH",
        headers: auth(token),
        body: JSON.stringify({ policy: { operatingHours: before } }),
      });
    }
  };
}

export async function firstFloor() {
  const { body } = await req(`/api/floors?organizationId=${ORG}`);
  return body.floors[0];
}

export async function layoutOf(floorId) {
  return (await req(`/api/floors/${floorId}/layout`)).body;
}

/** Available units on a floor, as {resourceId, unitLabel}. */
export function availableUnits(layout) {
  return layout.layout.resources.flatMap((r) =>
    r.units
      .map((u, i) => ({ resourceId: r.id, unitLabel: u.label, status: layout.status[r.id][i] }))
      .filter((u) => u.status.status === "available")
  );
}

/**
 * A floor belonging to a DIFFERENT organization, for isolation checks.
 *
 * Built directly through the models because there is no API to create an
 * organization — provisioning is a seeder/portal job, not an endpoint.
 * The org is named with the @test.silla marker so the normal cleanup
 * sweep removes it along with everything else the suites make.
 *
 * The point it exists to defend: floors hang off sites and sites carry
 * the organization, so a bare Floor.findById LOOKS org-scoped and is
 * not. Three structural write endpoints once trusted a client-supplied
 * floorId that way, which let one deployment's superadmin write onto
 * another deployment's map.
 */
export async function foreignFloor() {
  const mongoose = (await import("mongoose")).default;
  if (mongoose.connection.readyState !== 1) {
    const { connectDB } = await import("../src/config/db.js");
    await connectDB();
  }
  const Organization = (await import("../src/models/Organization.js")).default;
  const Site = (await import("../src/models/Site.js")).default;
  const Floor = (await import("../src/models/Floor.js")).default;

  const org = await Organization.create({ name: `isolation-probe-${unique()}${TEST_EMAIL_DOMAIN}` });
  const site = await Site.create({ organization: org._id, name: "Probe Site" });
  const floor = await Floor.create({
    site: site._id,
    name: "Probe Level",
    order: 0,
    grid: { cols: 10, rows: 10 },
  });
  return { orgId: org._id.toString(), floorId: floor._id.toString() };
}
