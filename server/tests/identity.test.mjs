/**
 * INF-3, INF-4, ID-1..ID-3, AUTH-1..AUTH-4 — identity, registration and
 * the check-in interface.
 */
import { ORG, TEST_EMAIL_DOMAIN, auth, emailIsLive, login, makeMember, req, uid, unique, verifyOutOfBand } from "./helpers.mjs";

export const name = "Identity, registration & check-in";

export async function run(check) {
  // Whether a real mail provider is carrying the one-time codes. When it
  // is, the dev fallback is off by design and the two checks that need
  // to READ a code step aside instead of failing.
  const liveEmail = await emailIsLive();

  /* ── INF-3: the check-in interface ── */
  const methods = await req("/api/checkin/methods");
  check("INF-3", "RFID is the only registered implementation",
    JSON.stringify(methods.body?.implemented) === '["rfid"]', JSON.stringify(methods.body?.implemented));
  check("INF-3", "QR is listed as fast-follow, not implemented",
    methods.body?.plannedFastFollow?.includes("qr") && !methods.body?.implemented?.includes("qr"));

  const qr = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, method: "qr", credential: "ABCD1234" }) });
  check("INF-3", "A QR tap is refused while the org is configured for RFID", qr.status === 400, qr.body?.error);

  const bad = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: "not-a-uid!!" }) });
  check("INF-3", "A malformed UID is rejected by the interface", bad.status === 400, bad.body?.error);

  const unknown = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: uid() }) });
  check("INF-3", "An unknown card returns unregistered, which triggers ID-1",
    unknown.body?.outcome === "unregistered" && unknown.body?.next === "register");

  /* ── ID-1: config-driven registration ── */
  const reqs = await req(`/api/registration/requirements?organizationId=${ORG}`);
  check("ID-1", "The kiosk reads the member-ID format from org config",
    /^[#A*\-\/ ]+$/.test(reqs.body?.memberIdFormat || ""), reqs.body?.memberIdFormat);
  check("ID-1", "An example is generated from that format",
    Boolean(reqs.body?.memberIdExample), reqs.body?.memberIdExample);

  const badFormat = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: uid(), memberId: "NOPE", firstName: "A", lastName: "B",
    email: `bad-${unique()}${TEST_EMAIL_DOMAIN}`, pin: "123456" }) });
  check("ID-1", "A member ID not matching the org's format is rejected", badFormat.status === 400, badFormat.body?.error);

  const shortPin = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: uid(), memberId: reqs.body.memberIdExample, firstName: "A", lastName: "B",
    email: `pin-${unique()}${TEST_EMAIL_DOMAIN}`, pin: "1234" }) });
  check("ID-1", "A 4-digit PIN is rejected — the spec requires 6", shortPin.status === 400, shortPin.body?.error);

  /* ── ID-2: verification, and pending-until-verified ── */
  const card = uid();
  const email = `member-${unique()}${TEST_EMAIL_DOMAIN}`;
  const memberId = `2098-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  // Deliberately messy UID: lower case with separators, as a different
  // reader model would emit it.
  const messy = card.toLowerCase().match(/.{2}/g).join(":");
  const started = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: messy, memberId, firstName: "Ver", lastName: "Test",
    email, pin: "246810" }) });
  check("ID-1", "Registration creates a pending account", started.status === 201, `status ${started.status}`);
  // The dev fallback returns the code so this can be asserted. With a
  // real provider configured it is (correctly) absent, and no test can
  // read an inbox — so the check announces why it stepped aside rather
  // than failing for a reason unrelated to what it tests.
  if (liveEmail) {
    check("ID-2", "A verification code is issued", "skip",
      "email is live, so the code is only in the inbox");
  } else {
    check("ID-2", "A verification code is issued", /^\d{6}$/.test(started.body?.devVerificationCode || ""));
  }

  const pendingTap = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: card }) });
  check("INF-3", "A messy-format UID resolves to the same canonical card",
    pendingTap.body?.cardUid === card, pendingTap.body?.cardUid);
  check("ID-2", "An unverified account taps as pending", pendingTap.body?.next === "verify");

  const early = await login(email, "246810");
  check("ID-2", "An unverified account cannot sign in (pending until verified)",
    early?.requiresVerification === true || !early?.token);

  const wrong = await req("/api/registration/verify", { method: "POST",
    body: JSON.stringify({ registrationId: started.body.registrationId, code: "000000" }) });
  check("ID-2", "A wrong code is rejected and reports attempts remaining",
    wrong.status === 401 && typeof wrong.body?.attemptsRemaining === "number");

  if (liveEmail) {
    check("ID-2", "The correct code verifies the account", "skip",
      "the code is only in the inbox");
    // Complete it anyway, so the checks that follow still test card
    // resolution and sign-in rather than an account stuck pending.
    await verifyOutOfBand(started.body.registrationId);
  } else {
    const verified = await req("/api/registration/verify", { method: "POST",
      body: JSON.stringify({ registrationId: started.body.registrationId,
        code: started.body.devVerificationCode }) });
    check("ID-2", "The correct code verifies the account", verified.status === 200);
  }

  const memberTap = await req("/api/checkin/tap", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, credential: card }) });
  check("INF-3", "The verified card now resolves to the member",
    memberTap.body?.outcome === "member" && memberTap.body?.member?.memberId === memberId);
  check("INF-3", "The interface resolves identity only — the route decides what follows",
    memberTap.body?.next === "walk-in" && !("reservation" in (memberTap.body || {})), `next=${memberTap.body?.next}`);

  /* ── ID-3: org-scoped uniqueness, rejected by field name ── */
  const dupEmail = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: uid(), memberId: `2097-${unique().slice(-6)}`,
    firstName: "D", lastName: "E", email, pin: "111111" }) });
  check("ID-3", "A duplicate email is rejected by name, not a raw E11000",
    dupEmail.status === 409 && /email/i.test(dupEmail.body?.error || ""), dupEmail.body?.error);

  const dupCard = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: card, memberId: `2096-${unique().slice(-6)}`,
    firstName: "D", lastName: "C", email: `dc-${unique()}${TEST_EMAIL_DOMAIN}`, pin: "111111" }) });
  check("ID-3", "A duplicate card is rejected by name",
    dupCard.status === 409 && /card/i.test(dupCard.body?.error || ""), dupCard.body?.error);

  const dupId = await req("/api/registration/start", { method: "POST", body: JSON.stringify({
    organizationId: ORG, cardUid: uid(), memberId,
    firstName: "D", lastName: "I", email: `di-${unique()}${TEST_EMAIL_DOMAIN}`, pin: "111111" }) });
  check("ID-3", "A duplicate member ID is rejected by name",
    dupId.status === 409 && /id/i.test(dupId.body?.error || ""), dupId.body?.error);

  /* ── AUTH-1 / AUTH-2 ── */
  const member = await login(email, "246810");
  check("AUTH-1", "A verified member signs in with email + PIN", Boolean(member?.token));
  const admin = await login("admin@demo.test", "123456");
  check("AUTH-1", "The same login works for staff roles", admin?.user?.role === "superadmin");

  const rl = await req("/api/auth/login", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, email, pin: "246810" }) });
  check("AUTH-2", "Login carries rate-limit headers",
    rl.headers.get("ratelimit-limit") === "10", `limit=${rl.headers.get("ratelimit-limit")}`);

  // Per-account lockout: the org's threshold is 5 wrong PINs.
  const victim = await makeMember("lockout", "135790");
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await login(victim.email, "000000");
    statuses.push(r?.error ? (r.error.includes("locked") ? 423 : 401) : 200);
    if (statuses.at(-1) === 423) break;
  }
  check("AUTH-2", "An account locks after repeated wrong PINs",
    statuses.includes(423), `statuses: ${statuses.join(",")}`);
  const whileLocked = await login(victim.email, "135790");
  check("AUTH-2", "Even the correct PIN is refused while locked",
    Boolean(whileLocked?.error) && !whileLocked?.token);

  /* ── AUTH-4: PIN reset ── */
  const resetMe = await makeMember("reset", "555555");
  const unknownAddr = await req("/api/auth/request-pin-reset", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, email: `nobody-${unique()}${TEST_EMAIL_DOMAIN}` }) });
  check("AUTH-4", "An unknown address still answers 200 — no membership oracle",
    unknownAddr.status === 200 && !unknownAddr.body?.devResetCode);

  const asked = await req("/api/auth/request-pin-reset", { method: "POST",
    body: JSON.stringify({ organizationId: ORG, email: resetMe.email }) });
  check("AUTH-4", "A reset code is issued for a real account",
    liveEmail ? asked.status === 200 : Boolean(asked.body?.devResetCode),
    liveEmail ? "email is live — asserted acceptance, not the code" : "");

  if (liveEmail) {
    check("AUTH-4", "The correct code sets a new PIN", "skip", "the code is only in the inbox");
    check("AUTH-4", "The new PIN is immediately usable", "skip", "needs the emailed code");
  } else {
    const done = await req("/api/auth/reset-pin", { method: "POST", body: JSON.stringify({
      organizationId: ORG, email: resetMe.email, code: asked.body.devResetCode, newPin: "666666" }) });
    check("AUTH-4", "The correct code sets a new PIN", done.status === 200);
    check("AUTH-4", "The new PIN is immediately usable", Boolean((await login(resetMe.email, "666666"))?.token));
  }

  /* ── AUTH-3: terms gate, on a freshly provisioned account ── */
  const adminAuth = auth(admin.token);
  const staffEmail = `gate-${unique()}${TEST_EMAIL_DOMAIN}`;
  const provisioned = await req("/api/admin/staff", { method: "POST", headers: adminAuth,
    body: JSON.stringify({ firstName: "Gate", lastName: "Test", email: staffEmail, role: "staff" }) });
  check("ADM-4", "A superadmin provisions staff with a temporary PIN",
    provisioned.status === 201 && Boolean(provisioned.body?.temporaryPin));

  const first = await login(staffEmail, provisioned.body.temporaryPin);
  check("ADM-4", "A provisioned account must change its PIN first", first?.user?.mustChangePin === true);
  check("AUTH-3", "…and must accept the terms", first?.user?.requiresTermsAcceptance === true);

  const changed = await req("/api/auth/change-pin", { method: "POST", headers: auth(first.token),
    body: JSON.stringify({ currentPin: provisioned.body.temporaryPin, newPin: "778899" }) });
  check("ADM-4", "The forced PIN change succeeds", changed.status === 200);

  const noAuth = await req("/api/auth/accept-terms", { method: "POST",
    body: JSON.stringify({ userId: "6a8ed2b8587f249ffe338781" }) });
  check("AUTH-3", "accept-terms refuses unauthenticated callers (the old IDOR)", noAuth.status === 401);

  const accepted = await req("/api/auth/accept-terms", { method: "POST", headers: auth(first.token) });
  check("AUTH-3", "An authenticated user can accept their own terms", accepted.status === 200);
  const again = await req("/api/auth/accept-terms", { method: "POST", headers: auth(first.token) });
  check("AUTH-3", "Re-accepting does not move the timestamp — acceptance is once only",
    again.body?.termsAcceptedAt === accepted.body?.termsAcceptedAt);
}
