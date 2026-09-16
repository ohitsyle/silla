/**
 * Test-side helpers that reach the database directly.
 *
 * Verification codes are bcrypt-hashed and emails to @test.silla are
 * dropped by the transport, so no test can read a real code. Instead the
 * test PLANTS a code it knows, then drives the real HTTP endpoint with
 * it — so everything after "the code arrived" is still exercised for
 * real: attempt counting, expiry, consumption, the swap itself.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";

async function ensureDb() {
  if (mongoose.connection.readyState !== 1) await connectDB();
}

export const KNOWN_CODE = "246810";

export async function plantCode(email, purpose, { pendingEmail = null, code = KNOWN_CODE, expired = false } = {}) {
  await ensureDb();
  await Account.updateOne(
    { email },
    {
      $set: {
        verification: {
          purpose,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: new Date(Date.now() + (expired ? -60_000 : 10 * 60_000)),
          attempts: 0,
          // Backdated past the resend cooldown so a test can also exercise
          // "send another" without sleeping for a minute.
          sentAt: new Date(Date.now() - 120_000),
          pendingEmail,
        },
      },
    }
  );
}

export async function readAccount(email) {
  await ensureDb();
  return Account.findOne({ email }).lean();
}
