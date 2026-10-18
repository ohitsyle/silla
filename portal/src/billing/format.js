/**
 * Billing words and conversions shared by the buyer's billing pages and
 * the staff console. Money itself is formatted ONLY by formatMoney in
 * lib/plans.js; this file turns a form's text into minor units and back,
 * and says dates and statuses in words.
 */

/** "October 24, 2026" — the month in words, so nobody guesses which number is the day. */
export const longDate = (value) =>
  value ? new Date(value).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" }) : "";

/** "Oct 24, 2026" — for tables. */
export const shortDate = (value) =>
  value ? new Date(value).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" }) : "";

/** "Oct 24, 2026, 3:05 PM" — for history, where the time of day matters. */
export const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString("en-PH", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

/** Today as YYYY-MM-DD in local time — what <input type="date"> speaks. */
export const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A stored date as YYYY-MM-DD for a date input, in local time. */
export const toDateInput = (value) => {
  if (!value) return "";
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A date input's YYYY-MM-DD as a local-noon timestamp, so no timezone can tip it into the day before. */
export const fromDateInput = (text) => (text ? new Date(`${text}T12:00:00`).toISOString() : null);

/**
 * What someone typed as an amount of money ("82,800", "₱1,250.50") in
 * minor units, or null if it isn't one. People type pesos; the API wants
 * centavos.
 */
export function toMinor(text) {
  const clean = String(text ?? "").replace(/[₱$,\s]/g, "").replace(/^PHP/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Minor units back into the text a person would type: 8280000 → "82800", 125050 → "1250.50". */
export const toMajorText = (minor) => (minor == null ? "" : minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100));

export const METHOD_LABEL = {
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  maya: "Maya",
  cash: "Cash",
  card: "Card",
  other: "Other",
};

/** What a buyer can say they paid with. No card: there is no card payment to claim. */
export const CLAIM_METHODS = ["bank_transfer", "gcash", "maya", "cash", "other"];
/** What staff can record. A card at a terminal is real money received. */
export const PAYMENT_METHODS = ["bank_transfer", "gcash", "maya", "cash", "card", "other"];

/** Status colours resolve through the state tokens, and a label always says it too. */
export const TONE_CHANNEL = {
  good: "--c-state-available",
  waiting: "--c-state-reserved",
  warning: "--c-state-reserved",
  bad: "--c-state-unavailable",
  neutral: "--c-ink-muted",
  info: "--c-accent",
};

/**
 * A buyer's "I've paid" still waiting for an answer. Only on an OPEN
 * invoice: once the money is recorded (or the invoice voided) the claim
 * stays on the record but there is nothing left to check.
 */
export const claimWaiting = (invoice) =>
  invoice?.status === "open" && Boolean(invoice.claim?.submittedAt && !invoice.claim?.dismissedAt);

/** An invoice's standing in one label: Paid, Void, Overdue, Checking payment, or due on a day. */
export function invoiceState(invoice) {
  if (invoice.status === "paid") return { label: "Paid", tone: "good" };
  if (invoice.status === "void") return { label: "Void", tone: "neutral" };
  const waiting = claimWaiting(invoice);
  if (invoice.overdue) return { label: waiting ? "Overdue · checking payment" : "Overdue", tone: "bad" };
  if (waiting) return { label: "Checking payment", tone: "waiting" };
  return { label: invoice.dueAt ? `Due ${shortDate(invoice.dueAt)}` : "Open", tone: "info" };
}

/** What an invoice is for, in one phrase: its first line, and how many more there are. */
export function invoiceSummary(invoice) {
  const lines = invoice?.lines || [];
  if (lines.length <= 1) return lines[0]?.description || invoice?.organizationName || "";
  return `${lines[0].description}, and ${lines.length - 1} more`;
}

/** Plan limits said as a count of things: 1 building, 600 bookable units, unlimited members. */
const NOUNS = {
  buildings: ["building", "buildings"],
  floors: ["floor", "floors"],
  rooms: ["room", "rooms"],
  resources: ["bookable unit", "bookable units"],
  members: ["member", "members"],
  staff: ["staff account", "staff accounts"],
};
export function limitPhrase(key, value) {
  const [one, many] = NOUNS[key] || [key, key];
  if (value === null || value === undefined) return `Unlimited ${many}`;
  return `${Number(value).toLocaleString("en-PH")} ${value === 1 ? one : many}`;
}
