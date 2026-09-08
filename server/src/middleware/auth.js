import jwt from "jsonwebtoken";
import User from "../models/User.js";

/**
 * requireAuth — verifies the login token issued at /api/auth/login
 * (spec §5: email + PIN for everyone, same login regardless of role)
 * and attaches { id, organizationId, role } to req.user.
 *
 * The token is proof of a PAST login, not of present standing, so the
 * account is re-read on every request rather than trusted from the
 * claims. Without that, a 12h token outlives the two controls that
 * matter most: ADM-4's "deactivate this staff account" was a no-op for
 * up to half a day (they could no longer log in, but the token they
 * already held kept full admin access — member PII, PIN resets, card
 * reissue), and a demotion from superadmin to staff left the old role
 * in the signature for just as long. Both are exactly the moves you
 * make when someone leaves or an account is compromised.
 *
 * The cost is one indexed findById per authenticated request, which is
 * the normal price of revocable sessions. If that ever shows up in a
 * profile, the answer is a short-lived token plus a refresh step, not
 * trusting the claims again.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const account = await User.findById(claims.id).select(
      "organization role active mustChangePin termsAcceptedAt"
    );

    // Same 401 for "deleted" and "deactivated": the client's job in both
    // cases is to drop the token and send the user back to login.
    if (!account || !account.active) {
      return res.status(401).json({ error: "Account is no longer active" });
    }

    // A token minted against one organization must never act on another.
    if (account.organization.toString() !== String(claims.organizationId)) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = {
      id: account._id.toString(),
      organizationId: account.organization.toString(),
      role: account.role, // live, so a demotion takes effect immediately
      mustChangePin: Boolean(account.mustChangePin),
      termsAccepted: Boolean(account.termsAcceptedAt),
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * requireRole — gate a route to specific roles, e.g. requireRole("superadmin").
 * Staff-management and Settings routes are superadmin-only per spec §14.
 * Reads req.user.role, which requireAuth has already refreshed from the
 * database, so this reflects the account's role now and not at login.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}
