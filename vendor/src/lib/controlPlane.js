/**
 * The signed client for a deployment's control-plane API
 * (server/src/routes/internal.routes.js). This is how SILLA staff actions
 * — provision, change a plan, suspend, re-issue an owner's access — reach
 * the product, without the two services sharing code or a JWT secret.
 *
 *   Authorization: SILLA-HMAC t=<unix seconds>,sig=<hex>
 *   sig = HMAC-SHA256(CONTROL_PLANE_SECRET, `${t}\n${METHOD}\n${path incl. query}\n${sha256hex(body)}`)
 *
 * server/src/lib/controlPlane.js is the verifying half. Change both or
 * neither. The body is signed as the exact string sent, so it is
 * serialised once, here, and never re-serialised on the way out.
 *
 *   SERVER_INTERNAL_URL   where the product API listens; the vendor calls
 *                         it directly on the box (default 127.0.0.1:4000),
 *                         never through CloudFront — nginx refuses
 *                         /api/internal/ from outside
 *   CONTROL_PLANE_SECRET  shared with server/, 32+ characters
 */
import crypto from "node:crypto";

export class ControlPlaneError extends Error {
  constructor(message, status = 502, data = {}) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.data = data;
  }
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

export function signRequest(secret, { method, path, body = "", t = Math.floor(Date.now() / 1000) }) {
  const payload = `${t}\n${method.toUpperCase()}\n${path}\n${sha256(body)}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `SILLA-HMAC t=${t},sig=${sig}`;
}

export const controlPlaneConfigured = () => (process.env.CONTROL_PLANE_SECRET || "").length >= 32;

/**
 * Calls the deployment and returns its parsed JSON. Throws
 * ControlPlaneError with the deployment's own message on any non-2xx, and
 * with status 503 if this service was never given the secret — a staff
 * action must fail loudly, not appear to work.
 */
export async function callDeployment(method, path, body) {
  const secret = process.env.CONTROL_PLANE_SECRET || "";
  if (secret.length < 32) {
    throw new ControlPlaneError("The control plane is not configured (CONTROL_PLANE_SECRET).", 503);
  }
  const base = (process.env.SERVER_INTERNAL_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
  const payload = body === undefined ? "" : JSON.stringify(body);

  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        Authorization: signRequest(secret, { method, path, body: payload }),
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload || undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ControlPlaneError(`Couldn't reach the product API: ${err.message}`, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ControlPlaneError(data.error || `The product API answered ${res.status}.`, res.status, data);
  return data;
}
