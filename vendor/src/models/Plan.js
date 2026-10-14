import mongoose from "mongoose";

/**
 * A plan SILLA sells — the catalogue behind the pricing page, the
 * configurator's plan choice and every subscription.
 *
 * Data, not code: staff edit plans in the console (Plans section), and
 * the storefront reads GET /api/vendor/plans. The portal used to hold the
 * only copy in portal/src/lib/plans.js; that file is now the offline
 * fallback, not the source.
 *
 * Money is in MINOR units (centavos), like Order.quotedAmount.
 *   prices.monthly        charged each month on monthly billing
 *   prices.annualMonthly  the per-month price on yearly billing — the
 *                         pricing page's "billed annually" figure. A
 *                         yearly invoice is annualMonthly × 12.
 * null for either means "priced with you" (the Campus plan).
 *
 * `features` and `limits` are keyed by lib/planKeys.js and become the
 * entitlement snapshot a deployment enforces; a subscription's
 * `overrides` are layered on top for one client.
 */
const planSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    tagline: { type: String, default: "", maxlength: 160 },
    highlights: { type: [String], default: [] },
    featured: { type: Boolean, default: false },
    currency: { type: String, default: "PHP", uppercase: true, trim: true },
    prices: {
      monthly: { type: Number, default: null, min: 0 },
      annualMonthly: { type: Number, default: null, min: 0 },
    },
    features: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    /** Retired plans stay for the subscriptions on them, but are not sold. */
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("Plan", planSchema);
