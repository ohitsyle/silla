import { useEffect, useId, useState } from "react";
import { motion } from "framer-motion";
import { Check, CircleCheck, Copy, Landmark, Mail, Phone, Send } from "lucide-react";

import { Button, Modal, Notice, Textarea } from "../components/ui.jsx";
import { TextInput } from "../account/kit.jsx";
import { billingApi } from "../lib/billingApi.js";
import { formatMoney } from "../lib/plans.js";
import { CLAIM_METHODS, METHOD_LABEL, TONE_CHANNEL, fromDateInput, invoiceState, toMinor, todayInput } from "./format.js";

/**
 * The billing pieces both sides use — the buyer's billing page and
 * invoice, and the staff console's subscriptions and invoices. Built from
 * components/ui.jsx and account/kit.jsx rather than beside them, so a
 * focus ring or a field error reads the same here as everywhere else.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/** A status said in words and colour — never colour alone. */
export function ToneBadge({ tone = "neutral", children, className, size = "md" }) {
  const channel = TONE_CHANNEL[tone] || TONE_CHANNEL.neutral;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-bold",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        className
      )}
      style={{ background: `rgb(var(${channel}) / 0.14)`, color: `rgb(var(${channel}))` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(var(${channel}))` }} />
      {children}
    </span>
  );
}

/** `withDue={false}` says "Open" rather than "Due Oct 31" — for a table that has a due column of its own. */
export function InvoiceBadge({ invoice, size, withDue = true }) {
  const state = invoiceState(invoice);
  const { tone } = state;
  const label = !withDue && /^Due /.test(state.label) ? "Open" : state.label;
  return (
    <ToneBadge tone={tone} size={size}>
      {label}
    </ToneBadge>
  );
}

/** A labelled fact in a card: "Paid through / October 31, 2026". */
export function Fact({ label, children, className }) {
  return (
    <div className={cx("min-w-0 rounded-lg bg-bg-panel/70 px-4 py-3", className)}>
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">{label}</div>
      <div className="mt-1 truncate font-bold">{children}</div>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  if (!value || !navigator.clipboard) return null;
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true), () => {})}
      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-ink-secondary
                 transition-colors hover:bg-line/[0.07] hover:text-ink-primary print:hidden"
      aria-label={`${label}: ${value}`}
    >
      {copied ? <Check size={13} strokeWidth={3} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * How to pay, from SILLA's settings: each method with its account details,
 * the free-text instructions, and the one rule that makes a transfer
 * findable — quote the invoice number.
 */
export function HowToPay({ instructions = "", methods = [], contact = {}, invoiceNumber, compact = false, columns = 3 }) {
  const nothing = !methods.length && !String(instructions).trim();
  return (
    <div className={compact ? "" : "rounded-xl border border-line/10 bg-bg-card p-6 shadow-sm"}>
      {!compact && (
        <div className="mb-4 flex items-center gap-3">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
            style={{ background: "rgb(var(--c-accent) / 0.11)", color: "var(--color-accent)" }}
          >
            <Landmark size={19} strokeWidth={2.2} />
          </span>
          <div>
            <h2 className="text-lg font-extrabold tracking-tight">How to pay</h2>
            <p className="text-sm text-ink-secondary">Bank transfer or e-wallet, then tell us.</p>
          </div>
        </div>
      )}

      {nothing ? (
        <p className="text-sm text-ink-secondary">
          Reply to any invoice email, or write to {contact.email || "us"}, and we'll send you the payment details.
        </p>
      ) : (
        <>
          {methods.length > 0 &&
            (compact ? (
              // On the invoice sheet: a document's columns, not cards — it is
              // read on paper as often as on a screen.
              <ul className={`grid gap-x-8 gap-y-4 ${columns >= 3 ? "sm:grid-cols-2 lg:grid-cols-3" : columns === 2 ? "sm:grid-cols-2" : ""}`}>
                {methods.map((m, i) => (
                  <li key={i} className="border-t border-line/10 pt-3">
                    <div className="flex items-center gap-2">
                      <span className="mr-auto text-sm font-bold">{m.label}</span>
                      <CopyButton value={m.details} />
                    </div>
                    {m.details && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-secondary">{m.details}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="space-y-2.5">
                {methods.map((m, i) => (
                  <li key={i} className="rounded-lg border border-line/[0.08] bg-bg-panel/50 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="mr-auto font-bold">{m.label}</span>
                      <CopyButton value={m.details} />
                    </div>
                    {m.details && <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-secondary">{m.details}</p>}
                  </li>
                ))}
              </ul>
            ))}
          {String(instructions).trim() && (
            <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink-secondary">{instructions}</p>
          )}
        </>
      )}

      <p
        className="mt-4 rounded-lg px-3.5 py-2.5 text-sm"
        style={{ background: "rgb(var(--c-accent) / 0.08)", color: "rgb(var(--m-accent-deep, 192 92 68))" }}
      >
        Quote <span className="font-bold">{invoiceNumber || "the invoice number"}</span> as the reference, so we can match
        your payment to it.
      </p>

      {(contact.email || contact.phone) && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-secondary">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1.5 hover:text-ink-primary">
              <Mail size={14} /> {contact.email}
            </a>
          )}
          {contact.phone && (
            <span className="inline-flex items-center gap-1.5">
              <Phone size={14} /> {contact.phone}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Pill choices — a row that wraps, so five methods fit a phone without a select. */
export function ChoicePills({ options, value, onChange, error, label }) {
  return (
    <div>
      {label && <span className="text-sm text-ink-secondary">{label}</span>}
      <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              className={cx(
                "h-10 rounded-full border-2 px-4 text-sm font-semibold transition-colors duration-fast",
                on ? "" : error ? "border-state-unavailable/50 text-ink-secondary" : "border-line/10 text-ink-secondary hover:border-line/25"
              )}
              style={on ? { borderColor: "var(--color-accent)", background: "rgb(var(--c-accent) / 0.1)", color: "rgb(var(--c-ink-primary))" } : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {error && (
        <span data-field-error="" className="mt-1 block text-xs font-medium text-state-unavailable">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * A peso amount, typed in pesos. The ₱ sits inside the field, where the
 * eye expects it, so nobody types centavos by mistake; the API is sent
 * minor units by whoever calls toMinor().
 */
export function MoneyInput({ label, hint, error, optional, currencySymbol = "₱", className, ...props }) {
  const id = useId();
  return (
    <label className={cx("block", className)}>
      <span className="flex items-baseline gap-1.5 text-sm text-ink-secondary">
        {label}
        {optional && <span className="text-xs text-ink-muted">optional</span>}
      </span>
      <span className="relative mt-1.5 block">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-semibold text-ink-muted">
          {currencySymbol}
        </span>
        <input
          inputMode="decimal"
          autoComplete="off"
          {...props}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error || hint ? `${id}-d` : undefined}
          className={cx(
            "h-11 w-full rounded-md border bg-bg-panel pl-8 pr-3 font-semibold tabular-nums text-ink-primary outline-none",
            "transition-colors duration-fast ease-out",
            error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40"
          )}
        />
      </span>
      {(error || hint) && (
        <span
          id={`${id}-d`}
          data-field-error={error ? "" : undefined}
          className={cx("mt-1 block text-xs font-medium", error ? "text-state-unavailable" : "text-ink-muted")}
        >
          {error || hint}
        </span>
      )}
    </label>
  );
}

/**
 * "I've paid" — for a buyer who has sent money and wants SILLA to know.
 *
 * It is a CLAIM. The dialog says so before it asks anything: nothing is
 * marked paid and nothing switches on until SILLA finds the money and
 * records it. Errors are revealed on submit, never before — the same
 * rule as every form in the portal.
 */
export function ClaimDialog({ invoice, open, onClose, onClaimed, email }) {
  const blank = () => ({
    method: "",
    reference: "",
    amount: invoice?.total == null ? "" : (invoice.total / 100).toLocaleString("en-PH", { minimumFractionDigits: invoice.total % 100 ? 2 : 0 }),
    paidAt: todayInput(),
    note: "",
  });
  const [form, setForm] = useState(blank);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(blank());
    setFields({});
    setDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.id]);

  if (!invoice) return null;
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const needsReference = form.method && !["cash", "other"].includes(form.method);

  const submit = async () => {
    const f = {};
    if (!form.method) f.method = "Choose how you paid.";
    if (needsReference && !form.reference.trim()) f.reference = "Enter the reference number from your receipt, so we can find the payment.";
    const amount = toMinor(form.amount);
    if (!amount) f.amount = "Enter the amount you paid, like 82,800.";
    if (!form.paidAt) f.paidAt = "Enter the date you paid.";
    else if (form.paidAt > todayInput()) f.paidAt = "That date hasn't happened yet.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    try {
      const { invoice: updated } = await billingApi.claim(invoice.id, {
        method: form.method,
        reference: form.reference.trim(),
        amount,
        paidAt: fromDateInput(form.paidAt),
        note: form.note.trim(),
      });
      setDone(true);
      onClaimed?.(updated);
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={Send}
      title="Tell us you've paid"
      subtitle={`${invoice.number} · ${formatMoney(invoice.total, { currency: invoice.currency, exact: true })}`}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon={Send} loading={busy} onClick={submit}>
              Send to SILLA
            </Button>
          </>
        )
      }
    >
      {done ? (
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }} className="py-4 text-center">
          <motion.span
            initial={{ scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.05 }}
            className="mx-auto grid h-16 w-16 place-items-center rounded-full"
            style={{ background: "rgb(var(--c-state-available) / 0.16)", color: "rgb(var(--c-state-available))" }}
          >
            <CircleCheck size={34} />
          </motion.span>
          <h3 className="mt-4 text-xl font-extrabold tracking-tight">Thanks — we'll check it</h3>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-secondary">
            Once we find the payment we'll mark {invoice.number} paid and email {email ? <strong>{email}</strong> : "you"} a receipt.
            There's nothing else you need to do.
          </p>
        </motion.div>
      ) : (
        <div className="space-y-5">
          <div className="rounded-lg px-4 py-3 text-sm leading-relaxed" style={{ background: "rgb(var(--c-state-reserved) / 0.1)" }}>
            <span className="font-bold">This doesn't mark the invoice paid.</span>{" "}
            <span className="text-ink-secondary">
              It tells us which payment to look for. SILLA checks the account and confirms it — usually within a working day — and
              the invoice stays open until we do.
            </span>
          </div>

          <ChoicePills
            label="How did you pay?"
            options={CLAIM_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
            value={form.method}
            onChange={(method) => setForm((f) => ({ ...f, method }))}
            error={fields.method}
          />

          <TextInput
            label="Reference number"
            optional={!needsReference}
            hint={needsReference ? "From your bank or e-wallet receipt." : "If there is one."}
            value={form.reference}
            onChange={set("reference")}
            error={fields.reference}
            autoComplete="off"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput label="Amount paid" value={form.amount} onChange={set("amount")} error={fields.amount} />
            <TextInput label="Date paid" type="date" max={todayInput()} value={form.paidAt} onChange={set("paidAt")} error={fields.paidAt} />
          </div>

          <Textarea
            label="Anything we should know?"
            rows={2}
            placeholder="Optional — paid from a different account name, split across two transfers…"
            value={form.note}
            onChange={set("note")}
            error={fields.note}
          />

          {fields._form && <Notice tone="error">{fields._form}</Notice>}
        </div>
      )}
    </Modal>
  );
}
