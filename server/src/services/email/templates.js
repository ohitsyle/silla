/**
 * Email templates (spec §15).
 *
 * Every template takes the organization so the copy carries the buyer's
 * name and terminology rather than "SILLA" or "library" (spec §16).
 * Plain text only for now — a provider-side HTML template is a
 * presentation concern, not a v1 requirement.
 */

const facility = (org) => org?.terminology?.facilityLabel || "facility";
const memberNoun = (org) => org?.terminology?.memberNoun || "member";

/** ID-2 — the registration verification code. */
export function verificationCodeEmail({ org, user, code, expiryMinutes }) {
  return {
    to: user.email,
    subject: `${org.name} — your verification code`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Someone started a ${memberNoun(org)} registration at ${org.name} with this email address.`,
      "",
      `Your verification code is: ${code}`,
      "",
      `Enter it at the kiosk within ${expiryMinutes} minutes.`,
      "",
      `If this wasn't you, ignore this email — the registration is discarded automatically and no account is created.`,
      "",
      `— ${org.name} ${facility(org)}`,
    ].join("\n"),
  };
}

const when = (date) =>
  new Date(date).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const resourceNoun = (org) => org?.terminology?.resourceNoun || "resource";

/** NOT-2 — reservation confirmation. */
export function reservationConfirmedEmail({ org, user, reservation, resourceLabel }) {
  const grace = org.policy?.gracePeriodMinutes ?? 10;
  return {
    to: user.email,
    subject: `${org.name} — your ${resourceNoun(org)} is reserved`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Your ${resourceNoun(org)} (${resourceLabel}) is reserved.`,
      "",
      `  From: ${when(reservation.startTime)}`,
      `  Until: ${when(reservation.endTime)}`,
      "",
      `Tap your card at the kiosk within ${grace} minutes of the start time to check in.`,
      `If you don't, the ${resourceNoun(org)} is released for someone else.`,
      "",
      `— ${org.name}`,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  };
}

/** NOT-3 — starting-soon reminder, sent before the grace window closes. */
export function startingSoonEmail({ org, user, reservation, resourceLabel }) {
  const grace = org.policy?.gracePeriodMinutes ?? 10;
  return {
    to: user.email,
    subject: `${org.name} — your reservation starts soon`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Your ${resourceNoun(org)} (${resourceLabel}) is booked from ${when(reservation.startTime)}.`,
      "",
      `Tap in within ${grace} minutes of that time or it will be released as a no-show.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** NOT-4 — the maximum-stay auto-release (spec §10). */
export function maxStayReleasedEmail({ org, user, reservation, resourceLabel }) {
  const maxHours = org.policy?.maxStayHours ?? 4;
  return {
    to: user.email,
    subject: `${org.name} — your session was released`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Your ${resourceNoun(org)} (${resourceLabel}) has been released after reaching the ${maxHours}-hour maximum stay.`,
      "",
      `If you are still using it, please tap your card again to start a new session.`,
      `Staff may ask you to move if someone is waiting.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** Grace expired with no check-in — the no-show release (spec §11). */
export function noShowReleasedEmail({ org, user, reservation, resourceLabel }) {
  return {
    to: user.email,
    subject: `${org.name} — reservation released`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Your ${resourceNoun(org)} (${resourceLabel}) booked for ${when(reservation.startTime)} was released because it wasn't checked in within the grace period.`,
      "",
      `You can book again at any time.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** NOT-5 — a closure cancelled the reservation; the reason is included. */
export function closureCancelledEmail({ org, user, reservation, resourceLabel, closure }) {
  return {
    to: user.email,
    subject: `${org.name} — your reservation was cancelled`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Your ${resourceNoun(org)} (${resourceLabel}) booked for ${when(reservation.startTime)} has been cancelled because ${org.name} is closed during that period.`,
      "",
      `  Reason: ${closure.reason}`,
      `  Closed: ${when(closure.startTime)} — ${when(closure.endTime)}`,
      "",
      `We're sorry for the inconvenience. You can book another time once the closure ends.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** RES-6 — the grace period changed; that day's reservers are told. */
export function gracePeriodChangedEmail({ org, user, minutes }) {
  return {
    to: user.email,
    subject: `${org.name} — check-in grace period changed`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `The check-in grace period at ${org.name} is now ${minutes} minutes.`,
      `This applies to your reservation today — please tap in within ${minutes} minutes of your start time.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** ADM-4 — staff onboarding one-time PIN. */
export function staffOnboardingEmail({ org, user, temporaryPin }) {
  return {
    to: user.email,
    subject: `${org.name} — your staff account`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `A ${user.role} account has been created for you at ${org.name}.`,
      "",
      `  Sign in with: ${user.email}`,
      `  Temporary PIN: ${temporaryPin}`,
      "",
      `You'll be asked to set your own 6-digit PIN and accept the terms of use on first sign-in.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}

/** AUTH-4 — PIN reset code. */
export function pinResetEmail({ org, user, code, expiryMinutes }) {
  return {
    to: user.email,
    subject: `${org.name} — reset your PIN`,
    text: [
      `Hi ${user.firstName},`,
      "",
      `Use this code to set a new PIN: ${code}`,
      "",
      `It expires in ${expiryMinutes} minutes. If you didn't request this, ignore this email — your PIN is unchanged.`,
      "",
      `— ${org.name}`,
    ].join("\n"),
  };
}
