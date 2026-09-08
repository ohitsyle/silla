import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import Chair, { ChairRow } from "./Chair.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
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

function Nav({ onConfigure, navigate }) {
  const { isSignedIn } = useAccount();
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
          {[
            ["How it works", "#how"],
            ["Make it yours", "#yours"],
            ["What's inside", "#inside"],
            ["Pricing", "#pricing"],
          ].map(([label, href]) => (
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

        <div className="ml-auto md:ml-0 flex items-center gap-4">
          {/* Signed in, this is the way back to what you already have —
              a storefront that only ever points forward makes a
              returning customer start over. */}
          <button
            type="button"
            onClick={() => navigate?.(isSignedIn ? "#/orders" : "#/sign-in")}
            className="hidden sm:inline text-[15px] font-medium transition-opacity hover:opacity-60"
            style={{ color: "rgb(var(--m-ink-soft))" }}
          >
            {isSignedIn ? "Your orders" : "Sign in"}
          </button>
          <button
            type="button"
            onClick={onConfigure}
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-[15px] font-semibold
                       transition-transform duration-200 active:scale-95"
            style={{ background: "rgb(var(--m-ink))", color: "rgb(var(--m-paper))" }}
          >
            Build yours
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

export default function Landing({ onConfigure, navigate }) {
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
            Name it, colour it, lay out your floors, and walk away with a file that builds the whole
            system. No call required.
          </motion.p>
          <motion.div {...reveal(0.2)} className="mt-10">
            <Cta onClick={onConfigure}>
              Start building
              <ArrowRight size={18} />
            </Cta>
          </motion.div>
        </div>
      </section>

      <footer className="px-6 py-12" style={{ borderTop: "1px solid rgb(var(--m-ink) / 0.08)" }}>
        <div className="mx-auto max-w-6xl flex flex-wrap items-center gap-4">
          <span className="font-extrabold text-lg tracking-tight">SILLA</span>
          <span className="text-sm" style={{ color: "rgb(var(--m-ink-faint))" }}>
            Space Intelligence &amp; Live Layout Administration
          </span>
          <button
            type="button"
            onClick={onConfigure}
            className="ml-auto inline-flex items-center gap-1.5 text-sm font-semibold hover:opacity-60 transition-opacity"
          >
            Open the configurator
            <ArrowUpRight size={15} />
          </button>
        </div>
      </footer>
    </div>
  );
}
