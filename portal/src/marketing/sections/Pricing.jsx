import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check, Plus } from "lucide-react";

import { EASE, prefersReducedMotion, reveal, revealChild, revealGroup } from "../motion.js";
import {
  formatMoney, moneyParts, monthlyPrice, periodPrice, usePlans, vatSentence, yearlyPercent, yearlySavingOf,
  yearlySavingRange,
} from "../../lib/plans.js";
import { groupCatalogue, iconFor, minimumTag, monthlyOf, monthlyTag, oneTimeTag, tierName } from "../../lib/catalogue.js";

/**
 * Plans, then everything else SILLA sells — extra buildings, hardware,
 * setup and support — priced up front.
 *
 * Read from SILLA's catalogue (GET /api/vendor/plans), which staff edit in
 * the console's Plans section — so a price change is a form, not a
 * deploy. Until the catalogue answers, or if it never does, the page shows
 * the fallback in lib/plans.js (the vendor's own seed files, byte for
 * byte), so nothing jumps when the live figures land. An order is priced
 * again on the server and freezes what it was quoted.
 *
 * The plans' axis is SIZE, not features: everything is in every plan,
 * which is what the section above promises. Charging twice for the same
 * product by withholding the map editor would make that a lie.
 *
 * VAT is said once, under the toggle, for everything on the page — and
 * only says VAT is added when SILLA is VAT-registered.
 */

const GRID = {
  1: "lg:grid-cols-1 lg:max-w-md lg:mx-auto",
  2: "lg:grid-cols-2 lg:max-w-4xl lg:mx-auto",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

const CARD = {
  background: "rgb(var(--m-card))",
  border: "1px solid rgb(var(--m-ink) / 0.08)",
  boxShadow: "0 14px 34px -26px rgb(var(--m-ink) / 0.3)",
};
const soft = { color: "rgb(var(--m-ink-soft))" };
const faint = { color: "rgb(var(--m-ink-faint))" };

function Price({ plan, annual, featured }) {
  const amount = monthlyPrice(plan, annual);
  const muted = featured ? "rgb(var(--m-paper) / 0.6)" : "rgb(var(--m-ink-faint))";

  if (amount === null) {
    return (
      <div className="mt-6">
        <span className="display text-[2.75rem]">Let's talk</span>
        <p className="mt-1.5 text-sm" style={{ color: muted }}>
          Priced on how big it actually is.
        </p>
      </div>
    );
  }

  const { symbol, amount: figure } = moneyParts(amount, { currency: plan.currency });
  const saves = yearlySavingOf(plan);
  // This plan's own percentage — the figure the configurator shows once
  // the plan is chosen, so the two never disagree.
  const percent = yearlyPercent(plan);
  const share = percent > 0 ? ` (${percent}%)` : "";
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
        <span className="text-base font-semibold" style={{ color: muted }}>
          /month
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: muted }}>
        {annual ? (
          <>
            Billed yearly — {formatMoney(periodPrice(plan, true), { currency: plan.currency })} a year.
            {saves ? (
              <span className="font-semibold" style={{ color: featured ? "rgb(var(--m-accent))" : "rgb(var(--m-accent-deep))" }}>
                {" "}You save {formatMoney(saves, { currency: plan.currency })}{share}.
              </span>
            ) : null}
          </>
        ) : saves ? (
          `Billed monthly. ${formatMoney(monthlyPrice(plan, true), { period: "month", currency: plan.currency })} billed yearly saves ${formatMoney(saves, { currency: plan.currency })} a year${share}.`
        ) : (
          "Billed monthly."
        )}
      </p>
    </div>
  );
}

/** A small rounded tile holding an item's icon — the storefront's chip, as the feature cards use. */
function Chip({ item, size = 44, tone = "accent" }) {
  const Icon = iconFor(item);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[14px]"
      style={{
        width: size,
        height: size,
        background: tone === "accent" ? "rgb(var(--m-accent) / 0.14)" : "rgb(var(--m-ink) / 0.06)",
        color: tone === "accent" ? "rgb(var(--m-accent-deep))" : "rgb(var(--m-ink-soft))",
      }}
    >
      <Icon size={Math.round(size * 0.45)} strokeWidth={2.2} />
    </span>
  );
}

function GroupHead({ title, lead }) {
  return (
    <div className="mb-5">
      <h4 className="text-xl font-extrabold tracking-tight sm:text-2xl">{title}</h4>
      {lead && (
        <p className="mt-1 text-[15px]" style={soft}>
          {lead}
        </p>
      )}
    </div>
  );
}

/**
 * More buildings. A strip of building tiles that grows by one is the
 * point of the item: each one raises the building limit by one.
 */
function BuildingsBand({ item, annual, campus }) {
  const monthly = monthlyOf(item, false);
  const yearly = monthlyOf(item, true);
  const plans = (item.plans || []).map((k) => (k === "building" ? "Building" : k === "campus" ? "Campus" : k));
  return (
    <motion.div {...reveal()} className="rounded-[1.75rem] p-6 sm:p-9" style={CARD}>
      <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "rgb(var(--m-accent-deep))" }}>
            More than one building
          </p>
          <h4 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-[1.75rem]">More {item.unit?.many || "buildings"}, as you need them</h4>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed" style={soft}>
            {item.description} Available on {plans.join(" and ") || "every plan"}
            {campus?.limits?.buildings > 1 ? `; Campus includes ${campus.limits.buildings} to start` : ""}.
          </p>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="text-[15px]">
              <span className="text-2xl font-extrabold tabular-nums">{formatMoney(annual ? yearly : monthly, { currency: item.currency })}</span>
              <span className="font-semibold" style={faint}>
                {" "}
                per building a month, billed {annual ? "yearly" : "monthly"}
              </span>
            </span>
            {yearly !== monthly && (
              <span className="text-sm" style={faint}>
                {annual
                  ? `${formatMoney(monthly, { currency: item.currency })}/month on monthly billing`
                  : `${formatMoney(yearly, { currency: item.currency })}/month billed yearly`}
              </span>
            )}
          </div>
          {item.note && (
            <p className="mt-3 text-sm font-medium" style={soft}>
              {item.note}
            </p>
          )}
        </div>
        {/* Decorative, and only where there is room: a small skyline that
            grows by one, which is the whole of what the item does. */}
        <div aria-hidden className="hidden items-end gap-3 md:flex">
          {[76, 104].map((height, i) => {
            const Icon = iconFor(item);
            return (
              <span
                key={i}
                className="grid w-[68px] place-items-center rounded-[16px]"
                style={{ height, background: "rgb(var(--m-ink) / 0.07)", color: "rgb(var(--m-ink-soft))" }}
              >
                <Icon size={24} strokeWidth={2} />
              </span>
            );
          })}
          <span
            className="grid h-[88px] w-[68px] place-items-center rounded-[16px] border-2 border-dashed"
            style={{ borderColor: "rgb(var(--m-accent) / 0.55)", background: "rgb(var(--m-accent) / 0.08)", color: "rgb(var(--m-accent-deep))" }}
          >
            <Plus size={24} strokeWidth={2.6} />
          </span>
        </div>
      </div>
    </motion.div>
  );
}

/** One kiosk: what it is, then buying and renting side by side. */
function KioskCard({ item }) {
  const rent = monthlyOf(item, false);
  return (
    <motion.div {...revealChild()} className="flex h-full flex-col rounded-[1.75rem] p-6 sm:p-7" style={CARD}>
      <div className="flex items-start gap-4">
        <Chip item={item} />
        <div className="min-w-0">
          <h5 className="text-lg font-extrabold tracking-tight">{item.name}</h5>
          <p className="mt-1 text-[15px] leading-relaxed" style={soft}>
            {item.description}
          </p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 overflow-hidden rounded-2xl" style={{ background: "rgb(var(--m-ink) / 0.045)" }}>
        <div className="p-4 sm:p-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em]" style={faint}>
            Buy
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums sm:text-2xl">{formatMoney(item.prices.oneTime, { currency: item.currency })}</div>
          <div className="mt-0.5 text-sm" style={soft}>
            once
          </div>
        </div>
        <div className="p-4 sm:p-5" style={{ boxShadow: "inset 1px 0 0 rgb(var(--m-ink) / 0.08)" }}>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em]" style={faint}>
            Rent
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums sm:text-2xl">
            {formatMoney(rent, { currency: item.currency })}
            <span className="text-sm font-semibold" style={faint}>
              /month
            </span>
          </div>
          <div className="mt-0.5 text-sm" style={soft}>
            {item.rentalMinimumMonths ? `${item.rentalMinimumMonths}-month minimum` : "month to month"}
          </div>
        </div>
      </div>
      {item.note && (
        <p className="mt-4 text-sm leading-relaxed" style={soft}>
          {item.note}
        </p>
      )}
    </motion.div>
  );
}

/** A list of one-time things with their price tags: cards and readers, or setup and services. */
function PriceList({ title, lead, items, annual }) {
  return (
    <motion.div {...revealChild()} className="rounded-[1.75rem] p-6 sm:p-7" style={CARD}>
      <GroupHead title={title} lead={lead} />
      <ul className="divide-y" style={{ borderColor: "rgb(var(--m-ink) / 0.08)" }}>
        {items.map((item) => {
          const waived = item.waivedOnYearly && annual;
          const minimum = minimumTag(item);
          return (
            <li key={item.key} className="flex items-start gap-3.5 py-4 first:pt-0 last:pb-0" style={{ borderColor: "rgb(var(--m-ink) / 0.08)" }}>
              <Chip item={item} size={38} tone="ink" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-bold">{item.name}</span>
                  <span className="whitespace-nowrap font-extrabold tabular-nums">
                    {waived ? (
                      <>
                        <span className="mr-1.5 font-semibold line-through" style={faint}>
                          {formatMoney(item.prices.oneTime, { currency: item.currency })}
                        </span>
                        Free
                      </>
                    ) : (
                      oneTimeTag(item)
                    )}
                  </span>
                </div>
                <p className="mt-0.5 text-sm leading-relaxed" style={soft}>
                  {item.description}
                </p>
                {/* Neutral ink: a minimum order or a warranty is information,
                    and the accent read as a warning here. */}
                {(minimum || item.note || item.waivedOnYearly) && (
                  <p className="mt-1 text-[13px] font-medium" style={soft}>
                    {[minimum, item.waivedOnYearly ? (annual ? "Waived on yearly billing." : "Free on yearly billing.") : null, item.note]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}

/** The support tiers, side by side: what each adds and what it costs. */
function SupportCompare({ tiers }) {
  return (
    <div>
      <GroupHead title="Maintenance and support" lead="Pick one. Standard comes with every plan." />
      <motion.div {...revealGroup(0.08)} className="grid gap-4 md:grid-cols-3">
        {tiers.map((tier, i) => {
          const free = monthlyOf(tier, false) === 0;
          return (
            <motion.div key={tier.key} {...revealChild()} className="flex h-full flex-col rounded-[1.5rem] p-6" style={CARD}>
              <div className="flex items-center gap-3">
                <Chip item={tier} size={40} tone={i === tiers.length - 1 ? "accent" : "ink"} />
                <div>
                  <h5 className="text-lg font-extrabold tracking-tight">{tierName(tier)}</h5>
                  <div className="text-sm font-bold tabular-nums" style={{ color: free ? "rgb(var(--m-ink-soft))" : "rgb(var(--m-accent-deep))" }}>
                    {monthlyTag(tier, false)}
                  </div>
                </div>
              </div>
              <ul className="mt-5 flex-1 space-y-2.5">
                {(tier.highlights?.length ? tier.highlights : [tier.description]).map((point) => (
                  <li key={point} className="flex gap-2.5 text-[15px]">
                    <Check size={17} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--m-accent-deep))" }} />
                    <span style={soft}>{point}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

export default function Pricing({ onConfigure }) {
  const [annual, setAnnual] = useState(true);
  const store = usePlans();
  const { plans, catalogue, trialDays } = store;
  const saving = yearlySavingRange(plans);
  const groups = groupCatalogue(catalogue);
  const campus = plans.find((p) => p.key === "campus");
  const featured = plans.find((p) => p.featured) || plans[0];

  return (
    <section id="pricing" className="px-6 py-24 sm:py-32" style={{ background: "rgb(var(--m-paper-deep))" }}>
      <div className="mx-auto max-w-6xl">
        <motion.h2 {...reveal()} className="display text-center text-[clamp(2rem,5.5vw,3.75rem)]">
          Take your pick.
        </motion.h2>
        <motion.p {...reveal(0.08)} className="mx-auto mt-5 max-w-xl text-center text-lg" style={soft}>
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
                  {/* Worked out from the prices, so it can't drift from
                      them. It speaks for every plan, so it says "up to"
                      when they differ; each card says its own figure. */}
                  {value && saving && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{
                        background: annual ? "rgb(var(--m-accent))" : "rgb(var(--m-accent) / 0.18)",
                        color: annual ? "rgb(var(--m-accent-ink))" : "rgb(var(--m-accent-deep))",
                      }}
                    >
                      {saving.min === saving.max ? `Save ${saving.max}%` : `Save up to ${saving.max}%`}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </motion.div>
        {/* Said once, for every price on the page. */}
        <motion.p {...reveal(0.18)} className="mx-auto mt-4 max-w-2xl text-center text-sm" style={faint}>
          {vatSentence(store)}
        </motion.p>

        <motion.div {...revealGroup(0.1)} className={`mt-12 grid gap-6 ${GRID[Math.min(plans.length, 4)] || GRID[3]}`}>
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

              <Price plan={plan} annual={annual} featured={plan.featured} />

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
                // "Configure this" on the smallest plan landed you at the end
                // of the configurator with the featured plan preselected at
                // three times the price.
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

        <motion.p {...reveal(0.2)} className="mt-10 text-center text-sm" style={faint}>
          Every plan includes the whole product
          {trialDays > 0 ? `, and starts with a ${trialDays}-day free trial the day your system goes live` : ""}.
          Configure yours first — you only talk to us when you're ready to switch it on.
        </motion.p>

        {/* ── everything else ── */}
        <div className="mt-24 sm:mt-32">
          <motion.h3 {...reveal()} className="display text-center text-[clamp(1.75rem,4.5vw,3rem)]">
            Everything else, priced up front.
          </motion.h3>
          <motion.p {...reveal(0.08)} className="mx-auto mt-4 max-w-2xl text-center text-lg" style={soft}>
            Hardware we configure and test before it reaches you, help getting set up, and support when you need it. Choose any of
            it in the configurator — it's all on your quote before you commit to anything.
          </motion.p>

          <div className="mt-12 space-y-12 sm:mt-14 sm:space-y-14">
            {groups.buildings.map((item) => (
              <BuildingsBand key={item.key} item={item} annual={annual} campus={campus} />
            ))}

            {groups.kiosks.length > 0 && (
              <div>
                <GroupHead title="Kiosks" lead="Buy one outright, or rent it by the month — set up, tested and locked to your kiosk page." />
                <motion.div {...revealGroup(0.08)} className="grid gap-5 md:grid-cols-2">
                  {groups.kiosks.map((item) => (
                    <KioskCard key={item.key} item={item} />
                  ))}
                </motion.div>
              </div>
            )}

            <motion.div {...revealGroup(0.08)} className="grid items-start gap-5 lg:grid-cols-2">
              {groups.hardware.length > 0 && (
                <PriceList
                  title="Cards and readers"
                  lead="Configured and tested before they ship. Bought hardware carries a 1-year warranty."
                  items={groups.hardware}
                  annual={annual}
                />
              )}
              {groups.services.length > 0 && (
                <PriceList title="Setup and services" lead="Paid once, on your first invoice." items={groups.services} annual={annual} />
              )}
            </motion.div>

            {groups.support.length > 0 && <SupportCompare tiers={groups.support} />}
          </div>

          <motion.div {...reveal(0.1)} className="mt-14 flex flex-col items-center gap-3 text-center">
            <button
              type="button"
              onClick={() => onConfigure({ plan: featured?.key, annual })}
              className="inline-flex items-center gap-2 rounded-full px-7 py-4 text-base font-semibold transition-transform duration-200 active:scale-[0.97]"
              style={{ background: "rgb(var(--m-accent))", color: "rgb(var(--m-accent-ink))", boxShadow: "0 6px 0 0 rgb(var(--m-accent-deep))" }}
            >
              Build yours and see the quote
              <ArrowRight size={17} />
            </button>
            <p className="text-sm" style={faint}>
              The configurator adds it up as you choose. Nothing is charged until you submit an order.
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
