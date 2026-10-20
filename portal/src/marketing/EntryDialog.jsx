import { useMemo } from "react";
import { ArrowRight, LogIn, RotateCcw, Sparkles } from "lucide-react";

import { Modal, Button } from "../components/ui.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { PLAN_BY_KEY, formatMoney, priceFor } from "../lib/plans.js";

/**
 * The doorway — journey step 4.
 *
 * Six different CTAs on the storefront ("Build yours", "Build yours in 5
 * minutes", two "Configure this" pricing buttons, "Start building",
 * "Open the configurator") all called the same zero-argument handler and
 * dropped the visitor straight onto step 1 of a seven-step form with no
 * explanation of what it was, how long it takes, or whether it would
 * cost them anything. A stranger's first click landed them inside a
 * tool nobody had introduced.
 *
 * This is not a sign-up wall, and must not become one. CLAUDE.md's rule
 * holds: the account is asked for LAST, because asking first is how you
 * lose people on step one. So "explore" is the primary action, needs
 * nothing, and is what the Enter key does. Signing in is offered beside
 * it for people who want their work to follow them between devices.
 *
 * It also carries the one piece of intent that was previously thrown
 * away at this exact boundary: which plan they clicked. Someone who
 * pressed "Configure this" on One Room used to arrive at step 7 with
 * Whole Building preselected at three times the price.
 */

/** The draft the wizard keeps in localStorage, read defensively. */
function readDraft() {
  try {
    const raw = window.localStorage.getItem("silla-portal-draft");
    if (!raw) return null;
    const draft = JSON.parse(raw);
    const name = draft?.config?.organizationName?.trim();
    return { name: name || null, stepKey: draft?.stepKey || null };
  } catch {
    // Private-mode browsers throw on access. A draft we cannot read is
    // the same as no draft — it must never stop the dialog opening.
    return null;
  }
}

const STEP_ORDER = ["details", "terminology", "branding", "policy", "catalog", "floors", "hardware", "review"];

function Choice({ icon: Icon, title, children, onClick, primary, autoFocus }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-autofocus={autoFocus ? "" : undefined}
      className="group w-full rounded-lg border-2 p-4 text-left transition-all duration-fast ease-out
                 hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5"
      style={{
        borderColor: primary ? "var(--color-accent)" : "rgb(var(--c-line) / 0.12)",
        background: primary ? "rgb(var(--c-accent) / 0.06)" : "transparent",
      }}
    >
      <span className="flex items-center gap-2">
        <Icon size={16} style={primary ? { color: "var(--color-accent)" } : undefined} />
        <span className="font-bold tracking-tight">{title}</span>
        {primary && (
          <ArrowRight
            size={15}
            className="ml-auto transition-transform duration-fast group-hover:translate-x-0.5"
            style={{ color: "var(--color-accent)" }}
          />
        )}
      </span>
      <span className="mt-1.5 block text-[13px] leading-relaxed text-ink-secondary">{children}</span>
    </button>
  );
}

export default function EntryDialog({ open, onClose, planKey, annual = true, onExplore, onStartNew, onSignIn }) {
  const { account, isSignedIn } = useAccount();
  const draft = useMemo(() => (open ? readDraft() : null), [open]);
  const plan = planKey ? PLAN_BY_KEY[planKey] : null;

  // formatMoney takes MINOR units, which is what priceFor returns and
  // what the order stores. Reading plan.annual directly here would be
  // major units and render "$3900/month" on a $39 plan.
  const price = plan ? formatMoney(priceFor(plan.key, annual), { period: "month" }) : null;
  const billing = plan && priceFor(plan.key, annual) != null ? (annual ? "billed yearly" : "billed monthly") : null;

  const stepNumber = draft?.stepKey ? STEP_ORDER.indexOf(draft.stepKey) + 1 : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={Sparkles}
      title="Before you start"
      subtitle="Eight short steps — name it, choose your words, pick your colours, lay out your floors, then the hardware and support you want, priced as you go. About five minutes, and nothing is charged."
      width="max-w-xl"
    >
      {plan && (
        <div
          className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md px-3 py-2 text-sm"
          style={{ background: "rgb(var(--c-accent) / 0.08)" }}
        >
          <span className="font-bold">{plan.name}</span>
          <span className="text-ink-secondary">
            {price}
            {billing ? `, ${billing}` : ""}
          </span>
          <span className="ml-auto text-xs text-ink-muted">You can change it when you choose your hardware.</span>
        </div>
      )}

      {/* The Campus card's button reads "Get in touch" and opens this,
          which was simply untrue while nothing explained it. It is true
          now, because configuring IS how you reach us: the order lands
          in the queue and a person answers it. Saying so is the
          difference between a misleading button and a routed one. */}
      {plan && priceFor(plan.key, annual) == null && (
        <p className="mb-4 text-sm leading-relaxed text-ink-secondary">
          Campus deployments are quoted individually, so there is no price to show yet. Configure
          what you actually need — floors, rooms, how many people — and we will price it with you
          from that. It is the fastest way to get a real number, and it is how you reach us.
        </p>
      )}

      {/* Offered first when it exists: someone with unfinished work
          almost never wants to start again, and losing it silently is
          the worst outcome this dialog can produce. */}
      {draft && (
        <div className="mb-4 rounded-lg border border-line/[0.12] p-4">
          <p className="text-sm">
            <span className="font-bold">You have a saved draft</span>
            {draft.name ? (
              <>
                {" — "}
                <span className="font-semibold">{draft.name}</span>
              </>
            ) : null}
            {stepNumber > 0 ? `, step ${stepNumber} of ${STEP_ORDER.length}` : null}.
          </p>
          <Button variant="primary" className="mt-3" icon={RotateCcw} onClick={onExplore} data-autofocus>
            Pick up where you left off
          </Button>
        </div>
      )}

      {/* Signed in, there is nothing to choose between: "No account
          needed" and "Sign in first" were offered to people who already
          had one. "Start a new one" used to call the same handler as
          "Pick up where you left off", so it opened the old draft; it
          replaces it now, and says so. */}
      <div className={isSignedIn ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        <Choice
          icon={Sparkles}
          title={draft ? "Start a new one" : isSignedIn ? "Start configuring" : "Just explore"}
          primary
          autoFocus={!draft}
          onClick={draft ? onStartNew || onExplore : onExplore}
        >
          {draft && "Replaces the draft above. "}
          {isSignedIn
            ? `You're signed in${account?.firstName ? ` as ${account.firstName}` : ""}. Your work is kept in this browser as you go, and one click at the end saves it to your account.`
            : "No account needed. Your work stays in this browser, and you can save it to an account whenever you like — including at the very end."}
        </Choice>

        {!isSignedIn && (
          <Choice icon={LogIn} title="Sign in first" onClick={onSignIn}>
            Your name and email are filled in for you, and at the end your configuration saves to
            your account in one click — to pick up on any device.
          </Choice>
        )}
      </div>

      <p className="mt-4 text-xs leading-relaxed text-ink-muted">
        {isSignedIn ? "You end up with" : "Either way you end up with the same thing:"} a complete
        description of your system that we build for you. Nothing is final until you place an order.
      </p>
    </Modal>
  );
}
