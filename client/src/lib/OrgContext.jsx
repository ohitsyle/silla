import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { applyOrgTheme } from "../theme/applyOrgTheme.js";

const OrgContext = createContext(null);

/**
 * OrgProvider — fetches the organization's config once on boot and
 * makes it available app-wide, applying its branding as it loads
 * (spec §16). Every screen should read resource/member terminology
 * from here rather than hardcoding "seat" or "student".
 *
 * It is also the ONE place a page learns which organization it is
 * serving. Pages used to read VITE_DEMO_ORG_ID themselves, which welded
 * every build to a single customer; reading `organizationId` from here
 * lets the app shell decide (by the address it was opened at) and every
 * page follow.
 *
 * `entitlements` is what the organization's plan allows, as the server
 * reports it. The server enforces every limit itself — this copy only
 * exists so a screen can explain a limit BEFORE someone hits it, instead
 * of offering a button that fails.
 */
export function OrgProvider({ organizationId, children }) {
  const [org, setOrg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!organizationId) return;
    api
      .getOrgConfig(organizationId)
      .then((data) => {
        setOrg(data);
        applyOrgTheme(data);
      })
      .catch((err) => setError(err.message));
  }, [organizationId]);

  const value = useMemo(
    () => ({ org, error, organizationId, entitlements: entitlementsOf(org) }),
    [org, error, organizationId]
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
