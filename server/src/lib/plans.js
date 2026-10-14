/**
 * The vocabulary of plans: which features can be switched off and which
 * counts can be capped. These keys are the CONTRACT between SILLA's
 * control plane (vendor/), which decides what each organization is
 * entitled to, and this service, which enforces it.
 *
 * vendor/src/lib/planKeys.js holds a copy (no cross-imports between the
 * services — see CLAUDE.md). Keep the two in step. A key added on one side
 * only is harmless by design: services/entitlements.js treats a key the
 * snapshot does not mention as allowed, so version skew can never lock a
 * paying customer out.
 */

/** Features a plan can withhold. Absent from a snapshot = allowed. */
export const FEATURES = {
  kiosk: "Kiosk check-in and self-registration",
  reports: "Reports and CSV export",
  customBranding: "Custom colours and logo",
  wholeRoomBooking: "Booking whole rooms",
  emailReminders: "Reminder emails before a reservation starts",
};

/** Counts a plan can cap. Absent or null = unlimited. */
export const LIMITS = {
  buildings: "Buildings",
  floors: "Floors",
  rooms: "Rooms",
  resources: "Bookable units",
  members: "Members",
  staff: "Staff and administrator accounts",
};

/**
 * Subscription states as the deployment sees them. The control plane has
 * more (an unpaid first invoice, say), but only these reach here.
 */
export const ENTITLEMENT_STATUS = ["trialing", "active", "past_due", "suspended", "cancelled"];

/** States in which the organization works normally. past_due is the grace period. */
export const OPERATIONAL_STATUS = new Set(["trialing", "active", "past_due"]);
