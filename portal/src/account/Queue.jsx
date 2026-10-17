import { useCallback, useEffect, useState } from "react";
import { Copy, Download, RefreshCw } from "lucide-react";

import { Button, Card, Field, Notice, Segmented, Skeleton } from "../components/ui.jsx";
import { vendorApi } from "../lib/vendorApi.js";
import { ROUTES } from "../lib/useHashRoute.js";
import { AccountLayout, BackLink, StatusBadge, money, planLabel, when } from "./shared.jsx";

/**
 * SILLA's order queue — the internal side.
 *
 * Everything a person needs to actually provision one order is on the
 * detail screen: the profile to download, the command to run it with,
 * and the transition buttons. The command lives HERE rather than in the
 * buyer's review step, which is where it used to be shown to the
 * customer buying the result of it.
 */

const FILTERS = [
  { value: "", label: "Open" },
  { value: "submitted", label: "Submitted" },
  { value: "provisioning", label: "Provisioning" },
  { value: "live", label: "Live" },
  { value: "cancelled", label: "Cancelled" },
];

function CopyButton({ value, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={Copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          /* clipboard blocked — the text is on screen to select */
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

function QueueDetail({ id, navigate }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [orgId, setOrgId] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(
    () =>
      vendorApi
        .queueOrder(id)
        .then((d) => {
          setOrder(d.order);
          setUrl(d.order.deploymentUrl || "");
          setOrgId(d.order.provisionedOrganizationId || "");
        })
        .catch((e) => setError(e.message)),
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

  const move = async (status) => {
    setBusy(true);
    setError(null);
    try {
      await vendorApi.moveOrder(id, {
        status,
        note: note.trim(),
        deploymentUrl: url.trim(),
        provisionedOrganizationId: orgId.trim(),
      });
      setNote("");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadProfile = () => {
    const blob = new Blob([JSON.stringify(order.profile, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${order.profile?.key || "profile"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  if (!order) {
    return (
      <AccountLayout navigate={navigate} title="Order">
        {error ? <Notice tone="error">{error}</Notice> : <Skeleton className="h-40" />}
      </AccountLayout>
    );
  }

  const NEXT = { submitted: "provisioning", provisioning: "live" };
  const next = NEXT[order.status];
  const command = `cd server && npm run seed:file ./${order.profile?.key || "profile"}.json`;

  return (
    <AccountLayout
      navigate={navigate}
      title={order.organizationName}
      subtitle={
        order.account ? `${order.account.name} · ${order.account.email}` : "Account removed"
      }
      action={<StatusBadge status={order.status} />}
    >
      <BackLink onClick={() => navigate(ROUTES.queue)} children="Queue" />

      {error && <Notice tone="error" className="mb-4">{error}</Notice>}

      <Card>
        <h2 className="font-semibold">Provision it</h2>
        <p className="mt-2 text-sm text-ink-secondary">
          Download the profile, drop it in the repo root, and seed it. Provisioning is create-only —
          running it twice builds a second organization rather than updating the first.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button icon={Download} onClick={downloadProfile}>
            Download profile
          </Button>
          <code className="rounded-md border border-line/10 bg-bg-panel px-3 py-2 font-mono text-sm">
            {command}
          </code>
          <CopyButton value={command} label="Copy command" />
        </div>
      </Card>

      <Card className="mt-4">
        <h2 className="font-semibold">Move it along</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Deployment URL"
            placeholder="https://theirname.silla.app"
            hint="Required before an order can go live."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Field
            label="Provisioned organization id"
            placeholder="from the seeder's output"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        </div>
        <Field
          label="Note"
          className="mt-4"
          placeholder="Anything worth recording against this step"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="mt-5 flex flex-wrap gap-3">
          {next && (
            <Button variant="primary" loading={busy} onClick={() => move(next)}>
              Mark {next}
            </Button>
          )}
          {order.status !== "cancelled" && (
            <Button variant="danger" loading={busy} onClick={() => move("cancelled")}>
              Cancel order
            </Button>
          )}
          {!next && order.status !== "cancelled" && (
            <p className="self-center text-sm text-ink-muted">Nothing further to do.</p>
          )}
        </div>
      </Card>

      <Card className="mt-4">
        <h2 className="font-semibold">History</h2>
        <ol className="mt-4 space-y-3">
          {(order.history || []).map((h, i) => (
            <li key={i} className="flex flex-wrap items-center gap-3 text-sm">
              <StatusBadge status={h.status} />
              <span className="text-ink-muted">{when(h.at)}</span>
              {h.note && <span className="text-ink-secondary">{h.note}</span>}
            </li>
          ))}
        </ol>
      </Card>
    </AccountLayout>
  );
}

export default function Queue({ id, navigate }) {
  const [status, setStatus] = useState("");
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setOrders(null);
    vendorApi
      .queue(status || undefined)
      .then((d) => setOrders(d.orders))
      .catch((e) => setError(e.message));
  }, [status]);

  useEffect(() => {
    if (!id) load();
  }, [id, load]);

  if (id) return <QueueDetail id={id} navigate={navigate} />;

  return (
    <AccountLayout
      navigate={navigate}
      title="Order queue"
      subtitle="Everything buyers have submitted. Drafts stay private until they send them."
      action={<Button icon={RefreshCw} onClick={load}>Refresh</Button>}
    >
      <Segmented size="sm" value={status} onChange={setStatus} options={FILTERS} className="mb-5" />

      {error && <Notice tone="error">{error}</Notice>}
      {!orders && !error && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {orders?.length === 0 && (
        <Card className="text-center">
          <p className="text-lg font-semibold">Nothing waiting.</p>
          <p className="mt-2 text-ink-secondary">Submitted orders land here.</p>
        </Card>
      )}

      <div className="space-y-3">
        {(orders || []).map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => navigate(`${ROUTES.queue}/${o.id}`)}
            className="block w-full rounded-xl border border-line/[0.08] bg-bg-card p-5 text-left
                       transition-colors duration-fast hover:border-line/20"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="mr-auto text-lg font-bold">{o.organizationName}</span>
              <StatusBadge status={o.status} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
              {o.account && <span>{o.account.email}</span>}
              <span>{planLabel(o)}</span>
              <span>{money(o.quotedAmount, o.currency)}/month</span>
              <span className="text-ink-muted">updated {when(o.updatedAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </AccountLayout>
  );
}
