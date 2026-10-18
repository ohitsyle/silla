/**
 * The spatial suite — buildings, floors, rooms, and the reservation engine
 * under them (INF-1, MAP-1..MAP-3, RES-1..RES-5, OCC-1..OCC-5).
 *
 *   npm run test:spaces                        run every check, then discard the data
 *   npm run test:spaces -- --serve             run them, then keep the API on :4010
 *                                              with preview data (docs/spatial-map.md)
 *   npm run test:spaces -- --serve --managed   the same, with the preview organization
 *                                              on a limited plan, to see the limits
 *   npm run test:spaces -- --serve --port=4011 the same on another port, when another
 *                                              worktree's preview already holds 4010
 *
 * It runs on a DISPOSABLE replica set: it never reads .env and never
 * touches Atlas. A replica set rather than a standalone server because the
 * engine's guarantees are transaction guarantees — the racing claims below
 * only prove something against the real thing.
 *
 * Checks run in one story, in order, because each scenario builds on the
 * map the one before it left behind.
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.JWT_SECRET = "isolated-space-tests-only";
process.env.NODE_ENV = "test";

const SERVE = process.argv.includes("--serve");
/** The preview API's port: 4010 unless --port=<n> says otherwise. */
const PREVIEW_PORT = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length)) || 4010;
/** The fixed id the browser preview's VITE_DEMO_ORG_ID points at. */
const PREVIEW_ORG_ID = "6abd97aca6022143a42a51d7";

const { createApp } = await import("../src/app.js");
const { default: Organization } = await import("../src/models/Organization.js");
const { default: Site } = await import("../src/models/Site.js");
const { default: Floor } = await import("../src/models/Floor.js");
const { default: User } = await import("../src/models/User.js");
const { default: ResourceType } = await import("../src/models/ResourceType.js");
const { default: Resource } = await import("../src/models/Resource.js");
const { default: Reservation } = await import("../src/models/Reservation.js");
const { default: Room } = await import("../src/models/Room.js");
const { default: Zone } = await import("../src/models/Zone.js");
const {
  ReservationError, cancelReservation, claimReservation, reservationAvailability, roomBookingOptions,
  syncUnitStatus, transact,
} = await import("../src/services/reservations/index.js");
const { assignWalkIn, checkOut, checkIn } = await import("../src/services/reservations/occupancy.js");
const { closeOut } = await import("../src/services/reservations/lifecycle.js");
const { MAX_ATTEMPTS, withSpaceTransaction } = await import("../src/services/spaces.js");
const {
  startScheduler, releaseExpiredGraceHolds, releaseOverstayedSessions, refreshDueHolds, sendStartingSoonReminders,
} = await import("../src/workers/scheduler.js");
const { clearOfMidnight, endOfDay, MINUTE, HOUR } = await import("./helpers.mjs");
const { cellKey, contains, floorCells } = await import("../src/lib/cells.js");

let passed = 0;
function check(name, value) {
  assert.ok(value, name);
  passed += 1;
  console.log("PASS " + name);
}

/** Asserts `fn` is refused with the engine's `code`. */
async function rejected(fn, code) {
  await assert.rejects(fn, (err) => err.code === code);
  passed += 1;
  console.log("PASS rejects " + code);
}

/** Stands in for Socket.io and records what would have been streamed. */
function recordingIo(into) {
  return { to: (channel) => ({ emit: (event, value) => into.push({ channel, event, value }) }) };
}

/**
 * A write conflict as MongoDB reports one inside a transaction. The driver
 * retries anything carrying this label, which is exactly the path the
 * bounded retry in withSpaceTransaction exists to cap.
 */
const simulatedWriteConflict = () =>
  new mongoose.mongo.MongoServerError({
    errmsg: "WriteConflict (simulated by the spatial suite)",
    code: 112,
    codeName: "WriteConflict",
    errorLabels: ["TransientTransactionError"],
  });

/**
 * Runs a scheduler job with `between` slipped in after the job has READ
 * its batch and before it acts on any of it — the window in which a
 * member taps in, taps out or cancels. Every job's first query is its
 * batch, so only the first Reservation.find is intercepted.
 */
async function interleaved(job, between) {
  const find = Reservation.find;
  Reservation.find = function findThenInterleave(...args) {
    Reservation.find = find;
    const query = find.apply(this, args);
    const exec = query.exec.bind(query);
    query.exec = async (...rest) => {
      const batch = await exec(...rest);
      await between();
      return batch;
    };
    return query;
  };
  try {
    return await job();
  } finally {
    Reservation.find = find;
  }
}

const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server;
let io;
let scheduler;
try {
  await mongoose.connect(replica.getUri());

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  const org = await Organization.create({
    ...(SERVE ? { _id: PREVIEW_ORG_ID } : {}),
    name: "Isolated workspaces",
    terminology: { resourceNoun: "desk", memberNoun: "member", facilityLabel: "Workspace" },
    policy: { operatingHours: { open: "00:00", close: "23:59" }, maxStayHours: 4 },
  });
  const foreign = await Organization.create({ name: "Another organization" });
  const site = await Site.create({ organization: org._id, name: "North site" });
  const foreignSite = await Site.create({ organization: foreign._id, name: "South site" });
  const oldFloor = await Floor.create({ site: site._id, name: "Ground", grid: { cols: 20, rows: 12 } });
  const foreignFloor = await Floor.create({ site: foreignSite._id, name: "Foreign", grid: { cols: 20, rows: 12 } });
  await ResourceType.create({
    organization: org._id, key: "desk", label: "Desk", footprint: { w: 2, h: 1 }, seatCount: 2,
  });
  await ResourceType.create({
    organization: org._id, key: "equipment", label: "Projector", footprint: { w: 1, h: 1 }, seatCount: 1,
    hasServiceStatus: true,
  });

  const pinHash = await bcrypt.hash("123456", 4);
  const makeUser = (role, i, organization = org._id) =>
    User.create({
      organization,
      role,
      firstName: "Space",
      lastName: "Tester",
      email: role + i + "@test.silla",
      memberId: role === "member" ? "M" + i : null,
      cardUid: role === "member" ? "F0" + String(i).padStart(6, "0") : null,
      pinHash,
      verified: true,
      termsAcceptedAt: new Date(),
    });
  const admin = await makeUser("superadmin", 0);
  const staff = await makeUser("staff", 0);
  const members = await Promise.all(Array.from({ length: 12 }, (_, i) => makeUser("member", i)));
  const foreignAdmin = await makeUser("superadmin", 1, foreign._id);
  const token = (user) =>
    jwt.sign({ id: String(user._id), organizationId: String(user.organization), role: user.role }, process.env.JWT_SECRET);

  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(SERVE ? PREVIEW_PORT : 0, "127.0.0.1", () => resolve(listening));
  });
  io = new Server(server, { cors: { origin: true } });
  app.set("io", io);
  io.on("connection", (socket) => socket.on("floor:join", (id) => socket.join("floor:" + id)));
  const base = "http://127.0.0.1:" + server.address().port;

  async function req(path, method = "GET", body, user = admin) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { Authorization: "Bearer " + token(user) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const call = async (path, method, body, expected = 200, user = admin) => {
    const response = await req(path, method, body, user);
    assert.equal(response.status, expected, JSON.stringify(response.body));
    return response.body;
  };

  /* ──────────────────────── buildings and floors ──────────────────────── */

  const hierarchy = await call("/api/spaces?organizationId=" + org._id);
  check(
    "legacy floors remain visible without a migration",
    hierarchy.buildings[0].unassigned && hierarchy.buildings[0].floors[0].id === String(oldFloor._id)
  );
  await call("/api/spaces/buildings", "POST", { name: "Denied" }, 403, staff);
  const building = (await call("/api/spaces/buildings", "POST", { name: "Building 1", adoptExisting: true }, 201)).building;
  const floor2 = (await call("/api/floors", "POST", {
    name: "Upper", buildingId: building.id, grid: { cols: 20, rows: 12 },
  }, 201)).floor;
  check("building adoption preserves the floor id", String((await Floor.findById(oldFloor._id)).building) === building.id);
  check("new floors belong to the selected building", floor2.buildingId === building.id);

  /* ─────────────────────────────── rooms ─────────────────────────────── */

  const place = async (floorId, resourceTypeKey, col, row) =>
    (await call("/api/resources", "POST", { floorId: String(floorId), resourceTypeKey, col, row }, 201)).resource;
  const desk = await place(oldFloor._id, "desk", 2, 3);
  const upperDesk = await place(floor2.id, "desk", 2, 3);
  const equipment = await place(oldFloor._id, "equipment", 5, 5);

  const definition = {
    name: "Two-level commons",
    buildingId: building.id,
    bookingMode: "either",
    levels: [
      { floorId: String(oldFloor._id), name: "Ground", bounds: { col: 1, row: 1, w: 8, h: 8 } },
      { floorId: floor2.id, name: "Balcony", bounds: { col: 1, row: 1, w: 8, h: 8 } },
    ],
  };
  await call("/api/spaces/rooms", "POST", definition, 403, staff);
  await call("/api/spaces/rooms", "POST", {
    ...definition, levels: [{ floorId: String(foreignFloor._id), bounds: definition.levels[0].bounds }],
  }, 404);
  // A boundary through the middle of a placed desk.
  await call("/api/spaces/rooms", "POST", {
    ...definition, levels: [{ floorId: String(oldFloor._id), bounds: { col: 3, row: 3, w: 3, h: 3 } }],
  }, 409);
  const room = (await call("/api/spaces/rooms", "POST", definition, 201)).room;
  check("one room has two real building levels", room.levels.length === 2);
  await call("/api/spaces/rooms", "POST", definition, 409); // overlaps itself
  await call("/api/spaces/rooms/" + room.id, "PATCH", { name: "Wrong org" }, 404, foreignAdmin);
  await call("/api/floors/" + floor2.id, "PATCH", { grid: { cols: 5, rows: 5 } }, 409);
  await call("/api/floors/" + floor2.id, "DELETE", null, 409);
  await call("/api/spaces/buildings/" + building.id, "DELETE", null, 409);
  // A desk straddling the room's edge.
  await call("/api/resources", "POST", { floorId: floor2.id, resourceTypeKey: "desk", col: 8, row: 5 }, 409);

  const layout = await call("/api/floors/" + floor2.id + "/layout");
  check(
    "layout includes room membership and all levels",
    layout.layout.rooms[0].levels.length === 2 && layout.layout.resources[0].roomId === room.id
  );
  check("layout names the owning building", layout.floor.building?.id === building.id);
  check(
    "layout gives each room level its shape, and a plain floor an empty outline",
    layout.layout.rooms[0].levels.every((level) => JSON.stringify(level.areas) === JSON.stringify([level.bounds])) &&
      Array.isArray(layout.floor.shape?.areas) && layout.floor.shape.areas.length === 0
  );
  check(
    "whole-room target is not fake furniture",
    layout.layout.resources.length === 1 && layout.resourceTypes.every((type) => type.key !== "__room")
  );
  check("room has its own streamed status identity", layout.status[room.resourceId][0].status === "available");
  const foreignView = await call("/api/floors/" + floor2.id + "/layout", "GET", null, 200, foreignAdmin);
  check(
    "another organization's staff token grants no staff-only map details",
    !foreignView.viewerIsStaff && Object.values(foreignView.status).every((units) => units.every((u) => !("overstay" in u)))
  );

  /* ─────────────────────────── booking rules ─────────────────────────── */

  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(10, 0, 0, 0);
  const window = { startTime: when, endTime: new Date(+when + HOUR) };
  const claim = (member, resourceId, unitLabel = "1", extra = {}) =>
    claimReservation({ organizationId: org._id, memberId: member._id, resourceId, unitLabel, ...window, ...extra });

  /**
   * The room panel's bulk answer must match, unit by unit, the answer the
   * booking form gets for each unit alone — they are the same rules read
   * two ways, and this is what stops the two drifting apart.
   */
  async function roomOptionsAgree(scenario) {
    const options = await roomBookingOptions({ organizationId: org._id, roomId: room.id, ...window });
    const pairs = [];
    if (options.whole) {
      const alone = await reservationAvailability({
        organizationId: org._id, resourceId: room.resourceId, unitLabel: "room", ...window,
      });
      pairs.push([options.whole, alone]);
    }
    for (const unit of options.units) {
      const alone = await reservationAvailability({
        organizationId: org._id, resourceId: unit.resourceId, unitLabel: unit.unitLabel, ...window,
      });
      pairs.push([unit, alone]);
    }
    check(
      `room options agree with the per-unit preview (${scenario})`,
      pairs.length > 0 && pairs.every(([bulk, alone]) => bulk.bookable === alone.bookable && (bulk.code || null) === (alone.code || null))
    );
    return options;
  }

  const freeRoom = await roomOptionsAgree("nothing booked");
  check(
    "a free room offers itself whole and every unit inside",
    freeRoom.whole?.bookable && freeRoom.units.length === 5 && freeRoom.units.every((unit) => unit.bookable)
  );
  const optionsQuery = `startTime=${when.toISOString()}&endTime=${window.endTime.toISOString()}`;
  const overHttp = await call(`/api/reservations/rooms/${room.id}/options?${optionsQuery}`, "GET", null, 200, members[1]);
  check(
    "room options list the units on every level",
    overHttp.bookingMode === "either" && new Set(overHttp.units.map((unit) => unit.floorId)).size === 2
  );
  await call(`/api/reservations/rooms/${room.id}/options?${optionsQuery}`, "GET", null, 404, foreignAdmin);

  const equipmentBooking = await claim(members[0], equipment.id);
  check("equipment can be booked individually inside a room", equipmentBooking.targetLabel === "Projector · 1");
  await rejected(() => claim(members[1], room.resourceId, "room"), "CONFLICT");
  await cancelReservation({ reservationId: equipmentBooking._id });
  await call(`/api/admin/resources/${equipment.id}/units/1`, "PATCH", { serviceStatus: "out_of_service" }, 200, staff);
  await rejected(() => claim(members[0], equipment.id), "OUT_OF_SERVICE");
  await call(`/api/admin/resources/${equipment.id}/units/1`, "PATCH", { serviceStatus: "working", status: "available" }, 200, staff);

  const seat = await claim(members[0], desk.id);
  const availability = await call(
    `/api/reservations/availability?resourceId=${room.resourceId}&unitLabel=room&${optionsQuery}`,
    "GET", null, 200, members[1]
  );
  check(
    "availability preview refuses a room containing an overlapping seat booking",
    !availability.bookable && availability.code === "CONFLICT"
  );
  const withSeat = await roomOptionsAgree("one desk booked");
  check(
    "a booked desk takes the whole room but not its neighbours",
    withSeat.whole.code === "CONFLICT" &&
      withSeat.units.filter((unit) => !unit.bookable).length === 1 &&
      withSeat.units.find((unit) => unit.resourceId === desk.id && unit.unitLabel === "1")?.code === "CONFLICT"
  );

  const schedule = await call("/api/admin/resources/" + room.resourceId + "/history", "GET", null, 200, staff);
  check(
    "room schedule includes individual resource reservations",
    schedule.schedule.some((r) => r.id === String(seat._id) && r.resourceLabel)
  );
  await call("/api/admin/resources/" + room.resourceId + "/history", "GET", null, 404, foreignAdmin);
  await call("/api/admin/reservations/" + seat._id, "DELETE", { reason: "Foreign request" }, 404, foreignAdmin);
  check("foreign staff cancellation leaves the reservation untouched", (await Reservation.findById(seat._id)).status === "held");
  await call(`/api/admin/resources/${desk.id}/units/1`, "PATCH", { status: "unavailable" }, 409, staff);
  await rejected(() => claim(members[1], room.resourceId, "room"), "CONFLICT");
  await call("/api/spaces/rooms/" + room.id, "PATCH", { bookingMode: "whole" }, 409);
  await call("/api/spaces/rooms/" + room.id + "/availability", "PATCH", { status: "unavailable" }, 409, staff);
  await cancelReservation({ reservationId: seat._id });

  const hall = await claim(members[1], room.resourceId, "room");
  await rejected(() => claim(members[2], upperDesk.id), "CONFLICT");
  await call("/api/resources/" + upperDesk.id, "DELETE", null, 409);
  await call("/api/resources", "POST", { floorId: floor2.id, resourceTypeKey: "desk", col: 4, row: 5 }, 409);
  const next = await claim(members[2], upperDesk.id, "1", {
    startTime: window.endTime, endTime: new Date(+window.endTime + HOUR),
  });
  check("adjacent non-overlapping room and seat bookings both succeed", Boolean(next._id));
  await cancelReservation({ reservationId: hall._id });
  await cancelReservation({ reservationId: next._id });

  /* ───────────────────────────── concurrency ───────────────────────────── */

  const races = await Promise.allSettled(
    members.slice(0, 8).map((member, i) => (i % 2 ? claim(member, room.resourceId, "room") : claim(member, upperDesk.id)))
  );
  const winners = races.filter((race) => race.status === "fulfilled");
  check("eight racing room/seat claims commit one winner", winners.length === 1);
  check(
    "losers leave no tentative reservations",
    (await Reservation.countDocuments({ status: { $in: ["held", "active"] } })) === 1
  );
  await cancelReservation({ reservationId: winners[0].value._id });
  const different = await Promise.allSettled([claim(members[8], desk.id, "1"), claim(members[8], upperDesk.id, "2")]);
  check(
    "same member racing different resources gets one reservation",
    different.filter((race) => race.status === "fulfilled").length === 1
  );
  await cancelReservation({ reservationId: different.find((race) => race.status === "fulfilled").value._id });

  // A conflict that clears is retried out of sight...
  let tries = 0;
  const settled = await withSpaceTransaction(org._id, async () => {
    tries += 1;
    if (tries < 3) throw simulatedWriteConflict();
    return "committed";
  });
  check("a transient write conflict is retried until it clears", settled === "committed" && tries === 3);
  // ...but one that never clears is given up on, quickly and plainly.
  tries = 0;
  const startedAt = Date.now();
  const gaveUp = await withSpaceTransaction(org._id, async () => {
    tries += 1;
    throw simulatedWriteConflict();
  }).catch((err) => err);
  check(
    `a conflict that never clears stops after ${MAX_ATTEMPTS} attempts with BUSY`,
    tries === MAX_ATTEMPTS && gaveUp.code === "BUSY" && gaveUp.status === 503
  );
  check("giving up takes moments, not the driver's two minutes", Date.now() - startedAt < 5000);
  const busyClaim = await transact(org._id, async () => {
    throw simulatedWriteConflict();
  }).catch((err) => err);
  check(
    "the booking path reports BUSY as a plain try-again message",
    busyClaim instanceof ReservationError && busyClaim.code === "BUSY" && busyClaim.status === 503 &&
      /try again/i.test(busyClaim.message)
  );

  /* ───────────────────────────── room modes ───────────────────────────── */

  await call("/api/spaces/rooms/" + room.id, "PATCH", { bookingMode: "whole" });
  await rejected(() => claim(members[0], desk.id), "ROOM_MODE");
  await call("/api/spaces/rooms/" + room.id, "PATCH", { bookingMode: "individual" });
  await rejected(() => claim(members[0], room.resourceId, "room"), "ROOM_MODE");
  await call("/api/spaces/rooms/" + room.id + "/availability", "PATCH", { status: "unavailable" }, 200, staff);
  await rejected(() => claim(members[0], upperDesk.id), "ROOM_CLOSED");
  const closedRoom = await roomOptionsAgree("room closed by staff");
  check(
    "a closed room offers nothing, and says why",
    closedRoom.whole === null && closedRoom.units.every((unit) => !unit.bookable && unit.code === "ROOM_CLOSED")
  );
  await call("/api/spaces/rooms/" + room.id + "/availability", "PATCH", { status: "available" }, 200, staff);
  await call("/api/spaces/rooms/" + room.id, "PATCH", { bookingMode: "either" });

  /* ──────────────────────── right now: the physical loop ──────────────────────── */

  // Every window below stays inside today, because a booking may not span
  // two days; seconds from midnight the block waits for the date to turn
  // instead (see helpers.mjs).
  await clearOfMidnight();
  const now = new Date();
  const dayEnd = endOfDay(now);
  const boundary = new Date(+now + Math.min(8 * MINUTE, (dayEnd - now) / 2));
  const occupying = await claim(members[3], desk.id, "1", { startTime: now, endTime: boundary });
  await checkIn({ organizationId: org._id, memberId: members[3]._id });
  const earlyRoom = await claim(members[4], room.resourceId, "room", {
    startTime: boundary, endTime: new Date(Math.min(+boundary + HOUR, +dayEnd)),
  });
  await rejected(() => checkIn({ organizationId: org._id, memberId: members[4]._id }), "CONFLICT");
  check("refused early room arrival keeps the future reservation held", (await Reservation.findById(earlyRoom._id)).status === "held");
  await checkOut({ memberId: members[3]._id });
  check(
    "room arrival succeeds after the previous seat checks out",
    (await checkIn({ organizationId: org._id, memberId: members[4]._id })).status === "active"
  );
  await checkOut({ memberId: members[4]._id });

  // An overstay is a session whose scheduled end has passed. Booked as a
  // normal window, then moved into the past: an hour ago may be yesterday.
  const overstay = await claim(members[3], upperDesk.id, "1");
  await Reservation.updateOne({ _id: overstay._id }, {
    startTime: new Date(+now - HOUR), endTime: new Date(+now - MINUTE),
    status: "active", checkedInAt: new Date(+now - HOUR), overstay: true,
  });
  await rejected(
    () => assignWalkIn({ organizationId: org._id, memberId: members[4]._id, resourceId: room.resourceId, unitLabel: "room" }),
    "CONFLICT"
  );
  await checkOut({ memberId: members[3]._id });
  check("completed sessions release all room conflicts", (await Reservation.findById(occupying._id)).status === "completed");
  const roomNow = await assignWalkIn({ organizationId: org._id, memberId: members[0]._id, resourceId: room.resourceId, unitLabel: "room" });
  check("whole-room walk-in uses the normal active lifecycle", roomNow.status === "active");
  await rejected(
    () => assignWalkIn({ organizationId: org._id, memberId: members[1]._id, resourceId: upperDesk.id, unitLabel: "1" }),
    "CONFLICT"
  );
  const emissions = [];
  await syncUnitStatus(room.resourceId, "room", { io: recordingIo(emissions) });
  const streamed = emissions.filter((emission) => emission.event === "resource:status");
  check(
    "whole-room occupancy streams to every room level",
    streamed.length === 2 && streamed.every((emission) => emission.value.units[0].status === "occupied")
  );
  const dashboard = await call("/api/admin/dashboard");
  check("room target never inflates the physical resource count", dashboard.metrics.total === 5 && dashboard.metrics.occupied === 5);
  await checkOut({ memberId: members[0]._id });
  const groups = await call("/api/admin/resources");
  check(
    "room checkout restores individual availability",
    groups.groups.flatMap((group) => group.resources).every((r) => r.units.every((u) => u.status === "available"))
  );
  const apiBooked = await call("/api/reservations", "POST", {
    resourceId: room.resourceId, unitLabel: "room", pin: "123456", startTime: window.startTime, endTime: window.endTime,
  }, 201, members[0]);
  check("PIN-confirmed room booking records the real room name", apiBooked.reservation.resourceLabel === room.name);
  await call("/api/reservations/" + apiBooked.reservation.id, "DELETE", null, 200, members[0]);

  /* ─────────────────────────────── the scheduler ─────────────────────────────── */

  const due = await claim(members[0], room.resourceId, "room");
  await Reservation.updateOne({ _id: due._id }, { startTime: new Date(Date.now() - MINUTE), endTime: new Date(Date.now() + 30 * MINUTE) });
  const dueEmissions = [];
  await refreshDueHolds({ io: recordingIo(dueEmissions) });
  check("scheduled room holds become reserved when their window starts", (await Resource.findById(room.resourceId)).units[0].status === "reserved");
  const dueStreamed = dueEmissions.filter((emission) => emission.event === "resource:status");
  check(
    "scheduled room status reaches every level automatically",
    dueStreamed.length === 2 && dueStreamed.every((emission) => emission.value.units[0].status === "reserved")
  );
  await cancelReservation({ reservationId: due._id });

  // Two refreshes of one unit can interleave, and the one that read the
  // reservations first can write last. Simulated here by a refresh whose
  // first read predates a booking that is now live: it must not leave the
  // stale "available" behind.
  const late = await claim(members[11], desk.id, "2");
  await Reservation.updateOne({ _id: late._id }, { startTime: new Date(Date.now() - MINUTE), endTime: new Date(Date.now() + 30 * MINUTE) });
  const find = Reservation.find;
  Reservation.find = function readsTheOldWorld(...args) {
    Reservation.find = find;
    const query = find.apply(this, args);
    query.exec = async () => [];
    return query;
  };
  try {
    await syncUnitStatus(desk.id, "2");
  } finally {
    Reservation.find = find;
  }
  check(
    "a refresh that read before a booking committed still leaves the unit right",
    (await Resource.findById(desk.id)).units.find((unit) => unit.label === "2").status === "reserved"
  );
  await cancelReservation({ reservationId: late._id });

  // A no-show started half an hour ago. Booked as a normal window and moved,
  // for the same reason as the overstay above.
  const noShow = await claim(members[0], room.resourceId, "room");
  await Reservation.updateOne({ _id: noShow._id }, { startTime: new Date(+now - 30 * MINUTE), endTime: new Date(+now + 30 * MINUTE) });
  await releaseExpiredGraceHolds();
  check("no-show worker expires whole-room bookings through the shared lifecycle", (await Reservation.findById(noShow._id)).status === "expired");
  check("no-show worker restores room availability", (await Resource.findById(room.resourceId)).units[0].status === "available");

  // The races the conditional moves exist for: the member acts AFTER the
  // worker has read its batch and before it gets round to them. A plain
  // save() wrote the worker's stale decision over the member's.
  const graceMinutes = org.policy.gracePeriodMinutes;
  const lastSecond = await claim(members[5], desk.id, "1");
  const lastSecondStart = new Date(Date.now() - (graceMinutes + 1) * MINUTE);
  await Reservation.updateOne({ _id: lastSecond._id }, { startTime: lastSecondStart, endTime: new Date(Date.now() + 30 * MINUTE) });
  const noShows = await interleaved(releaseExpiredGraceHolds, () =>
    // Their tap was read inside the grace period and committed just now.
    Reservation.updateOne({ _id: lastSecond._id }, {
      status: "active", checkedInAt: new Date(+lastSecondStart + (graceMinutes - 1) * MINUTE),
    })
  );
  check(
    "a last-second check-in is not overwritten as a no-show",
    noShows === 0 && (await Reservation.findById(lastSecond._id)).status === "active"
  );
  await checkOut({ memberId: members[5]._id });

  const longStay = await claim(members[6], desk.id, "2");
  await Reservation.updateOne({ _id: longStay._id }, {
    status: "active", checkedInAt: new Date(Date.now() - (org.policy.maxStayHours + 1) * HOUR),
  });
  const overstays = await interleaved(releaseOverstayedSessions, () => checkOut({ memberId: members[6]._id }));
  const leftOnTime = await Reservation.findById(longStay._id);
  check(
    "a tap-out is not overwritten as an overstay release",
    overstays === 0 && leftOnTime.status === "completed" && !leftOnTime.overstay
  );

  const soon = await claim(members[7], upperDesk.id, "1");
  await Reservation.updateOne({ _id: soon._id }, {
    startTime: new Date(Date.now() + 5 * MINUTE), endTime: new Date(Date.now() + 35 * MINUTE),
  });
  const reminded = await interleaved(sendStartingSoonReminders, () => cancelReservation({ reservationId: soon._id }));
  check(
    "a booking cancelled after the batch was read is not reminded",
    reminded === 0 && (await Reservation.findById(soon._id)).remindedAt === null
  );
  const twice = await claim(members[9], upperDesk.id, "2");
  await Reservation.updateOne({ _id: twice._id }, {
    startTime: new Date(Date.now() + 5 * MINUTE), endTime: new Date(Date.now() + 35 * MINUTE),
  });
  const passes = await Promise.all([sendStartingSoonReminders(), sendStartingSoonReminders()]);
  check("two overlapping reminder passes send one reminder", passes[0] + passes[1] === 1);
  await cancelReservation({ reservationId: twice._id });

  const closing = await claim(members[10], desk.id, "1");
  const readAtClose = await Reservation.findById(closing._id);
  await Reservation.updateOne({ _id: closing._id }, { status: "active", checkedInAt: new Date() });
  check(
    "a tap-in during the closing minute is released, not expired",
    (await closeOut(readAtClose))?.status === "released"
  );
  const unclaimed = await claim(members[10], desk.id, "1");
  check("an untouched booking expires at closing", (await closeOut(unclaimed))?.status === "expired");
  check("a reservation already finished is left alone at closing", (await closeOut(unclaimed)) === null);

  /* ───────────────────────────── plan limits ───────────────────────────── */

  // A MANAGED organization: the control plane's snapshot written straight
  // into the test database. Every other organization in this suite is
  // unmanaged — no limits, every feature — which is what all the checks
  // above rely on, and what every organization that exists today is.
  const managed = await Organization.create({
    name: "Managed workspace",
    terminology: { resourceNoun: "desk" },
    policy: { operatingHours: { open: "00:00", close: "23:59" }, maxStayHours: 4 },
    entitlements: {
      managed: true,
      plan: "room",
      planName: "One Room",
      status: "active",
      features: { wholeRoomBooking: false },
      limits: { buildings: 1, floors: 1, rooms: 1, resources: 3 },
    },
  });
  const managedSite = await Site.create({ organization: managed._id, name: "Managed site" });
  for (const [key, label, w, seatCount, reservable] of [
    ["desk", "Desk", 2, 2, true],
    ["solo", "Focus desk", 1, 1, true],
    ["shelf", "Shelf", 1, 0, false],
  ]) {
    await ResourceType.create({ organization: managed._id, key, label, footprint: { w, h: 1 }, seatCount, reservable });
  }
  const owner = await makeUser("superadmin", 2, managed._id);
  const tenant = await makeUser("member", 20, managed._id);

  /** A request the plan must refuse, through app.js's error handler. */
  async function refusedByPlan(path, method, body, code, scenario) {
    const response = await req(path, method, body, owner);
    check(`${scenario} — 403 ${code}`, response.status === 403 && response.body.code === code);
    return response.body;
  }

  const managedBuilding = (await call("/api/spaces/buildings", "POST", {
    name: "Only building", siteId: String(managedSite._id),
  }, 201, owner)).building;
  const overBuildings = await refusedByPlan("/api/spaces/buildings", "POST", { name: "Second building" }, "PLAN_LIMIT", "a second building on a one-building plan");
  check(
    "the refusal names the limit, the cap and the usage",
    overBuildings.limit === "buildings" && overBuildings.max === 1 && overBuildings.used === 1 && /plan/i.test(overBuildings.error)
  );

  const managedFloor = (await call("/api/floors", "POST", {
    name: "Only floor", buildingId: managedBuilding.id, grid: { cols: 12, rows: 8 },
  }, 201, owner)).floor;
  await refusedByPlan("/api/floors", "POST", { name: "Second floor", buildingId: managedBuilding.id }, "PLAN_LIMIT", "a second floor on a one-floor plan");

  await call("/api/resources", "POST", { floorId: managedFloor.id, resourceTypeKey: "desk", col: 1, row: 1 }, 201, owner);
  const overUnits = await refusedByPlan(
    "/api/resources", "POST", { floorId: managedFloor.id, resourceTypeKey: "desk", col: 1, row: 3 },
    "PLAN_LIMIT", "a two-seat desk with one bookable unit left"
  );
  check("a piece counts as the units it adds", overUnits.limit === "resources" && overUnits.used === 2 && overUnits.adding === 2);
  await call("/api/resources", "POST", { floorId: managedFloor.id, resourceTypeKey: "solo", col: 4, row: 1 }, 201, owner);
  const shelf = await req("/api/resources", "POST", { floorId: managedFloor.id, resourceTypeKey: "shelf", col: 6, row: 1 }, owner);
  check("a piece nobody books is never refused for units, even at the limit", shelf.status === 201);

  const usage = (await call("/api/spaces/usage", "GET", null, 200, owner)).usage;
  check(
    "usage is counted the way the limits count it",
    usage.buildings === 1 && usage.floors === 1 && usage.rooms === 0 && usage.resources === 3
  );
  await call("/api/spaces/usage", "GET", null, 403, tenant);

  const roomOn = (bounds) => ({ buildingId: managedBuilding.id, levels: [{ floorId: managedFloor.id, bounds }] });
  await refusedByPlan(
    "/api/spaces/rooms", "POST", { ...roomOn({ col: 0, row: 0, w: 8, h: 3 }), name: "Project room", bookingMode: "whole" },
    "PLAN_FEATURE", "a room booked whole on a plan without whole-room booking"
  );
  const projectRoom = (await call("/api/spaces/rooms", "POST", {
    ...roomOn({ col: 0, row: 0, w: 8, h: 3 }), name: "Project room", bookingMode: "individual",
  }, 201, owner)).room;
  await refusedByPlan(
    "/api/spaces/rooms", "POST", { ...roomOn({ col: 0, row: 5, w: 4, h: 3 }), name: "Second room", bookingMode: "individual" },
    "PLAN_LIMIT", "a second room on a one-room plan"
  );
  await refusedByPlan(
    `/api/spaces/rooms/${projectRoom.id}`, "PATCH", { bookingMode: "either" },
    "PLAN_FEATURE", "switching a room to whole-room booking without the feature"
  );

  // A room booked whole from before a downgrade keeps what it has...
  await Room.updateOne({ _id: projectRoom.id }, { bookingMode: "whole" });
  const renamed = await call(`/api/spaces/rooms/${projectRoom.id}`, "PATCH", {
    name: "Project room (renamed)", bookingMode: "whole",
  }, 200, owner);
  check("a downgrade never blocks editing a room as it already is", renamed.room.name === "Project room (renamed)");
  // ...but takes no NEW whole-room bookings, and says so before the PIN.
  const wholeBooking = await req("/api/reservations", "POST", {
    resourceId: projectRoom.resourceId, unitLabel: "room", pin: "123456", ...window,
  }, tenant);
  check(
    "a new whole-room booking without the feature — 403 PLAN_FEATURE",
    wholeBooking.status === 403 && wholeBooking.body.code === "PLAN_FEATURE"
  );
  const preview = await call(
    `/api/reservations/availability?resourceId=${projectRoom.resourceId}&unitLabel=room&${optionsQuery}`,
    "GET", null, 200, tenant
  );
  const managedOptions = await call(`/api/reservations/rooms/${projectRoom.id}/options?${optionsQuery}`, "GET", null, 200, tenant);
  check(
    "the booking form and the room panel are told before the PIN",
    !preview.bookable && preview.code === "PLAN_FEATURE" && managedOptions.whole?.code === "PLAN_FEATURE"
  );

  /* ─────────────────────────────── removal ─────────────────────────────── */

  await call("/api/spaces/rooms/" + room.id, "DELETE");
  const after = await call("/api/floors/" + floor2.id + "/layout");
  check("removing a room preserves its furniture", after.layout.rooms.length === 0 && after.layout.resources.length === 1);
  check("room history survives removal of its map boundary", Boolean(await Reservation.findById(apiBooked.reservation.id)));

  /* ─────────────────────────────── shapes ─────────────────────────────── */

  // A building that is not a rectangle. The L floor, 12 by 10 cells:
  //
  //     cols 0–11, rows 0–3   the bar
  //     cols 0–4,  rows 4–9   the stem          the rest of the grid is not floor
  //
  // with an L-shaped room around its inside corner, desks in both arms of
  // the room and one outside it, an L-shaped zone and a label.
  const shaped = (await call("/api/spaces/buildings", "POST", { name: "Shaped building" }, 201)).building;
  const newFloor = (name, grid, shape) => req("/api/floors", "POST", { name, buildingId: shaped.id, grid, ...(shape === undefined ? {} : { shape }) });
  const outlineRefusals = await Promise.all([
    newFloor("Fractions", { cols: 12, rows: 10 }, { areas: [{ col: 0, row: 0, w: 1.5, h: 2 }] }),
    newFloor("Past the edge", { cols: 12, rows: 10 }, { areas: [{ col: 10, row: 0, w: 3, h: 2 }] }),
    newFloor("Not a shape", { cols: 12, rows: 10 }, "L"),
    newFloor("Too intricate", { cols: 12, rows: 10 }, { areas: Array.from({ length: 201 }, () => ({ col: 0, row: 0, w: 1, h: 1 })) }),
  ]);
  check("a floor outline must be whole cells inside the grid, in at most 200 rectangles", outlineRefusals.every((r) => r.status === 400));

  const L_SHAPE = [{ col: 0, row: 0, w: 12, h: 4 }, { col: 0, row: 4, w: 5, h: 6 }];
  const lFloor = (await newFloor("L wing", { cols: 12, rows: 10 }, { areas: L_SHAPE })).body.floor;
  check("an L-shaped floor stores its two rectangles", JSON.stringify(lFloor.shape.areas) === JSON.stringify(L_SHAPE));
  const plain = (await newFloor("Plain", { cols: 6, rows: 4 }, { areas: [{ col: 0, row: 0, w: 3, h: 4 }, { col: 3, row: 0, w: 3, h: 4 }] })).body.floor;
  check(
    "an outline that covers the whole grid is stored as a plain floor",
    plain.shape.areas.length === 0 && (await Floor.findById(plain.id)).shape?.areas === undefined
  );
  await call("/api/floors/" + plain.id, "DELETE");

  // Nothing goes in the missing corner, or across the inside corner.
  const corner = await Promise.all([
    req("/api/resources", "POST", { floorId: lFloor.id, resourceTypeKey: "desk", col: 8, row: 6 }),
    req("/api/resources", "POST", { floorId: lFloor.id, resourceTypeKey: "desk", col: 4, row: 5 }),
    req("/api/resources/zones", "POST", { floorId: lFloor.id, name: "Spill", areas: [{ col: 6, row: 3, w: 3, h: 3 }] }),
    req("/api/resources/labels", "POST", { floorId: lFloor.id, text: "Nowhere", col: 9, row: 8 }),
    req("/api/spaces/rooms", "POST", {
      name: "Spill", buildingId: shaped.id, bookingMode: "individual",
      levels: [{ floorId: lFloor.id, areas: [{ col: 3, row: 3, w: 4, h: 4 }] }],
    }),
  ]);
  check("a piece, zone, label or room outside the floor's outline is refused", corner.every((r) => r.status === 400));
  check("the refusal says it is the outline", /outline/.test(corner[0].body.error) && /outline/.test(corner[4].body.error));

  const roomDesk = await place(lFloor.id, "desk", 2, 1); // the room's bar
  const stemDesk = await place(lFloor.id, "desk", 1, 7); // the room's stem
  const barDesk = await place(lFloor.id, "desk", 8, 1); // outside the room
  const zone = (await call("/api/resources/zones", "POST", {
    floorId: lFloor.id, name: "Quiet corner", areas: [{ col: 6, row: 0, w: 6, h: 2 }, { col: 10, row: 2, w: 2, h: 2 }],
  }, 201)).zone;
  check("an L-shaped zone keeps its shape and its bounding box", zone.areas.length === 2 && zone.bounds.w === 6 && zone.bounds.h === 4);
  const sign = (await call("/api/resources/labels", "POST", { floorId: lFloor.id, text: "Lifts", col: 4, row: 9 }, 201)).label;

  const L_ROOM = [{ col: 0, row: 0, w: 6, h: 4 }, { col: 0, row: 4, w: 4, h: 5 }];
  const lRoom = (await call("/api/spaces/rooms", "POST", {
    name: "Reading room", buildingId: shaped.id, bookingMode: "either", levels: [{ floorId: lFloor.id, areas: L_ROOM }],
  }, 201)).room;
  check(
    "an L-shaped room is one room with both rectangles",
    JSON.stringify(lRoom.levels[0].areas) === JSON.stringify(L_ROOM) &&
      JSON.stringify(lRoom.levels[0].bounds) === JSON.stringify({ col: 0, row: 0, w: 6, h: 9 })
  );
  const sharesOneCell = await req("/api/spaces/rooms", "POST", {
    name: "Neighbour", buildingId: shaped.id, bookingMode: "individual", levels: [{ floorId: lFloor.id, areas: [{ col: 3, row: 8, w: 2, h: 2 }] }],
  });
  check("two rooms may not share even one cell", sharesOneCell.status === 409);
  const throughDesk = await req("/api/spaces/rooms", "POST", {
    name: "Cutting", buildingId: shaped.id, bookingMode: "individual",
    levels: [{ floorId: lFloor.id, areas: [{ col: 6, row: 2, w: 3, h: 2 }, { col: 9, row: 0, w: 3, h: 4 }] }],
  });
  check("a shaped room may not cut through a piece", throughDesk.status === 409 && /cuts through/.test(throughDesk.body.error));

  const lLayout = await call("/api/floors/" + lFloor.id + "/layout");
  const roomOf = (piece) => lLayout.layout.resources.find((r) => r.id === piece.id)?.roomId;
  check(
    "a piece in either arm of an L-shaped room belongs to it, and one beside it does not",
    roomOf(roomDesk) === lRoom.id && roomOf(stemDesk) === lRoom.id && roomOf(barDesk) === null
  );
  check(
    "the layout carries the floor's outline and the zone's shape",
    JSON.stringify(lLayout.floor.shape.areas) === JSON.stringify(L_SHAPE) && lLayout.layout.zones[0].areas.length === 2
  );
  const lOptions = await roomBookingOptions({ organizationId: org._id, roomId: lRoom.id, ...window });
  check(
    "the room panel offers the desks in both arms",
    new Set(lOptions.units.map((unit) => unit.resourceId)).size === 2 && lOptions.units.length === 4 && lOptions.whole?.bookable
  );
  const grouped = (await call("/api/admin/resources?floorId=" + lFloor.id, "GET", null, 200, staff)).groups;
  check(
    "the console groups by the room's and the zone's shapes",
    grouped.find((g) => g.zoneId === lRoom.id)?.resources.length === 2 &&
      grouped.find((g) => g.zoneId === zone.id)?.resources.map((r) => r.id).join() === barDesk.id
  );

  // Whole-room booking covers both arms.
  const [reader, other] = await Promise.all([makeUser("member", 40), makeUser("member", 41)]);
  const inStem = await claim(reader, stemDesk.id);
  await rejected(() => claim(other, lRoom.resourceId, "room"), "CONFLICT");
  await cancelReservation({ reservationId: inStem._id });
  const wholeL = await claim(other, lRoom.resourceId, "room");
  await rejected(() => claim(reader, roomDesk.id), "CONFLICT");
  await rejected(() => claim(reader, stemDesk.id, "2"), "CONFLICT");
  const outsideRoom = await claim(reader, barDesk.id);
  check("a whole-room booking of an L takes both arms and nothing beyond them", Boolean(outsideRoom._id));
  await cancelReservation({ reservationId: wholeL._id });
  await cancelReservation({ reservationId: outsideRoom._id });

  // Reshaping the floor: refused while anything would be left outside.
  const cutStem = await req("/api/floors/" + lFloor.id, "PATCH", { shape: { areas: [{ col: 0, row: 0, w: 12, h: 4 }] } });
  check(
    "cutting away the stem is refused, naming what stands in it",
    cutStem.status === 409 &&
      cutStem.body.error === "1 piece, the room “Reading room” and the label “Lifts” are in the part you're removing. Move or remove them first." &&
      ["room", "resource", "label"].every((kind) => cutStem.body.outside.some((item) => item.kind === kind)) &&
      cutStem.body.outside.find((item) => item.kind === "resource").id === stemDesk.id
  );
  check("a refused reshape changes nothing", JSON.stringify((await call("/api/floors/" + lFloor.id + "/layout")).floor.shape.areas) === JSON.stringify(L_SHAPE));
  const trimmed = await call("/api/floors/" + lFloor.id, "PATCH", {
    shape: { areas: [...L_SHAPE.slice(0, 1), { col: 0, row: 4, w: 5, h: 5 }, { col: 4, row: 9, w: 1, h: 1 }] },
  });
  check(
    "cutting away an empty part is allowed, and stored canonically",
    JSON.stringify(trimmed.floor.shape.areas) ===
      JSON.stringify([{ col: 0, row: 0, w: 12, h: 4 }, { col: 0, row: 4, w: 5, h: 5 }, { col: 4, row: 9, w: 1, h: 1 }])
  );

  // Resizing the grid keeps the outline inside it.
  const shorter = await req("/api/floors/" + lFloor.id, "PATCH", { grid: { cols: 12, rows: 9 } });
  check("a smaller grid is refused while it would cut off a label", shorter.status === 409 && /label “Lifts”/.test(shorter.body.error));
  await call("/api/resources/labels/" + sign.id, "DELETE");
  const trimmedGrid = (await call("/api/floors/" + lFloor.id, "PATCH", { grid: { cols: 12, rows: 9 } })).floor;
  check(
    "a smaller grid trims a shaped floor's outline to the new edge",
    JSON.stringify(trimmedGrid.shape.areas) === JSON.stringify([{ col: 0, row: 0, w: 12, h: 4 }, { col: 0, row: 4, w: 5, h: 5 }])
  );
  const wider = (await call("/api/floors/" + lFloor.id, "PATCH", { grid: { cols: 14, rows: 9 } })).floor;
  check(
    "a larger grid leaves a shaped floor's outline as it was",
    wider.grid.cols === 14 && JSON.stringify(wider.shape.areas) === JSON.stringify(trimmedGrid.shape.areas) &&
      (await req("/api/resources", "POST", { floorId: lFloor.id, resourceTypeKey: "equipment", col: 13, row: 0 })).status === 400
  );
  const island = (await newFloor("Island", { cols: 10, rows: 10 }, { areas: [{ col: 6, row: 6, w: 4, h: 4 }] })).body.floor;
  check(
    "a grid too small to keep any of the outline is refused",
    (await req("/api/floors/" + island.id, "PATCH", { grid: { cols: 5, rows: 5 } })).status === 409
  );
  await call("/api/floors/" + island.id, "DELETE");

  // Zones reshape under the same rules as everything else.
  const zoneOut = await req("/api/resources/zones/" + zone.id, "PATCH", { areas: [{ col: 4, row: 3, w: 4, h: 3 }] });
  const zoneIn = await call("/api/resources/zones/" + zone.id, "PATCH", { areas: [{ col: 6, row: 0, w: 6, h: 4 }] });
  check("a zone can be reshaped inside the outline, but not past it", zoneOut.status === 400 && zoneIn.zone.areas.length === 1);

  // A T, the other shape the owner asked about.
  const T_SHAPE = [{ col: 0, row: 0, w: 15, h: 3 }, { col: 5, row: 3, w: 5, h: 7 }];
  const tFloor = (await newFloor("T hall", { cols: 15, rows: 10 }, { areas: T_SHAPE })).body.floor;
  const tDesk = await place(tFloor.id, "desk", 6, 6);
  check(
    "a T-shaped floor takes pieces in its stem and refuses them beside it",
    Boolean(tDesk.id) && (await req("/api/resources", "POST", { floorId: tFloor.id, resourceTypeKey: "desk", col: 1, row: 6 })).status === 400
  );

  // Reset to a rectangle: the whole grid is floor again, stored as nothing.
  const reset = (await call("/api/floors/" + tFloor.id, "PATCH", { shape: null })).floor;
  const besideStem = await place(tFloor.id, "desk", 1, 6);
  check(
    "resetting to a rectangle makes the whole grid floor again",
    reset.shape.areas.length === 0 && (await Floor.findById(tFloor.id)).shape?.areas === undefined && Boolean(besideStem.id)
  );
  // ...and the T comes back only once nothing stands beside its stem.
  const tAgain = await req("/api/floors/" + tFloor.id, "PATCH", { shape: { areas: T_SHAPE } });
  await call("/api/resources/" + besideStem.id, "DELETE");
  const restored = (await call("/api/floors/" + tFloor.id, "PATCH", { shape: { areas: T_SHAPE } })).floor;
  check(
    "a T redrawn over a desk is refused until the desk goes",
    tAgain.status === 409 && JSON.stringify(restored.shape.areas) === JSON.stringify(T_SHAPE)
  );

  const listed = await call("/api/spaces?organizationId=" + org._id);
  const floorList = await call("/api/floors?organizationId=" + org._id);
  check(
    "the hierarchy and the floor list carry each floor's outline",
    listed.buildings.find((b) => b.id === shaped.id).floors.find((f) => f.id === tFloor.id).shape.areas.length === 2 &&
      floorList.floors.find((f) => f.id === lFloor.id).shape.areas.length === 2
  );

  // Racing a reshape against placements in the part it cuts. Every one of
  // them writes the organization's space revision first, so whichever goes
  // second sees the other: never a piece, zone or label left off the floor.
  const RACE_CUT = [{ col: 0, row: 0, w: 8, h: 3 }, { col: 0, row: 3, w: 4, h: 3 }];
  const outcomes = new Set();
  let stranded = 0;
  for (let round = 0; round < 4; round += 1) {
    const arena = (await newFloor(`Race ${round}`, { cols: 8, rows: 6 })).body.floor;
    const racing = [
      req("/api/floors/" + arena.id, "PATCH", { shape: { areas: RACE_CUT } }),
      req("/api/resources", "POST", { floorId: arena.id, resourceTypeKey: "desk", col: 5, row: 4 }),
      req("/api/resources/zones", "POST", { floorId: arena.id, name: "Corner", areas: [{ col: 4, row: 3, w: 4, h: 3 }] }),
      req("/api/resources/labels", "POST", { floorId: arena.id, text: "Corner", col: 6, row: 5 }),
    ];
    const [cut] = await Promise.all(racing);
    outcomes.add(cut.status);
    const after = await call("/api/floors/" + arena.id + "/layout");
    const cells = floorCells(after.floor);
    const footprint = (piece) => after.resourceTypes.find((type) => type.id === piece.resourceType).footprint;
    stranded +=
      after.layout.resources.filter((piece) => !contains(cells, { ...piece.position, ...footprint(piece) })).length +
      after.layout.zones.filter((zone) => !contains(cells, zone.areas)).length +
      after.layout.labels.filter((label) => !cells.has(cellKey(label.position.col, label.position.row))).length;
    for (const piece of after.layout.resources) await call("/api/resources/" + piece.id, "DELETE");
    await call("/api/floors/" + arena.id, "DELETE");
  }
  check(
    "racing a reshape against placements never leaves anything off the floor",
    stranded === 0 && [...outcomes].every((status) => status === 200 || status === 409)
  );

  /* ──────────────────── documents written before shapes ──────────────────── */

  // Written as rooms, zones and floors were before shapes existed: a floor
  // with no outline, a room level and a zone with one `bounds` and no
  // `areas`. Nothing migrates them; they must read and behave as before.
  const legacyFloor = (await newFloor("Before shapes", { cols: 10, rows: 8 })).body.floor;
  const legacyRoom = (await call("/api/spaces/rooms", "POST", {
    name: "Old room", buildingId: shaped.id, bookingMode: "either",
    levels: [{ floorId: legacyFloor.id, bounds: { col: 1, row: 1, w: 5, h: 4 } }],
  }, 201)).room;
  const legacyZone = (await call("/api/resources/zones", "POST", {
    floorId: legacyFloor.id, name: "Old zone", col: 6, row: 1, w: 4, h: 4,
  }, 201)).zone;
  await Room.collection.updateOne({ _id: new mongoose.Types.ObjectId(legacyRoom.id) }, { $unset: { "levels.$[].areas": "" } });
  await Zone.collection.updateOne({ _id: new mongoose.Types.ObjectId(legacyZone.id) }, { $unset: { areas: "" } });
  const stored = await Room.collection.findOne({ _id: new mongoose.Types.ObjectId(legacyRoom.id) });
  const storedFloor = await Floor.collection.findOne({ _id: new mongoose.Types.ObjectId(legacyFloor.id) });
  check("the legacy fixtures really have no shape fields", !("areas" in stored.levels[0]) && !("shape" in storedFloor));

  const oldDesk = await place(legacyFloor.id, "desk", 2, 2);
  const oldCorner = await place(legacyFloor.id, "desk", 8, 7);
  const oldLayout = await call("/api/floors/" + legacyFloor.id + "/layout");
  check(
    "an old floor, room and zone read as their one rectangle",
    oldLayout.floor.shape.areas.length === 0 &&
      JSON.stringify(oldLayout.layout.rooms[0].levels[0].areas) === JSON.stringify([{ col: 1, row: 1, w: 5, h: 4 }]) &&
      JSON.stringify(oldLayout.layout.zones[0].areas) === JSON.stringify([{ col: 6, row: 1, w: 4, h: 4 }])
  );
  check(
    "an old room's membership is its rectangle, and the whole grid is floor",
    oldLayout.layout.resources.find((r) => r.id === oldDesk.id)?.roomId === legacyRoom.id &&
      oldLayout.layout.resources.find((r) => r.id === oldCorner.id)?.roomId === null
  );
  const oldSeat = await claim(reader, oldDesk.id);
  await rejected(() => claim(other, legacyRoom.resourceId, "room"), "CONFLICT");
  await cancelReservation({ reservationId: oldSeat._id });
  const renamedOld = await call("/api/spaces/rooms/" + legacyRoom.id, "PATCH", { name: "Old room, renamed" });
  check(
    "an old room renames without being redrawn or rewritten",
    renamedOld.room.levels[0].areas.length === 1 && renamedOld.room.name === "Old room, renamed" &&
      !("areas" in (await Room.collection.findOne({ _id: new mongoose.Types.ObjectId(legacyRoom.id) })).levels[0])
  );
  await call("/api/floors/" + legacyFloor.id, "PATCH", { grid: { cols: 9, rows: 8 } }, 409); // the corner desk
  check(
    "an old floor still resizes as a plain grid",
    (await call("/api/floors/" + legacyFloor.id, "PATCH", { grid: { cols: 12, rows: 9 } })).floor.shape.areas.length === 0
  );

  console.log(`\n${passed} spatial checks passed; ${SERVE ? "isolated database kept for preview." : "isolated database discarded."}`);

  /* ───────────────────────────── browser preview ───────────────────────────── */

  if (SERVE) {
    // Enough of a workplace to judge the map by eye: rooms of every booking
    // mode, a room on two levels, open-plan desks outside any room, and
    // units in every state the legend explains.
    await ResourceType.create({
      organization: org._id, key: "table", label: "Meeting table", footprint: { w: 4, h: 2 }, seatCount: 6,
    });
    await ResourceType.create({
      organization: org._id, key: "solo", label: "Focus desk", footprint: { w: 1, h: 1 }, seatCount: 1,
    });
    // Ground: the Commons (either), a meeting room (whole only), open plan.
    await place(oldFloor._id, "desk", 5, 3);
    await place(oldFloor._id, "desk", 2, 6);
    await place(oldFloor._id, "table", 12, 3);
    const openPlan = [];
    for (const col of [2, 5, 8, 11, 14]) openPlan.push(await place(oldFloor._id, "desk", col, 10));
    await place(oldFloor._id, "solo", 18, 10);
    // Upper: the Commons balcony, and focus desks along the windows.
    await place(floor2.id, "desk", 5, 3);
    for (const col of [12, 14, 16]) await place(floor2.id, "solo", col, 3);
    await call("/api/spaces/rooms", "POST", { ...definition, name: "Commons" }, 201);
    await call("/api/spaces/rooms", "POST", {
      ...definition, name: "Meeting room", bookingMode: "whole",
      levels: [{ floorId: String(oldFloor._id), bounds: { col: 11, row: 1, w: 7, h: 6 } }],
    }, 201);
    const secondBuilding = (await call("/api/spaces/buildings", "POST", { name: "Building 2" }, 201)).building;
    const workshop = (await call("/api/floors", "POST", {
      name: "Workshop floor", buildingId: secondBuilding.id, grid: { cols: 14, rows: 10 },
    }, 201)).floor;
    for (const col of [3, 5, 7]) await place(workshop.id, "solo", col, 3);
    for (const col of [3, 5, 7]) await place(workshop.id, "solo", col, 6);
    await place(workshop.id, "equipment", 12, 8);
    await call("/api/spaces/rooms", "POST", {
      name: "Focus studio", buildingId: secondBuilding.id, bookingMode: "individual",
      levels: [{ floorId: workshop.id, bounds: { col: 1, row: 1, w: 9, h: 7 } }],
    }, 201);

    // Floors from before buildings existed, at a second site — what the
    // editor's "Set up building" path is for.
    const annex = await Site.create({ organization: org._id, name: "South annex" });
    const annexFloor = await Floor.create({ site: annex._id, name: "Annex ground", grid: { cols: 16, rows: 10 } });
    for (const col of [2, 5, 8]) await place(annexFloor._id, "desk", col, 4);

    // Somebody at a desk, a desk held for now, and one closed by staff.
    // member0 is left free, to explore and book.
    await clearOfMidnight();
    const previewNow = new Date();
    const until = (ms) => new Date(Math.min(+previewNow + ms, +endOfDay(previewNow)));
    await claim(members[1], openPlan[0].id, "1", { startTime: previewNow, endTime: until(2 * HOUR) });
    await checkIn({ organizationId: org._id, memberId: members[1]._id });
    await claim(members[2], openPlan[1].id, "2", { startTime: previewNow, endTime: until(HOUR) });
    await refreshDueHolds({ io });
    await call(`/api/admin/resources/${openPlan[2].id}/units/1`, "PATCH", { status: "unavailable" }, 200, staff);

    // Later today, for the rings, the timelines and the kiosk's paths: a
    // booking in three hours (member4 taps in early and is asked what to do
    // with it), one in ninety minutes (a walk-in at that desk is "free
    // until"), and the Commons booked whole this evening (its desks on both
    // levels are blocked then). Skipped when the day has too little left.
    const laterToday = async (member, resourceId, unitLabel, fromMinutes, minutes) => {
      const start = new Date(+previewNow + fromMinutes * MINUTE);
      const end = new Date(+start + minutes * MINUTE);
      if (end > endOfDay(previewNow)) return;
      await claim(member, resourceId, unitLabel, { startTime: start, endTime: end });
    };
    await laterToday(members[4], openPlan[3].id, "1", 180, 60);
    await laterToday(members[6], openPlan[4].id, "1", 90, 60);
    const commons = (await call("/api/spaces?organizationId=" + org._id)).buildings
      .flatMap((b) => b.floors).flatMap((f) => f.rooms).find((r) => r.name === "Commons");
    if (commons) await laterToday(members[7], commons.resourceId, "room", 300, 60);

    // A plan to look at: whole-room booking withheld, and the building
    // and room limits already reached, so the editor shows its reasons.
    if (process.argv.includes("--managed")) {
      await Organization.updateOne({ _id: org._id }, {
        entitlements: {
          managed: true, plan: "preview", planName: "Preview plan", status: "active",
          features: { wholeRoomBooking: false },
          limits: { buildings: 2, floors: 6, rooms: 3, resources: 60 },
        },
      });
    }

    scheduler = startScheduler(io);
    console.log("PREVIEW_ORG=" + org._id + " API=http://localhost:" + PREVIEW_PORT);
    await new Promise((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
  }
} finally {
  scheduler?.stop();
  if (io) await new Promise((resolve) => io.close(resolve));
  else if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
