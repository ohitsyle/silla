/**
 * SILLA staff themselves: who is signed in and what they may do, the
 * console's overview, and (for owners) inviting, re-roling and
 * deactivating staff. Mounted in app.js at /api/vendor/staff.
 * See docs/control-plane.md §5.
 *
 * How staff come to exist changed here. They used to exist ONLY through
 * `npm run seed:staff`, on the reasoning that an HTTP route able to mint
 * staff is a back door however carefully it is guarded. That reasoning
 * still decides the shape of this file:
 *
 *   - The FIRST owner still comes from seed:staff. No route can create a
 *     staff account from nothing; POST /invite needs a signed-in owner,
 *     and `staff.manage` is held by owners alone (middleware/staff.js).
 *   - An invitation does not hand anyone access. It creates a locked
 *     account (random password) and emails a one-time code to the
 *     invited ADDRESS; only someone who can read that inbox can set a
 *     password. The code is bcrypt-hashed, single-use and expires.
 *   - Every invite, re-send, acceptance, role change and deactivation
 *     writes an AuditEvent, so the question "who let this person in"
 *     always has an answer.
 *   - Nobody can change their own role or access, and the last active
 *     owner can never be demoted or deactivated — see ownerGuard below.
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import Account from "../models/Account.js";
import Order from "../models/Order.js";
import Conversation from "../models/Conversation.js";
import AuditEvent from "../models/AuditEvent.js";
// Read for display only — billing owns these (services/billing.js).
import Subscription from "../models/Subscription.js";
import Invoice from "../models/Invoice.js";
import { requireAccount } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { STAFF_ROLES, can, permissionsOf, requirePermission, staffRoleOf } from "../middleware/staff.js";
import { consumeCode, cooldownRemaining, issueCode, ttlMinutesFor } from "../lib/codes.js";
import { audit } from "../lib/audit.js";
import { sendEmail } from "../services/email/index.js";
import { staffInvitationEmail } from "../services/email/staffTemplates.js";
import { planNameOf } from "./order.routes.js";

const router = Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normEmail = (value) => String(value || "").trim().toLowerCase();
const clean = (value, max = 80) => String(value ?? "").trim().slice(0, max);
const reject = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

/** The same rule as auth.routes.js: length only, 10 to 200 characters. */
function passwordProblem(password) {
  const pw = String(password || "");
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}

/**
 * Said in an invitation email, so the person knows what they are being
 * let into. Mirrors the table in docs/control-plane.md §5, which
 * middleware/staff.js enforces.
 */
const ROLE_LABEL = { owner: "Owner", admin: "Admin", billing: "Billing", support: "Support" };
const ROLE_SUMMARY = {
  owner: "everything in the console, including staff and settings",
  admin: "orders, provisioning, deployments, billing, plans, settings and the activity log",
  billing: "plans, subscriptions, invoices and payments",
  support: "orders, clients, conversations and owner-access resets",
};

/** Invited, and the address not yet proved — accepting is what proves it. */
const isPending = (a) => Boolean(a.invitedAt) && !a.emailVerified;

const statusOf = (a) => (!a.active ? "deactivated" : isPending(a) ? "invited" : "active");

/** What the console may know about a staff member. Never a hash, never a code. */
function staffShape(a, viewer) {
  const live = a.verification?.purpose === "invite" ? a.verification : null;
  return {
    id: a._id.toString(),
    email: a.email,
    name: a.name,
    firstName: a.firstName,
    lastName: a.lastName,
    staffRole: staffRoleOf(a),
    status: statusOf(a),
    active: a.active,
    invitedAt: a.invitedAt,
    invitedBy: a.invitedBy && typeof a.invitedBy === "object" && a.invitedBy.email
      ? { id: a.invitedBy._id.toString(), name: a.invitedBy.name, email: a.invitedBy.email }
      : null,
    inviteAcceptedAt: a.inviteAcceptedAt,
    inviteExpiresAt: isPending(a) && live ? live.expiresAt : null,
    deactivatedAt: a.deactivatedAt,
    lastLoginAt: a.lastLoginAt,
    createdAt: a.createdAt,
    isYou: viewer ? a._id.equals(viewer._id) : false,
  };
}

/** An owner, in the sense the guard below means: can sign in today and holds the role. */
const ACTIVE_OWNER = {
  role: "silla",
  active: true,
  emailVerified: true,
  // A staff account from before roles existed has no staffRole and is
  // treated as an owner (staffRoleOf) — it counts here too.
  $or: [{ staffRole: "owner" }, { staffRole: null }],
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ─────────────────────────────── me ─────────────────────────────── */

/**
 * The console asks this once on load and shows only the sections whose
 * permission is listed — so a support agent is never offered a button
 * that would answer 403.
 */
router.get(
  "/me",
  requireAccount,
  asyncHandler(async (req, res) => {
    const role = staffRoleOf(req.account);
    if (!role) return res.status(403).json({ error: "SILLA staff only" });
    res.json({
      id: req.account._id.toString(),
      name: req.account.name,
      email: req.account.email,
      staffRole: role,
      permissions: permissionsOf(req.account),
    });
  })
);

/* ──────────────────────────── directory ──────────────────────────── */

/**
 * Every active staff member, for pickers: who a conversation can be
 * assigned to, whose actions to filter the activity log by. Readable by
 * every role — assigning a thread to a colleague should not need the
 * owner-only staff list.
 */
router.get(
  "/directory",
  requireAccount,
  requirePermission("conversations.read"),
  asyncHandler(async (req, res) => {
    const staff = await Account.find({ role: "silla", active: true, emailVerified: true })
      .select("firstName lastName name email staffRole")
      .sort({ firstName: 1, name: 1 });
    res.json({
      staff: staff.map((a) => ({
        id: a._id.toString(),
        name: a.name,
        email: a.email,
        staffRole: staffRoleOf(a),
        isYou: a._id.equals(req.account._id),
      })),
    });
  })
);

/* ──────────────────────────── overview ──────────────────────────── */

/**
 * The console's first screen: what is waiting, at a glance.
 *
 * Gated like the Overview section itself (orders.read, every role), and
 * then trimmed per permission: the money figures appear only for those
 * who hold billing.read, the activity feed only for audit.read. A support
 * agent sees orders and conversations, which is their day.
 */
router.get(
  "/overview",
  requireAccount,
  requirePermission("orders.read"),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const me = req.account._id;

    const [byStatus, waiting, openConvos, unreadConvos, unassigned, mine, deployments, syncErrors] = await Promise.all([
      Order.aggregate([{ $match: { status: { $ne: "draft" } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      // Oldest first: the order that has waited longest is the one to pick up.
      Order.find({ status: { $in: ["submitted", "provisioning"] } })
        .sort({ updatedAt: 1 })
        .limit(6)
        .populate("account", "name email"),
      Conversation.countDocuments({ status: "open" }),
      Conversation.countDocuments({ status: "open", "unread.staff": { $gt: 0 } }),
      Conversation.countDocuments({ status: "open", assignee: null }),
      Conversation.countDocuments({ status: "open", assignee: me }),
      Order.countDocuments({ provisionedOrganizationId: { $ne: "" } }),
      Subscription.countDocuments({ organizationId: { $ne: "" }, "sync.error": { $ne: null } }),
    ]);

    const orders = { submitted: 0, provisioning: 0, live: 0, cancelled: 0 };
    for (const row of byStatus) if (row._id in orders) orders[row._id] = row.n;

    let billing = null;
    if (can(req.account, "billing.read")) {
      const [subs, overdue] = await Promise.all([
        Subscription.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
        // `overdue` is computed from the clock, never stored (models/Invoice.js).
        Invoice.aggregate([
          { $match: { status: "open", dueAt: { $lt: now } } },
          { $group: { _id: "$currency", n: { $sum: 1 }, total: { $sum: "$total" } } },
        ]),
      ]);
      billing = {
        subscriptions: Object.fromEntries(subs.map((r) => [r._id, r.n])),
        overdueInvoices: overdue.reduce((sum, r) => sum + r.n, 0),
        overdueByCurrency: overdue.map((r) => ({ currency: r._id, count: r.n, total: r.total })),
      };
    }

    let recent = null;
    if (can(req.account, "audit.read")) {
      const events = await AuditEvent.find({}).sort({ at: -1 }).limit(8).lean();
      recent = events.map((e) => ({
        id: e._id.toString(),
        at: e.at,
        actorEmail: e.actorEmail,
        actorRole: e.actorRole,
        action: e.action,
        target: e.target,
        summary: e.summary,
      }));
    }

    res.json({
      orders,
      waiting: waiting.map((o) => ({
        id: o._id.toString(),
        organizationName: o.organizationName,
        status: o.status,
        plan: o.plan,
        planName: planNameOf(o),
        updatedAt: o.updatedAt,
        account: o.account ? { name: o.account.name, email: o.account.email } : null,
      })),
      conversations: { open: openConvos, unread: unreadConvos, unassigned, mine },
      deployments: { total: deployments, syncErrors },
      billing,
      recent,
    });
  })
);

/* ─────────────────────────── staff management ─────────────────────────── */

router.get(
  "/",
  requireAccount,
  requirePermission("staff.manage"),
  asyncHandler(async (req, res) => {
    const staff = await Account.find({ role: "silla" })
      .populate("invitedBy", "name email")
      .sort({ active: -1, createdAt: 1 });
    res.json({ staff: staff.map((a) => staffShape(a, req.account)), roles: STAFF_ROLES });
  })
);

/**
 * Invite someone into the console.
 *
 * Creates the account straight away — locked behind a random password
 * nobody is told — so it can be listed, re-sent and revoked like any
 * other. The emailed code is what turns it into a working sign-in.
 */
router.post(
  "/invite",
  requireAccount,
  requirePermission("staff.manage"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const fields = {};
    const firstName = clean(body.firstName);
    const lastName = clean(body.lastName);
    const email = normEmail(body.email);
    if (!firstName) fields.firstName = "Enter their first name.";
    if (!lastName) fields.lastName = "Enter their last name.";
    if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";
    if (!STAFF_ROLES.includes(body.staffRole)) fields.staffRole = "Choose a role.";
    if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], { fields });

    const existing = await Account.findOne({ email }).select("role active");
    if (existing) {
      // A customer is never quietly turned into staff: the same address
      // would then carry both a buyer's orders and the whole queue.
      const message =
        existing.role === "buyer"
          ? "That address belongs to a customer account. Invite a different address."
          : existing.active
            ? "That person is already on the staff list."
            : "That person is on the staff list, deactivated. Reactivate them there instead.";
      return reject(res, 409, message, { fields: { email: message } });
    }

    const account = new Account({
      firstName,
      lastName,
      email,
      role: "silla",
      staffRole: body.staffRole,
      // Random and never disclosed: the account cannot be signed in to
      // until the invitation code replaces this with a real password.
      passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
      emailVerified: false,
      invitedAt: new Date(),
      invitedBy: req.account._id,
      active: true,
    });
    const code = await issueCode(account, "invite");
    await account.save();

    sendEmail(
      staffInvitationEmail({
        account,
        code,
        invitedBy: req.account,
        roleLabel: ROLE_LABEL[body.staffRole],
        roleSummary: ROLE_SUMMARY[body.staffRole],
        expiryHours: Math.round(ttlMinutesFor("invite") / 60),
      })
    );

    await audit(
      req,
      "staff.invite",
      { type: "staff", id: account._id, label: account.name },
      `Invited ${account.name} <${account.email}> as ${ROLE_LABEL[body.staffRole].toLowerCase()}`,
      { email: account.email, staffRole: body.staffRole }
    );

    await account.populate("invitedBy", "name email");
    res.status(201).json({ staff: staffShape(account, req.account) });
  })
);

/** A fresh code for a pending invitation — the first email went missing, or it lapsed. */
router.post(
  "/:id/resend-invite",
  requireAccount,
  requirePermission("staff.manage"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return reject(res, 400, "Invalid staff id");
    const account = await Account.findOne({ _id: req.params.id, role: "silla" });
    if (!account) return reject(res, 404, "Staff member not found");
    if (!account.active) return reject(res, 409, "Reactivate them before sending a new invitation.");
    if (!isPending(account)) return reject(res, 409, "They have already accepted their invitation.");

    const wait = cooldownRemaining(account, "invite");
    if (wait) return reject(res, 429, `You can send another invitation in ${wait} seconds.`, { retryAfterSeconds: wait });

    const code = await issueCode(account, "invite");
    await account.save();
    const role = staffRoleOf(account);
    sendEmail(
      staffInvitationEmail({
        account,
        code,
        invitedBy: req.account,
        roleLabel: ROLE_LABEL[role],
        roleSummary: ROLE_SUMMARY[role],
        expiryHours: Math.round(ttlMinutesFor("invite") / 60),
      })
    );

    await audit(
      req,
      "staff.invite.resend",
      { type: "staff", id: account._id, label: account.name },
      `Sent ${account.name} a new invitation`,
      { email: account.email }
    );

    await account.populate("invitedBy", "name email");
    res.json({ staff: staffShape(account, req.account) });
  })
);

/**
 * Change a staff member's role, or their access.
 *
 * Two rules, both enforced here rather than trusted to the console:
 *
 * NEVER YOURSELF. An owner demoting themselves by accident has no way
 * back, and an account that can widen its own role needs no attacker.
 *
 * NEVER THE LAST ACTIVE OWNER. Read naively this can never fire: only an
 * owner holds staff.manage, and they cannot target themselves, so some
 * other owner always remains. Except under concurrency — two owners
 * demoting EACH OTHER at the same moment would each see the other's
 * request as leaving one owner, and both would commit. A transaction
 * alone does not stop that (snapshot isolation permits exactly this
 * write skew; see the RES-2 note in CLAUDE.md), so each transaction also
 * WRITES the acting owner's own document. The two now collide on a real
 * write, one is retried against a fresh snapshot, and on the retry its
 * actor is no longer an owner. The count afterwards is the belt to that
 * pair of braces. Recovery from a console with no owner at all remains
 * `npm run seed:staff`.
 */
router.patch(
  "/:id",
  requireAccount,
  requirePermission("staff.manage"),
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return reject(res, 400, "Invalid staff id");
    const { staffRole } = req.body || {};
    const active = req.body?.active;

    if (staffRole !== undefined && !STAFF_ROLES.includes(staffRole)) {
      return reject(res, 400, "Choose a role.", { fields: { staffRole: "Choose a role." } });
    }
    if (active !== undefined && typeof active !== "boolean") return reject(res, 400, "`active` must be true or false.");
    if (staffRole === undefined && active === undefined) return reject(res, 400, "Nothing to change.");

    if (req.account._id.equals(req.params.id)) {
      return reject(res, 409, "You can't change your own role or access. Ask another owner.", { code: "SELF" });
    }

    let before;
    let after;
    let label;
    try {
      await mongoose.connection.transaction(async (session) => {
        const actor = await Account.findById(req.account._id).session(session);
        if (!actor?.active || !can(actor, "staff.manage")) {
          throw new HttpError(403, "You don't have access to that.", { code: "STAFF_PERMISSION" });
        }
        const target = await Account.findOne({ _id: req.params.id, role: "silla" }).session(session);
        if (!target) throw new HttpError(404, "Staff member not found");

        before = { staffRole: staffRoleOf(target), active: target.active };
        after = {
          staffRole: staffRole ?? before.staffRole,
          active: active ?? before.active,
        };
        label = target.name || target.email;

        const set = { staffRole: after.staffRole, active: after.active };
        if (before.active && !after.active) {
          set.deactivatedAt = new Date();
          // Deactivating someone who never accepted revokes the invitation:
          // their code dies with it, and reactivating needs a fresh one.
          if (isPending(target)) set.verification = null;
        }
        if (!before.active && after.active) set.deactivatedAt = null;
        await Account.updateOne({ _id: target._id }, { $set: set }, { session });

        const owners = await Account.countDocuments(ACTIVE_OWNER).session(session);
        if (owners === 0) {
          throw new HttpError(409, "That would leave SILLA with no active owner. Make someone else an owner first.", {
            code: "LAST_OWNER",
          });
        }

        // The shared write described above.
        await Account.updateOne({ _id: actor._id }, { $set: { updatedAt: new Date() } }, { session });
      });
    } catch (err) {
      if (err instanceof HttpError) return reject(res, err.status, err.message, err.extra);
      throw err;
    }

    // Their open threads go back to the shared inbox. Left assigned to
    // someone who can no longer sign in, a customer's next message would
    // notify nobody and sit under a name nobody answers to.
    let unassigned = 0;
    if (before.active && !after.active) {
      const result = await Conversation.updateMany({ assignee: req.params.id, status: "open" }, { $set: { assignee: null } });
      unassigned = result.modifiedCount || 0;
    }

    const target = { type: "staff", id: req.params.id, label };
    if (before.staffRole !== after.staffRole) {
      await audit(
        req,
        "staff.role",
        target,
        `Changed ${label} from ${before.staffRole} to ${after.staffRole}`,
        { from: before.staffRole, to: after.staffRole }
      );
    }
    if (before.active !== after.active) {
      const back = unassigned ? ` — ${unassigned} open conversation${unassigned === 1 ? "" : "s"} back to the shared inbox` : "";
      await audit(req, after.active ? "staff.reactivate" : "staff.deactivate", target,
        `${after.active ? "Reactivated" : "Deactivated"} ${label}${back}`, after.active ? {} : { unassignedConversations: unassigned });
    }

    const fresh = await Account.findById(req.params.id).populate("invitedBy", "name email");
    res.json({ staff: staffShape(fresh, req.account) });
  })
);

/* ───────────────────────── accepting an invitation ───────────────────────── */

/**
 * The invited person sets their password with the emailed code. No token
 * is needed — they have no password yet — so this is rate limited by
 * address and email like every other code entry, and its failures do not
 * say whether the address is a staff account at all.
 *
 * Returns no session: the console signs in with the new password through
 * the ordinary login, so there is still exactly one place that mints a
 * token (auth.routes.js).
 */
router.post(
  "/invitations/accept",
  rateLimit({
    name: "invite-accept",
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyFor: (req) => `${req.ip}:${normEmail(req.body?.email)}`,
  }),
  asyncHandler(async (req, res) => {
    const email = normEmail(req.body?.email);
    const fields = {};
    if (!EMAIL_RE.test(email)) fields.email = "Enter the email address the invitation was sent to.";
    const pwProblem = passwordProblem(req.body?.password);
    if (pwProblem) fields.password = pwProblem;
    if (Object.keys(fields).length) return reject(res, 400, Object.values(fields)[0], { fields });

    const NO_INVITE =
      "There's no invitation waiting for that address. Check the email it was sent to, or ask the owner who invited you to send a new one.";

    const account = await Account.findOne({ email, role: "silla", active: true });
    if (!account || !isPending(account)) return reject(res, 400, NO_INVITE);

    const result = await consumeCode(account, "invite", req.body?.code);
    if (!result.ok) {
      await account.save();
      // codes.js says "Send a new one" — which the invited person cannot
      // do. Only the owner who invited them can.
      const error =
        result.status === 400 && result.error.startsWith("There's no code")
          ? NO_INVITE
          : result.status === 410
            ? "This invitation has expired. Ask the owner who invited you to send a new one."
            : result.status === 429
              ? "Too many wrong codes. Ask the owner who invited you to send a new one."
              : result.error;
      return res.status(result.status).json({ error, attemptsRemaining: result.attemptsRemaining });
    }

    account.passwordHash = await bcrypt.hash(String(req.body.password), 10);
    // Backdated a second, as in auth.routes.js: the token the console is
    // about to sign in for has an `iat` truncated to whole seconds.
    account.passwordChangedAt = new Date(Date.now() - 1000);
    // The code arrived at this inbox, which proves the address.
    account.emailVerified = true;
    account.emailVerifiedAt = new Date();
    account.inviteAcceptedAt = new Date();
    await account.save();

    await audit(
      { account },
      "staff.invite.accept",
      { type: "staff", id: account._id, label: account.name },
      `${account.name} accepted their invitation (${staffRoleOf(account)})`
    );

    res.json({ ok: true, email: account.email });
  })
);

export default router;
