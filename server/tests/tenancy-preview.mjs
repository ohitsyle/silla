/**
 * Two organizations side by side, for walking the client's tenancy in a
 * browser: organization addresses, per-organization sessions, the plan
 * page, limits and a paused organization (docs/control-plane.md §1–2).
 *
 *   node tests/tenancy-preview.mjs                    serve on :4012 (Ctrl-C to stop)
 *   node tests/tenancy-preview.mjs --port=4020        …on another port
 *   node tests/tenancy-preview.mjs --plan=suspended   push a plan state to a RUNNING
 *        [--port=4020]                                preview, signed the way the
 *                                                     control plane signs it
 *
 * --plan takes trialing, active, past_due, suspended or cancelled. Then
 * point the client at it, as the summary prints:
 *
 *   cd client && VITE_API_URL=http://127.0.0.1:4012 VITE_DEMO_ORG_ID=<id> npx vite --port 5180
 *
 * What it serves:
 *
 *   /demo-library  `npm run seed` exactly: the library demo with its demo
 *                  trio, UNMANAGED — no plan, every feature, no limits.
 *                  It is the default organization, so /map and /kiosk
 *                  redirect here.
 *   /harborview    provisioned the way a customer's order is, through
 *                  services/provisioning.js: the office vertical under a
 *                  buyer's name, with a founding owner who must change
 *                  their temporary PIN and accept the terms, and a
 *                  MANAGED plan — two staff accounts (both in use), and
 *                  no reports, kiosk or custom branding.
 *
 * Disposable like test:isolated: an in-memory replica set, no .env, no
 * mail (codes print to this console, and the API returns them in dev),
 * nothing kept after Ctrl-C. Operating hours are widened to the whole
 * day in both organizations so kiosk check-in can be walked at any hour.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length)) || 4012;
const PLAN_STATE = process.argv.find((arg) => arg.startsWith("--plan="))?.slice("--plan=".length);
const OUT = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);

/** Exists only for this throwaway database, like the one in isolated.mjs. */
const CONTROL_PLANE_SECRET = "tenancy-preview-control-plane-secret-not-for-real-use";
const CLIENT_URL = process.env.PREVIEW_CLIENT_URL || "http://localhost:5180";
const DAY = 86_400_000;

/**
 * Harborview's plan, in each state the control plane can push. Limits are
 * set so the client has something to show: both staff places are taken,
 * and reports, the kiosk and custom colours are not included.
 */
function harborviewPlan(status = "active") {
  const now = Date.now();
  // Dates as the control plane would leave them: an overdue period has
  // already ended and its grace is running; a paused one's grace is over.
  const periodEnd = { trialing: 9, active: 18, past_due: -2, suspended: -9, cancelled: -30 }[status] ?? 18;
  const graceEnd = { past_due: 5, suspended: -2 }[status];
  return {
    managed: true,
    plan: "team",
    planName: "Team",
    status,
    features: { kiosk: false, reports: false, customBranding: false, wholeRoomBooking: true, emailReminders: true },
    limits: { buildings: 1, floors: 3, rooms: 6, resources: 80, members: 40, staff: 2 },
    currentPeriodEnd: new Date(now + periodEnd * DAY).toISOString(),
    graceEndsAt: graceEnd === undefined ? null : new Date(now + graceEnd * DAY).toISOString(),
    notice: {
      past_due: "Your October invoice is overdue. Pay by bank transfer or GCash and reply to the invoice email, and we'll confirm it the same day.",
      suspended: "Paused for an unpaid invoice. Everything is kept — pay it and Harborview reopens within the hour.",
      cancelled: null,
    }[status] ?? null,
    version: now,
  };
}

/* ───────────────────── --plan: push a state to a running preview ───────────────────── */

if (PLAN_STATE) {
  const base = `http://127.0.0.1:${PORT}`;
  const org = await (await fetch(`${base}/api/organizations/by-slug/harborview/config`)).json();
  if (!org?._id) throw new Error(`No preview answering on ${base}`);
  // Signed exactly as vendor/src/lib/controlPlane.js signs (docs/control-plane.md §3).
  const path = `/api/internal/organizations/${org._id}/entitlements?n=${Date.now()}`;
  const body = JSON.stringify(harborviewPlan(PLAN_STATE));
  const t = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const sig = crypto.createHmac("sha256", CONTROL_PLANE_SECRET).update(`${t}\nPUT\n${path}\n${hash}`).digest("hex");
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `SILLA-HMAC t=${t},sig=${sig}` },
    body,
  });
  console.log(`harborview → ${PLAN_STATE}: ${res.status}`, JSON.stringify(await res.json()).slice(0, 200));
  process.exit(res.ok ? 0 : 1);
}

/* ───────────────────────────── serve ───────────────────────────── */

const { MongoMemoryReplSet } = await import("mongodb-memory-server");
const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });

const env = {
  ...process.env,
  DOTENV_CONFIG_PATH: "/dev/null",
  MONGO_URI: replica.getUri(),
  JWT_SECRET: "tenancy-preview-only",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  EMAIL_API_KEY: "",
  CORS_ORIGINS: "",
  NODE_ENV: "development",
  CONTROL_PLANE_SECRET,
  APP_URL: CLIENT_URL,
  TRUST_PROXY_HOPS: "0",
};
// Before any service module loads: the email transport is chosen at import.
Object.assign(process.env, env);

let server;
let io;
const stop = async () => {
  if (io) await new Promise((resolve) => io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
  const { default: mongoose } = await import("mongoose");
  await mongoose.disconnect().catch(() => {});
  await replica.stop();
};

try {
  // 1. The demo, exactly as `npm run seed` makes it.
  const seed = spawn(process.execPath, ["src/scripts/seed.js"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let seedOutput = "";
  seed.stdout.on("data", (d) => (seedOutput += d));
  seed.stderr.on("data", (d) => (seedOutput += d));
  const [seedCode] = await once(seed, "exit");
  if (seedCode) throw new Error(`Seeding failed:\n${seedOutput}`);
  const demoId = seedOutput.match(/organizationId:\s*([a-f0-9]{24})/i)?.[1];
  const demoSlug = seedOutput.match(/address:\s*\/([a-z0-9-]+)/)?.[1];
  if (!demoId || !demoSlug) throw new Error(`The seeder did not report its organization:\n${seedOutput}`);

  // 2. A customer, provisioned the way the control plane provisions one.
  const { default: mongoose } = await import("mongoose");
  await mongoose.connect(env.MONGO_URI);
  const bcrypt = (await import("bcryptjs")).default;
  const { default: Organization } = await import("../src/models/Organization.js");
  const { default: User } = await import("../src/models/User.js");
  const { getProfile } = await import("../src/scripts/profiles.js");
  const { provisionFromProfile, readEntitlementSnapshot } = await import("../src/services/provisioning.js");

  const { snapshot } = readEntitlementSnapshot(harborviewPlan("active"));
  const harborview = await provisionFromProfile(
    {
      ...getProfile("office"),
      key: "harborview-work-commons",
      label: "Harborview Work Commons",
      organizationName: "Harborview Work Commons",
      siteName: "Harborview Pier 4",
      owner: { firstName: "Rosa", lastName: "Marin", email: "rosa@harborview.test" },
    },
    { slug: "harborview", entitlements: snapshot }
  );
  const harborviewId = harborview.organization._id;

  // The owner is the first staff place; this is the second, so the plan's
  // two are both in use. And a member, to see the product as one.
  const people = {
    staff: { email: "sam@harborview.test", pin: "333333" },
    member: { email: "ellis@harborview.test", pin: "222222", card: "C0FFEE01" },
  };
  await User.create({
    organization: harborviewId, role: "staff", firstName: "Sam", lastName: "Okafor", email: people.staff.email,
    pinHash: await bcrypt.hash(people.staff.pin, 10), verified: true, termsAcceptedAt: new Date(),
  });
  await User.create({
    organization: harborviewId, role: "member", firstName: "Ellis", lastName: "Park", email: people.member.email,
    memberId: "EMP-00042", cardUid: people.member.card,
    pinHash: await bcrypt.hash(people.member.pin, 10), verified: true, termsAcceptedAt: new Date(),
  });

  // Whole-day hours, so the kiosk's walk-in check-in works at any hour.
  await Organization.updateMany({}, { $set: { "policy.operatingHours": { open: "00:00", close: "23:59" } } });

  // 3. The API, with Socket.io, the way server.js runs it.
  const { Server } = await import("socket.io");
  const { createApp } = await import("../src/app.js");
  const app = createApp();
  server = http.createServer(app);
  io = new Server(server, { cors: { origin: true } });
  app.set("io", io);
  io.on("connection", (socket) => socket.on("floor:join", (id) => socket.join(`floor:${id}`)));
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const api = `http://127.0.0.1:${PORT}`;
  const fixture = {
    api,
    demo: { id: demoId, slug: demoSlug },
    harborview: {
      id: String(harborviewId),
      slug: harborview.slug,
      owner: { email: harborview.owner.email, temporaryPin: harborview.owner.temporaryPin },
      ...people,
    },
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(fixture, null, 2));

  console.log(`
Tenancy preview on ${api} — a disposable database; nothing reaches Atlas or sends mail.

  cd client && VITE_API_URL=${api} VITE_DEMO_ORG_ID=${demoId} npx vite --port 5180

  /${demoSlug}  (default — /map and /kiosk redirect here) unmanaged, no plan limits
      admin@demo.test / 123456   staff@demo.test / 654321 (terms gate)
      member@demo.test / 111111, card DEADBEEF

  /${harborview.slug}  managed "Team" plan: 2 of 2 staff, no reports, kiosk or custom colours
      owner ${harborview.owner.email} / temporary PIN ${harborview.owner.temporaryPin} (must change it, then the terms)
      staff ${people.staff.email} / ${people.staff.pin}
      member ${people.member.email} / ${people.member.pin}, card ${people.member.card}

  Change Harborview's plan state while this runs:
      node tests/tenancy-preview.mjs --port=${PORT} --plan=past_due|suspended|cancelled|active|trialing

  Ctrl-C to stop; the database is discarded.
`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await stop();
}
