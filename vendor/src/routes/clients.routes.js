/**
 * The client directory for the staff console: every buyer account, and
 * for one of them the whole picture in a single answer. Mounted in
 * app.js at /api/vendor/clients. See docs/control-plane.md §5.
 *
 * Read-only. A client's orders, conversations and deployments are
 * changed in their own sections, through routes that audit; this is the
 * place to find them, not a second door to edit them.
 *
 * A buyer's DRAFTS stay out of it, as they stay out of the queue: an
 * unsubmitted configuration is their working copy, not an order.
 */
import { Router } from "express";
import mongoose from "mongoose";
import Account from "../models/Account.js";
import Order from "../models/Order.js";
import Conversation from "../models/Conversation.js";
import AuditEvent from "../models/AuditEvent.js";
// Read for display only — billing owns these (services/billing.js).
import Subscription, { SUBSCRIPTION_STATUS } from "../models/Subscription.js";
import Invoice from "../models/Invoice.js";
import { requireAccount } from "../middleware/auth.js";
import { can, requirePermission } from "../middleware/staff.js";
import { eventShape } from "./audit.routes.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount, requirePermission("clients.read"));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAGE_SIZE = 50;

/**
 * GET /api/vendor/clients
 *   ?q=harborview           name, email or organization
 *   ?filter=live            has a live deployment
 *   ?filter=unverified      has not proved their email (cannot submit an order)
 *   ?subscription=past_due  has a subscription in that state ("none" = no subscription)
 *   ?page=2
 *
 * Sorted by last activity — the most recent of signing in, an order
 * moving, or a message — so the clients who need attention now are at
 * the top rather than whoever registered most recently.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const match = { role: "buyer" };
    const and = [];

    if (req.query.q && String(req.query.q).trim()) {
      const rx = { $regex: escapeRegex(String(req.query.q).trim().slice(0, 80)), $options: "i" };
      and.push({ $or: [{ email: rx }, { name: rx }, { organizationName: rx }] });
    }
    if (req.query.filter === "live") {
      and.push({ _id: { $in: await Order.distinct("account", { status: "live" }) } });
    } else if (req.query.filter === "unverified") {
      and.push({ emailVerified: false });
    }
    const subStatus = String(req.query.subscription || "");
    if (subStatus === "none") {
      and.push({ _id: { $nin: await Subscription.distinct("account") } });
    } else if (SUBSCRIPTION_STATUS.includes(subStatus)) {
      and.push({ _id: { $in: await Subscription.distinct("account", { status: subStatus }) } });
    }
    if (and.length) match.$and = and;

    const [result] = await Account.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "account",
          as: "orders",
          pipeline: [{ $match: { status: { $ne: "draft" } } }, { $project: { status: 1, updatedAt: 1 } }],
        },
      },
      {
        $lookup: {
          from: "conversations",
          localField: "_id",
          foreignField: "account",
          as: "conversations",
          pipeline: [{ $project: { status: 1, lastMessageAt: 1, "unread.staff": 1 } }],
        },
      },
      {
        $addFields: {
          lastActivityAt: {
            $max: ["$createdAt", "$lastLoginAt", { $max: "$orders.updatedAt" }, { $max: "$conversations.lastMessageAt" }],
          },
        },
      },
      { $sort: { lastActivityAt: -1, _id: -1 } },
      {
        $facet: {
          rows: [{ $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }],
          total: [{ $count: "n" }],
        },
      },
    ]);
    const rows = result?.rows || [];

    const subs = await Subscription.find({ account: { $in: rows.map((r) => r._id) } }).select("account status").lean();
    const subsBy = new Map();
    for (const s of subs) {
      const key = s.account.toString();
      subsBy.set(key, [...(subsBy.get(key) || []), s.status]);
    }

    const [all, unverified, liveIds] = await Promise.all([
      Account.countDocuments({ role: "buyer" }),
      Account.countDocuments({ role: "buyer", emailVerified: false }),
      Order.distinct("account", { status: "live" }),
    ]);

    res.json({
      clients: rows.map((a) => ({
        id: a._id.toString(),
        name: a.name,
        email: a.email,
        organizationName: a.organizationName || "",
        emailVerified: Boolean(a.emailVerified),
        active: a.active !== false,
        createdAt: a.createdAt,
        lastLoginAt: a.lastLoginAt || null,
        lastActivityAt: a.lastActivityAt || a.createdAt,
        counts: {
          orders: a.orders.length,
          live: a.orders.filter((o) => o.status === "live").length,
          open: a.orders.filter((o) => o.status === "submitted" || o.status === "provisioning").length,
          conversations: a.conversations.filter((c) => c.status === "open").length,
          unread: a.conversations.reduce((sum, c) => sum + (c.unread?.staff || 0), 0),
        },
        subscriptions: subsBy.get(a._id.toString()) || [],
      })),
      total: result?.total?.[0]?.n || 0,
      page,
      pageSize: PAGE_SIZE,
      counts: { all, unverified, live: liveIds.length },
    });
  })
);

/**
 * One client, whole: who they are and where invoices go, every order
 * they have submitted, their subscriptions (status only — the money is
 * in Subscriptions and Invoices), their conversations, their deployments,
 * and the trail of everything staff have done to any of it.
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid client id" });
    const account = await Account.findOne({ _id: req.params.id, role: "buyer" });
    if (!account) return res.status(404).json({ error: "Client not found" });

    const showMoney = can(req.account, "billing.read");
    const [orders, drafts, subs, conversations, invoices] = await Promise.all([
      Order.find({ account: account._id, status: { $ne: "draft" } }).sort({ updatedAt: -1 }),
      Order.countDocuments({ account: account._id, status: "draft" }),
      Subscription.find({ account: account._id }).sort({ createdAt: -1 }),
      Conversation.find({ account: account._id }).sort({ lastMessageAt: -1 }).populate("assignee", "name email"),
      showMoney ? Invoice.find({ account: account._id }).sort({ issuedAt: -1 }).limit(25) : Promise.resolve([]),
    ]);

    // The activity trail: anything staff did to this account, or to
    // anything that belongs to it. Targets are recorded by id (lib/audit.js),
    // so the trail follows the records rather than a name that can change.
    const ids = [
      ...orders.map((o) => o._id.toString()),
      ...subs.map((s) => s._id.toString()),
      ...conversations.map((c) => c._id.toString()),
      ...invoices.map((i) => i._id.toString()),
    ];
    const activity = await AuditEvent.find({
      $or: [{ "target.type": "account", "target.id": account._id.toString() }, { "target.id": { $in: ids } }],
    })
      .sort({ at: -1 })
      .limit(60)
      .lean();

    const now = Date.now();
    res.json({
      client: {
        id: account._id.toString(),
        name: account.name,
        firstName: account.firstName,
        middleName: account.middleName,
        lastName: account.lastName,
        suffix: account.suffix,
        email: account.email,
        organizationName: account.organizationName,
        emailVerified: Boolean(account.emailVerified),
        emailVerifiedAt: account.emailVerifiedAt,
        active: account.active,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
        termsAcceptedAt: account.termsAcceptedAt,
        termsVersion: account.termsVersion,
        billing: account.billing || {},
      },
      drafts,
      orders: orders.map((o) => ({
        id: o._id.toString(),
        organizationName: o.organizationName,
        plan: o.plan,
        billingPeriod: o.billingPeriod,
        quotedAmount: o.quotedAmount,
        currency: o.currency,
        status: o.status,
        deploymentUrl: o.deploymentUrl,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
      subscriptions: subs.map((s) => ({
        id: s._id.toString(),
        order: s.order?.toString() || null,
        organizationName: s.organizationName,
        plan: s.plan,
        planName: s.planName,
        billingPeriod: s.billingPeriod,
        status: s.status,
        trialEndsAt: s.trialEndsAt,
        currentPeriodEnd: s.currentPeriodEnd,
        graceEndsAt: s.graceEndsAt,
        sync: { syncedAt: s.sync?.syncedAt || null, error: s.sync?.error || null },
      })),
      invoices: showMoney
        ? invoices.map((i) => ({
            id: i._id.toString(),
            number: i.number,
            status: i.status,
            total: i.total,
            currency: i.currency,
            issuedAt: i.issuedAt,
            dueAt: i.dueAt,
            paidAt: i.paidAt,
            overdue: i.status === "open" && i.dueAt && new Date(i.dueAt).getTime() < now,
          }))
        : null,
      conversations: conversations.map((c) => ({
        id: c._id.toString(),
        subject: c.subject,
        status: c.status,
        order: c.order ? c.order.toString() : null,
        unread: c.unread?.staff || 0,
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        lastMessageBy: c.lastMessageBy,
        assignee: c.assignee?.email ? { id: c.assignee._id.toString(), name: c.assignee.name } : null,
      })),
      deployments: orders
        .filter((o) => o.provisionedOrganizationId)
        .map((o) => ({
          orderId: o._id.toString(),
          organizationName: o.organizationName,
          organizationId: o.provisionedOrganizationId,
          slug: o.deploymentSlug || "",
          url: o.deploymentUrl,
          provisionedAt: o.provisionedAt || null,
          subscriptionStatus: subs.find((s) => s.order?.equals(o._id))?.status || null,
        })),
      activity: activity.map(eventShape),
    });
  })
);

export default router;
