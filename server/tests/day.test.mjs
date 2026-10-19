/**
 * The day suite — what a member may hold at once (RES-3), a floor's day
 * (the map's rings and timelines, MAP-1/MAP-2), and the kiosk's paths for
 * someone who taps in with no booking or with one later today (OCC-1,
 * OCC-2).
 *
 *   npm run test:spaces     runs it between the geometry and spatial suites
 *                           (the spatial suite last, so `-- --serve` reaches it)
 *   npm run test:day        this suite alone
 *
 * Like the spatial suite it runs on a DISPOSABLE replica set — never .env,
 * never Atlas — because the rule it tests most is a transaction guarantee:
 * one member racing themselves must end up with one current session and
 * one upcoming booking, never two of either and never overlapping.
 *
 * Its scenarios are about TODAY: a booking later today, a walk-in capped at
 * closing, an overstay blocking the next slot. Those need hours of the day
 * on both sides of "now", which no window can conjure at 23:50, so late in
 * the evening (and just after midnight) the suite moves its own clock to
 * midday first and says so (tests/clock.mjs keepClear). At any other hour
 * it runs on the clock it is given, SILLA_TEST_CLOCK's included.
 */
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { keepClear } from "./clock.mjs";

process.env.JWT_SECRET = "isolated-day-tests-only";
process.env.NODE_ENV = "test";

// Before the database driver loads: it keeps the clock it finds.
const moved = keepClear({ ahead: 6, behind: 2 });
if (moved) console.log(`(this suite's clock moved to ${moved}: its scenarios need hours of today on both sides of now)`);
const { default: mongoose } = await import("mongoose");
const { MongoMemoryReplSet } = await import("mongodb-memory-server");

const { createApp } = await import("../src/app.js");
const { default: Organization } = await import("../src/models/Organization.js");
const { default: Site } = await import("../src/models/Site.js");
const { default: User } = await import("../src/models/User.js");
const { default: ResourceType } = await import("../src/models/ResourceType.js");
const { default: Reservation } = await import("../src/models/Reservation.js");
const { default: Resource } = await import("../src/models/Resource.js");
const {
  cancelReservation, claimReservation, reservationAvailability,
} = await import("../src/services/reservations/index.js");
const {
  __resetTapHistory, assignWalkIn, checkIn, checkOut, walkInAtKiosk,
} = await import("../src/services/reservations/occupancy.js");
const { floorDay } = await import("../src/services/reservations/day.js");
const { MINUTE, HOUR } = await import("./helpers.mjs");

let passed = 0;
function check(name, value) {
  assert.ok(value, name);
  passed += 1;
  console.log("PASS " + name);
}

/** Asserts `fn` is refused with the engine's `code`, and returns the error. */
async function refused(name, fn, code) {
  let caught = null;
  await assert.rejects(fn, (err) => {
    caught = err;
    return err.code === code;
  }, `${name}: expected ${code}`);
  passed += 1;
  console.log(`PASS ${name} — ${code}`);
  return caught;
}

/**
 * `minutes` from the scenario's "now", as a Date. Each scenario takes one
 * instant (`settle()`) and measures every window from it, so two windows
 * meant to touch really do — measured from Date.now() twice, they would be
 * a few milliseconds apart and overlap.
 */
let anchor = Date.now();
const settle = () => (anchor = Date.now());
const at = (minutes) => new Date(anchor + minutes * MINUTE);

const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "8.2.6" } });
let server;
try {
  await mongoose.connect(replica.getUri());

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  const org = await Organization.create({
    name: "Day workspace",
    terminology: { resourceNoun: "desk", memberNoun: "member", facilityLabel: "Workspace" },
    policy: { operatingHours: { open: "00:00", close: "23:59" }, maxStayHours: 4, gracePeriodMinutes: 10 },
  });
  const site = await Site.create({ organization: org._id, name: "Main site" });
  await ResourceType.create({ organization: org._id, key: "solo", label: "Focus desk", footprint: { w: 1, h: 1 }, seatCount: 1 });
  await ResourceType.create({ organization: org._id, key: "desk", label: "Desk", footprint: { w: 2, h: 1 }, seatCount: 2 });

  const pinHash = await bcrypt.hash("123456", 4);
  const makeUser = (role, i) =>
    User.create({
      organization: org._id,
      role,
      firstName: role === "member" ? `Member${i}` : "Day",
      lastName: role === "member" ? "Holder" : "Tester",
      email: `${role}${i}@test.silla`,
      memberId: role === "member" ? `D${i}` : null,
      cardUid: role === "member" ? `D0${String(i).padStart(6, "0")}` : null,
      pinHash,
      verified: true,
      termsAcceptedAt: new Date(),
    });
  const admin = await makeUser("superadmin", 0);
  const staff = await makeUser("staff", 0);
  const members = [];
  for (let i = 0; i < 40; i += 1) members.push(await makeUser("member", i));
  const token = (user) =>
    jwt.sign({ id: String(user._id), organizationId: String(user.organization), role: user.role }, process.env.JWT_SECRET);

  // Stands in for Socket.io and records what would have been streamed.
  const emitted = [];
  const recordingIo = (into = emitted) => ({ to: (channel) => ({ emit: (event, value) => into.push({ channel, event, value }) }) });
  const app = createApp();
  app.set("io", recordingIo());
  server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
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
    assert.equal(response.status, expected, `${method || "GET"} ${path}: ${JSON.stringify(response.body)}`);
    return response.body;
  };

  // Ground: a row of open-plan focus desks, the Studio (booked whole or a
  // desk at a time, with a balcony upstairs) and a Boardroom booked only
  // whole. Upper: the Studio's balcony.
  const building = (await call("/api/spaces/buildings", "POST", { name: "Day building", siteId: String(site._id) }, 201)).building;
  const ground = (await call("/api/floors", "POST", { name: "Ground", buildingId: building.id, grid: { cols: 20, rows: 12 } }, 201)).floor;
  const upper = (await call("/api/floors", "POST", { name: "Upper", buildingId: building.id, grid: { cols: 20, rows: 12 } }, 201)).floor;
  const place = async (floorId, resourceTypeKey, col, row) =>
    (await call("/api/resources", "POST", { floorId, resourceTypeKey, col, row }, 201)).resource;
  const solos = [];
  for (const col of [1, 3, 5, 7, 9, 11, 13, 15, 17]) solos.push(await place(ground.id, "solo", col, 9));
  for (const col of [1, 3, 5, 7, 9, 11, 13, 15, 17]) solos.push(await place(ground.id, "solo", col, 11));
  const studioDesk = await place(ground.id, "desk", 2, 2);
  const balconyDesk = await place(upper.id, "desk", 2, 2);
  const boardDesk = await place(ground.id, "desk", 13, 2);
  const studio = (await call("/api/spaces/rooms", "POST", {
    name: "Studio", buildingId: building.id, bookingMode: "either",
    levels: [
      { floorId: ground.id, name: "Studio floor", bounds: { col: 0, row: 0, w: 9, h: 7 } },
      { floorId: upper.id, name: "Balcony", bounds: { col: 0, row: 0, w: 9, h: 7 } },
    ],
  }, 201)).room;
  const boardroom = (await call("/api/spaces/rooms", "POST", {
    name: "Boardroom", buildingId: building.id, bookingMode: "whole",
    levels: [{ floorId: ground.id, bounds: { col: 11, row: 0, w: 8, h: 6 } }],
  }, 201)).room;

  const claim = (member, piece, from, minutes, unitLabel = "1") =>
    claimReservation({
      organizationId: org._id, memberId: member._id, resourceId: piece.id, unitLabel,
      startTime: at(from), endTime: at(from + minutes),
    });
  const walkIn = (member, piece, extra = {}, unitLabel = "1") =>
    assignWalkIn({ organizationId: org._id, memberId: member._id, resourceId: piece.id, unitLabel, ...extra });
  const live = (member) => Reservation.find({ member: member._id, status: { $in: ["held", "active"] } }).sort({ startTime: 1 });
  /** Cancels everything the member still holds, so the next scenario starts clean. */
  async function release(member) {
    for (const reservation of await live(member)) {
      if (reservation.status === "active") await checkOut({ memberId: member._id });
      else await cancelReservation({ reservationId: reservation._id });
    }
  }

  /* ─────────── RES-3: one current session, one upcoming booking ─────────── */

  // Somebody who booked 3–5 PM this morning can still sit down now.
  const [ana, ben, cai, dee, eli, fay] = members;
  settle();
  const anaLater = await claim(ana, solos[0], 180, 60);
  const anaNow = await claim(ana, solos[1], 0, 60);
  check("a booking for later leaves room for one for now", anaLater.status === "held" && anaNow.status === "held");
  const secondNow = await refused("a second booking for now is refused", () => claim(ana, solos[2], 0, 30), "ALREADY_HOLDING");
  check(
    "the refusal names the booking that holds the place",
    /^Focus desk \d+$/.test(anaNow.targetLabel) && secondNow.message.includes(anaNow.targetLabel) && /for now/.test(secondNow.message)
  );
  const secondLater = await refused("a second booking for later is refused, any day", () => claim(ana, solos[2], 300, 30), "ALREADY_HOLDING");
  check("the refusal says one booking ahead is the limit", /coming up/.test(secondLater.message) && /one booking ahead/.test(secondLater.message));
  const preview = await reservationAvailability({
    organizationId: org._id, resourceId: solos[2].id, unitLabel: "1", startTime: at(300), endTime: at(330), memberId: ana._id,
  });
  const anonymousPreview = await reservationAvailability({
    organizationId: org._id, resourceId: solos[2].id, unitLabel: "1", startTime: at(300), endTime: at(330),
  });
  check(
    "the booking form's preview gives the member's own reason before the PIN",
    preview.bookable === false && preview.code === "ALREADY_HOLDING" && anonymousPreview.bookable === true
  );
  const mine = await call("/api/reservations/mine", "GET", null, 200, ana);
  check(
    "a member's reservations come back as their current session and their next booking",
    mine.holding.length === 2 && mine.holding[0].phase === "current" && mine.holding[1].phase === "upcoming" &&
      mine.holding[0].id === String(anaNow._id) && mine.live.id === String(anaNow._id)
  );
  const overHttp = await req("/api/reservations", "POST", {
    resourceId: solos[2].id, unitLabel: "1", startTime: at(300).toISOString(), endTime: at(330).toISOString(), pin: "123456",
  }, ana);
  check("the website refuses the same way, with a 409", overHttp.status === 409 && overHttp.body.code === "ALREADY_HOLDING");
  await release(ana);

  settle();
  await claim(ben, solos[0], 120, 60);
  const overlap = await refused("a booking that overlaps the member's own is refused", () => claim(ben, solos[1], 0, 150), "OWN_OVERLAP");
  check("the overlap refusal says where the member's time is free", /ends by/.test(overlap.message));
  const adjacent = await claim(ben, solos[1], 0, 120);
  check("a booking that ends as the member's next one starts is allowed", Boolean(adjacent._id));
  await release(ben);

  settle();
  await refused("a booking whose check-in window has already closed is refused", () => claim(cai, solos[0], -60, 30), "STARTED");
  const soon = await claim(cai, solos[0], 10, 30);
  const after = await claim(cai, solos[1], 60, 30);
  await refused(
    "a booking starting within its check-in window counts as the one for now",
    () => claim(cai, solos[2], 100, 30), "ALREADY_HOLDING"
  );
  const caiMine = await call("/api/reservations/mine", "GET", null, 200, cai);
  check(
    "opening its check-in window moves a booking from upcoming to current",
    caiMine.holding.map((r) => `${r.id}:${r.phase}`).join() === `${soon._id}:current,${after._id}:upcoming`
  );
  await release(cai);

  // A booking made when it was "later" can be in its check-in window while
  // the member is still checked in elsewhere — time passes. Checking in to
  // it must not leave them in two places.
  settle();
  await walkIn(dee, solos[3]);
  const booked = await Reservation.create({
    organization: org._id, member: dee._id, resource: solos[4].id, unitLabel: "1", targetLabel: "Focus desk · 1",
    startTime: at(5), endTime: at(65), status: "held",
  });
  await refused("checking in while checked in elsewhere is refused", () => checkIn({ organizationId: org._id, memberId: dee._id }), "ALREADY_HOLDING");
  await checkOut({ memberId: dee._id });
  check("after checking out, the booking checks in", (await checkIn({ organizationId: org._id, memberId: dee._id }))._id.equals(booked._id));
  await release(dee);

  // A walk-in with a booking later today ends before it starts.
  settle();
  const eliLater = await claim(eli, solos[0], 150, 60);
  const eliNow = await walkIn(eli, solos[5]);
  check(
    "a walk-in by someone booked later today ends when that booking starts",
    eliNow.status === "active" && +eliNow.endTime === +eliLater.startTime
  );
  await release(eli);

  /* ─────────────── RES-3 under concurrency: a member racing themselves ─────────────── */

  // Every round, one member fires bookings for now, walk-ins and bookings
  // for later at once, some of them overlapping each other. Whatever wins,
  // they end up with at most one of each, and never two that overlap.
  let violations = 0;
  let committedRounds = 0;
  for (let round = 0; round < 4; round += 1) {
    const racer = members[10 + round];
    settle();
    const attempts = [
      () => claim(racer, solos[0], 0, 60),
      () => claim(racer, solos[1], 0, 90),
      () => walkIn(racer, solos[2]),
      () => walkIn(racer, solos[3]),
      () => claim(racer, solos[4], 120, 60),
      () => claim(racer, solos[5], 150, 60),
      () => claim(racer, solos[6], 60, 120),
    ];
    const results = await Promise.allSettled(attempts.map((attempt) => attempt()));
    const unexpected = results.filter((r) => r.status === "rejected" && !["ALREADY_HOLDING", "OWN_OVERLAP"].includes(r.reason.code));
    if (unexpected.length) throw unexpected[0].reason;
    const held = await live(racer);
    const now = new Date();
    const current = held.filter((r) => r.status === "active" || r.startTime - now <= 15 * MINUTE);
    const upcoming = held.filter((r) => !current.includes(r));
    const overlapping = held.some((a, i) => held.some((b, j) => i < j && a.startTime < b.endTime && b.startTime < a.endTime));
    if (current.length > 1 || upcoming.length > 1 || overlapping) violations += 1;
    if (held.length) committedRounds += 1;
    await release(racer);
  }
  check("a member racing seven bookings and walk-ins never holds two for now, two for later, or an overlap", violations === 0);
  check("and every race still commits something", committedRounds === 4);

  // The website and the kiosk at the same moment, for one member.
  settle();
  const both = await Promise.allSettled([walkIn(fay, solos[0]), claim(fay, solos[1], 0, 60), walkIn(fay, solos[2])]);
  check(
    "a walk-in racing a booking for now leaves exactly one current session",
    both.filter((r) => r.status === "fulfilled").length === 1 && (await live(fay)).length === 1
  );
  await release(fay);

  /* ─────────────── the day: every unit's bookings, one read per floor ─────────────── */

  const dayOf = (floor, user = null, date = null) =>
    call(`/api/floors/${floor.id}/day${date ? `?date=${date}` : ""}`, "GET", null, 200, user);
  const unitIn = (day, piece, unitLabel = "1") => day.units[piece.id].find((unit) => unit.label === unitLabel);
  const roomIn = (day, room) => day.units[room.resourceId][0];
  const near = (a, b) => Math.abs(new Date(a) - new Date(b)) < 1000;
  const hhmm = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const setHours = (open, close) => Organization.updateOne({ _id: org._id }, { "policy.operatingHours": { open, close } });

  settle();
  const quiet = await dayOf(ground, ben);
  check(
    "a unit with nothing booked is free the rest of the day, and free now with no limit before closing",
    unitIn(quiet, solos[8]).day === "free" && unitIn(quiet, solos[8]).fraction === 0 &&
      unitIn(quiet, solos[8]).freeNow && unitIn(quiet, solos[8]).freeUntil === null && quiet.isToday
  );

  const anaDesk = await claim(ana, solos[0], 120, 60);
  const asOther = await dayOf(ground, ben);
  const seen = unitIn(asOther, solos[0]);
  check(
    "a booking later today makes the unit's day partial, and free until it starts",
    seen.day === "partial" && seen.freeNow && near(seen.freeUntil, anaDesk.startTime) && seen.freeUntilReason === "booking" &&
      seen.fraction > 0 && seen.fraction < 1 && seen.blocks.length === 1 && near(seen.blocks[0].start, anaDesk.startTime)
  );
  check(
    "another member sees the time booked, never who booked it",
    !("holder" in seen.blocks[0]) && !seen.blocks[0].mine && !JSON.stringify(asOther).includes("Holder")
  );
  const asAna = await dayOf(ground, ana);
  const asStaff = await dayOf(ground, staff);
  const anonymous = await dayOf(ground, null);
  check("the member who booked it sees it marked as theirs", unitIn(asAna, solos[0]).blocks[0].mine === true && !("holder" in unitIn(asAna, solos[0]).blocks[0]));
  check("staff see who holds it", unitIn(asStaff, solos[0]).blocks[0].holder === "Member0 Holder");
  check("the kiosk, signed out, sees neither", !JSON.stringify(anonymous).includes("Holder") && !JSON.stringify(anonymous).includes('"mine"'));
  await release(ana);

  // Full: closing in 90 minutes, and nothing useful left between bookings.
  settle();
  const closing = new Date(Math.ceil(at(90).getTime() / MINUTE) * MINUTE);
  await setHours("00:00", hhmm(closing));
  const minutesToClose = (closing - anchor) / MINUTE;
  await claim(ben, solos[1], 0, minutesToClose);
  await claim(cai, solos[2], 0, minutesToClose - 20);
  await claim(dee, solos[3], 0, minutesToClose - 45);
  const nearClose = await dayOf(ground, eli);
  check("a unit booked until closing is full", unitIn(nearClose, solos[1]).day === "full" && !unitIn(nearClose, solos[1]).freeNow);
  check(
    "a unit with only twenty minutes left free is full too — nothing that short can be booked",
    unitIn(nearClose, solos[2]).day === "full" && unitIn(nearClose, solos[2]).fraction < 1
  );
  check("a unit with forty-five minutes left free is partial", unitIn(nearClose, solos[3]).day === "partial");
  // A booking for after closing — made before the hours changed — limits nobody today.
  await Reservation.create({
    organization: org._id, member: members[39]._id, resource: solos[4].id, unitLabel: "1", targetLabel: "Focus desk · 1",
    startTime: new Date(+closing + 10 * MINUTE), endTime: new Date(+closing + 70 * MINUTE), status: "held",
  });
  const afterClosing = unitIn(await dayOf(ground, eli), solos[4]);
  check("'free until' stops at closing: what comes after it limits nobody today", afterClosing.freeNow && afterClosing.freeUntil === null && afterClosing.day === "free");
  await release(members[39]);
  await release(ben);
  await release(cai);
  await release(dee);

  await setHours("00:00", hhmm(new Date(anchor - 2 * MINUTE)));
  const afterHours = await dayOf(ground, eli);
  check(
    "after closing there is nothing left to book, and that is not the same as booked",
    Object.values(afterHours.units).flat().every((unit) => unit.day === "closed" || unit.day === null) &&
      Object.values(afterHours.units).flat().every((unit) => !unit.freeNow)
  );
  await setHours("00:00", "23:59");

  // Closures: time nobody can book, shown as itself.
  settle();
  const lunch = await call("/api/admin/closures", "POST", {
    startTime: at(60).toISOString(), endTime: at(120).toISOString(), reason: "Fire drill",
  }, 201);
  const withClosure = await dayOf(ground, eli);
  check(
    "a closure later today is listed with its reason, and a free unit is free until it",
    withClosure.closures.length === 1 && withClosure.closures[0].reason === "Fire drill" &&
      unitIn(withClosure, solos[8]).day === "free" && near(unitIn(withClosure, solos[8]).freeUntil, at(60)) &&
      unitIn(withClosure, solos[8]).freeUntilReason === "closure"
  );
  check(
    "adding a closure tells every floor's map its day changed",
    ["floor:" + ground.id, "floor:" + upper.id].every((channel) => emitted.some((e) => e.event === "floor:day" && e.channel === channel))
  );
  await call(`/api/admin/closures/${lunch.closure.id}`, "DELETE");
  const restOfDay = await call("/api/admin/closures", "POST", {
    startTime: at(-10).toISOString(), endTime: new Date(new Date(anchor).setHours(23, 59, 0, 0)).toISOString(), reason: "Power cut",
  }, 201);
  const shut = await dayOf(ground, eli);
  check(
    "a closure for the rest of today leaves every unit closed, not booked",
    Object.values(shut.units).flat().every((unit) => unit.day === "closed" || unit.day === null)
  );
  await call(`/api/admin/closures/${restOfDay.closure.id}`, "DELETE");

  // Rooms: a whole-room booking blocks everything inside, on every level...
  settle();
  emitted.length = 0;
  const wholeStudio = await claimReservation({
    organizationId: org._id, memberId: eli._id, resourceId: studio.resourceId, unitLabel: "room",
    startTime: at(200), endTime: at(260), io: recordingIo(),
  });
  const groundDay = await dayOf(ground, fay);
  const upperDay = await dayOf(upper, fay);
  const blockedBy = (unit) => unit.blocks.some((b) => b.kind === "room" && near(b.start, wholeStudio.startTime));
  check(
    "a whole-room booking blocks every unit inside the room, on all its levels",
    blockedBy(unitIn(groundDay, studioDesk, "1")) && blockedBy(unitIn(groundDay, studioDesk, "2")) &&
      blockedBy(unitIn(upperDay, balconyDesk, "1")) && unitIn(upperDay, balconyDesk, "2").day === "partial"
  );
  check("and nothing outside it", unitIn(groundDay, solos[0]).blocks.length === 0);
  check("the room itself reads as booked for that time", roomIn(groundDay, studio).blocks.some((b) => b.kind === "room") && roomIn(groundDay, studio).day === "partial");
  check(
    "a room booking tells every level's map its day changed",
    ["floor:" + ground.id, "floor:" + upper.id].every((channel) => emitted.some((e) => e.event === "floor:day" && e.channel === channel))
  );
  await release(eli);

  // ...and a booking of one unit inside blocks booking the room whole.
  settle();
  emitted.length = 0;
  const balconySeat = await claimReservation({
    organizationId: org._id, memberId: fay._id, resourceId: balconyDesk.id, unitLabel: "1",
    startTime: at(60), endTime: at(90), io: recordingIo(),
  });
  const studioFromGround = roomIn(await dayOf(ground, eli), studio);
  check(
    "a desk booked on the balcony blocks the whole room, seen from the floor below",
    studioFromGround.blocks.some((b) => b.kind === "inside" && near(b.start, balconySeat.startTime)) && studioFromGround.day === "partial"
  );
  check(
    "a booking inside a room tells both of the room's floors",
    ["floor:" + ground.id, "floor:" + upper.id].every((channel) => emitted.some((e) => e.event === "floor:day" && e.channel === channel))
  );
  await release(fay);

  const boardDay = await dayOf(ground, fay);
  check(
    "units in a room booked only whole have no day of their own; the room does",
    unitIn(boardDay, boardDesk, "1").bookable === false && unitIn(boardDay, boardDesk, "1").reason === "with-room" &&
      unitIn(boardDay, boardDesk, "1").day === null && roomIn(boardDay, boardroom).bookable && roomIn(boardDay, boardroom).day === "free"
  );

  // An overstay: still checked in after the booking ended.
  settle();
  const overstayer = members[20];
  await Reservation.create({
    organization: org._id, member: overstayer._id, resource: solos[6].id, unitLabel: "1", targetLabel: "Focus desk · 1",
    startTime: at(-60), endTime: at(-5), status: "active", checkedInAt: at(-60),
  });
  const overstayDay = await dayOf(ground, fay);
  const overstayStaff = await dayOf(ground, staff);
  const stayed = unitIn(overstayDay, solos[6]);
  check(
    "an overstay keeps blocking the slot it is in until they check out",
    !stayed.freeNow && stayed.blocks.length === 1 && new Date(stayed.blocks[0].end) > new Date() && stayed.day !== "free"
  );
  check(
    "staff see it flagged as an overstay; members do not",
    unitIn(overstayStaff, solos[6]).blocks[0].overstay === true && !("overstay" in stayed.blocks[0])
  );
  await checkOut({ memberId: overstayer._id });
  check("checking out frees it at once", unitIn(await dayOf(ground, fay), solos[6]).freeNow);

  await call(`/api/admin/resources/${solos[7].id}/units/1`, "PATCH", { status: "unavailable" }, 200, staff);
  const closedUnit = unitIn(await dayOf(ground, fay), solos[7]);
  check("a unit staff have closed has no day to book", !closedUnit.bookable && closedUnit.reason === "unavailable" && closedUnit.day === null);
  await call(`/api/admin/resources/${solos[7].id}/units/1`, "PATCH", { status: "available" }, 200, staff);

  const tomorrow = new Date(anchor);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  const nextDay = await dayOf(ground, fay, tomorrowKey);
  check(
    "another day is read from opening to closing, with nothing free 'now'",
    !nextDay.isToday && nextDay.date === tomorrowKey && new Date(nextDay.opensAt).getDate() === tomorrow.getDate() &&
      Object.values(nextDay.units).flat().every((unit) => !unit.freeNow) && unitIn(nextDay, solos[8]).day === "free"
  );
  const badDate = await req(`/api/floors/${ground.id}/day?date=2026-02-31`, "GET", null, fay);
  check("a date that does not exist is refused", badDate.status === 400 && badDate.body.code === "BAD_DATE");

  // One reservation query for the whole floor, however many units it has.
  const find = Reservation.find;
  let finds = 0;
  Reservation.find = function counted(...args) {
    finds += 1;
    return find.apply(this, args);
  };
  try {
    await floorDay({ floorId: ground.id, viewer: { id: String(fay._id), role: "member" } });
  } finally {
    Reservation.find = find;
  }
  check(`a floor's day takes one reservation query, not one per unit (${finds})`, finds === 1);

  /* ─────────────── the kiosk: what a tap does, and how long a walk-in lasts ─────────────── */

  // The kiosk has no session: identity comes from the card every time.
  // Duplicate-tap protection is per card and 5 seconds, so it is reset
  // before each deliberate tap. Requests stay under the per-address limit
  // (30 a minute); the individual limits are checked on the service.
  const kiosk = {
    tap: (member) => {
      __resetTapHistory();
      return req("/api/checkin/tap", "POST", { organizationId: String(org._id), credential: member.cardUid }, null);
    },
    walkIn: (member, piece, extra = {}, unitLabel = "1") =>
      req("/api/checkin/walkin", "POST", {
        organizationId: String(org._id), credential: member.cardUid, resourceId: piece.id, unitLabel, ...extra,
      }, null),
  };
  const atKiosk = (member, piece, extra = {}, unitLabel = "1") =>
    walkInAtKiosk({ organizationId: org._id, memberId: member._id, resourceId: piece.id, unitLabel, ...extra });
  const [k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13] = members.slice(21, 34);

  // 1. Checked in already: the tap checks them out.
  settle();
  await walkIn(k1, solos[0]);
  check("a member checked in is checked out by the tap", (await kiosk.tap(k1)).body.next === "checked-out");

  // 2. A booking whose check-in window is open: the tap checks them in.
  settle();
  await claim(k2, solos[1], 5, 60);
  const checkedIn = await kiosk.tap(k2);
  check("a booking in its check-in window is checked into", checkedIn.body.next === "checked-in" && Boolean(checkedIn.body.reservation.checkedInAt));
  await release(k2);

  // 3. A booking later today: the kiosk asks rather than acts.
  settle();
  const k3Later = await claim(k3, solos[2], 150, 60);
  const prompt = await kiosk.tap(k3);
  check(
    "a booking later today makes the tap ask what to do with it",
    prompt.body.next === "later-today" && prompt.body.upcoming.id === String(k3Later._id) &&
      near(prompt.body.upcoming.startTime, k3Later.startTime) && !("reservation" in prompt.body)
  );
  check(
    "keeping it is offered, ending the stay as the booking starts, and saying so",
    prompt.body.options.keep.available && near(prompt.body.options.keep.latestEnd, k3Later.startTime) &&
      prompt.body.options.keep.limit === "own" && /leave by/.test(prompt.body.options.keep.sentence)
  );
  check("cancelling it is offered without that limit", prompt.body.options.cancel.available && prompt.body.options.cancel.limit !== "own");
  check("'not now' needs nothing: the tap itself changed nothing", (await Reservation.findById(k3Later._id)).status === "held" && (await live(k3)).length === 1);

  // (a) cancels and seats in ONE transaction: a refused walk-in loses nothing.
  await walkIn(k4, solos[3]);
  const intoOccupied = await kiosk.walkIn(k3, solos[3], { cancelReservationId: String(k3Later._id) });
  check(
    "option (a) into a unit someone is using is refused, and the later booking survives",
    intoOccupied.status === 409 && (await Reservation.findById(k3Later._id)).status === "held"
  );
  const pastLimit = await kiosk.walkIn(k3, solos[4], { cancelReservationId: String(k3Later._id), minutes: 300 });
  check(
    "option (a) refused AFTER its cancellation was written still keeps the booking — it rolls back with the refusal",
    pastLimit.status === 409 && pastLimit.body.code === "LIMIT" && (await Reservation.findById(k3Later._id)).status === "held"
  );
  const swapped = await kiosk.walkIn(k3, solos[4], { cancelReservationId: String(k3Later._id) });
  check(
    "option (a) checks them in now and cancels the later booking together",
    swapped.status === 201 && swapped.body.cancelled?.id === String(k3Later._id) &&
      (await Reservation.findById(k3Later._id)).status === "cancelled" &&
      (await Reservation.findById(swapped.body.reservation.id)).status === "active"
  );
  check("and the stay is not cut short by the booking it gave up", new Date(swapped.body.reservation.endTime) > k3Later.startTime);
  await release(k3);
  await release(k4);

  // (b) keeps it: the stay ends as the booking begins.
  settle();
  const k5Later = await claim(k5, solos[5], 120, 60);
  const kept = await kiosk.walkIn(k5, solos[6]);
  check(
    "option (b) checks them in now, keeps the booking, and ends the stay as it starts",
    kept.status === 201 && near(kept.body.reservation.endTime, k5Later.startTime) && kept.body.limit?.limit === "own" &&
      /leave by/.test(kept.body.limit.sentence) && (await Reservation.findById(k5Later._id)).status === "held"
  );
  await release(k5);

  // (b) needs half an hour before the booking.
  settle();
  await claim(k6, solos[7], 20, 60);
  const tooClose = await kiosk.tap(k6);
  check(
    "option (b) is withheld with fewer than 30 minutes before the booking, saying why",
    tooClose.body.next === "later-today" && !tooClose.body.options.keep.available &&
      tooClose.body.options.keep.code === "TOO_CLOSE" && /check in to it from/.test(tooClose.body.options.keep.reason)
  );
  const keepAnyway = await kiosk.walkIn(k6, solos[8]);
  check("and refused by the server, whatever the kiosk sends", keepAnyway.status === 409 && keepAnyway.body.code === "TOO_CLOSE");
  await release(k6);

  // 4. No booking: a walk-in, up to the shortest limit.
  settle();
  const fresh = await kiosk.tap(k7);
  check(
    "a member with no booking is offered a walk-in, with how long it could last",
    fresh.body.next === "walk-in" && fresh.body.walkIn.available && fresh.body.walkIn.limit === "max-stay" && !("reservation" in fresh.body)
  );
  const overMax = await kiosk.walkIn(k7, solos[9], { minutes: 300 });
  check("a stay past the maximum is refused, not quietly shortened", overMax.status === 409 && overMax.body.code === "LIMIT" && /up to 4 hours/.test(overMax.body.error));
  const oddLength = await kiosk.walkIn(k7, solos[9], { minutes: 45 });
  check("a length that is not in half hours is refused", oddLength.status === 400 && oddLength.body.code === "BAD_LENGTH");
  const anHour = await kiosk.walkIn(k7, solos[9], { minutes: 60 });
  check(
    "an hour from now is an hour from now",
    anHour.status === 201 && Math.abs(new Date(anHour.body.reservation.endTime) - new Date(anHour.body.reservation.checkedInAt) - HOUR) < 2000
  );
  await release(k7);
  const noLength = await atKiosk(k7, solos[9]);
  check("without a length, as long as allowed: the maximum stay", noLength.limit === "max-stay" && Math.abs(noLength.reservation.endTime - noLength.reservation.checkedInAt - 4 * HOUR) < 2000);
  await release(k7);

  // The unit's next booking.
  settle();
  await claim(k8, solos[10], 100, 60);
  const untilBooked = await atKiosk(k9, solos[10]);
  check("a walk-in ends when the unit's next booking starts, and says so", near(untilBooked.reservation.endTime, at(100)) && untilBooked.limit === "booking");
  await release(k9);
  await refused("asking to stay past the unit's next booking is refused", () => atKiosk(k9, solos[10], { minutes: 120 }), "LIMIT");
  const fitsBefore = await atKiosk(k9, solos[10], { minutes: 90 });
  check("a stay that fits before it is taken as asked", fitsBefore.limit === null && near(fitsBefore.reservation.endTime, new Date(+fitsBefore.reservation.checkedInAt + 90 * MINUTE)));
  await release(k9);
  await release(k8);
  settle();
  await claim(k8, solos[11], 20, 30);
  await refused("a unit booked within half an hour can't be walked into", () => atKiosk(k9, solos[11]), "TOO_SHORT");
  await release(k8);

  // A whole room ends when anything inside it is booked.
  settle();
  await claim(k8, balconyDesk, 90, 60);
  const wholeWalk = await atKiosk(k9, { id: studio.resourceId }, {}, "room");
  check("a whole room's walk-in ends when something inside it is booked, on any level", near(wholeWalk.reservation.endTime, at(90)) && wholeWalk.limit === "booking");
  await release(k9);
  await release(k8);

  // Closing time.
  settle();
  const shutsAt = new Date(Math.ceil(at(75).getTime() / MINUTE) * MINUTE);
  await setHours("00:00", hhmm(shutsAt));
  const atClosing = await atKiosk(k10, solos[12]);
  check("a walk-in ends at closing time, and says so", near(atClosing.reservation.endTime, shutsAt) && atClosing.limit === "closing");
  await release(k10);
  await refused("a stay past closing is refused", () => atKiosk(k10, solos[12], { minutes: 120 }), "LIMIT");
  await setHours("00:00", hhmm(new Date(anchor - 2 * MINUTE)));
  const afterClose = await kiosk.tap(k10);
  check(
    "after closing, the tap says walk-ins have finished",
    afterClose.body.next === "walk-in" && !afterClose.body.walkIn.available && /finished for today/.test(afterClose.body.walkIn.reason)
  );
  check("and a walk-in sent anyway is refused", (await kiosk.walkIn(k10, solos[12])).status === 409);
  await setHours("00:00", "23:59");

  // A booking on another day does not prompt.
  settle();
  const tomorrowAt10 = new Date(anchor);
  tomorrowAt10.setDate(tomorrowAt10.getDate() + 1);
  tomorrowAt10.setHours(10, 0, 0, 0);
  await claimReservation({
    organizationId: org._id, memberId: k11._id, resourceId: solos[13].id, unitLabel: "1",
    startTime: tomorrowAt10, endTime: new Date(+tomorrowAt10 + HOUR),
  });
  const otherDay = await kiosk.tap(k11);
  check(
    "a booking on another day doesn't prompt: they simply walk in",
    otherDay.body.next === "walk-in" && otherDay.body.walkIn.available && otherDay.body.walkIn.limit !== "own"
  );
  await release(k11);

  // Two kiosks giving up the same booking at the same moment.
  settle();
  const contested = await claim(k12, solos[14], 150, 60);
  const racedSwap = await Promise.all([
    kiosk.walkIn(k12, solos[15], { cancelReservationId: String(contested._id) }),
    kiosk.walkIn(k12, solos[16], { cancelReservationId: String(contested._id) }),
  ]);
  check(
    "two kiosks racing option (a) seat the member once and cancel the booking once",
    racedSwap.filter((r) => r.status === 201).length === 1 && (await live(k12)).length === 1 &&
      (await Reservation.findById(contested._id)).status === "cancelled"
  );
  await release(k12);

  // The day view's "free until" and the walk-in agree, unit by unit.
  settle();
  await claim(k13, solos[17], 110, 60);
  const kioskDay = await dayOf(ground, null);
  const promised = unitIn(kioskDay, solos[17]).freeUntil;
  const given = await atKiosk(k9, solos[17]);
  check("the kiosk's map and the walk-in agree on how long a unit is free", near(promised, given.reservation.endTime));
  await release(k9);
  await release(k13);

  console.log(`\n${passed} day checks passed; isolated database discarded.`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
