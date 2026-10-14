/**
 * Run with: npm run seed:layout
 *
 * Fills the seeded floors with an actual layout — resources, zones, and
 * labels (spec §12's three map layers). Split out from `npm run seed`
 * on purpose: seed.js is create-only, so re-running it against a live
 * database would mint a SECOND organization with a new id and quietly
 * invalidate the client's VITE_DEMO_ORG_ID.
 *
 * This script is safe to re-run. It detects which vertical profile the
 * organization is running (from its seeded catalog), ensures that
 * profile's floors exist, then replaces those floors' layout documents
 * in place. Nothing outside the layout layers is touched.
 *
 * To switch the organization to a DIFFERENT vertical entirely — new
 * branding, terminology, catalog, and floors — use `npm run profile`.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Organization from "../models/Organization.js";
import Building from "../models/Building.js";
import Room from "../models/Room.js";
import Site from "../models/Site.js";
import Floor from "../models/Floor.js";
import ResourceType from "../models/ResourceType.js";
import Resource from "../models/Resource.js";
import Zone from "../models/Zone.js";
import Label from "../models/Label.js";
import { expandFloor } from "./layoutFixture.js";
import { detectProfile, getProfile } from "./profiles.js";

/**
 * Applies a profile's floor layouts to an org. Exported so seed.js and
 * applyProfile.js can reuse it instead of duplicating placement logic.
 */
export async function seedFloorLayouts(org, profileKey = null) {
  if (await Room.exists({ organization: org._id })) throw new Error("This organization has configured rooms. Edit its maps in the application; replacing the seed layout would invalidate those boundaries.");
  const site = await Site.findOne({ organization: org._id }).sort({ createdAt: 1 });
  if (!site) {
    throw new Error(`No site found for organization "${org.name}". Run \`npm run seed\` first.`);
  }

  const types = await ResourceType.find({ organization: org._id, internal: { $ne: true } });
  if (!types.length) {
    throw new Error(`No resource catalog found for "${org.name}". Run \`npm run seed\` first.`);
  }
  const typesByKey = new Map(types.map((t) => [t.key, t]));

  const profile = profileKey
    ? getProfile(profileKey)
    : detectProfile(types.map((t) => t.key));
  if (!profile) {
    throw new Error(
      `Could not match "${org.name}"'s catalog to a known vertical profile. ` +
        `Catalog keys: ${[...typesByKey.keys()].join(", ")}`
    );
  }

  const summaries = [];

  for (const definition of profile.floors) {
    // Match on `order` — the floor switcher's sort key, and the one
    // field a profile can rely on. Creates the floor when missing so an
    // already-seeded database gains new floors without being wiped.
    let floor = await Floor.findOne({ site: site._id, order: definition.order });
    if (!floor) {
      floor = await Floor.create({
        site: site._id,
        building: (await Building.findOne({ site: site._id }))?._id || null,
        name: definition.name,
        order: definition.order,
        grid: definition.grid,
      });
    } else if (floor.name !== definition.name || floor.grid.cols !== definition.grid.cols || floor.grid.rows !== definition.grid.rows) {
      // Switching verticals changes floor names and grid sizes.
      floor.name = definition.name;
      floor.grid = definition.grid;
      await floor.save();
    }

    const { resources, zones, labels } = expandFloor(definition, {
      organizationId: org._id,
      floor,
      typesByKey,
    });

    // Replace this floor's layout wholesale so the script is re-runnable.
    await Promise.all([
      Resource.deleteMany({ floor: floor._id }),
      Zone.deleteMany({ floor: floor._id }),
      Label.deleteMany({ floor: floor._id }),
    ]);
    await Promise.all([
      Resource.insertMany(resources),
      Zone.insertMany(zones),
      Label.insertMany(labels),
    ]);

    summaries.push({
      id: floor._id.toString(),
      name: floor.name,
      grid: `${floor.grid.cols}x${floor.grid.rows}`,
      resources: resources.length,
      units: resources.reduce((sum, r) => sum + r.units.length, 0),
      zones: zones.length,
      labels: labels.length,
    });
  }

  // Floors beyond what this profile defines would otherwise linger from
  // a previous vertical with more levels.
  const keptOrders = profile.floors.map((f) => f.order);
  const stale = await Floor.find({ site: site._id, order: { $nin: keptOrders } });
  for (const floor of stale) {
    await Promise.all([
      Resource.deleteMany({ floor: floor._id }),
      Zone.deleteMany({ floor: floor._id }),
      Label.deleteMany({ floor: floor._id }),
    ]);
    await Floor.deleteOne({ _id: floor._id });
  }

  return { profile, summaries, removedFloors: stale.length };
}

export function printLayoutSummary(org, profile, summaries) {
  console.log(`Layout seeded for "${org.name}" — ${profile.label} profile`);
  console.log(`  organizationId: ${org._id.toString()}`);
  for (const s of summaries) {
    console.log(
      `  ${s.name.padEnd(14)} ${s.grid.padEnd(7)} floorId: ${s.id}  ` +
        `${s.resources} resources / ${s.units} units, ${s.zones} zones, ${s.labels} labels`
    );
  }
}

async function main() {
  await connectDB();

  // White-label deployments are single-organization (spec §2), so there
  // is exactly one org to find.
  const org = await Organization.findOne().sort({ createdAt: 1 });
  if (!org) throw new Error("No organization found. Run `npm run seed` first.");

  const { profile, summaries } = await seedFloorLayouts(org);
  printLayoutSummary(org, profile, summaries);
  console.log("\nView it at: http://localhost:5173/map");

  await mongoose.disconnect();
}

if (process.argv[1] && process.argv[1].endsWith("seedLayout.js")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
