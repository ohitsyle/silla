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

export function createApp() {
  const app = express();

  const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
  // keepRawBody: control-plane signatures cover the exact bytes sent.
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
    console.error("[api]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
