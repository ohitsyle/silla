import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

/**
 * MAP-2 — real-time status updates (spec §12, §17).
 *
 * Subscribes to one floor's room and patches ONLY the status half of the
 * map. The layout was fetched once over REST and is never re-sent; this
 * hook must never touch it. That separation is the whole architectural
 * point of the split payload — see server/src/services/realtime.js.
 *
 * `onDay` hears that the floor's DAY changed — a booking for later, a
 * cancellation, a closure — which changes no colour, so the map re-reads
 * its day (useFloorDay). The event carries only the floor.
 *
 * One socket per mounted map, torn down on floor change so a client
 * looking at Level 4 never receives Level 3's traffic. The callbacks are
 * read through refs, so a caller passing a fresh function each render
 * neither tears the socket down nor leaves it calling a stale one.
 */
export function useFloorSocket(floorId, onStatus, onDay) {
  const handlers = useRef({ onStatus, onDay });
  handlers.current = { onStatus, onDay };

  useEffect(() => {
    if (!floorId) return undefined;

    const socket = io(import.meta.env.VITE_API_URL || "http://localhost:4000", {
      transports: ["websocket"],
      reconnectionDelay: 500,
    });

    const join = () => socket.emit("floor:join", floorId);
    socket.on("connect", join);
    // Re-join after a reconnect — room membership doesn't survive a drop.
    // Anything that happened while disconnected is caught by a fresh read.
    socket.io.on("reconnect", () => {
      join();
      handlers.current.onDay?.();
    });

    socket.on("resource:status", ({ resourceId, units }) => {
      if (resourceId && Array.isArray(units)) handlers.current.onStatus?.(resourceId, units);
    });
    socket.on("floor:day", ({ floorId: changed }) => {
      if (String(changed) === String(floorId)) handlers.current.onDay?.();
    });

    return () => {
      socket.off("resource:status");
      socket.off("floor:day");
      socket.close();
    };
  }, [floorId]);
}
