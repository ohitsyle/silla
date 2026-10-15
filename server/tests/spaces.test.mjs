/**
 * The spatial suite — buildings, floors, rooms, and the reservation engine
 * under them (INF-1, MAP-1..MAP-3, RES-1..RES-5, OCC-1..OCC-5).
 *
 *   npm run test:spaces                        run every check, then discard the data
 *   npm run test:spaces -- --serve             run them, then keep the API on :4010
 *                                              with preview data (docs/spatial-map.md)
 *   npm run test:spaces -- --serve --managed   the same, with the preview organization
 *                                              on a limited plan, to see the limits
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
    const listening = app.listen(SERVE ? 4010 : 0, "127.0.0.1", () => resolve(listening));
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
  check(
    "whole-room occupancy streams to every room level",
    emissions.length === 2 && emissions.every((emission) => emission.value.units[0].status === "occupied")
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
  check(
    "scheduled room status reaches every level automatically",
    dueEmissions.length === 2 && dueEmissions.every((emission) => emission.value.units[0].status === "reserved")
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
    console.log("PREVIEW_ORG=" + org._id + " API=http://localhost:4010");
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
