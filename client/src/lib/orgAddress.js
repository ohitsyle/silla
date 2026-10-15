/**
 * Organization addresses — the `harborview` in <product>/harborview/map
 * (docs/control-plane.md §1).
 *
 * One front end serves every organization and tells them apart by the
 * first path segment. Everything an organization's people use lives under
 * it, so the router is mounted with basename "/<slug>" and every route and
 * link inside the app stays exactly as it was ("/map", "/admin/reports").
 *
 * resolveAddress() runs once, at boot (App.jsx), and decides which
 * organization the page is for — or that it cannot tell, in which case
 * App.jsx asks the person where they meant to go.
 */
import { api } from "./api.js";

/**
 * The client's own top-level routes from before addresses existed. Kiosks,
 * bookmarks and printed signs point at these, so on a deployment with a
 * default organization they are redirected into it rather than broken.
 *
 * Mirrors the client half of RESERVED_SLUGS in server/src/lib/slug.js: no
 * organization can be called "map", so a first segment of "map" is always
 * one of these and never an address. A route added to App.jsx at the TOP
 * level belongs in both lists; one nested under these (such as
 * /login/reset) does not, because its first segment is already here.
 */
export const LEGACY_ROUTES = new Set(["map", "login", "kiosk", "admin", "editor", "terms", "change-pin"]);

/**
 * The shape lib/slug.js accepts: 3–40 lowercase letters, digits and single
 * hyphens, starting and ending with a letter or digit. Checked here only
 * to avoid asking the server about something that cannot be an address
 * ("favicon.ico", a stray "%20") — the server is still the one that knows.
 */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const isSlugShaped = (value) => typeof value === "string" && SLUG_SHAPE.test(value) && !value.includes("--");

/** "/harborview/map/abc" → { first: "harborview", rest: "/map/abc" }; "/" → { first: "", rest: "" }. */
export function splitPath(pathname) {
  const path = String(pathname || "/");
  const match = path.match(/^\/([^/]*)(.*)$/);
  if (!match) return { first: "", rest: "" };
  let first = match[1];
  try {
    first = decodeURIComponent(first);
  } catch {
    // A malformed escape is simply not an address; keep it as typed.
  }
  return { first, rest: match[2] };
}

/**
 * What someone typed into "Find your organization", reduced to the
 * address: a bare one ("harborview"), one with a leading slash or a page
 * after it ("/harborview/map"), or a whole link pasted from an email
 * ("https://example.cloudfront.net/harborview/login"). Lowercased, because
 * addresses are; returns "" when nothing usable was typed.
 */
export function addressFromInput(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";

  // A link, with or without its scheme: everything up to the first slash
  // is a host when it has a dot in it ("d3t…cloudfront.net/harborview").
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      return "";
    }
  } else {
    const [head, ...tail] = text.split("/");
    if (head.includes(".") && tail.length) text = `/${tail.join("/")}`;
  }

  const { first } = splitPath(text.startsWith("/") ? text : `/${text}`);
  return first.trim().toLowerCase();
}

/**
 * Which organization this page load is for, decided from its address.
 *
 *   /<slug>/…            that organization, router mounted at "/<slug>"
 *   /map, /kiosk, … or /  the DEFAULT organization (VITE_DEMO_ORG_ID): the
 *                         address is rewritten to /<its slug>/… so links,
 *                         reloads and the back button all agree from here on
 *   …with no default      { phase: "find" }: ask the person
 *   an unknown address    { phase: "not-found" }, with what they asked for
 *   the API unreachable   { phase: "unavailable" }, to retry
 *
 * "find" and "not-found" also carry `then`: the page that was asked for
 * (/kiosk, /map/abc?room=…), so finding the organization lands there and
 * not on its home page — a kiosk pointed at /kiosk should end up at
 * /<slug>/kiosk once someone types the address, not at a map.
 *
 * One window matters: a default organization that has no slug yet (it
 * predates addresses and `npm run migrate:slugs` has not run) is served
 * at the legacy paths with no prefix, exactly as before, so deploying
 * this ahead of the migration breaks nothing that works today.
 *
 * Nothing here touches the URL. `replaceWith` says what it should become,
 * and the caller applies it only if this answer is still the one it
 * wants — under StrictMode the boot effect runs twice, and the address
 * must be rewritten once, from the address the page was opened at.
 */
export async function resolveAddress({ pathname, search = "", hash = "" }, defaultOrganizationId) {
  const { first, rest } = splitPath(pathname);

  if (!first || LEGACY_ROUTES.has(first)) {
    const find = { phase: "find", then: first ? `${pathname}${search}${hash}` : "" };
    if (!defaultOrganizationId) return find;
    let org;
    try {
      org = await api.getOrgConfig(defaultOrganizationId);
    } catch (err) {
      // A default that no longer exists is no default at all.
      return err.status === 404 ? find : { phase: "unavailable" };
    }
    if (!org.slug) return { phase: "ready", org, basename: "" };
    const target = `/${org.slug}${first ? pathname : ""}`;
    return { phase: "ready", org, basename: `/${org.slug}`, replaceWith: `${target}${search}${hash}` };
  }

  const slug = first.toLowerCase();
  const notFound = { phase: "not-found", attempted: first, then: `${rest}${search}${hash}` };
  if (!isSlugShaped(slug)) return notFound;

  let org;
  try {
    org = await api.getOrgConfigBySlug(slug);
  } catch (err) {
    return err.status === 404 ? notFound : { phase: "unavailable" };
  }
  // The canonical spelling: /Harborview/map becomes /harborview/map, so
  // the address a person copies next is the real one.
  const canonical = org.slug || slug;
  return {
    phase: "ready",
    org,
    basename: `/${canonical}`,
    ...(first !== canonical ? { replaceWith: `/${canonical}${rest}${search}${hash}` } : {}),
  };
}
