/**
 * Run with: npm run seed                        (defaults to the library profile)
 *           npm run seed -- office              (or any other built-in vertical)
 *           npm run seed:file <profile.json>    (a portal-authored profile)
 *
 * Creates one demo Organization from a vertical profile — with a Site,
 * its Floors, the vendor catalog, a placed layout, and staff logins —
 * enough to hit every implemented endpoint against real data.
 *
 * Nothing in this file is library- or office-specific. The vertical is
 * entirely data, in profiles.js (spec §8: "Same mechanism, different
 * seed data") — or, for a buyer who configured their system in the SILLA
 * portal, in the profile file that portal exports. Both are the same
 * shape and both run the identical creation code below; the file is
 * validated first by importProfile.js, because a buyer-authored file is
 * untrusted input and a cast error mid-seed is a terrible error message.
 *
 * NOTE: this script is create-only. Running it a second time against a
 * populated database mints a SECOND organization with a new id, which
 * invalidates the client's VITE_DEMO_ORG_ID. To refresh map data on an
 * already-seeded database run `npm run seed:layout`; to switch it to a
 * different vertical in place, run `npm run profile <name>`.
 */
import "dotenv/config";
import path from "node:path";
import bcrypt from "bcryptjs";
import { connectDB } from "../config/db.js";
import Organization from "../models/Organization.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import ResourceType from "../models/ResourceType.js";
import User from "../models/User.js";
import { memberIdExample } from "../lib/identity.js";
import { normalizeCardUid } from "../services/checkin/rfid.js";
import { getProfile, PROFILE_KEYS } from "./profiles.js";
import { loadProfile, registerProfile } from "./importProfile.js";
import { seedFloorLayouts, printLayoutSummary } from "./seedLayout.js";

const SUPERADMIN_EMAIL = "admin@demo.test";
const SUPERADMIN_PIN = "123456";

// A second account that has NOT accepted terms, so AUTH-3's first-login
// gate is demonstrable — the superadmin is seeded already-accepted and
// would walk straight past it.
const STAFF_EMAIL = "staff@demo.test";
const STAFF_PIN = "654321";

// A card-bound member, so the kiosk is demonstrable without first
// walking through registration. The UID must be hex — the normaliser
// rejects anything else, which is why this is not "DEMO0001".
const MEMBER_EMAIL = "member@demo.test";
const MEMBER_PIN = "111111";
const MEMBER_CARD = "DEADBEEF";

/**
 * Works out which profile to seed from, whichever way the script was
 * invoked. Both routes end at the same thing — a profile object and a
 * key seedFloorLayouts() can resolve — so only the SOURCE differs
 * below, never the creation logic after it.
 */
function resolveProfile() {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === "--file" || arg.startsWith("--file="));

  if (flagIndex === -1) {
    const requested = args[0] || "library";
    if (!PROFILE_KEYS.includes(requested)) {
      console.error(`Unknown profile "${requested}". Available: ${PROFILE_KEYS.join(", ")}`);
      console.error("Seeding a portal-authored profile instead? Use: npm run seed:file <path>");
      process.exit(1);
    }
    return { profile: getProfile(requested), key: requested, file: null };
  }

  const flag = args[flagIndex];
  const filePath = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args[flagIndex + 1];
  if (!filePath) {
    console.error("Usage: npm run seed:file <path/to/profile.json>");
    process.exit(1);
  }

  // A profile that fails validation is a user error, not a crash: print
  // the report importProfile.js built and stop, rather than a stack.
  let profile;
  try {
    profile = loadProfile(filePath);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  // A file profile has no entry in profiles.js, and seedFloorLayouts()
  // resolves the layout it applies BY KEY. Registering it is what keeps
  // both paths on one creation routine rather than a second copy of the
  // placement logic living here.
  registerProfile(profile);
  return { profile, key: profile.key, file: path.resolve(filePath) };
}

async function seed() {
  const { profile, key, file } = resolveProfile();

  await connectDB();

  const org = await Organization.create({
    name: profile.organizationName,
    branding: profile.branding,
    terminology: profile.terminology,
    identity: profile.identity,
    policy: profile.policy,
    termsOfServiceText: profile.termsText, // AUTH-3 (spec §16 — content config)
  });

  const site = await Site.create({ organization: org._id, name: profile.siteName });

  // The vendor-configured catalog for this vertical (CAT-1, spec §8).
  await ResourceType.insertMany(profile.catalog.map((type) => ({ organization: org._id, ...type })));

  // Floors, so the map's floor switcher (MAP-1) has something to switch
  // between.
  await Floor.insertMany(
    profile.floors.map((f) => ({ site: site._id, name: f.name, order: f.order, grid: f.grid }))
  );

  await User.create({
    organization: org._id,
    role: "superadmin",
    firstName: "Demo",
    lastName: "Admin",
    email: SUPERADMIN_EMAIL,
    pinHash: await bcrypt.hash(SUPERADMIN_PIN, 10),
    verified: true,
    termsAcceptedAt: new Date(),
  });

  // Staff are email-provisioned with no card and no kiosk tap (spec §6),
  // and land on the terms gate at first login (AUTH-3).
  await User.create({
    organization: org._id,
    role: "staff",
    firstName: "Demo",
    lastName: "Staff",
    email: STAFF_EMAIL,
    pinHash: await bcrypt.hash(STAFF_PIN, 10),
    verified: true,
    termsAcceptedAt: null,
  });

  // Member IDs are org-configurable (spec §4), so derive one from THIS
  // profile's pattern rather than hardcoding a library-shaped id — a
  // literal "2024-000001" would fail the office profile's EMP-#####.
  await User.create({
    organization: org._id,
    role: "member",
    firstName: "Demo",
    lastName: "Member",
    email: MEMBER_EMAIL,
    memberId: memberIdExample(profile.identity.memberIdFormat),
    cardUid: normalizeCardUid(MEMBER_CARD),
    pinHash: await bcrypt.hash(MEMBER_PIN, 10),
    verified: true,
    termsAcceptedAt: new Date(),
  });

  const { summaries } = await seedFloorLayouts(org, key);

  console.log(`\nSeed complete — ${profile.label} profile.\n`);
  printLayoutSummary(org, profile, summaries);
  console.log(`\n  superadmin: ${SUPERADMIN_EMAIL} / PIN ${SUPERADMIN_PIN} (terms already accepted)`);
  console.log(`  staff:      ${STAFF_EMAIL} / PIN ${STAFF_PIN} (first login → terms gate, AUTH-3)`);
  console.log(`  member:     ${MEMBER_EMAIL} / PIN ${MEMBER_PIN}, card ${MEMBER_CARD} (tap at /kiosk)`);
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
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
