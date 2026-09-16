import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Eye, EyeOff, LogOut, Receipt, ShieldCheck, UserRound, ListChecks } from "lucide-react";

import { initialsOf, useAccount } from "../lib/AccountContext.jsx";
import { ROUTES } from "../lib/useHashRoute.js";

/**
 * Small pieces the account screens are built from.
 *
 * Kept together because they share one job — letting someone type
 * credentials and personal details without friction — and none is
 * general enough to belong in components/ui.jsx.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

const CONTROL =
  "mt-1.5 w-full h-11 px-3 rounded-md bg-bg-panel text-ink-primary border transition-colors duration-fast " +
  "ease-out outline-none";

/* ─────────────────────────── text + password ─────────────────────────── */

/**
 * A labelled input whose error or status line sits directly under it.
 * `status` is for live feedback that isn't an error — "Available",
 * "Emails match" — so it can be shown while typing, before the form is
 * submitted, without the red of a mistake.
 */
export function TextInput({ label, optional, hint, error, status, className, inputRef, trailing, ...props }) {
  const id = useId();
  const described = error || status || hint ? `${id}-d` : undefined;
  return (
    <label className={cx("block", className)}>
      <span className="flex items-baseline gap-1.5 text-sm text-ink-secondary">
        {label}
        {optional && <span className="text-xs text-ink-muted">optional</span>}
      </span>
      <span className="relative block">
        <input
          ref={inputRef}
          {...props}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={described}
          className={cx(
            CONTROL,
            trailing && "pr-11",
            error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40"
          )}
        />
        {trailing && <span className="absolute inset-y-0 right-1.5 mt-1.5 flex items-center">{trailing}</span>}
      </span>
      <AnimatePresence initial={false} mode="wait">
        {(error || status || hint) && (
          <motion.span
            key={error ? `e:${error}` : status ? `s:${status.text}` : "h"}
            id={described}
            data-field-error={error ? "" : undefined}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cx(
              "mt-1 flex items-center gap-1 text-xs font-medium",
              error ? "text-state-unavailable" : status?.tone === "good" ? "text-state-available" : "text-ink-muted"
            )}
          >
            {!error && status?.tone === "good" && <Check size={13} strokeWidth={3} />}
            {error || status?.text || hint}
          </motion.span>
        )}
      </AnimatePresence>
    </label>
  );
}

export function PasswordInput(props) {
  const [shown, setShown] = useState(false);
  return (
    <TextInput
      {...props}
      type={shown ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className="grid h-8 w-8 place-items-center rounded-md text-ink-muted transition-colors
                     hover:bg-line/[0.06] hover:text-ink-primary"
        >
          {shown ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      }
    />
  );
}

export function SelectInput({ label, optional, error, className, children, ...props }) {
  return (
    <label className={cx("block", className)}>
      <span className="flex items-baseline gap-1.5 text-sm text-ink-secondary">
        {label}
        {optional && <span className="text-xs text-ink-muted">optional</span>}
      </span>
      <span className="relative block">
        <select
          {...props}
          className={cx(CONTROL, "appearance-none pr-9", error ? "border-state-unavailable/60" : "border-line/10 focus:border-line/40")}
        >
          {children}
        </select>
        <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 mt-[3px] -translate-y-1/2 text-ink-muted" />
      </span>
      {error && <span data-field-error="" className="mt-1 block text-xs font-medium text-state-unavailable">{error}</span>}
    </label>
  );
}

/** Password length, shown as it's typed. Length is the only rule. */
export function PasswordMeter({ value }) {
  const len = value.length;
  const steps = [
    { at: 1, label: "Too short" },
    { at: 10, label: "Long enough" },
    { at: 16, label: "Strong" },
  ];
  const reached = steps.filter((s) => len >= s.at).length;
  if (!len) return null;
  const tone = len >= 16 ? "rgb(var(--c-state-available))" : len >= 10 ? "rgb(var(--c-state-available))" : "rgb(var(--c-state-reserved))";
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 flex-1 rounded-full"
            animate={{ background: i < reached ? tone : "rgb(var(--c-line) / 0.1)" }}
            transition={{ duration: 0.2 }}
          />
        ))}
      </div>
      <span className="w-[5.5rem] text-right text-xs font-medium text-ink-muted">
        {len < 10 ? `${10 - len} more` : steps[reached - 1].label}
      </span>
    </div>
  );
}

/* ─────────────────────────────── OTP ─────────────────────────────── */

/**
 * Six boxes for a six-digit code.
 *
 * Typing advances, Backspace steps back, arrows move, and pasting the
 * whole code into ANY box fills all six — which is how most people
 * actually enter a code, copying it out of the email. Completing the
 * sixth digit submits, so there is no button to hunt for.
 *
 * `autoComplete="one-time-code"` lets iOS and Android offer the code
 * from the message itself.
 */
export function OtpInput({ value, onChange, onComplete, disabled, error, autoFocus = true }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] || "");

  /**
   * The live code, updated synchronously on every keystroke.
   *
   * The handlers must not read `value` from the render they were created
   * in: when digits arrive faster than React re-renders — quick typing, a
   * keyboard's autofill, a password manager — each handler would see the
   * code as it was two keystrokes ago and overwrite the digit before it.
   * Same lesson as the map editor's drag rectangle, held in a ref for the
   * same reason.
   */
  const live = useRef(value);
  useEffect(() => {
    live.current = value;
  }, [value]);

  const focusBox = (i) => refs.current[Math.max(0, Math.min(i, 5))]?.focus();

  useEffect(() => {
    if (autoFocus) focusBox(value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  // A wrong code clears the boxes and puts the cursor back at the start.
  useEffect(() => {
    if (error && !value) focusBox(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, value]);

  const set = (next) => {
    const clean = next.replace(/\D/g, "").slice(0, 6);
    live.current = clean;
    onChange(clean);
    if (clean.length === 6) onComplete?.(clean);
    return clean;
  };

  const handle = (i) => (e) => {
    const v = live.current;
    let typed = e.target.value.replace(/\D/g, "");
    if (!typed) return;
    // Typing over a filled box whose content wasn't selected arrives as
    // "old+new". That's a replacement, not a paste of two digits.
    if (typed.length === 2 && typed[0] === (v[i] || "")) typed = typed[1];

    if (typed.length > 1) {
      const filled = set(v.slice(0, i) + typed);
      focusBox(filled.length);
      return;
    }
    const next = i < v.length ? v.slice(0, i) + typed + v.slice(i + 1) : v + typed;
    set(next);
    focusBox(i + 1);
  };

  const key = (i) => (e) => {
    const v = live.current;
    if (e.key === "Backspace") {
      e.preventDefault();
      if (v[i]) set(v.slice(0, i) + v.slice(i + 1));
      else if (i > 0) {
        set(v.slice(0, i - 1) + v.slice(i));
        focusBox(i - 1);
      }
    } else if (e.key === "ArrowLeft" && i > 0) focusBox(i - 1);
    else if (e.key === "ArrowRight" && i < 5) focusBox(i + 1);
  };

  const paste = (e) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!text) return;
    e.preventDefault();
    focusBox(set(text).length);
  };

  return (
    <motion.div
      className="flex justify-center gap-2 sm:gap-2.5"
      animate={error ? { x: [0, -8, 8, -5, 5, 0] } : { x: 0 }}
      transition={{ duration: 0.36 }}
      role="group"
      aria-label="Six-digit code"
    >
      {digits.map((d, i) => (
        <motion.input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          value={d}
          onChange={handle(i)}
          onKeyDown={key(i)}
          onPaste={paste}
          onFocus={(e) => {
            // Codes are entered in order. Clicking a box past the next
            // empty one moves you back to it, so there can be no gaps.
            if (i > live.current.length) {
              focusBox(live.current.length);
              return;
            }
            e.target.select();
          }}
          disabled={disabled}
          inputMode="numeric"
          // The dialog focuses [data-autofocus] first. Without it, focus
          // went to the dialog's close button — so someone who opened the
          // dialog and started typing their code typed into nothing.
          data-autofocus={autoFocus && i === 0 ? "" : undefined}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={6}
          aria-label={`Digit ${i + 1}`}
          animate={{ scale: d ? 1 : 0.98 }}
          transition={{ type: "spring", stiffness: 500, damping: 26 }}
          className={cx(
            "h-14 w-11 rounded-[14px] border-2 bg-bg-card text-center font-mono text-2xl font-bold text-ink-primary",
            "outline-none transition-colors duration-fast sm:h-16 sm:w-12",
            error
              ? "border-state-unavailable/70"
              : d
                ? "border-line/30"
                : "border-line/12 focus:border-[color:var(--color-accent)]"
          )}
        />
      ))}
    </motion.div>
  );
}

/* ─────────────────────────── terms agreement ─────────────────────────── */

/**
 * "By checking this box…" — agreeing is required, and must be easy.
 *
 * The whole row toggles it: the box AND the sentence. The one exception
 * is the "Terms & Conditions" link, which opens the terms instead and
 * must not tick the box on the way — reading them is not agreeing to
 * them. It stops the click from reaching the row for exactly that reason.
 */
export function AgreeToTerms({ checked, onChange, onOpenTerms, error }) {
  return (
    <div>
      <motion.div
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        animate={error && !checked ? { x: [0, -6, 6, -3, 3, 0] } : { x: 0 }}
        transition={{ duration: 0.34 }}
        className={cx(
          "flex cursor-pointer select-none items-start gap-3 rounded-lg border-2 p-3.5 transition-colors duration-fast",
          checked
            ? "border-[color:var(--color-accent)] bg-[rgb(var(--c-accent)/0.05)]"
            : error
              ? "border-state-unavailable/50"
              : "border-line/10 hover:border-line/25"
        )}
      >
        <span
          className={cx(
            "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border-2 transition-colors duration-fast",
            checked ? "border-transparent" : "border-line/30 bg-bg-card"
          )}
          style={checked ? { background: "var(--color-accent)" } : undefined}
        >
          <AnimatePresence>
            {checked && (
              <motion.span
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0 }}
                transition={{ type: "spring", stiffness: 600, damping: 22 }}
              >
                <Check size={13} strokeWidth={3.5} color="#FFFDF9" />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="text-sm leading-relaxed text-ink-secondary">
          By checking this box and creating an account, I agree to SILLA&rsquo;s{" "}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTerms();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="font-semibold text-ink-primary underline decoration-[color:var(--color-accent)]
                       decoration-2 underline-offset-[3px] hover:opacity-70"
          >
            Terms &amp; Conditions
          </button>
          , and confirm the details I&rsquo;ve given are accurate.
        </span>
      </motion.div>
      <AnimatePresence>
        {error && !checked && (
          <motion.span
            data-field-error=""
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-1.5 block text-xs font-medium text-state-unavailable"
          >
            {error}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────── account menu ─────────────────────────── */

/**
 * The signed-in person, top right, everywhere.
 *
 * Replaces a row of text links ("Orders · Queue · email · Sign out") that
 * grew one item at a time. An unverified account carries a dot on the
 * avatar, because that's the one thing standing between them and
 * placing an order.
 */
export function AccountMenu({ navigate, tone = "light" }) {
  const { account, isSilla, isVerified, signOut } = useAccount();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!account) return null;

  const go = (to) => {
    setOpen(false);
    navigate(to);
  };

  const items = [
    { icon: UserRound, label: "Profile", to: ROUTES.account },
    { icon: Receipt, label: "My orders", to: ROUTES.orders },
    isSilla && { icon: ListChecks, label: "Order queue", to: ROUTES.queue },
  ].filter(Boolean);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-line/[0.06]"
      >
        <span className="relative">
          <span
            className="grid h-8 w-8 place-items-center rounded-full text-[13px] font-bold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            {initialsOf(account)}
          </span>
          {!isVerified && !isSilla && (
            <span
              className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2"
              style={{ background: "rgb(var(--c-state-reserved))", borderColor: "rgb(var(--c-bg-page))" }}
              aria-label="Email not verified"
            />
          )}
        </span>
        <span className={cx("hidden max-w-[10rem] truncate text-[15px] font-semibold sm:inline", tone === "light" && "text-ink-primary")}>
          {account.firstName || account.name}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.18 }}>
          <ChevronDown size={15} className="text-ink-muted" />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[calc(100%+8px)] z-[120] w-64 overflow-hidden rounded-xl border
                       border-line/10 bg-bg-card shadow-lg"
          >
            <div className="border-b border-line/[0.08] px-4 py-3">
              <div className="truncate font-bold">{account.name}</div>
              <div className="truncate text-sm text-ink-muted">{account.email}</div>
              {!isSilla && (
                <div
                  className="mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
                  style={
                    isVerified
                      ? { background: "rgb(var(--c-state-available) / 0.14)", color: "rgb(var(--c-state-available))" }
                      : { background: "rgb(var(--c-state-reserved) / 0.16)", color: "rgb(var(--c-state-reserved))" }
                  }
                >
                  <ShieldCheck size={12} />
                  {isVerified ? "Verified" : "Email not verified"}
                </div>
              )}
            </div>
            <div className="p-1.5">
              {items.map(({ icon: Icon, label, to }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => go(to)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium
                             transition-colors hover:bg-line/[0.06]"
                >
                  <Icon size={16} className="text-ink-muted" />
                  {label}
                </button>
              ))}
            </div>
            <div className="border-t border-line/[0.08] p-1.5">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  signOut();
                  navigate(ROUTES.home);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium
                           transition-colors hover:bg-line/[0.06]"
              >
                <LogOut size={16} className="text-ink-muted" />
                Sign out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
