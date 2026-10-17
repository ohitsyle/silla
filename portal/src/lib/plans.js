import { useEffect, useSyncExternalStore } from "react";
import { billingApi } from "./billingApi.js";

/**
 * The plans, and the ONE money formatter.
 *
 * The catalogue is data now: staff edit plans in the console, and the
 * storefront reads GET /api/vendor/plans. This file holds the OFFLINE
 * FALLBACK — what the pricing page shows until the live catalogue answers,
 * or if it never does — not the source. Keep FALLBACK_PLANS in step with
 * vendor/src/lib/defaultPlans.js, which seeds the catalogue the first time.
 *
 * Shared by the pricing section (which sells them), the entry dialog and
 * the configurator (which records which one an order is for). Two copies
 * would drift, and the copy that mattered would be whichever one the order
 * was written from — see lib/adminSections.js in the product.
 *
 * ⚠️  THE PRICES ARE STILL PLACEHOLDERS, in Philippine pesos — guesses,
 * not a pricing decision. Change them in the console's Plans section;
 * the fallback here only has to resemble them.
 *
 * Money is in MINOR units (centavos) everywhere: in a plan's `prices`, in
 * an order's quotedAmount, on every invoice. The old fallback held MAJOR
 * units while orders held minor ones — both correct, 100x apart, which is
 * exactly how a $39 plan once rendered as "$3900/month".
 *
 *   prices.monthly        charged each month on monthly billing
 *   prices.annualMonthly  the per-month figure on yearly billing, billed as × 12
 *   null for both         "priced with you" (Campus)
 */

export const DEFAULT_CURRENCY = "PHP";

export const FALLBACK_PLANS = [
  {
    key: "room",
    name: "One Room",
    tagline: "A single floor, a reading room, a studio.",
    highlights: ["Up to 60 bookable units", "One building, one floor", "Every feature, no exceptions", "Email support"],
    featured: false,
    currency: "PHP",
    prices: { monthly: 2_900_00, annualMonthly: 2_300_00 },
    orderable: true,
  },
  {
    key: "building",
    name: "Whole Building",
    tagline: "Several floors and the staff to run them.",
    highlights: [
      "Up to 600 bookable units",
      "One building, unlimited floors and rooms",
      "Unlimited staff accounts",
      "Priority support",
      "Onboarding call and layout help",
    ],
    featured: true,
    currency: "PHP",
    prices: { monthly: 8_700_00, annualMonthly: 6_900_00 },
    orderable: true,
  },
  {
    key: "campus",
    name: "Campus",
    tagline: "More than one building, more than one team.",
    highlights: ["Unlimited units and buildings", "Multiple sites", "Custom identity formats and policy", "A named contact who answers"],
    featured: false,
    currency: "PHP",
    prices: { monthly: null, annualMonthly: null },
    orderable: true,
  },
];

/** The fallback, under its old name, for anything still importing it. Prefer usePlans(). */
export const PLANS = FALLBACK_PLANS;

/* ─────────────────────────── the live catalogue ─────────────────────────── */

/**
 * Plans by key, kept current as the live catalogue arrives — for code
 * outside React (the entry dialog reads it when it opens). Mutated in
 * place so an import taken before the catalogue loaded still sees it.
 */
export const PLAN_BY_KEY = {};

let state = { plans: FALLBACK_PLANS, live: false, failed: false, pricesExcludeVat: false, trialDays: null };
const listeners = new Set();
let inflight = null;

function publish(next) {
  state = { ...state, ...next };
  for (const key of Object.keys(PLAN_BY_KEY)) delete PLAN_BY_KEY[key];
  for (const plan of state.plans) PLAN_BY_KEY[plan.key] = plan;
  listeners.forEach((listener) => listener());
}
publish({});

/**
 * Fetches the catalogue once per page load (again with `force`). Only the
 * plans an order can carry are kept: offering one whose "Save" the order
 * route would refuse is a dead end with a price on it.
 */
export function loadPlans({ force = false } = {}) {
  if (inflight && !force) return inflight;
  inflight = billingApi
    .plans()
    .then(({ plans, pricesExcludeVat, trialDays }) => {
      const sellable = (plans || []).filter((p) => p.orderable !== false);
      if (sellable.length) {
        publish({
          plans: sellable,
          live: true,
          failed: false,
          pricesExcludeVat: Boolean(pricesExcludeVat),
          trialDays: Number.isInteger(trialDays) ? trialDays : null,
        });
      }
      return state;
    })
    .catch(() => {
      // Offline, or the commerce API is down: the fallback stays up, and
      // the next page load tries again.
      inflight = null;
      publish({ failed: true });
      return state;
    });
  return inflight;
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/**
 * { plans, live, failed, pricesExcludeVat, trialDays } — re-renders when
 * the live catalogue lands. trialDays is null until it does: unknown, so
 * say nothing rather than promise a trial that may not exist.
 */
export function usePlans() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    loadPlans();
  }, []);
  return current;
}

/* ─────────────────────────────── money ─────────────────────────────── */

const formatters = new Map();
function formatter(currency, digits) {
  const key = `${currency}:${digits}`;
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat("en-PH", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }));
    } catch {
      // An unknown currency code must not take a page down with it.
      formatters.set(key, { format: (n) => `${currency} ${n.toFixed(digits)}`, formatToParts: () => [] });
    }
  }
  return formatters.get(key);
}

/**
 * The one money formatter. Minor units in.
 *
 *   formatMoney(690000)                       "₱6,900"        a price tag: no decimals when whole
 *   formatMoney(690000, { period: "month" })  "₱6,900/month"
 *   formatMoney(8280000, { exact: true })     "₱82,800.00"    a sum owed: always two decimals
 *   formatMoney(null)                         "Priced with you"
 *
 * `currency` defaults to the catalogue's (pesos). Existing callers that
 * pass only `{ period }` keep working and now print the right symbol.
 */
export function formatMoney(minorUnits, { period, currency, exact = false } = {}) {
  if (minorUnits == null) return "Priced with you";
  const major = minorUnits / 100;
  const digits = exact || !Number.isInteger(major) ? 2 : 0;
  const shown = formatter(currency || state.plans[0]?.currency || DEFAULT_CURRENCY, digits).format(major);
  return `${shown}${period ? `/${period}` : ""}`;
}

/** The symbol and the figure apart, for type that sets them at different sizes: { symbol: "₱", amount: "6,900" }. */
export function moneyParts(minorUnits, { currency } = {}) {
  if (minorUnits == null) return null;
  const major = minorUnits / 100;
  const parts = formatter(currency || DEFAULT_CURRENCY, Number.isInteger(major) ? 0 : 2).formatToParts(major);
  const symbol = parts.find((p) => p.type === "currency")?.value || currency || "";
  const amount = parts
    .filter((p) => p.type !== "currency" && p.type !== "literal")
    .map((p) => p.value)
    .join("");
  return { symbol, amount: amount || major.toFixed(Number.isInteger(major) ? 0 : 2) };
}

/** The per-month figure a plan is sold at, in minor units — what an order's quotedAmount records. */
export const monthlyPrice = (plan, annual) => {
  if (!plan) return null;
  const amount = annual ? plan.prices?.annualMonthly : plan.prices?.monthly;
  return Number.isInteger(amount) ? amount : null;
};

/** By key, from the current catalogue. Minor units, which is what the order stores. */
export const priceFor = (key, annual) => monthlyPrice(PLAN_BY_KEY[key], annual);

/** What one invoice for a period costs: a month, or twelve of the yearly per-month price. */
export const periodPrice = (plan, annual) => {
  const amount = monthlyPrice(plan, annual);
  return amount == null ? null : annual ? amount * 12 : amount;
};

/** The yearly saving to advertise, as a whole percentage — the smallest across priced plans, so it is never overstated. */
export function yearlySaving(plans) {
  const savings = plans
    .filter((p) => Number.isInteger(p.prices?.monthly) && Number.isInteger(p.prices?.annualMonthly) && p.prices.monthly > 0)
    .map((p) => Math.floor((1 - p.prices.annualMonthly / p.prices.monthly) * 100));
  return savings.length ? Math.max(0, Math.min(...savings)) : 0;
}
