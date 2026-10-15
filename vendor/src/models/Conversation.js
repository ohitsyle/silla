import mongoose from "mongoose";

/**
 * A thread between one buyer and SILLA staff — about an order, or about
 * anything. Messages live in models/Message.js.
 *
 * Unread counts are kept per side so the inbox and the buyer's menu can
 * show a badge without counting messages, and `notified` records when
 * each side was last emailed so a burst of replies sends one email, not
 * ten (see workers/conversation.jobs.js).
 */
const conversationSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null, index: true },

    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "" },
    lastMessageBy: { type: String, enum: ["buyer", "staff", null], default: null },

    unread: {
      buyer: { type: Number, default: 0 },
      staff: { type: Number, default: 0 },
    },
    notified: {
      buyerAt: { type: Date, default: null },
      staffAt: { type: Date, default: null },
    },

    /**
     * The newest message each side could see, for the notification job.
     * PUBLIC messages only: an internal note moves neither, so it can
     * never be what makes a buyer's email fire. (`lastMessage*` above is
     * public-only for the same reason — the buyer's list shows its preview.)
     */
    lastBuyerMessageAt: { type: Date, default: null },
    lastStaffMessageAt: { type: Date, default: null },

    /** Who started it — a buyer from their account, or staff reaching out first. */
    startedBy: { type: String, enum: ["buyer", "staff"], default: "buyer" },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/** The inbox: open threads, busiest first. */
conversationSchema.index({ status: 1, lastMessageAt: -1 });

export default mongoose.model("Conversation", conversationSchema);
