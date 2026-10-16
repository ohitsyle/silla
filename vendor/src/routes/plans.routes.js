/**
 * The plan catalogue: the public list the storefront sells from, and the
 * staff console's editor.
 *
 *   GET   /          public — active plans, as the pricing page shows them
 *   GET   /all       staff (plans.manage) — every plan, retired too, with how many subscriptions use it
 *   POST  /          staff (plans.manage) — a new plan
 *   PATCH /:key      staff (plans.manage) — edit one; features and limits reach every
 *                    live deployment on it at once, the price only new subscriptions
 *
 * Mounted in app.js at /api/vendor/plans. The rules (and the audit lines)
 * are in services/billing.js; see docs/control-plane.md §4.
 */
import { Router } from "express";
import Subscription from "../models/Subscription.js";
import { requireAccount } from "../middleware/auth.js";
import { requirePermission } from "../middleware/staff.js";
import { BillingError, catalogue, createPlan, getSettings, updatePlan } from "../services/billing.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The storefront's prices. Public: the pricing page is read by people who
 * have not signed up, and nothing in a plan is a secret. `orderable` says
 * whether an order can carry it yet — the storefront offers only those.
 * `pricesExcludeVat` is true when SILLA is VAT-registered and invoices add
 * VAT on top, so the page can say so beside the price.
 */
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [plans, settings] = await Promise.all([catalogue(), getSettings()]);
    res.set("Cache-Control", "public, max-age=60");
    res.json({ plans, pricesExcludeVat: Boolean(settings.business?.vatRegistered) });
  })
);

router.get(
  "/all",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (_req, res) => {
    const [plans, counts] = await Promise.all([
      catalogue({ includeRetired: true }),
      Subscription.aggregate([{ $match: { status: { $ne: "cancelled" } } }, { $group: { _id: "$plan", n: { $sum: 1 } } }]),
    ]);
    const using = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    res.json({ plans: plans.map((p) => ({ ...p, subscriptions: using[p.key] || 0 })) });
  })
);

router.post(
  "/",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (req, res) => {
    const plan = await createPlan(req.body || {}, req.account);
    res.status(201).json({ plan: { ...plan, subscriptions: 0 } });
  })
);

router.patch(
  "/:key",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (req, res) => {
    const { plan, resyncing } = await updatePlan(String(req.params.key).toLowerCase(), req.body || {}, req.account);
    const subscriptions = await Subscription.countDocuments({ plan: plan.key, status: { $ne: "cancelled" } });
    res.json({ plan: { ...plan, subscriptions }, resyncing });
  })
);

/** A refusal from the billing service, said the way every other route says one. */
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, next) => {
  if (!(err instanceof BillingError)) return next(err);
  res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
});

export default router;
