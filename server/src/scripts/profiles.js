/**
 * Vertical profiles — the demo data that proves SILLA is a product, not
 * one institution's system.
 *
 * Spec §8: "A library gets tables, chairs, and computer desks; an office
 * gets hot desks and meeting rooms. Same mechanism, different seed data."
 *
 * That claim is only credible if there is more than one seed. Everything
 * that differs between these two profiles is DATA — branding,
 * terminology, the resource catalog, the floor layouts, the terms text.
 * Not one line of engine, API, or component code differs between them.
 *
 * Switch the running demo between verticals with:
 *     npm run profile library
 *     npm run profile office
 *
 * It rewrites the existing organization in place, keeping the same
 * organizationId, so the client's VITE_DEMO_ORG_ID keeps working and the
 * same URLs render a completely different vertical.
 */

// ---------------------------------------------------------------- library

const LIBRARY = {
  key: "library",
  label: "Library / reading room",
  organizationName: "Demo Library",
  siteName: "Main Campus",

  // The library profile doubles as the pilot test bed (an academic
  // Learning Resource Centre), so it carries that institution's real
  // brand — gold on navy — as a fully re-skinned deployment.
  //
  // This is the correct home for it. These values used to be the
  // PRODUCT's hardcoded defaults, which made every deployment look like
  // one institution. As buyer config they are exactly right: this is
  // what a branded deployment is supposed to look like.
  branding: {
    primaryColor: "#FFD41C",
    accentTextColor: "#181D40",
    surface: { page: "#0F1227", pageEnd: "#181D40", card: "#171B3A", panel: "#1E2347", line: "#FBFBFB" },
    ink: { primary: "#FBFBFB", secondary: "#9EA2C0", muted: "#6E7398" },
  },
  terminology: { resourceNoun: "seat", memberNoun: "student", facilityLabel: "Library" },
  identity: { memberIdFormat: "####-######", checkInMethod: "rfid", selfServiceRegistration: true },
  policy: {
    gracePeriodMinutes: 10,
    maxStayHours: 4,
    pinLockoutThreshold: 5,
    verificationCodeExpiryMinutes: 10,
    operatingHours: { open: "08:00", close: "19:00" },
  },

  // The starting library catalog from spec §8.
  catalog: [
    { key: "long_table", label: "Long Table", footprint: { w: 5, h: 1 }, seatCount: 5, icon: "Armchair" },
    { key: "short_table", label: "Short Table", footprint: { w: 2, h: 1 }, seatCount: 2, icon: "Armchair" },
    { key: "solo_desk", label: "Solo Table & Desk", footprint: { w: 2, h: 1 }, seatCount: 1, icon: "Armchair" },
    { key: "chair", label: "Standalone Chair", footprint: { w: 1, h: 1 }, seatCount: 1, icon: "Armchair" },
    {
      key: "computer_desk",
      label: "Computer Desk",
      footprint: { w: 1, h: 1 },
      seatCount: 1,
      icon: "Monitor",
      hasServiceStatus: true,
    },
  ],

  floors: [
    {
      name: "Ground Floor",
      order: 0,
      grid: { cols: 20, rows: 12 },
      zones: [
        { name: "Quiet Study", bounds: { col: 1, row: 1, w: 10, h: 5 } },
        { name: "Computer Lab", bounds: { col: 13, row: 1, w: 6, h: 5 } },
        { name: "Collaboration", bounds: { col: 1, row: 7, w: 10, h: 4 } },
      ],
      labels: [
        { text: "Reception", position: { col: 0, row: 0 } },
        { text: "Storage", position: { col: 18, row: 0 } },
        { text: "Printing", position: { col: 13, row: 10 } },
        { text: "Entrance", position: { col: 9, row: 11 } },
      ],
      resources: [
        {
          type: "long_table",
          position: { col: 2, row: 2 },
          units: ["available", "occupied", "occupied", "reserved", "available"],
        },
        {
          type: "long_table",
          position: { col: 2, row: 4 },
          units: ["available", "available", "available", "occupied", "available"],
          overstayUnits: [3],
        },
        { type: "short_table", position: { col: 8, row: 2 }, units: ["occupied", "available"] },
        { type: "short_table", position: { col: 8, row: 4 }, units: ["unavailable", "unavailable"] },

        { type: "computer_desk", position: { col: 14, row: 2 }, units: ["available"] },
        { type: "computer_desk", position: { col: 15, row: 2 }, units: ["occupied"] },
        { type: "computer_desk", position: { col: 16, row: 2 }, units: ["available"] },
        {
          type: "computer_desk",
          position: { col: 17, row: 2 },
          units: ["unavailable"],
          serviceStatus: "out_of_service",
        },
        { type: "computer_desk", position: { col: 14, row: 4 }, units: ["reserved"] },
        { type: "computer_desk", position: { col: 15, row: 4 }, units: ["available"] },
        { type: "computer_desk", position: { col: 16, row: 4 }, units: ["available"] },
        { type: "computer_desk", position: { col: 17, row: 4 }, units: ["available"] },

        {
          type: "long_table",
          position: { col: 2, row: 8 },
          units: ["reserved", "reserved", "available", "available", "occupied"],
        },
        { type: "solo_desk", position: { col: 8, row: 8 }, units: ["occupied"] },
        { type: "chair", position: { col: 2, row: 10 }, units: ["available"] },
        { type: "chair", position: { col: 3, row: 10 }, units: ["occupied"] },
        { type: "chair", position: { col: 4, row: 10 }, units: ["available"] },

        { type: "solo_desk", position: { col: 13, row: 8 }, units: ["available"] },
        { type: "solo_desk", position: { col: 16, row: 8 }, units: ["reserved"] },
        { type: "chair", position: { col: 19, row: 10 }, units: ["available"] },
      ],
    },
    {
      name: "Second Floor",
      order: 1,
      grid: { cols: 16, rows: 10 },
      zones: [{ name: "Reading Room", bounds: { col: 1, row: 1, w: 8, h: 6 } }],
      labels: [
        { text: "Stairs", position: { col: 0, row: 9 } },
        { text: "Archive", position: { col: 14, row: 1 } },
      ],
      resources: [
        {
          type: "long_table",
          position: { col: 2, row: 2 },
          units: ["available", "available", "reserved", "available", "available"],
        },
        {
          type: "long_table",
          position: { col: 2, row: 4 },
          units: ["occupied", "occupied", "available", "available", "available"],
        },
        { type: "short_table", position: { col: 2, row: 6 }, units: ["available", "available"] },
        { type: "chair", position: { col: 10, row: 2 }, units: ["available"] },
        { type: "chair", position: { col: 11, row: 2 }, units: ["occupied"] },
        { type: "solo_desk", position: { col: 10, row: 5 }, units: ["available"] },
      ],
    },
  ],

  termsText: [
    "By using this service you agree to the following.",
    "",
    "1. Your account is personal. Reservations are self-only — you may not reserve on behalf of another person.",
    "2. One active reservation at a time. Check in by tapping your card within the grace period, or the reservation is released as a no-show.",
    "3. Sessions end at the maximum-stay cap or at closing, whichever comes first. If your session is auto-released while you are still present, staff may ask you to re-tap or to move.",
    "4. Your card is your credential. Report a lost card to staff immediately so it can be reissued and the old one invalidated.",
    "5. Misuse — holding resources you are not using, sharing credentials, or repeated no-shows — may result in your access being suspended.",
    "",
    "This text is configured per organization and can be edited by a superadmin in Settings.",
  ].join("\n"),
};

// ----------------------------------------------------------------- office

const OFFICE = {
  key: "office",
  label: "Office / workplace",
  organizationName: "Demo Workplace",
  siteName: "Harbour Building",
  // A fully re-skinned deployment — surface, ink AND state colours — so
  // switching profiles proves the whole palette is config-driven, not
  // just the accent.
  branding: {
    primaryColor: "#2DD4BF",
    accentTextColor: "#05201C",
    surface: { page: "#0B1012", pageEnd: "#111A1C", card: "#121B1E", panel: "#182428", line: "#E6F2F1" },
    ink: { primary: "#E6F2F1", secondary: "#93A8A6", muted: "#657A78" },
    states: {
      available: "#10B981",
      reserved: "#F59E0B",
      occupied: "#52525B",
      unavailable: "#EF4444",
      overstay: "#A855F7",
    },
  },
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  // A different member ID shape entirely, to exercise the configurable
  // format rather than assuming everyone uses the library's.
  identity: { memberIdFormat: "EMP-#####", checkInMethod: "rfid", selfServiceRegistration: true },
  policy: {
    gracePeriodMinutes: 15,
    maxStayHours: 9,
    pinLockoutThreshold: 5,
    verificationCodeExpiryMinutes: 15,
    operatingHours: { open: "07:00", close: "20:00" },
  },

  // Same fixed-footprint catalog mechanism, entirely different pieces.
  catalog: [
    { key: "hot_desk", label: "Hot Desk", footprint: { w: 1, h: 1 }, seatCount: 1, icon: "Monitor" },
    {
      key: "standing_desk",
      label: "Standing Desk",
      footprint: { w: 1, h: 1 },
      seatCount: 1,
      icon: "Monitor",
      hasServiceStatus: true,
    },
    { key: "collab_table", label: "Collaboration Table", footprint: { w: 3, h: 1 }, seatCount: 3, icon: "Users" },
    { key: "meeting_room_s", label: "Meeting Room (4)", footprint: { w: 2, h: 2 }, seatCount: 4, icon: "Users" },
    { key: "meeting_room_l", label: "Boardroom (8)", footprint: { w: 4, h: 2 }, seatCount: 8, icon: "Users" },
    { key: "phone_booth", label: "Phone Booth", footprint: { w: 1, h: 1 }, seatCount: 1, icon: "Phone" },
  ],

  floors: [
    {
      name: "Level 3",
      order: 0,
      grid: { cols: 18, rows: 12 },
      zones: [
        { name: "Engineering", bounds: { col: 1, row: 1, w: 9, h: 5 } },
        { name: "Sales", bounds: { col: 1, row: 7, w: 9, h: 4 } },
        { name: "Meeting Rooms", bounds: { col: 12, row: 1, w: 5, h: 9 } },
      ],
      labels: [
        { text: "Reception", position: { col: 0, row: 0 } },
        { text: "Kitchen", position: { col: 17, row: 0 } },
        { text: "Lifts", position: { col: 0, row: 11 } },
        { text: "Print", position: { col: 17, row: 11 } },
      ],
      resources: [
        { type: "hot_desk", position: { col: 2, row: 2 }, units: ["occupied"] },
        { type: "hot_desk", position: { col: 3, row: 2 }, units: ["available"] },
        { type: "hot_desk", position: { col: 4, row: 2 }, units: ["occupied"] },
        { type: "hot_desk", position: { col: 5, row: 2 }, units: ["reserved"] },
        { type: "hot_desk", position: { col: 2, row: 4 }, units: ["available"] },
        { type: "hot_desk", position: { col: 3, row: 4 }, units: ["available"] },
        { type: "hot_desk", position: { col: 4, row: 4 }, units: ["occupied"], overstayUnits: [0] },
        { type: "hot_desk", position: { col: 5, row: 4 }, units: ["available"] },
        { type: "standing_desk", position: { col: 7, row: 2 }, units: ["available"] },
        {
          type: "standing_desk",
          position: { col: 8, row: 2 },
          units: ["unavailable"],
          serviceStatus: "out_of_service",
        },
        { type: "standing_desk", position: { col: 7, row: 4 }, units: ["occupied"] },
        { type: "standing_desk", position: { col: 8, row: 4 }, units: ["available"] },

        { type: "collab_table", position: { col: 2, row: 8 }, units: ["occupied", "occupied", "available"] },
        { type: "collab_table", position: { col: 6, row: 8 }, units: ["available", "available", "reserved"] },
        { type: "hot_desk", position: { col: 2, row: 10 }, units: ["available"] },
        { type: "hot_desk", position: { col: 3, row: 10 }, units: ["reserved"] },
        { type: "hot_desk", position: { col: 4, row: 10 }, units: ["available"] },

        {
          type: "meeting_room_l",
          position: { col: 13, row: 2 },
          units: ["occupied", "occupied", "occupied", "occupied", "occupied", "available", "available", "available"],
        },
        { type: "meeting_room_s", position: { col: 13, row: 5 }, units: ["reserved", "reserved", "reserved", "reserved"] },
        { type: "meeting_room_s", position: { col: 15, row: 5 }, units: ["available", "available", "available", "available"] },
        { type: "phone_booth", position: { col: 13, row: 8 }, units: ["occupied"] },
        { type: "phone_booth", position: { col: 14, row: 8 }, units: ["available"] },
        { type: "phone_booth", position: { col: 15, row: 8 }, units: ["unavailable"] },
      ],
    },
    {
      name: "Level 4",
      order: 1,
      grid: { cols: 14, rows: 10 },
      zones: [{ name: "Focus Area", bounds: { col: 1, row: 1, w: 6, h: 5 } }],
      labels: [
        { text: "Stairs", position: { col: 0, row: 9 } },
        { text: "Lounge", position: { col: 12, row: 1 } },
      ],
      resources: [
        { type: "hot_desk", position: { col: 2, row: 2 }, units: ["available"] },
        { type: "hot_desk", position: { col: 3, row: 2 }, units: ["occupied"] },
        { type: "hot_desk", position: { col: 4, row: 2 }, units: ["available"] },
        { type: "phone_booth", position: { col: 2, row: 4 }, units: ["available"] },
        { type: "phone_booth", position: { col: 3, row: 4 }, units: ["occupied"] },
        { type: "meeting_room_s", position: { col: 9, row: 2 }, units: ["available", "available", "occupied", "occupied"] },
        { type: "collab_table", position: { col: 9, row: 6 }, units: ["available", "reserved", "available"] },
      ],
    },
  ],

  termsText: [
    "Workplace booking terms.",
    "",
    "1. Bookings are personal and self-only. Do not book a desk or room on behalf of a colleague.",
    "2. One active booking at a time. Tap in within the grace period or the booking is released.",
    "3. Bookings end at the maximum-stay cap or at close of business. Tap out when you leave so the space frees for others.",
    "4. Your access card is your credential. Report a lost card to facilities immediately.",
    "5. Repeatedly holding space you are not using may result in booking privileges being suspended.",
    "",
    "This text is configured per organization and can be edited by a superadmin in Settings.",
  ].join("\n"),
};

// ----------------------------------------------------------------- exports

export const VERTICAL_PROFILES = { library: LIBRARY, office: OFFICE };

export const PROFILE_KEYS = Object.keys(VERTICAL_PROFILES);

export function getProfile(key) {
  const profile = VERTICAL_PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown profile "${key}". Available: ${PROFILE_KEYS.join(", ")}`);
  }
  return profile;
}

/**
 * Works out which profile an existing organization is running, by
 * matching its seeded catalog keys. Lets seedLayout re-lay out floors
 * without being told which vertical it is looking at.
 */
export function detectProfile(resourceTypeKeys = []) {
  const present = new Set(resourceTypeKeys);
  let best = null;
  for (const profile of Object.values(VERTICAL_PROFILES)) {
    const overlap = profile.catalog.filter((t) => present.has(t.key)).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { profile, overlap };
  }
  return best?.profile || null;
}
