import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import { requireAuth } from "../middleware/auth.js";
import { loginRateLimit } from "../middleware/rateLimit.js";
import { sendEmail, emailConfigured } from "../services/email/index.js";
import { pinResetEmail } from "../services/email/templates.js";
import { generateVerificationCode } from "../lib/identity.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * POST /api/auth/login
 * Body: { organizationId, email, pin }
 *
 * Spec §5: everyone logs in with email + PIN, regardless of role.
 *
 * AUTH-2 is two layers, both required by the AC:
 *   - loginRateLimit caps attempt *rate* per IP+email, which is what
 *     stops one-try-each spraying across many accounts.
 *   - the per-account lockout below is the persistent half.
 */
router.post("/login", loginRateLimit, asyncHandler(async (req, res) => {
  const { organizationId, email, pin } = req.body || {};
  if (!organizationId || !email || !pin) {
    return res.status(400).json({ error: "organizationId, email, and pin are required" });
  }

  const user = await User.findOne({ organization: organizationId, email: email.toLowerCase() });
  if (!user || !user.active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return res.status(423).json({ error: "Account temporarily locked. Try again later." });
  }

  // Spec §4: "the account stays pending until verified". Without this,
  // a half-finished kiosk registration (ID-2) would be a usable login.
  if (!user.verified) {
    return res.status(403).json({
      error: "This account is not verified yet. Enter the code emailed to you to finish registration.",
      requiresVerification: true,
      registrationId: user._id.toString(),
    });
  }

  const org = await Organization.findById(organizationId);
  const threshold = org?.policy?.pinLockoutThreshold ?? 5;

  const valid = await bcrypt.compare(pin, user.pinHash);
  if (!valid) {
    user.failedPinAttempts += 1;
    if (user.failedPinAttempts >= threshold) {
      user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 min lockout
      user.failedPinAttempts = 0;
    }
    await user.save();
    return res.status(401).json({ error: "Invalid credentials" });
  }

  user.failedPinAttempts = 0;
  await user.save();

  const token = jwt.sign(
    { id: user._id.toString(), organizationId: user.organization.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      requiresTermsAcceptance: !user.termsAcceptedAt, // spec §5 — first-login gate
      // ADM-4 — provisioned accounts and staff-reset PINs must be
      // changed before the account is usable.
      mustChangePin: Boolean(user.mustChangePin),
    },
  });
}));

/**
 * POST /api/auth/change-pin
 * Body: { currentPin, newPin }
 *
 * The forced first-login change for provisioned staff (ADM-4), and the
 * ordinary "change my PIN" path for everyone else.
 */
router.post(
  "/change-pin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPin, newPin } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user || !user.active) return res.status(401).json({ error: "Account is no longer active" });

    if (!/^[0-9]{6}$/.test(String(newPin || ""))) {
      return res.status(400).json({ error: "The new PIN must be exactly 6 digits." });
    }
    if (!(await bcrypt.compare(String(currentPin || ""), user.pinHash))) {
      return res.status(401).json({ error: "Your current PIN is not correct." });
    }
    if (String(currentPin) === String(newPin)) {
      return res.status(400).json({ error: "The new PIN must be different from the current one." });
    }

    user.pinHash = await bcrypt.hash(String(newPin), 10);
    user.mustChangePin = false;
    user.failedPinAttempts = 0;
    await user.save();

    res.json({ ok: true });
  })
);

/**
 * POST /api/auth/request-pin-reset
 * Body: { organizationId, email }
 *
 * AUTH-4 — "Reset flow via email; New PIN set and usable."
 *
 * Always answers 200 whether or not the address exists. Telling an
 * anonymous caller which emails are registered would turn this into a
 * membership oracle.
 */
router.post(
  "/request-pin-reset",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { organizationId, email } = req.body || {};
    if (!organizationId || !email) {
      return res.status(400).json({ error: "organizationId and email are required" });
    }

    const user = await User.findOne({
      organization: organizationId,
      email: String(email).toLowerCase(),
    });

    let devCode;
    if (user && user.active) {
      const org = await Organization.findById(organizationId);
      const expiryMinutes = org?.policy?.verificationCodeExpiryMinutes ?? 10;
      const code = generateVerificationCode();
      user.pinResetCode = await bcrypt.hash(code, 10);
      user.pinResetExpiresAt = new Date(Date.now() + expiryMinutes * 60_000);
      await user.save();
      sendEmail(pinResetEmail({ org, user, code, expiryMinutes }));
      if (process.env.NODE_ENV !== "production" && !emailConfigured) devCode = code;
    }

    res.json({
      ok: true,
      message: "If that address has an account, a reset code has been sent.",
      ...(devCode ? { devResetCode: devCode } : {}),
    });
  })
);

/**
 * POST /api/auth/reset-pin
 * Body: { organizationId, email, code, newPin }
 */
router.post(
  "/reset-pin",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { organizationId, email, code, newPin } = req.body || {};
    if (!/^[0-9]{6}$/.test(String(newPin || ""))) {
      return res.status(400).json({ error: "The new PIN must be exactly 6 digits." });
    }

    const user = await User.findOne({
      organization: organizationId,
      email: String(email || "").toLowerCase(),
    });
    if (!user || !user.pinResetCode || !user.pinResetExpiresAt) {
      return res.status(400).json({ error: "That reset code is not valid." });
    }
    if (user.pinResetExpiresAt < new Date()) {
      return res.status(410).json({ error: "That reset code has expired. Request a new one." });
    }
    if (!(await bcrypt.compare(String(code || ""), user.pinResetCode))) {
      return res.status(401).json({ error: "That reset code is not correct." });
    }

    user.pinHash = await bcrypt.hash(String(newPin), 10);
    user.pinResetCode = null;
    user.pinResetExpiresAt = null;
    user.mustChangePin = false;
    // A successful reset also clears a lockout — that is the point of
    // having a recovery path (AUTH-2 + AUTH-4 together).
    user.failedPinAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    res.json({ ok: true });
  })
);

/**
 * GET /api/auth/me
 * AUTH-3 — lets the client re-establish whether the terms gate is still
 * open after a reload, without trusting anything it kept locally.
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id).select("firstName lastName role email termsAcceptedAt active verified mustChangePin");
    if (!user || !user.active) return res.status(401).json({ error: "Account is no longer active" });
    res.json({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        requiresTermsAcceptance: !user.termsAcceptedAt,
        mustChangePin: Boolean(user.mustChangePin),
      },
    });
  })
);

/**
 * POST /api/auth/accept-terms
 *
 * AUTH-3 — flips the first-login flag (spec §5).
 *
 * The user id comes from the verified token, NOT the request body. It
 * previously took `userId` from the body with no auth at all, which let
 * any unauthenticated caller accept the terms on behalf of any account
 * whose id they could guess or observe.
 */
router.post(
  "/accept-terms",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user || !user.active) return res.status(401).json({ error: "Account is no longer active" });

    // Acceptance is once only — versioning is future work (spec §5), so
    // re-accepting must not move the timestamp.
    if (!user.termsAcceptedAt) {
      user.termsAcceptedAt = new Date();
      await user.save();
    }

    res.json({ ok: true, termsAcceptedAt: user.termsAcceptedAt });
  })
);

export default router;
