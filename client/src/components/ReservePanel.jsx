import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, Clock, X } from "lucide-react";
import { api } from "../lib/api.js";
import { panelEnter } from "../lib/motion.js";
import { Button, Card, Field, Notice, PinField, Select } from "./ui/index.jsx";

/**
 * ReservePanel — RES-1 (spec §9).
 *
 * "Select available resource + time; card + PIN confirm; Resource held
 * on confirm." The PIN is re-entered here rather than relying on the
 * session, because spec §5 requires card plus PIN to reserve — a live
 * session alone must not be able to spend someone's one reservation.
 *
 * Also renders the caller's existing reservation, since RES-3 allows
 * only one at a time: the panel has to explain why the button is gone.
 */

/** Rounds up to the next quarter hour — nobody books at 14:07. */
function nextQuarterHour(from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
  return d;
}

/**
 * The first bookable moment given the organization's operating hours
 * (spec §10). Defaulting the form to "now" is wrong outside opening
 * times: the server rejects it, and the member only finds out after
 * typing their PIN. Roll forward to the next opening instead.
 */
const MIN_SLOT_MINUTES = 30;

function firstBookableSlot(operatingHours) {
  const now = nextQuarterHour();
  if (!operatingHours?.open || !operatingHours?.close) return now;

  const [oh, om] = String(operatingHours.open).split(":").map(Number);
  const [ch, cm] = String(operatingHours.close).split(":").map(Number);
  const openMin = oh * 60 + (om || 0);
  const closeMin = ch * 60 + (cm || 0);
  const minutes = now.getHours() * 60 + now.getMinutes();

  const tomorrowOpen = () => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(oh, om || 0, 0, 0);
    return d;
  };

  if (minutes < openMin) {
    const d = new Date(now);
    d.setHours(oh, om || 0, 0, 0);
    return d;
  }
  // Past closing, OR so close to it that the shortest bookable slot
  // wouldn't fit — either way today is done, so offer tomorrow rather
  // than a form whose submit button is permanently disabled.
  if (minutes >= closeMin || closeMin - minutes < MIN_SLOT_MINUTES) {
    return tomorrowOpen();
  }
  return now;
}

const toLocalInput = (date) => {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const formatWhen = (value) =>
  new Date(value).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function ReservePanel({
  selectedUnit,
  resourceNoun = "resource",
  policy,
  myReservation,
  onClose,
  onReserved,
  onCancelled,
  embedded = false,
}) {
  const maxStayHours = policy?.maxStayHours ?? 4;
  const openingHours = policy?.operatingHours;

  const [start, setStart] = useState(() => toLocalInput(firstBookableSlot(openingHours)));
  const [duration, setDuration] = useState(Math.min(2, maxStayHours));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setError(null);
    setPin("");
  }, [selectedUnit?.resourceId, selectedUnit?.unitIndex]);

  // Recompute the default start whenever a different unit is picked, or
  // once the org's operating hours actually arrive. The useState
  // initializer above runs on first mount — before the org config has
  // loaded — so without this the form keeps a default of "now", which
  // the server rejects outside opening times.
  useEffect(() => {
    setStart(toLocalInput(firstBookableSlot(openingHours)));
  }, [openingHours?.open, openingHours?.close, selectedUnit?.resourceId, selectedUnit?.unitIndex]);

  /**
   * How long can actually be booked from the chosen start: the org's
   * max-stay cap, but never past closing time. Without this, someone
   * arriving at 17:30 in a building that shuts at 19:00 gets offered a
   * 4-hour default and is rejected for a reason the form never showed.
   */
  const maxDuration = useMemo(() => {
    const startsAt = new Date(start);
    if (Number.isNaN(startsAt.getTime()) || !openingHours?.close) return maxStayHours;
    const [ch, cm] = String(openingHours.close).split(":").map(Number);
    const closesAt = new Date(startsAt);
    closesAt.setHours(ch, cm || 0, 0, 0);
    const untilClose = (closesAt - startsAt) / 3_600_000;
    // Round down to the nearest half hour the picker offers.
    return Math.max(0, Math.min(maxStayHours, Math.floor(untilClose * 2) / 2));
  }, [start, openingHours?.close, maxStayHours]);

  // Keep the selected duration inside what's actually bookable.
  useEffect(() => {
    setDuration((d) => (maxDuration > 0 ? Math.min(d, maxDuration) : d));
  }, [maxDuration]);

  /**
   * Distinguishes the two reasons a booking can be impossible, because
   * they need different advice: a start outside opening hours, versus a
   * start inside them with too little left before closing.
   */
  const startsInsideHours = useMemo(() => {
    const startsAt = new Date(start);
    if (Number.isNaN(startsAt.getTime()) || !openingHours?.open || !openingHours?.close) return true;
    const mins = startsAt.getHours() * 60 + startsAt.getMinutes();
    const [oh, om] = String(openingHours.open).split(":").map(Number);
    const [ch, cm] = String(openingHours.close).split(":").map(Number);
    return mins >= oh * 60 + (om || 0) && mins < ch * 60 + (cm || 0);
  }, [start, openingHours?.open, openingHours?.close]);

  const endTime = useMemo(
    () => new Date(new Date(start).getTime() + duration * 3600_000),
    [start, duration]
  );

  useEffect(() => {
    if (!selectedUnit || myReservation) return;
    let current = true;
    setChecking(true); setAvailability(null);
    const timer = setTimeout(() => {
      if (Number.isNaN(+new Date(start)) || Number.isNaN(+endTime)) { setChecking(false); return; }
      api.reservationAvailability(selectedUnit.resourceId, selectedUnit.unitLabel, new Date(start).toISOString(), endTime.toISOString())
        .then((result) => { if (current) setAvailability(result); })
        .catch((e) => { if (current) setAvailability({ bookable: false, error: e.message }); })
        .finally(() => { if (current) setChecking(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [selectedUnit?.resourceId, selectedUnit?.unitLabel, start, +endTime, Boolean(myReservation)]);

  const isFree = selectedUnit?.status?.status !== "unavailable";
  const outOfService = selectedUnit?.status?.serviceStatus === "out_of_service";


  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createReservation({
        resourceId: selectedUnit.resourceId,
        unitLabel: selectedUnit.unitLabel,
        startTime: new Date(start).toISOString(),
        endTime: endTime.toISOString(),
        pin,
      });
      onReserved?.(created.reservation);
      setPin("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api.cancelReservation(myReservation.id);
      onCancelled?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Already holding one (RES-3) ----
  if (myReservation) {
    return (
      <Shell embedded={embedded}>
        <Header embedded={embedded} title="Your reservation" onClose={onClose} />
        <div className="text-sm text-ink-secondary space-y-1">
          <div className="text-ink-primary font-medium">
            {myReservation.roomId ? myReservation.resourceLabel : `${myReservation.resourceLabel || resourceNoun} · ${resourceNoun} ${myReservation.unitLabel}`}
          </div>
          <div className="flex items-center gap-1.5">
            <Clock size={14} />
            {formatWhen(myReservation.startTime)} — {formatWhen(myReservation.endTime)}
          </div>
          <div>
            Status: <span className="text-ink-primary">{myReservation.status}</span>
            {myReservation.status === "held" && (
              <> · tap your card within {policy?.gracePeriodMinutes ?? 10} min of the start</>
            )}
          </div>
        </div>

        {error && <Alert>{error}</Alert>}

        <Button variant="danger" onClick={cancel} loading={busy} className="mt-4">
          Cancel reservation
        </Button>
        <p className="mt-3 text-xs text-ink-muted">
          One active reservation at a time. Cancel this one to book another.
        </p>
      </Shell>
    );
  }

  if (!selectedUnit) return null;

  // ---- Not bookable ----
  if (!isFree) {
    return (
      <Shell embedded={embedded}>
        <Header
          embedded={embedded}
          title={selectedUnit.kind === "room" ? selectedUnit.type.label : `${selectedUnit.type.label} · ${resourceNoun} ${selectedUnit.unitLabel}`}
          onClose={onClose}
        />
        <div className="text-sm text-ink-secondary">
          This {resourceNoun} is <span className="text-ink-primary">{selectedUnit.statusLabel}</span>
          {outOfService && " and cannot be booked until it's repaired"}.
        </div>
        <p className="mt-3 text-xs text-ink-muted">Pick an available {resourceNoun} to reserve it.</p>
      </Shell>
    );
  }

  // ---- Booking form ----
  return (
    <Shell embedded={embedded}>
      <Header
        embedded={embedded}
        title={selectedUnit.kind === "room" ? selectedUnit.type.label : `${selectedUnit.type.label} · ${resourceNoun} ${selectedUnit.unitLabel}`}
        subtitle={selectedUnit.kind === "room" ? `Includes all ${selectedUnit.levels?.length || 1} room level(s)` : `Cell (${selectedUnit.position.col}, ${selectedUnit.position.row})`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="space-y-4 mt-1">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field
            label="Starts"
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Select label="Length" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {Array.from({ length: Math.max(1, Math.round(maxDuration * 2)) }, (_, i) => (i + 1) / 2).map((h) => (
                <option key={h} value={h}>
                  {h} hour{h === 1 ? "" : "s"}
                </option>
              ))}
          </Select>
        </div>

        {maxDuration <= 0 && (
          <Alert>
            {startsInsideHours
              ? `Not enough time before closing at ${openingHours?.close}. Pick an earlier start, or a later day.`
              : `That start time is outside opening hours (${openingHours?.open}–${openingHours?.close}).`}
          </Alert>
        )}

        <div className="text-xs text-ink-muted">
          Until {formatWhen(endTime)} · max stay {maxStayHours}h
          {openingHours?.open && openingHours?.close && (
            <> · open {openingHours.open}–{openingHours.close}</>
          )}
        </div>

        <PinField label="Confirm with your 6-digit PIN" name="reserve-pin" value={pin} onChange={setPin} />

        {checking && <p className="text-xs text-ink-muted" role="status">Checking this time…</p>}
        {availability?.bookable === false && <Alert>{availability.error}</Alert>}
        {availability?.bookable && <p className="text-xs text-state-available" role="status">Available for this time</p>}
        {error && <Alert>{error}</Alert>}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          icon={CircleCheck}
          loading={busy}
          disabled={pin.length !== 6 || maxDuration <= 0 || checking || !availability?.bookable}
          className="w-full"
        >
          Reserve this {selectedUnit.kind === "room" ? "room" : resourceNoun}
        </Button>
      </form>
    </Shell>
  );
}

/** The panel slides in below the map; AnimatePresence handles the exit. */
/**
 * Draws its own card when the panel lives in a page, and gets out of the
 * way when the Inspector is hosting it — the Inspector already provides
 * the surface, the title and the close button, so rendering them again
 * would nest a card inside a card and show two close buttons.
 */
function Shell({ children, embedded }) {
  if (embedded) return <>{children}</>;
  return (
    <motion.div {...panelEnter()} className="mt-4">
      <Card>{children}</Card>
    </motion.div>
  );
}

function Header({ title, subtitle, onClose, embedded }) {
  if (embedded) return null;
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="mr-auto min-w-0">
        <div className="font-semibold text-ink-primary">{title}</div>
        {subtitle && <div className="text-xs text-ink-muted mt-0.5">{subtitle}</div>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-ink-muted hover:text-ink-primary transition-colors duration-fast ease-out rounded-sm"
      >
        <X size={18} />
      </button>
    </div>
  );
}

const Alert = ({ children }) => <Notice tone="error">{children}</Notice>;
