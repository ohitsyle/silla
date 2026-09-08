import { motion } from "framer-motion";
import {
  Bell, LayoutGrid, Map, Nfc, PencilRuler, ShieldCheck, SlidersHorizontal, TrendingUp,
} from "lucide-react";

import { reveal, revealChild, revealGroup } from "../motion.js";

/**
 * What's in the box.
 *
 * Deliberately plain after the interactive section before it — a page
 * that is playful the whole way down never lets anything land. This is
 * where a buyer checks the thing they came for is actually included, so
 * it is scannable first and charming second.
 *
 * Every line here is something that exists. Nothing on this page is a
 * roadmap item dressed up as a feature.
 */

const FEATURES = [
  {
    icon: Map,
    title: "A map, not a list",
    body: "The real floor plan, drawn to scale, updating live as people come and go. Pan, zoom, switch floors.",
  },
  {
    icon: Nfc,
    title: "Tap to check in",
    body: "A plain USB card reader — the kind that types like a keyboard. No driver, no vendor lock-in, no integration project.",
  },
  {
    icon: LayoutGrid,
    title: "Book ahead or walk in",
    body: "Reserve a spot for later, or tap at the door and take whatever's free right now. Both end up on the same map.",
  },
  {
    icon: SlidersHorizontal,
    title: "A console for staff",
    body: "Who's in, what's free, what's overdue. Mark something out of service and it greys out for everyone instantly.",
  },
  {
    icon: PencilRuler,
    title: "Draw your own floors",
    body: "Place furniture, draw zones, label the printer corner. Add a floor, resize a room — no ticket to us required.",
  },
  {
    icon: ShieldCheck,
    title: "Roles that hold",
    body: "Staff run the space; admins define it. Enforced on the server, not just hidden in the interface.",
  },
  {
    icon: Bell,
    title: "It tells people things",
    body: "Booking confirmations, starting-soon nudges, no-show releases, and a note when you close for the day.",
  },
  {
    icon: TrendingUp,
    title: "Numbers worth having",
    body: "Peak hours, no-show rates, how long people actually stay. Export the lot to CSV whenever you want.",
  },
];

export default function Features() {
  return (
    <section id="inside" className="px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <motion.h2 {...reveal()} className="display text-center text-[clamp(2rem,5.5vw,3.75rem)]">
          What's inside.
        </motion.h2>
        <motion.p
          {...reveal(0.1)}
          className="mx-auto mt-5 max-w-xl text-center text-lg"
          style={{ color: "rgb(var(--m-ink-soft))" }}
        >
          All of it, in every plan. We don't hold features back to sell them to you twice.
        </motion.p>

        <motion.div {...revealGroup(0.06)} className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              {...revealChild()}
              className="rounded-[1.5rem] p-6 h-full"
              style={{
                background: "rgb(var(--m-card))",
                border: "1px solid rgb(var(--m-ink) / 0.07)",
              }}
            >
              <span
                className="w-10 h-10 rounded-xl grid place-items-center"
                style={{ background: "rgb(var(--m-accent) / 0.13)", color: "rgb(var(--m-accent-deep))" }}
              >
                <Icon size={19} />
              </span>
              <h3 className="mt-4 text-lg font-extrabold tracking-tight">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "rgb(var(--m-ink-soft))" }}>
                {body}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
