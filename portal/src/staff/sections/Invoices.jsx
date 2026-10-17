import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Ban, Banknote, BellRing, ExternalLink, FileText, HandCoins, Plus, Receipt, SearchX } from "lucide-react";

import { Button, EmptyState, Notice, Panel, Skeleton } from "../../components/ui.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { formatMoney } from "../../lib/plans.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES } from "../../lib/useHashRoute.js";
import { METHOD_LABEL, claimWaiting, dateTime, longDate, shortDate } from "../../billing/format.js";
import { InvoiceBadge } from "../../billing/ui.jsx";
import {
  BackTo, FilterTabs, ManualInvoiceDialog, ReasonDialog, RecordPaymentDialog, Row, SearchBox, useDebounced,
} from "../../billing/console.jsx";

/**
 * Staff console — Invoices.
 *
 * Where money is matched to bills. The list opens on what is OPEN, with
 * overdue invoices and buyers' "I've paid" claims a tab away; one invoice
 * is where staff record the money that arrived (the ONE way an invoice
 * becomes paid), confirm or dismiss a claim, or void a bill issued in
 * error.
 *
 * A claim is never a payment. Confirming one is recording a payment,
 * prefilled from what the buyer said, once the money is found.
 *
 * billing.read to look; billing.manage for every button that changes
 * anything, which is not rendered without it.
 */

const KIND = { first: "First invoice", renewal: "Renewal", manual: "Manual" };
const money = (inv, minor = inv.total) => formatMoney(minor, { currency: inv.currency, exact: true });

/* ───────────────────────────── the list ───────────────────────────── */

function InvoiceList({ navigate, can, query: address = {} }) {
  const toast = useToast();
  // Arriving from the overview's "overdue" figure opens on that tab.
  const [tab, setTab] = useState(() => (["open", "overdue", "claimed", "paid", "void", "all"].includes(address.tab) ? address.tab : "open"));
  const [q, setQ] = useState("");
  const query = useDebounced(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [subs, setSubs] = useState([]);

  const load = useCallback(() => {
    setError(null);
    const params = { q: query };
    if (["open", "paid", "void"].includes(tab)) params.status = tab;
    if (tab === "overdue") params.overdue = true;
    if (tab === "claimed") params.claimed = true;
    return billingApi
      .invoices(params)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [tab, query]);

  useEffect(() => {
    load();
  }, [load]);

  const openIssue = () => {
    setIssuing(true);
    if (!subs.length) billingApi.subscriptions().then((d) => setSubs(d.subscriptions)).catch(() => {});
  };

  const counts = data?.counts || {};
  const tabs = [
    { value: "open", label: "Open", count: counts.open },
    { value: "overdue", label: "Overdue", count: counts.overdue, alert: true },
    { value: "claimed", label: "Claims to check", count: counts.claimed, alert: true },
    { value: "paid", label: "Paid", count: counts.paid },
    { value: "void", label: "Void", count: counts.void },
    { value: "all", label: "All" },
  ];
  const rows = data?.invoices || [];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <FilterTabs tabs={tabs} value={tab} onChange={setTab} label="Invoice status" />
        <div className="flex items-center gap-2">
          <SearchBox value={q} onChange={setQ} placeholder="Number, organization or email" />
          {can("billing.manage") && (
            <Button variant="primary" icon={Plus} onClick={openIssue} className="ml-auto shrink-0" aria-label="New invoice">
              <span className="max-sm:hidden">New invoice</span>
            </Button>
          )}
        </div>
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
        <EmptyState icon={q ? SearchX : Receipt} title={q ? "Nothing matches that" : { overdue: "Nothing overdue", claimed: "No claims to check", open: "Nothing open" }[tab] || "No invoices here"}>
          {q ? "Try the invoice number, the organization, or the buyer's email." : tab === "claimed" ? "When a buyer says they've paid, it waits here for someone to find the money." : null}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_110px_110px_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 border-b border-line/[0.08] px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted lg:grid">
            <span>Invoice</span>
            <span>For</span>
            <span>Issued</span>
            <span>Due</span>
            <span className="text-right">Total</span>
            <span>Status</span>
          </div>
          <ul className="divide-y divide-line/[0.07]">
            {rows.map((inv, i) => (
              <motion.li key={inv.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }}>
                <button
                  type="button"
                  onClick={() => navigate(`${ROUTES.staff}/invoices/${inv.id}`)}
                  className="grid w-full gap-x-4 gap-y-1 px-5 py-3.5 text-left transition-colors hover:bg-line/[0.03]
                             lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.6fr)_110px_110px_minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center"
                  style={inv.overdue ? { background: "rgb(var(--c-state-unavailable) / 0.05)", boxShadow: "inset 3px 0 0 rgb(var(--c-state-unavailable))" } : undefined}
                >
                  <span className="min-w-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{inv.number}</span>
                      <span className="text-sm font-bold tabular-nums lg:hidden">{money(inv)}</span>
                    </span>
                    <span className="block truncate text-xs text-ink-muted">
                      {KIND[inv.kind]} · {inv.lines[0]?.description}
                    </span>
                  </span>
                  <span className="min-w-0 text-sm">
                    <span className="block truncate font-semibold">{inv.organizationName || inv.billTo?.company}</span>
                    <span className="block truncate text-xs text-ink-muted">{inv.account?.email}</span>
                  </span>
                  <span className="text-sm text-ink-secondary max-lg:hidden">{shortDate(inv.issuedAt)}</span>
                  <span className={`text-sm max-lg:hidden ${inv.overdue ? "font-semibold text-state-unavailable" : "text-ink-secondary"}`}>
                    {inv.status === "open" ? shortDate(inv.dueAt) : "—"}
                  </span>
                  <span className="text-right text-sm font-bold tabular-nums max-lg:hidden">{money(inv)}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <InvoiceBadge invoice={inv} size="sm" withDue={false} />
                    <span className="text-xs text-ink-muted lg:hidden">
                      {inv.status === "open" ? `due ${shortDate(inv.dueAt)}` : `issued ${shortDate(inv.issuedAt)}`}
                    </span>
                  </span>
                </button>
              </motion.li>
            ))}
          </ul>
        </div>
      )}

      <ManualInvoiceDialog
        open={issuing}
        subscriptions={subs}
        onClose={() => setIssuing(false)}
        onIssued={(invoice) => {
          setIssuing(false);
          toast(`${invoice.number} issued and emailed`);
          navigate(`${ROUTES.staff}/invoices/${invoice.id}`);
        }}
      />
    </div>
  );
}

/* ───────────────────────────── one invoice ───────────────────────────── */

function InvoiceDetail({ id, navigate, can }) {
  const manage = can("billing.manage");
  const toast = useToast();
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // "pay" | "void" | "dismiss"

  const load = useCallback(
    () =>
      billingApi
        .invoice(id)
        .then((d) => setInv(d.invoice))
        .catch((e) => setError(e)),
    [id]
  );
  useEffect(() => {
    setInv(null);
    load();
  }, [load]);

  const back = () => navigate(`${ROUTES.staff}/invoices`);
  if (error) {
    return (
      <div>
        <BackTo onClick={back}>All invoices</BackTo>
        <Notice tone="error">{error.status === 404 ? "That invoice wasn't found." : error.message}</Notice>
      </div>
    );
  }
  if (!inv) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-28" rounded="rounded-xl" />
        <Skeleton className="h-72" rounded="rounded-xl" />
      </div>
    );
  }

  const waiting = claimWaiting(inv);

  return (
    <div>
      <BackTo onClick={back}>All invoices</BackTo>

      <div className="mb-6 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="mr-auto min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-mono text-[clamp(1.25rem,2.6vw,1.6rem)] font-bold">{inv.number}</h2>
            <InvoiceBadge invoice={inv} />
          </div>
          <p className="mt-1.5 text-sm text-ink-secondary">
            {KIND[inv.kind]} · {inv.organizationName}
            {inv.account?.email ? (
              <>
                {" · "}
                <a href={`mailto:${inv.account.email}`} className="hover:text-ink-primary">
                  {inv.account.email}
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">Total</div>
          <div className="text-3xl font-extrabold tabular-nums tracking-tight">{money(inv)}</div>
        </div>
      </div>

      {/* The buyer's claim: what to look for, and the two honest answers. */}
      {waiting && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 rounded-xl border p-5"
          style={{ borderColor: "rgb(var(--c-state-reserved) / 0.4)", background: "rgb(var(--c-state-reserved) / 0.07)" }}
        >
          <div className="flex items-start gap-3">
            <HandCoins size={22} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-reserved))" }} />
            <div className="min-w-0 flex-1">
              <div className="font-bold">
                The customer says they paid {money(inv, inv.claim.amount)} by {METHOD_LABEL[inv.claim.method]} on {longDate(inv.claim.paidAt)}
              </div>
              <div className="mt-1 text-sm text-ink-secondary">
                {inv.claim.reference ? (
                  <>
                    Reference <span className="font-mono font-semibold text-ink-primary">{inv.claim.reference}</span>.{" "}
                  </>
                ) : (
                  "No reference given. "
                )}
                Told us {dateTime(inv.claim.submittedAt)}.{inv.claim.amount !== inv.total ? ` That's ${inv.claim.amount > inv.total ? "more" : "less"} than the ${money(inv)} invoiced.` : ""}
              </div>
              {inv.claim.note && <p className="mt-2 text-sm italic text-ink-secondary">“{inv.claim.note}”</p>}
              <p className="mt-2 text-xs text-ink-muted">A claim activates nothing. Find the money in the account first.</p>
            </div>
          </div>
          {manage && (
            <div className="mt-4 flex flex-wrap gap-2 sm:pl-[34px]">
              <Button variant="primary" icon={Banknote} onClick={() => setDialog("pay")}>
                Found it — record the payment
              </Button>
              <Button icon={SearchX} onClick={() => setDialog("dismiss")}>
                Couldn't find it
              </Button>
            </div>
          )}
        </motion.div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <Panel
            icon={FileText}
            title="The bill"
            action={
              <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => navigate(`${ROUTES.invoices}/${inv.id}`)}>
                Printable
              </Button>
            }
          >
            <table className="w-full text-sm">
              <tbody>
                {inv.lines.map((l, i) => (
                  <tr key={i} className="border-b border-line/[0.07] align-top">
                    <td className="py-2.5 pr-3">
                      <div className="font-semibold">{l.description}</div>
                      {l.quantity > 1 && (
                        <div className="text-xs text-ink-muted">
                          {l.quantity} × {money(inv, l.unitAmount)}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{money(inv, l.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pt-3 text-ink-muted">Subtotal</td>
                  <td className="pt-3 text-right tabular-nums">{money(inv, inv.subtotal)}</td>
                </tr>
                <tr>
                  <td className="pt-1 text-ink-muted">{inv.tax?.amount ? inv.tax.label : "VAT"}</td>
                  <td className="pt-1 text-right tabular-nums">{inv.tax?.amount ? money(inv, inv.tax.amount) : "Not charged"}</td>
                </tr>
                <tr className="font-bold">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right tabular-nums">{money(inv)}</td>
                </tr>
              </tbody>
            </table>
            {inv.memo && <p className="mt-4 text-sm text-ink-secondary">{inv.memo}</p>}
          </Panel>

          {inv.status === "paid" && inv.payment && (
            <Panel icon={Banknote} title="Payment">
              <div className="divide-y divide-line/[0.07]">
                <Row label="Amount">{money(inv, inv.payment.amount ?? inv.total)}</Row>
                <Row label="Method">{METHOD_LABEL[inv.payment.method] || "—"}</Row>
                <Row label="Reference">{inv.payment.reference || "—"}</Row>
                <Row label="Received">{longDate(inv.payment.receivedAt || inv.paidAt)}</Row>
                <Row label="Recorded by">{inv.payment.recordedBy ? inv.payment.recordedBy.name || inv.payment.recordedBy.email || "Staff" : "A payment provider"}</Row>
              </div>
              {inv.payment.note && <p className="mt-3 rounded-lg bg-bg-panel/70 px-3.5 py-2.5 text-sm">{inv.payment.note}</p>}
            </Panel>
          )}

          {inv.status === "void" && (
            <Notice tone="error">
              Voided {longDate(inv.voidedAt)}
              {inv.voidReason ? ` — ${inv.voidReason}` : ""}. Nothing is owed on it.
            </Notice>
          )}

          {inv.claim?.dismissedAt && (
            <Panel icon={SearchX} title="A claim that wasn't matched">
              <p className="text-sm">
                {money(inv, inv.claim.amount)} by {METHOD_LABEL[inv.claim.method]}
                {inv.claim.reference ? `, ref ${inv.claim.reference}` : ""}, said paid {longDate(inv.claim.paidAt)}.
              </p>
              <p className="mt-2 text-sm text-ink-secondary">
                Dismissed {dateTime(inv.claim.dismissedAt)}: “{inv.claim.dismissNote}” — the customer was told and can claim again.
              </p>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          {manage && inv.status === "open" && (
            <Panel title="Actions">
              <div className="flex flex-col gap-2">
                {!waiting && (
                  <Button variant="primary" icon={Banknote} onClick={() => setDialog("pay")}>
                    Record a payment
                  </Button>
                )}
                <Button variant="danger" icon={Ban} onClick={() => setDialog("void")}>
                  Void this invoice
                </Button>
              </div>
            </Panel>
          )}

          <Panel title="Details">
            <div className="divide-y divide-line/[0.07]">
              <Row label="Issued">{longDate(inv.issuedAt)}</Row>
              {inv.status !== "void" && (
                <Row label="Due">
                  <span className={inv.overdue ? "text-state-unavailable" : ""}>{longDate(inv.dueAt)}</span>
                </Row>
              )}
              {inv.periodStart && inv.periodEnd && <Row label="Pays for">{`${shortDate(inv.periodStart)} – ${shortDate(inv.periodEnd)}`}</Row>}
              <Row label="Buys a period">{inv.extendsSubscription ? `Yes — one ${inv.billingPeriod === "monthly" ? "month" : "year"}` : "No"}</Row>
              <Row label="Bill to">{inv.billTo?.name || "—"}</Row>
            </div>
            {inv.subscription && (
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => navigate(`${ROUTES.staff}/subscriptions/${inv.subscription}`)}>
                Open the subscription
              </Button>
            )}
          </Panel>

          <Panel icon={BellRing} title="Emails sent">
            <div className="divide-y divide-line/[0.07]">
              <Row label="Invoice">{inv.reminders?.issuedEmailAt ? dateTime(inv.reminders.issuedEmailAt) : "—"}</Row>
              <Row label="Due soon">{inv.reminders?.dueSoonAt ? dateTime(inv.reminders.dueSoonAt) : "Not yet"}</Row>
              <Row label="Overdue">{inv.reminders?.overdueAt ? dateTime(inv.reminders.overdueAt) : "Not yet"}</Row>
            </div>
            <p className="mt-2 text-xs text-ink-muted">Each goes out once. The billing job decides when.</p>
          </Panel>
        </div>
      </div>

      <RecordPaymentDialog
        open={dialog === "pay"}
        invoice={inv}
        onClose={() => setDialog(null)}
        onRecorded={({ invoice, subscription }) => {
          setInv(invoice);
          setDialog(null);
          toast(
            subscription?.status === "active"
              ? `Payment recorded — ${inv.organizationName} is active, receipt emailed`
              : "Payment recorded — receipt emailed"
          );
        }}
      />
      <ReasonDialog
        open={dialog === "void"}
        onClose={() => setDialog(null)}
        icon={Ban}
        title={`Void ${inv.number}?`}
        subtitle="Nothing will be owed on it, and its number is never reused. A paid invoice can't be voided — refunds happen outside SILLA for now."
        label="Why — printed on the voided invoice"
        placeholder="e.g. Issued twice by mistake."
        confirmLabel="Void it"
        onConfirm={async (reason) => {
          const { invoice } = await billingApi.voidInvoice(inv.id, reason);
          setInv(invoice);
          setDialog(null);
          toast(`${inv.number} voided`);
        }}
      />
      <ReasonDialog
        open={dialog === "dismiss"}
        onClose={() => setDialog(null)}
        icon={SearchX}
        title="Couldn't find the payment?"
        subtitle="The customer is emailed what you write here, and can tell us again. The invoice stays open."
        label="What you found — the customer reads this"
        placeholder="e.g. No GCash transfer with that reference has arrived yet."
        confirmLabel="Tell the customer"
        confirmVariant="primary"
        onConfirm={async (reason) => {
          const { invoice } = await billingApi.dismissClaim(inv.id, reason);
          setInv(invoice);
          setDialog(null);
          toast("The customer has been told");
        }}
      />
    </div>
  );
}

export default function Invoices({ navigate, id, can, query }) {
  return id ? <InvoiceDetail id={id} navigate={navigate} can={can} /> : <InvoiceList navigate={navigate} can={can} query={query} />;
}
