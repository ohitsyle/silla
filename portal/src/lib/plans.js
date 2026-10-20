import { useEffect, useSyncExternalStore } from "react";
import { billingApi } from "./billingApi.js";
import { DEFAULT_PLANS } from "./defaultPlans.js";
import { DEFAULT_CATALOG } from "./defaultCatalog.js";

/**
 * The plans, the catalogue, and the ONE money formatter.
 *
 * What SILLA sells is data: staff edit plans and the catalogue (extra
 * buildings, hardware, services, support) in the console, and the
 * storefront reads both from GET /api/vendor/plans. This file holds the
 * OFFLINE FALLBACK — what the pricing page and the configurator show
 * until the live catalogue answers, or if it never does — and it is not
 * a second opinion: defaultPlans.js and defaultCatalog.js here are byte
 * for byte the vendor's seed files, and the vendor's pricing suite fails
 * if they drift.
 *
 * Shared by the pricing section (which sells them), the entry dialog and
 * the configurator (which records what an order is for). Two copies
 * would drift, and the copy that mattered would be whichever one the order
 * was written from — see lib/adminSections.js in the product. Whatever
 * this module shows, the ORDER is priced by the server (lib/quote.js,
 * run again there on the catalogue as it stands).
 *
 * Money is in MINOR units (centavos) everywhere, and EXCLUDES VAT: in a
 * plan's `prices`, an order's quotedAmount, on every invoice. The old
 * fallback held MAJOR units while orders held minor ones — both correct,
 * 100x apart, which is exactly how a $39 plan once rendered as
 * "$3900/month".
 *
 *   prices.monthly        charged each month on monthly billing
 *   prices.annualMonthly  the per-month figure on yearly billing, billed as × 12
 *   null for both         "priced with you"
 */

export const DEFAULT_CURRENCY = "PHP";

/** The seed plans as the API shapes them: orderable, with every limit stated. */
export const FALLBACK_PLANS = DEFAULT_PLANS.map((plan) => ({ ...plan, active: true, orderable: true }));
/** The seed catalogue — everything besides a plan. */
export const FALLBACK_CATALOGUE = DEFAULT_CATALOG.filter((item) => item.active !== false);

/** The fallback, under its old name, for anything still importing it. Prefer usePlans(). */
export const PLANS = FALLBACK_PLANS;

/* ─────────────────────────── the live catalogue ─────────────────────────── */

/**
 * Plans by key, kept current as the live catalogue arrives — for code
 * outside React (the entry dialog reads it when it opens). Mutated in
 * place so an import taken before the catalogue loaded still sees it.
 */
export const PLAN_BY_KEY = {};

let state = {
  plans: FALLBACK_PLANS,
  catalogue: FALLBACK_CATALOGUE,
  live: false,
  failed: false,
  // Unknown until the API says: the fallback assumes VAT is not added,
  // and the pages say "excluding VAT" only once they know it applies.
  vat: { registered: false, rate: 0.12 },
  pricesExcludeVat: false,
  trialDays: null,
};
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
    .then(({ plans, catalogue, vat, pricesExcludeVat, trialDays }) => {
      const sellable = (plans || []).filter((p) => p.orderable !== false);
      if (sellable.length) {
        const registered = Boolean(vat ? vat.registered : pricesExcludeVat);
        publish({
          plans: sellable,
          catalogue: Array.isArray(catalogue) ? catalogue.filter((i) => i.active !== false) : state.catalogue,
          live: true,
          failed: false,
          vat: { registered, rate: Number.isFinite(vat?.rate) ? vat.rate : 0.12 },
          pricesExcludeVat: registered,
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
 * { plans, catalogue, live, failed, vat, pricesExcludeVat, trialDays } —
 * re-renders when the live catalogue lands. trialDays is null until it
 * does: unknown, so say nothing rather than promise a trial that may not
 * exist.
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
 *   formatMoney(600000)                       "₱6,000"        a price tag: no decimals when whole
 *   formatMoney(600000, { period: "month" })  "₱6,000/month"
 *   formatMoney(7200000, { exact: true })     "₱72,000.00"    a sum owed: always two decimals
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

/** The symbol and the figure apart, for type that sets them at different sizes: { symbol: "₱", amount: "6,000" }. */
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

/** What billing yearly saves on a plan over a year, in minor units — or null when it can't be said. */
export function yearlySavingOf(plan) {
  const monthly = plan?.prices?.monthly;
  const annual = plan?.prices?.annualMonthly;
  return Number.isInteger(monthly) && Number.isInteger(annual) && annual < monthly ? (monthly - annual) * 12 : null;
}

/**
 * What billing yearly saves on one plan, as a whole percentage, worked out
 * in integers: 1 − 6000/7500 is 0.19999… in floating point, and a floor
 * of that advertised 19% for a plan that saves exactly 20%.
 */
export function yearlyPercent(plan) {
  const monthly = plan?.prices?.monthly;
  const annual = plan?.prices?.annualMonthly;
  if (!Number.isInteger(monthly) || !Number.isInteger(annual) || monthly <= 0) return null;
  return Math.max(0, Math.floor(((monthly - annual) * 100) / monthly));
}

/**
 * The yearly saving across the plans on sale, as whole percentages —
 * `{ min, max }`, or null when no plan is cheaper billed yearly.
 *
 * The storefront's toggle used to show the SMALLEST of them as a bare
 * "−16%", while the configurator showed the chosen plan's own "−20%": one
 * discount, stated two ways on the way to one order. Now a statement
 * about one plan always uses that plan's figure (yearlyPercent, from its
 * own prices), and the toggle, which speaks for all of them, says "up to"
 * the largest — or just the figure, when every plan saves the same.
 */
export function yearlySavingRange(plans) {
  const savings = plans.map(yearlyPercent).filter((n) => n != null && n > 0);
  return savings.length ? { min: Math.min(...savings), max: Math.max(...savings) } : null;
}

/**
 * The VAT sentence, said ONCE wherever prices are listed. Every price
 * excludes VAT; whether any is added depends on SILLA's registration, so
 * a page never tells a buyer to budget 12% that will not be charged — and
 * says nothing either way until the live catalogue has said which.
 */
export function vatSentence({ vat, live } = state) {
  if (!live) return "All prices are in Philippine pesos and exclude VAT.";
  return vat?.registered
    ? `All prices are in Philippine pesos and exclude ${Math.round((vat.rate ?? 0.12) * 100)}% VAT, which is added to your invoice.`
    : "All prices are in Philippine pesos, excluding VAT. SILLA isn't VAT-registered, so none is added.";
}
