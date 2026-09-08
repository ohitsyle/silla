import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Layers, RefreshCw } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import ReservePanel from "../components/ReservePanel.jsx";
import Inspector from "../components/Inspector.jsx";
import SpaceMap, { OVERSTAY_META, SERVICE_META, STATUS_META, STATUS_ORDER } from "../components/SpaceMap.jsx";
import {
  Button, Card, Notice, Page, PageHeader, Segmented, Skeleton, StatusDot, pageEnter,
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

  const [floors, setFloors] = useState([]);
  const [layoutData, setLayoutData] = useState(null);
  const [status, setStatus] = useState({});
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [myReservation, setMyReservation] = useState(null);
  const [live, setLive] = useState(false);

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
    api
      .getFloors(organizationId)
      .then((data) => {
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
    if (silent) setRefreshing(true);
    else setLoading(true);
    api
      .getFloorLayout(id)
      .then((data) => {
        setLayoutData(data);
        setStatus(data.status);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    setSelectedUnit(null);
    loadLayout(floorId);
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
    for (const units of Object.values(status)) {
      for (const unit of units) {
        total += 1;
        if (counts[unit.status] !== undefined) counts[unit.status] += 1;
        if (unit.overstay) overstays += 1;
        if (unit.serviceStatus === "out_of_service") outOfService += 1;
      }
    }
    return { counts, total, overstays, outOfService };
  }, [status]);

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

          {floors.length > 1 && (
            <Segmented
              size="sm"
              className="floors"
              value={floorId}
              onChange={(id) => navigate(`/map/${id}`)}
              options={floors.map((f) => ({ value: f.id, label: f.name }))}
            />
          )}

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
              onClick={() => loadLayout(floorId, { silent: true })}
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
              onSelectUnit={setSelectedUnit}
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
                Drag to pan · scroll to zoom · click an available {resourceNoun} to reserve it
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
        open={Boolean(selectedUnit) || Boolean(myReservation)}
        onClose={() => setSelectedUnit(null)}
        title={selectedUnit ? `${selectedUnit.type?.label || resourceNoun} · ${selectedUnit.unitLabel}` : "Your reservation"}
        subtitle={
          selectedUnit
            ? `Cell (${selectedUnit.position?.col}, ${selectedUnit.position?.row})`
            : undefined
        }
      >
        <ReservePanel
          embedded
          selectedUnit={selectedUnit}
          resourceNoun={resourceNoun}
          policy={org?.policy}
          myReservation={myReservation}
          onClose={() => setSelectedUnit(null)}
          onReserved={() => {
            setSelectedUnit(null);
            loadMine();
            loadLayout(floorId, { silent: true });
          }}
          onCancelled={() => {
            loadMine();
            loadLayout(floorId, { silent: true });
          }}
        />
      </Inspector>
    </div>
  );
}
