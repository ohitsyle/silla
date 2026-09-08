import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api.js";
import { applyOrgTheme } from "../theme/applyOrgTheme.js";

const OrgContext = createContext(null);

/**
 * OrgProvider — fetches the organization's config once on boot and
 * makes it available app-wide, applying its branding as it loads
 * (spec §16). Every screen should read resource/member terminology
 * from here rather than hardcoding "seat" or "student".
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

  return <OrgContext.Provider value={{ org, error }}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  return useContext(OrgContext);
}
