import { Router } from "express";
import mongoose from "mongoose";
import Order, { ALLOWED_TRANSITIONS } from "../models/Order.js";
import Account from "../models/Account.js";
import Conversation from "../models/Conversation.js";
import { requireAccount } from "../middleware/auth.js";
import { can, requirePermission } from "../middleware/staff.js";
import { audit } from "../lib/audit.js";
import { sendEmail, isUndeliverable } from "../services/email/index.js";
import * as billing from "../services/billing.js";
import { readSelections } from "../lib/quote.js";
import { formatMoney } from "../services/email/billingTemplates.js";
import {
  orderCancelledEmail, orderLiveEmail, orderProvisioningEmail,
  orderSubmittedEmail, orderSubmittedInternalEmail,
} from "../services/email/templates.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

/**
 * Orders from before `planName` was stored carry only a key — one of the
 * three plans that existed then, under the names they had.
 */
const LEGACY_PLAN_NAMES = { room: "One Room", building: "Whole Building", campus: "Campus" };
export const planNameOf = (order) => order.planName || LEGACY_PLAN_NAMES[order.plan] || order.plan;

/** A frozen quote's headline figures, for a list row — the whole quote is on the detail. */
const totalsOf = (quote) =>
  quote?.totals
    ? {
        oneTime: quote.totals.oneTime,
        perMonth: quote.totals.perMonth,
        perPeriod: quote.totals.perPeriod,
        firstInvoice: quote.totals.firstInvoice?.total ?? null,
      }
    : null;

/** What the buyer's own list needs — never the whole profile. */
const summary = (order) => ({
  id: order._id.toString(),
  organizationName: order.organizationName,
  plan: order.plan,
  planName: planNameOf(order),
  billingPeriod: order.billingPeriod,
  quotedAmount: order.quotedAmount,
  currency: order.currency,
  totals: totalsOf(order.quote),
  status: order.status,
  deploymentUrl: order.deploymentUrl,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

/** The same row for staff surfaces elsewhere (deployments.routes.js), so the two never disagree. */
export const orderSummary = summary;

/**
 * The plan an order may be saved with: any ACTIVE plan in the catalogue —
 * the three SILLA started with, or one staff created in the console.
 * A retired plan is still in the catalogue (subscriptions on it carry on)
 * but is no longer sold. Answers the plan, or null with the reason.
 */
const PLAN_KEY = /^[a-z0-9-]{2,40}$/;
async function orderablePlan(key) {
  const wanted = String(key || "").trim().toLowerCase();
  if (!PLAN_KEY.test(wanted)) return { plan: null, problem: "Pick a plan." };
  const plan = await billing.planByKey(wanted);
  if (!plan) return { plan: null, problem: "Pick a plan — that one isn't in the catalogue." };
  if (plan.active === false) return { plan: null, problem: "That plan isn't offered any more. Pick another." };
  return { plan, problem: null };
}

/** The first of a set of field problems, as the sentence a refusal leads with. */
const firstProblem = (fields) => Object.values(fields)[0];

/**
 * Prices an order's choices on the server (billing.quoteOrder) and
 * answers the problems, by field, if it can't be ordered as it stands —
 * a minimum not met, an extra building on a plan that has none, two
 * support tiers. Responds itself and returns null on a refusal.
 */
async function pricedOrRefused(res, { plan, billingPeriod, selections }) {
  const { quote, problems } = await billing.quoteOrder({ plan, billingPeriod, selections });
  if (Object.keys(problems).length) {
    res.status(400).json({ error: firstProblem(problems), code: "QUOTE_INVALID", fields: problems });
    return null;
  }
  return quote;
}

/** The buyer's choices from a request body — keys, quantities and buy/rent, nothing else. */
function selectionsOrRefused(res, raw) {
  const { selections, problems } = readSelections(raw);
  if (Object.keys(problems).length) {
    res.status(400).json({ error: firstProblem(problems), code: "QUOTE_INVALID", fields: problems });
    return null;
  }
  return selections;
}

/** An order's choices as plain { key, quantity, mode } — what lib/quote.js reads. */
const selectionsOf = (order) => (order.selections || []).map((s) => ({ key: s.key, quantity: s.quantity, mode: s.mode ?? null }));

/**
 * The quote to SHOW for an order: the frozen one once it was submitted;
 * for a draft, priced live — with any problems the catalogue has grown
 * since it was saved, so the buyer finds out before pressing Submit.
 */
async function quoteToShow(order) {
  // Submitted: what was frozen — and an order submitted before quotes
  // existed has none to show, rather than today's prices passed off as its own.
  if (order.status !== "draft") return { quote: order.quote || null, problems: {}, live: false };
  const plan = await billing.planByKey(order.plan);
  if (!plan) return { quote: null, problems: { plan: "That plan isn't in the catalogue any more. Pick another." }, live: true };
  const { quote, problems } = await billing.quoteOrder({ plan, billingPeriod: order.billingPeriod, selections: selectionsOf(order) });
  if (plan.active === false) problems.plan = "That plan isn't offered any more. Pick another.";
  return { quote, problems, live: true };
}


/* ─────────────────────────── A buyer's own ─────────────────────────── */

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ account: req.account._id }).sort({ updatedAt: -1 });
    res.json({ orders: orders.map(summary) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    // Scoped by account in the QUERY, not checked after: a findById
    // followed by an ownership test is one forgotten line away from an
    // IDOR, and this way the wrong id simply does not match.
    const order = await Order.findOne({ _id: req.params.id, account: req.account._id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const { quote, problems, live } = await quoteToShow(order);
    res.json({
      order: {
        ...summary(order),
        profile: order.profile,
        history: order.history,
        selections: selectionsOf(order),
        quote,
        quoteLive: live,
        quoteProblems: problems,
        quotedAt: order.quotedAt || null,
      },
    });
  })
);

/** Save a configuration. New every time — versioning is out of scope. */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    // quotedAmount, currency and any price are NOT read: the order is
    // priced here, from the catalogue (billing.quoteOrder).
    const { profile, plan, billingPeriod } = req.body || {};

    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return res.status(400).json({ error: "A configuration is required." });
    }
    if (!profile.organizationName) {
      return res.status(400).json({ error: "The configuration has no organization name." });
    }
    const chosen = await orderablePlan(plan);
    if (!chosen.plan) return res.status(400).json({ error: chosen.problem, fields: { plan: chosen.problem } });

    const period = billingPeriod === "monthly" ? "monthly" : "yearly";
    const selections = selectionsOrRefused(res, req.body?.selections);
    if (!selections) return;
    const quote = await pricedOrRefused(res, { plan: chosen.plan, billingPeriod: period, selections });
    if (!quote) return;

    const order = await Order.create({
      account: req.account._id,
      profile,
      organizationName: String(profile.organizationName),
      plan: chosen.plan.key,
      planName: chosen.plan.name,
      billingPeriod: period,
      selections,
      quotedAmount: quote.plan.perMonth,
      currency: quote.currency,
      status: "draft",
      history: [{ status: "draft", by: req.account._id, note: "Created" }],
    });

    res.status(201).json({ order: summary(order) });
  })
);

/** Edit a draft. Once submitted it is a record of what was agreed. */
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await Order.findOne({ _id: req.params.id, account: req.account._id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "draft") {
      return res.status(409).json({ error: "Only a draft can be edited. Contact SILLA to change a submitted order." });
    }

    const { profile, plan, billingPeriod } = req.body || {};
    if (profile) {
      if (typeof profile !== "object" || Array.isArray(profile) || !profile.organizationName) {
        return res.status(400).json({ error: "That configuration is not valid." });
      }
      order.profile = profile;
      order.organizationName = String(profile.organizationName);
    }
    let chosenPlan = null;
    if (plan && plan !== order.plan) {
      const chosen = await orderablePlan(plan);
      if (!chosen.plan) return res.status(400).json({ error: chosen.problem, fields: { plan: chosen.problem } });
      chosenPlan = chosen.plan;
      order.plan = chosen.plan.key;
      order.planName = chosen.plan.name;
    }
    if (billingPeriod) order.billingPeriod = billingPeriod === "monthly" ? "monthly" : "yearly";
    if (req.body?.selections !== undefined) {
      const selections = selectionsOrRefused(res, req.body.selections);
      if (!selections) return;
      order.selections = selections;
    }

    // Re-priced on every save: a new plan, period or set of choices must
    // still be orderable — an extra building stops being one on Starter.
    const pricedPlan = chosenPlan || (await billing.planByKey(order.plan));
    if (pricedPlan) {
      const quote = await pricedOrRefused(res, { plan: pricedPlan, billingPeriod: order.billingPeriod, selections: selectionsOf(order) });
      if (!quote) return;
      order.quotedAmount = quote.plan.perMonth;
      order.currency = quote.currency;
    }

    await order.save();
    res.json({ order: summary(order) });
  })
);

/** Hand it over. The only transition a buyer may make. */
router.post(
  "/:id/submit",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const draft = await Order.findOne({ _id: req.params.id, account: req.account._id });
    if (!draft) return res.status(404).json({ error: "Order not found" });
    if (!ALLOWED_TRANSITIONS[draft.status].includes("submitted")) {
      return res.status(409).json({ error: `An order that is ${draft.status} cannot be submitted.` });
    }

    // Submitting is the commercial commitment, and the email on the
    // account is where every update about it goes — so it has to be an
    // address the buyer has proved they own. Exploring, configuring and
    // saving drafts stay open to unverified accounts; this is the one gate.
    if (!req.account.emailVerified) {
      return res.status(403).json({
        error: "Verify your email address before placing an order.",
        code: "EMAIL_UNVERIFIED",
      });
    }

    // Priced again, here and now, and frozen: what the order costs is the
    // catalogue's at the moment of commitment, whatever the draft was
    // saved at and whatever the browser shows. A plan retired since the
    // draft, or a choice the catalogue no longer allows, is refused by
    // field rather than submitted at a price nobody agreed.
    const chosen = await orderablePlan(draft.plan);
    if (!chosen.plan) return res.status(400).json({ error: chosen.problem, code: "QUOTE_INVALID", fields: { plan: chosen.problem } });
    const quote = await pricedOrRefused(res, { plan: chosen.plan, billingPeriod: draft.billingPeriod, selections: selectionsOf(draft) });
    if (!quote) return;

    const now = new Date();
    const was = draft.quotedAmount;
    const notes = ["Submitted by the buyer"];
    if (Number.isFinite(was) && quote.plan.perMonth != null && was !== quote.plan.perMonth) {
      notes.push(
        `the plan was ${formatMoney(was, quote.currency)}/month when saved and ${formatMoney(quote.plan.perMonth, quote.currency)}/month at submission`
      );
    }
    // Conditional on still being a draft, so two submits at once cannot both land.
    const order = await Order.findOneAndUpdate(
      { _id: draft._id, status: "draft" },
      {
        $set: {
          status: "submitted",
          planName: chosen.plan.name,
          quote: { ...quote, frozenAt: now },
          quotedAt: now,
          quotedAmount: quote.plan.perMonth,
          currency: quote.currency,
        },
        $push: { history: { status: "submitted", at: now, by: req.account._id, note: notes.join("; ") } },
      },
      { new: true }
    );
    if (!order) return res.status(409).json({ error: "This order was submitted a moment ago." });

    // The subscription (and its first invoice) exists from the moment of
    // commitment. A billing failure must not un-submit the order — staff
    // can issue the invoice by hand — so it is logged, not thrown.
    try {
      await billing.onOrderSubmitted(order);
    } catch (err) {
      console.error("[vendor:billing] onOrderSubmitted failed for", order._id.toString(), err);
    }

    // Both directions: the buyer gets a receipt, and we get told rather
    // than finding out when somebody refreshes the queue. Not for test
    // buyers: the @test.silla guard in the transport checks only the
    // RECIPIENT, and this one goes to a real inbox.
    sendEmail(orderSubmittedEmail({ account: req.account, order }));
    if (process.env.SILLA_ORDERS_EMAIL && !isUndeliverable(req.account.email)) {
      sendEmail(orderSubmittedInternalEmail({ account: req.account, order, to: process.env.SILLA_ORDERS_EMAIL }));
    }

    res.json({ order: summary(order) });
  })
);

/* ───────────────────────── SILLA's queue ───────────────────────── */
/*
 * The staff console's Orders section. Gated by permission
 * (middleware/staff.js), not by "is SILLA staff": every staff role may
 * read the queue, but a billing clerk cannot move an order along.
 */

/**
 * Drafts are a buyer's private working copy — they are not an order
 * until submitted, and listing them would put half-finished thinking in
 * front of the vendor.
 *
 * The guard used to be `ALLOWED_TRANSITIONS[status] !== undefined`,
 * which reads like a validity check and is one — but "draft" IS a key in
 * that table, so `?status=draft` sailed through it and returned every
 * buyer's private draft along with their email. Verified against the
 * running API before this was changed. Being a known status and being
 * listable are different questions.
 */
const LISTABLE = ["submitted", "provisioning", "live", "cancelled"];
/** "Open" is what still needs someone: submitted, or being built. */
const OPEN = ["submitted", "provisioning"];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const who = (a) =>
  a && typeof a === "object" && a.email ? { id: a._id.toString(), name: a.name, email: a.email } : null;

router.get(
  "/queue/all",
  requirePermission("orders.read"),
  asyncHandler(async (req, res) => {
    const { status, q, plan } = req.query;

    const filter = {};
    if (status === "open") filter.status = { $in: OPEN };
    else if (status && LISTABLE.includes(status)) filter.status = status;
    else filter.status = { $ne: "draft" };
    if (plan && PLAN_KEY.test(String(plan))) filter.plan = String(plan);

    if (q && String(q).trim()) {
      const rx = { $regex: escapeRegex(String(q).trim().slice(0, 80)), $options: "i" };
      const buyers = await Account.find({ role: "buyer", $or: [{ email: rx }, { name: rx }, { organizationName: rx }] })
        .select("_id")
        .limit(500);
      filter.$or = [{ organizationName: rx }, { deploymentSlug: rx }, { account: { $in: buyers.map((b) => b._id) } }];
    }

    const [orders, byStatus] = await Promise.all([
      Order.find(filter).sort({ updatedAt: -1 }).limit(200).populate("account", "name email"),
      Order.aggregate([{ $match: { status: { $ne: "draft" } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);

    // Unread customer messages per order, so a thread about an order is
    // visible from the queue without opening the inbox.
    const unread = await Conversation.aggregate([
      { $match: { order: { $in: orders.map((o) => o._id) }, status: "open" } },
      { $group: { _id: "$order", open: { $sum: 1 }, unread: { $sum: "$unread.staff" } } },
    ]);
    const talk = new Map(unread.map((u) => [u._id.toString(), { open: u.open, unread: u.unread }]));

    const counts = { submitted: 0, provisioning: 0, live: 0, cancelled: 0 };
    for (const row of byStatus) if (row._id in counts) counts[row._id] = row.n;
    counts.open = counts.submitted + counts.provisioning;
    counts.all = counts.open + counts.live + counts.cancelled;

    res.json({
      orders: orders.map((o) => ({
        ...summary(o),
        account: o.account ? { name: o.account.name, email: o.account.email, id: o.account._id.toString() } : null,
        provisionedAt: o.provisionedAt || null,
        notes: o.notes?.length || 0,
        conversations: talk.get(o._id.toString()) || { open: 0, unread: 0 },
      })),
      counts,
    });
  })
);

/** Everything a person needs to act on one order. */
async function queueDetail(id) {
  const order = await Order.findById(id)
    .populate("account", "name email organizationName emailVerified")
    .populate("history.by", "name email")
    .populate("notes.by", "name email")
    .populate("provisioningClaim.by", "name email");
  if (!order || order.status === "draft") return null;

  const [sub, conversations] = await Promise.all([
    billing.subscriptionForOrder(order._id),
    Conversation.find({ order: order._id }).sort({ lastMessageAt: -1 }).limit(20),
  ]);

  return {
    ...summary(order),
    profile: order.profile,
    selections: selectionsOf(order),
    quote: order.quote || null,
    quotedAt: order.quotedAt || null,
    history: (order.history || []).map((h) => ({ status: h.status, at: h.at, note: h.note, by: who(h.by) })),
    notes: (order.notes || [])
      .map((n) => ({ id: n._id.toString(), at: n.at, body: n.body, by: who(n.by) }))
      .reverse(),
    account: order.account
      ? {
          id: order.account._id.toString(),
          name: order.account.name,
          email: order.account.email,
          organizationName: order.account.organizationName,
          emailVerified: Boolean(order.account.emailVerified),
        }
      : null,
    provisionedOrganizationId: order.provisionedOrganizationId,
    deploymentSlug: order.deploymentSlug || "",
    provisionedAt: order.provisionedAt || null,
    provisioning:
      order.provisioningClaim?.at && Date.now() - new Date(order.provisioningClaim.at).getTime() < 2 * 60 * 1000
        ? { since: order.provisioningClaim.at, by: who(order.provisioningClaim.by) }
        : null,
    allowed: ALLOWED_TRANSITIONS[order.status] || [],
    // Read for display: what billing knows about this order. Money lives
    // in the Subscriptions section; this is status only.
    subscription: sub
      ? {
          id: sub._id.toString(),
          status: sub.status,
          planName: sub.planName,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodEnd: sub.currentPeriodEnd,
          sync: { syncedAt: sub.sync?.syncedAt || null, error: sub.sync?.error || null },
        }
      : null,
    conversations: conversations.map((c) => ({
      id: c._id.toString(),
      subject: c.subject,
      status: c.status,
      unread: c.unread?.staff || 0,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageBy: c.lastMessageBy,
    })),
  };
}

router.get(
  "/queue/:id",
  requirePermission("orders.read"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await queueDetail(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order });
  })
);

/**
 * Move an order along. Only through a legal transition.
 *
 * This is also the MANUAL provisioning path — the profile run through
 * `npm run seed:file` by hand, then the URL and organization id recorded
 * here — for when the control plane is not available. PROVISION in the
 * console (deployments.routes.js) is the one-press path. Either way, going
 * live is what starts the subscription's trial (billing.onProvisioned):
 * a customer with a working system is on the clock however it was built.
 *
 * The write is CONDITIONAL on the order still being as it was read — its
 * status, its address, its organization, and nobody mid-way through
 * provisioning it. Two staff members acting on one order at once (one
 * cancelling while another presses Provision) would otherwise each save
 * over the other, and a cancelled order could come back live.
 */
const CLAIM_FRESH_MS = 2 * 60 * 1000; // deployments.routes.js CLAIM_TTL_MS

router.patch(
  "/queue/:id",
  requirePermission("orders.manage"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await Order.findById(req.params.id);
    if (!order || order.status === "draft") return res.status(404).json({ error: "Order not found" });

    const { status, deploymentUrl, provisionedOrganizationId } = req.body || {};
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const previous = order.status;
    const before = { deploymentUrl: order.deploymentUrl, provisionedOrganizationId: order.provisionedOrganizationId };
    const after = { ...before };
    const moving = Boolean(status) && status !== previous;

    if (moving) {
      if (!ALLOWED_TRANSITIONS[previous]?.includes(status)) {
        return res.status(409).json({
          error: `Cannot go from ${previous} to ${status}.`,
          allowed: ALLOWED_TRANSITIONS[previous],
        });
      }
      // Cancelling a LIVE order ends a running deployment: its subscription
      // is cancelled and the organization goes read-only. That is the
      // reach of deployments.manage (owners, admins) — orders.manage lets
      // support clear away a duplicate order, not switch a customer off.
      if (status === "cancelled" && previous === "live" && !can(req.account, "deployments.manage")) {
        return res.status(403).json({
          error: "Cancelling a live order switches the customer's system off. Ask an owner or an admin.",
          code: "STAFF_PERMISSION",
          permission: "deployments.manage",
        });
      }
      // A cancellation is emailed to the customer with its reason, and is
      // the one transition they will want explained. Nobody should get
      // "your order was cancelled" and nothing else.
      if (status === "cancelled" && !note) {
        return res.status(400).json({
          error: "Say why it's being cancelled — the customer is emailed the reason.",
          fields: { note: "Say why it's being cancelled — the customer is emailed the reason." },
        });
      }
    }

    if (deploymentUrl !== undefined) {
      after.deploymentUrl = String(deploymentUrl).trim().slice(0, 500);
      if (after.deploymentUrl && !/^https?:\/\/\S+$/i.test(after.deploymentUrl)) {
        const message = "Enter the full address, starting with https://";
        return res.status(400).json({ error: message, fields: { deploymentUrl: message } });
      }
    }
    if (provisionedOrganizationId !== undefined) {
      after.provisionedOrganizationId = String(provisionedOrganizationId).trim().slice(0, 64);
      if (after.provisionedOrganizationId !== before.provisionedOrganizationId) {
        // An organization the console provisioned is linked to its
        // subscription and its address; re-pointing it by hand would send
        // this customer's plan to someone else's deployment.
        if (order.deploymentSlug) {
          const message = "This order was provisioned from the console, so its organization can't be changed by hand.";
          return res.status(409).json({ error: message, fields: { provisionedOrganizationId: message } });
        }
        if (
          after.provisionedOrganizationId &&
          (await Order.exists({ _id: { $ne: order._id }, provisionedOrganizationId: after.provisionedOrganizationId }))
        ) {
          const message = "Another order is already linked to that organization.";
          return res.status(409).json({ error: message, fields: { provisionedOrganizationId: message } });
        }
      }
    }

    const nextStatus = moving ? status : previous;
    // Going live without saying where is the one mistake this flow
    // invites, and it is the field the customer actually needs.
    if (nextStatus === "live" && !after.deploymentUrl) {
      const message = "A live order needs its deployment URL.";
      return res.status(400).json({ error: message, fields: { deploymentUrl: message } });
    }

    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (!moving && !changed.length) return res.json({ order: summary(order) });

    const saved = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: previous,
        deploymentUrl: before.deploymentUrl,
        provisionedOrganizationId: before.provisionedOrganizationId,
        $or: [{ "provisioningClaim.at": null }, { "provisioningClaim.at": { $lt: new Date(Date.now() - CLAIM_FRESH_MS) } }],
      },
      {
        $set: { status: nextStatus, ...after },
        ...(moving ? { $push: { history: { status, at: new Date(), by: req.account._id, note } } } : {}),
      },
      { new: true }
    );
    if (!saved) {
      const now = await Order.findById(order._id).select("provisioningClaim");
      const claimed = now?.provisioningClaim?.at && Date.now() - new Date(now.provisioningClaim.at).getTime() < CLAIM_FRESH_MS;
      return res.status(409).json(
        claimed
          ? { error: "Someone is provisioning this order right now. Give it a moment, then refresh.", code: "PROVISIONING_IN_PROGRESS" }
          : { error: "This order changed while you were looking at it. Refresh it and try again.", code: "ORDER_CHANGED" }
      );
    }

    const target = { type: "order", id: saved._id, label: saved.organizationName };
    if (moving) {
      await audit(
        req,
        "order.status",
        target,
        `Moved ${saved.organizationName} from ${previous} to ${status}${note ? ` — ${note}` : ""}`,
        { from: previous, to: status, note }
      );
    }
    if (changed.length) {
      await audit(req, "order.update", target, `Updated ${changed.join(" and ")} on ${saved.organizationName}`, { before, after });
    }

    if (status === "cancelled" && moving) {
      try {
        await billing.onOrderCancelled(saved, { by: req.account, reason: note });
      } catch (err) {
        console.error("[vendor:billing] onOrderCancelled failed for", saved._id.toString(), err);
      }
    }

    // Live by hand: the same billing step as the one-press path — the
    // trial starts, and the deployment (once its id is known) is told its
    // plan. Again if the organization id is filled in afterwards.
    if (saved.status === "live" && (moving || changed.includes("provisionedOrganizationId"))) {
      try {
        await billing.onProvisioned(saved, saved.provisionedOrganizationId || "", { by: req.account });
      } catch (err) {
        console.error("[vendor:billing] onProvisioned failed for", saved._id.toString(), err);
      }
    }

    // Only on an actual change of state — re-saving a URL should not
    // email somebody again.
    if (moving) {
      const account = await Account.findById(saved.account).select("firstName name email");
      if (account) {
        if (status === "provisioning") sendEmail(orderProvisioningEmail({ account, order: saved }));
        if (status === "live") sendEmail(orderLiveEmail({ account, order: saved }));
        if (status === "cancelled") sendEmail(orderCancelledEmail({ account, order: saved, reason: note }));
      }
    }

    res.json({ order: summary(saved) });
  })
);

/**
 * A staff-only note on an order. Never returned by a buyer route — see
 * the `notes` field in models/Order.js for why it is not a history note.
 */
router.post(
  "/queue/:id/notes",
  requirePermission("orders.manage"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "Write the note first.", fields: { body: "Write the note first." } });
    if (body.length > 4000) {
      return res.status(400).json({ error: "Keep a note under 4,000 characters.", fields: { body: "Keep a note under 4,000 characters." } });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: "draft" } },
      { $push: { notes: { at: new Date(), by: req.account._id, body } } },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });

    await audit(
      req,
      "order.note",
      { type: "order", id: order._id, label: order.organizationName },
      `Added a note to ${order.organizationName}`
    );
    res.status(201).json({ order: await queueDetail(order._id) });
  })
);

export default router;
