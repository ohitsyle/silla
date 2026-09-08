import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button, Card, Field, Notice } from "../components/ui.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { hasPending } from "../lib/pendingConfiguration.js";

/**
 * Sign in and sign up, one screen.
 *
 * Both forms are three fields and a button; splitting them across two
 * pages means someone who picked wrong has to find the other one. The
 * mode swaps in place and keeps the email they already typed.
 *
 * Deliberately the storefront's warm surface rather than the product's
 * gate screens — this is somebody buying, not somebody clocking in.
 */
export default function AuthScreen({ mode, navigate, redirectTo }) {
  const { signIn, signUp } = useAccount();
  const isSignUp = mode === "signUp";

  const [form, setForm] = useState({ name: "", email: "", password: "", organizationName: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isSignUp) {
        await signUp({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          organizationName: form.organizationName.trim(),
        });
      } else {
        await signIn(form.email.trim(), form.password);
      }
      // Someone who came here mid-configuration goes back to it, not to
      // an orders list that is empty precisely because they have not yet
      // saved the thing they were making.
      navigate(hasPending() ? ROUTES.configure : redirectTo || ROUTES.orders, { replace: true });
    } catch (err) {
      // A taken email on sign-up is a recoverable mistake, not a
      // failure — point at the other form rather than just refusing.
      setError(
        err.status === 409
          ? "That email already has an account. Sign in instead?"
          : err.message || "Something went wrong."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="silla-marketing min-h-screen px-6 py-16">
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          onClick={() => navigate(ROUTES.home)}
          className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary
                     transition-opacity hover:opacity-70"
        >
          <ArrowLeft size={15} />
          Back to the site
        </button>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="display text-[clamp(2rem,5vw,2.75rem)]">
            {isSignUp ? "Create an account." : "Welcome back."}
          </h1>
          <p className="mt-3 text-ink-secondary">
            {hasPending()
              ? "Your configuration is waiting — we'll take you straight back to it."
              : isSignUp
                ? "So your configuration is saved, and you can come back to it."
                : "Pick up where you left off."}
          </p>

          <Card className="mt-8">
            <form onSubmit={submit}>
              {isSignUp && (
                <>
                  <Field label="Your name" required value={form.name} onChange={set("name")} autoFocus />
                  <Field
                    label="Organization"
                    hint="The place you're buying this for. You can change it later."
                    className="mt-4"
                    value={form.organizationName}
                    onChange={set("organizationName")}
                  />
                </>
              )}

              <Field
                label="Email"
                type="email"
                required
                autoFocus={!isSignUp}
                className={isSignUp ? "mt-4" : undefined}
                value={form.email}
                onChange={set("email")}
              />
              <Field
                label="Password"
                type="password"
                required
                className="mt-4"
                hint={isSignUp ? "At least 10 characters. Longer beats complicated." : undefined}
                value={form.password}
                onChange={set("password")}
              />

              {error && (
                <Notice tone="error" className="mt-4">
                  {error}
                </Notice>
              )}

              <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-6 w-full">
                {isSignUp ? "Create account" : "Sign in"}
                <ArrowRight size={16} />
              </Button>
            </form>
          </Card>

          <p className="mt-5 text-center text-sm text-ink-secondary">
            {isSignUp ? "Already have an account? " : "No account yet? "}
            <button
              type="button"
              onClick={() => navigate(isSignUp ? ROUTES.signIn : ROUTES.signUp)}
              className="font-semibold underline underline-offset-4 hover:opacity-70"
            >
              {isSignUp ? "Sign in" : "Create one"}
            </button>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
