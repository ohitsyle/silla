import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, KeyRound, MailCheck } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import { Button, Card, Field, Loading, Notice, PinField } from "../components/ui/index.jsx";

/**
 * "Forgot PIN?" — AUTH-4's reset, end to end: ask for a code, enter it
 * with a new PIN, and be signed in (spec §5: "Reset flow via email; New
 * PIN set and usable").
 *
 * Lives at /login/reset, under the sign-in page's own address, so it is
 * part of every organization at /<slug>/login/reset without becoming a
 * new top-level word that an organization's address could collide with
 * (lib/orgAddress.js).
 *
 * Two rules from the server shape the wording:
 *   - asking for a code answers the same whether or not the address has
 *     an account, so this page never says which — "if it has an account
 *     here, a code is on its way";
 *   - a reset also clears a lockout (AUTH-2), so this is the way back in
 *     for someone locked out by wrong PINs, and the sign-in page sends
 *     them here.
 *
 * Errors are revealed when the person submits, never before; each field
 * says what is wrong with it rather than one notice for the lot.
 */

const STEP = { REQUEST: "request", RESET: "reset" };
const RESEND_AFTER_S = 30;

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const wait = (body) => {
  const seconds = body?.retryAfterSeconds;
  return seconds ? ` in ${Math.max(1, Math.ceil(seconds / 60))} minute${Math.ceil(seconds / 60) === 1 ? "" : "s"}` : " shortly";
};

export default function ResetPinPage() {
  const { org, organizationId } = useOrg();
  const { login, isAuthenticated, booting } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;

  const [step, setStep] = useState(STEP.REQUEST);
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [devCode, setDevCode] = useState(null);
  const [resendIn, setResendIn] = useState(0);
  const [resent, setResent] = useState(false);

  const expiryMinutes = org?.policy?.verificationCodeExpiryMinutes ?? 10;

  // "Send a new code" waits a moment after each send: inboxes are slow,
  // and a second code makes the first one useless.
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  if (booting) return <Loading className="min-h-screen" />;
  // Signed in already: there is nothing to recover. (Changing a PIN you
  // know is /change-pin.)
  if (isAuthenticated) return <Navigate to={from || "/map"} replace />;

  const sendCode = async ({ again = false } = {}) => {
    const trimmed = email.trim();
    if (!trimmed) return setErrors({ email: "Enter the email address you sign in with." });
    if (!looksLikeEmail(trimmed)) return setErrors({ email: "That doesn't look like an email address." });
    setErrors({});
    setProblem(null);
    setBusy(true);
    try {
      const answer = await api.requestPinReset(organizationId, trimmed);
      setDevCode(answer.devResetCode || null);
      setStep(STEP.RESET);
      setResendIn(RESEND_AFTER_S);
      setResent(again);
      if (again) setCode("");
    } catch (err) {
      setProblem(err.status === 429 ? `Too many attempts. Try again${wait(err.details)}.` : err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e) => {
    e.preventDefault();
    const found = {};
    if (!/^\d{6}$/.test(code)) found.code = "Enter the 6-digit code from the email.";
    if (newPin.length !== 6) found.newPin = "Choose a 6-digit PIN.";
    else if (confirmPin !== newPin) found.confirmPin = "The two PINs don't match.";
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      await api.resetPin(organizationId, email.trim(), code, newPin);
    } catch (err) {
      setBusy(false);
      if (err.status === 429) return setProblem(`Too many attempts. Try again${wait(err.details)}.`);
      if (err.status === 410) return setErrors({ code: "That code has expired. Send a new one below." });
      if (err.status === 400 && /PIN/.test(err.message)) return setErrors({ newPin: err.message });
      // 400 (no code for that address) and 401 (wrong code) read the same:
      // saying which would tell a stranger whether the address has an account.
      if (err.status === 400 || err.status === 401) {
        return setErrors({ code: "That code isn't right. Check the email, or send a new code." });
      }
      return setProblem(err.message); // unreachable, or the server's own trouble
    }

    // The PIN is set. Signing in with it is the last step of the reset,
    // so nobody has to type it again on the page they came from.
    try {
      const user = await login(email.trim(), newPin);
      if (user.mustChangePin) navigate("/change-pin", { replace: true, state: { from } });
      else if (user.requiresTermsAcceptance) navigate("/terms", { replace: true, state: { from } });
      else navigate(from || "/map", { replace: true });
    } catch (err) {
      setBusy(false);
      setProblem(
        err.status === 403 && err.body?.requiresVerification
          ? "Your new PIN is set, but this account isn't verified yet. Finish registration at the kiosk to sign in."
          : "Your new PIN is set. Sign in with it to continue."
      );
    }
  };

  const requesting = step === STEP.REQUEST;

  return (
    <AuthShell
      icon={requesting ? KeyRound : MailCheck}
      title={requesting ? "Reset your PIN" : "Check your email"}
      subtitle={
        requesting
          ? `We'll email you a code to set a new one${org?.name ? ` for ${org.name}` : ""}.`
          : `If ${email.trim()} has an account here, a 6-digit code is on its way. It expires in ${expiryMinutes} minutes.`
      }
      footer={
        <Link
          to="/login"
          state={{ from }}
          className="inline-flex items-center gap-1.5 text-ink-secondary underline-offset-2 hover:text-ink-primary hover:underline"
        >
          <ArrowLeft size={13} />
          Back to sign in
        </Link>
      }
    >
      <Card elevation="floating">
        {requesting ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
            className="space-y-4"
          >
            <Field
              label="Email"
              type="email"
              name="email"
              autoComplete="email"
              autoFocus
              value={email}
              error={errors.email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors({});
              }}
            />
            {problem && <Notice tone="error">{problem}</Notice>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              Email me a code
            </Button>
          </form>
        ) : (
          <form noValidate onSubmit={reset} className="space-y-4">
            {devCode && (
              // Only ever present where no mail provider is configured and
              // the server is not in production — the same rule the kiosk's
              // registration code follows.
              <div className="rounded-lg border border-line/10 bg-bg-panel px-3 py-2 text-xs text-ink-muted">
                Dev mode — no email provider configured. Code:{" "}
                <span className="font-mono tracking-widest text-ink-primary">{devCode}</span>
              </div>
            )}
            {resent && !errors.code && <Notice tone="success">A new code is on its way. Use the newest one.</Notice>}

            <Field
              label="Code from the email"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              error={errors.code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                if (errors.code) setErrors(({ code: _ignored, ...rest }) => rest);
              }}
              inputClassName="font-mono text-lg tracking-[0.45em] text-center"
            />
            <PinField label="New PIN" name="newPin" value={newPin} onChange={setNewPin} error={errors.newPin} />
            <PinField
              label="Confirm new PIN"
              name="confirmPin"
              value={confirmPin}
              onChange={setConfirmPin}
              error={errors.confirmPin}
            />

            {problem && <Notice tone="error">{problem}</Notice>}

            <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
              Set PIN and sign in
            </Button>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs">
              <button
                type="button"
                onClick={() => sendCode({ again: true })}
                disabled={busy || resendIn > 0}
                className="rounded-sm text-ink-secondary transition-colors duration-fast hover:text-ink-primary
                           disabled:text-ink-muted"
              >
                {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep(STEP.REQUEST);
                  setErrors({});
                  setProblem(null);
                  setCode("");
                  setDevCode(null);
                  setResent(false);
                }}
                className="rounded-sm text-ink-secondary transition-colors duration-fast hover:text-ink-primary"
              >
                Use a different email
              </button>
            </div>
          </form>
        )}
      </Card>
    </AuthShell>
  );
}
