/**
 * The reservation engine's one error type: a message written for the
 * person who caused it, an HTTP status, and a stable `code` for clients
 * that branch on the reason rather than on the wording.
 *
 * In its own module so every part of the engine (index.js, standing.js,
 * occupancy.js, day.js) can throw it without importing each other in a
 * circle. index.js re-exports it, so callers keep importing it from there.
 */
export class ReservationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "ReservationError";
    this.status = status;
    this.code = code;
  }
}
