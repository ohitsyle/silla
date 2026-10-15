import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, DoorOpen, Grid2x2, Layers, X } from "lucide-react";
import { api } from "../lib/api.js";
import { levelName, listNames, plural, withArticle } from "../lib/rooms.js";
import { Notice, Segmented, Skeleton } from "./ui/index.jsx";
import WhenFields from "./WhenFields.jsx";

/**
 * What a room offers, in plain words, for the time the member has chosen.
 *
 * A room answers the last question of the map's hierarchy — building,
 * floor, room, then WHAT TO BOOK. The booking mode decides which options
 * exist, and each is stated as the thing the member would do:
 *
 *   whole / either        "Book the whole room"
 *   individual / either   "Pick a <noun> inside"
 *
 * Availability comes from one request for the whole room
 * (GET /api/reservations/rooms/:id/options), not one per unit, and is
 * asked for the CHOSEN window rather than for right now: someone planning
 * Thursday afternoon needs Thursday's answer, which the live colours on
 * the map cannot give them. The claim still decides; this is guidance.
 */
export default function RoomPanel({
  room,
  floors = [],
  floorId,
  booking,
  resourceNoun = "resource",
  refreshKey = 0,
  onBookRoom,
  onPickUnit,
  onHoverUnit,
  onShowLevel,
}) {
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Asked again whenever the time changes, and when the map's live status
  // moves underneath (refreshKey) — a desk taken a moment ago is no longer
  // an option, whatever the panel said when it opened.
  useEffect(() => {
    if (!booking.iso) {
      setOptions(null);
      return undefined;
    }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .roomOptions(room.id, booking.iso.startTime, booking.iso.endTime)
        .then((result) => {
          if (!current) return;
          setOptions(result);
          setError(null);
        })
        .catch((err) => current && setError(err.message))
        .finally(() => current && setLoading(false));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [room.id, booking.iso, refreshKey]);

  const allowsWhole = room.bookingMode !== "individual";
  const allowsUnits = room.bookingMode !== "whole";
  const levelNames = room.levels.map((level) => levelName(level, floors));

  return (
    <div className="space-y-6">
      <section aria-labelledby="room-when">
        <h3 id="room-when" className="mb-2 text-sm font-semibold">
          When?
        </h3>
        <WhenFields booking={booking} />
      </section>

      <section aria-labelledby="room-what" className="space-y-3">
        <h3 id="room-what" className="text-sm font-semibold">
          What would you like to book?
        </h3>

        {error && <Notice tone="error">{error}</Notice>}

        {allowsWhole && (
          <WholeRoomOption
            room={room}
            answer={options?.whole}
            loading={loading || (!options && Boolean(booking.iso))}
            waitingForTime={!booking.iso}
            onChoose={onBookRoom}
          />
        )}

        {allowsUnits && (
          <UnitsOption
            room={room}
            levelNames={levelNames}
            units={options?.units}
            loading={loading || (!options && Boolean(booking.iso))}
            waitingForTime={!booking.iso}
            resourceNoun={resourceNoun}
            onPick={onPickUnit}
            onHover={onHoverUnit}
          />
        )}

        {room.bookingMode === "either" && (
          <p className="text-xs leading-relaxed text-ink-muted">
            A whole-room booking takes every {resourceNoun} inside for that time — and a booked {resourceNoun}{" "}
            means the room can't be booked whole until it's free.
          </p>
        )}
      </section>

      {room.levels.length > 1 && (
        <section aria-labelledby="room-levels">
          <h3 id="room-levels" className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Layers size={14} className="text-ink-muted" />
            On {room.levels.length} floors
          </h3>
          <p className="mb-3 text-sm text-ink-secondary">
            {listNames(levelNames)} are one room: a whole-room booking covers every level. See each on the map:
          </p>
          <Segmented
            size="sm"
            className="room-levels"
            value={floorId}
            onChange={onShowLevel}
            options={room.levels.map((level, i) => ({ value: level.floorId, label: levelNames[i] }))}
          />
        </section>
      )}
    </div>
  );
}

/** One option in the panel: an icon, what it is, and its answer for the chosen time. */
function OptionCard({ icon: Icon, title, body, children }) {
  return (
    <div className="rounded-lg border border-line/10 bg-bg-panel/50 p-4">
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
          style={{ background: "rgb(var(--c-accent) / 0.12)", color: "var(--color-accent)" }}
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight">{title}</p>
          {body && <p className="mt-1 text-sm text-ink-secondary">{body}</p>}
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function WholeRoomOption({ room, answer, loading, waitingForTime, onChoose }) {
  const levels = room.levels.length;
  return (
    <OptionCard
      icon={DoorOpen}
      title="Book the whole room"
      body={`One booking for ${room.name} and everything in it${levels > 1 ? `, on all ${levels} floors` : ""}.`}
    >
      {waitingForTime ? (
        <p className="text-sm text-ink-muted">Choose a time above to see if it's free.</p>
      ) : loading ? (
        <Skeleton className="h-10 w-full" />
      ) : answer?.bookable ? (
        <button
          type="button"
          onClick={onChoose}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-md px-4 text-sm font-medium
                     shadow-sm transition-[filter] duration-fast hover:brightness-110"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          <span className="flex items-center gap-2">
            <Check size={15} />
            Free for this time
          </span>
          <span className="flex items-center gap-1">
            Book it
            <ArrowRight size={15} />
          </span>
        </button>
      ) : (
        <Refusal reason={answer?.error} />
      )}
    </OptionCard>
  );
}

/**
 * Every unit inside, grouped by the piece it belongs to — unit labels
 * repeat from piece to piece ("Desk · 1" twice), so a flat list would be
 * ambiguous. Hovering or focusing one outlines it on the map, which is
 * what tells two identical rows apart.
 */
function UnitsOption({ room, levelNames, units, loading, waitingForTime, resourceNoun, onPick, onHover }) {
  const pieces = useMemo(() => groupByPiece(room, units || []), [room, units]);
  const free = (units || []).filter((unit) => unit.bookable).length;
  const multiLevel = room.levels.length > 1;

  let summary = null;
  if (!waitingForTime && !loading && units) {
    summary = units.length
      ? `${free} of ${units.length} free for this time`
      : `There are no ${plural(resourceNoun)} in this room yet.`;
  }

  return (
    <OptionCard icon={Grid2x2} title={`Pick ${withArticle(resourceNoun)} inside`} body={summary}>
      {waitingForTime ? (
        <p className="text-sm text-ink-muted">Choose a time above to see what's free.</p>
      ) : loading && !units ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ) : (
        <ul className="space-y-2" onMouseLeave={() => onHover?.(null)}>
          {pieces.map((piece) => (
            <li key={piece.resourceId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-[6.5rem] text-sm text-ink-secondary">
                {piece.typeLabel}
                {multiLevel && (
                  <span className="text-ink-muted"> · {levelNames[room.levels.findIndex((l) => l.floorId === piece.floorId)]}</span>
                )}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {piece.units.map((unit) => (
                  <UnitChip key={unit.unitLabel} unit={unit} resourceNoun={resourceNoun} onPick={onPick} onHover={onHover} />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </OptionCard>
  );
}

/** A unit inside the room: a button when it is free, a struck-through label when it is not. */
function UnitChip({ unit, resourceNoun, onPick, onHover }) {
  const name = `${unit.typeLabel} · ${unit.unitLabel}`;
  const hover = () => onHover?.(unit);
  if (!unit.bookable) {
    return (
      <span
        title={unit.error}
        aria-label={`${name}: not free — ${unit.error}`}
        onMouseEnter={hover}
        className="inline-flex h-8 min-w-[2.5rem] items-center justify-center gap-1 rounded-md border border-line/10
                   px-2 text-xs text-ink-muted line-through"
      >
        <X size={12} className="shrink-0" />
        {unit.unitLabel}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onPick(unit)}
      onMouseEnter={hover}
      onFocus={hover}
      onBlur={() => onHover?.(null)}
      aria-label={`Book ${name} (${resourceNoun}) — free for this time`}
      className="inline-flex h-8 min-w-[2.5rem] items-center justify-center gap-1 rounded-md border px-2 text-xs
                 font-semibold transition-colors duration-fast"
      style={{
        borderColor: "rgb(var(--c-state-available) / 0.45)",
        background: "rgb(var(--c-state-available) / 0.12)",
        color: "var(--color-state-available)",
      }}
    >
      <Check size={12} className="shrink-0" />
      {unit.unitLabel}
    </button>
  );
}

function Refusal({ reason }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-ink-secondary">
      <X size={15} className="mt-0.5 shrink-0 text-state-unavailable" />
      <span>{reason || "Not available for this time."}</span>
    </p>
  );
}

/** Units -> pieces, in the order the room's levels are listed, then reading order on the floor. */
function groupByPiece(room, units) {
  const levelIndex = (floorId) => room.levels.findIndex((level) => level.floorId === floorId);
  const pieces = new Map();
  for (const unit of units) {
    if (!pieces.has(unit.resourceId)) {
      pieces.set(unit.resourceId, {
        resourceId: unit.resourceId,
        typeLabel: unit.typeLabel,
        floorId: unit.floorId,
        position: unit.position,
        units: [],
      });
    }
    pieces.get(unit.resourceId).units.push(unit);
  }
  return [...pieces.values()].sort(
    (a, b) =>
      levelIndex(a.floorId) - levelIndex(b.floorId) ||
      a.position.row - b.position.row ||
      a.position.col - b.position.col
  );
}
