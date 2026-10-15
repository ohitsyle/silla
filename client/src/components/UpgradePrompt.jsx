import { Link } from "react-router-dom";
import { ArrowRight, Sparkles } from "lucide-react";
import { Card } from "./ui/index.jsx";

/**
 * What a screen shows INSTEAD of a control the plan does not allow
 * (docs/control-plane.md §2) — a Create button at the staff limit, the
 * reports page without reports, colour pickers without custom branding.
 *
 * The server refuses all of these regardless (PLAN_LIMIT, PLAN_FEATURE);
 * the point of this is that nobody fills in a form, presses the button
 * and only THEN learns it could never work. It says what is not included,
 * what can be done about it, and links to the plan page that has the
 * rest. Informative rather than alarming: nothing is wrong, the plan is
 * just smaller than this.
 *
 * Only for staff and superadmins. Members never see an upgrade prompt —
 * they cannot change the plan, and a sales pitch is no answer to "why
 * can't I book this?".
 */
export default function UpgradePrompt({ icon: Icon = Sparkles, title, children, action, className }) {
  return (
    <Card className={className}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
          style={{ background: "rgb(var(--c-accent) / 0.14)", color: "var(--color-accent)" }}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">{title}</h2>
          <div className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-secondary">{children}</div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {action}
            <Link
              to="/admin/plan"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary
                         transition-colors duration-fast hover:text-ink-primary"
            >
              See plan &amp; usage
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}
