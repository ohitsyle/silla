/**
 * Test runner. No framework dependency — the suites are plain async
 * functions and this collects their results.
 *
 *   npm test              run everything
 *   npm test identity     run suites whose name matches
 *
 * Requires the API to be running (npm run dev) and the demo data seeded
 * (npm run seed, then npm run seed:layout).
 */
import { req, API } from "./helpers.mjs";
import { cleanup } from "./cleanup.mjs";

const suites = [
  await import("./identity.test.mjs"),
  await import("./reservations.test.mjs"),
  await import("./permissions.test.mjs"),
  await import("./admin.test.mjs"),
  // The control plane, provisioning, plans and tenancy. Last, so the
  // plans it pushes can never be mistaken for the demo organization's.
  await import("./platform.test.mjs"),
];

const filter = process.argv[2]?.toLowerCase();

const results = [];
let currentSuite = "";

/**
 * Record one check.
 *
 * `ok` may be true, false, or the string "skip". Skip is its own state
 * rather than a pass: once a real mail provider is configured the
 * verification code exists only in the recipient's inbox — it is bcrypt
 * hashed in the database, so no test can read it back — and the handful
 * of checks that need the literal code cannot run. Counting those as
 * passes would report full green for assertions that never executed,
 * which is the one thing a test summary must never do.
 */
export function check(story, name, ok, detail = "") {
  const skipped = ok === "skip";
  results.push({ suite: currentSuite, story, name, ok: ok === true, skipped, detail });
  const mark = skipped
    ? "\x1b[33mSKIP\x1b[0m"
    : ok
      ? "\x1b[32mPASS\x1b[0m"
      : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  [${story}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// Fail fast with a useful message rather than a wall of ECONNREFUSED.
const health = await req("/api/health").catch(() => null);
if (!health || health.status !== 200) {
  console.error(`\nCannot reach the API at ${API}.\n  Start it with:  npm run dev\n`);
  process.exit(1);
}

for (const suite of suites) {
  if (filter && !suite.name.toLowerCase().includes(filter)) continue;
  currentSuite = suite.name;
  console.log(`\n\x1b[1m═══ ${suite.name} ═══\x1b[0m`);
  try {
    await suite.run(check);
  } catch (err) {
    check(suite.name, "suite threw", false, err.message);
  }
}

// Tests create accounts and reservations; remove them so the next run
// starts clean and the demo data is left as seeded.
console.log("\n\x1b[2mcleaning up…\x1b[0m");
await cleanup().catch((e) => console.log(`  cleanup skipped: ${e.message}`));

const skipped = results.filter((r) => r.skipped).length;
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed - skipped;
console.log(`\n${"─".repeat(56)}`);
console.log(
  `  ${passed} passed, ${failed} failed` +
    (skipped ? `, ${skipped} skipped` : "") +
    `, ${results.length} total`
);
console.log(`${"─".repeat(56)}\n`);
if (skipped) {
  console.log("Skipped (not run, not proven):");
  for (const r of results.filter((x) => x.skipped)) {
    console.log(`  [${r.story}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log();
}
if (failed) {
  console.log("Failures:");
  for (const r of results.filter((x) => !x.ok && !x.skipped)) {
    console.log(`  [${r.story}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log();
}
process.exit(failed ? 1 : 0);
