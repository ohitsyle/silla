import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { readToken, vendorApi, writeToken } from "./vendorApi.js";

const AccountContext = createContext(null);

/**
 * Who is signed in to the storefront.
 *
 * Entirely separate from a buyer's deployment session (client/'s
 * AuthContext). Someone can be signed in here to buy a system and have
 * no account in any deployment at all — they are, at this point, not a
 * user of the product.
 *
 * `booting` exists so the app can tell "no session" from "we have a
 * token and are checking it". Without it, a refresh flashes the signed-
 * out state for a moment before the account arrives, which reads as
 * being logged out at random.
 */
export function AccountProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [booting, setBooting] = useState(Boolean(readToken()));

  useEffect(() => {
    if (!readToken()) return;
    vendorApi
      .me()
      .then((d) => setAccount(d.account))
      .catch(() => {
        // Expired or revoked: drop it rather than leaving a token that
        // makes every later request fail in a confusing way.
        writeToken(null);
        setAccount(null);
      })
      .finally(() => setBooting(false));
  }, []);

  const signIn = useCallback(async (email, password) => {
    const data = await vendorApi.login(email, password);
    writeToken(data.token);
    setAccount(data.account);
    return data.account;
  }, []);

  const signUp = useCallback(async (payload) => {
    const data = await vendorApi.register(payload);
    writeToken(data.token);
    setAccount(data.account);
    return data.account;
  }, []);

  const signOut = useCallback(() => {
    writeToken(null);
    setAccount(null);
  }, []);

  const value = useMemo(
    () => ({
      account,
      booting,
      isSignedIn: Boolean(account),
      isSilla: account?.role === "silla",
      signIn,
      signUp,
      signOut,
    }),
    [account, booting, signIn, signUp, signOut]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
