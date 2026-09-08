import { motion } from "framer-motion";
import { CreditCard, Map, Gauge } from "lucide-react";

import Chair from "../Chair.jsx";
import { EASE, prefersReducedMotion, reveal, revealChild, revealGroup } from "../motion.js";

/**
 * Three steps, each illustrated by the thing it describes rather than by
 * a stock icon in a circle. The tap scene actually flips a seat from
 * free to taken; the booking scene actually highlights a choice. Small
 * loops, long pauses — a page of things moving constantly is exhausting
 * to read past.
 */

/** Scene 1 — a card taps and a seat turns. */
function TapScene() {
  const reduced = prefersReducedMotion();
  return (
    <div className="relative h-40 grid place-items-center">
      <div className="flex items-center gap-6">
        <motion.div
          className="rounded-xl grid place-items-center"
          style={{
            width: 68,
            height: 44,
            background: "rgb(var(--m-ink))",
            color: "rgb(var(--m-paper))",
          }}
          animate={reduced ? undefined : { x: [0, 14, 0], rotate: [0, -4, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 1.6, ease: "easeInOut" }}
        >
          <CreditCard size={20} />
        </motion.div>

        {/* The seat the tap lands on. */}
        <motion.div
          animate={reduced ? undefined : { scale: [1, 1.12, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 1.6, times: [0, 0.45, 0.6], ease: "easeInOut" }}
        >
          <Chair state="taken" size={56} />
        </motion.div>
      </div>
    </div>
  );
}

/** Scene 2 — a small plan with one seat being chosen. */
function BookScene() {
  const reduced = prefersReducedMotion();
  const plan = ["free", "held", "free", "free", "taken", "free", "free", "free"];
  return (
    <div className="relative h-40 grid place-items-center">
      <div className="grid grid-cols-4 gap-2.5">
        {plan.map((state, i) => (
          <div key={i} className="relative">
            <Chair state={state} size={38} delay={i * 0.03} />
            {i === 6 && !reduced && (
              <motion.span
                className="absolute -inset-1.5 rounded-[14px] pointer-events-none"
                style={{ border: "2.5px solid rgb(var(--m-accent))" }}
                animate={{ opacity: [0, 1, 1, 0], scale: [0.9, 1, 1, 0.95] }}
                transition={{ duration: 3.2, repeat: Infinity, repeatDelay: 1.2, times: [0, 0.2, 0.75, 1] }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scene 3 — a capacity bar filling, the way the console shows it. */
function ConsoleScene() {
  const reduced = prefersReducedMotion();
  const bars = [
    { label: "Open", value: 0.59, tone: "free" },
    { label: "Taken", value: 0.24, tone: "taken" },
    { label: "Held", value: 0.1, tone: "held" },
  ];
  return (
    <div className="h-40 grid place-items-center px-2">
      <div className="w-full max-w-[210px] space-y-3.5">
        {bars.map((bar, i) => (
          <div key={bar.label}>
            <div className="flex justify-between text-xs font-semibold mb-1.5" style={{ color: "rgb(var(--m-ink-soft))" }}>
              <span>{bar.label}</span>
              <span className="tabular-nums">{Math.round(bar.value * 49)}</span>
            </div>
            <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "rgb(var(--m-ink) / 0.08)" }}>
              <motion.div
                className="h-full rounded-full origin-left"
                style={{ background: `rgb(var(--m-${bar.tone}))` }}
                initial={reduced ? { scaleX: bar.value } : { scaleX: 0 }}
                whileInView={{ scaleX: bar.value }}
                viewport={{ once: true, amount: 0.6 }}
                transition={{ duration: 1, delay: 0.15 + i * 0.12, ease: EASE }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    icon: CreditCard,
    title: "Tap in.",
    body:
      "One tap of a card checks you in, checks you out, or signs you up on the spot. The reader is a plain USB one that types like a keyboard — no driver, no integration project.",
    Scene: TapScene,
  },
  {
    n: "02",
    icon: Map,
    title: "Or book ahead.",
    body:
      "A live map of the actual floor, not a list of room names. Pick something green, confirm with your PIN, and it's yours. Change your mind and it's free again in a second.",
    Scene: BookScene,
  },
  {
    n: "03",
    icon: Gauge,
    title: "Staff see it all.",
    body:
      "Who's in, what's free, what's been sat in too long, what broke. Mark a desk out of service and it greys out on everyone's map the moment you do it.",
    Scene: ConsoleScene,
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <motion.h2 {...reveal()} className="display text-center text-[clamp(2rem,5.5vw,3.75rem)]">
          Three things, done well.
        </motion.h2>
        <motion.p
          {...reveal(0.1)}
          className="mx-auto mt-5 max-w-xl text-center text-lg"
          style={{ color: "rgb(var(--m-ink-soft))" }}
        >
          There is no fourth thing. That's rather the point.
        </motion.p>

        <motion.div {...revealGroup(0.12)} className="mt-16 grid gap-6 md:grid-cols-3">
          {STEPS.map(({ n, icon: Icon, title, body, Scene }) => (
            <motion.article
              key={n}
              {...revealChild()}
              className="rounded-[1.75rem] p-7 flex flex-col"
              style={{
                background: "rgb(var(--m-card))",
                boxShadow: "0 18px 40px -24px rgb(var(--m-ink) / 0.28)",
                border: "1px solid rgb(var(--m-ink) / 0.06)",
              }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-9 h-9 rounded-xl grid place-items-center"
                  style={{ background: "rgb(var(--m-accent) / 0.14)", color: "rgb(var(--m-accent-deep))" }}
                >
                  <Icon size={18} />
                </span>
                <span
                  className="text-xs font-bold tracking-[0.2em]"
                  style={{ color: "rgb(var(--m-ink-faint))" }}
                >
                  {n}
                </span>
              </div>

              <Scene />

              <h3 className="text-2xl font-extrabold tracking-tight">{title}</h3>
              <p className="mt-3 leading-relaxed" style={{ color: "rgb(var(--m-ink-soft))" }}>
                {body}
              </p>
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
