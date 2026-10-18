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

    /**
     * A plan key from the catalogue (models/Plan.js). Not an enum: staff
     * create plans in the console, and an order for one has to be
     * possible. order.routes.js checks the key against the catalogue
     * (billing.planByKey) — an ACTIVE plan for anything new — which is the
     * rule a fixed list here could only ever approximate.
     */
    plan: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    /** The plan's name when the order was saved, so a list or an email needs no lookup — and a renamed plan doesn't rename history. */
    planName: { type: String, default: "", trim: true },
    billingPeriod: { type: String, enum: ["monthly", "yearly"], default: "yearly" },

    /**
     * The PLAN's price per month on the chosen billing period, in minor
     * units — the figure on the pricing card ("₱6,000/month, billed
     * yearly"), and the meaning this field has always had. Only the plan:
     * the whole order's price is `quote`. Set by the SERVER from the
     * catalogue when a draft is saved and from the frozen quote at
     * submission; whatever a browser sends here is ignored.
     */
    quotedAmount: { type: Number, default: null },
    currency: { type: String, default: "PHP" },

    /**
     * What the buyer chose besides the plan: catalogue keys
     * (models/CatalogItem.js) with a quantity, and "buy" or "rent" for
     * what can be either. ONLY these three fields — lib/quote.js
     * readSelections drops anything sent beside them, prices included. A
     * draft may hold any; every save is priced against the catalogue and
     * refused with the problems, by field, if it can't be ordered.
     */
    selections: [
      {
        _id: false,
        key: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        mode: { type: String, enum: ["buy", "rent", null], default: null },
      },
    ],

    /**
     * The quote FROZEN at submission — lib/quote.js buildQuote, computed on
     * the server from the plans, the catalogue and the VAT settings at that
     * moment: every line, the one-time, per-month and first-invoice
     * totals, the limits it buys, the rental commitments. Null on a draft,
     * which is priced live. Never rewritten afterwards: staff changing the
     * catalogue changes NEW quotes, not this one, and the first invoice
     * and the subscription's add-ons are issued from it.
     */
    quote: { type: mongoose.Schema.Types.Mixed, default: null },
    quotedAt: { type: Date, default: null },

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

    /**
     * Staff-only notes — what was agreed on a call, why an order is on
     * hold. Separate from `history[].note` on purpose: a transition's note
     * is part of the record the BUYER reads on their order page (and a
     * cancellation reason is emailed to them), while these are never
     * returned by any buyer-facing route. Two fields, so nobody has to
     * remember which kind of note is safe to write where.
     */
    notes: [
      {
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
        body: { type: String, required: true, trim: true, maxlength: 4000 },
      },
    ],

    /** Filled in by SILLA once the deployment exists. */
    deploymentUrl: { type: String, default: "" },
    provisionedOrganizationId: { type: String, default: "" },
    /** The organization's address segment (`<PRODUCT_URL>/<slug>`), when provisioned through the control plane. */
    deploymentSlug: { type: String, default: "" },
    provisionedAt: { type: Date, default: null },

    /**
     * Held while one staff member's PROVISION call is in flight
     * (routes/deployments.routes.js). Two people pressing the button at
     * once would otherwise build two organizations for one order. Taken
     * with a conditional update, released when the call returns; a claim
     * older than the call's own timeout is stale and may be taken over.
     */
    provisioningClaim: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null },
    },

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
