/**
 * INF-3 — the check-in interface (spec §13).
 *
 * The single most important architectural constraint in Sprint 0:
 *
 *   "the check-in step is built behind a single interface — resolve a
 *    credential to a member — rather than wired directly into the
 *    reservation logic. RFID is the only implementation behind that
 *    interface in v1."
 *
 * So this module answers exactly ONE question:
 *
 *     given a credential, which member is this?
 *
 * It deliberately knows nothing about reservations, resources, walk-ins,
 * or occupancy. Everything downstream of identity (activate a held
 * reservation, offer walk-in selection, check out) is OCC-1..OCC-3 and
 * consumes the result of this call — it does not live inside it. That
 * separation is what makes QR a fast-follow (spec §19) rather than a
 * rewrite: QR proves identity by phone session instead of a card, but
 * produces the same resolution result, so nothing downstream changes.
 *
 * Adding QR later is three lines:
 *     import { qrResolver } from "./qr.js";
 *     registerResolver("qr", qrResolver);
 * ...plus flipping the org's identity.checkInMethod to "qr" or "both".
 */
import Organization from "../../models/Organization.js";
import { ValidationError } from "./errors.js";
import { OUTCOME } from "./outcomes.js";
import { rfidResolver } from "./rfid.js";

export { ValidationError, OUTCOME };

const resolvers = new Map();

export function registerResolver(method, resolver) {
  resolvers.set(method, resolver);
}

/** v1 ships RFID only (spec §13). QR is deliberately NOT registered. */
registerResolver("rfid", rfidResolver);

export const supportedMethods = () => [...resolvers.keys()];

/**
 * resolveCheckIn — the interface.
 *
 * @param {object} params
 * @param {string} params.organizationId
 * @param {string} params.method      "rfid" (the only v1 implementation)
 * @param {string} params.credential  the raw credential — a card UID for RFID
 * @returns {Promise<{outcome: string, member?: object, credential: string, method: string}>}
 */
export async function resolveCheckIn({ organizationId, method = "rfid", credential }) {
  if (!organizationId) throw new ValidationError("organizationId is required");
  if (!credential || typeof credential !== "string" || !credential.trim()) {
    throw new ValidationError("A credential is required");
  }

  const org = await Organization.findById(organizationId).select("identity");
  if (!org) throw new ValidationError("Organization not found");

  // The organization's configured check-in method is enforced here, not
  // at the route — otherwise every future caller would have to remember
  // to check it (spec §16: read config at runtime, never hardcode).
  const configured = org.identity?.checkInMethod || "rfid";
  if (configured !== "both" && configured !== method) {
    throw new ValidationError(
      `This organization is configured for ${configured} check-in; "${method}" is not accepted.`
    );
  }

  const resolver = resolvers.get(method);
  if (!resolver) {
    // Reached when an org is configured for a method v1 does not
    // implement yet — a config problem, not a caller problem.
    throw new ValidationError(
      `No check-in implementation registered for "${method}". Available: ${supportedMethods().join(", ") || "none"}.`
    );
  }

  const result = await resolver({ organizationId, credential: credential.trim() });
  return { ...result, method, credential: credential.trim() };
}
