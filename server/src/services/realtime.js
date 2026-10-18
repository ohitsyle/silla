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
 * Something on a floor's DAY changed — a booking made or cancelled for
 * later, a check-in, a no-show released, a closure — which the `status`
 * half cannot show: a booking for 3 PM changes no colour at 9 AM. The
 * event carries only the floor; a map showing it re-reads its day
 * (GET /api/floors/:id/day), so nothing about who booked what is pushed
 * to everyone watching.
 */
export const DAY_CHANGED_EVENT = "floor:day";

/**
 * @param {import("socket.io").Server|null} io  may be null in scripts and
 *        tests, where there is no HTTP server — emitting is then a no-op
 *        rather than a crash, so the engine stays usable outside the API.
 */
export function emitUnitStatus(io, { floorId, resourceId, units }) {
  if (!io || !floorId || !resourceId) return;
  io.to(FLOOR_ROOM(floorId)).emit(UNIT_STATUS_EVENT, { resourceId, units });
}

/** Tell every map showing these floors that their day has changed. */
export function emitDayChanged(io, floorIds) {
  if (!io) return;
  for (const floorId of new Set((floorIds || []).filter(Boolean).map(String))) {
    io.to(FLOOR_ROOM(floorId)).emit(DAY_CHANGED_EVENT, { floorId });
  }
}

/** Broadcast an org-wide notice (ADM-5 status changes, closures). */
export function emitOrgNotice(io, { organizationId, type, message }) {
  if (!io || !organizationId) return;
  io.emit("org:notice", { organizationId, type, message });
}
