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
 * does nothing at all — unless a suite calls keepClear() below, which moves
 * that suite's own clock away from midnight when its scenarios need hours
 * of today that the real hour does not have.
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

/**
 * Moves this process's Date and Date.now by `by` milliseconds, on top of
 * whatever clock is already in place.
 */
function shiftClock(by) {
  const RealDate = globalThis.Date;

  // A function rather than a subclass, so that:
  //   - `Date()` called without `new` still returns a string, as it must;
  //   - every date — including one made before this loaded, or by Node
  //     internals holding the original constructor — still passes
  //     `instanceof Date`, because the two share one prototype.
  // Only the zero-argument form is moved: `new Date(ms)` and
  // `new Date("2026-…")` describe a specific moment and must stay exact.
  function MovedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + by).toString();
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + by);
  }
  MovedDate.prototype = RealDate.prototype;
  // Mongoose maps `{ type: Date }` to its date type BY NAME, so a schema
  // compiled after this loads must still see a function called "Date".
  Object.defineProperty(MovedDate, "name", { value: "Date" });
  MovedDate.now = () => RealDate.now() + by;
  MovedDate.parse = RealDate.parse;
  MovedDate.UTC = RealDate.UTC;
  globalThis.Date = MovedDate;
}

if (offset) shiftClock(offset);

/**
 * For a suite whose scenarios need a stretch of TODAY around "now" — a
 * walk-in needs half an hour before closing, a booking "later today" needs
 * a later today — and that therefore cannot run as itself at 23:50, however
 * its windows are written.
 *
 * When less than `ahead` hours remain before midnight, or less than
 * `behind` have passed since it, the clock of THIS process is moved to
 * `hhmm` and the suite says so. At any other time it runs on the clock it
 * was given — the real one, or SILLA_TEST_CLOCK's — so a run at 03:00 is
 * a run at 03:00. Call it before connecting to the database or starting
 * the API, so everything in the process shares one clock from the start.
 *
 * The move is written into the environment like SILLA_TEST_CLOCK's, so a
 * child process that imports this file (`--import`) keeps the same clock.
 *
 * @returns null, or the time the clock was moved to
 */
export function keepClear({ ahead = 6, behind = 2, hhmm = "12:00" } = {}) {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const next = new Date(midnight);
  next.setDate(next.getDate() + 1);
  const hour = 3_600_000;
  if (next - now >= ahead * hour && now - midnight >= behind * hour) return null;

  const [hours, minutes] = hhmm.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  const by = target.getTime() - now.getTime();
  shiftClock(by);
  process.env[OFFSET_KEY] = String(Number(process.env[OFFSET_KEY] || 0) + by);
  return hhmm;
}

/**
 * The suites' walk-ins need half an hour of the day left: the product takes
 * no walk-in, and no booking, shorter than that, and none crosses midnight.
 * In the last 35 minutes of a day the system and spatial suites move to
 * 23:20 — still late at night, where the midnight bugs these clocks exist
 * for live, but with a walk-in's half hour to spare.
 */
export const LATE_EVENING = { ahead: 35 / 60, behind: 0, hhmm: "23:20" };
