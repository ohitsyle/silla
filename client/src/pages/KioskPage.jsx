import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CircleCheck, ContactRound, CreditCard, DoorOpen, LoaderCircle, MailCheck,
  RotateCcw, TriangleAlert, UserX,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import { stepSwap } from "../lib/motion.js";
import SpaceMap from "../components/SpaceMap.jsx";
import {
  Button, Card, Field, Modal, Notice, PinField, Segmented, Spinner,
} from "../components/ui/index.jsx";

/**
 * KioskPage — the physical surface (spec §4, §13; ID-1, ID-2, OCC-1..OCC-3, OCC-6).
 *
 * A tap resolves a credential through the check-in interface and the
 * server reports what should happen next. This screen exists to render
 * every one of those outcomes:
 *
 *   register      -> ID-1  collect details
 *   verify        -> ID-2  resume an unverified registration
 *   walk-in       -> OCC-2 show the map, assign the chosen resource
 *   checked-in    -> OCC-1 confirm and say where to sit
 *   checked-out   -> OCC-3 confirm the resource is freed
 *   duplicate-tap -> OCC-6 absorb an accidental double-tap
 *   see-staff     ->       deactivated account
 *
 * The tap itself is captured through a focused hidden input, because the
 * INF-4 spike found USB RFID readers present as HID keyboard-wedge
 * devices — they type the UID and press Enter. No driver, no serial
 * code, no native dependency. See docs/INF-4-rfid-spike.md.
 */

const STEP = {
  TAP: "tap",
  DETAILS: "details",
  VERIFY: "verify",
  WALKIN: "walkin",
  RESULT: "result",
};

/** Kiosks are shared — a result screen must not sit there for the next person. */
const AUTO_RESET_MS = 12_000;

export default function KioskPage() {
  const { org, organizationId } = useOrg();

  const [requirements, setRequirements] = useState(null);
  const [step, setStep] = useState(STEP.TAP);
  const [cardUid, setCardUid] = useState("");
  const [registration, setRegistration] = useState(null);
  const [result, setResult] = useState(null); // { kind, member, reservation }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const memberNoun = requirements?.memberNoun || org?.terminology?.memberNoun || "member";
  const resourceNoun = org?.terminology?.resourceNoun || "resource";

  useEffect(() => {
    if (!organizationId) {
      setError("This service isn't configured yet. Please ask a member of staff.");
      return;
    }
    api.getRegistrationRequirements(organizationId).then(setRequirements).catch((e) => setError(e.message));
  }, [organizationId]);

  const reset = useCallback(() => {
    setStep(STEP.TAP);
    setCardUid("");
    setRegistration(null);
    setResult(null);
    setError(null);
    setBusy(false);
  }, []);

  // Return the kiosk to the tap screen after a result, so the next
  // person doesn't walk up to someone else's confirmation.
  useEffect(() => {
    if (step !== STEP.RESULT) return undefined;
    const t = setTimeout(reset, AUTO_RESET_MS);
    return () => clearTimeout(t);
  }, [step, result, reset]);

  /** A tap resolves the credential through the INF-3 interface. */
  const onTap = useCallback(
    async (uid) => {
      // Don't accept a tap until the org's config has loaded — the
      // registration form is built from it (member noun, ID format).
      if (!uid || busy || !requirements) return;
      setBusy(true);
      setError(null);
      try {
        const r = await api.tap(organizationId, uid);
        setCardUid(r.cardUid || uid);

        switch (r.next) {
          case "register": // ID-1
            setStep(STEP.DETAILS);
            break;
          case "verify": // ID-2 — resume, don't restart
            setRegistration({ registrationId: r.registrationId, email: r.email });
            setStep(STEP.VERIFY);
            break;
          case "walk-in": // OCC-2
            setResult({ kind: "walk-in", member: r.member, maxStayHours: r.maxStayHours });
            setStep(STEP.WALKIN);
            break;
          case "checked-in": // OCC-1
            setResult({ kind: "checked-in", member: r.member, reservation: r.reservation });
            setStep(STEP.RESULT);
            break;
          case "checked-out": // OCC-3
            setResult({ kind: "checked-out", member: r.member });
            setStep(STEP.RESULT);
            break;
          case "duplicate-tap": // OCC-6
            setResult({ kind: "duplicate", member: r.member, retryInMs: r.retryInMs });
            setStep(STEP.RESULT);
            break;
          default:
            setResult({ kind: "unknown", member: r.member });
            setStep(STEP.RESULT);
        }
      } catch (err) {
        // A deactivated account comes back as 403 with next: "see-staff".
        if (err.body?.next === "see-staff") {
          setResult({ kind: "see-staff" });
          setStep(STEP.RESULT);
        } else {
          setError(err.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [organizationId, busy, requirements]
  );

  return (
    <div className="min-h-screen px-6 py-10 max-w-3xl mx-auto text-ink-primary flex flex-col justify-center">
      <header className="flex items-center gap-3 mb-8">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          <ContactRound size={22} />
        </div>
        <div className="mr-auto">
          <div className="text-lg font-semibold">{requirements?.organizationName || org?.name || "Kiosk"}</div>
          <div className="text-sm text-ink-secondary">Tap in, tap out, or register</div>
        </div>
        {step !== STEP.TAP && (
          <Button icon={RotateCcw} onClick={reset}>
            Start over
          </Button>
        )}
      </header>

      {/* The stepper only describes the REGISTRATION path; check-in and
          check-out are single-tap actions with no steps to show. */}
      {[STEP.DETAILS, STEP.VERIFY].includes(step) && <Stepper step={step} />}

      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {requirements && requirements.selfServiceRegistration === false && step === STEP.TAP && (
        <div className="mb-4">
          <Notice>Self-service registration is disabled — accounts are provisioned by staff.</Notice>
        </div>
      )}

      <AnimatePresence mode="wait">
        {step === STEP.TAP && (
          <TapStep key="tap" onTap={onTap} busy={busy} memberNoun={memberNoun} ready={Boolean(requirements)} />
        )}

        {step === STEP.DETAILS && (
          <DetailsStep
            key="details"
            organizationId={organizationId}
            cardUid={cardUid}
            requirements={requirements}
            onError={setError}
            onRegistered={(data) => {
              setRegistration(data);
              setStep(STEP.VERIFY);
            }}
          />
        )}

        {step === STEP.VERIFY && (
          <VerifyStep
            key="verify"
            registration={registration}
            expiryMinutes={requirements?.verificationCodeExpiryMinutes ?? 10}
            onError={setError}
            onVerified={(member) => {
              setResult({ kind: "registered", member });
              setStep(STEP.RESULT);
            }}
          />
        )}

        {step === STEP.WALKIN && (
          <WalkInStep
            key="walkin"
            organizationId={organizationId}
            credential={cardUid}
            member={result?.member}
            maxStayHours={result?.maxStayHours}
            resourceNoun={resourceNoun}
            org={org}
            onError={setError}
            onAssigned={(reservation) => {
              setResult((r) => ({ ...r, kind: "checked-in", reservation }));
              setStep(STEP.RESULT);
            }}
          />
        )}

        {step === STEP.RESULT && (
          <ResultStep
            key="result"
            result={result}
            memberNoun={memberNoun}
            resourceNoun={resourceNoun}
            onReset={reset}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------------------------------------------- */

function Stepper({ step }) {
  const steps = [
    { key: STEP.DETAILS, label: "Details" },
    { key: STEP.VERIFY, label: "Verify" },
  ];
  const index = steps.findIndex((s) => s.key === step);
  return (
    <ol className="flex items-center gap-2 mb-6 text-xs">
      <li className="flex items-center gap-2">
        <span className="h-7 px-3 rounded-full flex items-center font-medium border border-transparent"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}>
          Tap
        </span>
        <span className="w-4 h-px bg-line/15" />
      </li>
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={`h-7 px-3 rounded-full flex items-center font-medium border ${
              i <= index ? "border-transparent" : "border-line/10 text-ink-muted"
            }`}
            style={i <= index ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" } : undefined}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="w-4 h-px bg-line/15" />}
        </li>
      ))}
    </ol>
  );
}

/** Step 1 — the tap. A focused input receives the reader's keystrokes. */
function TapStep({ onTap, busy, memberNoun, ready }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const idleTimer = useRef(null);

  /**
   * The kiosk keeps focus on its hidden reader input, because a card
   * "types" and the keystrokes have to land somewhere. That loop must
   * pause while the manual-entry dialog is up — otherwise it steals
   * focus back every 1.2 seconds and you cannot type in the field the
   * dialog just opened for you.
   */
  useEffect(() => {
    if (manualOpen) return undefined;
    const focus = () => inputRef.current?.focus();
    focus();
    const interval = setInterval(focus, 1200);
    return () => clearInterval(interval);
  }, [manualOpen]);
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const submit = (uid) => {
    clearTimeout(idleTimer.current);
    const trimmed = uid.trim();
    setValue("");
    if (trimmed) onTap(trimmed);
  };

  const onChange = (e) => {
    const next = e.target.value;
    setValue(next);
    clearTimeout(idleTimer.current);
    // Readers "type" a full UID in milliseconds; a pause after a
    // plausible length means the tap is complete (not every reader
    // sends a terminator — see the INF-4 spike record).
    if (next.trim().length >= 8) idleTimer.current = setTimeout(() => submit(next), 250);
  };

  return (
    <>
      {/*
        A kiosk is a wall screen, not a web page.
        This used to be a small card centred in half a screen of empty
        black, which reads as an unfinished page rather than as a device
        waiting for you. Everything is scaled for reading and tapping at
        arm's length: the target is large, the instruction is large, and
        the manual-entry escape hatch is a real dialog rather than a
        native <details> triangle sitting under it.
      */}
      <div className="flex flex-col items-center justify-center text-center py-6 sm:py-10">
        <motion.div
          animate={{ scale: busy ? 1 : [1, 1.05, 1] }}
          transition={{ duration: 2.2, repeat: busy ? 0 : Infinity, ease: "easeInOut" }}
          className="w-36 h-36 sm:w-44 sm:h-44 rounded-[2rem] flex items-center justify-center mb-9"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-ink)",
            // A tinted glow rather than a black shadow: on a dark wall
            // screen a black shadow is simply invisible.
            boxShadow: "0 24px 70px -18px rgb(var(--c-accent) / 0.5)",
          }}
        >
          {busy ? (
            <LoaderCircle size={64} className="animate-spin" />
          ) : (
            <CreditCard size={64} strokeWidth={1.6} />
          )}
        </motion.div>

        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          {busy ? "Reading card…" : ready ? "Tap your card" : "Preparing kiosk…"}
        </h1>
        <p className="text-lg sm:text-xl text-ink-secondary mt-4 max-w-xl leading-relaxed">
          {ready
            ? `Check in, check out, or register — one tap does the right thing. New ${memberNoun}s are registered on the spot.`
            : "Loading this organization's registration settings."}
        </p>

        <input
          ref={inputRef}
          value={value}
          onChange={onChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(value);
            }
          }}
          aria-label="Card reader input"
          autoComplete="off"
          className="absolute opacity-0 w-px h-px -z-10"
        />

        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="mt-12 text-sm text-ink-muted hover:text-ink-secondary underline underline-offset-4
                     transition-colors duration-fast"
        >
          No reader attached? Enter a card number
        </button>
      </div>

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Enter a card number"
        subtitle="For testing, or when the reader is disconnected."
        icon={CreditCard}
      >
        <form
          id="manual-uid"
          onSubmit={(e) => {
            e.preventDefault();
            const uid = new FormData(e.currentTarget).get("uid") || "";
            setManualOpen(false);
            submit(uid);
          }}
        >
          <Field
            label="Card number"
            name="uid"
            data-autofocus
            placeholder="04A22B9C"
            mono
            hint="4–32 hex characters. Case and separators are ignored."
          />
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => setManualOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Tap
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Step 2 — ID-1: capture the details the org's config asks for. */
function DetailsStep({ organizationId, cardUid, requirements, onRegistered, onError }) {
  const [form, setForm] = useState({
    firstName: "", middleName: "", lastName: "", memberId: "", email: "", pin: "", confirmPin: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const memberNoun = requirements?.memberNoun || "member";
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setDigits = (key, max) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "").slice(0, max) }));

  const pinMismatch = form.confirmPin.length === 6 && form.pin !== form.confirmPin;
  const canSubmit =
    form.firstName.trim() && form.lastName.trim() && form.email.trim() && form.memberId.trim() &&
    form.pin.length === 6 && form.pin === form.confirmPin && !submitting;

  const onSubmit = async (e) => {
    e.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      const data = await api.startRegistration({
        organizationId, cardUid,
        firstName: form.firstName, middleName: form.middleName, lastName: form.lastName,
        memberId: form.memberId, email: form.email, pin: form.pin,
      });
      onRegistered(data);
    } catch (err) {
      onError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <motion.form
      {...stepSwap()}
      onSubmit={onSubmit}
      className="rounded-lg border border-line/10 bg-bg-card shadow-raised p-6 space-y-4"
    >
      <div className="text-sm text-ink-secondary">
        Card <span className="font-mono text-ink-primary">{cardUid}</span> isn't registered yet. Let's set it up.
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required value={form.firstName} onChange={set("firstName")} />
        <Field label="Last name" required value={form.lastName} onChange={set("lastName")} />
      </div>
      <Field label="Middle name (optional)" value={form.middleName} onChange={set("middleName")} />

      <Field
        label={`${memberNoun.charAt(0).toUpperCase()}${memberNoun.slice(1)} ID`}
        required mono
        value={form.memberId}
        onChange={set("memberId")}
        placeholder={requirements?.memberIdExample}
        hint={requirements?.memberIdFormat ? `Format: ${requirements.memberIdFormat}` : undefined}
      />
      <Field label="Email" required type="email" value={form.email} onChange={set("email")} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="6-digit PIN" required type="password" mono value={form.pin} onChange={setDigits("pin", 6)} />
        <Field
          label="Confirm PIN" required type="password" mono
          value={form.confirmPin} onChange={setDigits("confirmPin", 6)}
          error={pinMismatch ? "PINs don't match" : undefined}
        />
      </div>

      <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={!canSubmit} className="w-full">
        Send verification code
      </Button>
    </motion.form>
  );
}

/** Step 3 — ID-2: the emailed code. */
function VerifyStep({ registration, expiryMinutes, onVerified, onError }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [devCode, setDevCode] = useState(registration?.devVerificationCode || null);

  const onSubmit = async (e) => {
    e.preventDefault();
    onError(null);
    setSubmitting(true);
    try {
      const data = await api.verifyRegistration(registration.registrationId, code);
      onVerified(data.member);
    } catch (err) {
      const remaining = err.body?.attemptsRemaining;
      onError(remaining !== undefined ? `${err.message} ${remaining} attempt(s) left.` : err.message);
      setCode("");
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    onError(null);
    setResending(true);
    try {
      const data = await api.resendRegistrationCode(registration.registrationId);
      setDevCode(data.devVerificationCode || null);
      setCode("");
    } catch (err) {
      onError(err.message);
    } finally {
      setResending(false);
    }
  };

  return (
    <motion.form
      {...stepSwap()}
      onSubmit={onSubmit}
      className="rounded-lg border border-line/10 bg-bg-card shadow-raised p-8 text-center"
    >
      <div
        className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-5"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      >
        <MailCheck size={30} />
      </div>
      <div className="text-lg font-semibold">Check your email</div>
      <p className="text-sm text-ink-secondary mt-2">
        We sent a 6-digit code to <span className="text-ink-primary">{registration?.email}</span>. It expires in{" "}
        {expiryMinutes} minutes.
      </p>

      {devCode && (
        <div className="mt-4 rounded-lg border border-line/10 bg-bg-panel px-3 py-2 text-xs text-ink-muted">
          Dev mode — no email provider configured. Code:{" "}
          <span className="font-mono text-ink-primary tracking-widest">{devCode}</span>
        </div>
      )}

      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric" autoFocus aria-label="Verification code"
        className="mt-5 w-full h-14 rounded-lg bg-bg-panel border border-line/10 text-center
                   text-2xl font-mono tracking-[0.6em] outline-none focus:border-line/35"
      />

      <Button type="submit" variant="primary" size="lg" loading={submitting} disabled={code.length !== 6} className="mt-4 w-full">
        Verify
      </Button>
      <button
        type="button" onClick={onResend} disabled={resending}
        className="mt-3 text-xs text-ink-muted hover:text-ink-secondary disabled:opacity-40 rounded-sm"
      >
        {resending ? "Sending…" : "Send a new code"}
      </button>
    </motion.form>
  );
}

/**
 * OCC-2 — walk-in. "No reservation → map shown; Selected open resource
 * assigned on the spot."
 *
 * The credential is re-presented to the server rather than a member id:
 * the kiosk is unauthenticated, so identity must come from the check-in
 * interface every time.
 */
function WalkInStep({ organizationId, credential, member, maxStayHours, resourceNoun, org, onError, onAssigned }) {
  const [floors, setFloors] = useState([]);
  const [floorId, setFloorId] = useState(null);
  const [data, setData] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const palette = useMemo(() => resolveStatePalette(org), [org]);

  useEffect(() => {
    api.getFloors(organizationId).then((d) => {
      setFloors(d.floors);
      if (d.floors.length) setFloorId((current) => current || d.floors[0].id);
    }).catch((e) => onError(e.message));
  }, [organizationId, onError]);

  useEffect(() => {
    if (!floorId) return;
    api.getFloorLayout(floorId).then(setData).catch((e) => onError(e.message));
  }, [floorId, onError]);

  const pick = async (unit) => {
    if (assigning) return;
    if (unit.status?.status !== "available") {
      onError(`That ${resourceNoun} isn't available — pick a green one.`);
      return;
    }
    setAssigning(true);
    onError(null);
    try {
      const r = await api.assignWalkIn(organizationId, credential, unit.resourceId, unit.unitLabel);
      onAssigned(r.reservation);
    } catch (err) {
      onError(err.message);
      setAssigning(false);
      // Refresh so a seat someone else just took stops looking free.
      api.getFloorLayout(floorId).then(setData).catch(() => {});
    }
  };

  return (
    <motion.div {...stepSwap()}>
      <div className="rounded-lg border border-line/10 bg-bg-card shadow-raised p-5 mb-4">
        <div className="text-lg font-semibold">
          {member?.firstName ? `Hi ${member.firstName} — pick a ${resourceNoun}` : `Pick a ${resourceNoun}`}
        </div>
        <p className="text-sm text-ink-secondary mt-1">
          Choose an open {resourceNoun} or a bookable room for up to {maxStayHours ?? 4} hours. A whole-room booking includes every level and its contents.
        </p>
      </div>

      {floors.length > 1 && (
        <div className="mb-3">
          <Segmented
            className="kioskfloors"
            value={floorId}
            onChange={setFloorId}
            options={floors.map((f) => ({ value: f.id, label: f.name }))}
          />
        </div>
      )}

      <div className="rounded-lg border border-line/10 bg-bg-card shadow-raised overflow-hidden relative">
        {assigning && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-page/60 backdrop-blur-sm">
            <Spinner size={28} />
          </div>
        )}
        {data ? (
          <SpaceMap
            floor={data.floor}
            layout={data.layout}
            resourceTypes={data.resourceTypes}
            status={data.status}
            resourceNoun={resourceNoun}
            palette={palette}
            onSelectUnit={pick}
          />
        ) : (
          <div className="h-[46vh] flex items-center justify-center text-ink-secondary">Loading map…</div>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Tap a green {resourceNoun}, or a room's name to take the whole room. Drag to pan, pinch to zoom.
      </p>
    </motion.div>
  );
}

/** The outcome screens: OCC-1, OCC-3, OCC-6, ID-2 success, and see-staff. */
function ResultStep({ result, memberNoun, resourceNoun, onReset }) {
  const kind = result?.kind;

  const config = {
    "checked-in": {
      Icon: CircleCheck,
      tone: "available",
      title: result?.member?.firstName ? `You're checked in, ${result.member.firstName}.` : "You're checked in.",
      body: result?.reservation
        ? result.reservation.kind === "room" ? `${result.reservation.resourceLabel} · all ${result.reservation.roomLevels} room level(s)` : `${result.reservation.resourceLabel || resourceNoun} · ${resourceNoun} ${result.reservation.unitLabel}` +
          (result.reservation.position ? ` at (${result.reservation.position.col}, ${result.reservation.position.row})` : "")
        : null,
      foot: result?.reservation?.endTime
        ? `Until ${new Date(result.reservation.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Tap again when you leave.`
        : "Tap again when you leave.",
    },
    "checked-out": {
      Icon: DoorOpen,
      tone: "occupied",
      title: result?.member?.firstName ? `Checked out — thanks, ${result.member.firstName}.` : "Checked out.",
      body: `Your ${resourceNoun} is free for someone else.`,
      foot: "See you next time.",
    },
    registered: {
      Icon: CircleCheck,
      tone: "available",
      title: result?.member?.firstName ? `You're all set, ${result.member.firstName}.` : "You're all set.",
      body: "Your card is bound to your account.",
      foot: `Sign in with your email and PIN, or tap again to take a ${resourceNoun}.`,
    },
    duplicate: {
      Icon: TriangleAlert,
      tone: "reserved",
      title: "Card already read",
      body: "That tap was a duplicate and has been ignored.",
      foot: `Wait a moment before tapping again.`,
    },
    "see-staff": {
      Icon: UserX,
      tone: "unavailable",
      title: "Please see a member of staff",
      body: "This account is deactivated.",
      foot: null,
    },
    unknown: {
      Icon: CircleCheck,
      tone: "occupied",
      title: "Card recognised",
      body: null,
      foot: null,
    },
  }[kind] || {};

  const { Icon = CircleCheck, tone = "available", title, body, foot } = config;

  return (
    <motion.div
      {...stepSwap()}
      className="rounded-lg border border-line/10 bg-bg-card shadow-raised p-8 text-center"
    >
      <div
        className="w-20 h-20 rounded-xl mx-auto flex items-center justify-center mb-6 shadow-lg"
        style={{ background: `var(--color-state-${tone})`, color: "var(--color-bg-page)" }}
      >
        <Icon size={38} />
      </div>
      <div className="text-2xl font-semibold tracking-tight">{title}</div>
      {body && <p className="text-base text-ink-secondary mt-2">{body}</p>}
      {result?.member?.memberId && (
        <p className="text-xs text-ink-muted mt-3">
          {/* Capitalised here rather than with a CSS `capitalize` class,
              which would also mangle the mono ID that follows. */}
          {memberNoun.charAt(0).toUpperCase()}
          {memberNoun.slice(1)} ID: <span className="font-mono">{result.member.memberId}</span>
        </p>
      )}
      {foot && <p className="text-xs text-ink-muted mt-4">{foot}</p>}

      <Button onClick={onReset} className="mt-6">
        Next person
      </Button>
      <p className="text-[11px] text-ink-muted mt-3">Returning to the tap screen automatically…</p>
    </motion.div>
  );
}

function Panel({ children }) {
  return (
    <motion.div
      {...stepSwap()}
      className="rounded-lg border border-line/10 bg-bg-card shadow-raised p-8 text-center"
    >
      {children}
    </motion.div>
  );
}
