/**
 * Shapes on the floor grid: floors, rooms and zones that are not plain
 * rectangles, such as an L-shaped floor or a T-shaped reading room.
 *
 * THE MODEL. A shape is a SET OF CELLS. The map is a grid of whole cells
 * (spec §12), so any outline with square corners (an L, a T, a U, a floor
 * around a courtyard) is exactly a set of cells, and every question the
 * map asks of a shape becomes a set operation:
 *
 *   is this piece on the floor?        every footprint cell is in the set
 *   do these two rooms overlap?        the two sets share a cell
 *   does a boundary cut a piece?       some footprint cells are in, some out
 *
 * Stored, a shape is a short list of rectangles ({ col, row, w, h }) whose
 * union is the set: compact, readable in a document, and the same form a
 * plain rectangle already had. `areasOf` turns any set back into a
 * canonical list, so two drawings of the same shape store the same
 * rectangles however many drags made them.
 *
 * Curves and diagonal walls are out of scope on purpose. On a grid they can
 * only be staircases of cells, which is usually good enough for a floor
 * plan and never ambiguous.
 *
 * THIS FILE EXISTS TWICE, byte for byte: server/src/lib/cells.js and
 * client/src/lib/cells.js. The client and the server never import from
 * each other, and both must agree on what a shape contains or the editor
 * would offer what the server refuses. The spatial suite fails when the two
 * copies differ, so change both or neither.
 */

/** A shape may be drawn from at most this many rectangles. */
export const MAX_AREAS = 200;

/** The key a cell is stored under in a shape's Set. */
export const cellKey = (col, row) => `${col},${row}`;

/** The cell a key names. */
export function cellOf(key) {
  const comma = key.indexOf(",");
  return { col: Number(key.slice(0, comma)), row: Number(key.slice(comma + 1)) };
}

/**
 * The cells covered by a list of rectangles: their union. Overlapping
 * rectangles are fine, since a cell is either in the shape or not.
 *
 * A rectangle that is not whole numbers is skipped rather than looped over:
 * everything stored has been through normaliseAreas, and this guard only
 * keeps a malformed value from turning into an endless loop.
 */
export function cellsOf(areas) {
  const cells = new Set();
  for (const area of areas || []) {
    if (!area || ![area.col, area.row, area.w, area.h].every(Number.isInteger)) continue;
    for (let row = area.row; row < area.row + area.h; row += 1) {
      for (let col = area.col; col < area.col + area.w; col += 1) cells.add(cellKey(col, row));
    }
  }
  return cells;
}

/**
 * Anything shape-like as a Set of cells: a Set already, a list of
 * rectangles, or a single rectangle (a piece's footprint, a legacy bounds).
 */
export function toCells(shape) {
  if (shape instanceof Set) return shape;
  if (!shape) return new Set();
  return cellsOf(Array.isArray(shape) ? shape : [shape]);
}

/**
 * A set of cells as a short, canonical list of rectangles.
 *
 * It sweeps the cells row by row, takes each row's runs of neighbouring
 * cells, and grows a rectangle downwards for as long as the run below has
 * the same ends. It then does the same column by column and keeps
 * whichever answer needs fewer rectangles: a comb lying on its side splits
 * badly one way and well the other. The answer depends only on the cells,
 * so an L is two rectangles however it was drawn.
 */
export function areasOf(shape) {
  const cells = toCells(shape);
  const byRows = sweep(cells, false);
  const byColumns = sweep(cells, true);
  const best = byColumns.length < byRows.length ? byColumns : byRows;
  return best.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** One direction of areasOf: lines are rows, or columns when `columnwise`. */
function sweep(cells, columnwise) {
  const lines = new Map();
  for (const key of cells) {
    const { col, row } = cellOf(key);
    const line = columnwise ? col : row;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push(columnwise ? row : col);
  }

  const rects = [];
  // The rectangles that reached the previous line, by the run they cover.
  let growing = new Map();
  for (const line of [...lines.keys()].sort((a, b) => a - b)) {
    const reached = new Map();
    for (const [start, end] of runsOf(lines.get(line).sort((a, b) => a - b))) {
      const id = `${start}:${end}`;
      let rect = growing.get(id);
      if (rect && rect.line + rect.depth === line) rect.depth += 1;
      else {
        rect = { line, start, length: end - start + 1, depth: 1 };
        rects.push(rect);
      }
      reached.set(id, rect);
    }
    growing = reached;
  }
  return rects.map(({ line, start, length, depth }) =>
    columnwise ? { col: line, row: start, w: depth, h: length } : { col: start, row: line, w: length, h: depth }
  );
}

/** Sorted positions as [start, end] runs of neighbours: [1,2,3,7,8] → [[1,3],[7,8]]. */
function runsOf(sorted) {
  const runs = [];
  for (const at of sorted) {
    const last = runs[runs.length - 1];
    if (last && at === last[1] + 1) last[1] = at;
    else runs.push([at, at]);
  }
  return runs;
}

/** The smallest rectangle around a shape, or null for an empty one. */
export function boundingBox(shape) {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const key of toCells(shape)) {
    const { col, row } = cellOf(key);
    minCol = Math.min(minCol, col);
    minRow = Math.min(minRow, row);
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, row);
  }
  if (minCol === Infinity) return null;
  return { col: minCol, row: minRow, w: maxCol - minCol + 1, h: maxRow - minRow + 1 };
}

/** True when the shape is a plain rectangle: it fills its own bounding box. */
export function isRectangle(shape) {
  const cells = toCells(shape);
  const box = boundingBox(cells);
  return Boolean(box) && cells.size === box.w * box.h;
}

/**
 * True when every cell of `region` is in `shape`: a piece on the floor, a
 * room inside the floor's outline, a piece inside a room. An empty region
 * is contained by anything.
 */
export function contains(shape, region) {
  const outer = toCells(shape);
  for (const key of toCells(region)) if (!outer.has(key)) return false;
  return true;
}

/** True when the two shapes share at least one cell. */
export function intersects(a, b) {
  const [small, large] = [toCells(a), toCells(b)].sort((x, y) => x.size - y.size);
  for (const key of small) if (large.has(key)) return true;
  return false;
}

/** The cells in either shape. */
export const union = (a, b) => new Set([...toCells(a), ...toCells(b)]);

/** The cells of `a` that are not in `b`: what is left after cutting `b` away. */
export function difference(a, b) {
  const cut = toCells(b);
  return new Set([...toCells(a)].filter((key) => !cut.has(key)));
}

/** The cells in both shapes. */
export function intersection(a, b) {
  const other = toCells(b);
  return new Set([...toCells(a)].filter((key) => other.has(key)));
}

/** The shape moved `dc` columns right and `dr` rows down. */
export function translate(shape, dc, dr) {
  return new Set(
    [...toCells(shape)].map((key) => {
      const { col, row } = cellOf(key);
      return cellKey(col + dc, row + dr);
    })
  );
}

/**
 * The largest rectangle that fits wholly inside the shape: where a room's
 * or a zone's name goes.
 *
 * `usefulHeight` measures size the way a label uses it. A name is a line
 * of text, so past a couple of cells of height only width helps it: in a
 * T, the stem and the bar above it make the largest rectangle by area, but
 * the bar is where the name reads. Ties go to the larger area, then the
 * top, then the left, so a given shape's label always lands in one place.
 *
 * The classic "largest rectangle in a histogram", once per row: each column
 * holds the height of the unbroken run of cells ending on that row.
 */
export function largestRect(shape, { usefulHeight = Infinity } = {}) {
  const cells = toCells(shape);
  const box = boundingBox(cells);
  if (!box) return null;

  const heights = new Array(box.w).fill(0);
  let best = null;
  for (let row = box.row; row < box.row + box.h; row += 1) {
    for (let i = 0; i < box.w; i += 1) heights[i] = cells.has(cellKey(box.col + i, row)) ? heights[i] + 1 : 0;

    const rising = [];
    for (let i = 0; i <= box.w; i += 1) {
      const height = i < box.w ? heights[i] : 0;
      let start = i;
      while (rising.length && rising[rising.length - 1].height >= height) {
        const bar = rising.pop();
        if (bar.height > 0) {
          const candidate = { col: box.col + bar.start, row: row - bar.height + 1, w: i - bar.start, h: bar.height };
          if (isLarger(candidate, best, usefulHeight)) best = candidate;
        }
        start = bar.start;
      }
      rising.push({ start, height });
    }
  }
  return best;
}

function isLarger(candidate, best, usefulHeight) {
  if (!best) return true;
  const useful = (r) => r.w * Math.min(r.h, usefulHeight);
  if (useful(candidate) !== useful(best)) return useful(candidate) > useful(best);
  if (candidate.w * candidate.h !== best.w * best.h) return candidate.w * candidate.h > best.w * best.h;
  return candidate.row < best.row || (candidate.row === best.row && candidate.col < best.col);
}

/* ─────────────────────────────── outlines ─────────────────────────────── */

const STEP = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] };
const RIGHT_OF = { E: "S", S: "W", W: "N", N: "E" };
const LEFT_OF = { E: "N", N: "W", W: "S", S: "E" };

/**
 * The shape's outline as closed loops of corner points, in grid lines (x is
 * a column line, y a row line; multiply by the cell size to draw).
 *
 * Every side of a cell with no cell beyond it is wall. Each is walked with
 * the shape on its right-hand side, so with y pointing down an outside edge
 * runs clockwise and the edge of a hole (a courtyard) anticlockwise. Joined
 * up, they are closed loops; points along a straight wall are dropped, so a
 * loop lists only its corners, starting from its top-left corner.
 *
 * Where two cells touch only at a corner, the walk turns towards the shape
 * first. That keeps the two as separate loops rather than one figure of
 * eight, which would draw a wall straight through the pinch.
 */
export function outlineLoops(shape) {
  const cells = toCells(shape);
  const has = (col, row) => cells.has(cellKey(col, row));

  const edges = [];
  for (const key of cells) {
    const { col, row } = cellOf(key);
    if (!has(col, row - 1)) edges.push({ x: col, y: row, dir: "E" });
    if (!has(col + 1, row)) edges.push({ x: col + 1, y: row, dir: "S" });
    if (!has(col, row + 1)) edges.push({ x: col + 1, y: row + 1, dir: "W" });
    if (!has(col - 1, row)) edges.push({ x: col, y: row + 1, dir: "N" });
  }

  // Edges by the point they start from, then by direction.
  const from = new Map();
  for (const edge of edges) {
    const at = cellKey(edge.x, edge.y);
    if (!from.has(at)) from.set(at, {});
    from.get(at)[edge.dir] = edge;
  }
  const following = (edge) => {
    const [dx, dy] = STEP[edge.dir];
    const out = from.get(cellKey(edge.x + dx, edge.y + dy));
    return out[RIGHT_OF[edge.dir]] || out[edge.dir] || out[LEFT_OF[edge.dir]];
  };

  edges.sort((a, b) => a.y - b.y || a.x - b.x);
  const walked = new Set();
  const loops = [];
  for (const first of edges) {
    if (walked.has(first)) continue;
    const corners = [];
    let edge = first;
    do {
      walked.add(edge);
      const next = following(edge);
      if (next.dir !== edge.dir) corners.push({ x: next.x, y: next.y });
      edge = next;
    } while (edge !== first);

    const start = corners.reduce((best, point, i) => {
      const top = corners[best];
      return point.y < top.y || (point.y === top.y && point.x < top.x) ? i : best;
    }, 0);
    loops.push([...corners.slice(start), ...corners.slice(0, start)]);
  }
  return loops;
}

/**
 * The outline as straight wall segments, corner to corner, in grid lines.
 * The same walls as outlineLoops, for whoever wants lines rather than loops.
 */
export function outlineEdges(shape) {
  return outlineLoops(shape).flatMap((loop) =>
    loop.map((point, i) => {
      const next = loop[(i + 1) % loop.length];
      return { x1: point.x, y1: point.y, x2: next.x, y2: next.y };
    })
  );
}

/* ─────────────────────────── stored shapes ─────────────────────────── */

/**
 * Checks a drawn shape and returns it in canonical form, ready to store:
 * `{ areas, cells }`, or `{ error }` with a sentence for the person who
 * drew it. `noun` names what was drawn ("room", "zone", "floor outline").
 *
 * Every rectangle must be whole cells inside the grid. Overlaps are
 * allowed, since the union is what counts. The rectangle cap holds both for
 * what was sent and for the canonical answer, because the union of a few
 * overlapping rectangles can take a few more to describe.
 */
export function normaliseAreas(input, grid, { noun = "shape", max = MAX_AREAS } = {}) {
  const tooIntricate = `The ${noun} is too intricate. Keep it to ${max} rectangles or fewer.`;
  if (!Array.isArray(input)) return { error: `Draw the ${noun} using whole grid cells.` };
  if (!input.length) return { error: `The ${noun} needs at least one cell.` };
  if (input.length > max) return { error: tooIntricate };

  for (const area of input) {
    const whole = Boolean(area) && typeof area === "object" && [area.col, area.row, area.w, area.h].every(Number.isInteger);
    if (!whole || area.col < 0 || area.row < 0 || area.w < 1 || area.h < 1) {
      return { error: `Draw the ${noun} using whole grid cells.` };
    }
    if (area.col + area.w > grid.cols || area.row + area.h > grid.rows) {
      return { error: `The ${noun} reaches past the edge of the grid.` };
    }
  }

  const cells = cellsOf(input);
  const areas = areasOf(cells);
  if (areas.length > max) return { error: tooIntricate };
  return { areas, cells };
}

/** Rectangles as plain { col, row, w, h } objects, whatever document they came from. */
export const plainAreas = (areas) => (areas || []).map(({ col, row, w, h }) => ({ col, row, w, h }));

/**
 * The rectangles a room level or a zone covers.
 *
 * Written before shapes existed, a level or zone has one `bounds` and no
 * `areas`, and reads exactly as it always did. Written since, `areas` is
 * the shape and `bounds` only its bounding box, kept so a reader that
 * predates shapes still finds roughly where it is.
 */
export function regionAreas(region) {
  if (region?.areas?.length) return plainAreas(region.areas);
  return region?.bounds ? plainAreas([region.bounds]) : [];
}

/**
 * The rectangles that ARE the floor. A floor with no outline (every floor
 * drawn before shapes existed, and every plain rectangle since) is its
 * whole grid.
 */
export function floorAreas(floor) {
  if (floor?.shape?.areas?.length) return plainAreas(floor.shape.areas);
  const cols = floor?.grid?.cols || 0;
  const rows = floor?.grid?.rows || 0;
  return cols > 0 && rows > 0 ? [{ col: 0, row: 0, w: cols, h: rows }] : [];
}

/** The floor's cells: where things can be placed and drawn. */
export const floorCells = (floor) => cellsOf(floorAreas(floor));
