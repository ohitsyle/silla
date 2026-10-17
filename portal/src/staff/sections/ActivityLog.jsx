import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Activity, ChevronDown, SearchX } from "lucide-react";

import { Button, EmptyState, Notice, Skeleton } from "../../components/ui.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { dateTime, longDate } from "../../billing/format.js";
import { SearchBox, useDebounced } from "../../billing/console.jsx";
import { Avatar, RoleBadge } from "../kit.jsx";

/**
 * Staff console — Activity. The audit log (vendor/src/models/AuditEvent.js),
 * read-only: who did what to whom. Every staff mutation writes one — an
 * order moved, a deployment provisioned, an owner's access re-issued, a
 * payment recorded, a colleague invited — and there is deliberately no
 * way to edit or delete one, here or anywhere.
 *
 * audit.read (owners and admins). Paged by cursor, newest first, so new
 * entries arriving at the top never shift the page being read.
 */

/** The families of action, in words — the first segment of each verb. */
const FAMILIES = {
  order: "Orders",
  deployment: "Deployments",
  conversation: "Conversations",
  staff: "Staff",
  subscription: "Subscriptions",
  invoice: "Invoices",
  plan: "Plans",
  settings: "Settings",
};

/** Where an entry's subject lives in the console, when it has a page. */
function targetLink(target) {
  if (!target?.id) return null;
  const at = {
    order: `${ROUTES.staff}/orders/${target.id}`,
    deployment: `${ROUTES.staff}/deployments/${target.id}`,
    conversation: `${ROUTES.staff}/conversations/${target.id}`,
    subscription: `${ROUTES.staff}/subscriptions/${target.id}`,
    invoice: `${ROUTES.staff}/invoices/${target.id}`,
    plan: `${ROUTES.staff}/plans/${target.id}`,
    account: `${ROUTES.staff}/clients/${target.id}`,
    staff: `${ROUTES.staff}/staff`,
    settings: `${ROUTES.staff}/settings`,
  }[target.type];
  return at || null;
}

const dayOf = (value) => {
  const d = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return longDate(value);
};
const timeOf = (value) => new Date(value).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });

export default function ActivityLog({ navigate, query = {} }) {
  const family = query.action || "";
  const actor = query.actor || "";
  const [q, setQ] = useState(query.q || "");
  const debounced = useDebounced(q);
  const [events, setEvents] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actions, setActions] = useState([]);
  const [people, setPeople] = useState([]);

  const setFilters = (patch) =>
    navigate(withQuery(`${ROUTES.staff}/activity`, { action: family, actor, q: debounced, targetType: query.targetType, targetId: query.targetId, ...patch }), {
      replace: true,
    });
  useEffect(() => {
    if ((query.q || "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    staffApi.activityActions().then((d) => setActions(d.actions || [])).catch(() => {});
    staffApi.directory().then((d) => setPeople(d.staff || [])).catch(() => {});
  }, []);

  const params = { action: family, actor, q: debounced, targetType: query.targetType, targetId: query.targetId, limit: 50 };
  useEffect(() => {
    let live = true;
    setError(null);
    staffApi
      .activity(params)
      .then((d) => {
        if (!live) return;
        setEvents(d.events);
        setNext(d.next);
      })
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, actor, debounced, query.targetType, query.targetId]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const d = await staffApi.activity({ ...params, before: next });
      setEvents((e) => [...e, ...d.events]);
      setNext(d.next);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const families = useMemo(() => {
    const present = new Set(actions.map((a) => a.split(".")[0]));
    return Object.entries(FAMILIES).filter(([key]) => present.has(key) || key === family);
  }, [actions, family]);

  const groups = useMemo(() => {
    const out = [];
    for (const e of events || []) {
      const day = dayOf(e.at);
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, events: [] });
      out[out.length - 1].events.push(e);
    }
    return out;
  }, [events]);

  const filtered = Boolean(family || actor || debounced || query.targetId);
  const select =
    "h-11 w-full appearance-none rounded-full border border-line/10 bg-bg-card pl-4 pr-10 text-sm outline-none transition-colors focus:border-line/30";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchBox value={q} onChange={setQ} placeholder="What happened, or to whom" />
        <label className="relative block lg:w-52">
          <span className="sr-only">Kind of action</span>
          <select value={family} onChange={(e) => setFilters({ action: e.target.value })} className={select}>
            <option value="">Every kind</option>
            {families.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted" />
        </label>
        <label className="relative block lg:w-56">
          <span className="sr-only">Who did it</span>
          <select value={actor} onChange={(e) => setFilters({ actor: e.target.value })} className={select}>
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.isYou ? `${p.name} (you)` : p.name}
              </option>
            ))}
          </select>
          <ChevronDown size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted" />
        </label>
        {query.targetId && (
          <Button size="sm" variant="ghost" onClick={() => setFilters({ targetType: "", targetId: "" })}>
            Show everything, not one record
          </Button>
        )}
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {!events && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {events && events.length === 0 && (
        <EmptyState icon={filtered ? SearchX : Activity} title={filtered ? "Nothing matches that" : "Nothing has happened yet"}>
          {filtered ? "Try another kind of action, another person, or fewer words." : "Every staff action lands here as it happens."}
        </EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.day}>
          <h3 className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">{g.day}</h3>
          <ol className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
            {g.events.map((e, i) => {
              const link = targetLink(e.target);
              const system = e.actorEmail === "system";
              return (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i, 10) * 0.015 }}
                  className="grid gap-x-4 gap-y-1 border-b border-line/[0.07] px-5 py-3 last:border-0 sm:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[72px_minmax(0,1fr)_minmax(0,260px)]"
                >
                  <time dateTime={new Date(e.at).toISOString()} title={dateTime(e.at)} className="pt-0.5 text-sm tabular-nums text-ink-muted">
                    {timeOf(e.at)}
                  </time>
                  <div className="min-w-0">
                    <p className="text-[15px] leading-snug text-ink-primary">{e.summary}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                      <span className="font-mono">{e.action}</span>
                      {link && e.target?.label && (
                        <>
                          <span aria-hidden>·</span>
                          <a
                            href={link}
                            onClick={(ev) => {
                              ev.preventDefault();
                              navigate(link);
                            }}
                            className="font-semibold text-ink-secondary underline decoration-line/25 underline-offset-2 hover:text-ink-primary"
                          >
                            {e.target.label}
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 max-lg:col-start-2 lg:justify-end">
                    {system ? (
                      <span className="text-xs font-semibold text-ink-muted">Automatic</span>
                    ) : (
                      <>
                        <Avatar name={e.actorEmail} email={e.actorEmail} tone={e.actorRole === "buyer" ? "customer" : "staff"} size={22} />
                        <span className="min-w-0 truncate text-xs text-ink-secondary">{e.actorEmail}</span>
                        {e.actorRole === "buyer" ? (
                          <span className="text-[11px] font-semibold text-ink-muted">customer</span>
                        ) : (
                          <RoleBadge role={e.actorRole} />
                        )}
                      </>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}

      {next && (
        <div className="flex justify-center">
          <Button loading={loadingMore} onClick={more}>
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}
