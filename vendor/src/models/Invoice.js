import mongoose from "mongoose";

/**
 * A bill. Issued by services/billing.js (first invoice on order
 * submission, renewals by the billing job) or by staff by hand.
 *
 * Payment is recorded by SILLA staff against the money actually received
 * (bank transfer, GCash, Maya, cash) — there is no card processor yet, so
 * the buyer's "I've paid" is a CLAIM (`claimedPayment`) that staff
 * confirm, never a payment by itself.
 *
 * Amounts are minor units. `overdue` is not a status: it is
 * `status === "open" && dueAt < now`, computed, so it can never disagree
 * with the clock.
 */
export const INVOICE_STATUS = ["draft", "open", "paid", "void"];
export const PAYMENT_METHODS = ["bank_transfer", "gcash", "maya", "cash", "card", "other"];

const invoiceSchema = new mongoose.Schema(
  {
    /** Human, sequential, never reused: SILLA-2026-00001 (models/Counter.js). */
    number: { type: String, required: true, unique: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    organizationName: { type: String, default: "" },

    /**
     * Who is billing, frozen at issue like billTo. SILLA's TIN, address and
     * VAT registration are part of what a tax invoice SAYS, and VAT was
     * computed from that registration at issue — reading today's Settings
     * when printing an old invoice would put "VAT-registered" on a bill
     * that charged none. Payment instructions are deliberately NOT frozen:
     * how to pay an open invoice is whatever account works today.
     */
    issuer: {
      name: { type: String, default: "" },
      address: { type: [String], default: [] },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      taxId: { type: String, default: "" },
      vatRegistered: { type: Boolean, default: false },
    },

    /** Who it is addressed to, frozen at issue — later profile edits don't rewrite a sent invoice. */
    billTo: {
      name: { type: String, default: "" },
      company: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: [String], default: [] },
      taxId: { type: String, default: "" },
    },

    lines: [
      {
        description: { type: String, required: true },
        quantity: { type: Number, default: 1 },
        unitAmount: { type: Number, required: true },
        amount: { type: Number, required: true },
      },
    ],
    subtotal: { type: Number, required: true },
    tax: {
      label: { type: String, default: "" },
      rate: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
    },
    total: { type: Number, required: true },
    currency: { type: String, default: "PHP" },

    /** The service period this invoice pays for (null for one-off charges). */
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    /** "first" | "renewal" | "manual" — why it exists. */
    kind: { type: String, enum: ["first", "renewal", "manual"], default: "manual" },
    /**
     * Whether paying this buys the subscription one billing period —
     * activating it, or extending it. True for first and renewal invoices;
     * a manual invoice says which it is (a setup fee does not extend
     * anything; the first invoice of a plan priced by hand does). Stored
     * rather than derived from `kind` so one rule, in services/billing.js,
     * decides what a payment does.
     */
    extendsSubscription: { type: Boolean, default: false },
    /**
     * How much service an extending invoice buys, recorded at issue — so
     * moving a customer from monthly to yearly afterwards cannot turn the
     * month they paid for into a year.
     */
    billingPeriod: { type: String, enum: ["monthly", "yearly", null], default: null },
    /** Free text staff add to a manual invoice; printed under the lines. */
    memo: { type: String, default: "" },

    status: { type: String, enum: INVOICE_STATUS, default: "open", index: true },
    issuedAt: { type: Date, default: Date.now },
    dueAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: "" },

    payment: {
      method: { type: String, enum: [...PAYMENT_METHODS, null], default: null },
      reference: { type: String, default: "" },
      amount: { type: Number, default: null },
      receivedAt: { type: Date, default: null },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
      note: { type: String, default: "" },
    },
    claimedPayment: {
      method: { type: String, enum: [...PAYMENT_METHODS, null], default: null },
      reference: { type: String, default: "" },
      amount: { type: Number, default: null },
      paidAt: { type: Date, default: null },
      note: { type: String, default: "" },
      submittedAt: { type: Date, default: null },
      /**
       * Staff looked and could not find this money. The claim stays on
       * the record with the reason, so the buyer sees an answer rather
       * than their "I've paid" silently vanishing; claiming again
       * replaces it.
       */
      dismissedAt: { type: Date, default: null },
      dismissNote: { type: String, default: "" },
    },

    /** Which reminder emails went out, so the job sends each once. */
    reminders: {
      issuedEmailAt: { type: Date, default: null },
      dueSoonAt: { type: Date, default: null },
      overdueAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

invoiceSchema.index({ status: 1, dueAt: 1 });

/*
 * At most one first invoice per subscription, and one renewal per period.
 * These are what make the billing job safe to run twice — or in two
 * processes at once: a duplicate insert fails here instead of billing a
 * customer twice for the same year. A VOIDED renewal still occupies its
 * period on purpose: staff voided it for a reason, and the job must not
 * quietly issue it again. Distinct key patterns from `subscription_1`
 * above, which MongoDB would otherwise refuse as a conflicting index.
 */
invoiceSchema.index({ subscription: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: "first" } });
invoiceSchema.index(
  { subscription: 1, periodStart: 1 },
  { unique: true, partialFilterExpression: { kind: "renewal" } }
);

export default mongoose.model("Invoice", invoiceSchema);
