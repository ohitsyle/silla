import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Account from "../models/Account.js";
import { requireAccount } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { CODE_TTL_MINUTES, consumeCode, cooldownRemaining, issueCode } from "../lib/codes.js";
import { sendEmail } from "../services/email/index.js";
import {
  emailChangeCodeEmail,
  emailChangedNoticeEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
  welcomeEmail,
} from "../services/email/templates.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TOKEN_TTL = "12h";

/**
 * Bumped whenever the Terms & Conditions change materially, so we know
 * which text a given account agreed to. Matches the "last updated" date
 * shown on the terms page.
 */
export const TERMS_VERSION = "2026-09-17";

const SUFFIXES = ["", "Jr.", "Sr.", "II", "III", "IV", "V"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const sign = (account) =>
  jwt.sign({ id: account._id.toString(), role: account.role }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });

const normEmail = (value) => String(value || "").trim().toLowerCase();
const clean = (value, max = 80) => String(value ?? "").trim().slice(0, max);

/** What the portal is allowed to know about an account. Never a hash. */
function publicShape(account) {
  const v = account.verification;
  const live = v && new Date(v.expiresAt).getTime() > Date.now();
  return {
    id: account._id.toString(),
    email: account.email,
    firstName: account.firstName,
    middleName: account.middleName,
    lastName: account.lastName,
    suffix: account.suffix,
    name: account.name,
    organizationName: account.organizationName,
    role: account.role,
    emailVerified: Boolean(account.emailVerified),
    termsAcceptedAt: account.termsAcceptedAt,
    billing: account.billing || {},
    createdAt: account.createdAt,
    passwordChangedAt: account.passwordChangedAt,
    // Lets the portal show "we sent a code to …" and run the resend
    // countdown from the server's clock rather than guessing.
    pendingEmail: live && v.purpose === "email-change" ? v.pendingEmail : null,
    codeSentAt: live ? v.sentAt : null,
    codePurpose: live ? v.purpose : null,
  };
}

/**
 * Password rules: length only, 10 to 200 characters.
 * Composition rules push people towards "Password1!", and a long
 * passphrase beats a short complicated one.
 */
function passwordProblem(password) {
  const pw = String(password || "");
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}

/** Field-keyed errors, so the form can put each message under its own input. */
function nameProblems(body) {
  const fields = {};
  if (!clean(body.firstName)) fields.firstName = "Enter your first name.";
  if (!clean(body.lastName)) fields.lastName = "Enter your last name.";
  if (body.suffix && !SUFFIXES.includes(body.suffix)) fields.suffix = "Choose a suffix from the list.";
  return fields;
}

const reject = (res, status, error, fields) => res.status(status).json({ error, ...(fields ? { fields } : {}) });

/* ──────────────────────────── availability ──────────────────────────── */

/**
 * Whether an email can be used to sign up — so the form can say so
 * while it's being typed rather than after the whole form is filled.
 *
 * This does reveal whether an address has an account. That is not new:
 * register already has to answer 409 for a taken email. Rate limited so
 * it cannot be used to enumerate a list quickly.
 */
router.get(
  "/email-available",
  rateLimit({ name: "email-available", windowMs: 10 * 60 * 1000, max: 80 }),
  asyncHandler(async (req, res) => {
    const email = normEmail(req.query.email);
    if (!EMAIL_RE.test(email)) return res.json({ available: false, valid: false });
    const taken = await Account.exists({ email });
    res.json({ available: !taken, valid: true });
  })
);

/* ────────────────────────────── sign up ────────────────────────────── */

/**
 * Sign up.
 *
 * Always creates a `buyer`. There is deliberately no way to create a
 * SILLA staff account over HTTP — staff are minted by the seed script,
 * because an endpoint that can grant itself the queue is a back door
 * however carefully it is guarded.
 *
 * The account is created UNVERIFIED and signed in. The person can keep
 * exploring and configuring immediately; only placing an order needs
 * the verified address. Blocking the whole site behind a code would be
 * the sign-up wall this storefront is built to avoid.
 */
router.post(
  "/register",
  rateLimit({ name: "register", windowMs: 60 * 60 * 1000, max: 20 }),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const fields = nameProblems(body);

    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
    else if (normEmail(body.confirmEmail) !== email) fields.confirmEmail = "The two email addresses don't match.";

    const pwProblem = passwordProblem(body.password);
    if (pwProblem) fields.password = pwProblem;

    // Checked on the server too. The checkbox is a UI; this is the rule.
    if (body.acceptTerms !== true) fields.acceptTerms = "You need to agree to the Terms & Conditions to create an account.";

    if (Object.keys(fields).length) {
      return reject(res, 400, Object.values(fields)[0], fields);
    }

    if (await Account.exists({ email })) {
      return reject(res, 409, "An account with that email already exists.", {
        email: "An account with that email already exists.",
      });
    }

    const account = new Account({
      firstName: clean(body.firstName),
      middleName: clean(body.middleName),
      lastName: clean(body.lastName),
      suffix: SUFFIXES.includes(body.suffix) ? body.suffix : "",
      email,
      organizationName: clean(body.organizationName, 120),
      passwordHash: await bcrypt.hash(String(body.password), 10),
      role: "buyer",
      emailVerified: false,
      termsAcceptedAt: new Date(),
      termsVersion: TERMS_VERSION,
      billing: { email },
    });
    const code = await issueCode(account, "signup");
    await account.save();

    sendEmail(verificationEmail({ account, code, expiryMinutes: CODE_TTL_MINUTES }));

    res.status(201).json({ token: sign(account), account: publicShape(account) });
  })
);

/* ────────────────────────────── sign in ────────────────────────────── */

router.post(
  "/login",
  rateLimit({
    name: "login",
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFor: (req) => `${req.ip}:${normEmail(req.body?.email)}`,
  }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const account = await Account.findOne({ email: normEmail(email) });

    // One message for "no such account" and "wrong password": telling
    // them apart turns this into an account-enumeration oracle.
    const ok = account && account.active && (await bcrypt.compare(String(password || ""), account.passwordHash));
    if (!ok) return reject(res, 401, "That email and password don't match an account.");

    account.lastLoginAt = new Date();
    await account.save();

    res.json({ token: sign(account), account: publicShape(account) });
  })
);

/* ──────────────────────────── forgot password ──────────────────────────── */

/**
 * Always answers the same way, whether or not the address has an account
 * — otherwise this is a free "does this person use SILLA?" lookup.
 */
router.post(
  "/forgot-password",
  rateLimit({
    name: "forgot",
    windowMs: 15 * 60 * 1000,
    max: 6,
    keyFor: (req) => `${req.ip}:${normEmail(req.body?.email)}`,
  }),
  asyncHandler(async (req, res) => {
    const email = normEmail(req.body?.email);
    const answer = { ok: true, message: "If that email has an account, a reset code is on its way." };
    if (!EMAIL_RE.test(email)) return res.json(answer);

    const account = await Account.findOne({ email, active: true });
    if (account && cooldownRemaining(account, "password-reset") === 0) {
      const code = await issueCode(account, "password-reset");
      await account.save();
      sendEmail(passwordResetEmail({ account, code, expiryMinutes: CODE_TTL_MINUTES }));
    }
    res.json(answer);
  })
);

router.post(
  "/reset-password",
  rateLimit({
    name: "reset",
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyFor: (req) => `${req.ip}:${normEmail(req.body?.email)}`,
  }),
  asyncHandler(async (req, res) => {
    const { email, code, newPassword } = req.body || {};
    const pwProblem = passwordProblem(newPassword);
    if (pwProblem) return reject(res, 400, pwProblem, { newPassword: pwProblem });

    const account = await Account.findOne({ email: normEmail(email), active: true });
    // Same wording as a wrong code, so this doesn't confirm the account.
    if (!account) return reject(res, 400, "There's no code waiting. Send a new one.");

    const result = await consumeCode(account, "password-reset", code);
    if (!result.ok) {
      await account.save();
      return res.status(result.status).json({ error: result.error, attemptsRemaining: result.attemptsRemaining });
    }

    account.passwordHash = await bcrypt.hash(String(newPassword), 10);
    // Backdated one second: the token signed below has an `iat` truncated
    // to whole seconds, and stamping "now" would refuse the very session
    // this reset is handing back.
    account.passwordChangedAt = new Date(Date.now() - 1000);
    // The code arrived at this inbox, which proves the address is theirs.
    if (!account.emailVerified) {
      account.emailVerified = true;
      account.emailVerifiedAt = new Date();
    }
    account.lastLoginAt = new Date();
    await account.save();

    sendEmail(passwordChangedEmail({ account }));
    res.json({ token: sign(account), account: publicShape(account) });
  })
);

/* ──────────────────────────── signed in ──────────────────────────── */

router.get(
  "/me",
  requireAccount,
  asyncHandler(async (req, res) => {
    res.json({ account: publicShape(req.account) });
  })
);

/** Personal details. Email and password have their own routes, because both need proof. */
router.patch(
  "/me",
  requireAccount,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const fields = nameProblems(body);
    if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], fields);

    const a = req.account;
    a.firstName = clean(body.firstName);
    a.middleName = clean(body.middleName);
    a.lastName = clean(body.lastName);
    a.suffix = SUFFIXES.includes(body.suffix) ? body.suffix : "";
    if (body.organizationName !== undefined) a.organizationName = clean(body.organizationName, 120);
    await a.save();

    res.json({ account: publicShape(a) });
  })
);

/* ── verifying the sign-up address ── */

router.post(
  "/me/verify",
  requireAccount,
  rateLimit({ name: "verify", windowMs: 15 * 60 * 1000, max: 25, keyFor: (req) => req.account._id.toString() }),
  asyncHandler(async (req, res) => {
    const a = req.account;
    if (a.emailVerified) return res.json({ account: publicShape(a), alreadyVerified: true });

    const result = await consumeCode(a, "signup", req.body?.code);
    if (!result.ok) {
      await a.save();
      return res.status(result.status).json({ error: result.error, attemptsRemaining: result.attemptsRemaining });
    }

    a.emailVerified = true;
    a.emailVerifiedAt = new Date();
    await a.save();

    // Welcome waits for verification. Welcoming an address nobody has
    // proved they own is how a typo'd email gets our marketing.
    sendEmail(welcomeEmail({ account: a }));
    res.json({ account: publicShape(a) });
  })
);

router.post(
  "/me/verify/resend",
  requireAccount,
  asyncHandler(async (req, res) => {
    const a = req.account;
    if (a.emailVerified) return res.json({ account: publicShape(a), alreadyVerified: true });

    const wait = cooldownRemaining(a, "signup");
    if (wait) return res.status(429).json({ error: `You can send another code in ${wait} seconds.`, retryAfterSeconds: wait });

    const code = await issueCode(a, "signup");
    await a.save();
    sendEmail(verificationEmail({ account: a, code, expiryMinutes: CODE_TTL_MINUTES }));
    res.json({ account: publicShape(a) });
  })
);

/* ── changing email ── */

/**
 * Step one: prove it's you (password) and prove you own the new address
 * (a code sent THERE). The account keeps its current address until the
 * code comes back, so a typo cannot lock anyone out of their own account.
 */
router.post(
  "/me/email",
  requireAccount,
  rateLimit({ name: "email-change", windowMs: 15 * 60 * 1000, max: 8, keyFor: (req) => req.account._id.toString() }),
  asyncHandler(async (req, res) => {
    const a = req.account;
    const newEmail = normEmail(req.body?.newEmail);

    if (!EMAIL_RE.test(newEmail)) return reject(res, 400, "Enter a valid email address.", { newEmail: "Enter a valid email address." });
    if (newEmail === a.email) return reject(res, 400, "That's already your email.", { newEmail: "That's already your email." });
    if (!(await bcrypt.compare(String(req.body?.password || ""), a.passwordHash))) {
      return reject(res, 401, "That password isn't right.", { password: "That password isn't right." });
    }
    if (await Account.exists({ email: newEmail })) {
      return reject(res, 409, "Another account already uses that email.", { newEmail: "Another account already uses that email." });
    }

    const wait = a.verification?.pendingEmail === newEmail ? cooldownRemaining(a, "email-change") : 0;
    if (wait) return res.status(429).json({ error: `You can send another code in ${wait} seconds.`, retryAfterSeconds: wait });

    const code = await issueCode(a, "email-change", { pendingEmail: newEmail });
    await a.save();
    sendEmail(emailChangeCodeEmail({ account: a, newEmail, code, expiryMinutes: CODE_TTL_MINUTES }));
    res.json({ account: publicShape(a) });
  })
);

router.post(
  "/me/email/confirm",
  requireAccount,
  rateLimit({ name: "email-confirm", windowMs: 15 * 60 * 1000, max: 25, keyFor: (req) => req.account._id.toString() }),
  asyncHandler(async (req, res) => {
    const a = req.account;
    const result = await consumeCode(a, "email-change", req.body?.code);
    if (!result.ok) {
      await a.save();
      return res.status(result.status).json({ error: result.error, attemptsRemaining: result.attemptsRemaining });
    }

    // Re-checked at the moment of the swap: someone may have registered
    // the address in the ten minutes the code was live.
    if (await Account.exists({ email: result.pendingEmail, _id: { $ne: a._id } })) {
      await a.save();
      return reject(res, 409, "Another account started using that email in the meantime.");
    }

    const oldEmail = a.email;
    a.email = result.pendingEmail;
    a.emailVerified = true;
    a.emailVerifiedAt = new Date();
    if (a.billing?.email === oldEmail) a.billing.email = result.pendingEmail;
    await a.save();

    // The OLD address is told. If this was an account takeover, that is
    // the one inbox the real owner still controls.
    sendEmail(emailChangedNoticeEmail({ account: a, oldEmail, newEmail: a.email }));
    res.json({ account: publicShape(a) });
  })
);

/* ── changing password ── */

router.post(
  "/me/password",
  requireAccount,
  rateLimit({ name: "password-change", windowMs: 15 * 60 * 1000, max: 8, keyFor: (req) => req.account._id.toString() }),
  asyncHandler(async (req, res) => {
    const a = req.account;
    const { currentPassword, newPassword } = req.body || {};

    if (!(await bcrypt.compare(String(currentPassword || ""), a.passwordHash))) {
      return reject(res, 401, "Your current password isn't right.", { currentPassword: "Your current password isn't right." });
    }
    const pwProblem = passwordProblem(newPassword);
    if (pwProblem) return reject(res, 400, pwProblem, { newPassword: pwProblem });
    if (await bcrypt.compare(String(newPassword), a.passwordHash)) {
      return reject(res, 400, "Choose a password you aren't already using.", { newPassword: "Choose a password you aren't already using." });
    }

    a.passwordHash = await bcrypt.hash(String(newPassword), 10);
    // A second in the past, so the token issued just below — whose `iat`
    // is truncated to whole seconds — is not itself refused.
    a.passwordChangedAt = new Date(Date.now() - 1000);
    await a.save();

    sendEmail(passwordChangedEmail({ account: a }));
    // A fresh token for THIS session. Every other session is now signed out.
    res.json({ token: sign(a), account: publicShape(a) });
  })
);

/* ── billing details ── */

function looksLikeCard(value) {
  for (const run of String(value).match(/(?:\d[ -]?){13,19}/g) || []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

const BILLING_FIELDS = ["name", "company", "email", "phone", "address1", "address2", "city", "region", "postalCode", "country", "taxId"];

router.patch(
  "/me/billing",
  requireAccount,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const next = {};
    for (const key of BILLING_FIELDS) next[key] = clean(body[key], key === "address1" || key === "address2" ? 160 : 80);
    if (next.email) next.email = next.email.toLowerCase();

    const fields = {};
    if (next.email && !EMAIL_RE.test(next.email)) fields.email = "Enter a valid email address.";
    if (next.phone && !/^[+\d][\d\s()-]{6,24}$/.test(next.phone)) fields.phone = "Enter a valid phone number.";
    if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], fields);

    // Refuse anything that IS a card number. The form never asks for one,
    // and this keeps a pasted card out of the database even if a client
    // sends it. Luhn-checked, because a bare 13–19 digit test would also
    // reject a Philippine TIN with its branch code (up to 14 digits).
    if (Object.values(next).some(looksLikeCard)) return reject(res, 400, "Card numbers can't be stored here.");

    req.account.billing = next;
    await req.account.save();
    res.json({ account: publicShape(req.account) });
  })
);

export default router;
