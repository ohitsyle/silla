import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft, ArrowRight, CircleCheck, Eye, EyeOff, Pencil, RotateCcw, Send, UserPlus,
} from "lucide-react";

import { Button, Modal, Notice, Stepper, panelEnter } from "./components/ui.jsx";
import Preview from "./components/Preview.jsx";
import QuoteSummary from "./components/QuoteSummary.jsx";
import { DEFAULT_CONFIG, buildProfile, validate } from "./lib/profile.js";
import { formatMoney, usePlans } from "./lib/plans.js";
import { DEFAULT_EXTRAS, count, extrasErrors, quoteFor, selectionsFrom, suggestPlan, withExtrasDefaults } from "./lib/extras.js";
import { vendorApi } from "./lib/vendorApi.js";
import { useAccount } from "./lib/AccountContext.jsx";
import { ROUTES } from "./lib/useHashRoute.js";
import { savePending, takePending } from "./lib/pendingConfiguration.js";
import { peekIntent, takeIntent } from "./lib/entryIntent.js";

import DetailsStep from "./steps/DetailsStep.jsx";
import TerminologyStep from "./steps/TerminologyStep.jsx";
import BrandingStep from "./steps/BrandingStep.jsx";
import PolicyStep from "./steps/PolicyStep.jsx";
import CatalogStep from "./steps/CatalogStep.jsx";
import FloorsStep from "./steps/FloorsStep.jsx";
import HardwareStep from "./steps/HardwareStep.jsx";
import ReviewStep from "./steps/ReviewStep.jsx";

/**
 * The SILLA portal — the vendor's sales and onboarding surface.
 *
 * A buyer configures the system they are purchasing here, and the portal
 * emits a provisioning profile: the same JSON shape
 * server/src/scripts/profiles.js already defines and seed.js already
 * consumes. Nothing is provisioned from the browser; the profile is the
 * artefact, and SILLA runs the seeder with it.
 *
 * This is a separate app from client/ on purpose. The buyer's deployment
 * must never ship the vendor's order system, so the portal shares the
 * design language with the product and none of its code.
 *
 * The shell owns three things and delegates everything else: the config
 * state, which step is showing, and the draft in localStorage. Each step
 * is a dumb form over `config` — see the props contract on STEPS below.
 */

/**
 * Step order, and which part of the config each step is answerable for.
 *
 * `fields` is what turns a flat validate() result into per-step gating:
 * Continue is disabled only by errors in the fields THIS step owns, so a
 * buyer is never blocked on page two by something they have not reached
 * yet. Review owns nothing and therefore sees everything left over.
 *
 * These name keys of the WIZARD config, not of the emitted profile. The
 * profile's `key` and `label` are absent because buildProfile derives
 * both from organizationName — there is no field for a step to own.
 */
const STEPS = [
  {
    key: "details",
    label: "Details",
    title: "Your system",
    blurb: "SILLA builds it; you name it. This is the name your people will see.",
    Component: DetailsStep,
    fields: ["preset", "organizationName", "siteName", "owner"],
  },
  {
    key: "terminology",
    label: "Words",
    title: "What you call things",
    blurb: "Every noun in the product comes from here. Nothing says “seat” unless you do.",
    Component: TerminologyStep,
    fields: ["terminology"],
  },
  {
    key: "branding",
    label: "Branding",
    title: "Your colours",
    blurb: "Colours are tokens, not literals, so these repaint the whole product — not just the accent.",
    Component: BrandingStep,
    fields: ["branding", "colorScheme"],
  },
  {
    key: "policy",
    label: "Policy",
    title: "How it behaves",
    blurb: "How long a reservation holds, when you are open, and how a member identifies themselves.",
    Component: PolicyStep,
    fields: ["policy", "identity"],
  },
  {
    key: "catalog",
    label: "Catalog",
    title: "What can be placed",
    blurb: "The pieces your floors are built from. Footprint and unit count are what the map draws.",
    Component: CatalogStep,
    fields: ["catalog"],
  },
  {
    key: "floors",
    label: "Floors",
    title: "Your spaces",
    blurb: "A grid per floor, with zones, labels and the pieces placed on it.",
    Component: FloorsStep,
    fields: ["floors", "demoLayout"],
  },
  {
    key: "hardware",
    label: "Hardware",
    title: "Hardware & support",
    blurb: "How many buildings, the kiosks and cards you want from us, help setting up, and support. Priced as you go.",
    Component: HardwareStep,
    // The answers live beside the config, not in it; their problems are
    // the live quote's, keyed "extras.<field>" (lib/extras.js).
    fields: ["extras"],
  },
  {
    key: "review",
    label: "Review",
    title: "Your system and your quote",
    blurb: "Everything you configured, what it costs, and the file SILLA's seeder builds it from.",
    Component: ReviewStep,
    fields: null,
  },
];

const DRAFT_KEY = "silla-portal-draft";

/**
 * validate() reports one message per offending field, keyed by its dotted
 * path ("branding.primaryColor"). Normalised here so the ownership filter
 * below has a single shape to match against.
 */
function toErrorMap(result) {
  if (Array.isArray(result)) {
    return Object.fromEntries(result.filter(Boolean).map((e) => [e.field || e.path, e.message]));
  }
  return result || {};
}

/** True when `path` names `field` itself or something inside it. */
const owns = (field, path) =>
  path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`);

/**
 * Layers a saved draft over the defaults so a draft written before a
 * field existed still opens, instead of handing a step an undefined it
 * will read straight into an input.
 *
 * One level deep, because the groups a step spreads (branding, policy,
 * terminology, identity) are where new fields actually get added; a
 * top-level spread alone would let an old `branding` replace the whole
 * default group and take the new key with it. Arrays are replaced, never
 * merged — a buyer who deleted a floor must not get it back.
 */
function withDefaults(saved) {
  const merged = { ...DEFAULT_CONFIG, ...saved };
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) continue;
    const value = merged[key];
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...fallback, ...value }
      : fallback;
  }
  return merged;
}

function readDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    return {
      stepKey: draft.stepKey,
      config: withDefaults(draft.config),
      extras: withExtrasDefaults(draft.extras),
      plan: typeof draft.plan === "string" ? draft.plan : null,
      annual: typeof draft.annual === "boolean" ? draft.annual : null,
    };
  } catch {
    // Private-mode browsers throw on localStorage access, and a truncated
    // draft is not worth refusing to start over.
    return null;
  }
}

export default function Wizard({ onExit, navigate }) {
  const { isSignedIn } = useAccount();
  const [restored] = useState(readDraft);
  const [config, setConfig] = useState(() => restored?.config || DEFAULT_CONFIG);
  const [stepIndex, setStepIndex] = useState(() => {
    // Resume by step KEY, not index: reordering the wizard later must not
    // drop a returning buyer onto a different screen than they left.
    const index = STEPS.findIndex((step) => step.key === restored?.stepKey);
    return index < 0 ? 0 : index;
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  /**
   * Which way the last move went, so a step arrives from the side it
   * came from. Forward and back looked identical before — the same
   * upward fade for both — which is the one thing the transition is
   * actually there to tell you.
   */
  const [direction, setDirection] = useState(1);
  /**
   * Which steps have had their errors revealed.
   *
   * The wizard used to render "Enter the organization's name" in red the
   * instant it opened, before anyone had typed a character — scolding a
   * buyer for not yet having done the thing they arrived to do. A step's
   * errors now appear only once its Continue has been pressed, and
   * Continue stays live rather than disabled: a dead button with no
   * explanation is a worse dead end than an error message.
   */
  const [revealed, setRevealed] = useState({});
  const [downloaded, setDownloaded] = useState(false);
  /**
   * The plan, seeded from whatever the buyer clicked on their way in.
   *
   * These were `useState("building")` and `useState(true)`, so a buyer
   * who pressed "Configure this" on the One Room card arrived at step 7
   * with Whole Building preselected at three times the price. The two
   * surfaces agreed only by the coincidence of two independent
   * useState(true) calls, and `quotedAmount` is frozen onto the order as
   * the record of what this customer was offered.
   *
   * Read once, in the initialiser, and cleared by takeIntent — a plan
   * chosen on the way in must not still be overriding a later, different
   * configuration.
   */
  // peek, not take. takeIntent CLEARS the stored intent, and a state
  // initialiser runs during render — React 18's StrictMode deliberately
  // double-invokes it to surface exactly this class of bug. The first
  // call consumed the intent and the second returned null, so the plan
  // the buyer clicked was silently discarded and the wizard fell back to
  // Whole Building at three times the price. Reading is pure; the
  // clearing is a side effect and belongs in an effect.
  const [entryIntent] = useState(peekIntent);
  // A plan clicked on the way in wins over a draft's; a draft's over the default.
  const [plan, setPlan] = useState(() => entryIntent?.plan || restored?.plan || "building");
  const [annual, setAnnual] = useState(() =>
    entryIntent ? entryIntent.annual !== false : restored?.annual ?? true
  );
  /** The Hardware & support answers (lib/extras.js) — kept beside the config, never in the profile. */
  const [extras, setExtras] = useState(() => restored?.extras || DEFAULT_EXTRAS);

  // Cleared once, after mount, so a plan chosen on the way in cannot
  // still be overriding an unrelated configuration later.
  useEffect(() => {
    takeIntent();
  }, []);

  /**
   * The plans on sale right now — the live catalogue staff edit in the
   * console, or lib/plans.js's fallback until it answers. The quote is
   * read from the SAME list the cards below show, so what a buyer saw is
   * what their order records.
   */
  const store = usePlans();
  const { plans: catalogue, catalogue: items, trialDays, vat } = store;
  const chosenPlan = catalogue.find((p) => p.key === plan) || null;
  // A plan that is no longer sold (retired since a draft was saved, say)
  // can't be ordered; fall back to the one most people take.
  useEffect(() => {
    if (!chosenPlan && catalogue.length) setPlan((catalogue.find((p) => p.featured) || catalogue[0]).key);
  }, [chosenPlan, catalogue]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const reduceMotion = useReducedMotion();

  /**
   * Shallow by design: a nested group (branding, policy) is replaced
   * whole, so a step spreads what it means to keep. The function form is
   * for edits derived from the current value — appending a floor, say —
   * where a stale closure would otherwise drop a concurrent change.
   */
  const update = useCallback((patch) => {
    setConfig((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ stepKey: STEPS[stepIndex].key, config, extras, plan, annual })
      );
    } catch {
      // Nothing to recover here: an unsaved draft costs the buyer a
      // re-entry, while a thrown quota error would cost them the page.
    }
  }, [config, stepIndex, extras, plan, annual]);

  // A downloaded file stops being the current answer the moment the
  // config moves on, so the confirmation must not outlive the edit.
  useEffect(() => setDownloaded(false), [config]);

  /**
   * Coming back from sign-up: restore what they had configured and put
   * them on the last step, so the account round trip costs them nothing.
   * Cleared immediately — a pending draft that outlived one trip would
   * reappear over a later, different configuration.
   */
  useEffect(() => {
    if (!isSignedIn) return;
    const pending = takePending();
    if (!pending?.config) return;
    setConfig(pending.config);
    setPlan(pending.plan || "building");
    setAnnual(pending.annual !== false);
    if (pending.extras) setExtras(withExtrasDefaults(pending.extras));
    setStepIndex(STEPS.length - 1);
  }, [isSignedIn]);

  /**
   * The live quote: lib/quote.js on the answers, against the catalogue as
   * this page has it. The server prices the order again from its own
   * catalogue — this is what the buyer watches add up, not what they pay.
   */
  const profile = useMemo(() => buildProfile(config), [config]);
  const layout = useMemo(() => {
    const seats = new Map(profile.catalog.map((type) => [type.key, type.seatCount || 0]));
    const units = profile.floors.reduce((sum, f) => sum + f.resources.reduce((n, piece) => n + (seats.get(piece.type) || 0), 0), 0);
    return { floors: profile.floors.length, units };
  }, [profile]);
  const priced = useMemo(
    () => (chosenPlan ? quoteFor(extras, { plan: chosenPlan, plans: catalogue, catalogue: items, annual, vat }) : null),
    [extras, chosenPlan, catalogue, items, annual, vat]
  );
  const suggestion = useMemo(
    () => suggestPlan({ plans: catalogue, catalogue: items, buildings: count(extras.buildings) || 1, ...layout, annual }),
    [catalogue, items, extras.buildings, layout, annual]
  );

  const errors = useMemo(
    () => ({ ...toErrorMap(validate(config)), ...extrasErrors(priced?.problems, items) }),
    [config, priced, items]
  );

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const stepErrors = useMemo(() => {
    if (!step.fields) return errors;
    return Object.fromEntries(
      Object.entries(errors).filter(([path]) => step.fields.some((field) => owns(field, path)))
    );
  }, [errors, step]);

  const blocking = Object.entries(errors);
  const blocked = Object.keys(stepErrors).length > 0;
  const showErrors = Boolean(revealed[step.key]);
  const visibleErrors = showErrors ? stepErrors : {};

  const goTo = useCallback(
    (index) => {
      // Set in the same render as the index, so the outgoing step is
      // still holding the old direction when AnimatePresence captures
      // it — which is what makes an exit leave the way it came in.
      setDirection(index > stepIndex ? 1 : -1);
      setStepIndex(index);
      setPreviewOpen(false);
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    },
    [reduceMotion, stepIndex]
  );

  /**
   * Continue: advance, or reveal what is stopping you.
   *
   * Never disabled. A greyed-out Continue tells a buyer they are stuck
   * without telling them why, and on a long step the reason may be
   * scrolled off screen — so pressing it surfaces the errors and scrolls
   * to the first one instead of doing nothing.
   */
  const attempt = useCallback(() => {
    if (blocked) {
      setRevealed((prev) => ({ ...prev, [step.key]: true }));
      window.requestAnimationFrame(() => {
        document.querySelector("[data-field-error]")?.scrollIntoView({
          block: "center",
          behavior: reduceMotion ? "auto" : "smooth",
        });
      });
      return;
    }
    goTo(stepIndex + 1);
  }, [blocked, step.key, goTo, stepIndex, reduceMotion]);

  /**
   * Destructive with no undo, so it asks first — in a real dialog.
   *
   * This was a window.confirm(), which is the one piece of UI we cannot
   * style, cannot animate, and which renders as an OS alert bearing the
   * browser's name rather than ours. On a page this deliberately
   * designed it read as the site breaking.
   */
  function startOver() {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Clearing the in-memory config is the part that matters; a draft
      // we cannot remove will simply be overwritten by the next edit.
    }
    setConfig(DEFAULT_CONFIG);
    setExtras(DEFAULT_EXTRAS);
    setRevealed({});
    setDownloaded(false);
    setConfirmReset(false);
    goTo(0);
  }

  /**
   * Save the configuration against the buyer's account.
   *
   * This is the answer to "I configured it, now what?" — the wizard used
   * to end at a file in someone's Downloads folder, which is not a
   * record either side can act on. Signed out, we send them to sign up
   * and bring them straight back: asking for an account BEFORE they
   * have anything worth saving is how you lose people on step one.
   */
  async function saveToAccount() {
    if (!isSignedIn) {
      savePending({ config, plan, annual, extras });
      navigate?.(ROUTES.signUp);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      // What was chosen, never what it costs: keys, quantities and buy or
      // rent. The server prices the order from its catalogue and refuses,
      // by field, anything that can't be ordered.
      const order = await vendorApi.createOrder({
        profile: buildProfile(config),
        plan,
        billingPeriod: annual ? "yearly" : "monthly",
        selections: selectionsFrom(extras, { plan: chosenPlan, catalogue: items }),
      });
      navigate?.(`${ROUTES.orders}/${order.order.id}`);
    } catch (e) {
      setSaveError(Object.values(e.fields || {})[0] || e.message);
    } finally {
      setSaving(false);
    }
  }

  function download() {
    const profile = buildProfile(config);
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // buildProfile always slugs a key (falling back to "deployment"), so
    // the filename never needs a second slug implementation here.
    anchor.download = `${profile.key}-profile.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking in the same tick cancels the save in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setDownloaded(true);
  }

  /**
   * Steps slide the way you are travelling. The custom parameter is the
   * direction, handed to AnimatePresence as well as to the child, so the
   * step on its way out can still read the direction it was pushed in.
   */
  const stepVariants = reduceMotion
    ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        enter: (dir) => ({ opacity: 0, x: dir * 32 }),
        center: { opacity: 1, x: 0 },
        exit: (dir) => ({ opacity: 0, x: dir * -32 }),
      };

  const StepForm = step.Component;
  const StepHeading = stepIndex === 0 ? "h2" : "h1";

  return (
    <div className="relative min-h-screen text-ink-primary">
      {/* Two soft washes, fixed so they sit still while the form scrolls
          over them. The configurator was a flat sheet of cream — correct
          colour, no depth — and the storefront it opens from is full of
          light. Decorative only: aria-hidden, and no pointer target. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(58rem 38rem at 12% -12%, rgb(var(--c-accent) / 0.13), transparent 62%), " +
            "radial-gradient(46rem 32rem at 104% 4%, rgb(var(--c-state-available) / 0.08), transparent 64%)",
        }}
      />

      {/* The same bar as the storefront, so arriving here reads as
          walking further into one site rather than landing on another. */}
      <header
        className="sticky top-0 z-40 border-b border-line/[0.07]"
        style={{ background: "rgb(var(--c-bg-page) / 0.85)", backdropFilter: "saturate(180%) blur(12px)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-[72px] flex items-center gap-4">
          <button
            type="button"
            onClick={onExit}
            className="flex items-center gap-2.5 font-extrabold text-xl tracking-tight hover:opacity-70
                       transition-opacity duration-fast"
          >
            <span
              className="w-8 h-8 rounded-[10px] grid place-items-center text-sm"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              S
            </span>
            SILLA
          </button>

          {/* A way back to the storefront. Without it the wizard is a
              one-way door: someone who arrived from a pricing card and
              wanted to re-read the plans had only the browser's back
              button, which does not read as part of the product. */}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="ml-auto hidden sm:inline-flex items-center gap-1.5 text-sm font-medium
                         text-ink-secondary hover:text-ink-primary transition-colors duration-fast"
            >
              <ArrowLeft size={15} />
              Back to the site
            </button>
          )}

          <Button
            variant="ghost"
            size="sm"
            icon={RotateCcw}
            onClick={() => setConfirmReset(true)}
            className="ml-auto sm:ml-0"
          >
            Start over
          </Button>
        </div>
      </header>

      {/* The welcome runs once, on arrival. Kept for all seven steps it
          stops being a welcome and becomes 200px of furniture between
          you and the form. From step two on, the title moves down beside
          the form as a chapter head — one heading, in the column your
          eye is already in, instead of a centred one repeated in 14px
          inside the card. */}
      <AnimatePresence initial={false}>
        {stepIndex === 0 && (
          <motion.div
            key="wizard-welcome"
            initial={false}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -16, height: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 overflow-hidden"
          >
            <div className="max-w-6xl mx-auto px-6 pt-10 sm:pt-14 pb-2 text-center">
              <h1 className="display text-[clamp(2rem,5vw,3.25rem)]">Let's build yours.</h1>
              <p className="mt-4 mx-auto max-w-xl text-base text-ink-secondary leading-relaxed">
                Eight short steps. Name it, colour it, choose your words, lay out your floors and pick
                the hardware you want — with the price added up beside you as you go. Nothing is locked
                in; you can change any of it later.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative z-10 max-w-6xl mx-auto px-6 pt-8 pb-16">
        <Stepper
          steps={STEPS.map(({ key, label }) => ({ key, label }))}
          current={stepIndex}
          onJump={goTo}
        />

        <div className="mt-6 grid gap-6 items-start lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* top-[88px], not top-6: the site header is sticky and 72px
              tall, so a 24px offset parked the preview underneath it. */}
          {/* On the Hardware step the quote takes the preview's place: it is
              the thing that changes as the buyer answers. Below lg it comes
              after the form, so the questions stay first on a phone. */}
          {step.key === "hardware" && priced && (
            <aside className="hidden lg:block lg:order-2 min-w-0 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-104px)] lg:overflow-y-auto lg:pb-2">
              <div className="hidden lg:flex items-center gap-2 mb-2 px-1">
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "var(--color-accent)" }} />
                  <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "var(--color-accent)" }} />
                </span>
                <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">Live quote</span>
              </div>
              <QuoteSummary
                quote={priced.quote}
                onSwitchYearly={() => setAnnual(true)}
                footer="Priced from today's catalogue. Your order is priced again when you submit it, and the first invoice is issued from that."
              />
            </aside>
          )}

          <aside className={`order-1 lg:order-2 min-w-0 lg:sticky lg:top-[88px] ${step.key === "hardware" ? "hidden" : ""}`}>
            <Button
              className="lg:hidden w-full mb-3"
              icon={previewOpen ? EyeOff : Eye}
              onClick={() => setPreviewOpen((open) => !open)}
              aria-expanded={previewOpen}
            >
              {previewOpen ? "Hide preview" : "Show preview"}
            </Button>

            {/* Labelled, because it is not obvious that the dark panel
                is the thing being bought rather than an illustration —
                and the pulse says it is tracking what you type. */}
            <div className="hidden lg:flex items-center gap-2 mb-2 px-1">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                  style={{ background: "var(--color-accent)" }}
                />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full"
                  style={{ background: "var(--color-accent)" }}
                />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                Live preview
              </span>
            </div>

            <div className={previewOpen ? "block" : "hidden lg:block"}>
              <Preview config={config} />
              <p className="mt-2 hidden lg:block px-1 text-xs leading-relaxed text-ink-muted">
                Your system, drawn from the answers so far. Every colour, word and floor below is
                the real thing — not a mock-up of one.
              </p>
            </div>
          </aside>

          <div className="order-2 lg:order-1 min-w-0">
            <AnimatePresence mode="wait" initial={false} custom={direction}>
              <motion.div
                key={step.key}
                custom={direction}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              >
                {/* The chapter head. The step number is set large and
                    faint as a piece of furniture rather than a label —
                    it marks where you are without competing with the
                    title, which is the thing worth reading. */}
                <div className="mb-5 flex items-start gap-4">
                  <span
                    aria-hidden
                    className="display hidden sm:block shrink-0 text-[3.25rem] leading-[0.8] tabular-nums"
                    style={{ color: "rgb(var(--c-accent) / 0.22)" }}
                  >
                    {String(stepIndex + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                      Step {stepIndex + 1} of {STEPS.length} · {step.label}
                    </p>
                    {/* h1 from step two on. The welcome above owns the
                        h1 on arrival and then unmounts, which would
                        otherwise leave every later step as a document
                        with no top-level heading at all. */}
                    <StepHeading className="display mt-1 text-[clamp(1.5rem,3vw,2.1rem)]">
                      {step.title}
                    </StepHeading>
                    <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">{step.blurb}</p>
                  </div>
                </div>

                {/* onDownload is the Review step's; every other step
                    ignores it. Without it that step rendered no download
                    button at all, and the "that's your system" panel
                    below — which waits on `downloaded` — could never
                    appear. */}
                <StepForm
                  config={config}
                  update={update}
                  errors={visibleErrors}
                  onDownload={download}
                  pricing={{
                    extras,
                    setExtras,
                    plan,
                    setPlan,
                    annual,
                    setAnnual,
                    plans: catalogue,
                    catalogue: items,
                    layout,
                    suggestion,
                  }}
                  quote={
                    isLast && priced ? (
                      <QuoteSummary
                        quote={priced.quote}
                        problems={priced.problems}
                        title={`Your quote — ${chosenPlan?.name || "plan"}`}
                        onSwitchYearly={() => setAnnual(true)}
                        action={
                          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => goTo(STEPS.findIndex((s) => s.key === "hardware"))}>
                            Change
                          </Button>
                        }
                        footer={`Nothing is charged now. Submitting your order sends the first invoice${
                          trialDays > 0 ? `, and the ${trialDays}-day free trial starts when your system goes live` : ""
                        }.`}
                      />
                    ) : null
                  }
                />
              </motion.div>
            </AnimatePresence>

            {isLast && blocking.length > 0 && (
              <Notice tone="error" className="mt-4">
                <span className="font-medium">Not ready to provision.</span>
                <ul className="mt-1.5 space-y-1">
                  {blocking.map(([path, message]) => {
                    const home = STEPS.find((s) => s.fields?.some((field) => owns(field, path)));
                    return (
                      <li key={path}>
                        {message}
                        {home && <span className="text-ink-muted"> — {home.title}</span>}
                      </li>
                    );
                  })}
                </ul>
              </Notice>
            )}

            {/*
              The end of the process, not just the end of the form.
              "Profile downloaded" told a buyer the browser had saved a
              file and nothing about what they were supposed to do with
              it — so the last thing the configurator did was leave them
              holding an artefact with no next move.
            */}
            {isLast && downloaded && blocking.length === 0 && (
              <motion.div
                {...panelEnter()}
                className="mt-6 rounded-xl border-2 p-6"
                style={{
                  borderColor: "rgb(var(--c-state-available) / 0.35)",
                  background: "rgb(var(--c-state-available) / 0.06)",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <CircleCheck size={20} style={{ color: "rgb(var(--c-state-available))" }} />
                  <h3 className="text-xl font-extrabold tracking-tight">That's your system.</h3>
                </div>
                <p className="mt-2 text-ink-secondary">
                  The file is in your downloads. Here's what happens next.
                </p>

                <ol className="mt-5 space-y-4">
                  {[
                    ["Send us the file.", "Email it to hello@silla.app and say when you'd like to go live."],
                    ["We provision it.", "Your deployment is built from exactly what you configured — same names, same colours, same floors. Usually same day."],
                    ["You get your keys.", "A link, a superadmin login, and the card format for your readers. Everything after that is yours to change."],
                  ].map(([title, body], i) => (
                    <li key={title} className="flex gap-3.5">
                      <span
                        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[10px] text-xs font-bold"
                        style={{
                          background: "rgb(var(--c-state-available))",
                          color: "rgb(var(--c-bg-card))",
                        }}
                      >
                        {i + 1}
                      </span>
                      <span>
                        <span className="font-bold">{title}</span>{" "}
                        <span className="text-ink-secondary">{body}</span>
                      </span>
                    </li>
                  ))}
                </ol>

                <p className="mt-5 text-sm text-ink-muted">
                  Changed your mind about something? Step back, edit it, and download again — the file
                  you send is the one that gets built.
                </p>
              </motion.div>
            )}

            {/* Below lg the quote follows the questions, above the floating
                bar's resting place, so it is read before Continue. */}
            {step.key === "hardware" && priced && (
              <QuoteSummary
                className="mt-4 lg:hidden"
                quote={priced.quote}
                onSwitchYearly={() => setAnnual(true)}
                footer="Priced from today's catalogue. Your order is priced again when you submit it."
              />
            )}

            {/* The plan is chosen with the hardware now (step 7), where the
                buildings that decide it are asked; Review shows the quote
                that results, with a way back to change it. */}
            {isLast && saveError && (
              <Notice tone="error" className="mt-4">
                {saveError}
              </Notice>
            )}

            {/*
              Floats at the bottom of the viewport rather than sitting at
              the end of the page. Catalog and Floors are long enough to
              scroll several screens, and Continue used to be wherever
              the form happened to end — so the way forward was off-screen
              for most of the time you spent on the step that needed it
              most. Sticky, blurred, and it stops floating once the page
              bottom reaches it.
            */}
            <div className="sticky bottom-4 z-30 mt-6">
              <div
                className="flex flex-wrap items-center gap-3 rounded-full border border-line/10 p-2 shadow-md"
                style={{
                  background: "rgb(var(--c-bg-card) / 0.88)",
                  backdropFilter: "saturate(180%) blur(14px)",
                  WebkitBackdropFilter: "saturate(180%) blur(14px)",
                }}
              >
                <Button
                  variant="ghost"
                  icon={ArrowLeft}
                  onClick={() => goTo(stepIndex - 1)}
                  disabled={stepIndex === 0}
                >
                  Back
                </Button>

                {/* A rail rather than a number: it reads at a glance
                    from the corner of the eye, which "Step 4 of 7"
                    does not. The count stays for anyone who wants it. */}
                <div className="ml-auto flex items-center gap-3 pr-1">
                  {/* Below lg the quote sits after the form, so the bar
                      carries its bottom line while the buyer answers. */}
                  {step.key === "hardware" && priced?.quote?.totals?.firstInvoice && (
                    <span className="lg:hidden text-right leading-tight">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-ink-muted">First invoice</span>
                      <span className="block text-sm font-extrabold tabular-nums">
                        {formatMoney(priced.quote.totals.firstInvoice.total, { currency: priced.quote.currency })}
                      </span>
                    </span>
                  )}
                  <span className="hidden sm:flex items-center gap-2">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line/10">
                      <motion.span
                        className="block h-full rounded-full"
                        style={{ background: "var(--color-accent)" }}
                        initial={false}
                        animate={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                        transition={{ duration: reduceMotion ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] }}
                      />
                    </span>
                    <span className="text-xs text-ink-muted tabular-nums">
                      {stepIndex + 1}/{STEPS.length}
                    </span>
                  </span>

                  {isLast ? (
                    <Button
                      variant="primary"
                      icon={isSignedIn ? Send : UserPlus}
                      loading={saving}
                      onClick={saveToAccount}
                      disabled={blocking.length > 0}
                    >
                      {isSignedIn ? "Save to my account" : "Create an account to save"}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={attempt}>
                      Continue
                      <ArrowRight size={16} />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Not dismissible by Escape or a backdrop click: this discards
          work, and the two ways to leave a dialog by accident are
          exactly the two we do not want here. */}
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        dismissible={false}
        icon={RotateCcw}
        title="Start over?"
        subtitle="Your saved draft is discarded and every step goes back to its default. This cannot be undone."
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Keep my draft
            </Button>
            <Button variant="danger" icon={RotateCcw} onClick={startOver} data-autofocus>
              Discard and start over
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-secondary">
          You are on step {stepIndex + 1} of {STEPS.length}
          {config.organizationName ? (
            <>
              , configuring <span className="font-semibold text-ink-primary">{config.organizationName}</span>
            </>
          ) : null}
          .
        </p>
      </Modal>
    </div>
  );
}
