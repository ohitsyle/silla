import { Clock } from "lucide-react";
import { Field, Notice, Select } from "./ui/index.jsx";
import { formatHours, formatWhen } from "../lib/bookingWindow.js";

/**
 * "When?" — the start and length of the booking window (lib/bookingWindow).
 *
 * Shown wherever availability is asked about: the room panel above its
 * options, and the confirmation step above the PIN. Both render the SAME
 * window, so changing the time in one place changes it everywhere.
 *
 * The line under the fields says what the window comes to and what limits
 * it, so a refusal for running past closing never arrives as a surprise.
 */
export default function WhenFields({ booking }) {
  const { start, setStart, duration, setDuration, endTime, lengths, maxStayHours, hours, problem } = booking;

  // Stacked, always: the panel is ~350px wide, and a datetime input will
  // not shrink below its own text — side by side, the length overflowed.
  return (
    <div>
      <div className="grid gap-3">
        <Field
          label="Starts"
          type="datetime-local"
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Select label="For" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          {lengths.map((hoursLong) => (
            <option key={hoursLong} value={hoursLong}>
              {formatHours(hoursLong)}
            </option>
          ))}
        </Select>
      </div>

      {problem ? (
        <Notice tone="error" className="mt-3">
          {problem}
        </Notice>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
          <Clock size={12} className="shrink-0" />
          <span>
            Until {formatWhen(endTime)} · up to {formatHours(maxStayHours)}
            {hours?.open && hours?.close && <> · open {hours.open}–{hours.close}</>}
          </span>
        </p>
      )}
    </div>
  );
}
