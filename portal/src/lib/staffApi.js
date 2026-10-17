/**
 * The staff console's API client — staff, orders, clients, conversations,
 * deployments and the activity log — plus the buyer's half of a
 * conversation, so both sides of one thread go through one client. Same
 * service, token and error shape as lib/vendorApi.js, whose request() it
 * shares; billing has its own (lib/billingApi.js).
 *
 * Every route here is checked on the server (vendor/src/middleware/staff.js).
 * The console only HIDES what a role cannot do, so nobody is offered a
 * button that answers 403 — it is never the control.
 */
import { request } from "./vendorApi.js";

const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) });
const patch = (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body || {}) });

/** `{ status: "open", q: "" }` → "?status=open" — empty values are left out. */
const query = (params = {}) => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  return pairs.length ? `?${new URLSearchParams(pairs.map(([k, v]) => [k, v === true ? "1" : String(v)]))}` : "";
};

export const staffApi = {
  /* ── who is signed in ── */
  /** { id, name, email, staffRole, permissions[] } — the console shows only what this lists. */
  me: () => request("/api/vendor/staff/me"),
  /** Active colleagues, for "assign to" and "who did it" pickers. */
  directory: () => request("/api/vendor/staff/directory"),
  overview: () => request("/api/vendor/staff/overview"),

  /* ── staff (owners) ── */
  staff: () => request("/api/vendor/staff"),
  invite: (body) => post("/api/vendor/staff/invite", body),
  resendInvite: (id) => post(`/api/vendor/staff/${id}/resend-invite`),
  updateStaff: (id, body) => patch(`/api/vendor/staff/${id}`, body),
  /** No session needed: the invited person has no password yet. */
  acceptInvitation: (body) => post("/api/vendor/staff/invitations/accept", body),

  /* ── orders ── */
  queue: (params) => request(`/api/vendor/orders/queue/all${query(params)}`),
  order: (id) => request(`/api/vendor/orders/queue/${id}`),
  moveOrder: (id, body) => patch(`/api/vendor/orders/queue/${id}`, body),
  addOrderNote: (id, body) => post(`/api/vendor/orders/queue/${id}/notes`, { body }),

  /* ── clients ── */
  clients: (params) => request(`/api/vendor/clients${query(params)}`),
  client: (id) => request(`/api/vendor/clients/${id}`),

  /* ── conversations: the staff inbox ── */
  inbox: (params) => request(`/api/vendor/conversations/inbox${query(params)}`),
  inboxCounts: () => request("/api/vendor/conversations/inbox/counts"),
  /** Staff writing first: { accountId, subject, body, orderId? } */
  startConversation: (body) => post("/api/vendor/conversations", body),
  updateConversation: (id, body) => patch(`/api/vendor/conversations/${id}`, body),

  /* ── conversations: either side ── */
  conversation: (id) => request(`/api/vendor/conversations/${id}`),
  /** Staff may send { body, internal: true } — a note the customer never sees. */
  sendMessage: (id, body) => post(`/api/vendor/conversations/${id}/messages`, body),
  markRead: (id) => post(`/api/vendor/conversations/${id}/read`),

  /* ── conversations: the buyer's own ── */
  myConversations: (params) => request(`/api/vendor/conversations/mine${query(params)}`),
  myUnread: () => request("/api/vendor/conversations/mine/unread"),
  /** A buyer starting one: { subject, body, orderId? } */
  startMine: (body) => post("/api/vendor/conversations", body),

  /* ── deployments ── */
  controlPlane: (ping = false) => request(`/api/vendor/deployments/status${ping ? "?ping=1" : ""}`),
  slugCheck: (slug) => request(`/api/vendor/deployments/slug-check${query({ slug })}`),
  provision: (orderId, slug) => post("/api/vendor/deployments/provision", { orderId, slug }),
  deployments: (params) => request(`/api/vendor/deployments${query(params)}`),
  deployment: (orderId) => request(`/api/vendor/deployments/${orderId}`),
  ownerAccess: (orderId, email) => post(`/api/vendor/deployments/${orderId}/owner-access`, email ? { email } : {}),
  syncDeployment: (orderId) => post(`/api/vendor/deployments/${orderId}/sync`),

  /* ── the activity log ── */
  activity: (params) => request(`/api/vendor/audit${query(params)}`),
  activityActions: () => request("/api/vendor/audit/actions"),
};
