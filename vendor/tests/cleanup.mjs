/**
 * Removes everything the suites created. Test accounts all use
 * @test.silla, so this deletes exactly what the tests made and never a
 * real order.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";
import Order from "../src/models/Order.js";

export async function cleanup({ quiet = false } = {}) {
  const already = mongoose.connection.readyState === 1;
  if (!already) await connectDB();

  const testers = await Account.find({ email: /@test\.silla$/ }).select("_id");
  const ids = testers.map((t) => t._id);
  const orders = await Order.deleteMany({ account: { $in: ids } });
  const accounts = await Account.deleteMany({ _id: { $in: ids } });

  if (!quiet) console.log(`  cleaned ${accounts.deletedCount} account(s), ${orders.deletedCount} order(s)`);
  if (!already) await mongoose.disconnect();
}

if (process.argv[1]?.endsWith("cleanup.mjs")) {
  await cleanup();
  await mongoose.disconnect();
}
