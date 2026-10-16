/**
 * The billing job — the clock side of docs/control-plane.md §4.
 *
 * It decides WHO is due for something; what happens to them is decided in
 * services/billing.js, so a suspension by this job and a suspension by
 * staff are the same code, with the same history, audit line, push to the
 * deployment and email.
 *
 * One cycle, in this order, every five minutes:
 *
 *   1. number any invoice left reserved by a process that stopped mid-issue
 *   2. end the subscriptions scheduled to end at their period's (or trial's) end
 *   3. issue renewal invoices `renewalNoticeDays` before a paid period ends
 *   4. a period or trial over with its bill fallen due and unpaid → past due, with grace
 *   5. grace over with the bill still unpaid → suspended (read-only, nothing deleted)
 *   6. reminders: due soon, overdue, trial ending
 *
 * The order matters. Scheduled ends run before lapses, so a customer who
 * chose to leave is not first told they are late. Lapses run before
 * reminders, because the lapse email carries the overdue notice AND the
 * grace period — sending the plain overdue reminder first would say half
 * of it twice.
 *
 * Idempotent, every step: transitions are conditional updates that only
 * apply to the state the job read, renewals are unique per period, and
 * each reminder claims its slot on the invoice (Invoice.reminders) or
 * subscription before sending. Running a cycle twice — a restart, two
 * processes — sends nothing twice and bills nobody twice.
 *
 * Re-pushing failed entitlement syncs is its own job, on its own clock: a
 * slow or unreachable product API must not hold up invoices and reminders.
 *
 * Export shape: [{ name, everyMs, run }] — see scheduler.js.
 */
import Invoice from "../models/Invoice.js";
import Subscription from "../models/Subscription.js";
import * as billing from "../services/billing.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Per step per cycle. Far above SILLA's size; it bounds a cycle if something floods. */
const BATCH = 200;

/** Each item is isolated: one bad document must not stop everyone after it. */
async function each(label, docs, fn) {
  let done = 0;
  for (const doc of docs) {
    try {
      if (await fn(doc)) done += 1;
    } catch (err) {
      console.error(`[vendor:billing] ${label} failed for ${doc._id}:`, err);
    }
  }
  return done;
}

export async function runBillingCycle({ now = new Date() } = {}) {
  const settings = await billing.getSettings();
  const noticeDays = settings.billing?.renewalNoticeDays ?? 7;
  const lead = new Date(now.getTime() + billing.REMINDER_LEAD_DAYS * DAY);
  const done = {};

  done.numbered = await billing.numberReservedInvoices({ now });

  // 2. Scheduled ends.
  done.ended = await each(
    "scheduled end",
    await Subscription.find({
      cancelAtPeriodEnd: true,
      $or: [
        { status: "active", currentPeriodEnd: { $ne: null, $lte: now } },
        { status: "trialing", trialEndsAt: { $ne: null, $lte: now } },
      ],
    }).limit(BATCH),
    async (sub) => Boolean(await billing.endAtPeriodEnd(sub, { now }))
  );

  // 3. Renewals. A subscription without an agreed price, or ending, gets none.
  done.renewals = await each(
    "renewal",
    await Subscription.find({
      status: "active",
      cancelAtPeriodEnd: { $ne: true },
      needsPricing: { $ne: true },
      "price.amount": { $ne: null },
      currentPeriodEnd: { $ne: null, $lte: new Date(now.getTime() + noticeDays * DAY) },
    }).limit(BATCH),
    async (sub) => (await billing.issueRenewalInvoice(sub, { settings })).created
  );

  // 4. Lapses: the period (or trial) is over. lapse() itself checks that a
  // bill has actually fallen due — nobody is late for one not sent or not due.
  done.lapsed = await each(
    "lapse",
    await Subscription.find({
      cancelAtPeriodEnd: { $ne: true },
      $or: [
        { status: "active", currentPeriodEnd: { $ne: null, $lte: now } },
        { status: "trialing", trialEndsAt: { $ne: null, $lte: now } },
      ],
    }).limit(BATCH),
    async (sub) => Boolean(await billing.lapse(sub, { kind: sub.status === "trialing" ? "trial" : "period", settings, now }))
  );

  // 5. Grace over.
  done.suspended = await each(
    "suspension",
    await Subscription.find({ status: "past_due", graceEndsAt: { $ne: null, $lte: now } }).limit(BATCH),
    async (sub) => Boolean(await billing.suspendAfterGrace(sub, { settings, now }))
  );

  // 6. Reminders, each at most once.
  done.dueSoon = await each(
    "due-soon reminder",
    await Invoice.find({
      ...billing.NUMBERED,
      status: "open",
      "reminders.dueSoonAt": null,
      dueAt: { $gt: now, $lte: lead },
      // Not on the heels of the invoice itself: an invoice issued with short
      // terms would otherwise be followed by its "due soon" within minutes.
      issuedAt: { $lte: new Date(now.getTime() - DAY) },
    }).limit(BATCH),
    (invoice) => billing.sendDueSoonReminder(invoice, { settings, now })
  );
  done.overdue = await each(
    "overdue reminder",
    await Invoice.find({ ...billing.NUMBERED, status: "open", "reminders.overdueAt": null, dueAt: { $lt: now } }).limit(BATCH),
    (invoice) => billing.sendOverdueReminder(invoice, { settings, now })
  );
  done.trialEnding = await each(
    "trial-ending reminder",
    await Subscription.find({ status: "trialing", "reminders.trialEndingAt": null, trialEndsAt: { $gt: now, $lte: lead } }).limit(BATCH),
    (sub) => billing.sendTrialEndingReminder(sub, { settings, now })
  );

  const happened = Object.entries(done).filter(([, n]) => n);
  if (happened.length) console.log(`[vendor:billing] cycle — ${happened.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return done;
}

export default [
  { name: "billing.cycle", everyMs: 5 * MINUTE, run: () => runBillingCycle() },
  { name: "billing.sync-retry", everyMs: 10 * MINUTE, run: () => billing.retryFailedSyncs() },
];
