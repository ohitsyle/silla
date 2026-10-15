import mongoose from "mongoose";
import areaSchema from "./areaSchema.js";

/**
 * Zone — layer 2 of the three-layer map model (spec §12). An
 * admin-drawn named area that groups resources. Resource
 * membership is DERIVED from position (a resource sits inside a
 * zone's cells) — never tagged by hand. Named only in v1;
 * per-zone rules/types are future work.
 *
 * Like a room level, a zone's shape is `areas` (rectangles whose union is
 * the zone) with `bounds` as their bounding box; a zone written before
 * shapes has only `bounds`, and that rectangle is its shape.
 */
const zoneSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    floor: { type: mongoose.Schema.Types.ObjectId, ref: "Floor", required: true, index: true },
    name: { type: String, required: true, trim: true },
    bounds: {
      col: { type: Number, required: true },
      row: { type: Number, required: true },
      w: { type: Number, required: true },
      h: { type: Number, required: true },
    },
    areas: { type: [areaSchema], default: undefined },
  },
  { timestamps: true }
);

export default mongoose.model("Zone", zoneSchema);
