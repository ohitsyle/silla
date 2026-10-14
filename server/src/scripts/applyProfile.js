/**
 * Run with: npm run profile <library|office>
 *
 * Switches the demo deployment to a different vertical, IN PLACE.
 *
 * This is the white-label mechanism's proof (spec §2, §8, §16). It
 * rewrites only configuration and seed data — branding, terminology,
 * identity format, policy numbers, the resource catalog, the floors and
 * their layouts, the terms text. It does not touch a single line of
 * engine, API, or component code, because none of them know which
 * vertical they are serving.
 *
 * The organization's _id is preserved deliberately, so the client's
 * VITE_DEMO_ORG_ID keeps working and the SAME URLs render a completely
 * different product. Accounts are preserved too — people don't cease to
 * exist because the buyer's terminology changed.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Room from "../models/Room.js";
import Organization from "../models/Organization.js";
import Site from "../models/Site.js";
import ResourceType from "../models/ResourceType.js";
import { getProfile, PROFILE_KEYS } from "./profiles.js";
import { seedFloorLayouts, printLayoutSummary } from "./seedLayout.js";

/**
 * Mongoose rejects an explicit `undefined` on a nested path, so a naive
 * spread of a profile that omits an optional branding group (a buyer who
 * only set an accent) would fail validation. Drop undefined keys and
 * merge nested groups rather than replacing them wholesale.
 */
function mergeDefined(base = {}, patch = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeDefined(base?.[key], value)
      : value;
  }
  return out;
}

export async function applyProfile(org, profileKey) {
  if (await Room.exists({ organization: org._id })) throw new Error("This organization has configured rooms. A demo profile switch would replace its maps; use organization settings and the editor instead.");
  const profile = getProfile(profileKey);

  // ---- Organization config (spec §16) ----
  org.name = profile.organizationName;
  // Reset branding to schema defaults first, so switching FROM a fully
  // re-skinned deployment TO one that only sets an accent doesn't leave
  // the previous buyer's surface colours behind.
  org.set("branding", undefined);
  org.branding = mergeDefined({ logoUrl: null }, profile.branding);
  org.terminology = profile.terminology;
  org.identity = mergeDefined(org.identity?.toObject?.() ?? org.identity, profile.identity);
  org.policy = mergeDefined(org.policy?.toObject?.() ?? org.policy, profile.policy);
  org.termsOfServiceText = profile.termsText;
  await org.save();

  // ---- Site ----
  const site = await Site.findOne({ organization: org._id }).sort({ createdAt: 1 });
  if (site && site.name !== profile.siteName) {
    site.name = profile.siteName;
    await site.save();
  }

  // ---- Catalog (spec §8 — vendor-configured per install) ----
  // Replaced wholesale: the previous vertical's piece types are
  // meaningless in the new one, and leaving them would let an admin
  // place a "Long Table" in an office.
  await ResourceType.deleteMany({ organization: org._id });
  await ResourceType.insertMany(
    profile.catalog.map((type) => ({ organization: org._id, ...type }))
  );

  // ---- Floors + layout ----
  const { summaries } = await seedFloorLayouts(org, profileKey);

  return { profile, summaries };
}

async function main() {
  const requested = process.argv[2];
  if (!requested || !PROFILE_KEYS.includes(requested)) {
    console.error(`Usage: npm run profile <${PROFILE_KEYS.join("|")}>`);
    console.error("\nSwitches the demo organization to a different vertical, in place,");
    console.error("keeping the same organizationId so VITE_DEMO_ORG_ID stays valid.");
    process.exit(1);
  }

  await connectDB();
  const org = await Organization.findOne().sort({ createdAt: 1 });
  if (!org) throw new Error("No organization found. Run `npm run seed` first.");

  const previousName = org.name;
  const { profile, summaries } = await applyProfile(org, requested);

  console.log(`\nSwitched "${previousName}" -> "${profile.organizationName}" (${profile.label})\n`);
  console.log(`  resource noun : ${profile.terminology.resourceNoun}`);
  console.log(`  member noun   : ${profile.terminology.memberNoun}`);
  console.log(`  facility      : ${profile.terminology.facilityLabel}`);
  console.log(`  member ID     : ${profile.identity.memberIdFormat}`);
  console.log(`  accent        : ${profile.branding.primaryColor}`);
  console.log(`  catalog       : ${profile.catalog.map((t) => t.key).join(", ")}\n`);
  printLayoutSummary(org, profile, summaries);
  console.log("\nSame organizationId, same code, same URLs — reload http://localhost:5173/map\n");

  await mongoose.disconnect();
}

if (process.argv[1] && process.argv[1].endsWith("applyProfile.js")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
