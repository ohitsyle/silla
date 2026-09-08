import { Type } from "lucide-react";
import { Field, Panel } from "../components/ui.jsx";

/**
 * Step 2 — the words the product uses.
 *
 * Terminology is the most visible half of white-labelling: the same
 * engine says "reserve a seat" to a library and "book a desk" to an
 * office because these three nouns are config, never literals in the
 * code (spec §16). The live sentence below is here so the buyer reads
 * their own choice back in context before the product does.
 *
 * The member ID format sits on the policy step, not here: it belongs to
 * the `identity` group, and a control has to live on the step that is
 * handed that group's validation errors or the buyer is blocked with
 * nothing on screen to fix.
 */

/** App keys errors by the dotted field path validate() reports. */
const errorFor = (errors, field) => errors?.[field];

const article = (word) => (/^[aeiou]/i.test(String(word).trim()) ? "an" : "a");
const capitalize = (word) => String(word).charAt(0).toUpperCase() + String(word).slice(1);

/** One noun highlighted inside the live sentence. */
function Noun({ children }) {
  return (
    <span className="font-semibold" style={{ color: "var(--color-accent)" }}>
      {children}
    </span>
  );
}

export default function TerminologyStep({ config, update, errors }) {
  const terminology = config.terminology || {};

  // Neutral stand-ins for the preview sentence only — the emitted profile
  // takes its defaults from the config, never from this file.
  const resourceNoun = terminology.resourceNoun || "resource";
  const memberNoun = terminology.memberNoun || "member";
  const facilityLabel = terminology.facilityLabel || "facility";

  const setTerm = (field) => (event) =>
    update({ terminology: { ...terminology, [field]: event.target.value } });

  return (
    <Panel title="What things are called" icon={Type}>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field
          label="Resource noun"
          name="resourceNoun"
          value={terminology.resourceNoun || ""}
          onChange={setTerm("resourceNoun")}
          placeholder="resource"
          error={errorFor(errors, "terminology.resourceNoun")}
          hint="One bookable thing. Lowercase — the product capitalises it where it needs to."
        />
        <Field
          label="Member noun"
          name="memberNoun"
          value={terminology.memberNoun || ""}
          onChange={setTerm("memberNoun")}
          placeholder="member"
          error={errorFor(errors, "terminology.memberNoun")}
          hint="One person who books. Also the word staff see in the console."
        />
        <Field
          label="Facility label"
          name="facilityLabel"
          value={terminology.facilityLabel || ""}
          onChange={setTerm("facilityLabel")}
          placeholder="Facility"
          error={errorFor(errors, "terminology.facilityLabel")}
          hint="The place itself. Capitalised as you want it read."
        />
      </div>

      <div className="mt-4 rounded-md border border-line/10 bg-bg-panel px-4 py-3">
        <p className="text-base text-ink-primary">
          <Noun>{capitalize(article(memberNoun))} {memberNoun}</Noun> at this{" "}
          <Noun>{facilityLabel}</Noun> reserves <Noun>{article(resourceNoun)} {resourceNoun}</Noun>.
        </p>
        <ul className="text-sm text-ink-secondary mt-2 space-y-1">
          <li>Map header — “{facilityLabel} map”</li>
          <li>Empty state — “Every {resourceNoun} on this floor is taken.”</li>
          <li>Kiosk — “Tap your card to claim the {resourceNoun} you reserved.”</li>
        </ul>
      </div>

      <p className="text-xs text-ink-muted mt-4">
        These three words are the only place a vertical is named. Nothing in the product hardcodes
        “seat” or “student”, which is what lets one deployment be a reading room and the next a
        workplace without a branch.
      </p>
    </Panel>
  );
}
