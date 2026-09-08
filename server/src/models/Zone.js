import mongoose from "mongoose";

/**
 * Zone — layer 2 of the three-layer map model (spec §12). An
 * admin-drawn named rectangle that groups resources. Resource
 * membership is DERIVED from position (a resource sits inside a
 * zone's cell range) — never tagged by hand. Named only in v1;
 * per-zone rules/types are future work.
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
  },
  { timestamps: true }
);

export default mongoose.model("Zone", zoneSchema);
