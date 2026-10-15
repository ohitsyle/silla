import { outlineLoops } from "./cells.js";

/**
 * SVG path data for a shape's outline: a floor's walls, a room's or a
 * zone's boundary, the sketch of a new floor.
 *
 * lib/cells.js walks the outline as closed loops of corners in grid lines;
 * this only draws them. Kept apart from cells.js because that file is the
 * geometry the server shares byte for byte, and the server draws nothing.
 *
 *   cell     SVG units per grid cell
 *   inset    pulls every wall inwards by this many units, so two rooms that
 *            share a wall keep a hairline between their outlines instead of
 *            drawing one line on top of the other
 *   radius   rounds each corner, convex and concave alike, so an L reads as
 *            one drawn shape rather than two rectangles butted together
 *
 * One path holds every loop, so a floor around a courtyard is one shape
 * with a hole. Fill it with fill-rule="evenodd".
 */
export function outlinePath(shape, { cell, inset = 0, radius = 0 }) {
  return outlineLoops(shape)
    .map((loop) => loopPath(insetLoop(loop.map((p) => ({ x: p.x * cell, y: p.y * cell })), inset), radius))
    .join(" ");
}

/**
 * Moves each corner `d` units into the shape. Every wall in a loop runs
 * with the shape on its right (cells.js), so "into the shape" is the
 * right-hand normal of each wall, and a corner moves along the sum of the
 * normals of the two walls that meet there. That is exact for the square
 * corners a grid shape has, convex or concave.
 */
function insetLoop(points, d) {
  if (!d) return points;
  const n = points.length;
  return points.map((p, i) => {
    const before = direction(points[(i - 1 + n) % n], p);
    const after = direction(p, points[(i + 1) % n]);
    return { x: p.x - d * (before.y + after.y), y: p.y + d * (before.x + after.x) };
  });
}

/** One closed loop, its corners rounded by up to `radius` (never more than half a wall). */
function loopPath(points, radius) {
  const n = points.length;
  if (!radius) return `M${points.map(fmt).join(" L")} Z`;
  return (
    points
      .map((p, i) => {
        const before = points[(i - 1 + n) % n];
        const after = points[(i + 1) % n];
        const r = Math.min(radius, distance(before, p) / 2, distance(p, after) / 2);
        const start = towards(p, before, r);
        const end = towards(p, after, r);
        return `${i === 0 ? "M" : "L"}${fmt(start)} Q${fmt(p)} ${fmt(end)}`;
      })
      .join(" ") + " Z"
  );
}

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function direction(from, to) {
  const length = distance(from, to) || 1;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/** The point `r` units from `p` towards `q`. */
function towards(p, q, r) {
  const { x, y } = direction(p, q);
  return { x: p.x + x * r, y: p.y + y * r };
}

const fmt = (p) => `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`;
