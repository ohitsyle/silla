import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  Ban, Building2, Check, CircleCheck, DoorOpen, Eye, LandPlot, Layers, MousePointerClick, RotateCcw, SquareMinus,
  SquarePlus, Tag, Trash2, Undo2, Wrench,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import { readLimit, withArticle } from "../lib/rooms.js";
import {
  areasOf, boundingBox, cellsOf, difference, floorAreas, floorCells, intersection, isRectangle, regionAreas, union,
} from "../lib/cells.js";
import { outlineSummary, shapeSize } from "../lib/shapeWords.js";
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
 *
 * ── Shapes ─────────────────────────────────────────────────────────
 * Floors, rooms and zones need not be rectangles (lib/cells.js). Each is
 * reshaped the same way: drag a rectangle on the map to add its cells or
 * to cut them away, and watch the result before letting go.
 *
 *   floor   the Shape tool: a draft outline with Undo, Reset to
 *           rectangle and Save; a refused save says what is in the way
 *           and the map flags it
 *   room    "Add to room" / "Cut from room" in its settings; the dialog
 *           comes back with the new shape, saved with the rest of it
 *   zone    the same two actions in the zones list, saved at once
 */

const TOOL = {
  AVAILABILITY: "availability",
  PLACE: "place",
  REMOVE: "remove",
  ROOM: "room",
  ZONE: "zone",
  LABEL: "label",
  SHAPE: "shape",
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

  /** A zone dragged out with the Zone tool (its areas, on the floor), waiting for its name. */
  const [pendingZone, setPendingZone] = useState(null);
  const [zoneName, setZoneName] = useState("");
  const [labelDraft, setLabelDraft] = useState({ text: "", col: 0, row: 0 });

  const [buildingDialog, setBuildingDialog] = useState(null);
  const [addingFloor, setAddingFloor] = useState(false);
  /** The room being created or configured, shown in RoomDialog. */
  const [roomDraft, setRoomDraft] = useState(null);
  /**
   * A room whose level is being drawn or reshaped — set between "Draw it"
   * (or "Add to room" / "Cut from room") and the drag. `drawMode` is
   * "draw", "add" or "cut".
   */
  const [drawingRoom, setDrawingRoom] = useState(null);

  /**
   * The Shape tool's draft of this floor's outline: `areas`, the edits
   * before it for Undo, and whether a drag adds or cuts. Null outside the
   * tool; leaving the tool drops an unsaved draft.
   */
  const [outline, setOutline] = useState(null);
  /** A refused save of the outline: the server's reason, and the ids it named. */
  const [outlineRefusal, setOutlineRefusal] = useState(null);
  /** A zone being reshaped from the zones list: { id, name, areas, mode }. */
  const [zoneEdit, setZoneEdit] = useState(null);

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

  // Another floor, another outline: nothing drafted on this one carries over.
  useEffect(() => {
    setOutline(null);
    setOutlineRefusal(null);
    setZoneEdit(null);
  }, [floorId]);

  // The Shape tool starts from the floor's saved outline (the whole grid,
  // for a floor that has never had one), and starts again after a save.
  const savedOutline = visible ? floorAreas(visible.floor) : null;
  const savedOutlineKey = JSON.stringify(savedOutline);
  useEffect(() => {
    if (tool !== TOOL.SHAPE) {
      setOutline(null);
      setOutlineRefusal(null);
      return;
    }
    // A floor that is the whole grid has nothing around it to add, so the
    // first drag cuts; a shaped one more often grows.
    if (savedOutline && !outline) {
      setOutline({ areas: savedOutline, history: [], mode: visible.floor.shape?.areas?.length ? "add" : "cut" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, savedOutlineKey, outline]);

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

  /**
   * Draw a room — a new one, or a level of `room` on floor `onFloor`:
   * drawn afresh ("draw"), or added to or cut from its current shape.
   */
  const drawRoom = (room = null, onFloor = floorId, mode = "draw") => {
    setDrawingRoom(room ? { ...room, drawMode: mode } : null);
    setZoneEdit(null);
    setTool(TOOL.ROOM);
    setSelectedUnit(null);
    if (onFloor && onFloor !== floorId) navigate(`/editor/${onFloor}`);
  };
  const stopDrawing = () => {
    setDrawingRoom(null);
    setTool(TOOL.AVAILABILITY);
  };

  /** The toolbar: picking a tool ends whatever reshape was under way. */
  const chooseTool = (value) => {
    if (value === TOOL.ROOM) {
      drawRoom(null);
      return;
    }
    setDrawingRoom(null);
    setZoneEdit(null);
    setTool(value);
  };

  /** "Add to zone" / "Cut from zone": the next drag reshapes that zone. */
  const reshapeZone = (zone, mode) => {
    setError(null);
    setNotice(null);
    setDrawingRoom(null);
    setZoneEdit({ id: zone.id, name: zone.name, areas: zone.areas, mode });
    setTool(TOOL.ZONE);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("editor-canvas")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  };

  /* ── The floor's outline (the Shape tool) ── */

  const outlineDirty = Boolean(outline) && JSON.stringify(outline.areas) !== savedOutlineKey;
  const editOutline = (areas) => {
    setOutline((current) => ({ ...current, areas, history: [...current.history, current.areas] }));
    setOutlineRefusal(null);
  };
  const undoOutline = () => {
    setOutline((current) => ({ ...current, areas: current.history[current.history.length - 1], history: current.history.slice(0, -1) }));
    setOutlineRefusal(null);
  };
  const saveOutline = async () => {
    setError(null);
    setNotice(null);
    if (!outlineDirty) {
      setOutlineRefusal({ message: "Nothing to save yet. Drag on the map to add floor or cut it away.", flagged: null });
      return;
    }
    setBusy(true);
    try {
      const saved = await api.updateFloor(floorId, { shape: { areas: outline.areas } });
      // The floor takes its new outline at once, and the tool starts again
      // from what was saved (in the same mode) — not from the layout the
      // reload is about to replace.
      setData((current) =>
        current?.floor.id === floorId
          ? { ...current, floor: { ...current.floor, grid: saved.floor.grid, shape: saved.floor.shape } }
          : current
      );
      setOutline((current) => ({ areas: floorAreas(saved.floor), history: [], mode: current.mode }));
      setOutlineRefusal(null);
      setNotice("Outline saved.");
      reloadAll();
    } catch (err) {
      // The server names what stands in the part being removed; the map
      // flags each of them so they can be found.
      setOutlineRefusal({ message: err.message, flagged: new Set((err.body?.outside || []).map((item) => item.id)) });
    } finally {
      setBusy(false);
    }
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

  /** A shape with `rect` added to it or cut from it, as cells. */
  const reshaped = (areas, rect, mode) => (mode === "cut" ? difference(cellsOf(areas), [rect]) : union(cellsOf(areas), [rect]));

  /**
   * What a drawn room or zone keeps: only cells that are floor. The walls
   * bound a room, so a box dragged across an L's missing corner becomes an
   * L-shaped room rather than a refusal (the server checks it regardless).
   */
  const onTheFloor = (cells) => (visible ? intersection(cells, floorCells(visible.floor)) : cells);
  const OFF_THE_FLOOR = "That's outside the floor. Draw inside its outline.";

  /**
   * A rectangle was dragged out. With the Shape tool it reshapes the draft
   * outline. A new zone needs only its name; a zone being reshaped is saved
   * at once. A room needs its name and how it is booked — RoomDialog asks
   * for both, which is the last step of the setup sequence — and a room
   * being reshaped goes back to that dialog with its new shape.
   */
  const onRegionSelect = (rect) => {
    if (!isSuperadmin) return;

    if (tool === TOOL.SHAPE && outline) {
      const next = reshaped(outline.areas, rect, outline.mode);
      if (!next.size) {
        setOutlineRefusal({ message: "That would cut away the whole floor. Keep at least one cell.", flagged: null });
        return;
      }
      editOutline(areasOf(next));
      return;
    }

    if (tool === TOOL.ZONE && zoneEdit) {
      const next = onTheFloor(reshaped(zoneEdit.areas, rect, zoneEdit.mode));
      if (!next.size) {
        setError(`That would cut away the whole of “${zoneEdit.name}”. To remove it, use the bin in the zones list.`);
        return;
      }
      const { id, name } = zoneEdit;
      setZoneEdit(null);
      setTool(TOOL.AVAILABILITY);
      act(() => api.updateZone(id, { areas: areasOf(next) }), `Zone “${name}” reshaped.`);
      return;
    }
    if (tool === TOOL.ZONE) {
      const cells = onTheFloor(cellsOf([rect]));
      if (!cells.size) setError(OFF_THE_FLOOR);
      else setPendingZone(areasOf(cells));
      return;
    }
    if (tool !== TOOL.ROOM) return;
    if (!canDraw) {
      setError("Set up the building before drawing rooms.");
      return;
    }

    const existing = drawingRoom?.levels || [];
    const here = existing.find((level) => level.floorId === floorId);
    const mode = here ? drawingRoom.drawMode || "draw" : "draw";
    const cells = onTheFloor(mode === "draw" ? cellsOf([rect]) : reshaped(regionAreas(here), rect, mode));
    if (!cells.size) {
      setError(
        mode === "cut"
          ? "That would cut away the whole of this level. To take the room off this floor, remove the level in its settings."
          : OFF_THE_FLOOR
      );
      return;
    }
    const level = { floorId, name: here?.name || "", areas: areasOf(cells), bounds: boundingBox(cells) };
    // A level keeps its place in the list: the first one anchors the room.
    const levels = here ? existing.map((other) => (other.floorId === floorId ? level : other)) : [...existing, level];
    const { drawMode, ...room } = drawingRoom || {}; // eslint-disable-line no-unused-vars
    setRoomDraft({ bookingMode: "individual", name: "", ...room, buildingId: building.id, levels });
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
          { value: TOOL.SHAPE, label: "Shape", icon: LandPlot },
        ]
      : []),
  ];

  /** What the room being drawn is called in the hint. */
  const drawingName = drawingRoom?.name ? `“${drawingRoom.name}”` : "the room";

  /**
   * The shape the map previews while a drag adds to it or cuts from it:
   * the draft outline, the room level being reshaped, or the zone.
   */
  const levelBeingReshaped =
    tool === TOOL.ROOM && drawingRoom && drawingRoom.drawMode !== "draw"
      ? drawingRoom.levels?.find((level) => level.floorId === floorId)
      : null;
  const shapeEdit =
    tool === TOOL.SHAPE && outline
      ? { target: "floor", areas: outline.areas, mode: outline.mode }
      : levelBeingReshaped
        ? { target: "room", id: drawingRoom.id, areas: regionAreas(levelBeingReshaped), mode: drawingRoom.drawMode }
        : tool === TOOL.ZONE && zoneEdit
          ? { target: "zone", id: zoneEdit.id, areas: zoneEdit.areas, mode: zoneEdit.mode }
          : null;

  const hint = {
    [TOOL.AVAILABILITY]: isSuperadmin
      ? `Click ${withArticle(resourceNoun)} to change its availability, or a room to open its settings.`
      : `Click ${withArticle(resourceNoun)} to mark it unavailable or out of service.`,
    [TOOL.PLACE]: "Click an empty cell to place the chosen piece.",
    [TOOL.REMOVE]: "Click a piece to remove it.",
    [TOOL.ROOM]:
      drawingRoom?.drawMode === "add"
        ? `Drag across the map to add to ${drawingName} — an arm of an L, the stem of a T.`
        : drawingRoom?.drawMode === "cut"
          ? `Drag across the part of ${drawingName} to cut away.`
          : drawingRoom?.name
            ? `Drag a box for “${drawingRoom.name}” on ${floor?.name}.`
            : "Drag a box around the room, corner to corner. Next you'll name it and choose how it's booked.",
    [TOOL.ZONE]: zoneEdit
      ? zoneEdit.mode === "add"
        ? `Drag across the map to add to the zone “${zoneEdit.name}”.`
        : `Drag across the part of “${zoneEdit.name}” to cut away.`
      : "Drag a box on the map, then name the zone.",
    [TOOL.LABEL]: "Click the map to position the label, then add it.",
    [TOOL.SHAPE]: "Drag on the map to cut away what isn't floor, or to add more. Nothing changes until you save.",
  }[tool];


  return (
    <Page>
      <PageHeader
        title={isSuperadmin ? "Map editor" : "Space controls"}
        subtitle={
          floor && building
            ? `${building.name} › ${floor.name}${
                visible
                  ? visible.floor.shape?.areas?.length
                    ? ` · shaped, within ${visible.floor.grid.cols} × ${visible.floor.grid.rows} cells`
                    : ` · ${visible.floor.grid.cols} × ${visible.floor.grid.rows} cells`
                  : ""
              }`
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
          <Segmented className="editortools" value={tool} onChange={chooseTool} options={tools} />
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

      {tool === TOOL.SHAPE && isSuperadmin && outline && visible && (
        <OutlineBar
          outline={outline}
          grid={visible.floor.grid}
          dirty={outlineDirty}
          busy={busy}
          refusal={outlineRefusal}
          onMode={(mode) => setOutline((current) => ({ ...current, mode }))}
          onUndo={undoOutline}
          onReset={() => editOutline([{ col: 0, row: 0, w: visible.floor.grid.cols, h: visible.floor.grid.rows }])}
          onDiscard={() => {
            setOutline(null);
            setOutlineRefusal(null);
          }}
          onSave={saveOutline}
        />
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
            regionMode={isSuperadmin && (tool === TOOL.ZONE || tool === TOOL.ROOM || tool === TOOL.SHAPE)}
            onRegionSelect={onRegionSelect}
            shapeEdit={shapeEdit}
            flagged={tool === TOOL.SHAPE ? outlineRefusal?.flagged : null}
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
              secondary: `${shapeSize(zone.areas)} at (${zone.bounds.col}, ${zone.bounds.row})`,
              actions: [
                { label: `Add to ${zone.name}`, icon: SquarePlus, onClick: () => reshapeZone(zone, "add") },
                { label: `Cut from ${zone.name}`, icon: SquareMinus, onClick: () => reshapeZone(zone, "cut") },
              ],
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
        Pieces keep their size and sit on whole squares; they can't be rotated. Anything that would overlap another
        piece or fall outside the floor is refused, with the reason.
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
        subtitle={pendingZone ? shapeSize(pendingZone) : ""}
        icon={Layers}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const areas = pendingZone;
            const name = zoneName.trim();
            if (!areas || !name) return;
            setPendingZone(null);
            setZoneName("");
            act(() => api.createZone({ floorId, name, areas }), `Zone "${name}" added.`);
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
      title={unit.label || `${unit.type.label} · ${resourceNoun} ${unit.unitLabel}`}
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

/* ─────────────────────────── the floor's outline ─────────────────────────── */

/**
 * The Shape tool's controls, above the map: whether a drag adds floor or
 * cuts it away, what the draft is, and Undo, Reset to rectangle, Discard and
 * Save. A refused save is shown here, where the Save was pressed, in the
 * server's own words ("1 piece and the room “Commons” are in the part
 * you're removing"); the map flags each of those things.
 */
function OutlineBar({ outline, grid, dirty, busy, refusal, onMode, onUndo, onReset, onDiscard, onSave }) {
  const cells = cellsOf(outline.areas);
  const wholeGrid = isRectangle(cells) && cells.size === grid.cols * grid.rows;
  return (
    <Card className="mt-3 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented
          className="outline-mode"
          size="sm"
          value={outline.mode}
          onChange={onMode}
          options={[
            { value: "add", label: "Add area", icon: SquarePlus },
            { value: "cut", label: "Cut area", icon: SquareMinus },
          ]}
        />
        <p className="text-sm text-ink-secondary">
          {outlineSummary(cells, grid)}
          {dirty && <span className="text-ink-muted"> · not saved yet</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Button size="sm" variant="ghost" icon={Undo2} disabled={!outline.history.length || busy} onClick={onUndo}>
            Undo
          </Button>
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={wholeGrid || busy} onClick={onReset}>
            Reset to rectangle
          </Button>
          {dirty && (
            <Button size="sm" disabled={busy} onClick={onDiscard}>
              Discard
            </Button>
          )}
          <Button size="sm" variant="primary" icon={Check} loading={busy} onClick={onSave}>
            Save outline
          </Button>
        </div>
      </div>
      {refusal && (
        <Notice tone="error" className="mt-3">
          {refusal.message}
        </Notice>
      )}
    </Card>
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
              {!readOnly &&
                (item.actions || []).map(({ label, icon: Icon, onClick }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={onClick}
                    title={label}
                    aria-label={label}
                    className="rounded-sm text-ink-muted transition-colors duration-fast ease-out hover:text-ink-primary"
                  >
                    <Icon size={14} />
                  </button>
                ))}
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
