/**
 * Renders every storefront email — account, order and billing — to HTML
 * files so they can be looked at in a browser before anyone receives one.
 *
 *   npm run email:preview            -> ./email-preview/*.html
 *
 * Sample data only. Nothing is sent and nothing touches the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as t from "../services/email/templates.js";
import * as b from "../services/email/billingTemplates.js";
import * as st from "../services/email/staffTemplates.js";
import { buildQuote } from "../lib/quote.js";
import { DEFAULT_PLANS } from "../lib/defaultPlans.js";
import { DEFAULT_CATALOG } from "../lib/defaultCatalog.js";

const out = path.resolve(process.argv[2] || "email-preview");
mkdirSync(out, { recursive: true });

const account = { firstName: "Ana", lastName: "Reyes", name: "Ana Reyes", email: "ana@harborview.org" };
/** A two-building order on Building, with rented kiosks, printed cards, installation and Care — priced by lib/quote.js. */
const { quote } = buildQuote({
  plan: DEFAULT_PLANS.find((p) => p.key === "building"),
  plans: DEFAULT_PLANS,
  billingPeriod: "yearly",
  catalogue: DEFAULT_CATALOG,
  selections: [
    { key: "extra-building", quantity: 1, mode: null },
    { key: "kiosk", quantity: 2, mode: "rent" },
    { key: "rfid-card-printed", quantity: 300, mode: null },
    { key: "installation", quantity: 1, mode: null },
    { key: "support-care", quantity: 1, mode: null },
  ],
});
const order = {
  _id: "66f0c0ffee0000000000abcd",
  organizationName: "Harborview Reading Room",
  plan: "building",
  planName: "Building",
  billingPeriod: "yearly",
  quotedAmount: quote.plan.perMonth, // the plan's price per month, in centavos
  currency: "PHP",
  quote,
  deploymentUrl: "https://harborview.silla.example",
};

const samples = {
  "01-verification": t.verificationEmail({ account, code: "482913", expiryMinutes: 10 }),
  "02-welcome": t.welcomeEmail({ account }),
  "03-email-change-code": t.emailChangeCodeEmail({ account, newEmail: "ana.reyes@harborview.org", code: "730144", expiryMinutes: 10 }),
  "04-email-changed-notice": t.emailChangedNoticeEmail({ account, oldEmail: "ana@harborview.org", newEmail: "ana.reyes@harborview.org" }),
  "05-password-changed": t.passwordChangedEmail({ account }),
  "06-password-reset": t.passwordResetEmail({ account, code: "209385", expiryMinutes: 10 }),
  "07-order-submitted": t.orderSubmittedEmail({ account, order }),
  "08-order-internal": t.orderSubmittedInternalEmail({ account, order, to: "orders@silla.example" }),
  "09-order-provisioning": t.orderProvisioningEmail({ account, order }),
  "10-order-live": t.orderLiveEmail({ account, order }),
  "11-order-cancelled": t.orderCancelledEmail({ account, order, reason: "Duplicate of an earlier order" }),
};

/* ── billing (services/email/billingTemplates.js) ── */

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY);
const settings = {
  business: { name: "SILLA Technologies Inc.", email: "billing@silla.example", phone: "+63 2 8555 0142" },
  payment: {
    instructions: "Send the exact amount, then press “I've paid” on the invoice and enter the reference number from your receipt.",
    methods: [
      { label: "BDO bank transfer", details: "SILLA Technologies Inc. · Account 0012 3456 7890" },
      { label: "GCash", details: "0917 555 0142 · SILLA T." },
    ],
  },
  billing: { trialDays: 14, graceDays: 7, renewalNoticeDays: 7 },
};
const invoice = {
  _id: "66f0c0ffee0000000000beef",
  number: "SILLA-2026-00012",
  kind: "first",
  organizationName: "Harborview Reading Room",
  billTo: { name: "Ana Reyes", email: "accounts@harborview.example" },
  // The first invoice the order above is issued with.
  lines: quote.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitAmount: l.kind === "one_time" ? (l.waived ? 0 : l.unitAmount) : l.periodUnitAmount,
    amount: l.amount,
    note: l.kind === "one_time" ? l.note : "",
  })),
  subtotal: quote.totals.firstInvoice.subtotal,
  tax: { label: "VAT 12%", rate: 0.12, amount: Math.round(quote.totals.firstInvoice.subtotal * 0.12) },
  total: quote.totals.firstInvoice.subtotal + Math.round(quote.totals.firstInvoice.subtotal * 0.12),
  currency: "PHP",
  issuedAt: at(-6),
  dueAt: at(1),
};
const renewalLines = quote.lines
  .filter((l) => l.kind !== "one_time")
  .map((l) => ({
    description: l.description.replace("first year", "renewal, 1 year").replace(" (12-month minimum)", ""),
    quantity: l.quantity,
    unitAmount: l.periodUnitAmount,
    amount: l.amount,
  }));
const renewal = {
  ...invoice,
  number: "SILLA-2026-00031",
  kind: "renewal",
  lines: renewalLines,
  subtotal: quote.totals.renewal.subtotal,
  tax: { label: "VAT 12%", rate: 0.12, amount: Math.round(quote.totals.renewal.subtotal * 0.12) },
  total: quote.totals.renewal.subtotal + Math.round(quote.totals.renewal.subtotal * 0.12),
  dueAt: at(7),
};
const overdue = { ...invoice, number: "SILLA-2026-00027", issuedAt: at(-16), dueAt: at(-9) };
const paid = {
  ...invoice,
  status: "paid",
  payment: { method: "bank_transfer", reference: "BDO-20261017-4471", amount: 92_736_00, receivedAt: at(0) },
};
const claimed = {
  ...overdue,
  claimedPayment: { method: "gcash", reference: "9017 223 4410", amount: 92_736_00, paidAt: at(-1), note: "Paid from my personal GCash." },
};
const dismissed = { ...claimed, claimedPayment: { ...claimed.claimedPayment, dismissNote: "No GCash transfer with that reference has arrived yet." } };
const subscription = {
  organizationName: "Harborview Reading Room",
  planName: "Building",
  billingPeriod: "yearly",
  price: { amount: 72_000_00, currency: "PHP" },
  status: "active",
  currentPeriodEnd: at(365),
  trialEndsAt: at(3),
  graceEndsAt: at(5),
};

Object.assign(samples, {
  "12-invoice-first": b.invoiceIssuedEmail({ invoice, account, settings }),
  "13-invoice-renewal": b.invoiceIssuedEmail({ invoice: renewal, account, settings }),
  "14-invoice-due-soon": b.invoiceDueSoonEmail({ invoice, account, settings }),
  "15-invoice-overdue-grace": b.invoiceOverdueEmail({ invoice: overdue, account, settings, subscription: { ...subscription, status: "past_due" }, graceEndsAt: at(5) }),
  "16-invoice-overdue-trial": b.invoiceOverdueEmail({ invoice: overdue, account, settings, subscription: { ...subscription, status: "trialing" } }),
  "17-payment-receipt": b.paymentReceiptEmail({ invoice: paid, account, subscription }),
  "18-payment-receipt-reactivated": b.paymentReceiptEmail({ invoice: paid, account, subscription, reactivated: true }),
  "19-payment-claim-internal": b.paymentClaimEmail({ to: "orders@silla.example", invoice: claimed, account }),
  "20-payment-claim-dismissed": b.paymentClaimDismissedEmail({ invoice: dismissed, account }),
  "21-trial-ending": b.trialEndingEmail({ subscription: { ...subscription, status: "trialing" }, account, invoice, settings }),
  "22-suspended-unpaid": b.subscriptionSuspendedEmail({ subscription: { ...subscription, status: "suspended" }, account, invoice: overdue, settings }),
  "23-suspended-by-staff": b.subscriptionSuspendedEmail({ subscription: { ...subscription, status: "suspended" }, account, reason: "Paused at your request while the building is renovated." }),
  "24-reactivated": b.subscriptionReactivatedEmail({ subscription, account }),
  "25-plan-changed": b.planChangedEmail({ subscription: { ...subscription, planName: "Campus", price: { amount: 180_000_00, currency: "PHP" } }, account, fromName: "Building" }),
  "25b-add-ons-changed": b.addOnsChangedEmail({
    subscription,
    account,
    before: [{ key: "extra-building", name: "Extra building", kind: "recurring", quantity: 1, unitAmount: 2_500_00 }],
    after: [
      { key: "extra-building", name: "Extra building", kind: "recurring", quantity: 2, unitAmount: 2_500_00 },
      { key: "kiosk", name: "SILLA Kiosk", kind: "rental", quantity: 2, unitAmount: 1_500_00 },
      { key: "support-care", name: "Care support", kind: "recurring", quantity: 1, unitAmount: 1_500_00 },
    ],
  }),
  "26-cancelled": b.subscriptionCancelledEmail({ subscription: { ...subscription, status: "cancelled" }, account, reason: "Moving to another provider at the end of the school year." }),
});

/* ── the staff console (services/email/staffTemplates.js) ── */

const staffer = { firstName: "Sam", lastName: "Santos", name: "Sam Santos", email: "sam@silla.example" };
const owner = { firstName: "Olive", lastName: "Ocampo", name: "Olive Ocampo", email: "olive@silla.example" };
const conversation = { _id: "66f0c0ffee0000000000c0de", subject: "Can the reading room go live first?" };
Object.assign(samples, {
  "27-staff-invitation": st.staffInvitationEmail({
    account: staffer,
    code: "583120",
    invitedBy: owner,
    roleLabel: "Support",
    roleSummary: "orders, clients, conversations and owner-access resets",
    expiryHours: 72,
  }),
  "28-conversation-reply": st.conversationReplyEmail({
    account,
    conversation,
    latest: { authorName: "Sam Santos", body: "Yes — we'll bring the reading room up first and the stacks on Friday. You'll get an email the moment it's live." },
    unread: 2,
    organizationName: order.organizationName,
  }),
  "29-conversation-staff-notice": st.conversationStaffNoticeEmail({
    to: staffer.email,
    account: { ...account, organizationName: "Harborview" },
    conversation,
    latest: { body: "Thanks! One more thing — can members book the group rooms whole, or only seat by seat?" },
    unread: 1,
    organizationName: order.organizationName,
    assignee: staffer,
  }),
});

for (const [name, mail] of Object.entries(samples)) {
  writeFileSync(path.join(out, `${name}.html`), mail.html);
  writeFileSync(path.join(out, `${name}.txt`), `Subject: ${mail.subject}\nTo: ${mail.to}\n\n${mail.text}`);
}
console.log(`  wrote ${Object.keys(samples).length} emails to ${out}`);
