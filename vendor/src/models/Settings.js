import mongoose from "mongoose";

/**
 * SILLA's own business settings — one document. What goes on every
 * invoice (who is billing, their TIN, whether VAT applies), how a
 * customer should pay, and the billing rhythm. Edited by staff in the
 * console's Settings section; read through services/billing.js.
 *
 * Nothing here is a secret. Bank account numbers on an invoice are meant
 * to be read by the customer paying it.
 */
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "singleton", unique: true },
    business: {
      name: { type: String, default: "SILLA" },
      address: { type: [String], default: [] },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      taxId: { type: String, default: "" },
      vatRegistered: { type: Boolean, default: false },
      vatRate: { type: Number, default: 0.12 },
    },
    payment: {
      /** Shown on every invoice and on the buyer's billing page. Plain text, one method per line. */
      instructions: { type: String, default: "" },
      methods: [
        {
          label: { type: String, required: true }, // "BDO bank transfer", "GCash"
          details: { type: String, default: "" }, // account name and number
        },
      ],
    },
    invoice: {
      prefix: { type: String, default: "SILLA" },
      dueDays: { type: Number, default: 7 },
      footer: { type: String, default: "" },
    },
    billing: {
      trialDays: { type: Number, default: 14 },
      graceDays: { type: Number, default: 7 },
      renewalNoticeDays: { type: Number, default: 7 },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Settings", settingsSchema);
