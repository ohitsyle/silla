/**
 * Renders every storefront email to HTML files so they can be looked at
 * in a browser before anyone receives one.
 *
 *   npm run email:preview            -> ./email-preview/*.html
 *
 * Sample data only. Nothing is sent and nothing touches the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as t from "../services/email/templates.js";

const out = path.resolve(process.argv[2] || "email-preview");
mkdirSync(out, { recursive: true });

const account = { firstName: "Ana", lastName: "Reyes", name: "Ana Reyes", email: "ana@harborview.org" };
const order = {
  _id: "66f0c0ffee0000000000abcd",
  organizationName: "Harborview Reading Room",
  plan: "building",
  billingPeriod: "yearly",
  quotedAmount: 11900,
  currency: "USD",
  deploymentUrl: "https://harborview.silla.example",
};

const samples = {
  "01-verification": t.verificationEmail({ account, code: "482913", expiryMinutes: 10 }),
  "02-welcome": t.welcomeEmail({ account }),
  "03-email-change-code": t.emailChangeCodeEmail({ account, newEmail: "ana.reyes@harborview.org", code: "730144", expiryMinutes: 10 }),
  "04-email-changed-notice": t.emailChangedNoticeEmail({ account, oldEmail: "ana@harborview.org", newEmail: "ana.reyes@harborview.org" }),
  "05-password-changed": t.passwordChangedEmail({ account }),
  "06-password-reset": t.passwordResetEmail({ account, code: "209385", expiryMinutes: 10 }),
  "07-order-submitted": t.orderSubmittedEmail({ account, order }),
  "08-order-internal": t.orderSubmittedInternalEmail({ account, order, to: "orders@silla.example" }),
  "09-order-provisioning": t.orderProvisioningEmail({ account, order }),
  "10-order-live": t.orderLiveEmail({ account, order }),
  "11-order-cancelled": t.orderCancelledEmail({ account, order, reason: "Duplicate of an earlier order" }),
};

for (const [name, mail] of Object.entries(samples)) {
  writeFileSync(path.join(out, `${name}.html`), mail.html);
  writeFileSync(path.join(out, `${name}.txt`), `Subject: ${mail.subject}\nTo: ${mail.to}\n\n${mail.text}`);
}
console.log(`  wrote ${Object.keys(samples).length} emails to ${out}`);
