import { motion } from "framer-motion";
import { Activity, ArrowRight, ArrowUpRight, Inbox, MessagesSquare, Receipt, Server, ShoppingBag } from "lucide-react";

import { Notice, Panel, Skeleton } from "../../components/ui.jsx";
import { StatusBadge, planLabel } from "../../account/shared.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { formatMoney } from "../../lib/plans.js";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { SUBSCRIPTION_WORDS, SubscriptionBadge } from "../../billing/console.jsx";
import { Ago, Avatar, count, useAutoRefresh, useLoad, waited } from "../kit.jsx";

/**
 * Staff console — Overview. What is waiting, at a glance, and the way in
 * to each: every figure here is a link to the list it counts, already
 * filtered to it.
 *
 * Trimmed by the server per role (GET /api/vendor/staff/overview): money
 * only for billing.read, the activity feed only for audit.read. A support
 * agent sees orders and conversations, which is their day.
 */

const go = (navigate, to) => (e) => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(to);
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/**
 * A headline figure that is also the way to its list. Proportional figures
 * at this size (tabular ones look loose); the label says what it counts and
 * the line under it says what to do about it.
 */
function Tile({ icon: Icon, label, value, sub, to, navigate, urgent = false, index = 0 }) {
  return (
    <motion.a
      href={to}
      onClick={go(navigate, to)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className="group relative flex min-h-[124px] flex-col rounded-xl border border-line/10 bg-bg-card p-4 shadow-sm transition-colors hover:border-line/25 sm:min-h-[132px] sm:p-5"
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold leading-tight text-ink-secondary sm:text-sm">
        <span
          className="grid h-7 w-7 place-items-center rounded-[9px]"
          style={urgent ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" } : { background: "rgb(var(--c-accent) / 0.11)", color: "var(--color-accent)" }}
        >
          <Icon size={15} strokeWidth={2.4} />
        </span>
        {label}
        <ArrowUpRight size={15} className="ml-auto text-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="mt-3 text-[2rem] font-extrabold leading-none tracking-tight sm:text-[2.5rem]">{value}</span>
      {sub && <span className="mt-auto pt-2 text-xs leading-snug text-ink-muted sm:text-[13px]">{sub}</span>}
    </motion.a>
  );
}

export default function Overview({ navigate, me, can, refreshBadges }) {
  const { data, error, load } = useLoad(() => staffApi.overview(), []);
  useAutoRefresh(() => {
    load();
    refreshBadges?.();
  }, 30_000);

  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-12 w-2/3" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[124px] sm:h-[132px]" rounded="rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64" rounded="rounded-xl" />
      </div>
    );
  }

  const { orders, waiting, conversations, deployments, billing, recent } = data;
  const waitingCount = (orders.submitted || 0) + (orders.provisioning || 0);
  const first = String(me?.name || "").split(" ")[0];

  const headline = [
    waitingCount ? `${count(waitingCount, "order")} waiting` : null,
    conversations.unread ? `${count(conversations.unread, "customer")} waiting on a reply` : null,
    deployments.syncErrors ? `${count(deployments.syncErrors, "system")} not hearing their plan` : null,
    billing?.overdueInvoices ? `${count(billing.overdueInvoices, "invoice")} overdue` : null,
  ].filter(Boolean);

  const subscriptionRows = billing
    ? ["trialing", "active", "past_due", "suspended", "pending", "cancelled"].map((status) => [status, billing.subscriptions?.[status] || 0])
    : [];
  const subscriptionTotal = subscriptionRows.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="display text-[clamp(1.7rem,3.6vw,2.6rem)]">
          {greeting()}
          {first ? `, ${first}` : ""}.
        </h2>
        <p className="mt-2 text-ink-secondary">
          {headline.length ? `${headline.join(", ")}.` : "Nothing is waiting on anyone. Everything submitted is built, and every customer has an answer."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Tile
          index={0}
          icon={ShoppingBag}
          label="Orders waiting"
          value={waitingCount}
          urgent={waitingCount > 0}
          sub={
            waitingCount
              ? `${orders.submitted || 0} to build${orders.provisioning ? ` · ${orders.provisioning} being built` : ""}`
              : `${orders.live || 0} live in all`
          }
          to={withQuery(`${ROUTES.staff}/orders`, {})}
          navigate={navigate}
        />
        {can("conversations.read") && (
          <Tile
            index={1}
            icon={MessagesSquare}
            label="Unread messages"
            value={conversations.unread}
            urgent={conversations.unread > 0}
            sub={`${conversations.open} open · ${conversations.unassigned} unassigned${conversations.mine ? ` · ${conversations.mine} yours` : ""}`}
            to={withQuery(`${ROUTES.staff}/conversations`, { unread: conversations.unread ? true : "" })}
            navigate={navigate}
          />
        )}
        {can("deployments.read") && (
          <Tile
            index={2}
            icon={Server}
            label="Live systems"
            value={deployments.total}
            sub={deployments.syncErrors ? `${count(deployments.syncErrors, "plan push", "plan pushes")} failing` : "Every one has its latest plan"}
            to={`${ROUTES.staff}/deployments`}
            navigate={navigate}
          />
        )}
        {billing && (
          <Tile
            index={3}
            icon={Receipt}
            label="Overdue invoices"
            value={billing.overdueInvoices}
            urgent={billing.overdueInvoices > 0}
            sub={
              billing.overdueByCurrency?.length
                ? billing.overdueByCurrency.map((r) => `${formatMoney(r.total, { currency: r.currency, exact: true })} owed`).join(" · ")
                : "Nobody is late"
            }
            to={withQuery(`${ROUTES.staff}/invoices`, { tab: "overdue" })}
            navigate={navigate}
          />
        )}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel
          icon={Inbox}
          title="Waiting longest"
          subtitle="Submitted or being built — the one waiting longest first."
          action={
            <a href={`${ROUTES.staff}/orders`} onClick={go(navigate, `${ROUTES.staff}/orders`)} className="inline-flex items-center gap-1 text-sm font-semibold text-ink-secondary hover:text-ink-primary">
              All orders <ArrowRight size={14} />
            </a>
          }
        >
          {waiting.length ? (
            <ul className="-mx-2 divide-y divide-line/[0.07]">
              {waiting.map((o) => (
                <li key={o.id}>
                  <a
                    href={`${ROUTES.staff}/orders/${o.id}`}
                    onClick={go(navigate, `${ROUTES.staff}/orders/${o.id}`)}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-3 hover:bg-line/[0.03]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{o.organizationName}</span>
                      <span className="block truncate text-sm text-ink-muted">
                        {o.account?.name || "—"} · {planLabel(o)}
                      </span>
                    </span>
                    <span className="text-xs text-ink-muted" title="Since it last moved">
                      waiting {waited(o.updatedAt)}
                    </span>
                    <StatusBadge status={o.status} />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">Nothing is waiting. New orders land here the moment a buyer submits.</p>
          )}
        </Panel>

        <div className="space-y-5">
          {can("conversations.read") && (
            <Panel icon={MessagesSquare} title="Conversations">
              <ul className="-mx-2">
                {[
                  ["Unread", conversations.unread, { unread: true }],
                  ["Nobody has them", conversations.unassigned, { scope: "unassigned" }],
                  ["Yours", conversations.mine, { scope: "mine" }],
                  ["Open in all", conversations.open, {}],
                ].map(([label, n, params]) => {
                  const to = withQuery(`${ROUTES.staff}/conversations`, params);
                  return (
                    <li key={label}>
                      <a href={to} onClick={go(navigate, to)} className="flex items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-line/[0.03]">
                        <span className="text-ink-secondary">{label}</span>
                        <span className="font-bold">{n}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          {billing && (
            <Panel
              icon={Receipt}
              title="Subscriptions"
              subtitle={subscriptionTotal ? `${count(subscriptionTotal, "subscription")} in all.` : "None yet — one starts when a buyer submits an order."}
            >
              {subscriptionTotal > 0 && (
                <ul className="-mx-2">
                  {subscriptionRows
                    .filter(([, n]) => n > 0)
                    .map(([status, n]) => {
                      const to = withQuery(`${ROUTES.staff}/subscriptions`, { status });
                      return (
                        <li key={status}>
                          <a href={to} onClick={go(navigate, to)} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-line/[0.03]">
                            <SubscriptionBadge status={status} size="sm" />
                            <span className="flex items-center gap-3">
                              <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-line/[0.07] sm:block" aria-hidden>
                                <span
                                  className="block h-full rounded-full"
                                  style={{ width: `${(n / subscriptionTotal) * 100}%`, background: "rgb(var(--c-ink-muted))" }}
                                />
                              </span>
                              <span className="w-6 text-right font-bold">{n}</span>
                            </span>
                          </a>
                        </li>
                      );
                    })}
                </ul>
              )}
              <span className="sr-only">{Object.entries(SUBSCRIPTION_WORDS).map(([k, w]) => `${w.label}: ${billing.subscriptions?.[k] || 0}`).join(", ")}</span>
            </Panel>
          )}
        </div>
      </div>

      {recent && (
        <Panel
          icon={Activity}
          title="Lately"
          action={
            <a href={`${ROUTES.staff}/activity`} onClick={go(navigate, `${ROUTES.staff}/activity`)} className="inline-flex items-center gap-1 text-sm font-semibold text-ink-secondary hover:text-ink-primary">
              The whole log <ArrowRight size={14} />
            </a>
          }
        >
          {recent.length ? (
            <ol className="-mx-2">
              {recent.map((e) => (
                <li key={e.id} className="flex items-start gap-3 rounded-lg px-2 py-2">
                  {e.actorEmail === "system" ? (
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-line/[0.06] text-[10px] font-bold text-ink-muted">●</span>
                  ) : (
                    <Avatar name={e.actorEmail} email={e.actorEmail} tone={e.actorRole === "buyer" ? "customer" : "staff"} size={24} className="mt-0.5" />
                  )}
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="text-ink-primary">{e.summary}</span>
                    <span className="block text-xs text-ink-muted">
                      {e.actorEmail === "system" ? "Automatic" : e.actorEmail} · <Ago value={e.at} />
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-muted">Nothing yet.</p>
          )}
        </Panel>
      )}
    </div>
  );
}
