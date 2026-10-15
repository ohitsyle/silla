import mongoose from "mongoose";
import areaSchema from "./areaSchema.js";

// A room is one booking boundary. Its levels are shapes on building floors;
// a balcony and a ground-level hall therefore share one reservation identity.
//
// A level's shape is `areas`, a list of rectangles whose union is the room
// on that floor (an L-shaped room is two). `bounds` is their bounding box,
// kept so anything that predates shapes still finds roughly where the room
// is. Levels written before shapes have only `bounds`, and that one
// rectangle is their shape (lib/cells.js regionAreas); nothing was migrated.
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
    areas: { type: [areaSchema], default: undefined },
  }],
}, { timestamps: true });
schema.index({ organization: 1, "levels.floor": 1 });
export default mongoose.model("Room", schema);
