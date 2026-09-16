/**
 * Renders every product email to HTML files so they can be looked at in a
 * browser before any member receives one.
 *
 *   npm run email:preview              -> ./email-preview/*.html
 *   npm run email:preview -- <dir>
 *
 * Each email is rendered under BOTH vertical profiles, because they are
 * branded from the organization: if one looks right and the other does
 * not, a colour or a noun has been hardcoded. Sample data only — nothing
 * is sent and nothing touches the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as t from "../services/email/templates.js";
import { VERTICAL_PROFILES } from "./profiles.js";

const out = path.resolve(process.argv[2] || "email-preview");
mkdirSync(out, { recursive: true });

const at = (h, m = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
};

const user = { firstName: "Ana", lastName: "Reyes", email: "ana.reyes@example.org", role: "staff" };
const reservation = { startTime: at(14), endTime: at(17, 30) };
const closure = { reason: "Floor resurfacing on the second level", startTime: at(7, 0, 1), endTime: at(21, 0, 1) };

let count = 0;
for (const [key, profile] of Object.entries(VERTICAL_PROFILES)) {
  const org = {
    name: profile.organizationName,
    branding: profile.branding,
    terminology: profile.terminology,
    policy: profile.policy,
  };
  const label = key === "library" ? "A-12" : "D-204";

  const samples = {
    "01-verification": t.verificationCodeEmail({ org, user, code: "482913", expiryMinutes: 10 }),
    "02-reservation-confirmed": t.reservationConfirmedEmail({ org, user, reservation, resourceLabel: label }),
    "03-starting-soon": t.startingSoonEmail({ org, user, reservation, resourceLabel: label }),
    "04-max-stay-released": t.maxStayReleasedEmail({ org, user, reservation, resourceLabel: label }),
    "05-no-show-released": t.noShowReleasedEmail({ org, user, reservation, resourceLabel: label }),
    "06-closure-cancelled": t.closureCancelledEmail({ org, user, reservation, resourceLabel: label, closure }),
    "07-grace-changed": t.gracePeriodChangedEmail({ org, user, minutes: 15 }),
    "08-staff-onboarding": t.staffOnboardingEmail({ org, user, temporaryPin: "305718" }),
    "09-pin-reset": t.pinResetEmail({ org, user, code: "661204", expiryMinutes: 10 }),
    "10-founder-welcome": t.founderWelcomeEmail({
      org,
      user: { ...user, role: "superadmin" },
      temporaryPin: "918273",
      deploymentUrl: "https://reserve.example.org",
    }),
  };

  for (const [name, mail] of Object.entries(samples)) {
    writeFileSync(path.join(out, `${key}-${name}.html`), mail.html);
    writeFileSync(path.join(out, `${key}-${name}.txt`), `From: ${mail.fromName}\nSubject: ${mail.subject}\nTo: ${mail.to}\n\n${mail.text}`);
    count += 1;
  }
}
console.log(`  wrote ${count} emails to ${out}`);
