/**
 * A movable wall clock, for proving the suites pass at any time of day.
 *
 *   SILLA_TEST_CLOCK=23:50 NODE_OPTIONS=--import=./tests/clock.mjs npm run test:spaces
 *   SILLA_TEST_CLOCK=23:50 NODE_OPTIONS=--import=./tests/clock.mjs npm run test:isolated
 *
 * The suites book windows relative to "now", and the product refuses a
 * reservation that crosses midnight — correctly. They used to fail after
 * about 23:00 for exactly that reason, which nobody could see without
 * staying up to run them. This turns "late at night" into a flag.
 *
 * It moves Date and Date.now by a fixed offset, chosen so the LOCAL time
 * reads SILLA_TEST_CLOCK the moment the first process loads it. Time still
 * flows; it is the same clock, moved. A TZ trick cannot do this: Node only
 * honours IANA zone names, so the offsets on offer are whole and half hours
 * and "exactly 23:50" is usually unreachable.
 *
 * The offset is written back into the environment, so every child process
 * (isolated.mjs runs the seeder and the suites as children, and npm itself
 * is the first process) inherits the SAME clock instead of computing its
 * own a few seconds later. The database keeps its real clock, which is
 * fine: nothing asks it the time — every timestamp is written by the API.
 *
 * Test-only. Nothing under src/ imports it, and without SILLA_TEST_CLOCK it
 * does nothing at all.
 */
const OFFSET_KEY = "SILLA_TEST_CLOCK_OFFSET_MS";

const wanted = process.env.SILLA_TEST_CLOCK;
if (wanted && process.env[OFFSET_KEY] === undefined) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(wanted);
  if (!match) throw new Error(`SILLA_TEST_CLOCK must look like 23:50, not "${wanted}"`);
  const target = new Date();
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  process.env[OFFSET_KEY] = String(target.getTime() - Date.now());
}

const offset = Number(process.env[OFFSET_KEY] || 0);

if (offset) {
  const RealDate = Date;

  // A function rather than a subclass, so that:
  //   - `Date()` called without `new` still returns a string, as it must;
  //   - every date — including one made before this loaded, or by Node
  //     internals holding the original constructor — still passes
  //     `instanceof Date`, because the two share one prototype.
  // Only the zero-argument form is moved: `new Date(ms)` and
  // `new Date("2026-…")` describe a specific moment and must stay exact.
  function MovedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset);
  }
  MovedDate.prototype = RealDate.prototype;
  // Mongoose maps `{ type: Date }` to its date type BY NAME, so a schema
  // compiled after this loads must still see a function called "Date".
  Object.defineProperty(MovedDate, "name", { value: "Date" });
  MovedDate.now = () => RealDate.now() + offset;
  MovedDate.parse = RealDate.parse;
  MovedDate.UTC = RealDate.UTC;
  globalThis.Date = MovedDate;
}
