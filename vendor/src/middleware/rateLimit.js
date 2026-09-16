/**
 * A small fixed-window limiter, kept in memory.
 *
 * A copy of the idea in server/src/middleware/rateLimit.js rather than an
 * import — vendor/ never reaches into server/. In memory means per
 * process, which is exactly right for the one instance this runs on and
 * wrong the day it scales past one; the key function is the seam a
 * shared store would slot into.
 *
 * Limits are scoped to the threat, not the endpoint: login is keyed by
 * address AND email so one person guessing at one account is stopped
 * without locking out a whole office behind a shared IP.
 */
const buckets = new Map();

export function rateLimit({ windowMs, max, name, keyFor = (req) => req.ip }) {
  return (req, res, next) => {
    const key = `${name}:${keyFor(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${retryAfterSeconds < 90 ? `${retryAfterSeconds} seconds` : `${Math.ceil(retryAfterSeconds / 60)} minutes`}.`,
        retryAfterSeconds,
      });
    }
    next();
  };
}

// Swept occasionally so a long-running process doesn't keep every key it
// has ever seen.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 10 * 60 * 1000).unref();
