/**
 * The catalogue: everything SILLA sells besides a plan — extra buildings,
 * hardware, setup services and support tiers.
 *
 *   GET   /          public — active items, as the storefront and the configurator price them
 *   GET   /all       staff (plans.manage) — every item, retired too, with how many live subscriptions carry it
 *   POST  /          staff (plans.manage) — a new item
 *   PATCH /:key      staff (plans.manage) — edit one; reaches NEW quotes only
 *
 * Mounted in app.js at /api/vendor/catalogue. The storefront also gets the
 * active catalogue with the plans (GET /api/vendor/plans), so the pricing
 * page needs one request. The rules and the audit lines are in
 * services/billing.js; models/CatalogItem.js says what each field means.
 */
import { Router } from "express";
import Subscription from "../models/Subscription.js";
import { requireAccount } from "../middleware/auth.js";
import { requirePermission } from "../middleware/staff.js";
import { BillingError, catalogItems, createCatalogItem, updateCatalogItem } from "../services/billing.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.json({ catalogue: await catalogItems() });
  })
);

/** How many live subscriptions carry each add-on — what a price change would NOT touch. */
async function carriedBy() {
  const rows = await Subscription.aggregate([
    { $match: { status: { $ne: "cancelled" } } },
    { $unwind: "$addOns" },
    { $group: { _id: "$addOns.key", n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

router.get(
  "/all",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (_req, res) => {
    const [items, carried] = await Promise.all([catalogItems({ includeRetired: true }), carriedBy()]);
    res.json({ catalogue: items.map((i) => ({ ...i, subscriptions: carried[i.key] || 0 })) });
  })
);

router.post(
  "/",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (req, res) => {
    const item = await createCatalogItem(req.body || {}, req.account);
    res.status(201).json({ item: { ...item, subscriptions: 0 } });
  })
);

router.patch(
  "/:key",
  requireAccount,
  requirePermission("plans.manage"),
  asyncHandler(async (req, res) => {
    const item = await updateCatalogItem(String(req.params.key).toLowerCase(), req.body || {}, req.account);
    res.json({ item: { ...item, subscriptions: (await carriedBy())[item.key] || 0 } });
  })
);

/** A refusal from the billing service, said the way every other route says one. */
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, next) => {
  if (!(err instanceof BillingError)) return next(err);
  res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
});

export default router;
