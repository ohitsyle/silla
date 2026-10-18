import mongoose from "mongoose";

/**
 * Everything SILLA sells besides a plan: extra buildings, hardware, setup
 * services and support tiers. The catalogue behind the storefront's
 * pricing sections, the configurator's "Hardware & support" step, and
 * every quote an order freezes.
 *
 * Data, not code, exactly like Plan: seeded from lib/defaultCatalog.js the
 * first time it is read empty (services/billing.js ensureCatalog), owned
 * by staff in the console after that (Plans → Catalogue, plans.manage,
 * every change audited). A change reaches NEW quotes only: an order
 * freezes its quote when it is submitted, and a subscription keeps the
 * price agreed for each add-on it carries.
 *
 * Money is in MINOR units (centavos) and excludes VAT, like a plan's.
 *
 * `charge` — how it is paid for:
 *   one_time     prices.oneTime per unit, once, on the first invoice
 *                (cards, readers, visits, sessions)
 *   recurring    per unit per month: prices.monthly on monthly billing,
 *                prices.annualMonthly on yearly billing (null = the same),
 *                billed with the plan every period (extra buildings, support)
 *   buy_or_rent  the buyer chooses: prices.oneTime to buy it, or
 *                prices.monthly per month to rent it (prices.annualMonthly
 *                on yearly billing, null = the same). A rental states its
 *                minimum term, `rentalMinimumMonths`, on the quote (kiosks).
 *
 * The rules a quote enforces (lib/quote.js):
 *   minQuantity / maxQuantity   per order; null max is no item limit
 *   plans                       the plan keys it is offered on; empty = all
 *   group                       at most one item of a group per order
 *                               ("support"); `groupDefault` is the one a
 *                               quote carries when none was chosen
 *   alwaysIncluded              on every quote, once (onboarding)
 *   waivedOnYearly              free on yearly billing (onboarding)
 *   adds                        per unit, what it adds to the deployment's
 *                               limits — { buildings: 1 } for an extra
 *                               building. Recurring items only: a limit
 *                               lasts as long as it is paid for.
 */
export const CATALOG_CATEGORIES = ["building", "hardware", "service", "support"];
export const CATALOG_CHARGES = ["one_time", "recurring", "buy_or_rent"];

const amount = { type: Number, default: null, min: 0 };

const catalogItemSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: "", maxlength: 300 },
    /** Short points for the storefront's comparison (support tiers). */
    highlights: { type: [String], default: [] },
    category: { type: String, enum: CATALOG_CATEGORIES, required: true },
    charge: { type: String, enum: CATALOG_CHARGES, required: true },
    /** The thing being counted, in both numbers: "card" / "cards". */
    unit: {
      one: { type: String, default: "unit", trim: true, maxlength: 30 },
      many: { type: String, default: "units", trim: true, maxlength: 30 },
    },
    currency: { type: String, default: "PHP", uppercase: true, trim: true },
    prices: { oneTime: amount, monthly: amount, annualMonthly: amount },
    minQuantity: { type: Number, default: 1, min: 1 },
    maxQuantity: { type: Number, default: null, min: 1 },
    plans: { type: [String], default: [] },
    group: { type: String, default: "", trim: true },
    groupDefault: { type: Boolean, default: false },
    adds: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    /** The warranty, or "travel is billed at cost" — said wherever it is sold. */
    note: { type: String, default: "", maxlength: 200 },
    waivedOnYearly: { type: Boolean, default: false },
    alwaysIncluded: { type: Boolean, default: false },
    rentalMinimumMonths: { type: Number, default: 0, min: 0 },
    /** Retired items stay for the subscriptions that carry them, but are not sold. */
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("CatalogItem", catalogItemSchema);
