/**
 * Rooms, as the client reads them.
 *
 * A room is one booking boundary drawn on one or more floors of a
 * building. What a member may do with it depends on its booking mode:
 *
 *   individual   book the units inside it, one at a time
 *   whole        book the room itself; its contents come with it
 *   either       both — and a booking of one blocks the other
 *
 * The server decides (services/reservations); everything here exists only
 * to DESCRIBE that decision in the organization's own words, so the map,
 * the room panel and the editor all say the same thing.
 */

/** Plural of the organization's noun, for counts ("3 desks"). */
export const plural = (noun, n = 2) => (n === 1 ? noun : `${noun}s`);

/** "a desk" / "an office" — the noun is buyer-supplied, so the article is derived. */
export const withArticle = (noun) => `${/^[aeiou]/i.test(String(noun).trim()) ? "an" : "a"} ${noun}`;

/**
 * What each booking mode lets a member do, in plain words.
 *
 *   short   a few words, for a chip or a list row
 *   member  one sentence, for the member deciding what to book
 *   admin   one sentence, for the administrator choosing the mode
 */
export function roomMode(mode, noun = "resource") {
  const one = withArticle(noun);
  const many = plural(noun);
  switch (mode) {
    case "whole":
      return {
        label: "Whole room",
        short: "Whole room only",
        member: `Booked as a whole: one booking covers the room and everything in it.`,
        admin: `One booking takes the room and everything in it. The ${many} inside are never booked one at a time.`,
      };
    case "either":
      return {
        label: "Whole room or one at a time",
        short: `Whole room or ${one}`,
        member: `Book the whole room, or just ${one} inside it.`,
        admin: `Members book the whole room or ${one} inside it. A booking of one blocks the other for that time.`,
      };
    default:
      return {
        label: `One ${noun} at a time`,
        short: `Pick ${one}`,
        member: `Pick ${one} inside — the room itself isn't booked as a whole.`,
        admin: `Members book the ${many} inside one at a time. The room is never booked as a whole.`,
      };
  }
}

/** The booking modes in the order an administrator chooses between them. */
export const ROOM_MODE_ORDER = ["individual", "whole", "either"];

/** A room's own booking target as the reservation flow addresses it. */
export function roomUnit(room, status) {
  const own = status[room.resourceId]?.[0] || { status: "available" };
  return {
    kind: "room",
    roomId: room.id,
    resourceId: room.resourceId,
    unitIndex: 0,
    unitLabel: "room",
    levels: room.levels,
    status: own,
    statusLabel: own.status,
    type: { label: room.name, key: "__room" },
  };
}

/** The room's own state: free, booked as a whole, in use, or closed by staff. */
export function roomState(room, status) {
  return status[room.resourceId]?.[0]?.status || "available";
}

/**
 * How a unit inside a room should READ on the member's map, given the
 * room's own state. Composed for display only — never written back, so a
 * cancelled room booking gives every unit back its own state.
 *
 *   room closed by staff         every unit inside reads unavailable
 *   room booked or in use whole  every unit inside reads the same
 *   room only booked whole       units are not bookable alone; they
 *                                `includedInRoom` — drawn as part of
 *                                the room rather than as unavailable
 *                                furniture, which would read "broken"
 */
export function effectiveStatus(resource, unit, rooms, status) {
  const room = rooms.find((candidate) => candidate.id === resource.roomId);
  if (!room || !unit) return unit;
  const own = status[room.resourceId]?.[0];
  if (own?.status === "unavailable") return { ...unit, status: "unavailable", roomBlocked: true };
  if (own?.status === "reserved" || own?.status === "occupied") {
    return { ...unit, status: own.status, roomBlocked: true };
  }
  if (room.bookingMode === "whole") return { ...unit, status: "unavailable", roomBlocked: true, includedInRoom: true };
  return unit;
}

/** Display name of a room level: its own name, else the floor it sits on. */
export function levelName(level, floors = []) {
  return level.name || floors.find((floor) => floor.id === level.floorId)?.name || "Level";
}

/** "Ground", "Ground and Balcony", "Ground, Mezzanine and Roof". */
export function listNames(names) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
