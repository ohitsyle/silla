import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
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
 * place, and the two are visible at once. Below `lg` there is no room
 * for two columns, so it becomes a bottom sheet — still overlaying
 * rather than displacing, which is the property that matters.
 *
 * Not a dialog: it does not trap focus or block the page, because you
 * are meant to keep clicking seats while it is open and watch it follow
 * your selection. Escape still closes it, since that is what Escape
 * means everywhere else in the app.
 */
export default function Inspector({ open, onClose, title, subtitle, children, footer }) {
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Only below lg, where the sheet overlaps the content. */}
          <motion.div
            className="lg:hidden fixed inset-0 z-30 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            onClick={onClose}
          />

          <motion.aside
            aria-label={typeof title === "string" ? title : "Details"}
            className="
              fixed inset-x-0 bottom-0 z-40 max-h-[80vh] rounded-t-xl border-t border-line/12
              lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:h-full lg:w-[360px] lg:shrink-0
              lg:rounded-none lg:border-t-0 lg:border-l
              flex flex-col overflow-hidden bg-bg-card shadow-lg lg:shadow-none
            "
            initial={reduced ? { opacity: 0 } : { y: "100%" }}
            animate={reduced ? { opacity: 1 } : { y: 0 }}
            exit={reduced ? { opacity: 0 } : { y: "100%" }}
            transition={{ duration: DURATION.base, ease: EASE_OUT }}
            // The slide-from-below is right for the sheet; on the desktop
            // column a vertical slide would look like the panel fell in,
            // so the transform is neutralised there by the static layout.
            style={{ willChange: "transform" }}
          >
            <div className="flex items-start gap-3 border-b border-line/10 p-4">
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-semibold leading-tight">{title}</h2>
                {subtitle && <p className="mt-0.5 text-sm text-ink-secondary">{subtitle}</p>}
              </div>
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

            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

            {footer && <div className="shrink-0 border-t border-line/10 p-4">{footer}</div>}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
