import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, ArrowUpRight, LogIn, LogOut, Menu, UserPlus, X } from "lucide-react";

import Chair, { ChairRow } from "./Chair.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { useUnreadMessages } from "../lib/useUnreadMessages.js";
import { ROUTES } from "../lib/useHashRoute.js";
import { AccountMenu, accountLinks } from "../account/kit.jsx";
import { EASE, prefersReducedMotion, reveal, wordChild, wordsIn } from "./motion.js";
import HowItWorks from "./sections/HowItWorks.jsx";
import WhiteLabel from "./sections/WhiteLabel.jsx";
import Features from "./sections/Features.jsx";
import Pricing from "./sections/Pricing.jsx";

/**
 * The SILLA storefront.
 *
 * The portal used to open straight into a seven-step form, which asks a
 * stranger to configure a product nobody has explained to them yet. This
 * is the part that comes first: what SILLA is, what it feels like to
 * use, what it costs, and only then — build yours.
 *
 * On the charm: "silla" is Spanish for chair, and the product's smallest
 * unit is one bookable seat. So the seat tile is the mascot, drawn
 * exactly as the real map draws it. Every playful moment on this page is
 * the actual product doing something, which is the difference between
 * charming and twee.
 */

/** Splits a headline into animatable words without breaking screen readers. */
function Display({ children, className = "" }) {
  const words = String(children).split(" ");
  return (
    <motion.h1 {...wordsIn()} className={`display ${className}`} aria-label={children}>
      {words.map((word, i) => (
        <span key={i} className="inline-block overflow-hidden align-bottom">
          <motion.span {...wordChild()} className="inline-block" aria-hidden>
            {word}
            {i < words.length - 1 ? " " : ""}
          </motion.span>
        </span>
      ))}
    </motion.h1>
  );
}

function Cta({ children, onClick, variant = "primary", className = "" }) {
  const base =
    "inline-flex items-center gap-2 rounded-full px-7 py-4 text-base font-semibold " +
    "transition-transform duration-200 ease-out active:scale-[0.97] focus-visible:outline-none " +
    "focus-visible:ring-4 focus-visible:ring-[rgb(var(--m-accent)/0.35)]";
  const styles =
    variant === "primary"
      ? { background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))", boxShadow: "0 6px 0 0 rgb(var(--m-accent-deep))" }
      : { background: "transparent", color: "rgb(var(--m-ink))", boxShadow: "inset 0 0 0 2px rgb(var(--m-ink) / 0.18)" };

  return (
    <motion.button
      type="button"
      onClick={onClick}
      className={`${base} ${className}`}
      style={styles}
      whileHover={prefersReducedMotion() ? undefined : { y: -2 }}
      whileTap={prefersReducedMotion() ? undefined : { y: 2 }}
    >
      {children}
    </motion.button>
  );
}

/**
 * The hero's floor plan. Seats fill in as the page is scrolled, so the
 * first thing the page does is show the product working rather than
 * describe it.
 */
function HeroPlan() {
  const ref = useRef(null);
  const reduced = prefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [40, -40]);

  // A small plan, hand-placed so it reads as a room rather than a grid.
  const rows = [
    ["free", "free", "held", "free", "taken"],
    ["free", "taken", "free", "free", "held"],
    ["held", "free", "free", "taken", "free"],
  ];

  return (
    <motion.div ref={ref} style={{ y }} className="relative mx-auto w-full max-w-3xl">
      <div
        className="rounded-[2rem] p-6 sm:p-10"
        style={{
          background: "rgb(var(--m-card))",
          boxShadow: "0 30px 70px -30px rgb(var(--m-ink) / 0.25), 0 2px 0 0 rgb(var(--m-ink) / 0.05)",
        }}
      >
        <div className="flex items-center gap-2 mb-6">
          <span className="w-3 h-3 rounded-full" style={{ background: "rgb(var(--m-ink) / 0.12)" }} />
          <span className="w-3 h-3 rounded-full" style={{ background: "rgb(var(--m-ink) / 0.12)" }} />
          <span className="w-3 h-3 rounded-full" style={{ background: "rgb(var(--m-ink) / 0.12)" }} />
          <span className="ml-3 text-sm font-medium" style={{ color: "rgb(var(--m-ink-faint))" }}>
            Ground Floor · live
          </span>
        </div>

        <div className="space-y-3 sm:space-y-4">
          {rows.map((row, r) => (
            <div key={r} className="flex gap-3 sm:gap-4 justify-center">
              {row.map((state, c) => (
                <Chair
                  key={c}
                  state={state}
                  size={52}
                  delay={(r * row.length + c) * 0.04}
                  wiggle={r === 1 && c === 2}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-medium">
          {[
            ["free", "Free"],
            ["held", "Reserved"],
            ["taken", "Taken"],
          ].map(([state, label]) => (
            <span key={state} className="inline-flex items-center gap-2" style={{ color: "rgb(var(--m-ink-soft))" }}>
              <span
                className="w-3 h-3 rounded-[4px]"
                style={{ background: `rgb(var(--m-${state}))` }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

/** The page's own sections, in the order they appear. */
const SECTIONS = [
  ["How it works", "#how"],
  ["Make it yours", "#yours"],
  ["What's inside", "#inside"],
  ["Pricing", "#pricing"],
];

/**
 * The header's menu below md.
 *
 * At phone width the section links and "Sign in" were hidden and nothing
 * replaced them, so the header held only "Build yours": a returning buyer
 * had to scroll to the footer to sign in, and Pricing was a long thumb
 * away. This holds both — the sections, then signing in or the account's
 * own pages (the same list as the account menu, which it stands in for
 * here). Escape, a tap outside, or choosing anything closes it.
 */
function MobileMenu({ navigate }) {
  const { account, isSignedIn, isSilla, isVerified, signOut } = useAccount();
  const { unread } = useUnreadMessages();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const button = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // Into the menu, so a keyboard can walk it from the top.
    const frame = requestAnimationFrame(() => ref.current?.querySelector("[data-menu-item]")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const go = (to) => {
    setOpen(false);
    navigate?.(to);
  };
  // Something waiting for a signed-in buyer: a reply, or an unverified email.
  const flag = isSignedIn && !isSilla && (unread > 0 || !isVerified);
  const item =
    "flex w-full items-center gap-2.5 rounded-xl px-3.5 py-3 text-left text-[15px] font-semibold " +
    "transition-colors hover:bg-[rgb(var(--m-ink)/0.06)] focus-visible:outline-none " +
    "focus-visible:bg-[rgb(var(--m-ink)/0.06)]";

  return (
    <div ref={ref} className="md:hidden">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : flag ? "Menu — something needs your attention" : "Menu"}
        className="relative grid h-10 w-10 place-items-center rounded-full transition-colors
                   hover:bg-[rgb(var(--m-ink)/0.06)]"
        style={{ color: "rgb(var(--m-ink))" }}
      >
        {open ? <X size={20} /> : <Menu size={20} />}
        {flag && !open && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full border-2"
            style={{ background: "rgb(var(--m-accent))", borderColor: "rgb(var(--m-paper))" }}
          />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.nav
            id={panelId}
            aria-label="Menu"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute inset-x-4 top-[calc(100%+6px)] z-[60] max-h-[calc(100vh-96px)] overflow-y-auto
                       rounded-2xl p-2"
            style={{
              background: "rgb(var(--m-card))",
              border: "1px solid rgb(var(--m-ink) / 0.08)",
              boxShadow: "0 24px 48px -24px rgb(var(--m-ink) / 0.35)",
            }}
          >
            {SECTIONS.map(([label, href]) => (
              <a key={href} href={href} data-menu-item onClick={() => setOpen(false)} className={item}>
                {label}
              </a>
            ))}

            <div className="my-2 h-px" style={{ background: "rgb(var(--m-ink) / 0.08)" }} />

            {isSignedIn ? (
              <>
                <div className="px-3.5 pb-1 pt-1.5">
                  <div className="truncate text-sm font-bold">{account?.name}</div>
                  <div className="truncate text-[13px]" style={{ color: "rgb(var(--m-ink-faint))" }}>
                    {account?.email}
                    {!isSilla && !isVerified ? " · email not verified" : ""}
                  </div>
                </div>
                {accountLinks({ isSilla, unread }).map(({ icon: Icon, label, to, count }) => (
                  <button key={label} type="button" data-menu-item onClick={() => go(to)} className={item}>
                    <Icon size={17} style={{ color: "rgb(var(--m-ink-faint))" }} />
                    {label}
                    {count > 0 && (
                      <span
                        className="ml-auto min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-xs font-bold tabular-nums"
                        style={{ background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))" }}
                        aria-label={`${count} unread`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  data-menu-item
                  onClick={() => {
                    setOpen(false);
                    signOut();
                    navigate?.(ROUTES.home);
                  }}
                  className={item}
                >
                  <LogOut size={17} style={{ color: "rgb(var(--m-ink-faint))" }} />
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button type="button" data-menu-item onClick={() => go(ROUTES.signIn)} className={item}>
                  <LogIn size={17} style={{ color: "rgb(var(--m-ink-faint))" }} />
                  Sign in
                </button>
                <button type="button" data-menu-item onClick={() => go(ROUTES.signUp)} className={item}>
                  <UserPlus size={17} style={{ color: "rgb(var(--m-ink-faint))" }} />
                  Create an account
                </button>
              </>
            )}
          </motion.nav>
        )}
      </AnimatePresence>
    </div>
  );
}

function Nav({ onConfigure, navigate }) {
  const { isSignedIn, booting } = useAccount();
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="sticky top-0 z-50 transition-colors duration-300"
      style={{
        background: solid ? "rgb(var(--m-paper) / 0.85)" : "transparent",
        backdropFilter: solid ? "saturate(180%) blur(12px)" : "none",
        borderBottom: solid ? "1px solid rgb(var(--m-ink) / 0.07)" : "1px solid transparent",
      }}
    >
      <div className="mx-auto max-w-6xl px-6 h-[72px] flex items-center gap-6">
        <a href="#top" className="flex items-center gap-2.5 font-extrabold text-xl tracking-tight">
          <span
            className="w-8 h-8 rounded-[10px] grid place-items-center text-sm"
            style={{ background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))" }}
          >
            S
          </span>
          SILLA
        </a>

        <nav className="ml-auto hidden md:flex items-center gap-7 text-[15px] font-medium">
          {SECTIONS.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="transition-opacity hover:opacity-60"
              style={{ color: "rgb(var(--m-ink-soft))" }}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto md:ml-0 flex items-center gap-2 sm:gap-4">
          {/* Signed in, the account menu is the way back to what you
              already have — profile, orders — so a returning customer
              isn't made to start over. Signed out, one quiet link.
              Held back until the session check finishes, or a returning
              customer sees "Sign in" flash before their name appears.
              Below md both live in the phone menu instead. */}
          {booting ? (
            <span className="hidden h-8 w-20 md:block" aria-hidden />
          ) : isSignedIn ? (
            <div className="hidden md:block">
              <AccountMenu navigate={navigate} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => navigate?.("#/sign-in")}
              className="hidden md:inline text-[15px] font-medium transition-opacity hover:opacity-60"
              style={{ color: "rgb(var(--m-ink-soft))" }}
            >
              Sign in
            </button>
          )}
          <button
            type="button"
            onClick={onConfigure}
            className="inline-flex items-center gap-1.5 rounded-full px-4 sm:px-5 py-2.5 text-[15px] font-semibold
                       transition-transform duration-200 active:scale-95"
            style={{ background: "rgb(var(--m-ink))", color: "rgb(var(--m-paper))" }}
          >
            Build yours
            <ArrowRight size={16} className="hidden sm:block" />
          </button>
          {!booting && <MobileMenu navigate={navigate} />}
        </div>
      </div>
    </header>
  );
}

export default function Landing({ onConfigure, navigate }) {
  const { isSignedIn } = useAccount();
  return (
    <div className="silla-marketing min-h-screen" id="top">
      <Nav onConfigure={onConfigure} navigate={navigate} />

      {/* ─────────────────── Hero ─────────────────── */}
      <section className="relative overflow-hidden px-6 pt-16 pb-24 sm:pt-24">
        {/* A soft bloom so the paper isn't dead flat behind the headline. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[70vh]"
          style={{
            background:
              "radial-gradient(60% 60% at 50% 0%, rgb(var(--m-accent) / 0.13) 0%, transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-6xl text-center">
          <motion.p
            {...reveal()}
            className="text-sm font-bold uppercase tracking-[0.18em] mb-6"
            style={{ color: "rgb(var(--m-accent-deep))" }}
          >
            Space booking, minus the spreadsheet
          </motion.p>

          <Display className="text-[clamp(3rem,10vw,7.5rem)]">Save you a seat.</Display>

          <motion.p
            {...reveal(0.15)}
            className="mx-auto mt-8 max-w-2xl text-[clamp(1.05rem,2.2vw,1.35rem)] leading-relaxed"
            style={{ color: "rgb(var(--m-ink-soft))" }}
          >
            <em>Silla</em> is Spanish for chair. It's also the system behind every seat, desk and room
            your people can book — a live floor map, a tap-in kiosk, and a console that runs the whole
            place. Sold to you, branded as you.
          </motion.p>

          <motion.div {...reveal(0.25)} className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Cta onClick={onConfigure}>
              Build yours in 5 minutes
              <ArrowRight size={18} />
            </Cta>
            <Cta variant="ghost" onClick={() => document.querySelector("#how")?.scrollIntoView({ behavior: "smooth" })}>
              See how it works
            </Cta>
          </motion.div>

          <div className="mt-20">
            <HeroPlan />
          </div>
        </div>
      </section>

      {/* ─────────────────── The pitch in one line ─────────────────── */}
      <section className="px-6 py-24 sm:py-32" style={{ background: "rgb(var(--m-paper-deep))" }}>
        <div className="mx-auto max-w-5xl text-center">
          <ChairRow />
          <motion.h2
            {...reveal()}
            className="display mt-10 text-[clamp(2rem,5.5vw,4rem)]"
          >
            Everybody's looking for a seat.
            <br />
            <span style={{ color: "rgb(var(--m-accent-deep))" }}>Nobody should have to hunt for one.</span>
          </motion.h2>
          <motion.p
            {...reveal(0.15)}
            className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed"
            style={{ color: "rgb(var(--m-ink-soft))" }}
          >
            Libraries, offices, labs, studios — the problem is always the same. People wander looking for
            somewhere to sit, staff have no idea what's actually in use, and the only record is a clipboard
            by the door. SILLA turns the room into a map that's true right now.
          </motion.p>
        </div>
      </section>

      <HowItWorks />
      <WhiteLabel />
      <Features />
      <Pricing onConfigure={onConfigure} />

      {/* ─────────────────── Closing ─────────────────── */}
      <section className="px-6 py-28 sm:py-36 text-center">
        <div className="mx-auto max-w-3xl">
          <ChairRow pattern={["taken", "held", "free", "free", "free", "free"]} />
          <motion.h2 {...reveal()} className="display mt-10 text-[clamp(2.25rem,6vw,4.5rem)]">
            Pull up a chair.
          </motion.h2>
          <motion.p
            {...reveal(0.1)}
            className="mx-auto mt-6 max-w-xl text-lg"
            style={{ color: "rgb(var(--m-ink-soft))" }}
          >
            Name it, colour it, lay out your floors and place your order — we build the whole system
            from it. No call required.
          </motion.p>
          <motion.div {...reveal(0.2)} className="mt-10">
            <Cta onClick={onConfigure}>
              Start building
              <ArrowRight size={18} />
            </Cta>
          </motion.div>
        </div>
      </section>

      <footer className="px-6 pt-14 pb-10" style={{ borderTop: "1px solid rgb(var(--m-ink) / 0.08)" }}>
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-start gap-x-12 gap-y-8">
            <div className="mr-auto max-w-xs">
              <div className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight">
                <span
                  className="grid h-7 w-7 place-items-center rounded-[9px] text-xs"
                  style={{ background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))" }}
                >
                  S
                </span>
                SILLA
              </div>
              <p className="mt-3 text-sm leading-relaxed" style={{ color: "rgb(var(--m-ink-faint))" }}>
                Space Intelligence &amp; Live Layout Administration. Reservation and occupancy for the spaces people share.
              </p>
            </div>

            {[
              ["Product", [["How it works", "#how"], ["Make it yours", "#yours"], ["What's inside", "#inside"], ["Pricing", "#pricing"]]],
              ["Account", isSignedIn
                ? [["Your profile", "#/account"], ["Your orders", "#/orders"]]
                : [["Sign in", "#/sign-in"], ["Create an account", "#/sign-up"]]],
              ["Legal", [["Terms & Conditions", "#/terms"]]],
            ].map(([heading, links]) => (
              <nav key={heading} aria-label={heading}>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "rgb(var(--m-ink-faint))" }}>
                  {heading}
                </p>
                <ul className="mt-3 space-y-2">
                  {links.map(([label, href]) => (
                    <li key={label}>
                      <a
                        href={href}
                        onClick={(e) => {
                          // App routes go through the router; in-page
                          // anchors keep their smooth scroll.
                          if (href.startsWith("#/")) {
                            e.preventDefault();
                            navigate?.(href);
                          }
                        }}
                        className="text-sm font-medium transition-opacity hover:opacity-60"
                        style={{ color: "rgb(var(--m-ink-soft))" }}
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>

          <div
            className="mt-12 flex flex-wrap items-center gap-4 pt-6 text-sm"
            style={{ borderTop: "1px solid rgb(var(--m-ink) / 0.08)", color: "rgb(var(--m-ink-faint))" }}
          >
            <span>&copy; {new Date().getFullYear()} SILLA</span>
            <a
              href="#/terms"
              onClick={(e) => {
                e.preventDefault();
                navigate?.("#/terms");
              }}
              className="underline underline-offset-4 transition-opacity hover:opacity-60"
            >
              Terms &amp; Conditions
            </a>
            <button
              type="button"
              onClick={onConfigure}
              className="ml-auto inline-flex items-center gap-1.5 font-semibold transition-opacity hover:opacity-60"
              style={{ color: "rgb(var(--m-ink))" }}
            >
              Open the configurator
              <ArrowUpRight size={15} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
