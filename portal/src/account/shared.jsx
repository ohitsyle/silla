import { ArrowLeft } from "lucide-react";
import { AccountMenu } from "./kit.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { formatMoney } from "../lib/plans.js";

/**
 * The signed-in chrome for the storefront.
 *
 * Kept small on purpose: this is not the product's app shell. A buyer
 * comes here to check on an order, not to work all day, so a persistent
 * sidebar would be furniture around two pages.
 */
export function AccountLayout({ navigate, title, subtitle, action, children }) {
  return (
    <div className="silla-marketing min-h-screen">
      <header
        className="sticky top-0 z-40 border-b border-line/[0.08]"
        style={{ background: "rgb(var(--c-bg-page) / 0.86)", backdropFilter: "saturate(180%) blur(12px)" }}
      >
        <div className="mx-auto flex h-[72px] max-w-5xl items-center gap-4 px-6">
          <button
            type="button"
            onClick={() => navigate(ROUTES.home)}
            className="flex items-center gap-2.5 text-xl font-extrabold tracking-tight hover:opacity-70"
          >
            <span
              className="grid h-8 w-8 place-items-center rounded-[10px] text-sm"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              S
            </span>
            SILLA
          </button>

          <div className="ml-auto">
            <AccountMenu navigate={navigate} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-8 flex flex-wrap items-start gap-4">
          <div className="mr-auto">
            <h1 className="display text-[clamp(1.75rem,4vw,2.5rem)]">{title}</h1>
            {subtitle && <p className="mt-2 text-ink-secondary">{subtitle}</p>}
          </div>
          {action}
        </div>
        {children}
      </main>
    </div>
  );
}

export function BackLink({ onClick, children = "Back" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary
                 transition-opacity hover:opacity-70"
    >
      <ArrowLeft size={15} />
      {children}
    </button>
  );
}

/**
 * Order status, said in words and colour.
 *
 * The tones map to the product's resource states rather than inventing
 * a second vocabulary — green means good, amber means waiting, grey
 * means nothing is happening.
 */
const STATUS_TONE = {
  draft: { bg: "var(--c-ink-muted)", label: "Draft" },
  submitted: { bg: "var(--c-state-reserved)", label: "Submitted" },
  provisioning: { bg: "var(--c-state-reserved)", label: "Being built" },
  live: { bg: "var(--c-state-available)", label: "Live" },
  cancelled: { bg: "var(--c-state-unavailable)", label: "Cancelled" },
};

export function StatusBadge({ status }) {
  const tone = STATUS_TONE[status] || STATUS_TONE.draft;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
      style={{ background: `rgb(${tone.bg} / 0.16)`, color: `rgb(${tone.bg})` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(${tone.bg})` }} />
      {tone.label}
    </span>
  );
}

/** The names the first three plans had — for orders saved before an order carried its plan's name. */
export const PLAN_LABEL = { room: "One Room", building: "Whole Building", campus: "Campus" };

/** What to call an order's plan: the name it was saved with, which any catalogue plan has. */
export const planLabel = (order) => order?.planName || PLAN_LABEL[order?.plan] || order?.plan || "";

/**
 * What an order was quoted, per month — minor units, through the ONE
 * money formatter (lib/plans.js): "₱13,000/month", or "Priced with you".
 * This used to be its own formatter that assumed dollars, so every peso
 * order read "PHP 6900/month".
 *
 * The whole recurring cost when the order carries its frozen quote's
 * totals (add-ons, rentals and support included); the plan's own price
 * (`quotedAmount`) only for orders from before quotes were frozen. Shown
 * the plan's price alone, a client paying ₱13,000 a month read
 * "Building · ₱6,000/month" on their own client page.
 */
export const quoteOf = (order) => {
  const perMonth = Number.isInteger(order?.totals?.perMonth) && order?.totals?.perMonth > 0 ? order.totals.perMonth : null;
  return formatMoney(perMonth ?? order?.quotedAmount ?? null, { currency: order?.currency, period: "month" });
};

export const when = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
