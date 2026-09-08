import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
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
 */
export default function ChangePinPage() {
  const { user, booting, isAuthenticated, refresh } = useAuth();
  const navigate = useNavigate();

  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  const mismatch = confirmPin.length === 6 && newPin !== confirmPin;
  const sameAsOld = newPin.length === 6 && newPin === currentPin;
  const forced = Boolean(user?.mustChangePin);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePin(currentPin, newPin);
      const fresh = await refresh?.();
      navigate(fresh?.requiresTermsAcceptance ? "/terms" : "/map", { replace: true });
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
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <PinField
            label={forced ? "Temporary PIN" : "Current PIN"}
            name="currentPin"
            autoFocus
            value={currentPin}
            onChange={setCurrentPin}
          />
          <PinField
            label="New PIN"
            name="newPin"
            value={newPin}
            onChange={setNewPin}
            error={sameAsOld ? "Must be different from your current PIN" : undefined}
          />
          <PinField
            label="Confirm new PIN"
            name="confirmPin"
            value={confirmPin}
            onChange={setConfirmPin}
            error={mismatch ? "PINs don't match" : undefined}
          />

          {error && <Notice tone="error">{error}</Notice>}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            disabled={newPin.length !== 6 || newPin !== confirmPin || currentPin.length !== 6 || sameAsOld}
            className="w-full"
          >
            Save PIN
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
