import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { useOrg } from "./OrgContext.jsx";
import { clearToken, readToken, writeToken } from "./session.js";

const AuthContext = createContext(null);

/**
 * AuthProvider — session state for AUTH-1 and AUTH-3, for THIS
 * organization.
 *
 * Sessions are per organization (lib/session.js): the token lives under
 * `silla_token:<organizationId>`, so signing in here never signs you in
 * to — or out of — another organization open in the next tab.
 *
 * The terms gate is deliberately re-checked against the server on boot
 * rather than trusted from localStorage: the whole point of AUTH-3 is
 * that a user cannot proceed until they have accepted, and a flag the
 * client stores is a flag the client can edit.
 */
export function AuthProvider({ children }) {
  const { organizationId } = useOrg();
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => readToken(organizationId));
  const [booting, setBooting] = useState(() => Boolean(readToken(organizationId)));

  useEffect(() => {
    if (!token) {
      setBooting(false);
      return;
    }
    api
      .getMe()
      .then((data) => setUser(data.user))
      .catch(() => {
        // Expired or revoked — drop it rather than leaving a dead token
        // that makes every later request fail confusingly.
        clearToken(organizationId);
        setToken(null);
        setUser(null);
      })
      .finally(() => setBooting(false));
  }, [token, organizationId]);

  const login = useCallback(
    async (email, pin) => {
      const data = await api.login(organizationId, email, pin);
      writeToken(organizationId, data.token);
      setToken(data.token);
      setUser(data.user);
      return data.user;
    },
    [organizationId]
  );

  const logout = useCallback(() => {
    clearToken(organizationId);
    setToken(null);
    setUser(null);
  }, [organizationId]);

  /** Re-reads the session from the server (after a PIN change etc). */
  const refresh = useCallback(async () => {
    try {
      const data = await api.getMe();
      setUser(data.user);
      return data.user;
    } catch {
      return null;
    }
  }, []);

  const acceptTerms = useCallback(async () => {
    await api.acceptTerms();
    setUser((u) => (u ? { ...u, requiresTermsAcceptance: false } : u));
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      booting,
      isAuthenticated: Boolean(token && user),
      requiresTermsAcceptance: Boolean(user?.requiresTermsAcceptance),
      mustChangePin: Boolean(user?.mustChangePin),
      login,
      logout,
      acceptTerms,
      refresh,
    }),
    [user, token, booting, login, logout, acceptTerms, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
