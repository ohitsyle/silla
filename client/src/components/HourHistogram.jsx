import { useState } from "react";
import { motion } from "framer-motion";
import { DURATION, EASE_OUT, prefersReducedMotion } from "../lib/motion.js";

/**
 * Reservations by hour of day (RPT-1).
 *
 * This was 24 bars with no axis, no baseline and nothing drawn for an
 * empty hour — so a quiet day rendered as two rectangles floating in a
 * box, which reads as a broken chart rather than a real answer. The
 * shape of a DAY is the point here, so every hour now has a track
 * whether or not anything happened in it, there is a baseline to sit on,
 * and the scale is stated instead of implied.
 *
 * Colour comes from tokens only, so a buyer's accent drives the bars.
 */
export default function HourHistogram({ counts = [], label = "reservations" }) {
  const [hovered, setHovered] = useState(null);
  const reduced = prefersReducedMotion();

  const hours = counts.length === 24 ? counts : Array.from({ length: 24 }, (_, i) => counts[i] || 0);
  const peak = Math.max(...hours, 1);
  const total = hours.reduce((sum, n) => sum + n, 0);

  // A rounded ceiling reads better on the axis than a raw peak of 7.
  const ceiling = peak <= 4 ? peak : Math.ceil(peak / 5) * 5;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-xs text-ink-muted tabular-nums">
          {total} {label} · peak {peak} at {String(hours.indexOf(peak)).padStart(2, "0")}:00
        </span>
        <span className="text-xs text-ink-muted tabular-nums">max {ceiling}</span>
      </div>

      <div className="relative h-36 select-none">
        {/* Gridlines. Dashed and faint: a reference, not part of the data. */}
        {[0, 0.5, 1].map((fraction) => (
          <div
            key={fraction}
            className="absolute inset-x-0 border-t border-dashed border-line/10"
            style={{ bottom: `${fraction * 100}%` }}
          />
        ))}

        <div className="absolute inset-0 flex items-end gap-[3px]">
          {hours.map((count, hour) => {
            const active = hovered === hour;
            const height = ceiling ? (count / ceiling) * 100 : 0;
            return (
              <div
                key={hour}
                className="group relative flex-1 h-full flex items-end"
                onMouseEnter={() => setHovered(hour)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* The track — always drawn, so the empty hours are still
                    part of the picture instead of a gap. */}
                <div className="absolute inset-x-0 bottom-0 top-0 rounded-sm bg-line/[0.04]" />

                <motion.div
                  className="relative w-full rounded-sm origin-bottom"
                  initial={reduced ? false : { scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: DURATION.slow, delay: hour * 0.018, ease: EASE_OUT }}
                  style={{
                    height: `${count ? Math.max(height, 3) : 0}%`,
                    background: "var(--color-accent)",
                    opacity: active ? 1 : 0.85,
                  }}
                />

                {active && count > 0 && (
                  <div
                    className="absolute left-1/2 -translate-x-1/2 z-10 px-2 py-1 rounded-md
                               bg-bg-panel border border-line/15 shadow-md text-xs whitespace-nowrap
                               pointer-events-none"
                    style={{ bottom: `calc(${Math.max(height, 3)}% + 8px)` }}
                  >
                    <span className="font-medium text-ink-primary tabular-nums">{count}</span>
                    <span className="text-ink-muted"> at {String(hour).padStart(2, "0")}:00</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Baseline — the bars need something to stand on. */}
        <div className="absolute inset-x-0 bottom-0 border-t border-line/20" />
      </div>

      <div className="mt-2 flex justify-between text-[10px] text-ink-muted tabular-nums">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => (
          <span key={hour}>{String(hour).padStart(2, "0")}</span>
        ))}
        <span>24</span>
      </div>
    </div>
  );
}
