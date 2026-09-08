import "dotenv/config";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";
import { startScheduler } from "./workers/scheduler.js";

const PORT = process.env.PORT || 4000;

async function main() {
  await connectDB();

  const app = createApp();
  const server = http.createServer(app);

  // Live map updates (spec §12, §17): status changes stream here,
  // kept separate from layout, which is fetched once via REST.
  // Same rule as the REST app in app.js, and it has to be written the
  // same way. This was `...filter(Boolean) || "*"`, which never fires:
  // an empty array is truthy, so an unset CORS_ORIGINS handed Socket.io
  // `origin: []` — every origin refused. The REST half kept working
  // because app.js already used the length check, so the symptom was a
  // live map that silently stopped updating while everything else was
  // fine. Reflect the request origin only when nothing is configured.
  const socketOrigins = (process.env.CORS_ORIGINS || "").split(",").filter(Boolean);
  const io = new SocketIOServer(server, {
    cors: { origin: socketOrigins.length ? socketOrigins : true },
  });

  io.on("connection", (socket) => {
    // Client joins a room per floor so updates only go to people
    // looking at that floor's map.
    socket.on("floor:join", (floorId) => socket.join(`floor:${floorId}`));
  });

  // Make io reachable from route handlers / services that need to
  // emit resource-status changes, e.g. io.to(`floor:${id}`).emit(...)
  app.set("io", io);

  // The shared scheduled worker (spec §10, §11, §15). Given `io` so a
  // seat the worker releases streams to the map exactly like a
  // member-triggered change (MAP-2).
  startScheduler(io);

  server.listen(PORT, () => {
    console.log(`[server] SILLA API listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
