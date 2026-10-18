import { useEffect, useState } from "react";
import { CalendarCheck, CircleCheck, Clock, LoaderCircle } from "lucide-react";
import { api } from "../lib/api.js";
import { formatSpan } from "../lib/bookingWindow.js";
import { entryFor } from "../lib/dayView.js";
import { memberReason } from "../lib/rooms.js";
import { Badge, Button, Notice, PinField } from "./ui/index.jsx";
import DayTimeline from "./DayTimeline.jsx";
import WhenFields from "./WhenFields.jsx";

/**
 * ReservePanel — RES-1's confirmation step (spec §9).
 *
 * "Select available resource + time; card + PIN confirm; Resource held on
 * confirm." The PIN is asked for again here rather than trusting the
 * session, because spec §5 requires card plus PIN to reserve: a phone
 * left signed in must not be able to book on someone's behalf.
 *
 * `target` is what is being booked — one unit, or a room as a whole:
 *   { kind: "unit"|"room", resourceId, unitLabel, title, status }
 * `booking` is the page's shared window (lib/bookingWindow), so the time
 * chosen while browsing a room is the time confirmed here. `day` is the
 * floor's day for that window's date: the timeline at the top draws this
 * unit's bookings and writes a tapped or dragged time into the window.
 *
 * The availability line is the same check the claim makes, run as the
 * time changes — including what the member already holds (one booking for
 * now and one for later, never overlapping), so "you already have one
 * coming up" arrives before the PIN rather than after it. Problems with
 * what the MEMBER typed (the PIN) are only shown once they press the
 * button; nothing is red before they have had a chance to do it.
 */
export default function ReservePanel({ target, booking, resourceNoun = "resource", policy, day = null, roomName = null, onReserved }) {
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
    if (!booking.iso) {
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
  }, [target.resourceId, target.unitLabel, booking.iso]);

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

  const entry = entryFor(day, target.resourceId, target.unitLabel);

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {entry && (
        <DayTimeline
          day={day}
          entry={entry}
          window={booking.iso ? { start: booking.startTime, end: booking.endTime } : null}
          maxStayHours={booking.maxStayHours}
          noun={resourceNoun}
          roomName={isRoom ? target.typeLabel : roomName}
          onChoose={booking.choose}
        />
      )}
      <WhenFields booking={booking} />

      {!booking.problem && <AvailabilityLine checking={checking} availability={availability} />}

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
 * One of the member's reservations, with the way out of it. A member holds
 * at most one for now and one for later (RES-3), so the panel shows up to
 * two of these, the current one first — at the top whatever else is
 * selected, because they are what limits what can be booked next.
 * `compact` while a room or unit is the subject, so they stay a reminder
 * rather than pushing what the member came for below the fold.
 *
 * `reservation.phase` is "current" (checked in, or its check-in window is
 * open) or "upcoming" (later today, or another day).
 */
export function MyReservation({ reservation, resourceNoun = "resource", policy, compact = false, readOnly = false, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const held = reservation.status === "held";
  const upcoming = reservation.phase === "upcoming";
  const heading = !held ? "You're checked in" : upcoming ? "Coming up" : "Your reservation now";
  const badge = !held ? "Checked in" : upcoming ? "Booked" : "Now";
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

  // While the organization is paused nothing can change, cancelling
  // included — so the reservation is shown, and says why it has no button.
  const actions = readOnly ? (
    <p className="text-xs leading-relaxed text-ink-muted">Bookings are paused, so this can't be changed right now.</p>
  ) : confirming ? (
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
            <span className="text-ink-muted">{!held ? "Checked in at " : upcoming ? "Coming up: " : "Now: "}</span>
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
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{heading}</p>
          <p className="mt-0.5 truncate font-semibold">{title}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            {formatSpan(reservation.startTime, reservation.endTime)}
          </p>
        </div>
        <Badge tone={held ? "reserved" : "occupied"}>{badge}</Badge>
      </div>

      {held && !readOnly && (
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
