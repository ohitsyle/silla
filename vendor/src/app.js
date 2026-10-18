import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import orderRoutes from "./routes/order.routes.js";
import planRoutes from "./routes/plans.routes.js";
import catalogueRoutes from "./routes/catalogue.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import staffRoutes from "./routes/staff.routes.js";
import clientRoutes from "./routes/clients.routes.js";
import conversationRoutes from "./routes/conversations.routes.js";
import deploymentRoutes from "./routes/deployments.routes.js";
import auditRoutes from "./routes/audit.routes.js";

/**
 * SILLA's own commerce API — accounts and orders.
 *
 * A separate service from server/ on purpose. That one IS a buyer's
 * deployment: shipping the vendor's order queue inside it would put our
 * customer list in every customer's install. Nothing here is ever
 * provisioned to a buyer.
 */
export function createApp() {
  const app = express();

  // Behind CloudFront and nginx in production: trust exactly those two
  // hops (TRUST_PROXY_HOPS, default 2) so req.ip is the visitor CloudFront
  // saw — what the rate limiters key on. Trusting only loopback took the
  // address nginx reported, and nginx used to take it from a header any
  // visitor could forge. See server/src/app.js and deploy/nginx.conf.
  app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY_HOPS || "") ? Number(process.env.TRUST_PROXY_HOPS) : 2);

  app.use(
    cors({
      origin: (process.env.CORS_ORIGINS || "http://localhost:5174").split(",").filter(Boolean),
    })
  );
  app.use(express.json({ limit: "1mb" })); // a profile with many floors is still small

  app.get("/api/vendor/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/vendor/auth", authRoutes);
  app.use("/api/vendor/orders", orderRoutes);

  // Subscriptions and money.
  app.use("/api/vendor/plans", planRoutes);
  app.use("/api/vendor/catalogue", catalogueRoutes);
  app.use("/api/vendor/billing", billingRoutes);
  app.use("/api/vendor/settings", settingsRoutes);

  // The staff console: who staff are, the clients they serve, what they
  // say to them, the deployments they run, and the trail they leave.
  app.use("/api/vendor/staff", staffRoutes);
  app.use("/api/vendor/clients", clientRoutes);
  app.use("/api/vendor/conversations", conversationRoutes);
  app.use("/api/vendor/deployments", deploymentRoutes);
  app.use("/api/vendor/audit", auditRoutes);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[vendor]", err);
    if (err?.code === 11000) return res.status(409).json({ error: "That already exists." });
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}
