/**
 * Billing — the seam between orders, subscriptions, invoices and the
 * deployments they pay for. docs/control-plane.md §4 is the contract.
 *
 * Other code calls ONLY the functions exported here, never the billing
 * models' internals: order.routes.js on submit and cancel, the
 * staff-operations work when it provisions a deployment, and billing's own
 * routes and job. Reading the models for display is fine; writing them
 * anywhere else is how two rules for "is this customer paid up" start.
 *
 * How the money moves:
 *
 *   order submitted ────────► subscription "pending" + first invoice (emailed)
 *   deployment provisioned ─► "trialing" for trialDays, or "active" if already paid
 *   staff record a payment ─► invoice "paid" → "active"; the period starts or extends
 *   job, renewalNoticeDays before a period ends ─► renewal invoice
 *   job, a period or trial ends with its invoice open ─► "past_due" (grace)
 *   job, grace over ─► "suspended": read-only, nothing deleted
 *
 * Every status change writes a history entry and an audit event, then
 * pushes the entitlement snapshot to the deployment (syncDeployment), so
 * the product enforces what was decided here without ever having to ask.
 *
 * Payments: there is no card processor. Staff record money actually
 * received — bank transfer, GCash, Maya, cash — with recordPayment(), and
 * a buyer's "I've paid" is only a CLAIM (claimPayment) that staff confirm.
 * When PayMongo or Xendit arrives, its webhook calls recordPayment() with
 * `by: null` and the processor's reference: the same path, so a payment
 * means exactly the same thing however it arrived.
 *
 * The billing job (workers/billing.jobs.js) decides WHICH subscriptions
 * are due for something; the transitions themselves live here, so a
 * suspension by the job and a suspension by staff are the same code.
 */
import mongoose from "mongoose";
import Plan from "../models/Plan.js";
import CatalogItem, { CATALOG_CATEGORIES, CATALOG_CHARGES } from "../models/CatalogItem.js";
import Subscription from "../models/Subscription.js";
import Invoice, { PAYMENT_METHODS } from "../models/Invoice.js";
import Settings from "../models/Settings.js";
import Account from "../models/Account.js";
import Order from "../models/Order.js";
import { nextSequence } from "../models/Counter.js";
import { callDeployment } from "../lib/controlPlane.js";
import { DEFAULT_PLANS } from "../lib/defaultPlans.js";
import { DEFAULT_CATALOG } from "../lib/defaultCatalog.js";
import { FEATURES, LIMITS } from "../lib/planKeys.js";
import {
  MAX_QUANTITY, buildQuote, describeLine, itemMonthly as itemMonthlyOf, monthsIn, readSelections, scaledAdds, vatLabel, vatOn,
} from "../lib/quote.js";
import { audit } from "../lib/audit.js";
import { isUndeliverable, sendEmail } from "./email/index.js";
import * as mail from "./email/billingTemplates.js";

const DAY = 86_400_000;

/** How far ahead of a due date — or a trial's end — the "coming up" reminder goes out. */
export const REMINDER_LEAD_DAYS = 3;

/** A refusal with a reason a person can act on, and field-keyed messages for forms. */
export class BillingError extends Error {
  constructor(message, { status = 400, code = "BILLING", fields } = {}) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/** Throws the first problem as the message, all of them keyed by field. */
function refuse(fields, status = 400) {
  throw new BillingError(Object.values(fields)[0], { status, fields });
}

const clean = (value, max) => String(value ?? "").trim().slice(0, max);
const money = mail.formatMoney;
const date = mail.formatDate;
const PERIOD_WORD = { monthly: "month", yearly: "year" };
const STATUS_WORD = {
  pending: "pending",
  trialing: "trialing",
  active: "active",
  past_due: "past due",
  suspended: "suspended",
  cancelled: "cancelled",
};

/* ───────────────────────────── who did it ───────────────────────────── */

/**
 * audit() reads only `req.account`, so a service call hands it a stand-in
 * request. `by` null is the system — the billing job, or one day a payment
 * webhook — and the activity log says "system" rather than guessing.
 */
const actor = (by) => (by ? { account: by } : null);
const byId = (by) => by?._id || null;
const subjectOf = (sub) => ({ type: "subscription", id: sub._id, label: sub.organizationName });
const invoiceTarget = (inv) => ({ type: "invoice", id: inv._id, label: inv.number });
const planTarget = (plan) => ({ type: "plan", id: plan.key, label: plan.name });

/**
 * Every status change gets exactly one of these, targeted at the
 * subscription, whatever caused it — so a customer's whole standing can
 * be read from one filter in the activity log.
 */
async function statusAudit(sub, from, by, cause) {
  await audit(
    actor(by),
    "subscription.status",
    subjectOf(sub),
    `${sub.organizationName}: ${STATUS_WORD[from] || from} → ${STATUS_WORD[sub.status] || sub.status} (${cause})`,
    { from, to: sub.status, cause }
  );
}

/**
 * Moves a subscription out of the status it was READ in, with its history
 * entry, in one conditional update. If anything moved it in between — the
 * billing job, a payment, a second click on the same button — nothing is
 * written and the caller is refused, so a suspension happens once and
 * emails once. Returns the updated document.
 */
async function transition(sub, to, { set = {}, note = "", by = null } = {}) {
  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: sub.status },
    { $set: { ...set, status: to }, $push: { history: { at: new Date(), status: to, by: byId(by), note } } },
    { new: true }
  );
  if (!updated) {
    throw new BillingError("This subscription changed a moment ago. Reload it and try again.", {
      status: 409,
      code: "SUBSCRIPTION_CHANGED",
    });
  }
  return updated;
}

/* ───────────────────────────── time and money ───────────────────────────── */

export const addDays = (when, days) => new Date(new Date(when).getTime() + days * DAY);

/**
 * Calendar months, clamped: 31 January plus one month is 28 (or 29)
 * February, not 3 March. Otherwise a monthly customer who started on the
 * 31st would drift a few days later every short month.
 */
function addMonths(when, months) {
  const d = new Date(when);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export const addPeriod = (when, billingPeriod) => addMonths(when, billingPeriod === "monthly" ? 1 : 12);

const isAmount = (v) => Number.isInteger(v) && v >= 0;

/**
 * What one billing period costs on a plan, in minor units — or null when
 * the plan is priced with each customer. A yearly invoice is the
 * pricing page's "per month, billed annually" figure times twelve.
 */
export function periodPrice(plan, billingPeriod) {
  const prices = plan?.prices || {};
  if (billingPeriod === "monthly") return isAmount(prices.monthly) ? prices.monthly : null;
  return isAmount(prices.annualMonthly) ? prices.annualMonthly * 12 : null;
}

/** The per-month figure the storefront quotes for a period — what an order's quotedAmount holds. */
const monthlyFigure = (plan, billingPeriod) =>
  billingPeriod === "monthly" ? plan?.prices?.monthly ?? null : plan?.prices?.annualMonthly ?? null;

/** Not a status: computed from the clock, so it can never disagree with it. */
export const isOverdue = (invoice, now = new Date()) =>
  invoice.status === "open" && Boolean(invoice.dueAt) && new Date(invoice.dueAt) < now;

/* ───────────────────────────── plans ───────────────────────────── */

/** The catalogue, seeded with DEFAULT_PLANS the first time it is empty. */
export async function ensurePlans() {
  if ((await Plan.estimatedDocumentCount()) === 0) {
    await Plan.insertMany(DEFAULT_PLANS).catch((err) => {
      if (err?.code !== 11000) throw err; // a concurrent first read already seeded it
    });
  }
  return Plan.find({}).sort({ sort: 1, createdAt: 1 }).lean();
}

export async function planByKey(key) {
  await ensurePlans();
  return Plan.findOne({ key }).lean();
}

/**
 * Whether an order can carry this plan today — what the storefront offers.
 * Any ACTIVE plan: models/Order.js no longer restricts the key to a fixed
 * list, and order.routes.js accepts any active plan in the catalogue, so
 * a plan staff create in the console is on sale the moment it is saved.
 * Still read from the model rather than assumed, so a restriction ever put
 * back there is honoured here too: the storefront must never offer a plan
 * whose "Save" would answer "Pick a plan."
 */
const orderKeys = () => Order.schema.path("plan")?.enumValues || [];
const isOrderable = (plan) => plan?.active !== false && (!orderKeys().length || orderKeys().includes(plan.key));

export function planShape(plan) {
  return {
    key: plan.key,
    name: plan.name,
    tagline: plan.tagline || "",
    highlights: plan.highlights || [],
    featured: Boolean(plan.featured),
    currency: plan.currency || "PHP",
    prices: { monthly: plan.prices?.monthly ?? null, annualMonthly: plan.prices?.annualMonthly ?? null },
    features: Object.fromEntries(Object.keys(FEATURES).map((k) => [k, plan.features?.[k] !== false])),
    limits: Object.fromEntries(
      Object.keys(LIMITS).map((k) => [k, isAmount(plan.limits?.[k]) ? plan.limits[k] : null])
    ),
    active: plan.active !== false,
    sort: plan.sort || 0,
  };
}

/** The plans, shaped for the storefront (active only) or for staff (everything). */
export async function catalogue({ includeRetired = false } = {}) {
  const plans = await ensurePlans();
  return plans
    .filter((p) => includeRetired || p.active !== false)
    .map((p) => ({ ...planShape(p), orderable: isOrderable(p) }));
}

const PLAN_KEY = /^[a-z0-9-]{2,40}$/;
/** ₱100M a period. Far above any real price; it exists to catch an amount typed in centavos twice. */
const MAX_AMOUNT = 10_000_000_000;

function readAmount(raw, fields, key, message) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT) fields[key] = message;
  return n;
}

function readFeatures(raw, fields, prefix) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fields[prefix] = "Features must be a set of on/off switches.";
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in FEATURES)) fields[`${prefix}.${key}`] = `There is no feature called "${key}".`;
    else if (typeof value === "boolean") out[key] = value;
    else if (value !== null) fields[`${prefix}.${key}`] = "Choose on or off.";
  }
  return out;
}

/**
 * Limits: a whole number caps it, null means unlimited. For a plan an
 * absent key is also unlimited; for overrides absent means "use the
 * plan's", which is why null has to stay distinguishable from absent.
 */
function readLimits(raw, fields, prefix) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fields[prefix] = "Limits must be numbers, or unlimited.";
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in LIMITS)) fields[`${prefix}.${key}`] = `There is no limit called "${key}".`;
    else if (value === null) out[key] = null;
    else if (Number.isInteger(value) && value >= 0) out[key] = value;
    else fields[`${prefix}.${key}`] = "A whole number, or unlimited.";
  }
  return out;
}

function readPlan(input = {}, { creating }) {
  const fields = {};
  const value = {};

  if (creating) {
    value.key = String(input.key || "").trim().toLowerCase();
    if (!PLAN_KEY.test(value.key)) fields.key = "Use 2–40 lowercase letters, digits or hyphens.";
  }
  if (creating || input.name !== undefined) {
    value.name = clean(input.name, 200);
    if (!value.name) fields.name = "Give the plan a name.";
    else if (value.name.length > 60) fields.name = "Keep the name under 60 characters.";
  }
  if (input.tagline !== undefined) {
    value.tagline = clean(input.tagline, 400);
    if (value.tagline.length > 160) fields.tagline = "Keep the tagline under 160 characters.";
  }
  if (input.highlights !== undefined) {
    const list = (Array.isArray(input.highlights) ? input.highlights : String(input.highlights || "").split("\n"))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (list.length > 8) fields.highlights = "Up to 8 highlights — the card gets unreadable past that.";
    else if (list.some((s) => s.length > 120)) fields.highlights = "Keep each highlight under 120 characters.";
    value.highlights = list;
  }
  for (const flag of ["featured", "active"]) {
    if (input[flag] !== undefined) value[flag] = Boolean(input[flag]);
  }
  if (input.sort !== undefined) {
    value.sort = Number(input.sort);
    if (!Number.isInteger(value.sort)) fields.sort = "A whole number — lower comes first.";
  }
  if (input.currency !== undefined) {
    value.currency = String(input.currency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(value.currency)) fields.currency = "A three-letter currency code, like PHP.";
  }
  if (input.prices !== undefined) {
    const message = "Enter a price, or leave both empty for a plan priced with each customer.";
    const monthly = readAmount(input.prices?.monthly, fields, "prices.monthly", message);
    const annualMonthly = readAmount(input.prices?.annualMonthly, fields, "prices.annualMonthly", message);
    // Half a price is neither: the storefront would sell one period and
    // say "priced with you" for the other.
    if ((monthly === null) !== (annualMonthly === null)) {
      fields[monthly === null ? "prices.monthly" : "prices.annualMonthly"] =
        "Set both prices, or neither for a plan priced with each customer.";
    }
    value.prices = { monthly, annualMonthly };
  }
  if (input.features !== undefined) value.features = readFeatures(input.features, fields, "features");
  if (input.limits !== undefined) value.limits = readLimits(input.limits, fields, "limits");

  return { value, fields };
}

export async function createPlan(input, by) {
  await ensurePlans();
  const { value, fields } = readPlan(input, { creating: true });
  if (!fields.key && (await Plan.exists({ key: value.key }))) fields.key = "A plan with that key already exists.";
  if (Object.keys(fields).length) refuse(fields);

  const plan = await Plan.create(value);
  await audit(actor(by), "plan.create", planTarget(plan), `Created the ${plan.name} plan`, planShape(plan));
  return { ...planShape(plan), orderable: isOrderable(plan) };
}

/**
 * Edit a plan. Its FEATURES and LIMITS apply to every live subscription on
 * it at once (each one's overrides still win) — that is what a plan is.
 * Its PRICE does not: a subscription carries the price its customer
 * agreed, and only new subscriptions read the catalogue.
 */
export async function updatePlan(key, input, by) {
  const plan = await Plan.findOne({ key });
  if (!plan) throw new BillingError("There is no plan with that key.", { status: 404 });
  const { value, fields } = readPlan(input, { creating: false });
  if (Object.keys(fields).length) refuse(fields);

  const before = planShape(plan);
  for (const [field, v] of Object.entries(value)) {
    plan.set(field, v);
    if (field === "features" || field === "limits") plan.markModified(field);
  }
  await plan.save();
  const after = planShape(plan);
  const changed = Object.keys(value).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
  if (!changed.length) return { plan: { ...after, orderable: isOrderable(after) }, resyncing: 0 };

  const pick = (o) => Object.fromEntries(changed.map((f) => [f, o[f]]));
  await audit(actor(by), "plan.update", planTarget(plan), `Updated the ${plan.name} plan (${changed.join(", ")})`, {
    changed,
    before: pick(before),
    after: pick(after),
  });

  if (changed.includes("name")) {
    await Subscription.updateMany({ plan: key, status: { $ne: "cancelled" } }, { $set: { planName: plan.name } });
  }
  let resyncing = 0;
  if (changed.some((f) => ["name", "features", "limits"].includes(f))) resyncing = await resyncPlan(key);
  return { plan: { ...after, orderable: isOrderable(after) }, resyncing };
}

/**
 * Pushes every live deployment on a plan, in the background: a plan on
 * fifty deployments must not hold a staff member's Save for fifty round
 * trips. Each push records its own outcome on its subscription, and the
 * billing job retries the ones that failed.
 */
async function resyncPlan(key) {
  const ids = await Subscription.find({ plan: key, organizationId: { $ne: "" }, status: { $ne: "cancelled" } }).distinct("_id");
  if (ids.length) {
    (async () => {
      for (const id of ids) {
        const sub = await Subscription.findById(id);
        if (sub) await syncDeployment(sub);
      }
    })().catch((err) => console.error("[vendor:billing] plan resync failed:", err));
  }
  return ids.length;
}

/* ───────────────────────────── the catalogue: everything besides a plan ───────────────────────────── */

/**
 * Extra buildings, hardware, services and support — seeded with
 * DEFAULT_CATALOG the first time it is empty, exactly as the plans are,
 * then owned by staff (models/CatalogItem.js says what each field means).
 */
export async function ensureCatalog() {
  if ((await CatalogItem.estimatedDocumentCount()) === 0) {
    await CatalogItem.insertMany(DEFAULT_CATALOG).catch((err) => {
      if (err?.code !== 11000) throw err; // a concurrent first read already seeded it
    });
  }
  return CatalogItem.find({}).sort({ sort: 1, createdAt: 1 }).lean();
}

const amountOrNull = (v) => (isAmount(v) ? v : null);

/** Per-unit limit raises, keyed by lib/planKeys.js — anything else is dropped. */
function cleanAdds(adds) {
  const out = {};
  for (const [key, n] of Object.entries(adds || {})) {
    if (key in LIMITS && Number.isInteger(n) && n > 0) out[key] = n;
  }
  return out;
}

/** One catalogue item as the storefront, the configurator and lib/quote.js read it. */
export function catalogItemShape(item) {
  const prices = item.prices || {};
  return {
    key: item.key,
    name: item.name,
    description: item.description || "",
    highlights: item.highlights || [],
    category: item.category,
    charge: item.charge,
    unit: { one: item.unit?.one || "unit", many: item.unit?.many || "units" },
    currency: item.currency || "PHP",
    prices: {
      oneTime: amountOrNull(prices.oneTime),
      monthly: amountOrNull(prices.monthly),
      annualMonthly: amountOrNull(prices.annualMonthly),
    },
    minQuantity: Number.isInteger(item.minQuantity) && item.minQuantity >= 1 ? item.minQuantity : 1,
    maxQuantity: Number.isInteger(item.maxQuantity) && item.maxQuantity >= 1 ? item.maxQuantity : null,
    plans: [...(item.plans || [])],
    group: item.group || "",
    groupDefault: Boolean(item.groupDefault),
    adds: cleanAdds(item.adds),
    note: item.note || "",
    waivedOnYearly: Boolean(item.waivedOnYearly),
    alwaysIncluded: Boolean(item.alwaysIncluded),
    rentalMinimumMonths: Number.isInteger(item.rentalMinimumMonths) && item.rentalMinimumMonths > 0 ? item.rentalMinimumMonths : 0,
    active: item.active !== false,
    sort: item.sort || 0,
  };
}

/** The catalogue, shaped: active items for the storefront, everything for staff. */
export async function catalogItems({ includeRetired = false } = {}) {
  const items = await ensureCatalog();
  return items.filter((i) => includeRetired || i.active !== false).map(catalogItemShape);
}

const catalogTarget = (item) => ({ type: "catalog", id: item.key, label: item.name });
const GROUP_KEY = /^[a-z0-9-]{2,40}$/;
/** The fields a new item starts from, so a create is validated as the whole item it will be. */
const BLANK_ITEM = catalogItemShape({ key: "", name: "", category: "hardware", charge: "one_time", unit: {}, prices: {} });

/**
 * Validates a create or an edit. Each field is checked on its own, then
 * the item AS IT WOULD BE SAVED is checked as a whole: a charge that
 * needs a price it doesn't have, a limit raise on something paid once, a
 * waiver on something that isn't one-time. An edit sends only what
 * changed, so the whole is the stored item with the edit laid over it.
 */
function readCatalogItem(input = {}, { creating, current = null, planKeys = [] }) {
  const fields = {};
  const value = {};

  if (creating) {
    value.key = String(input.key || "").trim().toLowerCase();
    if (!PLAN_KEY.test(value.key)) fields.key = "Use 2–40 lowercase letters, digits or hyphens.";
  }
  if (creating || input.name !== undefined) {
    value.name = clean(input.name, 200);
    if (!value.name) fields.name = "Name it — this is what an invoice line says.";
    else if (value.name.length > 60) fields.name = "Keep the name under 60 characters.";
  }
  if (input.description !== undefined) {
    value.description = clean(input.description, 600);
    if (value.description.length > 300) fields.description = "Keep it under 300 characters.";
  }
  if (input.highlights !== undefined) {
    const list = lines(input.highlights);
    if (list.length > 8) fields.highlights = "Up to 8 points.";
    else if (list.some((s) => s.length > 120)) fields.highlights = "Keep each point under 120 characters.";
    value.highlights = list;
  }
  if (creating || input.category !== undefined) {
    value.category = String(input.category || "");
    if (!CATALOG_CATEGORIES.includes(value.category)) fields.category = "Choose what kind of thing it is.";
  }
  if (creating || input.charge !== undefined) {
    value.charge = String(input.charge || "");
    if (!CATALOG_CHARGES.includes(value.charge)) fields.charge = "Choose how it is charged.";
  }
  if (input.unit !== undefined) {
    value.unit = { one: clean(input.unit?.one, 60), many: clean(input.unit?.many, 60) };
    for (const n of ["one", "many"]) {
      if (!value.unit[n]) fields[`unit.${n}`] = n === "one" ? "What is one called — “card”?" : "And more than one — “cards”?";
      else if (value.unit[n].length > 30) fields[`unit.${n}`] = "Keep it under 30 characters.";
    }
  }
  if (input.currency !== undefined) {
    value.currency = String(input.currency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(value.currency)) fields.currency = "A three-letter currency code, like PHP.";
  }
  if (input.prices !== undefined) {
    const raw = input.prices && typeof input.prices === "object" ? input.prices : {};
    // Only the prices sent change; null clears one.
    value.prices = { ...(current ? catalogItemShape(current).prices : BLANK_ITEM.prices) };
    for (const p of ["oneTime", "monthly", "annualMonthly"]) {
      if (p in raw) value.prices[p] = readAmount(raw[p], fields, `prices.${p}`, "Enter a price in pesos, or leave it empty.");
    }
  }
  const readCount = (key, { nullable = false } = {}) => {
    if (input[key] === undefined) return;
    if (nullable && (input[key] === null || input[key] === "")) {
      value[key] = null;
      return;
    }
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) fields[key] = `A whole number from 1 to ${MAX_QUANTITY.toLocaleString("en-PH")}.`;
    value[key] = n;
  };
  readCount("minQuantity");
  readCount("maxQuantity", { nullable: true });
  if (input.plans !== undefined) {
    const list = (Array.isArray(input.plans) ? input.plans : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    const unknown = list.find((k) => !planKeys.includes(k));
    if (!Array.isArray(input.plans)) fields.plans = "List the plans it is offered on, or none for every plan.";
    else if (unknown) fields.plans = `There is no plan called “${unknown}”.`;
    value.plans = [...new Set(list)];
  }
  if (input.group !== undefined) {
    value.group = String(input.group || "").trim().toLowerCase();
    if (value.group && !GROUP_KEY.test(value.group)) fields.group = "2–40 lowercase letters, digits or hyphens — “support”.";
  }
  for (const flag of ["groupDefault", "waivedOnYearly", "alwaysIncluded", "active"]) {
    if (input[flag] !== undefined) value[flag] = Boolean(input[flag]);
  }
  if (input.adds !== undefined) {
    const raw = input.adds;
    value.adds = {};
    if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) fields.adds = "Limit raises are a set of numbers, like { buildings: 1 }.";
    else {
      for (const [k, n] of Object.entries(raw || {})) {
        if (!(k in LIMITS)) fields[`adds.${k}`] = `There is no limit called "${k}".`;
        else if (n === null || n === 0 || n === "") continue;
        else if (!Number.isInteger(n) || n < 1 || n > 1000) fields[`adds.${k}`] = "A whole number per unit, from 1.";
        else value.adds[k] = n;
      }
    }
  }
  if (input.note !== undefined) {
    value.note = clean(input.note, 400);
    if (value.note.length > 200) fields.note = "Keep the note under 200 characters — it is printed beside the price.";
  }
  if (input.rentalMinimumMonths !== undefined) {
    const n = Number(input.rentalMinimumMonths || 0);
    if (!Number.isInteger(n) || n < 0 || n > 60) fields.rentalMinimumMonths = "A whole number of months, 0–60.";
    value.rentalMinimumMonths = n;
  }
  if (input.sort !== undefined) {
    value.sort = Number(input.sort);
    if (!Number.isInteger(value.sort)) fields.sort = "A whole number — lower comes first.";
  }

  const next = { ...(current ? catalogItemShape(current) : BLANK_ITEM), ...value };
  if (!Object.keys(fields).length) {
    const p = next.prices;
    if (next.charge === "one_time" && p.oneTime == null) fields["prices.oneTime"] = "Enter the price of one.";
    if (next.charge === "recurring" && p.monthly == null) fields["prices.monthly"] = "Enter the price per month.";
    if (next.charge === "buy_or_rent") {
      if (p.oneTime == null) fields["prices.oneTime"] = "Enter the price to buy one.";
      if (p.monthly == null) fields["prices.monthly"] = "Enter the rent per month.";
    }
    if (next.maxQuantity != null && next.maxQuantity < next.minQuantity) fields.maxQuantity = "It can't be less than the minimum.";
    if (Object.keys(next.adds || {}).length && next.charge !== "recurring") {
      fields.adds = "Only something paid monthly can raise a limit — the limit lasts as long as it is paid for.";
    }
    if (next.waivedOnYearly && next.charge !== "one_time") fields.waivedOnYearly = "Only a one-time charge can be waived on yearly billing.";
    if (next.rentalMinimumMonths > 0 && next.charge !== "buy_or_rent") fields.rentalMinimumMonths = "Only something that can be rented has a minimum rental.";
    if (next.groupDefault && !next.group) fields.groupDefault = "Only an item in a group can be that group's default.";
    else if (next.groupDefault && next.charge !== "recurring") fields.groupDefault = "A group's default must be something paid monthly.";
    if (next.alwaysIncluded && next.group) fields.alwaysIncluded = "Something on every order can't also be one choice of a group.";
  }
  return { value, fields, next };
}

/** One default per group: a second would leave the quote to pick between them. */
async function checkGroupDefault(next, fields) {
  if (fields.groupDefault || !next.groupDefault || !next.active) return;
  const other = await CatalogItem.findOne({ key: { $ne: next.key }, group: next.group, groupDefault: true, active: { $ne: false } }).lean();
  if (other) fields.groupDefault = `${other.name} is already the default “${next.group}” choice. Turn that off first.`;
}

export async function createCatalogItem(input, by) {
  await ensureCatalog();
  const planKeys = (await ensurePlans()).map((p) => p.key);
  const { value, fields, next } = readCatalogItem(input, { creating: true, planKeys });
  if (!fields.key && (await CatalogItem.exists({ key: value.key }))) fields.key = "Something with that key already exists.";
  await checkGroupDefault(next, fields);
  if (Object.keys(fields).length) refuse(fields);

  const item = await CatalogItem.create(next);
  const shaped = catalogItemShape(item);
  await audit(actor(by), "catalog.create", catalogTarget(item), `Added ${item.name} to the catalogue`, shaped);
  return shaped;
}

/**
 * Edit an item. Its price, minimums and rules reach NEW quotes only: an
 * order froze its quote when it was submitted, and a subscription keeps
 * the price — and the limit raise — agreed for each add-on it carries.
 */
export async function updateCatalogItem(key, input, by) {
  const item = await CatalogItem.findOne({ key });
  if (!item) throw new BillingError("There is nothing in the catalogue with that key.", { status: 404 });
  const planKeys = (await ensurePlans()).map((p) => p.key);
  const { value, fields, next } = readCatalogItem(input, { creating: false, current: item, planKeys });
  await checkGroupDefault(next, fields);
  if (Object.keys(fields).length) refuse(fields);

  const before = catalogItemShape(item);
  for (const [field, v] of Object.entries(value)) {
    item.set(field, v);
    if (field === "adds") item.markModified("adds");
  }
  await item.save();
  const after = catalogItemShape(item);
  const changed = Object.keys(value).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
  if (changed.length) {
    const pick = (o) => Object.fromEntries(changed.map((f) => [f, o[f]]));
    await audit(actor(by), "catalog.update", catalogTarget(item), `Updated ${item.name} in the catalogue (${changed.join(", ")})`, {
      changed,
      before: pick(before),
      after: pick(after),
    });
  }
  return after;
}

/**
 * The quote for an order's choices, priced HERE from the plans, the
 * catalogue and the VAT settings as they stand — the only way an order is
 * priced. lib/quote.js does the maths, and the configurator runs the same
 * module to show its live quote, but nothing a browser computes or sends
 * is trusted: the order route passes only keys, quantities and buy/rent.
 * Retired items are passed in so that choosing one says it is no longer
 * offered rather than that it never existed.
 */
export async function quoteOrder({ plan, billingPeriod, selections = [] }) {
  const [plans, items, settings] = await Promise.all([
    catalogue({ includeRetired: true }),
    catalogItems({ includeRetired: true }),
    getSettings(),
  ]);
  return buildQuote({
    plan: planShape(plan),
    plans,
    billingPeriod,
    selections,
    catalogue: items,
    vat: { registered: Boolean(settings.business?.vatRegistered), rate: settings.business?.vatRate ?? 0.12 },
  });
}

/* ───────────────────────────── settings ───────────────────────────── */

/** SILLA's business settings — one document, created with its defaults on first read. */
export function getSettings() {
  return Settings.findOneAndUpdate(
    { key: "singleton" },
    { $setOnInsert: { key: "singleton" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export function settingsShape(s) {
  return {
    business: {
      name: s.business?.name || "",
      address: s.business?.address || [],
      email: s.business?.email || "",
      phone: s.business?.phone || "",
      taxId: s.business?.taxId || "",
      vatRegistered: Boolean(s.business?.vatRegistered),
      vatRate: s.business?.vatRate ?? 0.12,
    },
    payment: {
      instructions: s.payment?.instructions || "",
      methods: (s.payment?.methods || []).map((m) => ({ label: m.label, details: m.details || "" })),
    },
    invoice: { prefix: s.invoice?.prefix || "SILLA", dueDays: s.invoice?.dueDays ?? 7, footer: s.invoice?.footer || "" },
    billing: {
      trialDays: s.billing?.trialDays ?? 14,
      graceDays: s.billing?.graceDays ?? 7,
      renewalNoticeDays: s.billing?.renewalNoticeDays ?? 7,
    },
    updatedAt: s.updatedAt || null,
  };
}

/** What a buyer needs to pay: the methods, the instructions, and who to ask. */
export async function paymentInstructions() {
  const s = settingsShape(await getSettings());
  return {
    business: { name: s.business.name, email: s.business.email, phone: s.business.phone },
    instructions: s.payment.instructions,
    methods: s.payment.methods,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function readWholeDays(raw, fields, key, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fields[key] = `A whole number of days, ${min}–${max}.`;
  return n;
}

const lines = (raw) =>
  (Array.isArray(raw) ? raw : String(raw || "").split("\n")).map((s) => String(s).trim()).filter(Boolean);

/**
 * Update any of the four groups; a group left out is left alone, so the
 * console can save one section without resending the others.
 */
export async function updateSettings(input = {}, by = null) {
  const settings = await getSettings();
  const fields = {};
  const next = {};

  if (input.business) {
    const b = input.business;
    const address = lines(b.address);
    next.business = {
      name: clean(b.name, 200),
      address,
      email: clean(b.email, 200).toLowerCase(),
      phone: clean(b.phone, 60),
      taxId: clean(b.taxId, 60),
      vatRegistered: Boolean(b.vatRegistered),
      vatRate: Number(b.vatRate ?? settings.business.vatRate),
    };
    const n = next.business;
    if (!n.name) fields["business.name"] = "Enter the name invoices are issued under.";
    else if (n.name.length > 120) fields["business.name"] = "Keep it under 120 characters.";
    if (address.length > 6 || address.some((l) => l.length > 120)) fields["business.address"] = "Up to 6 lines of 120 characters.";
    if (n.email && !EMAIL_RE.test(n.email)) fields["business.email"] = "Enter a valid email address.";
    if (n.phone && !/^[+\d][\d\s()-]{6,24}$/.test(n.phone)) fields["business.phone"] = "Enter a valid phone number.";
    if (!Number.isFinite(n.vatRate) || n.vatRate <= 0 || n.vatRate > 0.5) fields["business.vatRate"] = "A rate between 0 and 50%.";
    if (n.vatRegistered && !n.taxId) fields["business.taxId"] = "A VAT-registered invoice must carry your TIN.";
  }

  if (input.payment) {
    const methods = Array.isArray(input.payment.methods) ? input.payment.methods : [];
    next.payment = {
      instructions: clean(input.payment.instructions, 4000),
      methods: methods.map((m) => ({ label: clean(m?.label, 200), details: clean(m?.details, 800) })),
    };
    if (next.payment.instructions.length > 2000) fields["payment.instructions"] = "Keep the instructions under 2,000 characters.";
    if (methods.length > 10) fields["payment.methods"] = "Up to 10 payment methods.";
    next.payment.methods.forEach((m, i) => {
      if (!m.label) fields[`payment.methods.${i}.label`] = "Name the method — “BDO bank transfer”, “GCash”.";
      else if (m.label.length > 60) fields[`payment.methods.${i}.label`] = "Keep the name under 60 characters.";
      if (m.details.length > 400) fields[`payment.methods.${i}.details`] = "Keep the details under 400 characters.";
    });
  }

  if (input.invoice) {
    next.invoice = {
      prefix: clean(input.invoice.prefix, 40).toUpperCase(),
      dueDays: readWholeDays(input.invoice.dueDays, fields, "invoice.dueDays", 0, 90),
      footer: clean(input.invoice.footer, 1000),
    };
    if (!/^[A-Z0-9]{2,12}$/.test(next.invoice.prefix)) fields["invoice.prefix"] = "2–12 letters or digits, like SILLA.";
    // The test suites' throwaway accounts are invoiced under TEST (see
    // nextInvoiceNumber); a real invoice must never look like one of theirs.
    else if (next.invoice.prefix === "TEST") fields["invoice.prefix"] = "TEST is kept for test invoices. Pick another.";
    if (next.invoice.footer.length > 500) fields["invoice.footer"] = "Keep the footer under 500 characters.";
  }

  if (input.billing) {
    next.billing = {
      trialDays: readWholeDays(input.billing.trialDays, fields, "billing.trialDays", 0, 90),
      graceDays: readWholeDays(input.billing.graceDays, fields, "billing.graceDays", 0, 60),
      renewalNoticeDays: readWholeDays(input.billing.renewalNoticeDays, fields, "billing.renewalNoticeDays", 1, 60),
    };
  }

  if (Object.keys(fields).length) refuse(fields);
  const groups = Object.keys(next);
  if (!groups.length) throw new BillingError("Nothing to save.");

  const before = settingsShape(settings);
  for (const group of groups) settings.set(group, next[group]);
  await settings.save();
  const after = settingsShape(settings);

  await audit(actor(by), "settings.update", { type: "settings", id: "singleton", label: "Billing settings" },
    `Updated the ${groups.join(", ")} settings`, {
      groups,
      before: Object.fromEntries(groups.map((g) => [g, before[g]])),
      after: Object.fromEntries(groups.map((g) => [g, after[g]])),
    });
  return after;
}

/* ───────────────────────────── invoices ───────────────────────────── */

/** The stand-in number an invoice holds for the moment between being reserved and numbered. */
const RESERVED_PREFIX = "RESERVED-";
export const RESERVED_NUMBER = /^RESERVED-/;
/** For any query that lists or acts on invoices people see: only numbered ones. */
export const NUMBERED = { number: { $not: RESERVED_NUMBER } };

/**
 * The next invoice number: <prefix>-<year>-<00001>, from one atomic
 * counter per year, so two invoices issued at once can never share one.
 *
 * The counter is per YEAR, not per prefix: renaming the prefix mid-year
 * continues the sequence rather than restarting it, so flipping it back
 * can never reissue a number.
 *
 * The test suites' throwaway accounts (the addresses the mail transport
 * refuses) draw from their own TEST sequence. Running a suite against a
 * real database must not punch holes in SILLA's real numbering — gaps in
 * a tax invoice series are something an auditor asks about.
 */
export async function nextInvoiceNumber({ prefix = "SILLA", at = new Date(), test = false } = {}) {
  const year = new Date(at).getFullYear();
  const name = test ? `invoice-test-${year}` : `invoice-${year}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const seq = await nextSequence(name);
      return `${test ? "TEST" : prefix}-${year}-${String(seq).padStart(5, "0")}`;
    } catch (err) {
      // Two first-ever upserts of a year's counter can collide on _id;
      // the loser simply increments the one that now exists.
      if (err?.code !== 11000 || attempt >= 3) throw err;
    }
  }
}

/** Who an invoice is addressed to, from the account's billing details — frozen onto the invoice. */
export function billToFor(account, organizationName = "") {
  const b = account?.billing || {};
  const locality = [[b.city, b.region].filter(Boolean).join(", "), b.postalCode].filter(Boolean).join(" ");
  const street = [b.address1, b.address2, locality].filter(Boolean);
  return {
    name: b.name || account?.name || "",
    company: b.company || organizationName || account?.organizationName || "",
    email: b.email || account?.email || "",
    // A country on its own is not an address; it is printed under a real one.
    address: street.length ? [...street, b.country].filter(Boolean) : [],
    taxId: b.taxId || "",
  };
}

const issuerFrom = (s) => ({
  name: s.business?.name || "SILLA",
  address: s.business?.address || [],
  email: s.business?.email || "",
  phone: s.business?.phone || "",
  taxId: s.business?.taxId || "",
  vatRegistered: Boolean(s.business?.vatRegistered),
});

/**
 * Issues one invoice: numbered, taxed per Settings, addressed from the
 * account's billing details, emailed. The single way an invoice comes
 * into existence — first, renewal and manual all pass through here.
 */
async function issueInvoice({
  account,
  subscription = null,
  kind,
  lines: items,
  currency = "PHP",
  extendsSubscription = false,
  billingPeriod = null,
  periodStart = null,
  periodEnd = null,
  memo = "",
  dueDays = null,
  dueAt = null,
  replaces = null,
  organizationName = "",
  settings = null,
}) {
  settings = settings || (await getSettings());
  const issuedAt = new Date();
  const dueByTerms = addDays(issuedAt, dueDays ?? settings.invoice?.dueDays ?? 7);
  const priced = items.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitAmount: l.unitAmount,
    amount: l.quantity * l.unitAmount,
    kind: l.kind || "",
    key: l.key || "",
    note: l.note || "",
  }));
  const subtotal = priced.reduce((sum, l) => sum + l.amount, 0);
  // VAT on top of the price, as Philippine B2B prices are usually quoted;
  // the storefront says "excluding VAT" whenever this applies. Rounded the
  // way lib/quote.js rounds it, so an invoice says what its quote said.
  const vat = Boolean(settings.business?.vatRegistered);
  const rate = vat ? Number(settings.business.vatRate) || 0 : 0;
  const tax = vat ? { label: vatLabel(rate), rate, amount: vatOn(subtotal, rate) } : { label: "", rate: 0, amount: 0 };

  const base = {
    account: account._id,
    subscription: subscription?._id || null,
    order: subscription?.order || null,
    organizationName: organizationName || subscription?.organizationName || account.organizationName || "",
    issuer: issuerFrom(settings),
    billTo: billToFor(account, organizationName || subscription?.organizationName),
    lines: priced,
    subtotal,
    tax,
    total: subtotal + tax.amount,
    currency,
    periodStart,
    periodEnd,
    kind,
    extendsSubscription,
    billingPeriod: extendsSubscription ? billingPeriod : null,
    memo,
    replaces,
    status: "open",
    issuedAt,
    // Never earlier than the payment terms allow; a caller may only push it later.
    dueAt: dueAt && new Date(dueAt) > dueByTerms ? new Date(dueAt) : dueByTerms,
  };

  // Reserve, then number. The invoice is inserted under a stand-in number
  // first, so for a first or renewal invoice the unique indexes refuse a
  // duplicate — a double submit, the job in a second process — BEFORE a
  // number is drawn. Drawing first meant the loser of such a race burned
  // a number for an invoice that never existed: a gap in a tax invoice
  // series, which is what an auditor asks about.
  const _id = new mongoose.Types.ObjectId();
  let reserved;
  try {
    reserved = await Invoice.create({ ...base, _id, number: `${RESERVED_PREFIX}${_id}` });
  } catch (err) {
    if (err?.code === 11000 && (kind === "first" || kind === "renewal")) {
      const filter = kind === "first" ? { subscription: subscription._id, kind } : { subscription: subscription._id, kind, periodStart };
      const existing = await Invoice.findOne(filter);
      if (existing) return { invoice: existing, created: false };
    }
    throw err;
  }

  const invoice = await numberInvoice(reserved, { settings, test: isUndeliverable(account.email) });
  sendEmail(mail.invoiceIssuedEmail({ invoice, account, settings }));
  await Invoice.updateOne({ _id: invoice._id }, { $set: { "reminders.issuedEmailAt": new Date() } });
  return { invoice, created: true };
}

/**
 * Gives a reserved invoice its real number — the only step that draws one,
 * so only an invoice that already exists ever consumes a number.
 */
async function numberInvoice(reserved, { settings, test }) {
  for (let attempt = 1; ; attempt += 1) {
    const number = await nextInvoiceNumber({ prefix: settings.invoice?.prefix || "SILLA", at: reserved.issuedAt, test });
    try {
      const numbered = await Invoice.findOneAndUpdate(
        { _id: reserved._id, number: reserved.number },
        { $set: { number } },
        { new: true }
      );
      return numbered || (await Invoice.findById(reserved._id));
    } catch (err) {
      // A number already in use means the counter was reset (a restore, a
      // hand edit). Take the next one rather than fail the invoice.
      if (err?.code === 11000 && err.keyPattern?.number && attempt < 5) continue;
      throw err;
    }
  }
}

/**
 * Numbers and sends any invoice still holding its stand-in — a process
 * that stopped between reserving an invoice and numbering it. Run by the
 * billing job; the age threshold keeps it clear of an issue in progress.
 */
export async function numberReservedInvoices({ olderThanMs = 5 * 60_000, now = new Date() } = {}) {
  const stuck = await Invoice.find({ number: RESERVED_NUMBER, createdAt: { $lte: new Date(now.getTime() - olderThanMs) } }).limit(50);
  if (!stuck.length) return 0;
  const settings = await getSettings();
  for (const reserved of stuck) {
    const account = await Account.findById(reserved.account);
    const invoice = await numberInvoice(reserved, { settings, test: isUndeliverable(account?.email) });
    if (account && invoice && !RESERVED_NUMBER.test(invoice.number) && !invoice.reminders?.issuedEmailAt) {
      sendEmail(mail.invoiceIssuedEmail({ invoice, account, settings }));
      await Invoice.updateOne({ _id: invoice._id }, { $set: { "reminders.issuedEmailAt": new Date() } });
    }
  }
  return stuck.length;
}

/* ── what a period is billed with ── */

/**
 * The lines one billing period is invoiced with: the plan at its agreed
 * price, then every add-on the subscription carries — extra buildings,
 * rentals, support — at the prices agreed for them, per unit for the
 * period. The first invoice and every renewal are built from this, so a
 * renewal bills exactly what the first did, less what was paid once.
 * `occasion` only changes the words (lib/quote.js describeLine).
 */
function periodLines(sub, { occasion }) {
  const billingPeriod = sub.billingPeriod;
  const months = monthsIn(billingPeriod);
  return [
    {
      description: describeLine({ kind: "plan", name: sub.planName }, { billingPeriod, occasion }),
      quantity: 1,
      unitAmount: sub.price.amount,
      kind: "plan",
      key: "plan",
    },
    ...(sub.addOns || []).map((a) => ({
      description: describeLine(
        { kind: a.kind, name: a.name, minimumMonths: a.minimumMonths, included: a.unitAmount === 0 },
        { billingPeriod, occasion }
      ),
      quantity: a.quantity,
      unitAmount: a.unitAmount * months,
      kind: a.kind,
      key: a.key,
    })),
  ];
}

/** "Extra building × 2, SILLA Kiosk rental × 2, Care support" — for history notes and the activity log. */
const describeAddOns = (addOns) =>
  addOns?.length
    ? addOns.map((a) => `${a.name}${a.kind === "rental" ? " rental" : ""}${a.quantity > 1 ? ` × ${a.quantity}` : ""}`).join(", ")
    : "no add-ons";

/** An order's one-time items — hardware bought, services — as invoice lines, from its frozen quote. */
const oneTimeLinesOf = (quote) =>
  (quote?.lines || [])
    .filter((l) => l.kind === "one_time")
    .map((l) => ({
      description: l.description,
      quantity: l.quantity,
      // A waived line is billed at nothing and says so in its words.
      unitAmount: l.waived ? 0 : l.unitAmount,
      kind: "one_time",
      key: l.key,
      note: l.note || "",
    }));

/** The add-ons a subscription starts with: every recurring line and rental of the order's frozen quote. */
const addOnsFromQuote = (quote, since = new Date()) =>
  (quote?.lines || [])
    .filter((l) => l.kind === "recurring" || l.kind === "rental")
    .map((l) => ({
      key: l.key,
      name: l.name,
      category: l.category || "",
      kind: l.kind,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      adds: l.unitAdds || {},
      minimumMonths: l.minimumMonths || 0,
      since,
    }));

/**
 * The invoice that pays for a subscription's first period. Its period is
 * left open: the service starts when the deployment goes live, after the
 * trial, which nobody knows yet — applyPaidInvoices() writes it when the
 * payment buys its period.
 *
 * It carries the plan, every add-on, and the order's one-time items —
 * billed ONCE: they are left off if an invoice still standing (open or
 * paid) already carries them, so a voided first invoice puts them back on
 * its replacement and nothing else ever bills them twice.
 *
 * If a first invoice already exists (even a voided one) the next one is
 * a manual extending invoice instead: there is one "first" per
 * subscription, and a voided one keeps its place in the record.
 */
async function issuePeriodInvoice(sub, { account = null, settings = null, firstOnly = false, quote = undefined } = {}) {
  if (sub.price?.amount == null) return { invoice: null, created: false };
  account = account || (await Account.findById(sub.account));
  if (!account) return { invoice: null, created: false };
  // On submission it is the first invoice or nothing: a second submit racing
  // the first must be refused by the unique index, not see the first one
  // and issue itself as a "manual" invoice beside it — which it did.
  const hasFirst = !firstOnly && (await Invoice.exists({ subscription: sub._id, kind: "first" }));
  const frozen = quote !== undefined ? quote : (await Order.findById(sub.order).select("quote").lean())?.quote;
  const oneTimeBilled =
    !firstOnly && (await Invoice.exists({ subscription: sub._id, status: { $in: ["open", "paid"] }, "lines.kind": "one_time" }));
  return issueInvoice({
    account,
    subscription: sub,
    kind: hasFirst ? "manual" : "first",
    lines: [...periodLines(sub, { occasion: "first" }), ...(oneTimeBilled ? [] : oneTimeLinesOf(frozen))],
    currency: sub.price.currency || "PHP",
    extendsSubscription: true,
    billingPeriod: sub.billingPeriod,
    organizationName: sub.organizationName,
    settings,
  });
}

/**
 * The renewal for the period after this one. Safe to call repeatedly; at
 * most one exists per period.
 *
 * Due when the period it pays for BEGINS, or by the usual terms if those
 * run later. Due a fixed number of days after issue, a renewal sent a
 * month ahead (renewalNoticeDays 30, dueDays 7) would be chased as overdue
 * three weeks before the customer's paid time even ran out.
 */
export async function issueRenewalInvoice(sub, { settings = null } = {}) {
  if (!sub.currentPeriodEnd || sub.price?.amount == null || sub.needsPricing || sub.cancelAtPeriodEnd) {
    return { invoice: null, created: false };
  }
  const periodStart = new Date(sub.currentPeriodEnd);
  const existing = await Invoice.findOne({ subscription: sub._id, kind: "renewal", periodStart });
  if (existing) return { invoice: existing, created: false };

  const account = await Account.findById(sub.account);
  if (!account) return { invoice: null, created: false };
  const result = await issueInvoice({
    account,
    subscription: sub,
    kind: "renewal",
    // The plan and every add-on, never the one-time items: those were paid once.
    lines: periodLines(sub, { occasion: "renewal" }),
    currency: sub.price.currency || "PHP",
    extendsSubscription: true,
    billingPeriod: sub.billingPeriod,
    periodStart,
    periodEnd: addPeriod(periodStart, sub.billingPeriod),
    dueAt: periodStart,
    organizationName: sub.organizationName,
    settings,
  });
  if (result.created) {
    const inv = result.invoice;
    await audit(null, "invoice.issue", invoiceTarget(inv), `Issued renewal invoice ${inv.number} to ${inv.organizationName}`, {
      kind: "renewal",
      total: inv.total,
      currency: inv.currency,
      periodStart: inv.periodStart,
    });
  }
  return result;
}

const openExtendingInvoices = (subscriptionId) =>
  Invoice.find({ subscription: subscriptionId, status: "open", extendsSubscription: true, ...NUMBERED }).sort({ issuedAt: 1 });

/** The void reason a scheduled cancellation writes — and the one a withdrawal looks for. */
const SCHEDULED_END_VOID = "Subscription ends at the end of its period";

/** Voids what a subscription that has ended can no longer owe: the periods it will never have. */
async function voidOpenPeriodInvoices(sub, reason, by) {
  const voided = [];
  for (const inv of await openExtendingInvoices(sub._id)) {
    const done = await Invoice.findOneAndUpdate(
      { _id: inv._id, status: "open" },
      { $set: { status: "void", voidedAt: new Date(), voidReason: reason } },
      { new: true }
    );
    if (!done) continue;
    voided.push(done);
    await audit(actor(by), "invoice.void", invoiceTarget(done), `Voided ${done.number}: ${reason}`, { reason, automatic: true });
  }
  return voided;
}

/**
 * Withdrawing a scheduled cancellation makes the periods it voided owed
 * again. Each is re-issued as a NEW invoice — a voided number is never
 * reused — pointing at the one it replaces. Without this the customer who
 * just decided to stay would never be billed for the period they kept: a
 * voided renewal still occupies its period, so the billing job will not
 * issue that renewal a second time.
 */
async function reissueVoidedPeriods(sub, by) {
  const voided = await Invoice.find({
    subscription: sub._id,
    status: "void",
    extendsSubscription: true,
    voidReason: SCHEDULED_END_VOID,
  }).sort({ issuedAt: 1 });
  if (!voided.length) return [];
  const replaced = new Set(
    (await Invoice.find({ replaces: { $in: voided.map((v) => v._id) } }).distinct("replaces")).map(String)
  );
  const pending = voided.filter((old) => !replaced.has(String(old._id)));
  if (!pending.length) return [];
  const [account, settings] = await Promise.all([Account.findById(sub.account), getSettings()]);
  if (!account) return [];

  const issued = [];
  for (const old of pending) {
    const { invoice } = await issueInvoice({
      account,
      subscription: sub,
      kind: "manual",
      lines: old.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitAmount: l.unitAmount,
        kind: l.kind || "",
        key: l.key || "",
        note: l.note || "",
      })),
      currency: old.currency,
      extendsSubscription: true,
      billingPeriod: old.billingPeriod || sub.billingPeriod,
      periodStart: old.periodStart,
      periodEnd: old.periodEnd,
      dueAt: old.periodStart,
      replaces: old._id,
      memo: `Re-issued in place of ${old.number}, which was voided when this subscription was set to end.`,
      organizationName: sub.organizationName,
      settings,
    });
    await audit(actor(by), "invoice.issue", invoiceTarget(invoice), `Re-issued ${old.number} as ${invoice.number} for ${invoice.organizationName}`, {
      kind: "manual",
      replaces: old.number,
      total: invoice.total,
      currency: invoice.currency,
    });
    issued.push(invoice);
  }
  return issued;
}

/** Staff issue an invoice by hand: a setup fee, an agreed custom price, a correction. */
export async function issueManualInvoice(input = {}, by = null) {
  const fields = {};
  let sub = null;
  let account = null;
  if (input.subscriptionId) {
    sub = await Subscription.findById(input.subscriptionId).catch(() => null);
    if (!sub) fields.subscriptionId = "No such subscription.";
    else account = await Account.findById(sub.account);
  } else if (input.accountId) {
    account = await Account.findOne({ _id: input.accountId, role: "buyer" }).catch(() => null);
    if (!account) fields.accountId = "No such customer.";
  } else {
    fields.subscriptionId = "Choose who this invoice is for.";
  }

  const raw = Array.isArray(input.lines) ? input.lines : [];
  if (!raw.length) fields.lines = "Add at least one line.";
  if (raw.length > 20) fields.lines = "Up to 20 lines.";
  const items = raw.slice(0, 20).map((l, i) => {
    const description = clean(l?.description, 400);
    const quantity = Number(l?.quantity ?? 1);
    const unitAmount = Number(l?.unitAmount);
    if (!description) fields[`lines.${i}.description`] = "Say what this line is for.";
    else if (description.length > 200) fields[`lines.${i}.description`] = "Keep it under 200 characters.";
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) fields[`lines.${i}.quantity`] = "A whole number from 1.";
    // Negative lines are allowed — that is what a discount is — but the
    // invoice as a whole may not ask for less than nothing.
    if (!Number.isInteger(unitAmount) || Math.abs(unitAmount) > MAX_AMOUNT) fields[`lines.${i}.unitAmount`] = "Enter an amount.";
    return { description, quantity, unitAmount };
  });
  if (!Object.keys(fields).length && items.reduce((s, l) => s + l.quantity * l.unitAmount, 0) < 0) {
    fields.lines = "The lines add up to less than nothing.";
  }

  let dueDays = null;
  if (input.dueDays !== undefined && input.dueDays !== null && input.dueDays !== "") {
    dueDays = readWholeDays(input.dueDays, fields, "dueDays", 0, 90);
  }
  const extendsSubscription = Boolean(input.extendsSubscription);
  if (extendsSubscription && !sub) fields.extendsSubscription = "Only an invoice for a subscription can pay for a period.";
  if (sub?.status === "cancelled") fields.subscriptionId = "That subscription has ended.";
  const memo = clean(input.memo, 1000);
  if (memo.length > 500) fields.memo = "Keep the note under 500 characters.";
  if (Object.keys(fields).length) refuse(fields);

  const { invoice } = await issueInvoice({
    account,
    subscription: sub,
    kind: "manual",
    lines: items,
    currency: sub?.price?.currency || "PHP",
    extendsSubscription,
    billingPeriod: sub?.billingPeriod || null,
    memo,
    dueDays,
    organizationName: sub?.organizationName || account.organizationName,
  });
  await audit(actor(by), "invoice.issue", invoiceTarget(invoice),
    `Issued ${invoice.number} to ${invoice.organizationName || account.email} for ${money(invoice.total, invoice.currency)}`, {
      kind: "manual",
      total: invoice.total,
      currency: invoice.currency,
      extendsSubscription,
    });
  if (sub && extendsSubscription) {
    sub.history.push({ status: sub.status, by: byId(by), note: `Invoice ${invoice.number} issued for one ${PERIOD_WORD[sub.billingPeriod]}` });
    await sub.save();
  }
  return invoice;
}

/* ───────────────────────────── orders → subscriptions ───────────────────────────── */

/**
 * Called once an order is submitted: creates its subscription and the
 * first invoice. Idempotent — a retried submit finds both already there.
 *
 * The price is the SERVER's: the quote order.routes.js froze onto the
 * order at submission, computed from the catalogue then — the plan's price
 * for the period, every add-on and rental with its quantity and price, and
 * the one-time items the first invoice carries. Nothing the buyer's
 * browser sent is billed from.
 *
 * An order submitted before quotes existed has none; it is billed as it
 * always was, the plan alone at the catalogue's price, and when that
 * differs from what the buyer was shown the history says so.
 */
export async function onOrderSubmitted(order) {
  const plan = await planByKey(order.plan);
  const frozen = order.quote?.plan ? order.quote : null;
  const amount = frozen ? frozen.plan.perPeriod ?? null : periodPrice(plan, order.billingPeriod);
  const currency = frozen?.currency || plan?.currency || "PHP";
  const addOns = frozen ? addOnsFromQuote(frozen) : [];

  const notes = [amount == null ? "Order submitted — priced with you: no invoice until a price is agreed" : "Order submitted"];
  const shown = monthlyFigure(plan, order.billingPeriod);
  if (!frozen && Number.isFinite(order.quotedAmount) && order.currency === currency && shown != null && order.quotedAmount !== shown) {
    notes.push(`quoted ${money(order.quotedAmount, currency)}/month when configured; catalogue price ${money(shown, currency)}/month used`);
  }
  if (addOns.length) notes.push(`with ${describeAddOns(addOns)}`);

  const result = await Subscription.findOneAndUpdate(
    { order: order._id },
    {
      $setOnInsert: {
        account: order.account,
        order: order._id,
        organizationName: order.organizationName,
        plan: order.plan,
        planName: plan?.name || order.plan,
        billingPeriod: order.billingPeriod,
        price: { amount, currency },
        addOns,
        needsPricing: amount == null,
        status: "pending",
        history: [{ status: "pending", by: order.account, note: notes.join("; ") }],
      },
    },
    { upsert: true, new: true, includeResultMetadata: true }
  );
  const sub = result.value;
  const account = await Account.findById(order.account);

  if (!result.lastErrorObject?.updatedExisting) {
    await audit(actor(account), "subscription.create", subjectOf(sub),
      `${sub.organizationName} subscribed to ${sub.planName} (${sub.billingPeriod})`, {
        plan: sub.plan,
        billingPeriod: sub.billingPeriod,
        price: sub.price?.amount ?? null,
        addOns: (sub.addOns || []).map((a) => ({ key: a.key, kind: a.kind, quantity: a.quantity, unitAmount: a.unitAmount })),
      });
  }

  if (sub.status === "pending" && !sub.needsPricing && account) {
    if (!(await Invoice.exists({ subscription: sub._id, kind: "first" }))) {
      const { invoice, created } = await issuePeriodInvoice(sub, { account, firstOnly: true, quote: frozen });
      if (created) {
        await audit(actor(account), "invoice.issue", invoiceTarget(invoice),
          `Issued first invoice ${invoice.number} to ${invoice.organizationName}`, {
            kind: "first",
            total: invoice.total,
            currency: invoice.currency,
          });
      }
    }
  }
  return sub;
}

/**
 * Called when staff cancel an order. Ends its subscription and voids the
 * periods it will never have, so a cancelled order does not go on
 * sending "your invoice is overdue" to someone who walked away.
 */
export async function onOrderCancelled(order, { by = null, reason = "" } = {}) {
  const current = await Subscription.findOne({ order: order._id });
  if (!current || current.status === "cancelled") return current;
  const from = current.status;
  const why = clean(reason, 300);
  const sub = await transition(current, "cancelled", {
    set: { cancelledAt: new Date(), cancelReason: why, cancelAtPeriodEnd: false },
    note: why || "Order cancelled",
    by,
  });
  await voidOpenPeriodInvoices(sub, "Order cancelled", by);
  await statusAudit(sub, from, by, "order cancelled");
  await syncDeployment(sub);
  return sub;
}

export const subscriptionForOrder = (orderId) => Subscription.findOne({ order: orderId });

/* ───────────────────────────── the deployment's view ───────────────────────────── */

/** What a deployment in each subscription state is told. `pending` only exists before provisioning. */
const DEPLOYMENT_STATUS = {
  pending: "trialing",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  suspended: "suspended",
  cancelled: "cancelled",
};

/** What the add-ons a subscription carries raise, in all: two extra buildings → { buildings: 2 }. */
export function addOnRaises(subscription) {
  const raises = {};
  for (const a of subscription?.addOns || []) {
    for (const [key, n] of Object.entries(scaledAdds(a.adds, a.quantity))) {
      if (key in LIMITS) raises[key] = (raises[key] || 0) + n;
    }
  }
  return raises;
}

/**
 * What a plan, this client's overrides and the add-ons they pay for
 * allow: every feature true or false, every limit a number or null
 * (unlimited). In that order — the plan's limit, replaced by an override
 * if staff set one, then raised by what the add-ons add (an extra
 * building is one more building whatever the base is). Unlimited stays
 * unlimited. A key none of them mentions is allowed — the same reading
 * the product applies (docs/control-plane.md §2).
 */
export function entitlementsFor(subscription, plan = {}) {
  const features = {};
  for (const key of Object.keys(FEATURES)) {
    const override = subscription.overrides?.features?.[key];
    features[key] = override !== undefined && override !== null ? Boolean(override) : plan?.features?.[key] !== false;
  }
  const raises = addOnRaises(subscription);
  const limits = {};
  for (const key of Object.keys(LIMITS)) {
    const override = subscription.overrides?.limits?.[key];
    const value = override !== undefined ? override : plan?.limits?.[key];
    limits[key] = typeof value === "number" && value >= 0 ? value + (raises[key] || 0) : null;
  }
  return { features, limits, raises };
}

/**
 * The entitlement snapshot for a subscription: plan defaults, this
 * client's overrides and add-ons, then status. The shape is the contract
 * the product enforces (server/src/services/entitlements.js;
 * docs/control-plane.md).
 */
export async function snapshotFor(subscription) {
  const plan = (await planByKey(subscription.plan)) || {};
  const { features, limits } = entitlementsFor(subscription, plan);
  return {
    managed: true,
    plan: subscription.plan,
    planName: subscription.planName || plan.name || subscription.plan,
    status: DEPLOYMENT_STATUS[subscription.status] || "trialing",
    features,
    limits,
    currentPeriodEnd: subscription.currentPeriodEnd || subscription.trialEndsAt || null,
    graceEndsAt: subscription.graceEndsAt || null,
    notice: subscription.notice || null,
    version: Date.now(),
  };
}

/** For provisioning: the snapshot an order's deployment should be born with. */
export async function snapshotForOrder(order) {
  const sub = (await subscriptionForOrder(order._id)) || (await onOrderSubmitted(order));
  return snapshotFor(sub);
}

/**
 * Pushes the subscription's snapshot to its deployment and records the
 * outcome on `sync`. Never throws — not on a refused push, and not on a
 * database hiccup while recording one: a failed push is recorded and
 * retried by the billing job, and the caller's own change still stands.
 *
 * The snapshot is built from the subscription AS STORED, re-read here,
 * never from the caller's copy: what a deployment enforces must be what
 * the database says, not an in-memory object that may predate someone
 * else's change. The outcome is written with its own update rather than
 * a save() of the caller's document, which used to persist whatever else
 * that document held and could throw a VersionError past the "never
 * throws" promise. Versions only go up, so a deployment can drop a push
 * that arrives after a newer one.
 */
export async function syncDeployment(subscription) {
  try {
    const id = subscription?._id;
    if (!id) return { skipped: true };
    const fresh = await Subscription.findById(id);
    if (!fresh?.organizationId) return { skipped: true };

    let sync;
    try {
      const snapshot = await snapshotFor(fresh);
      snapshot.version = Math.max(snapshot.version, (fresh.sync?.version || 0) + 1);
      await callDeployment("PUT", `/api/internal/organizations/${fresh.organizationId}/entitlements`, snapshot);
      sync = { version: snapshot.version, syncedAt: new Date(), error: null };
    } catch (err) {
      sync = {
        version: fresh.sync?.version || 0,
        syncedAt: fresh.sync?.syncedAt || null,
        error: clean(err?.message || "The push failed.", 500),
      };
    }
    // timestamps off: recording a push is not a change to the subscription.
    await Subscription.updateOne({ _id: id }, { $set: { sync } }, { timestamps: false });
    try {
      subscription.sync = sync; // so a caller returning its document shows the outcome
    } catch {
      /* a frozen or foreign object; the database has it */
    }
    return { error: sync.error, version: sync.version };
  } catch (err) {
    console.error("[vendor:billing] syncDeployment could not record its outcome:", err);
    return { error: err?.message || "The sync could not be recorded." };
  }
}

/** Staff pressing "Retry sync": the same push, with an audit line saying how it went. */
export async function syncNow(sub, by) {
  const result = await syncDeployment(sub);
  if (!result.skipped) {
    await audit(actor(by), "subscription.sync", subjectOf(sub),
      result.error ? `Sync to ${sub.organizationName} failed: ${result.error}` : `Pushed entitlements to ${sub.organizationName}`,
      { error: result.error || null, version: sub.sync?.version || null });
  }
  return result;
}

/* ───────────────────────────── periods ───────────────────────────── */

/**
 * Where a newly paid period begins. Service is CONTINUOUS: a paid period
 * follows straight on from what came before, whether that was a paid
 * period or the trial — so paying during a trial never costs trial days,
 * and paying late for a period already being used (the grace period)
 * pays for that period, not the next one.
 *
 * The exception is a suspended subscription: its service was switched
 * off, so the paid time starts when it is switched back on — unless it is
 * still paid through a date ahead (staff suspended a paid-up customer),
 * in which case the new period follows that, and no paid day is lost.
 */
function nextPeriodStart(sub, now) {
  const paidThrough = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  if (sub.status === "suspended") return paidThrough && paidThrough > now ? paidThrough : now;
  if (paidThrough) return paidThrough;
  if (sub.trialEndsAt) return new Date(sub.trialEndsAt);
  return now;
}

/**
 * Turns paid, period-buying invoices into service time — the ONE place a
 * payment becomes a paid period. Called after a payment is recorded and
 * after a deployment is provisioned; safe to call any number of times,
 * from any number of processes.
 *
 * Each invoice is applied in a single conditional update that extends the
 * period, records the invoice in `appliedInvoices` and writes the history
 * entry together, and only lands if the subscription is still exactly as
 * read. So two payments recorded at the same moment both count (the
 * second re-reads and extends from the first's end), and a replay counts
 * once. It used to be load, change and save(): two concurrent payments
 * each extended from the same end date and one period was simply lost.
 *
 * A pending subscription is left alone on purpose — its deployment is not
 * live, and the paid period starts at go-live (onProvisioned calls this
 * again then). A cancelled one has nothing left to buy.
 */
async function applyPaidInvoices(subscriptionId, { by = null, now = new Date() } = {}) {
  const applied = [];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const sub = await Subscription.findById(subscriptionId);
    if (!sub || sub.status === "pending" || sub.status === "cancelled") break;
    const invoice = await Invoice.findOne({
      subscription: sub._id,
      status: "paid",
      extendsSubscription: true,
      _id: { $nin: sub.appliedInvoices || [] },
    }).sort({ paidAt: 1, issuedAt: 1 });
    if (!invoice) break;

    const from = sub.status;
    const start = nextPeriodStart(sub, now);
    const end = addPeriod(start, invoice.billingPeriod || sub.billingPeriod);
    const note = `${invoice.number} paid${from === "suspended" ? " — reactivated" : ""}; paid through ${date(end)}`;
    const updated = await Subscription.findOneAndUpdate(
      {
        _id: sub._id,
        status: from,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        trialEndsAt: sub.trialEndsAt ?? null,
        appliedInvoices: { $ne: invoice._id },
      },
      {
        $set: { status: "active", currentPeriodStart: start, currentPeriodEnd: end, graceEndsAt: null },
        $addToSet: { appliedInvoices: invoice._id },
        $push: { history: { at: new Date(), status: "active", by: byId(by), note } },
      },
      { new: true }
    );
    if (!updated) continue; // something moved it in between — read it again

    // Stamp the period an open-ended invoice bought. A renewal's stated
    // period is part of what was sent, so it is never rewritten.
    if (!invoice.periodStart) {
      await Invoice.updateOne({ _id: invoice._id, periodStart: null }, { $set: { periodStart: start, periodEnd: end } });
    }
    if (from !== "active") await statusAudit(updated, from, by, `${invoice.number} paid`);
    applied.push({ invoice, from, start, end, subscription: updated });
  }
  return applied;
}

/**
 * Called after the staff-operations work provisions an order's
 * deployment. Starts the trial — and when the first invoice was paid
 * before go-live, that payment buys its period now, starting where the
 * trial ends, so the subscription goes live as active: paying early never
 * costs trial days.
 */
export async function onProvisioned(order, organizationId, { by = null } = {}) {
  const existing = (await subscriptionForOrder(order._id)) || (await onOrderSubmitted(order));
  // Linking the deployment is not a status change, and must land whatever the status is.
  let sub = await Subscription.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        organizationId: String(organizationId),
        ...(existing.organizationName ? {} : { organizationName: order.organizationName }),
      },
    },
    { new: true }
  );
  const from = sub.status;

  if (sub.status === "pending") {
    const settings = await getSettings();
    const now = new Date();
    // Staff may have set a trial end ahead of go-live; keep it if it is still ahead.
    const trialEndsAt =
      sub.trialEndsAt && sub.trialEndsAt > now ? sub.trialEndsAt : addDays(now, settings.billing?.trialDays ?? 14);
    try {
      sub = await transition(sub, "trialing", {
        set: { trialEndsAt },
        note: `Deployment provisioned — free trial until ${date(trialEndsAt)}`,
        by,
      });
      await statusAudit(sub, from, by, "deployment provisioned");
    } catch (err) {
      if (err?.code !== "SUBSCRIPTION_CHANGED") throw err;
      sub = await Subscription.findById(sub._id); // moved by someone else; go with what is stored
    }
  }

  const applied = await applyPaidInvoices(sub._id, { by });
  if (applied.length) sub = applied.at(-1).subscription;
  await syncDeployment(sub);
  return sub;
}

/* ───────────────────────────── payments ───────────────────────────── */

function readPayment(input, invoice) {
  const fields = {};
  const method = String(input.method || "");
  if (!PAYMENT_METHODS.includes(method)) fields.method = "Choose how the money arrived.";
  const amount = Number(input.amount);
  // Nothing received is not a payment — unless the invoice itself is for nothing.
  if (input.amount === "" || input.amount == null || !Number.isInteger(amount) || amount < 0 || (amount === 0 && invoice.total > 0)) {
    fields.amount = "Enter the amount received.";
  } else if (amount > MAX_AMOUNT) {
    fields.amount = "That's more than any invoice — check the amount (it's in centavos).";
  }
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) fields.receivedAt = "Enter the date the money arrived.";
  else if (receivedAt.getTime() > Date.now() + DAY) fields.receivedAt = "That date hasn't happened yet.";
  const reference = clean(input.reference, 120);
  const note = clean(input.note, 500);
  // No partial-payment ledger: one payment settles one invoice. Accepting
  // a different amount (a bank fee taken off a transfer, say) is allowed,
  // but the record has to say why.
  if (!fields.amount && amount !== invoice.total && !note) {
    fields.note = `The invoice is for ${money(invoice.total, invoice.currency)}. Say why a different amount settles it.`;
  }
  if (Object.keys(fields).length) refuse(fields);
  return { method, reference, amount, receivedAt, note };
}

/**
 * Records money actually received against an invoice — THE way an
 * invoice becomes paid. Staff call it from the console; a future payment
 * processor's webhook calls it with `by` null. Exactly once: the update
 * only applies to an invoice that is still open, so a double click or a
 * replayed webhook is refused rather than counted twice.
 *
 * An invoice that buys a period then activates the subscription and
 * starts or extends its period (applyPaidInvoices), and the deployment is
 * told. The receipt is emailed either way.
 */
export async function recordPayment(invoiceOrId, input = {}, by = null) {
  const current = await Invoice.findById(invoiceOrId?._id || invoiceOrId);
  if (!current) throw new BillingError("There is no such invoice.", { status: 404 });
  if (current.status !== "open") {
    throw new BillingError(current.status === "paid" ? `${current.number} is already paid.` : `${current.number} is void and can't be paid.`, {
      status: 409,
      code: "INVOICE_NOT_OPEN",
    });
  }
  const payment = readPayment(input, current);
  const now = new Date();

  const invoice = await Invoice.findOneAndUpdate(
    { _id: current._id, status: "open" },
    { $set: { status: "paid", paidAt: payment.receivedAt, payment: { ...payment, recordedBy: byId(by) } } },
    { new: true }
  );
  if (!invoice) throw new BillingError(`${current.number} was settled a moment ago.`, { status: 409, code: "INVOICE_NOT_OPEN" });

  let sub = invoice.subscription ? await Subscription.findById(invoice.subscription) : null;
  const from = sub?.status || null;
  let applied = [];
  if (sub && invoice.extendsSubscription) {
    applied = await applyPaidInvoices(sub._id, { by, now });
    if (applied.length) {
      sub = applied.at(-1).subscription;
    } else if (sub.status === "pending") {
      // Not live yet: onProvisioned() applies this payment at go-live.
      sub =
        (await Subscription.findOneAndUpdate(
          { _id: sub._id, status: "pending" },
          {
            $push: {
              history: {
                at: new Date(),
                status: "pending",
                by: byId(by),
                note: `${invoice.number} paid — the paid period starts when the deployment goes live`,
              },
            },
          },
          { new: true }
        )) || (await Subscription.findById(sub._id));
    }
  }

  await audit(actor(by), "invoice.payment", invoiceTarget(invoice),
    `Recorded ${money(payment.amount, invoice.currency)} for ${invoice.number} (${mail.METHOD_LABEL[payment.method]})` +
      (sub && from && from !== sub.status ? ` — ${sub.organizationName} is now ${STATUS_WORD[sub.status]}` : ""),
    {
      amount: payment.amount,
      total: invoice.total,
      method: payment.method,
      reference: payment.reference,
      receivedAt: payment.receivedAt,
      confirmsClaim: Boolean(invoice.claimedPayment?.submittedAt && !invoice.claimedPayment?.dismissedAt),
      subscriptionStatus: sub ? { from, to: sub.status } : null,
    });
  if (applied.length) await syncDeployment(sub);

  // The period stamp may have landed after the invoice was read.
  let receiptInvoice = (await Invoice.findById(invoice._id)) || invoice;
  const account = await Account.findById(invoice.account);
  if (account) {
    sendEmail(
      mail.paymentReceiptEmail({
        invoice: receiptInvoice,
        account,
        subscription: sub,
        reactivated: from === "suspended" && sub?.status === "active",
      })
    );
    receiptInvoice =
      (await Invoice.findOneAndUpdate({ _id: invoice._id }, { $set: { "reminders.receiptEmailAt": new Date() } }, { new: true })) ||
      receiptInvoice;
  }
  return { invoice: receiptInvoice, subscription: sub };
}

/** What a buyer may say they paid with. No "card": there is no card payment to claim. */
export const CLAIM_METHODS = ["bank_transfer", "gcash", "maya", "cash", "other"];

/**
 * A 15- or 16-digit number starting 3–6 that passes the Luhn check is a
 * card number. Narrower than the profile's card guard on purpose: GCash
 * references are 13 digits, and one in ten of them would pass a bare
 * Luhn check — refusing those would refuse real payments.
 */
function looksLikeCard(value) {
  for (const run of String(value).match(/(?:\d[ -]?){15,16}/g) || []) {
    const digits = run.replace(/\D/g, "");
    if (!/^[3-6]\d{14,15}$/.test(digits)) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/**
 * The buyer's "I've paid". A CLAIM — it never activates anything, never
 * marks the invoice paid, and the copy everywhere says "we'll confirm
 * it". It exists so staff know which money to look for, and it is
 * emailed to SILLA so nobody has to refresh a page to find out.
 */
export async function claimPayment(invoice, input = {}, account) {
  if (invoice.status !== "open") {
    throw new BillingError(invoice.status === "paid" ? "This invoice is already paid — thank you." : "This invoice was cancelled and isn't payable.", {
      status: 409,
      code: "INVOICE_NOT_OPEN",
    });
  }
  const fields = {};
  const method = String(input.method || "");
  if (!CLAIM_METHODS.includes(method)) fields.method = "Choose how you paid.";
  const reference = clean(input.reference, 200);
  if (reference.length > 120) fields.reference = "That reference is too long.";
  else if (!reference && method && method !== "cash" && method !== "other") {
    fields.reference = "Enter the reference number from your receipt, so we can find the payment.";
  }
  const amount = Number(input.amount);
  if (input.amount === "" || input.amount == null || !Number.isInteger(amount) || amount <= 0) fields.amount = "Enter the amount you paid.";
  const paidAt = input.paidAt ? new Date(input.paidAt) : null;
  if (!paidAt || Number.isNaN(paidAt.getTime())) fields.paidAt = "Enter the date you paid.";
  else if (paidAt.getTime() > Date.now() + DAY) fields.paidAt = "That date hasn't happened yet.";
  else if (paidAt.getTime() < Date.now() - 366 * DAY) fields.paidAt = "That's more than a year ago — check the date.";
  const note = clean(input.note, 1000);
  if (note.length > 500) fields.note = "Keep the note under 500 characters.";
  if (looksLikeCard(reference)) fields.reference = "That looks like a card number. We never need it — enter the transfer reference instead.";
  if (looksLikeCard(note)) fields.note = "That looks like a card number. Please don't send it to us.";
  if (Object.keys(fields).length) refuse(fields);

  invoice.claimedPayment = { method, reference, amount, paidAt, note, submittedAt: new Date(), dismissedAt: null, dismissNote: "" };
  await invoice.save();

  await audit(actor(account), "invoice.claim", invoiceTarget(invoice),
    `${account.email} says they paid ${money(amount, invoice.currency)} for ${invoice.number} (${mail.METHOD_LABEL[method]})`,
    { method, reference, amount, paidAt });

  // Not for test buyers: the transport's guard only checks the RECIPIENT,
  // and this one goes to SILLA's real inbox.
  if (process.env.SILLA_ORDERS_EMAIL && !isUndeliverable(account.email)) {
    sendEmail(mail.paymentClaimEmail({ to: process.env.SILLA_ORDERS_EMAIL, invoice, account }));
  }
  return invoice;
}

/** Staff could not find the money a buyer claimed. The buyer is told, and can claim again. */
export async function dismissClaim(invoice, input = {}, by = null) {
  const claim = invoice.claimedPayment || {};
  if (!claim.submittedAt || claim.dismissedAt) throw new BillingError("There is no claim waiting on this invoice.", { status: 409 });
  if (invoice.status !== "open") throw new BillingError("This invoice is no longer open.", { status: 409 });
  const reason = clean(input.reason, 600);
  if (!reason) refuse({ reason: "Tell the customer what you found — they will read this." });
  if (reason.length > 300) refuse({ reason: "Keep it under 300 characters." });

  invoice.claimedPayment.dismissedAt = new Date();
  invoice.claimedPayment.dismissNote = reason;
  await invoice.save();
  await audit(actor(by), "invoice.claim.dismiss", invoiceTarget(invoice), `Couldn't match the claimed payment for ${invoice.number}: ${reason}`, { reason });

  const account = await Account.findById(invoice.account);
  if (account) sendEmail(mail.paymentClaimDismissedEmail({ invoice, account }));
  return invoice;
}

/** Cancels an open invoice. A paid one can't be — that would be a refund, and refunds happen outside SILLA for now. */
export async function voidInvoice(invoiceOrId, input = {}, by = null) {
  const current = await Invoice.findById(invoiceOrId?._id || invoiceOrId);
  if (!current) throw new BillingError("There is no such invoice.", { status: 404 });
  const reason = clean(input.reason, 600);
  if (!reason) refuse({ reason: "Say why — it's printed on the voided invoice." });
  if (reason.length > 300) refuse({ reason: "Keep it under 300 characters." });

  const invoice = await Invoice.findOneAndUpdate(
    { _id: current._id, status: "open" },
    { $set: { status: "void", voidedAt: new Date(), voidReason: reason } },
    { new: true }
  );
  if (!invoice) {
    throw new BillingError(
      current.status === "paid" ? `${current.number} is paid. Refunds are handled outside SILLA for now.` : `${current.number} is already void.`,
      { status: 409, code: "INVOICE_NOT_OPEN" }
    );
  }
  await audit(actor(by), "invoice.void", invoiceTarget(invoice), `Voided ${invoice.number}: ${reason}`, { reason, total: invoice.total });
  if (invoice.subscription && invoice.extendsSubscription) {
    const sub = await Subscription.findById(invoice.subscription);
    if (sub) {
      sub.history.push({ status: sub.status, by: byId(by), note: `Invoice ${invoice.number} voided: ${reason}` });
      await sub.save();
    }
  }
  return invoice;
}

/* ───────────────────────────── staff changes ───────────────────────────── */

/**
 * Overrides for ONE client, layered over their plan: "dynamic per client"
 * without a plan per client. Replaces the whole set — a key left out goes
 * back to the plan's value.
 */
function readOverrides(raw, fields) {
  if (raw === null) return { features: {}, limits: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fields.overrides = "Overrides must list features and limits.";
    return null;
  }
  return {
    features: readFeatures(raw.features, fields, "overrides.features"),
    limits: readLimits(raw.limits, fields, "overrides.limits"),
  };
}

const describeOverrides = (o) => {
  const parts = [
    ...Object.entries(o.features || {}).map(([k, v]) => `${k} ${v ? "on" : "off"}`),
    ...Object.entries(o.limits || {}).map(([k, v]) => `${k} ${v === null ? "unlimited" : v}`),
  ];
  return parts.length ? parts.join(", ") : "none — the plan's own";
};

const CATEGORY_ORDER = { building: 1, hardware: 2, service: 3, support: 4 };
const addOnSignature = (list) => JSON.stringify((list || []).map((a) => [a.key, a.kind, a.quantity, a.unitAmount]));
const plainAddOns = (list) =>
  (list || []).map((a) => ({
    key: a.key,
    name: a.name,
    category: a.category || "",
    kind: a.kind,
    quantity: a.quantity,
    unitAmount: a.unitAmount,
    adds: { ...(a.adds || {}) },
    minimumMonths: a.minimumMonths || 0,
    since: a.since || null,
  }));

/**
 * A subscription's add-ons as staff set them — [{ key, quantity, mode }],
 * the WHOLE list: anything left out is removed. Only what is billed every
 * period can be on a subscription — extra buildings, rentals ("rent"),
 * support; something paid once goes on a manual invoice instead.
 *
 * The catalogue's rules apply to what is NEW: an add-on added, a quantity
 * changed. What the customer already has, and keeps as it is, stays as
 * agreed — an item retired since, or a minimum raised since, never blocks
 * an unrelated change. A plan's own availability is checked again whenever
 * the plan changes: Starter takes no extra buildings, however long they
 * were held. An agreed price stays agreed; an add-on added, or every
 * add-on when the billing period changes, takes the catalogue's price —
 * the rule the plan's own price follows.
 *
 * Problems are written into `fields`; the caller refuses if there are any.
 */
function readAddOns(raw, sub, { plan, planChanged, periodChanged, period, items, fields, sentByStaff }) {
  const fieldFor = (key) => (sentByStaff ? `addOns.${key}` : planChanged ? "plan" : "billingPeriod");
  const { selections, problems } = readSelections(raw);
  for (const [field, message] of Object.entries(problems)) fields[field.replace(/^selections/, "addOns")] = message;
  const current = sub.addOns || [];
  const currency = sub.price?.currency || "PHP";
  const now = new Date();
  const next = [];
  const groups = new Map();

  for (const choice of selections) {
    const item = items.get(choice.key);
    const field = fieldFor(choice.key);
    if (!item) {
      fields[field] = `There's no “${choice.key}” in the catalogue.`;
      continue;
    }
    let kind = null;
    if (item.charge === "recurring" && choice.mode !== "rent") kind = "recurring";
    else if (item.charge === "buy_or_rent" && choice.mode === "rent") kind = "rental";
    if (!kind) {
      fields[field] =
        item.charge === "recurring"
          ? `${item.name} can't be rented.`
          : item.charge === "buy_or_rent"
            ? `${item.name} is an add-on only when rented — a bought one goes on a manual invoice.`
            : `${item.name} — paid once, so it goes on a manual invoice instead.`;
      continue;
    }
    const existing = current.find((a) => a.key === item.key && a.kind === kind);
    if (!existing && item.active === false) {
      fields[field] = `${item.name} isn't offered any more.`;
      continue;
    }
    if ((!existing || planChanged) && item.plans?.length && !item.plans.includes(plan.key)) {
      fields[field] = `${item.name} isn't available on the ${plan.name} plan${sentByStaff ? "" : " — take it off the add-ons first"}.`;
      continue;
    }
    if (!existing && (item.currency || "PHP") !== currency) {
      fields[field] = `${item.name} is priced in ${item.currency}; this subscription is billed in ${currency}.`;
      continue;
    }
    if (!existing || existing.quantity !== choice.quantity) {
      const min = item.minQuantity || 1;
      if (choice.quantity < min) {
        fields[field] = `${item.name}: the minimum is ${min.toLocaleString("en-PH")} ${min === 1 ? item.unit.one : item.unit.many}.`;
        continue;
      }
      if (Number.isInteger(item.maxQuantity) && choice.quantity > item.maxQuantity) {
        fields[field] = item.maxQuantity === 1 ? `${item.name}: one at a time.` : `${item.name}: up to ${item.maxQuantity.toLocaleString("en-PH")}.`;
        continue;
      }
    }
    if (item.group) {
      const already = groups.get(item.group);
      if (already && already.key !== item.key) {
        fields[field] = `One ${item.group} option at a time — ${already.name} or ${item.name}, not both.`;
        continue;
      }
      groups.set(item.group, item);
    }
    const unitAmount = existing && !periodChanged ? existing.unitAmount : itemMonthlyOf(item, period);
    if (unitAmount == null) {
      fields[field] = `${item.name} has no price yet.`;
      continue;
    }
    next.push({
      key: item.key,
      name: existing?.name || item.name,
      category: item.category,
      kind,
      quantity: choice.quantity,
      unitAmount,
      adds: existing ? { ...(existing.adds || {}) } : kind === "recurring" ? scaledAdds(item.adds, 1) : {},
      minimumMonths: existing ? existing.minimumMonths || 0 : kind === "rental" ? item.rentalMinimumMonths || 0 : 0,
      since: existing?.since || now,
    });
  }

  // A group left empty gets its default when staff set the list, as an
  // order does: no support chosen is Standard support.
  if (sentByStaff) {
    for (const item of items.values()) {
      if (!item.group || !item.groupDefault || item.active === false || item.charge !== "recurring" || groups.has(item.group)) continue;
      if (item.plans?.length && !item.plans.includes(plan.key)) continue;
      const existing = current.find((a) => a.key === item.key && a.kind === "recurring");
      const unitAmount = existing && !periodChanged ? existing.unitAmount : itemMonthlyOf(item, period);
      if (unitAmount == null) continue;
      groups.set(item.group, item);
      next.push({
        key: item.key,
        name: existing?.name || item.name,
        category: item.category,
        kind: "recurring",
        quantity: 1,
        unitAmount,
        adds: existing ? { ...(existing.adds || {}) } : scaledAdds(item.adds, 1),
        minimumMonths: 0,
        since: existing?.since || now,
      });
    }
  }

  // The order the quote gives them, which is the order an invoice reads
  // in: buildings, then rentals, then support.
  const placeOf = (a) => [CATEGORY_ORDER[a.category] ?? 9, items.get(a.key)?.sort ?? 0, a.key, a.kind === "rental" ? 1 : 0];
  return next.sort((x, y) => {
    const [a, b] = [placeOf(x), placeOf(y)];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  });
}

/**
 * Staff changes to a subscription, all through one path: everything is
 * validated before anything is applied, one save, an audit line per
 * aspect changed, one push to the deployment.
 *
 *   plan           immediate entitlements; the new price from the NEXT invoice
 *   billingPeriod  monthly | yearly; the price follows the plan, from the next invoice
 *   price          the agreed price per period (minor units), or null to agree one
 *   overrides      { features: { key: bool }, limits: { key: n | null } }
 *   notice         a line shown to the organization's administrators
 *   trialEndsAt    a new trial end (only while nothing has been paid)
 *   addOns         [{ key, quantity, mode }] — the whole list of extra buildings,
 *                  rentals and support (readAddOns); entitlements now, prices
 *                  from the next invoice
 *
 * Open invoices are never rewritten by any of these: an invoice says what
 * was billed when it was sent.
 */
export async function updateSubscription(sub, patch = {}, by = null) {
  if (sub.status === "cancelled") throw new BillingError("This subscription has ended and can't be changed.", { status: 409 });
  const fields = {};
  const now = new Date();

  let plan = null;
  if (patch.plan !== undefined && patch.plan !== sub.plan) {
    plan = await planByKey(String(patch.plan));
    if (!plan) fields.plan = "There is no such plan.";
    else if (plan.active === false) fields.plan = "That plan is retired. Reactivate it in Plans first.";
  }
  let period = null;
  if (patch.billingPeriod !== undefined && patch.billingPeriod !== sub.billingPeriod) {
    if (!["monthly", "yearly"].includes(patch.billingPeriod)) fields.billingPeriod = "Monthly or yearly.";
    else period = patch.billingPeriod;
  }
  let price;
  if (patch.price !== undefined) {
    const raw = patch.price && typeof patch.price === "object" ? patch.price.amount : patch.price;
    price = readAmount(raw, fields, "price", "Enter the agreed price per period, in centavos.");
  }
  let overrides;
  if (patch.overrides !== undefined) overrides = readOverrides(patch.overrides, fields);
  let notice;
  if (patch.notice !== undefined) {
    notice = patch.notice === null ? null : clean(patch.notice, 600) || null;
    if (notice && notice.length > 280) fields.notice = "Keep the notice under 280 characters — it's one line in their product.";
  }
  let trialEndsAt;
  if (patch.trialEndsAt !== undefined) {
    const d = new Date(patch.trialEndsAt);
    if (!patch.trialEndsAt || Number.isNaN(d.getTime())) fields.trialEndsAt = "Pick the day the trial ends.";
    else if (d <= now) fields.trialEndsAt = "Pick a day in the future.";
    else if (sub.currentPeriodEnd) fields.trialEndsAt = `Already paid through ${date(sub.currentPeriodEnd)} — there's no trial to change.`;
    else trialEndsAt = d;
  }
  // The add-ons: the list staff sent, or — when only the plan or the
  // period moves — the current list, checked against the new plan and
  // re-priced for the new period.
  let addOns;
  if ((patch.addOns !== undefined || plan || period) && !fields.plan && !fields.billingPeriod) {
    const sentByStaff = patch.addOns !== undefined;
    if (sentByStaff && !Array.isArray(patch.addOns)) fields.addOns = "Add-ons are a list of what this customer pays for.";
    else {
      const items = new Map((await catalogItems({ includeRetired: true })).map((i) => [i.key, i]));
      const raw = sentByStaff
        ? patch.addOns
        : (sub.addOns || []).map((a) => ({ key: a.key, quantity: a.quantity, mode: a.kind === "rental" ? "rent" : null }));
      addOns = readAddOns(raw, sub, {
        plan: plan || (await planByKey(sub.plan)) || { key: sub.plan, name: sub.planName },
        planChanged: Boolean(plan),
        periodChanged: Boolean(period),
        period: period || sub.billingPeriod,
        items,
        fields,
        sentByStaff,
      });
    }
  }
  if (Object.keys(fields).length) refuse(fields);

  const from = sub.status;
  const entries = [];
  const wasUnpriced = sub.needsPricing;
  let movedFrom = null;
  const per = () => PERIOD_WORD[sub.billingPeriod];

  if (plan) {
    movedFrom = sub.planName;
    const oldKey = sub.plan;
    sub.plan = plan.key;
    sub.planName = plan.name;
    if (period) sub.billingPeriod = period;
    const amount = periodPrice(plan, sub.billingPeriod);
    sub.price = { amount, currency: plan.currency || sub.price?.currency || "PHP" };
    sub.needsPricing = amount == null;
    const priceNote = amount == null ? "a price to be agreed" : `${money(amount, sub.price.currency)} per ${per()} from the next invoice`;
    sub.history.push({ status: sub.status, by: byId(by), note: `Plan changed from ${movedFrom} to ${plan.name}; ${priceNote}` });
    entries.push(["subscription.plan", `Moved ${sub.organizationName} from ${movedFrom} to ${plan.name}`, { from: oldKey, to: plan.key, price: amount }]);
  }
  if (period && !plan) {
    const oldPeriod = sub.billingPeriod;
    sub.billingPeriod = period;
    const amount = periodPrice(await planByKey(sub.plan), period);
    sub.price.amount = amount;
    sub.needsPricing = amount == null;
    sub.history.push({
      status: sub.status,
      by: byId(by),
      note: `Billing changed to ${period}; ${amount == null ? "a price to be agreed" : `${money(amount, sub.price.currency)} per ${per()} from the next invoice`}`,
    });
    entries.push(["subscription.period", `Billing for ${sub.organizationName} changed from ${oldPeriod} to ${period}`, { from: oldPeriod, to: period, price: amount }]);
  }
  if (price !== undefined) {
    const before = sub.price?.amount ?? null;
    sub.price.amount = price;
    sub.needsPricing = price == null;
    sub.history.push({
      status: sub.status,
      by: byId(by),
      note: price == null ? "Price cleared — to be agreed" : `Price agreed: ${money(price, sub.price.currency)} per ${per()}`,
    });
    entries.push(["subscription.price",
      price == null ? `Cleared the price for ${sub.organizationName}` : `Set ${sub.organizationName}'s price to ${money(price, sub.price.currency)} per ${per()}`,
      { from: before, to: price }]);
  }
  if (overrides) {
    const before = { features: sub.overrides?.features || {}, limits: sub.overrides?.limits || {} };
    sub.overrides = overrides;
    sub.markModified("overrides");
    sub.history.push({ status: sub.status, by: byId(by), note: `Overrides: ${describeOverrides(overrides)}` });
    entries.push(["subscription.overrides", `Overrides for ${sub.organizationName}: ${describeOverrides(overrides)}`, { before, after: overrides }]);
  }
  if (notice !== undefined && notice !== (sub.notice || null)) {
    sub.notice = notice;
    entries.push(["subscription.notice", notice ? `Notice for ${sub.organizationName}: "${notice}"` : `Cleared the notice for ${sub.organizationName}`, { notice }]);
  }
  if (trialEndsAt) {
    const before = sub.trialEndsAt;
    sub.trialEndsAt = trialEndsAt;
    sub.set("reminders.trialEndingAt", null);
    // A trial that ran out unpaid comes back as a trial: the grace period
    // and the suspension were consequences of its end, which has moved.
    if (["past_due", "suspended"].includes(sub.status) && sub.organizationId) {
      sub.status = "trialing";
      sub.graceEndsAt = null;
    }
    sub.history.push({ status: sub.status, by: byId(by), note: `Trial ends ${date(trialEndsAt)}` });
    entries.push(["subscription.trial", `Trial for ${sub.organizationName} now ends ${date(trialEndsAt)}`, { from: before, to: trialEndsAt }]);
  }

  let addOnsChange = null;
  if (addOns && addOnSignature(addOns) !== addOnSignature(sub.addOns)) {
    const before = plainAddOns(sub.addOns);
    sub.addOns = addOns;
    sub.markModified("addOns");
    const priced = period && patch.addOns === undefined ? `re-priced for ${period} billing` : "from the next invoice";
    sub.history.push({ status: sub.status, by: byId(by), note: `Add-ons: ${describeAddOns(addOns)} — ${priced}` });
    entries.push([
      "subscription.addons",
      `Add-ons for ${sub.organizationName}: ${describeAddOns(before)} → ${describeAddOns(addOns)}`,
      { before, after: plainAddOns(addOns) },
    ]);
    addOnsChange = { before, after: plainAddOns(addOns) };
  }

  if (!entries.length) return { subscription: sub, invoice: null };
  await sub.save();
  if (sub.status !== from) await statusAudit(sub, from, by, "trial extended");
  for (const [action, summary, meta] of entries) await audit(actor(by), action, subjectOf(sub), summary, meta);

  // A price agreed for a customer who has never been invoiced issues
  // their first invoice now — that is what agreeing the price was for.
  let invoice = null;
  if (wasUnpriced && sub.price.amount != null && sub.status !== "cancelled") {
    const billed = await Invoice.exists({ subscription: sub._id, extendsSubscription: true, status: { $in: ["open", "paid"] } });
    if (!billed) {
      ({ invoice } = await issuePeriodInvoice(sub));
      if (invoice) {
        await audit(actor(by), "invoice.issue", invoiceTarget(invoice), `Issued ${invoice.number} to ${invoice.organizationName} at the agreed price`, {
          kind: invoice.kind,
          total: invoice.total,
          currency: invoice.currency,
        });
      }
    }
  }

  await syncDeployment(sub);
  // Told only of what they would notice: a move of plan says the new
  // price itself, so add-ons re-priced with it are not a second email.
  if (addOnsChange && !movedFrom && patch.addOns !== undefined) {
    const account = await Account.findById(sub.account);
    if (account) sendEmail(mail.addOnsChangedEmail({ subscription: sub, account, before: addOnsChange.before, after: addOnsChange.after }));
  }
  if (movedFrom || (from === "suspended" && sub.status !== "suspended")) {
    const account = await Account.findById(sub.account);
    if (account && movedFrom) sendEmail(mail.planChangedEmail({ subscription: sub, account, fromName: movedFrom }));
    // A new trial end lifted a suspension: they are told it works again.
    if (account && from === "suspended" && sub.status !== "suspended") {
      sendEmail(mail.subscriptionReactivatedEmail({ subscription: sub, account }));
    }
  }
  return { subscription: sub, invoice };
}

/** Staff suspend a subscription: read-only, nothing deleted. The customer is told, with the reason. */
export async function suspend(current, { reason = "" } = {}, by = null) {
  if (!["trialing", "active", "past_due"].includes(current.status)) {
    throw new BillingError(`A ${STATUS_WORD[current.status]} subscription can't be suspended.`, { status: 409 });
  }
  const why = clean(reason, 600);
  if (!why) refuse({ reason: "Say why — the customer is told." });
  if (why.length > 300) refuse({ reason: "Keep it under 300 characters." });

  const from = current.status;
  const sub = await transition(current, "suspended", { note: `Suspended by SILLA: ${why}`, by });
  await statusAudit(sub, from, by, `suspended by staff: ${why}`);
  await syncDeployment(sub);

  const [account, [invoice], settings] = await Promise.all([
    Account.findById(sub.account),
    openExtendingInvoices(sub._id),
    getSettings(),
  ]);
  if (account) sendEmail(mail.subscriptionSuspendedEmail({ subscription: sub, account, invoice: invoice || null, reason: why, settings }));
  return sub;
}

/**
 * Lifts a suspension — or withdraws a scheduled cancellation. Back to
 * whatever the dates say it is: paid through the future → active; an
 * unpaid trial still running → trialing; otherwise past due with a fresh
 * grace period, so the job does not re-suspend it on its next tick.
 */
export async function resume(current, by = null) {
  const now = new Date();
  const from = current.status;

  if (current.status === "suspended") {
    const settings = await getSettings();
    let to;
    let set;
    if (current.currentPeriodEnd && current.currentPeriodEnd > now) {
      to = "active";
      set = { graceEndsAt: null };
    } else if (!current.currentPeriodEnd && current.trialEndsAt && current.trialEndsAt > now) {
      to = "trialing";
      set = { graceEndsAt: null };
    } else {
      to = "past_due";
      set = { graceEndsAt: addDays(now, settings.billing?.graceDays ?? 7) };
    }
    const sub = await transition(current, to, {
      set,
      note: to === "past_due" ? `Resumed by SILLA — payment due by ${date(set.graceEndsAt)}` : "Resumed by SILLA",
      by,
    });
    await statusAudit(sub, from, by, "resumed by staff");
    await syncDeployment(sub);
    const account = await Account.findById(sub.account);
    if (account) sendEmail(mail.subscriptionReactivatedEmail({ subscription: sub, account }));
    return sub;
  }

  if (current.cancelAtPeriodEnd && current.status !== "cancelled") {
    const sub = await Subscription.findOneAndUpdate(
      { _id: current._id, cancelAtPeriodEnd: true, status: { $ne: "cancelled" } },
      {
        $set: { cancelAtPeriodEnd: false, cancelReason: "" },
        $push: { history: { at: new Date(), status: current.status, by: byId(by), note: "Scheduled cancellation withdrawn" } },
      },
      { new: true }
    );
    if (!sub) throw new BillingError("This subscription changed a moment ago. Reload it and try again.", { status: 409, code: "SUBSCRIPTION_CHANGED" });
    const reissued = await reissueVoidedPeriods(sub, by);
    await audit(actor(by), "subscription.cancel.withdraw", subjectOf(sub), `Withdrew ${sub.organizationName}'s scheduled cancellation` +
      (reissued.length ? ` and re-issued ${reissued.map((i) => i.number).join(", ")}` : ""), { reissued: reissued.map((i) => i.number) });
    return sub;
  }

  if (current.status === "cancelled") {
    throw new BillingError("A cancelled subscription has ended. A new order starts a new one.", { status: 409 });
  }
  throw new BillingError("There's nothing to resume — it isn't suspended or scheduled to end.", { status: 409 });
}

/**
 * Ends a subscription, now or when its paid period (or trial) runs out.
 * Either way the periods it will never have stop being owed: their open
 * invoices are voided, so the customer is not chased for them.
 */
export async function cancel(current, { when = "now", reason = "" } = {}, by = null) {
  if (current.status === "cancelled") throw new BillingError("This subscription has already ended.", { status: 409 });
  const why = clean(reason, 600);
  if (why.length > 300) refuse({ reason: "Keep it under 300 characters." });

  if (when === "period_end") {
    if (!["active", "trialing"].includes(current.status)) {
      throw new BillingError("Only a running subscription can end at its period's end. Cancel it now instead.", { status: 409 });
    }
    if (current.cancelAtPeriodEnd) throw new BillingError("It's already set to end at the end of its period.", { status: 409 });
    const endsAt = current.status === "active" ? current.currentPeriodEnd : current.trialEndsAt;
    if (!endsAt) throw new BillingError("This subscription has no period end yet. Cancel it now instead.", { status: 409 });
    const sub = await Subscription.findOneAndUpdate(
      { _id: current._id, status: current.status, cancelAtPeriodEnd: { $ne: true } },
      {
        $set: { cancelAtPeriodEnd: true, cancelReason: why },
        $push: { history: { at: new Date(), status: current.status, by: byId(by), note: `Will end on ${date(endsAt)}${why ? `: ${why}` : ""}` } },
      },
      { new: true }
    );
    if (!sub) throw new BillingError("This subscription changed a moment ago. Reload it and try again.", { status: 409, code: "SUBSCRIPTION_CHANGED" });
    await voidOpenPeriodInvoices(sub, SCHEDULED_END_VOID, by);
    await audit(actor(by), "subscription.cancel.schedule", subjectOf(sub), `${sub.organizationName} will end on ${date(endsAt)}`, { endsAt, reason: why });
    return sub;
  }
  if (when !== "now") refuse({ when: "Now, or at the end of the period." });

  const from = current.status;
  const sub = await transition(current, "cancelled", {
    set: { cancelledAt: new Date(), cancelReason: why, cancelAtPeriodEnd: false },
    note: why ? `Cancelled by SILLA: ${why}` : "Cancelled by SILLA",
    by,
  });
  await voidOpenPeriodInvoices(sub, "Subscription cancelled", by);
  await statusAudit(sub, from, by, why ? `cancelled by staff: ${why}` : "cancelled by staff");
  await syncDeployment(sub);
  const account = await Account.findById(sub.account);
  if (account) sendEmail(mail.subscriptionCancelledEmail({ subscription: sub, account, reason: why }));
  return sub;
}

/* ───────────────────────────── the billing job's transitions ───────────────────────────── */
/*
 * Called by workers/billing.jobs.js, which decides WHO is due. Each one is
 * a conditional update — it applies only if the subscription is still in
 * the state the job saw — so a staff action or a payment landing between
 * the job's read and its write wins, and running the job twice changes
 * nothing the first run already did.
 */

/**
 * A paid period — or a trial — ended with its bill unpaid: past due,
 * still usable through a grace period. Only when there is an open,
 * period-buying invoice that has actually FALLEN DUE: a customer is never
 * treated as late for a bill SILLA has not sent (a price never agreed, a
 * renewal voided by staff — those are flagged for staff instead), nor for
 * one that is not due yet (a trial staff shortened to end before its
 * invoice's due date). Grace runs from whichever came last, the end or
 * the due date.
 */
export async function lapse(sub, { kind, settings, now = new Date() }) {
  const endField = kind === "trial" ? "trialEndsAt" : "currentPeriodEnd";
  const from = kind === "trial" ? "trialing" : "active";
  const end = sub[endField];
  if (!end || new Date(end) > now) return null;

  const due = (await openExtendingInvoices(sub._id)).filter((i) => i.dueAt && new Date(i.dueAt) <= now);
  if (!due.length) return null;
  const firstDue = Math.min(...due.map((i) => new Date(i.dueAt).getTime()));
  const graceEndsAt = addDays(new Date(Math.max(new Date(end).getTime(), firstDue)), settings.billing?.graceDays ?? 7);

  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: from, [endField]: end, cancelAtPeriodEnd: { $ne: true } },
    {
      $set: { status: "past_due", graceEndsAt },
      $push: {
        history: {
          status: "past_due",
          at: now,
          note: `${kind === "trial" ? "Trial" : "Paid period"} ended with ${due[0].number} unpaid — grace until ${date(graceEndsAt)}`,
        },
      },
    },
    { new: true }
  );
  if (!updated) return null;

  // One message carries both the overdue notice and the grace period; the
  // invoice's own overdue reminder must not repeat it.
  await Invoice.updateMany({ _id: { $in: due.map((i) => i._id) }, "reminders.overdueAt": null }, { $set: { "reminders.overdueAt": now } });
  await statusAudit(updated, from, null, `${kind === "trial" ? "trial" : "period"} ended unpaid`);
  await syncDeployment(updated);
  // A grace period already over (the job was down, or the end was long
  // ago) would promise "keeps working until" a date in the past; the
  // suspension that follows in the same cycle sends the message instead.
  const account = graceEndsAt > now ? await Account.findById(updated.account) : null;
  if (account) {
    sendEmail(mail.invoiceOverdueEmail({ invoice: due[0], account, settings, subscription: updated, graceEndsAt }));
  }
  return updated;
}

/** Grace ran out with the invoice still open: suspended. Read-only, nothing deleted. */
export async function suspendAfterGrace(sub, { settings = null, now = new Date() } = {}) {
  const open = await openExtendingInvoices(sub._id);
  if (!open.length) return null;
  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: "past_due", graceEndsAt: { $ne: null, $lte: now } },
    { $set: { status: "suspended" }, $push: { history: { status: "suspended", at: now, note: `Grace period ended with ${open[0].number} unpaid` } } },
    { new: true }
  );
  if (!updated) return null;
  await statusAudit(updated, "past_due", null, "grace period ended unpaid");
  await syncDeployment(updated);
  const account = await Account.findById(updated.account);
  if (account) {
    sendEmail(
      mail.subscriptionSuspendedEmail({ subscription: updated, account, invoice: open[0], settings: settings || (await getSettings()) })
    );
  }
  return updated;
}

/** A cancellation scheduled for the end of the period (or trial), now due. */
export async function endAtPeriodEnd(sub, { now = new Date() } = {}) {
  const from = sub.status;
  const endField = from === "trialing" ? "trialEndsAt" : "currentPeriodEnd";
  const updated = await Subscription.findOneAndUpdate(
    // The end is part of the condition: a trial staff extended a moment ago is not ended on its old date.
    { _id: sub._id, status: from, cancelAtPeriodEnd: true, [endField]: { $ne: null, $lte: now } },
    {
      $set: { status: "cancelled", cancelledAt: now, cancelAtPeriodEnd: false },
      $push: { history: { status: "cancelled", at: now, note: "Ended at the end of the period, as scheduled" } },
    },
    { new: true }
  );
  if (!updated) return null;
  await voidOpenPeriodInvoices(updated, "Subscription ended", null);
  await statusAudit(updated, from, null, "scheduled cancellation");
  await syncDeployment(updated);
  const account = await Account.findById(updated.account);
  if (account) sendEmail(mail.subscriptionCancelledEmail({ subscription: updated, account, reason: updated.cancelReason }));
  return updated;
}

/**
 * "Send once" for reminders: claim the slot atomically, THEN send. Two
 * overlapping runs cannot both win the claim, so nobody gets a reminder
 * twice; a crash between claim and send costs one reminder, never a
 * duplicate — the right way round for something that nags.
 */
async function claimInvoiceReminder(invoice, slot, now) {
  const res = await Invoice.updateOne(
    { _id: invoice._id, status: "open", [`reminders.${slot}`]: null },
    { $set: { [`reminders.${slot}`]: now } }
  );
  return res.modifiedCount === 1;
}

export async function sendDueSoonReminder(invoice, { settings, now = new Date() }) {
  if (!(await claimInvoiceReminder(invoice, "dueSoonAt", now))) return false;
  const account = await Account.findById(invoice.account);
  if (account) sendEmail(mail.invoiceDueSoonEmail({ invoice, account, settings }));
  return true;
}

export async function sendOverdueReminder(invoice, { settings, now = new Date() }) {
  if (!(await claimInvoiceReminder(invoice, "overdueAt", now))) return false;
  const [account, subscription] = await Promise.all([
    Account.findById(invoice.account),
    invoice.subscription ? Subscription.findById(invoice.subscription) : null,
  ]);
  if (account) sendEmail(mail.invoiceOverdueEmail({ invoice, account, settings, subscription }));
  return true;
}

/** A few days before an UNPAID trial ends. Once per trial end — moving the end re-arms it. */
export async function sendTrialEndingReminder(sub, { settings, now = new Date() }) {
  const [invoice] = await openExtendingInvoices(sub._id);
  if (!invoice) return false; // paid (it would be active) or never invoiced: nothing to ask for
  const res = await Subscription.updateOne(
    { _id: sub._id, status: "trialing", "reminders.trialEndingAt": null },
    { $set: { "reminders.trialEndingAt": now } }
  );
  if (res.modifiedCount !== 1) return false;
  const account = await Account.findById(sub.account);
  if (account) sendEmail(mail.trialEndingEmail({ subscription: sub, account, invoice, settings }));
  return true;
}

/**
 * Re-pushes deployments whose last push failed — and any linked
 * deployment never pushed at all (a crash between linking and pushing).
 * Oldest first.
 */
export async function retryFailedSyncs({ limit = 50 } = {}) {
  const subs = await Subscription.find({
    organizationId: { $ne: "" },
    $or: [{ "sync.error": { $ne: null } }, { "sync.syncedAt": null }],
  })
    .sort({ "sync.syncedAt": 1, updatedAt: 1 })
    .limit(limit);
  for (const sub of subs) await syncDeployment(sub);
  return subs.length;
}

/* ───────────────────────────── for the console ───────────────────────────── */

/**
 * A subscription's standing in the words its customer reads — the billing
 * page shows these, so "past_due" never reaches a person. `tone` is for
 * colour, which is never the only signal: the label says it too.
 */
export function plainStatus(sub, { now = new Date() } = {}) {
  const ending = sub.cancelAtPeriodEnd;
  switch (sub.status) {
    case "pending":
      return {
        label: "Being set up",
        tone: "waiting",
        detail: "We're building your system. Your free trial starts the day it goes live.",
      };
    case "trialing": {
      const end = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
      return {
        label: "Free trial",
        tone: "good",
        detail: !end
          ? "Free while we agree your price."
          : end > now
            ? `Free until ${date(end)}.${ending ? " Your subscription ends then." : ""}`
            : `Your free trial ended on ${date(end)}.`,
      };
    }
    case "active":
      return {
        label: "Active",
        tone: "good",
        detail: sub.currentPeriodEnd
          ? `Paid through ${date(sub.currentPeriodEnd)}.${ending ? " Your subscription ends then." : ""}`
          : "Paid up.",
      };
    case "past_due":
      return {
        label: "Payment overdue",
        tone: "warning",
        detail: sub.graceEndsAt
          ? `Everything keeps working until ${date(sub.graceEndsAt)}. If it is still unpaid then, it becomes read-only until it is.`
          : "Everything still works, but a payment is overdue.",
      };
    case "suspended":
      return {
        label: "Read-only",
        tone: "bad",
        detail: "Everyone can still sign in and look, but nothing can be booked or changed until it's resolved. Nothing has been deleted.",
      };
    case "cancelled":
      return {
        label: "Ended",
        tone: "neutral",
        detail: `${sub.cancelledAt ? `Ended on ${date(sub.cancelledAt)}. ` : ""}Your data is kept.`,
      };
    default:
      return { label: sub.status, tone: "neutral", detail: "" };
  }
}

/**
 * What needs a person, said in words — the states the job deliberately
 * will not resolve on its own because the customer is not at fault.
 */
export function attentionFor(sub, { openInvoices = 0, now = new Date() } = {}) {
  if (sub.status === "cancelled") return [];
  const flags = [];
  if (sub.needsPricing) flags.push("Needs a price");
  if (sub.organizationId && sub.sync?.error) flags.push("Sync failing");
  if (sub.status === "trialing" && sub.trialEndsAt && new Date(sub.trialEndsAt) < now && !openInvoices) {
    flags.push("Trial over, nothing invoiced");
  }
  if (sub.status === "active" && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < now && !openInvoices) {
    flags.push("Period over, nothing invoiced");
  }
  if (["past_due", "suspended"].includes(sub.status) && !openInvoices) flags.push("Nothing left to pay");
  return flags;
}
