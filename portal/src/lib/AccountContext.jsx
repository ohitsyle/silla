import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { readToken, vendorApi, writeToken } from "./vendorApi.js";

const AccountContext = createContext(null);

/**
 * Who is signed in to the storefront.
 *
 * Entirely separate from a buyer's deployment session (client/'s
 * AuthContext). Someone can be signed in here to buy a system and have
 * no account in any deployment at all.
 *
 * `booting` exists so the app can tell "no session" from "we have a
 * token and are checking it". Without it, a refresh flashes the signed-
 * out state for a moment before the account arrives.
 */
export function AccountProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [booting, setBooting] = useState(Boolean(readToken()));

  useEffect(() => {
    if (!readToken()) return;
    vendorApi
      .me()
      .then((d) => setAccount(d.account))
      .catch((err) => {
        // Only a 401 means the session is gone. A dropped connection or a
        // 502 while the API restarts used to delete the token too, which
        // signed people out at random during every deploy.
        if (err.status === 401) {
          writeToken(null);
          setAccount(null);
        }
      })
      .finally(() => setBooting(false));
  }, []);

  /** Any response carrying `{ token?, account }` — sign-in, sign-up, reset, password change. */
  const applySession = useCallback((data) => {
    if (data?.token) writeToken(data.token);
    if (data?.account) setAccount(data.account);
    return data?.account;
  }, []);

  const signIn = useCallback(async (email, password) => applySession(await vendorApi.login(email, password)), [applySession]);
  const signUp = useCallback(async (payload) => applySession(await vendorApi.register(payload)), [applySession]);

  const signOut = useCallback(() => {
    writeToken(null);
    setAccount(null);
  }, []);

  const refresh = useCallback(async () => applySession(await vendorApi.me()), [applySession]);

  // A password change on another device revokes this session.
  useEffect(() => {
    const onRevoked = () => signOut();
    window.addEventListener("silla:session-revoked", onRevoked);
    return () => window.removeEventListener("silla:session-revoked", onRevoked);
  }, [signOut]);

  const value = useMemo(
    () => ({
      account,
      booting,
      isSignedIn: Boolean(account),
      isSilla: account?.role === "silla",
      isVerified: Boolean(account?.emailVerified),
      signIn,
      signUp,
      signOut,
      refresh,
      applySession,
    }),
    [account, booting, signIn, signUp, signOut, refresh, applySession]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}

/** "Ana Reyes" -> "AR". For the account menu's avatar. */
export const initialsOf = (account) =>
  [account?.firstName, account?.lastName]
    .filter(Boolean)
    .map((part) => part.trim()[0])
    .join("")
    .toUpperCase() || (account?.email?.[0] || "?").toUpperCase();
