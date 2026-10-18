import { CalendarDays, ChevronDown, Clock } from "lucide-react";
import { Segmented } from "./ui/index.jsx";
import { formatLength, startsOn, toLocalInput } from "../lib/bookingWindow.js";
import { clock, clockRange, dateKeyOf, shortDate } from "../lib/dayView.js";
import { plural } from "../lib/rooms.js";

/**
 * "When?" for the whole map — Now, a time later today, or another day and
 * time — over the page's one booking window (lib/bookingWindow), the same
 * window the panel's own When fields edit. Change one and the other moves.
 *
 *   Now          the map as it is: each unit's colour is what it is doing
 *                right now, and its ring the rest of today
 *   Later today  the units free for the chosen window stay bright and the
 *   Another day  taken ones fade — their colours still mean "right now",
 *                so a desk in use now but free at 3 PM is bright grey
 *
 * It answers "where can I sit at 3?" in one look instead of opening units
 * one at a time; `summary` counts it ("14 of 22 desks free 3:00 – 5:00 PM").
 */
export default function WhenBar({ booking, summary = null, resourceNoun = "resource", className = "" }) {
  const { mode, setMode, nowOpen, laterToday, startTime, endTime, duration, setDuration, lengths, hours } = booking;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // The time picker offers the window's own day; a start typed elsewhere
  // that is not on the half hour is shown as itself rather than snapped.
  const starts = mode === "later" ? laterToday : startsOn(startTime, hours);
  const startValue = Number.isNaN(startTime.getTime()) ? "" : String(startTime.getTime());
  const offered = starts.some((at) => String(at.getTime()) === startValue);

  const pickDay = (value) => {
    if (!value) return;
    const [y, m, d] = value.split("-").map(Number);
    const day = new Date(y, m - 1, d);
    const options = startsOn(day, hours);
    const same = options.find((at) => at.getHours() === startTime.getHours() && at.getMinutes() === startTime.getMinutes());
    const choice = same || options.find((at) => at.getHours() >= 10) || options[0];
    if (choice) booking.setStart(toLocalInput(choice));
  };

  return (
    <div className={`flex flex-wrap items-end gap-x-4 gap-y-2 ${className}`}>
      <div className="min-w-0">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">When</p>
        <Segmented
          size="sm"
          className="map-when"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "now",
              label: "Now",
              disabled: !nowOpen,
              title: nowOpen ? "What's free right now" : hours?.open ? `Closed now — opens at ${hours.open}` : "Closed now",
            },
            { value: "later", label: "Later today", disabled: !laterToday.length, title: laterToday.length ? undefined : "Nothing left to book today" },
            { value: "day", label: "Another day" },
          ]}
        />
      </div>

      {mode !== "now" && (
        <div className="flex flex-wrap items-end gap-2">
          {mode === "day" && (
            <Picker icon={CalendarDays} label="Day" text={shortDate(startTime)}>
              <input
                type="date"
                aria-label="Day"
                min={dateKeyOf(tomorrow)}
                value={dateKeyOf(startTime)}
                onChange={(e) => pickDay(e.target.value)}
                // A date input opens its picker only from its own icon;
                // the whole face is the target here.
                onClick={(e) => e.currentTarget.showPicker?.()}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </Picker>
          )}
          <Picker icon={Clock} label="From" text={clock(startTime)}>
            <select
              aria-label="From"
              value={startValue}
              onChange={(e) => booking.setStart(toLocalInput(new Date(Number(e.target.value))))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {!offered && startValue && <option value={startValue}>{clock(startTime)}</option>}
              {starts.map((at) => (
                <option key={at.getTime()} value={at.getTime()}>
                  {clock(at)}
                </option>
              ))}
            </select>
          </Picker>
          <Picker label="For" text={formatLength(Math.round(duration * 60))}>
            <select
              aria-label="For how long"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {lengths.map((hoursLong) => (
                <option key={hoursLong} value={hoursLong}>
                  {formatLength(Math.round(hoursLong * 60))}
                </option>
              ))}
            </select>
          </Picker>
        </div>
      )}

      {mode !== "now" && summary && summary.total > 0 && (
        <p className="pb-1.5 text-sm text-ink-secondary" role="status">
          <span className="font-semibold tabular-nums text-ink-primary">{summary.free}</span> of{" "}
          <span className="tabular-nums">{summary.total}</span> {plural(resourceNoun, summary.total)} free{" "}
          {clockRange(startTime, endTime)}
          {mode === "day" && <> on {shortDate(startTime)}</>}
        </p>
      )}
    </div>
  );
}

/**
 * A native picker under a styled face — the BuildingSwitcher's pattern:
 * the platform's own date and time pickers on a phone, the product's look
 * everywhere.
 */
function Picker({ icon: Icon, label, text, children }) {
  return (
    <label
      className="relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line/10 bg-bg-panel
                 pl-2.5 pr-7 text-sm font-medium transition-colors duration-fast hover:border-line/25
                 focus-within:border-line/40"
    >
      {Icon && <Icon size={14} className="shrink-0 text-ink-muted" />}
      <span className="sr-only">{label}</span>
      <span className="whitespace-nowrap">{text}</span>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 text-ink-muted" />
      {children}
    </label>
  );
}
