import mongoose from "mongoose";

// INF-1 extension: a site can contain several independently mapped buildings.
const schema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  site: { type: mongoose.Schema.Types.ObjectId, ref: "Site", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  order: { type: Number, default: 0 },
}, { timestamps: true });
export default mongoose.model("Building", schema);
