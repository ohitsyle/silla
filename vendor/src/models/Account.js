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

const billingSchema = new mongoose.Schema(
  {
    // Who and where an invoice is addressed to. Deliberately NO card
    // data: a card number must never touch this database. When billing
    // lands it goes through the payment provider, and all we keep is the
    // provider's customer id (stripeCustomerId, below).
    name: { type: String, default: "", trim: true },
    company: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    address1: { type: String, default: "", trim: true },
    address2: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    region: { type: String, default: "", trim: true },
    postalCode: { type: String, default: "", trim: true },
    country: { type: String, default: "Philippines", trim: true },
    taxId: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    // One live code per account. Issuing a code for a different purpose
    // replaces the last one, so an old sign-up code can never be spent
    // confirming an email change.
    purpose: { type: String, enum: ["signup", "email-change", "password-reset"], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: Date.now },
    /** For email-change only: the address being moved to. */
    pendingEmail: { type: String, default: null, lowercase: true, trim: true },
  },
  { _id: false }
);

const accountSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },

    firstName: { type: String, default: "", trim: true },
    middleName: { type: String, default: "", trim: true },
    lastName: { type: String, default: "", trim: true },
    suffix: { type: String, default: "", trim: true },

    /**
     * The composed display name, kept as a stored field rather than a
     * virtual because the order queue populates `account` with
     * "name email" — a virtual would arrive empty there. Recomputed from
     * the parts on every save, so it cannot drift from them.
     */
    name: { type: String, trim: true, default: "" },

    /** The organization they are buying FOR. Absent for SILLA staff. */
    organizationName: { type: String, default: "", trim: true },

    role: { type: String, enum: ["buyer", "silla"], default: "buyer", index: true },

    /**
     * What a SILLA staff member may do inside the staff console — see
     * middleware/staff.js for the table. Null for buyers. A staff account
     * from before roles existed has none and is treated as an owner, which
     * is what every one of them effectively was.
     */
    staffRole: { type: String, enum: ["owner", "admin", "billing", "support", null], default: null },

    /**
     * An unverified account can sign in, explore and configure. It cannot
     * place an order: an order is a commercial commitment and the email
     * on it is where every update about that commitment goes.
     */
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    verification: { type: verificationSchema, default: null },

    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null },

    /**
     * Tokens issued before this moment are refused. Changing a password
     * has to sign out every other session, or it does not protect
     * against the thing people change passwords because of.
     */
    passwordChangedAt: { type: Date, default: null },

    billing: { type: billingSchema, default: () => ({}) },

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

accountSchema.pre("validate", function composeName(next) {
  const parts = [this.firstName, this.middleName, this.lastName].map((s) => String(s || "").trim()).filter(Boolean);
  const composed = parts.join(" ") + (this.suffix ? ` ${this.suffix.trim()}` : "");
  // Legacy accounts predate the split fields and only have `name`; keep
  // it rather than blanking it until they are migrated.
  if (composed.trim()) this.name = composed.trim();
  if (!this.name) this.invalidate("name", "A name is required.");
  next();
});

export default mongoose.model("Account", accountSchema);
