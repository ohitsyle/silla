import { CalendarClock, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { formatMoney } from "../lib/plans.js";

/**
 * A quote, read the way a buyer reads a bill: what recurs and what it
 * comes to each period, what is paid once, and what the first invoice
 * will be — then what billing yearly saves and what a rental commits to.
 *
 * It renders the shape lib/quote.js builds, which is ALSO the shape an
 * order freezes on the server, so the live quote in the configurator, the
 * Review step, the saved order and the staff console all show one thing
 * in one way. Money goes through the one formatter.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");
const PER = { monthly: "month", yearly: "year" };

/** What a line is called in a quote: "Building plan", "SILLA Kiosk rental". */
export const quoteLineLabel = (line) =>
  line.kind === "plan" ? `${line.name} plan` : line.kind === "rental" ? `${line.name} rental` : line.name;

function Line({ line, money }) {
  const recurring = line.kind !== "one_time";
  const amount = recurring ? line.perPeriod : line.amount;
  return (
    <li className="flex items-baseline gap-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-ink-primary">{quoteLineLabel(line)}</span>
        {line.quantity > 1 && <span className="ml-1.5 tabular-nums text-ink-muted">× {line.quantity.toLocaleString("en-PH")}</span>}
      </span>
      <span className="shrink-0 text-right font-semibold tabular-nums">
        {line.waived ? (
          <>
            <span className="mr-1.5 font-medium text-ink-muted line-through">{money(line.fullAmount)}</span>
            Free
          </>
        ) : line.included ? (
          <span className="text-ink-secondary">Included</span>
        ) : amount == null ? (
          <span className="text-ink-secondary">To be agreed</span>
        ) : (
          money(amount)
        )}
      </span>
    </li>
  );
}

function Group({ title, children, total, sub }) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">{title}</h3>
      <ul className="mt-1 divide-y divide-line/[0.06]">{children}</ul>
      {total && (
        <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-line/10 pt-2 text-sm">
          <span className="text-ink-secondary">{sub}</span>
          <span className="font-bold tabular-nums">{total}</span>
        </div>
      )}
    </section>
  );
}

export default function QuoteSummary({ quote, problems = {}, title = "Your quote", onSwitchYearly, className, footer, action, flat = false }) {
  if (!quote) return null;
  const money = (n) => formatMoney(n, { currency: quote.currency });
  const per = PER[quote.billingPeriod] || "period";
  const t = quote.totals || {};
  const recurring = (quote.lines || []).filter((l) => l.kind !== "one_time");
  const oneTime = (quote.lines || []).filter((l) => l.kind === "one_time");
  const first = t.firstInvoice;
  const saving = t.yearlySaving?.total || 0;
  const wrong = Object.values(problems || {});

  return (
    <div className={cx(flat ? "" : "rounded-xl border border-line/10 bg-bg-card p-5 shadow-raised", className)}>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-auto text-[15px] font-bold tracking-tight">{title}</h2>
        <span className="rounded-full bg-line/[0.06] px-2.5 py-1 text-[11px] font-bold text-ink-secondary">
          Billed {quote.billingPeriod === "monthly" ? "monthly" : "yearly"}
        </span>
        {action}
      </div>

      {wrong.length > 0 && (
        <div className="mb-4 flex gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: "rgb(var(--c-state-unavailable) / 0.08)" }}>
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-state-unavailable" />
          <span className="text-ink-secondary">
            <span className="font-semibold text-ink-primary">Not orderable as it stands. </span>
            {wrong[0]}
          </span>
        </div>
      )}

      <Group
        title={`Every ${per}`}
        total={t.renewal ? money(t.perPeriod) : null}
        sub={quote.billingPeriod === "yearly" && t.perMonth ? `${money(t.perMonth)} a month, billed yearly` : "In all, each month"}
      >
        {recurring.map((line) => (
          <Line key={`${line.key}:${line.mode || ""}`} line={line} money={money} />
        ))}
      </Group>

      {oneTime.length > 0 && (
        <Group title="Paid once" total={t.oneTime > 0 ? money(t.oneTime) : null} sub="In all, once">
          {oneTime.map((line) => (
            <Line key={`${line.key}:${line.mode || ""}`} line={line} money={money} />
          ))}
        </Group>
      )}

      <div className="mt-5 rounded-lg px-4 py-3.5" style={{ background: "rgb(var(--c-accent) / 0.09)" }}>
        {first ? (
          <>
            {first.tax > 0 && (
              <div className="mb-1.5 space-y-1 text-sm">
                <div className="flex justify-between gap-3 text-ink-secondary">
                  <span>Before VAT</span>
                  <span className="tabular-nums">{money(first.subtotal)}</span>
                </div>
                <div className="flex justify-between gap-3 text-ink-secondary">
                  <span>{quote.vat?.label || "VAT"}</span>
                  <span className="tabular-nums">{money(first.tax)}</span>
                </div>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-bold">First invoice</span>
              <span className="text-2xl font-extrabold tabular-nums tracking-tight">{money(first.total)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-secondary">
              Then {money(t.renewal?.total)} a {per}
              {first.tax > 0 ? ", VAT included" : quote.vat?.registered ? "" : ". No VAT is added"}.
            </p>
          </>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-bold">First invoice</span>
            <span className="text-sm font-semibold text-ink-secondary">Priced with you</span>
          </div>
        )}
      </div>

      {saving > 0 && (
        <p className="mt-3 flex gap-2 text-sm">
          <CircleCheck size={16} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-available))" }} />
          <span className="text-ink-secondary">
            {quote.billingPeriod === "yearly" ? (
              <>
                Billing yearly saves <span className="font-semibold text-ink-primary">{money(saving)}</span> in the first year.
              </>
            ) : (
              <>
                Billing yearly would save <span className="font-semibold text-ink-primary">{money(saving)}</span> in the first year.
                {onSwitchYearly && (
                  <>
                    {" "}
                    <button type="button" onClick={onSwitchYearly} className="font-semibold underline decoration-line/30 underline-offset-2 hover:decoration-line/70">
                      Switch to yearly
                    </button>
                  </>
                )}
              </>
            )}
          </span>
        </p>
      )}
      {(quote.commitments || []).map((c) => (
        <p key={c} className="mt-2 flex gap-2 text-sm text-ink-secondary">
          <CalendarClock size={16} className="mt-0.5 shrink-0 text-ink-muted" />
          {c}
        </p>
      ))}
      {footer && (
        <p className="mt-3 flex gap-2 text-xs leading-relaxed text-ink-muted">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{footer}</span>
        </p>
      )}
    </div>
  );
}
