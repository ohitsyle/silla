/**
 * ADM-1..ADM-5, RPT-1, MAP-2 and MAP-4/5 — the admin surface, reports,
 * card reissue and real-time status.
 */
import {
  req, auth, adminToken, makeMember, firstFloor, layoutOf, uid, unique, ORG, TEST_EMAIL_DOMAIN,
} from "./helpers.mjs";

export const name = "Admin surface, reports & real-time";

export async function run(check) {
  const token = await adminToken();
  const A = auth(token);
  const floor = await firstFloor();

  /* ── ADM-1 ── */
  const dash = await req(`/api/admin/dashboard?floorId=${floor.id}`, { headers: A });
  check("ADM-1", "The dashboard returns occupancy metrics",
    dash.status === 200 && typeof dash.body?.metrics?.total === "number",
    `open ${dash.body?.metrics?.open}/${dash.body?.metrics?.total}`);
  check("ADM-1", "Overstays carry resource ids so the metric is clickable",
    Array.isArray(dash.body?.overstays) && dash.body.overstays.every((o) => o.resourceId && o.position));

  /* ── ADM-2 ── */
  const resources = await req(`/api/admin/resources?floorId=${floor.id}`, { headers: A });
  check("ADM-2", "Resources are grouped by zone, membership derived from position",
    resources.status === 200 && resources.body.groups.length >= 2,
    resources.body?.groups?.map((g) => `${g.zoneName}(${g.resources.length})`).join(" "));
  check("ADM-2", "Unzoned resources are grouped separately",
    resources.body.groups.some((g) => g.zoneName === "Unzoned"));

  const someResource = resources.body.groups.flatMap((g) => g.resources)[0];
  const history = await req(`/api/admin/resources/${someResource.id}/history`, { headers: A });
  check("ADM-2", "Per-resource schedule and history are available",
    history.status === 200 && Array.isArray(history.body.schedule) && Array.isArray(history.body.history));

  /* ── ADM-3: members, PIN reset, card reissue (spec §7) ── */
  const member = await makeMember("adm3");
  const search = await req(`/api/admin/members?q=adm3`, { headers: A });
  check("ADM-3", "Member search returns matches with their current session",
    search.status === 200 && search.body.members.some((m) => m.email === member.email));

  const found = search.body.members.find((m) => m.email === member.email);
  const newCard = uid();
  const reissued = await req(`/api/admin/members/${found.id}/reissue-card`, { method: "POST", headers: A,
    body: JSON.stringify({ cardUid: newCard }) });
  check("ADM-3", "Reissue rebinds the account to a new card",
    reissued.status === 200 && reissued.body.cardUid === newCard);

  const oldTap = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: member.card }) });
  check("ADM-3", "The OLD card no longer resolves — it is invalidated",
    oldTap.body?.outcome === "unregistered", oldTap.body?.outcome);
  const newTap = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: newCard }) });
  check("ADM-3", "The NEW card resolves to the same member", newTap.body?.member?.id === found.id);

  const other = await makeMember("adm3other");
  const clash = await req(`/api/admin/members/${found.id}/reissue-card`, { method: "POST", headers: A,
    body: JSON.stringify({ cardUid: other.card }) });
  check("ADM-3", "Reissue refuses a card already bound to someone else",
    clash.status === 409, clash.body?.error);

  const resetPin = await req(`/api/admin/members/${found.id}/reset-pin`, { method: "POST", headers: A });
  check("ADM-3", "Staff PIN reset issues a temporary PIN",
    resetPin.status === 200 && Boolean(resetPin.body?.temporaryPin));

  /* ── ADM-4: the founding superadmin is protected ── */
  const staffList = await req("/api/admin/staff", { headers: A });
  const founder = staffList.body.staff.find((s) => s.email === "admin@demo.test");
  const demote = await req(`/api/admin/staff/${founder.id}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ role: "staff" }) });
  check("ADM-4", "The founding superadmin cannot be demoted", demote.status === 403, demote.body?.error);
  const deactivate = await req(`/api/admin/staff/${founder.id}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ active: false }) });
  check("ADM-4", "The founding superadmin cannot be deactivated", deactivate.status === 403);

  /* ── ADM-5: settings, status enforcement, closures ── */
  const settings = await req("/api/admin/settings", { headers: A });
  check("ADM-5", "Settings expose the full white-label config",
    Boolean(settings.body?.organization?.terminology) && Boolean(settings.body?.organization?.branding));

  const badHours = await req("/api/admin/settings", { method: "PATCH", headers: A,
    body: JSON.stringify({ policy: { operatingHours: { open: "9am" } } }) });
  check("ADM-5", "An invalid operating-hours value is rejected", badHours.status === 400, badHours.body?.error);

  // RES-7: org status is enforced against the engine.
  await req("/api/admin/settings", { method: "PATCH", headers: A, body: JSON.stringify({ status: "closed" }) });
  const blocked = await makeMember("closedtest");
  const layout = await layoutOf(floor.id);
  const open = layout.layout.resources.flatMap((r) =>
    r.units.map((u, i) => ({ resourceId: r.id, unitLabel: u.label, s: layout.status[r.id][i].status }))
  ).find((u) => u.s === "available");
  const day = new Date(); day.setDate(day.getDate() + 5); day.setHours(11, 0, 0, 0);
  const whileClosed = await req("/api/reservations", { method: "POST", headers: auth(blocked.token),
    body: JSON.stringify({ resourceId: open.resourceId, unitLabel: open.unitLabel,
      startTime: day.toISOString(), endTime: new Date(day.getTime() + 3600_000).toISOString(),
      pin: blocked.pin }) });
  check("RES-7", "Org status 'closed' blocks the reservation engine",
    whileClosed.status === 409 && whileClosed.body?.code === "ORG_CLOSED", whileClosed.body?.error);
  await req("/api/admin/settings", { method: "PATCH", headers: A, body: JSON.stringify({ status: "open" }) });

  const closure = await req("/api/admin/closures", { method: "POST", headers: A, body: JSON.stringify({
    startTime: new Date(day.getTime() - 3600_000).toISOString(),
    endTime: new Date(day.getTime() + 7200_000).toISOString(),
    reason: "Scheduled maintenance" }) });
  check("ADM-5", "A superadmin schedules a closure with a reason", closure.status === 201);

  const blockedByClosure = await req("/api/reservations", { method: "POST", headers: auth(blocked.token),
    body: JSON.stringify({ resourceId: open.resourceId, unitLabel: open.unitLabel,
      startTime: day.toISOString(), endTime: new Date(day.getTime() + 3600_000).toISOString(),
      pin: blocked.pin }) });
  check("RES-7", "A scheduled closure blocks booking in that window",
    blockedByClosure.status === 409, blockedByClosure.body?.error);
  await req(`/api/admin/closures/${closure.body.closure.id}`, { method: "DELETE", headers: A });

  /* ── MAP-4 / MAP-5: zones and labels ── */
  const zone = await req("/api/resources/zones", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: floor.id, name: `Zone ${unique().slice(-4)}`, col: 0, row: 0, w: 3, h: 2 }) });
  check("MAP-4", "A named zone rectangle is created", zone.status === 201);
  const label = await req("/api/resources/labels", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: floor.id, text: `Label ${unique().slice(-4)}`, col: 1, row: 1 }) });
  check("MAP-5", "A free-typed label is placed", label.status === 201);

  const withBoth = await layoutOf(floor.id);
  check("MAP-4", "The zone appears in the layout payload",
    withBoth.layout.zones.some((z) => z.id === zone.body.zone.id));
  check("MAP-5", "The label appears in the layout payload",
    withBoth.layout.labels.some((l) => l.id === label.body.label.id));
  await req(`/api/resources/zones/${zone.body.zone.id}`, { method: "DELETE", headers: A });
  await req(`/api/resources/labels/${label.body.label.id}`, { method: "DELETE", headers: A });

  /* ── RPT-1 and export ── */
  const reports = await req("/api/admin/reports?days=30", { headers: A });
  check("RPT-1", "Reports return peak hour, no-show and overstay rates",
    reports.status === 200 && typeof reports.body?.noShowRate === "number" &&
    Array.isArray(reports.body?.reservationsByHour) && reports.body.reservationsByHour.length === 24,
    `peak ${reports.body?.peakHour}`);

  const csv = await req("/api/admin/export?days=30", { headers: A });
  check("ADM-5", "Manual export produces CSV with a header row",
    csv.status === 200 && String(csv.body).startsWith("reservation_id,member_id"));

  /* ── MAP-2: layout and status are separate, and only status streams ── */
  const payload = await layoutOf(floor.id);
  check("MAP-2", "The layout payload separates layout from status",
    Boolean(payload.layout) && Boolean(payload.status) &&
    !JSON.stringify(payload.layout).includes('"status"'),
    "layout carries no status field");
  check("MAP-1", "Overstay is withheld from anonymous viewers",
    Object.values(payload.status).flat().every((u) => !("overstay" in u)));
  const asStaff = (await req(`/api/floors/${floor.id}/layout`, { headers: A })).body;
  check("MAP-1", "…and present for staff",
    Object.values(asStaff.status).flat().every((u) => "overstay" in u));
}
