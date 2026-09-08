/**
 * A configuration parked while someone signs up.
 *
 * The wizard asks for an account only at the END, once there is
 * something worth saving — asking first is how you lose people on step
 * one. That means the configuration has to survive a round trip through
 * sign-up, and BOTH sides need to agree it exists: the wizard writes it,
 * and the auth screen has to know to send them back rather than to the
 * (empty) orders list.
 *
 * sessionStorage, not local: this is one round trip. A draft surviving a
 * browser restart to be silently restored days later would be a
 * surprise, not a convenience.
 */
const KEY = "silla_pending_configuration";

export function savePending(value) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    // Storage blocked. The caller carries on — losing the draft on the
    // round trip is better than refusing to let them sign up at all.
    return false;
  }
}

export function hasPending() {
  try {
    return Boolean(window.sessionStorage.getItem(KEY));
  } catch {
    return false;
  }
}

/** Reads it and clears it — a pending draft must not outlive one trip. */
export function takePending() {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
