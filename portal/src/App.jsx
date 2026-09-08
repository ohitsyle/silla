import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import Landing from "./marketing/Landing.jsx";
import Wizard from "./Wizard.jsx";
import AuthScreen from "./account/AuthScreen.jsx";
import Orders from "./account/Orders.jsx";
import Queue from "./account/Queue.jsx";
import { AccountProvider, useAccount } from "./lib/AccountContext.jsx";
import { ROUTES, useHashRoute } from "./lib/useHashRoute.js";

/**
 * The portal's views.
 *
 *   /               the storefront — what SILLA is, what it costs
 *   #/configure     the seven-step configurator
 *   #/sign-in       · #/sign-up
 *   #/orders[/id]   a buyer's saved configurations and their progress
 *   #/queue[/id]    SILLA's order queue (staff only)
 *
 * Hash routing rather than a router: these are flat, have no nested
 * layouts and one id parameter between them. See lib/useHashRoute.js.
 *
 * Moving between the storefront and the configurator is covered by a
 * short branded wipe. The swap takes about 60ms — there is nothing to
 * wait for — but an instant cut between two full-screen surfaces reads
 * as a glitch rather than as navigation. It is not a spinner pretending
 * to load, which is why it is fixed-length and short.
 *
 * Both surfaces share one warm palette (see index.css). Only the BUYER's
 * preview inside the wizard is dark, scoped to .silla-preview.
 */

function Routed() {
  const { route, navigate } = useHashRoute();
  const { isSignedIn, isSilla, booting } = useAccount();

  const [wiping, setWiping] = useState(false);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** Runs the wipe, swaps underneath it at the closed point, then lifts. */
  const transition = useCallback(
    (to) => {
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      if (reduced) {
        navigate(to);
        window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      setWiping(true);
      timers.current.push(
        setTimeout(() => {
          navigate(to);
          window.scrollTo({ top: 0, behavior: "auto" });
        }, 320),
        setTimeout(() => setWiping(false), 380)
      );
    },
    [navigate]
  );

  useEffect(() => {
    const titles = {
      home: "SILLA — save you a seat",
      configure: "Configure your system · SILLA",
      signIn: "Sign in · SILLA",
      signUp: "Create an account · SILLA",
      orders: "Your orders · SILLA",
      queue: "Order queue · SILLA",
    };
    document.title = titles[route.name] || titles.home;
  }, [route.name]);

  // Wait for the session check before deciding anything — otherwise a
  // refresh on #/orders bounces to sign-in for a frame and back again.
  const guarded = ["orders", "queue"].includes(route.name);
  if (booting && guarded) {
    return (
      <div className="silla-marketing grid min-h-screen place-items-center text-ink-muted">Loading…</div>
    );
  }

  if (guarded && !isSignedIn) {
    return <AuthScreen mode="signIn" navigate={navigate} redirectTo={window.location.hash} />;
  }
  if (route.name === "queue" && !isSilla) {
    // A buyer who guesses the URL gets their own orders rather than a
    // dead end. The API refuses them regardless — this is only about
    // not presenting a page that was never theirs to reach.
    return <Orders id={null} navigate={navigate} />;
  }

  const view = () => {
    switch (route.name) {
      case "configure":
        return <Wizard onExit={() => transition(ROUTES.home)} navigate={navigate} />;
      case "signIn":
      case "signUp":
        return <AuthScreen mode={route.name} navigate={navigate} />;
      case "orders":
        return <Orders id={route.id} navigate={navigate} />;
      case "queue":
        return <Queue id={route.id} navigate={navigate} />;
      default:
        return <Landing onConfigure={() => transition(ROUTES.configure)} navigate={navigate} />;
    }
  };

  return (
    <>
      {view()}

      <AnimatePresence>
        {wiping && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-center justify-center"
            style={{ background: "rgb(var(--c-accent))", color: "rgb(var(--c-accent-ink))" }}
            initial={{ clipPath: "inset(100% 0% 0% 0%)" }}
            animate={{ clipPath: "inset(0% 0% 0% 0%)" }}
            exit={{ clipPath: "inset(0% 0% 100% 0%)" }}
            transition={{ duration: 0.32, ease: [0.65, 0, 0.35, 1] }}
            aria-hidden
          >
            <motion.span
              className="display text-4xl"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.25 }}
            >
              SILLA
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function App() {
  return (
    <AccountProvider>
      <Routed />
    </AccountProvider>
  );
}
