import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";

/**
 * Brief confirmations — "Saved", "Email verified", "Password changed".
 *
 * A save that changes nothing visible on screen needs to SAY it worked,
 * or people press the button again. Announced to screen readers through
 * a polite live region, and never used for errors that need action —
 * those stay next to the thing that caused them.
 */
const ToastContext = createContext(null);

const ICON = { success: CircleCheck, info: Info, error: TriangleAlert };
const TONE = {
  success: "rgb(var(--c-state-available))",
  info: "var(--color-accent)",
  error: "rgb(var(--c-state-unavailable))",
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const toast = useCallback((message, { tone = "success", duration = 3200 } = {}) => {
    const id = ++seq.current;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), duration);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-5 z-[300] flex flex-col items-center gap-2 px-4"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ICON[t.tone] || Info;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-line/10
                           bg-bg-card px-4 py-2.5 text-sm font-semibold shadow-lg"
              >
                <Icon size={17} style={{ color: TONE[t.tone] }} />
                {t.message}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx.toast;
}
