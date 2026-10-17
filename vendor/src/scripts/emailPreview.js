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

const out = path.resolve(process.argv[2] || "email-preview");
mkdirSync(out, { recursive: true });

const account = { firstName: "Ana", lastName: "Reyes", name: "Ana Reyes", email: "ana@harborview.org" };
const order = {
  _id: "66f0c0ffee0000000000abcd",
  organizationName: "Harborview Reading Room",
  plan: "building",
  planName: "Whole Building",
  billingPeriod: "yearly",
  quotedAmount: 6_900_00, // per month, in centavos
  currency: "PHP",
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
  lines: [{ description: "Whole Building plan — first year", quantity: 1, unitAmount: 82_800_00, amount: 82_800_00 }],
  subtotal: 82_800_00,
  tax: { label: "VAT 12%", rate: 0.12, amount: 9_936_00 },
  total: 92_736_00,
  currency: "PHP",
  issuedAt: at(-6),
  dueAt: at(1),
};
const renewal = { ...invoice, number: "SILLA-2026-00031", kind: "renewal", lines: [{ ...invoice.lines[0], description: "Whole Building plan — renewal, 1 year" }], dueAt: at(7) };
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
  planName: "Whole Building",
  billingPeriod: "yearly",
  price: { amount: 82_800_00, currency: "PHP" },
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
  "25-plan-changed": b.planChangedEmail({ subscription: { ...subscription, planName: "Campus", price: { amount: null, currency: "PHP" } }, account, fromName: "Whole Building" }),
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
