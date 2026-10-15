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
import Plan from "../models/Plan.js";
import Subscription from "../models/Subscription.js";
import Invoice, { PAYMENT_METHODS } from "../models/Invoice.js";
import Settings from "../models/Settings.js";
import Account from "../models/Account.js";
import Order from "../models/Order.js";
import { nextSequence } from "../models/Counter.js";
import { callDeployment } from "../lib/controlPlane.js";
import { DEFAULT_PLANS } from "../lib/defaultPlans.js";
import { FEATURES, LIMITS } from "../lib/planKeys.js";
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
 * Which plan keys an order can carry today. Read from the Order model's
 * own enum rather than restated, so the day order.routes.js and the
 * model accept a plan staff created in the console, the storefront starts
 * selling it without a change here. Until then the storefront must not
 * offer a plan whose "Save" would answer "Pick a plan."
 */
const orderablePlans = () => new Set(Order.schema.path("plan")?.enumValues || []);

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
  const orderable = orderablePlans();
  return plans
    .filter((p) => includeRetired || p.active !== false)
    .map((p) => ({ ...planShape(p), orderable: orderable.has(p.key) }));
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
  return { ...planShape(plan), orderable: orderablePlans().has(plan.key) };
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
  if (!changed.length) return { plan: { ...after, orderable: orderablePlans().has(key) }, resyncing: 0 };

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
  return { plan: { ...after, orderable: orderablePlans().has(key) }, resyncing };
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
    if (!n.name) fields["business.name"] = "The name invoices are issued under.";
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

const percent = (rate) => `${Math.round(rate * 10000) / 100}%`;

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
  organizationName = "",
  settings = null,
}) {
  settings = settings || (await getSettings());
  const issuedAt = new Date();
  const priced = items.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitAmount: l.unitAmount,
    amount: l.quantity * l.unitAmount,
  }));
  const subtotal = priced.reduce((sum, l) => sum + l.amount, 0);
  // VAT on top of the price, as Philippine B2B prices are usually quoted;
  // the storefront says "excluding VAT" whenever this applies.
  const vat = Boolean(settings.business?.vatRegistered);
  const rate = vat ? Number(settings.business.vatRate) || 0 : 0;
  const tax = vat ? { label: `VAT ${percent(rate)}`, rate, amount: Math.round(subtotal * rate) } : { label: "", rate: 0, amount: 0 };

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
    status: "open",
    issuedAt,
    dueAt: addDays(issuedAt, dueDays ?? settings.invoice?.dueDays ?? 7),
  };

  const test = isUndeliverable(account.email);
  for (let attempt = 1; ; attempt += 1) {
    const number = await nextInvoiceNumber({ prefix: settings.invoice?.prefix || "SILLA", at: issuedAt, test });
    try {
      const invoice = await Invoice.create({ ...base, number });
      sendEmail(mail.invoiceIssuedEmail({ invoice, account, settings }));
      await Invoice.updateOne({ _id: invoice._id }, { $set: { "reminders.issuedEmailAt": new Date() } });
      return { invoice, created: true };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // A number already used means the counter was reset (a restore, a
      // hand edit). Take the next one rather than fail the invoice.
      if (err.keyPattern?.number && attempt < 5) continue;
      if (kind === "first" || kind === "renewal") {
        // Issued a moment ago by someone else — a double submit, or the
        // job in a second process. The unique index refused the copy. The
        // number taken above is lost: the one gap in the series a race
        // can leave, and only a race can.
        const filter = kind === "first" ? { subscription: subscription._id, kind } : { subscription: subscription._id, kind, periodStart };
        const existing = await Invoice.findOne(filter);
        if (existing) return { invoice: existing, created: false };
      }
      throw err;
    }
  }
}

/**
 * The invoice that pays for a subscription's first period. Its period is
 * left open: the service starts when the deployment goes live, after the
 * trial, which nobody knows yet — applyPaidPeriod() writes it on payment.
 *
 * If a first invoice already exists (even a voided one) the next one is
 * a manual extending invoice instead: there is one "first" per
 * subscription, and a voided one keeps its place in the record.
 */
async function issuePeriodInvoice(sub, { account = null, settings = null } = {}) {
  if (sub.price?.amount == null) return { invoice: null, created: false };
  account = account || (await Account.findById(sub.account));
  if (!account) return { invoice: null, created: false };
  const hasFirst = await Invoice.exists({ subscription: sub._id, kind: "first" });
  return issueInvoice({
    account,
    subscription: sub,
    kind: hasFirst ? "manual" : "first",
    lines: [{ description: `${sub.planName} plan — first ${PERIOD_WORD[sub.billingPeriod]}`, quantity: 1, unitAmount: sub.price.amount }],
    currency: sub.price.currency || "PHP",
    extendsSubscription: true,
    billingPeriod: sub.billingPeriod,
    organizationName: sub.organizationName,
    settings,
  });
}

/** The renewal for the period after this one. Safe to call repeatedly; at most one exists per period. */
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
    lines: [{ description: `${sub.planName} plan — renewal, 1 ${PERIOD_WORD[sub.billingPeriod]}`, quantity: 1, unitAmount: sub.price.amount }],
    currency: sub.price.currency || "PHP",
    extendsSubscription: true,
    billingPeriod: sub.billingPeriod,
    periodStart,
    periodEnd: addPeriod(periodStart, sub.billingPeriod),
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
  Invoice.find({ subscription: subscriptionId, status: "open", extendsSubscription: true }).sort({ issuedAt: 1 });

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
 * The price is the CATALOGUE's, read here on the server. The order's
 * quotedAmount is what the buyer's browser sent, and the order route
 * accepts any number in it; billing from it would let anyone set their
 * own price. When the two disagree (staff repriced between a draft and
 * its submission) the history says so, for staff to honour if they wish.
 */
export async function onOrderSubmitted(order) {
  const plan = await planByKey(order.plan);
  const amount = periodPrice(plan, order.billingPeriod);
  const currency = plan?.currency || "PHP";

  const notes = [amount == null ? "Order submitted — priced with you: no invoice until a price is agreed" : "Order submitted"];
  const shown = monthlyFigure(plan, order.billingPeriod);
  if (Number.isFinite(order.quotedAmount) && order.currency === currency && shown != null && order.quotedAmount !== shown) {
    notes.push(`quoted ${money(order.quotedAmount, currency)}/month when configured; catalogue price ${money(shown, currency)}/month used`);
  }

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
        needsPricing: amount == null,
        status: "pending",
        history: [{ status: "pending", note: notes.join("; ") }],
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
      });
  }

  if (sub.status === "pending" && !sub.needsPricing && account) {
    if (!(await Invoice.exists({ subscription: sub._id, kind: "first" }))) {
      const { invoice, created } = await issuePeriodInvoice(sub, { account });
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
  const sub = await Subscription.findOne({ order: order._id });
  if (!sub || sub.status === "cancelled") return sub;
  const from = sub.status;
  sub.status = "cancelled";
  sub.cancelledAt = new Date();
  sub.cancelReason = reason;
  sub.cancelAtPeriodEnd = false;
  sub.history.push({ status: "cancelled", by: byId(by), note: reason || "Order cancelled" });
  await sub.save();
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

/**
 * The entitlement snapshot for a subscription: plan defaults, then this
 * client's overrides, then status. The shape is the contract the product
 * enforces (server/src/services/entitlements.js; docs/control-plane.md).
 */
export async function snapshotFor(subscription) {
  const plan = (await planByKey(subscription.plan)) || {};
  const features = {};
  for (const key of Object.keys(FEATURES)) {
    const override = subscription.overrides?.features?.[key];
    features[key] = override !== undefined ? Boolean(override) : plan.features?.[key] !== false;
  }
  const limits = {};
  for (const key of Object.keys(LIMITS)) {
    const override = subscription.overrides?.limits?.[key];
    const value = override !== undefined ? override : plan.limits?.[key];
    limits[key] = typeof value === "number" && value >= 0 ? value : null;
  }
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
 * outcome on `sync`. Never throws: a failed push is recorded and retried
 * by the billing job, and the caller's own change still stands.
 */
export async function syncDeployment(subscription) {
  if (!subscription?.organizationId) return { skipped: true };
  try {
    const snapshot = await snapshotFor(subscription);
    await callDeployment("PUT", `/api/internal/organizations/${subscription.organizationId}/entitlements`, snapshot);
    subscription.sync = { version: snapshot.version, syncedAt: new Date(), error: null };
  } catch (err) {
    subscription.sync = { ...(subscription.sync?.toObject?.() || subscription.sync || {}), error: err.message };
  }
  await subscription.save();
  return { error: subscription.sync.error };
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
 * pays for that period, not the next one. The exception is a suspended
 * subscription: its service was switched off, so the paid time starts
 * when it is switched back on.
 */
function nextPeriodStart(sub, now) {
  if (sub.status === "suspended") return now;
  if (sub.currentPeriodEnd) return new Date(sub.currentPeriodEnd);
  if (sub.trialEndsAt) return new Date(sub.trialEndsAt);
  return now;
}

/**
 * Buys the subscription one period with a paid invoice: active, paid
 * through the period's end. The invoice is stamped with the period it
 * paid for when it did not name one — a renewal's stated period is part
 * of what was sent, so it is never rewritten.
 */
async function applyPaidPeriod(sub, invoice, now = new Date()) {
  const start = nextPeriodStart(sub, now);
  const end = addPeriod(start, invoice.billingPeriod || sub.billingPeriod);
  sub.currentPeriodStart = start;
  sub.currentPeriodEnd = end;
  sub.graceEndsAt = null;
  sub.status = "active";
  if (!invoice.periodStart) {
    invoice.periodStart = start;
    invoice.periodEnd = end;
    await Invoice.updateOne({ _id: invoice._id }, { $set: { periodStart: start, periodEnd: end } });
  }
  return { start, end };
}

/**
 * Called after the staff-operations work provisions an order's
 * deployment. Starts the trial — or, when the first invoice was paid
 * before go-live, goes straight to active, with the paid period starting
 * where the trial would have ended: paying early never costs trial days.
 */
export async function onProvisioned(order, organizationId, { by = null } = {}) {
  const sub = (await subscriptionForOrder(order._id)) || (await onOrderSubmitted(order));
  sub.organizationId = String(organizationId);
  if (!sub.organizationName) sub.organizationName = order.organizationName;
  const from = sub.status;

  if (sub.status === "pending") {
    const settings = await getSettings();
    const now = new Date();
    // Staff may have set a trial end ahead of go-live; keep it if it is still ahead.
    if (!sub.trialEndsAt || sub.trialEndsAt <= now) sub.trialEndsAt = addDays(now, settings.billing?.trialDays ?? 14);
    const prepaid = await Invoice.find({ subscription: sub._id, status: "paid", extendsSubscription: true, periodStart: null }).sort({ paidAt: 1 });
    if (prepaid.length) {
      for (const invoice of prepaid) await applyPaidPeriod(sub, invoice, now);
      sub.history.push({ status: "active", by: byId(by), note: `Deployment provisioned — already paid, through ${date(sub.currentPeriodEnd)}` });
    } else {
      sub.status = "trialing";
      sub.history.push({ status: "trialing", by: byId(by), note: `Deployment provisioned — free trial until ${date(sub.trialEndsAt)}` });
    }
  }
  await sub.save();
  if (sub.status !== from) await statusAudit(sub, from, by, "deployment provisioned");
  await syncDeployment(sub);
  return sub;
}

/* ───────────────────────────── payments ───────────────────────────── */

function readPayment(input, invoice) {
  const fields = {};
  const method = String(input.method || "");
  if (!PAYMENT_METHODS.includes(method)) fields.method = "Choose how the money arrived.";
  const amount = Number(input.amount);
  if (input.amount === "" || input.amount == null || !Number.isInteger(amount) || amount < 0) {
    fields.amount = "Enter the amount received.";
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
  let from = null;
  if (sub && invoice.extendsSubscription && sub.status !== "cancelled") {
    from = sub.status;
    if (sub.status === "pending") {
      // Not live yet: onProvisioned() starts the paid period at go-live.
      sub.history.push({ status: "pending", by: byId(by), note: `${invoice.number} paid — the paid period starts when the deployment goes live` });
    } else {
      const { end } = await applyPaidPeriod(sub, invoice, now);
      sub.history.push({
        status: "active",
        by: byId(by),
        note: `${invoice.number} paid${from === "suspended" ? " — reactivated" : ""}; paid through ${date(end)}`,
      });
    }
    await sub.save();
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
    });
  if (sub && from && sub.status !== from) await statusAudit(sub, from, by, `${invoice.number} paid`);
  if (sub && from) await syncDeployment(sub);

  const account = await Account.findById(invoice.account);
  if (account) sendEmail(mail.paymentReceiptEmail({ invoice, account, subscription: sub, reactivated: from === "suspended" }));
  return { invoice, subscription: sub };
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
  if (movedFrom) {
    const account = await Account.findById(sub.account);
    if (account) sendEmail(mail.planChangedEmail({ subscription: sub, account, fromName: movedFrom }));
  }
  return { subscription: sub, invoice };
}

/** Staff suspend a subscription: read-only, nothing deleted. The customer is told, with the reason. */
export async function suspend(sub, { reason = "" } = {}, by = null) {
  if (!["trialing", "active", "past_due"].includes(sub.status)) {
    throw new BillingError(`A ${STATUS_WORD[sub.status]} subscription can't be suspended.`, { status: 409 });
  }
  const why = clean(reason, 600);
  if (!why) refuse({ reason: "Say why — the customer is told." });
  if (why.length > 300) refuse({ reason: "Keep it under 300 characters." });

  const from = sub.status;
  sub.status = "suspended";
  sub.history.push({ status: "suspended", by: byId(by), note: `Suspended by SILLA: ${why}` });
  await sub.save();
  await statusAudit(sub, from, by, `suspended by staff: ${why}`);
  await syncDeployment(sub);

  const account = await Account.findById(sub.account);
  const [invoice] = await openExtendingInvoices(sub._id);
  if (account) sendEmail(mail.subscriptionSuspendedEmail({ subscription: sub, account, invoice: invoice || null, reason: why }));
  return sub;
}

/**
 * Lifts a suspension — or withdraws a scheduled cancellation. Back to
 * whatever the dates say it is: paid through the future → active; an
 * unpaid trial still running → trialing; otherwise past due with a fresh
 * grace period, so the job does not re-suspend it on its next tick.
 */
export async function resume(sub, by = null) {
  const now = new Date();
  const from = sub.status;

  if (sub.status === "suspended") {
    const settings = await getSettings();
    if (sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
      sub.status = "active";
      sub.graceEndsAt = null;
    } else if (!sub.currentPeriodEnd && sub.trialEndsAt && sub.trialEndsAt > now) {
      sub.status = "trialing";
      sub.graceEndsAt = null;
    } else {
      sub.status = "past_due";
      sub.graceEndsAt = addDays(now, settings.billing?.graceDays ?? 7);
    }
    sub.history.push({
      status: sub.status,
      by: byId(by),
      note: sub.status === "past_due" ? `Resumed by SILLA — payment due by ${date(sub.graceEndsAt)}` : "Resumed by SILLA",
    });
    await sub.save();
    await statusAudit(sub, from, by, "resumed by staff");
    await syncDeployment(sub);
    const account = await Account.findById(sub.account);
    if (account) sendEmail(mail.subscriptionReactivatedEmail({ subscription: sub, account }));
    return sub;
  }

  if (sub.cancelAtPeriodEnd && sub.status !== "cancelled") {
    sub.cancelAtPeriodEnd = false;
    sub.history.push({ status: sub.status, by: byId(by), note: "Scheduled cancellation withdrawn" });
    await sub.save();
    await audit(actor(by), "subscription.cancel.withdraw", subjectOf(sub), `Withdrew ${sub.organizationName}'s scheduled cancellation`, {});
    return sub;
  }

  if (sub.status === "cancelled") {
    throw new BillingError("A cancelled subscription has ended. A new order starts a new one.", { status: 409 });
  }
  throw new BillingError("There's nothing to resume — it isn't suspended or scheduled to end.", { status: 409 });
}

/**
 * Ends a subscription, now or when its paid period (or trial) runs out.
 * Either way the periods it will never have stop being owed: their open
 * invoices are voided, so the customer is not chased for them.
 */
export async function cancel(sub, { when = "now", reason = "" } = {}, by = null) {
  if (sub.status === "cancelled") throw new BillingError("This subscription has already ended.", { status: 409 });
  const why = clean(reason, 600);
  if (why.length > 300) refuse({ reason: "Keep it under 300 characters." });

  if (when === "period_end") {
    if (!["active", "trialing"].includes(sub.status)) {
      throw new BillingError("Only a running subscription can end at its period's end. Cancel it now instead.", { status: 409 });
    }
    const endsAt = sub.status === "active" ? sub.currentPeriodEnd : sub.trialEndsAt;
    if (!endsAt) throw new BillingError("This subscription has no period end yet. Cancel it now instead.", { status: 409 });
    sub.cancelAtPeriodEnd = true;
    sub.cancelReason = why;
    sub.history.push({ status: sub.status, by: byId(by), note: `Will end on ${date(endsAt)}${why ? `: ${why}` : ""}` });
    await sub.save();
    await voidOpenPeriodInvoices(sub, "Subscription ends at the end of its period", by);
    await audit(actor(by), "subscription.cancel.schedule", subjectOf(sub), `${sub.organizationName} will end on ${date(endsAt)}`, { endsAt, reason: why });
    return sub;
  }
  if (when !== "now") refuse({ when: "Now, or at the end of the period." });

  const from = sub.status;
  sub.status = "cancelled";
  sub.cancelledAt = new Date();
  sub.cancelReason = why;
  sub.cancelAtPeriodEnd = false;
  sub.history.push({ status: "cancelled", by: byId(by), note: why ? `Cancelled by SILLA: ${why}` : "Cancelled by SILLA" });
  await sub.save();
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
 * A paid period — or a trial — ended with its invoice still open: past
 * due, usable until `end + graceDays`. Only when there IS an open invoice:
 * a customer is never treated as late for a bill SILLA has not sent (a
 * price never agreed, a renewal voided by staff). Those are flagged for
 * staff in the console instead.
 */
export async function lapse(sub, { kind, settings, now = new Date() }) {
  const open = await openExtendingInvoices(sub._id);
  if (!open.length) return null;
  const endField = kind === "trial" ? "trialEndsAt" : "currentPeriodEnd";
  const from = kind === "trial" ? "trialing" : "active";
  const end = sub[endField];
  const graceEndsAt = addDays(end, settings.billing?.graceDays ?? 7);

  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: from, [endField]: end },
    {
      $set: { status: "past_due", graceEndsAt },
      $push: {
        history: {
          status: "past_due",
          at: now,
          note: `${kind === "trial" ? "Trial" : "Paid period"} ended with ${open[0].number} unpaid — grace until ${date(graceEndsAt)}`,
        },
      },
    },
    { new: true }
  );
  if (!updated) return null;

  // One message carries both the overdue notice and the grace period; the
  // invoice's own overdue reminder must not repeat it.
  await Invoice.updateMany({ _id: { $in: open.map((i) => i._id) }, "reminders.overdueAt": null }, { $set: { "reminders.overdueAt": now } });
  await statusAudit(updated, from, null, `${kind === "trial" ? "trial" : "period"} ended unpaid`);
  await syncDeployment(updated);
  const account = await Account.findById(updated.account);
  if (account) {
    sendEmail(mail.invoiceOverdueEmail({ invoice: open[0], account, settings, subscription: updated, graceEndsAt }));
  }
  return updated;
}

/** Grace ran out with the invoice still open: suspended. Read-only, nothing deleted. */
export async function suspendAfterGrace(sub, { now = new Date() } = {}) {
  const open = await openExtendingInvoices(sub._id);
  if (!open.length) return null;
  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: "past_due", graceEndsAt: { $lte: now } },
    { $set: { status: "suspended" }, $push: { history: { status: "suspended", at: now, note: `Grace period ended with ${open[0].number} unpaid` } } },
    { new: true }
  );
  if (!updated) return null;
  await statusAudit(updated, "past_due", null, "grace period ended unpaid");
  await syncDeployment(updated);
  const account = await Account.findById(updated.account);
  if (account) sendEmail(mail.subscriptionSuspendedEmail({ subscription: updated, account, invoice: open[0] }));
  return updated;
}

/** A cancellation scheduled for the end of the period (or trial), now due. */
export async function endAtPeriodEnd(sub, { now = new Date() } = {}) {
  const from = sub.status;
  const updated = await Subscription.findOneAndUpdate(
    { _id: sub._id, status: from, cancelAtPeriodEnd: true },
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

/** Re-pushes deployments whose last push failed. Oldest failure first. */
export async function retryFailedSyncs({ limit = 50 } = {}) {
  const subs = await Subscription.find({ "sync.error": { $ne: null }, organizationId: { $ne: "" } }).sort({ "sync.syncedAt": 1 }).limit(limit);
  for (const sub of subs) await syncDeployment(sub);
  return subs.length;
}

/* ───────────────────────────── for the console ───────────────────────────── */

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
