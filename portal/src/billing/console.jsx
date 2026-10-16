import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Banknote, Plus, Receipt, Search, Trash2 } from "lucide-react";

import { Button, Modal, Notice, Textarea, Toggle } from "../components/ui.jsx";
import { SelectInput, TextInput } from "../account/kit.jsx";
import { billingApi } from "../lib/billingApi.js";
import { formatMoney } from "../lib/plans.js";
import { METHOD_LABEL, PAYMENT_METHODS, claimWaiting, fromDateInput, toDateInput, toMinor, todayInput } from "./format.js";
import { ChoicePills, MoneyInput, ToneBadge } from "./ui.jsx";

/**
 * Pieces of the staff console's billing sections: the filter row, the
 * dialogs that change money, and the subscription status in staff words.
 *
 * Every dialog here reveals its errors on submit, takes field-keyed
 * errors from the server and puts each under its own field, and leaves
 * the page behind it untouched until the change has succeeded.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/** Subscription status for staff: plain words, the same tones as the buyer's page. */
export const SUBSCRIPTION_WORDS = {
  pending: { label: "Pending", tone: "waiting" },
  trialing: { label: "Trial", tone: "info" },
  active: { label: "Active", tone: "good" },
  past_due: { label: "Past due", tone: "warning" },
  suspended: { label: "Suspended", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function SubscriptionBadge({ status, size }) {
  const words = SUBSCRIPTION_WORDS[status] || { label: status, tone: "neutral" };
  return (
    <ToneBadge tone={words.tone} size={size}>
      {words.label}
    </ToneBadge>
  );
}

/**
 * The tabs above a list, with counts. Scrolls sideways inside itself on a
 * phone rather than pushing the page wider than the screen.
 */
export function FilterTabs({ tabs, value, onChange, label = "Filter" }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label={label}>
      <div className="inline-flex gap-1.5">
        {tabs.map((t) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.value)}
              className={cx(
                "inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold transition-colors duration-fast",
                on ? "bg-bg-card text-ink-primary shadow-sm ring-1 ring-line/10" : "text-ink-secondary hover:bg-line/[0.05] hover:text-ink-primary"
              )}
            >
              {t.label}
              {t.count != null && (
                <span
                  className="min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
                  style={
                    t.alert && t.count
                      ? { background: "rgb(var(--c-state-unavailable) / 0.14)", color: "rgb(var(--c-state-unavailable))" }
                      : { background: "rgb(var(--c-line) / 0.07)", color: "rgb(var(--c-ink-secondary))" }
                  }
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="relative block w-full sm:w-72">
      <span className="sr-only">{placeholder}</span>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-full border border-line/10 bg-bg-card pl-9 pr-4 text-sm outline-none transition-colors
                   duration-fast focus:border-line/30"
      />
    </label>
  );
}

export function BackTo({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary transition-opacity hover:opacity-70"
    >
      <ArrowLeft size={15} />
      {children}
    </button>
  );
}

/** A labelled value in a detail panel. */
export function Row({ label, children, className }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-2 text-sm", className)}>
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="min-w-0 text-right font-semibold">{children}</span>
    </div>
  );
}

/** Debounced value — search boxes ask the server, not every keystroke. */
export function useDebounced(value, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * A change that needs a reason — suspend, cancel, void, dismiss a claim.
 * The reason is required unless `optional`, and is said to be read by the
 * customer whenever it is.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  label = "Reason",
  hint,
  placeholder,
  confirmLabel,
  confirmVariant = "danger",
  optional = false,
  noReason = false,
  onConfirm,
  children,
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!optional && !noReason && !reason.trim()) {
      setError("Say why — it's kept on the record.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err.fields?.reason || err.fields?.when || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      icon={icon}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant={confirmVariant} loading={busy} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {noReason ? (
          error && <Notice tone="error">{error}</Notice>
        ) : (
          <Textarea
            label={optional ? `${label} (optional)` : label}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder}
            hint={!error ? hint : undefined}
            error={error}
            data-autofocus
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * Record money received against an invoice — the ONE way an invoice
 * becomes paid. Prefilled from the buyer's claim when there is one,
 * because confirming a claim is recording what they said once it has
 * been found.
 */
export function RecordPaymentDialog({ invoice, open, onClose, onRecorded }) {
  const claim = claimWaiting(invoice) ? invoice.claim : null;
  const initial = () => ({
    method: claim?.method || "",
    amount: invoice ? (((claim?.amount ?? invoice.total) || 0) / 100).toLocaleString("en-PH", { minimumFractionDigits: (claim?.amount ?? invoice.total) % 100 ? 2 : 0 }) : "",
    reference: claim?.reference || "",
    receivedAt: claim?.paidAt ? toDateInput(claim.paidAt) : todayInput(),
    note: "",
  });
  const [form, setForm] = useState(initial);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial());
      setFields({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.id]);

  if (!invoice) return null;
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const amount = toMinor(form.amount);
  const differs = amount != null && amount !== invoice.total;

  const submit = async () => {
    const f = {};
    if (!form.method) f.method = "Choose how the money arrived.";
    if (amount == null || amount <= 0) f.amount = "Enter the amount received.";
    if (!form.receivedAt) f.receivedAt = "Enter the date it arrived.";
    if (differs && !form.note.trim()) f.note = `The invoice is for ${formatMoney(invoice.total, { currency: invoice.currency, exact: true })}. Say why a different amount settles it.`;
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const result = await billingApi.recordPayment(invoice.id, {
        method: form.method,
        amount,
        reference: form.reference.trim(),
        receivedAt: fromDateInput(form.receivedAt),
        note: form.note.trim(),
      });
      onRecorded?.(result);
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      icon={Banknote}
      title={claim ? "Confirm the payment" : "Record a payment"}
      subtitle={`${invoice.number} · ${formatMoney(invoice.total, { currency: invoice.currency, exact: true })} · ${invoice.organizationName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Banknote} loading={busy} onClick={submit}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-ink-secondary">
          Only once the money is in the account. Recording it marks the invoice paid
          {invoice.extendsSubscription ? ", activates the subscription and starts or extends its period," : ","} and emails the
          customer a receipt.
        </p>
        {claim && (
          <Notice>
            Filled in from what the customer told us: {formatMoney(claim.amount, { currency: invoice.currency, exact: true })} by{" "}
            {METHOD_LABEL[claim.method]}
            {claim.reference ? `, ref ${claim.reference}` : ""}. Check it against the statement.
          </Notice>
        )}
        <ChoicePills
          label="How it arrived"
          options={PAYMENT_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          value={form.method}
          onChange={(method) => setForm((f) => ({ ...f, method }))}
          error={fields.method}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyInput label="Amount received" value={form.amount} onChange={set("amount")} error={fields.amount} />
          <TextInput label="Received on" type="date" max={todayInput()} value={form.receivedAt} onChange={set("receivedAt")} error={fields.receivedAt} />
        </div>
        <TextInput label="Reference" optional value={form.reference} onChange={set("reference")} error={fields.reference} hint="The bank or e-wallet reference, so this can be traced." />
        <Textarea
          label={differs ? "Why a different amount settles it" : "Internal note (optional)"}
          rows={2}
          value={form.note}
          onChange={set("note")}
          error={fields.note}
          placeholder={differs ? "e.g. ₱15 bank fee deducted by the sender's bank" : "Only staff see this."}
        />
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}

const blankLine = () => ({ description: "", quantity: "1", unitAmount: "" });

/** "4,500" → 450000, "-1,000" → -100000 (a discount), anything else → null. */
const signedMinor = (text) => {
  const t = String(text ?? "").trim();
  const negative = t.startsWith("-");
  const value = toMinor(negative ? t.slice(1) : t);
  return value == null ? null : negative ? -value : value;
};

/**
 * A manual invoice: a setup fee, an agreed custom price, a correction.
 * Lines in pesos (a negative line is a discount); whether paying it buys
 * the subscription a period is an explicit choice, because a setup fee
 * must not extend anything.
 */
export function ManualInvoiceDialog({ open, onClose, onIssued, subscription = null, subscriptions = [] }) {
  const [subId, setSubId] = useState(subscription?.id || "");
  const [lines, setLines] = useState([blankLine()]);
  const [extendsPeriod, setExtendsPeriod] = useState(false);
  const [dueDays, setDueDays] = useState("");
  const [memo, setMemo] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSubId(subscription?.id || "");
    setLines([blankLine()]);
    setExtendsPeriod(false);
    setDueDays("");
    setMemo("");
    setFields({});
  }, [open, subscription?.id]);

  const chosen = subscription || subscriptions.find((s) => s.id === subId) || null;
  const total = useMemo(() => lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (signedMinor(l.unitAmount) || 0), 0), [lines]);
  const setLine = (i, key) => (e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [key]: e.target.value } : l)));

  const submit = async () => {
    const f = {};
    if (!chosen) f.subscriptionId = "Choose who this invoice is for.";
    const parsed = lines.map((l, i) => {
      const unit = signedMinor(l.unitAmount);
      if (!l.description.trim()) f[`lines.${i}.description`] = "Say what this line is for.";
      if (unit == null) f[`lines.${i}.unitAmount`] = "Enter an amount in pesos.";
      if (!/^\d+$/.test(String(l.quantity)) || Number(l.quantity) < 1) f[`lines.${i}.quantity`] = "1 or more.";
      return { description: l.description.trim(), quantity: Number(l.quantity), unitAmount: unit };
    });
    if (!Object.keys(f).length && total < 0) f.lines = "The lines add up to less than nothing.";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const { invoice } = await billingApi.issueInvoice({
        subscriptionId: chosen.id,
        lines: parsed,
        extendsSubscription: extendsPeriod,
        dueDays: dueDays === "" ? undefined : Number(dueDays),
        memo: memo.trim(),
      });
      onIssued?.(invoice);
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      icon={Receipt}
      title="New invoice"
      subtitle={chosen ? `To ${chosen.organizationName}${chosen.account?.email ? ` · ${chosen.account.email}` : ""}` : "A setup fee, an agreed price, a correction."}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-sm text-ink-secondary">
            Before VAT: <span className="font-bold tabular-nums text-ink-primary">{formatMoney(total, { exact: true })}</span>
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Receipt} loading={busy} onClick={submit}>
            Issue and email it
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!subscription && (
          <SelectInput label="For" value={subId} onChange={(e) => setSubId(e.target.value)} error={fields.subscriptionId}>
            <option value="">Choose a subscription…</option>
            {subscriptions
              .filter((s) => s.status !== "cancelled")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.organizationName} — {s.account?.email || s.planName}
                </option>
              ))}
          </SelectInput>
        )}

        <div>
          <div className="mb-1.5 grid grid-cols-[1fr_64px_120px_36px] gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted max-sm:hidden">
            <span>Description</span>
            <span>Qty</span>
            <span>Unit (₱)</span>
            <span />
          </div>
          <div className="space-y-3">
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_64px] gap-2 sm:grid-cols-[1fr_64px_120px_36px]">
                <TextInput
                  aria-label="Description"
                  placeholder="e.g. On-site set-up, half day"
                  value={line.description}
                  onChange={setLine(i, "description")}
                  error={fields[`lines.${i}.description`]}
                  className="[&>span:first-child]:hidden"
                />
                <TextInput
                  aria-label="Quantity"
                  inputMode="numeric"
                  value={line.quantity}
                  onChange={setLine(i, "quantity")}
                  error={fields[`lines.${i}.quantity`]}
                  className="[&>span:first-child]:hidden"
                />
                <TextInput
                  aria-label="Unit amount in pesos"
                  inputMode="decimal"
                  placeholder="4,500"
                  value={line.unitAmount}
                  onChange={setLine(i, "unitAmount")}
                  error={fields[`lines.${i}.unitAmount`]}
                  className="col-span-1 [&>span:first-child]:hidden"
                />
                <button
                  type="button"
                  onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))}
                  disabled={lines.length === 1}
                  aria-label="Remove line"
                  className="mt-1.5 grid h-11 w-9 place-items-center rounded-md text-ink-muted transition-colors hover:bg-line/[0.06] hover:text-ink-primary disabled:opacity-30"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          {fields.lines && <p data-field-error="" className="mt-2 text-xs font-medium text-state-unavailable">{fields.lines}</p>}
          <Button size="sm" variant="ghost" icon={Plus} className="mt-2" onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={lines.length >= 20}>
            Add a line
          </Button>
          <p className="mt-1 text-xs text-ink-muted">A negative amount is a discount. VAT is added on issue if SILLA is VAT-registered.</p>
        </div>

        <Toggle
          label="Paying this buys a billing period"
          hint={
            chosen
              ? `Activates or extends ${chosen.organizationName} by one ${chosen.billingPeriod === "monthly" ? "month" : "year"} when paid. Leave off for a one-off charge.`
              : "Activates or extends the subscription by one period when paid. Leave off for a one-off charge."
          }
          checked={extendsPeriod}
          onChange={setExtendsPeriod}
        />
        {fields.extendsSubscription && <p className="text-xs font-medium text-state-unavailable">{fields.extendsSubscription}</p>}

        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <TextInput label="Due in (days)" optional inputMode="numeric" placeholder="Default" value={dueDays} onChange={(e) => setDueDays(e.target.value)} error={fields.dueDays} />
          <TextInput label="Note on the invoice" optional value={memo} onChange={(e) => setMemo(e.target.value)} error={fields.memo} placeholder="Printed under the lines" />
        </div>
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}
