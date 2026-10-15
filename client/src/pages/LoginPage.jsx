import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
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
 * means distinguishing "wrong PIN" from "locked" from "slow down".
 */
export default function LoginPage() {
  const { org, entitlements } = useOrg();
  const { login, isAuthenticated, requiresTermsAcceptance, mustChangePin, booting } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const memberNoun = org?.terminology?.memberNoun || "member";

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email.trim(), pin);
      // The gates run in order: PIN change (ADM-4), then terms (AUTH-3).
      if (user.mustChangePin) navigate("/change-pin");
      else navigate(user.requiresTermsAcceptance ? "/terms" : "/map");
    } catch (err) {
      if (err.status === 403 && err.body?.requiresVerification) {
        setError("This account isn't verified yet. Finish registration at the kiosk.");
      } else if (err.status === 423) {
        setError("Too many incorrect PINs — this account is locked for 15 minutes.");
      } else if (err.status === 429) {
        const secs = err.body?.retryAfterSeconds;
        setError(`Too many attempts. Try again${secs ? ` in ${Math.ceil(secs / 60)} minute(s)` : " shortly"}.`);
      } else {
        setError(err.message);
      }
      setSubmitting(false);
    }
  };

  if (booting) return <Loading className="min-h-screen" />;
  if (isAuthenticated) {
    return <Navigate to={mustChangePin ? "/change-pin" : requiresTermsAcceptance ? "/terms" : "/map"} replace />;
  }

  return (
    <AuthShell
      icon={Building2}
      title={org?.name || "SILLA"}
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
        <form onSubmit={onSubmit} className="space-y-4">
          <Field
            label="Email"
            type="email"
            name="email"
            required
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <PinField label="6-digit PIN" name="pin" value={pin} onChange={setPin} />

          {error && <Notice tone="error">{error}</Notice>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            icon={LockKeyhole}
            loading={submitting}
            disabled={pin.length !== 6}
            className="w-full"
          >
            Sign in
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
