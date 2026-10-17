import { useEffect, useState } from "react";
import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, FileText, MailCheck, MailWarning, MessagesSquare, PenLine, Receipt, SearchX, Server,
  ShoppingBag, UserRound, Users,
} from "lucide-react";

import { Button, EmptyState, Notice, Panel, Skeleton } from "../../components/ui.jsx";
import { StatusBadge, planLabel, quoteOf } from "../../account/shared.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { formatMoney } from "../../lib/plans.js";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { dateTime, invoiceState, longDate, shortDate } from "../../billing/format.js";
import { BackTo, FilterTabs, Row, SearchBox, SubscriptionBadge, useDebounced } from "../../billing/console.jsx";
import { ToneBadge } from "../../billing/ui.jsx";
import { Ago, Avatar, DetailHeader, ListCard, ListRow, UnreadPill, count, useLoad } from "../kit.jsx";
import { ComposeDialog } from "./Conversations.jsx";

/**
 * Staff console — Clients. Every buyer account, and one buyer's whole
 * picture: who they are, everything they ordered, what is live, what they
 * are paying (for roles that see money), what they have said to us and
 * what we have done for them.
 *
 * Read-only by design (clients.read, every role). Orders, threads and
 * deployments are changed in their own sections, through routes that
 * audit; this is where to find them. A buyer's unsubmitted drafts are
 * counted, never shown — they are not an order until sent.
 */

const TABS = [
  ["all", "Everyone"],
  ["live", "Live"],
  ["unverified", "Email not verified"],
];
const SUBSCRIPTION_FILTERS = [
  ["", "Any subscription"],
  ["trialing", "On trial"],
  ["active", "Active"],
  ["past_due", "Past due"],
  ["suspended", "Suspended"],
  ["pending", "Pending"],
  ["cancelled", "Cancelled"],
  ["none", "No subscription"],
];

const clientPath = (id) => `${ROUTES.staff}/clients/${id}`;

/** A link inside a panel that stays in the console's own navigation. */
function Go({ to, navigate, children, className = "" }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
      className={className}
    >
      {children}
    </a>
  );
}

/* ───────────────────────────── the directory ───────────────────────────── */

function ClientList({ navigate, query }) {
  const filter = TABS.some(([v]) => v === query.filter) ? query.filter : "all";
  const subscription = SUBSCRIPTION_FILTERS.some(([v]) => v && v === query.subscription) ? query.subscription : "";
  const page = Math.max(1, Number(query.page) || 1);
  const [q, setQ] = useState(query.q || "");
  const debounced = useDebounced(q);

  const setFilters = (patch) =>
    navigate(withQuery(`${ROUTES.staff}/clients`, { filter: filter === "all" ? "" : filter, subscription, q: debounced, page: "", ...patch }), {
      replace: true,
    });
  useEffect(() => {
    if ((query.q || "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error } = useLoad(
    () => staffApi.clients({ filter: filter === "all" ? "" : filter, subscription, q: debounced, page: page > 1 ? page : "" }),
    [filter, subscription, debounced, page]
  );

  const counts = data?.counts || {};
  const tabs = TABS.map(([value, label]) => ({ value, label, count: counts[value] }));
  const rows = data?.clients || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize || 50)));
  const filtered = Boolean(debounced || subscription || filter !== "all");

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <FilterTabs tabs={tabs} value={filter} onChange={(v) => setFilters({ filter: v === "all" ? "" : v })} label="Clients" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchBox value={q} onChange={setQ} placeholder="Name, email or organization" />
          <label className="relative block sm:w-56">
            <span className="sr-only">Subscription</span>
            <select
              value={subscription}
              onChange={(e) => setFilters({ subscription: e.target.value })}
              className="h-11 w-full appearance-none rounded-full border border-line/10 bg-bg-card pl-4 pr-10 text-sm outline-none transition-colors focus:border-line/30"
            >
              {SUBSCRIPTION_FILTERS.map(([value, label]) => (
                <option key={value || "any"} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted" />
          </label>
        </div>
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {data && rows.length === 0 && (
        <EmptyState icon={filtered ? SearchX : Users} title={filtered ? "Nobody matches that" : "No clients yet"}>
          {filtered ? "Try a name, an email or an organization, or clear the filters." : "Anyone who creates an account on the storefront appears here."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ListCard
          head={
            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_110px] gap-4 border-b border-line/[0.08] px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted lg:grid">
              <span>Client</span>
              <span>Orders</span>
              <span>Subscription</span>
              <span>Messages</span>
              <span className="text-right">Last active</span>
            </div>
          }
        >
          {rows.map((c, i) => (
            <ListRow key={c.id} index={i} href={clientPath(c.id)} onClick={() => navigate(clientPath(c.id))}>
              <div className="grid gap-x-4 gap-y-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_110px] lg:items-center">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name={c.name} email={c.email} size={36} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{c.name}</span>
                      {!c.emailVerified && (
                        <span title="Email not verified — they can't submit an order yet">
                          <MailWarning size={14} style={{ color: "rgb(var(--c-state-reserved))" }} aria-label="Email not verified" />
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-sm text-ink-muted">
                      {c.organizationName ? `${c.organizationName} · ` : ""}
                      {c.email}
                    </span>
                  </span>
                </span>
                <span className="text-sm text-ink-secondary">
                  {c.counts.orders ? (
                    <>
                      {count(c.counts.orders, "order")}
                      {c.counts.live ? <span className="text-ink-primary"> · {c.counts.live} live</span> : null}
                      {c.counts.open ? <span> · {c.counts.open} waiting</span> : null}
                    </>
                  ) : (
                    <span className="text-ink-muted">No orders yet</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {c.subscriptions.length ? (
                    c.subscriptions.map((s, j) => <SubscriptionBadge key={j} status={s} size="sm" />)
                  ) : (
                    <span className="text-sm text-ink-muted max-lg:hidden">—</span>
                  )}
                </span>
                <span className="flex items-center gap-2 text-sm text-ink-secondary">
                  {c.counts.unread ? (
                    <>
                      <UnreadPill n={c.counts.unread} /> unread
                    </>
                  ) : c.counts.conversations ? (
                    <span className="inline-flex items-center gap-1.5">
                      <MessagesSquare size={14} className="text-ink-muted" /> {c.counts.conversations} open
                    </span>
                  ) : (
                    <span className="text-ink-muted max-lg:hidden">—</span>
                  )}
                </span>
                <span className="text-sm text-ink-muted lg:text-right">
                  <Ago value={c.lastActivityAt} />
                </span>
              </div>
            </ListRow>
          ))}
        </ListCard>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 text-sm text-ink-secondary">
          <span>
            {(page - 1) * (data?.pageSize || 50) + 1}–{Math.min(page * (data?.pageSize || 50), total)} of {total}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => setFilters({ page: page - 1 > 1 ? page - 1 : "" })}>
              Newer
            </Button>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setFilters({ page: page + 1 })}>
              Older <ChevronRight size={14} />
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── one client ───────────────────────────── */

const ACTION_WORDS = {
  "order.status": "Order moved",
  "order.note": "Staff note",
  "order.update": "Order updated",
  "deployment.provision": "Provisioned",
  "deployment.provision.failed": "Provisioning failed",
  "deployment.owner_access": "Owner access",
  "deployment.sync": "Plan pushed",
  "conversation.start": "Wrote to them",
  "conversation.reply": "Replied",
  "conversation.note": "Internal note",
  "conversation.assign": "Assigned",
  "conversation.status": "Thread",
  "subscription.status": "Subscription",
  "subscription.create": "Subscribed",
  "invoice.issue": "Invoice",
  "invoice.payment": "Payment",
};

function ClientDetail({ id, navigate, can }) {
  const { data, error } = useLoad(() => staffApi.client(id), [id]);
  const [compose, setCompose] = useState(false);
  const back = () => navigate(`${ROUTES.staff}/clients`);

  if (error) {
    return (
      <div>
        <BackTo onClick={back}>All clients</BackTo>
        <Notice tone="error">{error.status === 404 ? "That client wasn't found. Staff accounts aren't clients." : error.message}</Notice>
      </div>
    );
  }
  if (!data) {
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

  const { client, orders, subscriptions, invoices, conversations, deployments, activity, drafts } = data;
  const billing = client.billing || {};
  const address = [billing.address1, billing.address2, [billing.city, billing.region].filter(Boolean).join(", "), billing.postalCode, billing.country]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <BackTo onClick={back}>All clients</BackTo>
      <DetailHeader
        title={client.name}
        status={
          client.emailVerified ? (
            <ToneBadge tone="good">
              <MailCheck size={12} /> Verified
            </ToneBadge>
          ) : (
            <ToneBadge tone="waiting">
              <MailWarning size={12} /> Email not verified
            </ToneBadge>
          )
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a href={`mailto:${client.email}`} className="font-semibold text-ink-primary hover:underline">
              {client.email}
            </a>
            {client.organizationName && (
              <>
                <span aria-hidden>·</span>
                <span>{client.organizationName}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>customer since {shortDate(client.createdAt)}</span>
            {client.lastLoginAt && (
              <>
                <span aria-hidden>·</span>
                <span>
                  last signed in <Ago value={client.lastLoginAt} />
                </span>
              </>
            )}
          </span>
        }
        actions={
          can("conversations.reply") ? (
            <Button icon={PenLine} onClick={() => setCompose(true)}>
              Write to {client.firstName || "them"}
            </Button>
          ) : null
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Panel
            icon={ShoppingBag}
            title="Orders"
            subtitle={drafts ? `Plus ${count(drafts, "unsubmitted draft")} — private to them until they send it.` : undefined}
          >
            {orders.length ? (
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {orders.map((o) => (
                  <li key={o.id}>
                    <Go to={`${ROUTES.staff}/orders/${o.id}`} navigate={navigate} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-line/[0.03]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{o.organizationName}</span>
                        <span className="block text-sm text-ink-muted">
                          {planLabel(o)} · {o.quotedAmount == null ? "priced with them" : quoteOf(o)} · updated <Ago value={o.updatedAt} />
                        </span>
                      </span>
                      <StatusBadge status={o.status} />
                    </Go>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">{drafts ? "Nothing submitted yet." : "No orders yet."}</p>
            )}
          </Panel>

          {deployments.length > 0 && (
            <Panel icon={Server} title="Live systems">
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {deployments.map((d) => (
                  <li key={d.orderId}>
                    <Go
                      to={`${ROUTES.staff}/deployments/${d.orderId}`}
                      navigate={navigate}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 hover:bg-line/[0.03]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{d.organizationName}</span>
                        <span className="block truncate text-sm text-ink-muted">{d.url || "No address recorded"}</span>
                      </span>
                      {d.subscriptionStatus && <SubscriptionBadge status={d.subscriptionStatus} />}
                    </Go>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel icon={MessagesSquare} title="Conversations">
            {conversations.length ? (
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <Go to={`${ROUTES.staff}/conversations/${c.id}`} navigate={navigate} className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-line/[0.03]">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{c.subject}</span>
                          {c.status === "closed" && <ToneBadge size="sm">Closed</ToneBadge>}
                        </span>
                        <span className="block truncate text-sm text-ink-muted">
                          {c.lastMessageBy === "staff" ? "SILLA: " : ""}
                          {c.lastMessagePreview}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-muted">
                        <Ago value={c.lastMessageAt} />
                        <UnreadPill n={c.unread} />
                      </span>
                    </Go>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">They haven't written to us, and we haven't written to them.</p>
            )}
          </Panel>

          <Panel icon={Activity} title="What we've done" subtitle="Every staff action on their orders, systems and threads, newest first.">
            {activity.length ? (
              <ol className="space-y-3">
                {activity.map((e) => (
                  <li key={e.id} className="flex gap-3 text-sm">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: "rgb(var(--c-line) / 0.25)" }} />
                    <span className="min-w-0">
                      <span className="text-ink-primary">{e.summary}</span>
                      <span className="block text-xs text-ink-muted">
                        {ACTION_WORDS[e.action] || e.action} · {e.actorEmail === "system" ? "automatic" : e.actorEmail} ·{" "}
                        <time title={dateTime(e.at)}>{dateTime(e.at)}</time>
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-muted">Nothing yet.</p>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel icon={UserRound} title="Account">
            <div className="divide-y divide-line/[0.07]">
              <Row label="Name">{[client.firstName, client.middleName, client.lastName, client.suffix].filter(Boolean).join(" ") || client.name}</Row>
              <Row label="Email">{client.emailVerified ? `verified ${shortDate(client.emailVerifiedAt)}` : "not verified"}</Row>
              <Row label="Terms">{client.termsAcceptedAt ? `accepted ${shortDate(client.termsAcceptedAt)}` : "not on record"}</Row>
              <Row label="Joined">{longDate(client.createdAt)}</Row>
              {!client.active && <Row label="Access">Deactivated</Row>}
            </div>
          </Panel>

          <Panel icon={FileText} title="Invoices go to">
            {billing.name || billing.email || address ? (
              <div className="space-y-1 text-sm">
                {billing.name && <p className="font-semibold">{billing.name}</p>}
                {billing.company && <p>{billing.company}</p>}
                {billing.email && <p className="text-ink-secondary">{billing.email}</p>}
                {address && <p className="text-ink-secondary">{address}</p>}
                {billing.taxId && <p className="text-ink-muted">TIN {billing.taxId}</p>}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Their account details — they haven't added billing details.</p>
            )}
          </Panel>

          {subscriptions.length > 0 && (
            <Panel icon={Receipt} title="Subscriptions">
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {subscriptions.map((s) => {
                  const inner = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{s.organizationName}</span>
                        <span className="block text-xs text-ink-muted">
                          {s.planName} · {s.billingPeriod}
                          {s.status === "trialing" && s.trialEndsAt ? ` · trial ends ${shortDate(s.trialEndsAt)}` : ""}
                          {s.status === "active" && s.currentPeriodEnd ? ` · paid through ${shortDate(s.currentPeriodEnd)}` : ""}
                        </span>
                      </span>
                      <SubscriptionBadge status={s.status} size="sm" />
                    </>
                  );
                  return (
                    <li key={s.id}>
                      {can("billing.read") ? (
                        <Go to={`${ROUTES.staff}/subscriptions/${s.id}`} navigate={navigate} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-line/[0.03]">
                          {inner}
                        </Go>
                      ) : (
                        <div className="flex items-center gap-3 px-2 py-2.5">{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          {invoices && invoices.length > 0 && (
            <Panel icon={Receipt} title="Invoices">
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {invoices.map((inv) => {
                  const state = invoiceState(inv);
                  return (
                    <li key={inv.id}>
                      <Go to={`${ROUTES.staff}/invoices/${inv.id}`} navigate={navigate} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-line/[0.03]">
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs font-semibold">{inv.number}</span>
                          <span className="block text-sm tabular-nums">{formatMoney(inv.total, { currency: inv.currency, exact: true })}</span>
                        </span>
                        <ToneBadge tone={state.tone} size="sm">
                          {state.label}
                        </ToneBadge>
                      </Go>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {compose && (
        <ComposeDialog
          open
          onClose={() => setCompose(false)}
          customer={{ id: client.id, name: client.name, email: client.email }}
          onSent={(conversation) => {
            setCompose(false);
            navigate(`${ROUTES.staff}/conversations/${conversation.id}`);
          }}
        />
      )}
    </div>
  );
}

export default function Clients({ navigate, id, can, query = {} }) {
  return id ? <ClientDetail id={id} navigate={navigate} can={can} /> : <ClientList navigate={navigate} can={can} query={query} />;
}
