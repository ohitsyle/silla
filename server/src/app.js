import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import organizationRoutes from "./routes/organization.routes.js";
import spaceRoutes from "./routes/space.routes.js";
import floorRoutes from "./routes/floor.routes.js";
import registrationRoutes from "./routes/registration.routes.js";
import checkinRoutes from "./routes/checkin.routes.js";
import reservationRoutes from "./routes/reservation.routes.js";
import resourceRoutes from "./routes/resource.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import { keepRawBody } from "./lib/controlPlane.js";
import { operationalGuard, respondToEntitlementError } from "./services/entitlements.js";

/**
 * How many proxies stand between a visitor and this process — and so how
 * far back along X-Forwarded-For the visitor's own address is.
 *
 * In production a request passes CloudFront, then nginx on the box:
 *
 *   visitor ──► CloudFront ──► nginx ──► this process
 *
 * CloudFront appends the address it saw (the visitor's) to
 * X-Forwarded-For and nginx appends CloudFront's. Trusting exactly those
 * two hops makes req.ip the visitor, which is what every per-IP rate
 * limit keys on. Without it every request arrived from nginx's 127.0.0.1,
 * so each per-IP limit was one bucket shared by the whole world — thirty
 * kiosk taps a minute across every organization.
 *
 * Exactly two, never "trust everything": anything further left in the
 * header was written by the visitor and is whatever they like. That only
 * holds if nobody can reach nginx WITHOUT passing CloudFront, which is why
 * the origin's port 80 belongs behind CloudFront's origin-facing prefix
 * list (docs/INF-5-aws-deployment.md).
 *
 * TRUST_PROXY_HOPS overrides it; 0 means "no proxy", for a process that
 * takes requests directly.
 */
function trustedProxyHops() {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 2;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : 2;
}

export function createApp() {
  const app = express();
  app.set("trust proxy", trustedProxyHops());

  const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
  // keepRawBody: control-plane signatures cover the exact bytes sent.
  // A provisioning profile carries a whole building's layout, which can
  // outgrow the 100kb default; the larger limit applies to the signed
  // internal API only, never to the public endpoints. (The second parser
  // skips a body the first has already read.)
  app.use("/api/internal", express.json({ limit: "2mb", verify: keepRawBody }));
  app.use(express.json({ verify: keepRawBody }));

  app.get("/api/health", (req, res) =>
    res.json({ ok: true, service: "silla-server", env: process.env.NODE_ENV || "development", tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  );

  // A suspended organization is read-only — see services/entitlements.js.
  // Before every router, so a new write route cannot forget it.
  app.use(operationalGuard());

  // SILLA's control plane only: signed requests from vendor/, refused at
  // nginx for the public internet. See lib/controlPlane.js.
  app.use("/api/internal", internalRoutes);

  app.use("/api/auth", authRoutes);
  app.use("/api/organizations", organizationRoutes);
  app.use("/api/spaces", spaceRoutes);
  app.use("/api/floors", floorRoutes); // MAP-1: floor list + read-only layout
  app.use("/api/registration", registrationRoutes); // ID-1, ID-2, ID-3
  app.use("/api/checkin", checkinRoutes); // INF-3/INF-4 identity + OCC-1..3, OCC-6
  app.use("/api/reservations", reservationRoutes); // RES-1..RES-3, RES-5, RES-7
  app.use("/api/resources", resourceRoutes); // MAP-3, MAP-4, MAP-5 (editor writes)
  app.use("/api/admin", adminRoutes); // ADM-1..ADM-5, RPT-1, RES-6

  // Note: /api/checkin resolves identity ONLY (spec §13). Activating a
  // reservation or assigning a walk-in resource is OCC-1/OCC-2 and
  // belongs downstream of it, not inside it.

  // Express 4 does not forward async rejections on its own — route
  // handlers must pass them to next() (see the asyncHandler wrapper in
  // floor.routes.js). This turns anything that reaches here into a 500
  // rather than leaking a stack trace to the client.
  app.use((err, req, res, _next) => {
    // Plan limits, withheld features and suspension carry their own
    // status and a message written for the person who hit them.
    if (respondToEntitlementError(err, res)) return;
    // A body that is not JSON, or is too large, is the caller's mistake
    // and deserves a 4xx that says so, not a 500 and a stack in the log.
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "The request body isn't valid JSON." });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "The request body is too large." });
    console.error("[api]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
