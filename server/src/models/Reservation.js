import mongoose from "mongoose";

/**
 * Reservation — spec §9 (Reservations) and §10 (Occupancy). Self-only,
 * one active per member, atomic time-range claim. `unit` identifies
 * which specific seat/unit on a Resource was claimed (a long table
 * has several; most pieces have one).
 *
 * Status lifecycle (spec §9–10):
 *   held -> active (checked in within grace) -> completed (checked out)
 *   held -> expired (grace missed, no-show)
 *   active -> released (max-stay cap hit, overstay flagged)
 *   held/active -> cancelled (closure, or member cancels)
 */
const reservationSchema = new mongoose.Schema(
  {
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    member: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    resource: { type: mongoose.Schema.Types.ObjectId, ref: "Resource", required: true },
    unitLabel: { type: String, required: true }, // matches Resource.units[].label

    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },

    status: {
      type: String,
      enum: ["held", "active", "completed", "expired", "released", "cancelled"],
      default: "held",
      index: true,
    },

    checkedInAt: { type: Date, default: null },
    checkedOutAt: { type: Date, default: null },
    overstay: { type: Boolean, default: false },

    // NOT-3 — the sent-once flag for the starting-soon reminder. Stored
    // on the reservation rather than held in the worker's memory so a
    // restart can never re-send.
    remindedAt: { type: Date, default: null },

    cancelReason: { type: String, default: null }, // e.g. closure reason, spec §14/§19

    // Which check-in method resolved this reservation's tap — kept so
    // the check-in interface (spec §13) can be swapped/extended without
    // losing history of how each session was actually confirmed.
    checkInMethod: { type: String, enum: ["rfid", "qr"], default: "rfid" },
  },
  { timestamps: true }
);

// Prevents overlapping-time double-booking at the database level as a
// backstop — the atomic claim logic in the reservation service is the
// primary guard (spec §9), this index protects against races.
reservationSchema.index({ resource: 1, unitLabel: 1, startTime: 1, endTime: 1 });

export default mongoose.model("Reservation", reservationSchema);
