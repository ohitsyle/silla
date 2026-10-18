/**
 * Billing — plans, subscriptions, invoices, payments and the billing job,
 * asserted from the outside wherever there is an outside.
 *
 * Money moves through the real HTTP API: submitting an order, claiming a
 * payment, staff recording one, the permission table. Time does not —
 * nobody can wait a year for a renewal — so the suite moves dates directly
 * in the database and then runs the billing job itself (runJobsOnce, in
 * this process, against the same database the API is using).
 *
 * That makes it unsafe anywhere but a throwaway database: the job would
 * renew, lapse and email REAL customers. It runs only under
 *   npm run test:isolated
 * and says so, rather than passing or failing, under plain `npm test`.
 *
 * Provisioning itself belongs to the staff-operations work; this suite
 * calls billing.onProvisioned() directly — the seam that work calls.
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { KNOWN_CODE, plantCode } from "./helpers.mjs";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";
import AuditEvent from "../src/models/AuditEvent.js";
import Invoice from "../src/models/Invoice.js";
import Order from "../src/models/Order.js";
import Plan from "../src/models/Plan.js";
import Subscription from "../src/models/Subscription.js";
import * as billing from "../src/services/billing.js";
import { runBillingCycle } from "../src/workers/billing.jobs.js";
import { runJobsOnce } from "../src/workers/scheduler.js";

export const name = "Billing — plans, subscriptions, invoices";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const DAY = 86_400_000;
const PASSWORD = "a-long-enough-password";
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function req(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (path, headers) => req(path, { headers });
const post = (path, body, headers) => req(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
const patch = (path, body, headers) => req(path, { method: "PATCH", headers, body: JSON.stringify(body || {}) });
const put = (path, body, headers) => req(path, { method: "PUT", headers, body: JSON.stringify(body || {}) });

const profileFor = (organizationName) => ({
  key: organizationName.toLowerCase().replace(/\W+/g, "-"),
  organizationName,
  siteName: "Main Site",
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  floors: [{ name: "Level 1", order: 0, grid: { cols: 10, rows: 8 }, resources: [], zones: [], labels: [] }],
});

/** Same as services/billing.js addPeriod: calendar months, clamped to the month's last day. */
function addMonths(when, months) {
  const d = new Date(when);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}
const near = (a, b, ms = 60_000) => a && b && Math.abs(new Date(a) - new Date(b)) <= ms;
const seqOf = (number) => Number(String(number).split("-").pop());

async function buyer(email, organizationName) {
  const signup = await post("/api/vendor/auth/register", {
    firstName: "Bil",
    lastName: "Tester",
    email,
    confirmEmail: email,
    password: PASSWORD,
    acceptTerms: true,
    organizationName,
  });
  const H = auth(signup.body?.token);
  await plantCode(email, "signup");
  await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, H);
  return H;
}

async function submitOrder(H, organizationName, plan, billingPeriod = "yearly") {
  const created = await post("/api/vendor/orders", { profile: profileFor(organizationName), plan, billingPeriod, currency: "PHP" }, H);
  const id = created.body?.order?.id;
  const submitted = await post(`/api/vendor/orders/${id}/submit`, {}, H);
  return { id, status: submitted.body?.order?.status };
}

/**
 * Planted straight into the database. Staff exist through seed:staff (the
 * first owner) or an owner's invitation, which staff.test.mjs walks; this
 * suite only needs them to exist.
 */
async function staffMember(role, tag) {
  const email = `staff-${role}-${tag}@test.silla`;
  await Account.create({
    email,
    firstName: "Staff",
    lastName: role,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    role: "silla",
    staffRole: role,
    active: true,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    passwordChangedAt: new Date(Date.now() - 5000),
  });
  const login = await post("/api/vendor/auth/login", { email, password: PASSWORD });
  return auth(login.body?.token);
}

async function cleanupBilling() {
  const testers = (await Account.find({ email: /@test\.silla$/ }).select("_id")).map((a) => a._id);
  const subs = (await Subscription.find({ account: { $in: testers } }).select("_id")).map((s) => String(s._id));
  const invoices = (await Invoice.find({ account: { $in: testers } }).select("_id")).map((i) => String(i._id));
  // The activity log has no delete route on purpose; this is the test
  // harness removing its own fabricated trail, never a person's.
  await AuditEvent.deleteMany({
    $or: [
      { "target.type": "subscription", "target.id": { $in: subs } },
      { "target.type": "invoice", "target.id": { $in: invoices } },
      { actor: { $in: testers } },
    ],
  });
  await Invoice.deleteMany({ account: { $in: testers } });
  await Subscription.deleteMany({ account: { $in: testers } });
}

export async function run(check) {
  if (mongoose.connection.readyState !== 1) await connectDB();
  if (process.env.VENDOR_DB_NAME !== "silla_vendor_isolated") {
    console.log("  skipped — this suite moves dates and runs the billing job against the database,");
    console.log("  which would bill real customers. Run it with: npm run test:isolated");
    // The other suites' submits still made subscriptions and invoices for
    // their @test.silla buyers; those are removed either way, like their
    // accounts and orders are by cleanup.mjs.
    await cleanupBilling();
    return;
  }
  // Deterministic: the control plane is NOT configured in THIS process —
  // the one calling billing directly below — whatever the shell exported.
  // (The API process has one, for the fake product API the staff suite
  // provisions against.) Put back afterwards: the suites share this
  // process, and the staff suite signs with the secret this would erase.
  const secretBefore = process.env.CONTROL_PLANE_SECRET;
  process.env.CONTROL_PLANE_SECRET = "";

  const tag = unique();
  const settingsBefore = billing.settingsShape(await billing.getSettings());
  let roomTagline = null;
  const teamKey = `team-${tag}`.slice(0, 40);
  const bespokeKey = `bespoke-${tag}`.slice(0, 40);

  try {
    /* ── who is asking ── */
    const ownerLogin = await post("/api/vendor/auth/login", {
      email: process.env.VENDOR_STAFF_EMAIL,
      password: process.env.VENDOR_STAFF_PASSWORD,
    });
    if (ownerLogin.status !== 200) {
      check("BIL-0", "SILLA staff can sign in", false, "set VENDOR_STAFF_EMAIL / VENDOR_STAFF_PASSWORD");
      return;
    }
    const OWNER = auth(ownerLogin.body.token);
    const BILLING = await staffMember("billing", tag);
    const SUPPORT = await staffMember("support", tag);
    const A = await buyer(`bil-a-${tag}@test.silla`, "Harbor Billing Co");
    const B = await buyer(`bil-b-${tag}@test.silla`, "Other Billing Co");

    /* ── the catalogue ── */
    const plans = await get("/api/vendor/plans");
    const building = (plans.body?.plans || []).find((p) => p.key === "building");
    check("BIL-1", "The storefront's plans are public, priced in pesos", plans.status === 200 && building?.currency === "PHP" && building?.prices?.annualMonthly > 0,
      building ? `${building.prices.annualMonthly} centavos/month yearly` : `status ${plans.status}`);

    /* ── submit → subscription + first invoice ── */
    const orderA = await submitOrder(A, "Harbor Billing Co", "building", "yearly");
    const subA = await Subscription.findOne({ order: orderA.id });
    check("BIL-2", "Submitting an order creates a pending subscription", orderA.status === "submitted" && subA?.status === "pending", subA?.status);
    const firstA = subA ? await Invoice.findOne({ subscription: subA._id, kind: "first" }) : null;
    check("BIL-2", "…and its first invoice, open and numbered", firstA?.status === "open" && /^TEST-\d{4}-\d{5}$/.test(firstA?.number || ""), firstA?.number);
    check("BIL-2", "A yearly invoice is the annual per-month price × 12", firstA?.total === building?.prices?.annualMonthly * 12,
      `${firstA?.total} vs ${building?.prices?.annualMonthly * 12}`);
    check("BIL-2", "No VAT while SILLA is not VAT-registered", firstA?.tax?.amount === 0 && firstA?.issuer?.vatRegistered === false);
    check("BIL-2", "It is due in the configured number of days", near(firstA?.dueAt, new Date(firstA?.issuedAt).getTime() + settingsBefore.invoice.dueDays * DAY));

    const meA = await get("/api/vendor/billing/me", A);
    const mineA = meA.body?.subscriptions?.[0];
    check("BIL-2", "The buyer sees it in plain words, with the open invoice",
      mineA?.status === "pending" && mineA?.statusLabel === "Being set up" && mineA?.openInvoices?.length === 1, mineA?.statusLabel);

    /* ── billTo is frozen ── */
    await patch("/api/vendor/auth/me/billing", { name: "Accounts Payable", company: "Harbor Billing Co", email: `ap-${tag}@test.silla` }, A);
    const frozen = await get(`/api/vendor/billing/invoices/${firstA?._id}`, A);
    check("BIL-3", "Editing billing details does not rewrite an invoice already issued",
      frozen.body?.invoice?.billTo?.name === "Bil Tester" && !String(frozen.body?.invoice?.billTo?.email).startsWith("ap-"), frozen.body?.invoice?.billTo?.name);

    /* ── one buyer, one set of invoices ── */
    const peek = await get(`/api/vendor/billing/invoices/${firstA?._id}`, B);
    check("BIL-4", "Another buyer cannot read this invoice", peek.status === 404, `status ${peek.status}`);
    const claimOther = await post(`/api/vendor/billing/invoices/${firstA?._id}/claim`, { method: "gcash", reference: "1234567890123", amount: 100, paidAt: new Date().toISOString() }, B);
    check("BIL-4", "…nor claim to have paid it", claimOther.status === 404, `status ${claimOther.status}`);
    const listB = await get("/api/vendor/billing/me/invoices", B);
    check("BIL-4", "…and it is absent from their list", !(listB.body?.invoices || []).some((i) => i.id === String(firstA?._id)));
    const buyerStaff = await get("/api/vendor/billing/subscriptions", A);
    check("BIL-4", "A buyer cannot reach the staff side", buyerStaff.status === 403, `status ${buyerStaff.status}`);

    /* ── a claim is a claim ── */
    const card = await post(`/api/vendor/billing/invoices/${firstA?._id}/claim`,
      { method: "bank_transfer", reference: "4111 1111 1111 1111", amount: firstA?.total, paidAt: new Date().toISOString() }, A);
    check("BIL-5", "A card number typed as a reference is refused, not stored", card.status === 400 && Boolean(card.body?.fields?.reference));
    const claim = await post(`/api/vendor/billing/invoices/${firstA?._id}/claim`,
      { method: "gcash", reference: "9012345678901", amount: firstA?.total, paidAt: new Date().toISOString() }, A);
    const afterClaim = await Subscription.findById(subA?._id);
    const invAfterClaim = await Invoice.findById(firstA?._id);
    check("BIL-5", "\"I've paid\" is recorded", claim.status === 200 && Boolean(claim.body?.invoice?.claim?.submittedAt), claim.body?.error);
    check("BIL-5", "…and activates NOTHING: the invoice stays open, the subscription pending",
      invAfterClaim?.status === "open" && afterClaim?.status === "pending", `${invAfterClaim?.status} / ${afterClaim?.status}`);
    const waiting = await get("/api/vendor/billing/invoices?claimed=1", OWNER);
    check("BIL-5", "Staff see it among the claims waiting", (waiting.body?.invoices || []).some((i) => i.id === String(firstA?._id)));

    /* ── provisioning: trial, and a sync that cannot reach anyone ── */
    let provisioned = null;
    let threw = null;
    try {
      provisioned = await billing.onProvisioned(await Order.findById(orderA.id), `org-${tag}`);
    } catch (err) {
      threw = err;
    }
    check("BIL-6", "Provisioning an unpaid order starts the free trial", provisioned?.status === "trialing" &&
      near(provisioned?.trialEndsAt, Date.now() + settingsBefore.billing.trialDays * DAY), provisioned?.status || threw?.message);
    const synced = await Subscription.findById(subA?._id);
    check("BIL-6", "Control plane not configured: the push fails, is recorded, and nothing throws",
      !threw && /not configured/i.test(synced?.sync?.error || ""), synced?.sync?.error || threw?.message);

    /* ── trial-ending reminder, once ── */
    const trialEnd = new Date(Date.now() + 2 * DAY);
    await Subscription.updateOne({ _id: subA._id }, { $set: { trialEndsAt: trialEnd, "reminders.trialEndingAt": null } });
    await runJobsOnce();
    const warned = (await Subscription.findById(subA._id)).reminders?.trialEndingAt;
    await runJobsOnce();
    const warnedAgain = (await Subscription.findById(subA._id)).reminders?.trialEndingAt;
    check("BIL-7", "The trial-ending reminder goes out once, however often the job runs", Boolean(warned) && +warned === +warnedAgain);

    /* ── who may record money ── */
    const paymentBody = { method: "gcash", amount: firstA?.total, reference: "9012345678901", receivedAt: new Date().toISOString() };
    const bySupport = await post(`/api/vendor/billing/invoices/${firstA?._id}/payment`, paymentBody, SUPPORT);
    check("BIL-8", "Support staff cannot record a payment", bySupport.status === 403 && bySupport.body?.code === "STAFF_PERMISSION", `status ${bySupport.status}`);
    const supportList = await get("/api/vendor/billing/subscriptions", SUPPORT);
    check("BIL-8", "…nor read subscriptions at all", supportList.status === 403);
    const byBilling = await post(`/api/vendor/billing/invoices/${firstA?._id}/payment`, paymentBody, BILLING);
    check("BIL-8", "Billing staff can", byBilling.status === 200 && byBilling.body?.invoice?.status === "paid", byBilling.body?.error);
    const twice = await post(`/api/vendor/billing/invoices/${firstA?._id}/payment`, paymentBody, BILLING);
    check("BIL-8", "The same invoice cannot be paid twice", twice.status === 409, `status ${twice.status}`);

    const paid = await Subscription.findById(subA._id);
    check("BIL-9", "Recording the payment activates the subscription", paid?.status === "active", paid?.status);
    check("BIL-9", "…and its paid year starts where the trial ends — paying early costs no trial days",
      +paid?.currentPeriodStart === +trialEnd && +paid?.currentPeriodEnd === +addMonths(trialEnd, 12),
      `${paid?.currentPeriodStart?.toISOString()} → ${paid?.currentPeriodEnd?.toISOString()}`);
    const stamped = await Invoice.findById(firstA?._id);
    check("BIL-9", "The invoice records the period it bought", +stamped?.periodStart === +trialEnd && +stamped?.periodEnd === +paid?.currentPeriodEnd);

    /* ── renewal: once, however often ── */
    const renewEnd = new Date(Date.now() + 2 * DAY);
    await Subscription.updateOne({ _id: subA._id }, { $set: { currentPeriodStart: addMonths(renewEnd, -12), currentPeriodEnd: renewEnd } });
    await runJobsOnce();
    await runJobsOnce();
    await Promise.all([runBillingCycle(), runBillingCycle()]);
    const renewals = await Invoice.find({ subscription: subA._id, kind: "renewal" });
    check("BIL-10", "The renewal job issues ONE invoice when run twice (and twice at once)", renewals.length === 1, `${renewals.length} renewal(s)`);
    const renewal = renewals[0];
    check("BIL-10", "…for the period after this one, due when that period begins",
      +renewal?.periodStart === +renewEnd && new Date(renewal?.dueAt) >= renewEnd, renewal?.number);

    /* ── unpaid period end → past due ── */
    const lapsedAt = new Date(Date.now() - 60 * 60 * 1000);
    await Subscription.updateOne({ _id: subA._id }, { $set: { currentPeriodStart: addMonths(lapsedAt, -12), currentPeriodEnd: lapsedAt } });
    await Invoice.updateOne({ _id: renewal?._id }, { $set: { periodStart: lapsedAt, periodEnd: addMonths(lapsedAt, 12), dueAt: lapsedAt } });
    await runJobsOnce();
    const late = await Subscription.findById(subA._id);
    check("BIL-11", "An unpaid period end makes it past due", late?.status === "past_due", late?.status);
    check("BIL-11", "…with a grace period running from the end", near(late?.graceEndsAt, lapsedAt.getTime() + settingsBefore.billing.graceDays * DAY));
    const lateInvoice = await Invoice.findById(renewal?._id);
    await runJobsOnce();
    const lateInvoiceAgain = await Invoice.findById(renewal?._id);
    check("BIL-11", "The overdue notice is claimed once and never repeated",
      Boolean(lateInvoice?.reminders?.overdueAt) && +lateInvoice.reminders.overdueAt === +lateInvoiceAgain?.reminders?.overdueAt);
    check("BIL-11", "…and no second renewal appeared", (await Invoice.countDocuments({ subscription: subA._id, kind: "renewal" })) === 1);
    const lateMe = (await get("/api/vendor/billing/me", A)).body?.subscriptions?.[0];
    check("BIL-11", "The buyer reads \"Payment overdue\", not past_due", lateMe?.statusLabel === "Payment overdue" && /keeps working until/.test(lateMe?.statusDetail || ""), lateMe?.statusDetail);

    /* ── grace over → suspended ── */
    await Subscription.updateOne({ _id: subA._id }, { $set: { graceEndsAt: new Date(Date.now() - 60_000) } });
    await runJobsOnce();
    const suspended = await Subscription.findById(subA._id);
    check("BIL-12", "Grace over and still unpaid: suspended", suspended?.status === "suspended", suspended?.status);

    /* ── paying a suspended subscription brings it back ── */
    const back = await post(`/api/vendor/billing/invoices/${renewal?._id}/payment`,
      { method: "bank_transfer", amount: renewal?.total, reference: "BDO-778812" }, BILLING);
    const revived = await Subscription.findById(subA._id);
    check("BIL-13", "A payment after suspension makes it active again", back.status === 200 && revived?.status === "active", revived?.status || back.body?.error);
    check("BIL-13", "…paid for a year from now, grace cleared",
      revived?.graceEndsAt === null && near(revived?.currentPeriodEnd, addMonths(new Date(), 12), 5 * 60_000), revived?.currentPeriodEnd?.toISOString());

    /* ── the trail ── */
    const trail = await AuditEvent.find({ "target.type": "subscription", "target.id": String(subA._id), action: "subscription.status" }).sort({ at: 1 });
    const moves = trail.map((e) => `${e.meta?.from}→${e.meta?.to}`);
    const expected = ["pending→trialing", "trialing→active", "active→past_due", "past_due→suspended", "suspended→active"];
    check("BIL-14", "Every status change wrote an audit event", expected.every((m) => moves.includes(m)), moves.join(", "));
    const payments = await AuditEvent.find({ action: "invoice.payment", "target.id": { $in: [String(firstA?._id), String(renewal?._id)] } });
    check("BIL-14", "…and each payment names the billing staff member who recorded it",
      payments.length === 2 && payments.every((e) => e.actorRole === "billing"), payments.map((e) => e.actorRole).join());
    const claimEvent = await AuditEvent.findOne({ action: "invoice.claim", "target.id": String(firstA?._id) });
    check("BIL-14", "…and the buyer's claim is on the record as theirs", claimEvent?.actorRole === "buyer");
    const history = (await Subscription.findById(subA._id)).history.map((h) => h.status);
    check("BIL-14", "The subscription's own history has every step", expected.every((m) => history.includes(m.split("→")[1])), history.join(" > "));

    /* ── numbering under concurrency ── */
    const accountB = await Account.findOne({ email: `bil-b-${tag}@test.silla` });
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post("/api/vendor/billing/invoices", { accountId: String(accountB._id), lines: [{ description: `Setup ${i + 1}`, quantity: 1, unitAmount: 150000 }] }, OWNER)
      )
    );
    const numbers = burst.map((r) => r.body?.invoice?.number).filter(Boolean);
    const seqs = numbers.map(seqOf).sort((x, y) => x - y);
    check("BIL-15", "Eight invoices issued at once get eight different numbers", numbers.length === 8 && new Set(numbers).size === 8, numbers.join(" "));
    check("BIL-15", "…with no gaps between them", seqs.every((n, i) => !i || n === seqs[i - 1] + 1), seqs.join(","));

    /* ── VAT only when registered, frozen at issue ── */
    const vatOn = await put("/api/vendor/settings", { business: { ...settingsBefore.business, vatRegistered: true, taxId: "123-456-789-000" } }, OWNER);
    const vatInvoice = await post("/api/vendor/billing/invoices", { accountId: String(accountB._id), lines: [{ description: "Training day", quantity: 1, unitAmount: 1_000_00 }] }, OWNER);
    await put("/api/vendor/settings", { business: settingsBefore.business }, OWNER);
    const vatRead = await get(`/api/vendor/billing/invoices/${vatInvoice.body?.invoice?.id}`, B);
    check("BIL-16", "VAT is added when SILLA is VAT-registered", vatOn.status === 200 && vatInvoice.body?.invoice?.tax?.amount === 12_000 && vatInvoice.body?.invoice?.total === 112_000,
      `${vatInvoice.body?.invoice?.tax?.label} ${vatInvoice.body?.invoice?.tax?.amount}`);
    check("BIL-16", "…and stays on that invoice after registration is switched off", vatRead.body?.invoice?.issuer?.vatRegistered === true && vatRead.body?.invoice?.tax?.amount === 12_000);
    const noVat = await post("/api/vendor/billing/invoices", { accountId: String(accountB._id), lines: [{ description: "Training day", quantity: 1, unitAmount: 1_000_00 }] }, OWNER);
    check("BIL-16", "A later invoice carries none", noVat.body?.invoice?.tax?.amount === 0 && noVat.body?.invoice?.total === 1_000_00);

    /* ── reminders, each once ── */
    const soon = burst[0].body?.invoice?.id;
    await Invoice.updateOne({ _id: soon }, { $set: { issuedAt: new Date(Date.now() - 2 * DAY), dueAt: new Date(Date.now() + 2 * DAY) } });
    await runJobsOnce();
    const soonOnce = (await Invoice.findById(soon)).reminders?.dueSoonAt;
    await runJobsOnce();
    const soonTwice = (await Invoice.findById(soon)).reminders?.dueSoonAt;
    check("BIL-17", "A due-soon reminder goes out once", Boolean(soonOnce) && +soonOnce === +soonTwice);

    /* ── a claim staff could not match ── */
    const claimB = burst[1].body?.invoice;
    await post(`/api/vendor/billing/invoices/${claimB?.id}/claim`, { method: "maya", reference: "MAYA-5512", amount: claimB?.total, paidAt: new Date().toISOString() }, B);
    const noReason = await post(`/api/vendor/billing/invoices/${claimB?.id}/claim/dismiss`, {}, BILLING);
    const dismissed = await post(`/api/vendor/billing/invoices/${claimB?.id}/claim/dismiss`, { reason: "No Maya transfer with that reference yet." }, BILLING);
    const seenByB = await get(`/api/vendor/billing/invoices/${claimB?.id}`, B);
    check("BIL-18", "Dismissing a claim needs a reason the buyer will read", noReason.status === 400 && Boolean(noReason.body?.fields?.reason));
    check("BIL-18", "…and the buyer sees why, with the invoice still open",
      dismissed.status === 200 && seenByB.body?.invoice?.status === "open" && seenByB.body?.invoice?.claim?.dismissNote === "No Maya transfer with that reference yet.");

    /* ── void ── */
    const toVoid = burst[2].body?.invoice?.id;
    const voided = await post(`/api/vendor/billing/invoices/${toVoid}/void`, { reason: "Issued in error" }, BILLING);
    const payVoid = await post(`/api/vendor/billing/invoices/${toVoid}/payment`, { method: "cash", amount: 150000 }, BILLING);
    check("BIL-19", "An invoice can be voided with a reason", voided.status === 200 && voided.body?.invoice?.status === "void");
    check("BIL-19", "…and a void invoice cannot be paid", payVoid.status === 409, `status ${payVoid.status}`);

    /* ── per-client overrides ── */
    const badOverride = await patch(`/api/vendor/billing/subscriptions/${subA._id}`, { overrides: { features: { teleport: true } } }, OWNER);
    check("BIL-20", "An override for a feature that doesn't exist is refused by name", badOverride.status === 400 && Boolean(badOverride.body?.fields?.["overrides.features.teleport"]));
    const overridden = await patch(`/api/vendor/billing/subscriptions/${subA._id}`,
      { overrides: { features: { kiosk: false }, limits: { resources: 900, staff: null } }, notice: "Kiosk paused while you renovate." }, OWNER);
    const eff = overridden.body?.subscription?.effective;
    check("BIL-20", "Overrides layer over the plan for this client only",
      overridden.status === 200 && eff?.features?.kiosk === false && eff?.limits?.resources === 900 && overridden.body?.subscription?.planDefaults?.limits?.resources === 600,
      JSON.stringify(eff?.limits));
    const includes = (await get("/api/vendor/billing/me", A)).body?.subscriptions?.[0]?.includes;
    check("BIL-20", "…and the buyer's page shows what they actually have",
      includes?.features?.find((f) => f.key === "kiosk")?.on === false && includes?.limits?.find((l) => l.key === "resources")?.value === 900);

    /* ── priced with you: no invoice until staff agree one ── */
    // Every default plan has a list price now, so this one is made for the
    // purpose — the console's "Has a list price: off".
    await post("/api/vendor/plans", {
      key: bespokeKey,
      name: "Bespoke",
      tagline: "Priced with each customer.",
      prices: { monthly: null, annualMonthly: null },
    }, OWNER);
    const orderC = await submitOrder(B, "Other Billing Campus", bespokeKey, "yearly");
    const subC = await Subscription.findOne({ order: orderC.id });
    check("BIL-21", "A plan priced with each customer issues no invoice on submit",
      subC?.needsPricing === true && (await Invoice.countDocuments({ subscription: subC?._id })) === 0);
    const flagged = await get("/api/vendor/billing/subscriptions?attention=1", BILLING);
    check("BIL-21", "…and is flagged for staff instead",
      (flagged.body?.subscriptions || []).some((s) => s.id === String(subC?._id) && s.attention.includes("Needs a price")));
    const priced = await patch(`/api/vendor/billing/subscriptions/${subC?._id}`, { price: 480_000_00 }, BILLING);
    const firstC = await Invoice.findOne({ subscription: subC?._id });
    check("BIL-21", "Agreeing a price issues the first invoice at that price",
      priced.status === 200 && Boolean(priced.body?.issuedInvoice) && firstC?.kind === "first" && firstC?.total === 480_000_00, priced.body?.error);

    /* ── paid before go-live → active at provisioning ── */
    await post(`/api/vendor/billing/invoices/${firstC?._id}/payment`, { method: "bank_transfer", amount: firstC?.total, reference: "BPI-1" }, BILLING);
    const prepaid = await Subscription.findById(subC?._id);
    check("BIL-22", "A payment before go-live leaves it pending", prepaid?.status === "pending");
    const liveC = await billing.onProvisioned(await Order.findById(orderC.id), `org-c-${tag}`);
    check("BIL-22", "Provisioning an already-paid order goes straight to active, the year after the trial",
      liveC?.status === "active" && +liveC?.currentPeriodStart === +liveC?.trialEndsAt, liveC?.status);

    /* ── plans and settings: who may change them ── */
    const roomBefore = (await get("/api/vendor/plans")).body?.plans?.find((p) => p.key === "room");
    roomTagline = roomBefore?.tagline ?? null;
    const billingEditsPlan = await patch("/api/vendor/plans/room", { tagline: "Nope" }, BILLING);
    const billingEditsSettings = await put("/api/vendor/settings", { invoice: { prefix: "NOPE", dueDays: 7 } }, BILLING);
    const billingReadsSettings = await get("/api/vendor/settings", BILLING);
    check("BIL-23", "Billing staff read settings but cannot change them, nor the plans",
      billingReadsSettings.status === 200 && billingEditsSettings.status === 403 && billingEditsPlan.status === 403);
    const retired = await patch("/api/vendor/plans/room", { active: false }, OWNER);
    const publicAfter = (await get("/api/vendor/plans")).body?.plans || [];
    const staffAll = (await get("/api/vendor/plans/all", OWNER)).body?.plans || [];
    await patch("/api/vendor/plans/room", { active: true }, OWNER);
    check("BIL-23", "A retired plan leaves the storefront but stays in the console",
      retired.status === 200 && !publicAfter.some((p) => p.key === "room") && staffAll.some((p) => p.key === "room" && p.active === false));
    const halfPrice = await patch("/api/vendor/plans/room", { prices: { monthly: 100000, annualMonthly: null } }, OWNER);
    check("BIL-23", "A plan cannot be half-priced", halfPrice.status === 400 && Boolean(halfPrice.body?.fields?.["prices.annualMonthly"]));
    const settingsAudit = await AuditEvent.findOne({ action: "settings.update", actorRole: "owner" }).sort({ at: -1 });
    const planAudit = await AuditEvent.findOne({ action: "plan.update", "target.id": "room" }).sort({ at: -1 });
    check("BIL-23", "Settings and plan changes are on the activity log", Boolean(settingsAudit && planAudit));

    /* ── a plan staff create is on sale at once ── */
    const teamPlan = await post("/api/vendor/plans", {
      key: teamKey,
      name: "Team",
      tagline: "For a team of twenty.",
      currency: "PHP",
      prices: { monthly: 1_500_00, annualMonthly: 1_200_00 },
      limits: { staff: 5, resources: 40 },
    }, OWNER);
    const onSale = ((await get("/api/vendor/plans")).body?.plans || []).find((p) => p.key === teamKey);
    check("BIL-24", "A plan staff create is on the storefront at once, and orderable",
      teamPlan.status === 201 && onSale?.orderable === true, teamPlan.body?.error || JSON.stringify(onSale));
    const teamOrder = await submitOrder(A, `Team Co ${tag}`, teamKey, "monthly");
    const teamSub = await Subscription.findOne({ order: teamOrder.id });
    const teamInvoice = teamSub ? await Invoice.findOne({ subscription: teamSub._id, kind: "first" }) : null;
    // On monthly billing the first invoice carries onboarding too — it is
    // waived only on yearly (lib/defaultCatalog.js).
    const teamPlanLine = teamInvoice?.lines?.find((l) => l.kind === "plan");
    check("BIL-24", "…an order for it is accepted and billed at its price",
      teamOrder.status === "submitted" && teamSub?.plan === teamKey && teamSub?.planName === "Team" && teamPlanLine?.amount === 1_500_00,
      `${teamOrder.status} ${teamSub?.plan} ${teamPlanLine?.amount}`);
    const teamRow = (await get(`/api/vendor/orders/${teamOrder.id}`, A)).body?.order;
    check("BIL-24", "…and the order keeps the plan's name and currency", teamRow?.planName === "Team" && teamRow?.currency === "PHP");
    const snapshot = await billing.snapshotForOrder(await Order.findById(teamOrder.id));
    check("BIL-24", "…and its deployment would be born with that plan's limits",
      snapshot.plan === teamKey && snapshot.limits.staff === 5 && snapshot.limits.resources === 40);
    await patch(`/api/vendor/plans/${teamKey}`, { active: false }, OWNER);
    const retiredOrder = await post("/api/vendor/orders", { profile: profileFor(`Late Co ${tag}`), plan: teamKey }, A);
    const unknown = await post("/api/vendor/orders", { profile: profileFor(`Nowhere Co ${tag}`), plan: `nope-${tag}`.slice(0, 40) }, A);
    check("BIL-24", "A retired plan takes no new orders, and neither does one that doesn't exist",
      retiredOrder.status === 400 && Boolean(retiredOrder.body?.fields?.plan) && unknown.status === 400 && Boolean(unknown.body?.fields?.plan));
  } finally {
    if (secretBefore === undefined) delete process.env.CONTROL_PLANE_SECRET;
    else process.env.CONTROL_PLANE_SECRET = secretBefore;
    // Leave the database as it was found: the settings and the plan this suite touched, and its records.
    await billing.updateSettings({ business: settingsBefore.business, invoice: settingsBefore.invoice, billing: settingsBefore.billing }).catch(() => {});
    if (roomTagline !== null) await billing.updatePlan("room", { tagline: roomTagline, active: true }).catch(() => {});
    await Plan.deleteMany({ key: { $in: [teamKey, bespokeKey] } }).catch(() => {});
    await cleanupBilling();
  }
}
