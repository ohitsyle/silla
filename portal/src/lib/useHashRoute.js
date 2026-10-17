import { useCallback, useEffect, useState } from "react";

/**
 * The portal's routing, still on the hash.
 *
 * It started as one boolean for two views. There are now five, which is
 * the point where a router usually earns its place — but these are flat,
 * have no nested layouts and no params beyond a single id, so a router
 * would be a dependency, a provider and a build cost for a `switch`.
 * If this grows nested routes or route-level data loading, swap it.
 *
 * The hash keeps every view linkable and refresh-proof, which matters
 * most for `#/orders/<id>`: a buyer emailing us about an order should be
 * able to send the URL of the thing they mean.
 */

export const ROUTES = {
  home: "",
  configure: "#/configure",
  signIn: "#/sign-in",
  signUp: "#/sign-up",
  orders: "#/orders",
  queue: "#/queue",
  account: "#/account",
  terms: "#/terms",
  billing: "#/billing", // a buyer's plan, subscription and invoices
  invoices: "#/invoices", // #/invoices/<id> — one invoice, printable
  messages: "#/messages", // #/messages[/<conversationId>]
  staff: "#/staff", // #/staff/<section>[/<id>] — the staff console
  staffSignIn: "#/staff/sign-in",
};

/**
 * `#/staff/clients/abc` → { name: "staff", section: "clients", id: "abc" }.
 * `#/staff/sign-in/invitation` is the staff door opened on "I have an
 * invitation" — the link an invitation email carries.
 */
function parseStaff(rest) {
  const [section = "", id = null] = rest;
  if (section === "sign-in") return { name: "staffSignIn", id, section: null };
  return { name: "staff", section: section || "dashboard", id };
}

/**
 * A list's filters, kept in the address after a "?" — `#/staff/orders?status=open`
 * — so a filtered view can be linked, bookmarked, refreshed and reached
 * from the overview, the same reason the sections are routes at all.
 */
export const withQuery = (path, params = {}) => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
  return pairs.length ? `${path}?${new URLSearchParams(pairs.map(([k, v]) => [k, v === true ? "1" : String(v)]))}` : path;
};

/** `#/orders/abc123` → { name: "orders", id: "abc123", query: {} } */
export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [clean, search = ""] = raw.split("?");
  const query = Object.fromEntries(new URLSearchParams(search));
  return { ...parsePath(clean), query };
}

function parsePath(clean) {
  if (!clean) return { name: "home", id: null };

  const [head, id = null, ...rest] = clean.split("/");
  if (head === "staff") return parseStaff([id, ...rest].filter((part) => part !== null));
  const known = {
    configure: "configure",
    "sign-in": "signIn",
    "sign-up": "signUp",
    orders: "orders",
    queue: "queue",
    account: "account",
    terms: "terms",
    billing: "billing",
    invoices: "invoices",
    messages: "messages",
  };
  return { name: known[head] || "home", id };
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  /**
   * `replace` avoids stacking history entries for redirects — being
   * bounced to sign-in and then pressing Back should not put you back
   * on the page that bounced you.
   */
  const navigate = useCallback((to, { replace = false } = {}) => {
    const target = to || "";

    if (replace) {
      const url = window.location.pathname + window.location.search + target;
      window.history.replaceState(null, "", url);
      setRoute(parseHash(target));
      return;
    }

    if (!target) {
      // Clear the hash without leaving a bare "#" behind.
      window.history.pushState("", document.title, window.location.pathname + window.location.search);
      setRoute({ name: "home", id: null, query: {} });
      return;
    }

    window.location.hash = target;
  }, []);

  return { route, navigate };
}
