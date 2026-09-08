import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import { normalizeCardUid } from "../services/checkin/rfid.js";
import { ValidationError } from "../services/checkin/errors.js";
import { sendEmail, emailConfigured } from "../services/email/index.js";
import { verificationCodeEmail } from "../services/email/templates.js";
import {
  registrationPerCardRateLimit,
  registrationRateLimit,
  verifyIpRateLimit,
  verifyRateLimit,
} from "../middleware/rateLimit.js";
import {
  assertMemberIdMatchesFormat,
  assertValidEmail,
  assertValidPin,
  describeDuplicateKeyError,
  generateVerificationCode,
  memberIdExample,
} from "../lib/identity.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_VERIFY_ATTEMPTS = 5;

/**
 * GET /api/registration/requirements?organizationId=...
 *
 * ID-1 — the kiosk asks what to collect before drawing the form. The
 * member ID format, the noun to call the person, and whether
 * self-service registration is even enabled all come from the org's
 * config (spec §16), never from the client.
 */
router.get(
  "/requirements",
  asyncHandler(async (req, res) => {
    const { organizationId } = req.query;
    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId query parameter is required" });
    }
    const org = await Organization.findById(organizationId).select("name terminology identity policy");
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const pattern = org.identity?.memberIdFormat || "";
    res.json({
      organizationName: org.name,
      selfServiceRegistration: org.identity?.selfServiceRegistration !== false,
      checkInMethod: org.identity?.checkInMethod || "rfid",
      memberNoun: org.terminology?.memberNoun || "member",
      facilityLabel: org.terminology?.facilityLabel || "facility",
      memberIdFormat: pattern,
      memberIdExample: memberIdExample(pattern),
      verificationCodeExpiryMinutes: org.policy?.verificationCodeExpiryMinutes ?? 10,
      pinLength: 6,
    });
  })
);

/**
 * POST /api/registration/start
 * Body: { organizationId, cardUid, memberId, firstName, middleName, lastName, email, pin }
 *
 * ID-1 + ID-2. Creates the account in a PENDING state (verified:false)
 * and emails a code. Spec §4: "the account stays pending until verified,
 * so an abandoned registration leaves nothing behind" — the pending
 * record is reclaimable (see the expired-pending handling below) and the
 * scheduler purges stale ones.
 */
router.post(
  "/start",
  registrationRateLimit,
  registrationPerCardRateLimit,
  asyncHandler(async (req, res) => {
    const { organizationId, cardUid, memberId, firstName, middleName = "", lastName, email, pin } = req.body || {};

    if (!organizationId || !mongoose.isValidObjectId(organizationId)) {
      return res.status(400).json({ error: "A valid organizationId is required" });
    }
    const org = await Organization.findById(organizationId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (org.identity?.selfServiceRegistration === false) {
      // Spec §4 fast-follow: an org may be configured for provisioned
      // accounts only. Enforced rather than assumed.
      return res.status(403).json({ error: "Self-service registration is disabled for this organization." });
    }

    if (!firstName?.trim() || !lastName?.trim()) {
      return res.status(400).json({ error: "First and last name are required." });
    }

    const memberNoun = org.terminology?.memberNoun || "member";
    const normalizedUid = normalizeCardUid(cardUid);
    assertValidEmail(email);
    assertValidPin(pin);
    assertMemberIdMatchesFormat(memberId, org.identity?.memberIdFormat);

    const normalizedEmail = String(email).trim().toLowerCase();

    // ---- ID-3: uniqueness, checked up front for a clear message ----
    // The unique indexes are the real guarantee (they win races); this
    // pre-check exists only so the common case reads well.
    const clash = await User.findOne({
      organization: organizationId,
      $or: [{ email: normalizedEmail }, { memberId: String(memberId) }, { cardUid: normalizedUid }],
    });

    if (clash) {
      // A pending registration that was abandoned and has expired is not
      // a real clash — reclaim it, so a mistyped email doesn't lock a
      // card or member ID out forever (spec §4: "leaves nothing behind").
      const reclaimable = !clash.verified && clash.verificationExpiresAt && clash.verificationExpiresAt < new Date();
      if (reclaimable) {
        await User.deleteOne({ _id: clash._id });
      } else {
        let field = "record";
        if (clash.email === normalizedEmail) field = "email address";
        else if (clash.memberId === String(memberId)) field = `${memberNoun} ID`;
        else if (clash.cardUid === normalizedUid) field = "card";
        return res.status(409).json({
          error: `That ${field} is already registered${clash.verified ? "" : " and is awaiting verification"}.`,
          field,
        });
      }
    }

    const expiryMinutes = org.policy?.verificationCodeExpiryMinutes ?? 10;
    const code = generateVerificationCode();

    let user;
    try {
      user = await User.create({
        organization: organizationId,
        role: "member",
        firstName: firstName.trim(),
        middleName: String(middleName).trim(),
        lastName: lastName.trim(),
        email: normalizedEmail,
        memberId: String(memberId),
        cardUid: normalizedUid,
        pinHash: await bcrypt.hash(String(pin), 10),
        // The code is hashed like the PIN — it is a short-lived
        // credential, and a database reader should not be able to
        // complete someone else's registration.
        verificationCode: await bcrypt.hash(code, 10),
        verificationExpiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
        verified: false,
        termsAcceptedAt: null, // AUTH-3 gates the first login
      });
    } catch (err) {
      const message = describeDuplicateKeyError(err, { memberNoun });
      if (message) return res.status(409).json({ error: message });
      throw err;
    }

    // Spec §15: async. A mail failure must not roll back a good
    // registration, so this is deliberately not awaited.
    sendEmail(verificationCodeEmail({ org, user, code, expiryMinutes }));

    res.status(201).json({
      registrationId: user._id.toString(),
      email: user.email,
      expiresAt: user.verificationExpiresAt,
      expiryMinutes,
      // DEV ONLY: with no EMAIL_API_KEY configured the code is only
      // printed to the server console, which a kiosk operator cannot
      // see. Returning it here keeps the flow demo-able locally. Both
      // conditions must fail open to production — never returned when
      // NODE_ENV=production or a mail provider is configured.
      ...(process.env.NODE_ENV !== "production" && !emailConfigured ? { devVerificationCode: code } : {}),
    });
  })
);

/**
 * POST /api/registration/verify
 * Body: { registrationId, code }
 *
 * ID-2 — the code is entered at the kiosk. On success the account
 * flips to verified and becomes usable; the card is now bound.
 */
router.post(
  "/verify",
  verifyIpRateLimit,
  verifyRateLimit,
  asyncHandler(async (req, res) => {
    const { registrationId, code } = req.body || {};
    if (!registrationId || !mongoose.isValidObjectId(registrationId)) {
      return res.status(400).json({ error: "A valid registrationId is required" });
    }
    if (!/^[0-9]{6}$/.test(String(code || ""))) {
      return res.status(400).json({ error: "Enter the 6-digit code from your email." });
    }

    const user = await User.findById(registrationId);
    if (!user) return res.status(404).json({ error: "Registration not found." });
    if (user.verified) return res.json({ ok: true, alreadyVerified: true });

    if (!user.verificationExpiresAt || user.verificationExpiresAt < new Date()) {
      // Expired: discard the pending account outright rather than
      // leaving a half-registered record holding a card UID hostage.
      await User.deleteOne({ _id: user._id });
      return res.status(410).json({ error: "That code has expired. Please start registration again." });
    }

    // Reuse the PIN lockout counter for code guessing — same threat,
    // same defence (AUTH-2 applies "on web and kiosk").
    if (user.failedPinAttempts >= MAX_VERIFY_ATTEMPTS) {
      await User.deleteOne({ _id: user._id });
      return res.status(429).json({ error: "Too many incorrect codes. Please start registration again." });
    }

    const valid = await bcrypt.compare(String(code), user.verificationCode || "");
    if (!valid) {
      user.failedPinAttempts += 1;
      await user.save();
      return res.status(401).json({
        error: "That code is not correct.",
        attemptsRemaining: Math.max(0, MAX_VERIFY_ATTEMPTS - user.failedPinAttempts),
      });
    }

    user.verified = true;
    user.verificationCode = null;
    user.verificationExpiresAt = null;
    user.failedPinAttempts = 0;
    await user.save();

    res.json({
      ok: true,
      member: {
        id: user._id.toString(),
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        memberId: user.memberId,
      },
    });
  })
);

/**
 * POST /api/registration/resend
 * Body: { registrationId }
 *
 * ID-2 — codes expire and inboxes are slow; without this the only
 * recovery is re-typing the whole form.
 */
router.post(
  "/resend",
  verifyIpRateLimit,
  verifyRateLimit,
  asyncHandler(async (req, res) => {
    const { registrationId } = req.body || {};
    if (!registrationId || !mongoose.isValidObjectId(registrationId)) {
      return res.status(400).json({ error: "A valid registrationId is required" });
    }
    const user = await User.findById(registrationId);
    if (!user) return res.status(404).json({ error: "Registration not found." });
    if (user.verified) return res.status(409).json({ error: "This account is already verified." });

    const org = await Organization.findById(user.organization);
    const expiryMinutes = org?.policy?.verificationCodeExpiryMinutes ?? 10;
    const code = generateVerificationCode();

    user.verificationCode = await bcrypt.hash(code, 10);
    user.verificationExpiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
    user.failedPinAttempts = 0; // a fresh code deserves a fresh attempt budget
    await user.save();

    sendEmail(verificationCodeEmail({ org, user, code, expiryMinutes }));

    res.json({
      ok: true,
      expiresAt: user.verificationExpiresAt,
      ...(process.env.NODE_ENV !== "production" && !emailConfigured ? { devVerificationCode: code } : {}),
    });
  })
);

// Map the interface's ValidationError onto a 400 rather than a 500.
router.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(err.status || 400).json({ error: err.message });
  return next(err);
});

export default router;
