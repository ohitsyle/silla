/**
 * Brings accounts created before verification and split names existed
 * up to the current shape.
 *
 *   npm run migrate:accounts            # dry run — prints what would change
 *   npm run migrate:accounts -- --apply
 *
 * Why it matters: `emailVerified` defaults to false, and submitting an
 * order now requires it. Every account that already existed — real
 * buyers, SILLA staff — would otherwise be locked out of placing orders
 * by a check they were never asked to pass.
 *
 * They are grandfathered as verified, NOT marked as having accepted the
 * terms. Verification is being waived; consent cannot be invented after
 * the fact, so termsAcceptedAt stays empty for them.
 *
 * Reads the raw collection, because a Mongoose document fills in schema
 * defaults on load and "the field is missing" and "the field is false"
 * would look identical through it. Safe to re-run.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";

const apply = process.argv.includes("--apply");
await connectDB();
const col = mongoose.connection.db.collection("accounts");

const legacy = await col
  .find({ $or: [{ emailVerified: { $exists: false } }, { firstName: { $exists: false } }] })
  .toArray();

console.log(`\n  ${legacy.length} account(s) predate the current shape${apply ? "" : "  (dry run)"}\n`);

for (const a of legacy) {
  const set = {};
  if (a.firstName === undefined) {
    const words = String(a.name || "").trim().split(/\s+/).filter(Boolean);
    const lastName = words.length > 1 ? words.pop() : "";
    set.firstName = words.join(" ");
    set.lastName = lastName;
    set.middleName = "";
    set.suffix = "";
  }
  if (a.emailVerified === undefined) {
    set.emailVerified = true;
    set.emailVerifiedAt = a.createdAt || new Date();
  }
  if (a.billing === undefined) set.billing = { email: a.email, country: "Philippines" };

  console.log(`  ${a.email.padEnd(40)} ${a.role.padEnd(6)} ${JSON.stringify({ first: set.firstName, last: set.lastName, verified: set.emailVerified })}`);
  if (apply) await col.updateOne({ _id: a._id }, { $set: set });
}

console.log(apply ? "\n  applied.\n" : "\n  nothing written — re-run with --apply.\n");
await mongoose.disconnect();
