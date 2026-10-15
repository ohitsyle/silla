import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Ban, Building2, CircleCheck, DoorOpen, Eye, Layers, MousePointerClick, Tag, Trash2, Wrench } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import { readLimit, withArticle } from "../lib/rooms.js";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import SpaceMap from "../components/SpaceMap.jsx";
import SetupSteps, { Usage } from "../components/SetupSteps.jsx";
import { BuildingSwitcher, FloorTabs } from "../components/SpaceNavigator.jsx";
import RoomManager, { BuildingDialog, RoomDialog } from "../components/RoomManager.jsx";
import { AddFloorDialog, FloorSettings } from "../components/FloorSettings.jsx";
import {
  Badge, Button, Card, EmptyState, Field, Loading, Modal, Notice, Page, PageHeader, Panel, Segmented, Skeleton, Spinner,
} from "../components/ui/index.jsx";

/**
 * EditorPage — MAP-3, MAP-4, MAP-5 and the building/floor/room setup
 * (spec §12, §14). One shared layout model renders both this and the
 * member map, so it reuses SpaceMap and adds an editing layer on top.
 *
 * ── Roles ──────────────────────────────────────────────────────────
 *   staff       "Space controls": availability (unavailable, out of
 *               service) and room schedules. They operate the space.
 *   superadmin  everything above, plus the setup sequence — buildings,
 *               floors, rooms and how each room is booked — and placing
 *               furniture, zones and labels. They define the space.
 *
 * The server enforces the split (resource, floor and space writes are
 * superadmin-only); the page hides what a role cannot use so nobody is
 * offered a button that would only refuse them.
 *
 * Plan limits work the same way. The server refuses creations beyond the
 * plan (PLAN_LIMIT / PLAN_FEATURE); the page reads the same entitlements
 * (useOrg) and the same usage counts (GET /api/spaces/usage) so the setup
 * steps can say "3 of 5 rooms" and, at the cap, explain instead of
 * offering an Add that fails. Unmanaged organizations see none of it.
 */

const TOOL = {
  AVAILABILITY: "availability",
  PLACE: "place",
  REMOVE: "remove",
  ROOM: "room",
  ZONE: "zone",
  LABEL: "label",
};

export default function EditorPage() {
  const { org, organizationId, entitlements } = useOrg();
  const { user, booting, isAuthenticated } = useAuth();
  const { floorId } = useParams();
  const navigate = useNavigate();

  const [buildings, setBuildings] = useState(null);
  /** Plan usage, for a managed organization's limits; null when unlimited. */
  const [usage, setUsage] = useState(null);
  const [buildingOverride, setBuildingOverride] = useState(null);
  const [data, setData] = useState(null);
  const layoutRequest = useRef(0);

  const [tool, setTool] = useState(TOOL.AVAILABILITY);
  const [typeKey, setTypeKey] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);

  /** A rectangle dragged out with the Zone tool, waiting for its name. */
  const [pendingZone, setPendingZone] = useState(null);
  const [zoneName, setZoneName] = useState("");
  const [labelDraft, setLabelDraft] = useState({ text: "", col: 0, row: 0 });

  const [buildingDialog, setBuildingDialog] = useState(null);
  const [addingFloor, setAddingFloor] = useState(false);
  /** The room being created or configured, shown in RoomDialog. */
  const [roomDraft, setRoomDraft] = useState(null);
  /** A room whose level is being drawn — set between "Draw it" and the drag. */
  const [drawingRoom, setDrawingRoom] = useState(null);

  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const isSuperadmin = user?.role === "superadmin";

  /* ───────────────────────────── loading ───────────────────────────── */

  const loadSpaces = useCallback(() => {
    if (!organizationId) return;
    api
      .getSpaces(organizationId)
      .then((spaces) => setBuildings(spaces.buildings))
      .catch((err) => setError(err.message));
  }, [organizationId]);
  useEffect(loadSpaces, [loadSpaces]);

  const limited = isSuperadmin && Boolean(entitlements?.managed);
  const loadUsage = useCallback(() => {
    if (!limited) return;
    api
      .getSpaceUsage()
      .then((result) => setUsage(result.usage))
      .catch(() => setUsage(null));
  }, [limited]);
  useEffect(loadUsage, [loadUsage]);

  // Open the first floor when none is in the address.
  useEffect(() => {
    if (!buildings || floorId) return;
    const first = buildings.flatMap((building) => building.floors)[0];
    if (first) navigate(`/editor/${first.id}`, { replace: true });
  }, [buildings, floorId, navigate]);

  const load = useCallback(() => {
    if (!floorId) return;
    const request = ++layoutRequest.current;
    api
      .getFloorLayout(floorId)
      .then((layout) => {
        if (request !== layoutRequest.current) return;
        setData(layout);
        setError(null);
        setTypeKey((current) => current || layout.resourceTypes[0]?.key || null);
      })
      .catch((err) => request === layoutRequest.current && setError(err.message));
  }, [floorId]);
  useEffect(() => {
    setSelectedUnit(null);
    load();
    return () => {
      layoutRequest.current += 1;
    };
  }, [load]);

  const applyStatus = useCallback((resourceId, units) => {
    setData((current) => (current ? { ...current, status: { ...current.status, [resourceId]: units } } : current));
  }, []);
  useFloorSocket(floorId, applyStatus);

  const reloadAll = () => {
    loadSpaces();
    load();
    loadUsage();
  };

  // Staff never get the structural tools.
  useEffect(() => {
    if (!isSuperadmin && tool !== TOOL.AVAILABILITY) setTool(TOOL.AVAILABILITY);
  }, [isSuperadmin, tool]);

  // Drawing a level on another floor arrives here after navigation: bring
  // the map into view so the drag is the obvious next move.
  useEffect(() => {
    if (!drawingRoom || data?.floor.id !== floorId) return undefined;
    const frame = requestAnimationFrame(() => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("editor-canvas")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [drawingRoom, data?.floor.id, floorId]);

  /* ───────────────────────────── where we are ───────────────────────────── */

  const allBuildings = buildings || [];
  const building =
    allBuildings.find((candidate) => candidate.id === buildingOverride) ||
    allBuildings.find((candidate) => candidate.floors.some((floor) => floor.id === floorId));
  const floor = building?.floors.find((candidate) => candidate.id === floorId) || null;
  const visible = data?.floor.id === floorId && floor ? data : null;
  const canDraw = Boolean(building && !building.unassigned && floor);

  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user && !["staff", "superadmin"].includes(user.role)) {
    return (
      <Page>
        <Notice tone="error">The map editor is for staff.</Notice>
        <Link to="/map" className="mt-4 inline-block text-sm text-accent underline underline-offset-4">
          Back to the map
        </Link>
      </Page>
    );
  }

  /* ───────────────────────────── actions ───────────────────────────── */

  const act = async (action, successMessage) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
      load();
      loadUsage();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const openBuilding = (next) => {
    setBuildingOverride(next.id);
    setDrawingRoom(null);
    setSelectedUnit(null);
    if (next.floors[0]) navigate(`/editor/${next.floors[0].id}`);
  };
  const openFloor = (id) => {
    setSelectedUnit(null);
    navigate(`/editor/${id}`);
  };

  /** Draw a room — a new one, or another level of `room` on floor `onFloor`. */
  const drawRoom = (room = null, onFloor = floorId) => {
    setDrawingRoom(room);
    setTool(TOOL.ROOM);
    setSelectedUnit(null);
    if (onFloor && onFloor !== floorId) navigate(`/editor/${onFloor}`);
  };
  const stopDrawing = () => {
    setDrawingRoom(null);
    setTool(TOOL.AVAILABILITY);
  };

  /** Clicking a unit: remove its piece, or open its availability. */
  const onSelectUnit = (unit) => {
    setError(null);
    if (tool === TOOL.REMOVE && isSuperadmin) {
      act(() => api.removeResource(unit.resourceId), "Removed.");
      setSelectedUnit(null);
      return;
    }
    if (tool === TOOL.AVAILABILITY) setSelectedUnit(unit);
  };

  /**
   * A rectangle was dragged out. A zone needs only its name. A room needs
   * its name and how it is booked — RoomDialog asks for both, which is the
   * last step of the setup sequence.
   */
  const onRegionSelect = (rect) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.ZONE) setPendingZone(rect);
    if (tool !== TOOL.ROOM) return;
    if (!canDraw) {
      setError("Set up the building before drawing rooms.");
      return;
    }
    const existing = drawingRoom?.levels || [];
    const levels = [
      ...existing.filter((level) => level.floorId !== floorId),
      { floorId, name: existing.find((level) => level.floorId === floorId)?.name || "", bounds: rect },
    ];
    setRoomDraft({ bookingMode: "individual", name: "", ...drawingRoom, buildingId: building.id, levels });
    setDrawingRoom(null);
    setTool(TOOL.AVAILABILITY);
  };

  const onCellClick = (col, row) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.PLACE) act(() => api.placeResource({ floorId, resourceTypeKey: typeKey, col, row }));
    else if (tool === TOOL.LABEL) setLabelDraft((draft) => ({ ...draft, col, row }));
  };

  const setUnitState = (patch, message) =>
    act(() => api.adminSetUnit(selectedUnit.resourceId, selectedUnit.unitLabel, patch), message);

  const siblings = allBuildings.filter((candidate) => !candidate.unassigned && candidate.siteId === building?.siteId);
  const limits = {
    buildings: readLimit(entitlements, usage, "buildings"),
    floors: readLimit(entitlements, usage, "floors"),
    rooms: readLimit(entitlements, usage, "rooms"),
  };
  const unitLimit = readLimit(entitlements, usage, "resources", `bookable ${resourceNoun}`);

  const tools = [
    { value: TOOL.AVAILABILITY, label: "Availability", icon: CircleCheck },
    ...(isSuperadmin
      ? [
          { value: TOOL.PLACE, label: `Place ${resourceNoun}`, icon: MousePointerClick },
          { value: TOOL.REMOVE, label: "Remove", icon: Trash2 },
          // A NEW room needs a building and room left on the plan; drawing
          // another level of an existing room still works (from its settings).
          ...(canDraw && !limits.rooms?.blocked ? [{ value: TOOL.ROOM, label: "Room", icon: DoorOpen }] : []),
          { value: TOOL.ZONE, label: "Zone", icon: Layers },
          { value: TOOL.LABEL, label: "Label", icon: Tag },
        ]
      : []),
  ];

  const hint = {
    [TOOL.AVAILABILITY]: isSuperadmin
      ? `Click ${withArticle(resourceNoun)} to change its availability, or a room to open its settings.`
      : `Click ${withArticle(resourceNoun)} to mark it unavailable or out of service.`,
    [TOOL.PLACE]: "Click an empty cell to place the chosen piece.",
    [TOOL.REMOVE]: "Click a piece to remove it.",
    [TOOL.ROOM]: drawingRoom?.name
      ? `Drag a box for “${drawingRoom.name}” on ${floor?.name}.`
      : "Drag a box around the room, corner to corner. Next you'll name it and choose how it's booked.",
    [TOOL.ZONE]: "Drag a box on the map, then name the zone.",
    [TOOL.LABEL]: "Click the map to position the label, then add it.",
  }[tool];


  return (
    <Page>
      <PageHeader
        title={isSuperadmin ? "Map editor" : "Space controls"}
        subtitle={
          floor && building
            ? `${building.name} › ${floor.name}${visible ? ` · ${visible.floor.grid.cols} × ${visible.floor.grid.rows} cells` : ""}`
            : building?.name || "Loading…"
        }
        action={
          <Button icon={Eye} disabled={!visible} onClick={() => navigate(`/map/${floorId}`)}>
            View as member
          </Button>
        }
      />

      {/* Floors from before buildings existed, somewhere other than here:
          say so above everything, or they wait unnoticed in a dropdown. */}
      {isSuperadmin &&
        allBuildings
          .filter((group) => group.unassigned && group.id !== building?.id)
          .map((group) => (
            <div
              key={group.id}
              className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3"
              style={{ borderColor: "rgb(var(--c-state-reserved) / 0.45)", background: "rgb(var(--c-state-reserved) / 0.07)" }}
            >
              <Building2 size={18} className="shrink-0 text-state-reserved" />
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{group.name}</span> has {group.floors.length}{" "}
                {group.floors.length === 1 ? "floor" : "floors"} that {group.floors.length === 1 ? "isn't" : "aren't"} in a
                building yet.{" "}
                {limits.buildings?.blocked
                  ? "Your plan's buildings are all in use, so setting one up waits until the limit is raised."
                  : `Set one up to draw rooms there — nothing on ${group.floors.length === 1 ? "it" : "them"} changes.`}
              </p>
              <Button
                size="sm"
                variant={limits.buildings?.blocked ? "secondary" : "primary"}
                icon={Building2}
                onClick={() => openBuilding(group)}
              >
                {limits.buildings?.blocked ? `Open ${group.name}` : "Set up building"}
              </Button>
            </div>
          ))}

      {isSuperadmin ? (
        <SetupSteps
          buildings={allBuildings}
          building={building}
          floor={floor}
          resourceNoun={resourceNoun}
          drawing={tool === TOOL.ROOM}
          limits={limits}
          onBuilding={openBuilding}
          onFloor={openFloor}
          onAddBuilding={() => setBuildingDialog({ siteId: building?.siteId || visible?.floor.site.id })}
          onEditBuilding={() => setBuildingDialog({ building, siteId: building.siteId })}
          onAddFloor={() => setAddingFloor(true)}
          onDrawRoom={() => drawRoom(null)}
          onStopDrawing={stopDrawing}
        />
      ) : (
        <>
          <Notice className="mb-4">
            You can mark any {resourceNoun} unavailable or out of service, close and reopen rooms, and see their
            schedules. Changing the layout is a superadmin task.
          </Notice>
          <div className="flex flex-wrap items-end gap-4">
            {allBuildings.filter((candidate) => candidate.floors.length).length > 1 && (
              <BuildingSwitcher
                buildings={allBuildings.filter((candidate) => candidate.floors.length)}
                value={building?.id}
                onChange={openBuilding}
              />
            )}
            {building && <FloorTabs floors={building.floors} value={floorId} onChange={openFloor} className="editor-floors" />}
          </div>
        </>
      )}

      {/* ── The map and its tools — staff have one tool, so no toolbar ── */}
      {isSuperadmin && (
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented
            className="editortools"
            value={tool}
            onChange={(value) => (value === TOOL.ROOM ? drawRoom(null) : setTool(value))}
            options={tools}
          />
          {busy && <Spinner className="text-ink-muted" />}
        </div>
      )}
      <p className={`text-sm text-ink-secondary ${isSuperadmin ? "mt-2" : "mt-4"}`} role="status">
        {hint}
      </p>

      {tool === TOOL.PLACE && visible && (
        <div className="mt-3 space-y-3">
          {unitLimit && (
            <div className="max-w-md">
              <Usage {...unitLimit} />
            </div>
          )}
          {/* At the cap the catalog gives way to the reason. Short of it, a
              piece with more seats than are left is refused by the server
              with the same explanation. */}
          {!unitLimit?.blocked && (
            <Segmented
              className="catalog"
              size="sm"
              value={typeKey}
              onChange={setTypeKey}
              options={visible.resourceTypes.map((type) => ({
                value: type.key,
                label: `${type.label} · ${type.footprint.w}×${type.footprint.h} · ${type.seatCount}`,
              }))}
            />
          )}
        </div>
      )}

      {tool === TOOL.LABEL && isSuperadmin && (
        <LabelForm
          draft={labelDraft}
          onChange={setLabelDraft}
          onSubmit={() =>
            act(() => api.createLabel({ floorId, ...labelDraft }), "Label added.").then(() =>
              setLabelDraft((draft) => ({ ...draft, text: "" }))
            )
          }
        />
      )}

      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mt-3">
          {notice}
        </Notice>
      )}

      <Card id="editor-canvas" padded={false} className="mt-3 overflow-hidden">
        {visible ? (
          <SpaceMap
            floor={visible.floor}
            layout={visible.layout}
            resourceTypes={visible.resourceTypes}
            status={visible.status}
            resourceNoun={resourceNoun}
            showOverstay
            palette={palette}
            selectedUnit={selectedUnit}
            onSelectUnit={onSelectUnit}
            onSelectRoom={isSuperadmin && tool === TOOL.AVAILABILITY ? (room) => setRoomDraft(room) : undefined}
            onCellClick={onCellClick}
            management
            regionMode={isSuperadmin && (tool === TOOL.ZONE || tool === TOOL.ROOM)}
            onRegionSelect={onRegionSelect}
            editing={isSuperadmin && tool !== TOOL.REMOVE && tool !== TOOL.AVAILABILITY}
          />
        ) : (
          <div className="h-[46vh] p-4">
            {building && !building.floors.length ? (
              <EmptyState
                icon={Layers}
                title={`${building.name} has no floors yet`}
                body={isSuperadmin ? "Add its first floor in step 2 above, then draw its rooms." : "A superadmin adds floors."}
              />
            ) : (
              <Skeleton className="h-full w-full" rounded="rounded-md" />
            )}
          </div>
        )}
      </Card>

      {/* ADM-2 — availability, the one editing power staff also have. */}
      {tool === TOOL.AVAILABILITY && selectedUnit && (
        <AvailabilityPanel
          unit={selectedUnit}
          resourceNoun={resourceNoun}
          busy={busy}
          onClose={() => setSelectedUnit(null)}
          onSet={setUnitState}
        />
      )}

      {visible && (
        <RoomManager
          rooms={visible.layout.rooms || []}
          floor={visible.floor}
          floors={building?.floors}
          status={visible.status}
          resourceNoun={resourceNoun}
          isSuperadmin={isSuperadmin}
          canDraw={canDraw}
          onSaved={reloadAll}
          onConfigure={setRoomDraft}
          onError={setError}
        />
      )}

      {isSuperadmin && visible && (
        <FloorSettings
          floor={visible.floor}
          buildings={siblings}
          onChanged={(result) => {
            loadSpaces();
            load();
            if (result?.floor?.buildingId && result.floor.buildingId !== building?.id) setBuildingOverride(result.floor.buildingId);
          }}
          onDeleted={() => {
            setBuildingOverride(building?.unassigned ? null : building?.id);
            loadSpaces();
            navigate("/editor", { replace: true });
          }}
        />
      )}

      {visible && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ListPanel
            title={`Zones (${visible.layout.zones.length})`}
            readOnly={!isSuperadmin}
            emptyHint="Use the Zone tool to drag one out."
            items={visible.layout.zones.map((zone) => ({
              id: zone.id,
              primary: zone.name,
              secondary: `${zone.bounds.w} × ${zone.bounds.h} at (${zone.bounds.col}, ${zone.bounds.row})`,
            }))}
            onRemove={(id) => act(() => api.deleteZone(id), "Zone removed.")}
          />
          <ListPanel
            title={`Labels (${visible.layout.labels.length})`}
            readOnly={!isSuperadmin}
            emptyHint="Use the Label tool to place one."
            items={visible.layout.labels.map((label) => ({
              id: label.id,
              primary: label.text,
              secondary: `(${label.position.col}, ${label.position.row})`,
            }))}
            onRemove={(id) => act(() => api.deleteLabel(id), "Label removed.")}
          />
        </div>
      )}

      <p className="mt-4 text-xs text-ink-muted">
        Fixed footprints, whole cells, no rotation — that constraint is what keeps the editor simple. Overlaps and
        bounds are checked on the server.
      </p>

      {/* ── Dialogs ── */}

      {roomDraft && (
        <RoomDialog
          key={roomDraft.id || "new"}
          draft={roomDraft}
          floors={building?.floors || []}
          resourceNoun={resourceNoun}
          wholeRoomAllowed={entitlements?.hasFeature("wholeRoomBooking") ?? true}
          onClose={() => setRoomDraft(null)}
          onSaved={reloadAll}
          onDraw={drawRoom}
        />
      )}

      {buildingDialog && (
        <BuildingDialog
          building={buildingDialog.building}
          siteId={buildingDialog.siteId}
          onClose={() => setBuildingDialog(null)}
          onSaved={(result) => {
            setBuildingOverride(result?.building?.id || null);
            reloadAll();
          }}
        />
      )}

      {building && !building.unassigned && (
        <AddFloorDialog
          open={addingFloor}
          building={building}
          onClose={() => setAddingFloor(false)}
          onCreated={(created) => {
            loadSpaces();
            loadUsage();
            if (created?.floor?.id) navigate(`/editor/${created.floor.id}`);
          }}
        />
      )}

      <Modal
        open={Boolean(pendingZone)}
        onClose={() => {
          setPendingZone(null);
          setZoneName("");
        }}
        title="Name this zone"
        subtitle={pendingZone ? `${pendingZone.w} × ${pendingZone.h} cells at (${pendingZone.col}, ${pendingZone.row})` : ""}
        icon={Layers}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const rect = pendingZone;
            const name = zoneName.trim();
            if (!rect || !name) return;
            setPendingZone(null);
            setZoneName("");
            act(() => api.createZone({ floorId, name, ...rect }), `Zone "${name}" added.`);
          }}
        >
          <Field
            label="Zone name"
            data-autofocus
            required
            placeholder="Quiet study"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
          />
          <div className="mt-5 flex justify-end gap-3">
            <Button
              onClick={() => {
                setPendingZone(null);
                setZoneName("");
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!zoneName.trim()}>
              Add zone
            </Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
}

/* ─────────────────────── availability (ADM-2) ─────────────────────── */

function AvailabilityPanel({ unit, resourceNoun, busy, onClose, onSet }) {
  const current = unit.status?.status;
  const outOfService = unit.status?.serviceStatus === "out_of_service";
  // Occupied and reserved come from a reservation; the server refuses to
  // set them by hand, so they are not offered.
  const derived = current === "occupied" || current === "reserved";

  return (
    <Panel
      className="mt-4"
      title={`${unit.type.label} · ${resourceNoun} ${unit.unitLabel}`}
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-secondary">Currently</span>
        <Badge tone={current}>{unit.statusLabel}</Badge>
      </div>

      {derived ? (
        <Notice>
          This {resourceNoun} is {current} because of a live reservation. Cancel it from the room's schedule or the
          console's Resources view to free it.
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            icon={CircleCheck}
            disabled={busy || (current === "available" && !outOfService)}
            onClick={() => onSet({ status: "available", serviceStatus: "working" }, "Marked available.")}
          >
            Available
          </Button>
          <Button
            icon={Ban}
            disabled={busy || (current === "unavailable" && !outOfService)}
            onClick={() => onSet({ status: "unavailable" }, "Marked unavailable.")}
          >
            Unavailable
          </Button>
          {unit.type.hasServiceStatus && (
            <Button
              icon={Wrench}
              disabled={busy}
              onClick={() =>
                onSet(
                  outOfService ? { serviceStatus: "working", status: "available" } : { serviceStatus: "out_of_service" },
                  outOfService ? "Marked working." : "Marked out of service."
                )
              }
            >
              {outOfService ? "Mark working" : "Out of service"}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────────── bits ─────────────────────────────── */

/** MAP-5: free text at a cell — the click on the map sets the position. */
function LabelForm({ draft, onChange, onSubmit }) {
  return (
    <Card className="mt-3 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <Field
          label="Text"
          required
          className="w-48"
          value={draft.text}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
        {["col", "row"].map((axis) => (
          <Field
            key={axis}
            label={axis === "col" ? "Col" : "Row"}
            type="number"
            className="w-20"
            value={draft[axis]}
            onChange={(e) => onChange({ ...draft, [axis]: Number(e.target.value) })}
          />
        ))}
        <Button type="submit" variant="primary">
          Add label
        </Button>
      </form>
      <p className="mt-2 text-xs text-ink-muted">Orientation text only — not bookable, and left out of reports.</p>
    </Card>
  );
}

function ListPanel({ title, items, onRemove, readOnly, emptyHint }) {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <EmptyState title="None yet" body={readOnly ? "A superadmin adds these." : emptyHint} />
      ) : (
        <ul className="divide-y divide-line/10">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="mr-auto text-ink-primary">{item.primary}</span>
              <span className="text-xs text-ink-muted">{item.secondary}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="rounded-sm text-ink-muted transition-colors duration-fast ease-out hover:text-state-unavailable"
                  aria-label={`Remove ${item.primary}`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
