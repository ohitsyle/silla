/**
 * The day suite — what a member may hold at once (RES-3), a floor's day
 * (the map's rings and timelines, MAP-1/MAP-2), and the kiosk's paths for
 * someone who taps in with no booking or with one later today (OCC-1,
 * OCC-2).
 *
 *   npm run test:spaces     runs it after the geometry and spatial suites
 *   node tests/day.test.mjs this suite alone
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
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { keepClear } from "./clock.mjs";

process.env.JWT_SECRET = "isolated-day-tests-only";
process.env.NODE_ENV = "test";

const moved = keepClear({ ahead: 6, behind: 2 });
if (moved) console.log(`(this suite's clock moved to ${moved}: its scenarios need hours of today on both sides of now)`);

const { createApp } = await import("../src/app.js");
const { default: Organization } = await import("../src/models/Organization.js");
const { default: Site } = await import("../src/models/Site.js");
const { default: User } = await import("../src/models/User.js");
const { default: ResourceType } = await import("../src/models/ResourceType.js");
const { default: Reservation } = await import("../src/models/Reservation.js");
const {
  cancelReservation, claimReservation, reservationAvailability,
} = await import("../src/services/reservations/index.js");
const { assignWalkIn, checkIn, checkOut } = await import("../src/services/reservations/occupancy.js");
const { MINUTE } = await import("./helpers.mjs");

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

  const app = createApp();
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
  check("the refusal names the booking that holds the place", /Focus desk · 1/.test(secondNow.message) && /for now/.test(secondNow.message));
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

  console.log(`\n${passed} day checks passed; isolated database discarded.`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replica.stop();
}
