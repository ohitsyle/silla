import { plural } from "./rooms.js";

/**
 * A plan, in plain words (docs/control-plane.md §2).
 *
 * The plan page, the banners in the shell and the upgrade prompts all
 * describe the same snapshot; they say it the same way because they say
 * it from here. Nothing in this file decides what is allowed — the server
 * does (services/entitlements.js), and OrgContext.entitlementsOf mirrors
 * it — this only turns the reading into sentences.
 */

/** "14 November 2026". */
export function formatDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Each subscription state as a person would say it. `tone` is a state
 * token for the badge; the words carry the meaning on their own.
 */
export const STATUS = {
  trialing: { label: "Free trial", tone: "available" },
  active: { label: "Active", tone: "available" },
  past_due: { label: "Payment overdue", tone: "reserved" },
  suspended: { label: "Paused", tone: "unavailable" },
  cancelled: { label: "Ended", tone: "occupied" },
};

export const statusOf = (entitlements) => STATUS[entitlements?.status] || STATUS.active;

/**
 * The one sentence under the plan's name: where the subscription stands
 * and the date that matters next.
 */
export function standing(entitlements, orgName = "This organization") {
  const end = formatDay(entitlements?.currentPeriodEnd);
  const grace = formatDay(entitlements?.graceEndsAt);
  switch (entitlements?.status) {
    case "trialing":
      return end ? `Your free trial runs until ${end}.` : "You're on a free trial.";
    case "past_due": {
      const ended = end && new Date(entitlements.currentPeriodEnd) <= new Date();
      const overdue = `Payment${ended ? ` for the period that ended ${end}` : ""} is overdue.`;
      return grace
        ? `${overdue} Everything keeps working until ${grace}; after that, ${orgName} pauses until it's paid.`
        : `${overdue} Everything keeps working for now; ${orgName} pauses if it stays unpaid.`;
    }
    case "suspended":
      return `${orgName} is paused. Everyone can still sign in and look, but nothing can be booked or changed until the subscription is sorted out.`;
    case "cancelled":
      return "Your subscription has ended. Everything is kept and can still be read, but nothing can change.";
    default:
      return end ? `Paid through ${end}.` : "Your subscription is active.";
  }
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What each limit counts, in this organization's own words: "Bookable
 * desks", "Employees". The server's labels are generic ("Bookable
 * units", "Members") because it serves every vertical; the plan page is
 * read inside one.
 */
export function limitLabel(key, org, fallback) {
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const memberNoun = org?.terminology?.memberNoun || "member";
  return (
    {
      buildings: "Buildings",
      floors: "Floors",
      rooms: "Rooms",
      resources: `Bookable ${plural(resourceNoun)}`,
      members: capitalise(plural(memberNoun)),
      staff: "Staff and administrator accounts",
    }[key] || fallback || key
  );
}

/**
 * Where a count stands against its limit. `max` null means no limit.
 * Over the limit happens after a downgrade: nothing was taken away, but
 * nothing new can be added until it is back under.
 */
export function usageState(used, max) {
  if (max === null || max === undefined) return "unlimited";
  if (used > max) return "over";
  if (used >= max) return "full";
  return used / Math.max(max, 1) >= 0.8 ? "near" : "room";
}
