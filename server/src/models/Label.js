import mongoose from "mongoose";

/**
 * Label — layer 3 of the three-layer map model (spec §12). Free-typed
 * text positioned on the map purely for orientation ("Storage",
 * "Reception"). Not reservable, not a zone, invisible to analytics —
 * this is deliberately the cheapest layer, by design.
 */
const labelSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    floor: { type: mongoose.Schema.Types.ObjectId, ref: "Floor", required: true, index: true },
    text: { type: String, required: true, trim: true },
    position: {
      col: { type: Number, required: true },
      row: { type: Number, required: true },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Label", labelSchema);
