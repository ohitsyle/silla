import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, LockKeyhole } from "lucide-react";

import { Button, Notice } from "../components/ui.jsx";
import { PasswordInput, TextInput } from "../account/kit.jsx";
import { ForgotPasswordModal } from "../account/modals.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { ROUTES } from "../lib/useHashRoute.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Where SILLA staff sign in: #/staff/sign-in.
 *
 * The same account system as buyers (one login, one session — see
 * CLAUDE.md), but its own door. A buyer who signs in here is told this is
 * the staff entrance and signed straight back out, rather than being
 * dropped into a console that would refuse them section by section.
 */
export default function StaffSignIn({ navigate }) {
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
        setError("This entrance is for SILLA staff. Customers sign in from the storefront.");
        setPassword("");
        return;
      }
      navigate(ROUTES.queue, { replace: true }); // the console is still being built
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

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
                <Notice tone="error" className="mt-3">{error}</Notice>
              </motion.div>
            )}
          </AnimatePresence>

          <Button type="submit" variant="primary" size="lg" icon={LockKeyhole} loading={busy} className="mt-5 w-full">
            Sign in
          </Button>
        </form>

        <button
          type="button"
          onClick={() => navigate(ROUTES.home)}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink-primary"
        >
          <ArrowLeft size={15} /> Back to the storefront
        </button>
      </motion.div>

      <ForgotPasswordModal
        open={forgot}
        onClose={() => setForgot(false)}
        initialEmail={email}
        onSignedIn={(account) => {
          setForgot(false);
          if (account?.role === "silla") navigate(ROUTES.queue, { replace: true }); // the console is still being built
          else {
            signOut();
            setError("This entrance is for SILLA staff. Customers sign in from the storefront.");
          }
        }}
      />
    </div>
  );
}
