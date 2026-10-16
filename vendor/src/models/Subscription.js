import mongoose from "mongoose";

/**
 * One customer's ongoing agreement for one deployment.
 *
 * Created when an order is submitted (status "pending"), linked to the
 * deployment when SILLA provisions it, and from then on the thing whose
 * status decides whether that organization works. Every status change is
 * pushed to the deployment as an entitlement snapshot (services/billing.js
 * → lib/controlPlane.js → the product's /api/internal), so the product
 * never has to ask.
 *
 *   pending     ordered; not yet provisioned and not yet paid
 *   trialing    provisioned and usable before the first payment
 *   active      paid through currentPeriodEnd
 *   past_due    a period ended unpaid; still usable until graceEndsAt
 *   suspended   grace ran out (or staff suspended it): read-only
 *   cancelled   ended; data is kept, nothing works
 *
 * Data is never deleted by any of these. A suspended organization keeps
 * everything and comes back whole when paid.
 */
export const SUBSCRIPTION_STATUS = ["pending", "trialing", "active", "past_due", "suspended", "cancelled"];

const subscriptionSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },

    /** The product's Organization _id, once provisioned. Empty before. */
    organizationId: { type: String, default: "", index: true },
    organizationName: { type: String, default: "", trim: true },

    plan: { type: String, required: true }, // Plan.key
    planName: { type: String, default: "" },
    billingPeriod: { type: String, enum: ["monthly", "yearly"], default: "yearly" },
    /** What each period costs THIS customer, in minor units — agreed, so a catalogue change does not rewrite it. */
    price: {
      amount: { type: Number, default: null },
      currency: { type: String, default: "PHP" },
    },
    /**
     * True while nobody has agreed what this customer pays — a plan
     * "priced with you" (the Campus plan), or a move onto one. No invoice
     * is issued automatically until staff set `price`, and the billing job
     * never treats the customer as late for an invoice SILLA has not sent:
     * the console lists these as needing attention instead.
     */
    needsPricing: { type: Boolean, default: false, index: true },

    status: { type: String, enum: SUBSCRIPTION_STATUS, default: "pending", index: true },
    trialEndsAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null, index: true },
    graceEndsAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "" },

    /**
     * Per-client adjustments by SILLA staff, layered over the plan's own
     * features and limits — "dynamic per client" without a plan per
     * client. Keys from lib/planKeys.js; a limit of null means unlimited.
     */
    overrides: {
      features: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    },
    /** A line shown to the organization's administrators in the product. */
    notice: { type: String, default: null },

    /**
     * Subscription-level reminders already sent, so the billing job sends
     * each once. Invoice reminders live on the invoice (Invoice.reminders).
     * Moving the trial end clears `trialEndingAt`, so a new end gets its
     * own warning.
     */
    reminders: {
      trialEndingAt: { type: Date, default: null },
    },

    /**
     * The paid invoices whose period has been added to this subscription.
     * A payment becomes service time exactly once: the period is extended
     * and the invoice recorded here in ONE conditional update
     * (services/billing.js applyPaidInvoices), so two payments landing at
     * once both count, and a replayed one counts once. A paid invoice that
     * extends the subscription but is not listed here has not bought its
     * period yet — on a subscription that is still pending, that is
     * deliberate: the paid period starts when the deployment goes live.
     */
    appliedInvoices: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    /** The last push of this subscription's snapshot to its deployment. */
    sync: {
      version: { type: Number, default: 0 },
      syncedAt: { type: Date, default: null },
      error: { type: String, default: null },
    },

    history: [
      {
        at: { type: Date, default: Date.now },
        status: { type: String, enum: SUBSCRIPTION_STATUS },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
        note: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export default mongoose.model("Subscription", subscriptionSchema);
