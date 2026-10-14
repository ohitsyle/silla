/**
 * The staff console's API client — staff, clients, conversations,
 * deployments and the activity log. Same service, token and error shape
 * as lib/vendorApi.js, whose request() it shares.
 *
 * Owner: the staff-operations work. Buyer-side conversation calls live
 * here too, so the two halves of a conversation use one client.
 */
import { request } from "./vendorApi.js";

export const staffApi = {
  /** { staffRole, permissions[] } — the console shows only what this lists. */
  me: () => request("/api/vendor/staff/me"),
};
