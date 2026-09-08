/**
 * Run with: node src/scripts/importProfile.js <path/to/profile.json>
 *           npm run seed:file <path/to/profile.json>   (validate, then seed)
 *
 * The consuming half of the portal handoff.
 *
 * The SILLA order portal is where a buyer configures the system they are
 * buying; what it emits is a provisioning profile — the same shape
 * profiles.js declares by hand for the built-in verticals (spec §8, §16:
 * "same mechanism, different seed data"). This module turns that file
 * into a profile the seeder can use, or into an error that names the
 * field a human has to fix.
 *
 * The validation here is not defensive padding. A profile arrives from
 * outside the deployment, so it is untrusted input, and unchecked it
 * fails as a Mongoose cast error halfway through a seed — with half an
 * organization already written and a message that names a schema path
 * nobody outside this repo has ever seen. Every problem in the file is
 * collected and reported at once, because a linter that stops at the
 * first mistake turns fixing a file into a guessing game.
 */
import fs from "node:fs";
import path from "node:path";
import { expandFloor } from "./layoutFixture.js";
import { VERTICAL_PROFILES, PROFILE_KEYS } from "./profiles.js";
import { memberIdExample } from "../lib/identity.js";

// Mirrors GRID_LIMITS in routes/floor.routes.js. A floor authored in the
// portal has to be one the map editor can later resize and redraw, so a
// profile may not describe a grid the editor would refuse.
const GRID_LIMITS = { min: 1, max: 60 };

const HEX = /^#[0-9A-Fa-f]{6}$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ROOT_KEYS = [
  "key", "label", "organizationName", "siteName",
  "branding", "terminology", "identity", "policy",
  "catalog", "floors", "termsText",
];
const SURFACE_KEYS = ["page", "pageEnd", "card", "panel", "line"];
const INK_KEYS = ["primary", "secondary", "muted"];
const STATE_KEYS = ["available", "reserved", "occupied", "unavailable", "overstay"];
const TERMINOLOGY_KEYS = ["resourceNoun", "memberNoun", "facilityLabel"];
const POLICY_NUMBERS = [
  "gracePeriodMinutes",
  "maxStayHours",
  "pinLockoutThreshold",
  "verificationCodeExpiryMinutes",
];

// Kept in step with the enums on Organization / Resource. A value
// outside them is exactly the cast error this module exists to prevent.
const CHECK_IN_METHODS = ["rfid", "qr", "both"];
const UNIT_STATUSES = ["available", "reserved", "occupied", "unavailable"];
const SERVICE_STATUSES = ["working", "out_of_service"];

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isFilledString = (v) => typeof v === "string" && v.trim().length > 0;
const isCell = (v) => Number.isInteger(v) && v >= 0;

/** Quotes the offending value into the message, so "got nothing" reads as a missing field. */
function describe(value) {
  if (value === undefined) return "nothing";
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ------------------------------------------------------------- validation

/**
 * Checks one parsed profile and returns a SANITISED copy of it.
 *
 * The copy matters as much as the check: seed.js inserts a catalog entry
 * as `{ organization: org._id, ...type }`, so a file carrying its own
 * `organization` or `_id` key would win that spread and write documents
 * into someone else's organization. Rebuilding each object from known
 * fields makes that structurally impossible instead of relying on
 * schema strictness to swallow it.
 */
export function validateProfile(raw) {
  const errors = [];
  const warnings = [];
  const fail = (field, message) => errors.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });

  if (!isPlainObject(raw)) {
    fail("(root)", `a profile must be a JSON object (got ${describe(raw)})`);
    return { ok: false, errors, warnings, profile: null };
  }

  const profile = {};

  // ---- the profile's own identity ----
  if (!isFilledString(raw.key)) {
    fail("key", `a slug is required, e.g. "acme-library" (got ${describe(raw.key)})`);
  } else if (!SLUG.test(raw.key)) {
    fail("key", `must be a lowercase slug of letters, digits and single dashes (got ${describe(raw.key)})`);
  } else if (PROFILE_KEYS.includes(raw.key)) {
    // A file profile is resolved by key at seed time, so a key that
    // shadows a built-in would make `npm run profile library` and this
    // file mean two different things. A portal export derives its key
    // from the organization name, so this fires on a buyer literally
    // called "Library" — name the rename, not just the rule, or the
    // only fix on offer is one the buyer never typed.
    fail(
      "key",
      `"${raw.key}" is the name of a built-in demo profile — choose another slug. ` +
        `A portal export takes its key from the organization name, so rename the ` +
        `organization to something more specific (or edit "key" in this file).`
    );
  } else {
    profile.key = raw.key;
  }

  for (const field of ["label", "organizationName", "siteName"]) {
    if (!isFilledString(raw[field])) fail(field, `a non-empty string is required (got ${describe(raw[field])})`);
    else profile[field] = raw[field].trim();
  }

  if (!isFilledString(raw.termsText)) {
    // AUTH-3 gates first login on this text; empty means a blank wall
    // between every new account and the product.
    fail("termsText", `terms text is required — it is what the first-login gate shows (got ${describe(raw.termsText)})`);
  } else {
    profile.termsText = raw.termsText;
  }

  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.includes(key)) warn(key, "is not part of the profile contract and will be ignored");
  }

  profile.branding = readBranding(raw.branding, fail, warn);
  profile.terminology = readTerminology(raw.terminology, fail);
  profile.identity = readIdentity(raw.identity, fail, warn);
  profile.policy = readPolicy(raw.policy, fail);
  profile.catalog = readCatalog(raw.catalog, fail, warn);
  profile.floors = readFloors(raw.floors, profile.catalog, fail, warn);

  const ok = errors.length === 0;
  return { ok, errors, warnings, profile: ok ? profile : null };
}

function readHex(value, field, fail) {
  if (!isFilledString(value) || !HEX.test(value)) {
    fail(field, `must be a #RRGGBB hex colour (got ${describe(value)})`);
    return null;
  }
  return value;
}

/**
 * `required` groups must be complete: a surface with three of its five
 * colours set is a half-branded deployment, which reads as a rendering
 * bug rather than as a configuration gap. States are genuinely optional
 * — the client's own tokens are a sane fallback for them.
 */
function readHexGroup(value, field, keys, fail, { required }) {
  if (value === undefined) {
    if (required) fail(field, `is required, with ${keys.join(", ")}`);
    return required ? null : undefined;
  }
  if (!isPlainObject(value)) {
    fail(field, `must be an object with ${keys.join(", ")} (got ${describe(value)})`);
    return null;
  }
  const out = {};
  for (const key of keys) {
    if (value[key] === undefined && !required) continue;
    const hex = readHex(value[key], `${field}.${key}`, fail);
    if (hex) out[key] = hex;
  }
  return out;
}

function readBranding(value, fail, warn) {
  if (!isPlainObject(value)) {
    fail("branding", `must be an object with primaryColor, accentTextColor, surface and ink (got ${describe(value)})`);
    return null;
  }
  const out = {
    primaryColor: readHex(value.primaryColor, "branding.primaryColor", fail),
    accentTextColor: readHex(value.accentTextColor, "branding.accentTextColor", fail),
    surface: readHexGroup(value.surface, "branding.surface", SURFACE_KEYS, fail, { required: true }),
    ink: readHexGroup(value.ink, "branding.ink", INK_KEYS, fail, { required: true }),
  };

  const states = readHexGroup(value.states, "branding.states", STATE_KEYS, fail, { required: false });
  if (states) out.states = states;

  if (value.logoUrl !== undefined && value.logoUrl !== null) {
    if (!isFilledString(value.logoUrl)) fail("branding.logoUrl", `must be a URL string or null (got ${describe(value.logoUrl)})`);
    else out.logoUrl = value.logoUrl.trim();
  }

  for (const key of Object.keys(value)) {
    if (!["primaryColor", "accentTextColor", "surface", "ink", "states", "logoUrl"].includes(key)) {
      warn(`branding.${key}`, "is not a branding field and will be ignored");
    }
  }
  return out;
}

function readTerminology(value, fail) {
  if (!isPlainObject(value)) {
    fail("terminology", `must be an object with ${TERMINOLOGY_KEYS.join(", ")} (got ${describe(value)})`);
    return null;
  }
  const out = {};
  for (const key of TERMINOLOGY_KEYS) {
    // No fallback here on purpose: a missing noun silently defaulting to
    // "seat" or "student" is how a deployment ends up sounding like a
    // library it isn't.
    if (!isFilledString(value[key])) fail(`terminology.${key}`, `a non-empty string is required (got ${describe(value[key])})`);
    else out[key] = value[key].trim();
  }
  return out;
}

function readIdentity(value, fail, warn) {
  if (!isPlainObject(value)) {
    fail("identity", `must be an object with memberIdFormat, checkInMethod and selfServiceRegistration (got ${describe(value)})`);
    return null;
  }
  const out = {};

  if (!isFilledString(value.memberIdFormat)) {
    fail("identity.memberIdFormat", `a pattern is required, e.g. "####-######" (got ${describe(value.memberIdFormat)})`);
  } else if (!/[#A*]/.test(value.memberIdFormat)) {
    fail(
      "identity.memberIdFormat",
      `must contain at least one placeholder — "#" digit, "A" uppercase letter or "*" alphanumeric. ` +
        `"${value.memberIdFormat}" would only ever match itself`
    );
  } else {
    out.memberIdFormat = value.memberIdFormat;
  }

  if (!CHECK_IN_METHODS.includes(value.checkInMethod)) {
    fail("identity.checkInMethod", `must be one of ${CHECK_IN_METHODS.join(", ")} (got ${describe(value.checkInMethod)})`);
  } else {
    out.checkInMethod = value.checkInMethod;
    // INF-3 registers exactly one resolver today; the others are a
    // registration away, but provisioning one now ships a kiosk that
    // cannot read a credential.
    if (value.checkInMethod !== "rfid") {
      warn("identity.checkInMethod", `only "rfid" has a registered resolver today — "${value.checkInMethod}" will not resolve a credential yet`);
    }
  }

  if (typeof value.selfServiceRegistration !== "boolean") {
    fail("identity.selfServiceRegistration", `must be true or false (got ${describe(value.selfServiceRegistration)})`);
  } else {
    out.selfServiceRegistration = value.selfServiceRegistration;
  }

  return out;
}

function readPolicy(value, fail) {
  if (!isPlainObject(value)) {
    fail("policy", `must be an object with ${POLICY_NUMBERS.join(", ")} and operatingHours (got ${describe(value)})`);
    return null;
  }
  const out = {};
  for (const key of POLICY_NUMBERS) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      fail(`policy.${key}`, `must be a positive number (got ${describe(n)})`);
    } else {
      out[key] = n;
    }
  }

  const hours = value.operatingHours;
  if (!isPlainObject(hours)) {
    fail("policy.operatingHours", `must be { open: "HH:mm", close: "HH:mm" } (got ${describe(hours)})`);
    return out;
  }
  let wellFormed = true;
  for (const key of ["open", "close"]) {
    if (!isFilledString(hours[key]) || !HHMM.test(hours[key])) {
      fail(`policy.operatingHours.${key}`, `must be a 24-hour "HH:mm" time (got ${describe(hours[key])})`);
      wellFormed = false;
    }
  }
  if (wellFormed) {
    if (minutesOf(hours.open) >= minutesOf(hours.close)) {
      // The scheduler and the reservation engine both treat the day as
      // one open..close window; an overnight span would silently mean a
      // facility that is never open.
      fail("policy.operatingHours", `open (${hours.open}) must be earlier than close (${hours.close}) — overnight hours are not supported`);
    } else {
      out.operatingHours = { open: hours.open, close: hours.close };
    }
  }
  return out;
}

function readCatalog(value, fail, warn) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("catalog", `at least one resource type is required — an empty catalog leaves nothing to place on a map (got ${describe(value)})`);
    return [];
  }

  const seen = new Map();
  const out = [];

  value.forEach((entry, index) => {
    const at = `catalog[${index}]`;
    if (!isPlainObject(entry)) {
      fail(at, `must be an object (got ${describe(entry)})`);
      return;
    }
    const type = {};

    if (!isFilledString(entry.key)) {
      fail(`${at}.key`, `a key is required, e.g. "hot_desk" (got ${describe(entry.key)})`);
    } else if (seen.has(entry.key)) {
      // ResourceType has a unique (organization, key) index, so this
      // would otherwise land as an E11000 mid-seed.
      fail(`${at}.key`, `"${entry.key}" is already used by catalog[${seen.get(entry.key)}] — catalog keys are unique per organization`);
    } else {
      seen.set(entry.key, index);
      type.key = entry.key;
    }

    if (!isFilledString(entry.label)) fail(`${at}.label`, `a display name is required (got ${describe(entry.label)})`);
    else type.label = entry.label.trim();

    if (!isPlainObject(entry.footprint)) {
      fail(`${at}.footprint`, `must be { w, h } in grid cells (got ${describe(entry.footprint)})`);
    } else {
      const footprint = {};
      for (const side of ["w", "h"]) {
        const n = entry.footprint[side];
        if (!Number.isInteger(n) || n < 1 || n > GRID_LIMITS.max) {
          fail(`${at}.footprint.${side}`, `must be a whole number between 1 and ${GRID_LIMITS.max} (got ${describe(n)})`);
        } else {
          footprint[side] = n;
        }
      }
      if (footprint.w && footprint.h) type.footprint = footprint;
    }

    if (!Number.isInteger(entry.seatCount) || entry.seatCount < 1) {
      fail(`${at}.seatCount`, `must be a whole number of 1 or more — a piece with no units cannot be reserved (got ${describe(entry.seatCount)})`);
    } else {
      type.seatCount = entry.seatCount;
    }

    if (entry.icon === undefined) {
      warn(`${at}.icon`, "is missing — the catalog will fall back to the default icon");
    } else if (!isFilledString(entry.icon)) {
      fail(`${at}.icon`, `must be a Lucide icon name, e.g. "Armchair" (got ${describe(entry.icon)})`);
    } else {
      type.icon = entry.icon;
    }

    for (const flag of ["hasServiceStatus", "reservable"]) {
      if (entry[flag] === undefined) continue;
      if (typeof entry[flag] !== "boolean") fail(`${at}.${flag}`, `must be true or false (got ${describe(entry[flag])})`);
      else type[flag] = entry[flag];
    }

    out.push(type);
  });

  return out;
}

function readFloors(value, catalog, fail, warn) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("floors", `at least one floor is required (got ${describe(value)})`);
    return [];
  }

  // Only fully-valid catalog entries can be used to check placement —
  // a type whose own footprint was rejected would report every piece
  // that uses it as a second, misleading failure.
  const typesByKey = new Map(
    catalog
      .filter((t) => t.key && t.footprint && t.seatCount)
      .map((t) => [t.key, { ...t, _id: null }])
  );

  const ordersSeen = new Map();
  const out = [];

  value.forEach((floor, index) => {
    const at = `floors[${index}]`;
    if (!isPlainObject(floor)) {
      fail(at, `must be an object (got ${describe(floor)})`);
      return;
    }

    const name = isFilledString(floor.name) ? floor.name.trim() : null;
    if (!name) fail(`${at}.name`, `a floor name is required, e.g. "Ground Floor" (got ${describe(floor.name)})`);

    let order = null;
    if (!Number.isInteger(floor.order) || floor.order < 0) {
      fail(`${at}.order`, `must be a whole number of 0 or more — it is the floor switcher's sort key (got ${describe(floor.order)})`);
    } else if (ordersSeen.has(floor.order)) {
      // seedLayout.js matches an existing floor by `order`, so two
      // floors sharing one would overwrite each other's layout.
      fail(`${at}.order`, `order ${floor.order} is already used by floors[${ordersSeen.get(floor.order)}] — floor order must be unique`);
    } else {
      ordersSeen.set(floor.order, index);
      order = floor.order;
    }

    const grid = readGrid(floor.grid, `${at}.grid`, fail);
    const label = name || at;

    const zones = readZones(floor.zones, `${at}.zones`, grid, label, fail);
    const labels = readLabels(floor.labels, `${at}.labels`, grid, fail);

    const resources = readResources(floor.resources, `${at}.resources`, typesByKey, fail, warn);

    if (grid && typesByKey.size) {
      // Placement is checked by the same expander the seeder runs, on a
      // throwaway floor: reimplementing the occupied-cell walk here is
      // how a linter starts passing files the seeder then rejects. The
      // expanded documents are discarded — we are only here for its
      // exceptions.
      try {
        expandFloor(
          { ...floor, zones: [], labels: [], resources },
          { organizationId: null, floor: { _id: null, name: label, grid }, typesByKey }
        );
      } catch (err) {
        fail(`${at}.resources`, err.message.replace(/^\[layout\] /, ""));
      }
    }

    if (name && order !== null && grid) {
      out.push({ name, order, grid, zones, labels, resources });
    }
  });

  return out;
}

function readGrid(value, field, fail) {
  if (!isPlainObject(value)) {
    fail(field, `must be { cols, rows } (got ${describe(value)})`);
    return null;
  }
  const grid = {};
  for (const side of ["cols", "rows"]) {
    const n = value[side];
    if (!Number.isInteger(n) || n < GRID_LIMITS.min || n > GRID_LIMITS.max) {
      fail(`${field}.${side}`, `must be a whole number between ${GRID_LIMITS.min} and ${GRID_LIMITS.max} (got ${describe(n)})`);
    } else {
      grid[side] = n;
    }
  }
  return grid.cols && grid.rows ? grid : null;
}

function readZones(value, field, grid, floorLabel, fail) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(field, `must be an array (got ${describe(value)})`);
    return [];
  }
  const out = [];
  value.forEach((zone, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(zone)) {
      fail(at, `must be an object (got ${describe(zone)})`);
      return;
    }
    if (!isFilledString(zone.name)) {
      fail(`${at}.name`, `a zone name is required (got ${describe(zone.name)})`);
      return;
    }
    if (!isPlainObject(zone.bounds)) {
      fail(`${at}.bounds`, `must be { col, row, w, h } (got ${describe(zone.bounds)})`);
      return;
    }
    const { col, row, w, h } = zone.bounds;
    if (!isCell(col) || !isCell(row)) {
      fail(`${at}.bounds`, `col and row must be whole numbers of 0 or more (got ${describe(zone.bounds)})`);
      return;
    }
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      fail(`${at}.bounds`, `w and h must be whole numbers of 1 or more (got ${describe(zone.bounds)})`);
      return;
    }
    if (grid && (col + w > grid.cols || row + h > grid.rows)) {
      fail(`${at}.bounds`, `"${zone.name}" at (${col},${row}) sized ${w}x${h} falls outside ${floorLabel}'s ${grid.cols}x${grid.rows} grid`);
      return;
    }
    out.push({ name: zone.name.trim(), bounds: { col, row, w, h } });
  });
  return out;
}

function readLabels(value, field, grid, fail) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(field, `must be an array (got ${describe(value)})`);
    return [];
  }
  const out = [];
  value.forEach((label, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(label)) {
      fail(at, `must be an object (got ${describe(label)})`);
      return;
    }
    if (!isFilledString(label.text)) {
      fail(`${at}.text`, `label text is required (got ${describe(label.text)})`);
      return;
    }
    const { col, row } = label.position || {};
    if (!isCell(col) || !isCell(row)) {
      fail(`${at}.position`, `must be { col, row } whole numbers of 0 or more (got ${describe(label.position)})`);
      return;
    }
    if (grid && (col >= grid.cols || row >= grid.rows)) {
      fail(`${at}.position`, `"${label.text}" at (${col},${row}) falls outside the ${grid.cols}x${grid.rows} grid`);
      return;
    }
    out.push({ text: label.text.trim(), position: { col, row } });
  });
  return out;
}

/**
 * Shape-checks every placed piece and fills in the units a portal file
 * may omit. A freshly provisioned system starts with everything
 * available — occupancy is something the running deployment produces,
 * not something a buyer configures — but an authored profile (the demo
 * verticals do this) may state unit statuses explicitly.
 *
 * A piece that fails these checks is reported by name and left OUT of
 * the returned array, which is what keeps the placement pass in
 * readFloors safe to run — a missing `position` would otherwise reach
 * expandFloor as a destructuring TypeError instead of a message about
 * the file. Only the malformed piece is skipped, never the whole floor:
 * gating the pass on an entirely sound floor hid every overlap behind
 * one mistyped coordinate, which made fixing a profile a game of one
 * error per run.
 */
function readResources(value, field, typesByKey, fail, warn) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(field, `must be an array (got ${describe(value)})`);
    return [];
  }

  const resources = [];

  value.forEach((piece, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(piece)) {
      fail(at, `must be an object (got ${describe(piece)})`);
      return;
    }
    if (!isFilledString(piece.type)) {
      fail(`${at}.type`, `must name a catalog key (got ${describe(piece.type)})`);
      return;
    }
    const { col, row } = piece.position || {};
    if (!isCell(col) || !isCell(row)) {
      fail(`${at}.position`, `must be { col, row } whole numbers of 0 or more (got ${describe(piece.position)})`);
      return;
    }

    const type = typesByKey.get(piece.type);
    const placed = { type: piece.type, position: { col, row } };

    let units = piece.units;
    if (units === undefined) {
      if (!type) {
        // Without a catalog entry there is nothing to size the piece
        // from, so this cannot fall through to expandFloor's own
        // unknown-type check the way a piece with explicit units does.
        fail(`${at}.type`, `"${piece.type}" is not a catalog key, so the number of units it has is unknown`);
        return;
      }
      units = new Array(type.seatCount).fill("available");
    } else if (!Array.isArray(units) || !units.every((s) => UNIT_STATUSES.includes(s))) {
      fail(`${at}.units`, `must be an array of ${UNIT_STATUSES.join(" / ")} (got ${describe(piece.units)})`);
      return;
    }
    placed.units = units;

    if (piece.overstayUnits !== undefined) {
      const bad = !Array.isArray(piece.overstayUnits) ||
        !piece.overstayUnits.every((i) => Number.isInteger(i) && i >= 0 && i < units.length);
      if (bad) {
        fail(`${at}.overstayUnits`, `must be an array of unit indexes between 0 and ${units.length - 1} (got ${describe(piece.overstayUnits)})`);
        return;
      }
      placed.overstayUnits = [...piece.overstayUnits];
    }

    if (piece.serviceStatus !== undefined) {
      if (!SERVICE_STATUSES.includes(piece.serviceStatus)) {
        fail(`${at}.serviceStatus`, `must be one of ${SERVICE_STATUSES.join(", ")} (got ${describe(piece.serviceStatus)})`);
        return;
      }
      if (type && !type.hasServiceStatus) {
        warn(`${at}.serviceStatus`, `"${piece.type}" is not marked hasServiceStatus in the catalog, so this is ignored`);
      }
      placed.serviceStatus = piece.serviceStatus;
    }

    resources.push(placed);
  });

  return resources;
}

// ----------------------------------------------------------------- loading

/**
 * Reads, parses and validates a profile file. Read and parse failures
 * become entries in the same report as validation failures, so the CLI
 * has one thing to print however the file is wrong.
 */
export function inspectProfileFile(filePath) {
  const resolved = isFilledString(filePath) ? path.resolve(filePath) : String(filePath);
  const problem = (field, message) => ({ path: resolved, ok: false, errors: [{ field, message }], warnings: [], profile: null });

  if (!isFilledString(filePath)) {
    return problem("(file)", "no profile path was given");
  }

  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return problem("(file)", `no file at ${resolved}`);
    if (err.code === "EISDIR") return problem("(file)", `${resolved} is a directory, not a profile file`);
    return problem("(file)", `could not read ${resolved} — ${err.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return problem("(file)", `${resolved} is not valid JSON — ${err.message}`);
  }

  return { path: resolved, ...validateProfile(raw) };
}

/**
 * The one function other modules should need: a validated, sanitised
 * profile, or a throw whose message names every field to fix.
 *
 * Warnings are printed rather than returned — a warning nobody surfaces
 * is not a warning, and the callers here are all scripts.
 */
export function loadProfile(filePath) {
  const result = inspectProfileFile(filePath);
  for (const { field, message } of result.warnings) {
    console.warn(`  ! ${field}: ${message}`);
  }
  if (!result.ok) throw new Error(formatProblems(result));
  return result.profile;
}

/**
 * Makes a file-authored profile resolvable by key.
 *
 * seedFloorLayouts() looks its profile up by key, and a file profile has
 * no entry in profiles.js. Registering it lets the file path and the
 * built-in path run the SAME creation code; the alternative is a second
 * copy of the placement logic in seed.js, which is exactly how a linter
 * and a seeder drift apart.
 */
export function registerProfile(profile) {
  VERTICAL_PROFILES[profile.key] = profile;
  return profile.key;
}

// --------------------------------------------------------------- reporting

function formatProblems(result) {
  const lines = [`${result.path} is not a usable profile — ${result.errors.length} problem(s):`, ""];
  for (const { field, message } of result.errors) lines.push(`  - ${field}: ${message}`);
  lines.push("", "  Nothing was written. Fix the file and run it past the importer again:");
  lines.push("    node src/scripts/importProfile.js <path>");
  return lines.join("\n");
}

/** Reads a profile back in the buyer's own words — the fastest way to spot a wrong file. */
export function formatReport(result) {
  const lines = [`\nProfile file: ${result.path}\n`];

  if (result.ok) {
    const p = result.profile;
    const row = (label, value) => lines.push(`  ${label.padEnd(13)} ${value}`);
    row("profile", `${p.label} (key: ${p.key})`);
    row("organization", `${p.organizationName} — ${p.siteName}`);
    row("terminology", `${p.terminology.resourceNoun} / ${p.terminology.memberNoun} / ${p.terminology.facilityLabel}`);
    row("member ID", `${p.identity.memberIdFormat} (e.g. ${memberIdExample(p.identity.memberIdFormat)})`);
    row("check-in", `${p.identity.checkInMethod}, self-service registration ${p.identity.selfServiceRegistration ? "on" : "off"}`);
    row(
      "policy",
      `grace ${p.policy.gracePeriodMinutes}m, max stay ${p.policy.maxStayHours}h, ` +
        `lockout ${p.policy.pinLockoutThreshold}, code ${p.policy.verificationCodeExpiryMinutes}m, ` +
        `open ${p.policy.operatingHours.open}–${p.policy.operatingHours.close}`
    );
    row("accent", `${p.branding.primaryColor} with ${p.branding.accentTextColor} text`);
    row("catalog", `${p.catalog.length} type(s): ${p.catalog.map((t) => t.key).join(", ")}`);
    p.floors.forEach((f, i) => {
      const units = f.resources.reduce((sum, r) => sum + r.units.length, 0);
      row(
        i === 0 ? "floors" : "",
        `${f.name} — ${f.grid.cols}x${f.grid.rows}, ${f.resources.length} pieces / ${units} units, ` +
          `${f.zones.length} zones, ${f.labels.length} labels`
      );
    });
    row("terms", `${p.termsText.length} characters`);
  } else {
    lines.push(`  INVALID — ${result.errors.length} problem(s):`, "");
    for (const { field, message } of result.errors) lines.push(`    - ${field}: ${message}`);
  }

  if (result.warnings.length) {
    lines.push("", `  ${result.warnings.length} warning(s):`, "");
    for (const { field, message } of result.warnings) lines.push(`    ! ${field}: ${message}`);
  }

  lines.push("");
  lines.push(result.ok ? "  VALID — seed it with: npm run seed:file <path>" : "  Nothing was written.");
  return `${lines.join("\n")}\n`;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node src/scripts/importProfile.js <path/to/profile.json>\n");
    console.error("Validates a provisioning profile exported from the SILLA portal and");
    console.error("prints what it would create. Seed a database from one with:");
    console.error("  npm run seed:file <path/to/profile.json>");
    process.exit(1);
  }

  const result = inspectProfileFile(filePath);
  console.log(formatReport(result));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("importProfile.js")) {
  main();
}
