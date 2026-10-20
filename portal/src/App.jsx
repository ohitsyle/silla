import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import Landing from "./marketing/Landing.jsx";
import EntryDialog from "./marketing/EntryDialog.jsx";
import Wizard from "./Wizard.jsx";
import AuthScreen from "./account/AuthScreen.jsx";
import Orders from "./account/Orders.jsx";
import ProfilePage from "./account/ProfilePage.jsx";
import { TermsPage } from "./account/Terms.jsx";
import BillingPage from "./account/BillingPage.jsx";
import InvoicePage from "./account/InvoicePage.jsx";
import MessagesPage from "./account/MessagesPage.jsx";
import StaffConsole from "./staff/StaffConsole.jsx";
import StaffSignIn from "./staff/StaffSignIn.jsx";
import { AccountProvider, useAccount } from "./lib/AccountContext.jsx";
import { ROUTES, useHashRoute } from "./lib/useHashRoute.js";
import { usePollUnread } from "./lib/useUnreadMessages.js";
import { saveIntent } from "./lib/entryIntent.js";
import { ToastProvider } from "./lib/toast.jsx";

/**
 * The portal's views.
 *
 *   /                    the storefront — what SILLA is, what it costs
 *   #/configure          the seven-step configurator
 *   #/sign-in            · #/sign-up
 *   #/orders[/id]        a buyer's saved configurations and their progress
 *   #/billing            · #/invoices/<id>   a buyer's plan, subscription and invoices
 *   #/messages[/id]      a buyer's conversations with SILLA
 *   #/account            · #/terms
 *   #/staff/<section>[/<id>][?filters]       the staff console
 *   #/staff/sign-in[/invitation]             its door, and an invited person's
 *   #/queue[/id]         the old order queue — now #/staff/orders, which it redirects to
 *
 * Hash routing rather than a router: these are flat, have no nested
 * layouts and one id parameter between them. See lib/useHashRoute.js.
 *
 * Every change of page is covered by a short branded wipe. The swap
 * itself takes about 60ms — there is nothing to wait for — but an
 * instant cut between two full-screen surfaces reads as a glitch rather
 * than as navigation. It is not a spinner pretending to load, which is
 * why it is fixed-length and short.
 *
 * It is driven by the ROUTE, not by whoever navigated. It used to be a
 * `transition()` function only the doorway and the wizard's exit called,
 * so two page changes wiped and every other one — the account menu,
 * footer links, sign-in's redirect, the Back button — cut. Watching the
 * hash means anything that changes the page gets it without knowing
 * the wipe exists. What is RENDERED is `shown`, which trails `route` by
 * the time the panel takes to close.
 *
 * Both surfaces share one warm palette (see index.css). Only the BUYER's
 * preview inside the wizard is dark, scoped to .silla-preview.
 */

/** How long the panel takes to close over the page. The swap happens then. */
const COVER_MS = 320;

const GUARDED = ["orders", "account", "billing", "invoices", "messages", "staff"];

/**
 * What is on screen is not only the address. A signed-out visitor at
 * #/orders sees the sign-in screen, and signing in turns it into their
 * orders without the hash moving — that is a change of page too, so the
 * gate's state is part of the key. While the session is still being
 * checked the gate is "?", and settling it is not navigation: a refresh
 * on #/orders must not wipe on load.
 */
const pageKey = (p) => `${p.name}/${p.section || ""}/${p.id || ""}/${p.gate}`;

/**
 * Pages that swap WITHOUT a wipe share a group. Sign in and sign up are
 * one screen with two tabs; the tabs have their own sliding indicator,
 * and a full-screen wipe between them would turn a tab click into a page
 * load. Everything else — including a list and one of its orders — is
 * its own page.
 */
const group = (p) => {
  if (p.name === "signIn" || p.name === "signUp") return "auth";
  // The staff door and its invitation form are one screen with two faces.
  if (p.name === "staffSignIn") return "staffDoor";
  // The staff console is a tool with a fixed sidebar; wiping the whole
  // screen between its sections would be a page load for a tab click.
  // Entering or leaving it still wipes.
  if (p.name === "staff" && p.gate === "in") return "staff";
  return pageKey(p);
};

/**
 * Trails `route` behind a wipe: the panel closes, the page swaps under
 * it and scrolls to the top, and the panel lifts.
 *
 * - Several navigations inside one wipe swap once, when it closes — the
 *   panel does not restart for each.
 * - Landing back on the page already showing (a redirect that undoes the
 *   navigation, or Back pressed mid-wipe) lifts the panel with no swap.
 * - Reduced motion, moves within one group, and the session check
 *   settling, swap immediately.
 */
function usePageWipe(target) {
  const [page, setPage] = useState(target);
  const [wiping, setWiping] = useState(false);
  const timers = useRef([]);
  const closesAt = useRef(0);
  const scrollOnSwap = useRef(false);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);

  useEffect(() => {
    if (pageKey(target) === pageKey(page)) {
      if (timers.current.length) {
        clear();
        setWiping(false);
      }
      return;
    }

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const regroup = group(target) !== group(page);
    if (reduced || !regroup || page.gate === "?") {
      clear();
      setWiping(false);
      scrollOnSwap.current = regroup;
      setPage(target);
      return;
    }

    clear();
    if (!wiping) closesAt.current = Date.now() + COVER_MS;
    setWiping(true);
    const wait = Math.max(0, closesAt.current - Date.now());
    timers.current.push(
      setTimeout(() => {
        scrollOnSwap.current = true;
        setPage(target);
      }, wait),
      setTimeout(() => {
        timers.current = [];
        setWiping(false);
      }, wait + 60)
    );
    // `page` and `wiping` are read as they stand when the target moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey(target)]);

  // After the swap has committed — a passive effect, so it runs after the
  // old page's cleanups, including a dialog releasing its scroll lock.
  useEffect(() => {
    if (!scrollOnSwap.current) return;
    scrollOnSwap.current = false;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [page]);

  return { page, wiping };
}

function Routed() {
  const { route, navigate } = useHashRoute();
  const { account, isSignedIn, isSilla, booting } = useAccount();

  // A buyer's unread replies from SILLA, for the account menu's badge —
  // kept here, above every page, so navigating never resets it.
  usePollUnread(isSignedIn && !isSilla, account?.id);

  /**
   * The doorway (journey step 4). Every "build" CTA on the storefront
   * opens this instead of jumping straight into the configurator, which
   * used to drop a stranger onto step 1 of a seven-step form with no
   * explanation of what it was or how long it would take.
   *
   * `intent` carries what they clicked — which plan, which billing
   * period — so it can be preselected instead of discarded.
   */
  const [entry, setEntry] = useState(null);

  const gate = !GUARDED.includes(route.name) ? "" : booting ? "?" : isSignedIn ? "in" : "out";
  const shown = usePageWipe({ name: route.name, id: route.id, section: route.section || null, gate });

  useEffect(() => {
    const titles = {
      home: "SILLA — save you a seat",
      configure: "Configure your system · SILLA",
      signIn: "Sign in · SILLA",
      signUp: "Create an account · SILLA",
      orders: "Your orders · SILLA",
      queue: "Order queue · SILLA",
      account: "Your profile · SILLA",
      terms: "Terms & Conditions · SILLA",
      billing: "Billing · SILLA",
      invoices: "Invoice · SILLA",
      messages: "Messages · SILLA",
      staff: "Staff console · SILLA",
      staffSignIn: "Staff sign in · SILLA",
    };
    document.title = titles[shown.page.name] || titles.home;
  }, [shown.page.name]);

  // Arriving at sign-in while already signed in reads as having been
  // logged out, so go home instead. Deliberately keyed on the ROUTE, not
  // on isSignedIn: signing UP signs you in while you're still on this
  // page, and the verification dialog must stay open when that happens.
  useEffect(() => {
    if ((route.name === "signIn" || route.name === "signUp") && isSignedIn && !booting) {
      navigate(ROUTES.home, { replace: true });
    }
    // Staff arriving at their own door while signed in go straight to work.
    if (route.name === "staffSignIn" && isSignedIn && isSilla && !booting) {
      navigate(ROUTES.staff, { replace: true });
    }
    // The queue moved into the console. Old links — bookmarks, and the
    // new-order emails sent before it moved — land on the same order there.
    if (route.name === "queue") {
      navigate(route.id ? `${ROUTES.staff}/orders/${route.id}` : `${ROUTES.staff}/orders`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, booting]);

  const page = shown.page;

  const view = () => {
    // Wait for the session check before deciding anything — otherwise a
    // refresh on #/orders bounces to sign-in for a frame and back again.
    if (page.gate === "?") {
      return <div className="silla-marketing grid min-h-screen place-items-center text-ink-muted">Loading…</div>;
    }
    if (page.gate === "out") {
      // Staff have their own door; everyone else gets the storefront's.
      if (page.name === "staff") return <StaffSignIn navigate={navigate} />;
      // From the page being SHOWN, not location.hash: mid-wipe the hash
      // has already moved on while this is still on screen.
      const here = `${ROUTES[page.name]}${page.id ? `/${page.id}` : ""}`;
      return <AuthScreen mode="signIn" navigate={navigate} redirectTo={here} />;
    }

    switch (page.name) {
      case "configure":
        return <Wizard onExit={() => navigate(ROUTES.home)} navigate={navigate} />;
      case "signIn":
      case "signUp":
        return <AuthScreen mode={page.name} navigate={navigate} />;
      case "orders":
        return <Orders id={page.id} navigate={navigate} />;
      case "queue":
        // Redirecting to #/staff/orders (above); nothing to show for a frame.
        return <div className="silla-marketing min-h-screen" />;
      case "account":
        return <ProfilePage navigate={navigate} />;
      case "terms":
        return <TermsPage navigate={navigate} />;
      case "billing":
        return <BillingPage navigate={navigate} />;
      case "invoices":
        return <InvoicePage id={page.id} navigate={navigate} />;
      case "messages":
        return <MessagesPage id={page.id} navigate={navigate} />;
      case "staff":
        // A buyer who guesses the address is sent to their own orders
        // rather than a dead end; the API refuses them regardless.
        return isSilla ? (
          <StaffConsole section={page.section} id={page.id} query={route.query || {}} navigate={navigate} />
        ) : (
          <Orders id={null} navigate={navigate} />
        );
      case "staffSignIn":
        return <StaffSignIn navigate={navigate} mode={page.id} />;
      default:
        return (
          <Landing
            // The doorway, not the configurator. `intent` is what
            // they clicked — a plan key and billing period from a
            // pricing card, or nothing from a generic CTA.
            onConfigure={(intent) => setEntry(intent || {})}
            navigate={navigate}
          />
        );
    }
  };

  return (
    <>
      {view()}

      <EntryDialog
        open={Boolean(entry)}
        onClose={() => setEntry(null)}
        planKey={entry?.plan}
        annual={entry?.annual !== false}
        onExplore={() => {
          // Straight in. Nothing is asked for, which is the whole point
          // — CLAUDE.md's rule is that the account comes LAST.
          if (entry?.plan) saveIntent({ plan: entry.plan, annual: entry.annual !== false });
          setEntry(null);
          navigate(ROUTES.configure);
        }}
        onStartNew={() => {
          // Their existing draft is replaced, which the dialog says on
          // the button. Without this the "new" one was the old draft.
          try {
            window.localStorage.removeItem("silla-portal-draft");
          } catch {
            // A draft we cannot remove is overwritten by the first edit.
          }
          if (entry?.plan) saveIntent({ plan: entry.plan, annual: entry.annual !== false });
          setEntry(null);
          navigate(ROUTES.configure);
        }}
        onSignIn={() => {
          // The plan survives the round trip through sign-in, and
          // AuthScreen's redirectTo brings them back to the wizard
          // rather than to an orders list that is empty precisely
          // because they have not configured anything yet.
          if (entry?.plan) saveIntent({ plan: entry.plan, annual: entry.annual !== false });
          setEntry(null);
          navigate(ROUTES.signIn);
        }}
      />

      <AnimatePresence>
        {shown.wiping && (
          <motion.div
            className="fixed inset-0 z-[200] flex items-center justify-center"
            style={{ background: "rgb(var(--c-accent))", color: "rgb(var(--c-accent-ink))" }}
            initial={{ clipPath: "inset(100% 0% 0% 0%)" }}
            animate={{ clipPath: "inset(0% 0% 0% 0%)" }}
            exit={{ clipPath: "inset(0% 0% 100% 0%)" }}
            transition={{ duration: COVER_MS / 1000, ease: [0.65, 0, 0.35, 1] }}
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
      <ToastProvider>
        <Routed />
      </ToastProvider>
    </AccountProvider>
  );
}
