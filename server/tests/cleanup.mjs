/**
 * Removes everything the suites created.
 *
 * Test accounts all use @test.silla, so this can delete exactly what the
 * tests made without touching the seeded demo accounts. Run automatically
 * after `npm test`, or on its own with `npm run test:clean`.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import Reservation from "../src/models/Reservation.js";
import Closure from "../src/models/Closure.js";
import Organization from "../src/models/Organization.js";
import Site from "../src/models/Site.js";
import Floor from "../src/models/Floor.js";
import Resource from "../src/models/Resource.js";
import Zone from "../src/models/Zone.js";
import Label from "../src/models/Label.js";

export async function cleanup({ quiet = false } = {}) {
  const alreadyConnected = mongoose.connection.readyState === 1;
  if (!alreadyConnected) await connectDB();

  const testers = await User.find({ email: /@test\.silla$/ }).select("_id");
  const ids = testers.map((t) => t._id);

  // The cross-organization isolation checks build a throwaway org, site
  // and floor (helpers.foreignFloor). They carry the same @test.silla
  // marker, so they are swept here rather than left behind to make the
  // database look multi-tenant when it is not. Anything under them goes
  // too — if an isolation check ever regresses, the write it should have
  // refused would land on the probe floor.
  const probeOrgs = await Organization.find({ name: /@test\.silla$/ }).select("_id");
  const probeOrgIds = probeOrgs.map((o) => o._id);
  const probeSites = await Site.find({ organization: { $in: probeOrgIds } }).select("_id");
  const probeFloorIds = (await Floor.find({ site: { $in: probeSites.map((s) => s._id) } }).select("_id")).map((f) => f._id);

  if (probeFloorIds.length) {
    await Resource.deleteMany({ floor: { $in: probeFloorIds } });
    await Zone.deleteMany({ floor: { $in: probeFloorIds } });
    await Label.deleteMany({ floor: { $in: probeFloorIds } });
    await Floor.deleteMany({ _id: { $in: probeFloorIds } });
  }
  await Site.deleteMany({ organization: { $in: probeOrgIds } });
  await Organization.deleteMany({ _id: { $in: probeOrgIds } });

  const reservations = await Reservation.deleteMany({ member: { $in: ids } });
  const users = await User.deleteMany({ _id: { $in: ids } });
  const closures = await Closure.deleteMany({ reason: "Scheduled maintenance" });

  // Restore the seeded staff account's one-time terms gate so the demo
  // still shows it, and clear any lockout the AUTH-2 test caused.
  await User.updateOne(
    { email: "staff@demo.test" },
    { termsAcceptedAt: null, mustChangePin: false, failedPinAttempts: 0, lockedUntil: null }
  );
  await User.updateOne(
    { email: "admin@demo.test" },
    { mustChangePin: false, failedPinAttempts: 0, lockedUntil: null }
  );

  if (!quiet) {
    console.log(
      `  cleaned ${users.deletedCount} test account(s), ` +
        `${reservations.deletedCount} reservation(s), ${closures.deletedCount} closure(s)` +
        (probeOrgIds.length ? `, ${probeOrgIds.length} probe org(s)` : "")
    );
  }
  if (!alreadyConnected) await mongoose.disconnect();
}

if (process.argv[1]?.endsWith("cleanup.mjs")) {
  cleanup().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
