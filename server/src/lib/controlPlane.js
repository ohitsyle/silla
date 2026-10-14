/**
 * The channel SILLA's control plane (vendor/) uses to act on this
 * deployment: provision an organization, push what its plan allows,
 * read its usage, re-issue its owner's access.
 *
 * vendor/ and server/ share no code and no JWT secret, on purpose (see
 * CLAUDE.md) — a vendor token must never be accepted here. What they
 * share is CONTROL_PLANE_SECRET, and every internal request is signed:
 *
 *   Authorization: SILLA-HMAC t=<unix seconds>,sig=<hex>
 *   sig = HMAC-SHA256(secret, `${t}\n${METHOD}\n${path incl. query}\n${sha256hex(raw body)}`)
 *
 * The timestamp bounds a replay to five minutes, each signature is
 * accepted once, and the body hash means a captured request cannot be
 * re-sent with a different payload. With no secret configured the
 * internal API answers 503 — it never falls back to open.
 *
 * vendor/src/lib/controlPlane.js is the signing half. Change both or
 * neither.
 *
 * nginx additionally refuses /api/internal/ from the internet (the vendor
 * calls this service on 127.0.0.1). The signature is the control; the
 * nginx rule is defence in depth.
 */
import crypto from "node:crypto";

const MAX_SKEW_SECONDS = 300;
const seen = new Map(); // signature -> expiry ms

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

export function signingString({ t, method, path, body }) {
  return `${t}\n${String(method).toUpperCase()}\n${path}\n${sha256(body || "")}`;
}

export function sign(secret, parts) {
  return crypto.createHmac("sha256", secret).update(signingString(parts)).digest("hex");
}

/**
 * Keeps the exact bytes of a JSON body for signature checks. Pass as
 * express.json({ verify: keepRawBody }) — re-serialising the parsed body
 * would not reproduce the bytes that were signed.
 */
export function keepRawBody(req, _res, buf) {
  if (req.originalUrl?.startsWith("/api/internal/")) req.rawBody = buf;
}

/** Express middleware for every /api/internal route. */
export function requireControlPlane(req, res, next) {
  const secret = process.env.CONTROL_PLANE_SECRET;
  if (!secret || secret.length < 32) {
    return res.status(503).json({ error: "The control plane is not configured on this deployment." });
  }

  const header = req.headers.authorization || "";
  const match = /^SILLA-HMAC t=(\d+),sig=([a-f0-9]{64})$/.exec(header);
  if (!match) return res.status(401).json({ error: "Missing or malformed control-plane signature." });

  const t = Number(match[1]);
  const given = match[2];
  if (Math.abs(Date.now() / 1000 - t) > MAX_SKEW_SECONDS) {
    return res.status(401).json({ error: "Control-plane request is too old or from the future." });
  }

  const expected = sign(secret, {
    t,
    method: req.method,
    path: req.originalUrl,
    body: req.rawBody ? req.rawBody.toString("utf8") : "",
  });
  const ok = crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
  if (!ok) return res.status(401).json({ error: "Bad control-plane signature." });

  const now = Date.now();
  for (const [sig, expiry] of seen) if (expiry < now) seen.delete(sig);
  if (seen.has(given)) return res.status(401).json({ error: "Control-plane request was already used." });
  seen.set(given, now + MAX_SKEW_SECONDS * 2 * 1000);

  return next();
}
