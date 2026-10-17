/**
 * What each kind of SILLA staff member may do.
 *
 * ONE table, read by every staff route through requirePermission() (or
 * can(), for a route both buyers and staff share). The console never
 * restates it: it asks GET /api/vendor/staff/me for the permissions this
 * person holds and shows the sections portal/src/staff/sections.js ties
 * to them. A permission is granted here or nowhere; a route that checks
 * `staffRole === "owner"` inline is how a second, unaudited set of rules
 * starts.
 *
 *   owner    runs SILLA: everything, including staff and settings
 *   admin    runs operations: orders, deployments, billing, plans
 *   billing  money: subscriptions, invoices, payments
 *   support  customers: orders, conversations, deployment health
 */
export const STAFF_ROLES = ["owner", "admin", "billing", "support"];

const ALL = STAFF_ROLES;

export const STAFF_PERMISSIONS = {
  "orders.read": ALL,
  "orders.manage": ["owner", "admin", "support"],
  "clients.read": ALL,
  "clients.manage": ["owner", "admin", "support"],
  "conversations.read": ALL,
  "conversations.reply": ALL,
  "deployments.read": ALL,
  "deployments.provision": ["owner", "admin"],
  "deployments.manage": ["owner", "admin"],
  "deployments.ownerAccess": ["owner", "admin", "support"],
  "billing.read": ["owner", "admin", "billing"],
  "billing.manage": ["owner", "admin", "billing"],
  "plans.manage": ["owner", "admin"],
  "settings.manage": ["owner", "admin"],
  "staff.manage": ["owner"],
  "audit.read": ["owner", "admin"],
};

/** A staff account's effective role. Pre-roles staff accounts were all owners in practice. */
export function staffRoleOf(account) {
  if (account?.role !== "silla") return null;
  return account.staffRole || "owner";
}

export function can(account, permission) {
  const role = staffRoleOf(account);
  if (!role) return false;
  const allowed = STAFF_PERMISSIONS[permission];
  if (!allowed) throw new Error(`Unknown staff permission "${permission}"`);
  return allowed.includes(role);
}

/** Every permission this account holds — sent to the console so it shows only what works. */
export function permissionsOf(account) {
  return Object.keys(STAFF_PERMISSIONS).filter((p) => can(account, p));
}

/**
 * Route guard. Use AFTER requireAccount. Buyers get the same 403 as a
 * staff member without the permission: neither should learn more than
 * that the action is not theirs.
 */
export function requirePermission(permission) {
  if (!STAFF_PERMISSIONS[permission]) throw new Error(`Unknown staff permission "${permission}"`);
  return (req, res, next) => {
    if (!can(req.account, permission)) {
      return res.status(403).json({ error: "You don't have access to that.", code: "STAFF_PERMISSION", permission });
    }
    next();
  };
}
