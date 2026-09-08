import { motion } from "framer-motion";
import { DURATION, EASE_OUT, listContainer, listItem } from "../lib/motion.js";
import FloorBackdrop from "./FloorBackdrop.jsx";

/**
 * AuthShell — the frame shared by every gate screen (sign in, terms,
 * PIN change). They were three subtly different layouts before; a person
 * moving between them should feel like they're in one product.
 *
 * Deliberately has no navigation: these screens exist to stop you, and
 * offering a way around them would defeat the point.
 *
 * The composition is doing real work here. This is the first thing
 * anyone sees, and it used to be a small card centred in an empty field
 * — the layout equivalent of a shrug. Now the page carries a floor-plan
 * backdrop (the product's own motif, in the buyer's own palette), the
 * card sits on it with actual elevation, and the header, body and
 * footer arrive in sequence rather than all at once. Nothing moves that
 * doesn't need to, and all of it stops under prefers-reduced-motion.
 */
export default function AuthShell({ icon: Icon, title, subtitle, children, footer, width = "max-w-sm" }) {
  return (
    <div className="relative min-h-screen overflow-hidden text-ink-primary">
      <FloorBackdrop />

      <div className="relative flex min-h-screen flex-col items-center justify-center px-6 py-12">
        <motion.div {...listContainer(0.07)} className={`w-full ${width}`}>
          <motion.div {...listItem()} className="mb-7 flex items-center gap-3">
            <motion.div
              initial={{ scale: 0.86, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: DURATION.slow, ease: EASE_OUT }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-ink)",
                // A tinted glow rather than a black drop shadow: on a dark
                // ground a black shadow is invisible, so the mark looked
                // pasted on instead of lit.
                boxShadow: "0 8px 28px -8px rgb(var(--c-accent) / 0.55)",
              }}
            >
              <Icon size={22} />
            </motion.div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight tracking-tight">{title}</h1>
              {subtitle && <p className="mt-0.5 text-sm text-ink-secondary">{subtitle}</p>}
            </div>
          </motion.div>

          <motion.div {...listItem()}>{children}</motion.div>

          {footer && (
            <motion.div {...listItem()} className="mt-5 text-center text-xs text-ink-muted">
              {footer}
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
