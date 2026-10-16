/**
 * Platform — the control-plane API, provisioning, plans and tenancy
 * (docs/control-plane.md §1–3).
 *
 * Everything here goes through the real HTTP surface: signatures are made
 * the way vendor/src/lib/controlPlane.js makes them, organizations are
 * provisioned by POST /api/internal/organizations, plans are pushed by
 * PUT .../entitlements, and enforcement is observed from the outside as a
 * customer's administrator would meet it.
 *
 * Needs CONTROL_PLANE_SECRET in the test environment (npm run
 * test:isolated sets one). Without it every check SKIPs rather than
 * reporting a pass for something that never ran.
 *
 * Self-cleaning: every organization provisioned here is removed at the
 * end, with everything under it. No reservations are made, so nothing
 * here depends on the time of day.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ORG, TEST_EMAIL_DOMAIN, auth, req, uid, unique } from "./helpers.mjs";

export const name = "platform";

const SECRET = process.env.CONTROL_PLANE_SECRET || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");

/** The signer, written out independently of both services: the contract, not either copy of it. */
function signature(method, path, body = "", { t = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const sig = crypto.createHmac("sha256", secret).update(`${t}\n${method}\n${path}\n${hash}`).digest("hex");
  return `SILLA-HMAC t=${t},sig=${sig}`;
}

/**
 * A signed call. Every request is made unique with a counter in the query
 * string, which is signed along with the rest of the path.
 *
 * That is not decoration. The signature covers only the second, the
 * method, the path and the body, and the server accepts each signature
 * ONCE — so two identical requests inside the same second (the same GET
 * twice, say) carry the same signature and the second is refused as a
 * replay. A real caller must make each request distinct the same way.
 */
let sequence = 0;
async function internal(method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const unique = `${path}${path.includes("?") ? "&" : "?"}n=${process.pid}-${(sequence += 1)}`;
  return req(unique, { method, headers: { Authorization: signature(method, unique, payload) }, ...(payload ? { body: payload } : {}) });
}

function profileFor(tag, { owner = true } = {}) {
  return {
    key: `platform-${tag}`,
    label: "Platform probe",
    organizationName: `Platform Probe ${tag}`,
    siteName: "Probe Site",
    ...(owner ? { owner: { firstName: "Pat", lastName: "Owner", email: `owner-${tag}${TEST_EMAIL_DOMAIN}` } } : {}),
    branding: {
      primaryColor: "#0F766E",
      accentTextColor: "#FFFFFF",
      surface: { page: "#0B1215", pageEnd: "#0E171B", card: "#111C21", panel: "#16242A", line: "#E6F0EE" },
      ink: { primary: "#E6F0EE", secondary: "#9DB3AE", muted: "#6B827D" },
    },
    terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Office" },
    identity: { memberIdFormat: "T-####", checkInMethod: "rfid", selfServiceRegistration: true },
    policy: {
      gracePeriodMinutes: 10,
      maxStayHours: 4,
      pinLockoutThreshold: 5,
      verificationCodeExpiryMinutes: 10,
      operatingHours: { open: "08:00", close: "18:00" },
    },
    catalog: [{ key: "desk", label: "Desk", footprint: { w: 1, h: 1 }, seatCount: 1, icon: "Monitor" }],
    floors: [
      {
        name: "Ground",
        order: 0,
        grid: { cols: 10, rows: 8 },
        resources: [
          { type: "desk", position: { col: 1, row: 1 } },
          { type: "desk", position: { col: 3, row: 1 } },
        ],
      },
    ],
    termsText: "Be kind to the desks.",
  };
}

/** A complete snapshot in the shape vendor/src/services/billing.js snapshotFor() builds. */
function snapshot(version, { status = "active", features = {}, limits = {}, ...rest } = {}) {
  return {
    managed: true,
    plan: "room",
    planName: "One Room",
    status,
    features: { kiosk: true, reports: true, customBranding: true, wholeRoomBooking: true, emailReminders: true, ...features },
    limits: { buildings: null, floors: null, rooms: null, resources: null, members: null, staff: null, ...limits },
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    graceEndsAt: null,
    notice: null,
    version,
    ...rest,
  };
}

const login = (organizationId, email, pin) =>
  req("/api/auth/login", { method: "POST", body: JSON.stringify({ organizationId, email, pin }) });

export async function run(check) {
  if (SECRET.length < 32) {
    check("CP-1", "control-plane checks need CONTROL_PLANE_SECRET (npm run test:isolated sets one)", "skip");
    return;
  }

  const provisioned = [];
  const tag = unique();
  let version = Date.now();
  const nextVersion = () => (version += 1000);

  try {
    /* ───────────── the signature ───────────── */

    const ping = "/api/internal/ping";
    check("CP-1", "a signed request is accepted", (await internal("GET", ping)).status === 200);
    check("CP-1", "no signature → 401", (await req(ping)).status === 401);
    check(
      "CP-1",
      "a malformed signature → 401",
      (await req(ping, { headers: { Authorization: "SILLA-HMAC t=yesterday,sig=nope" } })).status === 401
    );
    check(
      "CP-1",
      "a user's bearer token is not a signature → 401",
      (await req(ping, { headers: { Authorization: "Bearer not-a-control-plane-credential" } })).status === 401
    );
    check(
      "CP-1",
      "a signature made with the wrong secret → 401",
      (await req(ping, { headers: { Authorization: signature("GET", ping, "", { secret: "x".repeat(48) }) } })).status === 401
    );
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    check(
      "CP-1",
      "a ten-minute-old signature → 401",
      (await req(ping, { headers: { Authorization: signature("GET", ping, "", { t: stale }) } })).status === 401
    );
    const replayPath = `${ping}?replay=${tag}`;
    const once1 = signature("GET", replayPath);
    const first = await req(replayPath, { headers: { Authorization: once1 } });
    const replay = await req(replayPath, { headers: { Authorization: once1 } });
    check("CP-1", "a replayed signature → 401 (each is accepted once)", first.status === 200 && replay.status === 401, `${first.status} then ${replay.status}`);
    const body = JSON.stringify({ email: "someone-else@test.silla" });
    const tampered = await req(`/api/internal/organizations/${ORG}/owner-access`, {
      method: "POST",
      headers: { Authorization: signature("POST", `/api/internal/organizations/${ORG}/owner-access`, "{}") },
      body,
    });
    check("CP-1", "a body that differs from the one signed → 401", tampered.status === 401);

    // With no secret configured the API must refuse, never fall open. A
    // second app instance in THIS process, so the running server's secret
    // is untouched; nothing on this path reaches the database.
    {
      const { createApp } = await import("../src/app.js");
      const server = http.createServer(createApp());
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const saved = process.env.CONTROL_PLANE_SECRET;
      try {
        delete process.env.CONTROL_PLANE_SECRET;
        const unset = await fetch(base + ping, { headers: { Authorization: signature("GET", ping) } });
        process.env.CONTROL_PLANE_SECRET = "too-short";
        const short = await fetch(base + ping, { headers: { Authorization: signature("GET", ping) } });
        check("CP-1", "secret unset → 503, not open", unset.status === 503, `got ${unset.status}`);
        check("CP-1", "secret shorter than 32 characters → 503", short.status === 503, `got ${short.status}`);
      } finally {
        process.env.CONTROL_PLANE_SECRET = saved;
        await new Promise((resolve) => server.close(resolve));
      }
    }

    /* ───────────── addresses ───────────── */

    const demo = (await req(`/api/organizations/${ORG}/config`)).body;
    check("TEN-1", "npm run seed gave the demo organization an address", /^[a-z0-9-]{3,40}$/.test(demo?.slug || ""), demo?.slug);

    const takenSlug = await internal("GET", `/api/internal/slugs/${demo.slug}`);
    check(
      "TEN-1",
      "slug check: a taken address is refused with a free alternative",
      takenSlug.body.available === false && takenSlug.body.suggestion && takenSlug.body.suggestion !== demo.slug,
      JSON.stringify(takenSlug.body)
    );
    const reserved = await internal("GET", "/api/internal/slugs/login");
    check(
      "TEN-1",
      "slug check: a route the client owns can never be an address",
      reserved.body.available === false && /reserved/i.test(reserved.body.problem || ""),
      JSON.stringify(reserved.body)
    );
    const fresh = await internal("GET", `/api/internal/slugs/fresh-${tag}`);
    check("TEN-1", "slug check: an unused address is available", fresh.body.available === true && fresh.body.problem === null);

    /* ───────────── provisioning ───────────── */

    const slug = `platform-${tag}`;
    const v1 = nextVersion();
    const made = await internal("POST", "/api/internal/organizations", {
      profile: profileFor(tag),
      slug,
      entitlements: snapshot(v1),
      source: { orderId: `order-${tag}` },
    });
    if (made.body?.organizationId) provisioned.push(made.body.organizationId);
    const orgId = made.body?.organizationId;
    const owner = made.body?.owner;
    check(
      "CP-2",
      "provisioning answers 201 with the organization, its address and its owner",
      made.status === 201 && orgId && made.body.slug === slug && owner?.email === `owner-${tag}${TEST_EMAIL_DOMAIN}`,
      `${made.status} ${JSON.stringify(made.body).slice(0, 200)}`
    );
    check("CP-2", "the owner's temporary PIN comes back once, six digits", /^\d{6}$/.test(owner?.temporaryPin || ""));
    check(
      "CP-2",
      "the summary carries the layout the profile described",
      made.body?.summary?.units === 2 && made.body.summary.floors?.[0]?.name === "Ground",
      JSON.stringify(made.body?.summary)
    );
    check(
      "CP-2",
      "the founder's sign-in link is <APP_URL>/<slug>",
      !APP_URL || made.body?.summary?.deploymentUrl === `${APP_URL}/${slug}`,
      made.body?.summary?.deploymentUrl
    );

    const firstLogin = await login(orgId, owner?.email, owner?.temporaryPin);
    check(
      "CP-2",
      "the temporary PIN signs in, and must be changed first",
      firstLogin.status === 200 && firstLogin.body.user?.mustChangePin === true && firstLogin.body.user?.role === "superadmin",
      `${firstLogin.status} ${JSON.stringify(firstLogin.body?.user)}`
    );
    const changed = await req("/api/auth/change-pin", {
      method: "POST",
      headers: auth(firstLogin.body.token),
      body: JSON.stringify({ currentPin: owner?.temporaryPin, newPin: "246810" }),
    });
    const ownerSession = await login(orgId, owner?.email, "246810");
    check(
      "CP-2",
      "after the change the owner's own PIN works and the gate is gone",
      changed.status === 200 && ownerSession.status === 200 && ownerSession.body.user?.mustChangePin === false
    );
    const token = ownerSession.body.token;

    const bad = profileFor(`${tag}-bad`);
    delete bad.terminology.resourceNoun;
    bad.floors[0].grid.cols = 900;
    const refused = await internal("POST", "/api/internal/organizations", { profile: bad });
    const badFields = (refused.body?.fields || []).map((f) => f.field);
    check(
      "CP-2",
      "a bad profile → 400 naming every field to fix",
      refused.status === 400 && badFields.includes("terminology.resourceNoun") && badFields.includes("floors[0].grid.cols"),
      `${refused.status} ${badFields.join(", ")}`
    );
    const ownerless = await internal("POST", "/api/internal/organizations", { profile: profileFor(`${tag}-noowner`, { owner: false }) });
    check(
      "CP-2",
      "a customer deployment without an owner is refused (no demo accounts over the API)",
      ownerless.status === 400 && (ownerless.body?.fields || []).some((f) => f.field === "owner"),
      `${ownerless.status}`
    );
    const clash = await internal("POST", "/api/internal/organizations", { profile: profileFor(`${tag}-clash`), slug });
    if (clash.body?.organizationId) provisioned.push(clash.body.organizationId);
    const suggestion = clash.body?.suggestion;
    const suggestionFree = suggestion ? (await internal("GET", `/api/internal/slugs/${suggestion}`)).body.available : false;
    check(
      "CP-2",
      "a taken address → 409 SLUG_TAKEN with a free suggestion",
      clash.status === 409 && clash.body.code === "SLUG_TAKEN" && suggestion !== slug && suggestionFree === true,
      `${clash.status} ${JSON.stringify(clash.body)}`
    );
    const again = await internal("POST", "/api/internal/organizations", {
      profile: profileFor(`${tag}-again`),
      source: { orderId: `order-${tag}` },
    });
    if (again.body?.organizationId && again.status === 201) provisioned.push(again.body.organizationId);
    check(
      "CP-2",
      "a retried provisioning for the same order → 409, not a second deployment",
      again.status === 409 && again.body.code === "ALREADY_PROVISIONED" && again.body.organizationId === orgId,
      `${again.status} ${again.body?.code}`
    );

    /* ───────────── tenancy: config by address ───────────── */

    const bySlug = await req(`/api/organizations/by-slug/${slug}/config`);
    check(
      "TEN-1",
      "by-slug config resolves the address to the organization",
      bySlug.status === 200 && bySlug.body._id === orgId && bySlug.body.slug === slug && bySlug.body.terminology?.resourceNoun === "desk",
      `${bySlug.status}`
    );
    check(
      "TEN-1",
      "by-slug config carries the PUBLIC plan reading, not the stored snapshot",
      bySlug.body.entitlements?.managed === true && bySlug.body.entitlements.planName === "One Room" && bySlug.body.entitlements.version === undefined
    );
    check("TEN-1", "an unknown address → 404", (await req(`/api/organizations/by-slug/no-such-place-${tag}/config`)).status === 404);

    /* ───────────── the organization summary ───────────── */

    const summary = await internal("GET", `/api/internal/organizations/${orgId}`);
    check(
      "CP-3",
      "the summary reports the stored plan, live usage and the owners",
      summary.status === 200 &&
        summary.body.entitlements?.version === v1 &&
        summary.body.usage?.staff === 1 &&
        summary.body.usage?.resources === 2 &&
        summary.body.owners?.[0]?.email === owner.email &&
        summary.body.owners[0].mustChangePin === false &&
        summary.body.activity?.reservations30d === 0,
      JSON.stringify(summary.body).slice(0, 300)
    );
    check("CP-3", "an unknown organization → 404", (await internal("GET", "/api/internal/organizations/000000000000000000000000")).status === 404);

    /* ───────────── pushing entitlements ───────────── */

    const put = (snap) => internal("PUT", `/api/internal/organizations/${orgId}/entitlements`, snap);
    const v2 = nextVersion();
    const newer = await put(snapshot(v2, { features: { reports: false } }));
    check("CP-4", "a newer snapshot is applied", newer.status === 200 && !newer.body.ignored && newer.body.entitlements?.version === v2);
    const older = await put(snapshot(v1, { features: { reports: true } }));
    const equal = await put(snapshot(v2, { features: { reports: true } }));
    const stored = (await internal("GET", `/api/internal/organizations/${orgId}`)).body.entitlements;
    check(
      "CP-4",
      "an older or equal version arriving late is ignored, and says so",
      older.body.ignored === true && equal.body.ignored === true && stored.version === v2 && stored.features.reports === false,
      `${JSON.stringify(older.body.ignored)} ${JSON.stringify(equal.body.ignored)} v=${stored.version}`
    );
    const invalid = await put(snapshot(nextVersion(), { limits: { staff: -1 } }));
    check(
      "CP-4",
      "a snapshot with a bad value on a known key → 400 naming it",
      invalid.status === 400 && (invalid.body.fields || []).some((f) => f.field === "limits.staff"),
      `${invalid.status}`
    );
    const skewed = await put(snapshot(nextVersion(), { features: { reports: false, teleport: true } }));
    check(
      "CP-4",
      "an unknown key is dropped and reported, never a reason to refuse the push",
      skewed.status === 200 && (skewed.body.unknownKeys || []).includes("features.teleport") && skewed.body.entitlements.features.teleport === undefined
    );

    /* ───────────── enforcement ───────────── */

    const plan = (s) => put(snapshot(nextVersion(), s));
    const newStaff = (who) =>
      req("/api/admin/staff", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ firstName: "Sam", lastName: "Staff", email: `${who}-${tag}${TEST_EMAIL_DOMAIN}`, role: "staff" }),
      });

    await plan({ limits: { staff: 1 }, features: { reports: false } });
    const capped = await newStaff("capped");
    check(
      "PLAN-1",
      "staff limit: creating past it → 403 PLAN_LIMIT with the numbers",
      capped.status === 403 && capped.body.code === "PLAN_LIMIT" && capped.body.limit === "staff" && capped.body.max === 1 && capped.body.used === 1,
      `${capped.status} ${JSON.stringify(capped.body)}`
    );

    await plan({ limits: { staff: 2 }, features: { reports: false } });
    const hired = await newStaff("hired");
    check("PLAN-1", "raising the limit lets the same create through", hired.status === 201, `${hired.status}`);
    const hiredId = hired.body?.staff?.id;
    const off = await req(`/api/admin/staff/${hiredId}`, { method: "PATCH", headers: auth(token), body: JSON.stringify({ active: false }) });
    await plan({ limits: { staff: 1 }, features: { reports: false } });
    const back = await req(`/api/admin/staff/${hiredId}`, { method: "PATCH", headers: auth(token), body: JSON.stringify({ active: true }) });
    check(
      "PLAN-1",
      "reactivating an account past the limit is refused too (no deactivate/reactivate loophole)",
      off.status === 200 && back.status === 403 && back.body.code === "PLAN_LIMIT",
      `${off.status} then ${back.status}`
    );

    const reports = await req("/api/admin/reports", { headers: auth(token) });
    const exported = await req("/api/admin/export", { headers: auth(token) });
    check(
      "PLAN-2",
      "reports without the feature → 403 PLAN_FEATURE",
      reports.status === 403 && reports.body.code === "PLAN_FEATURE" && reports.body.feature === "reports",
      `${reports.status} ${JSON.stringify(reports.body)}`
    );
    check("PLAN-2", "the CSV export is the same feature → 403 PLAN_FEATURE", exported.status === 403 && exported.body.code === "PLAN_FEATURE");

    const planPage = await req("/api/admin/plan", { headers: auth(token) });
    const staffRow = (planPage.body?.limits || []).find((l) => l.key === "staff");
    const reportsRow = (planPage.body?.features || []).find((f) => f.key === "reports");
    check(
      "PLAN-3",
      "the plan page reports every limit with its usage, and every feature",
      planPage.status === 200 && staffRow?.max === 1 && staffRow.used === 1 && reportsRow?.included === false &&
        planPage.body.limits.length === 6 && planPage.body.features.length === 5,
      `${planPage.status} ${JSON.stringify(staffRow)} ${JSON.stringify(reportsRow)}`
    );

    const card = uid();
    await plan({ features: { kiosk: false, customBranding: false } });
    const tapOff = await req("/api/checkin/tap", { method: "POST", body: JSON.stringify({ organizationId: orgId, credential: card }) });
    const registerOff = await req("/api/registration/start", {
      method: "POST",
      body: JSON.stringify({
        organizationId: orgId, cardUid: card, memberId: "T-1234", firstName: "Kim", lastName: "Kiosk",
        email: `kiosk-${tag}${TEST_EMAIL_DOMAIN}`, pin: "135790",
      }),
    });
    check(
      "PLAN-4",
      "kiosk without the feature: the tap → 403 PLAN_FEATURE",
      tapOff.status === 403 && tapOff.body.code === "PLAN_FEATURE" && tapOff.body.feature === "kiosk",
      `${tapOff.status}`
    );
    check("PLAN-4", "kiosk without the feature: self-registration → 403 PLAN_FEATURE", registerOff.status === 403 && registerOff.body.code === "PLAN_FEATURE");

    const recolour = await req("/api/admin/settings", {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ branding: { primaryColor: "#FF0055" } }),
    });
    const sameColour = await req("/api/admin/settings", {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ branding: { primaryColor: "#0f766e" }, policy: { gracePeriodMinutes: 12 } }),
    });
    check(
      "PLAN-5",
      "custom branding without the feature: changing a colour → 403 PLAN_FEATURE",
      recolour.status === 403 && recolour.body.code === "PLAN_FEATURE" && recolour.body.feature === "customBranding",
      `${recolour.status}`
    );
    check(
      "PLAN-5",
      "…while saving settings that leave the colours as they are still works",
      sameColour.status === 200,
      `${sameColour.status} ${JSON.stringify(sameColour.body)}`
    );

    await plan({ limits: { members: 0 } });
    const tapFull = await req("/api/checkin/tap", { method: "POST", body: JSON.stringify({ organizationId: orgId, credential: card }) });
    const registerFull = await req("/api/registration/start", {
      method: "POST",
      body: JSON.stringify({
        organizationId: orgId, cardUid: card, memberId: "T-1234", firstName: "Kim", lastName: "Kiosk",
        email: `kiosk-${tag}${TEST_EMAIL_DOMAIN}`, pin: "135790",
      }),
    });
    check(
      "PLAN-6",
      "member limit: the kiosk is told at the tap that registration is closed",
      tapFull.status === 200 && tapFull.body.next === "register" && tapFull.body.registration?.open === false && tapFull.body.registration.code === "PLAN_LIMIT",
      `${tapFull.status} ${JSON.stringify(tapFull.body?.registration)}`
    );
    check(
      "PLAN-6",
      "member limit: registering past it → 403 PLAN_LIMIT",
      registerFull.status === 403 && registerFull.body.code === "PLAN_LIMIT" && registerFull.body.limit === "members",
      `${registerFull.status} ${JSON.stringify(registerFull.body)}`
    );

    /* ───────────── suspension: read-only ───────────── */

    await plan({ status: "suspended" });
    const suspendedLogin = await login(orgId, owner.email, "246810");
    const suspendedToken = suspendedLogin.body?.token;
    check("PLAN-7", "suspended: signing in still works", suspendedLogin.status === 200 && Boolean(suspendedToken));
    const reads = await Promise.all([
      req("/api/auth/me", { headers: auth(suspendedToken) }),
      req("/api/admin/plan", { headers: auth(suspendedToken) }),
      req("/api/admin/staff", { headers: auth(suspendedToken) }),
      req(`/api/organizations/by-slug/${slug}/config`),
    ]);
    check(
      "PLAN-7",
      "suspended: reads still work (me, plan, staff, config)",
      reads.every((r) => r.status === 200) && reads[1].body.operational === false && reads[3].body.entitlements.status === "suspended",
      reads.map((r) => r.status).join(",")
    );
    const writes = await Promise.all([
      newStaff("suspended"),
      req("/api/admin/settings", { method: "PATCH", headers: auth(suspendedToken), body: JSON.stringify({ policy: { gracePeriodMinutes: 15 } }) }),
      req("/api/checkin/tap", { method: "POST", body: JSON.stringify({ organizationId: orgId, credential: card }) }),
    ]);
    check(
      "PLAN-7",
      "suspended: every change → 403 ORG_SUSPENDED (staff, settings, kiosk tap)",
      writes.every((r) => r.status === 403 && r.body.code === "ORG_SUSPENDED"),
      writes.map((r) => `${r.status}/${r.body?.code}`).join(", ")
    );

    // Support can still restore an owner's access to a paused deployment:
    // the control plane is exempt from the read-only guard.
    const reissued = await internal("POST", `/api/internal/organizations/${orgId}/owner-access`, {});
    const oldPin = await login(orgId, owner.email, "246810");
    const newPin = await login(orgId, owner.email, reissued.body?.temporaryPin);
    check(
      "CP-5",
      "owner-access re-issues the founder's PIN: the old one stops working",
      reissued.status === 200 && reissued.body.email === owner.email && /^\d{6}$/.test(reissued.body.temporaryPin || "") && oldPin.status === 401,
      `${reissued.status} old=${oldPin.status}`
    );
    check(
      "CP-5",
      "…and the new temporary PIN signs in and must be changed (even while suspended)",
      newPin.status === 200 && newPin.body.user?.mustChangePin === true
    );
    const nobody = await internal("POST", `/api/internal/organizations/${orgId}/owner-access`, { email: `nobody-${tag}${TEST_EMAIL_DOMAIN}` });
    check("CP-5", "owner-access for an address that is not a superadmin → 404", nobody.status === 404);

    await plan({ status: "active" });
    const reopened = await newStaff("reopened");
    check("PLAN-7", "reinstated: changes work again", reopened.status === 201, `${reopened.status} ${reopened.body?.code}`);

    const demoAfter = (await req(`/api/organizations/${ORG}/config`)).body;
    check("PLAN-7", "the demo organization was never affected (unmanaged)", demoAfter.entitlements?.managed === false);

    /* ───────────── the slug migration ───────────── */

    if (process.env.SILLA_ISOLATED === "1") {
      await migrationChecks(check, tag, provisioned);
    } else {
      check("TEN-2", "migrate:slugs runs only against a disposable database (npm run test:isolated)", "skip");
    }
  } finally {
    await removeOrganizations(provisioned);
  }
}

/**
 * Two organizations with the same name and no address, as an
 * organization from before addresses existed would be: the dry run must
 * write nothing, --apply must give each a DIFFERENT valid address, and a
 * second --apply must change nothing.
 */
async function migrationChecks(check, tag, provisioned) {
  const { default: Organization } = await import("../src/models/Organization.js");
  await connected();
  const name = `Slugless Probe ${tag}`;
  const [a, b] = await Organization.create([{ name }, { name }]);
  provisioned.push(String(a._id), String(b._id));

  const script = (args) => spawnScript(["src/scripts/migrateSlugs.js", ...args]);
  await script([]);
  const afterDry = await Organization.find({ _id: { $in: [a._id, b._id] } }).lean();
  check("TEN-2", "migrate:slugs dry run writes nothing", afterDry.every((o) => !o.slug));

  await script(["--apply"]);
  const applied = await Organization.find({ _id: { $in: [a._id, b._id] } }).sort({ _id: 1 }).lean();
  const [sa, sb] = applied.map((o) => o.slug);
  check(
    "TEN-2",
    "migrate:slugs --apply gives each a unique address derived from its name",
    sa && sb && sa !== sb && sa.startsWith("slugless-probe") && sb.startsWith("slugless-probe"),
    `${sa} / ${sb}`
  );

  await script(["--apply"]);
  const twice = await Organization.find({ _id: { $in: [a._id, b._id] } }).sort({ _id: 1 }).lean();
  check("TEN-2", "migrate:slugs is idempotent — a second run changes nothing", twice[0].slug === sa && twice[1].slug === sb);
}

async function spawnScript(args) {
  const child = spawn(process.execPath, args, { cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const [code] = await once(child, "exit");
  if (code) throw new Error(`${args.join(" ")} failed:\n${output}`);
  return output;
}

async function connected() {
  const mongoose = (await import("mongoose")).default;
  if (mongoose.connection.readyState !== 1) {
    const { connectDB } = await import("../src/config/db.js");
    await connectDB();
  }
}

/** Everything under each organization this suite made, then the organization. */
async function removeOrganizations(ids) {
  if (!ids.length) return;
  await connected();
  const load = async (model) => (await import(`../src/models/${model}.js`)).default;
  const [Organization, Site, Building, Floor, Room, ResourceType, Resource, Zone, Label, User, Reservation, Closure] = await Promise.all(
    ["Organization", "Site", "Building", "Floor", "Room", "ResourceType", "Resource", "Zone", "Label", "User", "Reservation", "Closure"].map(load)
  );
  for (const organization of ids) {
    const sites = await Site.find({ organization }).distinct("_id");
    await Promise.all([
      Reservation.deleteMany({ organization }),
      Closure.deleteMany({ organization }),
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
}

