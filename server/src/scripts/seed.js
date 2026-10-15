/**
 * Run with: npm run seed                        (defaults to the library profile)
 *           npm run seed -- office              (or any other built-in vertical)
 *           npm run seed:file <profile.json>    (a portal-authored profile)
 *
 *   --slug <address>   the organization's address (<client>/<address>/map);
 *                      derived from its name when omitted
 *
 * Creates one Organization from a vertical profile — with a Site, its
 * Floors, the vendor catalog, a placed layout, and its first accounts —
 * enough to hit every implemented endpoint against real data.
 *
 * Nothing in this file is library- or office-specific, and nothing in it
 * creates anything either: it works out WHICH profile to use and hands it
 * to services/provisioning.js, the same function SILLA's control plane
 * calls when staff provision a buyer's order (POST /api/internal/
 * organizations). One creation path, so a profile that seeds here
 * provisions identically over the API, and the two can never drift.
 *
 * NOTE: this script is create-only. Running it a second time against a
 * populated database mints a SECOND organization with a new id (and the
 * next free address, e.g. demo-library-2), which invalidates the client's
 * VITE_DEMO_ORG_ID. To refresh map data on an already-seeded database run
 * `npm run seed:layout`; to switch it to a different vertical in place,
 * run `npm run profile <name>`.
 */
import "dotenv/config";
import path from "node:path";
import { connectDB } from "../config/db.js";
import { flushEmails } from "../services/email/index.js";
import { DEMO_ACCOUNTS, ProvisioningError, provisionFromProfile } from "../services/provisioning.js";
import { getProfile, PROFILE_KEYS } from "./profiles.js";
import { loadProfile } from "./importProfile.js";
import { printLayoutSummary } from "./seedLayout.js";

/**
 * `--slug x` or `--slug=x`, removed from the argument list so positionals
 * stay positional. Absent is `undefined`; present with no value is "" —
 * `npm run seed:file` with no path must be a usage error, not quietly the
 * library demo.
 */
function takeFlag(args, name) {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return undefined;
  const arg = args[index];
  if (arg.includes("=")) {
    args.splice(index, 1);
    return arg.slice(arg.indexOf("=") + 1);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value ?? "";
}

/**
 * Works out which profile to seed from, whichever way the script was
 * invoked. Both routes end at the same thing — a profile object for
 * provisionFromProfile() — so only the SOURCE differs, never the
 * creation logic after it.
 */
function resolveProfile() {
  const args = process.argv.slice(2);
  const slug = takeFlag(args, "slug");
  const filePath = takeFlag(args, "file");

  if (filePath === undefined) {
    const requested = args[0] || "library";
    if (!PROFILE_KEYS.includes(requested)) {
      console.error(`Unknown profile "${requested}". Available: ${PROFILE_KEYS.join(", ")}`);
      console.error("Seeding a portal-authored profile instead? Use: npm run seed:file <path>");
      process.exit(1);
    }
    return { profile: getProfile(requested), builtIn: true, file: null, slug };
  }

  if (!filePath) {
    console.error("Usage: npm run seed:file <path/to/profile.json> [--slug <address>]");
    process.exit(1);
  }

  // A profile that fails validation is a user error, not a crash: print
  // the report importProfile.js built and stop, rather than a stack.
  // (provisionFromProfile validates again — harmless, and it means the
  // API path can never skip the check this path performs.)
  try {
    return { profile: loadProfile(filePath), builtIn: false, file: path.resolve(filePath), slug };
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
}

async function seed() {
  const { profile, builtIn, file, slug } = resolveProfile();

  await connectDB();

  let result;
  try {
    result = await provisionFromProfile(profile, { slug, builtIn });
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    // Bad address or a taken one: say which, and what would work instead.
    console.error(`\n${err.message}`);
    for (const { field, message } of err.details.fields || []) console.error(`  - ${field}: ${message}`);
    if (err.details.suggestion) console.error(`  Try: --slug ${err.details.suggestion}`);
    console.error("\nNothing was written.\n");
    process.exit(1);
  }

  const { organization: org, owner, summaries } = result;

  console.log(`\nSeed complete — ${result.profile.label} profile.\n`);
  printLayoutSummary(org, result.profile, summaries);
  console.log(`  address:        /${result.slug}${result.deploymentUrl ? `  (${result.deploymentUrl})` : ""}`);

  if (owner) {
    // The operator's copy. sendEmail is fire-and-forget, so if delivery
    // fails there is no other record of this PIN anywhere — it is
    // bcrypt hashed the moment it is stored. Printing it is what stops
    // a silent mail failure becoming a deployment nobody can enter.
    console.log(`\n  FOUNDING SUPERADMIN — hand these over, then delete your copy:`);
    console.log(`    sign in as: ${owner.email}`);
    console.log(`    temporary PIN: ${owner.temporaryPin}`);
    console.log(`    sign in at: ${result.deploymentUrl || `<client>/${result.slug}/login (APP_URL is not set, so the email has no link)`}`);
    console.log(`    (they must change it and accept the terms on first sign-in)`);
    console.log(`\n  A welcome email with these details was queued to ${owner.email}.`);
    console.log(`  Sending is fire-and-forget — confirm it arrived, or relay the PIN yourself.`);
    console.log(`\n  No demo accounts were created. This deployment has exactly one user.`);
  } else {
    const { superadmin, staff, member } = DEMO_ACCOUNTS;
    console.log(`\n  DEMO ACCOUNTS — this profile named no owner, so the demo trio was planted.`);
    console.log(`  These credentials are public (they are in the README). Never ship them to a customer.`);
    console.log(`\n  superadmin: ${superadmin.email} / PIN ${superadmin.pin} (terms already accepted)`);
    console.log(`  staff:      ${staff.email} / PIN ${staff.pin} (first login → terms gate, AUTH-3)`);
    console.log(`  member:     ${member.email} / PIN ${member.pin}, card ${member.card} (tap at /${result.slug}/kiosk)`);
  }
  console.log(`\n  Set VITE_DEMO_ORG_ID=${org._id.toString()} in client/.env`);
  if (file) {
    console.log(`  Provisioned from ${file}`);
    // seed:layout re-detects a vertical from the built-in catalogs, so
    // it cannot recognise a buyer's own one. Saying so beats letting
    // someone discover it by having their map replaced.
    console.log("  Edit this deployment's map in /editor — `npm run seed:layout` only knows the built-in verticals.\n");
  } else {
    console.log(`  Switch vertical later with: npm run profile <${PROFILE_KEYS.join("|")}>\n`);
  }

  // The founder email is queued, not sent; exiting straight away would
  // kill it mid-flight, which is how a CLI-provisioned founder used to
  // receive nothing at all while the operator was told it was on its way.
  await flushEmails(20_000);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
