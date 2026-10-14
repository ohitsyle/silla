import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";

import { Button, Notice } from "../components/ui.jsx";
import Chair from "../marketing/Chair.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { hasPending } from "../lib/pendingConfiguration.js";
import { peekIntent } from "../lib/entryIntent.js";
import { vendorApi } from "../lib/vendorApi.js";
import { AgreeToTerms, PasswordInput, PasswordMeter, SelectInput, TextInput } from "./kit.jsx";
import { ForgotPasswordModal, VerifyEmailModal } from "./modals.jsx";
import { TermsModal } from "./Terms.jsx";

/**
 * Sign in or sign up — one screen, two tabs.
 *
 * Splitting them across two pages means someone who picked wrong has to
 * find the other one; the tabs swap in place and carry the email across.
 *
 * Sign-up asks for exactly what an order needs and no more. It creates
 * the account signed in but UNVERIFIED and opens the code dialog; the
 * person can verify now or later. Only placing an order waits on it.
 *
 * Errors follow the configurator's rule: revealed when you press the
 * button, never thrown at you before you've typed. The two exceptions are
 * live statuses you'd want while typing — whether the email is already
 * taken, and whether the two emails match — and those appear only once
 * there's something to say.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];

/** Where someone goes after signing in, in order of what they were doing. */
function destinationFor(account, redirectTo) {
  if (hasPending() || peekIntent()) return ROUTES.configure;
  if (redirectTo) return redirectTo;
  // SILLA staff start at their work; everyone else goes home.
  return account?.role === "silla" ? ROUTES.staff : ROUTES.home;
}

/* ─────────────────────────────── sign in ─────────────────────────────── */

function SignInForm({ email, setEmail, onDone, onForgot }) {
  const { signIn } = useAccount();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const f = {};
    if (!EMAIL_RE.test(email.trim())) f.email = "Enter your email address.";
    if (!password) f.password = "Enter your password.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      onDone(await signIn(email.trim(), password));
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <TextInput
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fields.email}
      />
      <div className="mt-4">
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onForgot}
            className="text-sm font-semibold text-ink-secondary underline decoration-line/20 underline-offset-4
                       transition-colors hover:text-ink-primary hover:decoration-[color:var(--color-accent)]"
          >
            Forgot password?
          </button>
        </div>
      </div>

      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <Notice tone="error" className="mt-3">{error}</Notice>
          </motion.div>
        )}
      </AnimatePresence>

      <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-6 w-full">
        Sign in
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}

/* ─────────────────────────────── sign up ─────────────────────────────── */

/**
 * Whether an email is free to use, checked while it's typed.
 * Debounced, and only asks once the address looks complete, so it
 * doesn't fire a request per keystroke or complain about "ana@".
 */
function useEmailAvailability(email) {
  const [state, setState] = useState({ status: "idle" });
  const seq = useRef(0);

  useEffect(() => {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setState({ status: "idle" });
      return undefined;
    }
    const mine = ++seq.current;
    setState({ status: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await vendorApi.emailAvailable(value);
        if (mine !== seq.current) return;
        setState({ status: res.available ? "available" : "taken" });
      } catch {
        // A failed check says nothing either way; register will still
        // answer authoritatively on submit.
        if (mine === seq.current) setState({ status: "idle" });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [email]);

  return state.status;
}

function SignUpForm({ email, setEmail, onCreated, onSwitchToSignIn, onOpenTerms, agreed, setAgreed }) {
  const { signUp } = useAccount();
  const [form, setForm] = useState({ firstName: "", middleName: "", lastName: "", suffix: "", confirmEmail: "", password: "" });
  const [fields, setFields] = useState({});
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const availability = useEmailAvailability(email);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const validate = () => {
    const f = {};
    if (!form.firstName.trim()) f.firstName = "Enter your first name.";
    if (!form.lastName.trim()) f.lastName = "Enter your last name.";
    if (!EMAIL_RE.test(email.trim())) f.email = "Enter a valid email address.";
    else if (availability === "taken") f.email = "An account with this email already exists.";
    if (!form.confirmEmail.trim()) f.confirmEmail = "Type your email again to confirm it.";
    else if (form.confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()) f.confirmEmail = "The two emails don't match.";
    if (form.password.length < 10) f.password = "Use at least 10 characters.";
    if (!agreed) f.acceptTerms = "You need to agree to the Terms & Conditions to create an account.";
    return f;
  };

  // Once revealed, errors track the form — fixing a field clears its
  // message. A server error stays until something is edited, which is
  // also exactly when it stops being true.
  useEffect(() => {
    if (revealed) setFields(validate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, email, agreed, availability]);

  const submit = async (e) => {
    e.preventDefault();
    setRevealed(true);
    const f = validate();
    setFields(f);
    if (Object.keys(f).length) {
      requestAnimationFrame(() =>
        document.querySelector("[data-field-error]")?.scrollIntoView({ behavior: "smooth", block: "center" })
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const account = await signUp({
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        lastName: form.lastName.trim(),
        suffix: form.suffix,
        email: email.trim(),
        confirmEmail: form.confirmEmail.trim(),
        password: form.password,
        acceptTerms: agreed,
      });
      onCreated(account);
    } catch (err) {
      if (Object.keys(err.fields || {}).length) setFields(err.fields);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Live statuses: shown while typing, before any submit.
  const emailStatus =
    fields.email
      ? null
      : availability === "checking"
        ? { tone: "muted", text: "Checking…" }
        : availability === "available"
          ? { tone: "good", text: "Available" }
          : null;
  const emailTaken = availability === "taken";
  const confirmLive =
    !fields.confirmEmail && form.confirmEmail && EMAIL_RE.test(email.trim())
      ? form.confirmEmail.trim().toLowerCase() === email.trim().toLowerCase()
        ? { tone: "good", text: "Emails match" }
        : form.confirmEmail.length >= email.length
          ? { tone: "muted", text: "Doesn't match yet" }
          : null
      : null;

  return (
    <form onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label="First name" autoComplete="given-name" autoFocus value={form.firstName} onChange={set("firstName")} error={fields.firstName} />
        <TextInput label="Middle name" optional autoComplete="additional-name" value={form.middleName} onChange={set("middleName")} />
        <TextInput label="Last name" autoComplete="family-name" value={form.lastName} onChange={set("lastName")} error={fields.lastName} />
        <SelectInput label="Suffix" optional value={form.suffix} onChange={set("suffix")} error={fields.suffix}>
          <option value="">None</option>
          {SUFFIXES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </SelectInput>
      </div>

      <div className="mt-4">
        <TextInput
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email && !emailTaken ? fields.email : null}
          status={emailStatus}
          trailing={
            availability === "checking" ? (
              <LoaderCircle size={16} className="mr-2 animate-spin text-ink-muted" />
            ) : null
          }
        />
        <AnimatePresence>
          {emailTaken && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div
                data-field-error={fields.email ? "" : undefined}
                className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-sm"
                style={{ background: "rgb(var(--c-state-reserved) / 0.12)" }}
              >
                <span className="text-ink-primary">An account with this email already exists.</span>
                <button
                  type="button"
                  onClick={onSwitchToSignIn}
                  className="font-bold underline decoration-[color:var(--color-accent)] decoration-2 underline-offset-[3px]"
                >
                  Sign in instead
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <TextInput
        label="Confirm email"
        type="email"
        autoComplete="off"
        className="mt-4"
        value={form.confirmEmail}
        onChange={set("confirmEmail")}
        onPaste={(e) => {
          // Pasting the address you just typed defeats the point of
          // typing it twice — a typo in the first copies straight over.
          e.preventDefault();
        }}
        error={fields.confirmEmail}
        status={confirmLive}
      />

      <div className="mt-4">
        <PasswordInput
          label="Password"
          autoComplete="new-password"
          value={form.password}
          onChange={set("password")}
          error={fields.password}
          hint={!fields.password && !form.password ? "At least 10 characters. A long phrase beats a short complicated one." : null}
        />
        <PasswordMeter value={form.password} />
      </div>

      <div className="mt-5">
        <AgreeToTerms checked={agreed} onChange={setAgreed} onOpenTerms={onOpenTerms} error={fields.acceptTerms} />
      </div>

      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <Notice tone="error" className="mt-4">{error}</Notice>
          </motion.div>
        )}
      </AnimatePresence>

      <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-6 w-full">
        Create account
        <ArrowRight size={16} />
      </Button>
    </form>
  );
}

/* ─────────────────────────────── screen ─────────────────────────────── */

const TABS = [
  { key: "signIn", label: "Sign in" },
  { key: "signUp", label: "Sign up" },
];

export default function AuthScreen({ mode: routeMode, navigate, redirectTo }) {
  const { account } = useAccount();
  const [mode, setMode] = useState(routeMode === "signUp" ? "signUp" : "signIn");
  const [email, setEmail] = useState("");
  const [forgotOpen, setForgotOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);

  useEffect(() => {
    setMode(routeMode === "signUp" ? "signUp" : "signIn");
  }, [routeMode]);

  const switchTo = (next) => {
    setMode(next);
    // Keep the address bar honest, but only when this IS the auth route —
    // on a guarded page that bounced here, the hash is where they return.
    if (!redirectTo) navigate(next === "signUp" ? ROUTES.signUp : ROUTES.signIn, { replace: true });
  };

  const finish = (signedIn) => navigate(destinationFor(signedIn || account, redirectTo), { replace: true });

  const pending = hasPending();

  return (
    <div className="silla-marketing min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* ── the brand side ── */}
      <aside
        className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12"
        style={{ background: "linear-gradient(160deg, rgb(var(--c-bg-page-end)), rgb(var(--c-accent) / 0.16))" }}
      >
        <button
          type="button"
          onClick={() => navigate(ROUTES.home)}
          className="flex w-fit items-center gap-2.5 text-xl font-extrabold tracking-tight transition-opacity hover:opacity-70"
        >
          <span className="grid h-9 w-9 place-items-center rounded-[11px] text-sm" style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}>
            S
          </span>
          SILLA
        </button>

        <div>
          <div className="mb-9 grid w-fit grid-cols-4 gap-3">
            {["free", "free", "held", "taken", "free", "taken", "free", "free"].map((state, i) => (
              <Chair key={i} state={state} size={54} delay={0.1 + i * 0.05} wiggle={i === 2} />
            ))}
          </div>
          <h2 className="display max-w-md text-[clamp(2.4rem,3.6vw,3.4rem)]">
            {mode === "signUp" ? "Save yourself a seat." : "Your seat's still here."}
          </h2>
          <p className="mt-4 max-w-sm text-lg leading-relaxed text-ink-secondary">
            {mode === "signUp"
              ? "An account keeps what you configure, so you can leave a system half-built and come back to it from anywhere."
              : "Sign in to pick up your configurations and see where your orders are."}
          </p>
        </div>

        <p className="text-sm text-ink-muted">Space Intelligence &amp; Live Layout Administration</p>
      </aside>

      {/* ── the form side ── */}
      <main className="flex min-h-screen flex-col px-6 py-10 sm:px-10 lg:min-h-0 lg:justify-center lg:py-12">
        <div className="mx-auto w-full max-w-[30rem]">
          <button
            type="button"
            onClick={() => navigate(ROUTES.home)}
            className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink-primary"
          >
            <ArrowLeft size={15} />
            Back to the site
          </button>

          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.h1
                key={mode}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
                className="display text-[clamp(2rem,5vw,2.75rem)]"
              >
                {mode === "signUp" ? "Create your account" : "Welcome back"}
              </motion.h1>
            </AnimatePresence>
            <p className="mt-2.5 text-ink-secondary">
              {pending
                ? "Your configuration is waiting — we'll take you straight back to it."
                : mode === "signUp"
                  ? "It takes a minute. You can explore before you verify."
                  : "Sign in to your SILLA account."}
            </p>

            {/* Tabs, with a marker that slides between them. */}
            <LayoutGroup>
              <div role="tablist" aria-label="Account" className="mt-7 grid grid-cols-2 rounded-full bg-bg-panel p-1">
                {TABS.map((tab) => {
                  const active = tab.key === mode;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => switchTo(tab.key)}
                      className="relative h-10 rounded-full text-sm font-bold transition-colors"
                      style={{ color: active ? "var(--color-ink-primary)" : "var(--color-ink-muted)" }}
                    >
                      {active && (
                        <motion.span
                          layoutId="auth-tab"
                          className="absolute inset-0 rounded-full bg-bg-card shadow-sm"
                          transition={{ type: "spring", stiffness: 480, damping: 38 }}
                        />
                      )}
                      <span className="relative">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </LayoutGroup>

            <div className="mt-6 rounded-xl border border-line/10 bg-bg-card p-6 shadow-md sm:p-7">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={mode}
                  initial={{ opacity: 0, x: mode === "signUp" ? 18 : -18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: mode === "signUp" ? -18 : 18 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  {mode === "signIn" ? (
                    <SignInForm email={email} setEmail={setEmail} onDone={finish} onForgot={() => setForgotOpen(true)} />
                  ) : (
                    <SignUpForm
                      email={email}
                      setEmail={setEmail}
                      agreed={agreed}
                      setAgreed={setAgreed}
                      onOpenTerms={() => setTermsOpen(true)}
                      onSwitchToSignIn={() => switchTo("signIn")}
                      onCreated={() => setVerifyOpen(true)}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <p className="mt-5 text-center text-sm text-ink-secondary">
              {mode === "signUp" ? "Already have an account? " : "New to SILLA? "}
              <button
                type="button"
                onClick={() => switchTo(mode === "signUp" ? "signIn" : "signUp")}
                className="font-bold text-ink-primary underline decoration-[color:var(--color-accent)] decoration-2 underline-offset-4 hover:opacity-70"
              >
                {mode === "signUp" ? "Sign in" : "Create an account"}
              </button>
            </p>
          </motion.div>
        </div>
      </main>

      <ForgotPasswordModal
        open={forgotOpen}
        onClose={() => setForgotOpen(false)}
        initialEmail={email}
        onSignedIn={(signedIn) => {
          setForgotOpen(false);
          finish(signedIn);
        }}
      />
      <TermsModal open={termsOpen} onClose={() => setTermsOpen(false)} onAgree={() => setAgreed(true)} agreed={agreed} />
      <VerifyEmailModal
        open={verifyOpen}
        onClose={() => {
          // "I'll verify later" — the account exists and is signed in.
          setVerifyOpen(false);
          finish();
        }}
        onVerified={(verified) => {
          setVerifyOpen(false);
          finish(verified);
        }}
      />
    </div>
  );
}
