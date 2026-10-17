/**
 * Customer deployments: provisioning and managing them through the
 * control plane. Mounted in app.js at /api/vendor/deployments.
 * See docs/control-plane.md §3 (the signed API this calls) and §5.
 *
 *   GET  /status                 is the control plane configured, and does the product answer?
 *   GET  /slug-check?slug=       proxies GET /api/internal/slugs/:slug
 *   POST /provision              { orderId, slug } — builds the organization, takes the order live
 *   GET  /                       every provisioned deployment, with its plan and status
 *   GET  /:orderId               one deployment, with its LIVE usage, activity and owners
 *   POST /:orderId/owner-access  { email? } — a new temporary PIN for an owner
 *   POST /:orderId/sync          pushes the subscription's entitlements again
 *
 * A deployment is addressed by its ORDER id: that is the record SILLA
 * holds, and the product's organization id lives on it
 * (`provisionedOrganizationId`).
 *
 * TEMPORARY PINS are passed through to the staff member who asked, once,
 * and are never stored, logged or written to the audit trail. The product
 * emails the PIN to the owner too; this copy exists only because that
 * email is fire-and-forget, and a deployment nobody can enter is worse
 * than a PIN read out over the phone.
 */
import { Router } from "express";
import mongoose from "mongoose";
import Order, { ALLOWED_TRANSITIONS } from "../models/Order.js";
// Read for display only — billing owns it (services/billing.js).
import Subscription from "../models/Subscription.js";
import { requireAccount } from "../middleware/auth.js";
import { can, requirePermission } from "../middleware/staff.js";
import { ControlPlaneError, callDeployment, controlPlaneConfigured } from "../lib/controlPlane.js";
import { audit } from "../lib/audit.js";
import * as billing from "../services/billing.js";
import { sendEmail } from "../services/email/index.js";
import { orderLiveEmail } from "../services/email/templates.js";
import { orderSummary, planNameOf } from "./order.routes.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount);

const reject = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where customers reach their organization: `${PRODUCT_URL}/<slug>`. */
const PRODUCT_URL = () => (process.env.PRODUCT_URL || "http://localhost:5173").replace(/\/+$/, "");
const urlFor = (slug) => `${PRODUCT_URL()}/${slug}`;
const productApi = () => (process.env.SERVER_INTERNAL_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");

/**
 * The same SHAPE rule as server/src/lib/slug.js, checked here only so an
 * obvious typo does not cost a round trip. The product remains the
 * judge — it knows the reserved words and which addresses are taken.
 */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const slugShapeProblem = (slug) =>
  !slug
    ? "Choose an address."
    : !SLUG_SHAPE.test(slug) || slug.includes("--")
      ? "Use 3–40 lowercase letters, numbers and single hyphens, starting and ending with a letter or number."
      : null;

/**
 * A provisioning claim older than this is abandoned (the process died
 * mid-call) and may be taken over. Well past callDeployment's own 20s
 * timeout, so a live call is never mistaken for a dead one.
 */
const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Turns a control-plane failure into something the person at the console
 * can act on. "The product API answered 503" is true and useless; which
 * side is missing its secret, or that the address is unreachable, is
 * what tells them who to call.
 *
 * Returns { status, body } for a ControlPlaneError, or null for anything
 * else (a bug, which should surface as one).
 */
function explain(err) {
  if (!(err instanceof ControlPlaneError)) return null;
  const data = err.data || {};

  if (err.status === 503) {
    const vendorSide = !controlPlaneConfigured();
    return {
      status: 503,
      body: {
        code: "CONTROL_PLANE_UNCONFIGURED",
        side: vendorSide ? "vendor" : "product",
        error: vendorSide
          ? "Provisioning isn't switched on for this service: the commerce API has no CONTROL_PLANE_SECRET. Set the same secret (32+ characters) on it and on the product API, then restart both."
          : "The product API has no CONTROL_PLANE_SECRET, so it refuses requests from the console. Set the same secret there as here, then restart it.",
      },
    };
  }
  if (err.status === 401) {
    return {
      status: 502,
      body: {
        code: "CONTROL_PLANE_REJECTED",
        error:
          "The product API refused this service's signature. Either the two CONTROL_PLANE_SECRET values differ, or the machines' clocks are more than five minutes apart.",
        detail: data.error || err.message,
      },
    };
  }
  // callDeployment answers 502 with no body when the request never got an
  // answer — the API is down, the address is wrong, or it timed out.
  if (err.status === 502 && !data.error) {
    return {
      status: 502,
      body: {
        code: "CONTROL_PLANE_UNREACHABLE",
        error: `Couldn't reach the product API at ${productApi()}. Check that it is running and that SERVER_INTERNAL_URL points at it.`,
        detail: err.message,
      },
    };
  }
  // The product's own answer: a bad profile (400 INVALID_PROFILE), a
  // reserved address (400 INVALID_SLUG), a taken one (409 SLUG_TAKEN with
  // `suggestion`), an unknown organization. The product lists problems as
  // [{ field, message }] — the importer's own words — while every form in
  // the portal reads `fields` as { field: message }, so both are sent:
  // `fields` keyed for the form, `problems` in full for the list.
  const body = { ...data, error: data.error || err.message };
  if (Array.isArray(data.fields)) {
    body.problems = data.fields.map((f) => ({ field: String(f?.field ?? ""), message: String(f?.message ?? "") }));
    body.fields = {};
    for (const { field, message } of body.problems) if (!(field in body.fields)) body.fields[field] = message;
  }
  return { status: err.status, body };
}

/** Runs a control-plane call, answering with the explanation when it fails. */
async function viaControlPlane(res, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const explained = explain(err);
    if (!explained) throw err;
    res.status(explained.status).json(explained.body);
    return { ok: false, explained };
  }
}

/** What the console shows of a subscription — status and sync, nothing to do with money. */
const subscriptionView = (sub) =>
  sub
    ? {
        id: sub._id.toString(),
        status: sub.status,
        plan: sub.plan,
        planName: sub.planName,
        billingPeriod: sub.billingPeriod,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
        graceEndsAt: sub.graceEndsAt,
        sync: { syncedAt: sub.sync?.syncedAt || null, error: sub.sync?.error || null, version: sub.sync?.version || 0 },
      }
    : null;

const deploymentRow = (order, sub) => ({
  orderId: order._id.toString(),
  organizationName: order.organizationName,
  organizationId: order.provisionedOrganizationId,
  slug: order.deploymentSlug || "",
  url: order.deploymentUrl,
  plan: order.plan,
  planName: planNameOf(order),
  billingPeriod: order.billingPeriod,
  orderStatus: order.status,
  provisionedAt: order.provisionedAt || null,
  account:
    order.account && typeof order.account === "object" && order.account.email
      ? { id: order.account._id.toString(), name: order.account.name, email: order.account.email }
      : null,
  subscription: subscriptionView(sub),
});

/* ─────────────────────────────── status ─────────────────────────────── */

/**
 * Lets the console explain BEFORE anyone presses Provision that it will
 * not work, instead of after. `?ping=1` also checks the channel end to end.
 */
router.get(
  "/status",
  requirePermission("deployments.read"),
  asyncHandler(async (req, res) => {
    const status = { configured: controlPlaneConfigured(), productUrl: PRODUCT_URL(), reachable: null, problem: null };
    if (status.configured && req.query.ping) {
      try {
        await callDeployment("GET", "/api/internal/ping");
        status.reachable = true;
      } catch (err) {
        const explained = explain(err);
        if (!explained) throw err;
        status.reachable = false;
        status.problem = explained.body;
      }
    }
    res.json(status);
  })
);

/* ─────────────────────────────── addresses ─────────────────────────────── */

router.get(
  "/slug-check",
  requirePermission("deployments.provision"),
  asyncHandler(async (req, res) => {
    const slug = String(req.query.slug || "").trim().toLowerCase();
    const problem = slugShapeProblem(slug);
    if (problem) return res.json({ slug, available: false, problem, suggestion: null, url: null });

    const result = await viaControlPlane(res, () => callDeployment("GET", `/api/internal/slugs/${encodeURIComponent(slug)}`));
    if (!result.ok) return;
    res.json({
      slug,
      available: Boolean(result.value.available),
      problem: result.value.problem || null,
      suggestion: result.value.suggestion || null,
      url: urlFor(slug),
    });
  })
);

/* ─────────────────────────────── provisioning ─────────────────────────────── */

/**
 * PROVISION: one press from a submitted order to a live organization.
 *
 *   1. claim the order, so a second press (or a second person) cannot
 *      build a second organization while the first is in flight;
 *   2. ask billing what the deployment is entitled to;
 *   3. POST /api/internal/organizations on the product — the same
 *      creation path `npm run seed:file` takes;
 *   4. record where it lives, and move the order to live THROUGH the
 *      legal transitions (submitted → provisioning → live), each one in
 *      its history, so the record reads the same as if a person had
 *      clicked through them;
 *   5. tell billing, email the buyer, write the audit entry;
 *   6. hand the owner's temporary PIN back ONCE.
 *
 * A failure before step 4 leaves the order exactly as it was (and is
 * audited, since the product may have been reached). A timeout is the one
 * ambiguous case — the organization may exist — and pressing again is
 * safe: the product keys provisioning on the order id and answers
 * ALREADY_PROVISIONED with the organization it built, which this records
 * exactly as if the first answer had arrived (`adopted`).
 */
router.post(
  "/provision",
  requirePermission("deployments.provision"),
  asyncHandler(async (req, res) => {
    const { orderId } = req.body || {};
    const slug = String(req.body?.slug || "").trim().toLowerCase();
    if (!mongoose.isValidObjectId(orderId)) return reject(res, 400, "Invalid order id");
    const shape = slugShapeProblem(slug);
    if (shape) return reject(res, 400, shape, { fields: { slug: shape } });

    const order = await Order.findById(orderId).populate("account", "firstName lastName name email");
    if (!order || order.status === "draft") return reject(res, 404, "Order not found");
    if (order.provisionedOrganizationId) {
      return reject(res, 409, "This order already has a deployment.", { code: "ALREADY_PROVISIONED" });
    }
    if (!["submitted", "provisioning"].includes(order.status)) {
      return reject(res, 409, `Only a submitted order can be provisioned. This one is ${order.status}.`, {
        code: "NOT_PROVISIONABLE",
      });
    }
    // A profile with no owner is a valid DEMO profile: the product plants
    // the three demo accounts into it, whose PINs are published in the
    // README. That is the cross-customer hole CLAUDE.md describes, so a
    // customer's order is never provisioned that way from here.
    const owner = order.profile?.owner;
    if (!owner?.email || !owner?.firstName || !owner?.lastName) {
      return reject(
        res,
        409,
        "This configuration doesn't name an owner, so provisioning it would plant the demo accounts — whose sign-ins are public — into a customer's system. Ask the customer who should run it.",
        { code: "NO_OWNER" }
      );
    }

    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        provisionedOrganizationId: "",
        status: { $in: ["submitted", "provisioning"] },
        $or: [{ "provisioningClaim.at": null }, { "provisioningClaim.at": { $lt: new Date(Date.now() - CLAIM_TTL_MS) } }],
      },
      { $set: { provisioningClaim: { at: new Date(), by: req.account._id } } },
      { new: true }
    );
    if (!claimed) {
      return reject(res, 409, "Someone is provisioning this order right now. Give it a moment, then refresh.", {
        code: "PROVISIONING_IN_PROGRESS",
      });
    }

    const target = { type: "deployment", id: order._id, label: order.organizationName };
    let created;
    // True when the product already holds an organization for this order:
    // an earlier press reached it, but its answer never came back (a
    // timeout, a dropped connection). The product keys provisioning on
    // source.orderId and refuses to build a twin, so the honest move is
    // to record the one that exists — whose PIN went out with that lost
    // answer, and can only be replaced (owner access), never recovered.
    let adopted = false;
    try {
      const entitlements = await billing.snapshotForOrder(claimed);
      created = await callDeployment("POST", "/api/internal/organizations", {
        profile: claimed.profile,
        slug,
        entitlements,
        source: { orderId: claimed._id.toString() },
      });
    } catch (err) {
      const explained = explain(err);
      if (explained?.body.code === "ALREADY_PROVISIONED" && explained.body.organizationId) {
        adopted = true;
        created = { organizationId: explained.body.organizationId, slug: explained.body.slug || slug, owner: null, summary: null };
      } else {
        await Order.updateOne({ _id: claimed._id }, { $set: { provisioningClaim: { at: null, by: null } } });
        await audit(
          req,
          "deployment.provision.failed",
          target,
          `Provisioning ${order.organizationName} failed: ${explained?.body.error || err.message}`,
          { slug, status: explained?.status || 500, code: explained?.body.code || null }
        );
        if (!explained) throw err;
        // The one ambiguous failure: the request may have arrived. Saying
        // so is what makes pressing again feel safe rather than reckless.
        if (explained.body.code === "CONTROL_PLANE_UNREACHABLE") {
          explained.body.retry =
            "If the product received the request before the connection failed, pressing Provision again links this order to the organization it built rather than building a second one.";
        }
        return res.status(explained.status).json(explained.body);
      }
    }

    const finalSlug = created.slug || slug;
    const url = urlFor(finalSlug);
    const now = new Date();

    // Through the legal moves only, each recorded.
    const steps = [];
    let from = claimed.status;
    for (const next of from === "submitted" ? ["provisioning", "live"] : ["live"]) {
      if (!ALLOWED_TRANSITIONS[from]?.includes(next)) throw new Error(`Illegal transition ${from} → ${next}`);
      steps.push({
        status: next,
        at: now,
        by: req.account._id,
        note: next === "live" ? `Live at ${url}` : "Provisioning from the staff console",
      });
      from = next;
    }

    const updated = await Order.findOneAndUpdate(
      // Guarded on the organization id so a stale-claim takeover (which
      // the TTL makes practically impossible) can never overwrite a
      // deployment someone else just recorded — and on the status, so an
      // order cancelled while this call was out never comes back live.
      { _id: claimed._id, provisionedOrganizationId: "", status: { $in: ["submitted", "provisioning"] } },
      {
        $set: {
          status: "live",
          provisionedOrganizationId: String(created.organizationId),
          deploymentSlug: finalSlug,
          deploymentUrl: url,
          provisionedAt: now,
          provisioningClaim: { at: null, by: null },
        },
        $push: { history: { $each: steps } },
      },
      { new: true }
    );
    if (!updated) {
      // The organization exists and the order no longer wants it, or holds
      // another. Nothing here can undo the product's side, so it is said
      // plainly and put on the record where the next person will find it.
      const now = await Order.findById(claimed._id).select("status provisionedOrganizationId");
      console.error("[vendor:deployments] organization", created.organizationId, "was created for", order._id.toString(), "but the order moved on:", now?.status);
      await audit(req, "deployment.provision.failed", target,
        `Built organization ${created.organizationId} for ${order.organizationName}, but the order had moved on (${now?.status || "gone"}) — it needs a person`,
        { slug: finalSlug, organizationId: String(created.organizationId), status: 409, code: "ORDER_MOVED_ON" });
      return reject(
        res,
        409,
        now?.provisionedOrganizationId
          ? "This order was provisioned by someone else at the same moment. Check the deployments list."
          : `This order was ${now?.status || "removed"} while it was being provisioned. The organization was still built (${created.organizationId}) — decide what happens to it before going further.`,
        { code: "ALREADY_PROVISIONED", organizationId: created.organizationId }
      );
    }

    // Billing must not un-provision a built organization: a failure is
    // reported to staff (and the billing job retries the sync), not thrown.
    let subscription = null;
    let billingWarning = null;
    try {
      subscription = await billing.onProvisioned(updated, created.organizationId, { by: req.account });
    } catch (err) {
      console.error("[vendor:billing] onProvisioned failed for", updated._id.toString(), err);
      billingWarning = "The deployment is live, but its subscription could not be linked. Check it in Subscriptions.";
    }

    if (order.account) sendEmail(orderLiveEmail({ account: order.account, order: updated }));

    await audit(
      req,
      "deployment.provision",
      target,
      adopted
        ? `Linked ${updated.organizationName} to the organization an earlier attempt built, at ${url}`
        : `Provisioned ${updated.organizationName} at ${url}`,
      { organizationId: String(created.organizationId), slug: finalSlug, url, owner: created.owner?.email || null, adopted }
    );

    res.status(201).json({
      order: orderSummary(updated),
      deployment: deploymentRow(updated, subscription),
      // The only time this PIN exists outside the product. Not stored.
      owner: created.owner ? { email: created.owner.email, temporaryPin: created.owner.temporaryPin } : null,
      summary: created.summary || null,
      adopted,
      ...(adopted
        ? {
            notice:
              "This order's organization already existed — an earlier attempt reached the product but its answer never arrived. The owner's temporary PIN went out with that attempt and can't be shown again; re-issue owner access if they don't have it.",
          }
        : {}),
      billingWarning,
    });
  })
);

/* ─────────────────────────────── reading ─────────────────────────────── */

router.get(
  "/",
  requirePermission("deployments.read"),
  asyncHandler(async (req, res) => {
    const filter = { provisionedOrganizationId: { $ne: "" } };
    if (req.query.q && String(req.query.q).trim()) {
      const rx = { $regex: escapeRegex(String(req.query.q).trim().slice(0, 80)), $options: "i" };
      filter.$or = [{ organizationName: rx }, { deploymentSlug: rx }, { deploymentUrl: rx }];
    }
    const orders = await Order.find(filter)
      .sort({ provisionedAt: -1, updatedAt: -1 })
      .limit(500)
      .populate("account", "name email");
    const subs = await Subscription.find({ order: { $in: orders.map((o) => o._id) } });
    const byOrder = new Map(subs.map((s) => [s.order.toString(), s]));

    let rows = orders.map((o) => deploymentRow(o, byOrder.get(o._id.toString())));
    if (req.query.status) rows = rows.filter((r) => (r.subscription?.status || "none") === req.query.status);

    const counts = {};
    for (const r of orders.map((o) => byOrder.get(o._id.toString()))) {
      const key = r?.status || "none";
      counts[key] = (counts[key] || 0) + 1;
    }
    res.json({ deployments: rows, counts, total: orders.length, productUrl: PRODUCT_URL(), configured: controlPlaneConfigured() });
  })
);

/** Loads a provisioned order or answers 404. */
async function deploymentOrder(req, res) {
  if (!mongoose.isValidObjectId(req.params.orderId)) {
    reject(res, 400, "Invalid order id");
    return null;
  }
  const order = await Order.findOne({ _id: req.params.orderId, provisionedOrganizationId: { $ne: "" } }).populate(
    "account",
    "name email"
  );
  if (!order) reject(res, 404, "No deployment for that order");
  return order;
}

/**
 * One deployment, with what the product itself reports: usage against
 * the plan's limits, recent activity, and who its owners are.
 *
 * The live half can fail on its own — the product is down, or the
 * control plane is not configured — and the page should still show what
 * SILLA knows locally, with the reason it cannot show more. So that
 * failure is returned as `liveError`, not as the response's status.
 */
router.get(
  "/:orderId",
  requirePermission("deployments.read"),
  asyncHandler(async (req, res) => {
    const order = await deploymentOrder(req, res);
    if (!order) return;
    const sub = await billing.subscriptionForOrder(order._id);

    let live = null;
    let liveError = null;
    try {
      live = await callDeployment("GET", `/api/internal/organizations/${encodeURIComponent(order.provisionedOrganizationId)}`);
    } catch (err) {
      const explained = explain(err);
      if (!explained) throw err;
      liveError = { status: explained.status, ...explained.body };
    }

    res.json({
      deployment: deploymentRow(order, sub),
      live,
      liveError,
      can: {
        ownerAccess: can(req.account, "deployments.ownerAccess"),
        sync: can(req.account, "deployments.manage"),
      },
    });
  })
);

/* ─────────────────────────────── acting ─────────────────────────────── */

/**
 * A new temporary PIN for one of the organization's owners — the
 * "I can't get in" call. The product forces a PIN change at next sign-in
 * and emails the owner; the PIN comes back here once, for reading out.
 */
router.post(
  "/:orderId/owner-access",
  requirePermission("deployments.ownerAccess"),
  asyncHandler(async (req, res) => {
    const order = await deploymentOrder(req, res);
    if (!order) return;
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reject(res, 400, "Enter a valid email address.");

    const result = await viaControlPlane(res, () =>
      callDeployment(
        "POST",
        `/api/internal/organizations/${encodeURIComponent(order.provisionedOrganizationId)}/owner-access`,
        email ? { email } : {}
      )
    );
    if (!result.ok) return;

    await audit(
      req,
      "deployment.owner_access",
      { type: "deployment", id: order._id, label: order.organizationName },
      `Re-issued owner access for ${order.organizationName} to ${result.value.email}`,
      { email: result.value.email }
    );
    res.json({ owner: { email: result.value.email, temporaryPin: result.value.temporaryPin } });
  })
);

/**
 * Push the subscription's entitlements again — after fixing a secret, or
 * when the sync column shows an error. billing.syncDeployment never
 * throws; it records the outcome on the subscription, which is returned.
 */
router.post(
  "/:orderId/sync",
  requirePermission("deployments.manage"),
  asyncHandler(async (req, res) => {
    const order = await deploymentOrder(req, res);
    if (!order) return;
    const sub = await billing.subscriptionForOrder(order._id);
    if (!sub) return reject(res, 409, "This deployment has no subscription to sync yet.", { code: "NO_SUBSCRIPTION" });

    const result = (await billing.syncDeployment(sub)) || {};
    const error = result.error || null;
    await audit(
      req,
      "deployment.sync",
      { type: "deployment", id: order._id, label: order.organizationName },
      error
        ? `Tried to push ${order.organizationName}'s plan to its deployment: ${error}`
        : `Pushed ${order.organizationName}'s plan to its deployment`,
      { error, skipped: Boolean(result.skipped) }
    );

    const fresh = await billing.subscriptionForOrder(order._id);
    res.json({ ok: !error && !result.skipped, error, configured: controlPlaneConfigured(), subscription: subscriptionView(fresh) });
  })
);

export default router;
