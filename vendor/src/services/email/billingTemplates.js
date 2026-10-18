/**
 * What the billing side sends, and when — invoices, receipts, reminders
 * and every change to whether a customer's system works.
 *
 * Same shell and voice as templates.js (SILLA is the sender, rendered
 * through layout.js into an HTML part and a text part from one set of
 * blocks). A separate file because these are driven by money and by the
 * billing job, not by a person clicking something, and because they share
 * vocabulary — amounts, due dates, "how to pay" — that the account emails
 * never need.
 *
 * Three rules for anything about money:
 *   1. Say the amount, the invoice number and the date in the first lines.
 *      Someone deciding whether to act needs those before anything else.
 *   2. Say what happens to their system, in plain words — "keeps working
 *      until", "read-only", "nothing is deleted" — never "past_due".
 *   3. Tell them how to pay in the same message. An overdue notice that
 *      sends you somewhere else to find the bank details is a second chore.
 *
 * Every function returns { to, subject, html, text } for sendEmail(), and
 * takes plain objects, so emailPreview.js can render them with sample data.
 */
import { button, details, lines, note, p, renderEmail } from "./layout.js";

const PORTAL = () => (process.env.PORTAL_URL || "http://localhost:5174").replace(/\/+$/, "");

/**
 * Always two decimals, unlike the storefront's prices: "₱82,800.00" is a
 * sum owed, "₱6,900" is a price tag. Minor units in, like everything else.
 */
export function formatMoney(minor, currency = "PHP") {
  if (minor == null) return "To be agreed with you";
  try {
    return new Intl.NumberFormat("en-PH", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      minor / 100
    );
  } catch {
    // An unknown currency code must not take the whole email down with it.
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** "October 15, 2026" — the month in words, so nobody has to guess which number is the day. */
export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" }) : "";

export const METHOD_LABEL = {
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  maya: "Maya",
  cash: "Cash",
  card: "Card",
  other: "Other",
};

const PERIOD_WORD = { monthly: "month", yearly: "year" };

/** First name for a greeting, from the split fields or the legacy single name. */
const first = (account) => account?.firstName || String(account?.name || "").split(" ")[0] || "there";

const build = (to, subject, content) => ({ to, subject, ...renderEmail(content) });

const invoiceLink = (invoice) => `${PORTAL()}/#/invoices/${invoice._id || invoice.id}`;
const billingLink = () => `${PORTAL()}/#/billing`;

/** Billing mail goes to the billing contact when they named one — the profile says "Invoices go here." */
const billingAddress = (account) => account?.billing?.email || account?.email;

/**
 * How to pay, from Settings: one row per method (bank, GCash, …), then
 * the free-text instructions, then the reference to quote. Rendered into
 * every message that asks for money, so nobody has to go looking.
 */
function howToPay(settings, invoice) {
  const methods = settings?.payment?.methods || [];
  const instructions = String(settings?.payment?.instructions || "").trim();
  const blocks = [];
  if (methods.length) {
    blocks.push(p("You can pay by any of these:"));
    blocks.push(details(methods.map((m) => [m.label, m.details || "Reply to this email for the details"])));
  }
  if (instructions) blocks.push(p(instructions));
  if (!methods.length && !instructions) {
    blocks.push(p("Reply to this email and we'll send you the payment details."));
  }
  blocks.push(note(`Quote ${invoice.number} as the reference, so we can match your payment to this invoice.`));
  return blocks;
}

const trialDays = (settings) => Number(settings?.billing?.trialDays ?? 0);

/** What an invoice is for, in one phrase: its first line, and how many more there are. */
const summaryOf = (invoice) => {
  const all = invoice.lines || [];
  if (all.length <= 1) return all[0]?.description;
  return `${all[0].description}, and ${all.length - 1} more line${all.length === 2 ? "" : "s"}`;
};

const invoiceRows = (invoice) => [
  ["Invoice", invoice.number],
  ["For", invoice.organizationName],
  ["Description", summaryOf(invoice)],
  ["Amount due", formatMoney(invoice.total, invoice.currency)],
  ["Due", formatDate(invoice.dueAt)],
];

/**
 * Every line of an invoice, as it is printed: what it is, how many at
 * what price, the note a customer should keep (a warranty), and the
 * totals with VAT when it was charged.
 */
export function invoiceLineItems(invoice) {
  const cur = invoice.currency;
  return lines(
    (invoice.lines || []).map((l) => ({
      description: l.description,
      detail: [l.quantity > 1 ? `${l.quantity.toLocaleString("en-PH")} × ${formatMoney(l.unitAmount, cur)}` : null, l.note || null]
        .filter(Boolean)
        .join(" · "),
      amount: formatMoney(l.amount, cur),
    })),
    [
      invoice.tax?.amount ? ["Subtotal", formatMoney(invoice.subtotal, cur)] : null,
      invoice.tax?.amount ? [invoice.tax.label || "VAT", formatMoney(invoice.tax.amount, cur)] : null,
      ["Total", formatMoney(invoice.total, cur)],
    ].filter(Boolean)
  );
}

/* ─────────────────────────────── invoices ─────────────────────────────── */

const ISSUED_TITLE = {
  first: "Your first invoice",
  renewal: "Your renewal invoice",
  manual: "A new invoice from SILLA",
};

/** To the buyer, the moment any invoice is issued. */
export const invoiceIssuedEmail = ({ invoice, account, settings }) =>
  build(
    invoice.billTo?.email || billingAddress(account),
    `Invoice ${invoice.number} — ${formatMoney(invoice.total, invoice.currency)} due ${formatDate(invoice.dueAt)}`,
    {
      preheader: `${formatMoney(invoice.total, invoice.currency)} for ${invoice.organizationName}, due ${formatDate(invoice.dueAt)}.`,
      eyebrow: "Invoice",
      title: ISSUED_TITLE[invoice.kind] || ISSUED_TITLE.manual,
      greeting: `Hi ${first(account)},`,
      blocks: [
        p(
          invoice.kind === "renewal"
            ? `Your ${invoice.organizationName} subscription renews soon. Here is the invoice for the next period.`
            : `Here is your invoice for ${invoice.organizationName}.`
        ),
        details(invoiceRows(invoice)),
        invoiceLineItems(invoice),
        // The first invoice arrives before the system is even live. Say
        // what paying it does, so paying early doesn't look like losing
        // the trial.
        invoice.kind === "first" && trialDays(settings) > 0
          ? p(
              `Your ${trialDays(settings)}-day free trial starts when ${invoice.organizationName} goes live, and the paid period starts when the trial ends — paying early never shortens it.`
            )
          : null,
        button("View the invoice", invoiceLink(invoice)),
        ...howToPay(settings, invoice),
        p("Already paid? Press “I've paid” on the invoice page and tell us the reference — we'll confirm it and send your receipt."),
      ].filter(Boolean),
      reason: "because SILLA issued an invoice to this address",
    }
  );

/** To the buyer, a few days before an open invoice falls due. Sent once per invoice. */
export const invoiceDueSoonEmail = ({ invoice, account, settings }) =>
  build(invoice.billTo?.email || billingAddress(account), `Reminder: invoice ${invoice.number} is due ${formatDate(invoice.dueAt)}`, {
    preheader: `${formatMoney(invoice.total, invoice.currency)} for ${invoice.organizationName} is due on ${formatDate(invoice.dueAt)}.`,
    eyebrow: "Payment reminder",
    title: `Due on ${formatDate(invoice.dueAt)}`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`A friendly reminder that invoice ${invoice.number} for ${invoice.organizationName} is due soon.`),
      details(invoiceRows(invoice)),
      ...howToPay(settings, invoice),
      button("View the invoice", invoiceLink(invoice)),
      note("Paid it already? Thank you — tell us on the invoice page so we can match it, and ignore this reminder."),
    ],
    reason: "because an invoice addressed to you is due soon",
  });

/**
 * Overdue, in one of two voices.
 *
 * With `graceEndsAt`: the subscription's paid period ended unpaid and its
 * system is in the grace period — say exactly how long it keeps working
 * and what happens after, because "past due" alone means nothing to the
 * person who has to find the money. Without it: an invoice is simply late
 * (a first invoice during a trial, a one-off charge), and the system is
 * not affected yet.
 */
export const invoiceOverdueEmail = ({ invoice, account, settings, subscription = null, graceEndsAt = null }) => {
  const org = invoice.organizationName;
  const grace = graceEndsAt
    ? [
        p(
          `${org} keeps working normally until ${formatDate(graceEndsAt)}. If the invoice is still unpaid then, ${org} becomes read-only: everyone can sign in and look, but nothing can be booked or changed until it is paid.`
        ),
        note("Nothing is deleted at any point. Paying restores everything at once.", "warning"),
      ]
    : subscription?.status === "trialing" && subscription.trialEndsAt
      ? [p(`Your free trial runs until ${formatDate(subscription.trialEndsAt)}. To keep ${org} running after that, please settle this invoice before then.`)]
      : [];
  return build(
    invoice.billTo?.email || billingAddress(account),
    graceEndsAt
      ? `Payment overdue — ${org} keeps working until ${formatDate(graceEndsAt)}`
      : `Invoice ${invoice.number} is overdue`,
    {
      preheader: `${formatMoney(invoice.total, invoice.currency)} was due on ${formatDate(invoice.dueAt)}.`,
      eyebrow: graceEndsAt ? "Grace period" : "Overdue",
      title: graceEndsAt ? "Your payment is overdue" : `Invoice ${invoice.number} is overdue`,
      greeting: `Hi ${first(account)},`,
      blocks: [
        p(`We haven't received payment for invoice ${invoice.number}, which was due on ${formatDate(invoice.dueAt)}.`),
        details(invoiceRows(invoice)),
        ...grace,
        ...howToPay(settings, invoice),
        button("Pay this invoice", invoiceLink(invoice)),
        note("If you've already paid, tell us on the invoice page so we can match it — and sorry for the nudge."),
      ],
      reason: "because an invoice addressed to you is overdue",
    }
  );
};

/* ─────────────────────────────── payments ─────────────────────────────── */

/** To the buyer, once SILLA records money against an invoice. The receipt. */
export const paymentReceiptEmail = ({ invoice, account, subscription = null, reactivated = false }) =>
  build(invoice.billTo?.email || billingAddress(account), `Payment received — thank you (${invoice.number})`, {
    preheader: `We received ${formatMoney(invoice.payment?.amount, invoice.currency)} for invoice ${invoice.number}.`,
    eyebrow: "Receipt",
    title: "Payment received — thank you",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`We've received your payment for invoice ${invoice.number}.`),
      details([
        ["Invoice", invoice.number],
        ["For", invoice.organizationName],
        ["Amount received", formatMoney(invoice.payment?.amount, invoice.currency)],
        ["Method", METHOD_LABEL[invoice.payment?.method] || ""],
        ["Reference", invoice.payment?.reference],
        ["Received on", formatDate(invoice.payment?.receivedAt)],
      ]),
      subscription?.status === "active" && subscription.currentPeriodEnd
        ? p(`Your ${subscription.planName} plan is paid through ${formatDate(subscription.currentPeriodEnd)}.`)
        : subscription?.status === "pending"
          ? p("Your paid period starts once your system is live — we'll email you when it is.")
          : null,
      reactivated ? note(`${invoice.organizationName} is back to normal — everything works again.`) : null,
      button("View your receipt", invoiceLink(invoice)),
    ].filter(Boolean),
    reason: "because SILLA recorded a payment from you",
  });

/**
 * To SILLA, when a buyer says they have paid. A CLAIM, and the message
 * says so: nothing is activated until someone checks the account and
 * records the money.
 */
export const paymentClaimEmail = ({ to, invoice, account }) => {
  const claim = invoice.claimedPayment || {};
  const buyer = [account.firstName, account.lastName].filter(Boolean).join(" ") || account.name;
  return build(to, `Payment claimed: ${invoice.number} — ${formatMoney(claim.amount, invoice.currency)} via ${METHOD_LABEL[claim.method] || "?"}`, {
    preheader: `${buyer} says they paid ${invoice.number}. Check the account, then record it.`,
    eyebrow: "Internal · payment claim",
    title: "A buyer says they've paid",
    blocks: [
      details([
        ["Buyer", `${buyer} <${account.email}>`],
        ["Organization", invoice.organizationName],
        ["Invoice", `${invoice.number} · ${formatMoney(invoice.total, invoice.currency)}`],
        ["Claimed", formatMoney(claim.amount, invoice.currency)],
        ["Method", METHOD_LABEL[claim.method] || ""],
        ["Reference", claim.reference],
        ["Paid on", formatDate(claim.paidAt)],
        ["Note", claim.note],
      ]),
      note("This is a claim, not a payment. Nothing changes until the money is found and recorded in the console.", "warning"),
      button("Open it in the console", `${PORTAL()}/#/staff/invoices/${invoice._id || invoice.id}`),
    ],
    reason: "because a buyer reported a payment to SILLA",
  });
};

/** To the buyer, when staff could not find the money they said they sent. */
export const paymentClaimDismissedEmail = ({ invoice, account }) =>
  build(invoice.billTo?.email || billingAddress(account), `We couldn't match your payment for ${invoice.number}`, {
    preheader: "We looked for your payment and couldn't find it yet.",
    eyebrow: "Payment not found",
    title: "We couldn't match your payment",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`You told us you paid invoice ${invoice.number}, but we couldn't find that payment yet.`),
      invoice.claimedPayment?.dismissNote ? details([["What we found", invoice.claimedPayment.dismissNote]]) : null,
      p("Banks and e-wallets sometimes take a day to settle. If you have a receipt, reply with it, or tell us the details again from the invoice page."),
      button("Open the invoice", invoiceLink(invoice)),
    ].filter(Boolean),
    reason: "because you reported a payment to SILLA",
  });

/* ─────────────────────────────── subscription ─────────────────────────────── */

/** A few days before an unpaid trial ends. Sent once per trial end. */
export const trialEndingEmail = ({ subscription, account, invoice = null, settings }) =>
  build(billingAddress(account), `Your free trial of ${subscription.organizationName} ends ${formatDate(subscription.trialEndsAt)}`, {
    preheader: `Pay ${invoice ? invoice.number : "your first invoice"} to keep ${subscription.organizationName} running.`,
    eyebrow: "Trial ending",
    title: `Your trial ends on ${formatDate(subscription.trialEndsAt)}`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(
        `Your free trial of ${subscription.organizationName} on the ${subscription.planName} plan ends on ${formatDate(subscription.trialEndsAt)}.`
      ),
      ...(invoice
        ? [
            p(`To keep it running without interruption, please pay invoice ${invoice.number} (${formatMoney(invoice.total, invoice.currency)}).`),
            ...howToPay(settings, invoice),
            button("Pay the invoice", invoiceLink(invoice)),
          ]
        : [button("See your billing", billingLink())]),
      note("If the trial ends unpaid, you get a short grace period before anything changes — and nothing is ever deleted."),
    ],
    reason: "because your SILLA free trial is ending",
  });

/**
 * When grace runs out, or SILLA staff suspend the subscription. With an
 * unpaid invoice it carries the payment details too (rule 3): this is the
 * message most likely to be acted on, and the fastest way back is paying.
 */
export const subscriptionSuspendedEmail = ({ subscription, account, invoice = null, reason = "", settings = null }) =>
  build(billingAddress(account), `${subscription.organizationName} is now read-only`, {
    preheader: invoice
      ? `Pay invoice ${invoice.number} to switch everything back on.`
      : `${subscription.organizationName} is read-only until this is resolved.`,
    eyebrow: "Suspended",
    title: `${subscription.organizationName} is now read-only`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(
        invoice
          ? `Invoice ${invoice.number} is still unpaid and the grace period has ended, so ${subscription.organizationName} is now read-only.`
          : `${subscription.organizationName} has been suspended by SILLA and is now read-only.`
      ),
      reason ? details([["Reason", reason]]) : null,
      p("Everyone can still sign in and see everything, but nothing can be booked, checked into or changed until it is resolved."),
      note(
        invoice
          ? "Nothing has been deleted. The moment the invoice is paid, everything works again exactly as it was."
          : "Nothing has been deleted. Reply to this email if you think this is a mistake.",
        "warning"
      ),
      ...(invoice ? [details(invoiceRows(invoice)), ...howToPay(settings, invoice), button("Pay the invoice", invoiceLink(invoice))] : [button("See your billing", billingLink())]),
    ].filter(Boolean),
    reason: "because the status of your SILLA subscription changed",
  });

/** When staff lift a suspension. (A payment that does it says so in the receipt instead.) */
export const subscriptionReactivatedEmail = ({ subscription, account }) =>
  build(billingAddress(account), `${subscription.organizationName} is back on`, {
    preheader: "Everything works again.",
    eyebrow: "Reactivated",
    title: `${subscription.organizationName} is back on`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`${subscription.organizationName} works normally again — bookings, check-ins and changes are all open.`),
      subscription.status === "active" && subscription.currentPeriodEnd
        ? details([["Paid through", formatDate(subscription.currentPeriodEnd)]])
        : subscription.status === "trialing" && subscription.trialEndsAt
          ? details([["Trial ends", formatDate(subscription.trialEndsAt)]])
          : subscription.status === "past_due" && subscription.graceEndsAt
            ? details([["Please pay by", formatDate(subscription.graceEndsAt)]])
            : null,
      button("See your billing", billingLink()),
    ].filter(Boolean),
    reason: "because the status of your SILLA subscription changed",
  });

/**
 * When staff move a customer to another plan. Two different moments are
 * in play and the message keeps them apart: what the plan ALLOWS changes
 * now; what it COSTS changes from the next invoice.
 */
export const planChangedEmail = ({ subscription, account, fromName }) => {
  const per = PERIOD_WORD[subscription.billingPeriod] || "period";
  return build(billingAddress(account), `Your SILLA plan is now ${subscription.planName}`, {
    preheader: `${subscription.organizationName} moved from ${fromName} to ${subscription.planName}.`,
    eyebrow: "Plan changed",
    title: `You're now on ${subscription.planName}`,
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`We've moved ${subscription.organizationName} from the ${fromName} plan to ${subscription.planName}.`),
      details([
        ["Organization", subscription.organizationName],
        ["Plan", `${fromName} → ${subscription.planName}`],
        [
          "New price",
          subscription.price?.amount == null
            ? "We'll agree it with you"
            : `${formatMoney(subscription.price.amount, subscription.price.currency)} per ${per}`,
        ],
      ]),
      p("What your plan includes changes now. The new price applies from your next invoice; invoices already sent keep their amounts."),
      button("See your billing", billingLink()),
    ],
    reason: "because your SILLA plan changed",
  });
};

/**
 * When staff change what a customer pays for besides the plan — extra
 * buildings, rentals, support. The same two moments as a plan change, kept
 * apart: what they ALLOW (one more building) changes now; what they COST
 * changes from the next invoice.
 */
export const addOnsChangedEmail = ({ subscription, account, before = [], after = [] }) => {
  const per = PERIOD_WORD[subscription.billingPeriod] || "period";
  const months = subscription.billingPeriod === "monthly" ? 1 : 12;
  const cur = subscription.price?.currency || "PHP";
  const named = (a) => `${a.name}${a.kind === "rental" ? " rental" : ""}`;
  const row = (a) => ({
    description: named(a),
    detail: a.quantity > 1 ? `${a.quantity} × ${formatMoney(a.unitAmount * months, cur)} a ${per}` : null,
    amount: a.unitAmount === 0 ? "Included" : `${formatMoney(a.unitAmount * months * a.quantity, cur)} a ${per}`,
  });
  const gone = before.filter((b) => !after.some((a) => a.key === b.key && a.kind === b.kind));
  return build(billingAddress(account), `Your SILLA add-ons for ${subscription.organizationName} changed`, {
    preheader: `What ${subscription.organizationName} pays for besides its plan has changed.`,
    eyebrow: "Add-ons changed",
    title: "Your add-ons changed",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`We've updated what ${subscription.organizationName} pays for besides its ${subscription.planName} plan. It now has:`),
      after.length ? lines(after.map(row)) : p("No add-ons."),
      gone.length ? p(`No longer included: ${gone.map(named).join(", ")}.`) : null,
      p("What they allow — another building, say — changes now. What they cost applies from your next invoice; invoices already sent keep their amounts."),
      button("See your billing", billingLink()),
    ].filter(Boolean),
    reason: "because what your SILLA subscription includes changed",
  });
};

/** When a subscription ends — staff cancelled it, or a scheduled cancellation came due. */
export const subscriptionCancelledEmail = ({ subscription, account, reason = "" }) =>
  build(billingAddress(account), `Your ${subscription.organizationName} subscription has ended`, {
    preheader: "Your data is kept.",
    eyebrow: "Subscription ended",
    title: "Your subscription has ended",
    greeting: `Hi ${first(account)},`,
    blocks: [
      p(`Your subscription for ${subscription.organizationName} has ended, and the system no longer accepts changes.`),
      reason ? details([["Reason", reason]]) : null,
      note("Your data is kept. If you'd like to come back, reply to this email — everything you set up is still there."),
    ].filter(Boolean),
    reason: "because your SILLA subscription ended",
  });
