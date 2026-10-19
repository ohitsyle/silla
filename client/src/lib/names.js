/**
 * What a placed piece and its units are CALLED — "Long Table 2", and
 * "Long Table 2 · Seat 3" for one place at it.
 *
 * Units used to be named by their type and their number on the piece
 * alone: four long tables in a reading room each had a "Long Table · 3",
 * and eight solo desks were all "Solo Desk · 1". A member could not tell
 * from the panel, their reservation or a reminder email which table was
 * theirs, and a screen reader read the same words for every one of them.
 *
 * So every piece has a number among the pieces of its type on its floor,
 * and its name is the type's label and that number. The number is stored
 * on the piece (`Resource.number`) once it has one; pieces placed before
 * numbering existed have none and are numbered here instead, in reading
 * order (row, then column) after the numbers already taken — the same
 * answer on every read, so nothing had to be migrated. The first
 * structural change to a floor stores the numbers its pieces were being
 * shown with (services/pieceNames.js), so adding or removing a table never
 * renumbers its neighbours afterwards.
 *
 * Kept free of imports and byte-identical in server/src/lib and
 * client/src/lib, like cells.js; the geometry suite fails if they drift.
 */

/** "seat" -> "Seat": the organization's own noun, as the start of a name. */
export function capitalise(word) {
  const text = String(word || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/**
 * Every piece's number on ONE floor.
 *
 * `pieces` are { id, type, position: { col, row }, number } with `type` the
 * catalog type's id. A stored number is kept; a piece without one takes the
 * smallest number its type has free on the floor, in reading order. Two
 * pieces that somehow share a stored number keep it — names are for
 * people, and the next structural write renumbers neither.
 *
 * Returns a Map of piece id -> number.
 */
export function numberPieces(pieces) {
  const numbers = new Map();
  const byType = new Map();
  for (const piece of pieces || []) {
    const key = String(piece.type);
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(piece);
  }
  for (const group of byType.values()) {
    const taken = new Set();
    for (const piece of group) {
      if (Number.isInteger(piece.number) && piece.number > 0) {
        numbers.set(String(piece.id), piece.number);
        taken.add(piece.number);
      }
    }
    const unnumbered = group
      .filter((piece) => !numbers.has(String(piece.id)))
      .sort(
        (a, b) =>
          (a.position?.row ?? 0) - (b.position?.row ?? 0) ||
          (a.position?.col ?? 0) - (b.position?.col ?? 0) ||
          String(a.id).localeCompare(String(b.id))
      );
    let next = 1;
    for (const piece of unnumbered) {
      while (taken.has(next)) next += 1;
      numbers.set(String(piece.id), next);
      taken.add(next);
    }
  }
  return numbers;
}

/** The smallest number free for `type` among `pieces` (after numberPieces). */
export function nextNumber(pieces, type) {
  const numbers = numberPieces(pieces);
  const taken = new Set(
    (pieces || []).filter((piece) => String(piece.type) === String(type)).map((piece) => numbers.get(String(piece.id)))
  );
  let next = 1;
  while (taken.has(next)) next += 1;
  return next;
}

/** "Long Table 2". */
export function pieceName(typeLabel, number) {
  const label = String(typeLabel || "").trim() || "Item";
  return Number.isInteger(number) ? `${label} ${number}` : label;
}

/**
 * One unit's full name: "Long Table 2 · Seat 3" — the piece, then the
 * organization's noun and the unit's label. A piece with a single unit is
 * just the piece ("Solo Desk 4"): "Solo Desk 4 · Seat 1" says nothing more.
 *
 * A piece already named for the noun — a two-person "Desk" where a desk is
 * what people book — would read "Desk 1 · Desk 2", the same word twice for
 * two different things; its units are "Desk 1 · Place 2" instead.
 */
export function unitName({ piece, unitLabel, units = 1, noun = "resource" }) {
  const name = String(piece || "").trim() || capitalise(noun);
  if (units <= 1) return name;
  const word = capitalise(noun) || "Unit";
  const lower = name.toLowerCase();
  const echoes = lower === word.toLowerCase() || lower.startsWith(`${word.toLowerCase()} `);
  return `${name} · ${echoes ? "Place" : word} ${unitLabel}`;
}
