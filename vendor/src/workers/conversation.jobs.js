/**
 * Conversation jobs: emailing people about unread messages.
 * Export an array of { name, everyMs, run }; see scheduler.js.
 *
 * Neither side is emailed per message. A support reply is often three
 * messages in a row, and three emails for one answer trains people to
 * ignore all of them. Instead, for each side of each thread:
 *
 *   - wait until the thread has been QUIET for that side's sender — no new
 *     message for QUIET_MINUTES — so a burst becomes one email, and anyone
 *     already looking at the thread reads it first and gets none;
 *   - email only about messages newer than the last email to that side,
 *     so nobody is told twice about the same reply.
 *
 * Together those mean at most one email per side, per thread, per quiet
 * period: a second email needs a new message after the first, and that
 * message must itself have gone quiet.
 *
 * Never for internal notes: the job keys on `lastStaffMessageAt`, which
 * only a PUBLIC staff message moves, and quotes the newest public message
 * found with { internal: false } in the query.
 *
 * Never to test addresses: the buyer's email goes through sendEmail, whose
 * transport drops every reserved test domain — @test.silla, .test,
 * .example, example.com (services/email/index.js — enforced there so no
 * caller can forget), and the outcome says it was
 * dropped. The staff-side email goes to a REAL inbox, so it is skipped
 * outright when the CUSTOMER is a test account, as order submission does.
 *
 * Idempotent: each email is claimed with a conditional update before it
 * is sent, so two overlapping ticks (or two processes) cannot both send it.
 */
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Account from "../models/Account.js";
import { isUndeliverable, sendEmail } from "../services/email/index.js";
import { conversationReplyEmail, conversationStaffNoticeEmail } from "../services/email/staffTemplates.js";

export const QUIET_MINUTES = Math.max(1, Number(process.env.CONVERSATION_QUIET_MINUTES) || 10);

const BATCH = 100;

/**
 * Claims the right to email `side` about this thread, or returns null if
 * someone else did, or a new message arrived since it was read. The
 * filter repeats exactly what was seen, so the update succeeds only if
 * nothing moved in between.
 *
 * The claim records the REAL moment, not the pass's `now`: it is compared
 * with real message times ("anything newer than the last email?"), so a
 * pass run with a clock stepped forward must not stamp a time from the
 * future that every later reply would seem to predate.
 */
function claim(conversation, side) {
  const lastField = side === "buyer" ? "lastStaffMessageAt" : "lastBuyerMessageAt";
  return Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      [`unread.${side}`]: { $gt: 0 },
      [lastField]: conversation[lastField],
      [`notified.${side}At`]: conversation.notified?.[`${side}At`] ?? null,
    },
    { $set: { [`notified.${side}At`]: new Date() } },
    { new: true }
  );
}

/**
 * Threads where `side` has unread messages that have settled and that
 * nobody has been emailed about. `only` limits the pass to some threads —
 * the suite's own, so a test run never claims a real customer's email.
 */
function due(side, now, only) {
  const lastField = side === "buyer" ? "lastStaffMessageAt" : "lastBuyerMessageAt";
  const settled = new Date(now.getTime() - QUIET_MINUTES * 60 * 1000);
  return Conversation.find({
    ...(only ? { _id: { $in: only } } : {}),
    [`unread.${side}`]: { $gt: 0 },
    [lastField]: { $ne: null, $lte: settled },
    $or: [
      { [`notified.${side}At`]: null },
      { $expr: { $lt: [`$notified.${side}At`, `$${lastField}`] } },
    ],
  })
    .populate("order", "organizationName")
    .limit(BATCH);
}

/**
 * One pass. Returns what it decided, per thread, so the suite can assert
 * on behaviour without an inbox to read.
 *
 * @param {object} [options]
 * @param {Date} [options.now]       lets a test step past the quiet period without waiting for it
 * @param {Function} [options.send]  where the built email goes — sendEmail, or a test's collector,
 *                                   so the suite can read what WOULD have been sent (and that no
 *                                   internal note is in it) without a mailbox
 * @param {Array} [options.only]     conversation ids to consider; every thread when absent
 */
export async function notifyUnread({ now = new Date(), send = sendEmail, only = null } = {}) {
  const outcome = { buyer: [], staff: [] };

  /* ── buyers: SILLA has replied ── */
  for (const conversation of await due("buyer", now, only)) {
    const claimed = await claim(conversation, "buyer");
    if (!claimed) continue;
    const id = conversation._id.toString();

    const account = await Account.findById(conversation.account).select("firstName lastName name email active");
    if (!account?.active) {
      outcome.buyer.push({ conversation: id, skipped: "account inactive" });
      continue;
    }
    // The newest PUBLIC staff reply — never a note.
    const latest = await Message.findOne({ conversation: conversation._id, authorRole: "staff", internal: false }).sort({
      createdAt: -1,
    });
    send(
      conversationReplyEmail({
        account,
        conversation,
        latest,
        unread: claimed.unread.buyer,
        organizationName: conversation.order?.organizationName || "",
      })
    );
    // A test address is dropped by the transport, never delivered.
    outcome.buyer.push({ conversation: id, to: account.email, ...(isUndeliverable(account.email) ? { dropped: "test address" } : {}) });
  }

  /* ── staff: a customer has written ── */
  for (const conversation of await due("staff", now, only)) {
    const claimed = await claim(conversation, "staff");
    if (!claimed) continue;
    const id = conversation._id.toString();

    const account = await Account.findById(conversation.account).select("firstName lastName name email organizationName");
    if (!account) {
      outcome.staff.push({ conversation: id, skipped: "customer account missing" });
      continue;
    }
    // This one goes to a real SILLA inbox, which the transport cannot know
    // to protect: a test customer's message must not reach it.
    if (isUndeliverable(account.email)) {
      outcome.staff.push({ conversation: id, skipped: "test customer" });
      continue;
    }
    // The person who has it, if they can still be reached; otherwise the
    // shared orders inbox. With neither, there is nobody to tell — the
    // unread badge in the console is still there.
    const assignee = conversation.assignee
      ? await Account.findOne({ _id: conversation.assignee, role: "silla", active: true }).select("firstName lastName name email")
      : null;
    const to = assignee?.email || process.env.SILLA_ORDERS_EMAIL || "";
    if (!to) {
      outcome.staff.push({ conversation: id, skipped: "no recipient" });
      continue;
    }
    const latest = await Message.findOne({ conversation: conversation._id, authorRole: "buyer" }).sort({ createdAt: -1 });
    send(
      conversationStaffNoticeEmail({
        to,
        account,
        conversation,
        latest,
        unread: claimed.unread.staff,
        organizationName: conversation.order?.organizationName || "",
        assignee,
      })
    );
    outcome.staff.push({ conversation: id, to });
  }

  return outcome;
}

export default [{ name: "conversation-notify", everyMs: 60 * 1000, run: () => notifyUnread() }];
