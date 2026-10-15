import { Link, useLocation } from "react-router-dom";
import { ArrowRight, CirclePause, CircleSlash, Clock } from "lucide-react";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { formatDay } from "../lib/plan.js";

/**
 * The one line at the top of every screen in the shell that says the
 * organization is not in good standing (docs/control-plane.md §2).
 *
 *   past_due   staff and superadmins only: everything still works, and
 *              members have nothing to do about an invoice
 *   suspended  everyone: the organization is read-only — anyone can look,
 *              nothing can be booked or changed
 *   cancelled  everyone, the same, for good
 *
 * Said calmly and plainly. A member opening the map should learn that
 * booking is paused, not that someone failed to pay; the people who can
 * act on it get the detail and a way to the plan page.
 */
export default function OrgStatusBanner() {
  const { org, entitlements } = useOrg();
  const { user } = useAuth();
  const { pathname } = useLocation();
  // The plan page says all of this, at more length, directly below.
  if (!entitlements?.managed || pathname === "/admin/plan") return null;

  const admin = user?.role === "staff" || user?.role === "superadmin";
  const name = org?.name || "This organization";
  const grace = formatDay(entitlements.graceEndsAt);

  let banner = null;
  switch (entitlements.status) {
    case "past_due":
      if (!admin) return null;
      banner = {
        Icon: Clock,
        tone: "reserved",
        lead: "Payment is overdue.",
        rest: grace
          ? `Everything keeps working until ${grace}; after that, ${name} pauses until it's paid.`
          : `Everything keeps working for now; ${name} pauses if it stays unpaid.`,
      };
      break;
    case "suspended":
      banner = {
        Icon: CirclePause,
        lead: `${name} is paused.`,
        rest: admin
          ? "Everyone can still sign in and look, but nothing can be booked or changed until the subscription is sorted out."
          : "You can still look around, but booking and check-in are on hold for now.",
      };
      break;
    case "cancelled":
      banner = {
        Icon: CircleSlash,
        lead: admin ? "Your subscription has ended." : `${name} is no longer taking bookings.`,
        rest: admin ? "Everything is kept and can still be read, but nothing can change." : "You can still look around.",
      };
      break;
    default:
      return null;
  }

  const { Icon, tone, lead, rest } = banner;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line/10 px-4 py-2.5 text-sm lg:px-6"
      style={{ background: tone ? `rgb(var(--c-state-${tone}) / 0.09)` : "rgb(var(--c-bg-panel))" }}
    >
      {/* A basis wide enough that on a phone the link wraps under the
          sentence instead of squeezing it into a column of five lines. */}
      <span className="flex min-w-0 grow basis-[20rem] items-start gap-2.5">
        <Icon
          size={16}
          className="mt-0.5 shrink-0"
          style={{ color: tone ? `var(--color-state-${tone})` : "var(--color-ink-secondary)" }}
        />
        <span className="min-w-0">
          <span className="font-medium text-ink-primary">{lead}</span>{" "}
          <span className="text-ink-secondary">{rest}</span>
        </span>
      </span>
      {admin && (
        <Link
          to="/admin/plan"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink-secondary
                     transition-colors duration-fast hover:text-ink-primary"
        >
          Plan &amp; usage
          <ArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}
