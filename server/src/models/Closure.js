import mongoose from "mongoose";

/**
 * Closure — a scheduled period when the organization (or one site) is
 * shut (spec §14, ADM-5). The reservation engine validates against these
 * so nobody books a closed period (RES-7), and creating one cancels any
 * reservations already inside it, emailing the affected members with the
 * staff-entered reason (NOT-5).
 */
const closureSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    // null = the whole organization is closed for this period.
    site: { type: mongoose.Schema.Types.ObjectId, ref: "Site", default: null },

    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },

    reason: { type: String, required: true, trim: true }, // included in the cancellation email
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Set once the closure's cancellations have been processed, so a
    // restart doesn't re-cancel and re-email.
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

closureSchema.index({ organization: 1, startTime: 1, endTime: 1 });

export default mongoose.model("Closure", closureSchema);
