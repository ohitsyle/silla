/**
 * Everything SILLA sells besides a plan, as it starts — written into the
 * CatalogItem collection the first time it is read empty (vendor:
 * services/billing.js ensureCatalog), after which staff own it in the
 * console (Plans → Catalogue). See models/CatalogItem.js for what each
 * field means.
 *
 * THIS FILE EXISTS TWICE, byte for byte: vendor/src/lib/defaultCatalog.js
 * seeds the catalogue, and portal/src/lib/defaultCatalog.js is what the
 * storefront and the configurator price from until the live catalogue
 * answers. The vendor's pricing suite fails when the two differ.
 *
 * The agreed pricing, in Philippine pesos. Money is in MINOR units
 * (centavos) and EXCLUDES VAT, like a plan's.
 *
 * The wording is a customer's, not ours: `name` is what an invoice line
 * says, `description` and `highlights` are what the storefront says, and
 * `note` is the one thing someone must know before buying it.
 */
const hardware = { category: "hardware", charge: "one_time", plans: [], group: "", groupDefault: false, adds: {}, waivedOnYearly: false, alwaysIncluded: false, rentalMinimumMonths: 0, maxQuantity: null, active: true };
const service = { ...hardware, category: "service" };
const support = { ...hardware, category: "support", charge: "recurring", group: "support", minQuantity: 1, maxQuantity: 1, unit: { one: "plan", many: "plans" } };

export const DEFAULT_CATALOG = [
  /* ── more buildings ── */
  {
    ...hardware,
    key: "extra-building",
    name: "Extra building",
    description: "Another building in the same system — its own floors, rooms and map, run by the same staff.",
    highlights: [],
    category: "building",
    charge: "recurring",
    unit: { one: "building", many: "buildings" },
    currency: "PHP",
    prices: { oneTime: null, monthly: 3_000_00, annualMonthly: 2_500_00 },
    minQuantity: 1,
    plans: ["building", "campus"],
    adds: { buildings: 1 },
    note: "Each one raises your building limit by one, straight away.",
    sort: 10,
  },

  /* ── hardware, configured and tested ── */
  {
    ...hardware,
    key: "kiosk",
    name: "SILLA Kiosk",
    description: "A 10-inch tablet on a floor stand with a built-in card reader, locked to your kiosk page.",
    highlights: [],
    charge: "buy_or_rent",
    unit: { one: "kiosk", many: "kiosks" },
    currency: "PHP",
    prices: { oneTime: 28_000_00, monthly: 1_500_00, annualMonthly: null },
    minQuantity: 1,
    rentalMinimumMonths: 12,
    note: "Bought, it carries a 1-year warranty. Rented, replacement is included.",
    sort: 20,
  },
  {
    ...hardware,
    key: "kiosk-large",
    name: "Large kiosk",
    description: "A 21.5-inch touchscreen on a freestanding stand, for a busy entrance.",
    highlights: [],
    charge: "buy_or_rent",
    unit: { one: "kiosk", many: "kiosks" },
    currency: "PHP",
    prices: { oneTime: 65_000_00, monthly: 3_500_00, annualMonthly: null },
    minQuantity: 1,
    rentalMinimumMonths: 12,
    note: "Bought, it carries a 1-year warranty.",
    sort: 21,
  },
  {
    ...hardware,
    key: "rfid-card",
    name: "RFID card, blank",
    description: "Plain cards, configured and tested, ready to hand out.",
    highlights: [],
    unit: { one: "card", many: "cards" },
    currency: "PHP",
    prices: { oneTime: 35_00, monthly: null, annualMonthly: null },
    minQuantity: 50,
    note: "1-year warranty.",
    sort: 22,
  },
  {
    ...hardware,
    key: "rfid-card-printed",
    name: "RFID card, printed with your logo and member ID",
    description: "Your logo on the front and each member's ID printed on it, configured and tested.",
    highlights: [],
    unit: { one: "card", many: "cards" },
    currency: "PHP",
    prices: { oneTime: 75_00, monthly: null, annualMonthly: null },
    minQuantity: 100,
    note: "1-year warranty.",
    sort: 23,
  },
  {
    ...hardware,
    key: "key-fob",
    name: "RFID key fob",
    description: "A tag for a keyring — the same tap as a card.",
    highlights: [],
    unit: { one: "fob", many: "fobs" },
    currency: "PHP",
    prices: { oneTime: 45_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    note: "1-year warranty.",
    sort: 24,
  },
  {
    ...hardware,
    key: "usb-reader",
    name: "USB RFID reader",
    description: "Plugs into your own PC or tablet. No driver to install — it types the card number.",
    highlights: [],
    unit: { one: "reader", many: "readers" },
    currency: "PHP",
    prices: { oneTime: 1_500_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    note: "1-year warranty.",
    sort: 25,
  },

  /* ── setup and services ── */
  {
    ...service,
    key: "onboarding",
    name: "Onboarding",
    description: "We build your map from your floor plans, set up your accounts and import your cards.",
    highlights: [],
    unit: { one: "setup", many: "setups" },
    currency: "PHP",
    prices: { oneTime: 5_000_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    maxQuantity: 1,
    alwaysIncluded: true,
    waivedOnYearly: true,
    note: "",
    sort: 30,
  },
  {
    ...service,
    key: "installation",
    name: "On-site installation",
    description: "We set up and test your kiosks at your site in Metro Manila — up to 3 kiosks per visit.",
    highlights: [],
    unit: { one: "visit", many: "visits" },
    currency: "PHP",
    prices: { oneTime: 6_000_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    note: "Outside Metro Manila, travel is billed at cost.",
    sort: 31,
  },
  {
    ...service,
    key: "card-enrollment",
    name: "Card enrollment",
    description: "We register your members' cards from a list you send, so they work on day one.",
    highlights: [],
    unit: { one: "card", many: "cards" },
    currency: "PHP",
    prices: { oneTime: 10_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    note: "",
    sort: 32,
  },
  {
    ...service,
    key: "training",
    name: "On-site staff training",
    description: "A session at your site for the people who will run it.",
    highlights: [],
    unit: { one: "session", many: "sessions" },
    currency: "PHP",
    prices: { oneTime: 4_000_00, monthly: null, annualMonthly: null },
    minQuantity: 1,
    note: "A 1-hour remote session is free.",
    sort: 33,
  },

  /* ── maintenance and support: one per order ── */
  {
    ...support,
    key: "support-standard",
    name: "Standard support",
    description: "Email support with a reply the next business day, every update, and remote help.",
    highlights: ["Email support, next-business-day reply", "Every update", "Remote help"],
    currency: "PHP",
    prices: { oneTime: null, monthly: 0, annualMonthly: 0 },
    groupDefault: true,
    note: "",
    sort: 40,
  },
  {
    ...support,
    key: "support-care",
    name: "Care support",
    description: "Faster replies, a quarterly health check, and replacement SILLA hardware at cost.",
    highlights: ["Replies within 4 business hours", "A quarterly health check", "Replacement SILLA hardware at cost"],
    currency: "PHP",
    prices: { oneTime: null, monthly: 1_500_00, annualMonthly: 1_500_00 },
    note: "",
    sort: 41,
  },
  {
    ...support,
    key: "support-care-plus",
    name: "Care Plus support",
    description: "Everything in Care, with hardware replaced free, visits on site and a yearly refresher.",
    highlights: [
      "Everything in Care",
      "Free replacement of SILLA hardware within 2 business days",
      "2 on-site visits a year (Metro Manila)",
      "A yearly refresher training",
    ],
    currency: "PHP",
    prices: { oneTime: null, monthly: 4_500_00, annualMonthly: 4_500_00 },
    note: "",
    sort: 42,
  },
];
