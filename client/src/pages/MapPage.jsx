import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Layers, RefreshCw } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import SpaceNavigator from "../components/SpaceNavigator.jsx";
import { ROOM_MODES, roomUnit, effectiveStatus } from "../lib/rooms.js";
import ReservePanel from "../components/ReservePanel.jsx";
import Inspector from "../components/Inspector.jsx";
import SpaceMap, { OVERSTAY_META, SERVICE_META, STATUS_META, STATUS_ORDER } from "../components/SpaceMap.jsx";
import {
  Badge, Button, Card, Notice, Page, PageHeader, Segmented, Select, Skeleton, StatusDot, pageEnter,
} from "../components/ui/index.jsx";

/**
 * MapPage — the member-facing live map screen (MAP-1).
 *
 * Owns the data: the floor list that feeds the switcher, and the layout
 * for whichever floor is selected. SpaceMap owns the drawing and knows
 * nothing about fetching.
 *
 * `layout` and `status` are held in separate state deliberately. Both
 * arrive from one REST read, but MAP-2's Socket.io stream only ever
 * touches `status` — see the subscription below.
 */
export default function MapPage() {
  const { org, error: orgError } = useOrg();
  const { floorId } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const roomId = search.get("room");
  const [buildings, setBuildings] = useState([]);

  const [floors, setFloors] = useState([]);
  const [layoutData, setLayoutData] = useState(null);
  const [status, setStatus] = useState({});
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [myReservation, setMyReservation] = useState(null);
  const [live, setLive] = useState(false);
  const [inspectorDismissed, setInspectorDismissed] = useState(false);
  const layoutRequest = useRef(0);

  const organizationId = import.meta.env.VITE_DEMO_ORG_ID || "";
  // The state colours come from the org's branding (spec §16), not from
  // constants in the renderer — see theme/applyOrgTheme.js.
  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const facilityLabel = org?.terminology?.facilityLabel || "facility";

  // ---- Floor list (the switcher's data source) ----
  useEffect(() => {
    if (!organizationId) {
      setError("This service isn't configured yet. Please ask a member of staff.");
      setLoading(false);
      return;
    }
    Promise.all([api.getFloors(organizationId), api.getSpaces(organizationId)])
      .then(([data, spaces]) => {
        setBuildings(spaces.buildings);
        setFloors(data.floors);
        if (!data.floors.length) {
          // Same rule as StarterPage's error: whoever reads this is a
          // member standing at a screen, not the engineer who seeds it.
          setError("No floors have been set up yet. Please ask a member of staff.");
          setLoading(false);
        } else if (!floorId) {
          // Land on the first floor by order, and put it in the URL so
          // the view is linkable.
          navigate(`/map/${data.floors[0].id}`, { replace: true });
        }
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [organizationId, floorId, navigate]);

  // ---- Layout + initial status snapshot for the selected floor ----
  const loadLayout = useCallback((id, { silent = false } = {}) => {
    if (!id) return;
    const request = ++layoutRequest.current;
    if (silent) setRefreshing(true);
    else { setLoading(true); setLayoutData(null); setStatus({}); }
    api
      .getFloorLayout(id)
      .then((data) => {
        if (request !== layoutRequest.current) return;
        setLayoutData(data);
        setStatus(data.status);
        setError(null);
      })
      .catch((err) => { if (request === layoutRequest.current) setError(err.message); })
      .finally(() => {
        if (request !== layoutRequest.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    setSelectedUnit(null);
    setLive(false);
    loadLayout(floorId);
    return () => { layoutRequest.current++; };
  }, [floorId, loadLayout]);

  // ---- MAP-2: live status over Socket.io (spec §12, §17) ----
  // Only `status` is patched. The layout was fetched once and is never
  // re-sent — that split is the whole point of the payload shape.
  const applyStatus = useCallback((resourceId, units) => {
    setStatus((current) => ({ ...current, [resourceId]: units }));
    setLive(true);
  }, []);
  useFloorSocket(floorId, applyStatus);

  // ---- The caller's own reservation (RES-3: at most one) ----
  const loadMine = useCallback(() => {
    api.myReservations().then((d) => setMyReservation(d.live)).catch(() => setMyReservation(null));
  }, []);
  useEffect(loadMine, [loadMine]);

  // ---- Occupancy summary, derived from the live status half ----
  const summary = useMemo(() => {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    let total = 0;
    let overstays = 0;
    let outOfService = 0;
    for (const resource of layoutData?.layout.resources || []) {
      for (const original of status[resource.id] || []) {
        const unit = effectiveStatus(resource, original, layoutData?.layout.rooms || [], status);
        total += 1;
        if (counts[unit.status] !== undefined) counts[unit.status] += 1;
        if (unit.overstay) overstays += 1;
        if (unit.serviceStatus === "out_of_service") outOfService += 1;
      }
    }
    return { counts, total, overstays, outOfService };
  }, [status, layoutData]);

  const currentBuilding = buildings.find((b) => b.floors.some((f) => f.id === floorId));
  const focusedRoom = layoutData && layoutData.floor.id === floorId ? layoutData.layout.rooms?.find((r) => r.id === roomId) : null;
  const openFloor = (id) => { setSelectedUnit(null); navigate(`/map/${id}`); };
  const openRoom = (room, id = floorId) => { setSelectedUnit(null); setInspectorDismissed(false); navigate(`/map/${id}?room=${room.id}`); };

  if (orgError) {
    return (
      <Page>
        <Notice tone="error">Couldn't load organization config: {orgError}</Notice>
      </Page>
    );
  }



  return (
    // Fill layout: a compact toolbar, the map taking every remaining
    // pixel, and the inspector as a COLUMN beside it. Nothing here
    // grows the page — selecting a seat cannot move the map, which was
    // the whole complaint about the old stacked version.
    <div className="flex h-full min-h-0">
      <SpaceNavigator buildings={buildings} floorId={floorId} roomId={roomId} onFloor={openFloor} onRoom={openRoom} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar — one row, fixed height, never scrolls away. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line/10 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate font-semibold leading-tight">
              {layoutData ? layoutData.floor.name : `Live ${facilityLabel.toLowerCase()} map`}
            </h1>
            <p className="truncate text-xs text-ink-muted">
              {layoutData ? layoutData.floor.site.name : "Loading…"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 lg:hidden">
            <Select label="Building" value={currentBuilding?.id || ""} onChange={(e) => { const first = buildings.find((b) => b.id === e.target.value)?.floors[0]; if (first) openFloor(first.id); }} >{buildings.filter((b) => b.floors.length).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
            <Select label="Floor" value={floorId || ""} onChange={(e) => openFloor(e.target.value)} >{(currentBuilding?.floors || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
          </div>
          {focusedRoom && <Button size="sm" onClick={() => openFloor(floorId)}>All rooms</Button>}
          {inspectorDismissed && (focusedRoom || myReservation) && <Button size="sm" onClick={() => setInspectorDismissed(false)}>{focusedRoom ? "Room details" : "Your reservation"}</Button>}

          <div className="ml-auto flex items-center gap-3">
            {live && (
              <span
                className="hidden sm:flex items-center gap-1.5 text-xs text-ink-muted"
                title="Receiving live status updates"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-state-available opacity-70 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-state-available" />
                </span>
                Live
              </span>
            )}
            <Button
              size="sm"
              icon={RefreshCw}
              onClick={() => {
                loadLayout(floorId, { silent: true });
                Promise.all([api.getFloors(organizationId), api.getSpaces(organizationId)]).then(([data, spaces]) => {
                  setFloors(data.floors); setBuildings(spaces.buildings);
                  if (data.floors.length && !data.floors.some((f) => f.id === floorId)) navigate(`/map/${data.floors[0].id}`, { replace: true });
                }).catch((err) => setError(err.message));
              }}
              disabled={!floorId || refreshing}
              className={refreshing ? "[&>svg]:animate-spin" : undefined}
            >
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <div className="shrink-0 px-4 pt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1.5 border-b border-line/5 px-4 py-2 text-xs text-ink-muted" aria-label="Current map location">
          <span>{currentBuilding?.name || layoutData?.floor.site.name}</span><span>›</span>
          <button className="hover:text-accent" onClick={() => openFloor(floorId)}>{layoutData?.floor.name}</button>
          {focusedRoom && <><span>›</span><span className="font-medium text-ink-primary">{focusedRoom.name}</span></>}
        </div>
        {!focusedRoom && Boolean(layoutData?.layout.rooms?.length) && <div className="flex shrink-0 gap-2 overflow-x-auto px-4 py-2 lg:hidden">
          {layoutData.layout.rooms.map((r) => <Button key={r.id} size="sm" onClick={() => openRoom(r)}>{r.name}</Button>)}
        </div>}
        {/* The map — everything that is left. */}
        <div className="min-h-0 flex-1 p-3">
          {loading && !layoutData ? (
            <Skeleton className="h-full w-full" rounded="rounded-md" />
          ) : layoutData ? (
            <SpaceMap
              fill
              floor={layoutData.floor}
              layout={layoutData.layout}
              resourceTypes={layoutData.resourceTypes}
              status={status}
              resourceNoun={resourceNoun}
              showOverstay={layoutData.viewerIsStaff}
              selectedUnit={selectedUnit}
              onSelectUnit={(unit) => { setSelectedUnit(unit); setInspectorDismissed(false); }}
              onSelectRoom={openRoom}
              focusedRoomId={focusedRoom?.id}
              palette={palette}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">
              No floor selected.
            </div>
          )}
        </div>

        {/* Legend — a status bar at the foot, where a tool puts it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line/10 px-4 py-2.5 text-sm">
          {layoutData ? (
            <>
              <span className="text-ink-secondary">
                <span className="font-semibold tabular-nums text-ink-primary">{summary.counts.available}</span>{" "}
                of <span className="tabular-nums">{summary.total}</span> {resourceNoun}s open
              </span>
              <span className="hidden h-4 w-px bg-line/10 sm:block" />
              {STATUS_ORDER.map((key) => (
                <StatusDot key={key} tone={key} label={STATUS_META[key].label} count={summary.counts[key]} />
              ))}
              {summary.outOfService > 0 && (
                <StatusDot tone="unavailable" label={SERVICE_META.label} count={summary.outOfService} outline />
              )}
              {layoutData.viewerIsStaff && summary.overstays > 0 && (
                <StatusDot tone="overstay" label={OVERSTAY_META.label} count={summary.overstays} />
              )}
              <span className="ml-auto hidden text-xs text-ink-muted lg:block">
                Drag to pan · scroll to zoom · select a room or resource to choose a time
              </span>
            </>
          ) : (
            <div className="flex gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-4 w-20" />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---- RES-1 / RES-3 — reserve, or manage the one you hold ---- */}
      <Inspector
        open={!inspectorDismissed && (Boolean(selectedUnit) || Boolean(myReservation) || Boolean(focusedRoom))}
        onClose={() => { setSelectedUnit(null); setInspectorDismissed(true); }}
        title={selectedUnit ? selectedUnit.kind === "room" ? selectedUnit.type.label : `${selectedUnit.type?.label || resourceNoun} · ${selectedUnit.unitLabel}` : focusedRoom?.name || "Your reservation"}
        subtitle={
          selectedUnit
            ? selectedUnit.kind === "room" ? `Includes all ${selectedUnit.levels.length} room level(s)` : `Cell (${selectedUnit.position?.col}, ${selectedUnit.position?.row})`
            : undefined
        }
      >
        {focusedRoom && !selectedUnit && <div className="mb-5 space-y-4">
          <Badge>{ROOM_MODES[focusedRoom.bookingMode]?.label}</Badge>
          <p className="text-sm leading-relaxed text-ink-secondary">{ROOM_MODES[focusedRoom.bookingMode]?.description}</p>
          {focusedRoom.levels.length > 1 && <div><p className="mb-2 text-xs text-ink-muted">Room levels · one shared booking</p><Segmented value={floorId} onChange={(id) => openRoom(focusedRoom, id)} options={focusedRoom.levels.map((l) => ({ value: l.floorId, label: l.name || floors.find((f) => f.id === l.floorId)?.name || "Level" }))} /></div>}
          {focusedRoom.bookingMode !== "individual" && !myReservation && <Button variant="primary" className="w-full" onClick={() => setSelectedUnit(roomUnit(focusedRoom, status))}>Reserve whole room</Button>}
          {focusedRoom.bookingMode !== "whole" && <p className="text-xs text-ink-muted">Select a resource on the map to reserve it individually.</p>}
          {focusedRoom.bookingMode === "whole" && <p className="text-xs text-ink-muted">Every level, seat and item inside is included. Individual bookings are disabled.</p>}
        </div>}
        {(selectedUnit || myReservation) && <ReservePanel
          embedded
          selectedUnit={selectedUnit}
          resourceNoun={resourceNoun}
          policy={org?.policy}
          myReservation={myReservation}
          onClose={() => setSelectedUnit(null)}
          onReserved={() => {
            setInspectorDismissed(false);
            setSelectedUnit(null);
            loadMine();
            loadLayout(floorId, { silent: true });
          }}
          onCancelled={() => {
            loadMine();
            loadLayout(floorId, { silent: true });
          }}
        />}
      </Inspector>
    </div>
  );
}
