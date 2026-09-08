/**
 * AUTH-2 — rate limiting (spec §5: "Repeated wrong PINs trigger
 * rate-limiting and lockout, on both web and kiosk").
 *
 * Two distinct defences, deliberately not the same thing:
 *   - LOCKOUT   (in auth.routes.js) is per-account and persistent: N
 *     wrong PINs locks that account for a cooldown. Survives restarts.
 *   - RATE LIMIT (here) is per-caller and in-memory: it caps how fast
 *     anyone can hit an endpoint at all, so an attacker cannot spray
 *     one attempt each across ten thousand accounts, which per-account
 *     lockout alone would never notice.
 *
 * Fixed-window counter, no dependency. The tradeoff is deliberate:
 * express-rate-limit is not installed and this scaffold runs as a single
 * process. Before horizontal scaling on AWS (INF-5) this needs a shared
 * store — the counters below live in one process's memory, so two
 * instances would each allow the full quota.
 */

const buckets = new Map(); // key -> { count, resetAt }

// Sweep expired buckets so a long-running process doesn't grow a bucket
// per unique IP forever.
const SWEEP_INTERVAL_MS = 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.(); // never hold the process open

/**
 * @param {object} options
 * @param {number} options.windowMs   window length
 * @param {number} options.max        allowed requests per window
 * @param {string} options.name       bucket namespace, so two limiters don't share counts
 * @param {(req) => string} [options.keyFor]  defaults to client IP; pass a
 *        function to scope by something more specific (e.g. IP + email),
 *        which is what makes credential-stuffing across many accounts
 *        visible rather than invisible.
 */
export function rateLimit({ windowMs, max, name, keyFor }) {
  return (req, res, next) => {
    const identity = keyFor ? keyFor(req) : clientIp(req);
    const key = `${name}:${identity}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(remaining));
    res.set("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many attempts. Please wait and try again.",
        retryAfterSeconds: retryAfter,
      });
    }

    return next();
  };
}

function clientIp(req) {
  // req.ip honours trust proxy when it's configured; the fallbacks keep
  // this working in a bare dev setup.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Login is the credential-stuffing target, so it is scoped by IP *and*
 * the email being tried: 10 attempts per identity per 15 minutes.
 */
export const loginRateLimit = rateLimit({
  name: "login",
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFor: (req) => `${clientIp(req)}|${String(req.body?.email || "").toLowerCase()}`,
});

/** Kiosk taps are frequent and low-risk, but shouldn't be a free UID oracle. */
export const tapRateLimit = rateLimit({ name: "tap", windowMs: 60 * 1000, max: 30 });

/**
 * Registration creates records, but the limit must not fight the actual
 * use case: a kiosk is ONE shared IP, and an orientation session may
 * onboard dozens of people back to back. A tight per-IP cap would block
 * legitimate sign-ups at exactly the busiest moment.
 *
 * So the per-IP ceiling is generous (abuse protection, not throttling),
 * and the meaningful limit is per-card below — one physical card should
 * not be able to spawn registration records in a loop.
 */
export const registrationRateLimit = rateLimit({ name: "registration", windowMs: 15 * 60 * 1000, max: 60 });

/** One card, a few attempts — this is the limit that actually matters. */
export const registrationPerCardRateLimit = rateLimit({
  name: "registration-card",
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFor: (req) => String(req.body?.cardUid || "unknown").replace(/[\s:-]/g, "").toUpperCase(),
});

/**
 * Code guessing. Like registration, the limit that matters is per
 * REGISTRATION, not per IP — one kiosk legitimately verifies many people
 * in a row, and an IP-scoped cap would block the eleventh person of the
 * morning.
 *
 * Guessing a specific 6-digit code is the actual threat, and that is
 * bounded per registrationId here (and again by MAX_VERIFY_ATTEMPTS in
 * the route, which destroys the pending account outright).
 */
export const verifyRateLimit = rateLimit({
  name: "verify",
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyFor: (req) => String(req.body?.registrationId || clientIp(req)),
});

/** Generous per-IP ceiling on the same endpoints — abuse protection only. */
export const verifyIpRateLimit = rateLimit({ name: "verify-ip", windowMs: 15 * 60 * 1000, max: 120 });

/** Exposed for tests so one suite's attempts don't leak into the next. */
export function __resetRateLimits() {
  buckets.clear();
}
