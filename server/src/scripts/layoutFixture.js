/**
 * Expands a vertical profile's floor definition into insertable
 * Resource / Zone / Label documents (spec §12's three map layers),
 * resolving ResourceType keys to ids and validating placement the same
 * way the map editor will have to (spec §8: overlap is prevented by an
 * occupied-cell check).
 *
 * The DATA lives in profiles.js — one definition per vertical. This
 * module is the vertical-agnostic expander, and knows nothing about
 * libraries, offices, or any other use case.
 *
 * Throws on a bad fixture rather than writing a corrupt layout — a
 * silently overlapping seed would look like a renderer bug later.
 */

export function expandFloor(floorDefinition, { organizationId, floor, typesByKey }) {
  const { cols, rows } = floor.grid;
  const occupied = new Map(); // "col,row" -> piece description, for error messages

  const resources = floorDefinition.resources.map((piece, index) => {
    const type = typesByKey.get(piece.type);
    if (!type) {
      throw new Error(
        `[layout] "${floor.name}" piece #${index} references unknown resource type "${piece.type}". ` +
          `Seeded catalog keys: ${[...typesByKey.keys()].join(", ")}`
      );
    }

    const { col, row } = piece.position;
    const { w, h } = type.footprint;

    if (col < 0 || row < 0 || col + w > cols || row + h > rows) {
      throw new Error(
        `[layout] "${floor.name}" ${piece.type} at (${col},${row}) with footprint ${w}x${h} ` +
          `falls outside the ${cols}x${rows} grid.`
      );
    }

    for (let dc = 0; dc < w; dc += 1) {
      for (let dr = 0; dr < h; dr += 1) {
        const key = `${col + dc},${row + dr}`;
        if (occupied.has(key)) {
          throw new Error(
            `[layout] "${floor.name}" ${piece.type} at (${col},${row}) overlaps ` +
              `${occupied.get(key)} at cell (${key}).`
          );
        }
        occupied.set(key, `${piece.type}@(${col},${row})`);
      }
    }

    if (piece.units.length !== type.seatCount) {
      throw new Error(
        `[layout] "${floor.name}" ${piece.type} at (${col},${row}) declares ` +
          `${piece.units.length} unit(s) but the catalog says seatCount ${type.seatCount}.`
      );
    }

    const overstayUnits = new Set(piece.overstayUnits || []);

    return {
      organization: organizationId,
      floor: floor._id,
      resourceType: type._id,
      zone: null, // zone membership is DERIVED from position (spec §12), never stored
      position: { col, row },
      units: piece.units.map((status, unitIndex) => ({
        label: String(unitIndex + 1),
        status,
        // Only pieces whose type carries a service status can be out of
        // service; everything else stays "working" (spec §8).
        serviceStatus: type.hasServiceStatus ? piece.serviceStatus || "working" : "working",
        overstay: overstayUnits.has(unitIndex),
      })),
    };
  });

  // A profile's zones are rectangles; stored the way the editor stores any
  // zone, as its areas plus their bounding box.
  const zones = (floorDefinition.zones || []).map((zone) => ({
    organization: organizationId,
    floor: floor._id,
    name: zone.name,
    bounds: zone.bounds,
    areas: [zone.bounds],
  }));

  const labels = (floorDefinition.labels || []).map((label) => ({
    organization: organizationId,
    floor: floor._id,
    text: label.text,
    position: label.position,
  }));

  return { resources, zones, labels };
}
