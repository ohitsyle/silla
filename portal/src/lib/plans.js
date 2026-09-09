/**
 * The plans, in one place.
 *
 * Shared by the pricing section (which sells them) and the configurator
 * (which records which one an order is for). Two copies would drift, and
 * the copy that mattered would be whichever one the order was written
 * from — see lib/adminSections.js in the product for the same lesson.
 *
 * ⚠️  THE NUMBERS AND CURRENCY ARE STILL PLACEHOLDERS. Nothing is
 * charged; Stripe is chosen but not wired. An order records
 * `quotedAmount` at the time it was placed, so changing these later
 * will not rewrite what an existing customer was offered — but a live
 * page must not show a price you cannot honour.
 */
export const CURRENCY = "$"; // placeholder — set alongside PLANS

export const PLANS = [
  {
    key: "room",
    name: "One Room",
    tagline: "A single floor, a reading room, a studio.",
    monthly: 49,
    annual: 39,
    highlights: [
      "Up to 60 bookable units",
      "One site, one floor",
      "Every feature, no exceptions",
      "Email support",
    ],
  },
  {
    key: "building",
    name: "Whole Building",
    tagline: "Several floors and the staff to run them.",
    monthly: 149,
    annual: 119,
    featured: true,
    highlights: [
      "Up to 600 bookable units",
      "One site, unlimited floors",
      "Unlimited staff accounts",
      "Priority support",
      "Onboarding call and layout help",
    ],
  },
  {
    key: "campus",
    name: "Campus",
    tagline: "More than one building, more than one team.",
    monthly: null, // "let's talk"
    annual: null,
    highlights: [
      "Unlimited units",
      "Multiple sites",
      "Custom identity formats and policy",
      "A named contact who answers",
    ],
  },
];


export const PLAN_BY_KEY = Object.fromEntries(PLANS.map((p) => [p.key, p]));

/**
 * One money formatter, because there were four.
 *
 * `priceFor` returns MINOR units (cents) — that is what the Order
 * stores, and storing money as a float is how you end up with £9.99
 * becoming £9.989999. Pricing.jsx renders `plan.annual` directly, in
 * MAJOR units. Both are correct and they differ by 100x, which is
 * exactly the kind of thing that renders "$3900/month" on a $39 plan.
 *
 * Takes minor units, because that is the form that travels — into the
 * order, and back out of it on the buyer's own orders screen.
 */
export const formatMoney = (minorUnits, { period } = {}) => {
  if (minorUnits == null) return "Priced with you";
  const major = minorUnits / 100;
  // No decimals on whole amounts: "$39" reads as a price, "$39.00"
  // reads as a receipt.
  const shown = Number.isInteger(major) ? major : major.toFixed(2);
  return `${CURRENCY}${shown}${period ? `/${period}` : ""}`;
};

/** Minor units (cents), which is what the order stores. */
export const priceFor = (key, annual) => {
  const plan = PLAN_BY_KEY[key];
  if (!plan) return null;
  const amount = annual ? plan.annual : plan.monthly;
  return amount == null ? null : amount * 100;
};
