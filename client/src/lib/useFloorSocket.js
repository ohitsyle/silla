import { useEffect } from "react";
import { io } from "socket.io-client";

/**
 * MAP-2 — real-time status updates (spec §12, §17).
 *
 * Subscribes to one floor's room and patches ONLY the status half of the
 * map. The layout was fetched once over REST and is never re-sent; this
 * hook must never touch it. That separation is the whole architectural
 * point of the split payload — see server/src/services/realtime.js.
 *
 * One socket per mounted map, torn down on floor change so a client
 * looking at Level 4 never receives Level 3's traffic.
 */
export function useFloorSocket(floorId, onStatus) {
  useEffect(() => {
    if (!floorId) return undefined;

    const socket = io(import.meta.env.VITE_API_URL || "http://localhost:4000", {
      transports: ["websocket"],
      reconnectionDelay: 500,
    });

    const join = () => socket.emit("floor:join", floorId);
    socket.on("connect", join);
    // Re-join after a reconnect — room membership doesn't survive a drop.
    socket.io.on("reconnect", join);

    socket.on("resource:status", ({ resourceId, units }) => {
      if (resourceId && Array.isArray(units)) onStatus(resourceId, units);
    });

    return () => {
      socket.off("resource:status");
      socket.close();
    };
    // onStatus is expected to be a stable callback (useCallback in the
    // caller); including it here would tear the socket down every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId]);
}
