import { useEffect, useSyncExternalStore } from "react";
import { staffApi } from "./staffApi.js";

/**
 * How many replies from SILLA a buyer hasn't read — the badge on Messages
 * in the account menu.
 *
 * One store for the whole page, so the menu and the messages page agree:
 * reading a thread clears the badge at once (refreshUnread) instead of
 * whenever the next poll lands. The polling is owned by the app shell
 * (usePollUnread in App.jsx), which outlives every page — owned by the
 * menu, it would stop and restart on each navigation and flicker to zero.
 */
let state = { unread: 0, threads: 0 };
const listeners = new Set();

const publish = (next) => {
  if (next.unread === state.unread && next.threads === state.threads) return;
  state = next;
  listeners.forEach((l) => l());
};

export function refreshUnread() {
  return staffApi
    .myUnread()
    .then((d) => publish({ unread: d.unread || 0, threads: d.threads || 0 }))
    .catch(() => {});
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/** { unread, threads } — read anywhere; zeros until a buyer is signed in. */
export const useUnreadMessages = () => useSyncExternalStore(subscribe, snapshot, snapshot);

/** Keeps the count fresh while `enabled` (a signed-in buyer), and clears it otherwise. */
export function usePollUnread(enabled, accountId) {
  useEffect(() => {
    if (!enabled) {
      publish({ unread: 0, threads: 0 });
      return undefined;
    }
    refreshUnread();
    const onVisible = () => document.visibilityState === "visible" && refreshUnread();
    const timer = setInterval(onVisible, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, accountId]);
}
