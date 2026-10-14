/**
 * Organization addresses: the `harborview` in <client>/harborview/map.
 *
 * The product serves every organization from one front end and tells them
 * apart by the first path segment, so a slug must never collide with a
 * route the app itself owns — "/login" has to stay the login page of
 * whichever organization you are in, not become an organization called
 * "login". RESERVED lists every top-level segment the client or the
 * deployment uses, plus a few that would be confusing or abusable.
 */

export const RESERVED_SLUGS = new Set([
  // client routes (client/src/App.jsx)
  "login", "kiosk", "map", "admin", "editor", "terms", "change-pin",
  // infrastructure and assets
  "api", "assets", "static", "socket.io", "favicon.ico", "robots.txt", "index.html",
  // names that would read as SILLA itself or as something official
  "silla", "www", "app", "help", "support", "billing", "status", "staff", "internal",
]);

const SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** "Harborview Reading Room" → "harborview-reading-room" (not checked for availability). */
export function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // é → e
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Returns an error message, or null when the slug is acceptable. */
export function slugProblem(slug) {
  if (typeof slug !== "string" || !slug) return "Choose an address.";
  if (!SHAPE.test(slug)) {
    return "Use 3–40 lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (slug.includes("--")) return "Use single hyphens between words.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved. Choose another address.`;
  return null;
}
