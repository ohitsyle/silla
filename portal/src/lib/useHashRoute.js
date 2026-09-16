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
};

/** `#/orders/abc123` → { name: "orders", id: "abc123" } */
export function parseHash(hash) {
  const clean = String(hash || "").replace(/^#\/?/, "");
  if (!clean) return { name: "home", id: null };

  const [head, id = null] = clean.split("/");
  const known = {
    configure: "configure",
    "sign-in": "signIn",
    "sign-up": "signUp",
    orders: "orders",
    queue: "queue",
    account: "account",
    terms: "terms",
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
      setRoute({ name: "home", id: null });
      return;
    }

    window.location.hash = target;
  }, []);

  return { route, navigate };
}
