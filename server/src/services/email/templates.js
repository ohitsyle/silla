/**
 * Email templates (spec §15).
 *
 * Every template takes the organization so the copy carries the buyer's
 * name, terminology and colours rather than "SILLA" or "library" (spec
 * §16). Each is rendered through layout.js, which produces an HTML part and
 * a plain-text part from the same blocks, and returns `fromName` so the
 * inbox shows the organization as the sender.
 *
 * Two rules for anything security-shaped (codes, PINs): say what happened
 * in plain words, and say what to do if it was not you. A code with no
 * "if you didn't ask for this" line trains people to type codes they did
 * not request.
 */
import { SILLA_BRAND, button, code, details, note, orgBrand, p, renderEmail } from "./layout.js";

const memberNoun = (org) => org?.terminology?.memberNoun || "member";
const resourceNoun = (org) => org?.terminology?.resourceNoun || "resource";

/**
 * Where a button should send people: the deployment's own client. APP_URL
 * when set, otherwise the first allowed CORS origin — which is that same
 * client, since it is the only thing permitted to call this API. With
 * neither, the message simply has no button.
 */
const appUrl = (path = "") => {
  const base = (process.env.APP_URL || (process.env.CORS_ORIGINS || "").split(",")[0] || "").trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
};

const day = (date) => new Date(date).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = (date) => new Date(date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Thursday, 17 September" + "2:00 PM – 6:00 PM", or a full range across days. */
const span = (start, end) =>
  sameDay(start, end)
    ? [["Date", day(start)], ["Time", `${time(start)} – ${time(end)}`]]
    : [["From", `${day(start)}, ${time(start)}`], ["Until", `${day(end)}, ${time(end)}`]];

function build(org, to, subject, content, brand = orgBrand(org)) {
  return { to, subject, fromName: brand.name, ...renderEmail({ brand, ...content }) };
}

/** ID-2 — the registration verification code. */
export function verificationCodeEmail({ org, user, code: value, expiryMinutes }) {
  return build(org, user.email, `${value} is your ${org.name} verification code`, {
    preheader: `Enter ${value} at the kiosk to finish registering. It expires in ${expiryMinutes} minutes.`,
    eyebrow: "Verify your email",
    title: "Finish your registration",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`Someone started a ${memberNoun(org)} registration at ${org.name} with this email address. Enter this code at the kiosk to finish.`),
      code(value, `Expires in ${expiryMinutes} minutes`),
      note("Wasn't you? Ignore this email. The registration is discarded automatically and no account is created."),
    ],
    reason: `because a registration was started at ${org.name} with this address`,
  });
}

/** NOT-2 — reservation confirmation. */
export function reservationConfirmedEmail({ org, user, reservation, resourceLabel }) {
  const grace = org.policy?.gracePeriodMinutes ?? 10;
  const noun = resourceNoun(org);
  return build(org, user.email, `Your ${noun} is reserved — ${resourceLabel}`, {
    preheader: `${resourceLabel}, ${day(reservation.startTime)} at ${time(reservation.startTime)}. Check in within ${grace} minutes of the start.`,
    eyebrow: "Reservation confirmed",
    title: `Your ${noun} is reserved`,
    greeting: `Hi ${user.firstName},`,
    blocks: [
      details([[capitalise(noun), resourceLabel], ...span(reservation.startTime, reservation.endTime)]),
      p(`Tap your card at the kiosk within ${grace} minutes of the start time to check in.`),
      note(`If you don't check in by then, the ${noun} is released for someone else.`, "warning"),
      appUrl("/map") ? button("View the map", appUrl("/map")) : null,
    ].filter(Boolean),
    reason: `because you reserved a ${noun} at ${org.name}`,
  });
}

/** NOT-3 — starting-soon reminder, sent before the grace window closes. */
export function startingSoonEmail({ org, user, reservation, resourceLabel }) {
  const grace = org.policy?.gracePeriodMinutes ?? 10;
  const noun = resourceNoun(org);
  return build(org, user.email, `Starting soon — ${resourceLabel} at ${time(reservation.startTime)}`, {
    preheader: `Tap in within ${grace} minutes of ${time(reservation.startTime)} or it's released.`,
    eyebrow: "Starting soon",
    title: "Your reservation starts soon",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      details([[capitalise(noun), resourceLabel], ...span(reservation.startTime, reservation.endTime)]),
      note(`Tap in within ${grace} minutes of the start time, or the ${noun} is released as a no-show.`, "warning"),
    ],
    reason: `as a reminder of your reservation at ${org.name}`,
  });
}

/** NOT-4 — the maximum-stay auto-release (spec §10). */
export function maxStayReleasedEmail({ org, user, reservation, resourceLabel }) {
  const maxHours = org.policy?.maxStayHours ?? 4;
  const noun = resourceNoun(org);
  return build(org, user.email, `Your session on ${resourceLabel} was released`, {
    preheader: `It reached the ${maxHours}-hour maximum stay. Tap in again to start a new session.`,
    eyebrow: "Session ended",
    title: "Your session was released",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`Your ${noun} (${resourceLabel}) was released after reaching the ${maxHours}-hour maximum stay.`),
      details([[capitalise(noun), resourceLabel], ["Started", `${day(reservation.startTime)}, ${time(reservation.startTime)}`]]),
      p("Still using it? Tap your card at the kiosk again to start a new session."),
      note("Staff may ask you to move if someone is waiting."),
    ],
    reason: `because a session at ${org.name} reached its time limit`,
  });
}

/** Grace expired with no check-in — the no-show release (spec §11). */
export function noShowReleasedEmail({ org, user, reservation, resourceLabel }) {
  const noun = resourceNoun(org);
  return build(org, user.email, `Reservation released — ${resourceLabel}`, {
    preheader: "It wasn't checked in within the grace period. You can book again at any time.",
    eyebrow: "Reservation released",
    title: "Your reservation was released",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`Your ${noun} wasn't checked in within the grace period, so it was released for someone else.`),
      details([[capitalise(noun), resourceLabel], ...span(reservation.startTime, reservation.endTime)]),
      p("You can book again at any time."),
      appUrl("/map") ? button("Book again", appUrl("/map")) : null,
    ].filter(Boolean),
    reason: `because a reservation at ${org.name} was not checked in`,
  });
}

/** NOT-5 — a closure cancelled the reservation; the reason is included. */
export function closureCancelledEmail({ org, user, reservation, resourceLabel, closure }) {
  const noun = resourceNoun(org);
  return build(org, user.email, `Your reservation was cancelled — ${org.name} is closed`, {
    preheader: `${org.name} is closed ${day(closure.startTime)}. Reason: ${closure.reason}`,
    eyebrow: "Reservation cancelled",
    title: "Your reservation was cancelled",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`${org.name} is closed during your reservation, so it has been cancelled.`),
      details([[capitalise(noun), resourceLabel], ...span(reservation.startTime, reservation.endTime)]),
      note(`Reason for the closure: ${closure.reason}`, "warning"),
      details([
        ["Closed from", `${day(closure.startTime)}, ${time(closure.startTime)}`],
        ["Closed until", `${day(closure.endTime)}, ${time(closure.endTime)}`],
      ]),
      p("We're sorry for the inconvenience. You can book another time once the closure ends."),
    ],
    reason: `because ${org.name} scheduled a closure`,
  });
}

/** RES-6 — the grace period changed; that day's reservers are told. */
export function gracePeriodChangedEmail({ org, user, minutes }) {
  return build(org, user.email, `Check-in grace period is now ${minutes} minutes`, {
    preheader: `This applies to your reservation today at ${org.name}.`,
    eyebrow: "Policy change",
    title: "The check-in grace period changed",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`The check-in grace period at ${org.name} is now ${minutes} minutes.`),
      note(`This applies to your reservation today — tap in within ${minutes} minutes of your start time.`, "warning"),
    ],
    reason: `because you have a reservation today at ${org.name}`,
  });
}

/** ADM-4 — staff onboarding one-time PIN. */
export function staffOnboardingEmail({ org, user, temporaryPin }) {
  return build(org, user.email, `Your ${org.name} ${user.role} account`, {
    preheader: `Sign in with your email and the temporary PIN inside.`,
    eyebrow: "Account created",
    title: `Welcome to ${org.name}`,
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p(`A ${user.role} account has been created for you at ${org.name}.`),
      details([["Sign in with", user.email]]),
      code(temporaryPin, "Temporary PIN"),
      p("You'll set your own 6-digit PIN and accept the terms of use the first time you sign in."),
      appUrl("/login") ? button("Sign in", appUrl("/login")) : null,
      note(`Weren't expecting this? Tell ${org.name} before signing in.`),
    ].filter(Boolean),
    reason: `because an administrator at ${org.name} created an account for you`,
  });
}

/**
 * The founding superadmin of a newly provisioned deployment.
 *
 * Distinct from staffOnboardingEmail because the situations are not the
 * same. That one says an account "has been created for you", which is
 * true when a colleague provisions you and nonsense when you are the
 * person who bought the system. This is the moment a customer's system
 * becomes theirs, so it says so, and it carries the one thing that was
 * previously promised and never sent: the credentials to get in.
 *
 * It is the one product email SILLA signs, because it is SILLA handing
 * the deployment over — every later message comes from the organization.
 *
 * The PIN is temporary by construction — the account is created with
 * mustChangePin, so the first sign-in forces a change and this message
 * stops being useful the moment it is used.
 */
export function founderWelcomeEmail({ org, user, temporaryPin, deploymentUrl }) {
  return build(
    org,
    user.email,
    `${org.name} is ready`,
    {
      preheader: `Your deployment is provisioned. Sign in with the temporary PIN inside.`,
      eyebrow: "Your system is live",
      title: `${org.name} is ready`,
      greeting: `Hi ${user.firstName},`,
      blocks: [
        p(
          `${org.name} has been provisioned and is ready to use. You are its superadmin, which means you can add your team, lay out your floors and change any of the settings we configured with you.`
        ),
        details([
          ["Sign in at", deploymentUrl || null],
          ["Your email", user.email],
        ]),
        code(temporaryPin, "Temporary PIN"),
        p("You'll set your own 6-digit PIN and accept the terms of use the first time you sign in. Nobody at SILLA can see the PIN you choose."),
        deploymentUrl ? button(`Open ${org.name}`, deploymentUrl) : null,
        note("If you did not expect this email, tell us before signing in.", "warning"),
      ].filter(Boolean),
      reason: `because a SILLA deployment was provisioned for ${org.name}`,
    },
    SILLA_BRAND
  );
}

/** AUTH-4 — PIN reset code. */
export function pinResetEmail({ org, user, code: value, expiryMinutes }) {
  return build(org, user.email, `${value} is your ${org.name} PIN reset code`, {
    preheader: `Enter ${value} to set a new PIN. It expires in ${expiryMinutes} minutes.`,
    eyebrow: "Reset your PIN",
    title: "Set a new PIN",
    greeting: `Hi ${user.firstName},`,
    blocks: [
      p("Enter this code to choose a new PIN."),
      code(value, `Expires in ${expiryMinutes} minutes`),
      note("Didn't ask for this? Ignore this email. Your PIN stays the same until the code is used."),
    ],
    reason: `because a PIN reset was requested for your ${org.name} account`,
  });
}

function capitalise(word) {
  return String(word).charAt(0).toUpperCase() + String(word).slice(1);
}
