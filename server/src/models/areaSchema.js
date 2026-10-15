import mongoose from "mongoose";

/**
 * One rectangle of a shape, in whole grid cells (spec §12). A floor's
 * outline, a room level and a zone are each a list of these whose union is
 * the shape; lib/cells.js has the geometry and the validation every stored
 * list goes through first.
 *
 * Not a model: no _id, because a rectangle is a value, not a thing.
 */
const areaSchema = new mongoose.Schema(
  {
    col: { type: Number, required: true },
    row: { type: Number, required: true },
    w: { type: Number, required: true },
    h: { type: Number, required: true },
  },
  { _id: false }
);

export default areaSchema;
