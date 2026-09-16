/**
 * Runs the vendor suites against a running API, then cleans up.
 * Mirrors server/tests/run.mjs so both feel the same to use.
 */
import "dotenv/config";
import { cleanup } from "./cleanup.mjs";
import * as accounts from "./accounts.test.mjs";
import * as orders from "./orders.test.mjs";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const results = [];
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const check = (story, label, passed, detail = "") => {
  results.push({ story, label, passed, detail });
  console.log(`  ${passed ? green("PASS") : red("FAIL")}  [${story}] ${label}${detail ? ` — ${detail}` : ""}`);
};

try {
  const res = await fetch(`${API}/api/vendor/health`);
  if (!res.ok) throw new Error("unhealthy");
} catch {
  console.error(`\nThe vendor API is not answering on ${API}. Start it with: cd vendor && npm run dev\n`);
  process.exit(1);
}

for (const suite of [accounts, orders]) {
  console.log(`\n${suite.name}`);
  try {
    await suite.run(check);
  } catch (err) {
    check(suite.name, "suite threw", false, err.message);
  }
}

console.log(dim("\ncleaning up…"));
await cleanup();

const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;
console.log("\n" + "─".repeat(56));
console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
console.log("─".repeat(56) + "\n");
process.exit(failed ? 1 : 0);
