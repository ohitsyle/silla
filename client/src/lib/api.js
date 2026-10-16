import { adoptLegacyToken, readToken } from "./session.js";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

/**
 * The organization this page serves, set once at boot (App.jsx) — one
 * page load serves exactly one organization. Requests carry THAT
 * organization's session and no other (lib/session.js).
 */
let sessionOrganizationId = null;
export function bindOrganization(organizationId) {
  sessionOrganizationId = organizationId ? String(organizationId) : null;
  adoptLegacyToken(sessionOrganizationId);
}

/**
 * Answers that mean this page's picture of the plan is out of date: it
 * offered something the plan no longer includes, or the organization was
 * paused since the page loaded. OrgProvider listens for this event and
 * re-reads the organization, so the banners and upgrade prompts catch up
 * with the server instead of the next person meeting the same error.
 * (PLAN_LIMIT is not one: a limit is reached by usage, which the config
 * does not carry, not by the plan changing.)
 */
export const PLAN_CHANGED_EVENT = "silla:plan-changed";
const STALE_PLAN = new Set(["PLAN_FEATURE", "ORG_SUSPENDED"]);

/**
 * One request, answered or thrown. A thrown error carries:
 *
 *   message  the server's own sentence — written for the person who hit
 *            it, so screens can show it as it is
 *   status   the HTTP status (0 when the server could not be reached)
 *   code     the server's stable code: PLAN_LIMIT, PLAN_FEATURE,
 *            ORG_SUSPENDED, BUSY, …, or "NETWORK"
 *   details  everything else the server sent: { limit, max, used },
 *            { feature }, { retryAfterSeconds }, { attemptsRemaining }, …
 *   body     the whole answer, as before
 *
 * The kiosk and login flows branch on these — a 403 with
 * requiresVerification means "resume ID-2", a 429 carries
 * retryAfterSeconds, a failed code entry carries attemptsRemaining.
 * Collapsing all of that into a message string would make those flows
 * impossible to build correctly.
 */
async function send(path, options = {}) {
  const token = readToken(sessionOrganizationId);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    // No answer at all. The browser's own words ("Failed to fetch") mean
    // nothing to the person reading them.
    const error = new Error("We couldn't reach the service. Check your connection and try again.");
    Object.assign(error, { status: 0, code: "NETWORK", details: {}, body: {} });
    throw error;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const { error: message, code = null, ...details } = body;
    const error = new Error(message || `Request failed: ${res.status}`);
    Object.assign(error, { status: res.status, code, details, body });
    if (STALE_PLAN.has(code) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT, { detail: { code } }));
    }
    throw error;
  }
  return res;
}

async function request(path, options = {}) {
  return (await send(path, options)).json();
}

export const api = {
  getOrgConfig: (orgId) => request(`/api/organizations/${orgId}/config`),
  // How the app finds its organization from the address it was opened at
  // (<product>/<slug>/…). The same config, found by slug instead of id.
  getOrgConfigBySlug: (slug) => request(`/api/organizations/by-slug/${encodeURIComponent(slug)}/config`),
  login: (organizationId, email, pin) =>
    request(`/api/auth/login`, { method: "POST", body: JSON.stringify({ organizationId, email, pin }) }),

  // MAP-1 — the floor switcher's list, and the one read that boots the map.
  // getFloorLayout returns { floor, resourceTypes, layout, status }: layout
  // is the slow-changing half, status the half Socket.io will stream (MAP-2).
  getFloors: (organizationId) => request(`/api/floors?organizationId=${encodeURIComponent(organizationId)}`),
  getFloorLayout: (floorId) => request(`/api/floors/${floorId}/layout`),

  // AUTH-3 — first-login terms gate.
  getMe: () => request(`/api/auth/me`),
  getTerms: (orgId) => request(`/api/organizations/${orgId}/terms`),
  acceptTerms: () => request(`/api/auth/accept-terms`, { method: "POST" }),

  // INF-3 / INF-4 — a kiosk tap resolves a credential to a member. It does
  // NOT activate a reservation; that's OCC-1 in Sprint 2.
  tap: (organizationId, credential, method = "rfid") =>
    request(`/api/checkin/tap`, {
      method: "POST",
      body: JSON.stringify({ organizationId, credential, method }),
    }),
  getCheckInMethods: () => request(`/api/checkin/methods`),

  // ID-1, ID-2 — kiosk self-service registration.
  getRegistrationRequirements: (organizationId) =>
    request(`/api/registration/requirements?organizationId=${encodeURIComponent(organizationId)}`),
  startRegistration: (payload) =>
    request(`/api/registration/start`, { method: "POST", body: JSON.stringify(payload) }),
  verifyRegistration: (registrationId, code) =>
    request(`/api/registration/verify`, { method: "POST", body: JSON.stringify({ registrationId, code }) }),
  resendRegistrationCode: (registrationId) =>
    request(`/api/registration/resend`, { method: "POST", body: JSON.stringify({ registrationId }) }),

  // OCC-2 — kiosk walk-in assignment.
  assignWalkIn: (organizationId, credential, resourceId, unitLabel) =>
    request(`/api/checkin/walkin`, {
      method: "POST",
      body: JSON.stringify({ organizationId, credential, resourceId, unitLabel }),
    }),

  // RES-1..RES-5 — the reservation engine.
  createReservation: (payload) =>
    request(`/api/reservations`, { method: "POST", body: JSON.stringify(payload) }),
  myReservations: () => request(`/api/reservations/mine`),
  cancelReservation: (id) => request(`/api/reservations/${id}`, { method: "DELETE" }),

  // AUTH-4 / ADM-4 — PIN change and reset.
  changePin: (currentPin, newPin) =>
    request(`/api/auth/change-pin`, { method: "POST", body: JSON.stringify({ currentPin, newPin }) }),
  requestPinReset: (organizationId, email) =>
    request(`/api/auth/request-pin-reset`, { method: "POST", body: JSON.stringify({ organizationId, email }) }),
  resetPin: (organizationId, email, code, newPin) =>
    request(`/api/auth/reset-pin`, { method: "POST", body: JSON.stringify({ organizationId, email, code, newPin }) }),

  // ADM-1..ADM-5, RPT-1 — the admin surface.
  // What the plan allows and how much of it is in use (staff and superadmin).
  adminPlan: () => request(`/api/admin/plan`),
  adminDashboard: (floorId) => request(`/api/admin/dashboard${floorId ? `?floorId=${floorId}` : ""}`),
  adminResources: (floorId) => request(`/api/admin/resources${floorId ? `?floorId=${floorId}` : ""}`),
  adminResourceHistory: (id) => request(`/api/admin/resources/${id}/history`),
  adminSetUnit: (resourceId, label, patch) =>
    request(`/api/admin/resources/${resourceId}/units/${encodeURIComponent(label)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  adminCancelReservation: (id, reason) =>
    request(`/api/admin/reservations/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
  adminMembers: (q) => request(`/api/admin/members${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  adminMemberHistory: (id) => request(`/api/admin/members/${id}/history`),
  adminResetMemberPin: (id) => request(`/api/admin/members/${id}/reset-pin`, { method: "POST" }),
  adminReissueCard: (id, cardUid) =>
    request(`/api/admin/members/${id}/reissue-card`, { method: "POST", body: JSON.stringify({ cardUid }) }),
  adminStaff: () => request(`/api/admin/staff`),
  adminCreateStaff: (payload) => request(`/api/admin/staff`, { method: "POST", body: JSON.stringify(payload) }),
  adminUpdateStaff: (id, patch) =>
    request(`/api/admin/staff/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  adminSettings: () => request(`/api/admin/settings`),
  adminUpdateSettings: (patch) => request(`/api/admin/settings`, { method: "PATCH", body: JSON.stringify(patch) }),
  adminCreateClosure: (payload) => request(`/api/admin/closures`, { method: "POST", body: JSON.stringify(payload) }),
  adminDeleteClosure: (id) => request(`/api/admin/closures/${id}`, { method: "DELETE" }),
  adminReports: (days = 30) => request(`/api/admin/reports?days=${days}`),
  /**
   * The CSV export, fetched WITH the session and handed back as a file.
   * It used to be a plain link to the API, which a browser follows with
   * no Authorization header — so every export answered 401 and saved a
   * scrap of JSON. Fetching it also means a plan without reports answers
   * with its reason, like every other screen.
   */
  adminExport: async (days = 30) => {
    const res = await send(`/api/admin/export?days=${days}`);
    return { blob: await res.blob(), filename: `reservations-${days}d.csv` };
  },

  // Floor management — superadmin only: add floors, resize them, and set
  // their outline ({ shape: { areas } }; null resets it to the whole grid).
  createFloor: (payload) => request(`/api/floors`, { method: "POST", body: JSON.stringify(payload) }),
  updateFloor: (id, patch) => request(`/api/floors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteFloor: (id) => request(`/api/floors/${id}`, { method: "DELETE" }),

  reservationAvailability: (resourceId, unitLabel, startTime, endTime) => request(`/api/reservations/availability?${new URLSearchParams({ resourceId, unitLabel, startTime, endTime })}`),
  // A room's whole-room and per-unit availability for one window, in one request.
  roomOptions: (roomId, startTime, endTime) =>
    request(`/api/reservations/rooms/${roomId}/options?${new URLSearchParams({ startTime, endTime })}`),

  // Buildings organize floors; rooms define shared booking boundaries.
  getSpaces: (orgId) => request(`/api/spaces?organizationId=${orgId}`),
  // How much of each map limit the plan allows is in use (superadmin).
  getSpaceUsage: () => request(`/api/spaces/usage`),
  createBuilding: (payload) => request(`/api/spaces/buildings`, { method: "POST", body: JSON.stringify(payload) }),
  updateBuilding: (id, patch) => request(`/api/spaces/buildings/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBuilding: (id) => request(`/api/spaces/buildings/${id}`, { method: "DELETE" }),
  createRoom: (payload) => request(`/api/spaces/rooms`, { method: "POST", body: JSON.stringify(payload) }),
  updateRoom: (id, patch) => request(`/api/spaces/rooms/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoom: (id) => request(`/api/spaces/rooms/${id}`, { method: "DELETE" }),
  setRoomAvailability: (id, status) => request(`/api/spaces/rooms/${id}/availability`, { method: "PATCH", body: JSON.stringify({ status }) }),

  // MAP-3/4/5 — editor writes.
  placeResource: (payload) => request(`/api/resources`, { method: "POST", body: JSON.stringify(payload) }),
  removeResource: (id) => request(`/api/resources/${id}`, { method: "DELETE" }),
  createZone: (payload) => request(`/api/resources/zones`, { method: "POST", body: JSON.stringify(payload) }),
  // { name?, areas? }: rename a zone, or reshape it (an L-shaped zone is two areas).
  updateZone: (id, patch) => request(`/api/resources/zones/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteZone: (id) => request(`/api/resources/zones/${id}`, { method: "DELETE" }),
  createLabel: (payload) => request(`/api/resources/labels`, { method: "POST", body: JSON.stringify(payload) }),
  deleteLabel: (id) => request(`/api/resources/labels/${id}`, { method: "DELETE" }),
};
