/**
 * Sends one real email, so delivery can be proven before anything
 * depends on it.
 *
 *   npm run email:test -- you@yourdomain.com
 *
 * Why this exists: setting EMAIL_API_KEY switches off the development
 * fallback that returns verification codes in the API response. If the
 * provider is misconfigured, the first thing you learn is that kiosk
 * registration has silently stopped working — the code goes nowhere and
 * nobody can finish signing up. This checks the provider on its own,
 * with a clear failure message, before that happens.
 *
 * It deliberately calls the provider DIRECTLY rather than going through
 * sendEmail(): that queue is fire-and-forget by design (spec §15), so a
 * failure there is logged and swallowed, which is exactly the wrong
 * behaviour for a test.
 */
import "dotenv/config";
import { isUndeliverable } from "../services/email/index.js";

const to = process.argv[2];
const key = process.env.EMAIL_API_KEY;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASSWORD;
const from = process.env.EMAIL_FROM || smtpUser;

const die = (message, hint) => {
  console.error(`\n  \u2717 ${message}`);
  if (hint) console.error(`    ${hint}`);
  console.error("");
  process.exit(1);
};

if (!to) die("No recipient.", "Usage: npm run email:test -- you@yourdomain.com");
// The transport drops reserved test addresses (RFC 2606's .test, .example
// and example.com, and our own @test.silla) before a provider sees them.
// This script calls the provider directly, so it applies the same rule
// rather than spending quota on a guaranteed bounce.
if (isUndeliverable(to)) {
  die(`${to} is a reserved test address, so nothing sent to it can arrive.`, "Use a real inbox you can read.");
}

const useSmtp = Boolean(smtpUser && smtpPass);

if (!useSmtp && !key) {
  die(
    "Neither SMTP nor an API key is configured, so nothing would be sent.",
    "Set SMTP_USER + SMTP_PASSWORD (Gmail app password) in server/.env, or EMAIL_API_KEY."
  );
}
if (!from) die("No sender address.", "Set EMAIL_FROM, or SMTP_USER if you are sending via Gmail.");
if (from === "no-reply@example.com") {
  die("EMAIL_FROM is still the placeholder.", "Use your real sending address.");
}

console.log(`\n  via  : ${useSmtp ? `SMTP (${process.env.SMTP_HOST || "smtp.gmail.com"})` : "Resend API"}`);
console.log(`  from : ${from}`);
console.log(`  to   : ${to}`);
console.log("  sending…\n");

const subject = "SILLA — email delivery test";
const text = [
  "This is a test from your SILLA deployment.",
  "",
  "If you are reading it, verification codes and PIN resets will reach",
  "your members. If you are not, they will not — and the system will not",
  "tell you, because email is sent asynchronously so a failing mail",
  "provider can never block a good reservation.",
].join("\n");

if (useSmtp) {
  const { createTransport } = await import("nodemailer");
  const smtp = createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_PORT || "465") === "465",
    auth: { user: smtpUser, pass: smtpPass },
  });
  try {
    // verify() checks the credentials before a message is queued, so a
    // wrong app password fails here with a clear reason rather than
    // silently later inside the fire-and-forget send queue.
    await smtp.verify();
  } catch (err) {
    if (/Invalid login|BadCredentials|535/i.test(err.message)) {
      die(
        "Gmail rejected the credentials.",
        "Use an APP PASSWORD, not your account password — myaccount.google.com/apppasswords (needs 2-Step Verification on)."
      );
    }
    die(`Could not reach the SMTP server: ${err.message}`);
  }

  try {
    const info = await smtp.sendMail({ from, to, subject, text });
    console.log(`  \u2713 Sent. Message id: ${info.messageId}\n`);
    console.log("    Check the inbox — and the spam folder, which is where a");
    console.log("    new Gmail sender often lands the first time.\n");
    process.exit(0);
  } catch (err) {
    die(`Gmail refused the message: ${err.message}`);
  }
}

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ from, to: [to], subject, text }),
});

const body = await res.text();

if (res.ok) {
  console.log("  \u2713 Accepted by Resend.\n");
  console.log("    Check the inbox — accepted is not the same as delivered.\n");
  process.exit(0);
}
if (res.status === 403 && body.includes("domain")) {
  die(
    `Resend rejected the sender (${res.status}).`,
    "That domain is not verified on your Resend account."
  );
}
if (res.status === 422) {
  die(
    `Resend rejected the request (${res.status}): ${body}`,
    "On the free tier, onboarding@resend.dev only delivers to your own signup address."
  );
}
die(`Resend responded ${res.status}: ${body}`);
