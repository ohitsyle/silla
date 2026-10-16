import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Printer, Send } from "lucide-react";

import { Button, EmptyState, Notice, Skeleton } from "../components/ui.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { billingApi } from "../lib/billingApi.js";
import { formatMoney } from "../lib/plans.js";
import { useToast } from "../lib/toast.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { METHOD_LABEL, longDate, shortDate } from "../billing/format.js";
import { ClaimDialog, HowToPay } from "../billing/ui.jsx";
import { AccountMenu } from "./kit.jsx";

/**
 * One invoice, as a document — on screen and on paper.
 *
 * The sheet is what a finance office files: who is billing (frozen at
 * issue, with their TIN and VAT registration), who is billed (also
 * frozen), the lines, VAT, the total, and a stamp that says at a glance
 * whether it is paid, due, overdue or void. While it is open it carries
 * today's payment instructions — those are deliberately NOT frozen: how
 * to pay is whatever account works now.
 *
 * "Print / Save as PDF" is the browser's own print, so there is no PDF
 * library to keep in step with the screen: the print stylesheet below
 * drops everything but the sheet and lays it on A4.
 *
 * Its own chrome rather than AccountLayout, so the header and toolbar
 * can be left off the page entirely when printing instead of leaving
 * blank space where they were.
 */

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm 14mm 16mm; }
  html, body { background: #fff !important; }
  .invoice-sheet { box-shadow: none !important; border: 0 !important; border-radius: 0 !important; padding: 0 !important; max-width: none !important; background: #fff !important; }
  .invoice-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .invoice-sheet a { color: inherit !important; text-decoration: none !important; }
}
`;

const STAMP = {
  paid: { label: "Paid", channel: "--c-state-available" },
  void: { label: "Void", channel: "--c-state-unavailable" },
  overdue: { label: "Overdue", channel: "--c-state-unavailable" },
  open: { label: "Unpaid", channel: "--c-state-reserved" },
};

function Stamp({ invoice }) {
  const kind = invoice.status === "paid" ? "paid" : invoice.status === "void" ? "void" : invoice.overdue ? "overdue" : "open";
  const { label, channel } = STAMP[kind];
  const sub =
    kind === "paid" ? shortDate(invoice.paidAt) : kind === "void" ? shortDate(invoice.voidedAt) : `Due ${shortDate(invoice.dueAt)}`;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.25, rotate: -14 }}
      animate={{ opacity: 1, scale: 1, rotate: -8 }}
      transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.15 }}
      className="pointer-events-none select-none rounded-[14px] border-[3px] px-4 py-1.5 text-center"
      style={{ borderColor: `rgb(var(${channel}) / 0.85)`, color: `rgb(var(${channel}))` }}
      aria-label={`Status: ${label}${sub ? `, ${sub}` : ""}`}
    >
      <div className="text-[22px] font-black uppercase leading-none tracking-[0.18em] sm:text-[26px]">{label}</div>
      {sub && <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em]">{sub}</div>}
    </motion.div>
  );
}

function Block({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">{label}</div>
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Sheet({ invoice, howToPay, footer }) {
  const money = (minor) => formatMoney(minor, { currency: invoice.currency, exact: true });
  const issuer = invoice.issuer || {};
  const bill = invoice.billTo || {};
  const taxed = invoice.tax?.amount > 0;
  const period =
    invoice.periodStart && invoice.periodEnd ? `${longDate(invoice.periodStart)} – ${longDate(invoice.periodEnd)}` : null;

  return (
    <article
      className="invoice-sheet relative mx-auto max-w-[840px] rounded-xl border border-line/10 bg-bg-card p-6 shadow-md sm:p-12"
      aria-label={`Invoice ${invoice.number}`}
    >
      {/* ── who is billing, and what this is ── */}
      <header className="flex flex-col-reverse gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-9 w-9 place-items-center rounded-[11px] text-base font-extrabold"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              S
            </span>
            <span className="text-xl font-extrabold tracking-tight">{issuer.name || "SILLA"}</span>
          </div>
          <div className="mt-3 space-y-0.5 text-sm text-ink-secondary">
            {(issuer.address || []).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {(issuer.email || issuer.phone) && <div>{[issuer.email, issuer.phone].filter(Boolean).join(" · ")}</div>}
            {issuer.taxId && <div>TIN {issuer.taxId}</div>}
            <div>{issuer.vatRegistered ? "VAT-registered" : "Non-VAT registered"}</div>
          </div>
        </div>

        <div className="flex flex-col items-start gap-5 sm:items-end sm:text-right">
          <div>
            <h1 className="display text-[2.6rem] sm:text-[3.2rem]">Invoice</h1>
            <div className="mt-1 whitespace-nowrap font-mono text-[15px] font-semibold">{invoice.number}</div>
          </div>
          <Stamp invoice={invoice} />
        </div>
      </header>

      {/* ── to whom, for what, when ── */}
      <section className="mt-10 grid gap-6 border-t border-line/10 pt-7 sm:grid-cols-3">
        <Block label="Bill to">
          {bill.name && <div className="font-bold">{bill.name}</div>}
          {bill.company && bill.company !== bill.name && <div>{bill.company}</div>}
          {(bill.address || []).map((line, i) => (
            <div key={i} className="text-ink-secondary">
              {line}
            </div>
          ))}
          {bill.email && <div className="text-ink-secondary">{bill.email}</div>}
          {bill.taxId && <div className="text-ink-secondary">TIN {bill.taxId}</div>}
        </Block>
        <Block label="For">
          <div className="font-bold">{invoice.organizationName || bill.company || "—"}</div>
          {period && <div className="text-ink-secondary">{period}</div>}
          {invoice.billingPeriod && (
            <div className="text-ink-secondary">Billed {invoice.billingPeriod === "monthly" ? "monthly" : "yearly"}</div>
          )}
        </Block>
        <Block label="Dates">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-ink-muted">Issued</dt>
            <dd>{longDate(invoice.issuedAt)}</dd>
            {invoice.status !== "void" && (
              <>
                <dt className="text-ink-muted">Due</dt>
                <dd className={invoice.overdue ? "font-bold text-state-unavailable" : ""}>{longDate(invoice.dueAt)}</dd>
              </>
            )}
            {invoice.status === "paid" && (
              <>
                <dt className="text-ink-muted">Paid</dt>
                <dd>{longDate(invoice.paidAt)}</dd>
              </>
            )}
          </dl>
        </Block>
      </section>

      {/* ── the lines ── */}
      <section className="mt-9">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-line/15 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">
              <th className="py-2.5 pr-3 font-bold">Description</th>
              <th className="hidden w-16 py-2.5 px-3 text-right font-bold sm:table-cell">Qty</th>
              <th className="hidden w-36 py-2.5 px-3 text-right font-bold sm:table-cell">Unit price</th>
              <th className="w-36 py-2.5 pl-3 text-right font-bold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, i) => (
              <tr key={i} className="border-b border-line/[0.08] align-top">
                <td className="py-3.5 pr-3">
                  <div className="font-semibold">{line.description}</div>
                  {line.quantity > 1 && (
                    <div className="text-xs text-ink-muted sm:hidden">
                      {line.quantity} × {money(line.unitAmount)}
                    </div>
                  )}
                </td>
                <td className="hidden py-3.5 px-3 text-right tabular-nums sm:table-cell">{line.quantity}</td>
                <td className="hidden py-3.5 px-3 text-right tabular-nums sm:table-cell">{money(line.unitAmount)}</td>
                <td className="py-3.5 pl-3 text-right font-semibold tabular-nums">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-5 flex justify-end">
          <dl className="w-full max-w-[320px] space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-secondary">Subtotal</dt>
              <dd className="tabular-nums">{money(invoice.subtotal)}</dd>
            </div>
            {taxed ? (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-secondary">{invoice.tax.label || "VAT"}</dt>
                <dd className="tabular-nums">{money(invoice.tax.amount)}</dd>
              </div>
            ) : (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-secondary">VAT</dt>
                <dd className="text-ink-muted">Not charged</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4 border-t-2 border-line/15 pt-3">
              <dt className="font-bold">Total</dt>
              <dd className="text-2xl font-extrabold tabular-nums tracking-tight">{money(invoice.total)}</dd>
            </div>
            {invoice.status === "paid" && invoice.payment && (
              <div className="flex justify-between gap-4 text-ink-secondary">
                <dt>Paid {invoice.payment.method ? `· ${METHOD_LABEL[invoice.payment.method]}` : ""}</dt>
                <dd className="tabular-nums">{money(invoice.payment.amount ?? invoice.total)}</dd>
              </div>
            )}
            {invoice.status === "open" && (
              <div
                className="flex justify-between gap-4 rounded-lg px-3 py-2 font-bold"
                style={{ background: invoice.overdue ? "rgb(var(--c-state-unavailable) / 0.1)" : "rgb(var(--c-accent) / 0.09)" }}
              >
                <dt>Amount due</dt>
                <dd className="tabular-nums">{money(invoice.total)}</dd>
              </div>
            )}
          </dl>
        </div>
      </section>

      {(invoice.memo || invoice.status === "void" || (invoice.status === "paid" && invoice.payment?.reference)) && (
        <section className="mt-8 space-y-2 text-sm">
          {invoice.memo && <p className="leading-relaxed text-ink-secondary">{invoice.memo}</p>}
          {invoice.status === "paid" && invoice.payment?.reference && (
            <p className="text-ink-secondary">
              Payment reference <span className="font-mono font-semibold text-ink-primary">{invoice.payment.reference}</span>, received{" "}
              {longDate(invoice.payment.receivedAt || invoice.paidAt)}.
            </p>
          )}
          {invoice.status === "void" && (
            <p className="font-semibold text-state-unavailable">
              Voided {longDate(invoice.voidedAt)}
              {invoice.voidReason ? ` — ${invoice.voidReason}` : ""}. Nothing is owed on this invoice.
            </p>
          )}
        </section>
      )}

      {invoice.status === "open" && howToPay && (
        <section className="mt-9 border-t border-line/10 pt-7">
          <h2 className="mb-4 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">How to pay</h2>
          <HowToPay compact {...howToPay} invoiceNumber={invoice.number} />
        </section>
      )}

      <footer className="mt-10 space-y-1.5 border-t border-line/10 pt-5 text-xs leading-relaxed text-ink-muted">
        {footer && <p className="whitespace-pre-line">{footer}</p>}
        {!issuer.vatRegistered && <p>This document is not valid for claim of input tax.</p>}
        <p>
          {issuer.name || "SILLA"} · {invoice.number} · issued {longDate(invoice.issuedAt)}
        </p>
      </footer>
    </article>
  );
}

export default function InvoicePage({ id, navigate }) {
  const { account, isSilla } = useAccount();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [claimSent, setClaimSent] = useState(false);

  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    return billingApi
      .invoice(id)
      .then((d) => setData(d))
      .catch((e) => setError(e));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (data?.invoice?.number) document.title = `${data.invoice.number} · Invoice · SILLA`;
  }, [data?.invoice?.number]);

  const back = () => navigate(isSilla ? `${ROUTES.staff}/invoices${id ? `/${id}` : ""}` : ROUTES.billing);
  const invoice = data?.invoice;
  const claimWaiting = invoice?.claim?.submittedAt && !invoice?.claim?.dismissedAt;

  return (
    <div className="silla-marketing min-h-screen print:bg-white">
      <style>{PRINT_CSS}</style>

      <header
        className="sticky top-0 z-40 border-b border-line/[0.08] print:hidden"
        style={{ background: "rgb(var(--c-bg-page) / 0.86)", backdropFilter: "saturate(180%) blur(12px)" }}
      >
        <div className="mx-auto flex h-[72px] max-w-5xl items-center gap-4 px-4 sm:px-6">
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

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-6 sm:px-6 print:p-0">
        <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
          <button
            type="button"
            onClick={back}
            className="mr-auto inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary transition-opacity hover:opacity-70"
          >
            <ArrowLeft size={15} />
            {isSilla ? "Back to the console" : "Billing"}
          </button>
          {invoice && (
            <>
              <Button icon={Printer} onClick={() => window.print()}>
                Print / Save as PDF
              </Button>
              {!isSilla && invoice.status === "open" && !claimWaiting && (
                <Button variant="primary" icon={Send} onClick={() => setClaiming(true)}>
                  I've paid
                </Button>
              )}
            </>
          )}
        </div>

        {error && (
          <EmptyState
            title={error.status === 404 ? "We couldn't find that invoice" : "The invoice didn't load"}
            action={<Button onClick={back}>{isSilla ? "Back to the console" : "Back to billing"}</Button>}
          >
            {error.status === 404 ? "It may belong to another account, or the link is incomplete." : error.message}
          </EmptyState>
        )}

        {!data && !error && <Skeleton className="mx-auto h-[720px] max-w-[840px]" rounded="rounded-xl" />}

        {invoice && (
          <>
            {invoice.claim?.submittedAt && invoice.status === "open" && (
              <div className="mx-auto mb-5 max-w-[840px] print:hidden">
                {invoice.claim.dismissedAt ? (
                  <Notice tone="error">
                    <span className="font-bold">We couldn't match your payment.</span> {invoice.claim.dismissNote}{" "}
                    {!isSilla && (
                      <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setClaiming(true)}>
                        Tell us again
                      </button>
                    )}
                  </Notice>
                ) : (
                  <Notice>
                    <span className="font-bold text-ink-primary">
                      {isSilla ? "The customer says they've paid" : "You told us you've paid"} —
                    </span>{" "}
                    {formatMoney(invoice.claim.amount, { currency: invoice.currency, exact: true })} by {METHOD_LABEL[invoice.claim.method]}
                    {invoice.claim.reference ? ` (ref ${invoice.claim.reference})` : ""} on {longDate(invoice.claim.paidAt)}.{" "}
                    {isSilla ? "Record it in the console once the money is found." : "We're checking, and will email your receipt once it's matched."}
                  </Notice>
                )}
              </div>
            )}
            <Sheet invoice={invoice} howToPay={data.howToPay} footer={data.footer} />
          </>
        )}
      </main>

      {invoice && !isSilla && (
        <ClaimDialog
          open={claiming}
          invoice={invoice}
          email={account?.billing?.email || account?.email}
          onClose={() => {
            setClaiming(false);
            if (claimSent) toast("Sent — we'll confirm your payment");
            setClaimSent(false);
          }}
          onClaimed={() => {
            setClaimSent(true);
            load();
          }}
        />
      )}
    </div>
  );
}
