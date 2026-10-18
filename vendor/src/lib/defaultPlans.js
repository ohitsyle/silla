/**
 * The plans SILLA starts with — written into the Plan collection the first
 * time it is read empty (vendor: services/billing.js ensurePlans), after
 * which staff own them in the console's Plans section. Changing a number
 * here changes a NEW database's starting catalogue, nothing else.
 *
 * THIS FILE EXISTS TWICE, byte for byte: vendor/src/lib/defaultPlans.js
 * seeds the catalogue, and portal/src/lib/defaultPlans.js is what the
 * storefront shows until the live catalogue answers (or if it never does).
 * The services never import from each other, so it is copied; the vendor's
 * pricing suite fails when the two differ — change both or neither.
 *
 * The agreed pricing, in Philippine pesos. Money is in MINOR units
 * (centavos) and EXCLUDES VAT: billing adds 12% on the invoice only while
 * SILLA is VAT-registered (Settings.business.vatRegistered).
 *
 *   prices.monthly        per month, on monthly billing
 *   prices.annualMonthly  per month on yearly billing — invoiced × 12
 *
 * Every plan has every feature; they differ by SIZE. A limit of null is
 * unlimited. More buildings than a plan includes are an add-on
 * ("extra-building" in defaultCatalog.js) on Building and Campus, and each
 * one raises the deployment's building limit by one.
 *
 * The keys are older than the names (room, building, campus): orders and
 * subscriptions refer to plans by key, so the keys stay.
 */
const ALL_FEATURES = { kiosk: true, reports: true, customBranding: true, wholeRoomBooking: true, emailReminders: true };

export const DEFAULT_PLANS = [
  {
    key: "room",
    name: "Starter",
    tagline: "A single floor, a reading room, a studio.",
    highlights: ["Up to 60 bookable units", "One building, one floor, up to 5 rooms", "Up to 3 staff accounts", "Every feature, no exceptions"],
    featured: false,
    currency: "PHP",
    prices: { monthly: 2_500_00, annualMonthly: 2_000_00 },
    features: ALL_FEATURES,
    limits: { buildings: 1, floors: 1, rooms: 5, resources: 60, members: null, staff: 3 },
    sort: 1,
  },
  {
    key: "building",
    name: "Building",
    tagline: "Several floors and the staff to run them.",
    highlights: [
      "Up to 600 bookable units",
      "One building — unlimited floors and rooms",
      "Unlimited staff accounts",
      "Add more buildings as you grow",
    ],
    featured: true,
    currency: "PHP",
    prices: { monthly: 7_500_00, annualMonthly: 6_000_00 },
    features: ALL_FEATURES,
    limits: { buildings: 1, floors: null, rooms: null, resources: 600, members: null, staff: null },
    sort: 2,
  },
  {
    key: "campus",
    name: "Campus",
    tagline: "More than one building, more than one team.",
    highlights: [
      "Three buildings included",
      "Unlimited floors, rooms and bookable units",
      "Unlimited staff accounts",
      "Add more buildings as you grow",
    ],
    featured: false,
    currency: "PHP",
    prices: { monthly: 18_000_00, annualMonthly: 15_000_00 },
    features: ALL_FEATURES,
    limits: { buildings: 3, floors: null, rooms: null, resources: null, members: null, staff: null },
    sort: 3,
  },
];
