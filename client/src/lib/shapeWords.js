import { boundingBox, isRectangle, toCells } from "./cells.js";

/**
 * A shape's size, in words for the editor: "8 × 6 cells" for a rectangle,
 * "52 cells within 8 × 9" for anything else. Nobody needs to be told a
 * shape is "two rectangles" — that is how it is stored, not what it is.
 */
export function shapeSize(shape) {
  const cells = toCells(shape);
  const box = boundingBox(cells);
  if (!box) return "No cells";
  return isRectangle(cells) ? `${box.w} × ${box.h} cells` : `${cells.size} cells within ${box.w} × ${box.h}`;
}

/**
 * What a floor's outline is, said for the Shape tool: the whole grid, a
 * smaller rectangle inside it, or a shape.
 */
export function outlineSummary(shape, grid) {
  const cells = toCells(shape);
  const box = boundingBox(cells);
  if (!box) return "No floor at all";
  if (isRectangle(cells) && box.w === grid.cols && box.h === grid.rows) return `The whole ${grid.cols} × ${grid.rows} grid`;
  return isRectangle(cells) ? `A ${box.w} × ${box.h} rectangle` : `Shaped · ${cells.size} cells within ${box.w} × ${box.h}`;
}
