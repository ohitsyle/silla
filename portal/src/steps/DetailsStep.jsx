import { Building2, Check, Wand2 } from "lucide-react";
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

/**
 * The same slug rule `buildProfile` applies, so the key shown here is the
 * key the emitted profile will carry. It is displayed rather than edited
 * because the profile has no key field of its own to store an override
 * in — the organization name is the single source of it.
 */
const slugify = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

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
            hint="The building this deployment covers. Floors belong to it."
          />
        </div>

        <div className="mt-4 rounded-md border border-line/10 bg-bg-panel px-4 py-3">
          <span className="text-sm text-ink-secondary">Profile key</span>
          <div className="font-mono text-sm text-ink-primary mt-0.5">
            {slugify(config.organizationName) || "deployment"}
          </div>
          <span className="text-xs mt-1 block text-ink-muted">
            How the provisioning script refers to this profile. Derived from the organization name so
            the two can never disagree.
          </span>
        </div>
      </Panel>

      <Panel title="Starting point" icon={Wand2}>
        <Notice>
          A preset fills in terminology, identity, policy, the resource catalog and a starter
          layout for that kind of space. Nothing it sets is locked — the steps after this one edit
          all of it — and your organization and site names are left as you typed them.
        </Notice>

        <div className="grid sm:grid-cols-2 gap-3 mt-4">
          {VERTICAL_PRESETS.map((preset) => {
            const branding = preset.branding || {};
            const selected = preset.key === config.preset;
            const swatches = [branding.primaryColor, branding.surface?.card, branding.ink?.primary].filter(Boolean);
            const facts = [
              preset.terminology && `${preset.terminology.memberNoun} · ${preset.terminology.resourceNoun}`,
              preset.catalog && `${preset.catalog.length} resource types`,
              preset.floors && `${preset.floors.length} starter floors`,
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
