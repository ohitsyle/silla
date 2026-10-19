import { Clock, IdCard, ShieldCheck, Timer, UserPlus } from "lucide-react";
import { Badge, Field, Notice, Panel, Segmented } from "../components/ui.jsx";

/**
 * Step 4 — the numbers the engine enforces, and how a member identifies
 * themselves.
 *
 * None of these are cosmetic: the scheduler releases no-shows against
 * the grace period every minute, the auth route locks an account on the
 * threshold, and the reservation engine refuses a booking that would run
 * past closing. So each field says what it actually causes, not what it
 * is called.
 */

/** App keys errors by the dotted field path validate() reports. */
const errorFor = (errors, field) => errors?.[field];

const capitalize = (word) => String(word).charAt(0).toUpperCase() + String(word).slice(1);

/** Minutes since midnight, or null if the value is not a complete HH:mm. */
const minutesOf = (time) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/*
 * Fixed sample characters rather than random ones: the example sits next
 * to a field being typed into, and an ID that reshuffles on every
 * keystroke reads as instability, not as variety.
 */
const SAMPLE_DIGITS = "48159263";
const SAMPLE_LETTERS = "KRMTBVLZ";

const PATTERN_LEGEND = [
  { token: "#", meaning: "one digit" },
  { token: "A", meaning: "one uppercase letter" },
  { token: "*", meaning: "one letter or digit" },
];

function exampleFor(format) {
  let placeholders = 0;
  const rendered = [...String(format || "")]
    .map((character) => {
      if (character === "#") return SAMPLE_DIGITS[placeholders++ % SAMPLE_DIGITS.length];
      if (character === "A") return SAMPLE_LETTERS[placeholders++ % SAMPLE_LETTERS.length];
      if (character === "*") {
        const pool = placeholders % 2 ? SAMPLE_DIGITS : SAMPLE_LETTERS;
        return pool[placeholders++ % pool.length];
      }
      return character;
    })
    .join("");
  return { rendered, placeholders };
}

/**
 * A number the profile has to carry as a number. Empty is allowed while
 * typing — clearing a field to retype it is not an error worth fighting
 * — and reported as missing rather than silently coerced to zero.
 */
function PolicyNumber({ label, name, value, min, max, unit, hint, error, onChange }) {
  const blank = value === "" || value === null || value === undefined;
  return (
    <Field
      label={unit ? `${label} (${unit})` : label}
      name={name}
      type="number"
      min={min}
      max={max}
      value={blank ? "" : value}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      hint={hint}
      error={error || (blank ? "Required." : undefined)}
    />
  );
}

export default function PolicyStep({ config, update, errors }) {
  const policy = config.policy || {};
  const identity = config.identity || {};

  // Neutral stand-ins for this screen's prose only; the profile takes its
  // own defaults from the terminology step.
  const memberNoun = config.terminology?.memberNoun || "member";
  const resourceNoun = config.terminology?.resourceNoun || "resource";

  const setPolicy = (field) => (value) => update({ policy: { ...policy, [field]: value } });
  const setHours = (field) => (event) => update({ policy: { ...policy, [field]: event.target.value } });

  const open = minutesOf(policy.openTime);
  const close = minutesOf(policy.closeTime);
  const hoursInverted = open !== null && close !== null && close <= open;

  const { rendered, placeholders } = exampleFor(identity.memberIdFormat);
  const formatError = errorFor(errors, "identity.memberIdFormat");

  return (
    <div className="space-y-4">
      <Panel title="Reservations" icon={Clock}>
        <div className="grid sm:grid-cols-2 gap-4">
          <PolicyNumber
            label="Grace period"
            name="gracePeriodMinutes"
            unit="minutes"
            min={1}
            max={120}
            value={policy.gracePeriodMinutes}
            onChange={setPolicy("gracePeriodMinutes")}
            error={errorFor(errors, "policy.gracePeriodMinutes")}
            hint={`How long a ${resourceNoun} is held after the reservation starts. Tap in before it
                   runs out, or the ${resourceNoun} is released for someone else and counted as a no-show.`}
          />
          <PolicyNumber
            label="Maximum stay"
            name="maxStayHours"
            unit="hours"
            min={1}
            max={24}
            value={policy.maxStayHours}
            onChange={setPolicy("maxStayHours")}
            error={errorFor(errors, "policy.maxStayHours")}
            hint={`The longest one session can run. A session that reaches the cap is ended and the
                   ${resourceNoun} goes back on the map automatically.`}
          />
        </div>
        <p className="text-xs text-ink-muted mt-3">
          Changing the grace period after launch notifies everyone holding a reservation that day,
          so it is worth agreeing on before go-live rather than tuning in public.
        </p>
      </Panel>

      <Panel title="Accounts and codes" icon={ShieldCheck}>
        <div className="grid sm:grid-cols-2 gap-4">
          <PolicyNumber
            label="PIN lockout after"
            name="pinLockoutThreshold"
            unit="attempts"
            min={3}
            max={20}
            value={policy.pinLockoutThreshold}
            onChange={setPolicy("pinLockoutThreshold")}
            error={errorFor(errors, "policy.pinLockoutThreshold")}
            hint={`Consecutive wrong PINs before that ${memberNoun}'s account is locked and has to be
                   reset. Low enough to stop guessing, high enough to survive a fat finger.`}
          />
          <PolicyNumber
            label="Verification code expiry"
            name="verificationCodeExpiryMinutes"
            unit="minutes"
            min={1}
            max={60}
            value={policy.verificationCodeExpiryMinutes}
            onChange={setPolicy("verificationCodeExpiryMinutes")}
            error={errorFor(errors, "policy.verificationCodeExpiryMinutes")}
            hint="How long an emailed code stays valid — both the one that finishes registration and
                  the one that resets a forgotten PIN."
          />
        </div>
      </Panel>

      <Panel title="Operating hours" icon={Timer}>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field
            label="Opens"
            name="openTime"
            type="time"
            value={policy.openTime || ""}
            onChange={setHours("openTime")}
            error={errorFor(errors, "policy.openTime")}
            hint="Before this, nothing can be reserved or checked in."
          />
          <Field
            label="Closes"
            name="closeTime"
            type="time"
            value={policy.closeTime || ""}
            onChange={setHours("closeTime")}
            error={errorFor(errors, "policy.closeTime")}
            hint="Anyone still checked in at closing is checked out automatically."
          />
        </div>

        {hoursInverted && (
          <Notice tone="error" className="mt-4">
            Closing has to be after opening, or there is no time left to book. Opening hours can't
            run past midnight.
          </Notice>
        )}

        <p className="text-xs text-ink-muted mt-3">
          These hours apply to every building in your system, in Philippine time.
        </p>
      </Panel>

      <Panel title="Member ID format" icon={IdCard}>
        <div className="grid sm:grid-cols-2 gap-4 items-start">
          <Field
            label="Format"
            name="memberIdFormat"
            mono
            value={identity.memberIdFormat || ""}
            onChange={(e) => update({ identity: { ...identity, memberIdFormat: e.target.value } })}
            placeholder="####-######"
            error={formatError}
            hint="The shape of the ID people already carry — a student number, an employee number."
          />

          <div>
            <span className="text-sm text-ink-secondary">Example</span>
            <div className="mt-1.5 h-11 px-3 rounded-md bg-bg-panel border border-line/10 font-mono
                            text-ink-primary flex items-center">
              {rendered || <span className="text-ink-muted">—</span>}
            </div>
            <span className="text-xs mt-1 block text-ink-muted">
              Generated from the format on the left.
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4">
          {PATTERN_LEGEND.map(({ token, meaning }) => (
            <span key={token} className="text-sm text-ink-secondary flex items-center gap-2">
              <Badge>
                <span className="font-mono">{token}</span>
              </Badge>
              {meaning}
            </span>
          ))}
          <span className="text-sm text-ink-secondary">Anything else is a literal character.</span>
        </div>

        {!formatError && placeholders === 0 && (
          <Notice tone="error" className="mt-4">
            This format has no <span className="font-mono">#</span>, <span className="font-mono">A</span> or{" "}
            <span className="font-mono">*</span> in it, so every member would be issued the same ID.
          </Notice>
        )}

        <p className="text-xs text-ink-muted mt-4">
          People check in by tapping an RFID card at the kiosk. It is the only way to check in for
          now, so there is nothing to choose here.
        </p>
      </Panel>

      <Panel title="Registration" icon={UserPlus}>
        <span className="text-sm text-ink-secondary">Self-service registration</span>
        <div className="mt-1.5">
          <Segmented
            value={identity.selfServiceRegistration === false ? "staff" : "self"}
            onChange={(next) =>
              update({ identity: { ...identity, selfServiceRegistration: next === "self" } })
            }
            options={[
              { value: "self", label: `${capitalize(memberNoun)}s enrol themselves` },
              { value: "staff", label: `Staff enrol ${memberNoun}s` },
            ]}
          />
        </div>
        <p className="text-sm text-ink-secondary mt-3">
          {identity.selfServiceRegistration === false
            ? `The kiosk turns away a card it doesn't know. Staff add each ${memberNoun} before their
               card works, which suits a place where cards are handed out by an office.`
            : `An unknown card at the kiosk starts enrolment: the ${memberNoun} types their details,
               receives a code by email and confirms it there and then. Nobody has to be at a desk.`}
        </p>
      </Panel>
    </div>
  );
}
