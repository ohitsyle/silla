/**
 * Email service (spec §15).
 *
 * Two rules from the spec drive the whole design:
 *   1. "sent asynchronously so a slow or failed mail server never blocks
 *      or rolls back a good reservation" — send() therefore NEVER throws
 *      and NEVER returns a promise the caller is expected to await for
 *      delivery. It enqueues and returns immediately.
 *   2. "delivered via an email API rather than raw SMTP" — the HTTP
 *      transport below, not nodemailer.
 *
 * This is the minimum NOT-1 needs to exist for ID-2 (the registration
 * verification code) to work. The full notification catalogue —
 * reservation confirmations, starting-soon reminders, release notices —
 * is Sprint 2; those are new templates through this same send(), not a
 * new mechanism.
 *
 * No dependency: the HTTP transport uses global fetch (Node 18+).
 */

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const queue = [];
let draining = false;

/**
 * Set once at boot so the dev transport can be detected by callers.
 *
 * True for EITHER route — an SMTP mailbox or an API key. Callers use
 * this to decide whether to keep returning verification codes in the
 * response, and that fallback must switch off whichever way mail is
 * actually being sent.
 */
export const smtpConfigured = Boolean(process.env.SMTP_USER && process.env.SMTP_PASSWORD);
export const emailConfigured = smtpConfigured || Boolean(process.env.EMAIL_API_KEY);

/**
 * Console transport — the default when no EMAIL_API_KEY is set. Prints
 * the message so a local kiosk registration can actually be completed
 * without a mail provider account.
 */
function consoleTransport({ to, subject, text }) {
  console.log(
    ["", "─".repeat(64), `[email:dev] To: ${to}`, `[email:dev] Subject: ${subject}`, "", text, "─".repeat(64), ""].join(
      "\n"
    )
  );
}

/**
 * Gmail (or any SMTP server), authenticating as a real mailbox.
 *
 * This is the simplest thing that works for a small deployment: the
 * address is already yours, so there is nothing to verify and mail
 * reaches ANY recipient immediately. An API relay like Resend refuses
 * to send from a domain you have not proved you own — a rule that
 * protects the relay's reputation, not a property of email.
 *
 * Gmail needs an APP PASSWORD, not the account password: Google blocks
 * plain-password SMTP outright. Generate one at
 * myaccount.google.com/apppasswords (requires 2-Step Verification).
 *
 * The trade is deliverability at volume — a free Gmail account is
 * capped near 500 recipients a day and is likelier to land in spam than
 * a verified sending domain. Fine for a pilot; revisit before a large
 * rollout, at which point only this function changes.
 */
let smtp = null;
async function smtpTransport({ to, subject, text, html, fromName }) {
  if (!smtp) {
    const { createTransport } = await import("nodemailer");
    smtp = createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || "465") === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  // nodemailer quotes the display name itself, so an organization
  // called `Smith, Jones & "Co"` cannot break the From header.
  await smtp.sendMail({
    from: { name: fromName || "", address: process.env.EMAIL_FROM || process.env.SMTP_USER },
    to,
    subject,
    text,
    html,
  });
}

/**
 * Resend-shaped HTTP transport. Swapping providers (SendGrid, Brevo)
 * means changing this one function — spec §15 leaves the choice open
 * and §20 lists it as still-open.
 */
async function httpTransport({ to, subject, text, html, fromName }) {
  const address = process.env.EMAIL_FROM || "no-reply@example.com";
  // Built by hand here, so the name is reduced to characters that cannot
  // end the display name or start a second address.
  const name = String(fromName || "").replace(/[^\p{L}\p{N} .&'-]/gu, "").trim();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: name ? `"${name}" <${address}>` : address,
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Email API responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

/**
 * SMTP wins when both are configured: it is the more specific choice,
 * and silently preferring an API key someone forgot to remove would
 * send from the wrong address.
 */
const transport = smtpConfigured ? smtpTransport : process.env.EMAIL_API_KEY ? httpTransport : consoleTransport;

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
        // Back off and requeue. A permanently failing provider must not
        // take the API down with it — the message is simply lost after
        // MAX_ATTEMPTS, and logged loudly.
        await sleep(RETRY_BASE_MS * 2 ** (job.attempts - 1));
        queue.push(job);
      } else {
        console.error(`[email] giving up on "${job.subject}" to ${job.to} after ${job.attempts} attempts:`, err.message);
      }
    }
  }
  draining = false;
}

/**
 * Fire-and-forget. Returns void by design: a caller that awaits delivery
 * has reintroduced exactly the coupling spec §15 forbids.
 */
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

export function sendEmail({ to, subject, text, html, fromName }) {
  if (!to) return;
  if (UNDELIVERABLE.test(to)) return;
  queue.push({ to, subject, text, html, fromName, attempts: 0 });
  // Detached on purpose — drain() swallows its own errors.
  drain();
}

/** Test/script hook: resolves once the queue has emptied. */
export async function flushEmails(timeoutMs = 5000) {
  const start = Date.now();
  while ((queue.length || draining) && Date.now() - start < timeoutMs) {
    await sleep(50);
  }
}
