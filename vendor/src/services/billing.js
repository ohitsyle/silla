/**
 * Billing — the seam between orders, subscriptions, invoices and the
 * deployments they pay for.
 *
 * Owner: the billing work. Other code calls ONLY the functions exported
 * here, never the billing models' internals — order.routes.js on submit
 * and cancel, the staff-operations work when it provisions a deployment.
 * Their signatures are the contract in docs/control-plane.md; the bodies
 * below are deliberately minimal starting points to be completed.
 */
import Plan from "../models/Plan.js";
import Subscription from "../models/Subscription.js";
import { callDeployment } from "../lib/controlPlane.js";
import { DEFAULT_PLANS } from "../lib/defaultPlans.js";
import { FEATURES, LIMITS } from "../lib/planKeys.js";

/** The catalogue, seeded with DEFAULT_PLANS the first time it is empty. */
export async function ensurePlans() {
  if ((await Plan.estimatedDocumentCount()) === 0) {
    await Plan.insertMany(DEFAULT_PLANS).catch((err) => {
      if (err?.code !== 11000) throw err; // a concurrent first read already seeded it
    });
  }
  return Plan.find({}).sort({ sort: 1, createdAt: 1 }).lean();
}

export async function planByKey(key) {
  await ensurePlans();
  return Plan.findOne({ key }).lean();
}

/** Called once an order is submitted. Creates its subscription (and, when completed, the first invoice). */
export async function onOrderSubmitted(order) {
  const plan = await planByKey(order.plan);
  return Subscription.findOneAndUpdate(
    { order: order._id },
    {
      $setOnInsert: {
        account: order.account,
        order: order._id,
        organizationName: order.organizationName,
        plan: order.plan,
        planName: plan?.name || order.plan,
        billingPeriod: order.billingPeriod,
        status: "pending",
        history: [{ status: "pending", note: "Order submitted" }],
      },
    },
    { upsert: true, new: true }
  );
}

/** Called when staff cancel an order. */
export async function onOrderCancelled(order, { by = null, reason = "" } = {}) {
  const sub = await Subscription.findOne({ order: order._id });
  if (!sub || sub.status === "cancelled") return sub;
  sub.status = "cancelled";
  sub.cancelledAt = new Date();
  sub.cancelReason = reason;
  sub.history.push({ status: "cancelled", by: by?._id || null, note: reason || "Order cancelled" });
  await sub.save();
  await syncDeployment(sub);
  return sub;
}

export const subscriptionForOrder = (orderId) => Subscription.findOne({ order: orderId });

/** What a deployment in each subscription state is told. `pending` only exists before provisioning. */
const DEPLOYMENT_STATUS = {
  pending: "trialing",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  suspended: "suspended",
  cancelled: "cancelled",
};

/**
 * The entitlement snapshot for a subscription: plan defaults, then this
 * client's overrides, then status. The shape is the contract the product
 * enforces (server/src/services/entitlements.js; docs/control-plane.md).
 */
export async function snapshotFor(subscription) {
  const plan = (await planByKey(subscription.plan)) || {};
  const features = {};
  for (const key of Object.keys(FEATURES)) {
    const override = subscription.overrides?.features?.[key];
    features[key] = override !== undefined ? Boolean(override) : plan.features?.[key] !== false;
  }
  const limits = {};
  for (const key of Object.keys(LIMITS)) {
    const override = subscription.overrides?.limits?.[key];
    const value = override !== undefined ? override : plan.limits?.[key];
    limits[key] = typeof value === "number" && value >= 0 ? value : null;
  }
  return {
    managed: true,
    plan: subscription.plan,
    planName: subscription.planName || plan.name || subscription.plan,
    status: DEPLOYMENT_STATUS[subscription.status] || "trialing",
    features,
    limits,
    currentPeriodEnd: subscription.currentPeriodEnd || subscription.trialEndsAt || null,
    graceEndsAt: subscription.graceEndsAt || null,
    notice: subscription.notice || null,
    version: Date.now(),
  };
}

/** For provisioning: the snapshot an order's deployment should be born with. */
export async function snapshotForOrder(order) {
  const sub = (await subscriptionForOrder(order._id)) || (await onOrderSubmitted(order));
  return snapshotFor(sub);
}

/** Called after the staff-operations work provisions an order's deployment. */
export async function onProvisioned(order, organizationId, { by = null } = {}) {
  const sub = (await subscriptionForOrder(order._id)) || (await onOrderSubmitted(order));
  sub.organizationId = String(organizationId);
  if (sub.status === "pending") {
    sub.status = "trialing";
    sub.history.push({ status: "trialing", by: by?._id || null, note: "Deployment provisioned" });
  }
  await sub.save();
  await syncDeployment(sub);
  return sub;
}

/**
 * Pushes the subscription's snapshot to its deployment and records the
 * outcome on `sync`. Never throws: a failed push is recorded and retried
 * by the billing job, and the caller's own change still stands.
 */
export async function syncDeployment(subscription) {
  if (!subscription?.organizationId) return { skipped: true };
  try {
    const snapshot = await snapshotFor(subscription);
    await callDeployment("PUT", `/api/internal/organizations/${subscription.organizationId}/entitlements`, snapshot);
    subscription.sync = { version: snapshot.version, syncedAt: new Date(), error: null };
  } catch (err) {
    subscription.sync = { ...(subscription.sync || {}), error: err.message };
  }
  await subscription.save();
  return { error: subscription.sync.error };
}
