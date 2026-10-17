import { useEffect, useState } from "react";
import {
  Activity, ArrowRight, ExternalLink, Gauge, KeyRound, Layers, RefreshCw, SearchX, Server, ShieldCheck, UserRound,
} from "lucide-react";

import { Button, EmptyState, Modal, Notice, Panel, Skeleton } from "../../components/ui.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { dateTime, shortDate } from "../../billing/format.js";
import { BackTo, FilterTabs, Row, SearchBox, SubscriptionBadge, useDebounced } from "../../billing/console.jsx";
import { ToneBadge } from "../../billing/ui.jsx";
import { Ago, ControlPlaneProblem, DetailHeader, ListCard, ListRow, OneTimePin, useLoad } from "../kit.jsx";

/**
 * Staff console — Deployments. Every organization SILLA has provisioned,
 * and for one of them what the PRODUCT itself reports: how much of the
 * plan they use, whether anyone is actually booking, who owns it — read
 * live over the control plane (docs/control-plane.md §3), with the
 * vendor's own record still shown when the product can't be reached.
 *
 * deployments.read to look (every role); deployments.ownerAccess to
 * re-issue an owner's PIN (owners, admins, support — "I can't get in" is a
 * support call); deployments.manage to push the plan again.
 */

const TABS = [
  ["all", "All"],
  ["trialing", "On trial"],
  ["active", "Active"],
  ["past_due", "Past due"],
  ["suspended", "Suspended"],
  ["cancelled", "Cancelled"],
  ["none", "Not linked"],
];

const deploymentPath = (orderId) => `${ROUTES.staff}/deployments/${orderId}`;
const host = (url) => String(url || "").replace(/^https?:\/\//, "");

/** Whether the deployment has heard the latest plan, in words. */
function SyncState({ sync, compact = false }) {
  if (!sync) return <span className="text-sm text-ink-muted">—</span>;
  if (sync.error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-state-unavailable" title={sync.error}>
        <span className="h-1.5 w-1.5 rounded-full bg-state-unavailable" /> {compact ? "Not synced" : "Push failing"}
      </span>
    );
  }
  if (!sync.syncedAt) return <span className="text-sm text-ink-muted">Never pushed</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
      <ShieldCheck size={14} style={{ color: "rgb(var(--c-state-available))" }} /> <Ago value={sync.syncedAt} />
    </span>
  );
}

/* ───────────────────────────── the list ───────────────────────────── */

function DeploymentList({ navigate, query }) {
  const tab = TABS.some(([v]) => v === query.status) ? query.status : "all";
  const [q, setQ] = useState(query.q || "");
  const debounced = useDebounced(q);
  const setFilters = (patch) =>
    navigate(withQuery(`${ROUTES.staff}/deployments`, { status: tab === "all" ? "" : tab, q: debounced, ...patch }), { replace: true });

  useEffect(() => {
    if ((query.q || "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error } = useLoad(() => staffApi.deployments({ status: tab === "all" ? "" : tab, q: debounced }), [tab, debounced]);

  const counts = data?.counts || {};
  const tabs = TABS.map(([value, label]) => ({
    value,
    label,
    count: value === "all" ? data?.total : counts[value] || 0,
    alert: ["past_due", "suspended"].includes(value),
  })).filter((t) => t.value === "all" || t.value === tab || t.count);
  const rows = data?.deployments || [];

  return (
    <div className="space-y-5">
      {data && !data.configured && (
        <ControlPlaneProblem
          problem={{
            error:
              "Provisioning and plan pushes are off: the commerce API has no CONTROL_PLANE_SECRET. Set the same secret (32+ characters) on it and on the product API, then restart both.",
          }}
        />
      )}
      <div className="space-y-3">
        <FilterTabs tabs={tabs} value={tab} onChange={(v) => setFilters({ status: v === "all" ? "" : v })} label="Subscription status" />
        <SearchBox value={q} onChange={setQ} placeholder="Organization or address" />
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {data && rows.length === 0 && (
        <EmptyState icon={debounced ? SearchX : Server} title={debounced ? "Nothing matches that" : "Nothing provisioned yet"}>
          {debounced ? "Try an organization name or its address." : "Provision a submitted order from Orders and its system appears here."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ListCard
          head={
            <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_120px_minmax(0,1fr)_120px] gap-4 border-b border-line/[0.08] px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted lg:grid">
              <span>Organization</span>
              <span>Plan</span>
              <span>Status</span>
              <span>Plan pushed</span>
              <span className="text-right">Provisioned</span>
            </div>
          }
        >
          {rows.map((d, i) => (
            <ListRow key={d.orderId} index={i} href={deploymentPath(d.orderId)} onClick={() => navigate(deploymentPath(d.orderId))}>
              <div className="grid gap-x-4 gap-y-1.5 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_120px_minmax(0,1fr)_120px] lg:items-center">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-bold">{d.organizationName}</span>
                    <span className="lg:hidden">{d.subscription && <SubscriptionBadge status={d.subscription.status} size="sm" />}</span>
                  </span>
                  <span className="block truncate font-mono text-[13px] text-ink-muted">{host(d.url) || "no address recorded"}</span>
                </span>
                <span className="text-sm">
                  <span className="font-semibold">{d.subscription?.planName || d.planName}</span>
                  <span className="text-ink-muted"> · {d.billingPeriod}</span>
                </span>
                <span className="hidden lg:block">
                  {d.subscription ? <SubscriptionBadge status={d.subscription.status} /> : <ToneBadge size="sm">Not linked</ToneBadge>}
                </span>
                <span>
                  <SyncState sync={d.subscription?.sync} compact />
                </span>
                <span className="text-sm text-ink-muted lg:text-right">{d.provisionedAt ? shortDate(d.provisionedAt) : "by hand"}</span>
              </div>
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}

/* ───────────────────────────── one deployment ───────────────────────────── */

const LIMIT_WORDS = {
  resources: ["Bookable units", "unit", "units"],
  members: ["Members", "member", "members"],
  staff: ["Staff and admin accounts", "account", "accounts"],
  buildings: ["Buildings", "building", "buildings"],
  floors: ["Floors", "floor", "floors"],
  rooms: ["Rooms", "room", "rooms"],
};
/** What their system is told, in words (docs/control-plane.md §2). */
const STANDING = {
  trialing: "On trial",
  active: "Active",
  past_due: "Past due — still working",
  suspended: "Suspended — read-only",
  cancelled: "Cancelled — read-only",
};
const FEATURE_WORDS = {
  kiosk: "Kiosk check-in",
  reports: "Reports",
  customBranding: "Own colours",
  wholeRoomBooking: "Whole-room booking",
  emailReminders: "Reminder emails",
};

/**
 * One quantity against its limit. The fill carries how close it is — the
 * accent while there is room, amber from 80%, red at the limit — and the
 * track is a lighter step of the same hue, so the state reads across the
 * whole bar. The words say it too: colour is never the only signal.
 */
function Meter({ label, used, max, one, many }) {
  const unlimited = max === null || max === undefined;
  const share = unlimited ? 0 : max === 0 ? 1 : Math.min(1, used / max);
  // Red only for OVER the limit (a downgrade left more than the plan
  // allows). Exactly at it is normal for a structural cap — one building on
  // a one-building plan — so it is the amber of "nearly full", not an alarm.
  const tone = unlimited ? "--c-accent" : used > max ? "--c-state-unavailable" : share >= 0.8 ? "--c-state-reserved" : "--c-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="text-ink-secondary">
          <span className="font-bold text-ink-primary">{Number(used || 0).toLocaleString("en-PH")}</span>
          {unlimited ? ` ${used === 1 ? one : many} · no limit` : ` of ${max.toLocaleString("en-PH")}`}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ background: `rgb(var(${tone}) / 0.16)` }}>
          <div
            className="h-full rounded-full transition-[width] duration-slow ease-out"
            style={{ width: `${Math.max(share * 100, used > 0 ? 3 : 0)}%`, background: `rgb(var(${tone}))` }}
          />
        </div>
      )}
      {!unlimited && used >= max && (
        <p className={`mt-1 text-xs ${used > max ? "font-medium text-state-unavailable" : "text-ink-muted"}`}>
          {used > max ? `${used - max} over — nothing is removed, but no new ones can be added.` : "Full — another needs a bigger plan."}
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-bg-panel/70 px-4 py-3">
      <div className="text-xs font-semibold text-ink-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-extrabold tracking-tight">{value}</div>
      {sub && <div className="text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function OwnerAccessDialog({ open, onClose, deployment, owner, onIssued }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const { owner: issued } = await staffApi.ownerAccess(deployment.orderId, owner?.email);
      onIssued(issued);
    } catch (err) {
      setError(err.body?.code?.startsWith?.("CONTROL_PLANE_") ? err.body : { error: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      icon={KeyRound}
      title={`Re-issue ${owner?.firstName || "the owner"}'s access?`}
      subtitle={`${owner?.email} · ${deployment.organizationName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={KeyRound} loading={busy} onClick={issue}>
            Issue a new PIN
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm leading-relaxed text-ink-secondary">
        <p>
          Their current PIN stops working at once. They get a new temporary one — emailed to them, and shown to you once — and must change
          it the next time they sign in. Any lockout from wrong guesses is cleared.
        </p>
        <p>For the "I can't get in" call: check you're speaking to the owner before you read a PIN out.</p>
        {error && <ControlPlaneProblem problem={error} />}
      </div>
    </Modal>
  );
}

function DeploymentDetail({ id, navigate, can }) {
  const { data, error, load } = useLoad(() => staffApi.deployment(id), [id]);
  const [asking, setAsking] = useState(null); // the owner being re-issued
  const [issued, setIssued] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();
  const back = () => navigate(`${ROUTES.staff}/deployments`);

  if (error) {
    return (
      <div>
        <BackTo onClick={back}>All deployments</BackTo>
        <Notice tone="error">{error.status === 404 ? "No deployment for that order." : error.message}</Notice>
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

  const { deployment: d, live, liveError } = data;
  const ent = live?.entitlements || null;
  const usage = live?.usage || {};
  const managed = ent ? ent.managed !== false : true;

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await staffApi.syncDeployment(d.orderId);
      toast(result.ok ? "Plan pushed to their system" : result.error ? "The push failed — see below" : "Nothing to push yet", {
        tone: result.ok ? "success" : "error",
      });
      load();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <BackTo onClick={back}>All deployments</BackTo>
      <DetailHeader
        title={d.organizationName}
        status={d.subscription ? <SubscriptionBadge status={d.subscription.status} /> : <ToneBadge>Not linked</ToneBadge>}
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {d.url ? (
              <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold text-ink-primary hover:underline">
                {host(d.url)} <ExternalLink size={13} />
              </a>
            ) : (
              <span>No address recorded</span>
            )}
            <span aria-hidden>·</span>
            <span>{d.subscription?.planName || d.planName}</span>
            {d.provisionedAt && (
              <>
                <span aria-hidden>·</span>
                <span>provisioned {shortDate(d.provisionedAt)}</span>
              </>
            )}
            {d.account && (
              <>
                <span aria-hidden>·</span>
                {can("clients.read") ? (
                  <a
                    href={`${ROUTES.staff}/clients/${d.account.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`${ROUTES.staff}/clients/${d.account.id}`);
                    }}
                    className="underline decoration-line/25 underline-offset-2"
                  >
                    {d.account.name}
                  </a>
                ) : (
                  <span>{d.account.name}</span>
                )}
              </>
            )}
          </span>
        }
        actions={
          <Button size="sm" icon={ArrowRight} onClick={() => navigate(`${ROUTES.staff}/orders/${d.orderId}`)}>
            The order
          </Button>
        }
      />

      {liveError && (
        <div className="mb-5">
          <ControlPlaneProblem problem={{ ...liveError, error: `Their system couldn't be read just now. ${liveError.error || ""}`.trim() }} />
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Panel
            icon={Gauge}
            title="Usage against their plan"
            subtitle={
              live
                ? managed
                  ? `What their system holds now, against what ${ent?.planName || "their plan"} allows. Limits only stop new things being added.`
                  : "Unmanaged: this organization predates plans, so nothing is limited."
                : "Read from their system — unavailable right now."
            }
          >
            {live ? (
              <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                {Object.entries(LIMIT_WORDS).map(([key, [label, one, many]]) => (
                  <Meter key={key} label={label} used={usage[key] || 0} max={managed ? ent?.limits?.[key] ?? null : null} one={one} many={many} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Nothing to show until their system answers.</p>
            )}
          </Panel>

          <Panel icon={Activity} title="Is anyone using it?" subtitle="The last 30 days, from their system.">
            {live ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Figure label="Reservations" value={(live.activity?.reservations30d || 0).toLocaleString("en-PH")} />
                <Figure label="Check-ins" value={(live.activity?.checkIns30d || 0).toLocaleString("en-PH")} />
                <Figure
                  label="Last reservation"
                  value={live.activity?.lastReservationAt ? <Ago value={live.activity.lastReservationAt} /> : "None yet"}
                />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Unavailable right now.</p>
            )}
          </Panel>

          <Panel icon={UserRound} title="Owners" subtitle="Their superadmins, oldest first — the first is who provisioning created.">
            {live?.owners?.length ? (
              <ul className="-mx-2 divide-y divide-line/[0.07]">
                {live.owners.map((o) => (
                  <li key={o.email} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        {o.firstName} {o.lastName}
                      </span>
                      <span className="block truncate text-sm text-ink-muted">{o.email}</span>
                    </span>
                    {o.mustChangePin ? (
                      <ToneBadge tone="waiting" size="sm">
                        Hasn't set a PIN yet
                      </ToneBadge>
                    ) : (
                      <ToneBadge tone="good" size="sm">
                        Own PIN set
                      </ToneBadge>
                    )}
                    {can("deployments.ownerAccess") && (
                      <Button size="sm" icon={KeyRound} onClick={() => setAsking(o)}>
                        Re-issue access
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">{live ? "No superadmin on record." : "Unavailable right now."}</p>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-5">
          <Panel icon={Layers} title="Their plan, as their system holds it">
            {ent ? (
              <>
                <div className="divide-y divide-line/[0.07]">
                  <Row label="Plan">{managed ? ent.planName || ent.plan || "—" : "Unmanaged"}</Row>
                  {managed && <Row label="Standing">{STANDING[ent.status] || ent.status}</Row>}
                  {ent.currentPeriodEnd && <Row label="Runs to">{shortDate(ent.currentPeriodEnd)}</Row>}
                  {ent.graceEndsAt && <Row label="Grace until">{shortDate(ent.graceEndsAt)}</Row>}
                </div>
                {managed && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {Object.entries(FEATURE_WORDS).map(([key, label]) => {
                      const on = ent.features?.[key] !== false;
                      return (
                        <span
                          key={key}
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${on ? "" : "text-ink-muted line-through decoration-1"}`}
                          style={{ background: on ? "rgb(var(--c-state-available) / 0.14)" : "rgb(var(--c-line) / 0.06)" }}
                        >
                          {label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {ent.notice && <p className="mt-3 rounded-lg bg-line/[0.04] px-3 py-2 text-sm text-ink-secondary">“{ent.notice}”</p>}
              </>
            ) : (
              <p className="text-sm text-ink-muted">Unavailable right now.</p>
            )}
          </Panel>

          <Panel icon={RefreshCw} title="Plan pushes">
            <div className="divide-y divide-line/[0.07]">
              <Row label="Last pushed">{d.subscription?.sync?.syncedAt ? dateTime(d.subscription.sync.syncedAt) : "Never"}</Row>
            </div>
            {d.subscription?.sync?.error && (
              <p className="mt-3 rounded-lg px-3 py-2 text-sm" style={{ background: "rgb(var(--c-state-unavailable) / 0.08)" }}>
                <span className="font-semibold text-state-unavailable">The last push failed:</span>{" "}
                <span className="text-ink-secondary">{d.subscription.sync.error}</span>
              </p>
            )}
            <p className="mt-3 text-xs text-ink-muted">Every billing change pushes the plan by itself, and failures are retried. Push by hand after fixing a secret.</p>
            {can("deployments.manage") && d.subscription && (
              <Button size="sm" className="mt-3" icon={RefreshCw} loading={syncing} onClick={sync}>
                Push now
              </Button>
            )}
            {can("billing.read") && d.subscription && (
              <Button size="sm" variant="ghost" className="ml-1 mt-3" icon={ArrowRight} onClick={() => navigate(`${ROUTES.staff}/subscriptions/${d.subscription.id}`)}>
                Billing
              </Button>
            )}
          </Panel>
        </div>
      </div>

      {asking && (
        <OwnerAccessDialog
          open
          deployment={d}
          owner={asking}
          onClose={() => setAsking(null)}
          onIssued={(result) => {
            setAsking(null);
            setIssued(result);
            load();
          }}
        />
      )}
      {issued && (
        <OneTimePin
          open
          onClose={() => setIssued(null)}
          title="Owner access re-issued"
          subtitle={`${d.organizationName} · their old PIN no longer works`}
          email={issued.email}
          pin={issued.temporaryPin}
          deploymentUrl={d.url}
        />
      )}
    </div>
  );
}

export default function Deployments({ navigate, id, can, query = {} }) {
  return id ? <DeploymentDetail id={id} navigate={navigate} can={can} /> : <DeploymentList navigate={navigate} query={query} />;
}

