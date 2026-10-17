/**
 * Staff — roles, invites, clients, orders, deployments, activity.
 *
 * Asserted from the outside, against the running API, like the other
 * suites: who may do what is a property of the real routes, not of a
 * mock. Provisioning runs end to end against the FAKE product API that
 * tests/isolated.mjs starts — it verifies each request's signature the
 * way the product does, and the checks below read back what it received.
 * Without that fake (plain `npm test`), the deployment checks are left
 * out rather than pointed at a real product.
 *
 * Buyers are made directly in the database, not through /register: the
 * accounts and orders suites already spend most of the per-address
 * registration allowance in the same run, and sign-up is theirs to test.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { KNOWN_CODE, plantCode, readAccount } from "./helpers.mjs";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";

export const name = "Staff — roles, invites, clients, deployments, activity";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const FAKE = process.env.FAKE_CONTROL_PLANE_URL || "";
// Read at import, before any suite runs: the billing suite blanks the
// variable in this shared process while it calls billing directly.
const CONTROL_PLANE_SECRET = process.env.CONTROL_PLANE_SECRET || "";
const PRODUCT_URL = (process.env.PRODUCT_URL || "http://localhost:5173").replace(/\/+$/, "");

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
const get = (path, token) => req(path, { headers: token ? auth(token) : {} });
const post = (path, body, token) => req(path, { method: "POST", headers: token ? auth(token) : {}, body: JSON.stringify(body || {}) });
const patch = (path, body, token) => req(path, { method: "PATCH", headers: token ? auth(token) : {}, body: JSON.stringify(body || {}) });

async function ensureDb() {
  if (mongoose.connection.readyState !== 1) await connectDB();
}

const PASSWORD = "a-long-enough-password";

/** A buyer straight into the database, then signed in through the real login. */
async function makeBuyer(email, { verified = true, organizationName = "Testing Co" } = {}) {
  await ensureDb();
  await Account.create({
    email,
    firstName: "Test",
    lastName: "Buyer",
    organizationName,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    role: "buyer",
    emailVerified: verified,
    emailVerifiedAt: verified ? new Date() : null,
    termsAcceptedAt: new Date(),
    termsVersion: "test",
  });
  const login = await post("/api/vendor/auth/login", { email, password: PASSWORD });
  return { email, token: login.body?.token, id: login.body?.account?.id };
}

const login = async (email, password) => (await post("/api/vendor/auth/login", { email, password })).body?.token;

/** The wizard's shape, only what is checked — with the owner provisioning needs. */
const profileFor = (organizationName, { owner = true } = {}) => ({
  key: organizationName.toLowerCase().replace(/\W+/g, "-"),
  organizationName,
  siteName: "Main Site",
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  floors: [{ name: "Level 1", order: 0, grid: { cols: 10, rows: 8 }, resources: [], zones: [], labels: [] }],
  ...(owner ? { owner: { firstName: "Olive", lastName: "Owner", email: `olive-${unique()}@test.silla` } } : {}),
});

async function submittedOrder(buyer, organizationName, opts) {
  const created = await post(
    "/api/vendor/orders",
    { profile: profileFor(organizationName, opts), plan: "building", billingPeriod: "yearly", quotedAmount: 690000, currency: "PHP" },
    buyer.token
  );
  const id = created.body?.order?.id;
  await post(`/api/vendor/orders/${id}/submit`, {}, buyer.token);
  return id;
}

const fake = async () => (await (await fetch(`${FAKE}/__received`)).json());
const drill = (body) => fetch(`${FAKE}/__drill`, { method: "POST", body: JSON.stringify(body) });

/** Every string value in a document, recursively — ids and dates are objects in a lean doc, so they are skipped. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object" && value.constructor === Object) Object.values(value).forEach((v) => strings(v, out));
  return out;
}
function keys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === "object" && value.constructor === Object) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keys(v, out);
    }
  }
  return out;
}

export async function run(check) {
  const tag = unique();
  const S = "STAFF";

  const ownerToken = await login(process.env.VENDOR_STAFF_EMAIL, process.env.VENDOR_STAFF_PASSWORD);
  if (!ownerToken) {
    check(S, "The staff owner can sign in", false, "set VENDOR_STAFF_EMAIL / VENDOR_STAFF_PASSWORD");
    return;
  }
  const ownerMe = await get("/api/vendor/staff/me", ownerToken);
  const ownerId = ownerMe.body?.id;
  check(S, "An owner holds every permission, including staff.manage",
    ownerMe.body?.staffRole === "owner" && ownerMe.body?.permissions?.includes("staff.manage") &&
      ownerMe.body?.permissions?.includes("deployments.provision"));

  const buyer = await makeBuyer(`staffsuite-buyer-${tag}@test.silla`, { organizationName: "Staffsuite Co" });

  /* ── a buyer is refused everywhere ── */

  const fakeId = new mongoose.Types.ObjectId().toString();
  const staffOnly = [
    ["GET", "/api/vendor/staff/me"],
    ["GET", "/api/vendor/staff"],
    ["GET", "/api/vendor/staff/overview"],
    ["GET", "/api/vendor/staff/directory"],
    ["POST", "/api/vendor/staff/invite"],
    ["PATCH", `/api/vendor/staff/${fakeId}`],
    ["POST", `/api/vendor/staff/${fakeId}/resend-invite`],
    ["GET", "/api/vendor/clients"],
    ["GET", `/api/vendor/clients/${fakeId}`],
    ["GET", "/api/vendor/orders/queue/all"],
    ["GET", `/api/vendor/orders/queue/${fakeId}`],
    ["POST", `/api/vendor/orders/queue/${fakeId}/notes`],
    ["GET", "/api/vendor/deployments"],
    ["GET", "/api/vendor/deployments/status"],
    ["GET", "/api/vendor/deployments/slug-check?slug=anything"],
    ["POST", "/api/vendor/deployments/provision"],
    ["GET", `/api/vendor/deployments/${fakeId}`],
    ["POST", `/api/vendor/deployments/${fakeId}/owner-access`],
    ["POST", `/api/vendor/deployments/${fakeId}/sync`],
    ["GET", "/api/vendor/audit"],
    ["GET", "/api/vendor/conversations/inbox"],
    ["PATCH", `/api/vendor/conversations/${fakeId}`],
  ];
  const leaks = [];
  for (const [method, path] of staffOnly) {
    const r = await req(path, { method, headers: auth(buyer.token), body: method === "GET" ? undefined : "{}" });
    if (r.status !== 403) leaks.push(`${method} ${path} → ${r.status}`);
  }
  check(S, `A buyer gets 403 on every staff route (${staffOnly.length} checked)`, leaks.length === 0, leaks.join("; "));

  /* ── invitations ── */

  const supportEmail = `support-${tag}@test.silla`;
  const adminEmail = `admin-${tag}@test.silla`;

  const blank = await post("/api/vendor/staff/invite", {}, ownerToken);
  check(S, "An invite with nothing filled in names every missing field",
    blank.status === 400 && ["firstName", "lastName", "email", "staffRole"].every((f) => blank.body?.fields?.[f]));

  const invited = await post("/api/vendor/staff/invite",
    { firstName: "Sam", lastName: "Support", email: supportEmail, staffRole: "support" }, ownerToken);
  check(S, "An owner can invite a support member", invited.status === 201 && invited.body?.staff?.status === "invited",
    invited.body?.error);
  const supportId = invited.body?.staff?.id;

  const invitedAdmin = await post("/api/vendor/staff/invite",
    { firstName: "Ada", lastName: "Admin", email: adminEmail, staffRole: "admin" }, ownerToken);
  const adminId = invitedAdmin.body?.staff?.id;
  check(S, "…and an admin", invitedAdmin.status === 201);

  const again = await post("/api/vendor/staff/invite",
    { firstName: "Sam", lastName: "Again", email: supportEmail, staffRole: "support" }, ownerToken);
  check(S, "The same address cannot be invited twice", again.status === 409 && Boolean(again.body?.fields?.email));

  const customer = await post("/api/vendor/staff/invite",
    { firstName: "Not", lastName: "Staff", email: buyer.email, staffRole: "admin" }, ownerToken);
  check(S, "A customer's address is never turned into staff", customer.status === 409, customer.body?.error);

  const stored = await readAccount(supportEmail);
  check(S, "The invitation code is stored hashed, for the invite purpose only",
    stored?.verification?.purpose === "invite" && /^\$2[aby]\$/.test(stored?.verification?.codeHash || ""));
  check(S, "…and lasts days, not minutes",
    new Date(stored?.verification?.expiresAt).getTime() - Date.now() > 70 * 3600 * 1000);
  check(S, "An invited account is a role-holding staff account from the start",
    stored?.role === "silla" && stored?.staffRole === "support" && stored?.emailVerified === false);

  const noSignInYet = await post("/api/vendor/auth/login", { email: supportEmail, password: PASSWORD });
  check(S, "An invited person cannot sign in before accepting", noSignInYet.status === 401);

  const wrongCode = await post("/api/vendor/staff/invitations/accept", { email: supportEmail, code: "000000", password: PASSWORD });
  check(S, "Accepting with a wrong code is refused and counts the attempt",
    wrongCode.status === 401 && wrongCode.body?.attemptsRemaining === 4, wrongCode.body?.error);

  await plantCode(supportEmail, "invite");
  const shortPw = await post("/api/vendor/staff/invitations/accept", { email: supportEmail, code: KNOWN_CODE, password: "short" });
  check(S, "A password under ten characters is refused on its own field",
    shortPw.status === 400 && Boolean(shortPw.body?.fields?.password));

  const accepted = await post("/api/vendor/staff/invitations/accept", { email: supportEmail, code: KNOWN_CODE, password: PASSWORD });
  check(S, "The right code sets the password", accepted.status === 200, accepted.body?.error);

  let supportToken = await login(supportEmail, PASSWORD);
  check(S, "…and the new staff member can sign in with it", Boolean(supportToken));

  const reused = await post("/api/vendor/staff/invitations/accept", { email: supportEmail, code: KNOWN_CODE, password: "another-long-password" });
  check(S, "An invitation code works once", reused.status === 400, reused.body?.error);
  const stillOld = await login(supportEmail, PASSWORD);
  check(S, "…so a second use cannot reset the password", Boolean(stillOld));

  const strangerAccept = await post("/api/vendor/staff/invitations/accept", { email: buyer.email, code: KNOWN_CODE, password: PASSWORD });
  check(S, "A customer's address has no invitation to accept", strangerAccept.status === 400);

  // An invitation lapses: after three days its code is worthless.
  const lapsedEmail = `lapsed-${tag}@test.silla`;
  await post("/api/vendor/staff/invite", { firstName: "Lee", lastName: "Lapsed", email: lapsedEmail, staffRole: "support" }, ownerToken);
  await plantCode(lapsedEmail, "invite", { expired: true });
  const lapsed = await post("/api/vendor/staff/invitations/accept", { email: lapsedEmail, code: KNOWN_CODE, password: PASSWORD });
  check(S, "An invitation code stops working when it expires", lapsed.status === 410 && /expired/i.test(lapsed.body?.error || ""),
    lapsed.body?.error);

  // Password reset is not a second way into an invitation — nor a way for
  // anyone who knows the address to wipe the invitation code out.
  const resetEmail = `reset-${tag}@test.silla`;
  await post("/api/vendor/staff/invite", { firstName: "Rae", lastName: "Reset", email: resetEmail, staffRole: "admin" }, ownerToken);
  const inviteHash = (await readAccount(resetEmail))?.verification?.codeHash;
  const forgot = await post("/api/vendor/auth/forgot-password", { email: resetEmail });
  const afterForgot = await readAccount(resetEmail);
  check(S, "Forgot-password answers as usual and leaves a pending invitation's code untouched",
    forgot.status === 200 && afterForgot?.verification?.purpose === "invite" && afterForgot?.verification?.codeHash === inviteHash);
  await plantCode(resetEmail, "password-reset");
  const resetIn = await post("/api/vendor/auth/reset-password", { email: resetEmail, code: KNOWN_CODE, newPassword: PASSWORD });
  check(S, "…and a reset code cannot set a password on an invitation nobody accepted",
    resetIn.status === 400 && (await readAccount(resetEmail))?.emailVerified === false && !(await login(resetEmail, PASSWORD)));

  // The admin: a re-send inside the cooldown is refused; after it, the
  // old code stops working and the new one is the only way in.
  const tooSoon = await post(`/api/vendor/staff/${adminId}/resend-invite`, {}, ownerToken);
  check(S, "Re-sending an invitation straight away is throttled", tooSoon.status === 429);
  await plantCode(adminEmail, "invite"); // known code, sent "two minutes ago"
  const resent = await post(`/api/vendor/staff/${adminId}/resend-invite`, {}, ownerToken);
  check(S, "After the cooldown an owner can re-send it", resent.status === 200, resent.body?.error);
  const oldCode = await post("/api/vendor/staff/invitations/accept", { email: adminEmail, code: KNOWN_CODE, password: PASSWORD });
  check(S, "…and the code it replaced no longer works", oldCode.status === 401);
  await plantCode(adminEmail, "invite");
  await post("/api/vendor/staff/invitations/accept", { email: adminEmail, code: KNOWN_CODE, password: PASSWORD });
  const adminToken = await login(adminEmail, PASSWORD);
  check(S, "The admin accepts and signs in", Boolean(adminToken));

  const resendAccepted = await post(`/api/vendor/staff/${supportId}/resend-invite`, {}, ownerToken);
  check(S, "An accepted invitation cannot be re-sent", resendAccepted.status === 409);

  const list = await get("/api/vendor/staff", ownerToken);
  const supportRow = list.body?.staff?.find((s) => s.id === supportId);
  check(S, "The staff list shows them active, with who invited them",
    supportRow?.status === "active" && supportRow?.invitedBy?.id === ownerId && Boolean(supportRow?.inviteAcceptedAt));

  /* ── what support may and may not do ── */

  const supportMe = await get("/api/vendor/staff/me", supportToken);
  check(S, "Support's permissions exclude staff and provisioning",
    supportMe.body?.staffRole === "support" &&
      !supportMe.body?.permissions?.includes("staff.manage") &&
      !supportMe.body?.permissions?.includes("deployments.provision") &&
      supportMe.body?.permissions?.includes("deployments.ownerAccess"));

  const supportRefused = [];
  for (const [method, path, body] of [
    ["GET", "/api/vendor/staff"],
    ["POST", "/api/vendor/staff/invite", { firstName: "X", lastName: "Y", email: `x-${tag}@test.silla`, staffRole: "owner" }],
    ["PATCH", `/api/vendor/staff/${ownerId}`, { staffRole: "support" }],
    ["PATCH", `/api/vendor/staff/${supportId}`, { staffRole: "owner" }],
    ["GET", "/api/vendor/deployments/slug-check?slug=support-try"],
    ["POST", "/api/vendor/deployments/provision", { orderId: fakeId, slug: "support-try" }],
    ["POST", `/api/vendor/deployments/${fakeId}/sync`],
    ["GET", "/api/vendor/audit"],
  ]) {
    const r = await req(path, { method, headers: auth(supportToken), body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}" });
    if (r.status !== 403) supportRefused.push(`${method} ${path} → ${r.status}`);
  }
  check(S, "Support cannot manage staff, provision, sync or read the audit log", supportRefused.length === 0, supportRefused.join("; "));

  const supportQueue = await get("/api/vendor/orders/queue/all", supportToken);
  const supportClients = await get("/api/vendor/clients", supportToken);
  check(S, "Support can read the queue and the client directory", supportQueue.status === 200 && supportClients.status === 200);

  /* ── changing roles; never yourself, never the last owner ── */

  const selfDemote = await patch(`/api/vendor/staff/${ownerId}`, { staffRole: "support" }, ownerToken);
  const selfOff = await patch(`/api/vendor/staff/${ownerId}`, { active: false }, ownerToken);
  check(S, "The only owner cannot demote or deactivate themselves",
    selfDemote.status === 409 && selfOff.status === 409 && selfDemote.body?.code === "SELF");

  const toBilling = await patch(`/api/vendor/staff/${supportId}`, { staffRole: "billing" }, ownerToken);
  check(S, "An owner can change someone's role", toBilling.status === 200 && toBilling.body?.staff?.staffRole === "billing");
  const nowBilling = await get("/api/vendor/staff/me", supportToken);
  check(S, "…and it takes effect on their very next request, without signing in again",
    nowBilling.body?.staffRole === "billing" && !nowBilling.body?.permissions?.includes("orders.manage"));
  const billingNote = await post(`/api/vendor/orders/queue/${fakeId}/notes`, { body: "hello" }, supportToken);
  check(S, "Billing staff cannot write order notes (orders.manage)", billingNote.status === 403);

  // Two owners, each demoting the other at the same moment: without the
  // guard both commit and SILLA has no owner left.
  await patch(`/api/vendor/staff/${adminId}`, { staffRole: "owner" }, ownerToken);
  const [a, b] = await Promise.all([
    patch(`/api/vendor/staff/${adminId}`, { staffRole: "admin" }, ownerToken),
    patch(`/api/vendor/staff/${ownerId}`, { staffRole: "admin" }, adminToken),
  ]);
  await ensureDb();
  const owners = await Account.countDocuments({
    role: "silla", active: true, emailVerified: true, $or: [{ staffRole: "owner" }, { staffRole: null }],
  });
  check(S, "Two owners demoting each other at once still leave an owner", owners >= 1,
    `${owners} owner(s); responses ${a.status} / ${b.status}`);
  // Put the seeded owner back, whichever way the race went.
  const seeded = await Account.findById(ownerId);
  if (seeded.staffRole !== "owner") await patch(`/api/vendor/staff/${ownerId}`, { staffRole: "owner" }, adminToken);
  const adminNow = await Account.findById(adminId);
  if (adminNow.staffRole !== "owner") await patch(`/api/vendor/staff/${adminId}`, { staffRole: "owner" }, ownerToken);

  // A demoted owner loses the console's staff controls at once.
  const demoted = await patch(`/api/vendor/staff/${ownerId}`, { staffRole: "admin" }, adminToken);
  const lostIt = await patch(`/api/vendor/staff/${adminId}`, { staffRole: "admin" }, ownerToken);
  check(S, "An owner demoted by another owner loses staff.manage immediately",
    demoted.status === 200 && lostIt.status === 403);
  await patch(`/api/vendor/staff/${ownerId}`, { staffRole: "owner" }, adminToken);
  await patch(`/api/vendor/staff/${adminId}`, { staffRole: "admin" }, ownerToken);
  const back = await get("/api/vendor/staff/me", ownerToken);
  check(S, "…and is restored the same way", back.body?.staffRole === "owner");

  // Someone's open thread, to see where it goes when they leave.
  const theirs = await post("/api/vendor/conversations", { subject: `Help with my order ${tag}`, body: "Hello?" }, buyer.token);
  const theirsId = theirs.body?.conversation?.id;
  await patch(`/api/vendor/conversations/${theirsId}`, { assignee: supportId }, ownerToken);

  const off = await patch(`/api/vendor/staff/${supportId}`, { active: false }, ownerToken);
  const offSession = await get("/api/vendor/staff/me", supportToken);
  const offLogin = await post("/api/vendor/auth/login", { email: supportEmail, password: PASSWORD });
  check(S, "Deactivating staff ends their session and their sign-in",
    off.body?.staff?.status === "deactivated" && offSession.status === 401 && offLogin.status === 401);
  const orphan = await get(`/api/vendor/conversations/${theirsId}`, ownerToken);
  check(S, "…and their open conversations go back to the shared inbox", Boolean(theirsId) && orphan.body?.conversation?.assignee === null,
    JSON.stringify(orphan.body?.conversation?.assignee));
  const on = await patch(`/api/vendor/staff/${supportId}`, { active: true, staffRole: "support" }, ownerToken);
  supportToken = await login(supportEmail, PASSWORD);
  check(S, "Reactivating restores them", on.body?.staff?.status === "active" && Boolean(supportToken));

  const pendingEmail = `pending-${tag}@test.silla`;
  const pending = await post("/api/vendor/staff/invite",
    { firstName: "Pat", lastName: "Pending", email: pendingEmail, staffRole: "support" }, ownerToken);
  await patch(`/api/vendor/staff/${pending.body?.staff?.id}`, { active: false }, ownerToken);
  check(S, "Deactivating someone who never accepted revokes their invitation code",
    (await readAccount(pendingEmail))?.verification === null);

  /* ── clients ── */

  const unverified = await makeBuyer(`staffsuite-unverified-${tag}@test.silla`, { verified: false, organizationName: "Unverified Co" });
  const search = await get(`/api/vendor/clients?q=${encodeURIComponent(buyer.email)}`, ownerToken);
  check(S, "The client directory finds a buyer by email",
    search.body?.clients?.length === 1 && search.body.clients[0].email === buyer.email);
  const onlyUnverified = await get("/api/vendor/clients?filter=unverified", ownerToken);
  check(S, "…and filters to unverified accounts",
    onlyUnverified.body?.clients?.some((c) => c.id === unverified.id) &&
      !onlyUnverified.body?.clients?.some((c) => c.id === buyer.id));
  const notAClient = await get(`/api/vendor/clients/${ownerId}`, ownerToken);
  check(S, "Staff accounts are not clients", notAClient.status === 404);

  /* ── orders in the console ── */

  const orgName = `Provision Test ${tag}`;
  const orderId = await submittedOrder(buyer, orgName);
  const queue = await get(`/api/vendor/orders/queue/all?status=open&q=${encodeURIComponent(orgName)}`, supportToken);
  check(S, "The queue finds an order by organization, with counts per status",
    queue.body?.orders?.length === 1 && typeof queue.body?.counts?.open === "number");

  const note = await post(`/api/vendor/orders/queue/${orderId}/notes`, { body: `Called them ${tag}: owner is Olive.` }, supportToken);
  check(S, "Staff can add an internal note to an order", note.status === 201 && note.body?.order?.notes?.[0]?.by?.email === supportEmail);
  const buyerView = await get(`/api/vendor/orders/${orderId}`, buyer.token);
  check(S, "The buyer's view of the order never carries staff notes",
    buyerView.status === 200 && !("notes" in buyerView.body.order) && !JSON.stringify(buyerView.body).includes(`Called them ${tag}`));

  const cancelId = await submittedOrder(buyer, `Cancel Test ${tag}`);
  const noReason = await patch(`/api/vendor/orders/queue/${cancelId}`, { status: "cancelled" }, ownerToken);
  check(S, "Cancelling needs a reason", noReason.status === 400 && Boolean(noReason.body?.fields?.note));
  const cancelled = await patch(`/api/vendor/orders/queue/${cancelId}`, { status: "cancelled", note: "Duplicate order" }, ownerToken);
  check(S, "…and with one, the order is cancelled", cancelled.body?.order?.status === "cancelled");

  /* ── deployments, end to end against the fake product API ── */

  if (!FAKE) {
    console.log("  (deployment checks need the fake product API — run them with npm run test:isolated)");
  } else {
    const status = await get("/api/vendor/deployments/status?ping=1", ownerToken);
    check(S, "The control plane reports configured and reachable", status.body?.configured === true && status.body?.reachable === true);

    const takenCheck = await get("/api/vendor/deployments/slug-check?slug=taken-already", ownerToken);
    check(S, "A taken address is reported with a suggestion",
      takenCheck.body?.available === false && takenCheck.body?.suggestion === "taken-already-2");
    const slug = `prov-${tag}`.slice(0, 40);
    const freeCheck = await get(`/api/vendor/deployments/slug-check?slug=${slug}`, ownerToken);
    check(S, "A free address is available, at the product URL",
      freeCheck.body?.available === true && freeCheck.body?.url === `${PRODUCT_URL}/${slug}`);

    const badSlug = await post("/api/vendor/deployments/provision", { orderId, slug: "Not A Slug" }, ownerToken);
    check(S, "A malformed address is refused before calling the product", badSlug.status === 400 && Boolean(badSlug.body?.fields?.slug));

    const takenProvision = await post("/api/vendor/deployments/provision", { orderId, slug: "taken-already" }, ownerToken);
    const stillSubmitted = await get(`/api/vendor/orders/queue/${orderId}`, ownerToken);
    check(S, "Provisioning at a taken address fails with a suggestion and leaves the order as it was",
      takenProvision.status === 409 && takenProvision.body?.code === "SLUG_TAKEN" &&
        takenProvision.body?.suggestion === "taken-already-2" && stillSubmitted.body?.order?.status === "submitted");

    const supportTry = await post("/api/vendor/deployments/provision", { orderId, slug }, supportToken);
    check(S, "Support cannot provision a real order either", supportTry.status === 403);

    const provisioned = await post("/api/vendor/deployments/provision", { orderId, slug }, ownerToken);
    const pin = provisioned.body?.owner?.temporaryPin;
    check(S, "An owner provisions the order", provisioned.status === 201, provisioned.body?.error);
    check(S, "…and receives the owner's temporary PIN once, in the response", /^\d{6}$/.test(pin || ""));

    const seen = await fake();
    const createCall = seen.received.find((r) => r.method === "POST" && r.path === "/api/internal/organizations" && r.body?.slug === slug);
    check(S, "The product API verified the request's signature", createCall?.verified === true);
    const [, t, sig] = /^SILLA-HMAC t=(\d+),sig=([a-f0-9]{64})$/.exec(createCall?.authorization || "") || [];
    const expected = crypto
      .createHmac("sha256", CONTROL_PLANE_SECRET)
      .update(`${t}\nPOST\n/api/internal/organizations\n${crypto.createHash("sha256").update(createCall?.rawBody || "").digest("hex")}`)
      .digest("hex");
    check(S, "…and the signature is HMAC-SHA256 over time, method, path and body hash, as documented", Boolean(sig) && sig === expected);
    check(S, "It sent the profile, the address, the entitlements and the order it came from",
      createCall?.body?.profile?.organizationName === orgName && createCall?.body?.entitlements?.managed === true &&
        createCall?.body?.source?.orderId === orderId);
    const issued = seen.issued.find((i) => i.temporaryPin === pin);
    check(S, "The PIN returned is the one the product issued", Boolean(issued));

    const live = await get(`/api/vendor/orders/queue/${orderId}`, ownerToken);
    const lo = live.body?.order;
    check(S, "The order is live, at <PRODUCT_URL>/<slug>",
      lo?.status === "live" && lo?.deploymentUrl === `${PRODUCT_URL}/${slug}` && lo?.provisionedOrganizationId === issued?.organizationId);
    const steps = (lo?.history || []).map((h) => h.status);
    check(S, "…having moved through provisioning to live, each step in its history",
      steps.slice(-2).join(">") === "provisioning>live", steps.join(" > "));

    await ensureDb();
    const Subscription = (await import("../src/models/Subscription.js")).default;
    const sub = await Subscription.findOne({ order: orderId }).lean();
    check(S, "Its subscription is linked to the new organization", sub?.organizationId === issued?.organizationId, sub?.status);

    // The PIN must exist nowhere in SILLA's own database.
    const collections = ["orders", "subscriptions", "auditevents", "accounts", "conversations", "messages"];
    const found = [];
    // Whole-word, so the six digits inside an id or a hash cannot count as a leak.
    const pinRx = new RegExp(`\\b${pin}\\b`);
    for (const c of collections) {
      const docs = await mongoose.connection.db.collection(c).find({}).toArray();
      for (const d of docs) {
        const plain = JSON.parse(JSON.stringify(d));
        if (keys(plain).some((k) => /pin/i.test(k))) found.push(`${c}: a pin field`);
        if (strings(plain).some((s) => pinRx.test(s))) found.push(`${c}: the PIN value`);
      }
    }
    check(S, "The temporary PIN is not stored anywhere", found.length === 0, found.slice(0, 3).join("; "));

    const supportCancel = await patch(`/api/vendor/orders/queue/${orderId}`, { status: "cancelled", note: "Trying" }, supportToken);
    check(S, "Support cannot cancel a live order — that switches the customer's system off",
      supportCancel.status === 403 && supportCancel.body?.permission === "deployments.manage");

    const twice = await post("/api/vendor/deployments/provision", { orderId, slug: `${slug}-x`.slice(0, 40) }, ownerToken);
    check(S, "An order cannot be provisioned twice", twice.status === 409 && twice.body?.code === "ALREADY_PROVISIONED");

    // Two presses at once must build one organization, not two.
    const raceOrder = await submittedOrder(buyer, `Race Test ${tag}`);
    const [r1, r2] = await Promise.all([
      post("/api/vendor/deployments/provision", { orderId: raceOrder, slug: `race-a-${tag}`.slice(0, 40) }, ownerToken),
      post("/api/vendor/deployments/provision", { orderId: raceOrder, slug: `race-b-${tag}`.slice(0, 40) }, adminToken),
    ]);
    const creates = (await fake()).received.filter((r) => r.path === "/api/internal/organizations" && r.body?.source?.orderId === raceOrder);
    check(S, "Two simultaneous provisions of one order build exactly one organization",
      [r1.status, r2.status].sort().join(",") === "201,409" && creates.length === 1, `${r1.status}/${r2.status}, ${creates.length} create(s)`);

    const noOwnerOrder = await submittedOrder(buyer, `No Owner ${tag}`, { owner: false });
    const before = (await fake()).received.length;
    const noOwner = await post("/api/vendor/deployments/provision", { orderId: noOwnerOrder, slug: `no-owner-${tag}`.slice(0, 40) }, ownerToken);
    check(S, "A profile with no owner is never provisioned (it would plant the public demo accounts)",
      noOwner.status === 409 && noOwner.body?.code === "NO_OWNER" && (await fake()).received.length === before);

    // The product refuses an address it reserves: its [{ field, message }]
    // list arrives keyed for the form, with the full list beside it.
    const reservedOrder = await submittedOrder(buyer, `Reserved Test ${tag}`);
    const reserved = await post("/api/vendor/deployments/provision", { orderId: reservedOrder, slug: "admin" }, ownerToken);
    check(S, "A reserved address is refused by the product, said under the address field",
      reserved.status === 400 && reserved.body?.code === "INVALID_SLUG" && typeof reserved.body?.fields?.slug === "string" &&
        reserved.body?.problems?.[0]?.field === "slug", JSON.stringify(reserved.body));

    // The ambiguous failure: the product builds the organization, and the
    // answer never arrives. Pressing again must link the order to it, not
    // build a second.
    const lostOrder = await submittedOrder(buyer, `Lost Answer ${tag}`);
    const lostSlug = `lost-${tag}`.slice(0, 40);
    await drill({ kind: "lose-answer" });
    const lost = await post("/api/vendor/deployments/provision", { orderId: lostOrder, slug: lostSlug }, ownerToken);
    const afterLost = await get(`/api/vendor/orders/queue/${lostOrder}`, ownerToken);
    check(S, "A provision whose answer is lost is explained as unreachable, says a retry is safe, and leaves the order as it was",
      lost.status === 502 && lost.body?.code === "CONTROL_PLANE_UNREACHABLE" && Boolean(lost.body?.retry) &&
        afterLost.body?.order?.status === "submitted" && !afterLost.body?.order?.provisionedOrganizationId, JSON.stringify(lost.body));
    const retried = await post("/api/vendor/deployments/provision", { orderId: lostOrder, slug: lostSlug }, ownerToken);
    const lostCreates = (await fake()).received.filter((r) => r.path === "/api/internal/organizations" && r.body?.source?.orderId === lostOrder);
    const builtFor = (await fake()).issued.filter((i) => lostCreates.length && i.email === lostCreates[0].body?.profile?.owner?.email);
    check(S, "…and pressing again links the order to the organization that was built, rather than building a twin",
      retried.status === 201 && retried.body?.adopted === true && retried.body?.owner === null && Boolean(retried.body?.notice) &&
        retried.body?.order?.status === "live" && retried.body?.deployment?.slug === lostSlug && builtFor.length === 1,
      `${retried.status} ${retried.body?.error || ""}; ${builtFor.length} organization(s) built`);
    const lostSub = await (await import("../src/models/Subscription.js")).default.findOne({ order: lostOrder }).lean();
    check(S, "…with its subscription linked and its trial started, as for any provision",
      lostSub?.organizationId === builtFor[0]?.organizationId && lostSub?.status === "trialing", lostSub?.status);

    // By hand, for when the control plane is down: the same billing step.
    const manualOrder = await submittedOrder(buyer, `Manual Test ${tag}`);
    await patch(`/api/vendor/orders/queue/${manualOrder}`, { status: "provisioning", note: "Seeding by hand" }, ownerToken);
    const manualLive = await patch(`/api/vendor/orders/queue/${manualOrder}`,
      { status: "live", deploymentUrl: `${PRODUCT_URL}/manual-${tag}`, provisionedOrganizationId: `manual-org-${tag}` }, ownerToken);
    const manualSub = await (await import("../src/models/Subscription.js")).default.findOne({ order: manualOrder }).lean();
    check(S, "Going live by hand starts the trial and links the organization, like the one-press path",
      manualLive.status === 200 && manualSub?.status === "trialing" && manualSub?.organizationId === `manual-org-${tag}`,
      `${manualLive.status} ${manualLive.body?.error || ""} ${manualSub?.status}`);
    const repoint = await patch(`/api/vendor/orders/queue/${orderId}`, { provisionedOrganizationId: `manual-org-${tag}` }, ownerToken);
    check(S, "A console-provisioned order's organization can't be re-pointed by hand", repoint.status === 409 && Boolean(repoint.body?.fields?.provisionedOrganizationId));
    const sameOrg = await patch(`/api/vendor/orders/queue/${noOwnerOrder}`, { provisionedOrganizationId: `manual-org-${tag}` }, ownerToken);
    check(S, "…and two orders can never be linked to one organization", sameOrg.status === 409 && Boolean(sameOrg.body?.fields?.provisionedOrganizationId),
      sameOrg.body?.error);

    const detail = await get(`/api/vendor/deployments/${orderId}`, supportToken);
    check(S, "Deployment detail carries the product's live usage, activity and owners",
      typeof detail.body?.live?.usage?.resources === "number" && detail.body?.live?.owners?.[0]?.email === createCall?.body?.profile?.owner?.email &&
        detail.body?.can?.ownerAccess === true && detail.body?.can?.sync === false);

    const listed = await get("/api/vendor/deployments", supportToken);
    check(S, "The deployments list shows it with its subscription status",
      listed.body?.deployments?.some((d) => d.orderId === orderId && d.subscription?.status && d.url === `${PRODUCT_URL}/${slug}`));

    const access = await post(`/api/vendor/deployments/${orderId}/owner-access`, {}, supportToken);
    const accessPin = access.body?.owner?.temporaryPin;
    check(S, "Support can re-issue an owner's access, and sees the new PIN once",
      access.status === 200 && /^\d{6}$/.test(accessPin || "") && (await fake()).issued.some((i) => i.temporaryPin === accessPin));
    await patch(`/api/vendor/staff/${supportId}`, { staffRole: "billing" }, ownerToken);
    const billingAccess = await post(`/api/vendor/deployments/${orderId}/owner-access`, {}, supportToken);
    check(S, "Billing staff cannot re-issue owner access", billingAccess.status === 403);
    await patch(`/api/vendor/staff/${supportId}`, { staffRole: "support" }, ownerToken);

    const syncSupport = await post(`/api/vendor/deployments/${orderId}/sync`, {}, supportToken);
    const putsBefore = (await fake()).received.filter((r) => r.method === "PUT").length;
    const sync = await post(`/api/vendor/deployments/${orderId}/sync`, {}, ownerToken);
    const puts = (await fake()).received.filter((r) => r.method === "PUT" && r.verified);
    check(S, "An owner can push the plan to the deployment again; support cannot",
      syncSupport.status === 403 && sync.body?.ok === true && puts.length > putsBefore, sync.body?.error);

    await drill({ kind: "unconfigured" });
    const unconfigured = await get(`/api/vendor/deployments/${orderId}`, ownerToken);
    const unconfiguredSlug = await get("/api/vendor/deployments/slug-check?slug=whatever-free", ownerToken);
    check(S, "A product API without the secret is explained, and the local half still loads",
      unconfigured.status === 200 && unconfigured.body?.liveError?.code === "CONTROL_PLANE_UNCONFIGURED" &&
        unconfigured.body?.liveError?.side === "product" && unconfiguredSlug.status === 503);
    await drill({ kind: "drop" });
    const down = await get("/api/vendor/deployments/slug-check?slug=whatever-free", ownerToken);
    check(S, "An unreachable product API is explained as unreachable", down.status === 502 && down.body?.code === "CONTROL_PLANE_UNREACHABLE");
    await drill(null);

    const clientPicture = await get(`/api/vendor/clients/${buyer.id}`, supportToken);
    const cp = clientPicture.body;
    check(S, "A client's whole picture: profile, orders, subscriptions, deployments, activity",
      cp?.client?.email === buyer.email && cp?.orders?.some((o) => o.id === orderId) && cp?.subscriptions?.length >= 1 &&
        cp?.deployments?.some((d) => d.orderId === orderId) && cp?.activity?.some((e) => e.action === "deployment.provision"));
    check(S, "…with invoice amounts withheld from a role without billing.read", cp?.invoices === null);
    check(S, "…and kept out of its activity trail too",
      !(cp?.activity || []).some((e) => e.action.startsWith("invoice.") || e.target?.type === "invoice") &&
        (cp?.activity || []).every((e) => !e.meta || !Object.keys(e.meta).length));
    const ownerPicture = await get(`/api/vendor/clients/${buyer.id}`, ownerToken);
    check(S, "An owner sees the invoices and their trail", Array.isArray(ownerPicture.body?.invoices) &&
      (ownerPicture.body?.activity || []).some((e) => e.action === "invoice.issue"));

    const putsBeforeEnd = (await fake()).received.filter((r) => r.method === "PUT").length;
    const ended = await patch(`/api/vendor/orders/queue/${orderId}`, { status: "cancelled", note: "Customer moved on" }, ownerToken);
    const putsAfterEnd = (await fake()).received.filter((r) => r.method === "PUT" && r.verified);
    check(S, "An owner can cancel a live order: its subscription ends and the deployment is told",
      ended.status === 200 && ended.body?.order?.status === "cancelled" && putsAfterEnd.length > putsBeforeEnd &&
        putsAfterEnd.at(-1)?.body?.status === "cancelled", ended.body?.error);
  }

  /* ── the overview ── */

  const overview = await get("/api/vendor/staff/overview", ownerToken);
  const supportOverview = await get("/api/vendor/staff/overview", supportToken);
  check(S, "The overview counts orders and conversations, and shows an owner billing and recent activity",
    typeof overview.body?.orders?.submitted === "number" && typeof overview.body?.conversations?.unread === "number" &&
      overview.body?.billing && Array.isArray(overview.body?.recent));
  check(S, "…while support sees no money and no activity feed", supportOverview.body?.billing === null && supportOverview.body?.recent === null);

  /* ── the audit trail ── */

  const expected = [
    "staff.invite", "staff.invite.resend", "staff.invite.accept", "staff.role", "staff.deactivate", "staff.reactivate",
    "order.note", "order.status",
    ...(FAKE ? ["deployment.provision", "deployment.provision.failed", "deployment.owner_access", "deployment.sync"] : []),
  ];
  const trail = [];
  let cursor = null;
  do {
    const page = await get(`/api/vendor/audit?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`, ownerToken);
    trail.push(...(page.body?.events || []));
    cursor = page.body?.next;
  } while (cursor && trail.length < 2000);
  const missing = expected.filter((action) => !trail.some((e) => e.action === action));
  check(S, `Every staff action above left an audit entry (${expected.length} kinds)`, missing.length === 0, missing.join(", "));
  // Every PIN the product handed out in this run, looked for by value:
  // "any six digits" would also match a price in centavos.
  const issuedPins = FAKE ? (await fake()).issued.map((i) => i.temporaryPin) : [];
  const pinsInTrail = trail.filter((e) => issuedPins.some((p) => new RegExp(`\\b${p}\\b`).test(`${e.summary} ${JSON.stringify(e.meta)}`)));
  check(S, `No audit entry carries a temporary PIN (${issuedPins.length} looked for)`, pinsInTrail.length === 0,
    pinsInTrail.map((e) => e.summary).slice(0, 2).join("; "));
  const invites = await get(`/api/vendor/audit?action=staff&targetId=${supportId}`, ownerToken);
  check(S, "The log filters by action family and target",
    invites.body?.events?.length >= 3 && invites.body.events.every((e) => e.action.startsWith("staff.") && e.target.id === supportId));
  const firstPage = await get("/api/vendor/audit?limit=2", ownerToken);
  const secondPage = await get(`/api/vendor/audit?limit=2&before=${encodeURIComponent(firstPage.body?.next || "")}`, ownerToken);
  check(S, "The log pages without repeating rows",
    firstPage.body?.events?.length === 2 && secondPage.body?.events?.length === 2 &&
      !secondPage.body.events.some((e) => firstPage.body.events.some((f) => f.id === e.id)));
  const actorFilter = await get(`/api/vendor/audit?actor=${ownerId}&limit=200`, ownerToken);
  check(S, "…and by who did it", actorFilter.body?.events?.length > 0 && actorFilter.body.events.every((e) => e.actor === ownerId));
}
