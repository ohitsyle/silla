import mongoose from "mongoose";

/**
 * The vendor service's own connection.
 *
 * Deliberately its own database, not a second set of collections beside
 * a buyer's: `VENDOR_MONGO_URI` falls back to MONGO_URI only so local
 * development works out of the box. Before this is deployed anywhere
 * real, point it at a separate database — an order queue and a
 * customer's operational data have no business sharing a blast radius.
 */
export async function connectDB() {
  const uri = process.env.VENDOR_MONGO_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error("VENDOR_MONGO_URI is not set — copy .env.example to .env and fill it in.");
  }
  await mongoose.connect(uri, { dbName: process.env.VENDOR_DB_NAME || "silla_vendor" });
  console.log(`[vendor:db] connected (db: ${process.env.VENDOR_DB_NAME || "silla_vendor"})`);
}
