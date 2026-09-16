import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, AtSign, CircleCheck, KeyRound, MailCheck, RefreshCw, ShieldCheck } from "lucide-react";

import { Button, Modal, Notice } from "../components/ui.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { useToast } from "../lib/toast.jsx";
import { vendorApi } from "../lib/vendorApi.js";
import { OtpInput, PasswordInput, PasswordMeter, TextInput } from "./kit.jsx";

const RESEND_SECONDS = 60;

/** Seconds left on a resend cooldown, ticking. Keyed off the server's send time. */
function useCooldown(sentAt) {
  const remaining = () =>
    sentAt ? Math.max(0, Math.ceil(RESEND_SECONDS - (Date.now() - new Date(sentAt).getTime()) / 1000)) : 0;
  const [left, setLeft] = useState(remaining);
  useEffect(() => {
    setLeft(remaining());
    if (!sentAt) return undefined;
    const t = setInterval(() => setLeft(remaining()), 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentAt]);
  return left;
}

/** The moment a code is accepted. A beat of confirmation before the dialog moves on. */
function Success({ title, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="py-6 text-center"
    >
      <motion.span
        initial={{ scale: 0, rotate: -30 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.05 }}
        className="mx-auto grid h-16 w-16 place-items-center rounded-full"
        style={{ background: "rgb(var(--c-state-available) / 0.16)", color: "rgb(var(--c-state-available))" }}
      >
        <CircleCheck size={34} />
      </motion.span>
      <h3 className="mt-4 text-xl font-extrabold tracking-tight">{title}</h3>
      {children && <p className="mx-auto mt-1.5 max-w-xs text-sm text-ink-secondary">{children}</p>}
    </motion.div>
  );
}

/**
 * Entering a six-digit code: the one interaction verification, email
 * change and password reset all share.
 *
 * A wrong code shakes the boxes, clears them and says how many tries are
 * left. "Send a new code" counts down from the server's own send time,
 * so reopening the dialog doesn't reset the wait.
 */
function CodeEntry({ email, submit, resend, sentAt, onSuccess, busyLabel = "Checking…" }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sendingAgain, setSendingAgain] = useState(false);
  const [localSentAt, setLocalSentAt] = useState(sentAt);
  const left = useCooldown(localSentAt);

  useEffect(() => setLocalSentAt(sentAt), [sentAt]);

  const attempt = async (value) => {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submit(value);
      onSuccess(result);
    } catch (err) {
      setError(err.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const again = async () => {
    setSendingAgain(true);
    setError(null);
    try {
      await resend();
      setLocalSentAt(new Date().toISOString());
      setCode("");
    } catch (err) {
      setError(err.message);
      if (err.body?.retryAfterSeconds) {
        setLocalSentAt(new Date(Date.now() - (RESEND_SECONDS - err.body.retryAfterSeconds) * 1000).toISOString());
      }
    } finally {
      setSendingAgain(false);
    }
  };

  return (
    <div>
      <p className="mb-5 text-center text-sm text-ink-secondary">
        We sent a 6-digit code to <span className="font-semibold text-ink-primary">{email}</span>.
        <br />
        It expires in 10 minutes.
      </p>

      <OtpInput value={code} onChange={setCode} onComplete={attempt} disabled={busy} error={error} />

      <div className="mt-4 min-h-[1.5rem] text-center">
        <AnimatePresence mode="wait">
          {busy ? (
            <motion.span key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-sm text-ink-muted">
              {busyLabel}
            </motion.span>
          ) : error ? (
            <motion.span
              key={`err:${error}`}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-sm font-medium text-state-unavailable"
              role="alert"
            >
              {error}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="mt-3 flex items-center justify-center gap-2 text-sm text-ink-muted">
        Didn&rsquo;t get it? Check your spam folder, or
        <button
          type="button"
          onClick={again}
          disabled={left > 0 || sendingAgain}
          className="inline-flex items-center gap-1 font-semibold text-ink-primary underline decoration-[color:var(--color-accent)]
                     decoration-2 underline-offset-[3px] disabled:text-ink-muted disabled:no-underline"
        >
          {sendingAgain && <RefreshCw size={13} className="animate-spin" />}
          {left > 0 ? `send a new one in ${left}s` : "send a new one"}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── verify sign-up email ─────────────────────────── */

/**
 * "Please verify and complete the creation of your account."
 *
 * Opened straight after sign-up, and again at checkout for anyone who
 * chose to verify later. `reason` changes the wording for the second
 * case, where it's standing between them and their order.
 */
export function VerifyEmailModal({ open, onClose, onVerified, reason }) {
  const { account, applySession } = useAccount();
  const toast = useToast();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open) setDone(false);
  }, [open]);

  const checkout = reason === "checkout";

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={done ? ShieldCheck : MailCheck}
      title={checkout ? "Verify your email to place this order" : "Check your email"}
      subtitle={
        done
          ? null
          : checkout
            ? "Orders go to a verified address, since that's where every update about them is sent."
            : "One last step to finish creating your account."
      }
      width="max-w-md"
    >
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <Success key="done" title="Email verified">
            {checkout ? "Placing your order now…" : "Your account is ready."}
          </Success>
        ) : (
          <motion.div key="entry" exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
            <CodeEntry
              email={account?.email}
              sentAt={account?.codePurpose === "signup" ? account.codeSentAt : null}
              submit={async (code) => applySession(await vendorApi.verifyEmail(code))}
              resend={async () => applySession(await vendorApi.resendVerification())}
              onSuccess={(verified) => {
                setDone(true);
                setTimeout(() => {
                  onVerified?.(verified);
                  toast("Email verified");
                }, checkout ? 700 : 1100);
              }}
            />
            {!checkout && (
              <div className="mt-6 border-t border-line/[0.08] pt-4 text-center">
                <button type="button" onClick={onClose} className="text-sm font-medium text-ink-muted transition-colors hover:text-ink-primary">
                  I&rsquo;ll verify later
                </button>
                <p className="mx-auto mt-1 max-w-xs text-xs text-ink-muted">
                  You can explore and configure now. You&rsquo;ll need to verify before placing an order.
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}

/* ─────────────────────────── forgot password ─────────────────────────── */

export function ForgotPasswordModal({ open, onClose, initialEmail = "", onSignedIn }) {
  const { applySession } = useAccount();
  const toast = useToast();
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(null);
  const left = useCooldown(sentAt);

  useEffect(() => {
    if (!open) return;
    setStep("email");
    setEmail(initialEmail);
    setCode("");
    setPassword("");
    setError(null);
    setFields({});
  }, [open, initialEmail]);

  const send = async (e) => {
    e?.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setFields({ email: "Enter the email you signed up with." });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await vendorApi.forgotPassword(email.trim());
      setSentAt(new Date().toISOString());
      setStep("reset");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e) => {
    e.preventDefault();
    const f = {};
    if (code.length !== 6) f.code = "Enter the 6-digit code from the email.";
    if (password.length < 10) f.password = "Use at least 10 characters.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      const account = applySession(await vendorApi.resetPassword(email.trim(), code, password));
      setStep("done");
      setTimeout(() => {
        onSignedIn?.(account);
        toast("Password reset — you're signed in");
      }, 1000);
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
      if (err.status === 401) setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={KeyRound}
      title="Reset your password"
      subtitle={step === "email" ? "We'll email you a code to choose a new one." : null}
      width="max-w-md"
    >
      <AnimatePresence mode="wait" initial={false}>
        {step === "email" && (
          <motion.form key="email" onSubmit={send} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }}>
            <TextInput
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fields.email}
              data-autofocus
            />
            {error && <Notice tone="error" className="mt-4">{error}</Notice>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-5 w-full">
              Send reset code
            </Button>
          </motion.form>
        )}

        {step === "reset" && (
          <motion.form
            key="reset"
            onSubmit={reset}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="mb-5 text-center text-sm text-ink-secondary">
              If <span className="font-semibold text-ink-primary">{email}</span> has an account, a code is on its way.
            </p>
            <OtpInput value={code} onChange={setCode} error={fields.code || (error && !code ? error : null)} />
            {fields.code && <p className="mt-2 text-center text-xs font-medium text-state-unavailable">{fields.code}</p>}

            <PasswordInput
              label="New password"
              autoComplete="new-password"
              className="mt-6"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fields.newPassword || fields.password}
            />
            <PasswordMeter value={password} />

            {error && !fields.newPassword && <Notice tone="error" className="mt-4">{error}</Notice>}

            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-5 w-full">
              Set new password
            </Button>
            <div className="mt-4 flex items-center justify-between text-sm">
              <button type="button" onClick={() => setStep("email")} className="inline-flex items-center gap-1 text-ink-muted hover:text-ink-primary">
                <ArrowLeft size={14} /> Different email
              </button>
              <button
                type="button"
                onClick={() => send()}
                disabled={left > 0 || busy}
                className="font-semibold text-ink-primary disabled:font-medium disabled:text-ink-muted"
              >
                {left > 0 ? `Resend in ${left}s` : "Resend code"}
              </button>
            </div>
          </motion.form>
        )}

        {step === "done" && (
          <Success key="done" title="You're back in">
            Your new password is set and you&rsquo;re signed in.
          </Success>
        )}
      </AnimatePresence>
    </Modal>
  );
}

/* ─────────────────────────── change email ─────────────────────────── */

export function ChangeEmailModal({ open, onClose }) {
  const { account, applySession } = useAccount();
  const toast = useToast();
  const [step, setStep] = useState("form");
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Pick up a change already in progress rather than starting over.
    const pending = account?.pendingEmail;
    setStep(pending ? "code" : "form");
    setNewEmail(pending || "");
    setPassword("");
    setFields({});
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const request = async (e) => {
    e?.preventDefault();
    const f = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail.trim())) f.newEmail = "Enter a valid email address.";
    else if (newEmail.trim().toLowerCase() === account?.email) f.newEmail = "That's already your email.";
    if (!password) f.password = "Enter your password to confirm it's you.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      applySession(await vendorApi.changeEmail(newEmail.trim(), password));
      setStep("code");
    } catch (err) {
      setFields(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={AtSign}
      title="Change your email"
      subtitle={step === "form" ? "We'll send a code to the new address to make sure it's yours." : null}
      width="max-w-md"
    >
      <AnimatePresence mode="wait" initial={false}>
        {step === "form" && (
          <motion.form key="form" onSubmit={request} exit={{ opacity: 0, x: -14 }} transition={{ duration: 0.18 }}>
            <div className="mb-4 rounded-lg bg-bg-panel px-3.5 py-2.5 text-sm">
              <span className="text-ink-muted">Current: </span>
              <span className="font-semibold">{account?.email}</span>
            </div>
            <TextInput
              label="New email"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              error={fields.newEmail}
              data-autofocus
            />
            <PasswordInput
              label="Your password"
              autoComplete="current-password"
              className="mt-4"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fields.password}
            />
            {error && <Notice tone="error" className="mt-4">{error}</Notice>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-5 w-full">
              Send code to new email
            </Button>
            <p className="mt-3 text-center text-xs text-ink-muted">Your current email keeps working until you confirm the new one.</p>
          </motion.form>
        )}

        {step === "code" && (
          <motion.div
            key="code"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <CodeEntry
              email={newEmail}
              sentAt={account?.codePurpose === "email-change" ? account.codeSentAt : null}
              submit={async (code) => applySession(await vendorApi.confirmEmailChange(code))}
              resend={async () => {
                // Resending needs the password again; if we no longer have
                // it (dialog reopened), send them back to the form.
                if (!password) {
                  setStep("form");
                  throw new Error("Enter your password again to send a new code.");
                }
                applySession(await vendorApi.changeEmail(newEmail, password));
              }}
              onSuccess={() => {
                setStep("done");
                setTimeout(() => {
                  onClose();
                  toast("Email changed");
                }, 1300);
              }}
            />
            <div className="mt-5 text-center">
              <button type="button" onClick={() => setStep("form")} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink-primary">
                <ArrowLeft size={14} /> Use a different address
              </button>
            </div>
          </motion.div>
        )}

        {step === "done" && (
          <Success key="done" title="Email changed">
            You&rsquo;ll sign in with {account?.email} from now on. We&rsquo;ve let your old address know.
          </Success>
        )}
      </AnimatePresence>
    </Modal>
  );
}

/* ─────────────────────────── change password ─────────────────────────── */

export function ChangePasswordModal({ open, onClose }) {
  const { applySession } = useAccount();
  const toast = useToast();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ current: "", next: "", confirm: "" });
    setFields({});
    setError(null);
    setDone(false);
  }, [open]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const f = {};
    if (!form.current) f.currentPassword = "Enter your current password.";
    if (form.next.length < 10) f.newPassword = "Use at least 10 characters.";
    if (form.confirm !== form.next) f.confirm = "The new passwords don't match.";
    setFields(f);
    if (Object.keys(f).length) return;

    setBusy(true);
    setError(null);
    try {
      applySession(await vendorApi.changePassword(form.current, form.next));
      setDone(true);
      setTimeout(() => {
        onClose();
        toast("Password changed");
      }, 1400);
    } catch (err) {
      setFields(err.fields || {});
      if (!Object.keys(err.fields || {}).length) setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const matches = form.confirm && form.confirm === form.next;

  return (
    <Modal open={open} onClose={onClose} icon={KeyRound} title="Change your password" width="max-w-md">
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <Success key="done" title="Password changed">
            Any other devices signed in to your account have been signed out.
          </Success>
        ) : (
          <motion.form key="form" onSubmit={submit} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <PasswordInput
              label="Current password"
              autoComplete="current-password"
              value={form.current}
              onChange={set("current")}
              error={fields.currentPassword}
              data-autofocus
            />
            <PasswordInput
              label="New password"
              autoComplete="new-password"
              className="mt-4"
              value={form.next}
              onChange={set("next")}
              error={fields.newPassword}
            />
            <PasswordMeter value={form.next} />
            <PasswordInput
              label="Confirm new password"
              autoComplete="new-password"
              className="mt-4"
              value={form.confirm}
              onChange={set("confirm")}
              error={fields.confirm}
              status={matches ? { tone: "good", text: "Passwords match" } : null}
            />
            {error && <Notice tone="error" className="mt-4">{error}</Notice>}
            <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-5 w-full">
              Change password
            </Button>
            <p className="mt-3 text-center text-xs text-ink-muted">Other devices will be signed out.</p>
          </motion.form>
        )}
      </AnimatePresence>
    </Modal>
  );
}
