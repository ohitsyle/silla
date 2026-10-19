/**
 * Accounts: sign-up with verification, sign-in, profile, email change,
 * password change and reset, billing details.
 */
import { KNOWN_CODE, plantCode, readAccount } from "./helpers.mjs";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const post = (path, body, headers) => req(path, { method: "POST", headers, body: JSON.stringify(body) });

export const name = "Accounts";

export async function run(check) {
  const tag = unique();
  const email = `acct-${tag}@test.silla`;
  const password = "a-long-enough-password";
  const base = { firstName: "Ana", middleName: "Maria", lastName: "Reyes", suffix: "", email, confirmEmail: email, password, acceptTerms: true };

  /* ── no reserved test address ever reaches a mail provider ── */
  // The transport's own guard, read directly: the suites sign up at
  // @test.silla, staff here live at owner@silla.test, and a product's demo
  // accounts at admin@demo.test. RFC 2606 reserves .test, .example,
  // .invalid and .localhost, and example.com, .net and .org.
  const { isUndeliverable } = await import("../src/services/email/index.js");
  const reserved = [
    "admin@demo.test", "owner@silla.test", "billing@harborview.test", "Ana Reyes <ana@demo.test>", "ADMIN@DEMO.TEST.",
    "x@school.example", "a@example.com", "a@mail.example.org", email, "x@host.invalid", "x@localhost",
  ];
  const leaked = reserved.filter((address) => !isUndeliverable(address));
  check("MAIL-1", "The mail transport refuses every reserved test address (.test, .example, example.com, @test.silla)",
    leaked.length === 0, leaked.length ? "would send: " + leaked.join(", ") : `${reserved.length} refused`);
  const real = ["someone@gmail.com", "ana@library.edu.ph", "x@testing.com", "x@example.com.ph", "x@contest.org", "x@test.silla.ph"];
  const refused = real.filter((address) => isUndeliverable(address));
  check("MAIL-1", "…and still sends to real domains that merely contain those words",
    refused.length === 0, refused.length ? "refused: " + refused.join(", ") : `${real.length} sent`);

  /* ── availability ── */
  const free = await req(`/api/vendor/auth/email-available?email=${encodeURIComponent(email)}`);
  check("ACC-1", "An unused email reports as available", free.body?.available === true && free.body?.valid === true);
  const junk = await req(`/api/vendor/auth/email-available?email=not-an-email`);
  check("ACC-1", "A malformed email reports as invalid, not available", junk.body?.valid === false);

  /* ── sign-up validation ── */
  const noTerms = await post("/api/vendor/auth/register", { ...base, acceptTerms: false });
  check("ACC-2", "Sign-up without agreeing to the terms is refused", noTerms.status === 400 && Boolean(noTerms.body?.fields?.acceptTerms));
  const truthyTerms = await post("/api/vendor/auth/register", { ...base, acceptTerms: "yes" });
  check("ACC-2", "…and only a literal true counts as agreeing", truthyTerms.status === 400);
  const mismatch = await post("/api/vendor/auth/register", { ...base, confirmEmail: `other-${tag}@test.silla` });
  check("ACC-2", "Mismatched confirmation email is refused on its own field", mismatch.status === 400 && Boolean(mismatch.body?.fields?.confirmEmail));
  const noName = await post("/api/vendor/auth/register", { ...base, firstName: "", lastName: "" });
  check("ACC-2", "First and last name are required, each named", Boolean(noName.body?.fields?.firstName && noName.body?.fields?.lastName));
  const badSuffix = await post("/api/vendor/auth/register", { ...base, suffix: "Esq." });
  check("ACC-2", "A suffix outside the list is refused", badSuffix.status === 400 && Boolean(badSuffix.body?.fields?.suffix));

  /* ── sign-up ── */
  const signup = await post("/api/vendor/auth/register", base);
  check("ACC-3", "A valid sign-up creates a signed-in account", signup.status === 201 && Boolean(signup.body?.token));
  check("ACC-3", "…which starts unverified", signup.body?.account?.emailVerified === false);
  check("ACC-3", "…with the name composed from its parts", signup.body?.account?.name === "Ana Maria Reyes", signup.body?.account?.name);
  const stored = await readAccount(email);
  check("ACC-3", "Terms acceptance is recorded with a version", Boolean(stored?.termsAcceptedAt && stored?.termsVersion));
  check("ACC-3", "The code is stored hashed, never in the clear", /^\$2[aby]\$/.test(stored?.verification?.codeHash || ""));

  const taken = await req(`/api/vendor/auth/email-available?email=${encodeURIComponent(email)}`);
  check("ACC-1", "Once registered, the email reports as taken", taken.body?.available === false);
  const dupe = await post("/api/vendor/auth/register", base);
  check("ACC-3", "The same email cannot register twice", dupe.status === 409 && Boolean(dupe.body?.fields?.email));

  let T = signup.body.token;

  /* ── verification ── */
  const early = await req("/api/vendor/orders", {
    method: "POST", headers: auth(T),
    body: JSON.stringify({ profile: { organizationName: "Unverified Co" }, plan: "room" }),
  });
  check("ACC-4", "An unverified account can still save a draft", early.status === 201);
  const blocked = await post(`/api/vendor/orders/${early.body?.order?.id}/submit`, {}, auth(T));
  check("ACC-4", "…but cannot submit an order", blocked.status === 403 && blocked.body?.code === "EMAIL_UNVERIFIED", blocked.body?.error);

  const resendTooSoon = await post("/api/vendor/auth/me/verify/resend", {}, auth(T));
  check("ACC-4", "Resending a code immediately is throttled", resendTooSoon.status === 429 && typeof resendTooSoon.body?.retryAfterSeconds === "number");

  await plantCode(email, "signup");
  const wrong = await post("/api/vendor/auth/me/verify", { code: "000000" }, auth(T));
  check("ACC-4", "A wrong code is refused and says how many tries remain", wrong.status === 401 && wrong.body?.attemptsRemaining === 4, wrong.body?.error);
  const malformed = await post("/api/vendor/auth/me/verify", { code: "12ab" }, auth(T));
  check("ACC-4", "A malformed code is refused without spending an attempt", malformed.status === 400);

  await plantCode(email, "signup", { expired: true });
  const expired = await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, auth(T));
  check("ACC-4", "An expired code is refused even when correct", expired.status === 410);

  await plantCode(email, "signup");
  for (let i = 0; i < 5; i += 1) await post("/api/vendor/auth/me/verify", { code: "111111" }, auth(T));
  const exhausted = await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, auth(T));
  check("ACC-4", "After five wrong codes even the right one is refused", exhausted.status === 429);

  const resend = await post("/api/vendor/auth/me/verify/resend", {}, auth(T));
  check("ACC-4", "A new code can be requested once the cooldown has passed", resend.status === 200);

  await plantCode(email, "signup");
  const verified = await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, auth(T));
  check("ACC-4", "The correct code verifies the account", verified.status === 200 && verified.body?.account?.emailVerified === true);
  const reused = await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, auth(T));
  check("ACC-4", "Verifying again is harmless", reused.status === 200 && reused.body?.alreadyVerified === true);
  const nowSubmits = await post(`/api/vendor/orders/${early.body?.order?.id}/submit`, {}, auth(T));
  check("ACC-4", "Once verified, the order can be submitted", nowSubmits.status === 200, nowSubmits.body?.error);

  /* ── sign-in ── */
  const badLogin = await post("/api/vendor/auth/login", { email, password: "wrong-password-entirely" });
  const ghostLogin = await post("/api/vendor/auth/login", { email: `nobody-${tag}@test.silla`, password });
  check("ACC-5", "Wrong password and unknown email give the same answer", badLogin.status === 401 && badLogin.body?.error === ghostLogin.body?.error);
  const login = await post("/api/vendor/auth/login", { email: email.toUpperCase(), password });
  check("ACC-5", "Sign-in works and ignores email case", login.status === 200 && login.body?.account?.emailVerified === true);

  /* ── profile ── */
  const renamed = await req("/api/vendor/auth/me", {
    method: "PATCH", headers: auth(T),
    body: JSON.stringify({ firstName: "Ana", middleName: "", lastName: "Reyes-Cruz", suffix: "Jr.", organizationName: "Harborview" }),
  });
  check("ACC-6", "Personal details can be updated", renamed.status === 200 && renamed.body?.account?.name === "Ana Reyes-Cruz Jr.", renamed.body?.account?.name);
  const blankName = await req("/api/vendor/auth/me", { method: "PATCH", headers: auth(T), body: JSON.stringify({ firstName: "", lastName: "X" }) });
  check("ACC-6", "…but not blanked", blankName.status === 400);

  /* ── billing ── */
  const billing = await req("/api/vendor/auth/me/billing", {
    method: "PATCH", headers: auth(T),
    body: JSON.stringify({ name: "Ana Reyes", company: "Harborview", email: "billing@harborview.test", phone: "+63 917 123 4567", address1: "12 Harbour St", city: "Manila", region: "Metro Manila", postalCode: "1000", country: "Philippines", taxId: "123-456-789-00000" }),
  });
  check("ACC-7", "Billing details save, including a 14-digit TIN", billing.status === 200 && billing.body?.account?.billing?.taxId === "123-456-789-00000", billing.body?.error);
  const card = await req("/api/vendor/auth/me/billing", {
    method: "PATCH", headers: auth(T), body: JSON.stringify({ name: "Ana", address1: "4242 4242 4242 4242" }),
  });
  check("ACC-7", "A card number is refused wherever it is typed", card.status === 400, card.body?.error);

  /* ── email change ── */
  const newEmail = `moved-${tag}@test.silla`;
  const noPw = await post("/api/vendor/auth/me/email", { newEmail, password: "not-it-at-all" }, auth(T));
  check("ACC-8", "Changing email needs the current password", noPw.status === 401 && Boolean(noPw.body?.fields?.password));
  const asked = await post("/api/vendor/auth/me/email", { newEmail, password }, auth(T));
  check("ACC-8", "A code is sent to the new address", asked.status === 200 && asked.body?.account?.pendingEmail === newEmail);
  check("ACC-8", "…while the account keeps its current address", asked.body?.account?.email === email);

  await plantCode(email, "email-change", { pendingEmail: newEmail });
  const confirmed = await post("/api/vendor/auth/me/email/confirm", { code: KNOWN_CODE }, auth(T));
  check("ACC-8", "The code moves the account to the new address", confirmed.status === 200 && confirmed.body?.account?.email === newEmail);
  const oldLogin = await post("/api/vendor/auth/login", { email, password });
  check("ACC-8", "The old address no longer signs in", oldLogin.status === 401);

  /* ── password change ── */
  const other = await post("/api/vendor/auth/login", { email: newEmail, password });
  const otherSession = other.body?.token;
  const wrongCurrent = await post("/api/vendor/auth/me/password", { currentPassword: "nope-nope-nope", newPassword: "another-long-password" }, auth(T));
  check("ACC-9", "A wrong current password is refused", wrongCurrent.status === 401);
  const same = await post("/api/vendor/auth/me/password", { currentPassword: password, newPassword: password }, auth(T));
  check("ACC-9", "Reusing the current password is refused", same.status === 400);
  // iat is whole seconds: make sure the old session was minted in an
  // earlier second than the change, as a real one would be.
  await new Promise((r) => setTimeout(r, 1100));
  const changed = await post("/api/vendor/auth/me/password", { currentPassword: password, newPassword: "another-long-password" }, auth(T));
  check("ACC-9", "The password can be changed, returning a fresh session", changed.status === 200 && Boolean(changed.body?.token));
  const stale = await req("/api/vendor/auth/me", { headers: auth(otherSession) });
  check("ACC-9", "Every other session is signed out", stale.status === 401 && stale.body?.code === "SESSION_REVOKED", `status ${stale.status}`);
  T = changed.body.token;
  const fresh = await req("/api/vendor/auth/me", { headers: auth(T) });
  check("ACC-9", "…but the session that made the change still works", fresh.status === 200);

  /* ── forgot / reset ── */
  const forgotReal = await post("/api/vendor/auth/forgot-password", { email: newEmail });
  const forgotGhost = await post("/api/vendor/auth/forgot-password", { email: `ghost-${tag}@test.silla` });
  check("ACC-10", "Forgot-password answers identically whether or not the account exists",
    forgotReal.status === 200 && forgotGhost.status === 200 && forgotReal.body?.message === forgotGhost.body?.message);

  await plantCode(newEmail, "password-reset");
  const badReset = await post("/api/vendor/auth/reset-password", { email: newEmail, code: "999999", newPassword: "reset-to-this-one" });
  check("ACC-10", "A wrong reset code is refused", badReset.status === 401);
  const reset = await post("/api/vendor/auth/reset-password", { email: newEmail, code: KNOWN_CODE, newPassword: "reset-to-this-one" });
  check("ACC-10", "The right code sets a new password and signs in", reset.status === 200 && Boolean(reset.body?.token), reset.body?.error);
  const resetSession = await req("/api/vendor/auth/me", { headers: auth(reset.body?.token) });
  check("ACC-10", "…and the session it hands back is not itself revoked", resetSession.status === 200, `status ${resetSession.status}`);
  const afterReset = await post("/api/vendor/auth/login", { email: newEmail, password: "reset-to-this-one" });
  check("ACC-10", "The new password signs in", afterReset.status === 200);
}
