import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { EASE, prefersReducedMotion, reveal } from "../motion.js";

/**
 * The white-label proof.
 *
 * This is the whole product argument, so it is shown rather than
 * claimed: pick a vertical and the mock repaints — colours, vocabulary,
 * zone names, ID format, the lot. Nothing here is a screenshot. It is
 * the same markup rendered three ways from three sets of values, which
 * is exactly the mechanism the real system uses (`npm run profile
 * library` / `office` switches a running deployment in place).
 *
 * The vocabulary swap matters more than the colour swap and gets equal
 * billing. Recolouring a UI is table stakes; a product that says "desk"
 * to an office and "seat" to a library — with no code path per vertical
 * — is the part that is hard.
 */

const BRANDS = [
  {
    key: "library",
    tab: "Library",
    name: "Northgate Learning Commons",
    accent: "212 175 55",
    ink: "24 29 64",
    paper: "248 246 240",
    resource: "seat",
    member: "student",
    idFormat: "2026-000148",
    zone: "Quiet Study",
    floor: "Ground Floor",
  },
  {
    key: "office",
    tab: "Workplace",
    name: "Harborview Work Commons",
    accent: "45 212 191",
    ink: "11 16 18",
    paper: "240 250 249",
    resource: "desk",
    member: "employee",
    idFormat: "EMP-04471",
    zone: "Engineering",
    floor: "Level 3",
  },
  {
    key: "studio",
    tab: "Studio",
    name: "Kiln & Co. Makerspace",
    accent: "232 113 82",
    ink: "38 24 20",
    paper: "252 244 238",
    resource: "bench",
    member: "maker",
    idFormat: "MK-2026-83",
    zone: "Ceramics",
    floor: "The Yard",
  },
];

/** "a desk" but "an employee" — the vocabulary is buyer-supplied, so the
 *  article has to be derived rather than written into the sentence. */
const article = (word) => (/^[aeiou]/i.test(String(word).trim()) ? "an" : "a");

const PLAN = ["free", "free", "held", "free", "taken", "free", "free", "taken", "free", "free", "held", "free"];

const STATE_COLOUR = {
  free: "82 183 136",
  held: "244 162 97",
  taken: "141 153 174",
};

/** The mock deployment. One component, three sets of values. */
function Mock({ brand }) {
  const reduced = prefersReducedMotion();
  const t = { duration: reduced ? 0.2 : 0.55, ease: EASE };

  return (
    <motion.div
      layout
      className="rounded-[1.75rem] overflow-hidden"
      animate={{ background: `rgb(${brand.paper})` }}
      transition={t}
      style={{ boxShadow: "0 30px 70px -34px rgb(var(--m-ink) / 0.35)", border: "1px solid rgb(var(--m-ink) / 0.07)" }}
    >
      {/* Their header, their name, their colour. */}
      <motion.div
        className="px-5 py-4 flex items-center gap-3"
        animate={{ background: `rgb(${brand.ink})` }}
        transition={t}
      >
        <motion.span
          className="w-7 h-7 rounded-lg grid place-items-center text-sm font-black"
          animate={{ background: `rgb(${brand.accent})`, color: `rgb(${brand.ink})` }}
          transition={t}
        >
          {brand.name.charAt(0)}
        </motion.span>
        <AnimatePresence mode="wait">
          <motion.span
            key={brand.key}
            initial={{ opacity: 0, y: reduced ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : -6 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="font-bold text-[15px] text-white truncate"
          >
            {brand.name}
          </motion.span>
        </AnimatePresence>
      </motion.div>

      <div className="p-5">
        <AnimatePresence mode="wait">
          <motion.div
            key={brand.key}
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : -8 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-lg font-extrabold" style={{ color: `rgb(${brand.ink})` }}>
                {brand.floor}
              </span>
              <span className="text-sm font-medium" style={{ color: `rgb(${brand.ink} / 0.55)` }}>
                8 of 12 {brand.resource}s open
              </span>
            </div>
            <div className="mt-1 text-sm font-medium" style={{ color: `rgb(${brand.ink} / 0.45)` }}>
              {brand.zone} · signed in as {article(brand.member)} {brand.member} · {brand.idFormat}
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="mt-5 grid grid-cols-6 gap-2.5">
          {PLAN.map((state, i) => (
            <motion.div
              key={i}
              className="aspect-square rounded-[10px]"
              animate={{ background: `rgb(${STATE_COLOUR[state]})` }}
              transition={{ ...t, delay: reduced ? 0 : i * 0.012 }}
            />
          ))}
        </div>

        <motion.button
          type="button"
          tabIndex={-1}
          className="mt-5 w-full rounded-full py-3 text-sm font-bold"
          animate={{ background: `rgb(${brand.accent})`, color: `rgb(${brand.ink})` }}
          transition={t}
        >
          Reserve this {brand.resource}
        </motion.button>
      </div>
    </motion.div>
  );
}

export default function WhiteLabel() {
  const [active, setActive] = useState(0);
  const brand = BRANDS[active];

  return (
    <section id="yours" className="px-6 py-24 sm:py-32" style={{ background: "rgb(var(--m-paper-deep))" }}>
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-14 lg:grid-cols-2 lg:gap-20 items-center">
          <div>
            <motion.p
              {...reveal()}
              className="text-sm font-bold uppercase tracking-[0.18em] mb-5"
              style={{ color: "rgb(var(--m-accent-deep))" }}
            >
              White-label, properly
            </motion.p>

            <motion.h2 {...reveal(0.05)} className="display text-[clamp(2rem,5vw,3.5rem)]">
              You don't buy SILLA.
              <br />
              You buy <span style={{ color: "rgb(var(--m-accent-deep))" }}>your own</span>.
            </motion.h2>

            <motion.p
              {...reveal(0.12)}
              className="mt-7 text-lg leading-relaxed"
              style={{ color: "rgb(var(--m-ink-soft))" }}
            >
              Your name on the door, your colours throughout, and your vocabulary everywhere — because a
              library has <em>seats</em> and an office has <em>desks</em>, and neither wants to read the
              other's word for it. Even the member ID format is yours.
            </motion.p>

            <motion.p
              {...reveal(0.18)}
              className="mt-5 text-lg leading-relaxed"
              style={{ color: "rgb(var(--m-ink-soft))" }}
            >
              Nobody who uses your system will ever see the word SILLA. Try it — the panel is live, not a
              screenshot:
            </motion.p>

            <motion.div {...reveal(0.24)} className="mt-8 inline-flex rounded-full p-1.5"
              style={{ background: "rgb(var(--m-ink) / 0.06)" }}>
              {BRANDS.map((b, i) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setActive(i)}
                  className="relative rounded-full px-5 py-2.5 text-[15px] font-semibold transition-colors"
                  style={{ color: i === active ? "rgb(var(--m-paper))" : "rgb(var(--m-ink-soft))" }}
                >
                  {i === active && (
                    <motion.span
                      layoutId="brand-pill"
                      className="absolute inset-0 rounded-full"
                      style={{ background: "rgb(var(--m-ink))" }}
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative">{b.tab}</span>
                </button>
              ))}
            </motion.div>
          </div>

          <motion.div {...reveal(0.1)}>
            <Mock brand={brand} />
            <p className="mt-5 text-center text-sm" style={{ color: "rgb(var(--m-ink-faint))" }}>
              Same code, same database, same everything. Only the configuration differs.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
