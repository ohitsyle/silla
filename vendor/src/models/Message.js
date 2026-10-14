import mongoose from "mongoose";

/**
 * One message in a Conversation. `internal` messages are staff-only notes
 * on the thread: never returned to the buyer, never emailed to them, never
 * counted in their unread badge. That rule is enforced in the routes'
 * QUERIES, not by filtering a response afterwards.
 */
const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
    authorRole: { type: String, enum: ["buyer", "staff"], required: true },
    /** Denormalised so a thread reads correctly after a rename. */
    authorName: { type: String, default: "" },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    internal: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

export default mongoose.model("Message", messageSchema);
