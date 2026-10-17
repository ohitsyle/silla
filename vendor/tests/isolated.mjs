/**
 * Runs the vendor suites against a DISPOSABLE database, not Atlas.
 *
 *   npm run test:isolated
 *
 * The plain `npm test` drives a running vendor connected to the shared
 * Atlas cluster — the same one production uses. This spins up a
 * throwaway replica set, starts the API in-process on a random port,
 * seeds one owner-level staff account, runs tests/run.mjs against it and
 * tears everything down. No .env is read and no mail is sent.
 *
 * It also starts a FAKE product API — the control plane's other end —
 * so provisioning, owner access and entitlement syncs run end to end
 * without a real deployment. The fake verifies every request's signature
 * with the same algorithm as server/src/lib/controlPlane.js (written out
 * again below, not imported: vendor/ never reaches into server/), and
 * answers the endpoints in docs/control-plane.md §3 with the documented
 * shapes. What it received is readable by the suites at
 * $FAKE_CONTROL_PLANE_URL/__received.
 *
 *   npm run test:isolated -- --serve      (VENDOR_PORT, default 4100)
 *
 * keeps the throwaway API (and the fake product API) running instead of
 * testing, for a browser walk: point the portal at it with
 * VITE_VENDOR_API_URL and allow the portal's origin with CORS_ORIGINS.
 * Stop it with Ctrl+C.
 *
 * To walk it against the REAL product instead of the fake — a disposable
 * one, such as server/tests/tenancy-preview.mjs — give --serve that
 * product's address and secret, and where its client is served:
 *
 *   SERVER_INTERNAL_URL=http://127.0.0.1:4040 CONTROL_PLANE_SECRET=<same as the product's> \
 *   PRODUCT_URL=http://localhost:5185 npm run test:isolated -- --serve
 *
 * Only --serve reads them. A test run always provisions against the fake.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import http from "node:http";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server;
let fake;

const STAFF_EMAIL = "owner@silla.test";
const STAFF_PASSWORD = "isolated-owner-passphrase";

// 32+ characters, like the real one must be. Shared by the vendor (which
// signs) and the fake product API (which verifies), and by nothing real.
const CONTROL_PLANE_SECRET = "isolated-control-plane-secret-for-tests-only";
const PRODUCT_URL = process.env.PRODUCT_URL || "http://localhost:5173";
const SERVING = process.argv.includes("--serve");
/** A --serve walk against a real product API, when given one with its secret. */
const SERVE_AGAINST_PRODUCT = SERVING && Boolean(process.env.SERVER_INTERNAL_URL && process.env.CONTROL_PLANE_SECRET);

/* ───────────────────────── the fake product API ───────────────────────── */

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Mirrors server/src/lib/slug.js closely enough to answer like it. */
const RESERVED = new Set(["login", "kiosk", "map", "admin", "editor", "terms", "change-pin", "api", "assets", "static",
  "silla", "www", "app", "help", "support", "billing", "status", "staff", "internal"]);
const slugProblem = (slug) =>
  !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || slug.includes("--")
    ? "Use 3–40 lowercase letters, numbers and hyphens, starting and ending with a letter or number."
    : RESERVED.has(slug)
      ? `"${slug}" is reserved. Choose another address.`
      : null;

const pin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

function startFakeControlPlane(secret) {
  const received = []; // every request, with whether its signature verified
  const issued = []; // every temporary PIN handed out, so a suite can look for leaks
  const orgs = new Map();
  const byOrder = new Map(); // source.orderId → organization id, as Organization.provisioning.orderId
  const taken = new Set(["taken-already"]);
  const seen = new Set();
  // Failure drills the suites switch on:
  //   unconfigured  the product has no secret (503)
  //   drop          the product is down: every connection is cut
  //   lose-answer   the NEXT provision is built, then its answer is lost
  let drill = null;

  const fakeServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    /* The suites' window into the fake. Unsigned, and only here. */
    if (req.url === "/__received") return send(200, { received, issued });
    if (req.url === "/__drill" && req.method === "POST") {
      drill = raw ? JSON.parse(raw) : null;
      return send(200, { drill });
    }

    if (!req.url.startsWith("/api/internal/")) return send(404, { error: "Not found" });
    if (drill?.kind === "drop") return req.socket.destroy(); // "the product API is down"
    if (drill?.kind === "unconfigured") return send(503, { error: "The control plane is not configured on this deployment." });

    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization || "",
      rawBody: raw,
      body: raw ? JSON.parse(raw) : null,
      verified: false,
    };
    received.push(entry);

    // The verifying half, as server/src/lib/controlPlane.js does it.
    const match = /^SILLA-HMAC t=(\d+),sig=([a-f0-9]{64})$/.exec(entry.authorization);
    if (!match) return send(401, { error: "Missing or malformed control-plane signature." });
    const t = Number(match[1]);
    if (Math.abs(Date.now() / 1000 - t) > 300) return send(401, { error: "Control-plane request is too old or from the future." });
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${t}\n${req.method.toUpperCase()}\n${req.url}\n${sha256(raw)}`)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(expected, "hex"))) {
      return send(401, { error: "Bad control-plane signature." });
    }
    if (seen.has(match[2])) return send(401, { error: "Control-plane request was already used." });
    seen.add(match[2]);
    entry.verified = true;

    const path = req.url.split("?")[0];
    let m;

    if (req.method === "GET" && path === "/api/internal/ping") return send(200, { ok: true, service: "fake-silla-server" });

    if (req.method === "GET" && (m = /^\/api\/internal\/slugs\/([^/]+)$/.exec(path))) {
      const slug = decodeURIComponent(m[1]);
      const problem = slugProblem(slug);
      const isTaken = taken.has(slug);
      return send(200, {
        available: !problem && !isTaken,
        problem: problem || (isTaken ? "That address is taken." : null),
        suggestion: isTaken ? `${slug}-2` : null,
      });
    }

    if (req.method === "POST" && path === "/api/internal/organizations") {
      // In the order server/src/services/provisioning.js checks, with its
      // shapes: problems as [{ field, message }], the order before the address.
      const { profile, slug, entitlements, source } = entry.body || {};
      if (!profile || typeof profile !== "object" || !profile.organizationName) {
        return send(400, {
          error: "This profile can't be provisioned — 1 field(s) need fixing.",
          code: "INVALID_PROFILE",
          fields: [{ field: "organizationName", message: "is required" }],
        });
      }
      if (!profile.owner?.email) {
        return send(400, {
          error: "A deployment provisioned for a customer must name its owner.",
          code: "INVALID_PROFILE",
          fields: [{ field: "owner", message: "is required: the founding superadmin's firstName, lastName and email" }],
        });
      }
      const orderId = source?.orderId ? String(source.orderId) : null;
      if (orderId && byOrder.has(orderId)) {
        const existing = orgs.get(byOrder.get(orderId));
        return send(409, {
          error: "This order already has a deployment.",
          code: "ALREADY_PROVISIONED",
          organizationId: existing.organization.id,
          slug: existing.organization.slug,
        });
      }
      const problem = slugProblem(String(slug || ""));
      if (problem) {
        return send(400, { error: problem, code: "INVALID_SLUG", fields: [{ field: "slug", message: problem }], suggestion: `${slug}-org` });
      }
      if (taken.has(slug)) return send(409, { error: "That address is taken.", code: "SLUG_TAKEN", suggestion: `${slug}-2` });

      const id = crypto.randomBytes(12).toString("hex");
      taken.add(slug);
      if (orderId) byOrder.set(orderId, id);
      const owner = profile.owner?.email ? { email: profile.owner.email, temporaryPin: pin() } : null;
      if (owner) issued.push({ organizationId: id, email: owner.email, temporaryPin: owner.temporaryPin });
      const floors = Array.isArray(profile.floors) ? profile.floors.length : 0;
      orgs.set(id, {
        organization: { id, name: profile.organizationName, slug, createdAt: new Date().toISOString() },
        entitlements: entitlements || { managed: false },
        usage: { buildings: 1, floors, rooms: 2, resources: 48, members: 12, staff: owner ? 1 : 3 },
        activity: { reservations30d: 37, checkIns30d: 29, lastReservationAt: new Date().toISOString() },
        owners: owner
          ? [{ email: owner.email, firstName: profile.owner.firstName, lastName: profile.owner.lastName, mustChangePin: true }]
          : [],
      });
      if (drill?.kind === "lose-answer") {
        drill = null; // once: the retry gets a real answer
        return req.socket.destroy(); // built, and the answer never arrives
      }
      return send(201, { organizationId: id, slug, owner, summary: { floors, resources: 48 } });
    }

    if ((m = /^\/api\/internal\/organizations\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
      const org = orgs.get(m[1]);
      if (!org) return send(404, { error: "Organization not found." });
      const tail = m[2] || "";

      if (req.method === "GET" && !tail) return send(200, org);

      if (req.method === "PUT" && tail === "/entitlements") {
        const next = entry.body || {};
        // An older snapshot arriving after a newer one is ignored (§2).
        if ((org.entitlements?.version || 0) > (next.version || 0)) return send(200, { entitlements: org.entitlements, ignored: true });
        org.entitlements = next;
        return send(200, { entitlements: next });
      }

      if (req.method === "POST" && tail === "/owner-access") {
        const wanted = entry.body?.email ? String(entry.body.email).toLowerCase() : null;
        const owner = wanted ? org.owners.find((o) => o.email === wanted) : org.owners[0];
        if (!owner) return send(404, { error: "No superadmin with that email in this organization." });
        owner.mustChangePin = true;
        const temporaryPin = pin();
        issued.push({ organizationId: m[1], email: owner.email, temporaryPin });
        return send(200, { email: owner.email, temporaryPin });
      }
    }

    return send(404, { error: "Not found" });
  });

  return fakeServer;
}

/* ───────────────────────────── the run ───────────────────────────── */

try {
  fake = startFakeControlPlane(CONTROL_PLANE_SECRET);
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: "/dev/null",
    VENDOR_MONGO_URI: replica.getUri(),
    MONGO_URI: "",
    VENDOR_DB_NAME: "silla_vendor_isolated",
    JWT_SECRET: "isolated-vendor-tests",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    EMAIL_API_KEY: "",
    SILLA_ORDERS_EMAIL: "",
    CORS_ORIGINS: process.env.CORS_ORIGINS || "http://localhost:5174",
    NODE_ENV: "test",
    // The control plane points at the fake, never at a real product API —
    // except a --serve walk that names a (disposable) one, see the header.
    SERVER_INTERNAL_URL: SERVE_AGAINST_PRODUCT ? process.env.SERVER_INTERNAL_URL : fakeUrl,
    CONTROL_PLANE_SECRET: SERVE_AGAINST_PRODUCT ? process.env.CONTROL_PLANE_SECRET : CONTROL_PLANE_SECRET,
    PRODUCT_URL,
  };
  Object.assign(process.env, env);

  const { connectDB } = await import("../src/config/db.js");
  await connectDB();
  const { default: Account } = await import("../src/models/Account.js");
  await Account.create({
    email: STAFF_EMAIL,
    firstName: "Isolated",
    lastName: "Owner",
    passwordHash: await bcrypt.hash(STAFF_PASSWORD, 10),
    role: "silla",
    staffRole: "owner",
    active: true,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    passwordChangedAt: new Date(Date.now() - 1000),
  });

  const { createApp } = await import("../src/app.js");
  server = http.createServer(createApp());

  if (SERVING) {
    const port = Number(process.env.VENDOR_PORT || 4100);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    console.log(`\n  Throwaway vendor API on http://127.0.0.1:${port}`);
    console.log(`  Staff owner: ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
    console.log(`  CORS allows: ${env.CORS_ORIGINS}`);
    console.log(
      SERVE_AGAINST_PRODUCT
        ? `  Control plane: the product API at ${env.SERVER_INTERNAL_URL}`
        : `  Fake product API (control plane): ${fakeUrl} — what it received: ${fakeUrl}/__received`
    );
    console.log(`  Deployments are addressed at ${PRODUCT_URL}/<slug>`);
    // Invitation and verification codes are only ever emailed. To walk an
    // invitation in the browser, plant a known one (246810):
    console.log(
      `  Plant a known code: VENDOR_MONGO_URI='${replica.getUri()}' VENDOR_DB_NAME=silla_vendor_isolated ` +
        `DOTENV_CONFIG_PATH=/dev/null node tests/plant.mjs <email> invite`
    );
    console.log("  Ctrl+C to stop.\n");
    await new Promise((resolve) => process.once("SIGINT", resolve).once("SIGTERM", resolve));
  } else {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const child = spawn(process.execPath, ["tests/run.mjs", ...process.argv.slice(2)], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...env,
        VENDOR_API_URL: `http://127.0.0.1:${server.address().port}`,
        VENDOR_STAFF_EMAIL: STAFF_EMAIL,
        VENDOR_STAFF_PASSWORD: STAFF_PASSWORD,
        FAKE_CONTROL_PLANE_URL: fakeUrl,
      },
      stdio: "inherit",
    });
    const [code] = await once(child, "exit");
    process.exitCode = code;
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake) await new Promise((resolve) => fake.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
