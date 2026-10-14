import mongoose from "mongoose";

/**
 * ResourceType — one entry in an organization's resource catalog
 * (spec §8). Vendor-configured per install, NOT buyer-editable in v1
 * — a library org gets tables/chairs/computer desks seeded; an office
 * org gets hot desks/meeting rooms seeded. Same mechanism either way.
 *
 * Footprint is fixed (w x h in grid cells) — no free-shaping or
 * resize. This constraint is what keeps the map editor buildable
 * (spec §8, §12).
 */
const resourceTypeSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    key: { type: String, required: true }, // "long_table", "hot_desk", ...
    internal: { type: Boolean, default: false },
    label: { type: String, required: true }, // display name, e.g. "Long Table"
    footprint: {
      w: { type: Number, required: true },
      h: { type: Number, required: true },
    },
    seatCount: { type: Number, default: 1 }, // how many reservable units this piece provides
    reservable: { type: Boolean, default: true }, // false for shelves/desks used only as labels' predecessor — see Label model
    icon: { type: String, default: "Armchair" }, // Lucide icon name
    hasServiceStatus: { type: Boolean, default: false }, // e.g. computer desks: working / out-of-service
  },
  { timestamps: true }
);

resourceTypeSchema.index({ organization: 1, key: 1 }, { unique: true });

export default mongoose.model("ResourceType", resourceTypeSchema);
