import { useMemo, useRef, useState } from "react";
import { RotateCcw, Square, SquareMinus, SquarePlus } from "lucide-react";
import { areasOf, boundingBox, cellsOf, difference, isRectangle, largestRect, translate, union } from "../lib/cells.js";
import { outlinePath } from "../lib/shapePath.js";
import { Button, Segmented } from "./ui/index.jsx";

/**
 * Sketch a new floor by dragging on a blank grid: its size, and — for a
 * building that is not a rectangle — its outline.
 *
 * Adding a floor asked for two numbers, which is the wrong question:
 * nobody knows their reading room is "20 by 12", they know roughly what
 * shape it is. Drag the rectangle and the numbers fall out of it. Then, for
 * an L, a T or a U, add a wing or cut a corner away the same way the
 * editor's Shape tool does on the real map.
 *
 *   Rectangle   a drag sets the whole outline to that rectangle
 *   Add area    a drag adds its cells to the outline
 *   Cut area    a drag cuts its cells away
 *
 * Deliberately NOT SpaceMap. This draws on an empty canvas with no floor,
 * no pieces and no pan/zoom — reusing the real map here would mean feeding
 * it a fake floor and then hiding half its controls.
 *
 * Only the SHAPE is kept, not where it was drawn: a floor's grid is an
 * extent, not a position. The value is `{ cols, rows, areas }`, with the
 * outline's top-left at (0, 0) and `areas` empty for a plain rectangle,
 * which is how the server stores one. On the canvas the sketch stays where
 * the last edit left it, so it never jumps out from under the pointer.
 */
export default function GridSketch({ cols, rows, areas = [], max = 60, onChange }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [mode, setMode] = useState("size");
  const [note, setNote] = useState(null);

  // The canvas is bigger than any sensible room so there is always space
  // to draw into, but capped at the server's own limit (validateGrid
  // accepts 1–60) — offering a 90-wide sketch it would reject is a trap.
  const canvasCols = Math.min(max, 40);
  const canvasRows = Math.min(max, 24);
  const CELL = 14;

  const areasKey = JSON.stringify(areas);
  const shapeCells = useMemo(
    () => cellsOf(areas.length ? areas : [{ col: 0, row: 0, w: cols, h: rows }]),
    [areasKey, cols, rows] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Centred to begin with, so there is room to add a wing on any side.
  const [offset, setOffset] = useState(() => ({
    col: Math.max(0, Math.floor((canvasCols - cols) / 2)),
    row: Math.max(0, Math.floor((canvasRows - rows) / 2)),
  }));
  // Kept on the canvas when the number fields make the floor bigger.
  const at = {
    col: Math.min(offset.col, Math.max(0, canvasCols - cols)),
    row: Math.min(offset.row, Math.max(0, canvasRows - rows)),
  };
  const drawn = useMemo(() => translate(shapeCells, at.col, at.row), [shapeCells, at.col, at.row]);

  const cellAt = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    const scaleX = canvasCols / r.width;
    const scaleY = canvasRows / r.height;
    return {
      col: Math.max(0, Math.min(canvasCols - 1, Math.floor((clientX - r.left) * scaleX))),
      row: Math.max(0, Math.min(canvasRows - 1, Math.floor((clientY - r.top) * scaleY))),
    };
  };

  const rectOf = (d) => ({
    w: Math.abs(d.start.col - d.end.col) + 1,
    h: Math.abs(d.start.row - d.end.row) + 1,
    col: Math.min(d.start.col, d.end.col),
    row: Math.min(d.start.row, d.end.row),
  });

  /** The outline the drag would leave, on the canvas. */
  const resultOf = (d) => {
    const rect = rectOf(d);
    if (mode === "size") return cellsOf([rect]);
    return mode === "cut" ? difference(drawn, [rect]) : union(drawn, [rect]);
  };

  const begin = (e) => {
    const start = cellAt(e.clientX, e.clientY);
    const next = { start, end: start, x: e.clientX, y: e.clientY, travelled: 0 };
    dragRef.current = next;
    setDrag(next);
    setNote(null);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is an enhancement, never a requirement */
    }
  };

  const move = (e) => {
    const current = dragRef.current;
    if (!current) return;
    const next = {
      ...current,
      end: cellAt(e.clientX, e.clientY),
      x: e.clientX,
      y: e.clientY,
      travelled: current.travelled + Math.hypot(e.clientX - current.x, e.clientY - current.y),
    };
    dragRef.current = next;
    setDrag(next);
  };

  const end = () => {
    const finished = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!finished) return;
    const rect = rectOf(finished);
    // A press that barely moved is a click, not a one-cell floor.
    if (rect.w === 1 && rect.h === 1 && finished.travelled < 12) return;

    const next = resultOf(finished);
    if (!next.size) {
      setNote("That would cut away the whole floor.");
      return;
    }
    const box = boundingBox(next);
    setOffset({ col: box.col, row: box.row });
    const local = translate(next, -box.col, -box.row);
    onChange({ cols: box.w, rows: box.h, areas: isRectangle(local) ? [] : areasOf(local) });
  };

  // What to paint: the live drag's result if there is one, otherwise the
  // current outline.
  const shown = drag ? resultOf(drag) : drawn;
  const box = boundingBox(shown);
  const spot = largestRect(shown);
  const dragged = drag && mode !== "size" ? rectOf(drag) : null;
  const cutting = mode === "cut";
  const shaped = areas.length > 0;

  const hints = {
    size: "Drag to size the floor. Only the shape is kept — where you draw it doesn't matter.",
    add: "Drag to add floor: a wing, the stem of a T, the other arm of an L.",
    cut: "Drag across the outline to cut away what isn't floor: a corner, a courtyard.",
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented
          className="sketch-mode"
          size="sm"
          value={mode}
          onChange={(value) => {
            setMode(value);
            setNote(null);
          }}
          options={[
            { value: "size", label: "Rectangle", icon: Square },
            { value: "add", label: "Add area", icon: SquarePlus },
            { value: "cut", label: "Cut area", icon: SquareMinus },
          ]}
        />
        {shaped && (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onChange({ cols, rows, areas: [] })}>
            Reset to rectangle
          </Button>
        )}
      </div>

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
        aria-label={`Floor sketch, currently ${shaped ? `a shape within ${cols} by ${rows} cells` : `${cols} by ${rows} cells`}`}
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

        {shown.size > 0 && (
          <path
            d={outlinePath(shown, { cell: CELL, radius: 3 })}
            fillRule="evenodd"
            style={{
              fill: "var(--color-accent)",
              fillOpacity: drag ? 0.18 : 0.1,
              stroke: "var(--color-accent)",
              strokeWidth: 2,
              strokeDasharray: drag ? "6 4" : undefined,
              strokeLinejoin: "round",
            }}
          />
        )}
        {dragged && (
          <rect
            x={dragged.col * CELL}
            y={dragged.row * CELL}
            width={dragged.w * CELL}
            height={dragged.h * CELL}
            rx="3"
            pointerEvents="none"
            style={{
              fill: cutting ? "var(--color-state-unavailable)" : "none",
              fillOpacity: 0.16,
              stroke: cutting ? "var(--color-state-unavailable)" : "var(--color-accent)",
              strokeWidth: 1.5,
              strokeDasharray: "4 3",
            }}
          />
        )}
        {box && spot && (
          <text
            x={(spot.col + spot.w / 2) * CELL}
            y={(spot.row + spot.h / 2) * CELL + 4}
            textAnchor="middle"
            fontSize="12"
            fontWeight="700"
            pointerEvents="none"
            style={{ fill: "var(--color-accent)" }}
          >
            {box.w} × {box.h}
          </text>
        )}
      </svg>

      <p className={`mt-2 text-xs ${note ? "text-state-unavailable" : "text-ink-muted"}`} role="status">
        {note || hints[mode]}
      </p>
    </div>
  );
}
