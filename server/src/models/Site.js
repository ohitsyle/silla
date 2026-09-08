import mongoose from "mongoose";

/**
 * Site — a physical location belonging to an organization (spec §2).
 * An org may have one site (typical v1 case) or several (data model
 * supports multi-site now; the management UI for it is fast-follow).
 */
const siteSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Site", siteSchema);
