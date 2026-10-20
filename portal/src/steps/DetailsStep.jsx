import { Building2, Check, UserCog, Wand2 } from "lucide-react";
import { Field, Notice, Panel } from "../components/ui.jsx";
import { VERTICAL_PRESETS } from "../lib/profile.js";

/**
 * Step 1 — who is buying, and what kind of space they run.
 *
 * The preset picker is the only control in the wizard that writes
 * several config groups at once. It is a starting point rather than a
 * mode: every value it sets is editable in the steps that follow, and it
 * deliberately leaves the organization and site names alone — those are
 * the two things the buyer has already told us, and the only two a
 * preset could only ever get wrong.
 */

/** A preset carries its own picker chrome and demo names; neither belongs in the buyer's profile. */
const PRESET_SKIP = new Set(["key", "label", "description", "organizationName", "siteName"]);

/** App keys errors by the dotted field path validate() reports. */
const errorFor = (errors, field) => errors?.[field];

/** "1 starter floor", "2 starter floors". */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function DetailsStep({ config, update, errors }) {
  const applyPreset = (preset) => {
    // Cloned: the presets are a module-level constant, and a config that
    // aliased one would let an edit made later in the wizard follow the
    // buyer into the next preset they try.
    const patch = { preset: preset.key };
    for (const [field, value] of Object.entries(preset)) {
      if (PRESET_SKIP.has(field)) continue;
      patch[field] = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
    }
    update(patch);
  };

  return (
    <div className="space-y-4">
      <Panel title="The buying organization" icon={Building2}>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field
            label="Organization name"
            name="organizationName"
            value={config.organizationName || ""}
            onChange={(e) => update({ organizationName: e.target.value })}
            placeholder="Acme Holdings"
            error={errorFor(errors, "organizationName")}
            hint="Shown in the header, on the kiosk and in every email the system sends."
          />
          <Field
            label="Site name"
            name="siteName"
            value={config.siteName || ""}
            onChange={(e) => update({ siteName: e.target.value })}
            placeholder="Main Site"
            error={errorFor(errors, "siteName")}
            hint="Where your space is — a campus, a branch, an office. Your floors belong to it."
          />
        </div>
        {/* The profile key used to be shown here as "how the provisioning
            script refers to this profile" — SILLA's own bookkeeping, read
            by the person buying. buildProfile still derives it from the
            organization name; nobody buying needs to see it. */}
      </Panel>

      {/*
        Who the system belongs to.
        This is not an administrative afterthought — it is the block that
        decides whether the provisioned deployment gets a real founding
        superadmin or falls back to the shared demo accounts. Every
        organization provisioned without it used to receive the same
        published admin@demo.test / 123456, so any buyer could sign into
        any other buyer's system.
      */}
      <Panel
        title="Who will run it"
        icon={UserCog}
        subtitle="They become your system's first administrator — the only account it starts with — and can add your staff from there."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="First name"
            name="ownerFirstName"
            value={config.owner?.firstName || ""}
            onChange={(e) => update({ owner: { ...config.owner, firstName: e.target.value } })}
            placeholder="Ana"
            error={errorFor(errors, "owner.firstName")}
          />
          <Field
            label="Last name"
            name="ownerLastName"
            value={config.owner?.lastName || ""}
            onChange={(e) => update({ owner: { ...config.owner, lastName: e.target.value } })}
            placeholder="Reyes"
            error={errorFor(errors, "owner.lastName")}
          />
        </div>

        <Field
          className="mt-4"
          label="Email"
          name="ownerEmail"
          type="email"
          value={config.owner?.email || ""}
          onChange={(e) => update({ owner: { ...config.owner, email: e.target.value } })}
          placeholder="ana@your-organization.org"
          error={errorFor(errors, "owner.email")}
          hint="The sign-in link and a one-time PIN go here the moment the system is built. Nobody at SILLA can see the PIN they choose afterwards."
        />
      </Panel>

      <Panel title="Starting point" icon={Wand2}>
        <Notice>
          A starting point fills in the words, the ID format, the rules, the furniture and a starter
          layout for that kind of space. Nothing it sets is locked — the steps after this one change
          any of it — and the names you typed above stay as they are.
        </Notice>

        <div className="grid sm:grid-cols-2 gap-3 mt-4">
          {VERTICAL_PRESETS.map((preset) => {
            const branding = preset.branding || {};
            const selected = preset.key === config.preset;
            const swatches = [branding.primaryColor, branding.surface?.card, branding.ink?.primary].filter(Boolean);
            const facts = [
              preset.terminology && `${preset.terminology.memberNoun} · ${preset.terminology.resourceNoun}`,
              preset.catalog && plural(preset.catalog.length, "resource type"),
              preset.floors && plural(preset.floors.length, "starter floor"),
            ].filter(Boolean);

            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyPreset(preset)}
                aria-pressed={selected}
                className="text-left rounded-lg border border-line/10 bg-bg-card shadow-raised p-4
                           transition-colors duration-fast ease-out hover:border-line/25"
                style={selected ? { borderColor: "var(--color-accent)" } : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink-primary">{preset.label || preset.key}</span>
                  {selected && <Check size={15} style={{ color: "var(--color-accent)" }} />}
                  <span className="ml-auto flex gap-1">
                    {swatches.map((colour, i) => (
                      <span
                        key={`${colour}-${i}`}
                        className="w-3.5 h-3.5 rounded-full border border-line/20"
                        style={{ background: colour }}
                      />
                    ))}
                  </span>
                </div>
                {preset.description && <p className="text-sm text-ink-secondary mt-1">{preset.description}</p>}
                {facts.length > 0 && <p className="text-xs text-ink-muted mt-2">{facts.join(" — ")}</p>}
              </button>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
