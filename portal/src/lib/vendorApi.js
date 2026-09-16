/**
 * The storefront's API client — SILLA's commerce service, not a buyer's
 * deployment. Different origin, different port, different token.
 *
 * The portal talks to exactly two things and they must never be
 * confused: this, and nothing else. It has no client for `server/`
 * because it has no business reading a customer's operational data.
 */
const BASE = import.meta.env.VITE_VENDOR_API_URL || "http://localhost:4100";

const TOKEN_KEY = "silla_vendor_token";

export const readToken = () => {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // A private window with storage blocked should still let someone
    // browse the storefront; they just cannot stay signed in.
    return null;
  }
};

export const writeToken = (token) => {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* see above */
  }
};

async function request(path, options = {}) {
  const token = readToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry status and body: the sign-up form branches on 409 (email
    // taken) and the queue on 409 (illegal transition, with `allowed`).
    const error = new Error(body.error || `Request failed: ${res.status}`);
    error.status = res.status;
    error.body = body;
    // Field-keyed messages, so a form can put each under its own input
    // instead of one sentence at the bottom about the whole form.
    error.fields = body.fields || {};
    error.code = body.code;
    if (res.status === 401 && body.code === "SESSION_REVOKED") {
      // The password was changed elsewhere. Tell the app, which signs out.
      window.dispatchEvent(new CustomEvent("silla:session-revoked"));
    }
    throw error;
  }
  return body;
}

const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) });
const patch = (path, body) => request(path, { method: "PATCH", body: JSON.stringify(body || {}) });

export const vendorApi = {
  register: (payload) => post("/api/vendor/auth/register", payload),
  login: (email, password) => post("/api/vendor/auth/login", { email, password }),
  me: () => request("/api/vendor/auth/me"),
  emailAvailable: (email) => request(`/api/vendor/auth/email-available?email=${encodeURIComponent(email)}`),

  verifyEmail: (code) => post("/api/vendor/auth/me/verify", { code }),
  resendVerification: () => post("/api/vendor/auth/me/verify/resend"),

  updateProfile: (fields) => patch("/api/vendor/auth/me", fields),
  changeEmail: (newEmail, password) => post("/api/vendor/auth/me/email", { newEmail, password }),
  confirmEmailChange: (code) => post("/api/vendor/auth/me/email/confirm", { code }),
  changePassword: (currentPassword, newPassword) => post("/api/vendor/auth/me/password", { currentPassword, newPassword }),
  updateBilling: (billing) => patch("/api/vendor/auth/me/billing", billing),

  forgotPassword: (email) => post("/api/vendor/auth/forgot-password", { email }),
  resetPassword: (email, code, newPassword) => post("/api/vendor/auth/reset-password", { email, code, newPassword }),

  myOrders: () => request("/api/vendor/orders"),
  order: (id) => request(`/api/vendor/orders/${id}`),
  createOrder: (payload) => request("/api/vendor/orders", { method: "POST", body: JSON.stringify(payload) }),
  updateOrder: (id, patch) => request(`/api/vendor/orders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  submitOrder: (id) => request(`/api/vendor/orders/${id}/submit`, { method: "POST" }),

  queue: (status) => request(`/api/vendor/orders/queue/all${status ? `?status=${status}` : ""}`),
  queueOrder: (id) => request(`/api/vendor/orders/queue/${id}`),
  moveOrder: (id, patch) =>
    request(`/api/vendor/orders/queue/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
