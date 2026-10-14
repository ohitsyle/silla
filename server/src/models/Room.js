import mongoose from "mongoose";

// A room is one booking boundary. Its levels are rectangles on building floors;
// a balcony and a ground-level hall therefore share one reservation identity.
const schema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  building: { type: mongoose.Schema.Types.ObjectId, ref: "Building", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  bookingMode: { type: String, enum: ["individual", "whole", "either"], default: "individual" },
  resource: { type: mongoose.Schema.Types.ObjectId, ref: "Resource", required: true },
  levels: [{
    floor: { type: mongoose.Schema.Types.ObjectId, ref: "Floor", required: true },
    name: { type: String, trim: true, maxlength: 80, default: "" },
    bounds: {
      col: { type: Number, required: true }, row: { type: Number, required: true },
      w: { type: Number, required: true }, h: { type: Number, required: true },
    },
  }],
}, { timestamps: true });
schema.index({ organization: 1, "levels.floor": 1 });
export default mongoose.model("Room", schema);
