// Runs the existing stack suites on a disposable replica set, not Atlas.
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { MongoMemoryReplSet } from "mongodb-memory-server";
const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server, io;
const run = async (args, env, capture = false) => {
  const child = spawn(process.execPath, args, { cwd: new URL("..", import.meta.url), env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  let output = "";
  if (capture) { child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => output += d); }
  const [code] = await once(child, "exit");
  if (code) throw new Error("Isolated command failed: " + args.join(" ") + (capture ? "\n" + output : ""));
  return output;
};
try {
  const env = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null", MONGO_URI: replica.getUri(), JWT_SECRET: "isolated-regression-tests", SMTP_USER: "", SMTP_PASSWORD: "", EMAIL_API_KEY: "", CORS_ORIGINS: "", NODE_ENV: "test" };
  Object.assign(process.env, env);
  const seed = await run(["src/scripts/seed.js"], env, true);
  const orgId = seed.match(/organizationId:\s*([a-f0-9]{24})/i)?.[1];
  if (!orgId) throw new Error("Seeder did not report its organization id");
  await mongoose.connect(env.MONGO_URI);
  const { createApp } = await import("../src/app.js");
  const app = createApp(); server = http.createServer(app);
  io = new Server(server, { cors: { origin: true } }); app.set("io", io);
  io.on("connection", (socket) => socket.on("floor:join", (id) => socket.join("floor:" + id)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await run(["tests/run.mjs", ...process.argv.slice(2)], { ...env, TEST_ORG_ID: orgId, TEST_API_URL: "http://127.0.0.1:" + server.address().port });
} finally {
  if (io) await new Promise((resolve) => io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); await replica.stop();
}
