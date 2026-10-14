import mongoose from "mongoose";

/**
 * Resource — one placed instance of a ResourceType on a floor's grid
 * (spec §8, §12, layer 1 of the three-layer map model: "Resources").
 * Position is integer cell coordinates only — never free pixels.
 *
 * The live `status` fields below are intentionally kept on this
 * document but are logically the "fast-changing" half of the map:
 * layout (position, type) rarely changes; status changes constantly.
 * The API should stream status over Socket.io rather than re-sending
 * full layout on every occupancy change (spec §12, §17).
 */
const resourceSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    floor: { type: mongoose.Schema.Types.ObjectId, ref: "Floor", required: true, index: true },
    resourceType: { type: mongoose.Schema.Types.ObjectId, ref: "ResourceType", required: true },
    zone: { type: mongoose.Schema.Types.ObjectId, ref: "Zone", default: null },
    // Room booking targets use the existing reservation/check-in lifecycle but
    // never appear as furniture or contribute an extra seat to capacity totals.
    kind: { type: String, enum: ["piece", "room"], default: "piece" },
    room: { type: mongoose.Schema.Types.ObjectId, ref: "Room", default: null },

    position: {
      col: { type: Number, required: true },
      row: { type: Number, required: true },
    },

    // Sub-units for multi-seat pieces (e.g. a long table's individual seats).
    // For a 1-seat piece this array has exactly one entry.
    units: [
      {
        label: { type: String, default: "1" }, // "Seat 1", "Seat 2", ...
        status: {
          type: String,
          enum: ["available", "reserved", "occupied", "unavailable"],
          default: "available",
        },
        serviceStatus: {
          type: String,
          enum: ["working", "out_of_service"],
          default: "working",
        },
        overstay: { type: Boolean, default: false }, // staff-only flag, spec §10
      },
    ],
  },
  { timestamps: true }
);

resourceSchema.index({ floor: 1, "position.col": 1, "position.row": 1 });

export default mongoose.model("Resource", resourceSchema);
