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
 *   npm run test:isolated -- --serve      (VENDOR_PORT, default 4100)
 *
 * keeps the throwaway API running instead of testing, for a browser
 * walk: point the portal at it with VITE_VENDOR_API_URL and allow the
 * portal's origin with CORS_ORIGINS. Stop it with Ctrl+C.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server;

const STAFF_EMAIL = "owner@silla.test";
const STAFF_PASSWORD = "isolated-owner-passphrase";

try {
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

  if (process.argv.includes("--serve")) {
    const port = Number(process.env.VENDOR_PORT || 4100);
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    console.log(`\n  Throwaway vendor API on http://127.0.0.1:${port}`);
    console.log(`  Staff owner: ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
    console.log(`  CORS allows: ${env.CORS_ORIGINS}\n  Ctrl+C to stop.\n`);
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
    },
    stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  process.exitCode = code;
  }
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
