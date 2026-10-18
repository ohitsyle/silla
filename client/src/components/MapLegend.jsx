import { OVERSTAY_META, SERVICE_META, STATUS_META, STATUS_ORDER } from "./SpaceMap.jsx";
import { plural } from "../lib/rooms.js";
import { Skeleton, StatusDot } from "./ui/index.jsx";

/**
 * The key to the map, at its foot where a tool puts its status bar.
 *
 * Every mark the map draws is explained here, including the two that are
 * not unit states: the outline of a room, and furniture that only comes
 * with its room. Counts are of units a member could book on their own —
 * a table inside a room booked only whole is part of that room, not a
 * row of "unavailable" seats, and counting it as one made a free meeting
 * room look like a broken one.
 *
 * `ringed` counts the units whose day ring is showing. The ring is the
 * map's one mark about LATER — the colours are all about now — so its line
 * appears whenever one is drawn, and only then.
 */
export default function MapLegend({ summary, resourceNoun = "resource", showOverstay = false, loading = false, ringed = 0 }) {
  if (loading || !summary) {
    return (
      <div className="flex shrink-0 gap-4 border-t border-line/10 px-4 py-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-20" />
        ))}
      </div>
    );
  }

  const { counts, total, outOfService, overstays, rooms, included } = summary;
  return (
    <div
      aria-label="Map key"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line/10 px-4 py-2.5 text-sm"
    >
      <span className="text-ink-secondary">
        <span className="font-semibold tabular-nums text-ink-primary">{counts.available}</span> of{" "}
        <span className="tabular-nums">{total}</span> {plural(resourceNoun, total)} free now
      </span>
      <span className="hidden h-4 w-px bg-line/10 sm:block" />
      {STATUS_ORDER.map((key) => (
        <StatusDot key={key} tone={key} label={STATUS_META[key].label} count={counts[key]} />
      ))}
      {outOfService > 0 && <StatusDot tone="unavailable" label={SERVICE_META.label} count={outOfService} outline />}
      {showOverstay && overstays > 0 && <StatusDot tone="overstay" label={OVERSTAY_META.label} count={overstays} />}
      {rooms > 0 && (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-4 shrink-0 rounded-[4px] border-2"
            style={{ borderColor: "rgb(var(--c-line) / 0.45)" }}
          />
          Room
        </span>
      )}
      {ringed > 0 && (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
          <RingSample />
          Booked later today
          <span className="font-semibold text-ink-primary">{ringed}</span>
        </span>
      )}
      {included > 0 && (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: "rgb(var(--c-line) / 0.22)" }}
          />
          Comes with its room
        </span>
      )}
    </div>
  );
}

/** The day ring as the map draws it: a chip, and an arc of it already booked. */
function RingSample() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="shrink-0">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" style={{ fill: "rgb(var(--c-line) / 0.16)" }} />
      <rect x="1.25" y="1.25" width="13.5" height="13.5" rx="3.5" pathLength="1"
        style={{ fill: "none", stroke: "rgb(var(--c-line) / 0.42)", strokeWidth: 1.5 }} />
      <path
        d="M 8 1.25 H 11.25 A 3.5 3.5 0 0 1 14.75 4.75 V 11.25 A 3.5 3.5 0 0 1 11.25 14.75 H 8"
        style={{ fill: "none", stroke: "var(--color-state-reserved)", strokeWidth: 1.5, strokeLinecap: "round" }}
      />
    </svg>
  );
}
