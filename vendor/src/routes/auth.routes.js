import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Account from "../models/Account.js";
import { requireAccount } from "../middleware/auth.js";
import { sendEmail } from "../services/email/index.js";
import { welcomeEmail } from "../services/email/templates.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TOKEN_TTL = "12h";

const sign = (account) =>
  jwt.sign({ id: account._id.toString(), role: account.role }, process.env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });

const publicShape = (account) => ({
  id: account._id.toString(),
  email: account.email,
  name: account.name,
  organizationName: account.organizationName,
  role: account.role,
});

/**
 * Sign up.
 *
 * Always creates a `buyer`. There is deliberately no way to create a
 * SILLA staff account over HTTP — staff are minted by the seed script,
 * because an endpoint that can grant itself the queue is a back door
 * however carefully it is guarded.
 */
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, email, password, organizationName } = req.body || {};

    if (!String(name || "").trim()) return res.status(400).json({ error: "Your name is required." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ""))) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    // Length only. Composition rules push people towards "Password1!"
    // and a longer passphrase beats a short complicated one.
    if (String(password || "").length < 10) {
      return res.status(400).json({ error: "Use at least 10 characters." });
    }

    const normalised = String(email).trim().toLowerCase();
    if (await Account.findOne({ email: normalised })) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const account = await Account.create({
      name: String(name).trim(),
      email: normalised,
      organizationName: String(organizationName || "").trim(),
      passwordHash: await bcrypt.hash(String(password), 10),
      role: "buyer",
    });

    sendEmail(welcomeEmail({ account }));

    res.status(201).json({ token: sign(account), account: publicShape(account) });
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const account = await Account.findOne({ email: String(email || "").trim().toLowerCase() });

    // One message for "no such account" and "wrong password": telling
    // them apart turns this into an account-enumeration oracle.
    const ok = account && account.active && (await bcrypt.compare(String(password || ""), account.passwordHash));
    if (!ok) return res.status(401).json({ error: "Invalid email or password." });

    account.lastLoginAt = new Date();
    await account.save();

    res.json({ token: sign(account), account: publicShape(account) });
  })
);

router.get(
  "/me",
  requireAccount,
  asyncHandler(async (req, res) => {
    res.json({ account: publicShape(req.account) });
  })
);

export default router;
