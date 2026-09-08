/**
 * Shared error type for the check-in interface. Kept in its own module
 * so implementations (rfid.js, and qr.js later) can throw it without
 * importing index.js and creating an import cycle.
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}
