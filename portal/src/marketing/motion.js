/**
 * Scroll and reveal vocabulary for the storefront.
 *
 * Separate from the wizard's motion because the two surfaces move for
 * different reasons. The wizard is a tool: entrances are ~200ms and
 * exist only to explain what changed. The landing page is a pitch, so
 * it is allowed to be slower and more expressive — but never bouncy,
 * and never so slow that scrolling feels like it is fighting you.
 *
 * Everything here degrades to a plain fade under prefers-reduced-motion.
 * A marketing page is exactly where motion sickness gets designed in by
 * accident, so the reduced path is the one written first.
 */

export const EASE = [0.22, 1, 0.36, 1];
export const EASE_SOFT = [0.4, 0, 0.2, 1];

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The standard "arrive as you scroll to it" treatment.
 *
 * `once: true` matters: a section that re-animates every time it
 * re-enters the viewport turns a scroll back up the page into a
 * flickering mess. amount 0.3 fires when a third of the block is
 * visible, so it has started before the reader's eye lands on it.
 */
export const reveal = (delay = 0) => {
  const reduced = prefersReducedMotion();
  return {
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 28 },
    whileInView: reduced ? { opacity: 1 } : { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.3 },
    transition: { duration: reduced ? 0.3 : 0.7, delay, ease: EASE },
  };
};

/** A group whose children arrive one after another. */
export const revealGroup = (stagger = 0.08) => ({
  initial: "hidden",
  whileInView: "shown",
  viewport: { once: true, amount: 0.25 },
  variants: {
    hidden: {},
    shown: { transition: { staggerChildren: prefersReducedMotion() ? 0 : stagger } },
  },
});

export const revealChild = () => {
  const reduced = prefersReducedMotion();
  return {
    variants: {
      hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 24 },
      shown: { opacity: 1, y: 0 },
    },
    transition: { duration: reduced ? 0.3 : 0.6, ease: EASE },
  };
};

/**
 * Display headings that arrive a word at a time.
 *
 * Cheap trick, but it is the difference between a headline that appears
 * and one that is *delivered*. Split on spaces rather than characters:
 * per-character reveals on a long line read as a slot machine, and they
 * break how a screen reader announces the text.
 */
export const wordsIn = (stagger = 0.055) => ({
  initial: "hidden",
  whileInView: "shown",
  viewport: { once: true, amount: 0.5 },
  variants: {
    hidden: {},
    shown: { transition: { staggerChildren: prefersReducedMotion() ? 0 : stagger } },
  },
});

export const wordChild = () => {
  const reduced = prefersReducedMotion();
  return {
    variants: {
      hidden: reduced ? { opacity: 0 } : { opacity: 0, y: "0.4em", rotate: -2 },
      shown: { opacity: 1, y: 0, rotate: 0 },
    },
    transition: { duration: reduced ? 0.3 : 0.65, ease: EASE },
  };
};
