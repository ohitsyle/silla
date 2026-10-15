import { useMemo } from "react";
import { boundingBox, toCells } from "../lib/cells.js";
import { outlinePath } from "../lib/shapePath.js";

/**
 * A shape at thumbnail size — a room level's outline in the room dialog,
 * so "L-shaped" is something you see rather than read. Drawn from the same
 * outline as the map, fitted to its own bounding box.
 */
export default function ShapeGlyph({ areas, size = 36, className = "" }) {
  const cells = useMemo(() => toCells(areas), [areas]);
  const box = boundingBox(cells);
  if (!box) return null;
  const cell = 10;
  const pad = 2;
  return (
    <svg
      viewBox={`${box.col * cell - pad} ${box.row * cell - pad} ${box.w * cell + pad * 2} ${box.h * cell + pad * 2}`}
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <path
        d={outlinePath(cells, { cell, radius: 2 })}
        fillRule="evenodd"
        style={{ fill: "rgb(var(--c-accent) / 0.16)", stroke: "var(--color-accent)", strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }}
      />
    </svg>
  );
}
