/**
 * INF-3 — the RFID implementation behind the check-in interface
 * (spec §13). The only implementation in v1.
 *
 * Its entire contract: card UID -> member. It must not reach into
 * reservations; see the note at the top of index.js for why.
 *
 * Normalisation matters more than it looks. Readers report the same
 * physical card differently — lower vs upper case hex, with or without
 * colon/space separators, and some HID keyboard-wedge readers append a
 * carriage return. Storing and comparing a canonical form means a card
 * registered on one reader still resolves on another (spec §7, the
 * lost-card reissue flow, depends on this too).
 */
import User from "../../models/User.js";
import { OUTCOME } from "./outcomes.js";
import { ValidationError } from "./errors.js";

/**
 * Canonical UID form: uppercase hex, no separators. Exported because
 * registration (ID-1) must store exactly what this resolver will later
 * look up — if the two ever disagree, every card silently fails to
 * resolve.
 */
export function normalizeCardUid(raw) {
  const cleaned = String(raw)
    .trim()
    .replace(/[\s:-]/g, "")
    .toUpperCase();

  if (!/^[0-9A-F]{4,32}$/.test(cleaned)) {
    throw new ValidationError(
      "Card UID must be 4–32 hexadecimal characters (separators and case are ignored)."
    );
  }
  return cleaned;
}

export async function rfidResolver({ organizationId, credential }) {
  const cardUid = normalizeCardUid(credential);

  const member = await User.findOne({ organization: organizationId, cardUid });

  if (!member) {
    // Not an error — this is the trigger for ID-1's self-service
    // registration (spec §4: "if unregistered, registration launches on
    // the spot").
    return { outcome: OUTCOME.UNREGISTERED, cardUid };
  }

  if (!member.verified) {
    return { outcome: OUTCOME.PENDING, member, cardUid };
  }

  if (!member.active) {
    return { outcome: OUTCOME.INACTIVE, member, cardUid };
  }

  return { outcome: OUTCOME.MEMBER, member, cardUid };
}
