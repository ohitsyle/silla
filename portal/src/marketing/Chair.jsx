import { motion } from "framer-motion";
import { EASE, prefersReducedMotion } from "./motion.js";

/**
 * The seat tile — the storefront's recurring character.
 *
 * "Silla" is Spanish for chair, and this is the product's smallest unit:
 * one bookable thing, in one of three states. It is drawn here exactly
 * as the real map draws it (rounded square, status colour, a glyph so
 * colour is never the only signal) so the charm on the landing page is
 * the actual product, not decoration invented for a pitch.
 *
 * States match the product's: free / held / taken.
 */

const TONE = {
  free: { bg: "var(--m-free)", label: "free" },
  held: { bg: "var(--m-held)", label: "held" },
  taken: { bg: "var(--m-taken)", label: "taken" },
};

/** A check, a clock and a person — the same three glyphs the map uses. */
function Glyph({ state, size }) {
  const stroke = "rgb(var(--m-card))";
  const common = { fill: "none", stroke, strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" };
  const s = size * 0.44;
  const o = (size - s) / 2;

  if (state === "free") {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" style={{ position: "absolute", left: o, top: o }}>
        <path d="M4 12.5 L9.5 18 L20 6.5" {...common} />
      </svg>
    );
  }
  if (state === "held") {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" style={{ position: "absolute", left: o, top: o }}>
        <circle cx="12" cy="12" r="8.5" {...common} />
        <path d="M12 7.5 V12 L15 14" {...common} />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" style={{ position: "absolute", left: o, top: o }}>
      <circle cx="12" cy="8" r="3.6" {...common} />
      <path d="M5 19.5 C5 15.9 8.1 14 12 14 C15.9 14 19 15.9 19 19.5" {...common} />
    </svg>
  );
}

export default function Chair({
  state = "free",
  size = 44,
  delay = 0,
  wiggle = false,
  className = "",
  style = {},
}) {
  const reduced = prefersReducedMotion();
  const tone = TONE[state] || TONE.free;

  return (
    <motion.div
      className={className}
      aria-hidden
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 10 }}
      whileInView={{ opacity: 1, scale: 1, y: 0 }}
      viewport={{ once: true, amount: 0.6 }}
      transition={{ duration: reduced ? 0.3 : 0.5, delay, ease: EASE }}
      // The wiggle is the one piece of pure charm here. It is opt-in,
      // never on more than a handful at a time, and off entirely when
      // the OS asks for less motion.
      animate={
        wiggle && !reduced
          ? { rotate: [0, -3.5, 3, -2, 0] }
          : undefined
      }
      {...(wiggle && !reduced
        ? { transition: { rotate: { duration: 3.6, repeat: Infinity, repeatDelay: 2.4, ease: "easeInOut", delay } } }
        : {})}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `rgb(${tone.bg})`,
        position: "relative",
        boxShadow: `0 ${size * 0.09}px 0 0 rgb(${tone.bg} / 0.35)`,
        ...style,
      }}
    >
      <Glyph state={state} size={size} />
    </motion.div>
  );
}

/**
 * A row of tiles, for use as a decorative rule between sections.
 * Deterministic pattern rather than random: it must not reshuffle when
 * React re-renders the page around it.
 */
export function ChairRow({ pattern = ["free", "free", "held", "free", "taken", "free"], size = 26, gap = 8 }) {
  return (
    <div className="flex items-center justify-center" style={{ gap }} aria-hidden>
      {pattern.map((state, i) => (
        <Chair key={i} state={state} size={size} delay={i * 0.05} />
      ))}
    </div>
  );
}
