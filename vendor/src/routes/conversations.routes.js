/**
 * Conversations between buyers and SILLA staff. Mounted in app.js at
 * /api/vendor/conversations. See docs/control-plane.md §5.
 *
 *   buyer   GET  /mine               their own threads
 *           GET  /mine/unread        the account menu's badge
 *           POST /                   { subject, body, orderId? }
 *   staff   GET  /inbox              ?status=open|closed|all &scope=all|mine|unassigned &unread=1 &q=
 *           GET  /inbox/counts       the console's sidebar badge
 *           POST /                   { accountId, subject, body, orderId? } — reaching out first
 *           PATCH /:id               { status, assignee }
 *   both    GET  /:id                one thread
 *           POST /:id/messages       buyer { body } · staff { body, internal }
 *           POST /:id/read           clears the caller's side's unread count
 *
 * The shared paths serve whoever asks, but through two separate handlers
 * chosen by role (bySide, below), so the buyer's code path never touches a
 * query that could return an internal note, and the staff one sits behind
 * requirePermission exactly like every other staff route. THE PRIVACY RULE:
 *
 *   - A buyer's thread is found by { _id, account: <them> } — another
 *     buyer's id simply does not match (404), the same IDOR rule as
 *     orders.
 *   - A buyer's messages are read with { internal: false } IN THE QUERY.
 *     Nothing is fetched and then filtered: a filter after the fact is one
 *     refactor away from being dropped, and a query that never returns
 *     the note cannot leak it.
 *   - Internal notes never move `lastMessage*`, `lastStaffMessageAt` or
 *     the buyer's unread count, so neither a preview in the buyer's list
 *     nor an email can carry one.
 */
import { Router } from "express";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Order from "../models/Order.js";
import Account from "../models/Account.js";
import { requireAccount } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requirePermission } from "../middleware/staff.js";
import { audit } from "../lib/audit.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

const isStaff = (req) => req.account.role === "silla";
const reject = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SUBJECT_MAX = 160;
const BODY_MAX = 5000;

/** One line for a list row. Whitespace collapsed so a pasted block doesn't render as a gap. */
const preview = (body) => String(body).replace(/\s+/g, " ").trim().slice(0, 140);

/** Field-keyed problems with a new thread or message, so the form can put each under its input. */
function messageProblems({ subject, body }, { needsSubject }) {
  const fields = {};
  if (needsSubject) {
    const s = String(subject ?? "").trim();
    if (!s) fields.subject = "Add a subject.";
    else if (s.length > SUBJECT_MAX) fields.subject = `Keep the subject under ${SUBJECT_MAX} characters.`;
  }
  const b = String(body ?? "").trim();
  if (!b) fields.body = "Write a message.";
  else if (b.length > BODY_MAX) fields.body = `Keep it under ${BODY_MAX.toLocaleString("en")} characters.`;
  return fields;
}

/**
 * One path, two handlers: a buyer's request goes to `buyer`, a staff
 * member's to `staff` — and only through requirePermission(permission),
 * so a staff role without it gets the same 403 as on any staff route.
 */
function bySide({ buyer, staff, permission }) {
  const guard = requirePermission(permission);
  const forBuyer = asyncHandler(buyer);
  const forStaff = asyncHandler(staff);
  return (req, res, next) => {
    if (!isStaff(req)) return forBuyer(req, res, next);
    return guard(req, res, (err) => (err ? next(err) : forStaff(req, res, next)));
  };
}

/* ─────────────────────────────── shapes ─────────────────────────────── */

const orderRef = (o) =>
  o && typeof o === "object" && o.organizationName
    ? { id: o._id.toString(), organizationName: o.organizationName, status: o.status }
    : null;

/** What a buyer may know about their own thread — no assignee, no staff-side counters. */
const buyerSummary = (c) => ({
  id: c._id.toString(),
  subject: c.subject,
  status: c.status,
  order: orderRef(c.order),
  lastMessageAt: c.lastMessageAt,
  lastMessagePreview: c.lastMessagePreview,
  lastMessageBy: c.lastMessageBy,
  unread: c.unread?.buyer || 0,
  createdAt: c.createdAt,
});

const buyerMessage = (m) => ({
  id: m._id.toString(),
  authorRole: m.authorRole,
  authorName: m.authorName,
  body: m.body,
  createdAt: m.createdAt,
});

const person = (a) =>
  a && typeof a === "object" && a.email
    ? { id: a._id.toString(), name: a.name, email: a.email, organizationName: a.organizationName || "" }
    : null;

const staffSummary = (c) => ({
  ...buyerSummary(c),
  unread: c.unread?.staff || 0,
  // Whether the customer has read our last reply — "seen" in the inbox.
  buyerUnread: c.unread?.buyer || 0,
  account: person(c.account),
  assignee: c.assignee && typeof c.assignee === "object" && c.assignee.email
    ? { id: c.assignee._id.toString(), name: c.assignee.name, email: c.assignee.email }
    : null,
  startedBy: c.startedBy,
  closedAt: c.closedAt,
  notified: c.notified,
});

const staffMessage = (m) => ({
  ...buyerMessage(m),
  author: m.author ? m.author.toString() : null,
  internal: Boolean(m.internal),
});

const populateForStaff = (query) =>
  query
    .populate("account", "name email organizationName")
    .populate("order", "organizationName status")
    .populate("assignee", "name email");

/* ─────────────────────────────── buyer ─────────────────────────────── */

const buyersOnly = (req, res, next) =>
  isStaff(req) ? reject(res, 403, "This is the customer side of conversations. Use the staff inbox.") : next();

/** `?orderId=` narrows it to the threads about one of THEIR orders — the account is still in the query. */
router.get(
  "/mine",
  buyersOnly,
  asyncHandler(async (req, res) => {
    const filter = { account: req.account._id };
    if (req.query.orderId !== undefined) {
      if (!mongoose.isValidObjectId(req.query.orderId)) return reject(res, 400, "Invalid order id");
      filter.order = req.query.orderId;
    }
    const conversations = await Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .populate("order", "organizationName status");
    res.json({
      conversations: conversations.map(buyerSummary),
      unread: conversations.reduce((sum, c) => sum + (c.unread?.buyer || 0), 0),
    });
  })
);

/** Cheap enough to poll from every page that shows the account menu. */
router.get(
  "/mine/unread",
  buyersOnly,
  asyncHandler(async (req, res) => {
    const [row] = await Conversation.aggregate([
      { $match: { account: req.account._id, "unread.buyer": { $gt: 0 } } },
      { $group: { _id: null, unread: { $sum: "$unread.buyer" }, threads: { $sum: 1 } } },
    ]);
    res.json({ unread: row?.unread || 0, threads: row?.threads || 0 });
  })
);

/* ─────────────────────────────── staff inbox ─────────────────────────────── */

const inboxCounts = async (me) => {
  const [open, closed, mine, unassigned, unread] = await Promise.all([
    Conversation.countDocuments({ status: "open" }),
    Conversation.countDocuments({ status: "closed" }),
    Conversation.countDocuments({ status: "open", assignee: me }),
    Conversation.countDocuments({ status: "open", assignee: null }),
    Conversation.countDocuments({ status: "open", "unread.staff": { $gt: 0 } }),
  ]);
  return { open, closed, mine, unassigned, unread };
};

router.get(
  "/inbox",
  requirePermission("conversations.read"),
  asyncHandler(async (req, res) => {
    const { status = "open", scope = "all", q } = req.query;
    const filter = {};
    if (status === "open" || status === "closed") filter.status = status;
    if (scope === "mine") filter.assignee = req.account._id;
    if (scope === "unassigned") filter.assignee = null;
    if (req.query.unread === "1" || req.query.unread === "true") filter["unread.staff"] = { $gt: 0 };
    if (req.query.accountId && mongoose.isValidObjectId(req.query.accountId)) filter.account = req.query.accountId;
    if (req.query.orderId && mongoose.isValidObjectId(req.query.orderId)) filter.order = req.query.orderId;

    if (q && String(q).trim()) {
      const rx = { $regex: escapeRegex(String(q).trim().slice(0, 80)), $options: "i" };
      const people = await Account.find({ role: "buyer", $or: [{ email: rx }, { name: rx }, { organizationName: rx }] })
        .select("_id")
        .limit(500);
      filter.$or = [{ subject: rx }, { lastMessagePreview: rx }, { account: { $in: people.map((p) => p._id) } }];
    }

    const [conversations, counts] = await Promise.all([
      populateForStaff(Conversation.find(filter).sort({ lastMessageAt: -1 }).limit(200)),
      inboxCounts(req.account._id),
    ]);
    res.json({ conversations: conversations.map(staffSummary), counts });
  })
);

router.get(
  "/inbox/counts",
  requirePermission("conversations.read"),
  asyncHandler(async (req, res) => res.json({ counts: await inboxCounts(req.account._id) }))
);

/* ───────────────────────────── starting one ───────────────────────────── */

/**
 * Opens a thread with its first message — always a PUBLIC one, whoever
 * starts it. `customer` is whose thread it is; `order`, if any, has
 * already been found scoped to that customer.
 */
async function openThread(req, res, { customer, order, staff }) {
  const now = new Date();
  const text = String(req.body.body).trim();
  const conversation = await Conversation.create({
    account: customer._id,
    order: order?._id || null,
    subject: String(req.body.subject).trim(),
    status: "open",
    // Whoever reaches out first owns the thread until someone reassigns it.
    assignee: staff ? req.account._id : null,
    startedBy: staff ? "staff" : "buyer",
    lastMessageAt: now,
    lastMessagePreview: preview(text),
    lastMessageBy: staff ? "staff" : "buyer",
    lastBuyerMessageAt: staff ? null : now,
    lastStaffMessageAt: staff ? now : null,
    unread: { buyer: staff ? 1 : 0, staff: staff ? 0 : 1 },
  });
  await Message.create({
    conversation: conversation._id,
    author: req.account._id,
    authorRole: staff ? "staff" : "buyer",
    authorName: req.account.name,
    body: text,
    internal: false,
  });
  return conversation;
}

/**
 * The order a new thread is about, found with the CUSTOMER in the query:
 * a buyer cannot attach their thread to someone else's order by guessing
 * its id, and staff cannot file one customer's thread under another's.
 * A draft may be asked about — the buyer is choosing to share it.
 */
async function orderFor(res, orderId, customer) {
  if (!orderId) return { ok: true, order: null };
  if (!mongoose.isValidObjectId(orderId)) {
    reject(res, 400, "Invalid order id");
    return { ok: false };
  }
  const order = await Order.findOne({ _id: orderId, account: customer._id }).select("organizationName status");
  if (!order) {
    reject(res, 404, "Order not found");
    return { ok: false };
  }
  return { ok: true, order };
}

const startProblems = (req, res) => {
  const fields = messageProblems(req.body || {}, { needsSubject: true });
  if (!Object.keys(fields).length) return false;
  reject(res, 400, Object.values(fields)[0], { fields });
  return true;
};

router.post(
  "/",
  rateLimit({
    name: "conversation-start",
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyFor: (req) => req.account._id.toString(),
  }),
  bySide({
    permission: "conversations.reply",

    // A buyer, from their account or an order.
    buyer: async (req, res) => {
      if (startProblems(req, res)) return;
      const found = await orderFor(res, req.body.orderId, req.account);
      if (!found.ok) return;
      const conversation = await openThread(req, res, { customer: req.account, order: found.order, staff: false });
      await conversation.populate("order", "organizationName status");
      res.status(201).json({ conversation: buyerSummary(conversation) });
    },

    // Staff reaching out first, to the customer they name.
    staff: async (req, res) => {
      if (startProblems(req, res)) return;
      if (!mongoose.isValidObjectId(req.body.accountId)) {
        return reject(res, 400, "Choose the customer to write to.", { fields: { accountId: "Choose the customer to write to." } });
      }
      const customer = await Account.findOne({ _id: req.body.accountId, role: "buyer" });
      if (!customer) return reject(res, 404, "Customer not found");
      const found = await orderFor(res, req.body.orderId, customer);
      if (!found.ok) return;

      const conversation = await openThread(req, res, { customer, order: found.order, staff: true });
      await audit(
        req,
        "conversation.start",
        { type: "conversation", id: conversation._id, label: conversation.subject },
        `Wrote to ${customer.name} <${customer.email}>: “${conversation.subject}”`,
        { accountId: customer._id.toString(), orderId: found.order?._id?.toString() || null }
      );
      const full = await populateForStaff(Conversation.findById(conversation._id));
      res.status(201).json({ conversation: staffSummary(full) });
    },
  })
);

/* ───────────────────────────── one thread ───────────────────────────── */

const validId = (req, res, next) =>
  mongoose.isValidObjectId(req.params.id) ? next() : reject(res, 400, "Invalid conversation id");

/** The buyer's thread: theirs by query, public messages by query. */
async function buyerThread(req, res) {
  const conversation = await Conversation.findOne({ _id: req.params.id, account: req.account._id }).populate(
    "order",
    "organizationName status"
  );
  if (!conversation) return reject(res, 404, "Conversation not found");
  const messages = await Message.find({ conversation: conversation._id, internal: false }).sort({ createdAt: 1 });
  res.json({ conversation: buyerSummary(conversation), messages: messages.map(buyerMessage) });
}

async function staffThread(req, res) {
  const conversation = await populateForStaff(Conversation.findById(req.params.id));
  if (!conversation) return reject(res, 404, "Conversation not found");
  const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 });
  res.json({ conversation: staffSummary(conversation), messages: messages.map(staffMessage) });
}

router.get("/:id", validId, bySide({ buyer: buyerThread, staff: staffThread, permission: "conversations.read" }));

/* ───────────────────────────── writing ───────────────────────────── */

async function buyerReply(req, res) {
  const fields = messageProblems(req.body || {}, { needsSubject: false });
  if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], { fields });

  const text = String(req.body.body).trim();
  const now = new Date();
  // Scoped by account in the same update that writes it: there is no
  // moment where someone else's thread is loaded and then checked.
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, account: req.account._id },
    {
      $inc: { "unread.staff": 1 },
      $set: {
        // Writing a reply means they have read the thread.
        "unread.buyer": 0,
        lastMessageAt: now,
        lastMessagePreview: preview(text),
        lastMessageBy: "buyer",
        lastBuyerMessageAt: now,
        // A customer writing into a closed thread has reopened it.
        status: "open",
        closedAt: null,
      },
    },
    { new: true }
  ).populate("order", "organizationName status");
  if (!conversation) return reject(res, 404, "Conversation not found");

  const message = await Message.create({
    conversation: conversation._id,
    author: req.account._id,
    authorRole: "buyer",
    authorName: req.account.name,
    body: text,
    internal: false,
  });
  res.status(201).json({ conversation: buyerSummary(conversation), message: buyerMessage(message) });
}

async function staffReply(req, res) {
  const fields = messageProblems(req.body || {}, { needsSubject: false });
  if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], { fields });

  const internal = req.body.internal === true;
  const text = String(req.body.body).trim();
  const now = new Date();

  const existing = await Conversation.findById(req.params.id).select("assignee subject account");
  if (!existing) return reject(res, 404, "Conversation not found");

  // An internal note touches nothing the customer can see: not the
  // preview, not their unread count, not the time the notification job
  // keys on. Writing anything does mean staff have read the thread.
  const update = internal
    ? { $set: { "unread.staff": 0 } }
    : {
        $inc: { "unread.buyer": 1 },
        $set: {
          "unread.staff": 0,
          lastMessageAt: now,
          lastMessagePreview: preview(text),
          lastMessageBy: "staff",
          lastStaffMessageAt: now,
          status: "open",
          closedAt: null,
          // The first public reply claims an unassigned thread, so the
          // next customer message has someone to notify.
          ...(existing.assignee ? {} : { assignee: req.account._id }),
        },
      };
  await Conversation.updateOne({ _id: existing._id }, update);

  const message = await Message.create({
    conversation: existing._id,
    author: req.account._id,
    authorRole: "staff",
    authorName: req.account.name,
    body: text,
    internal,
  });

  const customer = await Account.findById(existing.account).select("name email");
  await audit(
    req,
    internal ? "conversation.note" : "conversation.reply",
    { type: "conversation", id: existing._id, label: existing.subject },
    internal
      ? `Added an internal note to “${existing.subject}”`
      : `Replied to ${customer?.name || "a customer"} on “${existing.subject}”`,
    { messageId: message._id.toString(), ...(internal || existing.assignee ? {} : { assignedTo: req.account.email }) }
  );

  const conversation = await populateForStaff(Conversation.findById(existing._id));
  res.status(201).json({ conversation: staffSummary(conversation), message: staffMessage(message) });
}

router.post(
  "/:id/messages",
  validId,
  rateLimit({ name: "conversation-message", windowMs: 10 * 60 * 1000, max: 60, keyFor: (req) => req.account._id.toString() }),
  bySide({ buyer: buyerReply, staff: staffReply, permission: "conversations.reply" })
);

/**
 * Clears the CALLER's side only: a buyer reading never marks the staff side
 * read, and vice versa. Not audited — reading is not a change to anything
 * the customer has, and a log entry per glance would bury the ones that are.
 */
router.post(
  "/:id/read",
  validId,
  bySide({
    permission: "conversations.read",
    buyer: async (req, res) => {
      const result = await Conversation.updateOne(
        { _id: req.params.id, account: req.account._id },
        { $set: { "unread.buyer": 0 } }
      );
      if (!result.matchedCount) return reject(res, 404, "Conversation not found");
      res.json({ ok: true });
    },
    staff: async (req, res) => {
      const result = await Conversation.updateOne({ _id: req.params.id }, { $set: { "unread.staff": 0 } });
      if (!result.matchedCount) return reject(res, 404, "Conversation not found");
      res.json({ ok: true });
    },
  })
);

/* ───────────────────────────── handling ───────────────────────────── */

/** Close or reopen a thread, and say who has it. Staff only. */
router.patch(
  "/:id",
  validId,
  requirePermission("conversations.reply"),
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    const hasAssignee = Object.prototype.hasOwnProperty.call(req.body || {}, "assignee");
    if (status !== undefined && !["open", "closed"].includes(status)) return reject(res, 400, "Status is open or closed.");
    if (status === undefined && !hasAssignee) return reject(res, 400, "Nothing to change.");

    const conversation = await Conversation.findById(req.params.id).populate("assignee", "name email");
    if (!conversation) return reject(res, 404, "Conversation not found");
    const target = { type: "conversation", id: conversation._id, label: conversation.subject };

    let assignee = conversation.assignee;
    if (hasAssignee) {
      const wanted = req.body.assignee;
      if (wanted === null || wanted === "") assignee = null;
      else {
        if (!mongoose.isValidObjectId(wanted)) return reject(res, 400, "Invalid assignee");
        assignee = await Account.findOne({ _id: wanted, role: "silla", active: true, emailVerified: true }).select("name email");
        if (!assignee) return reject(res, 400, "Assign it to an active member of staff.");
      }
    }

    const events = [];
    const previousAssignee = conversation.assignee;
    if (hasAssignee && String(previousAssignee?._id || "") !== String(assignee?._id || "")) {
      conversation.assignee = assignee?._id || null;
      events.push([
        "conversation.assign",
        assignee ? `Assigned “${conversation.subject}” to ${assignee.name}` : `Unassigned “${conversation.subject}”`,
        { from: previousAssignee?.email || null, to: assignee?.email || null },
      ]);
    }
    if (status && status !== conversation.status) {
      conversation.status = status;
      conversation.closedAt = status === "closed" ? new Date() : null;
      events.push([
        "conversation.status",
        `${status === "closed" ? "Closed" : "Reopened"} “${conversation.subject}”`,
        { to: status },
      ]);
    }
    await conversation.save();
    for (const [action, summary, meta] of events) await audit(req, action, target, summary, meta);

    const fresh = await populateForStaff(Conversation.findById(conversation._id));
    res.json({ conversation: staffSummary(fresh) });
  })
);

export default router;
