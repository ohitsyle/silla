/**
 * RES-1..RES-7 and OCC-1..OCC-6 — the reservation engine and the
 * physical loop. RES-2's atomic claim is the one that matters most, so
 * it is tested under genuine concurrency rather than in sequence.
 */
import {
  req, auth, makeMember, window, nowWindow, clearOfMidnight, firstFloor, layoutOf, availableUnits,
  adminToken, withOpenHours, ORG,
} from "./helpers.mjs";

export const name = "Reservation engine & physical loop";

export async function run(check) {
  const floor = await firstFloor();
  const layout = await layoutOf(floor.id);
  const free = availableUnits(layout);
  if (free.length < 12) throw new Error(`need ~12 free units, found ${free.length} — run npm run seed:layout`);

  /* ── RES-1: PIN confirmation (spec §5 — card plus PIN to reserve) ── */
  const alice = await makeMember("alice");
  const target = free[0];

  const noPin = await req("/api/reservations", { method: "POST", headers: auth(alice.token),
    body: JSON.stringify({ resourceId: target.resourceId, unitLabel: target.unitLabel, ...window() }) });
  check("RES-1", "A reservation without a PIN is refused", noPin.status === 400, noPin.body?.error);

  const wrongPin = await req("/api/reservations", { method: "POST", headers: auth(alice.token),
    body: JSON.stringify({ resourceId: target.resourceId, unitLabel: target.unitLabel, ...window(), pin: "999999" }) });
  check("RES-1", "A wrong PIN is refused", wrongPin.status === 401, wrongPin.body?.error);

  const held = await req("/api/reservations", { method: "POST", headers: auth(alice.token),
    body: JSON.stringify({ resourceId: target.resourceId, unitLabel: target.unitLabel, ...window(), pin: alice.pin }) });
  check("RES-1", "The correct PIN holds the resource",
    held.status === 201 && held.body?.reservation?.status === "held", `status ${held.status}`);

  const after = await layoutOf(floor.id);
  const idx = after.layout.resources.find((r) => r.id === target.resourceId)
    .units.findIndex((u) => u.label === target.unitLabel);
  check("MAP-1", "A future hold leaves the seat available right now",
    after.status[target.resourceId][idx].status === "available",
    after.status[target.resourceId][idx].status);

  /* ── RES-3: self-only, one active ── */
  const second = await req("/api/reservations", { method: "POST", headers: auth(alice.token),
    body: JSON.stringify({ resourceId: free[1].resourceId, unitLabel: free[1].unitLabel, ...window(3), pin: alice.pin }) });
  check("RES-3", "A second concurrent reservation is refused",
    second.status === 409 && second.body?.code === "ALREADY_HOLDING", second.body?.error);

  /* ── RES-2: the atomic claim, under real concurrency ── */
  const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => makeMember(`race${i}`)));
  const contested = free[2];
  const w = window(5);
  const results = await Promise.all(racers.map((m) =>
    req("/api/reservations", { method: "POST", headers: auth(m.token), body: JSON.stringify({
      resourceId: contested.resourceId, unitLabel: contested.unitLabel, ...w, pin: m.pin }) })));

  const won = results.filter((r) => r.status === 201);
  const lost = results.filter((r) => r.status === 409);
  check("RES-2", "Exactly one of 8 simultaneous claims wins", won.length === 1,
    `${won.length} won / ${lost.length} rejected`);
  check("RES-2", "Every loser gets a clear 409, never a 500",
    lost.length === 7 && lost.every((r) => r.body?.error), lost[0]?.body?.error);

  const overlapper = await makeMember("overlap");
  const mid = new Date(new Date(w.startTime).getTime() + 3600_000);
  const partial = await req("/api/reservations", { method: "POST", headers: auth(overlapper.token),
    body: JSON.stringify({ resourceId: contested.resourceId, unitLabel: contested.unitLabel,
      startTime: mid.toISOString(), endTime: new Date(mid.getTime() + 3600_000).toISOString(),
      pin: overlapper.pin }) });
  check("RES-2", "A partially-overlapping window is rejected",
    partial.status === 409 && partial.body?.code === "CONFLICT", partial.body?.error);

  const later = await makeMember("later");
  const nonOverlap = await req("/api/reservations", { method: "POST", headers: auth(later.token),
    body: JSON.stringify({ resourceId: contested.resourceId, unitLabel: contested.unitLabel,
      ...window(8, 1), pin: later.pin }) });
  check("RES-2", "A NON-overlapping window on the same unit is still allowed",
    nonOverlap.status === 201, `status ${nonOverlap.status} ${nonOverlap.body?.error || ""}`);

  /* ── RES-5 / RES-7: policy gates ── */
  const policyMember = await makeMember("policy");
  const tooLong = await req("/api/reservations", { method: "POST", headers: auth(policyMember.token),
    body: JSON.stringify({ resourceId: free[5].resourceId, unitLabel: free[5].unitLabel,
      ...window(0, 9), pin: policyMember.pin }) });
  check("RES-5", "Exceeding the org's max-stay cap is rejected",
    tooLong.status === 400 && tooLong.body?.code === "MAX_STAY", tooLong.body?.error);

  const night = new Date(); night.setDate(night.getDate() + 3); night.setHours(23, 0, 0, 0);
  const outside = await req("/api/reservations", { method: "POST", headers: auth(policyMember.token),
    body: JSON.stringify({ resourceId: free[5].resourceId, unitLabel: free[5].unitLabel,
      startTime: night.toISOString(), endTime: new Date(night.getTime() + 3600_000).toISOString(),
      pin: policyMember.pin }) });
  check("RES-7", "A window outside operating hours is rejected", outside.status === 400, outside.body?.error);

  /* ── OCC-1/3/6 and OCC-2: the physical loop, which needs "now" ── */
  // Seconds before midnight there is no same-day window left to book, so
  // the block waits for the date to turn rather than fail on a correct rule.
  await clearOfMidnight();
  const admin = await adminToken();
  const restore = await withOpenHours(admin);
  try {
    const bob = await makeMember("bob");
    const spot = free[10];
    // Started a minute ago so the tap lands inside the grace period; ends
    // within today, because a booking may not span two days.
    const booked = await req("/api/reservations", { method: "POST", headers: auth(bob.token),
      body: JSON.stringify({ resourceId: spot.resourceId, unitLabel: spot.unitLabel,
        ...nowWindow(), pin: bob.pin }) });
    check("RES-1", "Booked a now-window for the tap test", booked.status === 201, booked.body?.error || "");

    const tapIn = await req("/api/checkin/tap", { method: "POST",
      body: JSON.stringify({ organizationId: ORG, credential: bob.card }) });
    check("OCC-1", "A tap activates the held reservation",
      tapIn.body?.next === "checked-in" && Boolean(tapIn.body?.reservation?.checkedInAt), tapIn.body?.next);

    const dupe = await req("/api/checkin/tap", { method: "POST",
      body: JSON.stringify({ organizationId: ORG, credential: bob.card }) });
    check("OCC-6", "An immediate second tap is absorbed as a duplicate",
      dupe.body?.next === "duplicate-tap", dupe.body?.next);

    const occupied = await layoutOf(floor.id);
    const oi = occupied.layout.resources.find((r) => r.id === spot.resourceId)
      .units.findIndex((u) => u.label === spot.unitLabel);
    check("OCC-1", "The map shows the unit occupied after check-in",
      occupied.status[spot.resourceId][oi].status === "occupied");

    await new Promise((r) => setTimeout(r, 5200)); // clear the 5s duplicate window
    const tapOut = await req("/api/checkin/tap", { method: "POST",
      body: JSON.stringify({ organizationId: ORG, credential: bob.card }) });
    check("OCC-3", "The next tap checks the member out", tapOut.body?.next === "checked-out", tapOut.body?.next);

    const freed = await layoutOf(floor.id);
    check("OCC-3", "The map frees the unit immediately",
      freed.status[spot.resourceId][oi].status === "available");

    /* OCC-2: walk-in */
    const carol = await makeMember("carol");
    const offered = await req("/api/checkin/tap", { method: "POST",
      body: JSON.stringify({ organizationId: ORG, credential: carol.card }) });
    check("OCC-2", "A member with no reservation is offered walk-in", offered.body?.next === "walk-in");

    const open = availableUnits(await layoutOf(floor.id))[0];
    const assigned = await req("/api/checkin/walkin", { method: "POST", body: JSON.stringify({
      organizationId: ORG, credential: carol.card,
      resourceId: open.resourceId, unitLabel: open.unitLabel }) });
    check("OCC-2", "Walk-in assigns the chosen open resource on the spot",
      assigned.status === 201 && Boolean(assigned.body?.reservation?.checkedInAt), `status ${assigned.status}`);
  } finally {
    await restore();
  }
}
