/**
 * Shared motion vocabulary (spec §20 — "motion-duration tokens" was one
 * of the design-system items left open).
 *
 * Every screen animates from this file rather than inventing its own
 * durations, so the product moves at one speed. Two rules shape it:
 *
 *   1. This is an operational tool people use all day. Entrances are
 *      short (~200ms) and never bounce. Motion is there to explain what
 *      changed, not to be noticed.
 *   2. Nothing important is *only* communicated by motion, so honouring
 *      prefers-reduced-motion costs nothing — the reduced variants below
 *      simply skip the movement and keep the fade.
 */

/** Matches the --ease-* tokens in index.css. */
export const EASE_OUT = [0.22, 1, 0.36, 1];
export const EASE_IN_OUT = [0.65, 0, 0.35, 1];

export const DURATION = {
  instant: 0.09,
  fast: 0.15,
  base: 0.24,
  slow: 0.38,
};

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Strips translation from a variant set when the OS asks for less motion. */
function respectMotion(variants) {
  if (!prefersReducedMotion()) return variants;
  const strip = (v) => {
    if (!v || typeof v !== "object") return v;
    const { y, x, scale, ...rest } = v;
    return rest;
  };
  return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, strip(v)]));
}

/** A page or major section arriving. */
export const pageEnter = () =>
  respectMotion({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  });

/** A panel that appears in response to a click (details, forms). */
export const panelEnter = () =>
  respectMotion({
    initial: { opacity: 0, y: 10, scale: 0.99 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -6, scale: 0.99 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  });

/** A modal-ish step swap (the kiosk's flow). */
export const stepSwap = () =>
  respectMotion({
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -12 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  });

/**
 * A list whose children arrive in sequence. Keep the stagger tight —
 * a long cascade reads as slowness, not delight.
 */
export const listContainer = (stagger = 0.035) => ({
  initial: "hidden",
  animate: "shown",
  variants: {
    hidden: {},
    shown: { transition: { staggerChildren: prefersReducedMotion() ? 0 : stagger } },
  },
});

export const listItem = () => ({
  variants: respectMotion({
    hidden: { opacity: 0, y: 8 },
    shown: { opacity: 1, y: 0 },
  }),
  transition: { duration: DURATION.base, ease: EASE_OUT },
});

/** Hover/press feedback for cards that behave as buttons. */
export const pressable = () =>
  prefersReducedMotion()
    ? {}
    : { whileHover: { y: -2 }, whileTap: { y: 0, scale: 0.995 }, transition: { duration: DURATION.fast, ease: EASE_OUT } };

/** A value that changed — used for live metrics so a jump is noticed. */
export const valueChange = () =>
  respectMotion({
    initial: { opacity: 0, y: -4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.fast, ease: EASE_OUT },
  });
