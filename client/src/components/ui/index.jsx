import { forwardRef, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { LoaderCircle, TriangleAlert, CircleCheck, Info, X } from "lucide-react";
import {
  DURATION, EASE_OUT, listContainer, listItem, pageEnter, prefersReducedMotion, pressable,
} from "../../lib/motion.js";

/**
 * UI primitives.
 *
 * Before this file, every page hand-rolled its own buttons, cards,
 * notices and loading states, so no two surfaces looked quite alike and
 * a change to (say) focus styling had to be made in nine places. These
 * are the shared pieces; screens compose them and stop inventing.
 *
 * Nothing here hardcodes a colour — everything resolves through the
 * design tokens in index.css so a buyer's branding still drives the
 * whole product (spec §16).
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

/* ────────────────────────────── Button ────────────────────────────── */

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 font-medium rounded-md whitespace-nowrap " +
  "transition-[background-color,border-color,color,opacity,transform] duration-fast ease-out " +
  "disabled:opacity-40 disabled:pointer-events-none select-none";

const BUTTON_SIZES = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
};

const BUTTON_VARIANTS = {
  // The accent is a runtime CSS variable, so it can't be a Tailwind
  // class — see the `style` branch in the component below.
  primary: "border border-transparent shadow-sm hover:brightness-110 active:brightness-95",
  secondary:
    "bg-bg-panel border border-line/10 text-ink-secondary hover:text-ink-primary hover:border-line/25 active:bg-bg-panel/70",
  ghost: "border border-transparent text-ink-secondary hover:text-ink-primary hover:bg-bg-panel/60",
  danger:
    "border border-state-unavailable/40 text-state-unavailable hover:bg-state-unavailable/10 active:bg-state-unavailable/20",
};

export const Button = forwardRef(function Button(
  { variant = "secondary", size = "md", loading = false, icon: Icon, children, className, ...props },
  ref
) {
  const isPrimary = variant === "primary";
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant], className)}
      style={isPrimary ? { background: "var(--color-accent)", color: "var(--color-accent-ink)", ...props.style } : props.style}
    >
      {loading ? <LoaderCircle size={size === "sm" ? 13 : 16} className="animate-spin" /> : Icon && <Icon size={size === "sm" ? 13 : 16} />}
      {children}
    </button>
  );
});

/* ──────────────────────── Segmented control ───────────────────────── */

/**
 * One control for every "pick one of these" row in the product — admin
 * tabs, floor switchers, editor tools, report ranges. They were four
 * different-looking things before.
 *
 * An option may be `disabled` — the map's "Now" while closed — and then
 * says why in its `title`.
 */
export function Segmented({ options, value, onChange, size = "md", className }) {
  return (
    <div className={cx("inline-flex flex-wrap gap-1 p-1 rounded-lg bg-bg-panel/60 border border-line/10", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            title={option.title}
            disabled={option.disabled}
            aria-pressed={selected}
            className={cx(
              "relative rounded-md font-medium transition-colors duration-fast ease-out flex items-center gap-2",
              // lg: a wall screen's tabs, sized for a finger at arm's length.
              size === "sm" ? "h-7 px-2.5 text-xs" : size === "lg" ? "h-11 px-4 text-base" : "h-8 px-3 text-sm",
              selected ? "" : "text-ink-secondary hover:text-ink-primary"
            )}
            style={selected ? { color: "var(--color-accent-ink)" } : undefined}
          >
            {selected && (
              // A single shared element slides between options rather
              // than each one fading — the movement is what tells you
              // which changed.
              <motion.span
                layoutId={`segmented-${className || "default"}`}
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

/**
 * `elevation="floating"` is for a card that sits on the decorative floor
 * backdrop (the gate screens). The default raised level is tuned for a
 * flat page and vanishes into the pattern behind it there.
 */
export function Card({ children, className, padded = true, elevation = "raised", ...props }) {
  return (
    <div
      {...props}
      className={cx(
        "rounded-lg border border-line/10 bg-bg-card",
        elevation === "floating" ? "shadow-floating" : "shadow-raised",
        padded && "p-5",
        className
      )}
    >
      {children}
    </div>
  );
}

/** A card with a heading — the standard section wrapper. */
export function Panel({ title, icon: Icon, action, children, className }) {
  return (
    <Card className={className}>
      {(title || action) && (
        <div className="flex items-center gap-2 mb-4">
          {Icon && <Icon size={15} className="text-ink-muted" />}
          {title && <h2 className="text-sm font-semibold text-ink-primary">{title}</h2>}
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      {children}
    </Card>
  );
}

/* ────────────────────────────── Fields ────────────────────────────── */

/**
 * `className` styles the field's WRAPPER; `inputClassName` styles the
 * control itself. They were one prop, and since `className` is
 * destructured here, `props.className` on the input was always
 * undefined — so PinField's letter-spacing landed on the <label> and
 * cascaded into the label text ("6 — d i g i t   P I N") while the
 * digits it was written for stayed unspaced. Two props, no ambiguity.
 */
export function Field({ label, hint, error, mono, className, inputClassName, children, ...props }) {
  const describedBy = error ? `${props.name || label}-error` : undefined;
  return (
    <label className={cx("block", className)}>
      {label && <span className="text-sm font-medium text-ink-secondary">{label}</span>}
      {children || (
        <input
          {...props}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          className={cx(
            "mt-1.5 w-full h-11 px-3 rounded-md bg-bg-panel text-ink-primary",
            "border transition-colors duration-fast ease-out outline-none",
            "placeholder:text-ink-muted/60",
            error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40",
            mono && "font-mono",
            inputClassName
          )}
        />
      )}
      {(hint || error) && (
        <span
          id={describedBy}
          className={cx("text-xs mt-1 block", error ? "text-state-unavailable" : "text-ink-muted")}
        >
          {error || hint}
        </span>
      )}
    </label>
  );
}

/** A 6-digit PIN entry — used on four different screens. */
export function PinField({ label, value, onChange, hint, error, autoFocus, name }) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      type="password"
      name={name}
      required
      autoFocus={autoFocus}
      inputMode="numeric"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      inputClassName="font-mono text-lg tracking-[0.45em] text-center"
    />
  );
}

export function Select({ label, hint, className, children, ...props }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="text-sm text-ink-secondary">{label}</span>}
      <select
        {...props}
        className="mt-1.5 w-full h-11 px-3 rounded-md bg-bg-panel border border-line/10 text-ink-primary
                   outline-none transition-colors duration-fast ease-out focus:border-line/40"
      >
        {children}
      </select>
      {hint && <span className="text-xs mt-1 block text-ink-muted">{hint}</span>}
    </label>
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

/** Coloured dot + label, for statuses. Never colour alone (MAP-1 AC). */
export function StatusDot({ tone, label, count, outline = false, className }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-ink-secondary text-sm", className)}>
      <span
        className="inline-block w-2.5 h-2.5 rounded-[3px] shrink-0"
        style={
          outline
            ? { border: `2px solid var(--color-state-${tone})` }
            : { background: `var(--color-state-${tone})` }
        }
      />
      {label}
      {count !== undefined && <span className="text-ink-primary font-semibold">{count}</span>}
    </span>
  );
}

export function Badge({ children, tone, className }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium", className)}
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

/**
 * Counts from 0 to `value` on mount and between values on update.
 *
 * These are live operational numbers — how many seats are free right
 * now — and a figure that snaps has no sense of being measured. The
 * duration is fixed rather than proportional to the distance so that
 * 3 and 300 finish together and a row of stats settles as one.
 *
 * Non-numeric values (a peak hour of "08:00", a rate of "25%") pass
 * straight through: there is nothing to count.
 */
function AnimatedNumber({ value }) {
  const [shown, setShown] = useState(typeof value === "number" ? 0 : value);
  const frame = useRef();

  useEffect(() => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      setShown(value);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setShown(value);
      return undefined;
    }

    const from = typeof shown === "number" ? shown : 0;
    if (from === value) return undefined;

    const start = performance.now();
    const run = (now) => {
      const t = Math.min((now - start) / 620, 1);
      // Same curve as EASE_OUT, so numbers settle like everything else.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (t < 1) frame.current = requestAnimationFrame(run);
    };
    frame.current = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame.current);
    // `shown` is deliberately not a dependency: it changes every frame,
    // and reading it here is only to pick the starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <>{shown}</>;
}

/**
 * `progress` (0..1) draws a capacity bar under the figure. "29 of 49"
 * is a ratio, and a ratio is read faster as a length than as two
 * numbers the eye has to divide.
 */
export function Stat({ label, value, sub, tone, progress, onClick }) {
  const Wrapper = onClick ? motion.button : motion.div;
  return (
    <Wrapper
      {...listItem()}
      {...(onClick ? { onClick, type: "button", ...pressable() } : {})}
      className={cx(
        "rounded-lg border border-line/10 bg-bg-card shadow-raised p-4 text-left",
        // Column + mt-auto on the bar: without it the bar floats directly
        // under the figure, so a card WITH a sub-line and one without put
        // their bars at different heights and the row looked ragged.
        "flex flex-col",
        onClick && "hover:border-line/25 transition-colors duration-fast ease-out"
      )}
    >
      <div className="text-xs text-ink-secondary flex items-center gap-1.5">
        {tone && <span className="w-2 h-2 rounded-full" style={{ background: `var(--color-state-${tone})` }} />}
        {label}
      </div>
      <div className="text-2xl font-semibold text-ink-primary mt-1 tabular-nums">
        <AnimatedNumber value={value} />
      </div>
      {sub && <div className="text-xs text-ink-muted mt-0.5">{sub}</div>}
      {typeof progress === "number" && (
        <div className="mt-auto pt-2.5 h-1 box-content rounded-full overflow-hidden">
          <div className="h-1 rounded-full bg-line/10 overflow-hidden">
          <motion.div
            className="h-full rounded-full origin-left"
            style={{ background: `var(--color-state-${tone || "available"})` }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: Math.max(0, Math.min(1, progress)) }}
            transition={{ duration: DURATION.slow, ease: EASE_OUT }}
          />
          </div>
        </div>
      )}
    </Wrapper>
  );
}

/* ───────────────────────────── Modal ──────────────────────────────── */

/**
 * A dialog for anything that interrupts.
 *
 * The app used to grow these inline: pressing "Reissue card" appended a
 * form below the list, and the kiosk's manual-UID entry was a native
 * <details> disclosure — a raw triangle glyph that no amount of styling
 * makes look deliberate. Both push the page around underneath the
 * reader, and on a long list the thing you just opened can appear off
 * screen entirely.
 *
 * Rendered through a portal so an ancestor's overflow or transform can
 * never clip it. Escape closes, the backdrop closes, focus moves in on
 * open and returns to whatever opened it on close, and the page behind
 * cannot scroll while it is up.
 */
export function Modal({ open, onClose, title, subtitle, icon: Icon, children, footer, width = "max-w-lg" }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
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
      // Return focus, so a keyboard user is not dumped back at the top
      // of the document.
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [open, onClose]);

  const reduced = prefersReducedMotion();

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            className={cx(
              "relative w-full bg-bg-card border border-line/12 shadow-lg",
              "rounded-t-xl sm:rounded-xl max-h-[92vh] overflow-y-auto",
              width
            )}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
            transition={{ duration: DURATION.base, ease: EASE_OUT }}
          >
            {(title || onClose) && (
              <div className="flex items-start gap-3 p-5 pb-0">
                {Icon && (
                  <span
                    className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg"
                    style={{ background: "rgb(var(--c-accent) / 0.14)", color: "var(--color-accent)" }}
                  >
                    <Icon size={18} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {title && <h2 className="text-lg font-semibold leading-tight">{title}</h2>}
                  {subtitle && <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p>}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-md
                             text-ink-muted transition-colors duration-fast hover:bg-line/10 hover:text-ink-primary"
                >
                  <X size={17} />
                </button>
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

/* ──────────────────────────── Loading ─────────────────────────────── */

/**
 * A shaped placeholder, not a spinner. It holds the layout so the page
 * doesn't jump when data lands, which is the actual complaint people
 * have about loading states.
 */
export function Skeleton({ className, rounded = "rounded-md" }) {
  return (
    <span
      aria-hidden="true"
      className={cx("relative block overflow-hidden bg-bg-panel/70", rounded, className)}
    >
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-line/10 to-transparent" />
    </span>
  );
}

export function SkeletonStats({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-line/10 bg-bg-card p-4">
          <Skeleton className="h-3 w-16 mb-3" />
          <Skeleton className="h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 5 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ size = 16, className }) {
  return <LoaderCircle size={size} className={cx("animate-spin", className)} />;
}

/** Full-area loading state, for a whole page or panel. */
export function Loading({ label = "Loading…", className }) {
  return (
    <div className={cx("min-h-[40vh] flex items-center justify-center gap-2 text-ink-secondary text-sm", className)}>
      <Spinner />
      {label}
    </div>
  );
}

/* ──────────────────────────── Structure ───────────────────────────── */

export function PageHeader({ title, subtitle, action, className }) {
  return (
    <motion.div {...pageEnter()} className={cx("flex flex-wrap items-start gap-3 mb-6", className)}>
      <div className="mr-auto min-w-0">
        <h1 className="text-lg font-semibold text-ink-primary">{title}</h1>
        {subtitle && <p className="text-sm text-ink-secondary mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </motion.div>
  );
}

export function EmptyState({ icon: Icon, title, body, action, className }) {
  return (
    <div className={cx("text-center py-10 px-6", className)}>
      {Icon && (
        <div className="w-12 h-12 rounded-lg mx-auto mb-3 flex items-center justify-center bg-bg-panel text-ink-muted">
          <Icon size={22} />
        </div>
      )}
      <div className="text-sm font-medium text-ink-primary">{title}</div>
      {body && <p className="text-sm text-ink-secondary mt-1 max-w-sm mx-auto">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Standard page container — one width and rhythm for every screen.
 *
 * The top padding puts a page's title level with the organization's name
 * in the sidebar. It used to be zero — left over from when a top bar sat
 * above every page — so each title was pressed against the window's edge.
 */
export function Page({ children, width = "wide", className }) {
  const widths = { narrow: "max-w-sm", medium: "max-w-3xl", wide: "max-w-6xl" };
  return <div className={cx("px-6 pt-5 pb-14 mx-auto text-ink-primary", widths[width], className)}>{children}</div>;
}

/** Re-exported so screens animate lists without importing motion twice. */
export { listContainer, listItem, pageEnter, pressable };
