import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Building2, LockKeyhole } from "lucide-react";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import { Button, Card, Field, Loading, Notice, PinField } from "../components/ui/index.jsx";

/**
 * LoginPage — AUTH-1 (spec §5: "everyone — members and staff alike —
 * logs in with email and a 6-digit PIN"). One screen for every role; the
 * member ID is identity data, never a login credential.
 *
 * AUTH-2's lockout and rate limiting are enforced server-side; this
 * screen's job is to report them in a way a person can act on, which
 * means distinguishing "wrong PIN" from "locked" from "slow down" — and,
 * for a forgotten or locked PIN, offering the way back (AUTH-4, at
 * /login/reset), which also clears a lockout.
 *
 * Sign in is never disabled: an empty field is said when the person
 * presses it, next to the field, rather than a greyed-out button that
 * explains nothing. And it returns people to the page that sent them
 * here — a link to /admin/plan from an email should land on the plan,
 * not on the map, once they have signed in.
 */
export default function LoginPage() {
  const { org, entitlements } = useOrg();
  const { login, isAuthenticated, requiresTermsAcceptance, mustChangePin, booting } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;

  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const memberNoun = org?.terminology?.memberNoun || "member";

  /** Where a signed-in person goes next: the gates first, in order, then where they were headed. */
  const onward = (user) => {
    if (user.mustChangePin) return navigate("/change-pin", { replace: true, state: { from } });
    if (user.requiresTermsAcceptance) return navigate("/terms", { replace: true, state: { from } });
    return navigate(from || "/map", { replace: true });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const found = {};
    if (!email.trim()) found.email = "Enter the email address you sign in with.";
    if (pin.length !== 6) found.pin = "Enter your 6-digit PIN.";
    setFieldErrors(found);
    setError(null);
    setLocked(false);
    if (Object.keys(found).length) return;

    setSubmitting(true);
    try {
      onward(await login(email.trim(), pin));
    } catch (err) {
      if (err.status === 403 && err.body?.requiresVerification) {
        setError("This account isn't verified yet. Finish registration at the kiosk.");
      } else if (err.status === 423) {
        setLocked(true);
        setError("Too many incorrect PINs — this account is locked for 15 minutes.");
      } else if (err.status === 429) {
        const secs = err.details?.retryAfterSeconds;
        setError(`Too many attempts. Try again${secs ? ` in ${Math.ceil(secs / 60)} minute(s)` : " shortly"}.`);
      } else if (err.status === 401) {
        setError("That email and PIN don't match an account here.");
      } else {
        setError(err.message);
      }
      setSubmitting(false);
    }
  };

  if (booting) return <Loading className="min-h-screen" />;
  if (isAuthenticated) {
    return (
      <Navigate
        to={mustChangePin ? "/change-pin" : requiresTermsAcceptance ? "/terms" : from || "/map"}
        replace
        state={{ from }}
      />
    );
  }

  // The reset page starts from the address already typed here.
  const resetLink = { pathname: "/login/reset", state: { email: email.trim(), from } };

  return (
    <AuthShell
      icon={Building2}
      title={org?.name || "Sign in"}
      subtitle="Sign in to continue"
      footer={
        // Without the kiosk on the plan there is nowhere to register, so the
        // footer stops sending people to one.
        entitlements.hasFeature("kiosk") ? (
          <>
            New {memberNoun}s register in person at a kiosk by tapping their card.
            <br />
            <Link to="/kiosk" className="text-ink-secondary hover:text-ink-primary underline underline-offset-2">
              Open the kiosk
            </Link>
          </>
        ) : (
          <>Don't have an account yet? Ask a member of staff to set one up.</>
        )
      }
    >
      <Card elevation="floating">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <Field
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            autoFocus
            value={email}
            error={fieldErrors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
            }}
          />
          <div>
            <PinField
              label="6-digit PIN"
              name="pin"
              value={pin}
              error={fieldErrors.pin}
              onChange={(value) => {
                setPin(value);
                if (fieldErrors.pin) setFieldErrors((f) => ({ ...f, pin: undefined }));
              }}
            />
            {/* Visible, under the field it is about — not tucked in a footer. */}
            <div className="mt-2 text-right">
              <Link
                to={resetLink.pathname}
                state={resetLink.state}
                className="text-xs text-ink-secondary underline-offset-2 transition-colors duration-fast
                           hover:text-ink-primary hover:underline"
              >
                Forgot your PIN?
              </Link>
            </div>
          </div>

          {error && (
            <Notice tone="error">
              {error}
              {locked && (
                <>
                  {" "}
                  <Link to={resetLink.pathname} state={resetLink.state} className="font-medium underline underline-offset-2">
                    Reset your PIN
                  </Link>{" "}
                  to unlock it now.
                </>
              )}
            </Notice>
          )}

          <Button type="submit" variant="primary" size="lg" icon={LockKeyhole} loading={submitting} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
