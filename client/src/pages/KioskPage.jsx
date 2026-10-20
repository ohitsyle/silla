import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight, CircleCheck, CirclePause, CircleSlash, ContactRound, CreditCard, DoorOpen, LoaderCircle, MailCheck,
  RotateCcw, TriangleAlert, UserX,
} from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { stepSwap } from "../lib/motion.js";
import { clock } from "../lib/dayView.js";
import {
  DurationStep, LaterTodayStep, WalkInStep, useIdleReset,
} from "../components/KioskWalkIn.jsx";
import { Button, Field, Modal, Notice } from "../components/ui/index.jsx";

/**
 * KioskPage — the physical surface (spec §4, §13; ID-1, ID-2, OCC-1..OCC-3, OCC-6).
 *
 * A tap resolves a credential through the check-in interface and the
 * server reports what should happen next. This screen exists to render
 * every one of those outcomes:
 *
 *   register      -> ID-1  collect details
 *   verify        -> ID-2  resume an unverified registration
 *   later-today   -> OCC-2 a booking later today: cancel it and sit now,
 *                          keep it and sit until then, or not now
 *   walk-in       -> OCC-2 what is free now on the map, then how long
 *   checked-in    -> OCC-1 confirm and say where to sit
 *   checked-out   -> OCC-3 confirm the resource is freed
 *   duplicate-tap -> OCC-6 absorb an accidental double-tap
 *   see-staff     ->       deactivated account
 *
 * The kiosk only ever seats people from now on; booking for later is the
 * website's. The walk-in screens are in components/KioskWalkIn.jsx.
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
  PROMPT: "prompt",
  WALKIN: "walkin",
  DURATION: "duration",
  RESULT: "result",
};

/** Kiosks are shared — a result screen must not sit there for the next person. */
const AUTO_RESET_MS = 12_000;

/** Nobody has touched a half-made choice for this long: back to the tap screen. */
const IDLE_RESET_MS = 60_000;

/**
 * What a member at the kiosk is told when the plan refuses something. The
 * server's sentence ("Your plan includes 40 employees… ask SILLA") is
 * written for an administrator; the person at the kiosk can do nothing
 * about a plan, only find someone who can.
 */
function kioskReason(err, memberNoun) {
  if (err?.code === "PLAN_LIMIT" || err?.code === "PLAN_FEATURE") {
    return `New ${memberNoun}s can't be registered here right now. Please ask a member of staff.`;
  }
  return err?.message;
}

export default function KioskPage() {
  const { org, organizationId, entitlements, reload } = useOrg();
  const { user } = useAuth();

  const [requirements, setRequirements] = useState(null);
  const [step, setStep] = useState(STEP.TAP);
  const [cardUid, setCardUid] = useState("");
  const [registration, setRegistration] = useState(null);
  const [result, setResult] = useState(null); // { kind, member, reservation }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  /**
   * A walk-in being chosen: { mode: "none"|"cancel"|"keep", member,
   * allowance (how long the member may stay, from the tap), upcoming,
   * unit, stay }.
   */
  const [walk, setWalk] = useState(null);
  const [walkError, setWalkError] = useState(null);

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
    setWalk(null);
    setWalkError(null);
  }, []);

  // A choice nobody is making any more must not wait for the next person.
  useIdleReset([STEP.PROMPT, STEP.WALKIN, STEP.DURATION].includes(step), IDLE_RESET_MS, reset);

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
            // Asked at the tap, so nobody types their name, ID, email and
            // PIN into a form the server would then refuse: registration
            // can be switched off, or the plan's member limit reached.
            if (r.registration?.open === false) {
              setResult({ kind: "registration-closed", reason: r.registration.code });
              setStep(STEP.RESULT);
            } else {
              setStep(STEP.DETAILS);
            }
            break;
          case "verify": // ID-2 — resume, don't restart
            setRegistration({ registrationId: r.registrationId, email: r.email });
            setStep(STEP.VERIFY);
            break;
          case "later-today": // a booking later today: ask what to do with it
            setResult({ kind: "later-today", member: r.member });
            setWalk({ member: r.member, upcoming: r.upcoming, options: r.options, maxStayHours: r.maxStayHours, minimum: r.minimumMinutes });
            setStep(STEP.PROMPT);
            break;
          case "walk-in": // OCC-2
            if (r.walkIn && !r.walkIn.available) {
              // Closed, or too close to closing: say so rather than show a
              // map with nothing on it that can be taken.
              setResult({ kind: "no-walk-in", member: r.member, reason: r.walkIn.reason });
              setStep(STEP.RESULT);
            } else {
              setResult({ kind: "walk-in", member: r.member });
              setWalk({ mode: "none", member: r.member, allowance: r.walkIn, maxStayHours: r.maxStayHours, minimum: r.minimumMinutes });
              setStep(STEP.WALKIN);
            }
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
        } else if (err.code === "ORG_SUSPENDED" || err.code === "PLAN_FEATURE") {
          // Paused, or the kiosk taken off the plan, since this screen
          // loaded. The server's sentence is for administrators; re-reading
          // the organization swaps this screen for one written for whoever
          // is standing at it.
          reload();
        } else {
          setError(err.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [organizationId, busy, requirements, reload]
  );

  // Suspended or cancelled, or a plan without the kiosk: every tap would
  // be refused, so the kiosk says so instead of inviting one
  // (docs/control-plane.md §2).
  if (!entitlements.operational) {
    return <KioskClosed org={org} ended={entitlements.status === "cancelled"} />;
  }
  if (!entitlements.hasFeature("kiosk")) {
    return (
      <KioskClosed
        org={org}
        notInPlan
        admin={user?.role === "staff" || user?.role === "superadmin"}
        resourceNoun={resourceNoun}
      />
    );
  }

  /** The member chose a unit on the map; ask how long. */
  const choseUnit = (unit, stay) => {
    setWalkError(null);
    setWalk((w) => ({ ...w, unit, stay }));
    setStep(STEP.DURATION);
  };

  /** Check in for the chosen length. The server decides every limit again. */
  const confirmStay = async (choice) => {
    setBusy(true);
    setWalkError(null);
    try {
      const r = await api.assignWalkIn(organizationId, cardUid, walk.unit.resourceId, walk.unit.unitLabel, {
        ...(choice.untilLimit ? { untilLimit: true } : { minutes: choice.minutes }),
        ...(walk.mode === "cancel" ? { cancelReservationId: walk.upcoming.id } : {}),
      });
      setResult({
        kind: "checked-in",
        member: walk.member,
        reservation: r.reservation,
        cancelled: r.cancelled,
        keptFor: walk.mode === "keep" ? walk.upcoming : null,
      });
      setStep(STEP.RESULT);
    } catch (err) {
      setWalkError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // The walk-in map wants the width — and the height — of a wall screen;
  // the rest reads best narrow and centred.
  const mapStep = step === STEP.WALKIN;

  return (
    <div
      className={`min-h-screen px-6 mx-auto text-ink-primary flex flex-col justify-center
        ${mapStep ? "max-w-5xl py-6" : "max-w-3xl py-10"}`}
    >
      <header className={`flex items-center gap-3 ${mapStep ? "mb-5" : "mb-8"}`}>
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
          <Button icon={RotateCcw} onClick={reset} aria-label="Start over">
            <span className="hidden sm:inline">Start over</span>
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
          <Notice>New cards are registered by staff. If yours isn't recognised, please ask at the desk.</Notice>
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

        {step === STEP.PROMPT && walk && (
          <LaterTodayStep
            key="prompt"
            member={walk.member}
            upcoming={walk.upcoming}
            options={walk.options}
            onCancelIt={() => {
              setWalk((w) => ({ ...w, mode: "cancel", allowance: w.options.cancel }));
              setStep(STEP.WALKIN);
            }}
            onKeepIt={() => {
              setWalk((w) => ({ ...w, mode: "keep", allowance: w.options.keep }));
              setStep(STEP.WALKIN);
            }}
            onNotNow={reset}
          />
        )}

        {step === STEP.WALKIN && walk && (
          <WalkInStep
            key="walkin"
            organizationId={organizationId}
            member={walk.member}
            mode={walk.mode}
            allowance={walk.allowance}
            upcoming={walk.upcoming}
            minimum={walk.minimum || 30}
            resourceNoun={resourceNoun}
            org={org}
            onError={setError}
            onPick={choseUnit}
          />
        )}

        {step === STEP.DURATION && walk?.unit && (
          <DurationStep
            key={`duration-${walk.unit.resourceId}-${walk.unit.unitLabel}`}
            unit={walk.unit}
            stay={walk.stay}
            maxStayHours={walk.maxStayHours}
            minimum={walk.minimum || 30}
            busy={busy}
            error={walkError}
            onConfirm={confirmStay}
            onBack={() => {
              setWalkError(null);
              setStep(STEP.WALKIN);
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

/**
 * The kiosk while it cannot take a tap. Shaped like the tap screen — the
 * same header, the same large type for reading at arm's length — so a wall
 * screen reads as a device waiting, not one that has crashed.
 *
 *   paused      the organization is suspended. It comes back by itself:
 *               OrgProvider asks again every minute while paused.
 *   ended       cancelled: the same screen, without the promise to reopen.
 *   notInPlan   the plan has no kiosk. Whoever is here is pointed to the
 *               web sign-in; staff and superadmins also to the plan page,
 *               since they are the ones who can ask for it.
 */
function KioskClosed({ org, notInPlan = false, ended = false, admin = false, resourceNoun = "resource" }) {
  const name = org?.name || "This organization";
  /** The member chose a unit on the map; ask how long. */
  const choseUnit = (unit, stay) => {
    setWalkError(null);
    setWalk((w) => ({ ...w, unit, stay }));
    setStep(STEP.DURATION);
  };

  /** Check in for the chosen length. The server decides every limit again. */
  const confirmStay = async (choice) => {
    setBusy(true);
    setWalkError(null);
    try {
      const r = await api.assignWalkIn(organizationId, cardUid, walk.unit.resourceId, walk.unit.unitLabel, {
        ...(choice.untilLimit ? { untilLimit: true } : { minutes: choice.minutes }),
        ...(walk.mode === "cancel" ? { cancelReservationId: walk.upcoming.id } : {}),
      });
      setResult({
        kind: "checked-in",
        member: walk.member,
        reservation: r.reservation,
        cancelled: r.cancelled,
        keptFor: walk.mode === "keep" ? walk.upcoming : null,
      });
      setStep(STEP.RESULT);
    } catch (err) {
      setWalkError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // The walk-in map wants the width — and the height — of a wall screen;
  // the rest reads best narrow and centred.
  const mapStep = step === STEP.WALKIN;

  return (
    <div
      className={`min-h-screen px-6 mx-auto text-ink-primary flex flex-col justify-center
        ${mapStep ? "max-w-5xl py-6" : "max-w-3xl py-10"}`}
    >
      <header className={`flex items-center gap-3 ${mapStep ? "mb-5" : "mb-8"}`}>
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          <ContactRound size={22} />
        </div>
        <div className="text-lg font-semibold">{org?.name || "Kiosk"}</div>
      </header>

      <div className="flex flex-col items-center justify-center text-center py-6 sm:py-10">
        <div className="w-36 h-36 sm:w-44 sm:h-44 rounded-[2rem] flex items-center justify-center mb-9 bg-bg-panel border border-line/10 text-ink-secondary">
          {notInPlan ? <CircleSlash size={64} strokeWidth={1.6} /> : <CirclePause size={64} strokeWidth={1.6} />}
        </div>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">
          {notInPlan ? "Kiosk check-in isn't available" : ended ? "Check-in has closed" : "Check-in is paused"}
        </h1>
        <p className="text-lg sm:text-xl text-ink-secondary mt-4 max-w-xl leading-relaxed">
          {notInPlan
            ? admin
              ? "Kiosk check-in and self-registration aren't part of your plan. Ask SILLA to add them."
              : `${name} doesn't check in at a kiosk. Sign in on the web to book a ${resourceNoun}.`
            : `${name} ${ended ? "is no longer taking" : "isn't taking"} check-ins or registrations${ended ? "" : " right now"}. Please ask a member of staff.`}
        </p>
        {notInPlan ? (
          <Link
            to={admin ? "/admin/plan" : "/login"}
            className="mt-10 inline-flex items-center gap-1.5 text-base font-medium text-ink-secondary
                       transition-colors duration-fast hover:text-ink-primary"
          >
            {admin ? "See plan & usage" : "Sign in"}
            <ArrowRight size={16} />
          </Link>
        ) : ended ? null : (
          <p className="mt-12 text-sm text-ink-muted">This screen reopens by itself when check-in is back.</p>
        )}
      </div>
    </div>
  );
}

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
            hint="The code printed on the card: 4 to 32 digits and letters A–F. Spaces and dashes don't matter."
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
      onError(kioskReason(err, memberNoun));
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

/** "Long Table 2 · Seat 3", or "Discussion Room A, both levels". */
function checkedInWhere(reservation, resourceNoun) {
  if (reservation.kind === "room") {
    const levels = reservation.roomLevels || 1;
    return levels > 1 ? `${reservation.resourceLabel}, all ${levels} levels` : reservation.resourceLabel;
  }
  return reservation.label || `${reservation.resourceLabel || resourceNoun} · ${reservation.unitLabel}`;
}

/** The outcome screens: OCC-1, OCC-3, OCC-6, ID-2 success, and see-staff. */
function ResultStep({ result, memberNoun, resourceNoun, onReset }) {
  const kind = result?.kind;

  const config = {
    "checked-in": {
      Icon: CircleCheck,
      tone: "available",
      title: result?.member?.firstName ? `You're checked in, ${result.member.firstName}.` : "You're checked in.",
      // Where to go, by the name the map beside the kiosk uses: "Long Table
      // 2 · Seat 3", or the room (on every level, when it has more than one).
      body: result?.reservation ? checkedInWhere(result.reservation, resourceNoun) : null,
      foot: result?.reservation?.endTime
        ? `Until ${clock(result.reservation.endTime)}. Tap again when you leave.`
        : "Tap again when you leave.",
      notes: [
        result?.keptFor && `You'll need to leave by ${clock(result.keptFor.startTime)} for your reservation.`,
        result?.cancelled && `Your ${clock(result.cancelled.startTime)} reservation is cancelled.`,
      ].filter(Boolean),
    },
    "no-walk-in": {
      Icon: CircleSlash,
      tone: "occupied",
      title: result?.member?.firstName ? `Sorry, ${result.member.firstName}.` : "Sorry.",
      body: result?.reason || "There's nothing free to take right now.",
      foot: "Please ask a member of staff if you need help.",
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
    "registration-closed": {
      Icon: CircleSlash,
      tone: "occupied",
      title: "This card isn't registered yet",
      body:
        result?.reason === "REGISTRATION_DISABLED"
          ? `New ${memberNoun}s are set up by staff here, not at the kiosk.`
          : `New ${memberNoun}s can't be registered here right now.`,
      foot: "Please ask a member of staff.",
    },
    unknown: {
      Icon: CircleCheck,
      tone: "occupied",
      title: "Card recognised",
      body: null,
      foot: null,
    },
  }[kind] || {};

  const { Icon = CircleCheck, tone = "available", title, body, foot, notes = [] } = config;

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
      {notes.map((note) => (
        <p key={note} className="mt-3 text-base font-medium" style={{ color: "var(--color-state-reserved)" }}>
          {note}
        </p>
      ))}
      {foot && <p className="text-sm text-ink-muted mt-4">{foot}</p>}

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
