import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, Ban, Boxes, CalendarClock, Check, ExternalLink, FileText, History, Layers, Megaphone, Minus, PackageCheck, Pause,
  Play, Plus, RefreshCw, Server, SlidersHorizontal, Undo2, X,
} from "lucide-react";

import { Button, EmptyState, Notice, Panel, Segmented, Skeleton, Textarea } from "../../components/ui.jsx";
import { SelectInput, TextInput } from "../../account/kit.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { formatMoney } from "../../lib/plans.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES } from "../../lib/useHashRoute.js";
import { dateTime, fromDateInput, invoiceSummary, limitPhrase, longDate, shortDate, toDateInput, toMinor } from "../../billing/format.js";
import { InvoiceBadge, MoneyInput, ToneBadge } from "../../billing/ui.jsx";
import { iconFor } from "../../lib/catalogue.js";
import {
  BackTo, FilterTabs, ManualInvoiceDialog, ReasonDialog, Row, SearchBox, SubscriptionBadge, useDebounced,
} from "../../billing/console.jsx";

/**
 * Staff console — Subscriptions.
 *
 * The list answers "who needs a person?": attention first (a price never
 * agreed, a sync failing, a period over with nothing invoiced — the
 * states the billing job deliberately leaves alone), then by status. One
 * subscription is everything SILLA can decide for one client: its plan
 * and price, its features and limits over the plan's, the notice its
 * administrators see, its trial, and whether the deployment has heard.
 *
 * Reading needs billing.read; every control that changes something needs
 * billing.manage and is not rendered without it — staff are never offered
 * a button their role would be refused.
 */

const PERIOD = { monthly: "month", yearly: "year" };
const FEATURE_LABEL = {
  kiosk: "Kiosk check-in and self-registration",
  reports: "Reports and CSV export",
  customBranding: "Custom colours and logo",
  wholeRoomBooking: "Booking whole rooms",
  emailReminders: "Reminder emails before a reservation",
};
const LIMIT_LABEL = {
  buildings: "Buildings",
  floors: "Floors",
  rooms: "Rooms",
  resources: "Bookable units",
  members: "Members",
  staff: "Staff accounts",
};

const money = (minor, currency) => formatMoney(minor, { currency });
/** 8280000 → "82,800" — what a person types back into a peso field. */
const pesoText = (minor) => (minor / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 });

/** The date that matters for this status, in words. */
function keyDate(s) {
  if (s.status === "trialing") return s.trialEndsAt ? `Trial ends ${shortDate(s.trialEndsAt)}` : "Trial";
  if (s.status === "active") return s.currentPeriodEnd ? `${s.cancelAtPeriodEnd ? "Ends" : "Paid through"} ${shortDate(s.currentPeriodEnd)}` : "Active";
  if (s.status === "past_due") return s.graceEndsAt ? `Grace until ${shortDate(s.graceEndsAt)}` : "Past due";
  if (s.status === "suspended") return "Read-only";
  if (s.status === "cancelled") return s.cancelledAt ? `Ended ${shortDate(s.cancelledAt)}` : "Ended";
  return "Not live yet";
}

function AttentionChips({ flags }) {
  if (!flags?.length) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {flags.map((f) => (
        <span
          key={f}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{ background: "rgb(var(--c-state-reserved) / 0.14)", color: "rgb(var(--c-state-reserved))" }}
        >
          <AlertTriangle size={11} strokeWidth={2.6} />
          {f}
        </span>
      ))}
    </span>
  );
}

/* ───────────────────────────── the list ───────────────────────────── */

const TABS = [
  ["all", "All"],
  ["attention", "Needs attention"],
  ["trialing", "Trial"],
  ["active", "Active"],
  ["past_due", "Past due"],
  ["suspended", "Suspended"],
  ["pending", "Pending"],
  ["cancelled", "Cancelled"],
];

function SubscriptionList({ navigate, query: address = {} }) {
  // Arriving from the overview's breakdown opens on that status.
  const [tab, setTab] = useState(() => (TABS.some(([value]) => value === address.status) ? address.status : "all"));
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setError(null);
    billingApi
      .subscriptions({ status: ["all", "attention"].includes(tab) ? undefined : tab, attention: tab === "attention", q: query })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tab, query]);

  const counts = data?.counts || {};
  const total = Object.entries(counts).filter(([k]) => k !== "attention").reduce((s, [, n]) => s + n, 0);
  const tabs = TABS.map(([value, label]) => ({
    value,
    label,
    count: value === "all" ? total : counts[value],
    alert: ["attention", "past_due", "suspended"].includes(value),
  }));
  const rows = data?.subscriptions || [];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <FilterTabs tabs={tabs} value={tab} onChange={setTab} label="Subscription status" />
        <SearchBox value={q} onChange={setQ} placeholder="Organization or email" />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {data && rows.length === 0 && (
        <EmptyState icon={Layers} title={q ? "Nothing matches that" : tab === "attention" ? "Nothing needs a person" : "No subscriptions here"}>
          {q ? "Try an organization name or the buyer's email." : "Subscriptions appear when buyers submit orders."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_120px_minmax(0,1.3fr)_minmax(0,1.1fr)] gap-4 border-b border-line/[0.08] px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted lg:grid">
            <span>Organization</span>
            <span>Plan</span>
            <span>Status</span>
            <span>When</span>
            <span className="text-right">Open invoices</span>
          </div>
          <ul className="divide-y divide-line/[0.07]">
            {rows.map((s, i) => (
              <motion.li key={s.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
                <button
                  type="button"
                  onClick={() => navigate(`${ROUTES.staff}/subscriptions/${s.id}`)}
                  className="grid w-full gap-x-4 gap-y-1.5 px-5 py-3.5 text-left transition-colors hover:bg-line/[0.03]
                             lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_120px_minmax(0,1.3fr)_minmax(0,1.1fr)] lg:items-center"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{s.organizationName}</span>
                      <span className="lg:hidden">
                        <SubscriptionBadge status={s.status} size="sm" />
                      </span>
                    </span>
                    <span className="block truncate text-sm text-ink-muted">{s.account?.email}</span>
                    {s.attention.length > 0 && (
                      <span className="mt-1.5 block">
                        <AttentionChips flags={s.attention} />
                      </span>
                    )}
                  </span>
                  <span className="text-sm">
                    <span className="font-semibold">{s.planName}</span>
                    <span className="text-ink-muted">
                      {" · "}
                      {s.needsPricing || s.price.amount == null ? "price to agree" : `${money(s.perPeriod ?? s.price.amount, s.price.currency)}/${PERIOD[s.billingPeriod]}`}
                      {s.addOnCount > 0 ? ` · ${s.addOnCount} add-on${s.addOnCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  <span className="hidden lg:block">
                    <SubscriptionBadge status={s.status} />
                  </span>
                  <span className="text-sm text-ink-secondary">{keyDate(s)}</span>
                  <span className="text-sm lg:text-right">
                    {s.openInvoices.count ? (
                      <>
                        <span className="font-bold tabular-nums">{formatMoney(s.openInvoices.total, { currency: s.price.currency, exact: true })}</span>
                        <span className={s.openInvoices.overdue ? "font-semibold text-state-unavailable" : "text-ink-muted"}>
                          {" · "}
                          {s.openInvoices.overdue ? `${s.openInvoices.overdue} overdue` : `${s.openInvoices.count} open`}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-muted">Nothing owed</span>
                    )}
                  </span>
                </button>
              </motion.li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── one subscription ───────────────────────────── */

/** Saves a patch and hands back the fresh detail; field errors stay with their fields. */
function useSaver(id, onSaved) {
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState({});
  const toast = useToast();
  const save = async (patch, message) => {
    setBusy(true);
    setFields({});
    try {
      const result = await billingApi.updateSubscription(id, patch);
      onSaved(result.subscription);
      toast(result.issuedInvoice ? `${message} — ${result.issuedInvoice} issued and emailed` : message);
      return true;
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, fields, save };
}

function PlanAndPrice({ sub, manage, onSaved }) {
  // `price` is the agreed price as typed, or null for "not touched": then a
  // plan or period change takes the catalogue's, and nothing else moves it.
  const source = useMemo(
    () => ({ plan: sub.plan, billingPeriod: sub.billingPeriod, price: null }),
    [sub]
  );
  const current = sub.price.amount == null ? "" : pesoText(sub.price.amount);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const { busy, fields, save } = useSaver(sub.id, onSaved);

  const plan = sub.plans.find((p) => p.key === draft.plan);
  const catalogue = plan
    ? draft.billingPeriod === "monthly"
      ? plan.prices.monthly
      : plan.prices.annualMonthly == null
        ? null
        : plan.prices.annualMonthly * 12
    : null;
  const planChanged = draft.plan !== source.plan || draft.billingPeriod !== source.billingPeriod;
  // Compared as money, not text: "82800" and "82,800" are the same price.
  const priceChanged =
    draft.price !== null && (draft.price.trim() === "" ? sub.price.amount != null : toMinor(draft.price) !== sub.price.amount);
  const dirty = planChanged || priceChanged;
  const shownPrice = draft.price !== null ? draft.price : planChanged ? (catalogue == null ? "" : pesoText(catalogue)) : current;
  const badPrice = priceChanged && draft.price.trim() !== "" && toMinor(draft.price) == null;

  const commit = () => {
    if (badPrice) return;
    const patch = {};
    if (draft.plan !== source.plan) patch.plan = draft.plan;
    if (draft.billingPeriod !== source.billingPeriod) patch.billingPeriod = draft.billingPeriod;
    // Typed in the same save as a plan change, the agreed price wins over the catalogue's.
    if (priceChanged) patch.price = draft.price.trim() === "" ? null : toMinor(draft.price);
    save(patch, "Plan and price saved");
  };

  return (
    <Panel icon={Layers} title="Plan and price" subtitle="What the plan allows changes now. A new price applies from the next invoice — invoices already sent keep their amounts.">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectInput label="Plan" value={draft.plan} disabled={!manage} onChange={(e) => setDraft((d) => ({ ...d, plan: e.target.value, price: null }))} error={fields.plan}>
          {sub.plans
            .filter((p) => p.active || p.key === sub.plan)
            .map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
                {p.active ? "" : " (retired)"}
              </option>
            ))}
        </SelectInput>
        <div>
          <span className="text-sm text-ink-secondary">Billed</span>
          <div className="mt-1.5">
            {manage ? (
              <Segmented
                value={draft.billingPeriod}
                onChange={(v) => setDraft((d) => ({ ...d, billingPeriod: v, price: null }))}
                options={[
                  { value: "yearly", label: "Yearly" },
                  { value: "monthly", label: "Monthly" },
                ]}
              />
            ) : (
              <div className="h-11 py-2.5 font-semibold capitalize">{sub.billingPeriod}</div>
            )}
          </div>
        </div>
        <MoneyInput
          label={`Agreed price per ${PERIOD[draft.billingPeriod]}`}
          className="sm:col-span-2"
          disabled={!manage}
          value={shownPrice}
          placeholder={catalogue == null ? "Priced with this customer — agree one" : pesoText(catalogue)}
          onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
          error={fields.price || (badPrice ? "Enter an amount in pesos, like 82,800." : null)}
          hint={
            catalogue != null
              ? `Catalogue price: ${money(catalogue, plan?.currency)} a ${PERIOD[draft.billingPeriod]}. Leave it, or set what was agreed.`
              : sub.price.amount != null && !planChanged
                ? "No list price on this plan — this is the price agreed with them."
                : "This plan has no list price. Until one is agreed, no invoice is sent and the subscription is flagged."
          }
        />
      </div>
      {fields._form && <Notice tone="error" className="mt-4">{fields._form}</Notice>}
      {manage && dirty && (
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-line/[0.08] pt-4">
          {sub.openInvoices.count > 0 && planChanged && (
            <span className="mr-auto text-xs text-ink-muted">Open invoices keep their amounts — void and re-issue one if the change should apply now.</span>
          )}
          <Button variant="ghost" onClick={() => setDraft(source)} disabled={busy}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} onClick={commit}>
            Save
          </Button>
        </div>
      )}
    </Panel>
  );
}

/* ───────────────────────────── add-ons ───────────────────────────── */

const MONTHS = { monthly: 1, yearly: 12 };
const addOnLabel = (a) => `${a.name}${a.kind === "rental" ? " rental" : ""}`;
const addOnId = (a) => `${a.key}:${a.kind}`;

/** A quantity with − and + for the add-ons list. */
function QuantityStepper({ value, onChange, min = 1, max = null, disabled, label }) {
  const n = Number(value) || 0;
  return (
    <span className="inline-flex h-9 items-stretch overflow-hidden rounded-full border border-line/12 bg-bg-panel">
      <button
        type="button"
        aria-label={`Fewer ${label}`}
        disabled={disabled || n <= min}
        onClick={() => onChange(String(Math.max(min, n - 1)))}
        className="grid w-8 place-items-center text-ink-secondary hover:bg-line/[0.06] disabled:opacity-35"
      >
        <Minus size={13} strokeWidth={2.6} />
      </button>
      <input
        aria-label={label}
        inputMode="numeric"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="w-12 bg-transparent text-center text-sm font-bold tabular-nums outline-none"
      />
      <button
        type="button"
        aria-label={`More ${label}`}
        disabled={disabled || (max != null && n >= max)}
        onClick={() => onChange(String(n + 1))}
        className="grid w-8 place-items-center text-ink-secondary hover:bg-line/[0.06] disabled:opacity-35"
      >
        <Plus size={13} strokeWidth={2.6} />
      </button>
    </span>
  );
}

/**
 * What the customer pays for besides the plan — extra buildings, rentals,
 * support — and what they bought once with the order. Billing staff change
 * quantities, add or take off add-ons; the deployment's limits change on
 * save, the price from the next invoice. An add-on already on the
 * subscription keeps the price agreed for it; one added takes today's
 * catalogue price. The server checks the catalogue's rules again.
 */
function AddOnsPanel({ sub, manage, onSaved }) {
  const months = MONTHS[sub.billingPeriod] || 12;
  const per = PERIOD[sub.billingPeriod];
  const source = useMemo(
    () => sub.addOns.map((a) => ({ key: a.key, kind: a.kind, name: a.name, quantity: String(a.quantity), unitAmount: a.unitAmount, isNew: false })),
    [sub]
  );
  const [draft, setDraft] = useState(source);
  const [adding, setAdding] = useState("");
  useEffect(() => setDraft(source), [source]);
  const { busy, fields, save } = useSaver(sub.id, onSaved);
  const options = sub.addOnOptions || [];
  const optionFor = (a) => options.find((o) => o.key === a.key && o.kind === a.kind);
  const dirty = JSON.stringify(draft.map((a) => [a.key, a.kind, a.quantity])) !== JSON.stringify(source.map((a) => [a.key, a.kind, a.quantity]));
  const cur = sub.price.currency;

  const addable = options.filter(
    (o) => o.active && o.monthly != null && !draft.some((a) => a.key === o.key && a.kind === o.kind) && (!o.plans?.length || o.plans.includes(sub.plan))
  );
  const add = () => {
    const o = options.find((x) => `${x.key}:${x.kind}` === adding);
    if (!o) return;
    setDraft((d) => [
      // One per group: adding Care takes Standard (or Care Plus) off.
      ...d.filter((a) => !o.group || optionFor(a)?.group !== o.group),
      { key: o.key, kind: o.kind, name: o.name, quantity: String(o.minQuantity || 1), unitAmount: o.monthly, isNew: true },
    ]);
    setAdding("");
  };
  const total = (sub.price.amount ?? 0) + draft.reduce((sum, a) => sum + a.unitAmount * months * (Number(a.quantity) || 0), 0);
  const buildingsAdded = draft.reduce((sum, a) => sum + (optionFor(a)?.adds?.buildings || 0) * (Number(a.quantity) || 0), 0);
  const planBuildings = sub.overrides?.limits?.buildings !== undefined ? sub.overrides.limits.buildings : sub.planDefaults?.limits?.buildings;

  const commit = () =>
    save(
      { addOns: draft.map((a) => ({ key: a.key, quantity: Number(a.quantity) || 0, mode: a.kind === "rental" ? "rent" : null })) },
      "Add-ons saved — the deployment's limits change now, the price from the next invoice"
    );

  return (
    <Panel
      icon={Boxes}
      title="Add-ons"
      subtitle={`Billed with the plan every ${per}: extra buildings, rentals and support. Limits change when saved; prices from the next invoice.`}
    >
      {draft.length === 0 ? (
        <p className="text-sm text-ink-secondary">None — the plan alone.</p>
      ) : (
        <ul className="-mx-5 divide-y divide-line/[0.07] border-y border-line/[0.07]">
          {draft.map((a) => {
            const Icon = iconFor({ key: a.key, category: optionFor(a)?.category });
            const error = fields[`addOns.${a.key}`];
            const n = Number(a.quantity) || 0;
            return (
              <li key={addOnId(a)} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-line/[0.05] text-ink-secondary">
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <span className="min-w-[11rem] flex-1">
                    <span className="block font-semibold">{addOnLabel(a)}</span>
                    <span className="block text-xs text-ink-muted">
                      {a.unitAmount === 0 ? "Included" : `${money(a.unitAmount * months, cur)} each a ${per}`}
                      {a.isNew ? " · today's price" : " · as agreed"}
                      {optionFor(a)?.adds?.buildings ? ` · +${optionFor(a).adds.buildings} building each` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                  {manage && optionFor(a)?.maxQuantity !== 1 ? (
                    <QuantityStepper
                      value={a.quantity}
                      label={addOnLabel(a)}
                      min={1}
                      max={optionFor(a)?.maxQuantity ?? null}
                      onChange={(q) => setDraft((d) => d.map((x) => (addOnId(x) === addOnId(a) ? { ...x, quantity: q } : x)))}
                    />
                  ) : (
                    <span className="text-sm tabular-nums text-ink-secondary">× {a.quantity}</span>
                  )}
                  <span className="w-24 text-right text-sm font-bold tabular-nums">{a.unitAmount === 0 ? "—" : money(a.unitAmount * months * n, cur)}</span>
                  {manage && (
                    <button
                      type="button"
                      aria-label={`Take off ${addOnLabel(a)}`}
                      onClick={() => setDraft((d) => d.filter((x) => addOnId(x) !== addOnId(a)))}
                      className="grid h-8 w-8 place-items-center rounded-full text-ink-muted hover:bg-line/[0.06] hover:text-ink-primary"
                    >
                      <X size={15} />
                    </button>
                  )}
                  </span>
                </div>
                {error && <p className="mt-1.5 text-xs font-medium text-state-unavailable">{error}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {manage && addable.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <SelectInput label="Add" className="min-w-[220px] flex-1" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose something billed every {per}…</option>
            {addable.map((o) => (
              <option key={`${o.key}:${o.kind}`} value={`${o.key}:${o.kind}`}>
                {o.name}
                {o.kind === "rental" ? " (rented)" : ""} — {o.monthly === 0 ? "included" : `${money(o.monthly, cur)}/month`}
              </option>
            ))}
          </SelectInput>
          <Button icon={Plus} onClick={add} disabled={!adding}>
            Add
          </Button>
        </div>
      )}

      <div className="mt-4 space-y-1 rounded-lg bg-bg-panel/70 px-4 py-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-ink-secondary">Each {per}, plan included</span>
          <span className="font-bold tabular-nums">{sub.price.amount == null ? "Plan price to agree" : money(total, cur)}</span>
        </div>
        {(planBuildings != null || buildingsAdded > 0) && (
          <div className="flex justify-between gap-3">
            <span className="text-ink-secondary">Buildings they can have</span>
            <span className="font-semibold tabular-nums">
              {planBuildings == null ? "Unlimited" : `${planBuildings} + ${buildingsAdded} added = ${planBuildings + buildingsAdded}`}
            </span>
          </div>
        )}
      </div>
      {fields._form && <Notice tone="error" className="mt-4">{fields._form}</Notice>}
      {Object.entries(fields)
        .filter(([k]) => k === "addOns" || (k.startsWith("addOns.") && !draft.some((a) => `addOns.${a.key}` === k)))
        .map(([k, message]) => (
          <Notice key={k} tone="error" className="mt-3">
            {message}
          </Notice>
        ))}
      {manage && dirty && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-line/[0.08] pt-4">
          <span className="mr-auto text-xs text-ink-muted">Open invoices keep their amounts. Taking off a support tier leaves Standard.</span>
          <Button variant="ghost" onClick={() => setDraft(source)} disabled={busy}>
            Discard
          </Button>
          <Button variant="primary" loading={busy} onClick={commit}>
            Save add-ons
          </Button>
        </div>
      )}

      {sub.oneTime?.length > 0 && (
        <div className="mt-5 border-t border-line/[0.08] pt-4">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">
            <PackageCheck size={14} /> Bought once, with the order
          </h3>
          <ul className="mt-2 space-y-1 text-sm">
            {sub.oneTime.map((l) => (
              <li key={`${l.key}:${l.description}`} className="flex justify-between gap-3">
                <span>
                  {l.name}
                  {l.quantity > 1 && <span className="ml-1.5 tabular-nums text-ink-muted">× {l.quantity.toLocaleString("en-PH")}</span>}
                </span>
                <span className="tabular-nums text-ink-secondary">{l.waived ? "Waived" : money(l.amount, cur)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/** "as-plan" | "on" | "off" for features; "as-plan" | "unlimited" | a number (as text) for limits. */
const overrideState = (overrides) => ({
  features: Object.fromEntries(Object.keys(FEATURE_LABEL).map((k) => [k, k in (overrides.features || {}) ? (overrides.features[k] ? "on" : "off") : "as-plan"])),
  limits: Object.fromEntries(
    Object.keys(LIMIT_LABEL).map((k) => [
      k,
      k in (overrides.limits || {}) ? (overrides.limits[k] === null ? "unlimited" : String(overrides.limits[k])) : "as-plan",
    ])
  ),
});

function OverridesEditor({ sub, manage, onSaved }) {
  const source = useMemo(() => overrideState(sub.overrides), [sub]);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const { busy, fields, save } = useSaver(sub.id, onSaved);
  const defaults = sub.planDefaults || { features: {}, limits: {} };
  const dirty = JSON.stringify(draft) !== JSON.stringify(source);
  const [revealed, setRevealed] = useState(false);

  const limitError = (k) => {
    const v = draft.limits[k];
    if (v === "as-plan" || v === "unlimited") return null;
    return /^\d+$/.test(v) ? null : "A whole number";
  };

  const commit = () => {
    setRevealed(true);
    if (Object.keys(LIMIT_LABEL).some(limitError)) return;
    const features = {};
    for (const [k, v] of Object.entries(draft.features)) if (v !== "as-plan") features[k] = v === "on";
    const limits = {};
    for (const [k, v] of Object.entries(draft.limits)) if (v !== "as-plan") limits[k] = v === "unlimited" ? null : Number(v);
    save({ overrides: { features, limits } }, "Features and limits saved — pushed to the deployment");
  };

  const count = Object.values(draft.features).filter((v) => v !== "as-plan").length + Object.values(draft.limits).filter((v) => v !== "as-plan").length;
  const changedClass = (v) => (v !== "as-plan" ? "" : "text-ink-muted");

  return (
    <Panel
      icon={SlidersHorizontal}
      title="Features and limits"
      subtitle={`The ${sub.planName} plan's own, with this client's overrides on top. Limits only stop new things being created; nothing is ever removed.`}
      action={count ? <ToneBadge tone="info" size="sm">{count} override{count === 1 ? "" : "s"}</ToneBadge> : null}
    >
      <div className="-mx-5 overflow-hidden border-y border-line/[0.08]">
        <div className="hidden grid-cols-[minmax(0,1fr)_130px_200px] gap-4 bg-bg-panel/50 px-5 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted sm:grid">
          <span>{sub.planName} plan</span>
          <span>Plan default</span>
          <span>This client</span>
        </div>
        <ul className="divide-y divide-line/[0.07]">
          {Object.entries(FEATURE_LABEL).map(([k, label]) => {
            const value = draft.features[k];
            const effective = value === "as-plan" ? defaults.features[k] !== false : value === "on";
            return (
              <li
                key={k}
                className="grid items-center gap-x-4 gap-y-2 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_130px_200px]"
                style={value !== "as-plan" ? { background: "rgb(var(--c-accent) / 0.06)" } : undefined}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {effective ? (
                    <Check size={15} strokeWidth={2.8} className="shrink-0" style={{ color: "rgb(var(--c-state-available))" }} />
                  ) : (
                    <Minus size={15} strokeWidth={2.8} className="shrink-0 text-ink-muted" />
                  )}
                  {label}
                </span>
                <span className="text-sm text-ink-muted max-sm:hidden">{defaults.features[k] === false ? "Off" : "On"}</span>
                <select
                  aria-label={`${label} for this client`}
                  value={value}
                  disabled={!manage}
                  onChange={(e) => setDraft((d) => ({ ...d, features: { ...d.features, [k]: e.target.value } }))}
                  className={`h-9 w-full rounded-md border border-line/10 bg-bg-panel px-2.5 text-sm font-semibold outline-none focus:border-line/40 ${changedClass(value)}`}
                >
                  <option value="as-plan">As the plan ({defaults.features[k] === false ? "off" : "on"})</option>
                  <option value="on">On for this client</option>
                  <option value="off">Off for this client</option>
                </select>
              </li>
            );
          })}
          {Object.entries(LIMIT_LABEL).map(([k, label]) => {
            const value = draft.limits[k];
            const mode = value === "as-plan" || value === "unlimited" ? value : "number";
            const planValue = defaults.limits[k];
            const err = revealed ? limitError(k) || fields[`overrides.limits.${k}`] : null;
            return (
              <li
                key={k}
                className="grid items-start gap-x-4 gap-y-2 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_130px_200px]"
                style={value !== "as-plan" ? { background: "rgb(var(--c-accent) / 0.06)" } : undefined}
              >
                <span className="pt-2 text-sm font-semibold">{label}</span>
                <span className="pt-2 text-sm text-ink-muted max-sm:hidden">{planValue == null ? "Unlimited" : planValue.toLocaleString("en-PH")}</span>
                <span className="flex gap-2">
                  <select
                    aria-label={`${label} limit for this client`}
                    value={mode}
                    disabled={!manage}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        limits: { ...d.limits, [k]: e.target.value === "number" ? String(planValue ?? 0) : e.target.value },
                      }))
                    }
                    className={`h-9 min-w-0 flex-1 rounded-md border border-line/10 bg-bg-panel px-2.5 text-sm font-semibold outline-none focus:border-line/40 ${changedClass(value)}`}
                  >
                    <option value="as-plan">As the plan ({planValue == null ? "unlimited" : planValue})</option>
                    <option value="unlimited">Unlimited</option>
                    <option value="number">A number…</option>
                  </select>
                  {mode === "number" && (
                    <input
                      aria-label={`${label} limit`}
                      inputMode="numeric"
                      value={value}
                      disabled={!manage}
                      onChange={(e) => setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: e.target.value.trim() } }))}
                      className={`h-9 w-20 rounded-md border bg-bg-panel px-2.5 text-right text-sm font-semibold tabular-nums outline-none ${err ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40"}`}
                    />
                  )}
                </span>
                {err && <span className="text-xs font-medium text-state-unavailable sm:col-start-3">{err}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {fields._form && <Notice tone="error" className="mt-4">{fields._form}</Notice>}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p className="mr-auto text-xs text-ink-muted">
          Effective now:{" "}
          {Object.entries(sub.effective.limits)
            .map(([k, v]) => limitPhrase(k, v))
            .join(" · ")}
        </p>
        {manage && dirty && (
          <>
            <Button variant="ghost" onClick={() => { setDraft(source); setRevealed(false); }} disabled={busy}>
              Discard
            </Button>
            <Button variant="primary" loading={busy} onClick={commit}>
              Save overrides
            </Button>
          </>
        )}
      </div>
    </Panel>
  );
}

function NoticeEditor({ sub, manage, onSaved }) {
  const [text, setText] = useState(sub.notice || "");
  useEffect(() => setText(sub.notice || ""), [sub.notice]);
  const { busy, fields, save } = useSaver(sub.id, onSaved);
  const dirty = text.trim() !== (sub.notice || "");
  if (!manage && !sub.notice) return null;
  return (
    <Panel icon={Megaphone} title="Notice" subtitle="One line shown to this organization's administrators in their product.">
      {manage ? (
        <>
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Your extra 300 units are on us through December."
            error={fields.notice}
            hint={`${text.trim().length}/280`}
          />
          {dirty && (
            <div className="mt-3 flex justify-end gap-2">
              {sub.notice && !text.trim() ? null : (
                <Button size="sm" variant="ghost" onClick={() => setText(sub.notice || "")} disabled={busy}>
                  Discard
                </Button>
              )}
              <Button size="sm" variant="primary" loading={busy} onClick={() => save({ notice: text.trim() || null }, text.trim() ? "Notice saved" : "Notice cleared")}>
                {text.trim() ? "Save notice" : "Clear notice"}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm">{sub.notice}</p>
      )}
    </Panel>
  );
}

function TrialEditor({ sub, manage, onSaved }) {
  const [day, setDay] = useState(toDateInput(sub.trialEndsAt));
  useEffect(() => setDay(toDateInput(sub.trialEndsAt)), [sub.trialEndsAt]);
  const { busy, fields, save } = useSaver(sub.id, onSaved);
  // Only while nothing has been paid: a paid period has no trial left to move.
  if (!manage || sub.currentPeriodEnd || sub.status === "cancelled") return null;
  const dirty = day && day !== toDateInput(sub.trialEndsAt);
  return (
    <Panel icon={CalendarClock} title="Free trial" subtitle={sub.status === "pending" ? "Starts when the deployment goes live. Set an end now to give a longer one." : "Moving the end re-arms the reminder. A trial that ran out comes back as a trial."}>
      <div className="flex flex-wrap items-end gap-3">
        <TextInput label="Trial ends" type="date" className="min-w-[180px] flex-1" value={day} onChange={(e) => setDay(e.target.value)} error={fields.trialEndsAt} />
        {dirty && (
          <Button variant="primary" loading={busy} onClick={() => save({ trialEndsAt: fromDateInput(day) }, "Trial end saved")}>
            Save
          </Button>
        )}
      </div>
      {fields._form && <Notice tone="error" className="mt-3">{fields._form}</Notice>}
    </Panel>
  );
}

function SyncPanel({ sub, manage, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await billingApi.sync(sub.id);
      onSaved(result.subscription);
      toast(result.sync?.error ? "Tried again — it still failed" : "Pushed to the deployment", { tone: result.sync?.error ? "error" : "success" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const failing = Boolean(sub.sync.error);
  return (
    <Panel icon={Server} title="Deployment">
      {!sub.organizationId ? (
        <p className="text-sm text-ink-secondary">Not provisioned yet. Its entitlements are pushed the moment it is.</p>
      ) : (
        <>
          <div className="divide-y divide-line/[0.07]">
            <Row label="Organization">
              <span className="font-mono text-xs">{sub.organizationId}</span>
            </Row>
            {sub.order?.deploymentUrl && (
              <Row label="Address">
                <a href={sub.order.deploymentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:opacity-70" style={{ color: "rgb(var(--m-accent-deep))" }}>
                  Open <ExternalLink size={13} />
                </a>
              </Row>
            )}
            <Row label="Last pushed">{sub.sync.syncedAt ? dateTime(sub.sync.syncedAt) : "Never"}</Row>
          </div>
          <div
            className="mt-3 rounded-lg px-3.5 py-2.5 text-sm"
            style={{ background: `rgb(var(${failing ? "--c-state-unavailable" : "--c-state-available"}) / 0.09)` }}
          >
            <span className="font-bold" style={{ color: `rgb(var(${failing ? "--c-state-unavailable" : "--c-state-available"}))` }}>
              {failing ? "The last push failed." : "In step."}
            </span>{" "}
            <span className="text-ink-secondary">
              {failing ? `${sub.sync.error} The billing job retries every ten minutes.` : "The deployment enforces what this page says."}
            </span>
          </div>
          {error && <Notice tone="error" className="mt-3">{error}</Notice>}
          {manage && (
            <Button size="sm" className="mt-3" icon={RefreshCw} loading={busy} onClick={retry}>
              {failing ? "Retry now" : "Push again"}
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}

function InvoicesPanel({ sub, manage, navigate, onIssued }) {
  const [issuing, setIssuing] = useState(false);
  return (
    <Panel
      icon={FileText}
      title="Invoices"
      action={
        manage && sub.status !== "cancelled" ? (
          <Button size="sm" icon={Plus} onClick={() => setIssuing(true)}>
            New invoice
          </Button>
        ) : null
      }
    >
      {sub.invoices.length === 0 ? (
        <p className="text-sm text-ink-secondary">{sub.needsPricing ? "None yet — agree a price and the first one goes out." : "None yet."}</p>
      ) : (
        <ul className="-mx-5 divide-y divide-line/[0.07] border-t border-line/[0.07]">
          {sub.invoices.map((inv) => (
            <li key={inv.id}>
              <button
                type="button"
                onClick={() => navigate(`${ROUTES.staff}/invoices/${inv.id}`)}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left transition-colors hover:bg-line/[0.03]"
                style={inv.overdue ? { background: "rgb(var(--c-state-unavailable) / 0.05)" } : undefined}
              >
                <span className="font-mono text-sm font-semibold">{inv.number}</span>
                <InvoiceBadge invoice={inv} size="sm" />
                <span className="mr-auto min-w-0 truncate text-sm text-ink-muted">{invoiceSummary(inv)}</span>
                <span className="text-sm font-bold tabular-nums">{formatMoney(inv.total, { currency: inv.currency, exact: true })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ManualInvoiceDialog
        open={issuing}
        subscription={sub}
        onClose={() => setIssuing(false)}
        onIssued={(invoice) => {
          setIssuing(false);
          onIssued(invoice);
        }}
      />
    </Panel>
  );
}

function HistoryPanel({ sub }) {
  return (
    <Panel icon={History} title="History">
      <ol className="relative space-y-4 border-l-2 border-line/10 pl-5">
        {sub.history.map((h, i) => (
          <li key={i} className="relative">
            <span
              className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2"
              style={{ borderColor: "rgb(var(--c-bg-card))", background: i === 0 ? "var(--color-accent)" : "rgb(var(--c-line) / 0.25)" }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <SubscriptionBadge status={h.status} size="sm" />
              <span className="text-xs text-ink-muted">{dateTime(h.at)}</span>
            </div>
            {h.note && <p className="mt-1 text-sm leading-relaxed">{h.note}</p>}
            <p className="text-xs text-ink-muted">{h.by ? `${h.by.name || h.by.email}${h.by.staff ? "" : " (customer)"}` : "Automatic"}</p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function StandingPanel({ sub, manage, act }) {
  const facts = [
    ["Status", <SubscriptionBadge key="s" status={sub.status} />],
    sub.trialEndsAt && !sub.currentPeriodEnd ? ["Trial ends", longDate(sub.trialEndsAt)] : null,
    sub.currentPeriodEnd ? ["Paid period", `${shortDate(sub.currentPeriodStart)} – ${shortDate(sub.currentPeriodEnd)}`] : null,
    sub.graceEndsAt ? ["Grace until", longDate(sub.graceEndsAt)] : null,
    ["Price", sub.needsPricing || sub.price.amount == null ? "To agree" : `${money(sub.perPeriod ?? sub.price.amount, sub.price.currency)} / ${PERIOD[sub.billingPeriod]}`],
    ["Open", sub.openInvoices.count ? formatMoney(sub.openInvoices.total, { currency: sub.price.currency, exact: true }) : "Nothing owed"],
    sub.cancelledAt ? ["Ended", longDate(sub.cancelledAt)] : null,
  ].filter(Boolean);

  const running = ["trialing", "active", "past_due"].includes(sub.status);
  return (
    <Panel title="Standing">
      <div className="divide-y divide-line/[0.07]">
        {facts.map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
      </div>
      {sub.cancelAtPeriodEnd && (
        <p className="mt-3 rounded-lg px-3.5 py-2.5 text-sm" style={{ background: "rgb(var(--c-state-reserved) / 0.1)" }}>
          Set to end on <span className="font-bold">{longDate(sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd)}</span>
          {sub.cancelReason ? ` — ${sub.cancelReason}` : ""}.
        </p>
      )}
      {manage && sub.status !== "cancelled" && sub.status !== "pending" && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line/[0.08] pt-4">
          {sub.status === "suspended" && (
            <Button variant="primary" size="sm" icon={Play} onClick={() => act("resume")}>
              Resume
            </Button>
          )}
          {sub.cancelAtPeriodEnd && (
            <Button size="sm" icon={Undo2} onClick={() => act("withdraw")}>
              Keep it going
            </Button>
          )}
          {running && (
            <Button size="sm" variant="danger" icon={Pause} onClick={() => act("suspend")}>
              Suspend
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={Ban} onClick={() => act("cancel")}>
            Cancel…
          </Button>
        </div>
      )}
    </Panel>
  );
}

function SubscriptionDetail({ id, navigate, can }) {
  const manage = can("billing.manage");
  const toast = useToast();
  const [sub, setSub] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // "suspend" | "cancel" | "resume" | "withdraw"
  const [cancelWhen, setCancelWhen] = useState("period_end");

  const load = useCallback(
    () =>
      billingApi
        .subscription(id)
        .then((d) => setSub(d.subscription))
        .catch((e) => setError(e)),
    [id]
  );
  useEffect(() => {
    setSub(null);
    load();
  }, [load]);

  useEffect(() => {
    if (dialog === "cancel" && sub) setCancelWhen(["active", "trialing"].includes(sub.status) ? "period_end" : "now");
  }, [dialog, sub]);

  const back = () => navigate(`${ROUTES.staff}/subscriptions`);
  if (error) {
    return (
      <div>
        <BackTo onClick={back}>All subscriptions</BackTo>
        <Notice tone="error">{error.status === 404 ? "That subscription wasn't found." : error.message}</Notice>
      </div>
    );
  }
  if (!sub) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24" rounded="rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-96" rounded="rounded-xl" />
          <Skeleton className="h-96" rounded="rounded-xl" />
        </div>
      </div>
    );
  }

  const done = (message) => (fresh) => {
    setSub(fresh);
    setDialog(null);
    toast(message);
  };
  const run = async (fn, message) => {
    const { subscription } = await fn();
    done(message)(subscription);
  };

  return (
    <div>
      <BackTo onClick={back}>All subscriptions</BackTo>

      <div className="mb-6 flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <h2 className="display text-[clamp(1.6rem,3.4vw,2.3rem)]">{sub.organizationName}</h2>
          <p className="mt-1.5 text-sm text-ink-secondary">
            {sub.account?.name} ·{" "}
            <a href={`mailto:${sub.account?.email}`} className="hover:text-ink-primary">
              {sub.account?.email}
            </a>{" "}
            · {sub.planName} · billed {sub.billingPeriod}
          </p>
        </div>
        <SubscriptionBadge status={sub.status} />
      </div>

      {sub.attention.length > 0 && (
        <div className="mb-5 rounded-xl border px-5 py-3.5 text-sm" style={{ borderColor: "rgb(var(--c-state-reserved) / 0.35)", background: "rgb(var(--c-state-reserved) / 0.07)" }}>
          <div className="flex flex-wrap items-center gap-2 font-bold">
            <AlertTriangle size={16} style={{ color: "rgb(var(--c-state-reserved))" }} /> Needs a person
          </div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-ink-secondary">
            {sub.attention.map((flag) => (
              <li key={flag}>
                <span className="font-semibold text-ink-primary">{flag}.</span>{" "}
                {{
                  "Needs a price": "No invoice goes out until one is agreed — set it under Plan and price.",
                  "Sync failing": "The deployment hasn't heard the latest. See Deployment.",
                  "Trial over, nothing invoiced": "The trial ended with no bill to pay, so the job leaves it alone. Issue an invoice or extend the trial.",
                  "Period over, nothing invoiced": "The paid period ended with no renewal open (voided, or the price changed). Issue one by hand.",
                  "Nothing left to pay": "It's marked late, but no invoice is open. Resume it, or issue the invoice it owes.",
                }[flag] || ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5 max-lg:order-2">
          <PlanAndPrice sub={sub} manage={manage} onSaved={setSub} />
          <AddOnsPanel sub={sub} manage={manage} onSaved={setSub} />
          <OverridesEditor sub={sub} manage={manage} onSaved={setSub} />
          <InvoicesPanel sub={sub} manage={manage} navigate={navigate} onIssued={(inv) => { load(); toast(`${inv.number} issued and emailed`); }} />
        </div>
        <div className="space-y-5 max-lg:order-1">
          <StandingPanel sub={sub} manage={manage} act={setDialog} />
          <SyncPanel sub={sub} manage={manage} onSaved={setSub} />
          <NoticeEditor sub={sub} manage={manage} onSaved={setSub} />
          <TrialEditor sub={sub} manage={manage} onSaved={setSub} />
          <HistoryPanel sub={sub} />
        </div>
      </div>

      <ReasonDialog
        open={dialog === "suspend"}
        onClose={() => setDialog(null)}
        icon={Pause}
        title={`Suspend ${sub.organizationName}?`}
        subtitle="It becomes read-only at once: everyone can sign in and look, nothing can be booked or changed. Nothing is deleted."
        label="Why — the customer is emailed this"
        placeholder="e.g. Invoice unpaid after several reminders."
        confirmLabel="Suspend"
        onConfirm={(reason) => run(() => billingApi.suspend(sub.id, reason), "Suspended — the customer has been told")}
      />
      <ReasonDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        icon={Ban}
        title={`End ${sub.organizationName}'s subscription?`}
        subtitle="Its open period invoices are voided either way, so nobody is chased for time they won't have. Data is kept."
        label="Reason"
        optional
        placeholder="e.g. Moving to another provider."
        confirmLabel={cancelWhen === "now" ? "End it now" : "End at period end"}
        onConfirm={(reason) => run(() => billingApi.cancel(sub.id, { when: cancelWhen, reason }), cancelWhen === "now" ? "Subscription ended" : "Set to end at the end of its period")}
      >
        {["active", "trialing"].includes(sub.status) && (
          <Segmented
            value={cancelWhen}
            onChange={setCancelWhen}
            options={[
              { value: "period_end", label: `At ${sub.status === "trialing" ? "trial" : "period"} end (${shortDate(sub.status === "trialing" ? sub.trialEndsAt : sub.currentPeriodEnd)})` },
              { value: "now", label: "Now" },
            ]}
          />
        )}
      </ReasonDialog>
      <ReasonDialog
        open={dialog === "resume"}
        onClose={() => setDialog(null)}
        icon={Play}
        title={`Resume ${sub.organizationName}?`}
        subtitle={
          sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > new Date()
            ? `It's paid through ${longDate(sub.currentPeriodEnd)}, so it goes straight back to active.`
            : "Nothing is paid ahead, so it comes back past due with a fresh grace period — the job won't suspend it again until that runs out."
        }
        noReason
        confirmLabel="Resume"
        confirmVariant="primary"
        onConfirm={() => run(() => billingApi.resume(sub.id), "Resumed — the customer has been told")}
      />
      <ReasonDialog
        open={dialog === "withdraw"}
        onClose={() => setDialog(null)}
        icon={Undo2}
        title="Keep it going?"
        subtitle="Withdraws the scheduled end. Any invoice that was voided for the period after it is issued again."
        noReason
        confirmLabel="Keep it going"
        confirmVariant="primary"
        onConfirm={() => run(() => billingApi.resume(sub.id), "The scheduled end is withdrawn")}
      />
    </div>
  );
}

export default function Subscriptions({ navigate, id, can, query }) {
  return id ? <SubscriptionDetail id={id} navigate={navigate} can={can} /> : <SubscriptionList navigate={navigate} can={can} query={query} />;
}
