import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Banknote, Boxes, ListChecks, Package, Plus, Users } from "lucide-react";

import { Button, EmptyState, Notice, Panel, Segmented, Skeleton, Textarea, Toggle } from "../../components/ui.jsx";
import { SelectInput, TextInput } from "../../account/kit.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { formatMoney, loadPlans } from "../../lib/plans.js";
import { iconFor, minimumTag, monthlyOf, oneTimeTag } from "../../lib/catalogue.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES } from "../../lib/useHashRoute.js";
import { toMinor } from "../../billing/format.js";
import { MoneyInput, ToneBadge } from "../../billing/ui.jsx";
import { BackTo } from "../../billing/console.jsx";

/**
 * Staff console — Plans → Catalogue: everything SILLA sells besides a
 * plan. Extra buildings, hardware, setup services and support tiers, as
 * data (vendor models/CatalogItem.js): a price, a minimum, which plans
 * offer it, what it raises in a deployment's limits.
 *
 * A change here reaches NEW quotes only. An order froze its quote when it
 * was submitted, and a subscription keeps the price agreed for each add-on
 * it carries — the editor says so beside the save, because a price field
 * looks like it should change what customers pay, and here it doesn't.
 *
 * plans.manage only, like the plans themselves; every save is on the
 * activity log.
 */

const CATEGORY = {
  building: "More buildings",
  hardware: "Hardware",
  service: "Setup and services",
  support: "Support",
};
const CHARGE = {
  one_time: "Paid once",
  recurring: "Monthly",
  buy_or_rent: "Buy or rent",
};
const LIMITS = {
  buildings: "Buildings",
  floors: "Floors",
  rooms: "Rooms",
  resources: "Bookable units",
  members: "Members",
  staff: "Staff accounts",
};
/** "+1 building each", "+50 bookable units each". */
const NOUNS = {
  buildings: ["building", "buildings"],
  floors: ["floor", "floors"],
  rooms: ["room", "rooms"],
  resources: ["bookable unit", "bookable units"],
  members: ["member", "members"],
  staff: ["staff account", "staff accounts"],
};
const raiseWord = (key, n) => `+${n} ${(NOUNS[key] || [key, key])[n === 1 ? 0 : 1]} each`;

/** Centavos to what a person types: 300000 → "3,000". */
const pesos = (minor) => (minor == null ? "" : (minor / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 }));

/** The price, said the way the storefront says it. */
function priceLine(item) {
  if (item.charge === "one_time") return oneTimeTag(item);
  const monthly = monthlyOf(item, false);
  const yearly = monthlyOf(item, true);
  const rent = monthly == null ? "—" : monthly === 0 ? "Included" : formatMoney(monthly, { period: "month", currency: item.currency });
  const yearlyNote = yearly != null && yearly !== monthly ? ` (${formatMoney(yearly, { currency: item.currency })} billed yearly)` : "";
  if (item.charge === "recurring") return `${rent}${yearlyNote}`;
  return `${formatMoney(item.prices.oneTime, { currency: item.currency })} to buy · ${rent} to rent${yearlyNote}`;
}

/** The rules an item follows, as short chips. */
function rulesOf(item, plans) {
  const name = (key) => plans.find((p) => p.key === key)?.name || key;
  return [
    minimumTag(item),
    item.maxQuantity === 1 ? "One per order" : item.maxQuantity ? `Up to ${item.maxQuantity}` : null,
    item.plans?.length ? `${item.plans.map(name).join(" & ")} only` : null,
    item.group ? `Choose one: ${item.group}${item.groupDefault ? " (default)" : ""}` : null,
    item.alwaysIncluded ? "On every order" : null,
    item.waivedOnYearly ? "Waived on yearly" : null,
    item.rentalMinimumMonths ? `${item.rentalMinimumMonths}-month rental minimum` : null,
    ...Object.entries(item.adds || {}).map(([k, n]) => raiseWord(k, n)),
  ].filter(Boolean);
}

export function CatalogueList({ navigate }) {
  const [items, setItems] = useState(null);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    Promise.all([billingApi.allCatalogue(), billingApi.allPlans()])
      .then(([c, p]) => {
        setItems(c.catalogue);
        setPlans(p.plans);
      })
      .catch((e) => setError(e.message));
  }, []);

  const grouped = useMemo(
    () => Object.keys(CATEGORY).map((category) => [category, (items || []).filter((i) => i.category === category)]),
    [items]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-ink-secondary">
          Everything sold besides a plan. A change reaches new quotes only — submitted orders keep their frozen quote, and subscriptions keep
          the price agreed for each add-on.
        </p>
        <Button variant="primary" icon={Plus} onClick={() => navigate(`${ROUTES.staff}/plans/catalogue:new`)}>
          New item
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!items && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {items?.length === 0 && <EmptyState icon={Boxes} title="Nothing in the catalogue" />}
      {items?.length > 0 &&
        grouped
          .filter(([, list]) => list.length)
          .map(([category, list]) => (
            <section key={category}>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">{CATEGORY[category]}</h3>
              <ul className="divide-y divide-line/[0.07] overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
                {list.map((item, i) => {
                  const Icon = iconFor(item);
                  return (
                    <motion.li key={item.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.02 }}>
                      <button
                        type="button"
                        onClick={() => navigate(`${ROUTES.staff}/plans/catalogue:${item.key}`)}
                        className={`flex w-full items-start gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-line/[0.03] ${item.active ? "" : "opacity-70"}`}
                      >
                        <span
                          className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[11px]"
                          style={{ background: "rgb(var(--c-accent) / 0.1)", color: "var(--color-accent)" }}
                        >
                          <Icon size={17} strokeWidth={2.2} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-bold">{item.name}</span>
                            <span className="font-mono text-xs text-ink-muted">{item.key}</span>
                            {!item.active && (
                              <ToneBadge tone="neutral" size="sm">
                                Retired
                              </ToneBadge>
                            )}
                          </span>
                          <span className="mt-0.5 block text-sm font-semibold tabular-nums text-ink-secondary">{priceLine(item)}</span>
                          <span className="mt-1.5 flex flex-wrap gap-1.5">
                            {rulesOf(item, plans).map((rule) => (
                              <span key={rule} className="rounded-full bg-line/[0.06] px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
                                {rule}
                              </span>
                            ))}
                          </span>
                        </span>
                        {item.subscriptions > 0 && (
                          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-ink-muted sm:inline-flex">
                            <Users size={13} /> {item.subscriptions}
                          </span>
                        )}
                      </button>
                    </motion.li>
                  );
                })}
              </ul>
            </section>
          ))}
    </div>
  );
}

/* ───────────────────────────── the editor ───────────────────────────── */

const toForm = (item) => ({
  key: item?.key || "",
  name: item?.name || "",
  description: item?.description || "",
  highlights: (item?.highlights || []).join("\n"),
  category: item?.category || "hardware",
  charge: item?.charge || "one_time",
  unitOne: item?.unit?.one || "",
  unitMany: item?.unit?.many || "",
  oneTime: pesos(item?.prices?.oneTime),
  monthly: pesos(item?.prices?.monthly),
  annualMonthly: pesos(item?.prices?.annualMonthly),
  minQuantity: String(item?.minQuantity ?? 1),
  maxQuantity: item?.maxQuantity == null ? "" : String(item.maxQuantity),
  plans: [...(item?.plans || [])],
  group: item?.group || "",
  groupDefault: Boolean(item?.groupDefault),
  adds: Object.fromEntries(Object.keys(LIMITS).map((k) => [k, item?.adds?.[k] ? String(item.adds[k]) : ""])),
  note: item?.note || "",
  waivedOnYearly: Boolean(item?.waivedOnYearly),
  alwaysIncluded: Boolean(item?.alwaysIncluded),
  rentalMinimumMonths: item?.rentalMinimumMonths ? String(item.rentalMinimumMonths) : "",
  sort: String(item?.sort ?? 0),
  active: item ? item.active !== false : true,
});

/**
 * The API body for a form — the whole item. Prices that don't apply to
 * how it is charged are sent empty, so a monthly item doesn't carry a
 * stray one-time price. Client checks are only for numbers; the server
 * checks the item as a whole.
 */
function bodyOf(form, { creating }) {
  const fields = {};
  const out = {};
  if (creating) out.key = form.key.trim().toLowerCase();
  out.name = form.name.trim();
  out.description = form.description.trim();
  out.highlights = form.highlights.split("\n").map((s) => s.trim()).filter(Boolean);
  out.category = form.category;
  out.charge = form.charge;
  out.unit = { one: form.unitOne.trim(), many: form.unitMany.trim() };
  const price = (text, key, { optional = false } = {}) => {
    if (!String(text).trim()) return optional ? null : null;
    const minor = toMinor(text);
    if (minor == null) fields[`prices.${key}`] = "An amount in pesos, like 1,500.";
    return minor;
  };
  out.prices = {
    oneTime: form.charge === "recurring" ? null : price(form.oneTime, "oneTime"),
    monthly: form.charge === "one_time" ? null : price(form.monthly, "monthly"),
    annualMonthly: form.charge === "one_time" ? null : price(form.annualMonthly, "annualMonthly", { optional: true }),
  };
  const whole = (text, key, { empty = null } = {}) => {
    const t = String(text).trim();
    if (!t) return empty;
    if (!/^\d+$/.test(t)) fields[key] = "A whole number.";
    return Number(t);
  };
  out.minQuantity = whole(form.minQuantity, "minQuantity", { empty: 1 });
  out.maxQuantity = whole(form.maxQuantity, "maxQuantity");
  out.plans = form.plans;
  out.group = form.group.trim().toLowerCase();
  out.groupDefault = Boolean(out.group) && form.groupDefault;
  out.adds =
    form.charge === "recurring"
      ? Object.fromEntries(
          Object.entries(form.adds)
            .map(([k, v]) => [k, whole(v, `adds.${k}`)])
            .filter(([, n]) => n)
        )
      : {};
  out.note = form.note.trim();
  out.waivedOnYearly = form.charge === "one_time" && form.waivedOnYearly;
  out.alwaysIncluded = form.alwaysIncluded;
  out.rentalMinimumMonths = form.charge === "buy_or_rent" ? whole(form.rentalMinimumMonths, "rentalMinimumMonths", { empty: 0 }) : 0;
  out.sort = Number(form.sort);
  if (!Number.isInteger(out.sort)) fields.sort = "A whole number — lower comes first.";
  out.active = form.active;
  return { out, fields };
}

export function CatalogueEditor({ itemKey, navigate }) {
  const creating = itemKey === "new";
  const toast = useToast();
  const [item, setItem] = useState(creating ? null : undefined);
  const [plans, setPlans] = useState([]);
  const [form, setForm] = useState(() => toForm(null));
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([creating ? null : billingApi.allCatalogue(), billingApi.allPlans()])
      .then(([c, p]) => {
        setPlans(p.plans);
        if (creating) return;
        const found = c.catalogue.find((i) => i.key === itemKey);
        setItem(found || null);
        if (found) setForm(toForm(found));
      })
      .catch((e) => setError(e.message));
  }, [itemKey, creating]);

  const source = useMemo(() => toForm(item || null), [item]);
  const dirty = creating || JSON.stringify(form) !== JSON.stringify(source);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const flag = (key) => (v) => setForm((f) => ({ ...f, [key]: v }));
  const back = () => navigate(`${ROUTES.staff}/plans?view=catalogue`);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (item === undefined) return <Skeleton className="h-96" rounded="rounded-xl" />;
  if (item === null && !creating) {
    return (
      <div>
        <BackTo onClick={back}>The catalogue</BackTo>
        <Notice tone="error">There is nothing in the catalogue called “{itemKey}”.</Notice>
      </div>
    );
  }

  const save = async () => {
    const { out, fields: f } = bodyOf(form, { creating });
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      if (creating) {
        const { item: created } = await billingApi.createCatalogItem(out);
        toast(`${created.name} added to the catalogue`);
        navigate(`${ROUTES.staff}/plans/catalogue:${created.key}`, { replace: true });
      } else {
        // Only what changed, so the activity log names exactly that.
        const before = bodyOf(source, { creating: false }).out;
        const changed = Object.fromEntries(Object.entries(out).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
        const { item: saved } = await billingApi.updateCatalogItem(itemKey, changed);
        setItem(saved);
        setForm(toForm(saved));
        toast("Saved — new quotes use it now");
      }
      loadPlans({ force: true });
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  const charge = form.charge;
  const togglePlan = (key) =>
    setForm((f) => ({ ...f, plans: f.plans.includes(key) ? f.plans.filter((k) => k !== key) : [...f.plans, key] }));
  const Icon = iconFor({ key: form.key, category: form.category });

  return (
    <div className="pb-24">
      <BackTo onClick={back}>The catalogue</BackTo>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-[13px]" style={{ background: "rgb(var(--c-accent) / 0.1)", color: "var(--color-accent)" }}>
          <Icon size={20} strokeWidth={2.2} />
        </span>
        <h2 className="display mr-auto text-[clamp(1.6rem,3.4vw,2.3rem)]">{creating ? "A new item" : item.name}</h2>
        {!creating && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
            <Users size={15} /> {item.subscriptions} live subscription{item.subscriptions === 1 ? " carries" : "s carry"} it
          </span>
        )}
      </div>
      {!creating && !item.active && (
        <Notice className="mb-5">Retired: no new quote can include it. Subscriptions that carry it keep it, at the price they agreed.</Notice>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Panel icon={Package} title="What it is" subtitle="The name is what an invoice line says; the rest is what the storefront says.">
            <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
              <TextInput label="Name" value={form.name} onChange={set("name")} error={fields.name} />
              {creating ? (
                <TextInput label="Key" value={form.key} onChange={set("key")} error={fields.key} hint="Lowercase, for good — e.g. lanyard" />
              ) : (
                <TextInput label="Key" value={item.key} disabled hint="Keys never change." />
              )}
              <SelectInput label="Kind" value={form.category} onChange={set("category")} error={fields.category}>
                {Object.entries(CATEGORY).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectInput>
              <TextInput label="Order on the page" inputMode="numeric" value={form.sort} onChange={set("sort")} error={fields.sort} hint="Lower comes first" />
              <Textarea label="Description" className="sm:col-span-2" rows={2} value={form.description} onChange={set("description")} error={fields.description} />
              <TextInput
                label="Note"
                optional
                className="sm:col-span-2"
                value={form.note}
                onChange={set("note")}
                error={fields.note}
                hint="The one thing to know before buying — a warranty, “travel is billed at cost”. Printed with the price and on the invoice."
              />
              <Textarea
                label="Points for a comparison — one per line"
                className="sm:col-span-2"
                rows={3}
                value={form.highlights}
                onChange={set("highlights")}
                error={fields.highlights}
              />
            </div>
            <div className="mt-5 border-t border-line/[0.08] pt-5">
              <Toggle label="On sale" hint="A retired item stays on the subscriptions that carry it, but no new quote includes it." checked={form.active} onChange={flag("active")} />
            </div>
          </Panel>

          <Panel icon={Banknote} title="Price" subtitle="In Philippine pesos, before VAT. Reaches new quotes only.">
            <span className="text-sm text-ink-secondary">How it is charged</span>
            <div className="mt-1.5">
              <Segmented
                value={charge}
                onChange={(v) => setForm((f) => ({ ...f, charge: v }))}
                options={Object.entries(CHARGE).map(([value, label]) => ({ value, label }))}
              />
            </div>
            {fields.charge && <p data-field-error="" className="mt-1 text-xs font-medium text-state-unavailable">{fields.charge}</p>}
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {charge !== "recurring" && (
                <MoneyInput
                  label={charge === "buy_or_rent" ? "To buy, each" : "Price, each"}
                  value={form.oneTime}
                  onChange={set("oneTime")}
                  error={fields["prices.oneTime"]}
                />
              )}
              {charge !== "one_time" && (
                <MoneyInput
                  label={charge === "buy_or_rent" ? "Rent per month" : "Per month"}
                  value={form.monthly}
                  onChange={set("monthly")}
                  error={fields["prices.monthly"]}
                  hint={charge === "recurring" ? "0 for something included at no charge." : null}
                />
              )}
              {charge !== "one_time" && (
                <MoneyInput
                  label="Per month, billed yearly"
                  optional
                  value={form.annualMonthly}
                  onChange={set("annualMonthly")}
                  error={fields["prices.annualMonthly"]}
                  hint="Empty: the same as monthly."
                />
              )}
              {charge === "buy_or_rent" && (
                <TextInput
                  label="Minimum rental, months"
                  optional
                  inputMode="numeric"
                  value={form.rentalMinimumMonths}
                  onChange={set("rentalMinimumMonths")}
                  error={fields.rentalMinimumMonths}
                  hint="Stated on every quote that rents it."
                />
              )}
            </div>
            {charge === "one_time" && (
              <div className="mt-5 border-t border-line/[0.08] pt-5">
                <Toggle
                  label="Waived on yearly billing"
                  hint="Free when the customer bills yearly — like onboarding."
                  checked={form.waivedOnYearly}
                  onChange={flag("waivedOnYearly")}
                />
                {fields.waivedOnYearly && <p data-field-error="" className="mt-1 text-xs font-medium text-state-unavailable">{fields.waivedOnYearly}</p>}
              </div>
            )}
          </Panel>
        </div>

        <Panel icon={ListChecks} title="Rules" subtitle="What a quote enforces — in the configurator and again on the server.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="One is called" placeholder="card" value={form.unitOne} onChange={set("unitOne")} error={fields["unit.one"]} />
            <TextInput label="More than one are called" placeholder="cards" value={form.unitMany} onChange={set("unitMany")} error={fields["unit.many"]} />
            <TextInput label="Minimum per order" inputMode="numeric" value={form.minQuantity} onChange={set("minQuantity")} error={fields.minQuantity} />
            <TextInput
              label="Most per order"
              optional
              inputMode="numeric"
              placeholder="No limit"
              value={form.maxQuantity}
              onChange={set("maxQuantity")}
              error={fields.maxQuantity}
            />
          </div>

          <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">Offered on</h3>
          <div className="flex flex-wrap gap-2">
            {plans.map((p) => {
              const on = form.plans.includes(p.key);
              return (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => togglePlan(p.key)}
                  className="h-9 rounded-full border-2 px-3.5 text-sm font-semibold transition-colors duration-fast"
                  style={on ? { borderColor: "var(--color-accent)", background: "rgb(var(--c-accent) / 0.1)" } : { borderColor: "rgb(var(--c-line) / 0.1)" }}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
          <p className={`mt-1.5 text-xs ${fields.plans ? "font-medium text-state-unavailable" : "text-ink-muted"}`} data-field-error={fields.plans ? "" : undefined}>
            {fields.plans || (form.plans.length ? "Only these plans can order it." : "None chosen: every plan can order it.")}
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <TextInput
              label="Group"
              optional
              placeholder="support"
              value={form.group}
              onChange={set("group")}
              error={fields.group}
              hint="Items in a group are one-per-order choices."
            />
          </div>
          <div className="mt-4 space-y-4">
            {form.group.trim() && (
              <Toggle
                label="The group's default"
                hint="What an order carries when nothing in the group is chosen — Standard support."
                checked={form.groupDefault}
                onChange={flag("groupDefault")}
              />
            )}
            {fields.groupDefault && <p data-field-error="" className="text-xs font-medium text-state-unavailable">{fields.groupDefault}</p>}
            <Toggle label="On every order" hint="Added to every quote once, whatever is chosen — onboarding." checked={form.alwaysIncluded} onChange={flag("alwaysIncluded")} />
            {fields.alwaysIncluded && <p data-field-error="" className="text-xs font-medium text-state-unavailable">{fields.alwaysIncluded}</p>}
          </div>

          <AnimatePresence initial={false}>
            {charge === "recurring" && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">Raises the deployment's limits, per unit</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                  {Object.entries(LIMITS).map(([k, label]) => (
                    <TextInput
                      key={k}
                      label={label}
                      inputMode="numeric"
                      placeholder="—"
                      value={form.adds[k]}
                      onChange={(e) => setForm((f) => ({ ...f, adds: { ...f.adds, [k]: e.target.value } }))}
                      error={fields[`adds.${k}`]}
                    />
                  ))}
                </div>
                <p className={`mt-1.5 text-xs ${fields.adds ? "font-medium text-state-unavailable" : "text-ink-muted"}`}>
                  {fields.adds || "An extra building adds 1 building. Pushed to the deployment as soon as a subscription carries it."}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </div>

      {fields._form && (
        <Notice tone="error" className="mt-5">
          {fields._form}
        </Notice>
      )}

      <AnimatePresence>
        {dirty && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className="sticky bottom-4 z-20 mt-6">
            <div
              className="flex flex-wrap items-center gap-3 rounded-full border border-line/10 p-2 pl-5 shadow-md"
              style={{ background: "rgb(var(--c-bg-card) / 0.9)", backdropFilter: "saturate(180%) blur(14px)" }}
            >
              <span className="mr-auto flex items-center gap-2 text-sm text-ink-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--c-state-reserved))" }} />
                {creating ? "Not added yet" : "Unsaved — reaches new quotes only"}
              </span>
              {!creating && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setForm(source);
                    setFields({});
                  }}
                  disabled={busy}
                >
                  Discard
                </Button>
              )}
              <Button variant="primary" loading={busy} onClick={save}>
                {creating ? "Add to the catalogue" : "Save"}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
