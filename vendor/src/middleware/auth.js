import jwt from "jsonwebtoken";
import Account from "../models/Account.js";

/**
 * Same doctrine as the product's own middleware: the token proves a past
 * login, not present standing, so the account is re-read every request.
 * A deactivated account or a demoted staff member must lose access at
 * once, not whenever their token happens to expire.
 */
export async function requireAccount(req, res, next) {
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
    const account = await Account.findById(claims.id).select("email name role active organizationName");
    if (!account || !account.active) {
      return res.status(401).json({ error: "Account is no longer active" });
    }
    req.account = account;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * SILLA staff only — the order queue, and every status transition.
 *
 * 404 rather than 403 on the staff routes would be tidier about not
 * confirming they exist, but these are advertised in our own product;
 * a clear 403 is more useful than a confusing 404.
 */
export function requireSilla(req, res, next) {
  if (req.account?.role !== "silla") {
    return res.status(403).json({ error: "SILLA staff only" });
  }
  next();
}
