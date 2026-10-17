import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, CalendarRange, FileText, Plus, Trash2, Wallet } from "lucide-react";

import { Button, Notice, Panel, Skeleton, Textarea, Toggle } from "../../components/ui.jsx";
import { TextInput } from "../../account/kit.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { useToast } from "../../lib/toast.jsx";
import { HowToPay } from "../../billing/ui.jsx";

/**
 * Staff console — Settings: SILLA's own business, as invoices print it.
 *
 * Four groups, and each saves on its own — one Save for the page means a
 * typo in a bank account blocks a VAT change, and nobody can tell which of
 * twelve edits failed. The server validates and audits each group
 * (services/billing.js updateSettings).
 *
 * What changes what:
 *   business  printed on invoices issued FROM NOW; an invoice already sent
 *             keeps the details (and the VAT) it was issued with
 *   payment   shown on every open invoice and the billing page at once —
 *             deliberately not frozen: how to pay is whatever works today
 *   invoice   the next number's prefix, the payment terms, the footer
 *   billing   the rhythm the billing job runs to
 *
 * settings.manage only; the console hides this section from anyone else.
 */

const GROUP_FIELDS = (fields, group) =>
  Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith(`${group}.`)).map(([k, v]) => [k.slice(group.length + 1), v]));

/** Draft, dirty, save and discard for one group. */
function useGroup(group, source, onSaved) {
  const toast = useToast();
  const [draft, setDraft] = useState(source);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(source);
    setFields({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(source)]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(source);
  const save = async (payload, message) => {
    setBusy(true);
    setFields({});
    try {
      const { settings } = await billingApi.saveSettings({ [group]: payload });
      onSaved(settings);
      toast(message);
    } catch (err) {
      const mine = GROUP_FIELDS(err.fields || {}, group);
      setFields(Object.keys(mine).length ? mine : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };
  return { draft, setDraft, dirty, busy, fields, setFields, save, discard: () => { setDraft(source); setFields({}); } };
}

function SaveBar({ g, onSave }) {
  return (
    <AnimatePresence initial={false}>
      {(g.dirty || g.fields._form) && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          {g.fields._form && <Notice tone="error" className="mt-4">{g.fields._form}</Notice>}
          {g.dirty && (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line/[0.08] pt-4">
              <span className="mr-auto flex items-center gap-2 text-sm text-ink-secondary">
                <span className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--c-state-reserved))" }} />
                Unsaved changes
              </span>
              <Button variant="ghost" onClick={g.discard} disabled={g.busy}>
                Discard
              </Button>
              <Button variant="primary" loading={g.busy} onClick={onSave}>
                Save
              </Button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Business({ settings, onSaved }) {
  const source = useMemo(
    () => ({
      name: settings.business.name,
      address: settings.business.address.join("\n"),
      email: settings.business.email,
      phone: settings.business.phone,
      taxId: settings.business.taxId,
      vatRegistered: settings.business.vatRegistered,
      vatRate: String(Math.round(settings.business.vatRate * 10000) / 100),
    }),
    [settings]
  );
  const g = useGroup("business", source, onSaved);
  const d = g.draft;
  const set = (key) => (e) => g.setDraft((x) => ({ ...x, [key]: e.target.value }));
  const save = () => {
    const f = {};
    if (!d.name.trim()) f.name = "Enter the name invoices are issued under.";
    const rate = Number(d.vatRate);
    if (d.vatRegistered && (!Number.isFinite(rate) || rate <= 0 || rate > 50)) f.vatRate = "A rate between 0 and 50%.";
    if (d.vatRegistered && !d.taxId.trim()) f.taxId = "A VAT-registered invoice must carry your TIN.";
    if (Object.keys(f).length) {
      g.setFields(f); // revealed on Save, never before
      return;
    }
    g.save(
      { name: d.name, address: d.address, email: d.email, phone: d.phone, taxId: d.taxId, vatRegistered: d.vatRegistered, vatRate: (Number(d.vatRate) || 12) / 100 },
      "Business details saved — new invoices carry them"
    );
  };
  return (
    <Panel icon={Building2} title="Business details" subtitle="Who invoices are issued by. Applies to invoices issued from now; ones already sent keep what they said.">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label="Registered name" className="sm:col-span-2" value={d.name} onChange={set("name")} error={g.fields.name} />
        <Textarea label="Address — one line per row" className="sm:col-span-2" rows={3} value={d.address} onChange={set("address")} error={g.fields.address} />
        <TextInput label="Billing email" type="email" value={d.email} onChange={set("email")} error={g.fields.email} />
        <TextInput label="Phone" optional type="tel" value={d.phone} onChange={set("phone")} error={g.fields.phone} />
        <TextInput label="TIN" optional={!d.vatRegistered} className="sm:col-span-2" placeholder="000-000-000-00000" value={d.taxId} onChange={set("taxId")} error={g.fields.taxId} />
      </div>
      <div className="mt-5 flex flex-wrap items-start gap-4 rounded-lg bg-bg-panel/60 p-4">
        <Toggle
          className="mr-auto"
          label="VAT-registered"
          hint={d.vatRegistered ? "VAT is added on top of every new invoice, and the storefront says “plus VAT”." : "No VAT is charged; invoices say they're not valid for claim of input tax."}
          checked={d.vatRegistered}
          onChange={(v) => g.setDraft((x) => ({ ...x, vatRegistered: v }))}
        />
        {d.vatRegistered && (
          <TextInput label="Rate (%)" className="w-28" inputMode="decimal" value={d.vatRate} onChange={set("vatRate")} error={g.fields.vatRate} />
        )}
      </div>
      <SaveBar g={g} onSave={save} />
    </Panel>
  );
}

function Payment({ settings, onSaved }) {
  const source = useMemo(
    () => ({ instructions: settings.payment.instructions, methods: settings.payment.methods.map((m) => ({ label: m.label, details: m.details })) }),
    [settings]
  );
  const g = useGroup("payment", source, onSaved);
  const d = g.draft;
  const setMethod = (i, key) => (e) => g.setDraft((x) => ({ ...x, methods: x.methods.map((m, j) => (j === i ? { ...m, [key]: e.target.value } : m)) }));
  return (
    <Panel icon={Wallet} title="How customers pay" subtitle="On every open invoice and the billing page, straight away — how to pay is whatever works today.">
      <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div>
          <div className="space-y-3">
            {d.methods.map((m, i) => (
              <div key={i} className="rounded-lg border border-line/10 p-3.5">
                <div className="flex items-start gap-2">
                  <TextInput label="Method" className="flex-1" placeholder="BDO bank transfer" value={m.label} onChange={setMethod(i, "label")} error={g.fields[`methods.${i}.label`]} />
                  <button
                    type="button"
                    aria-label={`Remove ${m.label || "this method"}`}
                    onClick={() => g.setDraft((x) => ({ ...x, methods: x.methods.filter((_, j) => j !== i) }))}
                    className="mt-7 grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-line/[0.06] hover:text-state-unavailable"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <Textarea
                  label="Details"
                  className="mt-3"
                  rows={2}
                  placeholder={"Account name and number"}
                  value={m.details}
                  onChange={setMethod(i, "details")}
                  error={g.fields[`methods.${i}.details`]}
                />
              </div>
            ))}
          </div>
          {g.fields.methods && <p className="mt-2 text-xs font-medium text-state-unavailable">{g.fields.methods}</p>}
          <Button size="sm" variant="ghost" icon={Plus} className="mt-3" disabled={d.methods.length >= 10} onClick={() => g.setDraft((x) => ({ ...x, methods: [...x.methods, { label: "", details: "" }] }))}>
            Add a method
          </Button>
          <Textarea label="Instructions" className="mt-4" rows={3} value={d.instructions} onChange={(e) => g.setDraft((x) => ({ ...x, instructions: e.target.value }))} error={g.fields.instructions} placeholder="Send the exact amount, then press “I've paid” on the invoice…" />
        </div>
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">What a customer sees</div>
          <div className="rounded-xl bg-bg-panel/60 p-4">
            <HowToPay compact columns={1} instructions={d.instructions} methods={d.methods.filter((m) => m.label.trim())} contact={{ email: settings.business.email, phone: settings.business.phone }} invoiceNumber={`${settings.invoice.prefix}-${new Date().getFullYear()}-00042`} />
          </div>
        </div>
      </div>
      <SaveBar
        g={g}
        onSave={() =>
          g.save(
            { instructions: d.instructions, methods: d.methods.map((m) => ({ label: m.label.trim(), details: m.details.trim() })) },
            "Payment details saved — every open invoice shows them now"
          )
        }
      />
    </Panel>
  );
}

function Invoices({ settings, onSaved }) {
  const source = useMemo(
    () => ({ prefix: settings.invoice.prefix, dueDays: String(settings.invoice.dueDays), footer: settings.invoice.footer }),
    [settings]
  );
  const g = useGroup("invoice", source, onSaved);
  const d = g.draft;
  const year = new Date().getFullYear();
  return (
    <Panel icon={FileText} title="Invoices" subtitle="Numbering, payment terms and the line at the foot of every invoice.">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label="Number prefix"
          value={d.prefix}
          onChange={(e) => g.setDraft((x) => ({ ...x, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))}
          error={g.fields.prefix}
          hint={`Next numbers look like ${d.prefix || "…"}-${year}-00042. The count carries on whatever the prefix.`}
        />
        <TextInput label="Due after (days)" inputMode="numeric" value={d.dueDays} onChange={(e) => g.setDraft((x) => ({ ...x, dueDays: e.target.value }))} error={g.fields.dueDays} hint="A renewal is never due before its period begins." />
        <Textarea label="Footer (optional)" className="sm:col-span-2" rows={2} value={d.footer} onChange={(e) => g.setDraft((x) => ({ ...x, footer: e.target.value }))} error={g.fields.footer} placeholder="Thank you — questions about this invoice? Write to billing@…" />
      </div>
      <SaveBar g={g} onSave={() => g.save({ prefix: d.prefix, dueDays: Number(d.dueDays), footer: d.footer }, "Invoice settings saved")} />
    </Panel>
  );
}

function Rhythm({ settings, onSaved }) {
  const source = useMemo(
    () => ({
      trialDays: String(settings.billing.trialDays),
      graceDays: String(settings.billing.graceDays),
      renewalNoticeDays: String(settings.billing.renewalNoticeDays),
    }),
    [settings]
  );
  const g = useGroup("billing", source, onSaved);
  const d = g.draft;
  const set = (key) => (e) => g.setDraft((x) => ({ ...x, [key]: e.target.value }));
  const days = (v) => `${v || "…"} day${String(v) === "1" ? "" : "s"}`;
  const steps = [
    ["Goes live", Number(d.trialDays) ? `Free for ${days(d.trialDays)}` : "No trial", "good"],
    ["Unpaid", `Works for ${days(d.graceDays)} more`, "warning"],
    ["Still unpaid", "Read-only. Nothing deleted.", "bad"],
  ];
  return (
    <Panel icon={CalendarRange} title="Billing rhythm" subtitle="What the billing job runs to. Changes apply to the next date it works out, not to ones already set.">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextInput label="Free trial (days)" inputMode="numeric" value={d.trialDays} onChange={set("trialDays")} error={g.fields.trialDays} />
        <TextInput label="Grace period (days)" inputMode="numeric" value={d.graceDays} onChange={set("graceDays")} error={g.fields.graceDays} />
        <TextInput label="Renewal notice (days)" inputMode="numeric" value={d.renewalNoticeDays} onChange={set("renewalNoticeDays")} error={g.fields.renewalNoticeDays} />
      </div>
      <ol className="mt-5 grid gap-2 sm:grid-cols-3">
        {steps.map(([title, body, tone], i) => (
          <li key={title} className="relative rounded-lg bg-bg-panel/60 px-4 py-3">
            <span
              className="mb-1.5 block h-1.5 w-10 rounded-full"
              style={{ background: `rgb(var(${tone === "good" ? "--c-state-available" : tone === "warning" ? "--c-state-reserved" : "--c-state-unavailable"}))` }}
            />
            <div className="text-xs font-bold uppercase tracking-[0.08em] text-ink-muted">
              {i + 1}. {title}
            </div>
            <div className="mt-0.5 text-sm font-semibold">{body}</div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-muted">
        Renewal invoices go out {days(d.renewalNoticeDays)} before a paid period ends, and are due when the new period begins.
      </p>
      <SaveBar
        g={g}
        onSave={() =>
          g.save(
            { trialDays: Number(d.trialDays), graceDays: Number(d.graceDays), renewalNoticeDays: Number(d.renewalNoticeDays) },
            "Billing rhythm saved"
          )
        }
      />
    </Panel>
  );
}

export default function SettingsSection() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    billingApi
      .settings()
      .then((d) => setSettings(d.settings))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!settings) {
    return (
      <div className="grid gap-5 xl:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-80" rounded="rounded-xl" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <div className="space-y-5">
        <Business settings={settings} onSaved={setSettings} />
        <Invoices settings={settings} onSaved={setSettings} />
        <Rhythm settings={settings} onSaved={setSettings} />
      </div>
      <Payment settings={settings} onSaved={setSettings} />
    </div>
  );
}
