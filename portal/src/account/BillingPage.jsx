import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check, ChevronRight, Clock3, CreditCard, ExternalLink, FileText, Megaphone, Minus, Receipt, Send, ShieldAlert } from "lucide-react";

import { Button, EmptyState, Notice, Skeleton } from "../components/ui.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { billingApi } from "../lib/billingApi.js";
import { formatMoney } from "../lib/plans.js";
import { useToast } from "../lib/toast.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { longDate, shortDate, limitPhrase } from "../billing/format.js";
import { ClaimDialog, Fact, HowToPay, InvoiceBadge, ToneBadge } from "../billing/ui.jsx";
import { AccountLayout } from "./shared.jsx";

/**
 * Billing — a buyer's plan, what it costs, what they owe and how to pay.
 *
 * Read top to bottom it answers the questions in the order people have
 * them: is my system working, and until when; do I owe anything; how do
 * I pay it. Status is said in words ("Payment overdue — everything keeps
 * working until …"), never as "past_due", and an overdue invoice is the
 * loudest thing on the page.
 *
 * There is no card form and no "Pay now": money arrives by bank transfer
 * or e-wallet, and "I've paid" is a claim SILLA confirms. The page says
 * so wherever it asks for anything.
 */

const PERIOD = { monthly: "month", yearly: "year" };

/** The date that matters for this status, labelled for this status. */
function keyDate(sub) {
  if (sub.status === "past_due" && sub.graceEndsAt) return ["Keeps working until", longDate(sub.graceEndsAt)];
  if (sub.status === "trialing" && sub.trialEndsAt) return ["Free trial until", longDate(sub.trialEndsAt)];
  if (sub.status === "active" && sub.currentPeriodEnd) return [sub.cancelAtPeriodEnd ? "Ends on" : "Paid through", longDate(sub.currentPeriodEnd)];
  if (sub.status === "cancelled" && sub.cancelledAt) return ["Ended on", longDate(sub.cancelledAt)];
  if (sub.status === "suspended") return ["Since", "Read-only now"];
  return ["Starts", "When it goes live"];
}

/**
 * A deployment address, shortened to the part a person recognises. The
 * host of a shared product URL is noise ("d3ttts3ghharsa.cloudfront.net");
 * the organization's own path is what tells two of them apart.
 */
function prettyUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return path && u.host.length > 24 ? `…${path}` : `${u.host}${path}`;
  } catch {
    return url;
  }
}

function SubscriptionCard({ sub, vat, onClaim, navigate, delay }) {
  const [dateLabel, dateValue] = keyDate(sub);
  const price = sub.priceToBeAgreed || sub.price.amount == null
    ? "To be agreed with you"
    : `${formatMoney(sub.price.amount, { currency: sub.price.currency })} a ${PERIOD[sub.billingPeriod] || "period"}`;
  const vatNote = vat?.registered && sub.price.amount != null ? `+ ${Math.round((vat.rate || 0) * 100)}% VAT` : null;
  const accent = sub.tone === "bad" || sub.tone === "warning";

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm"
      style={accent ? { boxShadow: `inset 4px 0 0 rgb(var(${sub.tone === "bad" ? "--c-state-unavailable" : "--c-state-reserved"}))` } : undefined}
    >
      <div className="p-6 sm:p-7">
        <div className="flex flex-wrap items-start gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px]"
            style={{ background: "rgb(var(--c-accent) / 0.11)", color: "var(--color-accent)" }}
          >
            <CreditCard size={20} strokeWidth={2.2} />
          </span>
          <div className="mr-auto min-w-0">
            <h2 className="truncate text-xl font-extrabold tracking-tight">{sub.organizationName}</h2>
            <p className="text-sm text-ink-secondary">
              {sub.plan.name} plan · billed {sub.billingPeriod === "monthly" ? "monthly" : "yearly"}
            </p>
          </div>
          <ToneBadge tone={sub.tone}>{sub.statusLabel}</ToneBadge>
        </div>

        <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">{sub.statusDetail}</p>
        {sub.notice && (
          <p className="mt-3 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-sm" style={{ background: "rgb(var(--c-accent) / 0.08)" }}>
            <Megaphone size={15} className="mt-0.5 shrink-0" style={{ color: "var(--color-accent)" }} />
            <span>
              <span className="font-semibold">From SILLA: </span>
              {sub.notice}
            </span>
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Fact label="Price">
            {price}
            {vatNote && <span className="ml-1.5 text-xs font-semibold text-ink-muted">{vatNote}</span>}
          </Fact>
          <Fact label={dateLabel}>{dateValue}</Fact>
          <Fact label="Your system" className="col-span-2 sm:col-span-1">
            {sub.deploymentUrl ? (
              <a
                href={sub.deploymentUrl}
                target="_blank"
                rel="noreferrer"
                title={sub.deploymentUrl}
                className="inline-flex max-w-full items-center gap-1.5 hover:opacity-70"
                style={{ color: "rgb(var(--m-accent-deep))" }}
              >
                <span className="truncate">{prettyUrl(sub.deploymentUrl)}</span>
                <ExternalLink size={14} className="shrink-0" />
              </a>
            ) : (
              <span className="text-ink-muted">Not live yet</span>
            )}
          </Fact>
        </div>

        <details className="group mt-5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-ink-secondary hover:text-ink-primary">
            <ChevronRight size={15} className="transition-transform group-open:rotate-90" />
            What your plan includes
          </summary>
          <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {sub.includes.limits.map((l) => (
              <div key={l.key} className="flex items-center gap-2 text-sm">
                <Check size={15} strokeWidth={2.6} style={{ color: "rgb(var(--c-state-available))" }} />
                {limitPhrase(l.key, l.value)}
              </div>
            ))}
            {sub.includes.features.map((f) => (
              <div key={f.key} className={`flex items-center gap-2 text-sm ${f.on ? "" : "text-ink-muted"}`}>
                {f.on ? (
                  <Check size={15} strokeWidth={2.6} style={{ color: "rgb(var(--c-state-available))" }} />
                ) : (
                  <Minus size={15} strokeWidth={2.6} />
                )}
                <span className={f.on ? "" : "line-through decoration-line/30"}>{f.label}</span>
              </div>
            ))}
          </div>
        </details>
      </div>

      {sub.openInvoices.length > 0 && (
        <div className="border-t border-line/[0.08] bg-bg-panel/40 px-6 py-4 sm:px-7">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">To pay</div>
          <ul className="space-y-2">
            {sub.openInvoices.map((inv) => (
              <OpenInvoiceRow key={inv.id} invoice={inv} onClaim={onClaim} navigate={navigate} />
            ))}
          </ul>
        </div>
      )}
    </motion.section>
  );
}

function OpenInvoiceRow({ invoice, onClaim, navigate }) {
  const claimed = invoice.claim?.submittedAt && !invoice.claim?.dismissedAt;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="mr-auto min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold tabular-nums">{formatMoney(invoice.total, { currency: invoice.currency, exact: true })}</span>
          <InvoiceBadge invoice={invoice} size="sm" />
        </div>
        <div className="mt-0.5 text-xs text-ink-muted">
          {invoice.number} · due {longDate(invoice.dueAt)}
          {claimed ? ` · you told us you paid on ${shortDate(invoice.claim.paidAt)}` : ""}
        </div>
      </div>
      <Button size="sm" variant="ghost" icon={FileText} onClick={() => navigate(`${ROUTES.invoices}/${invoice.id}`)}>
        View
      </Button>
      {!claimed && (
        <Button size="sm" variant="primary" icon={Send} onClick={() => onClaim(invoice)}>
          I've paid
        </Button>
      )}
    </li>
  );
}

function InvoiceList({ invoices, onClaim, navigate }) {
  if (!invoices.length) {
    return <EmptyState icon={Receipt} title="No invoices yet">Your first one arrives by email when you submit an order.</EmptyState>;
  }
  return (
    <ul className="divide-y divide-line/[0.08] overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
      {invoices.map((inv) => {
        const claimed = inv.claim?.submittedAt && !inv.claim?.dismissedAt;
        const dismissed = inv.status === "open" && inv.claim?.dismissedAt;
        return (
          <li
            key={inv.id}
            className="relative"
            style={inv.overdue ? { background: "rgb(var(--c-state-unavailable) / 0.06)", boxShadow: "inset 3px 0 0 rgb(var(--c-state-unavailable))" } : undefined}
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
              <button
                type="button"
                onClick={() => navigate(`${ROUTES.invoices}/${inv.id}`)}
                className="mr-auto min-w-0 text-left after:absolute after:inset-0 after:content-['']"
                aria-label={`Open invoice ${inv.number}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{inv.number}</span>
                  <InvoiceBadge invoice={inv} size="sm" />
                </div>
                <div className="mt-0.5 truncate text-sm text-ink-secondary">{inv.lines[0]?.description || inv.organizationName}</div>
                <div className="mt-0.5 text-xs text-ink-muted">
                  Issued {shortDate(inv.issuedAt)}
                  {inv.status === "paid" && inv.paidAt ? ` · paid ${shortDate(inv.paidAt)}` : ""}
                  {inv.status === "open" && inv.dueAt ? ` · due ${shortDate(inv.dueAt)}` : ""}
                  {claimed ? " · we're checking your payment" : ""}
                </div>
                {dismissed && (
                  <div className="mt-1 text-xs font-medium text-state-unavailable">
                    We couldn't match your payment: {inv.claim.dismissNote}
                  </div>
                )}
              </button>
              <span className="font-bold tabular-nums">{formatMoney(inv.total, { currency: inv.currency, exact: true })}</span>
              {inv.status === "open" && !claimed && (
                <Button size="sm" className="relative z-10" onClick={() => onClaim(inv)}>
                  I've paid
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function BillingPage({ navigate }) {
  const { account, isSilla } = useAccount();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(null);
  // The success panel carries the outcome inside the dialog; the toast
  // waits until it closes, so the two don't say it at once.
  const [claimSent, setClaimSent] = useState(false);

  const load = useCallback(() => {
    if (isSilla) return Promise.resolve();
    return Promise.all([billingApi.me(), billingApi.myInvoices(), billingApi.paymentInstructions()])
      .then(([me, list, how]) => setData({ ...me, invoices: list.invoices, how }))
      .catch((e) => setError(e.message));
  }, [isSilla]);

  useEffect(() => {
    load();
  }, [load]);

  if (isSilla) {
    return (
      <AccountLayout navigate={navigate} title="Billing">
        <EmptyState
          icon={ShieldAlert}
          title="This page is for customers"
          action={
            <Button variant="primary" onClick={() => navigate(`${ROUTES.staff}/subscriptions`)}>
              Open the staff console
            </Button>
          }
        >
          You're signed in as SILLA staff. Customers' subscriptions and invoices are in the console.
        </EmptyState>
      </AccountLayout>
    );
  }

  const subs = data?.subscriptions || [];
  const invoices = data?.invoices || [];
  const open = invoices.filter((i) => i.status === "open");
  const overdue = open.filter((i) => i.overdue);
  const troubled = subs.find((s) => s.status === "suspended") || subs.find((s) => s.status === "past_due");
  const waiting = (inv) => Boolean(inv?.claim?.submittedAt && !inv?.claim?.dismissedAt);
  // The invoice to act on next: overdue first, and never one they've already told us they paid.
  const firstOpen = overdue.find((i) => !waiting(i)) || open.find((i) => !waiting(i)) || overdue[0] || open[0];
  // Once they've told us they paid, the banner stops asking and says we're on it.
  const allClaimed = overdue.length > 0 && overdue.every(waiting);

  return (
    <AccountLayout navigate={navigate} title="Billing" subtitle="Your plan, what it costs, and how to pay.">
      {error && <Notice tone="error">{error}</Notice>}

      {!data && !error && (
        <div className="space-y-4">
          <Skeleton className="h-56" rounded="rounded-xl" />
          <Skeleton className="h-40" rounded="rounded-xl" />
        </div>
      )}

      {data && (
        <div className="space-y-8">
          {/* The one thing that needs doing, said first. */}
          {(troubled || overdue.length > 0) && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-wrap items-center gap-4 rounded-xl border px-5 py-4"
              style={{
                borderColor: `rgb(var(${allClaimed ? "--c-state-reserved" : "--c-state-unavailable"}) / 0.35)`,
                background: `rgb(var(${allClaimed ? "--c-state-reserved" : "--c-state-unavailable"}) / 0.07)`,
              }}
              role={allClaimed ? "status" : "alert"}
            >
              {allClaimed ? (
                <Clock3 size={22} className="shrink-0" style={{ color: "rgb(var(--c-state-reserved))" }} />
              ) : (
                <ShieldAlert size={22} className="shrink-0" style={{ color: "rgb(var(--c-state-unavailable))" }} />
              )}
              <div className="mr-auto min-w-0">
                <div className="font-bold">
                  {allClaimed
                    ? `Thanks — we're checking your payment for ${overdue.map((i) => i.number).join(", ")}`
                    : troubled?.status === "suspended"
                      ? `${troubled.organizationName} is read-only until it's paid`
                      : overdue.length === 1
                        ? `Invoice ${overdue[0].number} is overdue`
                        : `${overdue.length} invoices are overdue`}
                </div>
                <div className="mt-0.5 text-sm text-ink-secondary">
                  {allClaimed
                    ? `We usually confirm within a working day, and email your receipt when we do.${troubled?.status === "past_due" && troubled.graceEndsAt ? ` Everything keeps working until ${longDate(troubled.graceEndsAt)}.` : ""}`
                    : troubled
                      ? troubled.statusDetail
                      : "Pay it the usual way, then tell us so we can match it."}
                </div>
              </div>
              {firstOpen && !waiting(firstOpen) && (
                <Button variant="primary" icon={Send} onClick={() => setClaiming(firstOpen)}>
                  I've paid {firstOpen.number}
                </Button>
              )}
            </motion.div>
          )}

          {subs.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No subscription yet"
              action={
                <Button variant="primary" onClick={() => navigate(ROUTES.orders)}>
                  Your orders <ArrowRight size={16} />
                </Button>
              }
            >
              When you submit an order, its subscription and first invoice appear here.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {subs.map((sub, i) => (
                <SubscriptionCard key={sub.id} sub={sub} vat={data.vat} onClaim={setClaiming} navigate={navigate} delay={i * 0.06} />
              ))}
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <section>
              <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold tracking-tight">
                <Receipt size={18} className="text-ink-muted" /> Invoices
              </h2>
              <InvoiceList invoices={invoices} onClaim={setClaiming} navigate={navigate} />
            </section>
            <aside className="lg:sticky lg:top-[96px]">
              <h2 className="sr-only">How to pay</h2>
              <HowToPay
                instructions={data.how?.instructions}
                methods={data.how?.methods}
                contact={{ email: data.how?.business?.email, phone: data.how?.business?.phone }}
                invoiceNumber={firstOpen?.number}
              />
            </aside>
          </div>
        </div>
      )}

      <ClaimDialog
        open={Boolean(claiming)}
        invoice={claiming}
        email={account?.billing?.email || account?.email}
        onClose={() => {
          setClaiming(null);
          if (claimSent) toast("Sent — we'll confirm your payment");
          setClaimSent(false);
        }}
        onClaimed={() => {
          setClaimSent(true);
          load();
        }}
      />
    </AccountLayout>
  );
}
