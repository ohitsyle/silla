import { useEffect, useState } from "react";
import { CalendarCheck, CircleCheck, Clock, LoaderCircle } from "lucide-react";
import { api } from "../lib/api.js";
import { formatSpan } from "../lib/bookingWindow.js";
import { memberReason } from "../lib/rooms.js";
import { Badge, Button, Notice, PinField } from "./ui/index.jsx";
import WhenFields from "./WhenFields.jsx";

/**
 * ReservePanel — RES-1's confirmation step (spec §9).
 *
 * "Select available resource + time; card + PIN confirm; Resource held on
 * confirm." The PIN is asked for again here rather than trusting the
 * session, because spec §5 requires card plus PIN to reserve: a phone
 * left signed in must not be able to spend someone's one reservation.
 *
 * `target` is what is being booked — one unit, or a room as a whole:
 *   { kind: "unit"|"room", resourceId, unitLabel, title, status }
 * `booking` is the page's shared window (lib/bookingWindow), so the time
 * chosen while browsing a room is the time confirmed here.
 *
 * The availability line is the same check the claim makes, run as the
 * time changes. Problems with what the MEMBER typed (the PIN) are only
 * shown once they press the button; nothing is red before they have had
 * a chance to do it.
 */
export default function ReservePanel({ target, booking, resourceNoun = "resource", policy, holding = false, onReserved }) {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);

  const isRoom = target.kind === "room";
  const what = isRoom ? "room" : resourceNoun;

  // A different target starts a fresh confirmation.
  useEffect(() => {
    setPin("");
    setPinError(null);
    setError(null);
  }, [target.resourceId, target.unitLabel]);

  // "Is it free then?" — debounced, and ignored if the question changed
  // before the answer arrived.
  useEffect(() => {
    if (holding || !booking.iso) {
      setAvailability(null);
      return undefined;
    }
    let current = true;
    setChecking(true);
    const timer = setTimeout(() => {
      api
        .reservationAvailability(target.resourceId, target.unitLabel, booking.iso.startTime, booking.iso.endTime)
        .then((result) => current && setAvailability(result))
        .catch((err) => current && setAvailability({ bookable: false, error: err.message }))
        .finally(() => current && setChecking(false));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [target.resourceId, target.unitLabel, booking.iso, holding]);

  // Unavailable or out of service RIGHT NOW is not a matter of timing: the
  // server refuses every window until staff change it, so say so plainly
  // instead of offering a form that cannot succeed.
  const outOfService = target.status?.serviceStatus === "out_of_service";
  if (!isRoom && (outOfService || target.status?.status === "unavailable")) {
    return (
      <Notice>
        This {resourceNoun} is {outOfService ? "out of service" : "unavailable"} and can't be booked until staff
        reopen it. Pick another one on the map.
      </Notice>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (pin.length !== 6) {
      setPinError("Enter your 6-digit PIN to confirm.");
      return;
    }
    setPinError(null);
    if (booking.problem) return setError(booking.problem);
    if (availability?.bookable === false) return setError(memberReason(availability));

    setBusy(true);
    try {
      const created = await api.createReservation({
        resourceId: target.resourceId,
        unitLabel: target.unitLabel,
        startTime: booking.iso.startTime,
        endTime: booking.iso.endTime,
        pin,
      });
      setPin("");
      onReserved?.(created.reservation);
    } catch (err) {
      if (err.status === 401) setPinError(err.message);
      else setError(memberReason({ code: err.body?.code, error: err.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <WhenFields booking={booking} />

      {!booking.problem && <AvailabilityLine checking={checking} availability={availability} />}

      {holding ? (
        <Notice>
          You already hold a reservation — one at a time. Cancel it above to book this {what} instead.
        </Notice>
      ) : (
        <>
          <PinField
            label="Confirm with your 6-digit PIN"
            name="reserve-pin"
            value={pin}
            onChange={(value) => {
              setPin(value);
              if (pinError) setPinError(null);
            }}
            error={pinError}
          />
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" variant="primary" size="lg" icon={CircleCheck} loading={busy} className="w-full">
            {isRoom ? "Reserve the whole room" : `Reserve this ${resourceNoun}`}
          </Button>
          <p className="text-xs leading-relaxed text-ink-muted">
            Tap your card within {policy?.gracePeriodMinutes ?? 10} minutes of the start, or the{" "}
            {what} is released for someone else.
          </p>
        </>
      )}
    </form>
  );
}

/** "Free for this time", the reason it isn't, or that we are still asking. */
function AvailabilityLine({ checking, availability }) {
  if (checking || !availability) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ink-muted" role="status">
        <LoaderCircle size={14} className="animate-spin" />
        Checking this time…
      </p>
    );
  }
  if (availability.bookable) {
    return (
      <p className="flex items-center gap-1.5 text-sm font-medium text-state-available" role="status">
        <CircleCheck size={15} />
        Free for this time
      </p>
    );
  }
  return <Notice tone="error">{memberReason(availability)}</Notice>;
}

/**
 * The member's one live reservation (RES-3 allows one at a time), with
 * the way out of it. Shown at the top of the panel whatever else is
 * selected, because it is the reason nothing else can be booked —
 * `compact` while a room or unit is the subject, so it stays a reminder
 * rather than pushing what they came for below the fold.
 */
export function MyReservation({ reservation, resourceNoun = "resource", policy, compact = false, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const held = reservation.status === "held";
  const title = reservation.roomId
    ? reservation.resourceLabel
    : `${reservation.resourceLabel || resourceNoun} · ${reservation.unitLabel}`;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancelReservation(reservation.id);
      onCancelled?.();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const actions = confirming ? (
    <>
      <Button size="sm" variant="danger" loading={busy} onClick={cancel}>
        Yes, cancel it
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep it
      </Button>
    </>
  ) : (
    <Button size="sm" onClick={() => setConfirming(true)}>
      Cancel reservation
    </Button>
  );

  if (compact) {
    return (
      <section
        aria-label="Your reservation"
        className="rounded-lg border px-3 py-2.5"
        style={{ borderColor: "rgb(var(--c-accent) / 0.3)", background: "rgb(var(--c-accent) / 0.05)" }}
      >
        <div className="flex items-center gap-2.5">
          <CalendarCheck size={16} className="shrink-0" style={{ color: "var(--color-accent)" }} />
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="text-ink-muted">You hold </span>
            <span className="font-medium">{title}</span>
            <span className="text-ink-muted"> · {formatSpan(reservation.startTime, reservation.endTime)}</span>
          </p>
        </div>
        {error && (
          <Notice tone="error" className="mt-2">
            {error}
          </Notice>
        )}
        <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
      </section>
    );
  }

  return (
    <section
      aria-label="Your reservation"
      className="rounded-lg border p-4"
      style={{ borderColor: "rgb(var(--c-accent) / 0.35)", background: "rgb(var(--c-accent) / 0.06)" }}
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
          style={{ background: "rgb(var(--c-accent) / 0.16)", color: "var(--color-accent)" }}
        >
          <CalendarCheck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">Your reservation</p>
          <p className="mt-0.5 truncate font-semibold">{title}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            {formatSpan(reservation.startTime, reservation.endTime)}
          </p>
        </div>
        <Badge tone={held ? "reserved" : "occupied"}>{held ? "Booked" : "Checked in"}</Badge>
      </div>

      {held && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Tap your card within {policy?.gracePeriodMinutes ?? 10} minutes of the start to check in.
        </p>
      )}
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}

      <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}
