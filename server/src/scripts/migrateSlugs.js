/**
 * Run with: npm run migrate:slugs              (dry run — prints, writes nothing)
 *           npm run migrate:slugs -- --apply   (writes)
 *
 * Gives every organization that has no address one derived from its
 * name: "Harborview Library" → harborview-library, so its people reach it
 * at <client>/harborview-library/map (docs/control-plane.md §1).
 *
 * Organizations created before addresses existed have none. They keep
 * working without one — the client serves the default organization at
 * the old unprefixed paths — but every other organization can only be
 * reached by its address, and email links carry it.
 *
 * Safe by construction:
 *   - dry run unless --apply, because an address is something people
 *     bookmark and print on kiosk signage; it should be read before it is
 *     written;
 *   - idempotent: only organizations WITHOUT a slug are touched, and the
 *     write itself is conditional on that still being true, so a second
 *     run (or one racing the control plane) changes nothing;
 *   - an existing slug is never rewritten, even one that is no longer
 *     valid — that breaks links people already have, so it is reported
 *     for a person to decide;
 *   - addresses are unique and never a reserved word (lib/slug.js), using
 *     the same chooser provisioning uses (services/provisioning.js).
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Organization from "../models/Organization.js";
import { slugProblem } from "../lib/slug.js";
import { availableSlug } from "../services/provisioning.js";

const NO_SLUG = { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] };

export async function planSlugs() {
  const missing = await Organization.find(NO_SLUG).sort({ createdAt: 1 }).select("name slug createdAt").lean();
  const taken = new Set(); // addresses promised earlier in THIS run, not yet written
  const plan = [];
  for (const org of missing) {
    const slug = await availableSlug(org.name, { taken });
    taken.add(slug);
    plan.push({ id: String(org._id), name: org.name, slug });
  }

  const invalid = (await Organization.find({ slug: { $type: "string", $ne: "" } }).select("name slug").lean())
    .map((org) => ({ id: String(org._id), name: org.name, slug: org.slug, problem: slugProblem(org.slug) }))
    .filter((row) => row.problem);

  return { plan, invalid };
}

/** Writes one planned address, re-choosing if something took it in the meantime. */
async function applyOne(row) {
  let slug = row.slug;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await Organization.updateOne({ _id: row.id, ...NO_SLUG }, { $set: { slug } });
      return result.modifiedCount ? slug : null; // null: it gained an address since the plan was made
    } catch (err) {
      if (err?.code !== 11000) throw err;
      slug = await availableSlug(row.name);
    }
  }
  throw new Error(`Could not find a free address for "${row.name}" (${row.id}).`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDB();

  const { plan, invalid } = await planSlugs();

  if (!plan.length) {
    console.log("\nEvery organization already has an address. Nothing to do.\n");
  } else {
    console.log(`\n${apply ? "Assigning" : "Would assign"} ${plan.length} address(es):\n`);
    for (const row of plan) {
      const written = apply ? await applyOne(row) : row.slug;
      const note = apply && written === null ? "  (skipped — it already has one)" : "";
      console.log(`  ${row.name.padEnd(36)} /${written ?? row.slug}${note}`);
    }
    if (!apply) console.log("\nDry run — nothing was written. Re-run with --apply to write these.");
  }

  if (invalid.length) {
    console.log("\nThese addresses are not valid any more and were left alone (changing one breaks links people have):");
    for (const row of invalid) console.log(`  ${row.name.padEnd(36)} /${row.slug} — ${row.problem}`);
  }
  console.log();

  await mongoose.disconnect();
}

if (process.argv[1] && process.argv[1].endsWith("migrateSlugs.js")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
