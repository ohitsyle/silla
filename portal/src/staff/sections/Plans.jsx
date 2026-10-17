import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Banknote, Layers, Plus, SlidersHorizontal, Star, Users } from "lucide-react";

import { Button, EmptyState, Notice, Panel, Skeleton, Textarea, Toggle } from "../../components/ui.jsx";
import { TextInput } from "../../account/kit.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { formatMoney, loadPlans } from "../../lib/plans.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES } from "../../lib/useHashRoute.js";
import { limitPhrase, toMinor } from "../../billing/format.js";
import { MoneyInput, ToneBadge } from "../../billing/ui.jsx";
import { BackTo } from "../../billing/console.jsx";

/**
 * Staff console — Plans: the catalogue the storefront sells from.
 *
 * A plan's FEATURES and LIMITS reach every live deployment on it the
 * moment they are saved (each client's own overrides still win) — that is
 * what a plan is. Its PRICE does not: a subscription keeps the price its
 * customer agreed, and only new orders read the catalogue. The editor
 * says which is which next to the fields, because the two kinds of change
 * look identical in a form and behave nothing alike.
 *
 * Prices are typed in pesos and stored in centavos. Both empty means
 * "priced with each customer" (Campus): orders on it wait for staff to
 * agree a price before any invoice goes out.
 *
 * plans.manage only; the console hides this section from anyone without it.
 */

const FEATURES = {
  kiosk: "Kiosk check-in and self-registration",
  reports: "Reports and CSV export",
  customBranding: "Custom colours and logo",
  wholeRoomBooking: "Booking whole rooms",
  emailReminders: "Reminder emails before a reservation",
};
const LIMITS = {
  buildings: "Buildings",
  floors: "Floors",
  rooms: "Rooms",
  resources: "Bookable units",
  members: "Members",
  staff: "Staff accounts",
};

/** Centavos to what a person types: 870000 → "8,700". */
const pesos = (minor) => (minor == null ? "" : (minor / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 }));

function PlanCard({ plan, onOpen, delay }) {
  const priced = plan.prices.monthly != null;
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className={`flex h-full flex-col rounded-xl border bg-bg-card p-5 text-left shadow-sm transition-colors duration-fast hover:border-line/25 ${
        plan.active ? "border-line/10" : "border-dashed border-line/20 opacity-80"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-lg font-extrabold tracking-tight">{plan.name}</h3>
        {plan.featured && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "rgb(var(--c-accent) / 0.12)", color: "rgb(var(--m-accent-deep))" }}>
            <Star size={11} strokeWidth={2.6} /> Featured
          </span>
        )}
        <ToneBadge tone={plan.active ? "good" : "neutral"} size="sm">
          {plan.active ? "On sale" : "Retired"}
        </ToneBadge>
      </div>
      <p className="mt-0.5 font-mono text-xs text-ink-muted">{plan.key}</p>
      <p className="mt-2 text-sm text-ink-secondary">{plan.tagline}</p>

      <div className="mt-4 rounded-lg bg-bg-panel/70 px-4 py-3">
        {priced ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted">Monthly</div>
              <div className="font-bold tabular-nums">{formatMoney(plan.prices.monthly, { currency: plan.currency })}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted">Yearly</div>
              <div className="font-bold tabular-nums">
                {formatMoney(plan.prices.annualMonthly, { currency: plan.currency })}
                <span className="text-xs font-semibold text-ink-muted">/mo</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="font-bold">Priced with each customer</div>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-muted">
        {Object.entries(plan.limits)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => limitPhrase(k, v))
          .join(" · ") || "No limits"}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-sm">
        <span className="inline-flex items-center gap-1.5 text-ink-secondary">
          <Users size={14} /> {plan.subscriptions} live subscription{plan.subscriptions === 1 ? "" : "s"}
        </span>

      </div>
    </motion.button>
  );
}

function PlanList({ navigate }) {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    billingApi
      .allPlans()
      .then((d) => setPlans(d.plans))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-ink-secondary">
          What the storefront sells. Features and limits reach every deployment on a plan when saved; a price change applies to new
          subscriptions only.
        </p>
        <Button variant="primary" icon={Plus} onClick={() => navigate(`${ROUTES.staff}/plans/new`)}>
          New plan
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!plans && !error && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-72" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {plans?.length === 0 && <EmptyState icon={Layers} title="No plans yet" />}
      {plans?.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan, i) => (
            <PlanCard key={plan.key} plan={plan} delay={i * 0.04} onOpen={() => navigate(`${ROUTES.staff}/plans/${plan.key}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── the editor ───────────────────────────── */

const toForm = (plan) => ({
  key: plan?.key || "",
  name: plan?.name || "",
  tagline: plan?.tagline || "",
  highlights: (plan?.highlights || []).join("\n"),
  featured: Boolean(plan?.featured),
  active: plan ? plan.active !== false : true,
  sort: String(plan?.sort ?? 0),
  priced: plan ? plan.prices.monthly != null : true,
  monthly: pesos(plan?.prices.monthly),
  annualMonthly: pesos(plan?.prices.annualMonthly),
  features: Object.fromEntries(Object.keys(FEATURES).map((k) => [k, plan ? plan.features[k] !== false : true])),
  limits: Object.fromEntries(
    Object.keys(LIMITS).map((k) => [k, plan ? (plan.limits[k] == null ? "" : String(plan.limits[k])) : ""])
  ),
});

function PlanEditor({ planKey, navigate }) {
  const creating = planKey === "new";
  const toast = useToast();
  const [plan, setPlan] = useState(creating ? null : undefined);
  const [form, setForm] = useState(() => toForm(null));
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (creating) return;
    billingApi
      .allPlans()
      .then((d) => {
        const found = d.plans.find((p) => p.key === planKey);
        setPlan(found || null);
        if (found) setForm(toForm(found));
      })
      .catch((e) => setError(e.message));
  }, [planKey, creating]);

  const source = useMemo(() => toForm(plan || null), [plan]);
  const dirty = creating || JSON.stringify(form) !== JSON.stringify(source);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const back = () => navigate(`${ROUTES.staff}/plans`);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (plan === undefined) return <Skeleton className="h-96" rounded="rounded-xl" />;
  if (plan === null && !creating) {
    return (
      <div>
        <BackTo onClick={back}>All plans</BackTo>
        <Notice tone="error">There is no plan called “{planKey}”.</Notice>
      </div>
    );
  }

  const monthlyMinor = toMinor(form.monthly);
  const annualMinor = toMinor(form.annualMonthly);

  const body = () => {
    const f = {};
    const out = {};
    if (creating) out.key = form.key.trim().toLowerCase();
    for (const k of ["name", "tagline"]) out[k] = form[k].trim();
    out.highlights = form.highlights.split("\n").map((s) => s.trim()).filter(Boolean);
    out.featured = form.featured;
    out.active = form.active;
    out.sort = Number(form.sort);
    if (!Number.isInteger(out.sort)) f.sort = "A whole number — lower comes first.";
    if (form.priced) {
      if (monthlyMinor == null) f["prices.monthly"] = "Enter the monthly price in pesos.";
      if (annualMinor == null) f["prices.annualMonthly"] = "Enter the per-month price on yearly billing.";
      out.prices = { monthly: monthlyMinor, annualMonthly: annualMinor };
    } else {
      out.prices = { monthly: null, annualMonthly: null };
    }
    out.features = { ...form.features };
    out.limits = Object.fromEntries(
      Object.entries(form.limits).map(([k, v]) => {
        if (v.trim() === "") return [k, null];
        if (!/^\d+$/.test(v.trim())) f[`limits.${k}`] = "A whole number, or empty for unlimited.";
        return [k, Number(v)];
      })
    );
    return { out, f };
  };

  const save = async () => {
    const { out, f } = body();
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      if (creating) {
        const { plan: created } = await billingApi.createPlan(out);
        toast(`${created.name} created`);
        navigate(`${ROUTES.staff}/plans/${created.key}`, { replace: true });
      } else {
        // Only what changed, so the audit line names exactly that.
        const changed = Object.fromEntries(Object.entries(out).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(toCompare(k, source))));
        const { plan: saved, resyncing } = await billingApi.updatePlan(planKey, Object.keys(changed).length ? changed : out);
        setPlan(saved);
        setForm(toForm(saved));
        toast(resyncing ? `Saved — pushing to ${resyncing} deployment${resyncing === 1 ? "" : "s"}` : "Saved");
      }
      loadPlans({ force: true });
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  /** The same shape `body()` builds, from the saved plan — for sending only what changed. */
  function toCompare(key, src) {
    const b = { ...src };
    if (key === "highlights") return b.highlights.split("\n").map((s) => s.trim()).filter(Boolean);
    if (key === "sort") return Number(b.sort);
    if (key === "prices") return b.priced ? { monthly: toMinor(b.monthly), annualMonthly: toMinor(b.annualMonthly) } : { monthly: null, annualMonthly: null };
    if (key === "limits") return Object.fromEntries(Object.entries(b.limits).map(([k, v]) => [k, v === "" ? null : Number(v)]));
    if (key === "name" || key === "tagline") return b[key].trim();
    return b[key];
  }

  return (
    <div className="pb-24">
      <BackTo onClick={back}>All plans</BackTo>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h2 className="display mr-auto text-[clamp(1.6rem,3.4vw,2.3rem)]">{creating ? "A new plan" : plan.name}</h2>
        {!creating && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
            <Users size={15} /> {plan.subscriptions} live subscription{plan.subscriptions === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {!creating && !plan.active && (
        <Notice className="mb-5">
          Retired: the storefront doesn't offer it and no new order can carry it. The subscriptions already on it carry on, and staff
          can still move one onto it.
        </Notice>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Panel icon={Layers} title="On the storefront" subtitle="How the pricing page presents it.">
            <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
              <TextInput label="Name" value={form.name} onChange={set("name")} error={fields.name} />
              {creating ? (
                <TextInput label="Key" value={form.key} onChange={set("key")} error={fields.key} hint="Lowercase, for good — e.g. floor-plus" />
              ) : (
                <TextInput label="Key" value={plan.key} disabled hint="Keys never change." />
              )}
              <TextInput label="Tagline" className="sm:col-span-2" value={form.tagline} onChange={set("tagline")} error={fields.tagline} />
              <Textarea
                label="Highlights — one per line"
                className="sm:col-span-2"
                rows={5}
                value={form.highlights}
                onChange={set("highlights")}
                error={fields.highlights}
              />
              <TextInput label="Order on the page" inputMode="numeric" value={form.sort} onChange={set("sort")} error={fields.sort} hint="Lower comes first" />
            </div>
            <div className="mt-5 space-y-4 border-t border-line/[0.08] pt-5">
              <Toggle label="On sale" hint="Retired plans stay for the subscriptions on them, but aren't offered." checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} />
              <Toggle label="Featured" hint="The dark card most people pick." checked={form.featured} onChange={(v) => setForm((f) => ({ ...f, featured: v }))} />
            </div>
          </Panel>

          <Panel icon={Banknote} title="Price" subtitle="In Philippine pesos, before VAT. A change applies to new subscriptions — existing customers keep the price they agreed.">
            <Toggle
              label="Has a list price"
              hint="Off for a plan priced with each customer: no invoice goes out until staff agree one."
              checked={form.priced}
              onChange={(v) => setForm((f) => ({ ...f, priced: v }))}
            />
            <AnimatePresence initial={false}>
              {form.priced && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="grid gap-4 pt-5 sm:grid-cols-2">
                    <MoneyInput label="Monthly billing — per month" value={form.monthly} onChange={set("monthly")} error={fields["prices.monthly"]} />
                    <MoneyInput
                      label="Yearly billing — per month"
                      value={form.annualMonthly}
                      onChange={set("annualMonthly")}
                      error={fields["prices.annualMonthly"]}
                      hint={annualMinor != null ? `Invoiced as ${formatMoney(annualMinor * 12, { exact: true })} a year` : "Invoiced × 12, once a year"}
                    />
                  </div>
                  {monthlyMinor > 0 && annualMinor != null && annualMinor < monthlyMinor && (
                    <p className="mt-3 text-xs text-ink-muted">
                      Yearly saves {Math.floor((1 - annualMinor / monthlyMinor) * 100)}% — the storefront shows the smallest saving across
                      plans.
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </Panel>
        </div>

        <Panel icon={SlidersHorizontal} title="What it allows" subtitle="Reaches every live deployment on this plan when saved. A client's own overrides still win.">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">Features</h3>
          <div className="space-y-3">
            {Object.entries(FEATURES).map(([k, label]) => (
              <Toggle
                key={k}
                label={label}
                checked={form.features[k]}
                onChange={(v) => setForm((f) => ({ ...f, features: { ...f.features, [k]: v } }))}
              />
            ))}
          </div>
          <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">Limits — empty is unlimited</h3>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {Object.entries(LIMITS).map(([k, label]) => (
              <TextInput
                key={k}
                label={label}
                inputMode="numeric"
                placeholder="Unlimited"
                value={form.limits[k]}
                onChange={(e) => setForm((f) => ({ ...f, limits: { ...f.limits, [k]: e.target.value } }))}
                error={fields[`limits.${k}`]}
              />
            ))}
          </div>
        </Panel>
      </div>

      {fields._form && <Notice tone="error" className="mt-5">{fields._form}</Notice>}

      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="sticky bottom-4 z-20 mt-6"
          >
            <div
              className="flex flex-wrap items-center gap-3 rounded-full border border-line/10 p-2 pl-5 shadow-md"
              style={{ background: "rgb(var(--c-bg-card) / 0.9)", backdropFilter: "saturate(180%) blur(14px)" }}
            >
              <span className="mr-auto flex items-center gap-2 text-sm text-ink-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--c-state-reserved))" }} />
                {creating ? "Not created yet" : "Unsaved changes"}
              </span>
              {!creating && (
                <Button variant="ghost" onClick={() => { setForm(source); setFields({}); }} disabled={busy}>
                  Discard
                </Button>
              )}
              <Button variant="primary" loading={busy} onClick={save}>
                {creating ? "Create plan" : "Save plan"}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Plans({ navigate, id }) {
  return id ? <PlanEditor planKey={id} navigate={navigate} /> : <PlanList navigate={navigate} />;
}
