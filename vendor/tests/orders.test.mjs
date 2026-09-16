import { KNOWN_CODE, plantCode } from "./helpers.mjs";
/**
 * The commerce path, asserted from the outside.
 *
 * Runs against a RUNNING vendor API and the real database, for the same
 * reason the product's suites do: the properties worth testing here —
 * that one buyer cannot read another's order, that a buyer cannot reach
 * the queue, that an order cannot skip a lifecycle step — are properties
 * of the real stack, not of a mock.
 *
 * Self-cleaning: every account it makes uses @test.silla and is removed
 * afterwards, along with its orders.
 */
const API = process.env.VENDOR_API_URL || "http://localhost:4100";

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** A minimal profile — the shape the wizard emits, only what's checked. */
const profileFor = (name) => ({
  key: name.toLowerCase().replace(/\W+/g, "-"),
  organizationName: name,
  siteName: "Main Site",
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  floors: [{ name: "Level 1", order: 0, grid: { cols: 10, rows: 8 }, resources: [], zones: [], labels: [] }],
});

export const name = "Orders";

/** The sign-up body the current API expects. */
const signupBody = (full, email, password) => {
  const [firstName, ...rest] = full.split(" ");
  return { firstName, lastName: rest.join(" ") || "Tester", email, confirmEmail: email, password, acceptTerms: true };
};

export async function run(check) {
  const tag = unique();
  const buyerEmail = `buyer-${tag}@test.silla`;
  const otherEmail = `other-${tag}@test.silla`;
  const password = "a-long-enough-password";

  /* ── Registration ── */

  const short = await req("/api/vendor/auth/register", {
    method: "POST",
    body: JSON.stringify(signupBody("Too Short", `short-${tag}@test.silla`, "abc123")),
  });
  check("VEN-1", "A short password is rejected", short.status === 400, short.body?.error);

  const badEmail = await req("/api/vendor/auth/register", {
    method: "POST",
    body: JSON.stringify(signupBody("Bad", "not-an-email", password)),
  });
  check("VEN-1", "An invalid email is rejected", badEmail.status === 400, badEmail.body?.error);

  const signup = await req("/api/vendor/auth/register", {
    method: "POST",
    body: JSON.stringify({ ...signupBody("Test Buyer", buyerEmail, password), organizationName: "Testing Co" }),
  });
  check("VEN-1", "A buyer can sign up", signup.status === 201 && Boolean(signup.body?.token));
  check("VEN-1", "New accounts are buyers, never SILLA staff", signup.body?.account?.role === "buyer",
    signup.body?.account?.role);

  const dupe = await req("/api/vendor/auth/register", {
    method: "POST",
    body: JSON.stringify(signupBody("Again", buyerEmail, password)),
  });
  check("VEN-1", "The same email cannot register twice", dupe.status === 409, dupe.body?.error);

  const B = auth(signup.body.token);

  const wrong = await req("/api/vendor/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: buyerEmail, password: "not-the-password" }),
  });
  check("VEN-1", "A wrong password is refused", wrong.status === 401);
  check("VEN-1", "…without revealing whether the account exists",
    wrong.body?.error === "That email and password don't match an account.", wrong.body?.error);

  /* ── Drafts and submission ── */

  const created = await req("/api/vendor/orders", {
    method: "POST",
    headers: B,
    body: JSON.stringify({ profile: profileFor("Testing Co"), plan: "building", billingPeriod: "yearly", quotedAmount: 11900 }),
  });
  check("VEN-2", "A configuration can be saved as a draft",
    created.status === 201 && created.body?.order?.status === "draft", created.body?.error);
  const orderId = created.body?.order?.id;

  const noPlan = await req("/api/vendor/orders", {
    method: "POST", headers: B,
    body: JSON.stringify({ profile: profileFor("No Plan"), plan: "enterprise" }),
  });
  check("VEN-2", "An unknown plan is rejected", noPlan.status === 400, noPlan.body?.error);

  const noProfile = await req("/api/vendor/orders", {
    method: "POST", headers: B, body: JSON.stringify({ plan: "room" }),
  });
  check("VEN-2", "An order with no configuration is rejected", noProfile.status === 400);

  const edited = await req(`/api/vendor/orders/${orderId}`, {
    method: "PATCH", headers: B,
    body: JSON.stringify({ plan: "room", profile: profileFor("Testing Co Renamed") }),
  });
  check("VEN-2", "A draft can be edited",
    edited.status === 200 && edited.body?.order?.organizationName === "Testing Co Renamed");

  const mine = await req("/api/vendor/orders", { headers: B });
  check("VEN-2", "It appears in the buyer's own list",
    (mine.body?.orders || []).some((o) => o.id === orderId));

  // Submitting needs a verified email; that gate has its own tests in
  // accounts.test.mjs. Here the buyer simply verifies first.
  await plantCode(buyerEmail, "signup");
  await req("/api/vendor/auth/me/verify", { method: "POST", headers: B, body: JSON.stringify({ code: KNOWN_CODE }) });

  const submitted = await req(`/api/vendor/orders/${orderId}/submit`, { method: "POST", headers: B });
  check("VEN-3", "A draft can be submitted", submitted.body?.order?.status === "submitted", submitted.body?.error);

  const editAfter = await req(`/api/vendor/orders/${orderId}`, {
    method: "PATCH", headers: B, body: JSON.stringify({ plan: "campus" }),
  });
  check("VEN-3", "A submitted order can no longer be edited by the buyer",
    editAfter.status === 409, editAfter.body?.error);

  const resubmit = await req(`/api/vendor/orders/${orderId}/submit`, { method: "POST", headers: B });
  check("VEN-3", "It cannot be submitted twice", resubmit.status === 409, resubmit.body?.error);

  /* ── One buyer must never see another's ── */

  const other = await req("/api/vendor/auth/register", {
    method: "POST",
    body: JSON.stringify(signupBody("Other Buyer", otherEmail, password)),
  });
  const O = auth(other.body.token);

  const peek = await req(`/api/vendor/orders/${orderId}`, { headers: O });
  check("VEN-4", "Another buyer cannot read this order", peek.status === 404, `status ${peek.status}`);

  const theirList = await req("/api/vendor/orders", { headers: O });
  check("VEN-4", "…and it is absent from their list",
    !(theirList.body?.orders || []).some((o) => o.id === orderId));

  const buyerQueue = await req("/api/vendor/orders/queue/all", { headers: B });
  check("VEN-4", "A buyer cannot reach the SILLA queue", buyerQueue.status === 403, `status ${buyerQueue.status}`);

  const buyerMove = await req(`/api/vendor/orders/queue/${orderId}`, {
    method: "PATCH", headers: B, body: JSON.stringify({ status: "live" }),
  });
  check("VEN-4", "…nor move their own order through it", buyerMove.status === 403);

  /* ── The queue, as SILLA ── */

  const staffLogin = await req("/api/vendor/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: process.env.VENDOR_STAFF_EMAIL, password: process.env.VENDOR_STAFF_PASSWORD }),
  });
  if (staffLogin.status !== 200) {
    check("VEN-5", "SILLA staff can sign in", false,
      "seed one first: npm run seed:staff -- <email> <name> <password>");
    return { orderId, buyerEmail, otherEmail };
  }
  const S = auth(staffLogin.body.token);
  check("VEN-5", "SILLA staff can sign in", true);

  const queue = await req("/api/vendor/orders/queue/all", { headers: S });
  check("VEN-5", "The queue lists submitted orders",
    (queue.body?.orders || []).some((o) => o.id === orderId));

  const draftLeak = await req("/api/vendor/orders", {
    method: "POST", headers: B,
    body: JSON.stringify({ profile: profileFor("Still A Draft"), plan: "room" }),
  });
  const queueAgain = await req("/api/vendor/orders/queue/all", { headers: S });
  check("VEN-5", "A buyer's unsubmitted draft is NOT in the queue",
    !(queueAgain.body?.orders || []).some((o) => o.id === draftLeak.body?.order?.id));

  const skip = await req(`/api/vendor/orders/queue/${orderId}`, {
    method: "PATCH", headers: S, body: JSON.stringify({ status: "live", deploymentUrl: "https://x.test" }),
  });
  check("VEN-6", "An order cannot skip from submitted straight to live",
    skip.status === 409, skip.body?.error);

  const prov = await req(`/api/vendor/orders/queue/${orderId}`, {
    method: "PATCH", headers: S, body: JSON.stringify({ status: "provisioning", note: "Building it" }),
  });
  check("VEN-6", "Submitted → provisioning is allowed", prov.body?.order?.status === "provisioning");

  const liveNoUrl = await req(`/api/vendor/orders/queue/${orderId}`, {
    method: "PATCH", headers: S, body: JSON.stringify({ status: "live" }),
  });
  check("VEN-6", "Going live without a deployment URL is refused",
    liveNoUrl.status === 400, liveNoUrl.body?.error);

  const live = await req(`/api/vendor/orders/queue/${orderId}`, {
    method: "PATCH", headers: S,
    body: JSON.stringify({ status: "live", deploymentUrl: "https://testing-co.silla.test", note: "Provisioned" }),
  });
  check("VEN-6", "Provisioning → live with a URL is allowed", live.body?.order?.status === "live", live.body?.error);

  const detail = await req(`/api/vendor/orders/${orderId}`, { headers: B });
  check("VEN-6", "The buyer sees the deployment URL on their order",
    detail.body?.order?.deploymentUrl === "https://testing-co.silla.test");
  check("VEN-6", "…and the full history of who moved it",
    (detail.body?.order?.history || []).length >= 4,
    `${(detail.body?.order?.history || []).length} entries`);

  return { orderId, buyerEmail, otherEmail };
}
