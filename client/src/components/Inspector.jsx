import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronLeft, ChevronUp, X } from "lucide-react";
import { DURATION, EASE_OUT, prefersReducedMotion } from "../lib/motion.js";

/**
 * The panel that opens BESIDE the thing you selected.
 *
 * Selecting a seat used to append a panel underneath the map, which
 * grew the page and pushed the map you were reading up the screen — so
 * the answer to "what did I just click" arrived somewhere you had to go
 * looking for. Scrolling to it was a patch on the wrong shape.
 *
 * On a wide screen this is a column next to the map: the map keeps its
 * place, and the two are visible at once. Below `lg` it is a bottom sheet
 * DOCKED under the map rather than floating over it. It used to be a
 * fixed overlay with a dimmed backdrop, which covered exactly the room
 * you were choosing from and blocked the taps the panel is meant to
 * follow. Docked, the map gives up the space instead, keeps responding,
 * and the sheet can be folded down to its title when you want the map
 * back.
 *
 * Not a dialog: it does not trap focus or block the page, because you
 * are meant to keep clicking on the map while it is open and watch it
 * follow your selection. Escape still closes it, since that is what
 * Escape means everywhere else in the app.
 *
 * `onBack` + `backLabel` add one step back above the title — from
 * confirming a desk to the room it is in — so drilling down never needs
 * the close button to undo. `defaultFolded` starts the phone sheet folded
 * to its title; the column on a wide screen is never folded.
 */
export default function Inspector({
  open, onClose, title, subtitle, children, footer, onBack, backLabel, defaultFolded = false,
}) {
  const reduced = prefersReducedMotion();
  const [folded, setFolded] = useState(defaultFolded);
  const body = useRef(null);

  // Something new to show arrives in its default state — unfolded, unless
  // it is only a reminder (on a phone, your reservation should not take
  // half the screen before you have looked at the map) — and from its top:
  // the next step must not open where the last one was scrolled to.
  useEffect(() => {
    setFolded(defaultFolded);
    if (body.current) body.current.scrollTop = 0;
  }, [title, defaultFolded]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="inspector"
          aria-label={typeof title === "string" ? title : "Details"}
          className="
            relative z-10 flex max-h-[60vh] shrink-0 flex-col overflow-hidden rounded-t-xl border-t border-line/12
            bg-bg-card shadow-lg
            lg:h-full lg:max-h-none lg:w-[380px] lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none
          "
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: DURATION.base, ease: EASE_OUT }}
        >
          {/* The sheet's handle folds it — only where it is a sheet. */}
          <button
            type="button"
            onClick={() => setFolded((value) => !value)}
            aria-label={folded ? "Show details" : "Fold details away"}
            aria-expanded={!folded}
            className="flex justify-center pt-2 lg:hidden"
          >
            <span className="h-1 w-10 rounded-full bg-line/25" />
          </button>

          <div className="flex items-start gap-2 border-b border-line/10 px-4 pb-3 pt-2 lg:p-4">
            <div className="min-w-0 flex-1">
              {onBack && backLabel && (
                <button
                  type="button"
                  onClick={onBack}
                  className="-ml-1 mb-1 flex max-w-full items-center gap-0.5 rounded-sm text-sm text-ink-secondary
                             transition-colors duration-fast hover:text-ink-primary"
                >
                  <ChevronLeft size={16} className="shrink-0" />
                  <span className="truncate">{backLabel}</span>
                </button>
              )}
              <h2 className="truncate text-lg font-semibold leading-tight">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={() => setFolded((value) => !value)}
              aria-label={folded ? "Show details" : "Fold details away"}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-muted transition-colors
                         duration-fast hover:bg-line/10 hover:text-ink-primary lg:hidden"
            >
              {folded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-muted
                         transition-colors duration-fast hover:bg-line/10 hover:text-ink-primary"
            >
              <X size={17} />
            </button>
          </div>

          <div ref={body} className={`min-h-0 flex-1 overflow-y-auto p-4 ${folded ? "hidden lg:block" : ""}`}>
            {children}
          </div>

          {footer && (
            <div className={`shrink-0 border-t border-line/10 p-4 ${folded ? "hidden lg:block" : ""}`}>{footer}</div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
