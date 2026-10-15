/**
 * Moving a reservation to its next state without overwriting a newer one.
 *
 * The scheduler loads a batch of candidates and then works through them
 * one at a time, emailing as it goes. By the time it reaches one, its
 * holder may have checked in, checked out or cancelled — and a plain
 * `doc.save()` writes the scheduler's stale decision straight over theirs:
 *
 *   - a member who tapped in at the last second is marked a no-show, and
 *     their seat shows free while they sit in it;
 *   - a member who tapped out is marked "released" with an overstay flag,
 *     emailed about it, and counted in the overstay rate.
 *
 * So every move names the state it expects to move FROM, and changes
 * nothing if the reservation has already moved on. The caller acts on
 * the returned document — or, on null, does nothing at all.
 *
 * These are single-document conditional updates, not transactions, and
 * they need not be: a check-in or cancellation that is mid-transaction
 * holds the document, so the update waits for it to commit and then
 * re-evaluates its filter against the new state. Whichever side lands
 * first wins and the other changes nothing.
 */
import Reservation from "../../models/Reservation.js";

/**
 * @param {{ _id: unknown }} reservation  any copy; only its id is used
 * @param {string|string[]} from          the status(es) it must still be in
 * @param {object} changes                fields to set
 * @returns the updated reservation, or null if it had already moved on
 */
export function moveReservation(reservation, from, changes) {
  const statuses = Array.isArray(from) ? from : [from];
  return Reservation.findOneAndUpdate(
    { _id: reservation._id, status: { $in: statuses } },
    { $set: changes },
    { new: true }
  );
}

/**
 * OCC-5's move at closing time, whose destination depends on where the
 * reservation is NOW rather than where it was when the batch was read: a
 * session still running is released, a booking nobody checked into
 * expires.
 *
 * Deciding from the stale copy would be wrong both ways. A member who
 * tapped in during the closing minute would either be marked a no-show,
 * or — with a plain "still held?" condition — skipped and left checked
 * in all night, because the job only runs in that one minute. So the
 * database picks the destination from the live status, in one update.
 */
export function closeOut(reservation) {
  return Reservation.findOneAndUpdate(
    { _id: reservation._id, status: { $in: ["held", "active"] } },
    [{ $set: { status: { $cond: [{ $eq: ["$status", "active"] }, "released", "expired"] } } }],
    { new: true }
  );
}

/**
 * NOT-3's sent-once flag, claimed before the email goes rather than set
 * after it. Two scheduler processes (or a restart mid-tick) cannot both
 * win the claim, and a reservation cancelled since it was loaded is not
 * reminded at all.
 */
export function claimReminder(reservation, now = new Date()) {
  return Reservation.findOneAndUpdate(
    { _id: reservation._id, status: "held", remindedAt: null },
    { $set: { remindedAt: now } },
    { new: true }
  );
}
