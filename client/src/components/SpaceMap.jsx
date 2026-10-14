import { effectiveStatus, roomUnit } from "../lib/rooms.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Ban, Check, Clock, Maximize, TriangleAlert, User, Wrench, ZoomIn, ZoomOut } from "lucide-react";

/**
 * SpaceMap — the read-only grid renderer (MAP-1, spec §12).
 *
 * One shared layout model renders both the member-facing map and, later,
 * the admin editor (MAP-3) — this component owns only the *reading* half.
 * It draws spec §12's three layers, back to front:
 *
 *   zones     — admin-drawn named rectangles; membership is derived from
 *               position, so a zone is purely a backdrop here
 *   resources — catalog pieces on the integer cell grid, each showing its
 *               reservable units by colour AND icon (MAP-1 AC)
 *   labels    — free-typed orientation text; not reservable, no analytics
 *
 * `layout` and `status` are separate props on purpose, mirroring the
 * split in GET /api/floors/:id/layout: layout is fetched once and rarely
 * changes, status is the fast-changing half that Socket.io will stream
 * (MAP-2, spec §17). Wiring MAP-2 means replacing entries in `status` —
 * nothing in this file has to change.
 *
 * Nothing here hardcodes "seat": the unit noun comes from the org's
 * configured terminology (spec §16).
 */

const CELL = 40; // SVG user units per grid cell — integer cells only (spec §12)
const PAD = 1; // one cell of breathing room around the grid
const PIECE_INSET = 5; // gap between a piece's footprint and its body
const UNIT_GAP = 3; // gap between unit chips inside a piece

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
  editing = false,
  fill = false,
  className = "",
}) {
  const svgRef = useRef(null);
  const pointers = useRef(new Map());
  // Distance the last pointer travelled, read by the click handler.
  const lastTravel = useRef(0);

  const grid = floor?.grid || { cols: 0, rows: 0 };

  const rooms = layout?.rooms || [];
  const focusedLevel = rooms.find((r) => r.id === focusedRoomId)?.levels.find((l) => l.floorId === floor?.id);

  const baseView = useMemo(
    () => focusedLevel ? ({
      x: (focusedLevel.bounds.col - PAD) * CELL, y: (focusedLevel.bounds.row - PAD) * CELL,
      w: (focusedLevel.bounds.w + PAD * 2) * CELL, h: (focusedLevel.bounds.h + PAD * 2) * CELL,
    }) : ({ x: -PAD * CELL, y: -PAD * CELL, w: (grid.cols + PAD * 2) * CELL, h: (grid.rows + PAD * 2) * CELL }),
    [grid.cols, grid.rows, floor?.id, focusedRoomId, focusedLevel?.bounds.col, focusedLevel?.bounds.row, focusedLevel?.bounds.w, focusedLevel?.bounds.h]
  );

  const [view, setView] = useState(baseView);

  // Reset the viewport whenever the floor changes — a zoomed-in view of
  // a 20x12 floor makes no sense on a 16x10 one.
  useEffect(() => setView(baseView), [baseView]);

  const zoomLimits = useMemo(() => ({ min: baseView.w / 8, max: baseView.w * 2 }), [baseView.w]);

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
      updateRegion({ start, end: start, pointerId: e.pointerId });
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, captured: false });
  };

  const handlePointerMove = (e) => {
    const drawing = regionRef.current;
    if (drawing && drawing.pointerId === e.pointerId) {
      updateRegion({ ...drawing, end: cellAt(e.clientX, e.clientY) });
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
      // A single cell is almost always a misfire — a click that moved a
      // pixel — so it is dropped rather than creating a 1x1 room.
      if (rect.w > 1 || rect.h > 1) onRegionSelect?.(rect);
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

  const isSelected = (resourceId, unitIndex) =>
    selectedUnit?.resourceId === resourceId && selectedUnit?.unitIndex === unitIndex;

  if (!floor || !layout) return null;

  const gridW = grid.cols * CELL;
  const gridH = grid.rows * CELL;

  return (
    // Two sizing modes.
    //
    // Default: the box takes the grid's own aspect ratio so the SVG
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
              aspectRatio: `${grid.cols + PAD * 2} / ${grid.rows + PAD * 2}`,
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
        style={{ touchAction: "none", cursor: "grab" }}
        role="img"
        aria-label={`Map of ${floor.name}: ${layout.resources.length} pieces on a ${grid.cols} by ${grid.rows} grid`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      >
        <style>{`
          .silla-unit { cursor: pointer; outline: none; }
          .silla-unit:focus-visible .silla-unit-body { stroke: var(--color-accent); stroke-width: 3; }
          .silla-unit:hover .silla-unit-body { filter: brightness(1.18); }
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

        {/* ---- Grid ----
             In editing mode the grid itself is clickable, so an empty
             cell can receive a placement (MAP-3). It sits behind every
             other layer, so a click that lands on a piece hits the piece
             instead — which is what the remove tool needs. */}
        <rect
          x="0"
          y="0"
          width={gridW}
          height={gridH}
          fill="url(#silla-grid)"
          style={
            regionMode
              ? { cursor: "crosshair" }
              : editing && onCellClick
                ? { cursor: "copy" }
                : undefined
          }
          onClick={(e) => {
            if (!editing || !onCellClick) return;
            const rect = svgRef.current.getBoundingClientRect();
            const { x, y } = clientToSvg(rect, view, e.clientX, e.clientY);
            const col = Math.floor(x / CELL);
            const row = Math.floor(y / CELL);
            if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return;
            onCellClick(col, row);
          }}
        />
        <rect
          x="0"
          y="0"
          width={gridW}
          height={gridH}
          fill="none"
          style={{ stroke: "var(--color-map-outline)" }}
          strokeWidth="1.5"
          rx="4"
        />

        {/* ---- Layer: zones (spec §12) ---- */}
        <g>
          {layout.zones.map((zone) => (
            <g key={zone.id}>
              <rect
                x={zone.bounds.col * CELL}
                y={zone.bounds.row * CELL}
                width={zone.bounds.w * CELL}
                height={zone.bounds.h * CELL}
                style={{ fill: "var(--color-map-zone-fill)", stroke: "var(--color-map-zone-stroke)" }}
                strokeWidth="1.5"
                strokeDasharray="6 5"
                rx="8"
              />
              <text
                x={zone.bounds.col * CELL + 10}
                y={zone.bounds.row * CELL + 18}
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
          ))}
        </g>

        {/* Rooms have their own booking identity; their shapes are per floor. */}
        <g>
          {rooms.filter((r) => !focusedRoomId || r.id === focusedRoomId).map((room) => {
            const level = room.levels.find((l) => l.floorId === floor.id);
            if (!level) return null;
            const { col, row, w, h } = level.bounds;
            const state = status[room.resourceId]?.[0]?.status || "available";
            const tone = palette[state] || palette.available;
            const select = () => {
              if (editing || regionMode || wasDrag()) return;
              if (onSelectRoom) onSelectRoom(room);
              else if (!management && room.bookingMode !== "individual") onSelectUnit?.(roomUnit(room, status));
            };
            return <g key={room.id} role="button" tabIndex={editing || regionMode ? -1 : 0}
              aria-label={`${room.name}, ${room.bookingMode === "individual" ? "individual resources" : "room booking"}, ${state}`}
              onClick={select} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } }}>
              <title>{room.name} · {room.levels.length} level{room.levels.length > 1 ? "s" : ""} · {state}</title>
              <rect x={col * CELL + 1} y={row * CELL + 1} width={w * CELL - 2} height={h * CELL - 2} rx="8"
                fill={tone.color} fillOpacity={0.07} stroke={tone.color} strokeOpacity={0.7} strokeWidth="2" />
              <text x={col * CELL + 10} y={row * CELL + 17} fontSize="11" fontWeight="600" style={{ fill: "var(--color-ink-primary)" }}>{room.name.slice(0, Math.max(8, w * 6))}</text>
            </g>;
          })}
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

                {resource.units.map((unit, unitIndex) => {
                  const unitStatus = management ? unitStatuses[unitIndex] : effectiveStatus(resource, unitStatuses[unitIndex], rooms, status);
                  const appearance = resolveUnitAppearance(unitStatus, palette);
                  const overstayed = showOverstay && unitStatus?.overstay;
                  const r = rects[unitIndex];
                  const cx = x + r.x + r.w / 2;
                  const cy = y + r.y + r.h / 2;

                  const iconSize = clamp(Math.min(r.w, r.h) * 0.5, 9, 18);
                  const showIcon = Math.min(r.w, r.h) >= 14;
                  const showLabel = r.h >= 26 && r.w >= 24;
                  const overstayTone = palette.overstay || DEFAULT_PALETTE.overstay;
                  const Icon = overstayed ? OVERSTAY_META.Icon : appearance.Icon;
                  const fill = overstayed ? overstayTone.color : appearance.color;
                  const ink = overstayed ? overstayTone.ink : appearance.ink;
                  const selected = isSelected(resource.id, unitIndex);
                  const isHighlighted = highlighted.has(`${resource.id}:${unit.label}`);

                  const description =
                    `${type.label} · ${resourceNoun} ${unit.label} — ${appearance.statusLabel}` +
                    (overstayed ? ` · ${OVERSTAY_META.label}` : "");

                  return (
                    <g
                      key={`${resource.id}-${unitIndex}`}
                      className="silla-unit"
                      role="button"
                      tabIndex={0}
                      aria-label={description}
                      onClick={(e) => {
                        if (wasDrag()) return;
                        if (unitStatus?.roomBlocked && !management) { onSelectRoom?.(rooms.find((r) => r.id === resource.roomId)); return; }
                        onSelectUnit?.({
                          resourceId: resource.id,
                          unitIndex,
                          unitLabel: unit.label,
                          type,
                          position: resource.position,
                          status: unitStatus,
                          statusLabel: appearance.statusLabel,
                          overstay: Boolean(overstayed),
                        });
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        if (unitStatus?.roomBlocked && !management) { onSelectRoom?.(rooms.find((r) => r.id === resource.roomId)); return; }
                        onSelectUnit?.({
                          resourceId: resource.id,
                          unitIndex,
                          unitLabel: unit.label,
                          type,
                          position: resource.position,
                          status: unitStatus,
                          statusLabel: appearance.statusLabel,
                          overstay: Boolean(overstayed),
                        });
                      }}
                    >
                      <title>{description}</title>
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
                        style={
                          selected
                            ? { stroke: "var(--color-accent)", strokeWidth: 3 }
                            : isHighlighted
                              ? { stroke: "var(--color-accent)", strokeWidth: 2, strokeDasharray: "4 3" }
                              : { stroke: "rgb(var(--c-bg-page) / 0.45)", strokeWidth: 1 }
                        }
                      />
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
        <g>
          {layout.labels.map((label) => (
            <text
              key={label.id}
              x={label.position.col * CELL + CELL / 2}
              y={label.position.row * CELL + CELL / 2 + 4}
              textAnchor="middle"
              fontSize="11"
              fontWeight="500"
              letterSpacing="0.6"
              style={{ fill: "var(--color-ink-secondary)", pointerEvents: "none" }}
            >
              {label.text}
            </text>
          ))}
        </g>
        {/* ---- Layer: the rectangle being dragged out ---- */}
        {region && (() => {
          const r = normalise(region.start, region.end);
          return (
            <g pointerEvents="none">
              <rect
                x={r.col * CELL}
                y={r.row * CELL}
                width={r.w * CELL}
                height={r.h * CELL}
                rx="6"
                style={{
                  fill: "var(--color-accent)",
                  fillOpacity: 0.14,
                  stroke: "var(--color-accent)",
                }}
                strokeWidth="2"
                strokeDasharray="6 4"
              />
              {/* The size, stated while you draw it — the number is the
                  thing the old form was asking you to know in advance. */}
              <text
                x={r.col * CELL + (r.w * CELL) / 2}
                y={r.row * CELL + (r.h * CELL) / 2 + 5}
                textAnchor="middle"
                fontSize="14"
                fontWeight="700"
                style={{ fill: "var(--color-accent)" }}
              >
                {r.w} × {r.h}
              </text>
            </g>
          );
        })()}

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
