import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, CalendarClock, CalendarX, Clock, Hourglass, LogIn, MapPin } from "lucide-react";
import { api } from "../lib/api.js";
import { stepSwap } from "../lib/motion.js";
import { useFloorDay } from "../lib/useFloorDay.js";
import { useFloorSocket } from "../lib/useFloorSocket.js";
import { clock, clockRange, dateKeyOf, entryFor } from "../lib/dayView.js";
import { formatLength } from "../lib/bookingWindow.js";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import SpaceMap from "./SpaceMap.jsx";
import { Button, Notice, Segmented, Spinner } from "./ui/index.jsx";

/**
 * The kiosk after a member's tap, when it has something to ASK them (OCC-2):
 *
 *   LaterTodayStep   they have a booking later today: check in now and
 *                    cancel it, check in now and keep it, or not now
 *   WalkInStep       what is free right now, on the floor map — only units
 *                    free for at least half an hour can be chosen
 *   DurationStep     how long, in half hours from now, up to the shortest
 *                    of every limit — and the limit said in words
 *
 * The kiosk only ever seats people from now on; booking for later is the
 * website's. Everything here is a wall screen: large targets, large type,
 * nothing that needs a keyboard. The server checks every limit again when
 * the walk-in is made (walkInAtKiosk) and refuses a stay that runs past one;
 * what is shown here is so the member is never offered something it will
 * refuse.
 */

const MINUTE = 60_000;

/** Why a stay ends when it does — the server's own sentences (occupancy.js limitSentence). */
export function limitWords(limit, at, maxStayHours = 4) {
  switch (limit) {
    case "booking":
      return `Free until ${clock(at)}`;
    case "own":
      return `You'll need to leave by ${clock(at)}`;
    case "closing":
      return `We close at ${clock(at)}`;
    case "closure":
      return `We're closed from ${clock(at)}`;
    default:
      return `Stays are up to ${maxStayHours} hours`;
  }
}

/**
 * How long a walk-in at `entry` could last from now: the member's own
 * limit (`allowance`, from the tap: maximum stay, closing, their own next
 * booking) or the unit's next booking or closure, whichever is first.
 */
export function stayFor(entry, allowance) {
  const limits = [{ at: new Date(allowance.latestEnd), limit: allowance.limit }];
  if (entry?.freeUntil) {
    limits.push({ at: new Date(entry.freeUntil), limit: entry.freeUntilReason === "closure" ? "closure" : "booking" });
  }
  // On a tie, the unit's booking is what the member can see on the map.
  limits.sort((a, b) => a.at - b.at || (a.limit === "booking" ? -1 : 1));
  return limits[0];
}

/* ─────────────────────────────── a booking later today ─────────────────────────────── */

/**
 * "You have a reservation at 3:00 PM (Focus desk · 4). Would you like to:"
 *
 *   a) check in now and cancel it — sit anywhere free now; the booking is
 *      given up in the same step as the check-in, so nothing is lost if
 *      the check-in fails
 *   b) check in now and keep it — leave by 3:00 PM; withheld, saying why,
 *      when there is less than half an hour before it
 *   c) not now
 */
export function LaterTodayStep({ member, upcoming, options, onCancelIt, onKeepIt, onNotNow }) {
  const at = clock(upcoming.startTime);
  const where = upcoming.label || upcoming.resourceLabel || "your reservation";
  const nothingNow = !options.cancel.available && !options.keep.available;

  return (
    <motion.div {...stepSwap()} className="py-2">
      <div className="mb-8 flex flex-col items-center text-center">
        <span
          className="mb-6 grid h-20 w-20 place-items-center rounded-2xl"
          style={{ background: "rgb(var(--c-state-reserved) / 0.16)", color: "var(--color-state-reserved)" }}
        >
          <CalendarClock size={38} strokeWidth={1.8} />
        </span>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {member?.firstName ? `${member.firstName}, you` : "You"} have a reservation at {at}
        </h1>
        <p className="mt-3 text-lg text-ink-secondary">
          {where} · {clockRange(upcoming.startTime, upcoming.endTime)} today
        </p>
        <p className="mt-6 text-lg font-medium">{nothingNow ? options.cancel.reason : "Would you like to:"}</p>
      </div>

      <div className="space-y-3">
        {!nothingNow && (
          <>
            <Choice
              letter="a"
              icon={LogIn}
              title={`Check in now and cancel your ${at} reservation`}
              detail={
                options.cancel.available
                  ? `Sit anywhere that's free now. ${where} at ${at} is released for someone else.`
                  : options.cancel.reason
              }
              disabled={!options.cancel.available}
              onClick={onCancelIt}
            />
            <Choice
              letter="b"
              icon={Hourglass}
              title="Check in now and keep it"
              detail={
                options.keep.available
                  ? `Sit somewhere until ${at}, then go to your reservation.`
                  : options.keep.reason
              }
              disabled={!options.keep.available}
              onClick={onKeepIt}
            />
          </>
        )}
        <Choice letter={nothingNow ? null : "c"} icon={CalendarX} title="Not now" detail="Keep your reservation and come back later." onClick={onNotNow} quiet />
      </div>
    </motion.div>
  );
}

/** One large option on the prompt — the whole row is the target. */
function Choice({ letter, icon: Icon, title, detail, disabled = false, quiet = false, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-4 rounded-xl border p-5 text-left transition-colors duration-fast
        ${quiet ? "border-line/10 bg-transparent hover:bg-bg-panel/60" : "border-line/15 bg-bg-card shadow-raised hover:border-line/30"}
        disabled:cursor-not-allowed disabled:opacity-100`}
    >
      <span
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg"
        style={
          disabled
            ? { background: "rgb(var(--c-line) / 0.06)", color: "var(--color-ink-muted)" }
            : quiet
              ? { background: "rgb(var(--c-line) / 0.08)", color: "var(--color-ink-secondary)" }
              : { background: "rgb(var(--c-accent) / 0.14)", color: "var(--color-accent)" }
        }
      >
        <Icon size={22} />
      </span>
      <span className="min-w-0">
        <span className={`block text-lg font-semibold leading-snug ${disabled ? "text-ink-muted" : ""}`}>
          {letter && <span className="mr-1.5 text-ink-muted">{letter})</span>}
          {title}
        </span>
        <span className={`mt-1 block text-base leading-relaxed ${disabled ? "text-ink-secondary" : "text-ink-secondary"}`}>
          {detail}
        </span>
      </span>
    </button>
  );
}

/* ─────────────────────────────── what is free now ─────────────────────────────── */

/**
 * The floor map, with only what can be taken right now: a unit free for at
 * least `minimum` minutes before its next booking, closing, or the member's
 * own limit. Everything else fades and does nothing when tapped. Each unit
 * answers taps across its whole share of its piece, for a finger at arm's
 * length rather than a mouse.
 *
 * Live: a unit taken at another kiosk or on the website fades as it goes.
 */
export function WalkInStep({ organizationId, member, mode, allowance, upcoming, minimum = 30, resourceNoun, org, onPick, onError }) {
  /** Buildings with floors, from the map's own hierarchy, so a wall screen offers "which building, which floor" the way the map does. */
  const [buildings, setBuildings] = useState([]);
  const [floorId, setFloorId] = useState(null);
  const [layout, setLayout] = useState(null);
  const [status, setStatus] = useState({});
  const [dayVersion, setDayVersion] = useState(0);
  const [notice, setNotice] = useState(null);
  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const { day } = useFloorDay(floorId, dateKeyOf(new Date()), dayVersion);

  useEffect(() => {
    api
      .getSpaces(organizationId)
      .then((d) => {
        const withFloors = d.buildings.filter((building) => building.floors.length);
        setBuildings(withFloors);
        setFloorId((current) => current || withFloors[0]?.floors[0]?.id || null);
      })
      .catch((e) => onError(e.message));
  }, [organizationId, onError]);
  const building = buildings.find((candidate) => candidate.floors.some((floor) => floor.id === floorId));

  useEffect(() => {
    if (!floorId) return;
    setLayout(null);
    api
      .getFloorLayout(floorId)
      .then((d) => {
        setLayout(d);
        setStatus(d.status);
      })
      .catch((e) => onError(e.message));
  }, [floorId, onError]);

  const applyStatus = useCallback((resourceId, units) => setStatus((s) => ({ ...s, [resourceId]: units })), []);
  const dayChanged = useCallback(() => setDayVersion((n) => n + 1), []);
  useFloorSocket(floorId, applyStatus, dayChanged);

  /** A unit's stay from now, or null when it cannot be taken. */
  const stayAt = useCallback(
    (resourceId, unitLabel) => {
      const entry = entryFor(day, resourceId, unitLabel);
      if (!entry?.freeNow) return null;
      const stay = stayFor(entry, allowance);
      return stay.at - Date.now() >= minimum * MINUTE ? stay : null;
    },
    [day, allowance, minimum]
  );

  const view = useMemo(
    () =>
      day && {
        isFree: (resourceId, unitLabel) => Boolean(stayAt(resourceId, unitLabel)),
        freeWords: "Free now",
        takenWords: "Not free now",
      },
    [day, stayAt]
  );

  const freeHere = useMemo(() => {
    if (!layout || !day) return null;
    let free = 0;
    for (const resource of layout.layout.resources) {
      for (const unit of resource.units) if (stayAt(resource.id, unit.label)) free += 1;
    }
    return free;
  }, [layout, day, stayAt]);

  const pick = (unit) => {
    const stay = stayAt(unit.resourceId, unit.unitLabel);
    if (!stay) {
      const entry = entryFor(day, unit.resourceId, unit.unitLabel);
      setNotice(
        entry?.freeNow
          ? `That ${unit.kind === "room" ? "room" : resourceNoun} is only free for a few minutes. Please choose another.`
          : `That ${unit.kind === "room" ? "room" : resourceNoun} isn't free right now. Please choose a bright one.`
      );
      return;
    }
    setNotice(null);
    // The map names it: "Long Table 2 · Seat 3", or the room.
    onPick({ ...unit, label: unit.label || (unit.kind === "room" ? unit.type?.label : `${unit.type?.label} · ${unit.unitLabel}`) }, stay);
  };

  const heading =
    mode === "cancel"
      ? { title: "Choose where to sit", body: `Your ${clock(upcoming.startTime)} reservation is cancelled when you check in.` }
      : mode === "keep"
        ? { title: `Choose where to sit until ${clock(upcoming.startTime)}`, body: "Your reservation stays booked for you." }
        : {
            title: "You don't have a reservation",
            body: `Here's what's free right now. Tap a bright ${resourceNoun} to sit there.`,
          };

  return (
    <motion.div {...stepSwap()}>
      <div className="mb-5">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{heading.title}</h1>
        <p className="mt-2 text-lg text-ink-secondary">
          {member?.firstName ? `${member.firstName}, ` : ""}
          {heading.body.charAt(0).toLowerCase() + heading.body.slice(1)}
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-3">
        {buildings.length > 1 && (
          <Segmented
            size="lg"
            className="kioskbuildings"
            value={building?.id}
            onChange={(id) => setFloorId(buildings.find((b) => b.id === id)?.floors[0]?.id)}
            options={buildings.map((b) => ({ value: b.id, label: b.name }))}
          />
        )}
        {building && building.floors.length > 1 && (
          <Segmented
            size="lg"
            className="kioskfloors"
            value={floorId}
            onChange={setFloorId}
            options={building.floors.map((f) => ({ value: f.id, label: f.name }))}
          />
        )}
        {freeHere !== null && (
          <p className="text-base text-ink-secondary" role="status">
            <span className="font-semibold text-ink-primary">{freeHere}</span> free for at least {formatLength(minimum)} here
          </p>
        )}
      </div>

      {notice && (
        <div className="mb-3">
          <Notice>{notice}</Notice>
        </div>
      )}

      {/* The floor's own shape, as tall as the screen allows and no
          taller: a wall screen should not need scrolling to reach the
          bottom of the floor, and a phone should not letterbox it in a box
          taller than the floor is. */}
      <div className="relative overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-raised">
        {layout && day ? (
          <SpaceMap
            maxHeight="max(300px, calc(100vh - 360px))"
            floor={layout.floor}
            layout={layout.layout}
            resourceTypes={layout.resourceTypes}
            status={status}
            resourceNoun={resourceNoun}
            palette={palette}
            rings={false}
            windowView={view}
            selectableOnly
            touchTargets
            onSelectUnit={pick}
          />
        ) : (
          <div className="flex h-[46vh] items-center justify-center gap-2 text-lg text-ink-secondary">
            <Spinner size={20} /> Loading the map…
          </div>
        )}
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <MapPin size={15} className="shrink-0" />
        Bright {resourceNoun}s are free for at least {formatLength(minimum)}; faded ones are taken or about to be. Pinch to zoom.
      </p>
    </motion.div>
  );
}

/* ─────────────────────────────── how long ─────────────────────────────── */

/**
 * The stays on offer from now: every half hour up to the limit, and the
 * limit itself when it falls between two — "until 3:00 PM" — so the time
 * someone else's booking leaves is not wasted.
 */
export function staysUntil(limitAt, now = Date.now(), minimum = 30) {
  const total = Math.floor((new Date(limitAt) - now) / MINUTE);
  const stays = [];
  for (let minutes = minimum; minutes <= total; minutes += 30) {
    stays.push({ minutes, end: new Date(now + minutes * MINUTE) });
  }
  const last = stays[stays.length - 1];
  if (!last || total - last.minutes >= 5) stays.push({ minutes: total, end: new Date(limitAt), untilLimit: true });
  return stays;
}

/** "1 h 35 min" — a stay that is not a whole half hour. */
const compactLength = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
};

/**
 * How long, in half hours from now. The longest is chosen to begin with —
 * a walk-in used to run to the maximum stay, and checking out early frees
 * the place anyway — and the sentence above says what limits it: "Free
 * until 3:00 PM" when someone else's booking does.
 */
export function DurationStep({ unit, stay, maxStayHours, minimum = 30, busy = false, error = null, onConfirm, onBack }) {
  const [now] = useState(() => Date.now());
  // The maximum stay runs from NOW, not from the tap a minute ago: measured
  // from the tap, "4 hours" turned into "until 8:11 AM, 3 h 59 min".
  const limitAt = stay.limit === "max-stay" ? new Date(now + maxStayHours * 60 * MINUTE) : stay.at;
  const stays = useMemo(() => staysUntil(limitAt, now, minimum), [+limitAt, now, minimum]); // eslint-disable-line react-hooks/exhaustive-deps
  const [chosen, setChosen] = useState(stays.length - 1);
  const choice = stays[Math.min(chosen, stays.length - 1)];

  return (
    <motion.div {...stepSwap()}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 rounded-md py-2 text-base text-ink-secondary transition-colors hover:text-ink-primary"
      >
        <ArrowLeft size={18} />
        Choose another
      </button>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">How long will you stay?</h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-lg text-ink-secondary">
        <span className="font-medium text-ink-primary">{unit.label}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1.5">
          <Clock size={17} className="shrink-0" />
          {limitWords(stay.limit, limitAt, maxStayHours)}
        </span>
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="How long">
        {stays.map((option, i) => {
          const selected = i === chosen;
          return (
            <button
              key={option.minutes}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setChosen(i)}
              className="flex min-h-[84px] flex-col items-start justify-center rounded-xl border px-5 py-3 text-left transition-colors duration-fast"
              style={
                selected
                  ? { borderColor: "var(--color-accent)", background: "rgb(var(--c-accent) / 0.12)", boxShadow: "inset 0 0 0 1px var(--color-accent)" }
                  : { borderColor: "rgb(var(--c-line) / 0.12)", background: "rgb(var(--c-bg-card))" }
              }
            >
              <span className="text-xl font-semibold">
                {option.untilLimit ? `Until ${clock(option.end)}` : formatLength(option.minutes)}
              </span>
              <span className="mt-0.5 text-sm text-ink-secondary">
                {option.untilLimit ? compactLength(option.minutes) : `until ${clock(option.end)}`}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-5">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <Button
        variant="primary"
        size="lg"
        icon={LogIn}
        loading={busy}
        onClick={() => onConfirm(choice)}
        className="mt-6 h-14 w-full text-base"
      >
        Check in until {clock(choice.end)}
      </Button>
    </motion.div>
  );
}

/**
 * Returns the kiosk to its tap screen after `ms` with nobody touching it —
 * a shared wall screen must not sit on someone's half-made choice for the
 * next person. Any tap, click or key starts the wait again.
 */
export function useIdleReset(active, ms, onIdle) {
  useEffect(() => {
    if (!active) return undefined;
    let timer = setTimeout(onIdle, ms);
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, ms);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) => window.addEventListener(name, restart, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, restart));
    };
  }, [active, ms, onIdle]);
}
