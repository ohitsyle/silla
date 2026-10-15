import { useEffect, useMemo, useState } from "react";

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

/** "Thu 14:00" — the short form every panel uses for a time. */
export const formatWhen = (value) =>
  new Date(value).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** "Thu 14:00 – 16:00", or across days "Thu 14:00 – Fri 09:00". */
export function formatSpan(start, end) {
  const from = new Date(start);
  const to = new Date(end);
  const sameDay = from.toDateString() === to.toDateString();
  const time = to.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${formatWhen(from)} – ${sameDay ? time : formatWhen(to)}`;
}

/** "1 hour", "1.5 hours". */
export const formatHours = (hours) => `${hours} hour${hours === 1 ? "" : "s"}`;

/**
 * @param {object} policy  the organization's policy (maxStayHours, operatingHours)
 * @returns the window, its limits, and why it cannot be booked if it cannot
 */
export function useBookingWindow(policy) {
  const maxStayHours = policy?.maxStayHours ?? 4;
  const hours = policy?.operatingHours;

  const [start, setStart] = useState(() => toLocalInput(firstBookableSlot(hours)));
  const [duration, setDuration] = useState(() => Math.min(2, maxStayHours));

  // The organization's config usually arrives after the first render, so
  // the default start is recomputed once its opening hours are known.
  useEffect(() => {
    setStart(toLocalInput(firstBookableSlot(hours)));
  }, [hours?.open, hours?.close]);

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

  return {
    start, setStart, duration, setDuration,
    startTime, endTime, maxDuration, maxStayHours, hours, lengths, problem, iso,
  };
}
