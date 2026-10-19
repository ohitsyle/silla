import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/** How often an open map re-reads its day without being told: "now" moves on. */
const REFRESH_MS = 60_000;

/**
 * One floor's day for one date (GET /api/floors/:id/day), kept current.
 *
 * Re-read when:
 *   - the floor or the date changes;
 *   - `version` changes — the page bumps it when the socket says the day
 *     changed (useFloorSocket's onDay), or after the member books;
 *   - a minute passes, gently: the past greys, "free until" moves on, and a
 *     closure added with no booking inside it still arrives.
 *
 * The previous answer stays on screen while the next one loads, so the
 * rings and the timeline never blink out between reads. An answer to an
 * older question (another floor, another date) is dropped.
 */
export function useFloorDay(floorId, date, version = 0) {
  const [day, setDay] = useState(null);
  const [error, setError] = useState(null);
  const request = useRef(0);

  const load = useCallback(() => {
    if (!floorId || !date) return;
    const ticket = ++request.current;
    api
      .getFloorDay(floorId, date)
      .then((answer) => {
        if (ticket !== request.current) return;
        setDay(answer);
        setError(null);
      })
      .catch((err) => ticket === request.current && setError(err.message));
  }, [floorId, date]);

  // A different floor or date: what is on screen no longer answers it.
  useEffect(() => {
    setDay((current) => (current && current.floorId === floorId && current.date === date ? current : null));
  }, [floorId, date]);

  // Debounced, because one booking can announce itself to a floor twice
  // (its own unit and its room) and a burst of changes needs one read.
  useEffect(() => {
    const timer = setTimeout(load, version ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, version]);

  useEffect(() => {
    if (!floorId || !date) return undefined;
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, floorId, date]);

  return { day: day && day.floorId === floorId && day.date === date ? day : null, error, reload: load };
}
