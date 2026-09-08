import mongoose from "mongoose";

/**
 * A configuration on its way to becoming a deployment.
 *
 * The wizard used to end at a downloaded file, which meant the record of
 * what someone wanted lived in their Downloads folder and our inbox.
 * This is that record: one row that a buyer can come back to, and that
 * SILLA can work through.
 *
 * A draft IS an order. Modelling "draft" as a separate collection would
 * mean copying the whole profile across on submit and then reconciling
 * two shapes forever; a status field costs nothing and keeps one id for
 * the life of the thing.
 */

/**
 * The lifecycle, and the only legal moves through it.
 *
 * Enforced in the route rather than left to whoever calls it: an order
 * that can jump from `draft` straight to `live` is one bad request away
 * from a deployment nobody built.
 */
export const ORDER_STATUS = ["draft", "submitted", "provisioning", "live", "cancelled"];

export const ALLOWED_TRANSITIONS = {
  draft: ["submitted", "cancelled"],
  submitted: ["provisioning", "cancelled"],
  provisioning: ["live", "submitted", "cancelled"],
  live: ["cancelled"],
  cancelled: [],
};

const orderSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },

    /**
     * The provisioning profile, exactly as the wizard emits it and
     * exactly as `server/src/scripts/importProfile.js` consumes it.
     * Stored as a free-form object on purpose: this service must not
     * grow a second opinion about the profile's shape, or the two will
     * disagree and the seeder is the one that matters.
     */
    profile: { type: mongoose.Schema.Types.Mixed, required: true },

    /** Denormalised for the queue, so listing orders needs no profile parsing. */
    organizationName: { type: String, required: true, trim: true },

    plan: { type: String, enum: ["room", "building", "campus"], required: true },
    billingPeriod: { type: String, enum: ["monthly", "yearly"], default: "yearly" },

    /**
     * What was quoted when the order was placed, in minor units (cents).
     * Recorded on the ORDER rather than read from the price list at
     * render time: a plan's price will change, and an order must still
     * say what this customer was actually offered.
     */
    quotedAmount: { type: Number, default: null },
    currency: { type: String, default: "USD" },

    status: { type: String, enum: ORDER_STATUS, default: "draft", index: true },

    /**
     * Every move, with who made it. An order changing state with no
     * record of who did it is the kind of thing you only miss once.
     */
    history: [
      {
        status: { type: String, enum: ORDER_STATUS },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
        note: { type: String, default: "" },
      },
    ],

    /** Filled in by SILLA once the deployment exists. */
    deploymentUrl: { type: String, default: "" },
    provisionedOrganizationId: { type: String, default: "" },

    // ---- Billing seam ----
    // Nullable now, populated when Stripe lands. Kept on the order
    // because a subscription belongs to a purchase; the customer id
    // lives on the Account, which is the thing that persists across
    // several of these.
    stripeSubscriptionId: { type: String, default: null },
    paidUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

/** The queue is read by status and recency far more than anything else. */
orderSchema.index({ status: 1, updatedAt: -1 });

export default mongoose.model("Order", orderSchema);
