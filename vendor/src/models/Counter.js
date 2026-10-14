import mongoose from "mongoose";

/**
 * Named sequences — invoice numbers. `nextSequence("invoice-2026")` is one
 * atomic findOneAndUpdate, so two invoices issued at once can never share
 * a number, and a number once handed out is never handed out again.
 */
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
const Counter = mongoose.model("Counter", counterSchema);

export async function nextSequence(name) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

export default Counter;
