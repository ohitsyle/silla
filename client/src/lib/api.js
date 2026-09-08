const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

async function request(path, options = {}) {
  const token = localStorage.getItem("silla_token"); // fine for a dev scaffold; revisit for production auth storage
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Carry the status and the response body on the error. The kiosk and
    // login flows branch on both — a 403 with requiresVerification means
    // "resume ID-2", a 429 carries retryAfterSeconds, a failed code entry
    // carries attemptsRemaining. Collapsing all of that into a message
    // string would make those flows impossible to build correctly.
    const error = new Error(body.error || `Request failed: ${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return res.json();
}

export const api = {
  getOrgConfig: (orgId) => request(`/api/organizations/${orgId}/config`),
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
  adminExportUrl: (days = 30) => `${BASE_URL}/api/admin/export?days=${days}`,

  // Floor management — superadmin only (add floors, resize rooms).
  createFloor: (payload) => request(`/api/floors`, { method: "POST", body: JSON.stringify(payload) }),
  updateFloor: (id, patch) => request(`/api/floors/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteFloor: (id) => request(`/api/floors/${id}`, { method: "DELETE" }),

  // MAP-3/4/5 — editor writes.
  placeResource: (payload) => request(`/api/resources`, { method: "POST", body: JSON.stringify(payload) }),
  removeResource: (id) => request(`/api/resources/${id}`, { method: "DELETE" }),
  createZone: (payload) => request(`/api/resources/zones`, { method: "POST", body: JSON.stringify(payload) }),
  deleteZone: (id) => request(`/api/resources/zones/${id}`, { method: "DELETE" }),
  createLabel: (payload) => request(`/api/resources/labels`, { method: "POST", body: JSON.stringify(payload) }),
  deleteLabel: (id) => request(`/api/resources/labels/${id}`, { method: "DELETE" }),
};
