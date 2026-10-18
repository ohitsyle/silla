/**
 * Plans, subscriptions, invoices and payments — for the storefront, the
 * buyer's billing page and the staff console. Same service, token and
 * error shape as lib/vendorApi.js, whose request() it shares.
 *
 * Money is in MINOR units (centavos) both ways; format it only with
 * formatMoney() from lib/plans.js.
 */
import { request } from "./vendorApi.js";

const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) });
const patch = (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body || {}) });
const put = (path, body) => request(path, { method: "PUT", body: JSON.stringify(body || {}) });

/** `{ status: "open", q: "" }` → "?status=open" — empty values are left out. */
const query = (params = {}) => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  return pairs.length ? `?${new URLSearchParams(pairs.map(([k, v]) => [k, v === true ? "1" : String(v)]))}` : "";
};

export const billingApi = {
  /* ── the storefront ── */
  /** { plans[], catalogue[], vat, trialDays } — public: active plans, and everything else SILLA sells. */
  plans: () => request("/api/vendor/plans"),

  /* ── a buyer's own ── */
  /** { subscriptions[], otherOpenInvoices[] } */
  me: () => request("/api/vendor/billing/me"),
  myInvoices: () => request("/api/vendor/billing/me/invoices"),
  /** { invoice, howToPay, footer } — theirs, or any for staff with billing.read. */
  invoice: (id) => request(`/api/vendor/billing/invoices/${id}`),
  /** "I've paid" — a claim SILLA confirms; it activates nothing by itself. */
  claim: (id, body) => post(`/api/vendor/billing/invoices/${id}/claim`, body),
  /** { business, instructions, methods[] } */
  paymentInstructions: () => request("/api/vendor/settings/payment-instructions"),

  /* ── staff: subscriptions ── */
  subscriptions: (params) => request(`/api/vendor/billing/subscriptions${query(params)}`),
  subscription: (id) => request(`/api/vendor/billing/subscriptions/${id}`),
  updateSubscription: (id, body) => patch(`/api/vendor/billing/subscriptions/${id}`, body),
  suspend: (id, reason) => post(`/api/vendor/billing/subscriptions/${id}/suspend`, { reason }),
  resume: (id) => post(`/api/vendor/billing/subscriptions/${id}/resume`),
  cancel: (id, { when, reason }) => post(`/api/vendor/billing/subscriptions/${id}/cancel`, { when, reason }),
  sync: (id) => post(`/api/vendor/billing/subscriptions/${id}/sync`),

  /* ── staff: invoices ── */
  invoices: (params) => request(`/api/vendor/billing/invoices${query(params)}`),
  issueInvoice: (body) => post("/api/vendor/billing/invoices", body),
  recordPayment: (id, body) => post(`/api/vendor/billing/invoices/${id}/payment`, body),
  voidInvoice: (id, reason) => post(`/api/vendor/billing/invoices/${id}/void`, { reason }),
  dismissClaim: (id, reason) => post(`/api/vendor/billing/invoices/${id}/claim/dismiss`, { reason }),

  /* ── staff: plans and settings ── */
  allPlans: () => request("/api/vendor/plans/all"),
  createPlan: (body) => post("/api/vendor/plans", body),
  updatePlan: (key, body) => patch(`/api/vendor/plans/${key}`, body),
  settings: () => request("/api/vendor/settings"),
  saveSettings: (body) => put("/api/vendor/settings", body),
};
