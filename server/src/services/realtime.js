/**
 * MAP-2 — real-time map updates (spec §12, §17).
 *
 * "Socket.io pushes status changes; Layout and live status kept
 * separate."
 *
 * The separation is already structural: GET /api/floors/:id/layout
 * returns `layout` (slow) and `status` (fast) as sibling objects, and
 * SpaceMap takes them as separate props. This module only ever emits the
 * `status` half — one entry of that map, keyed by resource id. A client
 * receiving it replaces that entry and re-renders; the layout it fetched
 * once is never re-sent.
 *
 * server.js already rooms clients per floor (`floor:join`), so a status
 * change only reaches people looking at that floor.
 */

export const FLOOR_ROOM = (floorId) => `floor:${floorId}`;
export const UNIT_STATUS_EVENT = "resource:status";

/**
 * @param {import("socket.io").Server|null} io  may be null in scripts and
 *        tests, where there is no HTTP server — emitting is then a no-op
 *        rather than a crash, so the engine stays usable outside the API.
 */
export function emitUnitStatus(io, { floorId, resourceId, units }) {
  if (!io || !floorId || !resourceId) return;
  io.to(FLOOR_ROOM(floorId)).emit(UNIT_STATUS_EVENT, { resourceId, units });
}

/** Broadcast an org-wide notice (ADM-5 status changes, closures). */
export function emitOrgNotice(io, { organizationId, type, message }) {
  if (!io || !organizationId) return;
  io.emit("org:notice", { organizationId, type, message });
}
