/**
 * Everything SILLA sells besides a plan, as it starts — written into the
 * CatalogItem collection the first time it is read empty (vendor:
 * services/billing.js ensureCatalog), after which staff own it in the
 * console (Plans → Catalogue). models/CatalogItem.js (vendor) says what
 * each field means; lib/quote.js is what enforces them.
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
const base = {
  description: "",
  highlights: [],
  currency: "PHP",
  minQuantity: 1,
  maxQuantity: null,
  plans: [],
  group: "",
  groupDefault: false,
  adds: {},
  note: "",
  waivedOnYearly: false,
  alwaysIncluded: false,
  rentalMinimumMonths: 0,
  active: true,
};
const oneTime = (oneTimePrice) => ({ charge: "one_time", prices: { oneTime: oneTimePrice, monthly: null, annualMonthly: null } });
const support = (monthly) => ({
  category: "support",
  charge: "recurring",
  group: "support",
  maxQuantity: 1,
  unit: { one: "plan", many: "plans" },
  prices: { oneTime: null, monthly, annualMonthly: monthly },
});

export const DEFAULT_CATALOG = [
  /* ── more buildings ── */
  {
    ...base,
    key: "extra-building",
    name: "Extra building",
    description: "Another building in the same system — its own floors, rooms and map, run by the same staff.",
    category: "building",
    charge: "recurring",
    unit: { one: "building", many: "buildings" },
    prices: { oneTime: null, monthly: 3_000_00, annualMonthly: 2_500_00 },
    plans: ["building", "campus"],
    adds: { buildings: 1 },
    note: "Each one raises your building limit by one, straight away.",
    sort: 10,
  },

  /* ── hardware, configured and tested ── */
  {
    ...base,
    key: "kiosk",
    name: "SILLA Kiosk",
    description: "A 10-inch tablet on a floor stand with a built-in card reader, locked to your kiosk page.",
    category: "hardware",
    charge: "buy_or_rent",
    unit: { one: "kiosk", many: "kiosks" },
    prices: { oneTime: 28_000_00, monthly: 1_500_00, annualMonthly: null },
    rentalMinimumMonths: 12,
    note: "Bought, it carries a 1-year warranty. Rented, replacement is included.",
    sort: 20,
  },
  {
    ...base,
    key: "kiosk-large",
    name: "Large kiosk",
    description: "A 21.5-inch touchscreen on a freestanding stand.",
    category: "hardware",
    charge: "buy_or_rent",
    unit: { one: "kiosk", many: "kiosks" },
    prices: { oneTime: 65_000_00, monthly: 3_500_00, annualMonthly: null },
    rentalMinimumMonths: 12,
    note: "Bought, it carries a 1-year warranty.",
    sort: 21,
  },
  {
    ...base,
    ...oneTime(35_00),
    key: "rfid-card",
    name: "RFID card, blank",
    description: "Plain cards, configured and tested, ready to hand out.",
    category: "hardware",
    unit: { one: "card", many: "cards" },
    minQuantity: 50,
    note: "1-year warranty.",
    sort: 22,
  },
  {
    ...base,
    ...oneTime(75_00),
    key: "rfid-card-printed",
    name: "RFID card, printed with your logo and member ID",
    description: "Your logo on the front and each member's ID printed on it, configured and tested.",
    category: "hardware",
    unit: { one: "card", many: "cards" },
    minQuantity: 100,
    note: "1-year warranty.",
    sort: 23,
  },
  {
    ...base,
    ...oneTime(45_00),
    key: "key-fob",
    name: "RFID key fob",
    description: "A tag for a keyring — the same tap as a card.",
    category: "hardware",
    unit: { one: "fob", many: "fobs" },
    note: "1-year warranty.",
    sort: 24,
  },
  {
    ...base,
    ...oneTime(1_500_00),
    key: "usb-reader",
    name: "USB RFID reader",
    description: "Plugs into your own PC or tablet. Nothing to install — it types the card number.",
    category: "hardware",
    unit: { one: "reader", many: "readers" },
    note: "1-year warranty.",
    sort: 25,
  },

  /* ── setup and services ── */
  {
    ...base,
    ...oneTime(5_000_00),
    key: "onboarding",
    name: "Onboarding",
    description: "We build your map from your floor plans, set up your accounts and import your cards.",
    category: "service",
    unit: { one: "setup", many: "setups" },
    maxQuantity: 1,
    alwaysIncluded: true,
    waivedOnYearly: true,
    sort: 30,
  },
  {
    ...base,
    ...oneTime(6_000_00),
    key: "installation",
    name: "On-site installation",
    description: "We set up and test your kiosks at your site in Metro Manila — up to 3 kiosks per visit.",
    category: "service",
    unit: { one: "visit", many: "visits" },
    note: "Outside Metro Manila, travel is billed at cost.",
    sort: 31,
  },
  {
    ...base,
    ...oneTime(10_00),
    key: "card-enrollment",
    name: "Card enrollment",
    description: "We register your members' cards from a list you send, so they work on day one.",
    category: "service",
    unit: { one: "card", many: "cards" },
    sort: 32,
  },
  {
    ...base,
    ...oneTime(4_000_00),
    key: "training",
    name: "On-site staff training",
    description: "A session at your site for the people who will run it.",
    category: "service",
    unit: { one: "session", many: "sessions" },
    note: "A 1-hour remote session is free.",
    sort: 33,
  },

  /* ── maintenance and support: one per order ── */
  {
    ...base,
    ...support(0),
    key: "support-standard",
    name: "Standard support",
    description: "Email support with a reply the next business day, every update, and remote help.",
    highlights: ["Email support, replies the next business day", "Every update", "Remote help"],
    groupDefault: true,
    sort: 40,
  },
  {
    ...base,
    ...support(1_500_00),
    key: "support-care",
    name: "Care support",
    description: "Faster replies, a quarterly health check, and replacement SILLA hardware at cost.",
    highlights: ["Replies within 4 business hours", "A quarterly health check", "Replacement SILLA hardware at cost"],
    sort: 41,
  },
  {
    ...base,
    ...support(4_500_00),
    key: "support-care-plus",
    name: "Care Plus support",
    description: "Everything in Care, with hardware replaced free, visits on site and a yearly refresher.",
    highlights: [
      "Everything in Care",
      "Free replacement of SILLA hardware within 2 business days",
      "2 on-site visits a year (Metro Manila)",
      "A yearly refresher training",
    ],
    sort: 42,
  },
];
