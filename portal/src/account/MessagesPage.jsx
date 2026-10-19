import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Building2, ChevronDown, MessagesSquare, PenLine, Send } from "lucide-react";

import { Button, EmptyState, LinkedText, Modal, Notice, Skeleton, Textarea } from "../components/ui.jsx";
import { TextInput } from "./kit.jsx";
import { AccountLayout, StatusBadge } from "./shared.jsx";
import { staffApi } from "../lib/staffApi.js";
import { vendorApi } from "../lib/vendorApi.js";
import { useAccount } from "../lib/AccountContext.jsx";
import { refreshUnread } from "../lib/useUnreadMessages.js";
import { useToast } from "../lib/toast.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { dateTime } from "../billing/format.js";
import { Ago, Avatar, UnreadPill, useAutoRefresh, useLoad } from "../staff/kit.jsx";

/**
 * A buyer's conversations with SILLA: #/messages[/<id>].
 *
 * Their threads, newest first, and one of them open beside the list — or,
 * on a phone, one at a time. They can start a thread about an order or
 * about anything, and reply. What they see is exactly what the server
 * gives a buyer: their own threads (the account is in the query) and the
 * public messages in them — a staff member's internal note never arrives
 * here, because it is never sent.
 */

const threadPath = (id) => `${ROUTES.messages}/${id}`;

/* ───────────────────────────── writing ───────────────────────────── */

/** Start a thread — from here, or from an order (with `order` fixed). */
export function NewMessageDialog({ open, onClose, order: fixedOrder = null, onSent }) {
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState(fixedOrder?.id || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOrderId(fixedOrder?.id || "");
    setSubject(fixedOrder ? `About ${fixedOrder.organizationName}` : "");
    setBody("");
    setFields({});
    if (!fixedOrder) vendorApi.myOrders().then((d) => setOrders(d.orders || [])).catch(() => setOrders([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const send = async () => {
    const f = {};
    if (!subject.trim()) f.subject = "Add a subject, so we know what it's about.";
    if (!body.trim()) f.body = "Write your message.";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const { conversation } = await staffApi.startMine({ subject: subject.trim(), body: body.trim(), ...(orderId ? { orderId } : {}) });
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
      title={fixedOrder ? `Message SILLA about ${fixedOrder.organizationName}` : "Write to SILLA"}
      subtitle="A person on our team answers, usually within a working day. You'll get an email when they do."
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
        {!fixedOrder && orders.length > 0 && (
          <label className="block">
            <span className="flex items-baseline gap-1.5 text-sm text-ink-secondary">
              About <span className="text-xs text-ink-muted">optional</span>
            </span>
            <span className="relative mt-1.5 block">
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="h-11 w-full appearance-none rounded-md border border-line/10 bg-bg-panel px-3 pr-9 text-ink-primary outline-none focus:border-line/40"
              >
                <option value="">Nothing in particular</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    Your order for {o.organizationName}
                    {o.status === "draft" ? " (draft)" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            </span>
          </label>
        )}
        <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={fields.subject} maxLength={160} data-autofocus />
        <Textarea label="Message" rows={6} value={body} onChange={(e) => setBody(e.target.value)} error={fields.body} />
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}

/* ───────────────────────────── one thread ───────────────────────────── */

function Thread({ id, navigate, onRead }) {
  const { account } = useAccount();
  const { data, error, load } = useLoad(() => staffApi.conversation(id), [id]);
  const [text, setText] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const toast = useToast();
  useAutoRefresh(load, 20_000);

  const conversation = data?.conversation;
  const messages = data?.messages || [];

  useEffect(() => {
    if (conversation?.unread) {
      staffApi
        .markRead(conversation.id)
        .then(() => {
          refreshUnread();
          onRead?.();
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, conversation?.unread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  if (error) return <Notice tone="error">{error.status === 404 ? "That conversation wasn't found." : error.message}</Notice>;
  if (!conversation) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-20" rounded="rounded-2xl" />
        <Skeleton className="h-20" rounded="rounded-2xl" />
      </div>
    );
  }

  const send = async () => {
    if (!text.trim()) {
      setFieldError("Write your reply first.");
      return;
    }
    setBusy(true);
    setFieldError(null);
    try {
      await staffApi.sendMessage(conversation.id, { body: text.trim() });
      setText("");
      toast("Sent — we'll email you when SILLA replies");
      load();
      onRead?.();
    } catch (err) {
      setFieldError(err.fields?.body || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="mb-5 border-b border-line/[0.08] pb-4">
        <h2 className="text-xl font-extrabold leading-snug tracking-tight">{conversation.subject}</h2>
        {conversation.order && (
          <a
            href={`${ROUTES.orders}/${conversation.order.id}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`${ROUTES.orders}/${conversation.order.id}`);
            }}
            className="mt-1.5 inline-flex items-center gap-2 text-sm text-ink-secondary hover:text-ink-primary"
          >
            <Building2 size={14} className="text-ink-muted" />
            Your order for <span className="font-semibold text-ink-primary underline decoration-line/25 underline-offset-2">{conversation.order.organizationName}</span>
            <StatusBadge status={conversation.order.status} />
          </a>
        )}
      </div>

      <ol className="space-y-5 pb-5">
        {messages.map((m) => {
          const mine = m.authorRole === "buyer";
          return (
            <motion.li key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex gap-2.5 ${mine ? "flex-row-reverse" : ""}`}>
              <Avatar name={mine ? account?.name : m.authorName} email={account?.email} tone={mine ? "customer" : "staff"} size={32} className="mt-5" />
              <div className={`flex min-w-0 max-w-[min(560px,85%)] flex-col ${mine ? "items-end text-right" : ""}`}>
                <span className="mb-1 px-1 text-xs text-ink-muted">
                  <span className="font-semibold text-ink-secondary">{mine ? "You" : `${m.authorName} · SILLA`}</span> ·{" "}
                  <time title={dateTime(m.createdAt)}>{dateTime(m.createdAt)}</time>
                </span>
                <div
                  className={`whitespace-pre-line rounded-2xl px-4 py-2.5 text-left text-[15px] leading-relaxed [overflow-wrap:anywhere] ${
                    mine ? "rounded-tr-md border border-line/10 bg-bg-card" : "rounded-tl-md"
                  }`}
                  style={mine ? undefined : { background: "rgb(var(--c-accent) / 0.13)" }}
                >
                  <LinkedText text={m.body} />
                </div>
              </div>
            </motion.li>
          );
        })}
      </ol>

      {conversation.status === "closed" && (
        <p className="mb-3 rounded-lg bg-line/[0.04] px-3.5 py-2 text-sm text-ink-secondary">
          SILLA closed this conversation. Writing again reopens it.
        </p>
      )}
      <div className="rounded-2xl border-2 border-line/10 bg-bg-card p-3">
        <label htmlFor="reply" className="sr-only">
          Your reply
        </label>
        <textarea
          id="reply"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
          placeholder="Write your reply…"
          className="block w-full resize-y bg-transparent px-1.5 py-1 text-[15px] leading-relaxed outline-none placeholder:text-ink-muted"
          aria-invalid={fieldError ? "true" : undefined}
        />
        {fieldError && (
          <p data-field-error="" className="px-1.5 text-xs font-medium text-state-unavailable">
            {fieldError}
          </p>
        )}
        <div className="mt-2 flex items-center justify-end border-t border-line/[0.07] pt-2.5">
          <Button size="sm" variant="primary" icon={Send} loading={busy} onClick={send}>
            Send
          </Button>
        </div>
      </div>
      <div ref={endRef} />
    </div>
  );
}

/* ───────────────────────────── the page ───────────────────────────── */

export default function MessagesPage({ id, navigate }) {
  const { data, error, load } = useLoad(() => staffApi.myConversations(), []);
  const [writing, setWriting] = useState(false);
  useAutoRefresh(load, 30_000);
  const rows = data?.conversations || [];

  const list = (
    <ul className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
      {rows.map((c) => {
        const active = c.id === id;
        return (
          <li key={c.id} className="border-b border-line/[0.07] last:border-0">
            <a
              href={threadPath(c.id)}
              onClick={(e) => {
                e.preventDefault();
                navigate(threadPath(c.id));
              }}
              aria-current={active ? "true" : undefined}
              className={`relative block px-4 py-3.5 transition-colors ${active ? "bg-[rgb(var(--c-accent)/0.08)]" : "hover:bg-line/[0.03]"}`}
            >
              {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full" style={{ background: "var(--color-accent)" }} />}
              <span className="flex items-baseline gap-2">
                <span className={`truncate text-sm ${c.unread ? "font-extrabold" : "font-semibold"}`}>{c.subject}</span>
                <span className="ml-auto shrink-0 text-xs text-ink-muted">
                  <Ago value={c.lastMessageAt} />
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">
                  {c.lastMessageBy === "buyer" ? "You: " : "SILLA: "}
                  {c.lastMessagePreview}
                </span>
                {c.status === "closed" && <span className="text-[11px] font-semibold text-ink-muted">Closed</span>}
                <UnreadPill n={c.unread} label="unread replies" />
              </span>
              {c.order && <span className="mt-1 block truncate text-xs text-ink-muted">About {c.order.organizationName}</span>}
            </a>
          </li>
        );
      })}
    </ul>
  );

  return (
    <AccountLayout
      navigate={navigate}
      title="Messages"
      subtitle="Your conversations with SILLA — about an order, your bill, or anything else."
      action={
        <Button variant="primary" icon={PenLine} onClick={() => setWriting(true)}>
          Write to SILLA
        </Button>
      }
    >
      {error && <Notice tone="error">{error.message}</Notice>}
      {!data && !error && <Skeleton className="h-64" rounded="rounded-xl" />}

      {data && rows.length === 0 && (
        <EmptyState
          icon={MessagesSquare}
          title="No messages yet"
          action={
            <Button variant="primary" icon={PenLine} onClick={() => setWriting(true)}>
              Write to SILLA
            </Button>
          }
        >
          Questions about an order, your bill, or setting things up — a person on our team answers.
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* Held in view beside a long thread: it scrolled away with the
              page and left an empty column beside the conversation. */}
          <div className={`min-w-0 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-104px)] lg:overflow-y-auto ${id ? "max-lg:hidden" : ""}`}>
            {list}
          </div>
          <div className={`min-w-0 ${id ? "" : "max-lg:hidden"}`}>
            {id ? (
              <>
                <button type="button" onClick={() => navigate(ROUTES.messages)} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary lg:hidden">
                  <ArrowLeft size={15} /> All messages
                </button>
                <div className="rounded-2xl border border-line/10 bg-bg-card/60 p-4 sm:p-6">
                  <Thread key={id} id={id} navigate={navigate} onRead={load} />
                </div>
              </>
            ) : (
              <div className="grid min-h-[320px] place-items-center rounded-2xl border border-dashed border-line/15 px-6 text-center">
                <div>
                  <p className="font-bold tracking-tight">Pick a conversation</p>
                  <p className="mt-1.5 text-sm text-ink-secondary">Or start a new one — we usually answer within a working day.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <NewMessageDialog
        open={writing}
        onClose={() => setWriting(false)}
        onSent={(conversation) => {
          setWriting(false);
          load();
          navigate(threadPath(conversation.id));
        }}
      />
    </AccountLayout>
  );
}
