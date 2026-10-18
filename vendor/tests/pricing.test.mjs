/**
 * Pricing — the catalogue, quotes computed on the server, add-ons on
 * invoices and in the entitlements. Asserted from the outside wherever
 * there is an outside: orders are priced, submitted and paid through the
 * real HTTP API, the catalogue is edited as staff edit it, and what a
 * deployment is told is read back from the fake product API.
 *
 * The quote maths are checked twice: as pure arithmetic on lib/quote.js
 * (exact centavos, no float anywhere), and as what an order actually
 * freezes and an invoice actually bills — the two must agree to the
 * centavo.
 *
 * Like billing.test.mjs this edits shared state (catalogue prices, VAT
 * settings) and runs the billing job, so everything past the pure checks
 * runs only under `npm run test:isolated`; elsewhere it says so.
 */
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { KNOWN_CODE, plantCode } from "./helpers.mjs";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";
import AuditEvent from "../src/models/AuditEvent.js";
import CatalogItem from "../src/models/CatalogItem.js";
import Invoice from "../src/models/Invoice.js";
import Order from "../src/models/Order.js";
import Subscription from "../src/models/Subscription.js";
import * as billing from "../src/services/billing.js";
import { runBillingCycle } from "../src/workers/billing.jobs.js";
import { DEFAULT_PLANS } from "../src/lib/defaultPlans.js";
import { DEFAULT_CATALOG } from "../src/lib/defaultCatalog.js";
import { buildQuote, readSelections } from "../src/lib/quote.js";
import { invoiceIssuedEmail } from "../src/services/email/billingTemplates.js";
import { orderSubmittedEmail } from "../src/services/email/templates.js";

export const name = "Pricing — catalogue, quotes, add-ons";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const FAKE = process.env.FAKE_CONTROL_PLANE_URL || "";
const DAY = 86_400_000;
const PASSWORD = "a-long-enough-password";
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function req(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (path, headers) => req(path, { headers });
const post = (path, body, headers) => req(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
const patch = (path, body, headers) => req(path, { method: "PATCH", headers, body: JSON.stringify(body || {}) });
const put = (path, body, headers) => req(path, { method: "PUT", headers, body: JSON.stringify(body || {}) });

const profileFor = (organizationName) => ({
  key: organizationName.toLowerCase().replace(/\W+/g, "-"),
  organizationName,
  siteName: "Main Site",
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  floors: [{ name: "Level 1", order: 0, grid: { cols: 10, rows: 8 }, resources: [], zones: [], labels: [] }],
  owner: { firstName: "Pia", lastName: "Owner", email: `pia-${unique()}@test.silla` },
});

async function buyer(email, organizationName) {
  const signup = await post("/api/vendor/auth/register", {
    firstName: "Pri",
    lastName: "Tester",
    email,
    confirmEmail: email,
    password: PASSWORD,
    acceptTerms: true,
    organizationName,
  });
  const H = auth(signup.body?.token);
  await plantCode(email, "signup");
  await post("/api/vendor/auth/me/verify", { code: KNOWN_CODE }, H);
  return H;
}

async function staffMember(role, tag) {
  const email = `pricing-${role}-${tag}@test.silla`;
  await Account.create({
    email,
    firstName: "Staff",
    lastName: role,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    role: "silla",
    staffRole: role,
    active: true,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    passwordChangedAt: new Date(Date.now() - 5000),
  });
  const login = await post("/api/vendor/auth/login", { email, password: PASSWORD });
  return auth(login.body?.token);
}

/** The walk's order: a two-building site on Building, two rented kiosks, printed cards, installation and Care. */
const WALK = [
  { key: "extra-building", quantity: 1 },
  { key: "kiosk", quantity: 2, mode: "rent" },
  { key: "rfid-card-printed", quantity: 300 },
  { key: "installation", quantity: 1 },
  { key: "support-care", quantity: 1 },
];

const lineOf = (lines, key, kind) => (lines || []).find((l) => l.key === key && (!kind || l.kind === kind));
const sameFile = (a, b) => readFileSync(new URL(a, import.meta.url), "utf8") === readFileSync(new URL(b, import.meta.url), "utf8");

export async function run(check) {
  /* ───────────── pure: the copies, and the arithmetic ───────────── */

  const copies = ["quote.js", "defaultPlans.js", "defaultCatalog.js"].filter(
    (f) => !sameFile(`../src/lib/${f}`, `../../portal/src/lib/${f}`)
  );
  check("PRC-1", "The quote maths and the default prices exist once: the portal's copies are the vendor's, byte for byte",
    copies.length === 0, copies.length ? `differs: ${copies.join(", ")}` : "");

  const building = DEFAULT_PLANS.find((p) => p.key === "building");
  const starter = DEFAULT_PLANS.find((p) => p.key === "room");
  const walk = readSelections(WALK).selections;
  const quoteOf = (plan, billingPeriod, selections, vat) =>
    buildQuote({ plan, plans: DEFAULT_PLANS, billingPeriod, selections, catalogue: DEFAULT_CATALOG, vat });

  const monthly = quoteOf(building, "monthly", walk);
  check("PRC-2", "Monthly: ₱15,000 a month and ₱33,500 paid once, ₱48,500 on the first invoice — in centavos, exactly",
    monthly.quote.totals.perMonth === 15_000_00 && monthly.quote.totals.oneTime === 33_500_00 && monthly.quote.totals.firstInvoice.total === 48_500_00,
    JSON.stringify(monthly.quote.totals));
  const yearly = quoteOf(building, "yearly", walk);
  check("PRC-2", "Yearly: ₱156,000 a year, ₱28,500 paid once, ₱184,500 on the first invoice",
    yearly.quote.totals.perPeriod === 156_000_00 && yearly.quote.totals.oneTime === 28_500_00 && yearly.quote.totals.firstInvoice.total === 184_500_00,
    JSON.stringify(yearly.quote.totals));
  check("PRC-2", "…and yearly billing saves ₱24,000 on the recurring items plus the ₱5,000 onboarding",
    yearly.quote.totals.yearlySaving.recurring === 24_000_00 && yearly.quote.totals.yearlySaving.waived === 5_000_00);

  // Centavo prices a float would get wrong: 3 × ₱0.10 is 30 centavos, not 0.30000000000000004 pesos.
  const tiny = buildQuote({
    plan: { key: "t", name: "T", currency: "PHP", prices: { monthly: 1_00, annualMonthly: 1_00 }, limits: {} },
    billingPeriod: "monthly",
    selections: [
      { key: "dime", quantity: 3, mode: null },
      { key: "odd", quantity: 3, mode: null },
    ],
    catalogue: [
      { key: "dime", name: "Dime", category: "hardware", charge: "one_time", prices: { oneTime: 10 }, minQuantity: 1, plans: [] },
      { key: "odd", name: "Odd", category: "hardware", charge: "one_time", prices: { oneTime: 33_33 }, minQuantity: 1, plans: [] },
    ],
    vat: { registered: true, rate: 0.12 },
  }).quote;
  const integers = [...tiny.lines.map((l) => l.amount), tiny.totals.oneTime, tiny.totals.firstInvoice.subtotal, tiny.totals.firstInvoice.tax, tiny.totals.firstInvoice.total];
  check("PRC-2", "No float drift: every amount is a whole number of centavos, VAT rounded once (₱101.29 + ₱12.15 = ₱113.44)",
    integers.every(Number.isInteger) && tiny.totals.firstInvoice.subtotal === 10_129 && tiny.totals.firstInvoice.tax === 1_215 && tiny.totals.firstInvoice.total === 11_344,
    JSON.stringify(tiny.totals.firstInvoice));

  const below = quoteOf(building, "yearly", [{ key: "rfid-card", quantity: 10, mode: null }]);
  check("PRC-3", "A quantity under the minimum is refused, saying what the minimum is",
    below.problems["selections.rfid-card"] === "RFID card, blank: the minimum is 50 cards.", below.problems["selections.rfid-card"]);
  const onStarter = quoteOf(starter, "yearly", [{ key: "extra-building", quantity: 1, mode: null }]);
  check("PRC-4", "An extra building is refused on Starter, naming the plans that take one",
    onStarter.problems["selections.extra-building"] === "Extra building isn't available on the Starter plan — choose Building or Campus.",
    onStarter.problems["selections.extra-building"]);
  const twoTiers = quoteOf(building, "yearly", [
    { key: "support-care", quantity: 1, mode: null },
    { key: "support-care-plus", quantity: 1, mode: null },
  ]);
  check("PRC-5", "Two support tiers are refused: one per order",
    /Choose one support option/.test(twoTiers.problems["selections.support-care-plus"] || ""), JSON.stringify(twoTiers.problems));
  const onboardingYearly = lineOf(yearly.quote.lines, "onboarding");
  const onboardingMonthly = lineOf(monthly.quote.lines, "onboarding");
  check("PRC-6", "Onboarding is on every order: waived on yearly billing, ₱5,000 on monthly",
    onboardingYearly?.waived === true && onboardingYearly.amount === 0 && onboardingYearly.description === "Onboarding — waived on yearly billing" &&
      onboardingMonthly?.amount === 5_000_00);
  const standard = lineOf(quoteOf(building, "yearly", []).quote.lines, "support-standard");
  check("PRC-6", "With no support chosen the quote carries Standard support, included", standard?.included === true && standard.amount === 0,
    standard?.description);

  /* ───────────── through the API: isolated only ───────────── */

  if (mongoose.connection.readyState !== 1) await connectDB();
  if (process.env.VENDOR_DB_NAME !== "silla_vendor_isolated") {
    console.log("  the rest is skipped — it edits catalogue prices and VAT settings and runs the billing job,");
    console.log("  which must never happen to a real catalogue. Run it with: npm run test:isolated");
    return;
  }

  const tag = unique();
  await billing.ensureCatalog(); // seeded on its first read, which may be this one
  const settingsBefore = billing.settingsShape(await billing.getSettings());
  const kioskBefore = billing.catalogItemShape(await CatalogItem.findOne({ key: "kiosk" }).lean());
  const tempKey = `lanyard-${tag}`.slice(0, 40);

  try {
    const ownerLogin = await post("/api/vendor/auth/login", { email: process.env.VENDOR_STAFF_EMAIL, password: process.env.VENDOR_STAFF_PASSWORD });
    if (ownerLogin.status !== 200) {
      check("PRC-0", "SILLA staff can sign in", false, "set VENDOR_STAFF_EMAIL / VENDOR_STAFF_PASSWORD");
      return;
    }
    const OWNER = auth(ownerLogin.body.token);
    const BILLING = await staffMember("billing", tag);
    const A = await buyer(`pri-a-${tag}@test.silla`, "Harbor Pricing Co");
    const B = await buyer(`pri-b-${tag}@test.silla`, "Other Pricing Co");

    /* ── the catalogue, public ── */
    const storefront = await get("/api/vendor/plans");
    const names = (storefront.body?.plans || []).map((p) => `${p.key}:${p.name}:${p.prices.monthly}/${p.prices.annualMonthly}`);
    check("PRC-7", "The storefront sells Starter, Building and Campus at the agreed prices",
      ["room:Starter:250000/200000", "building:Building:750000/600000", "campus:Campus:1800000/1500000"].every((n) => names.includes(n)), names.join(" "));
    const sold = new Map((storefront.body?.catalogue || []).map((i) => [i.key, i]));
    check("PRC-7", "…with the catalogue beside them: extra buildings, hardware, services and support, priced",
      sold.get("extra-building")?.prices?.monthly === 3_000_00 && sold.get("kiosk")?.prices?.oneTime === 28_000_00 &&
        sold.get("rfid-card-printed")?.minQuantity === 100 && sold.get("support-care-plus")?.prices?.monthly === 4_500_00 &&
        sold.get("kiosk")?.note.includes("1-year warranty") && storefront.body?.vat?.rate === 0.12,
      `${sold.size} items`);

    /* ── who may write it ── */
    const byBuyer = await patch("/api/vendor/catalogue/kiosk", { prices: { monthly: 1 } }, A);
    const byBuyerCreate = await post("/api/vendor/catalogue", { key: `x-${tag}`.slice(0, 40), name: "X", category: "hardware", charge: "one_time", prices: { oneTime: 1 } }, A);
    const byBuyerRead = await get("/api/vendor/catalogue/all", A);
    const byBilling = await patch("/api/vendor/catalogue/kiosk", { prices: { monthly: 1 } }, BILLING);
    const unchanged = billing.catalogItemShape(await CatalogItem.findOne({ key: "kiosk" }).lean());
    check("PRC-8", "Buyers cannot write the catalogue, nor read staff's view of it",
      byBuyer.status === 403 && byBuyerCreate.status === 403 && byBuyerRead.status === 403, `${byBuyer.status} ${byBuyerCreate.status} ${byBuyerRead.status}`);
    check("PRC-8", "…nor can billing staff, who don't hold plans.manage — and the price did not move",
      byBilling.status === 403 && unchanged.prices.monthly === kioskBefore.prices.monthly);

    /* ── staff edit it, validated as a whole item ── */
    const badAdds = await patch("/api/vendor/catalogue/kiosk", { adds: { buildings: 1 } }, OWNER);
    const noPrice = await patch("/api/vendor/catalogue/rfid-card", { prices: { oneTime: null } }, OWNER);
    const badPlan = await post("/api/vendor/catalogue", { key: tempKey, name: "Lanyard", category: "hardware", charge: "one_time", prices: { oneTime: 25_00 }, plans: ["nope"] }, OWNER);
    check("PRC-9", "A catalogue edit that makes no sense is refused by field: a limit raise on hardware, a price removed, an unknown plan",
      badAdds.status === 400 && Boolean(badAdds.body?.fields?.adds) && noPrice.status === 400 && Boolean(noPrice.body?.fields?.["prices.oneTime"]) &&
        badPlan.status === 400 && Boolean(badPlan.body?.fields?.plans),
      JSON.stringify([badAdds.body?.fields, noPrice.body?.fields, badPlan.body?.fields]));
    const created = await post("/api/vendor/catalogue", {
      key: tempKey, name: "Lanyard", category: "hardware", charge: "one_time", prices: { oneTime: 25_00 }, unit: { one: "lanyard", many: "lanyards" },
    }, OWNER);
    const retired = await patch(`/api/vendor/catalogue/${tempKey}`, { active: false }, OWNER);
    const publicAfter = ((await get("/api/vendor/catalogue")).body?.catalogue || []).map((i) => i.key);
    const orderRetired = await post("/api/vendor/orders", { profile: profileFor(`Retired Co ${tag}`), plan: "building", selections: [{ key: tempKey, quantity: 2 }] }, B);
    check("PRC-9", "Staff add an item and retire it: it leaves the storefront, and an order choosing it is told it isn't offered",
      created.status === 201 && retired.status === 200 && !publicAfter.includes(tempKey) && orderRetired.status === 400 &&
        /isn't offered any more/.test(orderRetired.body?.fields?.[`selections.${tempKey}`] || ""),
      orderRetired.body?.error);
    const trail = await AuditEvent.find({ action: { $in: ["catalog.create", "catalog.update"] }, "target.id": tempKey });
    check("PRC-9", "…and both changes are on the activity log", trail.length === 2 && trail.every((e) => e.actorRole === "owner"), `${trail.length} entries`);

    /* ── the rules, refused by the server ── */
    const refusedBy = async (selections, plan = "building") => {
      const res = await post("/api/vendor/orders", { profile: profileFor(`Refused Co ${unique()}`), plan, billingPeriod: "yearly", selections }, B);
      return { status: res.status, code: res.body?.code, fields: res.body?.fields || {} };
    };
    const minimum = await refusedBy([{ key: "rfid-card-printed", quantity: 40 }]);
    check("PRC-3", "The server refuses a draft under a minimum, by field, with the minimum in words",
      minimum.status === 400 && minimum.code === "QUOTE_INVALID" &&
        minimum.fields["selections.rfid-card-printed"] === "RFID card, printed with your logo and member ID: the minimum is 100 cards.",
      JSON.stringify(minimum.fields));
    const starterExtra = await refusedBy([{ key: "extra-building", quantity: 2 }], "room");
    check("PRC-4", "…an extra building on Starter", starterExtra.status === 400 && Boolean(starterExtra.fields["selections.extra-building"]),
      JSON.stringify(starterExtra.fields));
    const tiers = await refusedBy([{ key: "support-care", quantity: 1 }, { key: "support-care-plus", quantity: 1 }]);
    check("PRC-5", "…and two support tiers", tiers.status === 400 && Boolean(tiers.fields["selections.support-care-plus"]), JSON.stringify(tiers.fields));
    const noMode = await refusedBy([{ key: "kiosk", quantity: 1 }]);
    check("PRC-5", "A kiosk has to be bought or rented — the order says which", noMode.status === 400 && Boolean(noMode.fields["selections.kiosk"]));

    /* ── a draft is priced at submission, not when it was saved ── */
    const draftB = await post("/api/vendor/orders", {
      profile: profileFor(`Draft Co ${tag}`), plan: "building", billingPeriod: "yearly", selections: [{ key: "kiosk", quantity: 1, mode: "rent" }],
    }, B);
    const draftBId = draftB.body?.order?.id;

    /* ── the walk's order: a browser-sent price is ignored ── */
    const createdA = await post("/api/vendor/orders", {
      profile: profileFor("Harbor Pricing Co"),
      plan: "building",
      billingPeriod: "yearly",
      // None of these is read: the server prices the order from the catalogue.
      quotedAmount: 1,
      currency: "USD",
      quote: { totals: { firstInvoice: { total: 1 } } },
      selections: WALK.map((s) => ({ ...s, unitAmount: 1, price: 1, amount: 1 })),
    }, A);
    const orderAId = createdA.body?.order?.id;
    check("PRC-10", "An order is saved with what the buyer chose, priced by the server, not by what the browser sent",
      createdA.status === 201 && createdA.body?.order?.quotedAmount === 6_000_00 && createdA.body?.order?.currency === "PHP",
      `${createdA.status} ${createdA.body?.error || ""} ${createdA.body?.order?.quotedAmount}`);
    const draftView = (await get(`/api/vendor/orders/${orderAId}`, A)).body?.order;
    check("PRC-10", "…and a draft shows its quote priced live", draftView?.quoteLive === true && draftView?.quote?.totals?.firstInvoice?.total === 184_500_00 &&
      draftView?.selections?.length === WALK.length && !("unitAmount" in (draftView?.selections?.[0] || {})), JSON.stringify(draftView?.selections?.[0]));

    const submitA = await post(`/api/vendor/orders/${orderAId}/submit`, {}, A);
    const orderA = await Order.findById(orderAId).lean();
    const frozen = orderA?.quote;
    check("PRC-10", "Submitting freezes the server's quote: the catalogue's prices, the plan's figure in quotedAmount",
      submitA.status === 200 && Boolean(frozen?.frozenAt) && frozen.totals.firstInvoice.total === 184_500_00 &&
        lineOf(frozen.lines, "kiosk", "rental")?.unitAmount === 1_500_00 && orderA.quotedAmount === 6_000_00 && orderA.currency === "PHP",
      submitA.body?.error || JSON.stringify(frozen?.totals));
    check("PRC-10", "…stating the rental's 12-month minimum on the quote",
      frozen?.commitments?.includes("SILLA Kiosk rental: 12-month minimum.") &&
        lineOf(frozen?.lines, "kiosk", "rental")?.description === "SILLA Kiosk rental — first year (12-month minimum)");

    /* ── the first invoice ── */
    const subA = await Subscription.findOne({ order: orderAId });
    const firstA = await Invoice.findOne({ subscription: subA?._id, kind: "first" }).lean();
    const firstLines = (firstA?.lines || []).map((l) => `${l.description}|${l.quantity}|${l.unitAmount}|${l.amount}`);
    const expectedFirst = [
      "Building plan — first year|1|7200000|7200000",
      "Extra building — first year|1|3000000|3000000",
      "SILLA Kiosk rental — first year (12-month minimum)|2|1800000|3600000",
      "Care support — first year|1|1800000|1800000",
      "RFID card, printed with your logo and member ID|300|7500|2250000",
      "Onboarding — waived on yearly billing|1|0|0",
      "On-site installation|1|600000|600000",
    ];
    check("PRC-11", "The first invoice carries the plan's year, every add-on and rental for the year, and every one-time item, in that order",
      JSON.stringify(firstLines) === JSON.stringify(expectedFirst), firstLines.join(" / "));
    check("PRC-11", "…totalling what the frozen quote said, with no VAT while SILLA isn't VAT-registered",
      firstA?.subtotal === 184_500_00 && firstA?.tax?.amount === 0 && firstA?.total === frozen?.totals?.firstInvoice?.total, `${firstA?.total}`);
    check("PRC-11", "…each line saying what it is, and the warranty and the travel note printed with them",
      lineOf(firstA?.lines, "rfid-card-printed")?.note === "1-year warranty." && /travel is billed at cost/.test(lineOf(firstA?.lines, "installation")?.note || "") &&
        lineOf(firstA?.lines, "plan")?.kind === "plan" && lineOf(firstA?.lines, "kiosk")?.kind === "rental");
    check("PRC-11", "The subscription remembers its add-ons and rentals with their quantities and agreed prices",
      JSON.stringify((subA?.addOns || []).map((a) => `${a.key}:${a.kind}:${a.quantity}:${a.unitAmount}`)) ===
        JSON.stringify(["extra-building:recurring:1:250000", "kiosk:rental:2:150000", "support-care:recurring:1:150000"]),
      (subA?.addOns || []).map((a) => `${a.key}:${a.quantity}`).join(", "));

    /* ── entitlements: the plan's building limit plus the extras ── */
    const snapshot = await billing.snapshotFor(subA);
    check("PRC-12", "The entitlement snapshot's building limit is the plan's plus the extra buildings (1 + 1)",
      snapshot.limits.buildings === 2 && snapshot.limits.resources === 600, JSON.stringify(snapshot.limits));
    const slug = `harbor-pricing-${tag}`.slice(0, 40);
    const provisioned = await post("/api/vendor/deployments/provision", { orderId: orderAId, slug }, OWNER);
    const received = FAKE ? (await (await fetch(`${FAKE}/__received`)).json()).received : [];
    const born = received.filter((r) => r.method === "POST" && r.path === "/api/internal/organizations" && r.body?.slug === slug).at(-1);
    check("PRC-12", "…and the deployment is born with it",
      provisioned.status === 201 && born?.body?.entitlements?.limits?.buildings === 2, provisioned.body?.error || JSON.stringify(born?.body?.entitlements?.limits));
    const orgId = provisioned.body?.organizationId || (await Order.findById(orderAId).lean())?.provisionedOrganizationId;
    const meA = (await get("/api/vendor/billing/me", A)).body?.subscriptions?.find((s) => s.orderId === orderAId);
    const buildingsA = meA?.includes?.limits?.find((l) => l.key === "buildings");
    check("PRC-12", "The buyer's billing page says 2 buildings, one of them added, and what a year costs in all",
      buildingsA?.value === 2 && buildingsA?.raisedBy === 1 && meA?.perPeriod === 156_000_00 && meA?.addOns?.length === 3,
      JSON.stringify(buildingsA) + ` ${meA?.perPeriod}`);

    /* ── pay the first invoice: active ── */
    const paid = await post(`/api/vendor/billing/invoices/${firstA?._id}/payment`, { method: "bank_transfer", amount: firstA?.total, reference: `BDO-${tag}` }, BILLING);
    check("PRC-13", "Paying the first invoice activates the subscription", paid.status === 200 && paid.body?.subscription?.status === "active", paid.body?.error);

    /* ── staff reprice the catalogue: new quotes move, frozen ones never ── */
    const repriced = await patch("/api/vendor/catalogue/kiosk", { prices: { monthly: 1_700_00 } }, OWNER);
    const frozenAfter = (await get(`/api/vendor/orders/${orderAId}`, A)).body?.order;
    check("PRC-14", "Staff reprice the kiosk rental; the submitted order's frozen quote does not move",
      repriced.status === 200 && frozenAfter?.quoteLive === false && lineOf(frozenAfter?.quote?.lines, "kiosk", "rental")?.unitAmount === 1_500_00 &&
        frozenAfter?.quote?.totals?.firstInvoice?.total === 184_500_00);
    const submitB = await post(`/api/vendor/orders/${draftBId}/submit`, {}, B);
    const orderB = await Order.findById(draftBId).lean();
    check("PRC-14", "…while a draft saved at the old price is priced at the new one when it is submitted",
      submitB.status === 200 && lineOf(orderB?.quote?.lines, "kiosk", "rental")?.unitAmount === 1_700_00, submitB.body?.error);
    const liveNew = await post("/api/vendor/orders", { profile: profileFor(`New Co ${tag}`), plan: "building", billingPeriod: "monthly", selections: [{ key: "kiosk", quantity: 1, mode: "rent" }] }, B);
    const liveView = (await get(`/api/vendor/orders/${liveNew.body?.order?.id}`, B)).body?.order;
    check("PRC-14", "…and so is any new quote", lineOf(liveView?.quote?.lines, "kiosk", "rental")?.unitAmount === 1_700_00);

    /* ── staff change the add-ons on the subscription ── */
    const subPath = `/api/vendor/billing/subscriptions/${subA?._id}`;
    const tooManyTiers = await patch(subPath, { addOns: [{ key: "support-care", quantity: 1 }, { key: "support-care-plus", quantity: 1 }] }, BILLING);
    const oneOff = await patch(subPath, { addOns: [{ key: "rfid-card", quantity: 60 }] }, BILLING);
    const toStarter = await patch(subPath, { plan: "room" }, BILLING);
    const byBuyerSub = await patch(subPath, { addOns: [] }, A);
    check("PRC-15", "A subscription's add-ons refuse two support tiers, one-time items (a manual invoice is for those), and a move to Starter while it holds extra buildings",
      tooManyTiers.status === 400 && Boolean(tooManyTiers.body?.fields?.["addOns.support-care-plus"]) &&
        oneOff.status === 400 && /manual invoice/.test(oneOff.body?.fields?.["addOns.rfid-card"] || "") &&
        toStarter.status === 400 && /isn't available on the Starter plan/.test(toStarter.body?.fields?.plan || "") && byBuyerSub.status === 403,
      JSON.stringify([tooManyTiers.body?.fields, oneOff.body?.fields, toStarter.body?.fields]));
    const changed = await patch(subPath, {
      addOns: [
        { key: "extra-building", quantity: 2 },
        { key: "kiosk", quantity: 2, mode: "rent" },
        { key: "support-care", quantity: 1 },
      ],
    }, BILLING);
    const detail = changed.body?.subscription;
    check("PRC-15", "Billing staff set two extra buildings: the entitlements follow at once (1 + 2 = 3)",
      changed.status === 200 && detail?.effective?.limits?.buildings === 3 && detail?.perPeriod === 186_000_00, changed.body?.error || JSON.stringify(detail?.effective?.limits));
    const pushes = FAKE
      ? (await (await fetch(`${FAKE}/__received`)).json()).received.filter((r) => r.method === "PUT" && r.path === `/api/internal/organizations/${orgId}/entitlements`)
      : [];
    check("PRC-15", "…and the deployment is told", pushes.at(-1)?.body?.limits?.buildings === 3, `${pushes.length} push(es)`);
    const kept = (await Subscription.findById(subA?._id).lean())?.addOns || [];
    check("PRC-15", "…the kiosk rental keeps the price agreed for it, though the catalogue now asks more",
      lineOf(kept, "kiosk", "rental")?.unitAmount === 1_500_00 && lineOf(kept, "extra-building")?.quantity === 2);
    const audited = await AuditEvent.findOne({ action: "subscription.addons", "target.id": String(subA?._id) });
    check("PRC-15", "…and the change is on the activity log as the billing staff member's", audited?.actorRole === "billing", audited?.summary);

    /* ── the renewal: plan and add-ons, rentals included, never the one-time items ── */
    const renewEnd = new Date(Date.now() + 2 * DAY);
    await Subscription.updateOne({ _id: subA._id }, { $set: { currentPeriodEnd: renewEnd } });
    await runBillingCycle();
    const renewal = await Invoice.findOne({ subscription: subA._id, kind: "renewal" }).lean();
    const renewalLines = (renewal?.lines || []).map((l) => `${l.description}|${l.quantity}|${l.unitAmount}`);
    const expectedRenewal = [
      "Building plan — renewal, 1 year|1|7200000",
      "Extra building — renewal, 1 year|2|3000000",
      "SILLA Kiosk rental — renewal, 1 year|2|1800000",
      "Care support — renewal, 1 year|1|1800000",
    ];
    check("PRC-16", "The renewal bills the plan, both extra buildings and the rented kiosks for the next year",
      JSON.stringify(renewalLines) === JSON.stringify(expectedRenewal), renewalLines.join(" / "));
    check("PRC-16", "…and no one-time item a second time", renewal && !(renewal.lines || []).some((l) => l.kind === "one_time") && renewal.total === 186_000_00,
      `${renewal?.total}`);

    /* ── VAT, for a new order, only while VAT-registered ── */
    const vatOn = await put("/api/vendor/settings", { business: { ...settingsBefore.business, vatRegistered: true, taxId: "123-456-789-000" } }, OWNER);
    const vatPlans = (await get("/api/vendor/plans")).body;
    const vatOrder = await post("/api/vendor/orders", {
      profile: profileFor(`Vat Co ${tag}`), plan: "room", billingPeriod: "monthly", selections: [{ key: "usb-reader", quantity: 2 }],
    }, B);
    await post(`/api/vendor/orders/${vatOrder.body?.order?.id}/submit`, {}, B);
    const vatFrozen = (await Order.findById(vatOrder.body?.order?.id).lean())?.quote;
    const vatSub = await Subscription.findOne({ order: vatOrder.body?.order?.id });
    const vatInvoice = await Invoice.findOne({ subscription: vatSub?._id, kind: "first" }).lean();
    await put("/api/vendor/settings", { business: settingsBefore.business }, OWNER);
    // Starter monthly ₱2,500 + 2 readers ₱3,000 + onboarding ₱5,000 = ₱10,500; VAT 12% = ₱1,260.
    check("PRC-17", "VAT-registered, a new order's quote and its first invoice both add 12% — ₱10,500 + ₱1,260",
      vatOn.status === 200 && vatPlans?.vat?.registered === true && vatFrozen?.totals?.firstInvoice?.tax === 1_260_00 &&
        vatInvoice?.tax?.amount === 1_260_00 && vatInvoice?.total === 11_760_00 && vatInvoice?.tax?.label === "VAT 12%",
      `${vatFrozen?.totals?.firstInvoice?.tax} ${vatInvoice?.tax?.amount} ${vatInvoice?.total}`);
    check("PRC-17", "…while the order submitted before carries none", firstA?.tax?.amount === 0 && frozen?.vat?.registered === false);

    /* ── the emails say every line through the one formatter ── */
    const accountA = await Account.findOne({ email: `pri-a-${tag}@test.silla` }).lean();
    const receipt = orderSubmittedEmail({ account: accountA, order: orderA });
    check("PRC-18", "The order receipt lists the quote's lines and totals in pesos",
      receipt.text.includes("SILLA Kiosk rental — first year (12-month minimum) (2 × ₱18,000.00 a year): ₱36,000.00") &&
        receipt.text.includes("First invoice: ₱184,500.00") && receipt.html.includes("₱184,500.00") && receipt.text.includes("12-month minimum."),
      receipt.text.split("\n").filter((l) => l.includes("₱")).slice(0, 3).join(" | "));
    const invoiceMail = invoiceIssuedEmail({ invoice: firstA, account: accountA, settings: settingsBefore });
    check("PRC-18", "The invoice email prints every line, not just the first",
      expectedFirst.every((l) => invoiceMail.text.includes(l.split("|")[0])) && invoiceMail.text.includes("Total: ₱184,500.00"));
  } finally {
    await CatalogItem.updateOne({ key: "kiosk" }, { $set: { prices: kioskBefore.prices } }).catch(() => {});
    await CatalogItem.deleteOne({ key: tempKey }).catch(() => {});
    await billing.updateSettings({ business: settingsBefore.business }).catch(() => {});
    await AuditEvent.deleteMany({ "target.type": "catalog", "target.id": tempKey }).catch(() => {});
  }
}
