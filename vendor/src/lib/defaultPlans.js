/**
 * The catalogue SILLA starts with — written into the Plan collection the
 * first time it is read empty (services/billing.js ensurePlans), after
 * which staff own it in the console.
 *
 * ⚠️  The prices are PLACEHOLDERS in Philippine pesos (minor units:
 * centavos). They are converted guesses from the storefront's old USD
 * placeholders, not a pricing decision. Change them in the console's
 * Plans section before anyone can act on them.
 */
const ALL_FEATURES = { kiosk: true, reports: true, customBranding: true, wholeRoomBooking: true, emailReminders: true };

export const DEFAULT_PLANS = [
  {
    key: "room",
    name: "One Room",
    tagline: "A single floor, a reading room, a studio.",
    highlights: ["Up to 60 bookable units", "One building, one floor", "Every feature, no exceptions", "Email support"],
    currency: "PHP",
    prices: { monthly: 2_900_00, annualMonthly: 2_300_00 },
    features: ALL_FEATURES,
    limits: { buildings: 1, floors: 1, rooms: 5, resources: 60, members: null, staff: 3 },
    sort: 1,
  },
  {
    key: "building",
    name: "Whole Building",
    tagline: "Several floors and the staff to run them.",
    highlights: [
      "Up to 600 bookable units",
      "One building, unlimited floors and rooms",
      "Unlimited staff accounts",
      "Priority support",
      "Onboarding call and layout help",
    ],
    featured: true,
    currency: "PHP",
    prices: { monthly: 8_700_00, annualMonthly: 6_900_00 },
    features: ALL_FEATURES,
    limits: { buildings: 1, floors: null, rooms: null, resources: 600, members: null, staff: null },
    sort: 2,
  },
  {
    key: "campus",
    name: "Campus",
    tagline: "More than one building, more than one team.",
    highlights: ["Unlimited units and buildings", "Multiple sites", "Custom identity formats and policy", "A named contact who answers"],
    currency: "PHP",
    prices: { monthly: null, annualMonthly: null },
    features: ALL_FEATURES,
    limits: { buildings: null, floors: null, rooms: null, resources: null, members: null, staff: null },
    sort: 3,
  },
];
