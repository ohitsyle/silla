import mongoose from "mongoose";
import areaSchema from "./areaSchema.js";

/**
 * Floor — a level within a site (spec §2). Each floor has its own
 * resource grid (spec §12). Grid dimensions are in integer cells —
 * the whole map/editor model depends on staying grid-aligned, never
 * free-pixel (spec §12, "The Space Map").
 *
 * `shape` is the floor's outline, for a building that is not a rectangle:
 * the rectangles whose cells ARE the floor (an L is two). Everything else
 * in the grid is not floor, and nothing can be placed there. Absent or
 * empty means the whole grid, which is what every floor written before
 * outlines existed means, so none of them needed migrating.
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
    building: { type: mongoose.Schema.Types.ObjectId, ref: "Building", default: null, index: true },
    order: { type: Number, default: 0 }, // display order in the floor switcher
    grid: {
      cols: { type: Number, required: true, default: 20 },
      rows: { type: Number, required: true, default: 12 },
    },
    shape: {
      areas: { type: [areaSchema], default: undefined },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Floor", floorSchema);
