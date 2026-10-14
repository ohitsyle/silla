import { Router } from "express";
import mongoose from "mongoose";
import Order, { ALLOWED_TRANSITIONS } from "../models/Order.js";
import Account from "../models/Account.js";
import { requireAccount, requireSilla } from "../middleware/auth.js";
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

router.get(
  "/queue/all",
  requireSilla,
  asyncHandler(async (req, res) => {
    // Drafts are a buyer's private working copy — they are not an order
    // until submitted, and listing them would put half-finished thinking
    // in front of the vendor.
    //
    // The guard used to be `ALLOWED_TRANSITIONS[status] !== undefined`,
    // which reads like a validity check and is one — but "draft" IS a
    // key in that table, so `?status=draft` sailed through it and
    // returned every buyer's private draft along with their email.
    // Verified against the running API before this was changed.
    // Being a known status and being listable are different questions.
    const LISTABLE = ["submitted", "provisioning", "live", "cancelled"];

    const filter = {};
    if (req.query.status && LISTABLE.includes(req.query.status)) {
      filter.status = req.query.status;
    } else {
      filter.status = { $ne: "draft" };
    }

    const orders = await Order.find(filter).sort({ updatedAt: -1 }).limit(200).populate("account", "name email");
    res.json({
      orders: orders.map((o) => ({
        ...summary(o),
        account: o.account ? { name: o.account.name, email: o.account.email } : null,
      })),
    });
  })
);

router.get(
  "/queue/:id",
  requireSilla,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await Order.findById(req.params.id).populate("account", "name email organizationName");
    if (!order || order.status === "draft") return res.status(404).json({ error: "Order not found" });
    res.json({
      order: {
        ...summary(order),
        profile: order.profile,
        history: order.history,
        account: order.account
          ? { name: order.account.name, email: order.account.email, organizationName: order.account.organizationName }
          : null,
      },
    });
  })
);

/** Move an order along. Only through a legal transition. */
router.patch(
  "/queue/:id",
  requireSilla,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid order id" });
    const order = await Order.findById(req.params.id);
    if (!order || order.status === "draft") return res.status(404).json({ error: "Order not found" });

    const { status, note, deploymentUrl, provisionedOrganizationId } = req.body || {};
    const previous = order.status;

    if (status && status !== order.status) {
      if (!ALLOWED_TRANSITIONS[order.status]?.includes(status)) {
        return res.status(409).json({
          error: `Cannot go from ${order.status} to ${status}.`,
          allowed: ALLOWED_TRANSITIONS[order.status],
        });
      }
      order.status = status;
      order.history.push({ status, by: req.account._id, note: String(note || "") });
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

    if (status === "cancelled" && previous !== "cancelled") {
      try {
        await billing.onOrderCancelled(order, { by: req.account, reason: String(note || "") });
      } catch (err) {
        console.error("[vendor:billing] onOrderCancelled failed for", order._id.toString(), err);
      }
    }

    // Only on an actual change of state — re-saving a URL should not
    // email somebody again.
    if (status && status !== previous) {
      const account = await Account.findById(order.account).select("name email");
      if (account) {
        if (status === "provisioning") sendEmail(orderProvisioningEmail({ account, order }));
        if (status === "live") sendEmail(orderLiveEmail({ account, order }));
        if (status === "cancelled") sendEmail(orderCancelledEmail({ account, order, reason: note }));
      }
    }

    res.json({ order: summary(order) });
  })
);

export default router;
