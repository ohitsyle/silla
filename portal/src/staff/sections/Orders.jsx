import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight, Ban, Check, ChevronDown, CircleCheck, Download, ExternalLink, FileText, Hammer, History, Inbox, Loader2, Lock,
  MessagesSquare, Rocket, Server, SearchX, StickyNote, Undo2, Wrench, X,
} from "lucide-react";

import { Button, EmptyState, Modal, Notice, Panel, Skeleton, Textarea } from "../../components/ui.jsx";
import { TextInput } from "../../account/kit.jsx";
import { StatusBadge, planLabel, quoteOf } from "../../account/shared.jsx";
import { billingApi } from "../../lib/billingApi.js";
import { staffApi } from "../../lib/staffApi.js";
import { slugify } from "../../lib/profile.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { dateTime, shortDate } from "../../billing/format.js";
import { BackTo, FilterTabs, ReasonDialog, Row, SearchBox, SubscriptionBadge, useDebounced } from "../../billing/console.jsx";
import { ToneBadge } from "../../billing/ui.jsx";
import {
  Ago, ControlPlaneProblem, DetailHeader, ListCard, ListRow, OneTimePin, ProblemList, UnreadPill, count, useLoad,
} from "../kit.jsx";
import { ComposeDialog } from "./Conversations.jsx";

/**
 * Staff console — Orders. The queue, moved into the console.
 *
 * The list opens on what still needs someone (submitted, or being built),
 * oldest updates last; one order is everything needed to act on it: what
 * they configured, the one-press PROVISION, the moves through its
 * lifecycle, the staff-only notes, its history and the conversations
 * about it.
 *
 * orders.read to look; orders.manage to move it or write a note;
 * deployments.provision to provision; and cancelling a LIVE order — which
 * switches a customer's system off — deployments.manage. Each control is
 * rendered only for a role the server would let through.
 */

const TABS = [
  ["open", "Waiting"],
  ["submitted", "Submitted"],
  ["provisioning", "Being built"],
  ["live", "Live"],
  ["cancelled", "Cancelled"],
  ["all", "All"],
];

const orderPath = (id) => `${ROUTES.staff}/orders/${id}`;

/* ───────────────────────────── the list ───────────────────────────── */

function OrderList({ navigate, query }) {
  const tab = TABS.some(([v]) => v === query.status) ? query.status : "open";
  const [q, setQ] = useState(query.q || "");
  const debounced = useDebounced(q);
  const plan = query.plan || "";
  const [plans, setPlans] = useState([]);

  // The filters live in the address, so this view can be linked and refreshed.
  const setFilters = (patch) =>
    navigate(withQuery(`${ROUTES.staff}/orders`, { status: tab === "open" ? "" : tab, q: debounced, plan, ...patch }), { replace: true });
  useEffect(() => {
    if ((query.q || "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    billingApi.plans().then((d) => setPlans(d.plans || [])).catch(() => {});
  }, []);

  const { data, error } = useLoad(
    () => staffApi.queue({ status: tab === "all" ? "" : tab, q: debounced, plan }),
    [tab, debounced, plan]
  );

  const counts = data?.counts || {};
  const tabs = TABS.map(([value, label]) => ({ value, label, count: counts[value] }));
  const rows = data?.orders || [];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <FilterTabs tabs={tabs} value={tab} onChange={(v) => setFilters({ status: v === "open" ? "" : v })} label="Order status" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchBox value={q} onChange={setQ} placeholder="Organization, buyer or address" />
          <label className="relative block sm:w-56">
            <span className="sr-only">Plan</span>
            <select
              value={plan}
              onChange={(e) => setFilters({ plan: e.target.value })}
              className="h-11 w-full appearance-none rounded-full border border-line/10 bg-bg-card pl-4 pr-10 text-sm outline-none transition-colors focus:border-line/30"
            >
              <option value="">Every plan</option>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
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
        <EmptyState icon={q || plan ? SearchX : Inbox} title={q || plan ? "Nothing matches that" : tab === "open" ? "Nothing is waiting" : "No orders here"}>
          {q || plan
            ? "Try an organization, the buyer's name or email, or an address."
            : tab === "open"
              ? "Submitted orders land here. Drafts stay private to the buyer until they send them."
              : "Orders appear here as they move through their lifecycle."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ListCard
          head={
            <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.5fr)_130px_110px_110px] gap-4 border-b border-line/[0.08] px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-muted lg:grid">
              <span>Organization</span>
              <span>Plan</span>
              <span>Status</span>
              <span>Messages</span>
              <span className="text-right">Updated</span>
            </div>
          }
        >
          {rows.map((o, i) => (
            <ListRow key={o.id} index={i} href={orderPath(o.id)} onClick={() => navigate(orderPath(o.id))}>
              <div className="grid gap-x-4 gap-y-1.5 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.5fr)_130px_110px_110px] lg:items-center">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-bold">{o.organizationName}</span>
                    <span className="lg:hidden">
                      <StatusBadge status={o.status} />
                    </span>
                  </span>
                  <span className="block truncate text-sm text-ink-muted">
                    {o.account ? `${o.account.name} · ${o.account.email}` : "Account removed"}
                  </span>
                </span>
                <span className="min-w-0 truncate text-sm">
                  <span className="font-semibold">{planLabel(o)}</span>
                  <span className="text-ink-muted">
                    {" · "}
                    {o.quotedAmount == null ? "priced with them" : quoteOf(o)}
                  </span>
                </span>
                <span className="hidden lg:block">
                  <StatusBadge status={o.status} />
                </span>
                <span className="flex items-center gap-2 text-sm text-ink-secondary">
                  {o.conversations?.unread ? (
                    <>
                      <UnreadPill n={o.conversations.unread} />
                      <span className="lg:hidden">unread {o.conversations.unread === 1 ? "message" : "messages"}</span>
                    </>
                  ) : o.conversations?.open ? (
                    <span className="inline-flex items-center gap-1.5">
                      <MessagesSquare size={14} className="text-ink-muted" /> {o.conversations.open} open
                    </span>
                  ) : (
                    <span className="text-ink-muted max-lg:hidden">—</span>
                  )}
                  {o.notes > 0 && (
                    <span className="inline-flex items-center gap-1 text-ink-muted" title={count(o.notes, "staff note")}>
                      <StickyNote size={13} /> {o.notes}
                    </span>
                  )}
                </span>
                <span className="text-sm text-ink-muted lg:text-right">
                  <Ago value={o.updatedAt} />
                </span>
              </div>
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}

/* ───────────────────────────── provisioning ───────────────────────────── */

/** A starting address from the organization's name, in the shape the product accepts. */
const suggestSlug = (name) => {
  const base = slugify(name);
  return base.length >= 3 ? base : base ? `${base}-org` : "";
};

const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * PROVISION: an address, checked live against the product as it is typed,
 * then one press — the organization is built from the buyer's profile,
 * the order goes live through its legal moves, billing starts the trial
 * and the buyer is emailed. The owner's temporary PIN comes back once.
 */
function ProvisionPanel({ order, onDone }) {
  const [plane, setPlane] = useState(null); // GET /deployments/status?ping=1
  const [slug, setSlug] = useState(() => suggestSlug(order.organizationName));
  const settled = useDebounced(slug.trim().toLowerCase(), 350);
  const [check, setCheck] = useState(null); // { slug, available, problem, suggestion, url } | { checking }
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null); // the server's answer when a press failed
  const [result, setResult] = useState(null); // the 201
  const owner = order.profile?.owner;

  const pingPlane = () => {
    setPlane((p) => (p ? { ...p, checking: true } : p));
    staffApi
      .controlPlane(true)
      .then(setPlane)
      .catch((err) => setPlane({ configured: false, reachable: false, problem: err.body || { error: err.message } }));
  };
  useEffect(pingPlane, []);

  useEffect(() => {
    let live = true;
    if (!settled) {
      setCheck(null);
      return undefined;
    }
    if (!SLUG_SHAPE.test(settled) || settled.includes("--")) {
      setCheck({ slug: settled, available: false, problem: "Use 3–40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number." });
      return undefined;
    }
    setCheck({ slug: settled, checking: true });
    staffApi
      .slugCheck(settled)
      .then((d) => live && setCheck(d))
      .catch((err) => live && setCheck({ slug: settled, error: err.body || { error: err.message } }));
    return () => {
      live = false;
    };
  }, [settled]);

  const productUrl = (plane?.productUrl || "").replace(/^https?:\/\//, "");
  const current = check && check.slug === slug.trim().toLowerCase() ? check : null;
  const fieldError =
    (revealed && !slug.trim() && "Choose the address their people will use.") ||
    (failure?.fields?.slug && failure.slugTried === slug.trim().toLowerCase() ? failure.fields.slug : null) ||
    (current && !current.checking && current.available === false ? current.problem : null);
  const suggestion = failure?.slugTried === slug.trim().toLowerCase() ? failure?.suggestion || current?.suggestion : current?.suggestion;

  const provision = async () => {
    setRevealed(true);
    if (!slug.trim()) return;
    setBusy(true);
    setFailure(null);
    const tried = slug.trim().toLowerCase();
    try {
      const done = await staffApi.provision(order.id, tried);
      setResult(done);
    } catch (err) {
      setFailure({ ...(err.body || {}), error: err.body?.error || err.message, status: err.status, slugTried: tried });
    } finally {
      setBusy(false);
    }
  };

  const planeDown = plane && (!plane.configured || plane.reachable === false);
  const code = failure?.code;
  const controlPlaneFailure = code && code.startsWith("CONTROL_PLANE_");

  return (
    <Panel
      icon={Rocket}
      title="Provision it"
      subtitle="Builds their organization from exactly what they configured, takes the order live, starts the trial and emails the buyer."
    >
      {planeDown && !failure && (
        <div className="mb-4">
          <ControlPlaneProblem
            problem={
              plane.problem || {
                error: "Provisioning isn't switched on for this service: the commerce API has no CONTROL_PLANE_SECRET. Set the same secret on it and on the product API, then restart both.",
              }
            }
          />
          <Button size="sm" variant="ghost" className="mt-2" icon={plane.checking ? Loader2 : undefined} onClick={pingPlane}>
            Check again
          </Button>
        </div>
      )}

      {!owner?.email && (
        <Notice tone="error" className="mb-4">
          This configuration doesn't name who will run the system, so it can't be provisioned — it would plant the demo accounts, whose
          sign-ins are public. Ask the customer who should own it.
        </Notice>
      )}

      <div>
        <label htmlFor="provision-slug" className="text-sm text-ink-secondary">
          Their address
        </label>
        <div
          className={`mt-1.5 flex h-11 items-stretch overflow-hidden rounded-md border bg-bg-panel transition-colors focus-within:border-line/40 ${
            fieldError ? "border-state-unavailable/60" : "border-line/10"
          }`}
        >
          {productUrl && (
            <span className="hidden max-w-[45%] items-center truncate border-r border-line/10 bg-line/[0.03] px-3 text-sm text-ink-muted sm:flex">
              {productUrl}/
            </span>
          )}
          <input
            id="provision-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            spellCheck="false"
            autoComplete="off"
            maxLength={40}
            aria-invalid={fieldError ? "true" : undefined}
            aria-describedby="provision-slug-status"
            className="min-w-0 flex-1 bg-transparent px-3 font-semibold text-ink-primary outline-none"
          />
          <span className="flex w-10 items-center justify-center" aria-hidden>
            {current?.checking ? (
              <Loader2 size={16} className="animate-spin text-ink-muted" />
            ) : current?.available ? (
              <Check size={17} strokeWidth={3} style={{ color: "rgb(var(--c-state-available))" }} />
            ) : current && !current.error && current.available === false ? (
              <X size={17} strokeWidth={3} style={{ color: "rgb(var(--c-state-unavailable))" }} />
            ) : null}
          </span>
        </div>
        <div id="provision-slug-status" className="mt-1 min-h-[1.25rem] text-xs font-medium" data-field-error={fieldError ? "" : undefined}>
          {fieldError ? (
            <span className="text-state-unavailable">
              {fieldError}
              {suggestion && suggestion !== slug.trim() && (
                <>
                  {" "}
                  <button type="button" onClick={() => setSlug(suggestion)} className="font-bold text-ink-primary underline decoration-2 underline-offset-2">
                    Use {suggestion}
                  </button>
                </>
              )}
            </span>
          ) : current?.available ? (
            <span className="text-ink-secondary">Free — their people will sign in at {current.url}</span>
          ) : current?.error ? (
            <span className="text-ink-muted">Couldn't check the address just now — provisioning will check it again.</span>
          ) : (
            <span className="text-ink-muted">Lowercase letters, numbers and hyphens. It can't be changed later.</span>
          )}
        </div>
      </div>

      {owner?.email && (
        <p className="mt-3 text-sm text-ink-secondary">
          <span className="font-semibold text-ink-primary">
            {owner.firstName} {owner.lastName}
          </span>{" "}
          ({owner.email}) becomes its owner, with a temporary PIN they change on first sign-in.
        </p>
      )}

      <AnimatePresence>
        {failure && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4">
            {controlPlaneFailure ? (
              <ControlPlaneProblem problem={failure} />
            ) : code === "INVALID_PROFILE" ? (
              <Notice tone="error">
                <span className="font-semibold">{failure.error}</span>
                <ProblemList problems={failure.problems} />
                <span className="mt-2 block text-ink-secondary">The buyer's configuration needs fixing first — write to them from the conversations below.</span>
              </Notice>
            ) : code === "SLUG_TAKEN" || code === "INVALID_SLUG" ? null : (
              <Notice tone="error">{failure.error}</Notice>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line/[0.08] pt-4">
        <Button variant="primary" icon={busy ? undefined : Rocket} loading={busy} onClick={provision} disabled={!owner?.email}>
          {busy ? "Building it…" : "Provision"}
        </Button>
        <span className="text-xs text-ink-muted">Takes a few seconds. Pressing it twice is safe — an order only ever gets one organization.</span>
      </div>

      {result && (
        <ProvisionedDialog
          result={result}
          order={order}
          onClose={() => {
            setResult(null);
            onDone();
          }}
        />
      )}
    </Panel>
  );
}

/** What PROVISION answered: the one-time PIN, or — for an organization an earlier press built — why there is none. */
function ProvisionedDialog({ result, order, onClose }) {
  const url = result.deployment?.url;
  const floors = result.summary?.floors;
  const units = result.summary?.units ?? result.summary?.resources;
  const facts = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <CircleCheck size={17} style={{ color: "rgb(var(--c-state-available))" }} />
        <span className="font-semibold">Live at</span>
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline decoration-line/30 underline-offset-2">
          {url} <ExternalLink size={13} />
        </a>
      </div>
      {(Array.isArray(floors) || units != null) && (
        <p className="text-sm text-ink-secondary">
          {Array.isArray(floors) ? `${count(floors.length, "floor")}, ` : ""}
          {units != null ? `${count(units, "bookable unit")} ` : ""}
          built from their configuration. {order.account?.email ? `${order.account.email} has been emailed that it's live.` : ""}
        </p>
      )}
      {result.billingWarning && <Notice tone="error">{result.billingWarning}</Notice>}
    </div>
  );

  if (!result.owner) {
    return (
      <Modal open onClose={onClose} icon={Server} title={`${order.organizationName} is live`} subtitle="Linked to the organization an earlier attempt built." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="space-y-4">
          {facts}
          <Notice>{result.notice}</Notice>
        </div>
      </Modal>
    );
  }
  return (
    <OneTimePin
      open
      onClose={onClose}
      title={`${order.organizationName} is live`}
      subtitle="Give the owner their temporary PIN if their welcome email doesn't arrive."
      email={result.owner.email}
      pin={result.owner.temporaryPin}
      deploymentUrl={url}
    >
      {facts}
    </OneTimePin>
  );
}

/* ───────────────────────────── the order's other panels ───────────────────────────── */

function DeploymentPanel({ order, navigate, canSeeDeployments }) {
  return (
    <Panel icon={Server} title="Their system" subtitle={order.provisionedAt ? `Provisioned ${dateTime(order.provisionedAt)}` : "Recorded by hand"}>
      <div className="divide-y divide-line/[0.07]">
        <Row label="Address">
          {order.deploymentUrl ? (
            <a href={order.deploymentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-line/30 underline-offset-2">
              {order.deploymentUrl.replace(/^https?:\/\//, "")} <ExternalLink size={13} />
            </a>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Organization id">
          <span className="font-mono text-xs">{order.provisionedOrganizationId || "Not recorded"}</span>
        </Row>
      </div>
      {canSeeDeployments && order.provisionedOrganizationId && (
        <Button size="sm" className="mt-4" icon={ArrowRight} onClick={() => navigate(`${ROUTES.staff}/deployments/${order.id}`)}>
          Usage, owners and plan
        </Button>
      )}
    </Panel>
  );
}

const unitsOf = (floor) => (floor?.resources || []).reduce((sum, r) => sum + (Array.isArray(r.units) ? r.units.length : 0), 0);

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (value, fallback) => (HEX.test(value || "") ? value : fallback);

/**
 * A floor as the product will draw it: their pieces on their grid, in
 * THEIR colours — the dark surface and accent their people will see, as
 * a small picture sitting on SILLA's page rather than more chrome.
 */
function FloorThumb({ floor, branding }) {
  const cols = floor?.grid?.cols || 1;
  const rows = floor?.grid?.rows || 1;
  const page = hexOr(branding?.surface?.page, "#11161D");
  const card = hexOr(branding?.surface?.card, "#1B232D");
  const accent = hexOr(branding?.primaryColor, "#E07A5F");
  const pad = 0.6;
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${cols + pad * 2} ${rows + pad * 2}`}
      className="block h-auto max-h-[150px] w-full rounded-lg"
      style={{ background: page }}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${floor.name}: a ${cols} by ${rows} grid with ${(floor.resources || []).length} pieces`}
    >
      {(floor.zones || []).map((z, i) => (
        <rect key={`z${i}`} x={z.bounds.col} y={z.bounds.row} width={z.bounds.w} height={z.bounds.h} rx={0.35} fill={card} />
      ))}
      {(floor.resources || []).map((r, i) => {
        const n = Array.isArray(r.units) ? r.units.length : 1;
        return (
          <rect key={`r${i}`} x={r.position.col + 0.14} y={r.position.row + 0.14} width={Math.max(0.72, n - 0.28)} height={0.72} rx={0.2} fill={accent} />
        );
      })}
    </svg>
  );
}

function ProfilePanel({ order }) {
  const p = order.profile || {};
  const floors = p.floors || [];
  const units = floors.reduce((sum, f) => sum + unitsOf(f), 0);

  const download = () => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${p.key || "profile"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  const facts = [
    ["Site", p.siteName],
    ["Owner", p.owner ? `${p.owner.firstName} ${p.owner.lastName} · ${p.owner.email}` : "Not named"],
    ["Their words", p.terminology && `${p.terminology.resourceNoun} · ${p.terminology.memberNoun} · ${p.terminology.facilityLabel}`],
    ["Member IDs", p.identity?.memberIdFormat],
    ["Open", p.policy?.operatingHours && `${p.policy.operatingHours.open}–${p.policy.operatingHours.close}`],
    ["Grace period", p.policy?.gracePeriodMinutes && `${p.policy.gracePeriodMinutes} min`],
    ["Catalog", p.catalog?.length ? p.catalog.map((c) => c.label).join(", ") : null],
  ].filter(([, v]) => v);

  return (
    <Panel
      icon={FileText}
      title="What they configured"
      subtitle={`${count(floors.length, "floor")} · ${count(units, "bookable unit")}${p.catalog?.length ? ` · ${count(p.catalog.length, "furniture type")}` : ""}`}
      action={
        <Button size="sm" icon={Download} onClick={download}>
          Profile
        </Button>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="divide-y divide-line/[0.07]">
          {facts.map(([label, value]) => (
            <Row key={label} label={label}>
              <span className="break-words">{value}</span>
            </Row>
          ))}
          {p.branding?.primaryColor && (
            <Row label="Colours">
              <span className="inline-flex items-center gap-1.5">
                {[p.branding.primaryColor, p.branding.surface?.page, p.branding.surface?.card, p.branding.ink?.primary]
                  .filter(Boolean)
                  .map((c, i) => (
                    <span key={i} title={c} className="h-5 w-5 rounded-full ring-1 ring-line/15" style={{ background: c }} />
                  ))}
              </span>
            </Row>
          )}
        </div>
        <div className="space-y-3">
          {floors.slice(0, 4).map((f) => (
            <figure key={f.name}>
              <FloorThumb floor={f} branding={p.branding} />
              <figcaption className="mt-1 flex justify-between text-xs text-ink-muted">
                <span className="font-semibold text-ink-secondary">{f.name}</span>
                <span>
                  {f.grid?.cols}×{f.grid?.rows} · {count(unitsOf(f), "unit")}
                </span>
              </figcaption>
            </figure>
          ))}
          {floors.length > 4 && <p className="text-xs text-ink-muted">…and {count(floors.length - 4, "more floor")}.</p>}
        </div>
      </div>
    </Panel>
  );
}

/** The moves an order can make next, as staff words. */
const MOVE = {
  provisioning: { label: "Mark as being built", icon: Hammer, hint: "Tells the buyer work has started." },
  submitted: { label: "Back to submitted", icon: Undo2, hint: "If it was marked too early." },
  live: { label: "Live, built by hand…", icon: Wrench, hint: "When it was seeded by hand: record where it lives." },
  cancelled: { label: "Cancel order…", icon: Ban, hint: "The buyer is emailed your reason." },
};

function StatusPanel({ order, can, onChanged }) {
  const toast = useToast();
  const [dialog, setDialog] = useState(null); // "cancelled" | "live"
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const manage = can("orders.manage");
  const allowed = (order.allowed || []).filter((s) => !(s === "cancelled" && order.status === "live" && !can("deployments.manage")));

  const move = async (status, extra = {}) => {
    setBusy(status);
    setError(null);
    try {
      await staffApi.moveOrder(order.id, { status, ...extra });
      toast(status === "cancelled" ? "Order cancelled — the buyer has been emailed" : status === "provisioning" ? "Marked as being built — the buyer has been told" : status === "live" ? "Live — the buyer has been emailed" : "Moved back to submitted");
      setDialog(null);
      onChanged();
    } catch (err) {
      if (dialog) throw err;
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Status" action={<StatusBadge status={order.status} />}>
      {order.provisioning && (
        <Notice className="mb-3">
          {order.provisioning.by?.name || "Someone"} is provisioning this order right now (since {dateTime(order.provisioning.since)}).
        </Notice>
      )}
      {!manage ? (
        <p className="text-sm text-ink-secondary">Your role can look at orders but not move them.</p>
      ) : allowed.length === 0 ? (
        <p className="text-sm text-ink-secondary">{order.status === "cancelled" ? "Cancelled orders stay as they are." : "Nothing further to do here."}</p>
      ) : (
        <div className="space-y-2">
          {allowed.map((status) => {
            const m = MOVE[status];
            if (!m) return null;
            return (
              <button
                key={status}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => (status === "cancelled" || status === "live" ? setDialog(status) : move(status))}
                className={`flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50 ${
                  status === "cancelled" ? "border-state-unavailable/25 hover:bg-state-unavailable/[0.06]" : "border-line/10 hover:border-line/25"
                }`}
              >
                {busy === status ? <Loader2 size={16} className="animate-spin text-ink-muted" /> : <m.icon size={16} className={status === "cancelled" ? "text-state-unavailable" : "text-ink-muted"} />}
                <span className="min-w-0">
                  <span className={`block text-sm font-semibold ${status === "cancelled" ? "text-state-unavailable" : ""}`}>{m.label}</span>
                  <span className="block text-xs text-ink-muted">{m.hint}</span>
                </span>
              </button>
            );
          })}
          {order.status === "live" && !can("deployments.manage") && (
            <p className="pt-1 text-xs text-ink-muted">Cancelling a live order switches their system off — an owner or admin can do that.</p>
          )}
        </div>
      )}
      {error && <Notice tone="error" className="mt-3">{error}</Notice>}

      <ReasonDialog
        open={dialog === "cancelled"}
        onClose={() => setDialog(null)}
        icon={Ban}
        title={`Cancel ${order.organizationName}'s order?`}
        subtitle={
          order.status === "live"
            ? "Their subscription ends and their system goes read-only straight away. Nothing is deleted."
            : "Its subscription ends and any open invoice for it is voided."
        }
        label="Why — the buyer is emailed this"
        placeholder="e.g. Duplicate of the order placed this morning."
        confirmLabel="Cancel the order"
        onConfirm={(note) => move("cancelled", { note })}
      />
      <ManualLiveDialog open={dialog === "live"} order={order} onClose={() => setDialog(null)} onConfirm={(body) => move("live", body)} />
    </Panel>
  );
}

/** Going live by hand — `npm run seed:file` was run on the server — records where it lives. */
function ManualLiveDialog({ open, order, onClose, onConfirm }) {
  const [url, setUrl] = useState("");
  const [orgId, setOrgId] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUrl(order.deploymentUrl || "");
      setOrgId(order.provisionedOrganizationId || "");
      setFields({});
    }
  }, [open, order]);

  const submit = async () => {
    const f = {};
    if (!/^https?:\/\/\S+$/i.test(url.trim())) f.deploymentUrl = "Enter the full address, starting with https://";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      await onConfirm({ deploymentUrl: url.trim(), provisionedOrganizationId: orgId.trim(), note: "Provisioned by hand" });
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
      icon={Wrench}
      title="Mark it live, built by hand"
      subtitle="For when the profile was seeded on the server with npm run seed:file. The buyer is emailed the address and the trial starts."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Mark live
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextInput label="Where it lives" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} error={fields.deploymentUrl} data-autofocus />
        <TextInput
          label="Organization id"
          optional
          hint="From the seeder's output. Without it the plan can't be pushed to their system."
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          error={fields.provisionedOrganizationId}
        />
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}

function NotesPanel({ order, can, onSaved }) {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const add = async () => {
    if (!text.trim()) {
      setError("Write the note first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { order: fresh } = await staffApi.addOrderNote(order.id, text.trim());
      setText("");
      onSaved(fresh);
      toast("Note added");
    } catch (err) {
      setError(err.fields?.body || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      icon={StickyNote}
      title="Staff notes"
      subtitle="What was agreed on a call, why it's waiting. Never shown to the buyer."
    >
      {order.notes?.length ? (
        <ul className="space-y-3">
          {order.notes.map((n) => (
            <li key={n.id} className="rounded-lg px-3.5 py-3 text-sm" style={{ background: "rgb(var(--c-state-reserved) / 0.08)" }}>
              <p className="whitespace-pre-line leading-relaxed">{n.body}</p>
              <p className="mt-1.5 text-xs text-ink-muted">
                {n.by?.name || "Staff"} · <Ago value={n.at} />
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No notes yet.</p>
      )}
      {can("orders.manage") && (
        <div className="mt-4">
          <Textarea
            label="Add a note"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={error}
            placeholder="Only staff see this."
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <Lock size={12} /> Staff only
            </span>
            <Button size="sm" loading={busy} onClick={add}>
              Add note
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function HistoryPanel({ order }) {
  const steps = [...(order.history || [])].reverse();
  return (
    <Panel icon={History} title="History">
      <ol className="relative space-y-4 border-l border-line/10 pl-5">
        {steps.map((h, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-bg-card" style={{ background: "rgb(var(--c-ink-muted))" }} />
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={h.status} />
              <span className="text-xs text-ink-muted">{dateTime(h.at)}</span>
            </div>
            <p className="mt-1 text-sm text-ink-secondary">
              {h.note || "—"}
              {h.by?.name ? <span className="text-ink-muted"> · {h.by.name}</span> : null}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function OrderConversations({ order, navigate, can, onStarted }) {
  const [compose, setCompose] = useState(false);
  return (
    <Panel
      icon={MessagesSquare}
      title="Conversations"
      subtitle="Threads about this order, with the buyer."
      action={
        can("conversations.reply") && order.account ? (
          <Button size="sm" onClick={() => setCompose(true)}>
            Write to them
          </Button>
        ) : null
      }
    >
      {order.conversations?.length ? (
        <ul className="-mx-2 divide-y divide-line/[0.07]">
          {order.conversations.map((c) => (
            <li key={c.id}>
              <a
                href={`${ROUTES.staff}/conversations/${c.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`${ROUTES.staff}/conversations/${c.id}`);
                }}
                className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-line/[0.03]"
              >
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
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">Nobody has written about this order yet.</p>
      )}
      {compose && (
        <ComposeDialog
          open
          onClose={() => setCompose(false)}
          customer={order.account}
          order={{ id: order.id, organizationName: order.organizationName }}
          onSent={(conversation) => {
            setCompose(false);
            onStarted?.();
            navigate(`${ROUTES.staff}/conversations/${conversation.id}`);
          }}
        />
      )}
    </Panel>
  );
}

/* ───────────────────────────── one order ───────────────────────────── */

function OrderDetail({ id, navigate, can }) {
  const { data, error, load, setData } = useLoad(() => staffApi.order(id), [id]);
  const order = data?.order;
  const back = () => navigate(`${ROUTES.staff}/orders`);

  if (error) {
    return (
      <div>
        <BackTo onClick={back}>All orders</BackTo>
        <Notice tone="error">{error.status === 404 ? "That order wasn't found. A buyer's unsubmitted draft never appears here." : error.message}</Notice>
      </div>
    );
  }
  if (!order) {
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

  const provisionable = ["submitted", "provisioning"].includes(order.status) && !order.provisionedOrganizationId;
  const account = order.account;

  return (
    <div>
      <BackTo onClick={back}>All orders</BackTo>
      <DetailHeader
        title={order.organizationName}
        status={<StatusBadge status={order.status} />}
        meta={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {account ? (
              <>
                {can("clients.read") ? (
                  <a
                    href={`${ROUTES.staff}/clients/${account.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`${ROUTES.staff}/clients/${account.id}`);
                    }}
                    className="font-semibold text-ink-primary underline decoration-line/25 underline-offset-2 hover:decoration-line/60"
                  >
                    {account.name}
                  </a>
                ) : (
                  <span className="font-semibold text-ink-primary">{account.name}</span>
                )}
                <a href={`mailto:${account.email}`} className="hover:text-ink-primary">
                  {account.email}
                </a>
                {!account.emailVerified && <ToneBadge tone="waiting" size="sm">Email not verified</ToneBadge>}
              </>
            ) : (
              "Account removed"
            )}
            <span aria-hidden>·</span>
            <span>
              {planLabel(order)}, billed {order.billingPeriod} · {order.quotedAmount == null ? "priced with them" : `quoted ${quoteOf(order)}`}
            </span>
            <span aria-hidden>·</span>
            <span>submitted {shortDate((order.history || []).find((h) => h.status === "submitted")?.at || order.createdAt)}</span>
          </span>
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {provisionable && can("deployments.provision") && <ProvisionPanel order={order} onDone={load} />}
          {provisionable && !can("deployments.provision") && (
            <Notice>Provisioning is for owners and admins. Once it's built, the address appears here and the buyer is emailed.</Notice>
          )}
          {(order.status === "live" || order.provisionedOrganizationId) && (
            <DeploymentPanel order={order} navigate={navigate} canSeeDeployments={can("deployments.read")} />
          )}
          <ProfilePanel order={order} />
          <OrderConversations order={order} navigate={navigate} can={can} onStarted={load} />
        </div>
        <div className="min-w-0 space-y-5">
          <StatusPanel order={order} can={can} onChanged={load} />
          {order.subscription && (
            <Panel title="Subscription" action={<SubscriptionBadge status={order.subscription.status} />}>
              <p className="text-sm text-ink-secondary">
                {order.subscription.planName}
                {order.subscription.trialEndsAt && order.subscription.status === "trialing" ? ` · trial ends ${shortDate(order.subscription.trialEndsAt)}` : ""}
                {order.subscription.currentPeriodEnd && order.subscription.status === "active" ? ` · paid through ${shortDate(order.subscription.currentPeriodEnd)}` : ""}
              </p>
              {order.subscription.sync?.error && (
                <p className="mt-2 text-xs font-medium text-state-unavailable">Their system hasn't heard the latest plan: {order.subscription.sync.error}</p>
              )}
              {can("billing.read") && (
                <Button size="sm" className="mt-3" icon={ArrowRight} onClick={() => navigate(`${ROUTES.staff}/subscriptions/${order.subscription.id}`)}>
                  Billing
                </Button>
              )}
            </Panel>
          )}
          <NotesPanel order={order} can={can} onSaved={(fresh) => setData({ order: fresh })} />
          <HistoryPanel order={order} />
        </div>
      </div>
    </div>
  );
}

export default function Orders({ navigate, id, can, query = {} }) {
  return id ? <OrderDetail id={id} navigate={navigate} can={can} /> : <OrderList navigate={navigate} can={can} query={query} />;
}
