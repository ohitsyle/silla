import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, TriangleAlert, CircleCheck, Info, Check, X, Inbox } from "lucide-react";

/**
 * Portal UI primitives.
 *
 * The portal is a separate package from the buyer app on purpose (a
 * buyer's deployment must never ship the vendor's order system), so
 * this file deliberately duplicates the client's primitives instead of
 * importing them. It follows the same rules: no colour literal in a
 * component, every value resolving through the design tokens, one
 * shared focus/disabled/elevation language.
 *
 * The one place a literal colour legitimately appears is ColorField's
 * swatch — that is the buyer's chosen brand value being previewed, i.e.
 * data, not styling.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/* ────────────────────────────── Motion ────────────────────────────── */

/**
 * A local copy of the client's motion vocabulary (client/src/lib/motion.js).
 * Same durations, so a buyer configuring their system and then using it
 * experiences one product moving at one speed.
 *
 * Nothing here is communicated by movement alone, so honouring
 * prefers-reduced-motion costs nothing: the reduced variants keep the
 * fade and drop the travel.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1];

export const DURATION = { instant: 0.09, fast: 0.15, base: 0.24, slow: 0.38 };

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function respectMotion(variants) {
  if (!prefersReducedMotion()) return variants;
  const strip = (v) => {
    if (!v || typeof v !== "object") return v;
    const { y, x, scale, ...rest } = v;
    return rest;
  };
  return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, strip(v)]));
}

/** A page or major section arriving. */
export const pageEnter = () =>
  respectMotion({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  });

/** A panel that appears in response to a click — a wizard step, a form. */
export const panelEnter = () =>
  respectMotion({
    initial: { opacity: 0, y: 10, scale: 0.99 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -6, scale: 0.99 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  });

/** A list whose children arrive in sequence. Keep the stagger tight. */
export const listContainer = (stagger = 0.035) => ({
  initial: "hidden",
  animate: "shown",
  variants: {
    hidden: {},
    shown: { transition: { staggerChildren: prefersReducedMotion() ? 0 : stagger } },
  },
});

export const listItem = () => ({
  variants: respectMotion({
    hidden: { opacity: 0, y: 8 },
    shown: { opacity: 1, y: 0 },
  }),
  transition: { duration: DURATION.base, ease: EASE_OUT },
});

/** Hover/press feedback for cards that behave as buttons. */
export const pressable = () =>
  prefersReducedMotion()
    ? {}
    : {
        whileHover: { y: -2 },
        whileTap: { y: 0, scale: 0.995 },
        transition: { duration: DURATION.fast, ease: EASE_OUT },
      };

/* ────────────────────────────── Button ────────────────────────────── */

/*
 * Pills, not rounded rectangles, and they press.
 *
 * The storefront's CTAs sit on a hard offset shadow that collapses when
 * pushed, so a button feels like an object rather than a colour. Buttons
 * inside the configurator now do the same thing: it is the same surface
 * and a buyer arrives here straight off that page.
 *
 * `active:translate-y-*` pairs with the shadow on primary — pressing it
 * moves the cap down onto its own shadow. On the flat variants there is
 * no shadow to collapse, so they only tint.
 */
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-full whitespace-nowrap " +
  "transition-[background-color,border-color,color,opacity,transform,box-shadow] duration-fast ease-out " +
  "disabled:opacity-40 disabled:pointer-events-none select-none";

const BUTTON_SIZES = {
  sm: "h-9 px-4 text-[13px]",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-7 text-[15px]",
};

const BUTTON_VARIANTS = {
  // The accent is a runtime CSS variable, so it can't be a Tailwind
  // class — see the `style` branch in the component below.
  primary: "border-0 hover:brightness-[1.04] active:translate-y-[3px] active:shadow-none",
  secondary:
    "bg-bg-card border-2 border-line/12 text-ink-primary hover:border-line/25 active:translate-y-[1px]",
  ghost: "border-0 text-ink-secondary hover:text-ink-primary hover:bg-line/[0.06]",
  danger:
    "border-2 border-state-unavailable/40 text-state-unavailable hover:bg-state-unavailable/10 active:translate-y-[1px]",
};

export const Button = forwardRef(function Button(
  { variant = "secondary", size = "md", loading = false, icon: Icon, children, className, ...props },
  ref
) {
  const isPrimary = variant === "primary";
  const iconSize = size === "sm" ? 13 : 16;
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
      style={
        isPrimary
          ? {
              background: "var(--color-accent)",
              color: "var(--color-accent-ink)",
              // The hard offset is the whole trick; a blurred shadow
              // reads as elevation, a solid one reads as thickness.
              boxShadow: props.disabled || loading ? "none" : "0 3px 0 0 rgb(192 92 68)",
              ...props.style,
            }
          : props.style
      }
    >
      {loading ? (
        <LoaderCircle size={iconSize} className="animate-spin" />
      ) : (
        Icon && <Icon size={iconSize} />
      )}
      {children}
    </button>
  );
});

/* ──────────────────────── Segmented control ───────────────────────── */

/** One control for every "pick one of these" row. */
export function Segmented({ options, value, onChange, size = "md", className }) {
  // Scoped to this instance so two segmented controls on one screen
  // don't animate their markers into each other.
  const groupId = useId();
  return (
    <div
      className={cx(
        "inline-flex flex-wrap gap-1 p-1 rounded-lg bg-bg-panel/60 border border-line/10",
        className
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            title={option.title}
            aria-pressed={selected}
            className={cx(
              "relative rounded-md font-medium transition-colors duration-fast ease-out flex items-center gap-2",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
              selected ? "" : "text-ink-secondary hover:text-ink-primary"
            )}
            style={selected ? { color: "var(--color-accent-ink)" } : undefined}
          >
            {selected && (
              // A single shared element slides between options rather
              // than each one fading — the movement is what tells you
              // which changed.
              <motion.span
                layoutId={`segmented-${groupId}`}
                className="absolute inset-0 rounded-md shadow-sm"
                style={{ background: "var(--color-accent)" }}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {Icon && <Icon size={size === "sm" ? 13 : 15} />}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── Card ─────────────────────────────── */

export function Card({ children, className, padded = true, ...props }) {
  return (
    <div
      {...props}
      className={cx(
        "rounded-lg border border-line/10 bg-bg-card shadow-raised",
        padded && "p-5",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A card with a heading — the standard section wrapper.
 *
 * The icon sits in a tinted chip rather than floating grey beside the
 * text. Two reasons: a 15px muted glyph next to a 14px semibold line is
 * the house style of an admin console, and this is a storefront; and the
 * chip is the only place the accent appears inside a step, so it carries
 * SILLA's colour down the page without any of it landing on a control a
 * buyer might mistake for their own branding.
 */
export function Panel({ title, subtitle, icon: Icon, action, children, className }) {
  return (
    <Card className={className}>
      {(title || action) && (
        <div className={cx("flex gap-3 mb-4", subtitle ? "items-start" : "items-center")}>
          {Icon && (
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px]"
              style={{ background: "rgb(var(--c-accent) / 0.11)", color: "var(--color-accent)" }}
            >
              <Icon size={17} strokeWidth={2.3} />
            </span>
          )}
          <div className="mr-auto min-w-0">
            {title && (
              <h2 className="text-[15px] font-bold tracking-tight text-ink-primary">{title}</h2>
            )}
            {subtitle && (
              <p className="text-[13px] text-ink-secondary mt-0.5 leading-relaxed">{subtitle}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </Card>
  );
}

/* ────────────────────────────── Fields ────────────────────────────── */

const CONTROL_BASE =
  "mt-1.5 w-full px-3 rounded-md bg-bg-panel text-ink-primary " +
  "border transition-colors duration-fast ease-out outline-none";

export function Field({ label, hint, error, mono, className, children, ...props }) {
  const fieldId = useId();
  // Not derived from the label: the wizard's labels are prose ("Site
  // name"), and an id containing a space makes aria-describedby read as
  // two references, neither of which exists.
  const describedBy = error || hint ? `${fieldId}-desc` : undefined;
  return (
    <label className={cx("block", className)}>
      {label && <span className="text-sm text-ink-secondary">{label}</span>}
      {children || (
        <input
          {...props}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          className={cx(
            CONTROL_BASE,
            "h-11",
            error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40",
            mono && "font-mono",
            props.className
          )}
        />
      )}
      {(hint || error) && (
        <span
          id={describedBy}
          // Marks the scroll target for the wizard's Continue: pressing
          // it on an incomplete step reveals the errors and brings the
          // first one into view, which needs something to aim at.
          data-field-error={error ? "" : undefined}
          className={cx(
            "text-xs mt-1 block font-medium",
            error ? "text-state-unavailable" : "text-ink-muted"
          )}
        >
          {error || hint}
        </span>
      )}
    </label>
  );
}

/** Long-form copy — terms text, a floor description. */
export function Textarea({ label, hint, error, mono, rows = 6, className, ...props }) {
  const fieldId = useId();
  const describedBy = error || hint ? `${fieldId}-desc` : undefined;
  return (
    <label className={cx("block", className)}>
      {label && <span className="text-sm text-ink-secondary">{label}</span>}
      <textarea
        {...props}
        rows={rows}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        className={cx(
          CONTROL_BASE,
          "py-2.5 leading-relaxed resize-y",
          error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40",
          mono && "font-mono text-xs",
          props.className
        )}
      />
      {(hint || error) && (
        <span
          id={describedBy}
          // Marks the scroll target for the wizard's Continue: pressing
          // it on an incomplete step reveals the errors and brings the
          // first one into view, which needs something to aim at.
          data-field-error={error ? "" : undefined}
          className={cx(
            "text-xs mt-1 block font-medium",
            error ? "text-state-unavailable" : "text-ink-muted"
          )}
        >
          {error || hint}
        </span>
      )}
    </label>
  );
}

export function Select({ label, hint, className, children, ...props }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="text-sm text-ink-secondary">{label}</span>}
      <select {...props} className={cx(CONTROL_BASE, "h-11 border-line/10 focus:border-line/40")}>
        {children}
      </select>
      {hint && <span className="text-xs mt-1 block text-ink-muted">{hint}</span>}
    </label>
  );
}

/* ──────────────────────────── ColorField ──────────────────────────── */

/**
 * Accepts "#abc", "ABCDEF", " #a1b2c3 " and returns "#A1B2C3", or null
 * when the text isn't a colour yet. A buyer either picks visually or
 * pastes a hex out of a brand guide, and brand guides are inconsistent
 * about the leading # and the case.
 */
function normalizeHex(raw) {
  const body = String(raw || "").trim().replace(/^#/, "");
  const expanded = /^[0-9a-f]{3}$/i.test(body)
    ? body.split("").map((c) => c + c).join("")
    : body;
  return /^[0-9a-f]{6}$/i.test(expanded) ? `#${expanded.toUpperCase()}` : null;
}

/**
 * A colour picker paired with the hex itself. The text input is the one
 * that matters — the profile contract stores #RRGGBB and a buyer
 * matching an existing brand pastes rather than eyeballs — so the field
 * lets them type freely and only calls onChange once the text resolves
 * to a real colour. Half-typed values stay on screen instead of being
 * rejected keystroke by keystroke.
 */
export function ColorField({ label, value, onChange, hint, name, className }) {
  const [draft, setDraft] = useState(value || "");
  const descId = useId();

  // Keep the buyer's own text while it still means the current colour
  // (they typed lowercase, or omitted the #), and only overwrite when
  // the value genuinely changed underneath them — a profile preset
  // being applied, say.
  useEffect(() => {
    setDraft((current) => (normalizeHex(current) === value ? current : value || ""));
  }, [value]);

  const commit = (raw) => {
    setDraft(raw);
    const hex = normalizeHex(raw);
    if (hex) onChange(hex);
  };

  const swatch = normalizeHex(draft) || value || "#000000";
  const invalid = draft.trim() !== "" && !normalizeHex(draft);

  return (
    <div className={cx("block", className)}>
      {label && (
        <label htmlFor={`${descId}-hex`} className="text-sm text-ink-secondary">
          {label}
        </label>
      )}
      <div
        className="mt-1.5 flex items-stretch gap-2 rounded-md
                   focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-0"
      >
        <span
          className="relative h-11 w-12 shrink-0 rounded-md border border-line/15 overflow-hidden"
          style={{ background: swatch }}
        >
          <input
            type="color"
            value={swatch}
            aria-label={label ? `${label} colour picker` : "Colour picker"}
            onChange={(e) => commit(e.target.value)}
            // Laid over the swatch rather than styled directly: the
            // native control's inner chrome is unstyleable and differs
            // per browser, and the swatch has to read as the exact hex.
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </span>
        <input
          id={`${descId}-hex`}
          name={name}
          value={draft}
          spellCheck="false"
          autoComplete="off"
          maxLength={7}
          placeholder="#000000"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={hint || invalid ? `${descId}-desc` : undefined}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setDraft(value || "")}
          className={cx(
            "w-full h-11 px-3 rounded-md bg-bg-panel text-ink-primary font-mono uppercase",
            "border transition-colors duration-fast ease-out outline-none",
            invalid ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40"
          )}
        />
      </div>
      {(hint || invalid) && (
        <span
          id={`${descId}-desc`}
          className={cx("text-xs mt-1 block", invalid ? "text-state-unavailable" : "text-ink-muted")}
        >
          {invalid ? "Enter a hex colour, e.g. #2DD4BF." : hint}
        </span>
      )}
    </div>
  );
}

/* ────────────────────────────── Toggle ────────────────────────────── */

/**
 * A switch, not a checkbox: every use here flips a setting that takes
 * effect immediately in the preview, with no separate save.
 */
export function Toggle({ label, checked, onChange, hint, disabled, className }) {
  const labelId = useId();
  return (
    <div className={cx("flex items-start gap-3", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? `${labelId}-label` : undefined}
        aria-describedby={hint ? `${labelId}-hint` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "mt-0.5 relative w-10 h-6 shrink-0 rounded-full border transition-colors duration-fast ease-out",
          "disabled:opacity-40 disabled:pointer-events-none",
          checked ? "border-transparent" : "bg-bg-panel border-line/15"
        )}
        style={checked ? { background: "var(--color-accent)" } : undefined}
      >
        <motion.span
          className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-sm"
          style={{ background: checked ? "var(--color-accent-ink)" : "var(--color-ink-muted)" }}
          animate={{ x: checked ? 16 : 0 }}
          transition={
            prefersReducedMotion()
              ? { duration: 0 }
              : { type: "spring", stiffness: 600, damping: 38 }
          }
        />
      </button>
      {(label || hint) && (
        <div className="min-w-0">
          {label && (
            <span
              id={`${labelId}-label`}
              onClick={() => !disabled && onChange(!checked)}
              className="block text-sm text-ink-primary cursor-pointer select-none"
            >
              {label}
            </span>
          )}
          {hint && (
            <span id={`${labelId}-hint`} className="block text-xs text-ink-muted mt-0.5">
              {hint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── Stepper ───────────────────────────── */

/**
 * Wizard progress. Completed steps are clickable so a buyer can go back
 * and correct branding after seeing the catalog; future ones are not,
 * because a later step's defaults are derived from earlier answers.
 *
 * `current` is a step index or a step key. onJump is called with
 * (index, key) so a caller holding either can use it.
 */
export function Stepper({ steps, current, onJump, className }) {
  const markerId = useId();
  const currentIndex =
    typeof current === "number" ? current : Math.max(0, steps.findIndex((s) => s.key === current));
  const done = currentIndex;
  const pct = Math.round((done / (steps.length - 1)) * 100);

  return (
    <nav aria-label="Progress" className={cx("w-full", className)}>
      {/* A seat fills in for each step you finish.
         The circles-and-hairlines version said "form, 7 of them" — this
         says "you are filling a room", which is the thing being bought.
         Same tile the storefront uses, same tile the real map draws. */}
      <ol className="flex items-start gap-1.5 sm:gap-3">
        {steps.map((step, index) => {
          const isDone = index < currentIndex;
          const active = index === currentIndex;
          const clickable = isDone && typeof onJump === "function";
          return (
            <li key={step.key} className="flex-1 min-w-0">
              <button
                type="button"
                disabled={!clickable}
                aria-current={active ? "step" : undefined}
                onClick={clickable ? () => onJump(index, step.key) : undefined}
                className={cx(
                  "group w-full text-left",
                  // A step you have not reached is not an error, but
                  // index.css paints every [disabled] not-allowed at the
                  // same specificity as cursor-*. The variant outranks it.
                  clickable ? "cursor-pointer" : "disabled:cursor-default"
                )}
              >
                <span className="relative block">
                  <span
                    className={cx(
                      "relative flex h-10 w-full items-center justify-center rounded-[12px]",
                      "text-sm font-bold transition-colors duration-fast ease-out",
                      !isDone && !active && "bg-line/[0.06] text-ink-muted",
                      clickable && "group-hover:brightness-95"
                    )}
                    style={
                      isDone
                        ? { background: "rgb(var(--c-state-available))", color: "rgb(var(--c-bg-card))" }
                        : undefined
                    }
                  >
                    {active && (
                      // One marker that slides between steps: the travel
                      // is what says "you moved on", so the numbers do
                      // not have to be read for the change to register.
                      <motion.span
                        layoutId={`stepper-${markerId}`}
                        className="absolute inset-0 rounded-[12px] shadow-sm"
                        style={{ background: "var(--color-accent)" }}
                        transition={{ type: "spring", stiffness: 500, damping: 40 }}
                      />
                    )}
                    <span
                      className="relative flex items-center justify-center"
                      style={active ? { color: "var(--color-accent-ink)" } : undefined}
                    >
                      {isDone ? <Check size={16} strokeWidth={3} /> : index + 1}
                    </span>
                  </span>
                </span>
                <span
                  className={cx(
                    "mt-2 hidden sm:block truncate text-xs font-semibold transition-colors duration-fast",
                    active ? "text-ink-primary" : isDone ? "text-ink-secondary" : "text-ink-muted"
                  )}
                >
                  {step.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Said in words as well as colour, for anyone who cannot use the
          fill to judge how far along they are. */}
      <p className="sr-only">
        Step {currentIndex + 1} of {steps.length}. {pct}% complete.
      </p>
    </nav>
  );
}

/* ───────────────────────────── Feedback ───────────────────────────── */

const NOTICE_TONES = {
  info: { cls: "border-line/15 text-ink-secondary", Icon: Info },
  error: { cls: "border-state-unavailable/40 text-state-unavailable", Icon: TriangleAlert },
  success: { cls: "border-state-available/40 text-state-available", Icon: CircleCheck },
};

export function Notice({ tone = "info", children, className }) {
  const { cls, Icon } = NOTICE_TONES[tone] || NOTICE_TONES.info;
  return (
    <motion.div
      {...pageEnter()}
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-md border px-4 py-3 text-sm flex gap-2.5 items-start", cls, className)}
    >
      <Icon size={16} className="shrink-0 mt-0.5" />
      <span className="min-w-0">{children}</span>
    </motion.div>
  );
}

export function Badge({ children, tone, className }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium",
        className
      )}
      style={
        tone
          ? { background: `rgb(var(--c-state-${tone}) / 0.18)`, color: `var(--color-state-${tone})` }
          : { background: "rgb(var(--c-line) / 0.08)", color: "var(--color-ink-secondary)" }
      }
    >
      {children}
    </span>
  );
}

/* ───────────────────────────── Metrics ────────────────────────────── */

export function Stat({ label, value, sub, tone, onClick }) {
  const Wrapper = onClick ? motion.button : motion.div;
  return (
    <Wrapper
      {...listItem()}
      {...(onClick ? { onClick, type: "button", ...pressable() } : {})}
      className={cx(
        "rounded-lg border border-line/10 bg-bg-card shadow-raised p-4 text-left",
        onClick && "hover:border-line/25 transition-colors duration-fast ease-out"
      )}
    >
      <div className="text-xs text-ink-secondary flex items-center gap-1.5">
        {tone && (
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: `var(--color-state-${tone})` }}
          />
        )}
        {label}
      </div>
      <div className="text-2xl font-semibold text-ink-primary mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-ink-muted mt-0.5">{sub}</div>}
    </Wrapper>
  );
}

/* ──────────────────────────── Modal ───────────────────────────────── */

/**
 * A dialog for anything that interrupts.
 *
 * A copy of the product's, not an import — the portal must never reach
 * into client/. Same contract, warmer surface: the storefront's rounder
 * radii, and a scrim tinted with the ink token rather than flat black,
 * because hard black over cream reads as another application's chrome
 * dropping onto the page.
 *
 * Rendered through a portal so an ancestor's overflow or transform can
 * never clip it. Escape closes, the backdrop closes, focus moves in on
 * open and returns to whatever opened it on close, and the page behind
 * cannot scroll while it is up.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  children,
  footer,
  width = "max-w-lg",
  dismissible = true,
}) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;

    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      // A destructive confirmation can opt out, so a stray keypress
      // cannot dismiss the question it is asking.
      if (dismissible) onClose?.();
    };
    document.addEventListener("keydown", onKey, true);

    // Compensate for the scrollbar so the page behind does not jump
    // sideways the moment the dialog opens.
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    const frame = requestAnimationFrame(() => {
      const target =
        panelRef.current?.querySelector("[data-autofocus]") ||
        panelRef.current?.querySelector("input, select, textarea, button");
      target?.focus();
    });

    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      cancelAnimationFrame(frame);
      // Return focus, so a keyboard user is not dumped at the top of
      // the document.
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [open, onClose, dismissible]);

  const reduced = prefersReducedMotion();

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 backdrop-blur-sm"
            style={{ background: "rgb(var(--c-line) / 0.45)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            onClick={dismissible ? onClose : undefined}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            className={cx(
              "relative w-full border border-line/10 bg-bg-card shadow-lg",
              "max-h-[92vh] overflow-y-auto rounded-t-xl sm:rounded-xl",
              width
            )}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
            transition={{ duration: DURATION.base, ease: EASE_OUT }}
          >
            {(title || (onClose && dismissible)) && (
              <div className="flex items-start gap-3 p-5 pb-0">
                {Icon && (
                  <span
                    className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
                    style={{
                      background: "rgb(var(--c-accent) / 0.12)",
                      color: "var(--color-accent)",
                    }}
                  >
                    <Icon size={19} strokeWidth={2.2} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {title && (
                    <h2 className="text-lg font-bold leading-tight tracking-tight">{title}</h2>
                  )}
                  {subtitle && (
                    <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{subtitle}</p>
                  )}
                </div>
                {dismissible && (
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full
                               text-ink-muted transition-colors duration-fast
                               hover:bg-line/[0.07] hover:text-ink-primary"
                  >
                    <X size={17} />
                  </button>
                )}
              </div>
            )}

            <div className="p-5">{children}</div>

            {footer && (
              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line/10 p-5">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ──────────────────────────── Empty state ─────────────────────────── */

/**
 * What a list says when it holds nothing.
 *
 * An empty region with no explanation reads as a failure to load. This
 * says which it is, and where there is one, offers the action that
 * fills it.
 */
export function EmptyState({ icon: Icon = Inbox, title, children, action, className }) {
  return (
    <div
      className={cx(
        "rounded-lg border border-dashed border-line/15 px-6 py-12 text-center",
        className
      )}
    >
      <span
        className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-[14px]"
        style={{ background: "rgb(var(--c-line) / 0.05)", color: "var(--color-ink-muted)" }}
      >
        <Icon size={22} />
      </span>
      {title && <p className="font-bold tracking-tight text-ink-primary">{title}</p>}
      {children && (
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-ink-secondary">
          {children}
        </p>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}


/* ──────────────────────────── Structure ───────────────────────────── */

/** Standard page container — one width and rhythm for every screen. */
/**
 * A loading placeholder.
 *
 * The portal had none because nothing in it loaded — every screen was
 * local state. The order screens fetch, so a shape that holds the
 * layout's height beats a spinner that lets the page jump when data
 * lands. Shimmer comes from the keyframe already declared in index.css.
 */
export function Skeleton({ className, rounded = "rounded-md" }) {
  return (
    <div
      className={cx("relative overflow-hidden bg-line/[0.07]", rounded, className)}
      aria-hidden
    >
      <div
        className="absolute inset-0 -translate-x-full animate-shimmer"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgb(var(--c-line) / 0.06), transparent)",
        }}
      />
    </div>
  );
}

export function Page({ children, width = "wide", className }) {
  const widths = { narrow: "max-w-sm", medium: "max-w-3xl", wide: "max-w-6xl" };
  return (
    <div className={cx("px-6 pb-14 mx-auto text-ink-primary", widths[width], className)}>
      {children}
    </div>
  );
}
