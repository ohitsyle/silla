import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import {
  MINIMUM_MINUTES, SLOT_MINUTES, clock, clockRange, describeDay, latestEnd, shortDate, slotsOf,
} from "../lib/dayView.js";
import { formatLength } from "../lib/bookingWindow.js";

/**
 * One unit's day — or a room's, as a whole — from opening to closing, in
 * half-hour steps: what is booked, what is yours, what has passed, what is
 * closed, and the time you have chosen.
 *
 * It exists because a desk free all morning can be booked from 3 PM, and
 * the map's colours, which say what is happening NOW, cannot show that. A
 * member who tried 2–4 PM was refused and left guessing. Here the booked
 * stretch is drawn, said in a sentence ("Free until 3:00 PM"), and the free
 * time around it is what you pick from:
 *
 *   tap      a free half hour starts the booking there; a second tap on a
 *            later one sets where it ends
 *   drag     (mouse or pen) across free half hours, for start and length
 *            at once
 *
 * Either way the length stops at the maximum stay, closing time and the
 * next booking, whichever is first, and it is written straight into the
 * page's one booking window (lib/bookingWindow), so the When fields, the
 * availability check and the PIN step all follow.
 *
 * On a narrow screen the hours scroll sideways — every half hour keeps a
 * target at least SLOT_PX wide rather than shrinking into slivers — and
 * the strip opens scrolled to the time that matters (your choice, or now).
 */

/**
 * Width of one half hour, in CSS pixels: the 24px minimum for a touch
 * target, and narrow enough that the panel shows most of a working day.
 */
const SLOT_PX = 24;
const MINUTE = 60_000;

/** The earliest a booking in the slot holding `now` can start: the next five minutes. */
const soonest = (now) => new Date(Math.ceil(now.getTime() / (5 * MINUTE)) * 5 * MINUTE);

export default function DayTimeline({
  day,
  entry,
  window,
  maxStayHours = 4,
  noun = "resource",
  roomName = null,
  caption,
  onChoose,
}) {
  const scroller = useRef(null);
  const track = useRef(null);
  const drag = useRef(null);
  const suppressClick = useRef(false);
  /** After a tap set the start, the next tap on a later slot sets the end. */
  const [pending, setPending] = useState(null);
  const [draft, setDraft] = useState(null);

  const now = new Date();
  const slots = useMemo(() => slotsOf(day), [day]);
  const dayStart = day ? new Date(day.opensAt).getTime() : 0;
  const dayEnd = day ? new Date(day.closesAt).getTime() : 0;
  const span = Math.max(1, dayEnd - dayStart);
  const pct = (at) => `${((Math.min(Math.max(new Date(at).getTime(), dayStart), dayEnd) - dayStart) / span) * 100}%`;
  const width = (from, to) =>
    `${((Math.min(new Date(to).getTime(), dayEnd) - Math.max(new Date(from).getTime(), dayStart)) / span) * 100}%`;

  // A choice made somewhere else (the When fields, the When picker) ends a
  // two-tap selection in progress — but not the change this strip made
  // itself with the first tap, or the second tap would never land.
  const windowKey = window ? `${+window.start}:${+window.end}` : "";
  const chosenHere = useRef(null);
  useEffect(() => {
    if (windowKey !== chosenHere.current) setPending(null);
  }, [windowKey]);
  useEffect(() => setPending(null), [day?.date, entry?.label]);
  /** Writes a choice into the shared window, remembering it was ours. */
  const choose = (at, minutes) => {
    chosenHere.current = `${+at}:${+at + minutes * MINUTE}`;
    onChoose?.(at, minutes);
  };

  /* ── what each half hour allows ── */
  const cells = useMemo(() => {
    if (!day || !entry) return [];
    const blocks = (entry.blocks || []).map((b) => ({ ...b, start: new Date(b.start), end: new Date(b.end) }));
    const closures = (day.closures || []).map((c) => ({ ...c, start: new Date(c.start), end: new Date(c.end) }));
    return slots.map((slot, index) => {
      const past = day.isToday && slot.end <= now;
      const current = day.isToday && slot.start <= now && now < slot.end;
      const startAt = current ? soonest(now) : slot.start;
      const closure = closures.find((c) => c.start < slot.end && slot.start < c.end) || null;
      const covered = blocks.find((b) => b.start <= startAt && startAt < b.end) || null;
      const closedThen = closures.find((c) => c.start <= startAt && startAt < c.end) || null;
      const limit = latestEnd(entry, day, startAt, maxStayHours);
      const room = Math.floor((limit.at - startAt) / MINUTE);
      const choosable = Boolean(entry.bookable && day.bookable && !past && !covered && !closedThen && room >= MINIMUM_MINUTES);
      return { ...slot, index, past, current, startAt, closure, covered, choosable, limit, room };
    });
  }, [day, entry, slots, maxStayHours, Math.floor(now.getTime() / MINUTE)]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The longest booking from a slot's start up to the end of slot `last`, in whole half hours. */
  const lengthTo = (cell, last) => {
    const end = Math.min(last.end.getTime(), cell.limit.at.getTime());
    return Math.floor((end - cell.startAt.getTime()) / (SLOT_MINUTES * MINUTE)) * SLOT_MINUTES;
  };
  const currentMinutes = window ? Math.round((window.end - window.start) / MINUTE) : 60;

  const tap = (cell) => {
    if (!cell.choosable) return;
    if (pending && cell.index >= pending.index) {
      const from = cells[pending.index];
      const minutes = lengthTo(from, cell);
      if (minutes >= MINIMUM_MINUTES) {
        choose(from.startAt, minutes);
        setPending(null);
        return;
      }
    }
    const longest = Math.floor(cell.room / SLOT_MINUTES) * SLOT_MINUTES;
    choose(cell.startAt, Math.max(MINIMUM_MINUTES, Math.min(currentMinutes, longest)));
    setPending({ index: cell.index });
  };

  /* ── dragging with a mouse or pen: start where pressed, end where released ── */
  const cellAtX = (clientX) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return null;
    const index = Math.floor(((clientX - rect.left) / rect.width) * cells.length);
    return cells[Math.max(0, Math.min(cells.length - 1, index))];
  };
  const onPointerDown = (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return; // touch scrolls; a tap is a click
    const cell = cellAtX(e.clientX);
    if (!cell?.choosable) return;
    // Not captured yet: capturing on press would retarget the click that
    // follows to the strip, and a plain click on a half hour would be lost.
    drag.current = { from: cell, last: cell, moved: false, pointerId: e.pointerId };
  };
  const onPointerMove = (e) => {
    const current = drag.current;
    if (!current) return;
    const cell = cellAtX(e.clientX);
    if (!cell || cell.index < current.from.index || cell.index === current.last.index) return;
    if (!current.moved) {
      try {
        track.current.setPointerCapture?.(current.pointerId);
      } catch {
        /* the drag still works inside the strip without it */
      }
    }
    current.last = cell;
    current.moved = true;
    const minutes = lengthTo(current.from, cell);
    if (minutes >= MINIMUM_MINUTES) setDraft({ start: current.from.startAt, end: new Date(current.from.startAt.getTime() + minutes * MINUTE) });
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return;
    suppressClick.current = true;
    setDraft(null);
    setPending(null);
    const minutes = lengthTo(current.from, current.last);
    if (minutes >= MINIMUM_MINUTES) choose(current.from.startAt, minutes);
  };

  // Open on the time that matters: the choice, else now, else opening.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !day) return;
    const focus = window && window.start >= dayStart && window.start < dayEnd ? window.start.getTime() : day.isToday ? now.getTime() : dayStart;
    // A little of what came before, and as much as fits of what comes after.
    const x = ((focus - dayStart) / span) * el.scrollWidth;
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.15);
  }, [day?.date, entry, windowKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!day || !entry) return null;

  const { headline, later } = describeDay(entry, day, { noun, roomName, now });
  const blocks = (entry.blocks || []).filter((b) => new Date(b.end) > new Date(dayStart) && new Date(b.start) < new Date(dayEnd));
  const shown = draft || window;
  const onThisDay = shown && shown.start < dayEnd && shown.end > dayStart;
  const clash = onThisDay && !draft && blocks.some((b) => new Date(b.start) < shown.end && shown.start < new Date(b.end));
  const hours = slots.filter((slot) => slot.start.getMinutes() === 0);
  const anyClosure = (day.closures || []).length > 0;

  return (
    <section aria-label={caption || `${roomName && entry.label === "room" ? roomName : `This ${noun}`} on ${shortDate(day.opensAt)}`}>
      <div className="mb-2 flex items-start gap-2">
        <CalendarClock size={16} className="mt-0.5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug">{headline}</p>
          <p className="text-xs leading-relaxed text-ink-muted">
            {caption || (day.isToday ? "Today" : shortDate(day.opensAt))}
            {later.length > 0 && <> · booked {later.slice(0, 3).join(", ")}{later.length > 3 ? ` and ${later.length - 3} more` : ""}</>}
          </p>
        </div>
      </div>

      <div
        ref={scroller}
        className="-mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1"
        style={{ touchAction: "pan-x" }}
      >
        <div className="relative select-none" style={{ width: `max(100%, ${slots.length * SLOT_PX}px)` }}>
          {/* The hours, each written from its own line: a label centred on
              its line ran into the next one at a phone's width, and one
              without its AM/PM was ambiguous once scrolled to mid-day. */}
          <div className="relative h-5" aria-hidden="true">
            {hours.map((slot) => (
              <span
                key={+slot.start}
                className="absolute top-0 whitespace-nowrap pl-1 text-[11px] tabular-nums text-ink-muted"
                style={{ left: pct(slot.start) }}
              >
                {slot.start.toLocaleTimeString(undefined, { hour: "numeric" })}
              </span>
            ))}
          </div>

          <div
            ref={track}
            role="group"
            aria-label="Half hours from opening to closing"
            className="relative flex h-11 overflow-hidden rounded-md border border-line/10 bg-bg-panel/60"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setDraft(null);
            }}
          >
            {cells.map((cell) => (
              <button
                key={+cell.start}
                type="button"
                disabled={!cell.choosable}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  tap(cell);
                }}
                aria-label={`${clockRange(cell.start, cell.end)}: ${slotWords(cell)}`}
                title={`${clockRange(cell.start, cell.end)} — ${slotWords(cell)}`}
                className={`h-full flex-1 border-l transition-colors duration-fast first:border-l-0
                  ${cell.start.getMinutes() === 0 ? "border-line/[0.09]" : "border-line/[0.04]"}
                  ${cell.choosable ? "cursor-pointer hover:bg-state-available/15 focus-visible:bg-state-available/15" : "cursor-default"}`}
                style={cell.past ? { backgroundImage: PAST_HATCH } : undefined}
              />
            ))}

            {/* Closures: nobody books these, whatever is free. */}
            {(day.closures || []).map((closure) => (
              <span
                key={`${closure.start}-${closure.reason}`}
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 flex items-center justify-center overflow-hidden px-1 text-[11px] font-medium"
                style={{
                  left: pct(closure.start),
                  width: width(closure.start, closure.end),
                  backgroundImage: CLOSED_HATCH,
                  color: "var(--color-state-unavailable)",
                }}
              >
                <span className="truncate">Closed</span>
              </span>
            ))}

            {/* What is booked, at its real times rather than rounded to the half hour. */}
            {blocks.map((block, i) => {
              const tone = block.mine ? "accent" : "reserved";
              return (
                <span
                  key={`${block.start}-${i}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-1 flex items-center overflow-hidden rounded-[5px] px-1.5 text-[11px] font-semibold"
                  style={{
                    left: pct(block.start),
                    width: width(block.start, block.end),
                    backgroundColor: tone === "accent" ? "rgb(var(--c-accent) / 0.9)" : "rgb(var(--c-state-reserved) / 0.82)",
                    color: tone === "accent" ? "var(--color-accent-ink)" : "rgb(var(--c-bg-page))",
                    backgroundImage: block.kind === "room" || block.kind === "inside" ? ROOM_STRIPES : undefined,
                    // A seam, so two bookings back to back read as two.
                    boxShadow: "inset 1px 0 0 rgb(var(--c-bg-page) / 0.55)",
                  }}
                  title={blockWords(block, roomName)}
                >
                  {/* Only where it fits whole: a word cut to "Ro…" says nothing. */}
                  {blockMinutes(block) >= 60 && <span className="truncate">{blockLabel(block)}</span>}
                </span>
              );
            })}

            {/* The chosen time — red-edged when it runs into a booking. */}
            {onThisDay && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 rounded-md border-2"
                style={{
                  left: pct(shown.start),
                  width: width(shown.start, shown.end),
                  borderColor: clash ? "var(--color-state-unavailable)" : "var(--color-accent)",
                  borderStyle: clash ? "dashed" : "solid",
                  background: clash ? "rgb(var(--c-state-unavailable) / 0.1)" : "rgb(var(--c-accent) / 0.16)",
                }}
              />
            )}

            {/* Now. */}
            {day.isToday && now.getTime() > dayStart && now.getTime() < dayEnd && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full"
                style={{ left: pct(now), background: "var(--color-ink-primary)" }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <Key swatch={{ background: "rgb(var(--c-state-reserved) / 0.82)" }} label="Booked" />
        {blocks.some((b) => b.kind === "room") && (
          <Key swatch={{ backgroundColor: "rgb(var(--c-state-reserved) / 0.82)", backgroundImage: ROOM_STRIPES }} label="Whole room booked" />
        )}
        {blocks.some((b) => b.kind === "inside") && (
          <Key swatch={{ backgroundColor: "rgb(var(--c-state-reserved) / 0.82)", backgroundImage: ROOM_STRIPES }} label="Booked inside" />
        )}
        {blocks.some((b) => b.mine) && <Key swatch={{ background: "rgb(var(--c-accent) / 0.9)" }} label="Yours" />}
        {anyClosure && <Key swatch={{ backgroundImage: CLOSED_HATCH }} label="Closed" />}
        <Key swatch={{ border: "2px solid var(--color-accent)", background: "rgb(var(--c-accent) / 0.16)" }} label="Your choice" />
      </div>
      <p className="mt-1 text-xs text-ink-secondary" aria-live="polite">
        {pending ? "Now tap where you'd like to finish." : "Tap a free time to start there, then tap where to finish."}
      </p>
      {onThisDay && !draft && (
        <p className="sr-only" role="status">
          Chosen: {clockRange(shown.start, shown.end)}, {formatLength(Math.round((shown.end - shown.start) / MINUTE))}.
        </p>
      )}
    </section>
  );
}

/* ─────────────────────────────── words ─────────────────────────────── */


function slotWords(cell) {
  if (cell.past) return "already past";
  if (cell.closure && !cell.choosable) return `closed${cell.closure.reason ? ` — ${cell.closure.reason}` : ""}`;
  if (cell.covered) return cell.covered.mine ? "your booking" : "booked";
  if (!cell.choosable) return "too short to book before the next booking or closing";
  return `free — up to ${formatLength(Math.floor(cell.room / SLOT_MINUTES) * SLOT_MINUTES)} from ${clock(cell.startAt)}`;
}

const blockMinutes = (block) => (new Date(block.end) - new Date(block.start)) / MINUTE;

/** The word inside a block — short, because an hour is 48 pixels wide. */
function blockLabel(block) {
  if (block.mine) return "Yours";
  if (block.holder) return block.holder;
  if (block.kind === "room") return "Room";
  if (block.kind === "inside") return "Inside";
  return "Booked";
}

function blockWords(block, roomName) {
  const when = clockRange(block.start, block.end);
  const whose = block.mine ? "Your booking" : block.holder ? `Booked by ${block.holder}${block.what ? ` (${block.what})` : ""}` : "Booked";
  const why = block.kind === "room" ? ` — ${roomName || "the room"} is booked whole` : block.kind === "inside" ? " — something inside the room" : "";
  return `${whose}, ${when}${why}${block.overstay ? " · still checked in" : ""}`;
}

function Key({ swatch, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-2.5 w-3.5 shrink-0 rounded-[3px]" style={swatch} />
      {label}
    </span>
  );
}

/* Patterns, from tokens: the past is faintly hatched, closures stripe in the
   "unavailable" tone, and a booking made by the room (or inside it) carries
   a light stripe over its colour so it reads apart from the unit's own. */
const PAST_HATCH = "repeating-linear-gradient(135deg, rgb(var(--c-line) / 0.07) 0 2px, transparent 2px 7px)";
const CLOSED_HATCH = "repeating-linear-gradient(135deg, rgb(var(--c-state-unavailable) / 0.32) 0 3px, rgb(var(--c-state-unavailable) / 0.08) 3px 8px)";
const ROOM_STRIPES = "repeating-linear-gradient(135deg, rgb(var(--c-bg-page) / 0.18) 0 3px, transparent 3px 9px)";
