import { buildQuote } from "./quote.js";
import { monthlyPrice } from "./plans.js";
import { monthlyOf } from "./catalogue.js";

/**
 * The configurator's "Hardware & support" answers, and what they become.
 *
 * A buyer answers in plain words — how many buildings, how many kiosks,
 * how many cards and which kind — and this turns the answers into the
 * catalogue SELECTIONS an order carries ([{ key, quantity, mode }]), which
 * lib/quote.js prices here for the live quote and the vendor prices again
 * on the server. Only keys, quantities and buy/rent ever leave the
 * browser.
 *
 * Counts are kept as the text typed, so a field can be emptied: empty is
 * none.
 */
export const DEFAULT_EXTRAS = {
  /** How many buildings SILLA will manage. */
  buildings: "1",
  /** Catalogue key → typed count, for kiosks, fobs, readers and services. */
  counts: {},
  /** Catalogue key → "buy" | "rent", for what can be either. */
  modes: {},
  /** How many RFID cards, and which kind (a card item's key; "" is the first). */
  cards: "",
  cardKind: "",
  /** The support tier's key; "" is the group's default (Standard). */
  support: "",
};

/** A typed count as a number: "", "0" and anything that isn't digits are 0. */
export const count = (text) => {
  const n = Number(String(text ?? "").replace(/[,\s]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** Layers saved answers over the defaults, so an answer added later never arrives undefined. */
export const withExtrasDefaults = (saved) => ({
  ...DEFAULT_EXTRAS,
  ...(saved || {}),
  counts: { ...(saved?.counts || {}) },
  modes: { ...(saved?.modes || {}) },
});

/** The item that adds buildings — the extra building — if the catalogue sells one. */
export const buildingAddOn = (catalogue = []) =>
  catalogue.find((i) => i.active !== false && i.charge === "recurring" && Number.isInteger(i.adds?.buildings) && i.adds.buildings > 0) || null;

/** RFID cards in their kinds (blank, printed): one-time hardware counted in cards. */
export const cardKinds = (catalogue = []) =>
  catalogue
    .filter((i) => i.active !== false && i.category === "hardware" && i.charge === "one_time" && i.unit?.one === "card")
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

const isOffered = (item, plan) => !item?.plans?.length || item.plans.includes(plan?.key);

/** Extra buildings a plan needs for this many buildings: 0 when it includes them (or has no limit). */
export function extraBuildingsFor(plan, buildings, catalogue) {
  const extra = buildingAddOn(catalogue);
  const included = plan?.limits?.buildings;
  if (!Number.isInteger(included) || buildings <= included) return 0;
  return Math.ceil((buildings - included) / (extra?.adds?.buildings || 1));
}

/** The answers as an order's selections. */
export function selectionsFrom(extras, { plan, catalogue = [] }) {
  const items = new Map(catalogue.map((i) => [i.key, i]));
  const out = [];

  const extra = buildingAddOn(catalogue);
  const extraCount = extraBuildingsFor(plan, count(extras.buildings) || 1, catalogue);
  // Asked for even on a plan that has none, so the quote can say so.
  if (extra && extraCount > 0) out.push({ key: extra.key, quantity: extraCount, mode: null });

  const kinds = cardKinds(catalogue);
  const kind = items.has(extras.cardKind) ? extras.cardKind : kinds[0]?.key;
  if (kind && count(extras.cards) > 0) out.push({ key: kind, quantity: count(extras.cards), mode: null });

  for (const [key, typed] of Object.entries(extras.counts || {})) {
    const item = items.get(key);
    const n = count(typed);
    if (!item || !n || item.alwaysIncluded || item.group || item === extra) continue;
    out.push({ key, quantity: n, mode: item.charge === "buy_or_rent" ? extras.modes?.[key] || "rent" : null });
  }

  const tier = items.get(extras.support);
  if (tier && !tier.groupDefault) out.push({ key: tier.key, quantity: 1, mode: null });
  return out;
}

/** The live quote for the answers — the same function the vendor runs on the server. */
export function quoteFor(extras, { plan, plans, catalogue, annual, vat }) {
  return buildQuote({
    plan,
    plans,
    billingPeriod: annual ? "yearly" : "monthly",
    selections: selectionsFrom(extras, { plan, catalogue }),
    catalogue,
    vat,
  });
}

/**
 * The quote's problems, keyed by the field on the Hardware step they are
 * about — the wizard reveals them under that field when Continue is
 * pressed, the same as every other step.
 */
export function extrasErrors(problems, catalogue = []) {
  const items = new Map(catalogue.map((i) => [i.key, i]));
  const extra = buildingAddOn(catalogue);
  const kinds = new Set(cardKinds(catalogue).map((i) => i.key));
  const out = {};
  for (const [field, message] of Object.entries(problems || {})) {
    const key = field.replace(/^selections\.?/, "").split(".")[0];
    const item = items.get(key);
    let target = "extras.other";
    if (item && item === extra) target = "extras.buildings";
    else if (kinds.has(key)) target = "extras.cards";
    else if (item?.group) target = "extras.support";
    else if (item) target = `extras.counts.${key}`;
    if (!out[target]) out[target] = message;
  }
  return out;
}

/**
 * The cheapest plan that fits, priced with the extra buildings it would
 * need — the suggestion beside "how many buildings". Fits means: it
 * takes this many buildings (itself or with extras), and the floors and
 * bookable units already laid out. Ties go to the plan staff sort first.
 */
export function suggestPlan({ plans = [], catalogue = [], buildings = 1, floors = 0, units = 0, annual = true }) {
  const extra = buildingAddOn(catalogue);
  const options = [];
  for (const plan of plans) {
    const rate = monthlyPrice(plan, annual);
    if (rate == null) continue;
    const limits = plan.limits || {};
    if (Number.isInteger(limits.floors) && floors > limits.floors) continue;
    if (Number.isInteger(limits.resources) && units > limits.resources) continue;
    const extras = extraBuildingsFor(plan, buildings, catalogue);
    if (extras > 0 && (!extra || !isOffered(extra, plan))) continue;
    const perMonth = rate + extras * (monthlyOf(extra, annual) || 0);
    options.push({ plan, extras, perMonth });
  }
  options.sort((a, b) => a.perMonth - b.perMonth || (a.plan.sort ?? 0) - (b.plan.sort ?? 0));
  return options[0] || null;
}

/** What a plan can't hold of the layout as configured — said, never blocking: limits stop NEW things, not provisioning. */
export function outgrows(plan, { floors = 0, units = 0 }) {
  const limits = plan?.limits || {};
  const over = [];
  if (Number.isInteger(limits.floors) && floors > limits.floors) over.push(`${floors} floors (it covers ${limits.floors})`);
  if (Number.isInteger(limits.resources) && units > limits.resources) over.push(`${units} bookable units (it covers ${limits.resources})`);
  return over;
}
