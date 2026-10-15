import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CircleAlert, CircleCheck, Megaphone, Minus } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { limitLabel, standing, statusOf, usageState } from "../lib/plan.js";
import { Badge, Card, Notice, Panel, Skeleton, listContainer, listItem } from "./ui/index.jsx";

const cx = (...parts) => parts.filter(Boolean).join(" ");

/**
 * Plan & usage — the console section that answers "what does our plan
 * include, and how much of it are we using?" (docs/control-plane.md §2).
 *
 * Read from GET /api/admin/plan, which is the SERVER's reading of the
 * snapshot (services/entitlements.js) with live counts — so this page can
 * never disagree with what is actually enforced. Staff and superadmins
 * both see it: staff meet the limits too, and should know why.
 *
 * An unmanaged organization (the demo, anything that predates plans) has
 * no limits at all, and says so plainly instead of drawing six bars that
 * all read "no limit".
 */
export default function PlanUsage() {
  const { org } = useOrg();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api
      .adminPlan()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <PlanSkeleton />;

  const { entitlements } = data;
  const managed = Boolean(entitlements?.managed);
  const orgName = org?.name || "This organization";

  return (
    <motion.div {...listContainer(0.05)} className="space-y-4">
      <motion.div {...listItem()}>
        {managed ? <PlanSummary entitlements={entitlements} orgName={orgName} /> : <NoPlan orgName={orgName} />}
      </motion.div>

      <motion.div {...listItem()} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel title="Usage">
          <ul className="space-y-5">
            {data.limits.map((limit) => (
              <li key={limit.key}>
                <UsageMeter
                  label={limitLabel(limit.key, org, limit.label)}
                  used={limit.used}
                  max={managed ? limit.max : null}
                  // With no plan at all, "no limit" on every row repeats the
                  // heading above six times; the bare count is enough.
                  quiet={!managed}
                  // Only a superadmin can deactivate anyone, so only they
                  // are told it is a way to make room.
                  remedy={
                    limit.key === "staff" && user?.role === "superadmin"
                      ? "Deactivating an account in Staff frees its place."
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Features">
          <ul className="divide-y divide-line/10">
            {/* What you have first, then what you don't. */}
            {[...data.features].sort((a, b) => Number(b.included) - Number(a.included)).map((feature) => (
              <li key={feature.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <span
                  className={cx(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
                    feature.included ? "" : "bg-line/10 text-ink-muted"
                  )}
                  style={
                    feature.included
                      ? { background: "rgb(var(--c-state-available) / 0.16)", color: "var(--color-state-available)" }
                      : undefined
                  }
                >
                  {feature.included ? <CircleCheck size={13} /> : <Minus size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx("block text-sm", feature.included ? "text-ink-primary" : "text-ink-secondary")}>
                    {feature.label}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {feature.included ? "Included" : "Not in your plan"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </motion.div>

      {managed && (
        <motion.p {...listItem()} className="text-xs text-ink-muted">
          To change your plan or raise a limit, contact SILLA. A smaller plan never removes anything you already
          have — it only stops new additions past the limit.
        </motion.p>
      )}
    </motion.div>
  );
}

/** The plan's name, where it stands, and anything SILLA has to say about it. */
function PlanSummary({ entitlements, orgName }) {
  const status = statusOf(entitlements);
  return (
    <Card>
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">Your plan</p>
      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <h2 className="text-2xl font-semibold tracking-tight">{entitlements.planName || "Your plan"}</h2>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {/* The sentence carries the date that matters next, so it is not
          repeated beside it. */}
      <p className="mt-2 max-w-2xl text-sm text-ink-secondary">{standing(entitlements, orgName)}</p>

      {entitlements.notice && (
        <div
          className="mt-4 flex gap-3 rounded-md border px-4 py-3"
          style={{ borderColor: "rgb(var(--c-accent) / 0.3)", background: "rgb(var(--c-accent) / 0.06)" }}
        >
          <Megaphone size={16} className="mt-0.5 shrink-0" style={{ color: "var(--color-accent)" }} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink-secondary">A note from SILLA</p>
            <p className="mt-0.5 text-sm text-ink-primary">{entitlements.notice}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function NoPlan({ orgName }) {
  return (
    <Card>
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">Your plan</p>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">No plan limits</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-secondary">
        {orgName} isn't on a metered plan: every feature is included and nothing is capped. The counts below are
        what you use today.
      </p>
    </Card>
  );
}

/**
 * One limit as a meter: the count in words, a bar whose fill carries how
 * close it is (accent, then warning at the limit, danger past it), and a
 * sentence once it matters. The words say it all on their own; the colour
 * only makes it faster to find.
 *
 * `max` null is no limit: the count, said so, and no bar — a bar implies
 * a ratio there is none of.
 */
export function UsageMeter({ label, used, max, remedy = null, quiet = false }) {
  const state = usageState(used, max);
  const fill = { room: "accent", near: "accent", full: "state-reserved", over: "state-unavailable" }[state];
  const channel = { room: "--c-accent", near: "--c-accent", full: "--c-state-reserved", over: "--c-state-unavailable" }[state];
  const share = max ? Math.min(1, used / max) : 0;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm text-ink-primary">{label}</span>
        <span className="shrink-0 text-sm tabular-nums">
          {state === "unlimited" ? (
            <>
              <span className="font-semibold">{used}</span>
              {!quiet && <span className="text-ink-muted"> · no limit</span>}
            </>
          ) : (
            <>
              <span className="font-semibold">{used}</span>
              <span className="text-ink-muted"> of {max}</span>
            </>
          )}
        </span>
      </div>

      {state !== "unlimited" && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full"
          style={{ background: `rgb(var(${channel}) / 0.16)` }}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={used}
        >
          <motion.div
            className="h-full origin-left rounded-full"
            style={{ background: `var(--color-${fill})` }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: share }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      )}

      {(state === "full" || state === "over") && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-secondary">
          <CircleAlert size={13} className="mt-px shrink-0" style={{ color: `var(--color-${fill})` }} />
          <span>
            {state === "over"
              ? `${used - max} over your plan's limit. Nothing was removed, but no more can be added.`
              : "All in use — new ones can't be added."}
            {remedy ? ` ${remedy}` : ""}
          </span>
        </p>
      )}
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-36 w-full" rounded="rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Skeleton className="h-80" rounded="rounded-lg" />
        <Skeleton className="h-64" rounded="rounded-lg" />
      </div>
    </div>
  );
}
