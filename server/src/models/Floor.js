import mongoose from "mongoose";

/**
 * Floor — a level within a site (spec §2). Each floor has its own
 * resource grid (spec §12). Grid dimensions are in integer cells —
 * the whole map/editor model depends on staying grid-aligned, never
 * free-pixel (spec §12, "The Space Map").
 */
const floorSchema = new mongoose.Schema(
  {
    site: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Site",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true }, // "Ground Floor", "2F", ...
    order: { type: Number, default: 0 }, // display order in the floor switcher
    grid: {
      cols: { type: Number, required: true, default: 20 },
      rows: { type: Number, required: true, default: 12 },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Floor", floorSchema);
