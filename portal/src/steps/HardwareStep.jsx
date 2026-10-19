import { Building2, IdCard, LifeBuoy, Lightbulb, Minus, Plus, Tablet, TriangleAlert, Wrench } from "lucide-react";

import { Panel, Segmented } from "../components/ui.jsx";
import { formatMoney, monthlyPrice, yearlyPercent, yearlySaving } from "../lib/plans.js";
import { groupCatalogue, iconFor, minimumTag, monthlyOf, monthlyTag, oneTimeTag, tierName, unitWord } from "../lib/catalogue.js";
import { buildingAddOn, cardKinds, count, extraBuildingsFor, outgrows } from "../lib/extras.js";

/**
 * Step 7 — what else they need, asked in plain words: how many buildings
 * (which decides the plan, and any extra buildings), kiosks bought or
 * rented, RFID cards and which kind, fobs and readers, help setting up,
 * and a support tier. The quote beside it is lib/quote.js running on
 * these answers — the same function the server runs when the order is
 * saved and again when it is submitted.
 *
 * Everything starts empty except one building and Standard support, and
 * every count can be emptied again. Problems (a minimum not met, extra
 * buildings on Starter) are revealed under their field on Continue, like
 * every other step; nothing here is pre-thrown.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/** A count with − and +; + from nothing jumps to the minimum, − below it empties the field. */
function CountInput({ value, onChange, min = 1, floor = 0, label, error }) {
  const n = count(value);
  const down = () => {
    if (n <= floor) return;
    const next = n - 1;
    onChange(next < Math.max(min, 1) ? (floor > 0 ? String(floor) : "") : String(next));
  };
  const up = () => onChange(String(n < min ? min : n + 1));
  return (
    <div
      className={cx(
        "inline-flex h-11 items-stretch overflow-hidden rounded-full border bg-bg-panel",
        error ? "border-state-unavailable/60" : "border-line/[0.12]"
      )}
    >
      <button
        type="button"
        onClick={down}
        disabled={n <= floor}
        aria-label={`Fewer ${label}`}
        className="grid w-10 place-items-center text-ink-secondary transition-colors hover:bg-line/[0.06] hover:text-ink-primary disabled:opacity-35"
      >
        <Minus size={15} strokeWidth={2.6} />
      </button>
      <input
        value={value}
        inputMode="numeric"
        placeholder="0"
        aria-label={label}
        aria-invalid={error ? "true" : undefined}
        onChange={(e) => onChange(e.target.value.replace(/[^\d,]/g, "").slice(0, 7))}
        className="w-16 bg-transparent text-center font-bold tabular-nums text-ink-primary outline-none placeholder:font-semibold placeholder:text-ink-muted/70"
      />
      <button
        type="button"
        onClick={up}
        aria-label={`More ${label}`}
        className="grid w-10 place-items-center text-ink-secondary transition-colors hover:bg-line/[0.06] hover:text-ink-primary"
      >
        <Plus size={15} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function FieldError({ children }) {
  if (!children) return null;
  return (
    <p data-field-error="" className="mt-2 text-xs font-medium text-state-unavailable">
      {children}
    </p>
  );
}

/** One thing to choose: what it is and what it costs on the left, the controls on the right. */
function ItemRow({ item, price, note, hint, children, error }) {
  const Icon = iconFor(item);
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-3">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
            style={{ background: "rgb(var(--c-line) / 0.05)", color: "var(--color-ink-secondary)" }}
          >
            <Icon size={18} strokeWidth={2.1} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-ink-primary">{item.name}</span>
              {price && <span className="text-sm font-semibold tabular-nums text-ink-secondary">{price}</span>}
            </div>
            {item.description && <p className="mt-0.5 text-sm leading-relaxed text-ink-secondary">{item.description}</p>}
            {(note || hint) && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{[hint, note].filter(Boolean).join(" ")}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[52px] sm:pl-0">{children}</div>
      </div>
      <div className="pl-[52px]">
        <FieldError>{error}</FieldError>
      </div>
    </div>
  );
}

export default function HardwareStep({ errors = {}, pricing }) {
  if (!pricing) return null;
  const { extras, setExtras, plan, setPlan, annual, setAnnual, plans, catalogue, layout } = pricing;
  const groups = groupCatalogue(catalogue);
  const extra = buildingAddOn(catalogue);
  const kinds = cardKinds(catalogue);
  const others = groups.hardware.filter((i) => !kinds.includes(i));
  const chosen = plans.find((p) => p.key === plan) || null;
  const buildings = count(extras.buildings) || 1;
  const suggestion = pricing.suggestion;
  const extraOnChosen = extraBuildingsFor(chosen, buildings, catalogue);
  const tooSmall = outgrows(chosen, layout);
  const cardKind = kinds.find((k) => k.key === extras.cardKind) || kinds[0];
  const kiosksCounted = groups.kiosks.reduce((n, k) => n + count(extras.counts[k.key]), 0);

  const set = (patch) => setExtras((current) => ({ ...current, ...patch }));
  const setCount = (key, value) => setExtras((current) => ({ ...current, counts: { ...current.counts, [key]: value } }));
  const setMode = (key, mode) => setExtras((current) => ({ ...current, modes: { ...current.modes, [key]: mode } }));
  // The chosen plan's own saving: the storefront's badge shows the smallest
  // across plans so it is never overstated, but here the plan is known.
  const percent = yearlyPercent(chosen) ?? yearlySaving(plans);

  return (
    <div className="space-y-4">
      {/* ── buildings, which decide the plan ── */}
      <Panel
        title="Buildings and plan"
        icon={Building2}
        subtitle="Plans are sized by how much you run, never by features — every plan has all of SILLA."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">How many buildings will SILLA manage?</p>
            <p className="mt-0.5 text-sm text-ink-secondary">Each has its own floors, rooms and map, run by the same staff.</p>
          </div>
          <div className="self-start sm:self-auto">
            <CountInput
              value={extras.buildings}
              onChange={(value) => set({ buildings: value })}
              min={1}
              floor={1}
              label="buildings"
              error={errors["extras.buildings"]}
            />
          </div>
        </div>
        <FieldError>{errors["extras.buildings"]}</FieldError>

        {suggestion && (
          <div
            className="mt-4 flex flex-col gap-3 rounded-lg px-4 py-3 sm:flex-row sm:items-center"
            style={{ background: "rgb(var(--c-accent) / 0.08)" }}
          >
            <Lightbulb size={18} className="hidden shrink-0 sm:block" style={{ color: "var(--color-accent)" }} />
            <p className="min-w-0 flex-1 text-sm leading-relaxed">
              {suggestion.plan.key === plan ? (
                <>
                  <span className="font-semibold">{suggestion.plan.name} fits.</span>{" "}
                  <span className="text-ink-secondary">
                    {suggestion.extras
                      ? `${buildings} buildings is ${suggestion.plan.name} with ${suggestion.extras} extra building${suggestion.extras === 1 ? "" : "s"}`
                      : `It covers ${buildings === 1 ? "one building" : `${buildings} buildings`}`}
                    {" "}— the least it can cost you.
                  </span>
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    {suggestion.plan.name}
                    {suggestion.extras ? ` with ${suggestion.extras} extra building${suggestion.extras === 1 ? "" : "s"}` : ""} fits for less
                  </span>{" "}
                  <span className="text-ink-secondary">
                    — {formatMoney(suggestion.perMonth, { period: "month" })} {annual ? "billed yearly" : "billed monthly"}, for{" "}
                    {buildings === 1 ? "one building" : `${buildings} buildings`}.
                  </span>
                </>
              )}
            </p>
            {suggestion.plan.key !== plan && (
              <button
                type="button"
                onClick={() => setPlan(suggestion.plan.key)}
                className="shrink-0 self-start rounded-full px-4 py-2 text-sm font-bold sm:self-auto"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
              >
                Switch to {suggestion.plan.name}
              </button>
            )}
          </div>
        )}

        <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Plan">
          {plans.map((p) => {
            const on = p.key === plan;
            const extrasHere = extraBuildingsFor(p, buildings, catalogue);
            const offersExtra = extra && (!extra.plans?.length || extra.plans.includes(p.key));
            const included = p.limits?.buildings;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPlan(p.key)}
                className="min-w-0 rounded-lg border-2 px-2.5 py-2.5 text-left transition-colors duration-fast sm:p-3"
                style={{
                  borderColor: on ? "var(--color-accent)" : "rgb(var(--c-line) / 0.12)",
                  background: on ? "rgb(var(--c-accent) / 0.08)" : "transparent",
                }}
              >
                <span className="block truncate text-sm font-bold">{p.name}</span>
                <span className="mt-0.5 block text-[13px] tabular-nums text-ink-secondary sm:text-sm">
                  {formatMoney(monthlyPrice(p, annual), { currency: p.currency })}
                  <span className="text-ink-muted">/mo</span>
                </span>
                <span className="mt-1 hidden text-xs text-ink-muted sm:block">
                  {included == null
                    ? "Any number of buildings"
                    : extrasHere && offersExtra
                      ? `${included} included + ${extrasHere} extra`
                      : extrasHere
                        ? `${included === 1 ? "One building" : `${included} buildings`} only`
                        : `${included === 1 ? "One building" : `${included} buildings`} included`}
                </span>
              </button>
            );
          })}
        </div>
        {extraOnChosen > 0 && extra && (!extra.plans?.length || extra.plans.includes(plan)) && (
          <p className="mt-3 text-sm text-ink-secondary">
            {extraOnChosen} extra building{extraOnChosen === 1 ? "" : "s"} at {formatMoney(monthlyOf(extra, annual), { period: "month" })} each
            {annual ? ", billed yearly" : ""}. {extra.note}
          </p>
        )}
        {tooSmall.length > 0 && (
          <p className="mt-3 flex gap-2 text-sm text-ink-secondary">
            <TriangleAlert size={15} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-reserved))" }} />
            <span>
              Your floors so far have {tooSmall.join(" and ")} — {chosen?.name} won't let you add more once it's built.
            </span>
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line/[0.08] pt-4">
          <Segmented
            size="sm"
            value={annual ? "yearly" : "monthly"}
            onChange={(v) => setAnnual(v === "yearly")}
            options={[
              { value: "yearly", label: percent > 0 ? `Yearly (−${percent}%)` : "Yearly" },
              { value: "monthly", label: "Monthly" },
            ]}
          />
          <span className="text-xs text-ink-muted">Yearly billing also waives onboarding. You can change billing later.</span>
        </div>
      </Panel>

      {/* ── kiosks ── */}
      {groups.kiosks.length > 0 && (
        <Panel title="Kiosks" icon={Tablet} subtitle="Where people tap their card to check in. Buy one, or rent it by the month.">
          <div className="divide-y divide-line/[0.07]">
            {groups.kiosks.map((item) => {
              const mode = extras.modes[item.key] || "rent";
              const rent = monthlyOf(item, annual);
              return (
                <ItemRow
                  key={item.key}
                  item={item}
                  price={mode === "buy" ? `${formatMoney(item.prices.oneTime)} each` : `${formatMoney(rent, { period: "month" })} each`}
                  hint={mode === "rent" && item.rentalMinimumMonths ? `${item.rentalMinimumMonths}-month minimum.` : null}
                  note={item.note}
                  error={errors[`extras.counts.${item.key}`]}
                >
                  <Segmented
                    size="sm"
                    value={mode}
                    onChange={(m) => setMode(item.key, m)}
                    options={[
                      { value: "rent", label: "Rent" },
                      { value: "buy", label: "Buy" },
                    ]}
                  />
                  <CountInput
                    value={extras.counts[item.key] || ""}
                    onChange={(v) => setCount(item.key, v)}
                    min={item.minQuantity || 1}
                    label={item.unit?.many || "kiosks"}
                    error={errors[`extras.counts.${item.key}`]}
                  />
                </ItemRow>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ── cards, fobs, readers ── */}
      {(kinds.length > 0 || others.length > 0) && (
        <Panel title="Cards and readers" icon={IdCard} subtitle="Configured and tested before they reach you. Bought hardware carries a 1-year warranty.">
          <div className="divide-y divide-line/[0.07]">
            {cardKind && (
              <div className="py-4 first:pt-0">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
                      style={{ background: "rgb(var(--c-line) / 0.05)", color: "var(--color-ink-secondary)" }}
                    >
                      <IdCard size={18} strokeWidth={2.1} />
                    </span>
                    <div className="min-w-0">
                      <span className="font-semibold">RFID cards</span>
                      <p className="mt-0.5 text-sm text-ink-secondary">What your members tap. Choose plain, or printed with your logo and each member's ID.</p>
                    </div>
                  </div>
                  <div className="pl-[52px] sm:pl-0">
                    <CountInput
                      value={extras.cards}
                      onChange={(v) => set({ cards: v })}
                      min={cardKind.minQuantity || 1}
                      label="cards"
                      error={errors["extras.cards"]}
                    />
                  </div>
                </div>
                {kinds.length > 1 && (
                  <div className="mt-3 grid gap-2 pl-[52px] sm:grid-cols-2" role="radiogroup" aria-label="Kind of card">
                    {kinds.map((kind) => {
                      const on = kind.key === cardKind.key;
                      return (
                        <button
                          key={kind.key}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => {
                            // Moving to a kind with a higher minimum lifts a count below it
                            // to that minimum, rather than leaving an error waiting.
                            const n = count(extras.cards);
                            set({ cardKind: kind.key, ...(n > 0 && n < kind.minQuantity ? { cards: String(kind.minQuantity) } : {}) });
                          }}
                          className="rounded-lg border-2 px-3 py-2.5 text-left transition-colors duration-fast"
                          style={{
                            borderColor: on ? "var(--color-accent)" : "rgb(var(--c-line) / 0.12)",
                            background: on ? "rgb(var(--c-accent) / 0.08)" : "transparent",
                          }}
                        >
                          <span className="block text-sm font-bold">{kind.name.replace(/^RFID card,\s*/i, "").replace(/^./, (c) => c.toUpperCase())}</span>
                          <span className="mt-0.5 block text-xs text-ink-secondary">
                            {oneTimeTag(kind)} · {minimumTag(kind) || "no minimum"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="pl-[52px]">
                  <FieldError>{errors["extras.cards"]}</FieldError>
                </div>
              </div>
            )}
            {others.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                price={oneTimeTag(item)}
                note={[minimumTag(item), item.note].filter(Boolean).join(" · ")}
                error={errors[`extras.counts.${item.key}`]}
              >
                <CountInput
                  value={extras.counts[item.key] || ""}
                  onChange={(v) => setCount(item.key, v)}
                  min={item.minQuantity || 1}
                  label={item.unit?.many || "items"}
                  error={errors[`extras.counts.${item.key}`]}
                />
              </ItemRow>
            ))}
          </div>
        </Panel>
      )}

      {/* ── setup and services ── */}
      {groups.services.length > 0 && (
        <Panel title="Setting up" icon={Wrench} subtitle="Paid once, on your first invoice.">
          <div className="divide-y divide-line/[0.07]">
            {groups.services.map((item) => {
              if (item.alwaysIncluded) {
                const waived = item.waivedOnYearly && annual;
                return (
                  <ItemRow
                    key={item.key}
                    item={item}
                    price={waived ? "Free on yearly billing" : oneTimeTag(item)}
                    hint={item.waivedOnYearly && !annual ? "Free if you bill yearly." : null}
                    note={item.note}
                  >
                    <span
                      className="rounded-full px-3 py-1.5 text-xs font-bold"
                      style={{ background: "rgb(var(--c-state-available) / 0.14)", color: "rgb(var(--c-state-available))" }}
                    >
                      Included
                    </span>
                  </ItemRow>
                );
              }
              const visits = item.key === "installation" && kiosksCounted > 0 ? Math.ceil(kiosksCounted / 3) : null;
              return (
                <ItemRow
                  key={item.key}
                  item={item}
                  price={oneTimeTag(item)}
                  hint={
                    visits
                      ? `Your ${kiosksCounted} kiosk${kiosksCounted === 1 ? "" : "s"} need${kiosksCounted === 1 ? "s" : ""} ${visits} visit${visits === 1 ? "" : "s"}.`
                      : item.key === "card-enrollment" && count(extras.cards) > 0
                        ? `You're ordering ${count(extras.cards).toLocaleString("en-PH")} ${unitWord(cardKind, count(extras.cards))}.`
                        : null
                  }
                  note={[minimumTag(item), item.note].filter(Boolean).join(" · ")}
                  error={errors[`extras.counts.${item.key}`]}
                >
                  <CountInput
                    value={extras.counts[item.key] || ""}
                    onChange={(v) => setCount(item.key, v)}
                    min={item.minQuantity || 1}
                    label={item.unit?.many || "items"}
                    error={errors[`extras.counts.${item.key}`]}
                  />
                </ItemRow>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ── support ── */}
      {groups.support.length > 0 && (
        <Panel title="Support" icon={LifeBuoy} subtitle="One tier, billed with your plan. Standard comes with every plan.">
          <div className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="Support">
            {groups.support.map((tier) => {
              const on = (extras.support || groups.support.find((t) => t.groupDefault)?.key) === tier.key;
              return (
                <button
                  key={tier.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ support: tier.key })}
                  className="flex flex-col rounded-lg border-2 p-3.5 text-left transition-colors duration-fast"
                  style={{
                    borderColor: on ? "var(--color-accent)" : "rgb(var(--c-line) / 0.12)",
                    background: on ? "rgb(var(--c-accent) / 0.08)" : "transparent",
                  }}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-bold">{tierName(tier)}</span>
                    <span className="text-sm font-semibold tabular-nums text-ink-secondary">{monthlyTag(tier, annual)}</span>
                  </span>
                  <ul className="mt-2 space-y-1">
                    {(tier.highlights?.length ? tier.highlights : [tier.description]).map((point) => (
                      <li key={point} className="text-xs leading-relaxed text-ink-secondary">
                        {point}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
          <FieldError>{errors["extras.support"]}</FieldError>
        </Panel>
      )}

      {errors["extras.other"] && (
        <p data-field-error="" className="text-sm font-medium text-state-unavailable">
          {errors["extras.other"]}
        </p>
      )}
    </div>
  );
}
