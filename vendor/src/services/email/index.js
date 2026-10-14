/**
 * Email for the storefront.
 *
 * Deliberately a copy of the product's service rather than an import
 * from it: `vendor/` is a separate deployment with its own credentials
 * and its own database, and reaching across into `server/` would tie the
 * two together at exactly the seam we keep insisting is separate. The
 * duplication is small and the independence is the point.
 *
 * Same two rules as the product's (spec §15):
 *   1. Sending is asynchronous. A slow or failed mail server must never
 *      block or roll back a good order.
 *   2. One transport function, so a provider change is one edit.
 */
import { createTransport } from "nodemailer";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const queue = [];
let draining = false;

export const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASSWORD);
export const emailConfigured = smtpConfigured;

/** Prints instead of sending, so the storefront works with no mail set up. */
function consoleTransport({ to, subject, text }) {
  console.log(
    ["", "─".repeat(64), `[vendor-email:dev] To: ${to}`, `[vendor-email:dev] Subject: ${subject}`, "", text, "─".repeat(64), ""].join("\n")
  );
}

let smtp = null;
async function smtpTransport({ to, subject, text, html }) {
  if (!smtp) {
    smtp = createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || "465") === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  await smtp.sendMail({
    // A display name, so the inbox row reads "SILLA" rather than a bare
    // gmail address — which is what makes a code email look legitimate.
    from: { name: process.env.EMAIL_FROM_NAME || "SILLA", address: process.env.EMAIL_FROM || process.env.SMTP_USER },
    to,
    subject,
    text,
    // Both parts, always: clients that refuse HTML, screen readers and
    // spam filters scoring the text/HTML ratio all read the text part.
    ...(html ? { html } : {}),
  });
}

const transport = smtpConfigured ? smtpTransport : consoleTransport;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await transport(job);
    } catch (err) {
      job.attempts += 1;
      if (job.attempts < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** (job.attempts - 1));
        queue.push(job);
      } else {
        console.error(`[vendor-email] gave up on "${job.subject}" to ${job.to}:`, err.message);
      }
    }
  }
  draining = false;
}

/** Fire-and-forget by design — see rule 1 above. */
/**
 * Addresses that must never be handed to a real mail provider.
 *
 * The suites create accounts at @test.silla on every run. Once a live
 * provider is configured those become real send attempts — three
 * retries each, against a finite daily quota, every one of them
 * bouncing and every bounce counting against the sender's reputation.
 * Dropping them here rather than in each caller means a new test cannot
 * forget.
 */
const UNDELIVERABLE = /@test\.silla$|@example\.(com|org|net)$/i;

/** True for the test domains the transport drops — for callers deciding whether to notify a REAL inbox about them. */
export const isUndeliverable = (email) => UNDELIVERABLE.test(String(email || ""));

export function sendEmail({ to, subject, text, html }) {
  if (!to) return;
  if (UNDELIVERABLE.test(to)) return;
  queue.push({ to, subject, text, html, attempts: 0 });
  drain();
}

/** Test hook: resolves once the queue has emptied. */
export async function flushEmails(timeoutMs = 5000) {
  const start = Date.now();
  while ((queue.length || draining) && Date.now() - start < timeoutMs) await sleep(50);
}
