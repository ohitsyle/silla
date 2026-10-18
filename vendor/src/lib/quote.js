/**
 * Quotes — what an order costs, worked out from the catalogue.
 *
 * THIS FILE EXISTS TWICE, byte for byte: vendor/src/lib/quote.js and
 * portal/src/lib/quote.js. The configurator prices a buyer's choices with
 * it as they make them, and the vendor prices them again with it on the
 * server — for a draft when it is saved, and for the frozen quote when an
 * order is submitted, from the catalogue as it stands, never from a price
 * the browser sent. One function, so what the buyer watched add up is
 * what the order records. The vendor's pricing suite fails when the two
 * copies differ: change both or neither. (lib/cells.js is the precedent.)
 *
 * Pure: no database, no clock, no money formatting — callers format with
 * their own one formatter. Every amount is an integer number of MINOR
 * units (centavos): quantities times unit prices, summed, never a float,
 * and VAT is rounded once, from a rate held in basis points.
 *
 * The shapes in are what the vendor's catalogue serves:
 *   plan  { key, name, currency, prices: { monthly, annualMonthly }, limits }
 *   item  { key, name, category, charge, unit, prices: { oneTime, monthly,
 *           annualMonthly }, minQuantity, maxQuantity, plans, group,
 *           groupDefault, adds, note, waivedOnYearly, alwaysIncluded,
 *           rentalMinimumMonths, active, sort }
 *   selection  { key, quantity, mode }   mode is "buy" | "rent" for an item
 *                                        charged buy_or_rent, else null
 */

export const QUOTE_VERSION = 1;
/** Of any one thing on one order. Far above any real order; it bounds the arithmetic. */
export const MAX_QUANTITY = 100_000;
/** Lines a buyer can choose on one order. */
export const MAX_SELECTIONS = 40;
export const MODES = ["buy", "rent"];

const KEY = /^[a-z0-9-]{2,40}$/;
const CATEGORY_ORDER = { plan: 0, building: 1, hardware: 2, service: 3, support: 4 };
const isAmount = (v) => Number.isInteger(v) && v >= 0;

/** Months in one billed period. */
export const monthsIn = (billingPeriod) => (billingPeriod === "monthly" ? 1 : 12);
export const periodWord = (billingPeriod) => (billingPeriod === "monthly" ? "month" : "year");

/** 0.12 → 1200. A rate is carried as basis points so VAT is an integer sum, rounded once. */
export const basisPoints = (rate) => Math.round(Number(rate || 0) * 10_000);

/** VAT on an amount in minor units, rounded to the centavo. Shared with the invoices, so a quote and its invoice agree. */
export function vatOn(amount, rate) {
  const bp = basisPoints(rate);
  return bp > 0 && Number.isInteger(amount) ? Math.round((amount * bp) / 10_000) : 0;
}

/** "VAT 12%" */
export const vatLabel = (rate) => `VAT ${Math.round(basisPoints(rate)) / 100}%`;

/**
 * A plan's price per month on a billing period — null when it is priced
 * with each customer. For a plan, a missing yearly figure means exactly
 * that, not "the same as monthly".
 */
export function planMonthly(plan, billingPeriod) {
  const prices = plan?.prices || {};
  const value = billingPeriod === "monthly" ? prices.monthly : prices.annualMonthly;
  return isAmount(value) ? value : null;
}

/**
 * An item's price per unit per month on a billing period — for recurring
 * items and rentals. A missing yearly figure is the monthly one: an item
 * without a yearly discount costs the same either way.
 */
export function itemMonthly(item, billingPeriod) {
  const prices = item?.prices || {};
  if (billingPeriod !== "monthly" && isAmount(prices.annualMonthly)) return prices.annualMonthly;
  return isAmount(prices.monthly) ? prices.monthly : null;
}

/** The field a problem with one choice is reported under: "selections.kiosk.rent". */
export const selectionField = (key, mode = null) => `selections.${key}${mode ? `.${mode}` : ""}`;

/** A typed count: a whole number, a string of digits, or nothing (0). Anything else is null. */
function toCount(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  const text = String(value).replace(/[,\s]/g, "");
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

const count = (n) => Number(n).toLocaleString("en-PH");

/**
 * A buyer's choices as the vendor stores them: [{ key, quantity, mode }].
 * ONLY those three fields are read. A price sent beside them is dropped
 * here, so nothing downstream can ever see one. A quantity of 0 — or an
 * empty field — is not a choice and is left out. Problems are keyed by
 * field, like every form in the portal.
 */
export function readSelections(raw) {
  const problems = {};
  if (raw === null || raw === undefined) return { selections: [], problems };
  if (!Array.isArray(raw)) return { selections: [], problems: { selections: "Choices must be a list." } };
  if (raw.length > MAX_SELECTIONS) {
    return { selections: [], problems: { selections: `Up to ${MAX_SELECTIONS} choices on one order.` } };
  }
  const selections = [];
  const seen = new Set();
  for (const entry of raw) {
    const key = String(entry?.key ?? "").trim().toLowerCase();
    const mode = entry?.mode === null || entry?.mode === undefined || entry?.mode === "" ? null : String(entry.mode);
    if (!KEY.test(key)) {
      problems.selections = "Every choice needs a catalogue key.";
      continue;
    }
    const field = selectionField(key, mode);
    if (mode !== null && !MODES.includes(mode)) {
      problems[field] = "Choose buy or rent.";
      continue;
    }
    const quantity = toCount(entry?.quantity);
    if (quantity === null) {
      problems[field] = "Enter a whole number, or leave it empty.";
      continue;
    }
    if (quantity === 0) continue;
    if (quantity > MAX_QUANTITY) {
      problems[field] = `Up to ${count(MAX_QUANTITY)} on one order.`;
      continue;
    }
    const id = `${key}:${mode || ""}`;
    if (seen.has(id)) {
      problems[field] = "This is listed twice.";
      continue;
    }
    seen.add(id);
    selections.push({ key, quantity, mode });
  }
  return { selections, problems };
}

/**
 * What one line says on an invoice. The first invoice and every renewal
 * describe the same things, so the words live once, here.
 *
 *   Campus plan — first year
 *   Extra building — renewal, 1 year
 *   SILLA Kiosk rental — first year (12-month minimum)
 *   SILLA Kiosk (purchase)
 *   Onboarding — waived on yearly billing
 */
export function describeLine({ kind, name, mode = null, minimumMonths = 0, waived = false }, { billingPeriod, occasion = "first" } = {}) {
  const per = periodWord(billingPeriod);
  const when = occasion === "renewal" ? `renewal, 1 ${per}` : `first ${per}`;
  if (kind === "plan") return `${name} plan — ${when}`;
  if (kind === "rental") {
    return `${name} rental — ${when}${minimumMonths > 0 && occasion !== "renewal" ? ` (${minimumMonths}-month minimum)` : ""}`;
  }
  if (kind === "recurring") return `${name} — ${when}`;
  if (waived) return `${name} — waived on yearly billing`;
  if (mode === "buy") return `${name} (purchase)`;
  return name;
}

/** Per-unit limit raises times a quantity: { buildings: 1 } × 2 → { buildings: 2 }. */
function scaledAdds(adds, quantity) {
  const out = {};
  for (const [limit, per] of Object.entries(adds || {})) {
    if (Number.isInteger(per) && per > 0) out[limit] = per * quantity;
  }
  return out;
}

const order = (line) => [CATEGORY_ORDER[line.category] ?? 9, line.sort ?? 0, line.key, line.mode === "rent" ? 1 : 0];
function byPlace(a, b) {
  const x = order(a);
  const y = order(b);
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

const nameList = (names) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

/**
 * The quote for a plan, a billing period and a set of choices.
 *
 * Returns { quote, problems }. `problems` is keyed by field and empty when
 * the quote can be ordered; the quote is still returned with problems, so
 * a screen can show what adds up while it says what is wrong.
 *
 * Lines:
 *   plan       the plan, per month and per billed period
 *   recurring  monthly add-ons (extra buildings, support), per unit per month
 *   rental     buy_or_rent items rented, per unit per month, with their minimum term
 *   one_time   bought hardware and services, per unit, on the first invoice only
 *
 * Each recurring line carries `unitAmount` per unit per MONTH and
 * `periodUnitAmount` per unit per billed period (what an invoice line
 * charges); a one-time line carries `unitAmount` per unit. `amount` is what
 * the line adds to the FIRST invoice, in both kinds.
 */
export function buildQuote({ plan, plans = [], billingPeriod, selections = [], catalogue = [], vat = null } = {}) {
  const period = billingPeriod === "monthly" ? "monthly" : "yearly";
  const months = monthsIn(period);
  const problems = {};
  const items = new Map((catalogue || []).map((item) => [item.key, item]));
  const planName = (key) => plans.find((p) => p.key === key)?.name || key;
  const offered = (item) => !item.plans?.length || item.plans.includes(plan?.key);
  const lines = [];

  /* ── the plan ── */
  const planRate = planMonthly(plan, period);
  lines.push({
    key: "plan",
    kind: "plan",
    category: "plan",
    name: plan?.name || plan?.key || "Plan",
    mode: null,
    quantity: 1,
    unit: { one: "plan", many: "plans" },
    unitAmount: planRate,
    periodUnitAmount: planRate === null ? null : planRate * months,
    perMonth: planRate,
    perPeriod: planRate === null ? null : planRate * months,
    amount: planRate === null ? null : planRate * months,
    monthlyRate: planMonthly(plan, "monthly"),
    yearlyRate: planMonthly(plan, "yearly"),
    minimumMonths: 0,
    adds: {},
    included: false,
    waived: false,
    note: "",
    description: describeLine({ kind: "plan", name: plan?.name || plan?.key || "Plan" }, { billingPeriod: period }),
  });

  /* ── what was chosen ── */
  const recurringLine = (item, quantity, mode) => {
    const kind = mode === "rent" ? "rental" : "recurring";
    const unitAmount = itemMonthly(item, period);
    const minimumMonths = kind === "rental" ? Number(item.rentalMinimumMonths) || 0 : 0;
    return {
      key: item.key,
      kind,
      category: item.category,
      sort: item.sort ?? 0,
      name: item.name,
      mode,
      quantity,
      unit: item.unit || { one: "unit", many: "units" },
      unitAmount,
      periodUnitAmount: unitAmount * months,
      perMonth: quantity * unitAmount,
      perPeriod: quantity * unitAmount * months,
      amount: quantity * unitAmount * months,
      monthlyRate: itemMonthly(item, "monthly"),
      yearlyRate: itemMonthly(item, "yearly"),
      minimumMonths,
      adds: kind === "recurring" ? scaledAdds(item.adds, quantity) : {},
      included: unitAmount === 0,
      waived: false,
      note: item.note || "",
      description: describeLine({ kind, name: item.name, minimumMonths }, { billingPeriod: period }),
    };
  };
  const oneTimeLine = (item, quantity, mode) => {
    const unitAmount = item.prices.oneTime;
    const waived = Boolean(item.waivedOnYearly) && period === "yearly";
    return {
      key: item.key,
      kind: "one_time",
      category: item.category,
      sort: item.sort ?? 0,
      name: item.name,
      mode,
      quantity,
      unit: item.unit || { one: "unit", many: "units" },
      unitAmount,
      periodUnitAmount: null,
      perMonth: null,
      perPeriod: null,
      fullAmount: quantity * unitAmount,
      amount: waived ? 0 : quantity * unitAmount,
      waivable: Boolean(item.waivedOnYearly),
      waived,
      minimumMonths: 0,
      adds: {},
      included: false,
      note: item.note || "",
      description: describeLine({ kind: "one_time", name: item.name, mode, waived }, { billingPeriod: period }),
    };
  };

  const groups = new Map(); // group → the item already chosen from it
  const placed = new Set();
  for (const choice of selections || []) {
    const item = items.get(choice.key);
    const field = selectionField(choice.key, choice.mode);
    if (!item) {
      problems[field] = `There's no “${choice.key}” in the catalogue.`;
      continue;
    }
    if (item.active === false) {
      problems[field] = `${item.name} isn't offered any more — leave it out.`;
      continue;
    }
    // On every order already; choosing it again changes nothing.
    if (item.alwaysIncluded) continue;
    if (!offered(item)) {
      problems[field] = `${item.name} isn't available on the ${plan?.name || "chosen"} plan — choose ${nameList(item.plans.map(planName))}.`;
      continue;
    }

    let mode = null;
    if (item.charge === "buy_or_rent") {
      if (!MODES.includes(choice.mode)) {
        problems[field] = `Choose whether to buy or rent the ${item.unit?.many || "items"}.`;
        continue;
      }
      mode = choice.mode;
    } else if (choice.mode === "rent") {
      problems[field] = `${item.name} isn't rented — leave out “rent”.`;
      continue;
    }
    const id = `${item.key}:${mode || ""}`;
    if (placed.has(id)) {
      problems[field] = `${item.name} is listed twice.`;
      continue;
    }

    const quantity = choice.quantity;
    const min = Number(item.minQuantity) || 1;
    if (quantity < min) {
      problems[field] = `${item.name}: the minimum is ${count(min)} ${min === 1 ? item.unit?.one || "unit" : item.unit?.many || "units"}.`;
      continue;
    }
    if (Number.isInteger(item.maxQuantity) && quantity > item.maxQuantity) {
      problems[field] =
        item.maxQuantity === 1
          ? `${item.name}: one per order.`
          : `${item.name}: up to ${count(item.maxQuantity)} ${item.unit?.many || "units"} on one order.`;
      continue;
    }
    if (item.group) {
      const already = groups.get(item.group);
      if (already && already.key !== item.key) {
        problems[field] = `Choose one ${item.group} option — ${already.name} or ${item.name}, not both.`;
        continue;
      }
      groups.set(item.group, item);
    }

    const rented = mode === "rent";
    const monthly = item.charge === "recurring" || rented;
    if (monthly ? itemMonthly(item, period) === null : !isAmount(item.prices?.oneTime)) {
      problems[field] = `${item.name} has no price yet — leave it out, or ask us.`;
      continue;
    }
    placed.add(id);
    lines.push(monthly ? recurringLine(item, quantity, mode) : oneTimeLine(item, quantity, mode));
  }

  /* ── what every order carries ── */
  for (const item of items.values()) {
    if (item.active === false || !offered(item)) continue;
    if (item.alwaysIncluded && !placed.has(`${item.key}:`)) {
      const priced = item.charge === "recurring" ? itemMonthly(item, period) !== null : isAmount(item.prices?.oneTime);
      if (!priced) continue;
      placed.add(`${item.key}:`);
      lines.push(item.charge === "recurring" ? recurringLine(item, 1, null) : oneTimeLine(item, 1, null));
    }
  }
  for (const item of items.values()) {
    if (item.active === false || !offered(item) || !item.group || !item.groupDefault || groups.has(item.group)) continue;
    if (item.charge !== "recurring" || itemMonthly(item, period) === null) continue;
    groups.set(item.group, item);
    lines.push(recurringLine(item, 1, null));
  }

  lines.sort(byPlace);

  /* ── totals ── */
  const recurring = lines.filter((l) => l.kind !== "one_time");
  const oneTimes = lines.filter((l) => l.kind === "one_time");
  const sum = (list, field) => list.reduce((total, l) => total + (l[field] || 0), 0);
  const planPriced = planRate !== null;
  const perMonth = sum(recurring, "perMonth");
  const perPeriod = sum(recurring, "perPeriod");
  const oneTime = sum(oneTimes, "amount");
  const waived = sum(oneTimes.filter((l) => l.waived), "fullAmount");
  const rate = vat?.registered ? Number(vat.rate) || 0 : 0;
  const invoice = (subtotal) => {
    const tax = vatOn(subtotal, rate);
    return { subtotal, tax, total: subtotal + tax };
  };

  // What billing yearly saves over the same choices billed monthly, across
  // a first year: twelve months at the monthly rates, against the year at
  // the yearly ones — plus what is waived on yearly billing. The same
  // figure whichever period is chosen, so a monthly quote can offer it.
  const savingRecurring = recurring.reduce(
    (total, l) =>
      Number.isInteger(l.monthlyRate) && Number.isInteger(l.yearlyRate) ? total + l.quantity * (l.monthlyRate - l.yearlyRate) * 12 : total,
    0
  );
  const savingWaived = oneTimes.filter((l) => l.waivable).reduce((total, l) => total + l.fullAmount, 0);

  const adds = {};
  for (const line of recurring) {
    for (const [limit, n] of Object.entries(line.adds || {})) adds[limit] = (adds[limit] || 0) + n;
  }
  const limits = { ...(plan?.limits || {}) };
  for (const [limit, n] of Object.entries(adds)) {
    if (Number.isInteger(limits[limit])) limits[limit] += n;
  }

  const commitments = lines
    .filter((l) => l.kind === "rental" && l.minimumMonths > 0)
    .map((l) => `${l.name} rental: ${l.minimumMonths}-month minimum.`);

  const totals = {
    oneTime,
    perMonth,
    perPeriod,
    firstInvoice: planPriced ? invoice(perPeriod + oneTime) : null,
    renewal: planPriced ? invoice(perPeriod) : null,
    waived,
    yearlySaving: { recurring: savingRecurring, waived: savingWaived, total: savingRecurring + savingWaived },
  };
  const tooLarge = [perPeriod, oneTime, totals.firstInvoice?.total ?? 0].some((n) => !Number.isSafeInteger(n));
  if (tooLarge) problems.selections = "That's too large to price in one order — split it, or talk to us.";

  return {
    quote: {
      version: QUOTE_VERSION,
      currency: plan?.currency || "PHP",
      billingPeriod: period,
      months,
      plan: {
        key: plan?.key || "",
        name: plan?.name || plan?.key || "",
        priced: planPriced,
        perMonth: planRate,
        perPeriod: planPriced ? planRate * months : null,
      },
      lines: lines.map(({ sort, ...line }) => line),
      totals,
      vat: { registered: Boolean(vat?.registered), rate, label: rate ? vatLabel(rate) : "" },
      limits,
      adds,
      commitments,
    },
    problems,
  };
}
