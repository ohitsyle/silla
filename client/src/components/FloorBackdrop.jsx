import { useMemo } from "react";
import { motion } from "framer-motion";
import { prefersReducedMotion } from "../lib/motion.js";

/**
 * The decorative backdrop behind the gate screens (sign in, terms, PIN).
 *
 * Those screens were a card floating in an empty field, which is the
 * look of a page that nobody composed. Rather than fill the space with
 * a generic gradient wash, this fills it with what the product actually
 * is: a floor plan. The same 40px cell as SpaceMap, the same grid line
 * token, and a scatter of units in the same status colours — so the
 * first screen a person sees is already telling them what SILLA does.
 *
 * Everything resolves through design tokens, so a buyer's palette
 * repaints this exactly like it repaints the map. Nothing here is
 * hardcoded and nothing here is information: it is aria-hidden, and the
 * drift is dropped entirely when the OS asks for reduced motion.
 */

const CELL = 40; // matches SpaceMap's CELL, so the motif reads as the same space

/**
 * A deterministic floor plan. Not Math.random(): the layout must be
 * stable across re-renders, or the backdrop would reshuffle on every
 * keystroke in the form in front of it.
 *
 * Zones are laid across the whole plate rather than clustered, because
 * a viewport is much taller than the first few rows — with everything
 * up top the lower half read as bare graph paper.
 */
const ZONES = [
  { x: 1, y: 1, w: 8, h: 6 },
  { x: 12, y: 2, w: 7, h: 5 },
  { x: 23, y: 1, w: 9, h: 6 },
  { x: 35, y: 3, w: 6, h: 5 },
  { x: 2, y: 11, w: 7, h: 6 },
  { x: 13, y: 10, w: 9, h: 5 },
  { x: 26, y: 11, w: 7, h: 6 },
  { x: 36, y: 12, w: 5, h: 5 },
  { x: 4, y: 21, w: 8, h: 5 },
  { x: 16, y: 20, w: 7, h: 6 },
  { x: 28, y: 21, w: 8, h: 5 },
];

const STATES = ["available", "available", "occupied", "available", "reserved", "available", "unavailable"];

/**
 * Rows of units inside each zone, the way a real plan fills: a couple of
 * banks per room with a gap between them. The state cycles through
 * STATES so the mix looks plausible without being random.
 */
const UNITS = (() => {
  const out = [];
  let n = 0;
  for (const zone of ZONES) {
    for (let row = 1; row < zone.h - 1; row += 2) {
      for (let col = 1; col < zone.w - 1; col += 1) {
        n += 1;
        if (n % 5 < 2) continue; // gaps, so it reads as a plan rather than noise
        const wide = n % 11 === 0 && col + 2 < zone.w - 1;
        out.push({
          x: zone.x + col,
          y: zone.y + row,
          w: wide ? 2 : 1,
          h: 1,
          state: STATES[n % STATES.length],
        });
        if (wide) n += 1;
      }
    }
  }
  return out;
})();

export default function FloorBackdrop() {
  const reduced = prefersReducedMotion();

  // The drift is a slow parallax on the whole plate. Long enough that it
  // is felt rather than watched — a visible loop on a login screen is
  // the kind of thing that makes software feel cheap.
  const drift = useMemo(
    () =>
      reduced
        ? {}
        : {
            animate: { x: [0, -CELL, 0], y: [0, CELL * 0.5, 0] },
            transition: { duration: 90, repeat: Infinity, ease: "linear" },
          },
    [reduced]
  );

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Accent bloom, anchored off-centre so the composition has a light source. */}
      <div
        className="absolute -top-1/4 left-1/2 -translate-x-1/2 w-[140vw] h-[90vh] opacity-[0.11]"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 40%, var(--color-accent) 0%, transparent 70%)",
        }}
      />

      <motion.svg
        {...drift}
        className="absolute inset-0 w-[130%] h-[130%] -left-[15%] -top-[15%]"
        aria-hidden
      >
        <defs>
          <pattern id="silla-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
            <path
              d={`M ${CELL} 0 L 0 0 0 ${CELL}`}
              fill="none"
              stroke="var(--color-map-grid)"
              strokeWidth="1"
            />
          </pattern>
          {/*
            A RING, not a spotlight. The form sits dead centre, so a
            plate that is brightest in the middle puts its busiest area
            directly behind the thing people have to read. This keeps the
            centre quiet, lets the plan show around it, and fades out at
            the edges so it never ends on a hard line.
          */}
          <radialGradient id="silla-fade" cx="50%" cy="48%" r="70%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.12" />
            <stop offset="28%" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="55%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="silla-mask">
            <rect width="100%" height="100%" fill="url(#silla-fade)" />
          </mask>
        </defs>

        <g mask="url(#silla-mask)">
          <rect width="100%" height="100%" fill="url(#silla-grid)" />

          {ZONES.map((zone, i) => (
            <rect
              key={`z${i}`}
              x={zone.x * CELL}
              y={zone.y * CELL}
              width={zone.w * CELL}
              height={zone.h * CELL}
              rx="6"
              fill="var(--color-map-zone-fill)"
              stroke="var(--color-map-zone-stroke)"
              strokeWidth="1"
              strokeDasharray="4 5"
              opacity="0.5"
            />
          ))}

          {UNITS.map((unit, i) => (
            <motion.rect
              key={`u${i}`}
              x={unit.x * CELL + 5}
              y={unit.y * CELL + 5}
              width={unit.w * CELL - 10}
              height={unit.h * CELL - 10}
              rx="5"
              fill={`var(--color-state-${unit.state})`}
              initial={reduced ? false : { opacity: 0.05 }}
              animate={reduced ? { opacity: 0.14 } : { opacity: [0.07, 0.19, 0.07] }}
              transition={
                reduced
                  ? undefined
                  : {
                      // Staggered by index so the plate breathes unevenly,
                      // the way a real floor fills and empties.
                      duration: 7 + (i % 5) * 1.6,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: (i % 7) * 0.6,
                    }
              }
            />
          ))}
        </g>
      </motion.svg>
    </div>
  );
}
