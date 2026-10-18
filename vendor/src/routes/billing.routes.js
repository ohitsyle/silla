/**
 * Subscriptions, invoices and payments — the buyer's view and the staff
 * console's.
 *
 *   buyer   GET   /me                         their subscriptions in plain words, with what is open
 *           GET   /me/invoices                every invoice addressed to them
 *           GET   /invoices/:id               one invoice: theirs — or any, for staff with billing.read
 *           POST  /invoices/:id/claim         "I've paid": a CLAIM staff confirm, never a payment
 *
 *   staff   GET   /subscriptions              ?status ?plan ?q ?attention=1
 *           GET   /subscriptions/:id          with its invoices, history and plan defaults
 *           PATCH /subscriptions/:id          plan, billingPeriod, price, overrides, notice, trialEndsAt, addOns
 *           POST  /subscriptions/:id/suspend  { reason }
 *           POST  /subscriptions/:id/resume   lifts a suspension, or withdraws a scheduled end
 *           POST  /subscriptions/:id/cancel   { when: "now" | "period_end", reason }
 *           POST  /subscriptions/:id/sync     push the entitlements again
 *           GET   /invoices                   ?status ?overdue=1 ?claimed=1 ?q ?subscription
 *           POST  /invoices                   a manual invoice
 *           POST  /invoices/:id/payment       money received — the ONE way an invoice is paid
 *           POST  /invoices/:id/void          { reason }
 *           POST  /invoices/:id/claim/dismiss { reason } — the buyer is told
 *
 * Every rule, and every audit line, lives in services/billing.js. This file
 * decides who is asking, finds the record and shapes the answer — and a
 * buyer's read puts the account IN THE QUERY, so someone else's invoice
 * id simply does not match. Mounted at /api/vendor/billing.
 */
import { Router } from "express";
import mongoose from "mongoose";
import Account from "../models/Account.js";
import Invoice from "../models/Invoice.js";
import Order from "../models/Order.js";
import Subscription, { SUBSCRIPTION_STATUS } from "../models/Subscription.js";
import { requireAccount } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { can, requirePermission } from "../middleware/staff.js";
import { FEATURES, LIMITS } from "../lib/planKeys.js";
import { itemMonthly, monthsIn } from "../lib/quote.js";
import * as billing from "../services/billing.js";

const { BillingError, NUMBERED } = billing;

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

const STAFF_READ = requirePermission("billing.read");
const STAFF_MANAGE = requirePermission("billing.manage");

const notFound = (res, what = "That") => res.status(404).json({ error: `${what} wasn't found.` });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const idOf = (v) => (v ? String(v._id || v) : null);

/* ───────────────────────────── shapes ───────────────────────────── */

/** An invoice as a buyer sees it: everything printed on it, nothing internal. */
function invoiceShape(inv, { now = new Date() } = {}) {
  const claim = inv.claimedPayment || {};
  return {
    id: String(inv._id),
    number: inv.number,
    kind: inv.kind,
    status: inv.status,
    overdue: billing.isOverdue(inv, now),
    organizationName: inv.organizationName,
    subscription: idOf(inv.subscription),
    issuer: inv.issuer,
    billTo: inv.billTo,
    lines: (inv.lines || []).map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      amount: l.amount,
      kind: l.kind || "",
      note: l.note || "",
    })),
    subtotal: inv.subtotal,
    tax: inv.tax,
    total: inv.total,
    currency: inv.currency,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    billingPeriod: inv.billingPeriod,
    extendsSubscription: Boolean(inv.extendsSubscription),
    memo: inv.memo || "",
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    paidAt: inv.paidAt,
    voidedAt: inv.voidedAt,
    voidReason: inv.voidReason || "",
    payment:
      inv.status === "paid"
        ? {
            method: inv.payment?.method || null,
            reference: inv.payment?.reference || "",
            amount: inv.payment?.amount ?? null,
            receivedAt: inv.payment?.receivedAt || null,
          }
        : null,
    // The buyer sees their own claim and, if staff could not match it, why.
    claim: claim.submittedAt
      ? {
          method: claim.method,
          reference: claim.reference,
          amount: claim.amount,
          paidAt: claim.paidAt,
          note: claim.note || "",
          submittedAt: claim.submittedAt,
          dismissedAt: claim.dismissedAt,
          dismissNote: claim.dismissNote || "",
        }
      : null,
  };
}

/** The same, for staff: who it is for, who recorded the money and the internal note. */
function staffInvoiceShape(inv, { now = new Date(), accounts = new Map() } = {}) {
  const account = accounts.get(idOf(inv.account)) || (inv.account?.email ? inv.account : null);
  const recorder = accounts.get(idOf(inv.payment?.recordedBy));
  const base = invoiceShape(inv, { now });
  return {
    ...base,
    account: account ? { id: idOf(account), name: account.name, email: account.email } : { id: idOf(inv.account) },
    replaces: idOf(inv.replaces),
    payment:
      inv.status === "paid"
        ? {
            ...base.payment,
            note: inv.payment?.note || "",
            recordedBy: recorder ? { name: recorder.name, email: recorder.email } : inv.payment?.recordedBy ? { name: "", email: "" } : null,
          }
        : null,
    reminders: inv.reminders,
  };
}

const featureList = (features) => Object.entries(FEATURES).map(([key, label]) => ({ key, label, on: features[key] !== false }));
const limitList = (limits, raises = {}) =>
  Object.entries(LIMITS).map(([key, label]) => ({ key, label, value: limits[key] ?? null, raisedBy: raises[key] || 0 }));

/**
 * What a subscription pays for besides the plan, each with what it comes
 * to for one billing period — and the whole period, plan included. The
 * same reading the next invoice will make (services/billing.js periodLines).
 */
function addOnsOf(sub) {
  const months = monthsIn(sub.billingPeriod);
  const addOns = (sub.addOns || []).map((a) => ({
    key: a.key,
    name: a.name,
    kind: a.kind,
    category: a.category || "",
    quantity: a.quantity,
    unitAmount: a.unitAmount,
    periodUnitAmount: a.unitAmount * months,
    periodAmount: a.unitAmount * months * a.quantity,
    adds: a.adds || {},
    minimumMonths: a.minimumMonths || 0,
    since: a.since || null,
  }));
  const perPeriod = sub.price?.amount == null ? null : sub.price.amount + addOns.reduce((sum, a) => sum + a.periodAmount, 0);
  return { addOns, perPeriod };
}

/** A subscription as its customer sees it. No overrides, history or sync — those are SILLA's. */
function buyerSubscriptionShape(sub, { plan, order, open = [], now = new Date() }) {
  const words = billing.plainStatus(sub, { now });
  const { features, limits, raises } = billing.entitlementsFor(sub, plan || {});
  const { addOns, perPeriod } = addOnsOf(sub);
  return {
    id: String(sub._id),
    organizationName: sub.organizationName,
    plan: { key: sub.plan, name: sub.planName || plan?.name || sub.plan },
    billingPeriod: sub.billingPeriod,
    price: { amount: sub.price?.amount ?? null, currency: sub.price?.currency || "PHP" },
    addOns,
    perPeriod,
    priceToBeAgreed: Boolean(sub.needsPricing),
    status: sub.status,
    statusLabel: words.label,
    statusDetail: words.detail,
    tone: words.tone,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceEndsAt: sub.graceEndsAt,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    cancelledAt: sub.cancelledAt,
    deploymentUrl: order?.deploymentUrl || "",
    orderId: idOf(sub.order),
    // The line staff set for this organization; its administrators see it in the product too.
    notice: sub.notice || null,
    includes: { features: featureList(features), limits: limitList(limits, raises) },
    openInvoices: open.map((inv) => invoiceShape(inv, { now })),
  };
}

/** A row in the staff list. */
function staffSubscriptionRow(sub, { account, open = [], now = new Date() }) {
  const overdue = open.filter((i) => billing.isOverdue(i, now));
  return {
    id: String(sub._id),
    organizationName: sub.organizationName,
    account: account ? { id: idOf(account), name: account.name, email: account.email } : null,
    plan: sub.plan,
    planName: sub.planName,
    billingPeriod: sub.billingPeriod,
    price: { amount: sub.price?.amount ?? null, currency: sub.price?.currency || "PHP" },
    perPeriod: addOnsOf(sub).perPeriod,
    addOnCount: (sub.addOns || []).filter((a) => a.unitAmount > 0).length,
    needsPricing: Boolean(sub.needsPricing),
    status: sub.status,
    statusLabel: billing.plainStatus(sub, { now }).label,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceEndsAt: sub.graceEndsAt,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    cancelledAt: sub.cancelledAt,
    organizationId: sub.organizationId || "",
    hasOverrides: Boolean(
      Object.keys(sub.overrides?.features || {}).length || Object.keys(sub.overrides?.limits || {}).length
    ),
    notice: sub.notice || null,
    sync: { syncedAt: sub.sync?.syncedAt || null, error: sub.sync?.error || null, version: sub.sync?.version || 0 },
    openInvoices: { count: open.length, total: open.reduce((s, i) => s + i.total, 0), overdue: overdue.length },
    attention: billing.attentionFor(sub, { openInvoices: open.length, now }),
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

/** Open, numbered invoices for these subscriptions, grouped by subscription id. */
async function openInvoicesBySubscription(ids) {
  const open = await Invoice.find({ subscription: { $in: ids }, status: "open", ...NUMBERED }).sort({ dueAt: 1 });
  const by = new Map();
  for (const inv of open) {
    const key = idOf(inv.subscription);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(inv);
  }
  return by;
}

async function accountsById(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const accounts = await Account.find({ _id: { $in: unique } }).select("name email firstName lastName role staffRole");
  return new Map(accounts.map((a) => [String(a._id), a]));
}

/* ───────────────────────────── a buyer's own ───────────────────────────── */

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const subs = await Subscription.find({ account: req.account._id }).sort({ createdAt: -1 });
    const [orders, open, plans, loose] = await Promise.all([
      Order.find({ _id: { $in: subs.map((s) => s.order) }, account: req.account._id }).select("deploymentUrl status"),
      openInvoicesBySubscription(subs.map((s) => s._id)),
      billing.catalogue({ includeRetired: true }),
      // Invoices issued to the account itself, outside any subscription (a one-off charge).
      Invoice.find({ account: req.account._id, subscription: null, status: "open", ...NUMBERED }).sort({ dueAt: 1 }),
    ]);
    const orderById = new Map(orders.map((o) => [String(o._id), o]));
    const planByKey = new Map(plans.map((p) => [p.key, p]));
    const business = (await billing.getSettings()).business || {};
    res.json({
      // Prices are quoted before VAT; the page says "+ 12% VAT" while it applies.
      vat: { registered: Boolean(business.vatRegistered), rate: business.vatRate ?? 0.12 },
      subscriptions: subs.map((sub) =>
        buyerSubscriptionShape(sub, {
          plan: planByKey.get(sub.plan),
          order: orderById.get(String(sub.order)),
          open: open.get(String(sub._id)) || [],
          now,
        })
      ),
      otherOpenInvoices: loose.map((inv) => invoiceShape(inv, { now })),
    });
  })
);

router.get(
  "/me/invoices",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const invoices = await Invoice.find({ account: req.account._id, ...NUMBERED }).sort({ issuedAt: -1 }).limit(200);
    res.json({ invoices: invoices.map((inv) => invoiceShape(inv, { now })) });
  })
);

/**
 * One invoice, for the printable page. The owner — or staff who may read
 * billing — and the difference is in the QUERY: for a buyer the filter
 * carries their account, so another buyer's id is simply not found.
 */
router.get(
  "/invoices/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res, "That invoice");
    const staff = can(req.account, "billing.read");
    const filter = staff ? { _id: req.params.id } : { _id: req.params.id, account: req.account._id };
    const inv = await Invoice.findOne({ ...filter, ...NUMBERED });
    if (!inv) return notFound(res, "That invoice");

    const settings = billing.settingsShape(await billing.getSettings());
    const how =
      inv.status === "open"
        ? { instructions: settings.payment.instructions, methods: settings.payment.methods, contact: { email: settings.business.email, phone: settings.business.phone } }
        : null;
    const shaped = staff
      ? staffInvoiceShape(inv, { accounts: await accountsById([inv.account, inv.payment?.recordedBy]) })
      : invoiceShape(inv);
    res.json({ invoice: shaped, howToPay: how, footer: settings.invoice.footer });
  })
);

/** "I've paid." Recorded and passed to SILLA; it activates nothing (services/billing.js claimPayment). */
router.post(
  "/invoices/:id/claim",
  rateLimit({ name: "invoice-claim", windowMs: 60 * 60 * 1000, max: 10, keyFor: (req) => String(req.account?._id || req.ip) }),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res, "That invoice");
    const inv = await Invoice.findOne({ _id: req.params.id, account: req.account._id, ...NUMBERED });
    if (!inv) return notFound(res, "That invoice");
    const claimed = await billing.claimPayment(inv, req.body || {}, req.account);
    res.json({ invoice: invoiceShape(claimed) });
  })
);

/* ───────────────────────────── staff: subscriptions ───────────────────────────── */

router.get(
  "/subscriptions",
  STAFF_READ,
  asyncHandler(async (req, res) => {
    const now = new Date();
    const filter = {};
    const status = String(req.query.status || "");
    if (SUBSCRIPTION_STATUS.includes(status)) filter.status = status;
    if (req.query.plan) filter.plan = String(req.query.plan);
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const matches = await Account.find({ $or: [{ email: rx }, { name: rx }], role: "buyer" }).select("_id").limit(200);
      filter.$or = [{ organizationName: rx }, { account: { $in: matches.map((a) => a._id) } }];
    }

    const subs = await Subscription.find(filter).sort({ updatedAt: -1 }).limit(300);
    const [open, accounts] = await Promise.all([
      openInvoicesBySubscription(subs.map((s) => s._id)),
      accountsById(subs.map((s) => s.account)),
    ]);
    let rows = subs.map((sub) =>
      staffSubscriptionRow(sub, { account: accounts.get(String(sub.account)), open: open.get(String(sub._id)) || [], now })
    );
    if (req.query.attention === "1") rows = rows.filter((r) => r.attention.length);

    // Counts for the filter tabs, over everything (not just this page) —
    // including how many need a person, which is a reading, not a status.
    const grouped = await Subscription.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    const counts = Object.fromEntries(SUBSCRIPTION_STATUS.map((s) => [s, 0]));
    for (const g of grouped) counts[g._id] = g.n;
    const live = await Subscription.find({ status: { $ne: "cancelled" } })
      .select("status needsPricing organizationId sync trialEndsAt currentPeriodEnd")
      .limit(2000);
    const openCounts = await Invoice.aggregate([
      { $match: { status: "open", subscription: { $in: live.map((s) => s._id) }, ...NUMBERED } },
      { $group: { _id: "$subscription", n: { $sum: 1 } } },
    ]);
    const openBy = new Map(openCounts.map((c) => [String(c._id), c.n]));
    counts.attention = live.filter((s) => billing.attentionFor(s, { openInvoices: openBy.get(String(s._id)) || 0, now }).length).length;
    res.json({ subscriptions: rows, counts });
  })
);

/** Loads the subscription named in the path, or answers 404. */
async function loadSubscription(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    notFound(res, "That subscription");
    return null;
  }
  const sub = await Subscription.findById(req.params.id);
  if (!sub) notFound(res, "That subscription");
  return sub;
}

/**
 * What staff can put on a subscription: everything billed every period —
 * extra buildings, support, and anything that can be rented — priced for
 * this subscription's billing period. Something paid once is a manual
 * invoice, not an add-on.
 */
const addOnOptions = (items, sub) =>
  items
    .filter((i) => i.charge === "recurring" || i.charge === "buy_or_rent")
    .map((i) => ({
      key: i.key,
      name: i.name,
      category: i.category,
      kind: i.charge === "recurring" ? "recurring" : "rental",
      unit: i.unit,
      monthly: itemMonthly(i, sub.billingPeriod),
      plans: i.plans,
      group: i.group,
      groupDefault: i.groupDefault,
      minQuantity: i.minQuantity,
      maxQuantity: i.maxQuantity,
      adds: i.adds,
      active: i.active,
    }));

async function subscriptionDetail(sub) {
  const now = new Date();
  const [invoices, plan, order, plans, items] = await Promise.all([
    Invoice.find({ subscription: sub._id, ...NUMBERED }).sort({ issuedAt: -1 }),
    billing.planByKey(sub.plan),
    Order.findById(sub.order).select("status deploymentUrl provisionedOrganizationId createdAt quote"),
    billing.catalogue({ includeRetired: true }),
    billing.catalogItems({ includeRetired: true }),
  ]);
  const historyBy = (sub.history || []).map((h) => h.by).filter(Boolean);
  const accounts = await accountsById([sub.account, ...historyBy, ...invoices.map((i) => i.payment?.recordedBy)]);
  const open = invoices.filter((i) => i.status === "open");
  const shapedPlan = plan ? billing.planShape(plan) : null;
  const { features, limits, raises } = billing.entitlementsFor(sub, plan || {});
  return {
    ...staffSubscriptionRow(sub, { account: accounts.get(String(sub.account)), open, now }),
    ...addOnsOf(sub),
    addOnOptions: addOnOptions(items, sub),
    overrides: { features: sub.overrides?.features || {}, limits: sub.overrides?.limits || {} },
    planDefaults: shapedPlan ? { features: shapedPlan.features, limits: shapedPlan.limits, prices: shapedPlan.prices, currency: shapedPlan.currency, active: shapedPlan.active } : null,
    effective: { features, limits, raises },
    // What was paid once, from the order's frozen quote — staff deliver it.
    oneTime: (order?.quote?.lines || [])
      .filter((l) => l.kind === "one_time")
      .map((l) => ({ key: l.key, name: l.name, description: l.description, quantity: l.quantity, amount: l.amount, waived: Boolean(l.waived) })),
    cancelReason: sub.cancelReason || "",
    order: order ? { id: String(order._id), status: order.status, deploymentUrl: order.deploymentUrl || "" } : null,
    plans: plans.map((p) => ({ key: p.key, name: p.name, active: p.active, prices: p.prices, currency: p.currency })),
    invoices: invoices.map((inv) => staffInvoiceShape(inv, { now, accounts })),
    history: (sub.history || [])
      .map((h) => {
        const who = h.by ? accounts.get(String(h.by)) : null;
        return {
          at: h.at,
          status: h.status,
          note: h.note,
          by: who ? { name: who.name, email: who.email, staff: who.role === "silla" } : null,
        };
      })
      .reverse(),
  };
}

router.get(
  "/subscriptions/:id",
  STAFF_READ,
  asyncHandler(async (req, res) => {
    const sub = await loadSubscription(req, res);
    if (!sub) return;
    res.json({ subscription: await subscriptionDetail(sub) });
  })
);

router.patch(
  "/subscriptions/:id",
  STAFF_MANAGE,
  asyncHandler(async (req, res) => {
    const sub = await loadSubscription(req, res);
    if (!sub) return;
    const body = req.body || {};
    const patch = Object.fromEntries(
      ["plan", "billingPeriod", "price", "overrides", "notice", "trialEndsAt", "addOns"].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])
    );
    if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change." });
    const { subscription, invoice } = await billing.updateSubscription(sub, patch, req.account);
    res.json({ subscription: await subscriptionDetail(subscription), issuedInvoice: invoice ? invoice.number : null });
  })
);

for (const action of ["suspend", "resume", "cancel", "sync"]) {
  router.post(
    `/subscriptions/:id/${action}`,
    STAFF_MANAGE,
    asyncHandler(async (req, res) => {
      const sub = await loadSubscription(req, res);
      if (!sub) return;
      const body = req.body || {};
      let result = sub;
      let sync = null;
      if (action === "suspend") result = await billing.suspend(sub, { reason: body.reason }, req.account);
      if (action === "resume") result = await billing.resume(sub, req.account);
      if (action === "cancel") result = await billing.cancel(sub, { when: body.when || "now", reason: body.reason }, req.account);
      if (action === "sync") {
        if (!sub.organizationId) {
          return res.status(409).json({ error: "There's no deployment to push to yet — it hasn't been provisioned.", code: "NOT_PROVISIONED" });
        }
        sync = await billing.syncNow(sub, req.account);
        result = await Subscription.findById(sub._id);
      }
      res.json({ subscription: await subscriptionDetail(result), ...(sync ? { sync } : {}) });
    })
  );
}

/* ───────────────────────────── staff: invoices ───────────────────────────── */

router.get(
  "/invoices",
  STAFF_READ,
  asyncHandler(async (req, res) => {
    const now = new Date();
    const filter = { ...NUMBERED };
    const status = String(req.query.status || "");
    if (["open", "paid", "void"].includes(status)) filter.status = status;
    if (req.query.overdue === "1") Object.assign(filter, { status: "open", dueAt: { $lt: now } });
    if (req.query.claimed === "1") {
      Object.assign(filter, { status: "open", "claimedPayment.submittedAt": { $ne: null }, "claimedPayment.dismissedAt": null });
    }
    if (req.query.subscription && mongoose.isValidObjectId(req.query.subscription)) filter.subscription = req.query.subscription;
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const matches = await Account.find({ $or: [{ email: rx }, { name: rx }] }).select("_id").limit(200);
      filter.$or = [{ number: rx }, { organizationName: rx }, { account: { $in: matches.map((a) => a._id) } }];
    }

    const invoices = await Invoice.find(filter).sort({ issuedAt: -1 }).limit(300);
    const accounts = await accountsById(invoices.flatMap((i) => [i.account, i.payment?.recordedBy]));
    const [open, overdue, claimed, paid, voided] = await Promise.all([
      Invoice.countDocuments({ status: "open", ...NUMBERED }),
      Invoice.countDocuments({ status: "open", dueAt: { $lt: now }, ...NUMBERED }),
      Invoice.countDocuments({ status: "open", "claimedPayment.submittedAt": { $ne: null }, "claimedPayment.dismissedAt": null, ...NUMBERED }),
      Invoice.countDocuments({ status: "paid", ...NUMBERED }),
      Invoice.countDocuments({ status: "void", ...NUMBERED }),
    ]);
    res.json({
      invoices: invoices.map((inv) => staffInvoiceShape(inv, { now, accounts })),
      counts: { open, overdue, claimed, paid, void: voided },
    });
  })
);

router.post(
  "/invoices",
  STAFF_MANAGE,
  asyncHandler(async (req, res) => {
    const invoice = await billing.issueManualInvoice(req.body || {}, req.account);
    const accounts = await accountsById([invoice.account]);
    res.status(201).json({ invoice: staffInvoiceShape(invoice, { accounts }) });
  })
);

async function loadInvoice(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    notFound(res, "That invoice");
    return null;
  }
  const inv = await Invoice.findOne({ _id: req.params.id, ...NUMBERED });
  if (!inv) notFound(res, "That invoice");
  return inv;
}

async function staffInvoiceAnswer(id) {
  const inv = await Invoice.findById(id);
  const accounts = await accountsById([inv.account, inv.payment?.recordedBy]);
  return staffInvoiceShape(inv, { accounts });
}

router.post(
  "/invoices/:id/payment",
  STAFF_MANAGE,
  asyncHandler(async (req, res) => {
    const inv = await loadInvoice(req, res);
    if (!inv) return;
    const { subscription } = await billing.recordPayment(inv, req.body || {}, req.account);
    res.json({
      invoice: await staffInvoiceAnswer(inv._id),
      subscription: subscription
        ? { id: String(subscription._id), status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd }
        : null,
    });
  })
);

router.post(
  "/invoices/:id/void",
  STAFF_MANAGE,
  asyncHandler(async (req, res) => {
    const inv = await loadInvoice(req, res);
    if (!inv) return;
    await billing.voidInvoice(inv, req.body || {}, req.account);
    res.json({ invoice: await staffInvoiceAnswer(inv._id) });
  })
);

router.post(
  "/invoices/:id/claim/dismiss",
  STAFF_MANAGE,
  asyncHandler(async (req, res) => {
    const inv = await loadInvoice(req, res);
    if (!inv) return;
    await billing.dismissClaim(inv, req.body || {}, req.account);
    res.json({ invoice: await staffInvoiceAnswer(inv._id) });
  })
);

/** A refusal from the billing service, said the way every other route says one. */
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, next) => {
  if (!(err instanceof BillingError)) return next(err);
  res.status(err.status).json({ error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
});

export default router;
