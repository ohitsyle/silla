import { Router } from "express";
import mongoose from "mongoose";
import Order, { ALLOWED_TRANSITIONS } from "../models/Order.js";
import Account from "../models/Account.js";
import Conversation from "../models/Conversation.js";
import { requireAccount } from "../middleware/auth.js";
import { requirePermission } from "../middleware/staff.js";
import { audit } from "../lib/audit.js";
import { sendEmail, isUndeliverable } from "../services/email/index.js";
import * as billing from "../services/billing.js";
import {
  orderCancelledEmail, orderLiveEmail, orderProvisioningEmail,
  orderSubmittedEmail, orderSubmittedInternalEmail,
} from "../services/email/templates.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

/** What the buyer's own list needs — never the whole profile. */
const summary = (order) => ({
  id: order._id.toString(),
  organizationName: order.organizationName,
  plan: order.plan,
  billingPeriod: order.billingPeriod,
  quotedAmount: order.quotedAmount,
  currency: order.currency,
  status: order.status,
  deploymentUrl: order.deploymentUrl,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

/** The same row for staff surfaces elsewhere (deployments.routes.js), so the two never disagree. */
export const orderSummary = summary;

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
    res.json({ order: { ...summary(order), profile: order.profile, history: order.history } });
  })
);

/** Save a configuration. New every time — versioning is out of scope. */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { profile, plan, billingPeriod, quotedAmount, currency } = req.body || {};

    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return res.status(400).json({ error: "A configuration is required." });
    }
    if (!profile.organizationName) {
      return res.status(400).json({ error: "The configuration has no organization name." });
    }
    if (!["room", "building", "campus"].includes(plan)) {
      return res.status(400).json({ error: "Pick a plan." });
    }

    const order = await Order.create({
      account: req.account._id,
      profile,
      organizationName: String(profile.organizationName),
      plan,
      billingPeriod: billingPeriod === "monthly" ? "monthly" : "yearly",
      quotedAmount: Number.isFinite(quotedAmount) ? quotedAmount : null,
      currency: currency || "USD",
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

    const { profile, plan, billingPeriod, quotedAmount } = req.body || {};
    if (profile) {
      if (typeof profile !== "object" || Array.isArray(profile) || !profile.organizationName) {
        return res.status(400).json({ error: "That configuration is not valid." });
      }
      order.profile = profile;
      order.organizationName = String(profile.organizationName);
    }
    if (plan) {
      if (!["room", "building", "campus"].includes(plan)) return res.status(400).json({ error: "Unknown plan." });
      order.plan = plan;
    }
    if (billingPeriod) order.billingPeriod = billingPeriod === "monthly" ? "monthly" : "yearly";
    if (Number.isFinite(quotedAmount)) order.quotedAmount = quotedAmount;

    await order.save();
    res.json({ order: summary(order) });
  })
);

/** Hand it over. The only transition a buyer may make. */
router.post(
  "/:id/submit",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await Order.findOne({ _id: req.params.id, account: req.account._id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!ALLOWED_TRANSITIONS[order.status].includes("submitted")) {
      return res.status(409).json({ error: `An order that is ${order.status} cannot be submitted.` });
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

    order.status = "submitted";
    order.history.push({ status: "submitted", by: req.account._id, note: "Submitted by the buyer" });
    await order.save();

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
    if (plan && ["room", "building", "campus"].includes(plan)) filter.plan = plan;

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
 * console (deployments.routes.js) is the one-press path.
 */
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

    if (status && status !== order.status) {
      if (!ALLOWED_TRANSITIONS[order.status]?.includes(status)) {
        return res.status(409).json({
          error: `Cannot go from ${order.status} to ${status}.`,
          allowed: ALLOWED_TRANSITIONS[order.status],
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
      order.status = status;
      order.history.push({ status, by: req.account._id, note });
    }

    if (deploymentUrl !== undefined) order.deploymentUrl = String(deploymentUrl).trim();
    if (provisionedOrganizationId !== undefined) {
      order.provisionedOrganizationId = String(provisionedOrganizationId).trim();
    }

    // Going live without saying where is the one mistake this flow
    // invites, and it is the field the customer actually needs.
    if (order.status === "live" && !order.deploymentUrl) {
      return res.status(400).json({ error: "A live order needs its deployment URL." });
    }

    await order.save();

    const target = { type: "order", id: order._id, label: order.organizationName };
    if (status && status !== previous) {
      await audit(
        req,
        "order.status",
        target,
        `Moved ${order.organizationName} from ${previous} to ${status}${note ? ` — ${note}` : ""}`,
        { from: previous, to: status, note }
      );
    }
    const changed = Object.keys(before).filter((k) => before[k] !== order[k]);
    if (changed.length) {
      await audit(req, "order.update", target, `Updated ${changed.join(" and ")} on ${order.organizationName}`, {
        before,
        after: { deploymentUrl: order.deploymentUrl, provisionedOrganizationId: order.provisionedOrganizationId },
      });
    }

    if (status === "cancelled" && previous !== "cancelled") {
      try {
        await billing.onOrderCancelled(order, { by: req.account, reason: note });
      } catch (err) {
        console.error("[vendor:billing] onOrderCancelled failed for", order._id.toString(), err);
      }
    }

    // Only on an actual change of state — re-saving a URL should not
    // email somebody again.
    if (status && status !== previous) {
      const account = await Account.findById(order.account).select("firstName name email");
      if (account) {
        if (status === "provisioning") sendEmail(orderProvisioningEmail({ account, order }));
        if (status === "live") sendEmail(orderLiveEmail({ account, order }));
        if (status === "cancelled") sendEmail(orderCancelledEmail({ account, order, reason: note }));
      }
    }

    res.json({ order: summary(order) });
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
