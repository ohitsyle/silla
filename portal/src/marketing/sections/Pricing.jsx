import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";

import { EASE, prefersReducedMotion, reveal, revealChild, revealGroup } from "../motion.js";
import { formatMoney, moneyParts, monthlyPrice, periodPrice, usePlans, yearlySaving } from "../../lib/plans.js";

/**
 * Plans.
 *
 * Read from SILLA's catalogue (GET /api/vendor/plans), which staff edit
 * in the console's Plans section — so a price change is a form, not a
 * deploy. Until the catalogue answers, or if it never does, the page shows
 * the fallback in lib/plans.js, which mirrors the catalogue's defaults, so
 * the cards do not jump when the live figures land.
 *
 * ⚠️  The prices are still PLACEHOLDERS (pesos, converted guesses) until
 * someone sets real ones in the console. A wrong price on a live page is a
 * promise; an order freezes what it was quoted, and the invoice is billed
 * from the catalogue at submission.
 *
 * The axis is SIZE, not features: everything is in every plan, which is
 * what the section above promises. Charging twice for the same product
 * by withholding the map editor would make that a lie.
 */

const GRID = {
  1: "lg:grid-cols-1 lg:max-w-md lg:mx-auto",
  2: "lg:grid-cols-2 lg:max-w-4xl lg:mx-auto",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

function Price({ plan, annual, featured, pricesExcludeVat }) {
  const amount = monthlyPrice(plan, annual);
  const faint = featured ? "rgb(var(--m-paper) / 0.6)" : "rgb(var(--m-ink-faint))";

  if (amount === null) {
    return (
      <div className="mt-6">
        <span className="display text-[2.75rem]">Let's talk</span>
        <p className="mt-1.5 text-sm" style={{ color: faint }}>
          Priced on how big it actually is.
        </p>
      </div>
    );
  }

  const { symbol, amount: figure } = moneyParts(amount, { currency: plan.currency });
  const vat = pricesExcludeVat ? " Plus VAT." : "";
  return (
    <div className="mt-6">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold" style={{ color: featured ? "rgb(var(--m-paper) / 0.75)" : "rgb(var(--m-ink-soft))" }}>
          {symbol}
        </span>
        {/* Keyed on the value so the figure re-animates when the toggle flips. */}
        <motion.span
          key={`${plan.key}:${amount}`}
          className="display text-[3.25rem] tabular-nums"
          initial={prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          {figure}
        </motion.span>
        <span className="text-base font-semibold" style={{ color: faint }}>
          /month
        </span>
      </div>
      <p className="mt-1.5 text-sm" style={{ color: faint }}>
        {annual
          ? `Billed yearly — ${formatMoney(periodPrice(plan, true), { currency: plan.currency })} a year.${vat}`
          : `Billed monthly.${vat}`}
      </p>
    </div>
  );
}

export default function Pricing({ onConfigure }) {
  const [annual, setAnnual] = useState(true);
  const { plans, pricesExcludeVat, trialDays } = usePlans();
  const saving = yearlySaving(plans);

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
                aria-pressed={annual === value}
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
                  {/* Worked out from the prices, so it can't drift from them. */}
                  {value && saving > 0 && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{
                        background: annual ? "rgb(var(--m-accent))" : "rgb(var(--m-accent) / 0.18)",
                        color: annual ? "rgb(var(--m-accent-ink))" : "rgb(var(--m-accent-deep))",
                      }}
                    >
                      −{saving}%
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </motion.div>

        <motion.div {...revealGroup(0.1)} className={`mt-14 grid gap-6 ${GRID[Math.min(plans.length, 4)] || GRID[3]}`}>
          {plans.map((plan) => (
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

              <Price plan={plan} annual={annual} featured={plan.featured} pricesExcludeVat={pricesExcludeVat} />

              <ul className="mt-7 space-y-3 flex-1">
                {(plan.highlights || []).map((item) => (
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
                {monthlyPrice(plan, false) === null ? "Get in touch" : "Configure this"}
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
          Every plan includes the whole product
          {trialDays > 0 ? `, and starts with a ${trialDays}-day free trial the day your system goes live` : ""}.
          Configure yours first — you only talk to us when you're ready to switch it on.
        </motion.p>
      </div>
    </section>
  );
}
