import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Ban, Building2, CircleCheck, DoorOpen, Layers, MousePointerClick, Plus, Tag, Trash2, Wrench } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import SpaceMap from "../components/SpaceMap.jsx";
import RoomManager, { RoomDialog, BuildingDialog } from "../components/RoomManager.jsx";
import GridSketch from "../components/GridSketch.jsx";
import {
  Badge, Button, Card, EmptyState, Field, Loading, Modal, Notice, Page, PageHeader, Panel,
  Segmented, Select, Skeleton, Spinner,
} from "../components/ui/index.jsx";

/**
 * EditorPage — MAP-3, MAP-4, MAP-5 and floor management (spec §12, §14).
 *
 * "One shared layout model renders both the admin editor and the
 * member-facing map", so this reuses SpaceMap unchanged and adds an
 * editing layer on top.
 *
 * ── Roles ──────────────────────────────────────────────────────────
 * The two admin roles get genuinely different powers here, matching
 * spec §14's split between running the space and configuring it:
 *
 *   staff       availability only — mark a desk unavailable, or a
 *               machine out of service. They operate the space.
 *   superadmin  everything above, plus placing and removing pieces,
 *               zones, labels, and the floors themselves. They define
 *               what the space IS.
 *
 * The gate is enforced on the server (the resource and floor-write
 * routes are superadmin-only); hiding tools here is so staff aren't
 * offered buttons that would only ever 403.
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
  const { org, organizationId } = useOrg();
  const { user, booting, isAuthenticated } = useAuth();
  const { floorId } = useParams();
  const navigate = useNavigate();

  const [floors, setFloors] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [buildingOverride, setBuildingOverride] = useState(null);
  const [buildingDialog, setBuildingDialog] = useState(null);
  const [roomDraft, setRoomDraft] = useState(null);
  const [drawingRoom, setDrawingRoom] = useState(null);
  const [data, setData] = useState(null);
  const layoutRequest = useRef(0);
  const [tool, setTool] = useState(TOOL.AVAILABILITY);
  const [typeKey, setTypeKey] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);
  /** A rectangle drawn on the map, waiting for its name. */
  const [pendingZone, setPendingZone] = useState(null);
  const [zoneName, setZoneName] = useState("");
  const [labelDraft, setLabelDraft] = useState({ text: "", col: 0, row: 0 });

  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const isSuperadmin = user?.role === "superadmin";

  const loadFloors = useCallback(() => {
    Promise.all([api.getFloors(organizationId), api.getSpaces(organizationId)]).then(([d, spaces]) => {
      setFloors(d.floors);
      setBuildings(spaces.buildings);
      if (!floorId && d.floors.length) navigate(`/editor/${d.floors[0].id}`, { replace: true });
    }).catch((e) => setError(e.message));
  }, [floorId, navigate, organizationId]);
  useEffect(loadFloors, [loadFloors]);

  const load = useCallback(() => {
    if (!floorId) return;
    const request = ++layoutRequest.current;
    api
      .getFloorLayout(floorId)
      .then((d) => {
        if (request !== layoutRequest.current) return;
        setData(d);
        setError(null);
        setTypeKey((current) => current || d.resourceTypes[0]?.key || null);
      })
      .catch((e) => { if (request === layoutRequest.current) setError(e.message); });
  }, [floorId]);
  useEffect(() => { setSelectedUnit(null); load(); return () => { layoutRequest.current++; }; }, [load]);
  const applyStatus = useCallback((resourceId, units) => {
    setData((current) => current ? { ...current, status: { ...current.status, [resourceId]: units } } : current);
  }, []);
  useFloorSocket(floorId, applyStatus);
  useEffect(() => {
    if (!drawingRoom || data?.floor.id !== floorId) return undefined;
    const frame = requestAnimationFrame(() => document.getElementById("editor-canvas")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [drawingRoom, data?.floor.id, floorId]);

  // Staff never get the structural tools, so make sure the selected one
  // is legal for this role.
  useEffect(() => {
    if (!isSuperadmin && tool !== TOOL.AVAILABILITY) setTool(TOOL.AVAILABILITY);
  }, [isSuperadmin, tool]);

  const currentBuilding = buildings.find((b) => b.id === buildingOverride) || buildings.find((b) => b.floors.some((f) => f.id === floorId));
  const visibleData = data?.floor.id === floorId && currentBuilding?.floors.some((f) => f.id === floorId) ? data : null;
  const drawRoom = (room, id) => {
    setDrawingRoom(room); setTool(TOOL.ROOM); setSelectedUnit(null);
    if (id && id !== floorId) navigate(`/editor/${id}`);
  };
  const reloadSpaces = () => { loadFloors(); load(); };

  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user && !["staff", "superadmin"].includes(user.role)) {
    return (
      <Page>
        <Notice tone="error">The map editor is a staff surface.</Notice>
        <Link to="/map" className="mt-4 inline-block text-sm text-accent underline underline-offset-4">
          Back to the map
        </Link>
      </Page>
    );
  }

  const act = async (fn, successMessage) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Clicking a unit: remove its piece, or open the availability panel. */
  const onSelectUnit = (unit) => {
    setError(null);
    if (tool === TOOL.REMOVE && isSuperadmin) {
      act(() => api.removeResource(unit.resourceId), "Removed.");
      setSelectedUnit(null);
      return;
    }
    if (tool === TOOL.AVAILABILITY) setSelectedUnit(unit);
  };

  /** Clicking an empty cell places, or seeds a zone/label position. */
  /**
   * A rectangle was dragged out. Zones need a name, so the geometry is
   * held and the dialog asks for the one thing a drag cannot express.
   */
  const onRegionSelect = (rect) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.ZONE) setPendingZone(rect);
    if (tool === TOOL.ROOM) {
      if (!currentBuilding || currentBuilding.unassigned) { setError("Set up a building before drawing rooms."); return; }
      const levels = [...(drawingRoom?.levels || []).filter((l) => l.floorId !== floorId), { floorId, name: drawingRoom?.levels.find((l) => l.floorId === floorId)?.name || "", bounds: rect }];
      setRoomDraft({ ...drawingRoom, buildingId: currentBuilding.id, levels });
      setDrawingRoom(null);
    }
  };

  const onCellClick = (col, row) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.PLACE) {
      act(() => api.placeResource({ floorId, resourceTypeKey: typeKey, col, row }));
    } else if (tool === TOOL.LABEL) {
      setLabelDraft((l) => ({ ...l, col, row }));
    }
  };

  const setUnitState = (patch, message) =>
    act(() => api.adminSetUnit(selectedUnit.resourceId, selectedUnit.unitLabel, patch), message);

  const tools = [
    { value: TOOL.AVAILABILITY, label: "Availability", icon: CircleCheck, title: "ADM-2 — staff & superadmin" },
    ...(isSuperadmin
      ? [
          { value: TOOL.PLACE, label: `Place ${resourceNoun}`, icon: MousePointerClick, title: "MAP-3" },
          { value: TOOL.REMOVE, label: "Remove", icon: Trash2, title: "MAP-3" },
          { value: TOOL.ROOM, label: "Room", icon: DoorOpen, title: "Room boundary and booking rules" },
          { value: TOOL.ZONE, label: "Zone", icon: Layers, title: "MAP-4" },
          { value: TOOL.LABEL, label: "Label", icon: Tag, title: "MAP-5" },
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title={isSuperadmin ? "Map editor" : "Space controls"}
        subtitle={
          visibleData
            ? `${data.floor.site.name} · ${data.floor.name} · ${data.floor.grid.cols}×${data.floor.grid.rows}`
            : currentBuilding?.floors.length === 0 ? `${currentBuilding.name} · No floors yet` : "Loading…"
        }
        action={<Button disabled={!visibleData} onClick={() => navigate(`/map/${floorId}`)}>View as member</Button>}
      />

      {!isSuperadmin && (
        <Notice className="mb-4">
          You can change any {resourceNoun}'s availability here. Placing or removing them, and editing
          floors, is a superadmin task.
        </Notice>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-line/10 bg-bg-card/50 p-3">
        <Select label="Building" value={currentBuilding?.id || ""} onChange={(e) => { const b = buildings.find((v) => v.id === e.target.value); setBuildingOverride(b.id); setDrawingRoom(null); if (b.floors[0]) { setSelectedUnit(null); navigate(`/editor/${b.floors[0].id}`); } }} className="min-w-44">{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}{b.unassigned ? " · needs setup" : ""}</option>)}</Select>
        <Select label="Floor" value={currentBuilding?.floors.some((f) => f.id === floorId) ? floorId : ""} onChange={(e) => { setSelectedUnit(null); navigate(`/editor/${e.target.value}`); }} className="min-w-40"><option value="" disabled>Select floor</option>{(currentBuilding?.floors || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
        {isSuperadmin && <><Button icon={Plus} size="sm" onClick={() => setBuildingDialog({ create: true, siteId: currentBuilding?.siteId || data?.floor.site.id })}>Add building</Button>
          {currentBuilding && <Button size="sm" icon={Building2} onClick={() => setBuildingDialog({ building: currentBuilding, siteId: currentBuilding.siteId })}>{currentBuilding.unassigned ? "Set up building" : "Rename building"}</Button>}</>}
      </div>
      {tool === TOOL.ROOM && <Notice className="mb-3">{drawingRoom ? `Draw a level for “${drawingRoom.name || "this room"}” on the selected floor.` : "Drag a room boundary, then choose whether it is booked as a whole, individually, or either."}</Notice>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Segmented className="editortools" value={tool} onChange={setTool} options={tools} />
        {busy && <Spinner className="text-ink-muted" />}
      </div>

      {/* Catalog palette (spec §8: pick-from-palette, fixed footprints) */}
      {tool === TOOL.PLACE && data && (
        <div className="mb-3">
          <Segmented
            className="catalog"
            size="sm"
            value={typeKey}
            onChange={setTypeKey}
            options={data.resourceTypes.map((t) => ({
              value: t.key,
              label: `${t.label} · ${t.footprint.w}×${t.footprint.h} · ${t.seatCount}`,
            }))}
          />
        </div>
      )}

      {/*
        Zones are DRAWN, not typed.
        This asked for a corner by click and then width and height as
        numbers, which is the wrong instrument for a spatial editor: you
        know where the room is, you do not know that it is 7 cells wide.
        Drag the box on the map and name it afterwards.
      */}
      {tool === TOOL.ZONE && isSuperadmin && (
        <Notice className="mb-4">
          Drag a box on the map to draw a zone. Membership is derived from position — nothing is tagged
          by hand.
        </Notice>
      )}

      {tool === TOOL.LABEL && isSuperadmin && (
        <InlineForm
          onSubmit={() =>
            act(() => api.createLabel({ floorId, ...labelDraft }), "Label added.").then(() =>
              setLabelDraft((l) => ({ ...l, text: "" }))
            )
          }
          fields={[
            { label: "Text", value: labelDraft.text, onChange: (v) => setLabelDraft((l) => ({ ...l, text: v })) },
            { label: "Col", value: labelDraft.col, type: "number", onChange: (v) => setLabelDraft((l) => ({ ...l, col: +v })) },
            { label: "Row", value: labelDraft.row, type: "number", onChange: (v) => setLabelDraft((l) => ({ ...l, row: +v })) },
          ]}
          submitLabel="Add label"
          hint="Orientation text only — not reservable, excluded from analytics."
        />
      )}

      {error && (
        <Notice tone="error" className="mb-3">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-3">
          {notice}
        </Notice>
      )}

      <Card id="editor-canvas" padded={false} className="overflow-hidden">
        {visibleData ? (
          <SpaceMap
            floor={data.floor}
            layout={data.layout}
            resourceTypes={data.resourceTypes}
            status={data.status}
            resourceNoun={resourceNoun}
            showOverstay
            palette={palette}
            selectedUnit={selectedUnit}
            onSelectUnit={onSelectUnit}
            onCellClick={onCellClick}
            management
            regionMode={isSuperadmin && (tool === TOOL.ZONE || tool === TOOL.ROOM)}
            onRegionSelect={onRegionSelect}
            editing={isSuperadmin && tool !== TOOL.REMOVE && tool !== TOOL.AVAILABILITY}
          />
        ) : (
          <div className="h-[46vh] p-4">
            {currentBuilding && !currentBuilding.floors.length ? <EmptyState icon={Layers} title="Add this building's first floor" body="Use Add floor below to create a grid, then draw its rooms." /> : <Skeleton className="w-full h-full" rounded="rounded-md" />}
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-ink-muted">
        {tool === TOOL.AVAILABILITY && `Click any ${resourceNoun} to change its availability.`}
        {tool === TOOL.PLACE && "Click an empty cell to place the selected piece."}
        {tool === TOOL.REMOVE && "Click a piece to remove it."}
        {tool === TOOL.ROOM && "Drag a box to define the room. Use Configure to add its other levels."}
        {tool === TOOL.ZONE && "Drag a box on the map, then name it."}
        {tool === TOOL.LABEL && "Click the map to set the position, then submit above."}
      </p>

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

      {visibleData && <RoomManager rooms={data.layout.rooms || []} floor={data.floor} building={currentBuilding} floors={floors} status={data.status} isSuperadmin={isSuperadmin} onSaved={reloadSpaces} onDraw={drawRoom} onError={setError} />}
      {roomDraft && <RoomDialog draft={roomDraft} floors={currentBuilding?.floors || floors} onClose={() => setRoomDraft(null)} onSaved={reloadSpaces} onDraw={drawRoom} />}
      {buildingDialog && <BuildingDialog building={buildingDialog.building} siteId={buildingDialog.siteId} onClose={() => setBuildingDialog(null)} onSaved={(result) => { setBuildingOverride(result?.building?.id || null); reloadSpaces(); }} />}

      {visibleData && (
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <ListPanel
            title={`Zones (${data.layout.zones.length})`}
            readOnly={!isSuperadmin}
            items={data.layout.zones.map((z) => ({
              id: z.id,
              primary: z.name,
              secondary: `(${z.bounds.col}, ${z.bounds.row}) ${z.bounds.w}×${z.bounds.h}`,
            }))}
            onRemove={(id) => act(() => api.deleteZone(id), "Zone removed.")}
          />
          <ListPanel
            title={`Labels (${data.layout.labels.length})`}
            readOnly={!isSuperadmin}
            items={data.layout.labels.map((l) => ({
              id: l.id,
              primary: l.text,
              secondary: `(${l.position.col}, ${l.position.row})`,
            }))}
            onRemove={(id) => act(() => api.deleteLabel(id), "Label removed.")}
          />
        </div>
      )}

      {isSuperadmin && (
        <FloorManager
          floors={currentBuilding?.floors || floors}
          buildings={buildings.filter((b) => !b.unassigned && b.siteId === currentBuilding?.siteId)}
          building={currentBuilding}
          current={visibleData?.floor}
          busy={busy}
          onChanged={(created) => {
            loadFloors();
            if (created?.floor?.id) navigate(`/editor/${created.floor.id}`);
            else load();
          }}
          onError={setError}
          onNotice={setNotice}
          onDeleted={(id) => {
            if (id === floorId) navigate("/editor", { replace: true });
          }}
        />
      )}

      <p className="mt-4 text-xs text-ink-muted">
        Fixed footprints, integer cells, no rotation — that constraint is what keeps the editor simple.
        Overlap and bounds are enforced server-side.
      </p>
      <Modal
        open={Boolean(pendingZone)}
        onClose={() => { setPendingZone(null); setZoneName(""); }}
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
            placeholder="Quiet Study"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
          />
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => { setPendingZone(null); setZoneName(""); }}>Cancel</Button>
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
  const oos = unit.status?.serviceStatus === "out_of_service";
  // Occupied/reserved are derived from reservations — the server refuses
  // to set them directly, so don't offer it.
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
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="text-ink-secondary">Currently</span>
        <Badge tone={current}>{unit.statusLabel}</Badge>
        <span className="text-xs text-ink-muted">
          at ({unit.position.col}, {unit.position.row})
        </span>
      </div>

      {derived ? (
        <Notice>
          This {resourceNoun} is {current} because of a live reservation. Cancel it from the console's
          Resources &amp; Rules view to free it.
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            icon={CircleCheck}
            disabled={busy || (current === "available" && !oos)}
            onClick={() => onSet({ status: "available", serviceStatus: "working" }, "Marked available.")}
          >
            Available
          </Button>
          <Button
            icon={Ban}
            disabled={busy || (current === "unavailable" && !oos)}
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
                  oos ? { serviceStatus: "working", status: "available" } : { serviceStatus: "out_of_service" },
                  oos ? "Marked working." : "Marked out of service."
                )
              }
            >
              {oos ? "Mark working" : "Out of service"}
            </Button>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        Staff and superadmins can both change availability. Only a superadmin can add or remove{" "}
        {resourceNoun}s.
      </p>
    </Panel>
  );
}

/* ───────────────────── floors (superadmin only) ───────────────────── */

function FloorManager({ floors, buildings, building, current, busy, onChanged, onError, onNotice, onDeleted }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", cols: 20, rows: 12 });
  const [resize, setResize] = useState(null);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const isBusy = busy || running;

  useEffect(() => {
    if (current) setResize({ name: current.name, cols: current.grid.cols, rows: current.grid.rows, buildingId: current.building?.id || "" });
  }, [current?.id, current?.grid?.cols, current?.grid?.rows, current?.name, current?.building?.id]);

  const run = async (fn, message) => {
    onError(null);
    onNotice(null);
    setRunning(true);
    try {
      const result = await fn();
      onNotice(message);
      onChanged(result);
      return true;
    } catch (e) {
      onError(e.message);
      return false;
    } finally { setRunning(false); }
  };

  return (
    <Panel
      className="mt-4"
      title="Floors"
      icon={Layers}
      action={
        <Button size="sm" icon={Plus} disabled={isBusy} onClick={() => setAdding(true)}>
          Add floor
        </Button>
      }
    >
      {/*
        A dialog, not a toggle that grows a form out of the panel.
        "Add floor" pushed the floor list down while you were reading it
        and turned its own trigger into a Cancel button, so the control
        you pressed changed meaning underneath the cursor.
      */}
      <Modal
        open={adding}
        onClose={isBusy ? undefined : () => setAdding(false)}
        title="Add a floor"
        subtitle="Give it a name and a grid size. Both can be changed later."
        icon={Layers}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () => api.createFloor({ name: draft.name, ...(building && !building.unassigned ? { buildingId: building.id } : {}), grid: { cols: draft.cols, rows: draft.rows } }),
              `Added "${draft.name}".`
            );
            if (ok) {
              setDraft({ name: "", cols: 20, rows: 12 });
              setAdding(false);
            }
          }}
        >
          <Field
            label="Floor name"
            required
            data-autofocus
            placeholder="Second Floor"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {/* Sketch the room rather than describing it in two numbers.
              The fields stay, below, for whoever does know the figure —
              the drag sets them and they set the drag. */}
          <div className="mt-4">
            <span className="text-sm font-medium text-ink-secondary">Floor size</span>
            <div className="mt-1.5">
              <GridSketch
                cols={draft.cols}
                rows={draft.rows}
                onChange={({ cols, rows }) => setDraft((d) => ({ ...d, cols, rows }))}
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field
              label="Columns"
              type="number"
              min={1}
              max={60}
              value={draft.cols}
              onChange={(e) => setDraft((d) => ({ ...d, cols: Number(e.target.value) }))}
            />
            <Field
              label="Rows"
              type="number"
              min={1}
              max={60}
              value={draft.rows}
              onChange={(e) => setDraft((d) => ({ ...d, rows: Number(e.target.value) }))}
            />
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button disabled={isBusy} onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!draft.name.trim() || isBusy}>
              {running ? "Creating…" : "Create floor"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rename / resize the floor currently open */}
      {current && resize && (
        <form
          className="flex flex-wrap gap-2 items-end mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                api.updateFloor(current.id, {
                  name: resize.name,
                  ...(resize.buildingId ? { buildingId: resize.buildingId } : {}),
                  grid: { cols: resize.cols, rows: resize.rows },
                }),
              "Floor updated."
            );
          }}
        >
          <Field
            label="Name"
            value={resize.name}
            onChange={(e) => setResize((r) => ({ ...r, name: e.target.value }))}
            className="w-48"
          />
          {buildings.length > 1 && <Select label="Building" value={resize.buildingId} onChange={(e) => setResize((r) => ({ ...r, buildingId: e.target.value }))}>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}
          <Field
            label="Columns"
            type="number"
            min={1}
            max={60}
            value={resize.cols}
            onChange={(e) => setResize((r) => ({ ...r, cols: Number(e.target.value) }))}
            className="w-24"
          />
          <Field
            label="Rows"
            type="number"
            min={1}
            max={60}
            value={resize.rows}
            onChange={(e) => setResize((r) => ({ ...r, rows: Number(e.target.value) }))}
            className="w-24"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            Save size
          </Button>
        </form>
      )}

      <ul className="divide-y divide-line/10">
        {floors.map((f) => (
          <li key={f.id} className="py-2 flex items-center gap-3 text-sm">
            <span className="text-ink-primary mr-auto">
              {f.name}
              {current?.id === f.id && <span className="ml-2 text-xs text-ink-muted">(editing)</span>}
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {f.grid.cols}×{f.grid.rows}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="border border-line/10"
              disabled={isBusy}
              title="Delete this floor"
              onClick={() => setDeleting(f)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <Modal open={Boolean(deleting)} onClose={isBusy ? undefined : () => setDeleting(null)} title="Remove floor" subtitle={deleting?.name} icon={Trash2}>
        <p className="text-sm leading-relaxed text-ink-secondary">Only an empty floor can be removed. Move or remove its rooms and furniture first. Booking history is kept.</p>
        <div className="mt-5 flex justify-end gap-2"><Button disabled={isBusy} onClick={() => setDeleting(null)}>Keep floor</Button><Button variant="danger" disabled={isBusy} onClick={async () => { const id = deleting.id; const ok = await run(() => api.deleteFloor(id), `Removed "${deleting.name}".`); if (ok) { setDeleting(null); onDeleted(id); } }}>{running ? "Removing…" : "Remove floor"}</Button></div>
      </Modal>
      <p className="mt-3 text-xs text-ink-muted">
        Shrinking a floor is refused while anything would fall outside the new bounds, and a floor with
        placed items or live reservations can't be deleted.
      </p>
    </Panel>
  );
}

/* ─────────────────────────────── bits ─────────────────────────────── */

function InlineForm({ fields, onSubmit, submitLabel, hint }) {
  return (
    <Card className="mb-3 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex flex-wrap gap-2 items-end"
      >
        {fields.map((f) => (
          <Field
            key={f.label}
            label={f.label}
            required
            type={f.type || "text"}
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
            className={f.type === "number" ? "w-20" : "w-48"}
          />
        ))}
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
      </form>
      {hint && <p className="text-xs text-ink-muted mt-2">{hint}</p>}
    </Card>
  );
}

function ListPanel({ title, items, onRemove, readOnly }) {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <EmptyState
          title="None yet"
          body={readOnly ? "A superadmin can add these." : "Use the tool above to add one."}
        />
      ) : (
        <ul className="divide-y divide-line/10">
          {items.map((i) => (
            <li key={i.id} className="py-2 flex items-center gap-2 text-sm">
              <span className="text-ink-primary mr-auto">{i.primary}</span>
              <span className="text-xs text-ink-muted">{i.secondary}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onRemove(i.id)}
                  className="text-ink-muted hover:text-state-unavailable transition-colors duration-fast ease-out rounded-sm"
                  aria-label={`Remove ${i.primary}`}
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
