/**
 * The provisioning profile — the portal's single source of truth.
 *
 * A buyer configures their system here; this module turns that into the
 * JSON object `server/src/scripts/profiles.js` already defines and
 * `seed.js` consumes. Nothing downstream is written by hand: the shape
 * emitted by `buildProfile` IS the contract, so a change here is the
 * only edit needed to provision a different system.
 *
 * Two shapes live in this file and must not be confused:
 *
 *   CONFIG   flat and UI-shaped — one field per control the wizard
 *            renders. Floors carry `cols`/`rows`; catalog entries carry
 *            `w`/`h`; hours are two strings. There is no layout in it,
 *            because a buyer never draws one during onboarding.
 *
 *   PROFILE  the emitted contract — nested exactly as the seed script
 *            reads it (`grid: {cols, rows}`, `footprint: {w, h}`,
 *            `operatingHours: {open, close}`), with a starter layout
 *            generated for every floor.
 *
 * `buildProfile` is the only crossing between them, so the wizard never
 * has to think in the server's shape and the server never has to know a
 * portal exists.
 *
 * Readers here are deliberately tolerant of BOTH shapes (`w` or
 * `footprint.w`, `cols` or `grid.cols`) — a config round-tripped
 * through an emitted profile, or hand-pasted by a buyer, still builds.
 * The writer is strict: what comes out is always canonical.
 */

/* ───────────────────────────── colour ───────────────────────────── */

/**
 * Parses the colour forms a buyer can actually type into a hex field.
 * Returns null on anything unparseable so one bad value can never blank
 * out a palette — the caller keeps its fallback instead.
 */
function parseHex(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((c) => parseInt(c + c, 16));
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  return null;
}

const clampChannel = (c) => Math.max(0, Math.min(255, Math.round(c)));

const toHex = (channels) =>
  `#${channels.map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * Normalises whatever is in a colour field to the `#RRGGBB` the contract
 * specifies. The buyer app parses shorthand fine, but the emitted
 * profile is also read by humans and diffed between deployments, so it
 * gets one canonical form.
 */
export function normalizeHex(value, fallback = "#000000") {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : fallback;
}

/**
 * Picks a legible ink for text placed ON an accent colour.
 *
 * Same approach as `client/src/theme/applyOrgTheme.js` — WCAG relative
 * luminance, not a brightness average, so mid-tone greens and oranges
 * land on the right side of the threshold. The result is tinted toward
 * the accent's own hue rather than flat black or white, which is what
 * keeps a branded button from reading as a default one.
 *
 * Returns hex because the profile contract is hex-only; the client's
 * version returns rgb() for SVG. Same maths, different serialisation.
 */
export function deriveInk(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return "#FFFFFF";

  const linear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb;
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

  return luminance > 0.45
    ? toHex(rgb.map((c) => c * 0.18))
    : toHex(rgb.map((c) => c + (255 - c) * 0.88));
}

/**
 * Ready-made palettes a buyer picks as a starting point and then edits.
 *
 * One light, the rest dark, and every accent avoids the resource-state
 * hues (green / orange / red / purple) — a brand colour that reads as
 * "available" makes the map ambiguous, which is why Organization.branding
 * keeps `states` separate from `primaryColor` in the first place.
 *
 * `surface.line` is the hairline colour, always drawn at low alpha over
 * the surface beneath it. That is why it flips dark on the light scheme:
 * a pale line on a white card is invisible, not subtle.
 */
export const COLOR_SCHEMES = [
  {
    key: "graphite",
    name: "Graphite & Cyan",
    primaryColor: "#22D3EE",
    accentTextColor: "#04222B",
    surface: { page: "#0A0F14", pageEnd: "#0F161E", card: "#111820", panel: "#17202B", line: "#ECF1F6" },
    ink: { primary: "#ECF1F6", secondary: "#9AA8B5", muted: "#6A7885" },
  },
  {
    key: "midnight",
    name: "Midnight & Gold",
    primaryColor: "#FFD41C",
    accentTextColor: "#181D40",
    surface: { page: "#0F1227", pageEnd: "#181D40", card: "#171B3A", panel: "#1E2347", line: "#FBFBFB" },
    ink: { primary: "#FBFBFB", secondary: "#9EA2C0", muted: "#6E7398" },
  },
  {
    key: "harbour",
    name: "Harbour Teal",
    primaryColor: "#2DD4BF",
    accentTextColor: "#05201C",
    surface: { page: "#0B1012", pageEnd: "#111A1C", card: "#121B1E", panel: "#182428", line: "#E6F2F1" },
    ink: { primary: "#E6F2F1", secondary: "#93A8A6", muted: "#657A78" },
  },
  {
    key: "cobalt",
    name: "Cobalt Slate",
    primaryColor: "#60A5FA",
    accentTextColor: "#06203F",
    surface: { page: "#0A101C", pageEnd: "#0E1729", card: "#101929", panel: "#172234", line: "#E8EEF8" },
    ink: { primary: "#E8EEF8", secondary: "#97A6BC", muted: "#6B7A91" },
  },
  {
    key: "orchid",
    name: "Orchid Noir",
    primaryColor: "#F472B6",
    accentTextColor: "#2A0716",
    surface: { page: "#140D14", pageEnd: "#1C1220", card: "#1A121F", panel: "#23182A", line: "#F7ECF4" },
    ink: { primary: "#F7ECF4", secondary: "#B6A0B2", muted: "#857286" },
  },
  {
    key: "daylight",
    name: "Daylight",
    primaryColor: "#2563EB",
    accentTextColor: "#FFFFFF",
    surface: { page: "#F7F8FA", pageEnd: "#EDF1F6", card: "#FFFFFF", panel: "#F2F5F9", line: "#0B1220" },
    ink: { primary: "#0F172A", secondary: "#475569", muted: "#78859A" },
  },
];

export const colorSchemeByKey = (key) =>
  COLOR_SCHEMES.find((scheme) => scheme.key === key) || COLOR_SCHEMES[0];

/* ──────────────────────────── catalog ───────────────────────────── */

/**
 * Lucide icon names offered in the catalog editor. Kept as a short list
 * of names that exist in `lucide-react` and read at 16px on a map cell —
 * a free-text icon field would let a buyer provision a system whose map
 * renders nothing.
 */
export const CATALOG_ICONS = [
  "Square",
  "Boxes",
  "Armchair",
  "Sofa",
  "Monitor",
  "Laptop",
  "Users",
  "Presentation",
  "Phone",
  "DoorClosed",
  "Coffee",
  "BookOpen",
  "LayoutGrid",
];

/** Vertical-neutral, so an unedited catalog row never implies a vertical. */
export const DEFAULT_ICON = "Square";

/* ──────────────────────────── presets ───────────────────────────── */

const clone = (value) => JSON.parse(JSON.stringify(value));

let idCounter = 0;
/** Stable client-side id, so a floor keeps its React identity while it is being renamed. */
export const uid = (prefix = "id") => `${prefix}-${(idCounter += 1)}`;

/** Empty means "keep the product's state palette" — see `buildProfile`. */
const EMPTY_STATES = { available: "", reserved: "", occupied: "", unavailable: "", overstay: "" };

/**
 * Starting points, not products. Everything a preset carries is DATA the
 * buyer then edits — which is the same claim `npm run profile` makes on
 * the server side, made once more at the point of sale.
 */
const PRESET_DEFINITIONS = [
  {
    key: "library",
    label: "Library / reading room",
    description:
      "Study seats a member books for a few hours: long and short tables, solo desks, loose chairs, and computer desks that can go out of service.",
    colorScheme: "midnight",
    siteName: "Main Campus",
    terminology: { resourceNoun: "seat", memberNoun: "student", facilityLabel: "Library" },
    identity: { memberIdFormat: "####-######", selfServiceRegistration: true },
    policy: {
      gracePeriodMinutes: 10,
      maxStayHours: 4,
      pinLockoutThreshold: 5,
      verificationCodeExpiryMinutes: 10,
      openTime: "08:00",
      closeTime: "19:00",
    },
    catalog: [
      { key: "long_table", label: "Long Table", w: 5, h: 1, seatCount: 5, icon: "Armchair" },
      { key: "short_table", label: "Short Table", w: 2, h: 1, seatCount: 2, icon: "Armchair" },
      { key: "solo_desk", label: "Solo Table & Desk", w: 2, h: 1, seatCount: 1, icon: "Armchair" },
      { key: "chair", label: "Standalone Chair", w: 1, h: 1, seatCount: 1, icon: "Armchair" },
      { key: "computer_desk", label: "Computer Desk", w: 1, h: 1, seatCount: 1, icon: "Monitor", hasServiceStatus: true },
    ],
    floors: [
      { name: "Ground Floor", cols: 20, rows: 12 },
      { name: "Second Floor", cols: 16, rows: 10 },
    ],
  },
  {
    key: "office",
    label: "Office / workplace",
    description:
      "Hot-desking and room booking for a working day: individual desks, collaboration tables, meeting rooms of two sizes, and phone booths.",
    colorScheme: "harbour",
    siteName: "Harbour Building",
    terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
    identity: { memberIdFormat: "EMP-#####", selfServiceRegistration: true },
    policy: {
      gracePeriodMinutes: 15,
      maxStayHours: 9,
      pinLockoutThreshold: 5,
      verificationCodeExpiryMinutes: 15,
      openTime: "07:00",
      closeTime: "20:00",
    },
    catalog: [
      { key: "hot_desk", label: "Hot Desk", w: 1, h: 1, seatCount: 1, icon: "Monitor" },
      { key: "standing_desk", label: "Standing Desk", w: 1, h: 1, seatCount: 1, icon: "Monitor", hasServiceStatus: true },
      { key: "collab_table", label: "Collaboration Table", w: 3, h: 1, seatCount: 3, icon: "Users" },
      { key: "meeting_room_s", label: "Meeting Room (4)", w: 2, h: 2, seatCount: 4, icon: "Users" },
      { key: "meeting_room_l", label: "Boardroom (8)", w: 4, h: 2, seatCount: 8, icon: "Users" },
      { key: "phone_booth", label: "Phone Booth", w: 1, h: 1, seatCount: 1, icon: "Phone" },
    ],
    floors: [
      { name: "Level 3", cols: 18, rows: 12 },
      { name: "Level 4", cols: 14, rows: 10 },
    ],
  },
  {
    key: "blank",
    label: "Start from scratch",
    description:
      "Three generic pieces and one floor, named in the product's neutral terms. Pick this when the space is neither of the above and rename everything as you go.",
    colorScheme: "graphite",
    siteName: "Main Site",
    terminology: { resourceNoun: "resource", memberNoun: "member", facilityLabel: "Facility" },
    identity: { memberIdFormat: "######", selfServiceRegistration: true },
    policy: {
      gracePeriodMinutes: 10,
      maxStayHours: 4,
      pinLockoutThreshold: 5,
      verificationCodeExpiryMinutes: 10,
      openTime: "09:00",
      closeTime: "17:00",
    },
    catalog: [
      { key: "single_unit", label: "Single Unit", w: 1, h: 1, seatCount: 1, icon: "Boxes" },
      { key: "shared_table", label: "Shared Table", w: 3, h: 1, seatCount: 3, icon: "Users" },
      { key: "enclosed_room", label: "Enclosed Room", w: 2, h: 2, seatCount: 4, icon: "DoorClosed" },
    ],
    floors: [{ name: "Floor 1", cols: 16, rows: 10 }],
  },
];

/**
 * The presets as anything may consume them: every field the config shape
 * declares is present on the preset itself.
 *
 * That completeness is the point. A preset is applied by copying its
 * fields onto the config, so a preset that named a `colorScheme` but
 * carried no `branding` would set the scheme's NAME while leaving the
 * previous palette in place — a buyer who picked "Library" and never
 * opened the branding step would be provisioned in another vertical's
 * colours. Deriving the palette here means the two can never disagree,
 * whichever path applies the preset.
 */
export const VERTICAL_PRESETS = PRESET_DEFINITIONS.map((preset) => {
  const scheme = colorSchemeByKey(preset.colorScheme);
  return {
    ...preset,
    colorScheme: scheme.key, // resolved, so a typo here can't name a scheme that isn't there
    branding: {
      primaryColor: scheme.primaryColor,
      accentTextColor: scheme.accentTextColor,
      surface: { ...scheme.surface },
      ink: { ...scheme.ink },
      states: { ...EMPTY_STATES },
    },
    // RFID is the only resolver INF-3 registers. Carried on the preset so
    // that copying it field by field still yields a complete identity.
    identity: { ...preset.identity, checkInMethod: "rfid" },
    // The wizard keys floors by id while their names are still being
    // typed, so a preset's floors cannot be the one shape that lacks one.
    floors: preset.floors.map((floor) => ({ ...floor, id: uid("floor") })),
  };
});

export const presetByKey = (key) =>
  VERTICAL_PRESETS.find((preset) => preset.key === key) || VERTICAL_PRESETS[VERTICAL_PRESETS.length - 1];

/**
 * Expands a preset into wizard state.
 *
 * `keep` is what survives a preset change: anything the buyer has
 * already typed. Switching preset half-way through onboarding is a
 * legitimate thing to do and must not silently wipe the organization
 * name someone entered on step one.
 */
export function presetToConfig(presetKey, keep = {}) {
  const preset = presetByKey(presetKey);

  // Cloned throughout: the presets are a module-level constant, and a
  // config that aliased one would let an edit made in the wizard follow
  // the buyer into the next preset they try.
  return {
    preset: preset.key,
    organizationName: keep.organizationName || "",
    siteName: keep.siteName || preset.siteName,

    // Who will run the deployment. Kept across a preset change for the
    // same reason the organization name is: it is a fact about the
    // buyer, and no preset could ever have an opinion about it.
    //
    // It becomes the profile's `owner` block, which is what seed.js uses
    // to mint the founding superadmin. Without it a provisioned system
    // falls back to the shared demo accounts — the same admin@demo.test
    // in every customer's deployment.
    owner: {
      firstName: keep.owner?.firstName || "",
      lastName: keep.owner?.lastName || "",
      email: keep.owner?.email || "",
    },

    colorScheme: preset.colorScheme,
    branding: clone(preset.branding),

    terminology: clone(preset.terminology),
    identity: clone(preset.identity),
    policy: clone(preset.policy),
    catalog: clone(preset.catalog),
    // Fresh ids rather than the preset's: two configs built from one
    // preset must not share a floor identity. The id is assigned after
    // the spread so the preset's own can never win.
    floors: preset.floors.map((floor) => ({ ...clone(floor), id: uid("floor") })),

    // Empty = generate terms from the buyer's own terminology at build
    // time, so editing a noun later does not leave stale wording behind.
    termsText: keep.termsText || "",

    // A first boot onto an empty grid looks broken rather than new.
    demoLayout: true,
  };
}

/**
 * The wizard's starting state. A template, not a shared object — take a
 * fresh copy with `presetToConfig()` rather than mutating this.
 */
export const DEFAULT_CONFIG = presetToConfig("blank");

/* ─────────────────────── tolerant field readers ─────────────────── */

const toNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
};

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Accepts the UI shape (`w`/`h`) and the emitted shape (`footprint`). */
function footprintOf(type) {
  return {
    w: toNumber(type?.w ?? type?.footprint?.w),
    h: toNumber(type?.h ?? type?.footprint?.h),
  };
}

/** Accepts the UI shape (`cols`/`rows`) and the emitted shape (`grid`). */
function gridOf(floor) {
  return {
    cols: toNumber(floor?.cols ?? floor?.grid?.cols),
    rows: toNumber(floor?.rows ?? floor?.grid?.rows),
  };
}

/* ─────────────────────────── validation ─────────────────────────── */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CATALOG_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** "#" digit, "A" uppercase letter, "*" alphanumeric — see server/src/lib/identity.js. */
const PATTERN_VARIABLES = /[#A*]/;

const GRID_MIN = 1;
const GRID_MAX = 60; // matches GRID_LIMITS in server/src/routes/floor.routes.js

const minutesOf = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Returns every problem at once as `{ field, message }`, rather than
 * throwing on the first. The wizard shows all of them against their
 * inputs — a buyer who has three things to fix should learn that once,
 * not three submissions in a row.
 *
 * `field` is a dot path into the config, indexed where the value is in a
 * list ("catalog.2.seatCount"), so a caller can key errors to controls
 * without matching on message text.
 */
export function validate(config) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  if (!text(config?.organizationName)) {
    add("organizationName", "Enter the organization's name — it brands the whole deployment.");
  }

  // The founding superadmin. Required, because the alternative is not
  // "no admin" — it is seed.js planting the shared demo accounts, so
  // every customer provisioned without one ends up holding the same
  // published admin@demo.test / 123456 credential as every other.
  const owner = config?.owner || {};
  if (!text(owner.firstName)) add("owner.firstName", "Enter the first name of whoever will run this system.");
  if (!text(owner.lastName)) add("owner.lastName", "Enter their last name.");
  const ownerEmail = text(owner.email);
  if (!ownerEmail) {
    add("owner.email", "Enter their email — the founding sign-in details are sent there.");
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    add("owner.email", "That does not look like an email address.");
  }

  const terminology = config?.terminology || {};
  for (const [field, label] of [
    ["resourceNoun", "what one bookable unit is called"],
    ["memberNoun", "what one person is called"],
    ["facilityLabel", "what the space itself is called"],
  ]) {
    if (!text(terminology[field])) add(`terminology.${field}`, `Enter ${label}.`);
  }

  const pattern = text(config?.identity?.memberIdFormat);
  if (!pattern) {
    add("identity.memberIdFormat", "Enter a member ID format, for example ####-######.");
  } else if (!PATTERN_VARIABLES.test(pattern)) {
    add(
      "identity.memberIdFormat",
      "The format needs at least one # (digit), A (letter) or * (letter or digit) — otherwise every member would have the same ID."
    );
  }

  const policy = config?.policy || {};
  for (const [field, label] of [
    ["gracePeriodMinutes", "Grace period"],
    ["maxStayHours", "Maximum stay"],
    ["pinLockoutThreshold", "PIN lockout threshold"],
    ["verificationCodeExpiryMinutes", "Verification code expiry"],
  ]) {
    const value = toNumber(policy[field]);
    if (!Number.isFinite(value) || value <= 0) add(`policy.${field}`, `${label} must be a positive number.`);
  }
  if (toNumber(policy.maxStayHours) > 24) {
    add("policy.maxStayHours", "Maximum stay cannot exceed 24 hours.");
  }

  const open = text(policy.openTime ?? policy.operatingHours?.open);
  const close = text(policy.closeTime ?? policy.operatingHours?.close);
  if (!TIME_RE.test(open)) add("policy.openTime", "Opening time must be a 24-hour HH:mm value, e.g. 08:00.");
  if (!TIME_RE.test(close)) add("policy.closeTime", "Closing time must be a 24-hour HH:mm value, e.g. 19:00.");
  if (TIME_RE.test(open) && TIME_RE.test(close) && minutesOf(open) >= minutesOf(close)) {
    // Overnight hours would need a per-site timezone and a day-rollover
    // rule that the reservation engine does not have yet.
    add("policy.closeTime", "Closing time must be after opening time.");
  }

  const catalog = Array.isArray(config?.catalog) ? config.catalog : [];
  if (!catalog.length) {
    add("catalog", "Add at least one resource type — a system with an empty catalog has nothing to book.");
  }
  const seenKeys = new Map();
  catalog.forEach((type, index) => {
    const key = text(type?.key);
    if (!key) {
      add(`catalog.${index}.key`, "Every resource type needs a key.");
    } else if (!CATALOG_KEY_RE.test(key)) {
      add(`catalog.${index}.key`, "Use lowercase letters, digits and underscores, starting with a letter (e.g. hot_desk).");
    } else if (seenKeys.has(key)) {
      // The catalog is uniquely indexed per organization server-side, so
      // a duplicate here fails the seed rather than the wizard.
      add(`catalog.${index}.key`, `"${key}" is already used by another resource type.`);
    } else {
      seenKeys.set(key, index);
    }

    if (!text(type?.label)) add(`catalog.${index}.label`, "Every resource type needs a display name.");

    const { w, h } = footprintOf(type);
    for (const [axis, value] of [["w", w], ["h", h]]) {
      if (!Number.isInteger(value) || value < 1 || value > GRID_MAX) {
        add(
          `catalog.${index}.${axis}`,
          `Footprint ${axis === "w" ? "width" : "height"} must be a whole number of cells between 1 and ${GRID_MAX}.`
        );
      }
    }

    const seatCount = toNumber(type?.seatCount);
    if (!Number.isInteger(seatCount) || seatCount < 1) {
      add(`catalog.${index}.seatCount`, "A resource type must provide at least one bookable unit.");
    }
  });

  const floors = Array.isArray(config?.floors) ? config.floors : [];
  if (!floors.length) add("floors", "Add at least one floor.");
  const seenFloorNames = new Map();
  floors.forEach((floor, index) => {
    const name = text(floor?.name);
    if (!name) {
      add(`floors.${index}.name`, "Every floor needs a name.");
    } else if (seenFloorNames.has(name.toLowerCase())) {
      // The floor switcher shows names only; two "Ground Floor"s are
      // indistinguishable to anyone using the map.
      add(`floors.${index}.name`, `"${name}" is already used by another floor.`);
    } else {
      seenFloorNames.set(name.toLowerCase(), index);
    }

    const { cols, rows } = gridOf(floor);
    for (const [axis, value] of [["cols", cols], ["rows", rows]]) {
      if (!Number.isInteger(value) || value < GRID_MIN || value > GRID_MAX) {
        add(`floors.${index}.${axis}`, `Grid ${axis} must be a whole number between ${GRID_MIN} and ${GRID_MAX}.`);
      }
    }
  });

  return problems;
}

/* ────────────────────────── starter layout ──────────────────────── */

/**
 * A mix that shows every state the map can render, cycled across units
 * so no two adjacent pieces look identical. The point is a first boot
 * that demonstrates the product, not a realistic occupancy model.
 */
const STATUS_RING = ["available", "occupied", "available", "reserved", "available", "occupied", "available", "available"];

/** Enough to fill a floor visually; more only makes the emitted JSON heavier. */
const MAX_PIECES_PER_FLOOR = 26;

const stripParenthetical = (label) => label.replace(/\s*\([^)]*\)/g, "").trim();

function dominantLabel(types) {
  const counts = new Map();
  for (const type of types) counts.set(type.label, (counts.get(type.label) || 0) + 1);
  let best = null;
  for (const [label, count] of counts) if (!best || count > best.count) best = { label, count };
  return best ? best.label : "";
}

/**
 * Places a plausible starter layout on a floor: resources, a zone or
 * two, and a few orientation labels.
 *
 * Placement walks the grid in bands — left to right with a one-cell gap
 * between pieces, then down by the tallest piece in the band plus one.
 * Overlap is therefore impossible by construction rather than by check,
 * which matters because `layoutFixture.js` throws on an overlapping
 * fixture and a rejected seed is the buyer's first impression.
 *
 * The outer ring of the grid is left clear on purpose: it gives the
 * labels somewhere guaranteed free, and a map whose pieces run to the
 * edge reads as cropped.
 */
export function demoLayoutFor(floor, catalog = []) {
  const empty = { zones: [], labels: [], resources: [] };
  const { cols, rows } = gridOf(floor);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 3 || rows < 3) return empty;

  const types = (Array.isArray(catalog) ? catalog : [])
    .map((type) => {
      const { w, h } = footprintOf(type);
      const seatCount = toNumber(type?.seatCount);
      return { key: text(type?.key), label: text(type?.label) || text(type?.key), w, h, seatCount, hasServiceStatus: !!type?.hasServiceStatus };
    })
    .filter((type) => type.key && Number.isInteger(type.w) && type.w > 0 && Number.isInteger(type.h) && type.h > 0 && Number.isInteger(type.seatCount) && type.seatCount > 0);
  if (!types.length) return empty;

  const resources = [];
  const bands = [];
  let cursor = 0;
  let ring = 0;
  let row = 1;

  while (row <= rows - 2 && resources.length < MAX_PIECES_PER_FLOOR) {
    const bandTypes = [];
    let col = 1;
    let height = 0;

    while (col <= cols - 2 && resources.length < MAX_PIECES_PER_FLOOR) {
      const availableW = cols - 1 - col;
      const availableH = rows - 1 - row;

      // Cycle through the catalog so a floor shows variety, but skip any
      // piece too big for what is left of this band.
      let picked = null;
      for (let offset = 0; offset < types.length; offset += 1) {
        const candidate = types[(cursor + offset) % types.length];
        if (candidate.w <= availableW && candidate.h <= availableH) {
          picked = candidate;
          cursor = (cursor + offset + 1) % types.length;
          break;
        }
      }
      if (!picked) break;

      resources.push({
        type: picked.key,
        position: { col, row },
        units: Array.from({ length: picked.seatCount }, () => STATUS_RING[ring++ % STATUS_RING.length]),
      });
      bandTypes.push(picked);
      col += picked.w + 1;
      height = Math.max(height, picked.h);
    }

    if (!bandTypes.length) break;
    bands.push({ row, height, colStart: 1, colEnd: col - 2, types: bandTypes });
    row += height + 1;
  }

  if (!resources.length) return empty;

  // One piece out of service, so the service-status half of the map
  // legend is exercised on a system that has never been used.
  const serviceType = types.find((type) => type.hasServiceStatus);
  let outOfServiceIndex = -1;
  if (serviceType) {
    outOfServiceIndex = resources.map((r) => r.type).lastIndexOf(serviceType.key);
    if (outOfServiceIndex >= 0) {
      const piece = resources[outOfServiceIndex];
      piece.units = piece.units.map(() => "unavailable");
      piece.serviceStatus = "out_of_service";
    }
  }

  // One overstaying occupant, so staff see the flag they are meant to act on.
  for (let index = 0; index < resources.length; index += 1) {
    if (index === outOfServiceIndex) continue;
    const unit = resources[index].units.indexOf("occupied");
    if (unit >= 0) {
      resources[index].overstayUnits = [unit];
      break;
    }
  }

  // Zones follow the bands, merging consecutive bands of the same
  // dominant piece — which is how a real floor reads anyway (a row of
  // desks, then a row of rooms).
  const runs = [];
  for (const band of bands) {
    const name = `${stripParenthetical(dominantLabel(band.types)) || "General"} Area`;
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.bands.push(band);
    else runs.push({ name, bands: [band] });
  }
  const zones = runs.slice(0, 2).map((run) => {
    const first = run.bands[0];
    const last = run.bands[run.bands.length - 1];
    const colEnd = Math.max(...run.bands.map((band) => band.colEnd));
    return {
      name: run.name,
      bounds: { col: first.colStart, row: first.row, w: colEnd - first.colStart + 1, h: last.row + last.height - first.row },
    };
  });

  // The outer ring is never placed into, so these positions are free by
  // construction — no occupancy check needed.
  const labels = [
    { text: "Reception", position: { col: 0, row: 0 } },
    { text: "Entrance", position: { col: 0, row: rows - 1 } },
    { text: "Stairs", position: { col: cols - 1, row: rows - 1 } },
  ];

  return { zones, labels, resources };
}

/* ─────────────────────────── emission ───────────────────────────── */

/**
 * Slug for the profile key. Strips diacritics rather than dropping the
 * letters, so "Bibliothèque Municipale" becomes "bibliotheque-municipale"
 * instead of "biblioth-que-municipale".
 */
export function slugify(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

/**
 * Terms in the buyer's own words. Every noun comes from their
 * terminology and every number from their policy, so a deployment never
 * ships terms that describe someone else's building — and a buyer who
 * writes their own simply replaces this.
 */
function defaultTermsText(config) {
  const terminology = config?.terminology || {};
  const resource = text(terminology.resourceNoun) || DEFAULT_CONFIG.terminology.resourceNoun;
  const member = text(terminology.memberNoun) || DEFAULT_CONFIG.terminology.memberNoun;
  const facility = text(terminology.facilityLabel) || DEFAULT_CONFIG.terminology.facilityLabel;

  const policy = config?.policy || {};
  const grace = Math.round(toNumber(policy.gracePeriodMinutes)) || DEFAULT_CONFIG.policy.gracePeriodMinutes;
  const maxStay = toNumber(policy.maxStayHours) || DEFAULT_CONFIG.policy.maxStayHours;
  const close = text(policy.closeTime ?? policy.operatingHours?.close) || DEFAULT_CONFIG.policy.closeTime;

  return [
    `${facility} — terms of use.`,
    "",
    `1. Your account is personal. Each ${member} reserves a ${resource} for their own use; reservations may not be made on behalf of anyone else.`,
    `2. One active reservation at a time. Tap your card within ${plural(grace, "minute")} of the reservation starting, or the ${resource} is released for someone else.`,
    `3. A session ends after ${plural(maxStay, "hour")} or at closing (${close}), whichever comes first. Tap out when you leave so the ${resource} frees up.`,
    `4. Your card is your credential. Report a lost card to staff immediately so it can be reissued and the old one invalidated.`,
    `5. Misuse — holding a ${resource} you are not using, sharing credentials, or repeated no-shows — may result in your access being suspended.`,
    "",
    "This text is configured per organization and can be edited by a superadmin in Settings.",
  ].join("\n");
}

/**
 * Turns wizard state into the provisioning profile.
 *
 * Call `validate` first: this deliberately does not throw, because the
 * portal previews the profile live while the buyer is still filling the
 * form. Anything missing falls back to the neutral default rather than
 * emitting an undefined the seed script would write into the database.
 */
export function buildProfile(config) {
  // Named while the buyer is still typing: buildProfile also drives the
  // live preview, and a preview that reads "undefined" looks broken.
  const organizationName = text(config?.organizationName) || "Untitled organization";
  const scheme = colorSchemeByKey(config?.colorScheme);

  const ownerFirst = text(config?.owner?.firstName);
  const ownerLast = text(config?.owner?.lastName);
  const ownerEmail = text(config?.owner?.email).toLowerCase();
  // All three or nothing. importProfile treats a PRESENT owner as a
  // promise that every field is real and fails the whole file otherwise,
  // so a half-filled block would refuse to provision — while an absent
  // one is a perfectly valid demo profile.
  const ownerBlock =
    ownerFirst && ownerLast && ownerEmail
      ? { firstName: ownerFirst, lastName: ownerLast, email: ownerEmail }
      : null;

  const primaryColor = normalizeHex(config?.branding?.primaryColor, scheme.primaryColor);
  const branding = {
    primaryColor,
    // Falling back to the derived ink rather than a fixed colour means a
    // buyer who only picks an accent still gets readable buttons.
    accentTextColor: normalizeHex(config?.branding?.accentTextColor, deriveInk(primaryColor)),
    surface: {
      page: normalizeHex(config?.branding?.surface?.page, scheme.surface.page),
      pageEnd: normalizeHex(config?.branding?.surface?.pageEnd, scheme.surface.pageEnd),
      card: normalizeHex(config?.branding?.surface?.card, scheme.surface.card),
      panel: normalizeHex(config?.branding?.surface?.panel, scheme.surface.panel),
      line: normalizeHex(config?.branding?.surface?.line, scheme.surface.line),
    },
    ink: {
      primary: normalizeHex(config?.branding?.ink?.primary, scheme.ink.primary),
      secondary: normalizeHex(config?.branding?.ink?.secondary, scheme.ink.secondary),
      muted: normalizeHex(config?.branding?.ink?.muted, scheme.ink.muted),
    },
  };

  // States are emitted only where the buyer actually set one — an unset
  // state must inherit the product palette, not a colour this file made up.
  const states = {};
  for (const key of ["available", "reserved", "occupied", "unavailable", "overstay"]) {
    const value = config?.branding?.states?.[key];
    if (parseHex(value)) states[key] = normalizeHex(value);
  }
  if (Object.keys(states).length) branding.states = states;

  const policy = config?.policy || {};
  const catalogInput = Array.isArray(config?.catalog) ? config.catalog : [];

  const catalog = catalogInput.map((type, index) => {
    const { w, h } = footprintOf(type);
    const entry = {
      key: text(type?.key) || `type_${index + 1}`,
      label: text(type?.label) || text(type?.key) || `Type ${index + 1}`,
      footprint: { w: Number.isInteger(w) && w > 0 ? w : 1, h: Number.isInteger(h) && h > 0 ? h : 1 },
      seatCount: Math.max(1, Math.round(toNumber(type?.seatCount)) || 1),
      icon: text(type?.icon) || DEFAULT_ICON,
    };
    // Absent rather than false, matching the seeded profiles — the field
    // only means anything on types that can break.
    if (type?.hasServiceStatus) entry.hasServiceStatus = true;
    return entry;
  });

  const withDemoLayout = config?.demoLayout !== false;
  const floors = (Array.isArray(config?.floors) ? config.floors : []).map((floor, index) => {
    const { cols, rows } = gridOf(floor);
    const grid = {
      cols: Number.isInteger(cols) && cols > 0 ? cols : DEFAULT_CONFIG.floors[0].cols,
      rows: Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_CONFIG.floors[0].rows,
    };
    const layout = withDemoLayout ? demoLayoutFor(grid, catalogInput) : { zones: [], labels: [], resources: [] };
    return {
      name: text(floor?.name) || `Floor ${index + 1}`,
      order: index, // the floor switcher's sort key is the order shown in the wizard
      grid,
      zones: layout.zones,
      labels: layout.labels,
      resources: layout.resources,
    };
  });

  return {
    key: slugify(organizationName) || "deployment",
    label: organizationName,
    organizationName,
    siteName: text(config?.siteName) || "Main Site",
    ...(ownerBlock ? { owner: ownerBlock } : {}),
    branding,
    terminology: {
      resourceNoun: text(config?.terminology?.resourceNoun) || DEFAULT_CONFIG.terminology.resourceNoun,
      memberNoun: text(config?.terminology?.memberNoun) || DEFAULT_CONFIG.terminology.memberNoun,
      facilityLabel: text(config?.terminology?.facilityLabel) || DEFAULT_CONFIG.terminology.facilityLabel,
    },
    identity: {
      memberIdFormat: text(config?.identity?.memberIdFormat) || DEFAULT_CONFIG.identity.memberIdFormat,
      // RFID is the only resolver registered on the server (INF-3), so
      // emitting anything else would provision a system nobody can check
      // into. The field stays in the contract because adding QR later is
      // a registration, not a schema change.
      checkInMethod: "rfid",
      selfServiceRegistration: config?.identity?.selfServiceRegistration !== false,
    },
    policy: {
      gracePeriodMinutes: Math.round(toNumber(policy.gracePeriodMinutes)) || DEFAULT_CONFIG.policy.gracePeriodMinutes,
      maxStayHours: toNumber(policy.maxStayHours) || DEFAULT_CONFIG.policy.maxStayHours,
      pinLockoutThreshold: Math.round(toNumber(policy.pinLockoutThreshold)) || DEFAULT_CONFIG.policy.pinLockoutThreshold,
      verificationCodeExpiryMinutes:
        Math.round(toNumber(policy.verificationCodeExpiryMinutes)) || DEFAULT_CONFIG.policy.verificationCodeExpiryMinutes,
      operatingHours: {
        open: text(policy.openTime ?? policy.operatingHours?.open) || DEFAULT_CONFIG.policy.openTime,
        close: text(policy.closeTime ?? policy.operatingHours?.close) || DEFAULT_CONFIG.policy.closeTime,
      },
    },
    catalog,
    floors,
    termsText: text(config?.termsText) || defaultTermsText(config),
  };
}
