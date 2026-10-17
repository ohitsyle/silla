/**
 * SILLA's own business settings: who invoices are issued by, how
 * customers pay, and the billing rhythm.
 *
 *   GET /                       staff (billing.read) — everything, for the console
 *   PUT /                       staff (settings.manage) — any of business, payment,
 *                               invoice, billing; a group left out is left alone
 *   GET /payment-instructions   any signed-in account — how to pay, for the buyer's
 *                               billing page and invoices
 *
 * Mounted in app.js at /api/vendor/settings. Validation and the audit line
 * are in services/billing.js (updateSettings); see docs/control-plane.md §4.
 */
import { Router } from "express";
import { requireAccount } from "../middleware/auth.js";
import { requirePermission } from "../middleware/staff.js";
import { BillingError, getSettings, paymentInstructions, settingsShape, updateSettings } from "../services/billing.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

/**
 * Not a secret — bank details on an invoice are there to be read by the
 * customer paying it — but only for signed-in accounts: there is no reason
 * to publish SILLA's account numbers to every crawler on the storefront.
 */
router.get(
  "/payment-instructions",
  asyncHandler(async (_req, res) => {
    res.json(await paymentInstructions());
  })
);

router.get(
  "/",
  requirePermission("billing.read"),
  asyncHandler(async (_req, res) => {
    res.json({ settings: settingsShape(await getSettings()) });
  })
);

router.put(
  "/",
  requirePermission("settings.manage"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const input = Object.fromEntries(["business", "payment", "invoice", "billing"].filter((g) => body[g]).map((g) => [g, body[g]]));
    res.json({ settings: await updateSettings(input, req.account) });
  })
);

// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, next) => {
  if (!(err instanceof BillingError)) return next(err);
  res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
});

export default router;
