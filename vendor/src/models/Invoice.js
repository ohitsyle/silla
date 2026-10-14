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

export default mongoose.model("Invoice", invoiceSchema);
