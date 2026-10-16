import mongoose from "mongoose";
import { ENTITLEMENT_STATUS } from "../lib/plans.js";

/**
 * Organization — the top of the white-label hierarchy (spec §2).
 * One deployment serves ONE organization. Everything that differs
 * between buyers lives in `config` here, read at runtime instead
 * of hardcoded — this is what makes SILLA white-label (spec §16).
 */
const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Written BEFORE reading booking/layout constraints in a transaction. This
    // shared write prevents snapshot-isolation write skew across room and seat.
    spaceRevision: { type: Number, default: 0, select: false },

    /**
     * The organization's address in the product: <client>/<slug>/map.
     * One front end serves every organization and the first path segment
     * says which — see lib/slug.js for the rules. Sparse, so an
     * organization created before addresses existed still loads until
     * `npm run migrate:slugs` gives it one.
     */
    slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

    /**
     * What this organization's subscription allows. Written ONLY by
     * SILLA's control plane (vendor/), through the signed internal API;
     * interpreted ONLY by services/entitlements.js.
     *
     * `managed: false` — every organization that predates subscriptions,
     * and the demo — means every feature and no limits, so nothing that
     * exists today breaks. `features` and `limits` are keyed by
     * lib/plans.js; a key they do not mention is allowed.
     */
    entitlements: {
      managed: { type: Boolean, default: false },
      plan: { type: String, default: null },
      planName: { type: String, default: null },
      status: { type: String, enum: ENTITLEMENT_STATUS, default: "active" },
      features: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      currentPeriodEnd: { type: Date, default: null },
      graceEndsAt: { type: Date, default: null },
      // A line from SILLA staff shown to the organization's administrators,
      // e.g. "Your invoice is overdue — contact billing@…".
      notice: { type: String, default: null },
      // Monotonic, set by the control plane. An older push arriving late
      // is ignored rather than undoing a newer one.
      version: { type: Number, default: 0 },
      syncedAt: { type: Date, default: null },
    },

    /**
     * Which order this deployment was provisioned for, when SILLA's
     * control plane created it (services/provisioning.js). One order, one
     * organization: a provisioning call that timed out on the vendor's
     * side and was retried must not mint a second deployment. No defaults
     * on purpose — the unique index below is sparse, and a stored null
     * would collide with every other organization's null.
     */
    provisioning: {
      orderId: { type: String, trim: true },
      provisionedAt: { type: Date },
    },

    // ---- Organization identity / branding (spec §16) ----
    //
    // The full design-system palette, not just an accent. Every field is
    // optional: whatever an organization leaves unset falls back to the
    // product's neutral defaults in client/src/index.css. That matters —
    // a buyer whose brand is a dark green needs to restyle the surface
    // and the ink, not only the button colour, or the result looks like
    // someone else's product with one swatch changed.
    //
    // Values may be any CSS colour the client can parse (#rgb, #rrggbb,
    // rgb()/rgba()); applyOrgTheme.js normalises them.
    branding: {
      logoUrl: { type: String, default: null },

      // The accent — the one token nearly every deployment sets.
      primaryColor: { type: String, default: "#22D3EE" },
      accentTextColor: { type: String, default: "#04222B" },

      // Surface: page background, cards, panels, and the hairline colour
      // borders are drawn from (used with alpha).
      surface: {
        page: { type: String, default: null },
        pageEnd: { type: String, default: null },
        card: { type: String, default: null },
        panel: { type: String, default: null },
        line: { type: String, default: null },
      },

      // Text.
      ink: {
        primary: { type: String, default: null },
        secondary: { type: String, default: null },
        muted: { type: String, default: null },
      },

      // Resource states (spec §12). Deliberately separate from `accent`:
      // a buyer whose brand colour is green must not end up with
      // "available" and "branding" reading as the same thing.
      states: {
        available: { type: String, default: null },
        reserved: { type: String, default: null },
        occupied: { type: String, default: null },
        unavailable: { type: String, default: null },
        overstay: { type: String, default: null },
      },
    },

    // ---- Terminology (spec §16) ----
    // These defaults are the PRODUCT's, not any buyer's, so they must be
    // vertical-neutral. A deployment overrides them at install ("seat" /
    // "student" for a library, "desk" / "employee" for an office); an
    // org that never configures them should read as generic, not as a
    // school that forgot to fill in a form.
    terminology: {
      resourceNoun: { type: String, default: "resource" }, // "seat" | "desk" | "spot" | ...
      memberNoun: { type: String, default: "member" },     // "student" | "employee" | "member"
      facilityLabel: { type: String, default: "facility" },// "Library" | "Office" | ...
    },

    // ---- Identity & check-in (spec §4, §13, §16) ----
    identity: {
      memberIdFormat: { type: String, default: "####-######" }, // display pattern only
      checkInMethod: {
        type: String,
        enum: ["rfid", "qr", "both"],
        default: "rfid", // v1 default — QR is fast-follow (spec §13)
      },
      selfServiceRegistration: { type: Boolean, default: true }, // v1 default (spec §4)
    },

    // ---- Policy numbers (spec §9–11, §16) ----
    policy: {
      gracePeriodMinutes: { type: Number, default: 10 },
      maxStayHours: { type: Number, default: 4 },
      pinLockoutThreshold: { type: Number, default: 5 },
      verificationCodeExpiryMinutes: { type: Number, default: 10 },
      operatingHours: {
        open: { type: String, default: "08:00" }, // 24h "HH:mm", org-local time
        close: { type: String, default: "19:00" },
      },
    },

    // ---- Privacy (spec §16 — presence lookup is fast-follow; field reserved now) ----
    privacy: {
      presenceVisibility: {
        type: String,
        enum: ["off", "opt-in"],
        default: "off",
      },
    },

    // ---- Content ----
    termsOfServiceText: { type: String, default: "" },

    status: {
      type: String,
      enum: ["open", "limited", "closed"],
      default: "open",
    },
  },
  { timestamps: true }
);

organizationSchema.index({ "provisioning.orderId": 1 }, { unique: true, sparse: true });

export default mongoose.model("Organization", organizationSchema);
