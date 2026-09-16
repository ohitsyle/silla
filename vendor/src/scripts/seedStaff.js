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

// "Ana Maria Reyes" -> first "Ana Maria", last "Reyes". Staff give one
// name on the command line; the account stores the parts.
const words = name.trim().split(/\s+/);
const lastName = words.length > 1 ? words.pop() : "";
const firstName = words.join(" ");

// Staff are provisioned by us, from a terminal, with an address we chose.
// There is nothing for a verification code to prove, and an unverified
// staff account would be a person who cannot be emailed about the queue.
const fields = {
  firstName,
  lastName,
  passwordHash,
  role: "silla",
  active: true,
  emailVerified: true,
  emailVerifiedAt: new Date(),
  passwordChangedAt: new Date(Date.now() - 1000),
};

if (existing) {
  existing.set(fields);
  await existing.save();
  console.log(`Updated SILLA staff account: ${normalised}`);
} else {
  await Account.create({ email: normalised, ...fields });
  console.log(`Created SILLA staff account: ${normalised}`);
}

await mongoose.disconnect();
