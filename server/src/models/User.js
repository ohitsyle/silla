import mongoose from "mongoose";

/**
 * User — covers all roles (spec §3). Two account origins (spec §6):
 *   - member: self-service kiosk registration, card-bound
 *   - staff / superadmin: provisioned by the org's superadmin via
 *     email, no card, no kiosk tap
 *
 * Login is always email + PIN regardless of role (spec §5). PIN is
 * stored as a bcrypt hash, never plaintext — hash it in the auth
 * service, not here.
 */
const userSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    role: {
      type: String,
      enum: ["member", "staff", "superadmin"],
      required: true,
      default: "member",
    },

    // ---- Identity ----
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, default: "" }, // optional — spec §4
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    memberId: { type: String, default: null }, // format configurable per org; null for staff

    // ---- Card binding (members only — spec §4, §7) ----
    cardUid: { type: String, default: null },

    // ---- Auth (spec §5) ----
    pinHash: { type: String, required: true },
    failedPinAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    // ADM-4 / ADM-3 — set when an account is provisioned with a
    // temporary PIN, or when staff reset one. Forces a change at next
    // login before anything else is allowed (spec §14).
    mustChangePin: { type: Boolean, default: false },

    // AUTH-4 — short-lived PIN reset code, hashed like the PIN itself.
    pinResetCode: { type: String, default: null },
    pinResetExpiresAt: { type: Date, default: null },

    // ---- Lifecycle flags (spec §4, §5) ----
    verified: { type: Boolean, default: false }, // email verification, pending-until-verified
    verificationCode: { type: String, default: null },
    verificationExpiresAt: { type: Date, default: null },
    termsAcceptedAt: { type: Date, default: null }, // null = first login still pending (spec §5)

    active: { type: Boolean, default: true }, // false = staff deactivated by superadmin
  },
  { timestamps: true }
);

// One user, one email, one card, per organization (spec §4 — "1:1 identity").
userSchema.index({ organization: 1, email: 1 }, { unique: true });
userSchema.index(
  { organization: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { memberId: { $type: "string" } } }
);
userSchema.index(
  { organization: 1, cardUid: 1 },
  { unique: true, partialFilterExpression: { cardUid: { $type: "string" } } }
);

export default mongoose.model("User", userSchema);
