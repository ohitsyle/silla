import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CircleAlert, KeyRound, ShieldAlert } from "lucide-react";

import { Button, Modal, Notice } from "../components/ui.jsx";
import { CopyButton, ToneBadge } from "../billing/ui.jsx";
import { dateTime, shortDate } from "../billing/format.js";

/**
 * Pieces the staff console's operations sections share — orders, clients,
 * conversations, deployments, staff and the activity log. The billing
 * sections have theirs in billing/console.jsx; both build on
 * components/ui.jsx, so a field error or a focus ring reads the same in
 * every section.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/* ───────────────────────────── time ───────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "12 min ago", "3 h ago", "yesterday", "Oct 12" — for lists,
 * where how long something has waited matters more than its exact time.
 * The exact time is always in the element's title.
 */
/** How long something has waited: "7 min", "3 h", "2 days", "since Oct 12". */
export function waited(value, now = Date.now()) {
  if (!value) return "";
  const d = now - new Date(value).getTime();
  if (d < HOUR) return `${Math.max(1, Math.floor(d / MINUTE))} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  if (d < 14 * DAY) return `${Math.floor(d / DAY)} day${Math.floor(d / DAY) === 1 ? "" : "s"}`;
  return `since ${shortDate(value)}`;
}

export function ago(value, now = Date.now()) {
  if (!value) return "";
  const t = new Date(value).getTime();
  const d = now - t;
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return shortDate(value);
}

export function Ago({ value, className }) {
  if (!value) return null;
  return (
    <time dateTime={new Date(value).toISOString()} title={dateTime(value)} className={className}>
      {ago(value)}
    </time>
  );
}

/* ───────────────────────────── people ───────────────────────────── */

const initials = (name, email) =>
  String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || (email?.[0] || "?").toUpperCase();

/**
 * A person's initials in a circle. Staff wear SILLA's accent; customers a
 * neutral tint — in a thread, whose side a message is on should be
 * readable before the name is.
 */
export function Avatar({ name, email, tone = "customer", size = 32, className }) {
  const staff = tone === "staff";
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-full font-bold", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: staff ? "var(--color-accent)" : "rgb(var(--c-line) / 0.08)",
        color: staff ? "var(--color-accent-ink)" : "rgb(var(--c-ink-secondary))",
      }}
    >
      {initials(name, email)}
    </span>
  );
}

/** What each staff role may do — the table in docs/control-plane.md §5, in words. */
/**
 * A role is who someone is, not how something is going — so it never wears
 * a status colour (green "good", amber "waiting"). Owners carry SILLA's
 * accent because theirs is the reach worth noticing; the rest are neutral.
 */
export const ROLE_WORDS = {
  owner: { label: "Owner", tone: "info", summary: "Everything, including staff and settings." },
  admin: { label: "Admin", tone: "neutral", summary: "Orders, provisioning, deployments, billing, plans, settings and the activity log." },
  billing: { label: "Billing", tone: "neutral", summary: "Plans, subscriptions, invoices and payments." },
  support: { label: "Support", tone: "neutral", summary: "Orders, clients, conversations and owner-access resets." },
};

export function RoleBadge({ role, size = "sm" }) {
  const words = ROLE_WORDS[role] || { label: role, tone: "neutral" };
  return (
    <ToneBadge tone={words.tone} size={size}>
      {words.label}
    </ToneBadge>
  );
}

/* ───────────────────────────── layout ───────────────────────────── */

/** A section's detail page: the thing's name big, who and what under it, its status on the right. */
export function DetailHeader({ title, meta, status, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="mr-auto min-w-0">
        <h2 className="display break-words text-[clamp(1.6rem,3.4vw,2.3rem)]">{title}</h2>
        {meta && <div className="mt-1.5 text-sm text-ink-secondary">{meta}</div>}
      </div>
      {status}
      {actions && <div className="flex w-full flex-wrap gap-2 sm:w-auto">{actions}</div>}
    </div>
  );
}

/** The rounded card a list's rows sit in, with an optional column header for wide screens. */
export function ListCard({ head, children, className }) {
  return (
    <div className={cx("overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm", className)}>
      {head}
      <ul className="divide-y divide-line/[0.07]">{children}</ul>
    </div>
  );
}

export function ListRow({ index = 0, onClick, href, className, children }) {
  return (
    <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 12) * 0.025 }}>
      <a
        href={href}
        onClick={(e) => {
          // A real link, so it can be opened in a new tab; a plain click
          // stays in the console's own navigation.
          if (!onClick || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          onClick();
        }}
        className={cx("block w-full px-5 py-3.5 text-left transition-colors hover:bg-line/[0.03] focus-visible:bg-line/[0.03]", className)}
      >
        {children}
      </a>
    </motion.li>
  );
}

/** A count with its unit: "1 order", "3 orders". */
export const count = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString("en-PH")} ${n === 1 ? one : many}`;

/** Unread messages, as a small solid pill — the one thing in a row that should pull the eye. */
export function UnreadPill({ n, label = "unread" }) {
  if (!n) return null;
  return (
    <span
      className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
      style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      aria-label={`${n} ${label}`}
    >
      {n}
    </span>
  );
}

/* ───────────────────────────── data ───────────────────────────── */

/**
 * Loads something and reloads it on demand. Keeps the last answer on screen
 * while a reload is in flight, so a refresh never flashes a skeleton.
 */
export function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const live = useRef(true);
  const seq = useRef(0);
  // Set in the effect, not only at creation: StrictMode mounts, unmounts
  // and mounts again, and a flag only ever cleared would stay cleared.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => {
    const n = ++seq.current;
    return fn()
      .then((d) => {
        if (live.current && n === seq.current) {
          setData(d);
          setError(null);
        }
        return d;
      })
      .catch((err) => {
        if (live.current && n === seq.current) setError(err);
      });
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, load, setData };
}

/**
 * Re-runs `fn` every `ms` while the tab is visible — an inbox that only
 * changes when you reload it is one where a customer's message waits on
 * someone remembering to press F5. Paused in a hidden tab.
 */
export function useAutoRefresh(fn, ms = 30_000) {
  const saved = useRef(fn);
  useEffect(() => {
    saved.current = fn;
  }, [fn]);
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && saved.current?.();
    const timer = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}

/* ───────────────────────────── the control plane ───────────────────────────── */

/**
 * Why the product API can't be reached, said so someone can act on it —
 * the explanation the server wrote (deployments.routes.js explain()), with
 * the raw detail underneath for whoever fixes it.
 */
export function ControlPlaneProblem({ problem, className }) {
  if (!problem) return null;
  return (
    <div
      role="alert"
      className={cx("rounded-xl border px-4 py-3.5 text-sm", className)}
      style={{ borderColor: "rgb(var(--c-state-unavailable) / 0.35)", background: "rgb(var(--c-state-unavailable) / 0.06)" }}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={17} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-unavailable))" }} />
        <div className="min-w-0">
          <p className="font-semibold text-ink-primary">{problem.error || "The product API didn't answer."}</p>
          {problem.retry && <p className="mt-1 text-ink-secondary">{problem.retry}</p>}
          {problem.detail && <p className="mt-1 break-words font-mono text-xs text-ink-muted">{problem.detail}</p>}
        </div>
      </div>
    </div>
  );
}

/** The importer's own list of what is wrong with a profile — field, then what to fix. */
export function ProblemList({ problems }) {
  if (!problems?.length) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {problems.map((p, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <CircleAlert size={15} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-unavailable))" }} />
          <span>
            <code className="font-mono text-xs font-semibold text-ink-primary">{p.field || "profile"}</code>{" "}
            <span className="text-ink-secondary">{p.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── the one-time PIN ───────────────────────────── */

/**
 * A deployment owner's temporary PIN, shown ONCE.
 *
 * It exists outside the product only in this answer: SILLA never stores
 * it, and the product keeps only its hash. So the dialog cannot be closed
 * by a stray click or Escape — it asks to be dismissed on purpose, after
 * the PIN has been passed on. The product emails it to the owner too;
 * this copy is for when that email does not arrive.
 */
export function OneTimePin({ open, onClose, title, subtitle, email, pin, deploymentUrl, children }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={false}
      icon={KeyRound}
      title={title}
      subtitle={subtitle}
      width="max-w-xl"
      footer={
        <Button variant="primary" onClick={onClose} data-autofocus>
          I've passed it on
        </Button>
      }
    >
      <div className="space-y-5">
        {children}
        <div className="rounded-xl border border-line/10 bg-bg-panel/60 px-5 py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-muted">Temporary PIN for</span>
            <span className="min-w-0 truncate text-sm font-semibold">{email}</span>
          </div>
          <div className="mt-3 flex items-center justify-center gap-1.5 sm:gap-2" aria-label={`Temporary PIN ${String(pin).split("").join(" ")}`}>
            {String(pin)
              .split("")
              .map((digit, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.06 * i, duration: 0.25 }}
                  className="grid h-14 w-11 place-items-center rounded-[12px] border-2 border-line/[0.12] bg-bg-card font-mono text-2xl font-bold sm:h-16 sm:w-12"
                >
                  {digit}
                </motion.span>
              ))}
          </div>
          <div className="mt-3 flex justify-center">
            <CopyButton value={String(pin)} label="Copy PIN" />
          </div>
        </div>

        <div
          className="flex gap-3 rounded-xl px-4 py-3.5 text-sm leading-relaxed"
          style={{ background: "rgb(var(--c-state-reserved) / 0.12)" }}
        >
          <AlertTriangle size={17} className="mt-0.5 shrink-0" style={{ color: "rgb(var(--c-state-reserved))" }} />
          <p>
            <span className="font-bold">This is the only time it is shown.</span>{" "}
            <span className="text-ink-secondary">
              SILLA doesn't keep it and the product stores only a scrambled copy, so nobody can look it up later — a lost PIN is replaced
              by re-issuing owner access, not recovered. The owner has been emailed it too, and must change it the first time they sign
              in{deploymentUrl ? ` at ${deploymentUrl}` : ""}.
            </span>
          </p>
        </div>
      </div>
    </Modal>
  );
}

/** For a section that needs a permission this person lacks — said, rather than an empty page. */
export function NotYours({ children = "Your role doesn't include this." }) {
  return <Notice>{children}</Notice>;
}
