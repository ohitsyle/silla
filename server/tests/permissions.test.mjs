/**
 * The role model (spec §14). Staff OPERATE the space; the superadmin
 * DEFINES it. These are the gates that keep that true, so they are
 * asserted from the outside rather than trusted from the UI.
 */
import { req, auth, login, makeMember, adminToken, firstFloor, layoutOf, unique, ORG, TEST_EMAIL_DOMAIN, foreignFloor } from "./helpers.mjs";

export const name = "Role permissions";

export async function run(check) {
  const admin = await adminToken();
  const A = auth(admin);

  // A throwaway staff account, so the suite never consumes the seeded
  // one's single terms gate.
  const staffEmail = `perm-staff-${unique()}${TEST_EMAIL_DOMAIN}`;
  const created = await req("/api/admin/staff", { method: "POST", headers: A,
    body: JSON.stringify({ firstName: "Perm", lastName: "Staff", email: staffEmail, role: "staff" }) });
  const firstLogin = await login(staffEmail, created.body.temporaryPin);
  await req("/api/auth/change-pin", { method: "POST", headers: auth(firstLogin.token),
    body: JSON.stringify({ currentPin: created.body.temporaryPin, newPin: "191919" }) });
  const staffSession = await login(staffEmail, "191919");
  const S = auth(staffSession.token);

  const member = await makeMember("permmember");
  const M = auth(member.token);

  const floor = await firstFloor();
  const layout = await layoutOf(floor.id);
  const piece = layout.layout.resources[0];
  const serviceable = layout.layout.resources.find((r) =>
    layout.resourceTypes.find((t) => t.id === r.resourceType)?.hasServiceStatus);

  /* ── Staff: may run the space ── */
  const setUnavailable = await req(`/api/admin/resources/${piece.id}/units/${piece.units[0].label}`,
    { method: "PATCH", headers: S, body: JSON.stringify({ status: "unavailable" }) });
  check("ADM-2", "Staff CAN mark a unit unavailable", setUnavailable.status === 200, `status ${setUnavailable.status}`);
  await req(`/api/admin/resources/${piece.id}/units/${piece.units[0].label}`,
    { method: "PATCH", headers: S, body: JSON.stringify({ status: "available" }) });

  const oos = await req(`/api/admin/resources/${serviceable.id}/units/${serviceable.units[0].label}`,
    { method: "PATCH", headers: S, body: JSON.stringify({ serviceStatus: "out_of_service" }) });
  check("ADM-2", "Staff CAN mark a machine out of service", oos.status === 200, `status ${oos.status}`);
  check("ADM-2", "Out of service cascades the unit to unavailable",
    oos.body?.unit?.status === "unavailable", oos.body?.unit?.status);
  await req(`/api/admin/resources/${serviceable.id}/units/${serviceable.units[0].label}`,
    { method: "PATCH", headers: S, body: JSON.stringify({ serviceStatus: "working", status: "available" }) });

  const derived = await req(`/api/admin/resources/${piece.id}/units/${piece.units[0].label}`,
    { method: "PATCH", headers: S, body: JSON.stringify({ status: "occupied" }) });
  check("ADM-2", "Nobody can hand-set a derived status (occupied/reserved)", derived.status === 400, derived.body?.error);

  /* ── Staff: may NOT redraw the space ── */
  const place = await req("/api/resources", { method: "POST", headers: S,
    body: JSON.stringify({ floorId: floor.id, resourceTypeKey: "chair", col: 0, row: 0 }) });
  check("MAP-3", "Staff CANNOT place a piece", place.status === 403, `status ${place.status}`);

  const remove = await req(`/api/resources/${piece.id}`, { method: "DELETE", headers: S });
  check("MAP-3", "Staff CANNOT remove a piece", remove.status === 403, `status ${remove.status}`);

  const zone = await req("/api/resources/zones", { method: "POST", headers: S,
    body: JSON.stringify({ floorId: floor.id, name: "Nope", col: 0, row: 0, w: 2, h: 2 }) });
  check("MAP-4", "Staff CANNOT draw a zone", zone.status === 403, `status ${zone.status}`);

  const addFloor = await req("/api/floors", { method: "POST", headers: S,
    body: JSON.stringify({ name: "Staff Floor", grid: { cols: 5, rows: 5 } }) });
  check("INF-1", "Staff CANNOT add a floor", addFloor.status === 403, `status ${addFloor.status}`);

  const resize = await req(`/api/floors/${floor.id}`, { method: "PATCH", headers: S,
    body: JSON.stringify({ grid: { cols: 30, rows: 20 } }) });
  check("INF-1", "Staff CANNOT resize a room", resize.status === 403, `status ${resize.status}`);

  const staffMgmt = await req("/api/admin/staff", { headers: S });
  check("ADM-4", "Staff CANNOT reach staff management", staffMgmt.status === 403, `status ${staffMgmt.status}`);

  const settings = await req("/api/admin/settings", { headers: S });
  check("ADM-5", "Staff CANNOT reach org settings", settings.status === 403, `status ${settings.status}`);

  /* ── Member: none of it ── */
  const memberPlace = await req("/api/resources", { method: "POST", headers: M,
    body: JSON.stringify({ floorId: floor.id, resourceTypeKey: "chair", col: 0, row: 0 }) });
  check("MAP-3", "A member CANNOT place a piece", memberPlace.status === 403);
  const memberUnit = await req(`/api/admin/resources/${piece.id}/units/1`, { method: "PATCH", headers: M,
    body: JSON.stringify({ status: "unavailable" }) });
  check("ADM-2", "A member CANNOT change availability", memberUnit.status === 403);
  const anon = await req("/api/admin/dashboard");
  check("ADM-1", "The admin surface refuses unauthenticated callers", anon.status === 401);

  /* ── Superadmin: full structural control, with guards ── */
  const placed = await req("/api/resources", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: floor.id, resourceTypeKey: "chair", col: 0, row: 0 }) });
  check("MAP-3", "Superadmin CAN place a piece", placed.status === 201, `status ${placed.status}`);

  if (placed.status === 201) {
    const overlap = await req("/api/resources", { method: "POST", headers: A,
      body: JSON.stringify({ floorId: floor.id, resourceTypeKey: "chair", col: 0, row: 0 }) });
    check("MAP-3", "Overlap is prevented by the occupied-cell check", overlap.status === 409, overlap.body?.error);
    const deleted = await req(`/api/resources/${placed.body.resource.id}`, { method: "DELETE", headers: A });
    check("MAP-3", "Superadmin CAN remove a piece", deleted.status === 200);
  }

  const newFloor = await req("/api/floors", { method: "POST", headers: A,
    body: JSON.stringify({ name: `Test Level ${unique().slice(-4)}`, grid: { cols: 8, rows: 6 } }) });
  check("INF-1", "Superadmin CAN add a floor", newFloor.status === 201,
    `${newFloor.body?.floor?.grid?.cols}x${newFloor.body?.floor?.grid?.rows}`);

  if (newFloor.status === 201) {
    const id = newFloor.body.floor.id;
    const resized = await req(`/api/floors/${id}`, { method: "PATCH", headers: A,
      body: JSON.stringify({ grid: { cols: 14, rows: 10 }, name: "Resized" }) });
    check("INF-1", "Superadmin CAN resize and rename a room",
      resized.status === 200 && resized.body?.floor?.grid?.cols === 14);

    const badGrid = await req(`/api/floors/${id}`, { method: "PATCH", headers: A,
      body: JSON.stringify({ grid: { cols: 0, rows: 10 } }) });
    check("INF-1", "An invalid grid size is rejected", badGrid.status === 400, badGrid.body?.error);

    const removed = await req(`/api/floors/${id}`, { method: "DELETE", headers: A });
    check("INF-1", "Superadmin CAN delete an empty floor", removed.status === 200);
  }

  const shrink = await req(`/api/floors/${floor.id}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ grid: { cols: 5, rows: 5 } }) });
  check("INF-1", "Shrinking a room that would orphan pieces is refused",
    shrink.status === 409 && Array.isArray(shrink.body?.outside), shrink.body?.error);

  const deletePopulated = await req(`/api/floors/${floor.id}`, { method: "DELETE", headers: A });
  check("INF-1", "Deleting a populated floor is refused", deletePopulated.status === 409, deletePopulated.body?.error);

  /* ── ADM-4: standing is re-read per request, not trusted from the token ──
   *
   * A 12h token is proof of a past login. These assert it does not
   * outlive the account's present standing: deactivation used to leave
   * the holder full admin access (member PII, PIN resets, card reissue)
   * until the token expired, and a demotion left the old role in the
   * signature just as long. Both are precisely the moves made when
   * someone leaves or an account is compromised, so they are asserted
   * from the outside like every other gate here.
   *
   * Uses its own throwaway accounts — deactivating the suite's shared
   * staff session would break every check after it.
   */
  /* ── Cross-organization isolation ──
   *
   * The portal provisions a deployment per buyer, so more than one
   * organization really does share a database now. Floors hang off
   * sites and sites carry the organization, which makes a bare
   * Floor.findById look org-scoped without being it. These assert that
   * a superadmin cannot write onto a floor they do not own — the map
   * reads by floor, so anything placed there renders on the victim's
   * map, and a piece carries a resourceType their catalog lacks.
   *
   * 404, not 403: whether that id exists elsewhere is not our caller's
   * business.
   */
  const foreign = await foreignFloor();

  const foreignPiece = await req("/api/resources", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: foreign.floorId, resourceTypeKey: layout.resourceTypes[0].key, col: 0, row: 0 }) });
  check("MAP-3", "A piece cannot be placed on another organization's floor",
    foreignPiece.status === 404, `status ${foreignPiece.status} — a 201 here writes onto another deployment's map`);

  const foreignZone = await req("/api/resources/zones", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: foreign.floorId, name: "Intruder", col: 0, row: 0, w: 2, h: 2 }) });
  check("MAP-4", "A zone cannot be drawn on another organization's floor",
    foreignZone.status === 404, `status ${foreignZone.status}`);

  const foreignLabel = await req("/api/resources/labels", { method: "POST", headers: A,
    body: JSON.stringify({ floorId: foreign.floorId, text: "Intruder", col: 1, row: 1 }) });
  check("MAP-5", "A label cannot be placed on another organization's floor",
    foreignLabel.status === 404, `status ${foreignLabel.status}`);

  const foreignResize = await req(`/api/floors/${foreign.floorId}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ grid: { cols: 4, rows: 4 } }) });
  check("INF-1", "Another organization's floor cannot be resized",
    foreignResize.status === 404, `status ${foreignResize.status}`);

  const foreignDelete = await req(`/api/floors/${foreign.floorId}`, { method: "DELETE", headers: A });
  check("INF-1", "Another organization's floor cannot be deleted",
    foreignDelete.status === 404, `status ${foreignDelete.status}`);

  const revokedEmail = `revoked-${unique()}${TEST_EMAIL_DOMAIN}`;
  const revoked = await req("/api/admin/staff", { method: "POST", headers: A,
    body: JSON.stringify({ firstName: "Revoked", lastName: "Staff", email: revokedEmail, role: "staff" }) });
  const revokedSession = await login(revokedEmail, revoked.body.temporaryPin);
  const R = auth(revokedSession.token);

  const beforeOff = await req("/api/admin/dashboard", { headers: R });
  check("ADM-4", "A live staff token reaches the admin surface", beforeOff.status === 200, `status ${beforeOff.status}`);

  await req(`/api/admin/staff/${revoked.body.staff.id}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ active: false }) });

  const afterOff = await req("/api/admin/dashboard", { headers: R });
  check("ADM-4", "Deactivation revokes the token already issued", afterOff.status === 401,
    `status ${afterOff.status} — a 200 here means deactivation is a no-op until the token expires`);

  const pii = await req("/api/admin/members", { headers: R });
  check("ADM-4", "…including the member directory", pii.status === 401, `status ${pii.status}`);

  const reLogin = await req("/api/auth/login", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, email: revokedEmail, pin: revoked.body.temporaryPin }) });
  check("ADM-4", "…and they cannot log back in", reLogin.status === 401, `status ${reLogin.status}`);

  const demotedEmail = `demoted-${unique()}${TEST_EMAIL_DOMAIN}`;
  const demoted = await req("/api/admin/staff", { method: "POST", headers: A,
    body: JSON.stringify({ firstName: "Demoted", lastName: "Admin", email: demotedEmail, role: "superadmin" }) });
  const demotedSession = await login(demotedEmail, demoted.body.temporaryPin);
  const D = auth(demotedSession.token);

  const beforeDemotion = await req("/api/floors", { method: "POST", headers: D,
    body: JSON.stringify({ name: `Demo Level ${unique().slice(-4)}`, grid: { cols: 6, rows: 6 } }) });
  check("ADM-4", "A superadmin token reaches the structural routes", beforeDemotion.status === 201);
  if (beforeDemotion.status === 201) {
    await req(`/api/floors/${beforeDemotion.body.floor.id}`, { method: "DELETE", headers: A });
  }

  await req(`/api/admin/staff/${demoted.body.staff.id}`, { method: "PATCH", headers: A,
    body: JSON.stringify({ role: "staff" }) });

  const afterDemotion = await req("/api/floors", { method: "POST", headers: D,
    body: JSON.stringify({ name: `Should Not Exist ${unique().slice(-4)}`, grid: { cols: 6, rows: 6 } }) });
  check("ADM-4", "Demotion takes effect on the token already issued", afterDemotion.status === 403,
    `status ${afterDemotion.status} — a 201 here means the stale role claim still grants superadmin`);
  if (afterDemotion.status === 201) {
    await req(`/api/floors/${afterDemotion.body.floor.id}`, { method: "DELETE", headers: A });
  }
}
