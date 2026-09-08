/**
 * Resolution outcomes for the check-in interface (spec §13).
 *
 * Callers switch on these rather than on null checks, so a new outcome
 * is a visible addition instead of a silent fallthrough. Kept separate
 * from index.js so implementations can import it without an import
 * cycle.
 */
export const OUTCOME = {
  MEMBER: "member", // credential maps to exactly one active, verified member
  UNREGISTERED: "unregistered", // valid credential, no member bound — ID-1 launches registration
  PENDING: "pending", // member exists but has not verified their email yet (ID-2)
  INACTIVE: "inactive", // member exists but has been deactivated
};
