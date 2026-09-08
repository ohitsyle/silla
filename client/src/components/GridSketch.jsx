import { useRef, useState } from "react";

/**
 * Sketch a room's extent by dragging a box on a blank grid.
 *
 * Adding a floor asked for two numbers, which is the wrong question:
 * nobody knows their reading room is "20 by 12", they know roughly what
 * shape it is. Drag the rectangle and the numbers fall out of it.
 *
 * Deliberately NOT SpaceMap. This draws on an empty canvas with no
 * floor, no pieces and no pan/zoom — reusing the real map here would
 * mean feeding it a fake floor and then hiding half its controls.
 *
 * Only the SIZE is kept. Where you start the drag is irrelevant because
 * a floor's grid is an extent, not a position — so sketching in the
 * middle of the canvas gives the same result as sketching in the corner.
 * The numbers stay editable alongside for when someone does know them.
 */
export default function GridSketch({ cols, rows, max = 60, onChange }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);

  // The canvas is bigger than any sensible room so there is always space
  // to draw into, but capped at the server's own limit (validateGrid
  // accepts 1–60) — offering a 90-wide sketch it would reject is a trap.
  const canvasCols = Math.min(max, 40);
  const canvasRows = Math.min(max, 24);
  const CELL = 14;

  const cellAt = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    const scaleX = canvasCols / r.width;
    const scaleY = canvasRows / r.height;
    return {
      col: Math.max(0, Math.min(canvasCols - 1, Math.floor((clientX - r.left) * scaleX))),
      row: Math.max(0, Math.min(canvasRows - 1, Math.floor((clientY - r.top) * scaleY))),
    };
  };

  const rectOf = (d) =>
    d && {
      w: Math.abs(d.start.col - d.end.col) + 1,
      h: Math.abs(d.start.row - d.end.row) + 1,
      col: Math.min(d.start.col, d.end.col),
      row: Math.min(d.start.row, d.end.row),
    };

  const begin = (e) => {
    const start = cellAt(e.clientX, e.clientY);
    const next = { start, end: start };
    dragRef.current = next;
    setDrag(next);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an enhancement, never a requirement */
    }
  };

  const move = (e) => {
    if (!dragRef.current) return;
    const next = { ...dragRef.current, end: cellAt(e.clientX, e.clientY) };
    dragRef.current = next;
    setDrag(next);
  };

  const end = () => {
    const r = rectOf(dragRef.current);
    dragRef.current = null;
    setDrag(null);
    if (r) onChange({ cols: r.w, rows: r.h });
  };

  // What to paint: the live drag if there is one, otherwise the current
  // value, anchored at the origin so the shape reads as the room.
  const shown = rectOf(drag) || { col: 0, row: 0, w: cols, h: rows };

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${canvasCols * CELL} ${canvasRows * CELL}`}
        className="w-full rounded-md border border-line/10 bg-bg-panel touch-none select-none"
        style={{ cursor: "crosshair", aspectRatio: `${canvasCols} / ${canvasRows}` }}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        role="application"
        aria-label={`Room size sketch, currently ${cols} by ${rows} cells`}
      >
        <defs>
          <pattern id="sketch-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
            <path
              d={`M ${CELL} 0 L 0 0 0 ${CELL}`}
              fill="none"
              stroke="var(--color-map-grid)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#sketch-grid)" />

        <rect
          x={shown.col * CELL}
          y={shown.row * CELL}
          width={shown.w * CELL}
          height={shown.h * CELL}
          rx="4"
          style={{
            fill: "var(--color-accent)",
            fillOpacity: drag ? 0.18 : 0.1,
            stroke: "var(--color-accent)",
          }}
          strokeWidth="2"
          strokeDasharray={drag ? "6 4" : undefined}
        />
        <text
          x={shown.col * CELL + (shown.w * CELL) / 2}
          y={shown.row * CELL + (shown.h * CELL) / 2 + 4}
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          pointerEvents="none"
          style={{ fill: "var(--color-accent)" }}
        >
          {shown.w} × {shown.h}
        </text>
      </svg>

      <p className="mt-2 text-xs text-ink-muted">
        Drag to sketch the room. Only the size is kept — where you draw it doesn't matter.
      </p>
    </div>
  );
}
