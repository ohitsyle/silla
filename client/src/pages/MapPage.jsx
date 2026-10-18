import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CirclePause, RefreshCw } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import { useBookingWindow } from "../lib/bookingWindow.js";
import { effectiveStatus, levelName, listNames, roomMode } from "../lib/rooms.js";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import SpaceNavigator from "../components/SpaceNavigator.jsx";
import SpaceMap, { STATUS_ORDER } from "../components/SpaceMap.jsx";
import MapLegend from "../components/MapLegend.jsx";
import Inspector from "../components/Inspector.jsx";
import RoomPanel from "../components/RoomPanel.jsx";
import ReservePanel, { MyReservation } from "../components/ReservePanel.jsx";
import { Button, Notice, Page, Skeleton } from "../components/ui/index.jsx";

/**
 * MapPage — the member-facing live map (MAP-1, MAP-2, RES-1, RES-3).
 *
 * The page reads the space the way it is built: building → floor → room
 * → what to book. The header names each level and lets you change it
 * (SpaceNavigator); the floor plan draws rooms as outlined, named areas
 * with their furniture inside; choosing a room opens what it offers for
 * the time you have chosen (RoomPanel); choosing a unit or the whole room
 * asks for your PIN (ReservePanel).
 *
 * Where you are lives in the URL — /map/<floor>?room=<room> — so a room
 * can be linked to. What you have picked to book does not: it is a step
 * in a form, not a place.
 *
 * `layout` and `status` are held separately on purpose. Both arrive from
 * one REST read, but MAP-2's Socket.io stream only ever touches `status`.
 */
export default function MapPage() {
  const { org, organizationId, error: orgError, entitlements } = useOrg();
  // A suspended or cancelled organization is read-only: the map stays,
  // the booking flow does not (docs/control-plane.md §2).
  const paused = !entitlements.operational;
  const { floorId } = useParams();
  const [search] = useSearchParams();
  const roomId = search.get("room");
  const navigate = useNavigate();

  /** null until the hierarchy has loaded — distinct from "loaded, and empty". */
  const [buildings, setBuildings] = useState(null);
  const [layoutData, setLayoutData] = useState(null);
  const [status, setStatus] = useState({});
  const [statusVersion, setStatusVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  /** What the member holds: their current session and their next booking, at most one of each (RES-3). */
  const [holding, setHolding] = useState([]);
  /** What the member has picked to book: one unit, or a room as a whole. */
  const [selection, setSelection] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const layoutRequest = useRef(0);

  // State colours come from the organization's branding (spec §16).
  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const booking = useBookingWindow(org?.policy);

  /* ───────────────────────────── loading ───────────────────────────── */

  const loadSpaces = useCallback(() => {
    if (!organizationId) return;
    api
      .getSpaces(organizationId)
      .then((spaces) => setBuildings(spaces.buildings))
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) {
      setError("This service isn't configured yet. Please ask a member of staff.");
      setLoading(false);
      return;
    }
    loadSpaces();
  }, [organizationId, loadSpaces]);

  // Land on the first floor when none (or one that no longer exists) is
  // in the address — and put it there, so the view is linkable.
  useEffect(() => {
    if (!buildings) return;
    const floors = buildings.flatMap((building) => building.floors);
    if (!floors.length) {
      // Whoever reads this is a member standing at a screen, not the
      // engineer who sets the map up.
      setError("No floors have been set up yet. Please ask a member of staff.");
      setLoading(false);
    } else if (!floorId || !floors.some((candidate) => candidate.id === floorId)) {
      navigate(`/map/${floors[0].id}`, { replace: true });
    }
  }, [buildings, floorId, navigate]);

  const loadLayout = useCallback((id, { silent = false } = {}) => {
    if (!id) return;
    const request = ++layoutRequest.current;
    if (silent) setRefreshing(true);
    else {
      setLoading(true);
      setLayoutData(null);
      setStatus({});
    }
    api
      .getFloorLayout(id)
      .then((data) => {
        if (request !== layoutRequest.current) return;
        setLayoutData(data);
        setStatus(data.status);
        setStatusVersion((n) => n + 1);
        setError(null);
      })
      .catch((err) => request === layoutRequest.current && setError(err.message))
      .finally(() => {
        if (request !== layoutRequest.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    setLive(false);
    setHovered(null);
    // A choice made on another floor survives the move only if it is ON
    // the floor being opened — picking a desk on a room's balcony takes
    // you there with the desk still chosen.
    setSelection((current) => (current && current.floorId === floorId ? current : null));
    loadLayout(floorId);
    return () => {
      layoutRequest.current += 1;
    };
  }, [floorId, loadLayout]);

  // MAP-2: only `status` is patched; the layout is never re-sent.
  const applyStatus = useCallback((resourceId, units) => {
    setStatus((current) => ({ ...current, [resourceId]: units }));
    setStatusVersion((n) => n + 1);
    setLive(true);
  }, []);
  useFloorSocket(floorId, applyStatus);

  // RES-3: one current session and one upcoming booking at most.
  const loadMine = useCallback(() => {
    api
      .myReservations()
      .then((data) => setHolding(data.holding || (data.live ? [data.live] : [])))
      .catch(() => setHolding([]));
  }, []);
  useEffect(loadMine, [loadMine]);

  /* ───────────────────────────── where we are ───────────────────────────── */

  const building = buildings?.find((candidate) => candidate.floors.some((floor) => floor.id === floorId));
  const floor = building?.floors.find((candidate) => candidate.id === floorId);
  const current = layoutData?.floor.id === floorId ? layoutData : null;
  const rooms = current?.layout.rooms || [];
  const focusedRoom = rooms.find((room) => room.id === roomId) || null;

  const summary = useMemo(() => summarise(current, status), [current, status]);

  /* ───────────────────────────── moving around ───────────────────────────── */

  const openFloor = (id) => {
    setDismissed(false);
    navigate(`/map/${id}`);
  };
  const showFloorPlan = () => {
    setSelection(null);
    navigate(`/map/${floorId}`);
  };
  const openRoom = (room, onFloor = floorId) => {
    setSelection(null);
    setDismissed(false);
    navigate(`/map/${onFloor}?room=${room.id}`);
  };

  /** A unit tapped on the map. Inside a room, the room comes into focus with it. */
  const pickFromMap = (unit) => {
    setDismissed(false);
    setSelection({
      kind: "unit",
      resourceId: unit.resourceId,
      unitLabel: unit.unitLabel,
      floorId,
      roomId: unit.roomId,
      typeLabel: unit.type.label,
    });
    if (unit.roomId && unit.roomId !== roomId) navigate(`/map/${floorId}?room=${unit.roomId}`);
  };

  /** A unit chosen from the room panel's list — possibly on another of the room's floors. */
  const pickFromRoom = (unit) => {
    setDismissed(false);
    setSelection({
      kind: "unit",
      resourceId: unit.resourceId,
      unitLabel: unit.unitLabel,
      floorId: unit.floorId,
      roomId: focusedRoom.id,
      typeLabel: unit.typeLabel,
    });
    setHovered(null);
    if (unit.floorId !== floorId) navigate(`/map/${unit.floorId}?room=${focusedRoom.id}`);
  };

  const bookWholeRoom = () =>
    setSelection({
      kind: "room",
      resourceId: focusedRoom.resourceId,
      unitLabel: "room",
      floorId,
      roomId: focusedRoom.id,
      typeLabel: focusedRoom.name,
    });

  const refresh = () => {
    loadLayout(floorId, { silent: true });
    loadSpaces();
    loadMine();
  };

  /* ───────────────────────────── the panel ───────────────────────────── */

  const target = selection && {
    ...selection,
    // The live state of a unit on this floor, for "out of service" and the like.
    status: selection.kind === "unit" ? liveUnitStatus(current, status, selection) : status[selection.resourceId]?.[0],
  };
  const selectionRoom = selection?.roomId ? rooms.find((room) => room.id === selection.roomId) : null;
  const panelOpen = !dismissed && Boolean(selection || focusedRoom || holding.length);

  let title = holding.length > 1 ? "Your reservations" : "Your reservation";
  let subtitle;
  if (selection?.kind === "room") {
    title = "Book the whole room";
    subtitle = selectionRoom && selectionRoom.levels.length > 1
      ? `Everything in ${selection.typeLabel}, on ${listNames(selectionRoom.levels.map((level) => levelName(level, building?.floors)))}`
      : `${selection.typeLabel} and everything in it`;
  } else if (selection) {
    title = `${selection.typeLabel} · ${selection.unitLabel}`;
    subtitle = selectionRoom ? `In ${selectionRoom.name}, ${floor?.name}` : floor ? `On ${floor.name}` : undefined;
  } else if (focusedRoom) {
    title = focusedRoom.name;
    subtitle = roomMode(focusedRoom.bookingMode, resourceNoun).member;
  }

  if (orgError) {
    return (
      <Page>
        <Notice tone="error">Couldn't load this organization: {orgError}</Notice>
      </Page>
    );
  }

  return (
    // Map column plus the panel: beside it on a wide screen, docked under
    // it on a phone. Nothing here grows the page — choosing something
    // cannot scroll the map away from you.
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SpaceNavigator
          buildings={buildings || []}
          floorId={floorId}
          rooms={rooms}
          roomId={focusedRoom?.id || null}
          status={status}
          resourceNoun={resourceNoun}
          focused={panelOpen && Boolean(focusedRoom || selection)}
          onFloor={openFloor}
          onRoom={openRoom}
          onFloorView={showFloorPlan}
          actions={
            <>
              {live && (
                <span className="hidden items-center gap-1.5 text-xs text-ink-muted sm:flex" title="Receiving live updates">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-state-available opacity-70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-state-available" />
                  </span>
                  Live
                </span>
              )}
              {dismissed && (focusedRoom || holding.length > 0) && (
                <Button size="sm" onClick={() => setDismissed(false)}>
                  {focusedRoom ? "What can I book?" : holding.length > 1 ? "My reservations" : "My reservation"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                onClick={refresh}
                disabled={!floorId || refreshing}
                aria-label="Refresh the map"
                className={refreshing ? "[&>svg]:animate-spin" : undefined}
              >
                <span className="hidden sm:inline">Refresh</span>
              </Button>
            </>
          }
        />

        {error && (
          <div className="shrink-0 px-4 pt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        <div className="relative min-h-[11rem] flex-1 p-3">
          {current ? (
            <SpaceMap
              fill
              floor={current.floor}
              layout={current.layout}
              resourceTypes={current.resourceTypes}
              status={status}
              resourceNoun={resourceNoun}
              showOverstay={current.viewerIsStaff}
              selectedUnit={selection?.kind === "unit" ? selection : null}
              highlight={hovered ? [hovered] : []}
              onSelectUnit={pickFromMap}
              onSelectRoom={(room) => openRoom(room)}
              focusedRoomId={focusedRoom?.id}
              palette={palette}
            />
          ) : loading ? (
            <Skeleton className="h-full w-full" rounded="rounded-md" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">No floor selected.</div>
          )}
        </div>

        <div className={panelOpen ? "hidden lg:block" : undefined}>
          <MapLegend
            summary={summary}
            resourceNoun={resourceNoun}
            showOverstay={current?.viewerIsStaff}
            loading={!current}
          />
        </div>
      </div>

      <Inspector
        open={panelOpen}
        onClose={() => {
          setSelection(null);
          setDismissed(true);
        }}
        title={title}
        subtitle={subtitle}
        onBack={selection && focusedRoom ? () => setSelection(null) : undefined}
        backLabel={focusedRoom?.name}
        defaultFolded={!selection && !focusedRoom}
      >
        <div className="space-y-5">
          {holding.map((reservation) => (
            <MyReservation
              key={reservation.id}
              reservation={reservation}
              resourceNoun={resourceNoun}
              policy={org?.policy}
              compact={Boolean(selection || focusedRoom)}
              readOnly={paused}
              onCancelled={() => {
                loadMine();
                loadLayout(floorId, { silent: true });
              }}
            />
          ))}

          {paused && (target || focusedRoom) ? (
            <BookingPaused orgName={org?.name} resourceNoun={resourceNoun} ended={entitlements.status === "cancelled"} />
          ) : target ? (
            <ReservePanel
              key={`${target.resourceId}:${target.unitLabel}`}
              target={target}
              booking={booking}
              resourceNoun={resourceNoun}
              policy={org?.policy}
              onReserved={() => {
                setSelection(null);
                loadMine();
                loadLayout(floorId, { silent: true });
              }}
            />
          ) : focusedRoom ? (
            <RoomPanel
              room={focusedRoom}
              floors={building?.floors}
              floorId={floorId}
              booking={booking}
              resourceNoun={resourceNoun}
              refreshKey={statusVersion}
              onBookRoom={bookWholeRoom}
              onPickUnit={pickFromRoom}
              onHoverUnit={(unit) => setHovered(unit ? { resourceId: unit.resourceId, unitLabel: unit.unitLabel } : null)}
              onShowLevel={(id) => openRoom(focusedRoom, id)}
            />
          ) : null}
        </div>
      </Inspector>
    </div>
  );
}

/**
 * What the panel says instead of a booking form while the organization is
 * paused. Every booking would be refused (the server's read-only guard),
 * so offering the form — times, a PIN, a Reserve button — would only lead
 * someone through three steps to an error. The map beside it still works.
 */
function BookingPaused({ orgName, resourceNoun, ended = false }) {
  return (
    <div className="rounded-lg border border-line/10 bg-bg-panel/60 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-line/10 text-ink-secondary">
          <CirclePause size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-medium">{ended ? "Booking has closed" : "Booking is paused"}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-secondary">
            {orgName || "This organization"} {ended ? "is no longer taking bookings" : "isn't taking bookings right now"}.
            The map still shows which {resourceNoun}s are free and which are in use.
          </p>
        </div>
      </div>
    </div>
  );
}

/** The live state of the chosen unit, when it is on the floor in view. */
function liveUnitStatus(current, status, selection) {
  const resource = current?.layout.resources.find((candidate) => candidate.id === selection.resourceId);
  if (!resource) return undefined;
  const index = resource.units.findIndex((unit) => unit.label === selection.unitLabel);
  return effectiveStatus(resource, status[resource.id]?.[index], current.layout.rooms || [], status);
}

/**
 * The legend's counts, from the live status half. Units that only come
 * with a room booked whole are counted apart: they are part of that room,
 * not units anyone can take on their own.
 */
function summarise(current, status) {
  if (!current) return null;
  const counts = Object.fromEntries(STATUS_ORDER.map((key) => [key, 0]));
  let total = 0;
  let overstays = 0;
  let outOfService = 0;
  let included = 0;
  for (const resource of current.layout.resources) {
    for (const own of status[resource.id] || []) {
      const unit = effectiveStatus(resource, own, current.layout.rooms || [], status);
      if (unit?.includedInRoom) {
        included += 1;
        continue;
      }
      total += 1;
      if (counts[unit.status] !== undefined) counts[unit.status] += 1;
      if (unit.overstay) overstays += 1;
      if (unit.serviceStatus === "out_of_service") outOfService += 1;
    }
  }
  return { counts, total, overstays, outOfService, included, rooms: (current.layout.rooms || []).length };
}
