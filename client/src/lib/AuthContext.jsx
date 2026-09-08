import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const AuthContext = createContext(null);

const TOKEN_KEY = "silla_token";

/**
 * AuthProvider — session state for AUTH-1 and AUTH-3.
 *
 * The terms gate is deliberately re-checked against the server on boot
 * rather than trusted from localStorage: the whole point of AUTH-3 is
 * that a user cannot proceed until they have accepted, and a flag the
 * client stores is a flag the client can edit.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [booting, setBooting] = useState(Boolean(localStorage.getItem(TOKEN_KEY)));

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
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setBooting(false));
  }, [token]);

  const login = useCallback(async (organizationId, email, pin) => {
    const data = await api.login(organizationId, email, pin);
    localStorage.setItem(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

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
