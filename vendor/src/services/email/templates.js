/**
 * What the storefront sends, and when.
 *
 * SILLA is the sender here, unlike the product's own emails which are sent
 * AS the buyer's organization. Every message is rendered through
 * layout.js, which produces an HTML part and a plain-text part from the
 * same blocks so the two can never disagree.
 *
 * Two rules for anything security-shaped (codes, email and password
 * changes): say what happened in plain words, and say what to do if it
 * was not you. A code with no "if you didn't ask for this" line trains
 * people to type codes they did not request.
 */
import { button, code, details, lines, note, p, renderEmail } from "./layout.js";
import { formatMoney } from "./billingTemplates.js";

const PORTAL = () => (process.env.PORTAL_URL || "http://localhost:5174").replace(/\/+$/, "");

/** The names the first three plans had, for orders saved before an order carried its plan's name. */
const LEGACY_PLAN_NAMES = { room: "One Room", building: "Whole Building", campus: "Campus" };
const planOf = (order) => order.planName || LEGACY_PLAN_NAMES[order.plan] || order.plan;

/**
 * What the order was quoted at, per month. Minor units in, through the
 * ONE formatter the billing emails use — "₱6,900.00 a month", never
 * "PHP 6900", which is what a peso order printed when this assumed dollars.
 */
const quoted = (order) =>
  order.quotedAmount == null ? "To be agreed with you" : `${formatMoney(order.quotedAmount, order.currency || "PHP")} a month`;

/** First name for a greeting, from the split fields or the legacy single name. */
const first = (account) => account.firstName || String(account.name || "").split(" ")[0] || "there";

const build = (to, subject, content) => ({ to, subject, ...renderEmail(content) });

/* ─────────────────────────────── account ─────────────────────────────── */

export const verificationEmail = ({ account, code: value, expiryMinutes }) =>
  build(account.email, `${value} is your SILLA verification code`, {
    preheader: `Enter ${value} to finish creating your account. It expires in ${expiryMinutes} minutes.`,
    eyebrow: "Verify your email",
    title: "Finish creating your account",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("Enter this code on the SILLA site to confirm this is your email address."),
      code(value, `Expires in ${expiryMinutes} minutes`),
      p(
        "You can keep exploring and configuring before you verify. You'll need a verified address to place an order."
      ),
      note("Didn't create a SILLA account? Ignore this email — nothing happens without the code."),
    ],
    reason: "because someone created a SILLA account with this address",
  });

export const welcomeEmail = ({ account }) =>
  build(account.email, "Welcome to SILLA", {
    preheader: "Your email is verified. Anything you configure is now saved to your account.",
    eyebrow: "Account verified",
    title: `You're all set, ${first(account)}`,
    blocks: [
      p(
        "Your email is verified and your account is ready. Anything you configure is saved to it, so you can leave a system half-built and come back to it from any device."
      ),
      p("Nothing is charged until you submit an order and we confirm it with you."),
      button("Open the configurator", `${PORTAL()}/#/configure`),
    ],
  });

/** Sent to the NEW address, so only someone who controls it can complete the change. */
export const emailChangeCodeEmail = ({ account, newEmail, code: value, expiryMinutes }) =>
  build(newEmail, `${value} confirms your new SILLA email`, {
    preheader: `Enter ${value} to move your SILLA account to this address.`,
    eyebrow: "Confirm new email",
    title: "Confirm your new email address",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("You asked to move your SILLA account to this address. Enter this code to confirm it."),
      code(value, `Expires in ${expiryMinutes} minutes`),
      note("Didn't ask for this? Ignore this email. Your account stays on its current address."),
    ],
    reason: "because someone asked to move a SILLA account to this address",
  });

/** Sent to the OLD address after a change, so a hijack is noticed by the real owner. */
export const emailChangedNoticeEmail = ({ account, oldEmail, newEmail }) =>
  build(oldEmail, "Your SILLA email address was changed", {
    preheader: `Your account now signs in with ${newEmail}.`,
    eyebrow: "Security notice",
    title: "Your email address was changed",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("The email address on your SILLA account was just changed."),
      details([
        ["Previous", oldEmail],
        ["New", newEmail],
        ["When", new Date().toUTCString()],
      ]),
      note(
        "If this was you, there's nothing to do. If it wasn't, reply to this email straight away so we can lock the account.",
        "warning"
      ),
    ],
  });

export const passwordChangedEmail = ({ account }) =>
  build(account.email, "Your SILLA password was changed", {
    preheader: "The password on your SILLA account was just changed.",
    eyebrow: "Security notice",
    title: "Your password was changed",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("The password on your SILLA account was just changed. Other signed-in sessions will need the new one."),
      details([["When", new Date().toUTCString()]]),
      note(
        "If this was you, there's nothing to do. If it wasn't, reset your password now and reply to this email.",
        "warning"
      ),
      button("Reset my password", `${PORTAL()}/#/sign-in`),
    ],
  });

export const passwordResetEmail = ({ account, code: value, expiryMinutes }) =>
  build(account.email, `${value} is your SILLA password reset code`, {
    preheader: `Enter ${value} to choose a new password. It expires in ${expiryMinutes} minutes.`,
    eyebrow: "Reset your password",
    title: "Choose a new password",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("Enter this code on the SILLA sign-in page to set a new password."),
      code(value, `Expires in ${expiryMinutes} minutes`),
      note("Didn't ask to reset your password? Ignore this email. Your current password still works."),
    ],
    reason: "because a password reset was requested for this address",
  });

/* ─────────────────────────────── orders ─────────────────────────────── */

const PER = { monthly: "month", yearly: "year" };

/**
 * The headline rows. An order submitted with a quote (all of them now)
 * says what the first invoice comes to; an older one says the plan's
 * per-month figure it was quoted at.
 */
const orderRows = (order) => {
  const quote = order.quote;
  const cur = quote?.currency || order.currency || "PHP";
  const first = quote?.totals?.firstInvoice;
  return [
    ["Organization", order.organizationName],
    ["Plan", planOf(order)],
    ["Billing", order.billingPeriod === "monthly" ? "Monthly" : "Yearly"],
    quote ? ["First invoice", first ? `${formatMoney(first.total, cur)}${first.tax ? " incl. VAT" : ""}` : "To be agreed with you"] : ["Quoted", quoted(order)],
  ];
};

/**
 * Every line of the frozen quote, through the ONE formatter: what each
 * thing is, how many at what price, and what the first invoice, every
 * later period and the one-time items come to. Rentals' minimum terms are
 * said under it, because they are a commitment and not a price.
 */
function quoteBlocks(order) {
  const quote = order.quote;
  if (!quote?.lines?.length) return [];
  const cur = quote.currency || order.currency || "PHP";
  const per = PER[quote.billingPeriod] || "period";
  const money = (n) => formatMoney(n, cur);
  const rows = quote.lines.map((l) => {
    const recurring = l.kind !== "one_time";
    const each = recurring ? l.periodUnitAmount : l.unitAmount;
    return {
      description: l.description,
      detail: [
        l.quantity > 1 && each != null ? `${l.quantity.toLocaleString("en-PH")} × ${money(each)}${recurring ? ` a ${per}` : ""}` : null,
        l.kind === "one_time" ? l.note || null : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: l.amount == null ? "To be agreed" : money(l.amount),
    };
  });
  const t = quote.totals || {};
  const first = t.firstInvoice;
  const totals = [
    t.oneTime ? ["Paid once", money(t.oneTime)] : null,
    [`Every ${per} after`, t.renewal ? money(t.renewal.subtotal) : "To be agreed"],
    first?.tax ? [quote.vat?.label || "VAT", money(first.tax)] : null,
    ["First invoice", first ? money(first.total) : "To be agreed"],
  ].filter(Boolean);
  return [
    lines(rows, totals),
    quote.commitments?.length ? note(quote.commitments.join(" ")) : null,
    quote.vat?.registered ? null : note("Prices exclude VAT; SILLA isn't VAT-registered, so none is added."),
  ].filter(Boolean);
}

const orderLink = (order) => `${PORTAL()}/#/orders/${order._id}`;

/** To the buyer, when they submit. */
export const orderSubmittedEmail = ({ account, order }) =>
  build(account.email, `We've received your order — ${order.organizationName}`, {
    preheader: `Your configuration for ${order.organizationName} is with SILLA.`,
    eyebrow: "Order received",
    title: "We've got your order",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`Your configuration for ${order.organizationName} is with us.`),
      details(orderRows(order)),
      ...quoteBlocks(order),
      p(
        "We'll build it from exactly what you configured — the same names, colours and floors — and email you as it moves along."
      ),
      button("View your order", orderLink(order)),
      // In step with billing, which issues the first invoice the moment an
      // order is submitted — unless the plan is priced with each customer.
      note(
        (order.quote ? !order.quote.totals?.firstInvoice : order.quotedAmount == null)
          ? "Nothing has been charged. We'll agree a price with you before anything is billed."
          : "Your first invoice follows in a separate email, with how to pay. Nothing is taken automatically — there's no card on file."
      ),
    ],
  });

/** To SILLA, so a submitted order is not waiting on someone refreshing a page. */
export const orderSubmittedInternalEmail = ({ account, order, to }) => {
  const buyer = [account.firstName, account.lastName].filter(Boolean).join(" ") || account.name;
  return build(to, `New order: ${order.organizationName} (${planOf(order)})`, {
    preheader: `${buyer} submitted a configuration for ${order.organizationName}.`,
    eyebrow: "Internal · new order",
    title: "A buyer submitted an order",
    blocks: [
      details([["Buyer", `${buyer} <${account.email}>`], ...orderRows(order)]),
      ...quoteBlocks(order),
      button("Open it in the console", `${PORTAL()}/#/staff/orders/${order._id}`),
    ],
    reason: "because an order was submitted to the SILLA queue",
  });
};

export const orderProvisioningEmail = ({ account, order }) =>
  build(account.email, `We're building ${order.organizationName}`, {
    preheader: "Work has started on your SILLA deployment.",
    eyebrow: "In progress",
    title: `We're building ${order.organizationName}`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("Work has started on your system. You'll get another email with its address as soon as it's ready."),
      button("Track your order", orderLink(order)),
    ],
  });

export const orderLiveEmail = ({ account, order }) =>
  build(account.email, `${order.organizationName} is live`, {
    preheader: `${order.organizationName} is ready to use.`,
    eyebrow: "It's live",
    title: `${order.organizationName} is ready`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p("Your system is built and running."),
      button("Open your system", order.deploymentUrl),
      details([["Address", order.deploymentUrl]]),
      // True now: provisioning mints the named owner as the founding
      // superadmin and the product itself emails them a temporary PIN.
      note(
        "The person you named as the system's owner receives their sign-in details in a separate email, sent by the system itself. They'll set their own PIN the first time they sign in."
      ),
    ],
  });

export const orderCancelledEmail = ({ account, order, reason }) =>
  build(account.email, `Order cancelled — ${order.organizationName}`, {
    preheader: `Your order for ${order.organizationName} was cancelled.`,
    eyebrow: "Order cancelled",
    title: "Your order was cancelled",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`Your order for ${order.organizationName} has been cancelled.`),
      // Only when one was given — an empty "Reason" row reads as though
      // someone deleted the explanation.
      reason ? details([["Reason", reason]]) : null,
      p("If that isn't right, reply to this email and we'll sort it out."),
    ].filter(Boolean),
  });
