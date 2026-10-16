/**
 * Where a signed-in session is kept — one per organization
 * (docs/control-plane.md §1).
 *
 * One front end serves every organization, so one browser can hold a
 * session in several: a member of two organizations, or a SILLA engineer
 * checking two deployments side by side. The token used to live under a
 * single "silla_token" key, which meant signing in to one organization
 * silently signed you OUT of the other — or worse, sent one
 * organization's token with every request the other made. Now each
 * organization's token has its own key, `silla_token:<organizationId>`.
 *
 * A token is also never used for an organization other than the one in
 * its own `organizationId` claim, whatever key it was found under. The
 * server refuses such a token anyway (middleware/auth.js); refusing it
 * here means the client never sends one organization's credential to
 * another organization's screens in the first place.
 *
 * Storage can throw (a private window, blocked site data), so every read
 * and write is guarded: without storage you simply sign in again on each
 * visit, which is the correct degraded behaviour for a session.
 */

const LEGACY_KEY = "silla_token";
export const tokenKey = (organizationId) => `silla_token:${organizationId}`;

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The claims inside a JWT, read WITHOUT verifying it — the server verifies.
 * This only decides which organization a token claims to be for, and
 * whether it has already expired, so it is never sent where it cannot work.
 */
export function claimsOf(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(base64));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/** Usable for this organization: its own claim says so, and it has not expired. */
function usableFor(token, organizationId) {
  const claims = claimsOf(token);
  if (!claims || String(claims.organizationId) !== String(organizationId)) return false;
  return !(typeof claims.exp === "number" && claims.exp * 1000 <= Date.now());
}

/**
 * Carries the old single "silla_token" over to its organization's key —
 * once, and only when its claim names THIS organization — so people
 * signed in before sessions were per organization stay signed in.
 *
 * A legacy token for a different organization is left where it is, for
 * that organization to adopt when it is next opened. One that is
 * unreadable or already expired could never be adopted by anyone, so it
 * is removed rather than kept forever.
 */
export function adoptLegacyToken(organizationId) {
  const storage = store();
  if (!storage || !organizationId) return;
  try {
    const legacy = storage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const claims = claimsOf(legacy);
    const expired = typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now();
    if (!claims?.organizationId || expired) {
      storage.removeItem(LEGACY_KEY);
      return;
    }
    if (String(claims.organizationId) !== String(organizationId)) return;
    if (!storage.getItem(tokenKey(organizationId))) storage.setItem(tokenKey(organizationId), legacy);
    storage.removeItem(LEGACY_KEY);
  } catch {
    // Storage refused: nothing to carry over.
  }
}

/** This organization's token, or null. A token that is not usable here is dropped, never returned. */
export function readToken(organizationId) {
  const storage = store();
  if (!storage || !organizationId) return null;
  try {
    const token = storage.getItem(tokenKey(organizationId));
    if (!token) return null;
    if (usableFor(token, organizationId)) return token;
    storage.removeItem(tokenKey(organizationId));
    return null;
  } catch {
    return null;
  }
}

/** Stores a token for this organization — but only one that claims it. */
export function writeToken(organizationId, token) {
  const storage = store();
  if (!storage || !organizationId || !usableFor(token, organizationId)) return;
  try {
    storage.setItem(tokenKey(organizationId), token);
  } catch {
    // Storage refused: the session lasts as long as this page does.
  }
}

export function clearToken(organizationId) {
  const storage = store();
  if (!storage || !organizationId) return;
  try {
    storage.removeItem(tokenKey(organizationId));
  } catch {
    // Nothing stored, nothing to clear.
  }
}
