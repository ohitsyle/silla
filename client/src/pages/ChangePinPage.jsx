import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import { Button, Card, Loading, Notice, PinField } from "../components/ui/index.jsx";

/**
 * ChangePinPage — the forced first-login PIN change for provisioned
 * accounts (ADM-4), and the ordinary change-my-PIN path.
 *
 * Provisioned staff and members whose PIN was reset by staff arrive here
 * with a temporary PIN they must replace before anything else works.
 *
 * Save is never disabled. What is wrong is said when it is pressed, next
 * to the field it is about — a greyed-out button explains nothing — and
 * from then on each message clears as soon as its field is put right.
 */
export default function ChangePinPage() {
  const { user, booting, isAuthenticated, refresh } = useAuth();
  const navigate = useNavigate();
  const from = useLocation().state?.from;

  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  const forced = Boolean(user?.mustChangePin);
  const problems = {
    currentPin: currentPin.length !== 6 ? `Enter your ${forced ? "temporary" : "current"} 6-digit PIN.` : null,
    newPin:
      newPin.length !== 6
        ? "Choose a 6-digit PIN."
        : newPin === currentPin
          ? "Choose a PIN different from the current one."
          : null,
    confirmPin: newPin.length === 6 && confirmPin !== newPin ? "The two PINs don't match." : null,
  };
  const shown = (field) => (submitted ? problems[field] || undefined : undefined);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    try {
      await api.changePin(currentPin, newPin);
      const fresh = await refresh?.();
      navigate(fresh?.requiresTermsAcceptance ? "/terms" : from || "/map", { replace: true, state: { from } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthShell
      icon={KeyRound}
      title={forced ? "Set your PIN" : "Change your PIN"}
      subtitle={
        forced
          ? "Your account was set up with a temporary PIN. Choose your own to continue."
          : "Pick a new 6-digit PIN."
      }
    >
      <Card elevation="floating">
        <form onSubmit={submit} noValidate className="space-y-4">
          <PinField
            label={forced ? "Temporary PIN" : "Current PIN"}
            name="currentPin"
            autoFocus
            value={currentPin}
            onChange={setCurrentPin}
            error={shown("currentPin")}
          />
          <PinField label="New PIN" name="newPin" value={newPin} onChange={setNewPin} error={shown("newPin")} />
          <PinField
            label="Confirm new PIN"
            name="confirmPin"
            value={confirmPin}
            onChange={setConfirmPin}
            error={shown("confirmPin")}
          />

          {error && <Notice tone="error">{error}</Notice>}

          <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
            Save PIN
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
