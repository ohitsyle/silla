/**
 * Creates a SILLA staff account.
 *
 *   npm run seed:staff -- you@silla.example "Your Name" yourpassword
 *
 * Staff exist ONLY through this script. There is no HTTP route that can
 * create one, because an endpoint able to grant itself the order queue
 * is a back door no matter how it is guarded. Re-running with the same
 * email updates the password rather than failing on the unique index.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Account from "../models/Account.js";

const [email, name, password] = process.argv.slice(2);

if (!email || !name || !password) {
  console.error('Usage: npm run seed:staff -- <email> "<name>" <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}

await connectDB();

const normalised = email.trim().toLowerCase();
const passwordHash = await bcrypt.hash(password, 10);
const existing = await Account.findOne({ email: normalised });

if (existing) {
  existing.passwordHash = passwordHash;
  existing.name = name;
  existing.role = "silla";
  existing.active = true;
  await existing.save();
  console.log(`Updated SILLA staff account: ${normalised}`);
} else {
  await Account.create({ email: normalised, name, passwordHash, role: "silla" });
  console.log(`Created SILLA staff account: ${normalised}`);
}

await mongoose.disconnect();
