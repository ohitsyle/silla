import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, Building2, CheckCheck, ChevronDown, Inbox, Lock, MessageSquareReply, MessagesSquare, PenLine, RotateCcw, SearchX, Send,
  UserRound,
} from "lucide-react";

import { Button, EmptyState, Modal, Notice, Skeleton, Textarea } from "../../components/ui.jsx";
import { SelectInput, TextInput } from "../../account/kit.jsx";
import { StatusBadge } from "../../account/shared.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { useToast } from "../../lib/toast.jsx";
import { ROUTES, withQuery } from "../../lib/useHashRoute.js";
import { dateTime } from "../../billing/format.js";
import { FilterTabs, SearchBox, useDebounced } from "../../billing/console.jsx";
import { Ago, Avatar, UnreadPill, useAutoRefresh, useLoad } from "../kit.jsx";

/**
 * Staff console — Conversations. An inbox: the threads on the left, the
 * one you are in on the right, so answering the next customer is one
 * click, not a page load.
 *
 * Two kinds of writing, which must never be confused:
 *   - a REPLY goes to the customer (and emails them if they haven't read
 *     it within the quiet period — workers/conversation.jobs.js);
 *   - an INTERNAL NOTE is for staff only. The server never returns one to
 *     a buyer (it is excluded in the query), but the person typing has to
 *     KNOW which one they are writing, so a note looks nothing like a
 *     reply — amber, dashed, padlocked — in the composer and in the thread.
 *
 * conversations.read to look, conversations.reply to write — every staff
 * role holds both today, and the server checks regardless.
 */

const QUIET_MINUTES = 10; // workers/conversation.jobs.js — the default the deployment runs with

const TABS = [
  ["open", "Open"],
  ["closed", "Closed"],
  ["all", "All"],
];
const SCOPES = [
  ["all", "Everyone's"],
  ["mine", "Mine"],
  ["unassigned", "Unassigned"],
];

const threadPath = (id) => `${ROUTES.staff}/conversations/${id}`;
const firstName = (person) => String(person?.name || "").split(" ")[0] || "them";

/* ───────────────────────────── the inbox list ───────────────────────────── */

function InboxList({ navigate, query, selected, refreshKey, action }) {
  const tab = TABS.some(([v]) => v === query.status) ? query.status : "open";
  const scope = SCOPES.some(([v]) => v === query.scope) ? query.scope : "all";
  const unread = query.unread === "1";
  const [q, setQ] = useState(query.q || "");
  const debounced = useDebounced(q);

  const base = selected ? threadPath(selected) : `${ROUTES.staff}/conversations`;
  const setFilters = (patch) =>
    navigate(withQuery(base, { status: tab === "open" ? "" : tab, scope: scope === "all" ? "" : scope, unread, q: debounced, ...patch }), {
      replace: true,
    });
  useEffect(() => {
    if ((query.q || "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error, load } = useLoad(
    () => staffApi.inbox({ status: tab, scope, unread, q: debounced }),
    [tab, scope, unread, debounced, refreshKey]
  );
  useAutoRefresh(load, 20_000);

  const counts = data?.counts || {};
  const rows = data?.conversations || [];
  const tabs = TABS.map(([value, label]) => ({ value, label, count: value === "all" ? undefined : counts[value] }));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-3 pb-3">
        <FilterTabs tabs={tabs} value={tab} onChange={(v) => setFilters({ status: v === "open" ? "" : v })} label="Thread status" />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Whose threads">
          {SCOPES.map(([value, label]) => {
            const on = scope === value;
            const n = value === "mine" ? counts.mine : value === "unassigned" ? counts.unassigned : null;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                onClick={() => setFilters({ scope: value === "all" ? "" : value })}
                className={`h-8 rounded-full px-3 text-[13px] font-semibold transition-colors ${
                  on ? "bg-ink-primary text-bg-card" : "text-ink-secondary hover:bg-line/[0.06]"
                }`}
              >
                {label}
                {n ? <span className={`ml-1.5 tabular-nums ${on ? "opacity-70" : "text-ink-muted"}`}>{n}</span> : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={unread}
            onClick={() => setFilters({ unread: !unread })}
            className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors ${
              unread ? "bg-ink-primary text-bg-card" : "text-ink-secondary hover:bg-line/[0.06]"
            }`}
          >
            Unread{counts.unread ? <span className={`tabular-nums ${unread ? "opacity-70" : "text-ink-muted"}`}>{counts.unread}</span> : null}
          </button>
        </div>
        <div className="flex items-center gap-2 [&>label]:min-w-0 [&>label]:flex-1 [&>label]:sm:w-auto">
          <SearchBox value={q} onChange={setQ} placeholder="Customer, subject or message" />
          {action}
        </div>
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[76px]" rounded="rounded-xl" />
          ))}
        </div>
      )}
      {data && rows.length === 0 && (
        <EmptyState icon={q ? SearchX : Inbox} title={q ? "Nothing matches that" : unread ? "Nothing unread" : tab === "open" ? "No open conversations" : "Nothing here"}>
          {q ? "Try the customer's name, email or organization." : "Customers write from their account or an order. Their threads land here."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <ul className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
          {rows.map((c, i) => {
            const active = c.id === selected;
            return (
              <motion.li
                key={c.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 10) * 0.02 }}
                className="border-b border-line/[0.07] last:border-b-0"
              >
                <a
                  href={withQuery(threadPath(c.id), { status: tab === "open" ? "" : tab, scope: scope === "all" ? "" : scope, unread, q: debounced })}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return;
                    e.preventDefault();
                    navigate(withQuery(threadPath(c.id), { status: tab === "open" ? "" : tab, scope: scope === "all" ? "" : scope, unread, q: debounced }));
                  }}
                  aria-current={active ? "true" : undefined}
                  className={`relative flex gap-3 px-4 py-3.5 transition-colors ${active ? "bg-[rgb(var(--c-accent)/0.08)]" : "hover:bg-line/[0.03]"}`}
                >
                  {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full" style={{ background: "var(--color-accent)" }} />}
                  <Avatar name={c.account?.name} email={c.account?.email} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-sm ${c.unread ? "font-extrabold" : "font-semibold"}`}>{c.account?.name || "Customer"}</span>
                      <span className="ml-auto shrink-0 text-xs text-ink-muted">
                        <Ago value={c.lastMessageAt} />
                      </span>
                    </span>
                    <span className={`block truncate text-sm ${c.unread ? "font-bold text-ink-primary" : "text-ink-primary"}`}>{c.subject}</span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">
                        {c.lastMessageBy === "staff" ? "You: " : ""}
                        {c.lastMessagePreview}
                      </span>
                      {c.assignee ? (
                        <span title={`Assigned to ${c.assignee.name}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted">
                          <UserRound size={11} />
                          {firstName(c.assignee)}
                        </span>
                      ) : (
                        c.status === "open" && <span className="text-[11px] font-semibold text-ink-muted">Unassigned</span>
                      )}
                      <UnreadPill n={c.unread} />
                    </span>
                  </span>
                </a>
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ───────────────────────────── one thread ───────────────────────────── */

function Message({ m, customer }) {
  if (m.internal) {
    return (
      <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-[560px]">
        <div
          className="rounded-xl border-2 border-dashed px-4 py-3"
          style={{ borderColor: "rgb(var(--c-state-reserved) / 0.55)", background: "rgb(var(--c-state-reserved) / 0.09)" }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "rgb(var(--m-accent-deep, 192 92 68))" }}>
            <Lock size={12} strokeWidth={2.6} /> Internal note · only staff see this
          </div>
          <p className="mt-1.5 whitespace-pre-line text-[15px] leading-relaxed">{m.body}</p>
          <p className="mt-1.5 text-xs text-ink-muted">
            {m.authorName} · <time title={dateTime(m.createdAt)}>{dateTime(m.createdAt)}</time>
          </p>
        </div>
      </motion.li>
    );
  }
  const staff = m.authorRole === "staff";
  return (
    <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex gap-2.5 ${staff ? "flex-row-reverse" : ""}`}>
      <Avatar name={m.authorName} tone={staff ? "staff" : "customer"} size={32} className="mt-5" />
      <div className={`min-w-0 max-w-[min(560px,85%)] ${staff ? "items-end text-right" : ""} flex flex-col`}>
        <span className="mb-1 px-1 text-xs text-ink-muted">
          <span className="font-semibold text-ink-secondary">{staff ? m.authorName : customer?.name || m.authorName}</span>
          {staff ? " · SILLA" : ""} · <time title={dateTime(m.createdAt)}>{dateTime(m.createdAt)}</time>
        </span>
        <div
          className={`whitespace-pre-line rounded-2xl px-4 py-2.5 text-left text-[15px] leading-relaxed ${staff ? "rounded-tr-md" : "rounded-tl-md border border-line/10 bg-bg-card"}`}
          style={staff ? { background: "rgb(var(--c-accent) / 0.13)" } : undefined}
        >
          {m.body}
        </div>
      </div>
    </motion.li>
  );
}

/** Reply or note — two modes that look nothing alike, so nobody sends the wrong one. */
function Composer({ conversation, onSent }) {
  const [mode, setMode] = useState("reply");
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const toast = useToast();
  const note = mode === "note";
  const who = firstName(conversation.account);

  useEffect(() => {
    setText("");
    setError(null);
    setMode("reply");
  }, [conversation.id]);

  const send = async () => {
    if (!text.trim()) {
      setError(note ? "Write the note first." : "Write your reply first.");
      ref.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await staffApi.sendMessage(conversation.id, { body: text.trim(), internal: note });
      setText("");
      toast(note ? "Note added — only staff can see it" : `Reply sent to ${who}`);
      onSent();
    } catch (err) {
      setError(err.fields?.body || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-2xl border-2 p-3 transition-colors duration-base"
      style={
        note
          ? { borderStyle: "dashed", borderColor: "rgb(var(--c-state-reserved) / 0.6)", background: "rgb(var(--c-state-reserved) / 0.08)" }
          : { borderColor: "rgb(var(--c-line) / 0.1)", background: "rgb(var(--c-bg-card))" }
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="What you are writing">
        {[
          ["reply", `Reply to ${who}`, MessageSquareReply],
          ["note", "Internal note", Lock],
        ].map(([value, label, Icon]) => {
          const on = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setMode(value);
                setError(null);
                ref.current?.focus();
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold transition-colors ${
                on ? (value === "note" ? "text-ink-primary" : "text-ink-primary") : "text-ink-muted hover:text-ink-primary"
              }`}
              style={
                on
                  ? value === "note"
                    ? { background: "rgb(var(--c-state-reserved) / 0.22)" }
                    : { background: "rgb(var(--c-accent) / 0.14)" }
                  : undefined
              }
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>
      <label className="sr-only" htmlFor="composer">
        {note ? "Internal note" : `Reply to ${who}`}
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
        placeholder={note ? "Only staff will ever see this — the customer is never shown it or emailed about it." : `Write to ${who}…`}
        className="block w-full resize-y rounded-lg bg-transparent px-1.5 py-1 text-[15px] leading-relaxed outline-none placeholder:text-ink-muted"
        aria-invalid={error ? "true" : undefined}
      />
      {error && (
        <p data-field-error="" className="px-1.5 text-xs font-medium text-state-unavailable">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line/[0.07] pt-2.5">
        <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-ink-muted">
          {note ? (
            <>
              <Lock size={12} /> Not sent to {who}. Not emailed.
            </>
          ) : (
            <>Emailed to {who} if they haven't read it within {QUIET_MINUTES} minutes.</>
          )}
        </span>
        {note ? (
          <Button
            size="sm"
            icon={Lock}
            loading={busy}
            onClick={send}
            style={{ background: "rgb(var(--c-state-reserved) / 0.25)", color: "rgb(var(--c-ink-primary))", border: 0 }}
          >
            Add note
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Send} loading={busy} onClick={send}>
            Send reply
          </Button>
        )}
      </div>
    </div>
  );
}

function Thread({ id, navigate, can, query, onChanged }) {
  const { data, error, load, setData } = useLoad(() => staffApi.conversation(id), [id]);
  const [directory, setDirectory] = useState([]);
  const [busy, setBusy] = useState(null);
  const toast = useToast();
  const endRef = useRef(null);
  useAutoRefresh(load, 15_000);

  useEffect(() => {
    staffApi.directory().then((d) => setDirectory(d.staff || [])).catch(() => {});
  }, []);

  const conversation = data?.conversation;
  const messages = data?.messages || [];

  // Opening a thread is reading it: clear the staff side's unread count.
  useEffect(() => {
    if (conversation?.unread) {
      staffApi
        .markRead(conversation.id)
        .then(() => {
          setData((d) => (d ? { ...d, conversation: { ...d.conversation, unread: 0 } } : d));
          onChanged?.();
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.unread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  if (error) {
    return <Notice tone="error">{error.status === 404 ? "That conversation wasn't found." : error.message}</Notice>;
  }
  if (!conversation) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24" rounded="rounded-2xl" />
        <Skeleton className="h-24" rounded="rounded-2xl" />
      </div>
    );
  }

  const change = async (patch, message) => {
    setBusy(Object.keys(patch)[0]);
    try {
      const { conversation: fresh } = await staffApi.updateConversation(conversation.id, patch);
      setData((d) => ({ ...d, conversation: fresh }));
      toast(message(fresh));
      onChanged?.();
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const reply = can("conversations.reply");
  const order = conversation.order;
  const customer = conversation.account;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-4 flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-line/[0.08] pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-extrabold leading-snug tracking-tight">{conversation.subject}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
            <UserRound size={14} className="text-ink-muted" />
            {customer && can("clients.read") ? (
              <a
                href={`${ROUTES.staff}/clients/${customer.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`${ROUTES.staff}/clients/${customer.id}`);
                }}
                className="font-semibold text-ink-primary underline decoration-line/25 underline-offset-2"
              >
                {customer.name}
              </a>
            ) : (
              <span className="font-semibold text-ink-primary">{customer?.name || "Customer"}</span>
            )}
            {customer?.email && <span className="text-ink-muted">{customer.email}</span>}
          </div>
          {order && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
              <Building2 size={14} className="text-ink-muted" />
              <span className="text-ink-muted">About</span>
              {order.status === "draft" ? (
                <span>
                  {order.organizationName} <span className="text-ink-muted">— a draft they haven't submitted</span>
                </span>
              ) : (
                <>
                  <a
                    href={`${ROUTES.staff}/orders/${order.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`${ROUTES.staff}/orders/${order.id}`);
                    }}
                    className="font-semibold text-ink-primary underline decoration-line/25 underline-offset-2"
                  >
                    {order.organizationName}
                  </a>
                  <StatusBadge status={order.status} />
                </>
              )}
            </div>
          )}
        </div>
        {reply && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="relative">
              <span className="sr-only">Assigned to</span>
              <UserRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <select
                value={conversation.assignee?.id || ""}
                disabled={busy === "assignee"}
                onChange={(e) =>
                  change({ assignee: e.target.value || null }, (fresh) => (fresh.assignee ? `Assigned to ${fresh.assignee.name}` : "Unassigned"))
                }
                className="h-9 max-w-[14rem] appearance-none rounded-full border border-line/10 bg-bg-card pl-8 pr-8 text-[13px] font-semibold outline-none focus:border-line/30"
              >
                <option value="">Unassigned</option>
                {directory.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.isYou ? `${s.name} (you)` : s.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            </label>
            {conversation.status === "open" ? (
              <Button size="sm" icon={CheckCheck} loading={busy === "status"} onClick={() => change({ status: "closed" }, () => "Closed")}>
                Close
              </Button>
            ) : (
              <Button size="sm" icon={RotateCcw} loading={busy === "status"} onClick={() => change({ status: "open" }, () => "Reopened")}>
                Reopen
              </Button>
            )}
          </div>
        )}
      </div>

      {conversation.status === "closed" && (
        <p className="mb-4 rounded-lg bg-line/[0.04] px-3.5 py-2 text-sm text-ink-secondary">
          Closed {conversation.closedAt ? <Ago value={conversation.closedAt} /> : ""}. A reply from either side reopens it.
        </p>
      )}

      <ol className="space-y-5 pb-5">
        {messages.map((m) => (
          <Message key={m.id} m={m} customer={customer} />
        ))}
        {conversation.buyerUnread === 0 && conversation.lastMessageBy === "staff" && (
          <li className="text-right text-xs text-ink-muted">Seen by {firstName(customer)}</li>
        )}
      </ol>

      {reply && (
        // Pinned to the bottom of the screen on a desktop, where it can sit
        // under a long thread; on a phone it would cover half of it.
        <div className="z-10 lg:sticky lg:bottom-3">
          <Composer
            conversation={conversation}
            onSent={() => {
              load();
              onChanged?.();
            }}
          />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/* ───────────────────────────── writing first ───────────────────────────── */

/**
 * Staff starting a thread with a customer — from their client page, one of
 * their orders, or the inbox. Pass `customer` (and `order`) to fix them;
 * otherwise the dialog finds the customer first.
 */
export function ComposeDialog({ open, onClose, customer: fixedCustomer = null, order: fixedOrder = null, onSent }) {
  const [customer, setCustomer] = useState(fixedCustomer);
  const [search, setSearch] = useState("");
  const settled = useDebounced(search, 250);
  const [matches, setMatches] = useState(null);
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState(fixedOrder?.id || "");
  const [subject, setSubject] = useState(fixedOrder ? `Your order for ${fixedOrder.organizationName}` : "");
  const [body, setBody] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCustomer(fixedCustomer);
    setSearch("");
    setMatches(null);
    setOrderId(fixedOrder?.id || "");
    setSubject(fixedOrder ? `Your order for ${fixedOrder.organizationName}` : "");
    setBody("");
    setFields({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (customer || !settled.trim()) {
      setMatches(null);
      return undefined;
    }
    let live = true;
    staffApi
      .clients({ q: settled.trim() })
      .then((d) => live && setMatches(d.clients.slice(0, 6)))
      .catch(() => live && setMatches([]));
    return () => {
      live = false;
    };
  }, [settled, customer]);

  useEffect(() => {
    if (!customer || fixedOrder) return;
    staffApi
      .client(customer.id)
      .then((d) => setOrders(d.orders || []))
      .catch(() => setOrders([]));
  }, [customer, fixedOrder]);

  const send = async () => {
    const f = {};
    if (!customer) f.customer = "Choose who you're writing to.";
    if (!subject.trim()) f.subject = "Add a subject.";
    if (!body.trim()) f.body = "Write a message.";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const { conversation } = await staffApi.startConversation({
        accountId: customer.id,
        subject: subject.trim(),
        body: body.trim(),
        ...(orderId ? { orderId } : {}),
      });
      onSent?.(conversation);
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
      icon={PenLine}
      title={customer ? `Write to ${customer.name}` : "Write to a customer"}
      subtitle={customer ? customer.email : "Starts a conversation they'll see in their SILLA account."}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Send} loading={busy} onClick={send}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!customer && (
          <div>
            <TextInput
              label="Customer"
              placeholder="Name, email or organization"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              error={fields.customer || fields.accountId}
              data-autofocus
            />
            {matches && (
              <ul className="mt-2 overflow-hidden rounded-lg border border-line/10">
                {matches.length === 0 && <li className="px-3.5 py-2.5 text-sm text-ink-muted">No customer matches that.</li>}
                {matches.map((c) => (
                  <li key={c.id} className="border-b border-line/[0.07] last:border-0">
                    <button
                      type="button"
                      onClick={() => setCustomer(c)}
                      className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-line/[0.04]"
                    >
                      <Avatar name={c.name} email={c.email} size={30} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{c.name}</span>
                        <span className="block truncate text-xs text-ink-muted">
                          {c.email}
                          {c.organizationName ? ` · ${c.organizationName}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {customer && !fixedCustomer && (
          <button type="button" className="text-sm font-semibold text-ink-secondary underline underline-offset-2" onClick={() => setCustomer(null)}>
            Someone else
          </button>
        )}
        {customer && !fixedOrder && orders.length > 0 && (
          <SelectInput label="About" value={orderId} onChange={(e) => setOrderId(e.target.value)} optional>
            <option value="">Nothing in particular</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                Their order for {o.organizationName} ({o.status})
              </option>
            ))}
          </SelectInput>
        )}
        <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={fields.subject} maxLength={160} {...(customer ? { "data-autofocus": true } : {})} />
        <Textarea label="Message" rows={5} value={body} onChange={(e) => setBody(e.target.value)} error={fields.body} />
        <p className="text-xs text-ink-muted">
          It appears in their account under Messages, and they're emailed if they haven't read it within {QUIET_MINUTES} minutes. You'll be
          assigned the thread.
        </p>
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}

/* ───────────────────────────── the section ───────────────────────────── */

export default function Conversations({ navigate, id, can, query = {}, refreshBadges }) {
  const [compose, setCompose] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const changed = () => {
    setRefreshKey((k) => k + 1);
    refreshBadges?.();
  };
  const back = () => navigate(withQuery(`${ROUTES.staff}/conversations`, query), { replace: false });

  return (
    <div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <div className={`min-w-0 ${id ? "max-lg:hidden" : ""}`}>
          <InboxList
            navigate={navigate}
            query={query}
            selected={id}
            refreshKey={refreshKey}
            action={
              can("conversations.reply") ? (
                <Button size="md" icon={PenLine} onClick={() => setCompose(true)} aria-label="Write to a customer" className="shrink-0 max-sm:px-3.5">
                  <span className="max-sm:sr-only">Write</span>
                </Button>
              ) : null
            }
          />
        </div>
        <div className={`min-w-0 ${id ? "" : "max-lg:hidden"}`}>
          {id ? (
            <>
              <button type="button" onClick={back} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary lg:hidden">
                <ArrowLeft size={15} /> All conversations
              </button>
              <div className="rounded-2xl border border-line/10 bg-bg-card/60 p-4 sm:p-6">
                <Thread key={id} id={id} navigate={navigate} can={can} query={query} onChanged={changed} />
              </div>
            </>
          ) : (
            <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-line/15">
              <div className="max-w-xs text-center">
                <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-[14px] bg-line/[0.05] text-ink-muted">
                  <MessagesSquare size={22} />
                </span>
                <p className="font-bold tracking-tight">Pick a conversation</p>
                <p className="mt-1.5 text-sm text-ink-secondary">The thread opens here, with everything said on it and every staff note.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {compose && (
        <ComposeDialog
          open
          onClose={() => setCompose(false)}
          onSent={(conversation) => {
            setCompose(false);
            changed();
            navigate(threadPath(conversation.id));
          }}
        />
      )}
    </div>
  );
}

