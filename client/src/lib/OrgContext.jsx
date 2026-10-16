import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { PLAN_CHANGED_EVENT, api } from "./api.js";
import { applyOrgTheme } from "../theme/applyOrgTheme.js";

const OrgContext = createContext(null);

/**
 * OrgProvider — the organization this page is serving, app-wide, with its
 * branding applied (spec §16). Every screen should read resource/member
 * terminology from here rather than hardcoding "seat" or "student".
 *
 * It is also the ONE place a page learns which organization it is
 * serving. Which one is decided before this mounts, by the address the
 * app was opened at (App.jsx, lib/orgAddress.js): the config that boot
 * resolved arrives as `initialOrg`, so nothing renders until the
 * organization is known and its colours are already on the page.
 *
 * `entitlements` is what the organization's plan allows, as the server
 * reports it. The server enforces every limit itself — this copy only
 * exists so a screen can explain a limit BEFORE someone hits it, instead
 * of offering a button that fails. `reload()` fetches the config again,
 * for the moments it is known to be stale.
 */
export function OrgProvider({ initialOrg, children }) {
  const [org, setOrg] = useState(initialOrg);
  const organizationId = String(initialOrg._id);

  const reload = useCallback(async () => {
    try {
      const fresh = await api.getOrgConfig(organizationId);
      setOrg(fresh);
      applyOrgTheme(fresh);
      return fresh;
    } catch {
      // Keep what we have: a failed refresh must not blank a working page.
      return null;
    }
  }, [organizationId]);

  const operational = entitlementsOf(org).operational;

  /**
   * A paused organization is asked again every minute, so a kiosk or a
   * map left open on the paused state comes back by itself once the
   * subscription is sorted out — nobody should have to know to reload a
   * wall screen. A working organization is only re-read when the page
   * returns from the background after a while, or when an answer says the
   * plan changed under it (PLAN_CHANGED_EVENT, from lib/api.js); polling
   * it would cost every open tab a request a minute for news that is
   * almost always "nothing".
   */
  useEffect(() => {
    if (operational) return undefined;
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [operational, reload]);

  useEffect(() => {
    // Several requests can fail with the same news at once (a page that
    // loads three things); one re-read answers all of them.
    let pending = null;
    const onPlanChanged = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        reload();
      }, 250);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlanChanged);
    return () => {
      window.removeEventListener(PLAN_CHANGED_EVENT, onPlanChanged);
      clearTimeout(pending);
    };
  }, [reload]);

  useEffect(() => {
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const value = useMemo(
    () => ({
      org,
      // Kept for the pages that still check it. A config that fails to load
      // is now handled before the app mounts (the boot screens in App.jsx).
      error: null,
      organizationId,
      slug: org?.slug || null,
      entitlements: entitlementsOf(org),
      reload,
    }),
    [org, organizationId, reload]
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  return useContext(OrgContext);
}

/**
 * The client-side reading of Organization.entitlements. Mirrors
 * server/src/services/entitlements.js, including its permissive defaults:
 * an unmanaged organization (the demo, anything that predates
 * subscriptions) has every feature and no limits, and a key the snapshot
 * does not mention is allowed.
 */
export function entitlementsOf(org) {
  const e = org?.entitlements?.managed ? org.entitlements : null;
  const OPERATIONAL = ["trialing", "active", "past_due"];
  return {
    managed: Boolean(e),
    status: e?.status || "active",
    plan: e?.plan || null,
    planName: e?.planName || null,
    notice: e?.notice || null,
    currentPeriodEnd: e?.currentPeriodEnd || null,
    graceEndsAt: e?.graceEndsAt || null,
    operational: !e || OPERATIONAL.includes(e.status),
    hasFeature: (key) => !e || e.features?.[key] === undefined || Boolean(e.features[key]),
    /** null = no limit. */
    limitOf: (key) => {
      const v = e?.limits?.[key];
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    },
  };
}
