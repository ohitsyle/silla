/**
 * The vocabulary of plans — a COPY of server/src/lib/plans.js (no
 * cross-imports between the services; see CLAUDE.md). These keys are the
 * contract for the entitlement snapshot this service pushes to each
 * deployment. Keep the two files in step.
 */

export const FEATURES = {
  kiosk: "Kiosk check-in and self-registration",
  reports: "Reports and CSV export",
  customBranding: "Custom colours and logo",
  wholeRoomBooking: "Booking whole rooms",
  emailReminders: "Reminder emails before a reservation starts",
};

export const LIMITS = {
  buildings: "Buildings",
  floors: "Floors",
  rooms: "Rooms",
  resources: "Bookable units",
  members: "Members",
  staff: "Staff and administrator accounts",
};

/** The states a deployment understands (server/src/lib/plans.js ENTITLEMENT_STATUS). */
export const DEPLOYMENT_STATUS = ["trialing", "active", "past_due", "suspended", "cancelled"];
