import {
  Building2, FileSpreadsheet, GraduationCap, Headset, IdCard, KeyRound, LifeBuoy, Map as MapIcon, Monitor, Package,
  ShieldCheck, Tablet, Usb, Wrench,
} from "lucide-react";
import { formatMoney } from "./plans.js";

/**
 * How the storefront, the configurator and the console SHOW what is in
 * the catalogue — icons, grouping and the words around a price. Pure
 * presentation: what an item costs and the rules it follows come from the
 * catalogue itself (GET /api/vendor/plans), and are enforced by
 * lib/quote.js, here and again on the server.
 *
 * Keys a staff member adds later get their category's icon and the same
 * words, so a new item never needs a code change to be sold.
 */

const ICON_BY_KEY = {
  "extra-building": Building2,
  kiosk: Tablet,
  "kiosk-large": Monitor,
  "rfid-card": IdCard,
  "rfid-card-printed": IdCard,
  "key-fob": KeyRound,
  "usb-reader": Usb,
  onboarding: MapIcon,
  installation: Wrench,
  "card-enrollment": FileSpreadsheet,
  training: GraduationCap,
  "support-standard": LifeBuoy,
  "support-care": Headset,
  "support-care-plus": ShieldCheck,
};
const ICON_BY_CATEGORY = { building: Building2, hardware: Package, service: Wrench, support: LifeBuoy };

export const iconFor = (item) => ICON_BY_KEY[item?.key] || ICON_BY_CATEGORY[item?.category] || Package;

/**
 * The catalogue in the groups a buyer thinks in: more buildings, kiosks
 * (bought or rented), the smaller hardware, setup and services, and the
 * support tiers. Sorted as staff sorted them.
 */
export function groupCatalogue(catalogue = []) {
  const items = [...catalogue].filter((i) => i.active !== false).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return {
    buildings: items.filter((i) => i.category === "building"),
    kiosks: items.filter((i) => i.category === "hardware" && i.charge === "buy_or_rent"),
    hardware: items.filter((i) => i.category === "hardware" && i.charge !== "buy_or_rent"),
    services: items.filter((i) => i.category === "service"),
    support: items.filter((i) => i.category === "support"),
  };
}

/** A support tier's name without the word every tier shares: "Care Plus support" → "Care Plus". */
export const tierName = (item) => String(item?.name || "").replace(/\s+support$/i, "") || item?.name || "";

/** "card" / "cards" by count. */
export const unitWord = (item, n) => (n === 1 ? item?.unit?.one || "unit" : item?.unit?.many || "units");

/** An item's price per unit per month on a billing period: a missing yearly figure is the monthly one. */
export function monthlyOf(item, annual) {
  const prices = item?.prices || {};
  if (annual && Number.isInteger(prices.annualMonthly)) return prices.annualMonthly;
  return Number.isInteger(prices.monthly) ? prices.monthly : null;
}

/**
 * The price tag for a one-time item: "₱35 each" for hardware, "₱6,000 per
 * visit" for a service — said per the thing being counted.
 */
export function oneTimeTag(item) {
  const amount = item?.prices?.oneTime;
  if (!Number.isInteger(amount)) return "Ask us";
  const per = item.category === "hardware" ? "each" : item.maxQuantity === 1 ? "once" : `per ${item.unit?.one || "unit"}`;
  return `${formatMoney(amount, { currency: item.currency })} ${per}`;
}

/** "Minimum 50 cards", or nothing for a minimum of one. */
export const minimumTag = (item) => (item?.minQuantity > 1 ? `Minimum ${item.minQuantity.toLocaleString("en-PH")} ${unitWord(item, item.minQuantity)}` : "");

/** "₱1,500/month", or "Included" for a tier that costs nothing. */
export function monthlyTag(item, annual) {
  const amount = monthlyOf(item, annual);
  if (amount == null) return "Ask us";
  return amount === 0 ? "Included" : formatMoney(amount, { period: "month", currency: item.currency });
}
