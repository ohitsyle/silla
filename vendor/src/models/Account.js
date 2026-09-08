import mongoose from "mongoose";

/**
 * An account on SILLA's own storefront.
 *
 * This is NOT a user of any buyer's deployment. Those live in
 * server/src/models/User.js, are scoped to an Organization, and log in
 * with a 6-digit PIN at a kiosk or a wall-mounted screen. These are
 * people buying the product on the web, so: email and a real password,
 * no organization scope, and no PIN.
 *
 * Two roles share one model on purpose:
 *   buyer  — someone at a buying organization, sees only their own orders
 *   silla  — our team, sees the whole queue and moves orders through it
 *
 * One model rather than two means one login form, one session, one place
 * where authorization is decided. A second parallel auth system is how
 * you end up with a back door that nobody audits.
 */
const accountSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },

    name: { type: String, required: true, trim: true },
    /** The organization they are buying FOR. Absent for SILLA staff. */
    organizationName: { type: String, default: "", trim: true },

    role: { type: String, enum: ["buyer", "silla"], default: "buyer", index: true },

    // Reserved for when billing lands. Held here rather than on the
    // order because a customer is one Stripe customer across many
    // orders — putting it on the order would create a duplicate
    // customer per purchase.
    stripeCustomerId: { type: String, default: null },

    lastLoginAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("Account", accountSchema);
