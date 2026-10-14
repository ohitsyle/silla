/**
 * SILLA staff themselves: who is signed in and what they may do, and
 * (for owners) inviting, re-roling and deactivating staff.
 *
 * Owner: the staff-operations work. Mounted in app.js at /api/vendor/staff.
 * See docs/control-plane.md.
 */
import { Router } from "express";
import { requireAccount } from "../middleware/auth.js";
import { permissionsOf, staffRoleOf } from "../middleware/staff.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The console asks this once on load and shows only the sections whose
 * permission is listed — so a support agent is never offered a button
 * that would answer 403.
 */
router.get(
  "/me",
  requireAccount,
  asyncHandler(async (req, res) => {
    const role = staffRoleOf(req.account);
    if (!role) return res.status(403).json({ error: "SILLA staff only" });
    res.json({ staffRole: role, permissions: permissionsOf(req.account) });
  })
);

export default router;
