/**
 * One-time codes: email verification, email change, password reset, and
 * staff invitations.
 *
 * Stored bcrypt-hashed, never in the clear — a leaked database must not
 * hand anyone a working code. That also means nobody, including our own
 * tests, can read one back; the only copy is in the recipient's inbox.
 *
 * Three limits, each for a different attack:
 *   expiry      a code found in an old inbox is worthless
 *   attempts    six digits is a million guesses; five tries is not
 *   cooldown    "resend" cannot be used to flood someone's inbox
 */
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Purposes that outlive the ten-minute default. A sign-up code is typed
 * while the tab is still open; an invitation is read whenever the person
 * gets to their inbox, which may be after a weekend. Every other purpose
 * keeps the default, and the attempt limit still applies to all of them.
 */
const TTL_MINUTES_BY_PURPOSE = { invite: 72 * 60 };

export const ttlMinutesFor = (purpose) => TTL_MINUTES_BY_PURPOSE[purpose] ?? CODE_TTL_MINUTES;

/** Uniform over 000000–999999. randomInt is cryptographic; Math.random is not. */
const generate = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/**
 * Seconds until another code may be sent for this purpose, or 0.
 * Only throttles a repeat of the SAME purpose — a person who verifies
 * and then immediately changes their email should not be told to wait.
 */
export function cooldownRemaining(account, purpose) {
  const v = account.verification;
  if (!v || v.purpose !== purpose || !v.sentAt) return 0;
  const elapsed = (Date.now() - new Date(v.sentAt).getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
}

/** Issues a fresh code, replacing any live one. Returns the plain code for the email. */
export async function issueCode(account, purpose, { pendingEmail = null } = {}) {
  const code = generate();
  account.verification = {
    purpose,
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + ttlMinutesFor(purpose) * 60 * 1000),
    attempts: 0,
    sentAt: new Date(),
    pendingEmail,
  };
  return code;
}

/**
 * Checks a submitted code. On success the code is consumed; on failure
 * the attempt is counted. The caller saves the account either way.
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string, attemptsRemaining?: number }}
 */
export async function consumeCode(account, purpose, submitted) {
  const v = account.verification;
  if (!v || v.purpose !== purpose) {
    return { ok: false, status: 400, error: "There's no code waiting. Send a new one." };
  }
  if (new Date(v.expiresAt).getTime() < Date.now()) {
    return { ok: false, status: 410, error: "That code has expired. Send a new one." };
  }
  if (v.attempts >= MAX_ATTEMPTS) {
    return { ok: false, status: 429, error: "Too many wrong codes. Send a new one." };
  }
  if (!/^\d{6}$/.test(String(submitted || ""))) {
    return { ok: false, status: 400, error: "Enter the 6-digit code from the email." };
  }

  const match = await bcrypt.compare(String(submitted), v.codeHash);
  if (!match) {
    v.attempts += 1;
    account.markModified("verification");
    const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - v.attempts);
    return {
      ok: false,
      status: 401,
      error: attemptsRemaining
        ? `That code isn't right. ${attemptsRemaining} ${attemptsRemaining === 1 ? "try" : "tries"} left.`
        : "Too many wrong codes. Send a new one.",
      attemptsRemaining,
    };
  }

  account.verification = null;
  return { ok: true, pendingEmail: v.pendingEmail };
}
