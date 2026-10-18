/**
 * Moves a database that already has plans onto the agreed pricing.
 *
 *   npm run migrate:pricing            # dry run — prints what would change
 *   npm run migrate:pricing -- --apply
 *
 * Why it exists: plans are seeded from lib/defaultPlans.js only into an
 * EMPTY catalogue, and after that staff own them. A database seeded before
 * the pricing was agreed still holds the old placeholders — "One Room" at
 * ₱2,900, "Whole Building" at ₱8,700, Campus priced with each customer —
 * and would go on selling them beside the new catalogue of extra
 * buildings, hardware and support (which seeds itself on its first read).
 *
 * Only a plan that still holds EXACTLY its old placeholder name and prices
 * is touched, so nothing staff have edited is overwritten. Its name,
 * tagline, highlights and prices move to the defaults. Its LIMITS move too,
 * but only while no live subscription is on it: a plan's limits reach every
 * deployment on it at once, and Campus going from unlimited buildings to
 * three would take buildings away from a customer who has them. Such a plan
 * is reported, for staff to decide with per-client overrides first.
 *
 * Subscriptions keep the price they agreed — a plan's price only ever
 * reaches new orders. Safe to re-run.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { DEFAULT_PLANS } from "../lib/defaultPlans.js";
import { ensureCatalog } from "../services/billing.js";

/** What each default plan held before the pricing was agreed. */
const PLACEHOLDERS = {
  room: { name: "One Room", monthly: 2_900_00, annualMonthly: 2_300_00 },
  building: { name: "Whole Building", monthly: 8_700_00, annualMonthly: 6_900_00 },
  campus: { name: "Campus", monthly: null, annualMonthly: null },
};

const apply = process.argv.includes("--apply");
await connectDB();
const plans = mongoose.connection.db.collection("plans");
const subscriptions = mongoose.connection.db.collection("subscriptions");

console.log(`\n  The agreed pricing${apply ? "" : "  (dry run)"}\n`);

for (const target of DEFAULT_PLANS) {
  const stored = await plans.findOne({ key: target.key });
  const was = PLACEHOLDERS[target.key];
  const label = target.key.padEnd(9);
  if (!stored) {
    console.log(`  ${label} not in this catalogue — the next read seeds it from the defaults`);
    continue;
  }
  const untouched =
    stored.name === was.name && (stored.prices?.monthly ?? null) === was.monthly && (stored.prices?.annualMonthly ?? null) === was.annualMonthly;
  const agreed =
    stored.name === target.name &&
    (stored.prices?.monthly ?? null) === target.prices.monthly &&
    (stored.prices?.annualMonthly ?? null) === target.prices.annualMonthly;
  if (agreed) {
    const sameLimits = JSON.stringify(stored.limits || {}) === JSON.stringify(target.limits);
    console.log(
      `  ${label} "${stored.name}" is already on the agreed prices` +
        (sameLimits ? "" : " — its limits still differ from the defaults; set them in the console once its customers have overrides")
    );
    continue;
  }
  if (!untouched) {
    console.log(`  ${label} "${stored.name}" has been edited since it was seeded — left as staff set it`);
    continue;
  }
  const live = await subscriptions.countDocuments({ plan: target.key, status: { $ne: "cancelled" } });
  const set = { name: target.name, tagline: target.tagline, highlights: target.highlights, prices: target.prices, featured: target.featured };
  const limitsChange = JSON.stringify(stored.limits || {}) !== JSON.stringify(target.limits);
  if (limitsChange && !live) set.limits = target.limits;
  const price = (n) => (n == null ? "priced with you" : `₱${(n / 100).toLocaleString("en-PH")}`);
  console.log(
    `  ${label} "${stored.name}" → "${target.name}", ${price(was.monthly)}/${price(was.annualMonthly)} → ` +
      `${price(target.prices.monthly)}/${price(target.prices.annualMonthly)} a month` +
      (limitsChange ? (live ? `; limits LEFT AS THEY ARE — ${live} live subscription(s) on it` : "; limits too") : "")
  );
  if (apply) await plans.updateOne({ _id: stored._id }, { $set: { ...set, updatedAt: new Date() } });
}

if (apply) {
  const items = await ensureCatalog();
  console.log(`\n  catalogue: ${items.length} item(s)`);
}
console.log(apply ? "\n  applied.\n" : "\n  nothing written — re-run with --apply.\n");
await mongoose.disconnect();
