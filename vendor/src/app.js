import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import orderRoutes from "./routes/order.routes.js";

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

  // Behind nginx (and CloudFront) in production. Trusting only the
  // loopback hop makes req.ip the address nginx reports, which is what
  // the rate limiters key on — without it every visitor is 127.0.0.1 and
  // one person's failed logins lock out everyone.
  app.set("trust proxy", "loopback");

  app.use(
    cors({
      origin: (process.env.CORS_ORIGINS || "http://localhost:5174").split(",").filter(Boolean),
    })
  );
  app.use(express.json({ limit: "1mb" })); // a profile with many floors is still small

  app.get("/api/vendor/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/vendor/auth", authRoutes);
  app.use("/api/vendor/orders", orderRoutes);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[vendor]", err);
    if (err?.code === 11000) return res.status(409).json({ error: "That already exists." });
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}
