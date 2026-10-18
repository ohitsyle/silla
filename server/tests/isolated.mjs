// Runs the existing stack suites on a disposable replica set, not Atlas.
//
//   npm run test:isolated                 every suite, then the database is discarded
//   npm run test:isolated -- platform     one suite by name (same filter as npm test)
//   npm run test:isolated -- --serve      seed, then keep the API up for a browser walk
//                                         (PORT, default 4011; Ctrl-C to stop)
//
// The control-plane secret below exists only for this throwaway database,
// so the signed /api/internal routes can be exercised end to end. APP_URL
// is a placeholder host so provisioning's sign-in links are checkable;
// nothing is ever sent (the mail settings are blanked).
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { LATE_EVENING, keepClear } from "./clock.mjs";
const serve = process.argv.includes("--serve");
// The last half hour of a day takes no walk-ins, so the suites' walk-ins
// move to 23:20 then — every process alike, the API here and the seeder
// and the suites it starts (see tests/clock.mjs). A browser preview keeps
// the real clock: the browser beside it does.
//
// Before the database driver is loaded, not after: it keeps the clock it
// found, and one moved underneath it dropped the connection at its first
// heartbeat, ten seconds in.
const moved = serve ? null : keepClear(LATE_EVENING);
if (moved) console.log(`(clock moved to ${moved} for this run: a walk-in needs half an hour of the day left)`);
const clockImport = ["--import", new URL("./clock.mjs", import.meta.url).href];
const { default: mongoose } = await import("mongoose");
const { Server } = await import("socket.io");
const { MongoMemoryReplSet } = await import("mongodb-memory-server");
const suiteArgs = process.argv.slice(2).filter((arg) => arg !== "--serve");
const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server, io;
const run = async (args, env, capture = false) => {
  const child = spawn(process.execPath, [...(moved ? clockImport : []), ...args], { cwd: new URL("..", import.meta.url), env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  let output = "";
  if (capture) { child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => output += d); }
  const [code] = await once(child, "exit");
  if (code) throw new Error("Isolated command failed: " + args.join(" ") + (capture ? "\n" + output : ""));
  return output;
};
try {
  const env = {
    ...process.env, DOTENV_CONFIG_PATH: "/dev/null", MONGO_URI: replica.getUri(), JWT_SECRET: "isolated-regression-tests",
    SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_API_KEY: "", CORS_ORIGINS: "", NODE_ENV: "test",
    CONTROL_PLANE_SECRET: "isolated-control-plane-secret-not-for-any-real-deployment", SILLA_ISOLATED: "1",
    APP_URL: process.env.ISOLATED_APP_URL || "http://product.test.silla",
  };
  Object.assign(process.env, env);
  const seed = await run(["src/scripts/seed.js"], env, true);
  const orgId = seed.match(/organizationId:\s*([a-f0-9]{24})/i)?.[1];
  if (!orgId) throw new Error("Seeder did not report its organization id");
  await mongoose.connect(env.MONGO_URI);
  const { createApp } = await import("../src/app.js");
  const app = createApp(); server = http.createServer(app);
  io = new Server(server, { cors: { origin: true } }); app.set("io", io);
  io.on("connection", (socket) => socket.on("floor:join", (id) => socket.join("floor:" + id)));
  await new Promise((resolve) => server.listen(serve ? Number(process.env.PORT || 4011) : 0, "127.0.0.1", resolve));
  const api = "http://127.0.0.1:" + server.address().port;
  if (serve) {
    const slug = seed.match(/address:\s*\/([a-z0-9-]+)/)?.[1];
    console.log(`\nDisposable API on ${api} — nothing here reaches Atlas or sends mail.`);
    console.log(`  VITE_API_URL=${api} VITE_DEMO_ORG_ID=${orgId}   (demo organization: /${slug})`);
    console.log(`  CONTROL_PLANE_SECRET=${env.CONTROL_PLANE_SECRET}`);
    console.log("  Demo logins: admin@demo.test / 123456, staff@demo.test / 654321, member@demo.test / 111111 (card DEADBEEF)");
    console.log("  Ctrl-C to stop; the database is discarded.\n");
    await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    await run(["tests/run.mjs", ...suiteArgs], { ...env, TEST_ORG_ID: orgId, TEST_API_URL: api });
  }
} finally {
  if (io) await new Promise((resolve) => io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); await replica.stop();
}
