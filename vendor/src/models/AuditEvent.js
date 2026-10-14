import mongoose from "mongoose";

/**
 * Who did what to whom, inside SILLA.
 *
 * Every staff action that changes a customer's order, subscription,
 * deployment or account — and every change to staff themselves — writes
 * one of these through lib/audit.js. Staff can suspend a customer's whole
 * organization from the console; an action with that reach must leave a
 * trail that the person taking it cannot edit. There is deliberately no
 * route that updates or deletes these.
 */
const auditEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null, index: true },
    // Denormalised: the trail must still read correctly after the actor's
    // account is renamed or deactivated.
    actorEmail: { type: String, default: "" },
    actorRole: { type: String, default: "" },
    /** Dotted verb, e.g. "order.status", "deployment.provision", "invoice.payment". */
    action: { type: String, required: true, index: true },
    target: {
      type: { type: String, default: "" }, // "order" | "account" | "subscription" | "invoice" | "deployment" | "staff" | "plan" | "settings"
      id: { type: String, default: "" },
      label: { type: String, default: "" }, // what a person would call it: an org name, an invoice number
    },
    /** One line a human can read in the activity log. */
    summary: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false }
);

auditEventSchema.index({ "target.type": 1, "target.id": 1, at: -1 });

export default mongoose.model("AuditEvent", auditEventSchema);
