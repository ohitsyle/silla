// CLI wrapper for the test helper: node tests/plant.mjs <email> <purpose> [pendingEmail]
import mongoose from "mongoose";
import { plantCode } from "./helpers.mjs";
const [email, purpose, pendingEmail] = process.argv.slice(2);
await plantCode(email, purpose, { pendingEmail: pendingEmail || null });
console.log(`planted ${purpose} code for ${email}`);
await mongoose.disconnect();
