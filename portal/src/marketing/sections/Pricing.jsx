import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";

import { EASE, prefersReducedMotion, reveal, revealChild, revealGroup } from "../motion.js";
import { CURRENCY, PLANS } from "../../lib/plans.js";

/**
 * Plans.
 *
 * ⚠️  THE NUMBERS AND CURRENCY BELOW ARE PLACEHOLDERS.
 *
 * There is no billing system yet (see CLAUDE.md's portal roadmap), so
 * nothing here is charged and nothing is wired to a payment provider.
 * They exist so the page is complete and so the shape of the offer can
 * be argued about with something concrete on the screen. Replace
 * `PLANS` and `CURRENCY` before this is shown to anyone who might try
 * to buy — a wrong price on a live page is a promise you have to keep.
 *
 * The axis is SIZE, not features: everything is in every plan, which is
 * what the section above promises. Charging twice for the same product
 * by withholding the map editor would make that a lie.
 */

function Price({ plan, annual }) {
  const amount = annual ? plan.annual : plan.monthly;

  if (amount === null) {
    return (
      <div className="mt-6">
        <span className="display text-[2.75rem]">Let's talk</span>
        <p className="mt-1.5 text-sm" style={{ color: "rgb(var(--m-ink-faint))" }}>
          Priced on how big it actually is.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold" style={{ color: "rgb(var(--m-ink-soft))" }}>
          {CURRENCY}
        </span>
        {/* Keyed on the value so the figure re-animates when the toggle flips. */}
        <motion.span
          key={amount}
          className="display text-[3.25rem] tabular-nums"
          initial={prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          {amount}
        </motion.span>
        <span className="text-base font-semibold" style={{ color: "rgb(var(--m-ink-faint))" }}>
          /month
        </span>
      </div>
      <p className="mt-1.5 text-sm" style={{ color: "rgb(var(--m-ink-faint))" }}>
        {annual ? "Billed yearly." : "Billed monthly, cancel whenever."}
      </p>
    </div>
  );
}

export default function Pricing({ onConfigure }) {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="pricing" className="px-6 py-24 sm:py-32" style={{ background: "rgb(var(--m-paper-deep))" }}>
      <div className="mx-auto max-w-6xl">
        <motion.h2 {...reveal()} className="display text-center text-[clamp(2rem,5.5vw,3.75rem)]">
          Take your pick.
        </motion.h2>
        <motion.p
          {...reveal(0.08)}
          className="mx-auto mt-5 max-w-xl text-center text-lg"
          style={{ color: "rgb(var(--m-ink-soft))" }}
        >
          Priced by how much room you've got, not by which features we're willing to give you.
        </motion.p>

        {/* Billing toggle */}
        <motion.div {...reveal(0.14)} className="mt-10 flex justify-center">
          <div className="inline-flex rounded-full p-1.5" style={{ background: "rgb(var(--m-ink) / 0.06)" }}>
            {[
              [false, "Monthly"],
              [true, "Yearly"],
            ].map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setAnnual(value)}
                className="relative rounded-full px-6 py-2.5 text-[15px] font-semibold transition-colors"
                style={{ color: annual === value ? "rgb(var(--m-paper))" : "rgb(var(--m-ink-soft))" }}
              >
                {annual === value && (
                  <motion.span
                    layoutId="billing-pill"
                    className="absolute inset-0 rounded-full"
                    style={{ background: "rgb(var(--m-ink))" }}
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative flex items-center gap-2">
                  {label}
                  {value && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{
                        background: annual ? "rgb(var(--m-accent))" : "rgb(var(--m-accent) / 0.18)",
                        color: annual ? "rgb(var(--m-accent-ink))" : "rgb(var(--m-accent-deep))",
                      }}
                    >
                      −20%
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </motion.div>

        <motion.div {...revealGroup(0.1)} className="mt-14 grid gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <motion.div
              key={plan.key}
              {...revealChild()}
              className="relative rounded-[1.75rem] p-8 h-full flex flex-col"
              style={{
                background: plan.featured ? "rgb(var(--m-ink))" : "rgb(var(--m-card))",
                color: plan.featured ? "rgb(var(--m-paper))" : "inherit",
                border: plan.featured ? "none" : "1px solid rgb(var(--m-ink) / 0.08)",
                boxShadow: plan.featured
                  ? "0 30px 60px -28px rgb(var(--m-ink) / 0.5)"
                  : "0 14px 34px -26px rgb(var(--m-ink) / 0.3)",
              }}
            >
              {plan.featured && (
                <span
                  className="absolute -top-3 left-8 rounded-full px-3.5 py-1 text-xs font-bold"
                  style={{ background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))" }}
                >
                  Most take this one
                </span>
              )}

              <h3 className="text-2xl font-extrabold tracking-tight">{plan.name}</h3>
              <p
                className="mt-2 text-[15px]"
                style={{ color: plan.featured ? "rgb(var(--m-paper) / 0.65)" : "rgb(var(--m-ink-soft))" }}
              >
                {plan.tagline}
              </p>

              <Price plan={plan} annual={annual} />

              <ul className="mt-7 space-y-3 flex-1">
                {plan.highlights.map((item) => (
                  <li key={item} className="flex gap-3 text-[15px]">
                    <Check
                      size={18}
                      className="shrink-0 mt-0.5"
                      style={{ color: plan.featured ? "rgb(var(--m-accent))" : "rgb(var(--m-accent-deep))" }}
                    />
                    <span style={{ color: plan.featured ? "rgb(var(--m-paper) / 0.9)" : "rgb(var(--m-ink-soft))" }}>
                      {item}
                    </span>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                // The plan and billing period travel with the click. Every card
                // used to call the same argument-less handler, so pressing
                // "Configure this" on One Room landed you at step 7 with Whole
                // Building preselected at three times the price — and
                // quotedAmount is frozen onto the order as the record of what
                // the buyer was shown.
                onClick={() => onConfigure({ plan: plan.key, annual })}
                className="mt-8 w-full inline-flex items-center justify-center gap-2 rounded-full py-3.5
                           text-[15px] font-bold transition-transform duration-200 active:scale-[0.97]"
                style={
                  plan.featured
                    ? { background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))" }
                    : { background: "rgb(var(--m-ink))", color: "rgb(var(--m-paper))" }
                }
              >
                {plan.monthly === null ? "Get in touch" : "Configure this"}
                <ArrowRight size={16} />
              </button>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          {...reveal(0.2)}
          className="mt-10 text-center text-sm"
          style={{ color: "rgb(var(--m-ink-faint))" }}
        >
          Every plan includes the whole product. Configure yours first — you only talk to us when you're
          ready to switch it on.
        </motion.p>
      </div>
    </section>
  );
}
