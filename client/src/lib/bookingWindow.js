import { useCallback, useEffect, useMemo, useState } from "react";
import { clock, clockRange } from "./dayView.js";

/**
 * The time a member is booking for — one window shared by every panel on
 * the map.
 *
 * It used to live inside ReservePanel and reset itself whenever a
 * different unit was picked. That was harmless while the panel was the
 * only place a time was chosen, but the room panel now asks "what is free
 * at this time?" BEFORE anything is picked: a member who set Thursday
 * 14:00 there, then chose a desk, would find the form quietly back on
 * "now". One window, owned by the page, means the question and the answer
 * are always about the same time.
 */

const HOUR = 3_600_000;

/** Shortest booking the length picker offers, in minutes. */
const MIN_SLOT_MINUTES = 30;

/** "08:30" -> minutes after midnight. */
const minutesOf = (hhmm) => {
  const [hours, minutes] = String(hhmm).split(":").map(Number);
  return hours * 60 + (minutes || 0);
};

/** Rounds up to the next quarter hour — nobody books at 14:07. */
function nextQuarterHour(from = new Date()) {
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15);
  return date;
}

/**
 * The first bookable moment given the organization's operating hours
 * (spec §10). Defaulting the form to "now" is wrong outside opening
 * times: the server refuses it, and the member only finds out after
 * typing their PIN. Roll forward to the next opening instead.
 */
export function firstBookableSlot(operatingHours, now = new Date()) {
  const start = nextQuarterHour(now);
  if (!operatingHours?.open || !operatingHours?.close) return start;

  const open = minutesOf(operatingHours.open);
  const close = minutesOf(operatingHours.close);
  const minutes = start.getHours() * 60 + start.getMinutes();
  const atOpening = (date) => {
    date.setHours(Math.floor(open / 60), open % 60, 0, 0);
    return date;
  };

  if (minutes < open) return atOpening(new Date(start));
  // Past closing, or so close to it that the shortest slot would not fit:
  // today is done, so offer tomorrow rather than a form that cannot work.
  if (minutes >= close || close - minutes < MIN_SLOT_MINUTES) {
    const tomorrow = new Date(start);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return atOpening(tomorrow);
  }
  return start;
}

/** A Date as the value a datetime-local input takes, in local time. */
export function toLocalInput(date) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 16);
}

/** "Today", "Tomorrow", "Thu, Oct 22" — which day, said the short way. */
export function dayWord(value, now = new Date()) {
  const day = new Date(value);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day.toDateString() === now.toDateString()) return "Today";
  if (day.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** "3:00 PM today", "3:00 PM on Thu, Oct 22" — the short form every panel uses for a time. */
export function formatWhen(value) {
  const word = dayWord(value);
  return word === "Today" || word === "Tomorrow" ? `${clock(value)} ${word.toLowerCase()}` : `${clock(value)} on ${word}`;
}

/** "Today, 3:00 – 5:00 PM", or across days "3:00 PM today – 9:00 AM tomorrow". */
export function formatSpan(start, end) {
  const from = new Date(start);
  const to = new Date(end);
  if (from.toDateString() !== to.toDateString()) return `${formatWhen(from)} – ${formatWhen(to)}`;
  return `${dayWord(from)}, ${clockRange(from, to)}`;
}

/** "1 hour", "1.5 hours". */
export const formatHours = (hours) => `${hours} hour${hours === 1 ? "" : "s"}`;

/** "30 min", "1 hour", "1½ hours" — a length, the way a wall screen says it. */
export function formatLength(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const half = minutes % 60 >= 30;
  return `${hours}${half ? "½" : ""} hour${hours === 1 && !half ? "" : "s"}`;
}

const sameDate = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** Whether a booking of the shortest length can start now: open, and not about to close. */
function openNow(operatingHours, now = new Date()) {
  if (!operatingHours?.open || !operatingHours?.close) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= minutesOf(operatingHours.open) && minutesOf(operatingHours.close) - minutes >= MIN_SLOT_MINUTES;
}

/**
 * The half-hour starts a booking could take on `date`: from opening, or
 * from the next half hour today, up to the last one that still leaves the
 * shortest booking before closing.
 */
export function startsOn(date, operatingHours, now = new Date()) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const open = operatingHours?.open ? minutesOf(operatingHours.open) : 0;
  const close = operatingHours?.close ? minutesOf(operatingHours.close) : 24 * 60 - 1;
  const starts = [];
  for (let minutes = open; minutes + MIN_SLOT_MINUTES <= close; minutes += 30) {
    const at = new Date(day);
    at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (at > now) starts.push(at);
  }
  return starts;
}

/**
 * @param {object} policy  the organization's policy (maxStayHours, operatingHours)
 * @returns the window, its limits, and why it cannot be booked if it cannot
 */
export function useBookingWindow(policy) {
  const maxStayHours = policy?.maxStayHours ?? 4;
  const hours = policy?.operatingHours;

  const [start, setStartValue] = useState(() => toLocalInput(firstBookableSlot(hours)));
  const [duration, setDuration] = useState(() => Math.min(2, maxStayHours));
  /**
   * Whether the start follows the clock ("now"). It does until someone
   * chooses a time; while it does, it moves on by itself, so a map left
   * open for an hour is still asking about now and not about an hour ago.
   */
  const [following, setFollowing] = useState(true);
  const [tick, setTick] = useState(0);

  // The organization's config usually arrives after the first render, so
  // the default start is recomputed once its opening hours are known —
  // and, while following, every half minute after that.
  useEffect(() => {
    if (!following) return undefined;
    const follow = () => {
      setStartValue(toLocalInput(firstBookableSlot(hours)));
      setTick((n) => n + 1);
    };
    follow();
    const timer = setInterval(follow, 30_000);
    return () => clearInterval(timer);
  }, [following, hours?.open, hours?.close]);

  /** A start typed or picked by the member: it stops following the clock. */
  const setStart = useCallback((value) => {
    setFollowing(false);
    setStartValue(value);
  }, []);

  /**
   * How long can be booked from the chosen start: the maximum stay, but
   * never past closing. Someone starting at 17:30 in a building that
   * shuts at 19:00 must not be offered four hours and then refused.
   */
  const maxDuration = useMemo(() => {
    const startsAt = new Date(start);
    if (Number.isNaN(startsAt.getTime()) || !hours?.close) return maxStayHours;
    const closesAt = new Date(startsAt);
    const close = minutesOf(hours.close);
    closesAt.setHours(Math.floor(close / 60), close % 60, 0, 0);
    const untilClose = (closesAt - startsAt) / HOUR;
    // Down to the nearest half hour, which is the picker's step.
    return Math.max(0, Math.min(maxStayHours, Math.floor(untilClose * 2) / 2));
  }, [start, hours?.close, maxStayHours]);

  // Keep the chosen length inside what can be booked.
  useEffect(() => {
    setDuration((current) => (maxDuration > 0 ? Math.min(current, maxDuration) : current));
  }, [maxDuration]);

  const startTime = useMemo(() => new Date(start), [start]);
  const endTime = useMemo(() => new Date(startTime.getTime() + duration * HOUR), [startTime, duration]);

  /** Why this window cannot be booked anywhere, or null. Two causes, two different fixes. */
  const problem = useMemo(() => {
    if (Number.isNaN(startTime.getTime())) return "Choose when you'd like to start.";
    if (maxDuration > 0) return null;
    const minutes = startTime.getHours() * 60 + startTime.getMinutes();
    const inside = !hours?.open || !hours?.close || (minutes >= minutesOf(hours.open) && minutes < minutesOf(hours.close));
    return inside
      ? `There isn't enough time before closing at ${hours.close}. Pick an earlier start, or another day.`
      : `That's outside opening hours (${hours.open}–${hours.close}). Pick a time in between.`;
  }, [startTime, maxDuration, hours?.open, hours?.close]);

  /** Every length the picker offers, half an hour apart. */
  const lengths = useMemo(
    () => Array.from({ length: Math.max(1, Math.round(maxDuration * 2)) }, (_, i) => (i + 1) / 2),
    [maxDuration]
  );

  /**
   * Both ends as ISO strings for the API, or null while the window is
   * invalid. Memoised: panels fetch whenever it changes identity.
   */
  const iso = useMemo(
    () => (problem ? null : { startTime: startTime.toISOString(), endTime: endTime.toISOString() }),
    [problem, startTime, endTime]
  );

  /**
   * Where the window sits, for the map's When picker:
   *
   *   now    it follows the clock, and a booking could start now
   *   later  a time later today
   *   day    another day
   *
   * While closed, "now" is not on offer: the window waits at the next
   * opening, which is "later" (this morning) or "day" (tomorrow).
   */
  const nowOpen = useMemo(() => openNow(hours), [hours?.open, hours?.close, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const mode = useMemo(() => {
    if (Number.isNaN(startTime.getTime())) return "now";
    if (!sameDate(startTime, new Date())) return "day";
    return following && nowOpen ? "now" : "later";
  }, [startTime, following, nowOpen, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The starts on offer for the window's own date, for a time picker. */
  const starts = useMemo(
    () => (Number.isNaN(startTime.getTime()) ? [] : startsOn(startTime, hours)),
    [startTime, hours?.open, hours?.close, tick] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const laterToday = useMemo(() => startsOn(new Date(), hours), [hours?.open, hours?.close, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Moves the window to now, to later today, or to another day — keeping its length. */
  const setMode = useCallback((next) => {
    if (next === "now") {
      setFollowing(true);
      return;
    }
    const now = new Date();
    if (next === "later") {
      // The next whole hour still on offer today, else the next half hour.
      const options = startsOn(now, hours, now);
      const choice = options.find((at) => at.getMinutes() === 0 && at - now >= 30 * 60_000) || options[0];
      if (choice) {
        setFollowing(false);
        setStartValue(toLocalInput(choice));
      }
      return;
    }
    // Another day: tomorrow, at the same time of day if it is on offer then.
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const options = startsOn(tomorrow, hours, now);
    const sameTime = options.find((at) => at.getHours() === startTime.getHours() && at.getMinutes() === startTime.getMinutes());
    const choice = sameTime || options.find((at) => at.getHours() >= 10) || options[0];
    if (choice) {
      setFollowing(false);
      setStartValue(toLocalInput(choice));
    }
  }, [hours?.open, hours?.close, startTime]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A start and a length picked together — a tap or a drag on the
   * timeline. The length is in minutes, kept to the picker's half hours.
   */
  const choose = useCallback((at, minutes) => {
    setFollowing(false);
    setStartValue(toLocalInput(at));
    if (minutes) setDuration(Math.max(0.5, Math.round(minutes / 30) / 2));
  }, []);

  return {
    start, setStart, duration, setDuration,
    startTime, endTime, maxDuration, maxStayHours, hours, lengths, problem, iso,
    mode, setMode, nowOpen, starts, laterToday, choose,
  };
}
