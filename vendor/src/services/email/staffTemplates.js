/**
 * What the staff console sends: invitations to join it, and the emails
 * that tell each side of a conversation that the other has written.
 *
 * Kept apart from templates.js (the buyer's account and order mail) so
 * the two can grow without stepping on each other, and rendered through
 * the same layout.js — same shell, same text part, same escaping — so a
 * buyer cannot tell which file a message came from.
 *
 * The same two rules as templates.js: say what happened in plain words,
 * and for anything that unlocks an account, say what to do if it was
 * not expected.
 */
import { button, code, details, note, p, renderEmail } from "./layout.js";

const PORTAL = () => (process.env.PORTAL_URL || "http://localhost:5174").replace(/\/+$/, "");

const first = (account) => account?.firstName || String(account?.name || "").split(" ")[0] || "there";
const fullName = (account) =>
  [account?.firstName, account?.lastName].filter(Boolean).join(" ") || account?.name || account?.email || "Someone";

const build = (to, subject, content) => ({ to, subject, ...renderEmail(content) });

/**
 * A message body quoted inside an email. Trimmed rather than sent whole:
 * the email is a nudge to open the thread, not a second copy of it, and a
 * five-thousand-character reply in an inbox preview helps nobody.
 */
const excerpt = (body, max = 600) => {
  const text = String(body || "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/* ─────────────────────────────── staff ─────────────────────────────── */

/**
 * To someone an owner has invited into the staff console. The code is
 * the only way in: the account's password is random until it is spent.
 */
export const staffInvitationEmail = ({ account, code: value, invitedBy, roleLabel, roleSummary, expiryHours }) =>
  build(account.email, `${fullName(invitedBy)} invited you to the SILLA staff console`, {
    preheader: `Your invitation code is inside. It works once, for ${expiryHours} hours.`,
    eyebrow: "Staff invitation",
    title: "Join the SILLA staff console",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(
        `${fullName(invitedBy)} added you to SILLA's staff console as ${roleLabel.toLowerCase()} — ${roleSummary}.`
      ),
      details([
        ["Sign-in email", account.email],
        ["Role", roleLabel],
      ]),
      p("Open the staff sign-in, choose “I have an invitation”, and enter this code to set your password."),
      code(value, `Works once, for ${expiryHours} hours`),
      button("Accept the invitation", `${PORTAL()}/#/staff/sign-in/invitation`),
      note(
        "Weren't expecting this? Ignore this email. The account stays locked without the code, and the invitation lapses on its own."
      ),
    ],
    reason: "because a SILLA owner invited this address to the staff console",
  });

/* ─────────────────────────── conversations ─────────────────────────── */

/**
 * To the buyer, when SILLA has replied and they have not read it.
 *
 * `latest` is the newest PUBLIC staff message — the job never passes an
 * internal note here, and the quote below is the only message text the
 * email carries.
 */
export const conversationReplyEmail = ({ account, conversation, latest, unread, organizationName }) =>
  build(account.email, `SILLA replied: ${conversation.subject}`, {
    preheader: excerpt(latest?.body, 140),
    eyebrow: "New reply",
    title: unread > 1 ? `You have ${unread} replies from SILLA` : "You have a reply from SILLA",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(
        `About “${conversation.subject}”${organizationName ? ` — your order for ${organizationName}` : ""}.`
      ),
      latest ? note(`${latest.authorName || "SILLA"}: ${excerpt(latest.body)}`) : null,
      button("Read and reply", `${PORTAL()}/#/messages/${conversation._id}`),
      p("Reply from your SILLA account so the whole conversation stays in one place."),
    ].filter(Boolean),
    reason: "because SILLA replied to a conversation on your account",
  });

/**
 * To SILLA — the assignee if there is one, otherwise SILLA_ORDERS_EMAIL —
 * when a buyer has written and nobody has read it yet.
 */
export const conversationStaffNoticeEmail = ({ to, account, conversation, latest, unread, organizationName, assignee }) =>
  build(to, `${fullName(account)} wrote: ${conversation.subject}`, {
    preheader: excerpt(latest?.body, 140),
    eyebrow: "Internal · customer message",
    title:
      unread > 1 ? `${unread} unread messages from ${fullName(account)}` : `A message from ${fullName(account)}`,
    blocks: [
      details([
        ["Customer", `${fullName(account)} <${account.email}>`],
        ["Organization", organizationName || account.organizationName || ""],
        ["Subject", conversation.subject],
        ["Assigned to", assignee ? fullName(assignee) : "Nobody yet"],
      ]),
      latest ? note(`${fullName(account)}: ${excerpt(latest.body)}`) : null,
      button("Open the conversation", `${PORTAL()}/#/staff/conversations/${conversation._id}`),
    ].filter(Boolean),
    reason: assignee
      ? "because a conversation assigned to you has an unread customer message"
      : "because a customer conversation nobody is assigned to has an unread message",
  });
