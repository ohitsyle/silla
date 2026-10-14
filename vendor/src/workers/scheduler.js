/**
 * The vendor's background jobs — renewals, overdue invoices, suspensions,
 * reminder emails, conversation notifications.
 *
 * Each job module exports an array of { name, everyMs, run }. Every job
 * must be idempotent: it may run twice (a restart, an overlapping tick),
 * and running it again must change nothing that already happened. A job
 * that throws is logged and retried on its next tick; it never stops the
 * others.
 *
 * Started by server.js. Tests call runJobsOnce() directly instead of
 * waiting for a timer.
 */
import billingJobs from "./billing.jobs.js";
import conversationJobs from "./conversation.jobs.js";

export const JOBS = [...billingJobs, ...conversationJobs];

const running = new Set();

async function runJob(job) {
  if (running.has(job.name)) return; // the previous tick is still going
  running.add(job.name);
  try {
    await job.run();
  } catch (err) {
    console.error(`[vendor:job] ${job.name} failed:`, err);
  } finally {
    running.delete(job.name);
  }
}

export async function runJobsOnce(names = null) {
  for (const job of JOBS) {
    if (!names || names.includes(job.name)) await runJob(job);
  }
}

export function startScheduler() {
  const timers = JOBS.map((job) => setInterval(() => runJob(job), job.everyMs));
  console.log(`[vendor:jobs] ${JOBS.length} job(s) scheduled`);
  return () => timers.forEach(clearInterval);
}
