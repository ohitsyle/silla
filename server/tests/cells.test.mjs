/**
 * Shape geometry (lib/cells.js): floors, rooms and zones as sets of grid
 * cells. Pure functions, so no database. Run first by `npm run test:spaces`;
 * also runnable alone with `node tests/cells.test.mjs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_AREAS, areasOf, boundingBox, cellKey, cellsOf, contains, difference, floorAreas, floorCells, intersection,
  intersects, isRectangle, largestRect, normaliseAreas, outlineEdges, outlineLoops, regionAreas, translate, union,
} from "../src/lib/cells.js";
import { nextNumber, numberPieces, pieceName, unitName } from "../src/lib/names.js";

let passed = 0;
function check(name, value) {
  assert.ok(value, name);
  passed += 1;
  console.log("PASS " + name);
}

const rect = (col, row, w, h) => ({ col, row, w, h });
const sameCells = (a, b) => a.size === b.size && [...a].every((key) => b.has(key));
/** Twice the signed area of a loop: positive runs clockwise on screen (y down), negative anticlockwise. */
const signedArea = (loop) =>
  loop.reduce((sum, p, i) => {
    const q = loop[(i + 1) % loop.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);

/* The shapes the owner asked about, each as the rectangles someone might drag. */
const L = [rect(0, 0, 10, 5), rect(0, 5, 5, 5)];
const T = [rect(0, 0, 15, 3), rect(5, 3, 5, 7)];
const U = [rect(0, 0, 3, 7), rect(8, 0, 3, 7), rect(0, 7, 11, 3)];
const COURTYARD = [rect(0, 0, 8, 2), rect(0, 6, 8, 2), rect(0, 2, 2, 4), rect(6, 2, 2, 4)];

/* ─────────────────────────── cells and rectangles ─────────────────────────── */

check("cellsOf takes the union, so overlapping rectangles count once", cellsOf([rect(0, 0, 3, 3), rect(1, 1, 3, 3)]).size === 14);
check("an L is 75 cells", cellsOf(L).size === 75);
check(
  "a malformed rectangle is skipped instead of looping forever",
  cellsOf([rect(0, 0, 2, 2), { col: 0, row: 0, w: Infinity, h: 1 }, null]).size === 4
);

check("an L stores as two rectangles", JSON.stringify(areasOf(cellsOf(L))) === JSON.stringify(L));
check("a T stores as two rectangles", areasOf(cellsOf(T)).length === 2);
check("a U stores as three rectangles", areasOf(cellsOf(U)).length === 3);
check("a floor around a courtyard stores as four", areasOf(cellsOf(COURTYARD)).length === 4);
check("a plus stores as three", areasOf(cellsOf([rect(4, 0, 3, 10), rect(0, 4, 11, 3)])).length === 3);

// A comb lying on its side: the spine is one column, the teeth are rows.
// Swept by rows it would be nine strips; swept by columns it is six.
const comb = [rect(0, 0, 2, 9), ...[0, 2, 4, 6, 8].map((row) => rect(2, row, 8, 1))];
check("areasOf keeps whichever sweep needs fewer rectangles", areasOf(cellsOf(comb)).length === 6);

const drawnOneWay = cellsOf([rect(0, 0, 10, 10)]);
const drawnAnother = union(cellsOf([rect(0, 0, 4, 10)]), cellsOf([rect(4, 0, 6, 10)]));
check(
  "two drawings of the same shape store the same rectangles",
  JSON.stringify(areasOf(drawnOneWay)) === JSON.stringify(areasOf(drawnAnother)) && areasOf(drawnOneWay).length === 1
);
check("stored rectangles cover exactly the drawn cells", sameCells(cellsOf(areasOf(cellsOf(U))), cellsOf(U)));
check(
  "stored rectangles never overlap",
  areasOf(cellsOf(COURTYARD)).reduce((sum, area) => sum + area.w * area.h, 0) === cellsOf(COURTYARD).size
);

check("the bounding box of an L is its full extent", JSON.stringify(boundingBox(L)) === JSON.stringify(rect(0, 0, 10, 10)));
check("an empty shape has no bounding box", boundingBox(new Set()) === null);
check("a rectangle is a rectangle", isRectangle([rect(2, 3, 4, 5)]) && isRectangle([rect(0, 0, 2, 4), rect(2, 0, 3, 4)]));
check("an L is not a rectangle", !isRectangle(L));

/* ─────────────────────────────── set questions ─────────────────────────────── */

const floor = cellsOf(L);
check("a piece in the second arm of an L is on the floor", contains(floor, rect(1, 7, 2, 1)));
check("a piece in the missing corner is not", !contains(floor, rect(7, 7, 2, 1)));
check("a piece straddling the inside corner is not", !contains(floor, rect(4, 6, 2, 1)));
check("a cell set and a rectangle list answer the same", contains(L, cellsOf([rect(1, 7, 2, 1)])));

check("shapes that share one cell intersect", intersects(L, rect(4, 9, 3, 3)));
check("shapes that only touch along a wall do not", !intersects(L, rect(5, 5, 5, 5)));
check("union, difference and intersection agree", (() => {
  const a = cellsOf([rect(0, 0, 4, 4)]);
  const b = cellsOf([rect(2, 2, 4, 4)]);
  return union(a, b).size === 28 && difference(a, b).size === 12 && intersection(a, b).size === 4;
})());
check("translate moves every cell", sameCells(translate(cellsOf([rect(0, 0, 2, 1)]), 3, 4), cellsOf([rect(3, 4, 2, 1)])));

check("the largest rectangle in a T runs down its stem and through the bar", JSON.stringify(largestRect(T)) === JSON.stringify(rect(5, 0, 5, 10)));
const labelSpot = (shape) => JSON.stringify(largestRect(shape, { usefulHeight: 2 }));
check("measured for a label, a T's largest rectangle is its bar", labelSpot(T) === JSON.stringify(rect(0, 0, 15, 3)));
check("measured for a label, an L's is its wider part", labelSpot(L) === JSON.stringify(rect(0, 0, 10, 5)));
check(
  "a tie for the label goes to the top, then the left",
  JSON.stringify(largestRect([rect(0, 4, 3, 2), rect(5, 0, 3, 2), rect(0, 0, 3, 2)])) === JSON.stringify(rect(0, 0, 3, 2))
);
check("the largest rectangle can span both rectangles it was drawn as", (() => {
  const best = largestRect([rect(0, 0, 3, 4), rect(3, 1, 5, 2)]);
  return JSON.stringify(best) === JSON.stringify(rect(0, 1, 8, 2));
})());

/* ─────────────────────────────── outlines ─────────────────────────────── */

const square = outlineLoops([rect(1, 2, 3, 4)]);
check(
  "a rectangle's outline is one loop of four corners from its top-left, clockwise",
  square.length === 1 &&
    JSON.stringify(square[0]) === JSON.stringify([{ x: 1, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 6 }, { x: 1, y: 6 }])
);
check(
  "an L's outline is one loop of six corners",
  JSON.stringify(outlineLoops(L)) ===
    JSON.stringify([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 }]])
);
check("a T's outline has eight corners", outlineLoops(T)[0].length === 8);
const ring = outlineLoops(COURTYARD);
check(
  "a courtyard draws as an outer wall and the courtyard's wall, the two running opposite ways",
  ring.length === 2 && signedArea(ring[0]) > 0 && signedArea(ring[1]) < 0 && ring.every((loop) => loop.length === 4)
);
const pinch = outlineLoops([rect(0, 0, 1, 1), rect(1, 1, 1, 1)]);
check("cells touching only at a corner keep separate outlines", pinch.length === 2 && pinch.every((loop) => loop.length === 4));
const walls = outlineEdges(L);
check(
  "the walls of an L are six straight segments, 40 cells of wall in all",
  walls.length === 6 && walls.reduce((sum, wall) => sum + Math.abs(wall.x2 - wall.x1) + Math.abs(wall.y2 - wall.y1), 0) === 40
);

/* ─────────────────────────────── validation ─────────────────────────────── */

const grid = { cols: 12, rows: 10 };
/** Refused, with the sentence the person who drew it would read. */
const refused = (scenario, input, expected) =>
  check(`refuses ${scenario}`, normaliseAreas(input, grid, { noun: "room" }).error === expected);
const WHOLE_CELLS = "Draw the room using whole grid cells.";
refused("something that is not a list of rectangles", { col: 0, row: 0, w: 2, h: 2 }, WHOLE_CELLS);
refused("a shape with no cells", [], "The room needs at least one cell.");
refused("a fraction of a cell", [rect(0, 0, 1.5, 2)], WHOLE_CELLS);
refused("a negative position", [rect(-1, 0, 2, 2)], WHOLE_CELLS);
refused("an empty rectangle", [rect(0, 0, 0, 2)], WHOLE_CELLS);
refused("a rectangle past the edge of the grid", [rect(10, 0, 3, 2)], "The room reaches past the edge of the grid.");
refused(
  `more than ${MAX_AREAS} rectangles`,
  Array.from({ length: MAX_AREAS + 1 }, () => rect(0, 0, 1, 1)),
  `The room is too intricate. Keep it to ${MAX_AREAS} rectangles or fewer.`
);
check(
  "the refusal names what was drawn",
  normaliseAreas([rect(11, 0, 2, 1)], grid, { noun: "zone" }).error === "The zone reaches past the edge of the grid."
);
const drawn = normaliseAreas([rect(0, 0, 6, 3), rect(0, 2, 3, 5), rect(1, 1, 2, 2)], grid, { noun: "room" });
check(
  "overlapping drags are accepted and stored canonically",
  !drawn.error && drawn.areas.length === 2 && drawn.cells.size === 30 && sameCells(cellsOf(drawn.areas), drawn.cells)
);

/* ─────────────────────── documents written before shapes ─────────────────────── */

check("a level written with areas reads its areas", regionAreas({ bounds: rect(0, 0, 10, 10), areas: L }).length === 2);
check("a level written before shapes reads its one bounds", JSON.stringify(regionAreas({ bounds: rect(1, 1, 4, 4) })) === JSON.stringify([rect(1, 1, 4, 4)]));
check("an empty areas list still falls back to bounds", regionAreas({ bounds: rect(1, 1, 4, 4), areas: [] }).length === 1);
check("a floor with no shape is its whole grid", floorCells({ grid: { cols: 20, rows: 12 } }).size === 240);
check("a floor with an empty outline is its whole grid", floorAreas({ grid: { cols: 3, rows: 2 }, shape: { areas: [] } })[0].w === 3);
check("a shaped floor is its outline", sameCells(floorCells({ grid: { cols: 10, rows: 10 }, shape: { areas: L } }), cellsOf(L)));
check("cell keys are column then row", cellKey(3, 7) === "3,7");

/* ─────────────────────────────── one geometry ─────────────────────────────── */

// The client keeps an identical copy (no cross-imports). If the two ever
// differ, the editor would offer shapes the server refuses, or worse.
const server = readFileSync(new URL("../src/lib/cells.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../../client/src/lib/cells.js", import.meta.url), "utf8");
check("the client's copy of the geometry is identical to the server's", server === client);

/* ─────────────────────────────── piece names ─────────────────────────────── */

// Four long tables and two solo desks placed before numbering existed,
// out of reading order, plus one table that already carries a number.
const piece = (id, type, col, row, number = null) => ({ id, type, position: { col, row }, number });
const tables = [piece("t-a", "table", 10, 2), piece("t-b", "table", 2, 2), piece("t-c", "table", 2, 6), piece("t-d", "table", 10, 6)];
const solos = [piece("s-a", "solo", 4, 9), piece("s-b", "solo", 1, 9)];
const numbered = numberPieces([...tables, ...solos]);
check(
  "pieces without a number are numbered per type in reading order",
  numbered.get("t-b") === 1 && numbered.get("t-a") === 2 && numbered.get("t-c") === 3 && numbered.get("t-d") === 4 &&
    numbered.get("s-b") === 1 && numbered.get("s-a") === 2
);
const kept = numberPieces([...tables, piece("t-e", "table", 0, 0, 2)]);
check(
  "a stored number is kept, and the rest take the numbers still free",
  kept.get("t-e") === 2 && kept.get("t-b") === 1 && kept.get("t-a") === 3 && kept.get("t-c") === 4 && kept.get("t-d") === 5
);
check(
  "numbering is the same however the pieces are listed",
  JSON.stringify([...numberPieces([...tables].reverse()).entries()].sort()) === JSON.stringify([...numberPieces(tables).entries()].sort())
);
check("a new piece takes its type's smallest free number", nextNumber([...tables, ...solos], "table") === 5 && nextNumber([...tables, ...solos], "lamp") === 1);
check(
  "…including a gap a removed piece left",
  nextNumber([piece("x", "table", 0, 0, 1), piece("y", "table", 2, 0, 3)], "table") === 2
);
check(
  "a unit is named by its piece and the organization's noun",
  unitName({ piece: pieceName("Long Table", 2), unitLabel: "3", units: 5, noun: "seat" }) === "Long Table 2 · Seat 3"
);
check("a single-unit piece is just its name", unitName({ piece: pieceName("Solo Desk", 4), unitLabel: "1", units: 1, noun: "seat" }) === "Solo Desk 4");
check(
  "a piece named for the noun does not repeat it",
  unitName({ piece: pieceName("Desk", 1), unitLabel: "2", units: 2, noun: "desk" }) === "Desk 1 · Place 2" &&
    unitName({ piece: pieceName("Desktop Bench", 1), unitLabel: "2", units: 4, noun: "desk" }) === "Desktop Bench 1 · Desk 2"
);

const serverNames = readFileSync(new URL("../src/lib/names.js", import.meta.url), "utf8");
const clientNames = readFileSync(new URL("../../client/src/lib/names.js", import.meta.url), "utf8");
check("the client's copy of the naming rules is identical to the server's", serverNames === clientNames);

console.log(`\n${passed} geometry and naming checks passed.`);
