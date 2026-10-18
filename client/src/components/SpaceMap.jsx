import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Ban, Check, Clock, DoorOpen, Maximize, TriangleAlert, User, Wrench, ZoomIn, ZoomOut } from "lucide-react";
import { effectiveStatus, roomMode, roomUnit } from "../lib/rooms.js";
import { describeDay, entryFor } from "../lib/dayView.js";
import {
  boundingBox, cellKey, cellsOf, difference, floorAreas, isRectangle, largestRect, regionAreas, union,
} from "../lib/cells.js";
import { outlinePath } from "../lib/shapePath.js";

/**
 * SpaceMap — the read-only grid renderer (MAP-1, spec §12).
 *
 * One shared layout model renders both the member-facing map and, later,
 * the admin editor (MAP-3) — this component owns only the *reading* half.
 * It draws spec §12's three layers, back to front:
 *
 *   floor     — the building's outline: only the cells that ARE the floor
 *               get the grid, with a wall around them. An L-shaped floor's
 *               missing corner is empty page, not more floor
 *   zones     — admin-drawn named areas; membership is derived from
 *               position, so a zone is purely a backdrop here
 *   rooms     — booking boundaries: an outline with the room's name and
 *               what it lets you book, or its state when booked or closed
 *   resources — catalog pieces on the integer cell grid, each showing its
 *               reservable units by colour AND icon (MAP-1 AC)
 *   labels    — free-typed orientation text; not reservable, no analytics
 *
 * Floors, rooms and zones are SHAPES — sets of grid cells (lib/cells.js) —
 * drawn as their outlines (lib/shapePath.js). A rectangle is just the
 * simplest one, so nothing here special-cases it.
 *
 * `layout` and `status` are separate props on purpose, mirroring the
 * split in GET /api/floors/:id/layout: layout is fetched once and rarely
 * changes, status is the fast-changing half that Socket.io will stream
 * (MAP-2, spec §17). Wiring MAP-2 means replacing entries in `status` —
 * nothing in this file has to change.
 *
 * Nothing here hardcodes "seat": the unit noun comes from the org's
 * configured terminology (spec §16).
 *
 * Time, on top of the live status (lib/dayView.js):
 *
 *   day         a floor's day for TODAY (GET /api/floors/:id/day). Each
 *               unit's fill keeps meaning "right now"; a thin ring around it
 *               adds the rest of today — none while it is free for the rest
 *               of the day, an arc as long as the share already booked, a
 *               full ring when nothing bookable is left (DayRing)
 *   windowView  { isFree(resourceId, unitLabel) } for a chosen window: the
 *               units free for it stay bright and the rest fade, fills
 *               unchanged — "where can I sit at 3?" in one look
 *   selectableOnly   with windowView: the faded units cannot be chosen (the
 *               kiosk, where only what is free now can be taken)
 *   touchTargets     each unit answers taps across its whole share of its
 *               piece, not only its chip — for a wall screen
 */

const CELL = 40; // SVG user units per grid cell — integer cells only (spec §12)
const PAD = 1; // one cell of breathing room around the grid
const PIECE_INSET = 5; // gap between a piece's footprint and its body
const UNIT_GAP = 6; // gap between unit chips inside a piece — room for each one's day ring
const RING_GAP = 1.5; // how far a day ring sits outside its chip
const RING_WIDTH = 1.6; // its thickness, in map units: a hairline that scales with the map
const FADED = 0.24; // opacity of a unit that is not free for the chosen window

/**
 * Status presentation — labels and icons only. The COLOURS come from the
 * organization's branding at runtime (see resolveStatePalette in
 * theme/applyOrgTheme.js) and are passed in as the `palette` prop.
 *
 * They can't be Tailwind classes: a dynamic name like
 * `fill-state-${status}` never appears literally in the source, so the
 * JIT purge strips it. They can't be `var(--…)` either: SVG presentation
 * attributes don't resolve CSS variables, and Motion can't interpolate
 * between them, so a status change would snap instead of cross-fading.
 * Concrete values passed down as data is the one option that satisfies
 * both constraints and stays themeable.
 */
export const STATUS_META = {
  available: { label: "Available", Icon: Check },
  reserved: { label: "Reserved", Icon: Clock },
  occupied: { label: "Occupied", Icon: User },
  unavailable: { label: "Unavailable", Icon: Ban },
};

/** Staff-only alert state layered on top of a unit's status (spec §10, §14). */
export const OVERSTAY_META = { label: "Overstay", Icon: TriangleAlert };

/** Out-of-service is a service status, not an availability status (spec §8). */
export const SERVICE_META = { label: "Out of service", Icon: Wrench };

export const STATUS_ORDER = ["available", "reserved", "occupied", "unavailable"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Cuts `text` to `chars` characters with an ellipsis. SVG text cannot do this itself. */
const truncate = (text, chars) => (text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`);

/** Average advance of a glyph, as a fraction of the font size — enough to fit labels without measuring. */
const GLYPH = 0.6;

/** Corner rounding, in SVG units: a room's outline, a zone's, the floor's walls. */
const ROOM_RADIUS = 10;
const ZONE_RADIUS = 8;
const WALL_RADIUS = 4;

/**
 * Where a shape's name goes: its largest rectangle, measured the way a line
 * of text uses space (width, and height only up to two cells), so a T's
 * name sits in its bar rather than down its stem.
 */
const labelSpot = (cells) => largestRect(cells, { usefulHeight: 2 });

/** How a room reads when its own state is not "free". */
const ROOM_STATE = {
  reserved: { label: "Booked now", Icon: Clock },
  occupied: { label: "In use now", Icon: User },
  unavailable: { label: "Closed", Icon: Ban },
};

/**
 * Exact client-pixel → SVG-user-unit conversion. The SVG letterboxes
 * itself with preserveAspectRatio, so the naive rect.width ratio is
 * wrong whenever the container and the viewBox disagree on aspect.
 */
function svgMetrics(rect, view) {
  const scale = Math.min(rect.width / view.w, rect.height / view.h);
  return {
    scale,
    offsetX: (rect.width - view.w * scale) / 2,
    offsetY: (rect.height - view.h * scale) / 2,
  };
}

function clientToSvg(rect, view, clientX, clientY) {
  const { scale, offsetX, offsetY } = svgMetrics(rect, view);
  return {
    x: view.x + (clientX - rect.left - offsetX) / scale,
    y: view.y + (clientY - rect.top - offsetY) / scale,
  };
}

/**
 * Lays a piece's reservable units out inside its footprint.
 *
 * The arrangement is chosen to make the chips as square as possible for
 * the given footprint, rather than always splitting along one axis. That
 * keeps a 5x1 long table as five chips in a row, while an office
 * catalog's 4x2 boardroom with eight seats becomes a 4x2 grid instead of
 * eight unreadable slivers. The renderer must not assume the shape of
 * any one vertical's catalog (spec §8).
 *
 * A 2x1 solo desk with a single unit gets one chip spanning the whole
 * body — the library catalog's one case where seatCount is smaller than
 * the footprint.
 */
function unitRects(footprint, unitCount) {
  const bodyX = PIECE_INSET;
  const bodyY = PIECE_INSET;
  const bodyW = footprint.w * CELL - PIECE_INSET * 2;
  const bodyH = footprint.h * CELL - PIECE_INSET * 2;

  // Pick the columns/rows split whose resulting chips are closest to
  // square. Ties resolve toward more columns, which reads better for the
  // wide pieces both catalogs are dominated by.
  let best = { cols: unitCount, rows: 1, score: Infinity };
  for (let cols = 1; cols <= unitCount; cols += 1) {
    const rows = Math.ceil(unitCount / cols);
    const w = (bodyW - UNIT_GAP * (cols - 1)) / cols;
    const h = (bodyH - UNIT_GAP * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    const score = Math.max(w / h, h / w); // 1 is a perfect square
    if (score < best.score) best = { cols, rows, score };
  }

  const { cols, rows } = best;
  const w = (bodyW - UNIT_GAP * (cols - 1)) / cols;
  const h = (bodyH - UNIT_GAP * (rows - 1)) / rows;

  return Array.from({ length: unitCount }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: bodyX + col * (w + UNIT_GAP), y: bodyY + row * (h + UNIT_GAP), w, h };
  });
}

/**
 * Resolves the colour/icon a unit renders with, given all three states
 * (availability, service status, and the staff-only overstay flag).
 * Colours are looked up in the org's palette, never baked in here.
 */
function resolveUnitAppearance(unitStatus, palette) {
  const key = STATUS_META[unitStatus?.status] ? unitStatus.status : "unavailable";
  const base = STATUS_META[key];
  const tone = palette[key] || palette.unavailable;

  if (unitStatus?.serviceStatus === "out_of_service") {
    // Out of service borrows the "unavailable" tone but keeps its own
    // icon, so a broken machine is distinguishable from a closed one.
    return {
      ...SERVICE_META,
      ...palette.unavailable,
      statusLabel: `${base.label} · ${SERVICE_META.label}`,
    };
  }
  return { ...base, ...tone, statusLabel: base.label };
}

/**
 * The product's neutral state palette, used when no organization
 * branding has been resolved yet (first paint, or a config that sets
 * nothing). Kept in sync with the --c-state-* defaults in index.css.
 */
const DEFAULT_PALETTE = {
  available: { color: "#34D399", ink: "#06301F" },
  reserved: { color: "#FB923C", ink: "#42200A" },
  occupied: { color: "#64748B", ink: "#F1F5F9" },
  unavailable: { color: "#F87171", ink: "#4A1010" },
  overstay: { color: "#C084FC", ink: "#33094F" },
};

export default function SpaceMap({
  floor,
  layout,
  resourceTypes = [],
  status = {},
  resourceNoun = "resource",
  showOverstay = false,
  selectedUnit = null,
  onSelectUnit,
  onSelectRoom,
  focusedRoomId = null,
  management = false,
  palette = DEFAULT_PALETTE,
  highlight = [],
  onCellClick,
  /**
   * Drag a rectangle on the grid instead of panning.
   *
   * The editor asked for a region as four numbers — a corner from a
   * click, then width and height typed into boxes. On a spatial editor
   * that is the wrong instrument: you know where the room is, you do
   * not know that it is 7 wide. With this on, a drag draws the box and
   * `onRegionSelect({col,row,w,h})` receives it, normalised so dragging
   * up-left works exactly like dragging down-right.
   */
  regionMode = false,
  onRegionSelect,
  /**
   * A shape being edited, drawn live as the drag goes (the editor's Shape
   * tool, a room's "Add to room" / "Cut from room", and a zone's):
   *
   *   { target: "floor", areas, mode }           the floor's draft outline
   *   { target: "room", id?, areas, mode }       one room level's draft (no
   *                                              id for a room not yet saved)
   *   { target: "zone", id, areas, mode }        a zone's draft
   *
   * `mode` is "add" or "cut": a drag is previewed as the shape it would
   * leave, before onRegionSelect hands the rectangle over. Editing the
   * floor also shows the whole grid faintly, since that is where floor can
   * be added.
   */
  shapeEdit = null,
  /**
   * Ids of pieces, rooms, zones and labels to point at — what stood in the
   * way of a refused reshape (the server lists them).
   */
  flagged = null,
  editing = false,
  fill = false,
  className = "",
  day = null,
  rings = true,
  windowView = null,
  selectableOnly = false,
  touchTargets = false,
}) {
  const svgRef = useRef(null);
  const pointers = useRef(new Map());
  // Distance the last pointer travelled, read by the click handler.
  const lastTravel = useRef(0);

  const grid = floor?.grid || { cols: 0, rows: 0 };

  const rooms = layout?.rooms || [];
  const levelHere = (room) => room.levels.find((level) => level.floorId === floor?.id) || null;
  const focusedRoom = rooms.find((room) => room.id === focusedRoomId);
  const focusedLevel = focusedRoom ? levelHere(focusedRoom) : null;

  /**
   * The floor's cells: its outline, or the whole grid when it has none
   * (every floor drawn before outlines existed). While the outline itself
   * is being edited, the draft is drawn instead.
   */
  const editingFloor = shapeEdit?.target === "floor";
  const floorShape = editingFloor ? shapeEdit.areas : floorAreas(floor);
  const floorShapeKey = JSON.stringify(floorShape);
  const floorCells = useMemo(() => cellsOf(floorShape), [floorShapeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What the map is framed on: the floor's own extent, so a building whose
   * outline does not reach every edge of its grid is still centred — or,
   * while the outline is being edited, the whole grid, which is where it
   * can grow. A room in focus frames on that room.
   */
  const gridBox = { col: 0, row: 0, w: grid.cols, h: grid.rows };
  const focusBox = focusedLevel ? boundingBox(regionAreas(focusedLevel)) : null;
  const extent = editingFloor ? gridBox : boundingBox(floorCells) || gridBox;
  const frame = focusBox || extent;
  const baseView = useMemo(
    () => ({
      x: (frame.col - PAD) * CELL,
      y: (frame.row - PAD) * CELL,
      w: (frame.w + PAD * 2) * CELL,
      h: (frame.h + PAD * 2) * CELL,
    }),
    [floor?.id, focusedRoomId, frame.col, frame.row, frame.w, frame.h] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [view, setView] = useState(baseView);

  // Reset the viewport whenever the floor changes — a zoomed-in view of
  // a 20x12 floor makes no sense on a 16x10 one.
  useEffect(() => setView(baseView), [baseView]);

  const zoomLimits = useMemo(() => ({ min: baseView.w / 8, max: baseView.w * 2 }), [baseView.w]);

  /**
   * Screen pixels per SVG unit, kept current as the box resizes.
   *
   * Room names are sized from this so they read at about the same size on
   * a phone as on a monitor. Drawn at a fixed 11 units, a whole floor
   * squeezed into a 400px-wide screen put them at under 5px — the rooms
   * were there, but you could not tell which was which.
   */
  const [box, setBox] = useState({ width: 0, height: 0 });
  const drawn = Boolean(floor && layout);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [drawn]);
  const pxPerUnit = box.width && box.height ? Math.min(box.width / view.w, box.height / view.h) : 1;

  const typeById = useMemo(() => new Map(resourceTypes.map((t) => [t.id, t])), [resourceTypes]);

  // Units the caller wants drawn attention to — today that is the admin
  // console's "hover a row to locate it" on Resources & rules. Keyed so
  // the per-unit lookup below stays O(1) rather than scanning an array
  // once per chip.
  const highlighted = useMemo(
    () => new Set((highlight || []).map((h) => `${h.resourceId}:${h.unitLabel}`)),
    [highlight]
  );

  const zoomBy = useCallback(
    (factor, clientX, clientY) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const targetW = clamp(v.w * factor, zoomLimits.min, zoomLimits.max);
        const applied = targetW / v.w;
        const anchor =
          clientX == null
            ? { x: v.x + v.w / 2, y: v.y + v.h / 2 }
            : clientToSvg(rect, v, clientX, clientY);
        return {
          x: anchor.x - (anchor.x - v.x) * applied,
          y: anchor.y - (anchor.y - v.y) * applied,
          w: v.w * applied,
          h: v.h * applied,
        };
      });
    },
    [zoomLimits]
  );

  // React's onWheel is registered passively, so preventDefault there is
  // ignored and the page scrolls behind the map. Attach it natively.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  /** Movement (px) before a press is treated as a drag rather than a click. */
  const DRAG_THRESHOLD = 4;
  /** Movement (px) a drag inside one cell needs before it counts as drawing that cell. */
  const SINGLE_CELL_DRAG = 12;

  /**
   * setPointerCapture throws (NotFoundError) if the browser does not
   * consider that pointer id active — which aborts whatever handler
   * called it. Capture is an enhancement here, never a requirement: the
   * gesture must still work if it fails.
   */
  const capture = (pointerId) => {
    try {
      svgRef.current?.setPointerCapture?.(pointerId);
      return true;
    } catch {
      return false;
    }
  };
  const release = (pointerId) => {
    try {
      svgRef.current?.releasePointerCapture?.(pointerId);
    } catch {
      /* already gone — nothing to undo */
    }
  };

  /**
   * The rectangle currently being dragged out, in grid cells.
   *
   * Held in a ref for the handlers and mirrored into state for the
   * render. Reading it from state inside handlePointerMove would mean
   * the gesture only works if React has re-rendered between pointerdown
   * and the first move — true in practice, but it makes the interaction
   * depend on frame timing rather than on the events themselves. The
   * pan pointers are kept in a ref for the same reason.
   */
  const regionRef = useRef(null);
  const [region, setRegion] = useState(null);

  const updateRegion = (next) => {
    regionRef.current = next;
    setRegion(next);
  };

  /** Pointer position -> a clamped cell, so a drag off the edge still lands. */
  const cellAt = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    const { x, y } = clientToSvg(rect, view, clientX, clientY);
    return {
      col: Math.max(0, Math.min(grid.cols - 1, Math.floor(x / CELL))),
      row: Math.max(0, Math.min(grid.rows - 1, Math.floor(y / CELL))),
    };
  };

  /** Two corners -> {col,row,w,h}, whichever way the drag went. */
  const normalise = (a, b) => ({
    col: Math.min(a.col, b.col),
    row: Math.min(a.row, b.row),
    w: Math.abs(a.col - b.col) + 1,
    h: Math.abs(a.row - b.row) + 1,
  });

  const handlePointerDown = (e) => {
    // Deliberately does NOT capture the pointer here.
    //
    // Capturing on pointerdown retargets the whole subsequent event
    // sequence — including the compatibility `click` — to the capturing
    // element. That silently broke every click INSIDE the map: seats
    // could not be selected to reserve, and the editor could not place a
    // piece, because the click landed on the <svg> instead of the unit
    // or the grid cell. Capture is taken in handlePointerMove once the
    // pointer has actually travelled far enough to be a drag.
    if (regionMode && pointers.current.size === 0) {
      // Draw, don't pan. Capture immediately here — unlike a tap on a
      // seat there is no click to preserve, and the gesture must survive
      // the pointer leaving the SVG mid-drag.
      const start = cellAt(e.clientX, e.clientY);
      capture(e.pointerId);
      updateRegion({ start, end: start, pointerId: e.pointerId, x: e.clientX, y: e.clientY, travelled: 0 });
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, captured: false });
  };

  const handlePointerMove = (e) => {
    const drawing = regionRef.current;
    if (drawing && drawing.pointerId === e.pointerId) {
      updateRegion({
        ...drawing,
        end: cellAt(e.clientX, e.clientY),
        x: e.clientX,
        y: e.clientY,
        travelled: drawing.travelled + Math.hypot(e.clientX - drawing.x, e.clientY - drawing.y),
      });
      return;
    }

    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;

    const rect = svgRef.current.getBoundingClientRect();
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);

    const travelled = previous.moved + Math.hypot(e.clientX - previous.x, e.clientY - previous.y);

    // Now that this is a real drag, capture so the gesture keeps working
    // if the pointer leaves the SVG. A click never reaches this branch.
    if (!previous.captured && (travelled > DRAG_THRESHOLD || others.length === 1)) {
      previous.captured = capture(e.pointerId);
    }

    // Below the threshold this is still a potential click — don't pan,
    // or a slightly shaky hand would scroll the map instead of selecting.
    if (others.length === 0 && travelled <= DRAG_THRESHOLD) {
      pointers.current.set(e.pointerId, { ...previous, moved: travelled });
      return;
    }

    if (others.length === 0) {
      // Single pointer — pan.
      setView((v) => {
        const { scale } = svgMetrics(rect, v);
        return {
          ...v,
          x: v.x - (e.clientX - previous.x) / scale,
          y: v.y - (e.clientY - previous.y) / scale,
        };
      });
    } else if (others.length === 1) {
      // Two pointers — pinch to zoom around the midpoint (spec §12: pan
      // and zoom on mobile).
      const [, other] = others[0];
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0 && after > 0) {
        zoomBy(before / after, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
      }
    }

    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      moved: travelled,
      captured: previous.captured,
    });
  };

  const endPointer = (e) => {
    const drawn = regionRef.current;
    if (drawn && drawn.pointerId === e.pointerId) {
      release(e.pointerId);
      const rect = normalise(drawn.start, drawn.end);
      updateRegion(null);
      // A single cell from a press that barely moved is a misfire — a
      // click, or a tap's wobble — and is dropped rather than creating a
      // 1x1 room. A drag that wanders inside one cell is deliberate:
      // cutting a notch for a pillar is a real edit.
      if (rect.w > 1 || rect.h > 1 || drawn.travelled > SINGLE_CELL_DRAG) onRegionSelect?.(rect);
      // Suppress the click that follows this drag, or the grid's own
      // cell handler would also fire at the release point.
      lastTravel.current = DRAG_THRESHOLD + 1;
      return;
    }

    const entry = pointers.current.get(e.pointerId);
    if (entry?.captured) release(e.pointerId);
    // Keep the travel distance around briefly so the click handler that
    // fires immediately after can tell a click from the end of a drag.
    lastTravel.current = entry?.moved ?? 0;
    pointers.current.delete(e.pointerId);
  };

  /**
   * A drag across the map shouldn't also count as selecting a unit. The
   * pointer entry is already gone by the time `click` fires, so the
   * distance is stashed in endPointer above.
   */
  const wasDrag = () => lastTravel.current > DRAG_THRESHOLD;

  // By label, not index: a unit chosen from a list rather than the map
  // knows its label, and the label is what identifies it everywhere else.
  const isSelected = (resourceId, unitLabel) =>
    selectedUnit?.resourceId === resourceId && selectedUnit?.unitLabel === unitLabel;

  /**
   * The rooms drawn on this floor with their cells here, and which room
   * covers each cell — how a click finds the room under it.
   *
   * By cell rather than by the drawn outline: the outline is inset and its
   * corners rounded, but the room is its cells. It also lets a click in the
   * editor pass through a room to the cell beneath, to place a piece there,
   * instead of stopping at the room's fill.
   */
  const roomsHere = useMemo(
    () =>
      rooms
        .filter((room) => !focusedRoomId || room.id === focusedRoomId)
        .map((room) => ({ room, level: levelHere(room) }))
        .filter(({ level }) => level)
        .map(({ room, level }) => ({ room, cells: cellsOf(regionAreas(level)) })),
    [rooms, floor?.id, focusedRoomId] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const roomAtCell = useMemo(() => {
    const byCell = new Map();
    for (const { room, cells } of roomsHere) for (const key of cells) byCell.set(key, room);
    return byCell;
  }, [roomsHere]);
  const zonesHere = useMemo(
    () => (layout?.zones || []).map((zone) => ({ zone, cells: cellsOf(regionAreas(zone)) })),
    [layout?.zones]
  );

  /**
   * The shape being edited as it would be if the drag in progress ended
   * now — added to or cut from. Seeing that before letting go is the
   * point of the tool.
   */
  const editKey = JSON.stringify(shapeEdit?.areas || null);
  const editCells = useMemo(() => (shapeEdit ? cellsOf(shapeEdit.areas) : null), [editKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dragged = region ? normalise(region.start, region.end) : null;
  const previewCells = !editCells
    ? null
    : !dragged
      ? editCells
      : shapeEdit.mode === "cut"
        ? difference(editCells, [dragged])
        : union(editCells, [dragged]);

  /** Whether a room can be chosen from the map, and what choosing it does. */
  const roomIsInteractive = (room) =>
    !editing && !regionMode && Boolean(onSelectRoom || (!management && room.bookingMode !== "individual" && onSelectUnit));
  const chooseRoom = (room) => {
    if (onSelectRoom) onSelectRoom(room);
    else if (!management && room.bookingMode !== "individual") onSelectUnit?.(roomUnit(room, status));
  };

  /**
   * A click that reached the map itself rather than a piece (pieces stop
   * theirs): in the editor, the cell for the tool in hand; otherwise the
   * room covering that cell. Off the floor — the missing corner of an L —
   * there is nothing to click.
   */
  const handleMapClick = (e) => {
    if (regionMode || wasDrag()) return;
    const { x, y } = clientToSvg(svgRef.current.getBoundingClientRect(), view, e.clientX, e.clientY);
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    const key = cellKey(col, row);
    if (!floorCells.has(key)) return;
    if (editing) {
      onCellClick?.(col, row);
      return;
    }
    const room = roomAtCell.get(key);
    if (room && roomIsInteractive(room)) chooseRoom(room);
  };

  if (!floor || !layout) return null;

  const gridW = grid.cols * CELL;
  const gridH = grid.rows * CELL;

  // While the outline is edited, the floor is drawn as the draft would be.
  const plate = editingFloor ? previewCells : floorCells;
  const platePath = outlinePath(plate, { cell: CELL, radius: WALL_RADIUS });
  const plainFloor = isRectangle(floorCells) && floorCells.size === grid.cols * grid.rows;
  const editTone = shapeEdit?.mode === "cut" ? "var(--color-state-unavailable)" : "var(--color-accent)";

  return (
    // Two sizing modes.
    //
    // Default: the box takes the floor's own aspect ratio so the SVG
    // fills it rather than letterboxing — a fixed height would shrink a
    // 20x12 floor into a sliver on a phone, which is exactly where
    // pan/zoom matters most. maxHeight keeps a tall floor from running
    // off a desktop screen. Right when the map sits IN a page.
    //
    // fill: take the whole box the parent gives, whatever shape it is.
    // For the app shell, where the map IS the screen and the parent has
    // already worked out how much room that leaves. The SVG's
    // preserveAspectRatio keeps the floor undistorted either way.
    <div
      className={`relative w-full ${fill ? "h-full" : ""} ${className}`}
      style={
        fill
          ? undefined
          : {
              aspectRatio: `${extent.w + PAD * 2} / ${extent.h + PAD * 2}`,
              maxHeight: "68vh",
              minHeight: 260,
            }
      }
    >
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full select-none"
        style={{ touchAction: "none", cursor: regionMode ? "crosshair" : editing && onCellClick ? "copy" : "grab" }}
        role="img"
        aria-label={
          `Map of ${floor.name}: ${layout.resources.length} pieces on ` +
          (plainFloor ? `a ${grid.cols} by ${grid.rows} grid` : `a shaped floor within a ${grid.cols} by ${grid.rows} grid`)
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
        onClick={handleMapClick}
      >
        <style>{`
          .silla-unit { cursor: pointer; outline: none; }
          .silla-unit:focus-visible .silla-unit-body { stroke: var(--color-accent); stroke-width: 3; }
          .silla-unit:hover .silla-unit-body { filter: brightness(1.18); }
          .silla-room { cursor: pointer; outline: none; }
          .silla-room .silla-room-body { transition: stroke-opacity var(--dur-fast) var(--ease-out); }
          .silla-room:hover .silla-room-body { stroke-opacity: 1; }
          .silla-room:focus-visible .silla-room-body { stroke: var(--color-accent); stroke-width: 3; }
        `}</style>

        <defs>
          <pattern id="silla-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
            <path
              d={`M ${CELL} 0 L 0 0 0 ${CELL}`}
              fill="none"
              style={{ stroke: "var(--color-map-grid)" }}
              strokeWidth="1"
            />
          </pattern>
        </defs>

        {/* ---- The whole grid, faintly, while the outline is edited ----
             Floor can only be added inside the grid, so show where that is. */}
        {editingFloor && (
          <g pointerEvents="none">
            <rect x="0" y="0" width={gridW} height={gridH} fill="url(#silla-grid)" opacity="0.6" />
            <rect
              x="0"
              y="0"
              width={gridW}
              height={gridH}
              fill="none"
              rx="4"
              style={{ stroke: "var(--color-map-outline)", strokeWidth: 1.5, strokeDasharray: "5 6" }}
            />
          </g>
        )}

        {/* ---- Layer: the floor ----
             Only the floor's own cells get a surface and the grid, and the
             wall runs along their outline: the missing corner of an L is
             empty page, not floor nobody may use. Clicks are resolved by
             cell on the <svg> (handleMapClick), so nothing here listens. */}
        <g pointerEvents="none">
          <path d={platePath} fillRule="evenodd" style={{ fill: "var(--color-map-floor)" }} />
          <path d={platePath} fillRule="evenodd" fill="url(#silla-grid)" />
          <path
            d={platePath}
            fillRule="evenodd"
            fill="none"
            strokeLinejoin="round"
            // The draft takes the accent while it is edited, whether the
            // next drag adds or cuts: only the dragged rectangle shows that.
            style={{ stroke: editingFloor ? "var(--color-accent)" : "var(--color-map-wall)", strokeWidth: editingFloor ? 2.5 : 3 }}
          />
        </g>

        {/* ---- Layer: zones (spec §12) ---- a backdrop, so it takes no clicks */}
        <g pointerEvents="none">
          {zonesHere.map(({ zone, cells }) =>
            shapeEdit?.target === "zone" && shapeEdit.id === zone.id ? null : (
              <ZoneShape key={zone.id} zone={zone} cells={cells} flagged={Boolean(flagged?.has(zone.id))} />
            )
          )}
        </g>

        {/* ---- Layer: rooms ----
             A room is drawn per floor (each of its levels is a shape on one
             floor) and sits under the furniture, so its contents stay
             clickable. Clicking the room itself opens what it offers. A
             room whose shape is being edited is drawn by the edit layer
             instead, as the draft. */}
        <g>
          {roomsHere.map(({ room, cells }) =>
            shapeEdit?.target === "room" && shapeEdit.id === room.id ? null : (
              <RoomShape
                key={room.id}
                room={room}
                cells={cells}
                state={status[room.resourceId]?.[0]?.status || "available"}
                palette={palette}
                focused={room.id === focusedRoomId}
                flagged={Boolean(flagged?.has(room.id))}
                pxPerUnit={pxPerUnit}
                resourceNoun={resourceNoun}
                interactive={roomIsInteractive(room)}
                onSelect={() => chooseRoom(room)}
                faded={Boolean(windowView && room.bookingMode === "whole" && windowView.isFree(room.resourceId, "room") === false)}
              />
            )
          )}
        </g>
        {/* ---- Layer: resources (spec §12) ---- */}
        <g>
          {layout.resources.filter((r) => !focusedRoomId || r.roomId === focusedRoomId).map((resource, pieceIndex) => {
            const type = typeById.get(resource.resourceType);
            if (!type) return null; // catalog/layout mismatch — skip rather than crash

            const x = resource.position.col * CELL;
            const y = resource.position.row * CELL;
            const unitStatuses = status[resource.id] || [];
            const rects = unitRects(type.footprint, resource.units.length);

            return (
              <motion.g
                key={resource.id}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.25, delay: Math.min(pieceIndex * 0.012, 0.3) }}
                style={{ transformOrigin: `${x + (type.footprint.w * CELL) / 2}px ${y + (type.footprint.h * CELL) / 2}px` }}
                // A click on furniture is never a click on the cell beneath
                // it: the map's own handler would otherwise open the room
                // behind it, or try to place a second piece on top.
                onClick={(e) => e.stopPropagation()}
              >
                {/* The piece's physical body — the furniture, not the unit */}
                <rect
                  x={x + 2}
                  y={y + 2}
                  width={type.footprint.w * CELL - 4}
                  height={type.footprint.h * CELL - 4}
                  style={{ fill: "var(--color-map-piece-fill)", stroke: "var(--color-map-piece-stroke)" }}
                  strokeWidth="1"
                  rx="7"
                />
                {flagged?.has(resource.id) && <Flag x={x} y={y} w={type.footprint.w * CELL} h={type.footprint.h * CELL} />}

                {resource.units.map((unit, unitIndex) => {
                  const unitStatus = management
                    ? unitStatuses[unitIndex]
                    : effectiveStatus(resource, unitStatuses[unitIndex], rooms, status);
                  const r = rects[unitIndex];
                  const room = unitStatus?.roomBlocked ? rooms.find((candidate) => candidate.id === resource.roomId) : null;
                  const ownRoom = resource.roomId ? rooms.find((candidate) => candidate.id === resource.roomId) : null;

                  // Time: today's ring, and whether it is free for the chosen
                  // window. A unit that only comes with its room answers as the room.
                  const entry = management ? null : entryFor(day, resource.id, unit.label);
                  const asRoom = unitStatus?.includedInRoom && ownRoom;
                  const freeForWindow = management || !windowView
                    ? null
                    : asRoom
                      ? windowView.isFree(ownRoom.resourceId, "room")
                      : windowView.isFree(resource.id, unit.label);
                  const faded = freeForWindow === false;
                  const locked = faded && selectableOnly;
                  const daySentence = entry && day ? describeDay(entry, day, { noun: resourceNoun, roomName: ownRoom?.name }).headline : null;
                  const hit = touchTargets ? hitArea(r, type.footprint) : null;
                  // A unit blocked by its room opens the room: that is where
                  // the booking that matters is made (or why it can't be).
                  const choose = () => {
                    if (room && !management) {
                      onSelectRoom?.(room);
                      return;
                    }
                    onSelectUnit?.({
                      resourceId: resource.id,
                      unitIndex,
                      unitLabel: unit.label,
                      type,
                      position: resource.position,
                      roomId: resource.roomId || null,
                      status: unitStatus,
                      statusLabel: resolveUnitAppearance(unitStatus, palette).statusLabel,
                      overstay: Boolean(showOverstay && unitStatus?.overstay),
                      selectable: !locked,
                    });
                  };
                  const handlers = {
                    onClick: () => {
                      if (!wasDrag()) choose();
                    },
                    onKeyDown: (e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      choose();
                    },
                  };

                  // Furniture in a room booked only as a whole is not a unit
                  // anyone books alone. Drawn as part of the room — neutral,
                  // with the room's door — rather than as a row of red
                  // "unavailable" seats that make a free room look broken.
                  if (unitStatus?.includedInRoom && !management) {
                    const description = `${type.label} · ${unit.label} — comes with ${room?.name || "its room"}`;
                    const iconSize = clamp(Math.min(r.w, r.h) * 0.45, 8, 16);
                    return (
                      <g
                        key={`${resource.id}-${unitIndex}`}
                        className="silla-unit"
                        role="button"
                        tabIndex={locked ? -1 : 0}
                        aria-disabled={locked || undefined}
                        aria-label={description}
                        style={{ opacity: faded ? FADED : 1, transition: "opacity var(--dur-base) var(--ease-out)" }}
                        {...handlers}
                      >
                        <title>{description}</title>
                        {hit && <rect x={x + hit.x} y={y + hit.y} width={hit.w} height={hit.h} fill="transparent" />}
                        <rect
                          className="silla-unit-body"
                          x={x + r.x}
                          y={y + r.y}
                          width={r.w}
                          height={r.h}
                          rx="5"
                          style={{ fill: "rgb(var(--c-line) / 0.13)", stroke: "rgb(var(--c-line) / 0.18)", strokeWidth: 1 }}
                        />
                        {Math.min(r.w, r.h) >= 14 && (
                          <DoorOpen
                            x={x + r.x + r.w / 2 - iconSize / 2}
                            y={y + r.y + r.h / 2 - iconSize / 2}
                            width={iconSize}
                            height={iconSize}
                            strokeWidth={2}
                            style={{ color: "var(--color-ink-muted)", pointerEvents: "none" }}
                          />
                        )}
                      </g>
                    );
                  }

                  const appearance = resolveUnitAppearance(unitStatus, palette);
                  const overstayed = showOverstay && unitStatus?.overstay;
                  const cx = x + r.x + r.w / 2;
                  const cy = y + r.y + r.h / 2;

                  const iconSize = clamp(Math.min(r.w, r.h) * 0.5, 9, 18);
                  const showIcon = Math.min(r.w, r.h) >= 14;
                  const showLabel = r.h >= 26 && r.w >= 24;
                  const overstayTone = palette.overstay || DEFAULT_PALETTE.overstay;
                  const Icon = overstayed ? OVERSTAY_META.Icon : appearance.Icon;
                  const fill = overstayed ? overstayTone.color : appearance.color;
                  const ink = overstayed ? overstayTone.ink : appearance.ink;
                  const selected = isSelected(resource.id, unit.label);
                  const isHighlighted = highlighted.has(`${resource.id}:${unit.label}`);

                  const description =
                    `${type.label} · ${resourceNoun} ${unit.label} — ${appearance.statusLabel} now` +
                    (overstayed ? ` · ${OVERSTAY_META.label}` : "") +
                    (room ? ` (${room.name})` : "") +
                    (daySentence && rings ? `. ${daySentence}` : "") +
                    (windowView ? (faded ? `. ${windowView.takenWords || "Not free then"}` : `. ${windowView.freeWords || "Free then"}`) : "");

                  return (
                    <g
                      key={`${resource.id}-${unitIndex}`}
                      className="silla-unit"
                      role="button"
                      tabIndex={locked ? -1 : 0}
                      aria-disabled={locked || undefined}
                      aria-label={description}
                      aria-pressed={selected || undefined}
                      style={{
                        opacity: faded ? FADED : 1,
                        transition: "opacity var(--dur-base) var(--ease-out)",
                        cursor: locked ? "default" : undefined,
                      }}
                      {...handlers}
                    >
                      <title>{description}</title>
                      {hit && <rect x={x + hit.x} y={y + hit.y} width={hit.w} height={hit.h} fill="transparent" />}
                      {rings && <DayRing x={x + r.x} y={y + r.y} w={r.w} h={r.h} entry={entry} />}
                      {/* Motion animates the fill, so a status change
                          arriving over Socket.io (MAP-2) cross-fades
                          instead of snapping. */}
                      <motion.rect
                        className="silla-unit-body"
                        x={x + r.x}
                        y={y + r.y}
                        width={r.w}
                        height={r.h}
                        rx="5"
                        initial={false}
                        animate={{ fill }}
                        transition={{ duration: 0.35 }}
                        style={{ stroke: "rgb(var(--c-bg-page) / 0.45)", strokeWidth: 1 }}
                      />
                      {/* The selection outline, drawn over the chip rather than
                          as the chip's own stroke: Motion owns that element's
                          style, and a changed stroke there never reached the
                          screen — the chosen unit looked like every other.
                          Measured in screen pixels (non-scaling), not map
                          units: a whole floor on a phone shrank a 3-unit
                          outline to one faint pixel. */}
                      {(selected || isHighlighted) && (
                        <rect
                          x={x + r.x}
                          y={y + r.y}
                          width={r.w}
                          height={r.h}
                          rx="5"
                          pointerEvents="none"
                          style={{
                            fill: "none",
                            stroke: "var(--color-accent)",
                            strokeWidth: selected ? 3 : 2.5,
                            strokeDasharray: selected ? undefined : "5 3",
                            vectorEffect: "non-scaling-stroke",
                          }}
                        />
                      )}
                      {showIcon && (
                        <Icon
                          x={cx - iconSize / 2}
                          y={cy - iconSize / 2 - (showLabel ? 5 : 0)}
                          width={iconSize}
                          height={iconSize}
                          color={ink}
                          strokeWidth={2.5}
                          style={{ pointerEvents: "none" }}
                        />
                      )}
                      {showLabel && (
                        <text
                          x={cx}
                          y={cy + r.h / 2 - 5}
                          textAnchor="middle"
                          fontSize="9"
                          fontWeight="700"
                          fill={ink}
                          opacity="0.75"
                          style={{ pointerEvents: "none" }}
                        >
                          {unit.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </motion.g>
            );
          })}
        </g>

        {/* ---- Layer: labels (spec §12) ---- */}
        <g pointerEvents="none">
          {layout.labels.map((label) => (
            <g key={label.id}>
              {flagged?.has(label.id) && <Flag x={label.position.col * CELL} y={label.position.row * CELL} w={CELL} h={CELL} />}
              <text
                x={label.position.col * CELL + CELL / 2}
                y={label.position.row * CELL + CELL / 2 + 4}
                textAnchor="middle"
                fontSize="11"
                fontWeight="500"
                letterSpacing="0.6"
                style={{ fill: "var(--color-ink-secondary)" }}
              >
                {label.text}
              </text>
            </g>
          ))}
        </g>

        {/* ---- Layer: a room's or a zone's shape being edited ----
             The draft, as the drag in progress would leave it. */}
        {shapeEdit && !editingFloor && previewCells?.size > 0 && (
          <path
            d={outlinePath(previewCells, { cell: CELL, inset: 1, radius: ROOM_RADIUS })}
            fillRule="evenodd"
            pointerEvents="none"
            style={{ fill: "var(--color-accent)", fillOpacity: 0.1, stroke: "var(--color-accent)", strokeWidth: 2.5 }}
          />
        )}

        {/* ---- Layer: the rectangle being dragged out ----
             In the accent when it draws or adds, in the "unavailable" tone
             when it cuts — and signed, so the two read apart without colour. */}
        {dragged && (
          <g pointerEvents="none">
            <rect
              x={dragged.col * CELL}
              y={dragged.row * CELL}
              width={dragged.w * CELL}
              height={dragged.h * CELL}
              rx="6"
              style={{ fill: editTone, fillOpacity: shapeEdit?.mode === "cut" ? 0.18 : 0.14, stroke: editTone }}
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            {/* The size, stated while you draw it — the number is the
                thing the old form was asking you to know in advance. */}
            <text
              x={dragged.col * CELL + (dragged.w * CELL) / 2}
              y={dragged.row * CELL + (dragged.h * CELL) / 2 + 5}
              textAnchor="middle"
              fontSize="14"
              fontWeight="700"
              style={{ fill: editTone }}
            >
              {shapeEdit?.mode === "cut" ? "− " : shapeEdit?.mode === "add" ? "+ " : ""}
              {dragged.w} × {dragged.h}
            </text>
          </g>
        )}
      </svg>

      {/* Pan/zoom controls — the pointer gestures cover touch, these
          cover desktop and keyboard (MAP-1 AC: pan / zoom).

          pointer-events-none on the stack, auto on each button: the
          container spans the buttons AND the gaps between them, and
          those gaps were swallowing taps on whatever sat underneath.
          On the kiosk that cost a real available seat — the walk-in
          picker is tap-only, so the seat simply could not be chosen. */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5 pointer-events-none">
        {[
          // Touch already has pinch-to-zoom, and these would sit on top
          // of the map on a narrow screen — so only the reset stays.
          { Icon: ZoomIn, label: "Zoom in", onClick: () => zoomBy(1 / 1.3), desktopOnly: true },
          { Icon: ZoomOut, label: "Zoom out", onClick: () => zoomBy(1.3), desktopOnly: true },
          { Icon: Maximize, label: "Reset view", onClick: () => setView(baseView) },
        ].map(({ Icon, label, onClick, desktopOnly }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={`w-9 h-9 rounded-lg bg-bg-panel border border-line/10 text-ink-secondary
                       hover:text-ink-primary hover:border-line/25 items-center justify-center
                       backdrop-blur transition-colors pointer-events-auto
                       ${desktopOnly ? "hidden sm:flex" : "flex"}`}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One level of a room: its outline, its name, and a second line saying
 * what it lets you book — or, when the room itself is booked or closed,
 * that state as a coloured pill with an icon (colour is never the only
 * signal).
 *
 * The outline is the room's shape on this floor, whatever it is: an
 * L-shaped room is one outline, not two boxes. It is inset a unit from the
 * room's cells so two rooms sharing a wall keep a hairline between them.
 * The name sits in the room's largest rectangle (labelSpot), which is
 * where it reads.
 *
 * The outline is neutral while the room is free. Painting every free room
 * green made it read as one huge "available" unit, which is not what a
 * room in the individual mode is. The focused room takes the accent.
 *
 * Label sizes come from `pxPerUnit` so they hold about 13px on screen at
 * any zoom, and are cut to fit the width they sit in — a long name in a
 * narrow room is truncated rather than spilling over its neighbour.
 *
 * Clicks are not handled here: the map resolves them by cell, so a click
 * anywhere in the room's cells chooses it. The keyboard is.
 */
function RoomShape({ room, cells, state, palette, focused, flagged, pxPerUnit, resourceNoun, interactive, onSelect, faded = false }) {
  const outline = useMemo(() => outlinePath(cells, { cell: CELL, inset: 1, radius: ROOM_RADIUS }), [cells]);
  const spot = useMemo(() => labelSpot(cells), [cells]);
  const x = spot.col * CELL;
  const y = spot.row * CELL;
  const w = spot.w * CELL;
  const h = spot.h * CELL;

  const busy = ROOM_STATE[state] ? state : null;
  const tone = busy ? palette[busy] || palette.unavailable : null;

  const font = clamp(13 / pxPerUnit, 10, 52);
  const small = font * 0.84;
  const inset = clamp(font * 0.75, 8, 24);
  const fit = (size) => Math.max(1, Math.floor((w - inset * 2) / (size * GLYPH)));
  const name = truncate(room.name, fit(font));

  // The second line only at roughly natural size. When the labels are
  // being enlarged to stay readable — a whole floor on a phone — two lines
  // run into the furniture, and the room row above the map already says
  // what each room offers.
  const enlarged = font > 16;
  const showDetail = !enlarged && h >= font * 3.6 + inset;
  const detail = busy ? ROOM_STATE[busy].label : roomMode(room.bookingMode, resourceNoun).short;
  const detailY = y + inset + font * 0.9 + small * 1.45;

  const description =
    `${room.name}: ${roomMode(room.bookingMode, resourceNoun).short}` + (busy ? `, ${ROOM_STATE[busy].label.toLowerCase()}` : "");

  return (
    <g
      className={interactive ? "silla-room" : undefined}
      style={{ opacity: faded ? 0.45 : 1, transition: "opacity var(--dur-base) var(--ease-out)" }}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={interactive ? description : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect();
            }
          : undefined
      }
    >
      <title>{description}</title>
      <path
        className="silla-room-body"
        d={outline}
        fillRule="evenodd"
        style={{
          fill: tone ? tone.color : "rgb(var(--c-line) / 0.03)",
          fillOpacity: tone ? 0.08 : 1,
          stroke: flagged
            ? "var(--color-state-unavailable)"
            : focused
              ? "var(--color-accent)"
              : tone
                ? tone.color
                : "rgb(var(--c-line) / 0.5)",
          strokeOpacity: focused || tone || flagged ? 1 : 0.75,
          strokeWidth: focused || flagged ? 2.5 : 2,
          strokeDasharray: flagged ? "8 5" : undefined,
          strokeLinejoin: "round",
        }}
      />
      <text
        x={x + inset}
        y={y + inset + font * 0.9}
        fontSize={font}
        fontWeight="650"
        style={{ fill: "var(--color-ink-primary)", pointerEvents: "none" }}
      >
        {name}
      </text>
      {showDetail &&
        (busy ? (
          <RoomStatePill
            x={x + inset}
            y={detailY - small}
            size={small}
            tone={tone}
            Icon={ROOM_STATE[busy].Icon}
            label={truncate(detail, fit(small) - 2)}
          />
        ) : (
          <text
            x={x + inset}
            y={detailY}
            fontSize={small}
            fontWeight="500"
            style={{ fill: "var(--color-ink-muted)", pointerEvents: "none" }}
          >
            {truncate(detail, fit(small))}
          </text>
        ))}
    </g>
  );
}

/**
 * A zone: a dashed outline of its shape, and its name in capitals in the
 * shape's largest rectangle. A backdrop that groups pieces, never a target.
 */
function ZoneShape({ zone, cells, flagged }) {
  const outline = useMemo(() => outlinePath(cells, { cell: CELL, inset: 1, radius: ZONE_RADIUS }), [cells]);
  const spot = useMemo(() => labelSpot(cells), [cells]);
  return (
    <g>
      <path
        d={outline}
        fillRule="evenodd"
        style={{
          fill: "var(--color-map-zone-fill)",
          stroke: flagged ? "var(--color-state-unavailable)" : "var(--color-map-zone-stroke)",
          strokeWidth: flagged ? 2.5 : 1.5,
          strokeDasharray: "6 5",
          strokeLinejoin: "round",
        }}
      />
      <text
        x={spot.col * CELL + 10}
        y={spot.row * CELL + 18}
        fontSize="11"
        fontWeight="600"
        letterSpacing="1.2"
        // Two `style` attributes: JSX kept the LAST one, so the
        // fill was silently discarded and zone names painted in
        // the SVG default (black) on a dark map. Merged.
        style={{ fill: "var(--color-ink-muted)", textTransform: "uppercase" }}
      >
        {zone.name}
      </text>
    </g>
  );
}

/**
 * The rest of today, as a thin ring around a unit — the one mark that adds
 * time to a map whose colours mean "right now":
 *
 *   free the rest of the day     no ring at all, so a quiet day stays quiet
 *   partly booked                a neutral hairline ring, with an arc from
 *                                twelve o'clock as long as the share of the
 *                                time left that is booked — the track is what
 *                                makes a short arc read as a share of a day
 *                                rather than as a notch
 *   booked for the rest of day   the whole ring
 *
 * In the reserved state's colour — booked is booked, whatever the brand —
 * and never the only signal: the unit's label and the panel say it in words.
 * Units that cannot be booked at all (out of service, closed, part of a
 * room booked only whole) have no day, and so no ring.
 */
function DayRing({ x, y, w, h, entry }) {
  if (!entry?.bookable || (entry.day !== "partial" && entry.day !== "full")) return null;
  const path = ringPath(x - RING_GAP, y - RING_GAP, w + RING_GAP * 2, h + RING_GAP * 2, 5 + RING_GAP);
  const full = entry.day === "full";
  // However little is booked, the arc stays long enough to see; however
  // much, a partial day never closes the ring.
  const share = full ? 1 : clamp(entry.fraction || 0, 0.15, 0.9);
  const line = { fill: "none", strokeWidth: RING_WIDTH, strokeLinecap: "round" };
  return (
    <g pointerEvents="none" aria-hidden="true">
      {!full && <path d={path} pathLength={1} style={{ ...line, stroke: "rgb(var(--c-line) / 0.42)" }} />}
      <path
        d={path}
        pathLength={1}
        style={{ ...line, stroke: "var(--color-state-reserved)", strokeDasharray: full ? undefined : `${share} 1` }}
      />
    </g>
  );
}

/**
 * A rounded rectangle traced from the middle of its top edge, clockwise, so
 * a dashed stroke starts at twelve o'clock and grows the way a clock does.
 */
function ringPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  const right = x + w;
  const bottom = y + h;
  return (
    `M ${x + w / 2} ${y} H ${right - radius} A ${radius} ${radius} 0 0 1 ${right} ${y + radius} ` +
    `V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom} ` +
    `H ${x + radius} A ${radius} ${radius} 0 0 1 ${x} ${bottom - radius} ` +
    `V ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} Z`
  );
}

/**
 * A unit's share of its piece, for taps: its chip grown halfway across
 * every gap to its neighbours and out to the footprint's edge, so the
 * targets tile the piece with no dead space between them.
 */
function hitArea(chip, footprint) {
  const w = footprint.w * CELL;
  const h = footprint.h * CELL;
  const edge = 0.5;
  const left = chip.x <= PIECE_INSET + edge ? 0 : chip.x - UNIT_GAP / 2;
  const top = chip.y <= PIECE_INSET + edge ? 0 : chip.y - UNIT_GAP / 2;
  const right = chip.x + chip.w >= w - PIECE_INSET - edge ? w : chip.x + chip.w + UNIT_GAP / 2;
  const bottom = chip.y + chip.h >= h - PIECE_INSET - edge ? h : chip.y + chip.h + UNIT_GAP / 2;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A dashed ring in the "unavailable" tone around something in the way —
 * a piece, a label — measured in screen pixels so it reads at any zoom.
 */
function Flag({ x, y, w, h }) {
  return (
    <rect
      x={x - 3}
      y={y - 3}
      width={w + 6}
      height={h + 6}
      rx="9"
      pointerEvents="none"
      style={{
        fill: "none",
        stroke: "var(--color-state-unavailable)",
        strokeWidth: 2.5,
        strokeDasharray: "6 4",
        vectorEffect: "non-scaling-stroke",
      }}
    />
  );
}

/** "Booked now" on the room's own colour, with its icon. */
function RoomStatePill({ x, y, size, tone, Icon, label }) {
  const height = size * 1.7;
  const icon = size * 1.05;
  const pad = size * 0.55;
  const width = pad * 2 + icon + size * 0.4 + label.length * size * GLYPH;
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={x} y={y - size * 0.35} width={width} height={height} rx={height / 2} fill={tone.color} />
      <Icon x={x + pad} y={y - size * 0.35 + (height - icon) / 2} width={icon} height={icon} color={tone.ink} strokeWidth={2.5} />
      <text x={x + pad + icon + size * 0.4} y={y - size * 0.35 + height / 2 + size * 0.36} fontSize={size} fontWeight="600" fill={tone.ink}>
        {label}
      </text>
    </g>
  );
}
