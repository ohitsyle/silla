import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, ExternalLink, MailWarning, Plus, Send } from "lucide-react";

import { Button, Card, Notice, Skeleton } from "../components/ui.jsx";
import { vendorApi } from "../lib/vendorApi.js";
import { useAccount } from "../lib/AccountContext.jsx";
import { useToast } from "../lib/toast.jsx";
import { VerifyEmailModal } from "./modals.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { AccountLayout, BackLink, StatusBadge, planLabel, quoteOf, when } from "./shared.jsx";

/**
 * A buyer's own orders — the answer to "I configured it, now what?".
 *
 * The wizard used to end at a downloaded file, which meant the record of
 * what someone wanted lived in their Downloads folder. This is where it
 * lives now: a draft they can come back to, submit, and then watch move.
 */

/** What each status means for the person waiting. */
const EXPLAIN = {
  draft: "Not sent yet. Submit it when you're ready and we'll start building.",
  submitted: "With SILLA. We'll start on it shortly and this will update.",
  provisioning: "Being built right now. Usually same day.",
  live: "Ready. Sign in with the link below.",
  cancelled: "Cancelled. Get in touch if that's wrong.",
};

function OrderDetail({ id, navigate }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { isVerified } = useAccount();
  const toast = useToast();

  const load = () =>
    vendorApi
      .order(id)
      .then((d) => setOrder(d.order))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Placing an order needs a verified email. An unverified buyer gets
   * the code dialog here — at the moment it matters — and the order is
   * placed the instant they verify, so they don't have to press Submit a
   * second time. The server enforces the same rule; a 403 from it (say,
   * verified in another tab that then changed email) opens the dialog too.
   */
  const submit = async ({ skipCheck = false } = {}) => {
    if (!isVerified && !skipCheck) {
      setVerifying(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await vendorApi.submitOrder(id);
      await load();
      toast("Order placed — we've emailed you a receipt");
    } catch (e) {
      if (e.code === "EMAIL_UNVERIFIED") setVerifying(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <AccountLayout navigate={navigate} title="Order">
        <BackLink onClick={() => navigate(ROUTES.orders)} children="All orders" />
        <Notice tone="error">{error}</Notice>
      </AccountLayout>
    );
  }
  if (!order) {
    return (
      <AccountLayout navigate={navigate} title="Order">
        <Skeleton className="h-40" />
      </AccountLayout>
    );
  }

  const profile = order.profile || {};

  return (
    <AccountLayout
      navigate={navigate}
      title={order.organizationName}
      subtitle={`${planLabel(order)} · ${order.billingPeriod} · ${quoteOf(order)}`}
      action={<StatusBadge status={order.status} />}
    >
      <BackLink onClick={() => navigate(ROUTES.orders)} children="All orders" />

      <Notice tone={order.status === "live" ? "success" : "info"}>{EXPLAIN[order.status]}</Notice>

      {order.status === "live" && order.deploymentUrl && (
        <Card className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <div className="font-semibold">Your system is live</div>
              <div className="mt-0.5 text-sm text-ink-secondary">{order.deploymentUrl}</div>
            </div>
            <a
              href={order.deploymentUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              Open it
              <ExternalLink size={15} />
            </a>
          </div>
        </Card>
      )}

      {order.status === "draft" && (
        <Card className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="mr-auto text-sm text-ink-secondary">
              Nothing is sent until you submit. After that we take over and you can't edit it — ask us
              instead.
            </p>
            <Button variant="primary" icon={Send} loading={busy} onClick={() => submit()}>
              Submit to SILLA
            </Button>
          </div>
          {!isVerified && (
            <div
              className="mt-4 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm"
              style={{ background: "rgb(var(--c-state-reserved) / 0.1)" }}
            >
              <MailWarning size={16} style={{ color: "rgb(var(--c-state-reserved))" }} />
              <span className="text-ink-secondary">
                You'll be asked to verify your email when you submit — it only takes a moment.
              </span>
            </div>
          )}
        </Card>
      )}

      <VerifyEmailModal
        open={verifying}
        reason="checkout"
        onClose={() => setVerifying(false)}
        onVerified={() => {
          setVerifying(false);
          submit({ skipCheck: true });
        }}
      />

      <Card className="mt-4">
        <h2 className="font-semibold">What you configured</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {[
            ["Organization", profile.organizationName],
            ["Site", profile.siteName],
            ["Vocabulary", profile.terminology &&
              `${profile.terminology.resourceNoun} / ${profile.terminology.memberNoun}`],
            ["Member ID", profile.identity?.memberIdFormat],
            ["Floors", profile.floors?.length],
            ["Catalog", profile.catalog?.length && `${profile.catalog.length} types`],
          ]
            .filter(([, v]) => v)
            .map(([label, value]) => (
              <div key={label} className="flex gap-3 text-sm">
                <dt className="w-32 shrink-0 text-ink-muted">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
        </dl>
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

export default function Orders({ id, navigate }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (id) return;
    vendorApi
      .myOrders()
      .then((d) => setOrders(d.orders))
      .catch((e) => setError(e.message));
  }, [id]);

  if (id) return <OrderDetail id={id} navigate={navigate} />;

  return (
    <AccountLayout
      navigate={navigate}
      title="Your orders"
      subtitle="Configurations you've saved, and the systems built from them."
      action={
        <Button variant="primary" icon={Plus} onClick={() => navigate(ROUTES.configure)}>
          New configuration
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}

      {!orders && !error && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}

      {orders?.length === 0 && (
        <Card className="text-center">
          <p className="text-lg font-semibold">Nothing here yet.</p>
          <p className="mt-2 text-ink-secondary">
            Configure a system and it'll be saved here as a draft.
          </p>
          <Button variant="primary" className="mt-6" onClick={() => navigate(ROUTES.configure)}>
            Build one
            <ArrowRight size={16} />
          </Button>
        </Card>
      )}

      <div className="space-y-3">
        {(orders || []).map((o, i) => (
          <motion.button
            key={o.id}
            type="button"
            onClick={() => navigate(`${ROUTES.orders}/${o.id}`)}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.35 }}
            className="block w-full rounded-xl border border-line/[0.08] bg-bg-card p-5 text-left
                       transition-colors duration-fast hover:border-line/20"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="mr-auto text-lg font-bold">{o.organizationName}</span>
              <StatusBadge status={o.status} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
              <span>{planLabel(o)}</span>
              <span>{quoteOf(o)}</span>
              <span className="text-ink-muted">updated {when(o.updatedAt)}</span>
            </div>
          </motion.button>
        ))}
      </div>
    </AccountLayout>
  );
}
