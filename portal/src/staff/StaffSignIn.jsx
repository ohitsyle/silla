import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, LockKeyhole, MailOpen } from "lucide-react";

import { Button, Notice } from "../components/ui.jsx";
import { OtpInput, PasswordInput, PasswordMeter, TextInput } from "../account/kit.jsx";
import { ForgotPasswordModal } from "../account/modals.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { staffApi } from "../lib/staffApi.js";
import { ROUTES } from "../lib/useHashRoute.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NOT_STAFF = "This entrance is for SILLA staff. Customers sign in from the storefront.";

/**
 * Where SILLA staff sign in: #/staff/sign-in — and, at
 * #/staff/sign-in/invitation (the link every invitation email carries),
 * where someone an owner invited sets their password with the code.
 *
 * The same account system as buyers (one login, one session — see
 * CLAUDE.md), but its own door. A buyer who signs in here is told this is
 * the staff entrance and signed straight back out, rather than being
 * dropped into a console that would refuse them section by section.
 *
 * Accepting an invitation mints no session itself: it sets the password,
 * and the ordinary sign-in then runs with it, so there is still exactly
 * one place that issues a token.
 */
export default function StaffSignIn({ navigate, mode = null }) {
  const invitation = mode === "invitation";
  return (
    <div className="silla-marketing grid min-h-screen place-items-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <div className="mb-8 flex items-center gap-2.5">
          <span
            className="grid h-9 w-9 place-items-center rounded-[11px] text-sm font-extrabold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            S
          </span>
          <span className="text-xl font-extrabold tracking-tight">SILLA</span>
          <span className="rounded-full bg-line/[0.07] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
            Staff
          </span>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={invitation ? "invitation" : "sign-in"}
            initial={{ opacity: 0, x: invitation ? 16 : -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: invitation ? -16 : 16 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {invitation ? <AcceptInvitation navigate={navigate} /> : <SignIn navigate={navigate} />}
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          onClick={() => navigate(ROUTES.home)}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink-primary"
        >
          <ArrowLeft size={15} /> Back to the storefront
        </button>
      </motion.div>
    </div>
  );
}

function SignIn({ navigate }) {
  const { signIn, signOut } = useAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const f = {};
    if (!EMAIL_RE.test(email.trim())) f.email = "Enter your SILLA email address.";
    if (!password) f.password = "Enter your password.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      const account = await signIn(email.trim(), password);
      if (account?.role !== "silla") {
        signOut();
        setError(NOT_STAFF);
        setPassword("");
        return;
      }
      navigate(ROUTES.staff, { replace: true });
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="display text-[2rem]">Staff sign in</h1>
      <p className="mt-2 text-ink-secondary">Orders, clients, conversations and deployments.</p>

      <form onSubmit={submit} noValidate className="mt-8 rounded-2xl border border-line/[0.08] bg-bg-card p-6 shadow-sm">
        <TextInput
          label="Email"
          type="email"
          autoComplete="username"
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
              onClick={() => setForgot(true)}
              className="text-sm font-semibold text-ink-secondary underline decoration-line/20 underline-offset-4 hover:text-ink-primary"
            >
              Forgot password?
            </button>
          </div>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <Notice tone="error" className="mt-3">
                {error}
              </Notice>
            </motion.div>
          )}
        </AnimatePresence>

        <Button type="submit" variant="primary" size="lg" icon={LockKeyhole} loading={busy} className="mt-5 w-full">
          Sign in
        </Button>
      </form>

      <button
        type="button"
        onClick={() => navigate(`${ROUTES.staffSignIn}/invitation`, { replace: true })}
        className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-dashed border-line/15 px-4 py-3 text-left transition-colors hover:border-line/30"
      >
        <MailOpen size={18} className="shrink-0 text-ink-muted" />
        <span className="text-sm">
          <span className="font-semibold text-ink-primary">I have an invitation</span>
          <span className="block text-ink-secondary">Set your password with the code an owner sent you.</span>
        </span>
      </button>

      <ForgotPasswordModal
        open={forgot}
        onClose={() => setForgot(false)}
        initialEmail={email}
        onSignedIn={(account) => {
          setForgot(false);
          if (account?.role === "silla") navigate(ROUTES.staff, { replace: true });
          else {
            signOut();
            setError(NOT_STAFF);
          }
        }}
      />
    </>
  );
}

/**
 * The invited person proves the inbox with the emailed code and chooses a
 * password; then they are signed in like anyone else. The code works once,
 * for three days; only the owner who invited them can send another, which
 * is what every failure here says.
 */
function AcceptInvitation({ navigate }) {
  const { signIn, signOut } = useAccount();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    const f = {};
    if (!EMAIL_RE.test(email.trim())) f.email = "Enter the address the invitation was sent to.";
    if (!/^\d{6}$/.test(code)) f.code = "Enter the six-digit code from the invitation.";
    if (password.length < 10) f.password = "Use at least 10 characters.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      await staffApi.acceptInvitation({ email: email.trim(), code, password });
      const account = await signIn(email.trim(), password);
      if (account?.role !== "silla") {
        signOut();
        setError(NOT_STAFF);
        return;
      }
      navigate(ROUTES.staff, { replace: true });
    } catch (err) {
      if (err.fields?.password) setFields({ password: err.fields.password });
      else if (err.status === 401) {
        setCode("");
        setFields({ code: err.message });
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="display text-[2rem]">Accept your invitation</h1>
      <p className="mt-2 text-ink-secondary">Enter the code from your invitation email and choose a password.</p>

      <form onSubmit={submit} noValidate className="mt-8 rounded-2xl border border-line/[0.08] bg-bg-card p-6 shadow-sm">
        <TextInput
          label="Your work email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <div className="mt-5">
          <span className="text-sm text-ink-secondary">Invitation code</span>
          <div className="mt-2">
            <OtpInput value={code} onChange={setCode} error={fields.code} autoFocus={false} />
          </div>
          {fields.code && (
            <span data-field-error="" className="mt-2 block text-center text-xs font-medium text-state-unavailable">
              {fields.code}
            </span>
          )}
        </div>
        <div className="mt-5">
          <PasswordInput
            label="Choose a password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fields.password}
          />
          <PasswordMeter value={password} />
        </div>

        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              <Notice tone="error" className="mt-4">
                {error}
              </Notice>
            </motion.div>
          )}
        </AnimatePresence>

        <Button type="submit" variant="primary" size="lg" icon={KeyRound} loading={busy} className="mt-5 w-full">
          Set password and sign in
        </Button>
      </form>

      <button
        type="button"
        onClick={() => navigate(ROUTES.staffSignIn, { replace: true })}
        className="mt-4 text-sm font-semibold text-ink-secondary underline decoration-line/20 underline-offset-4 hover:text-ink-primary"
      >
        Already set your password? Sign in
      </button>
    </>
  );
}
