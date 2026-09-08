/**
 * Identity helpers for ID-1 (registration) and ID-3 (uniqueness).
 *
 * Member ID format is configurable per organization (spec §4, §16:
 * "Member ID format" is a config point). A library might use
 * "####-######"; an office might use "EMP-#####" or plain "######".
 * Nothing may hardcode one shape.
 */
import { randomInt } from "node:crypto";
import { ValidationError } from "../services/checkin/errors.js";

/**
 * Compiles an org's memberIdFormat pattern into a validator.
 *
 * Pattern language, deliberately tiny:
 *   #  — one digit
 *   A  — one uppercase letter
 *   *  — one alphanumeric character
 *   everything else — a literal that must appear exactly
 *
 * Kept this small on purpose: a full regex in config would let a
 * misconfiguration take down registration, and buyers do not author
 * these — SILLA sets them at install (spec §8's same reasoning).
 */
export function memberIdPatternToRegex(pattern) {
  const source = [...String(pattern || "")]
    .map((ch) => {
      if (ch === "#") return "[0-9]";
      if (ch === "A") return "[A-Z]";
      if (ch === "*") return "[A-Za-z0-9]";
      return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/** Human-readable example, so the kiosk can show "e.g. 2024-000123". */
export function memberIdExample(pattern) {
  let digit = 0;
  return [...String(pattern || "")]
    .map((ch) => {
      if (ch === "#") {
        digit += 1;
        return String(digit % 10);
      }
      if (ch === "A") return "X";
      if (ch === "*") return "X";
      return ch;
    })
    .join("");
}

export function assertMemberIdMatchesFormat(memberId, pattern) {
  if (!pattern) return; // org hasn't configured a format — accept anything non-empty
  if (!memberIdPatternToRegex(pattern).test(String(memberId || ""))) {
    throw new ValidationError(
      `Member ID must match the format ${pattern} (for example ${memberIdExample(pattern)}).`
    );
  }
}

/** A 6-digit PIN, per spec §4/§5 — not 4, not 8, and digits only. */
export function assertValidPin(pin) {
  if (!/^[0-9]{6}$/.test(String(pin || ""))) {
    throw new ValidationError("PIN must be exactly 6 digits.");
  }
}

export function assertValidEmail(email) {
  // Intentionally permissive — the verification code (ID-2) is the real
  // proof the address works, so over-strict syntax rules here only ever
  // reject valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""))) {
    throw new ValidationError("A valid email address is required.");
  }
}

/**
 * ID-3 — turns MongoDB's E11000 duplicate-key error into a message that
 * names the field, so a duplicate is "rejected clearly" (the story's AC)
 * rather than surfacing as an opaque 500.
 *
 * The unique indexes on User are all org-scoped compounds, so the key
 * pattern tells us which one tripped.
 */
export function describeDuplicateKeyError(err, { memberNoun = "member" } = {}) {
  if (!err || err.code !== 11000) return null;
  const fields = Object.keys(err.keyPattern || err.keyValue || {});
  if (fields.includes("email")) return "That email address is already registered.";
  if (fields.includes("memberId")) return `That ${memberNoun} ID is already registered.`;
  if (fields.includes("cardUid")) return "That card is already registered to another account.";
  return "That record already exists.";
}

/**
 * Six-digit verification code (spec §4). randomInt is uniform and
 * cryptographically sound; Math.random is neither, and this is a
 * security token however short-lived.
 */
export function generateVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
