import { Check, Contrast, Droplet, Palette } from "lucide-react";
import { ColorField, Notice, Panel } from "../components/ui.jsx";
import { COLOR_SCHEMES } from "../lib/profile.js";

/**
 * Step 3 — the palette.
 *
 * A buyer's deployment restyles the whole surface, not just a button:
 * page, cards, panels, hairlines and three weights of text all come from
 * here (spec §16). Schemes are a first pass at that; the fields below
 * them are the escape hatch, because a brand guideline is rarely a
 * scheme somebody else wrote.
 *
 * Contrast is reported rather than enforced. The wizard cannot know that
 * a brand's mandated pairing is genuinely unusable, so it says what the
 * ratio is and leaves the decision where it belongs.
 */

/** The palette half of a scheme; its key and name are picker chrome. */
const BRANDING_FIELDS = ["primaryColor", "accentTextColor", "surface", "ink", "states"];
const brandingOf = (scheme) => {
  const picked = {};
  for (const field of BRANDING_FIELDS) if (scheme[field]) picked[field] = scheme[field];
  return picked;
};

const parseHex = (value) => {
  const hex = String(value || "").trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
};

const CHANNEL_WEIGHTS = [0.2126, 0.7152, 0.0722];

const relativeLuminance = (rgb) =>
  rgb
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * CHANNEL_WEIGHTS[index], 0);

/** WCAG 2.1 contrast ratio, or null when either colour is not yet a valid hex. */
function contrastRatio(foreground, background) {
  const first = parseHex(foreground);
  const second = parseHex(background);
  if (!first || !second) return null;
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const verdict = (ratio) => {
  if (ratio === null) return "—";
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "Large text only";
  return "Below AA";
};

function ContrastReadout({ label, ratio }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-ink-secondary">{label}</span>
      <span className="text-ink-primary font-semibold tabular-nums">
        {ratio === null ? "—" : `${ratio.toFixed(1)}:1`}
      </span>
      <span className="text-ink-muted text-xs">{verdict(ratio)}</span>
    </div>
  );
}

/** A scheme rendered as the thing it produces: a page, a card, some text and the accent. */
function SchemePreview({ branding }) {
  const surface = branding.surface || {};
  const ink = branding.ink || {};
  return (
    <div className="rounded-md p-3 border border-line/10" style={{ background: surface.page }}>
      <div className="rounded-md p-3 space-y-2" style={{ background: surface.card }}>
        <div className="h-1.5 w-20 rounded-full" style={{ background: ink.primary }} />
        <div className="h-1.5 w-28 rounded-full opacity-70" style={{ background: ink.secondary }} />
        <div className="flex items-center gap-2 pt-1">
          <span
            className="text-[10px] font-semibold px-2 py-1 rounded"
            style={{ background: branding.primaryColor, color: branding.accentTextColor }}
          >
            Reserve
          </span>
          <span className="h-6 flex-1 rounded" style={{ background: surface.panel }} />
        </div>
      </div>
    </div>
  );
}

export default function BrandingStep({ config, update }) {
  const branding = config.branding || {};
  const surface = branding.surface || {};
  const ink = branding.ink || {};
  const setBranding = (patch) => update({ branding: { ...branding, ...patch } });

  // The scheme name is recorded alongside the palette because buildProfile
  // falls back to it for anything the buyer leaves unset — a stale name
  // would fill those gaps from a palette that is no longer on screen.
  const applyScheme = (scheme) =>
    update({ colorScheme: scheme.key, branding: { ...branding, ...brandingOf(scheme) } });

  // ColorField owns its input; accept the value it reports either way so
  // a plain <input type="color"> event works too.
  const hexOf = (next) => (typeof next === "string" ? next : next?.target?.value ?? "");

  const setAccent = (field) => (next) => setBranding({ [field]: hexOf(next) });
  const setSurface = (field) => (next) => setBranding({ surface: { ...surface, [field]: hexOf(next) } });
  const setInk = (field) => (next) => setBranding({ ink: { ...ink, [field]: hexOf(next) } });

  const accentRatio = contrastRatio(branding.accentTextColor, branding.primaryColor);
  const bodyRatio = contrastRatio(ink.primary, surface.card);
  const mutedRatio = contrastRatio(ink.muted, surface.card);

  const activeSchemeKey = COLOR_SCHEMES.find((scheme) => {
    const candidate = brandingOf(scheme);
    return (
      candidate.primaryColor === branding.primaryColor &&
      candidate.surface?.page === surface.page
    );
  })?.key;

  return (
    <div className="space-y-4">
      <Panel title="Colour scheme" icon={Palette}>
        <p className="text-sm text-ink-secondary mb-4">
          Pick the closest starting point, then adjust anything below. A scheme sets the accent,
          the surfaces and the text weights together, which is what keeps a palette coherent.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {COLOR_SCHEMES.map((scheme) => {
            const candidate = brandingOf(scheme);
            const selected = scheme.key === activeSchemeKey;
            return (
              <button
                key={scheme.key}
                type="button"
                onClick={() => applyScheme(scheme)}
                aria-pressed={selected}
                className="text-left rounded-lg border border-line/10 bg-bg-card shadow-raised p-3
                           transition-colors duration-fast ease-out hover:border-line/25"
                style={selected ? { borderColor: "var(--color-accent)" } : undefined}
              >
                <SchemePreview branding={candidate} />
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-sm font-medium text-ink-primary">{scheme.name}</span>
                  {selected && <Check size={14} className="ml-auto" style={{ color: "var(--color-accent)" }} />}
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="Accent" icon={Droplet}>
        <div className="grid sm:grid-cols-2 gap-4">
          <ColorField
            label="Accent"
            name="primaryColor"
            value={branding.primaryColor || ""}
            onChange={setAccent("primaryColor")}
            hint="Buttons, selection, the focus ring — the one colour people will call “theirs”."
          />
          <ColorField
            label="Text on accent"
            name="accentTextColor"
            value={branding.accentTextColor || ""}
            onChange={setAccent("accentTextColor")}
            hint="What a label sitting on the accent is drawn in."
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span
            className="text-sm font-semibold px-4 py-2 rounded-md"
            style={{ background: branding.primaryColor, color: branding.accentTextColor }}
          >
            Reserve a {config.terminology?.resourceNoun || "resource"}
          </span>
          <ContrastReadout label="Accent pair" ratio={accentRatio} />
        </div>

        {accentRatio !== null && accentRatio < 4.5 && (
          <Notice className="mt-4">
            The text on your accent lands at {accentRatio.toFixed(1)}:1, under the 4.5:1 that WCAG AA
            asks for body-sized text. Buttons will still work — this is a warning, not a block — but a
            darker or lighter “text on accent” is worth trying first.
          </Notice>
        )}
      </Panel>

      <Panel title="Surface and text" icon={Contrast}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <ColorField
            label="Page"
            name="surface.page"
            value={surface.page || ""}
            onChange={setSurface("page")}
            hint="Top of the background gradient."
          />
          <ColorField
            label="Page end"
            name="surface.pageEnd"
            value={surface.pageEnd || ""}
            onChange={setSurface("pageEnd")}
            hint="Bottom of it. Keep it close to Page unless you want a visible gradient."
          />
          <ColorField
            label="Card"
            name="surface.card"
            value={surface.card || ""}
            onChange={setSurface("card")}
            hint="Panels and cards — everything content sits on."
          />
          <ColorField
            label="Panel"
            name="surface.panel"
            value={surface.panel || ""}
            onChange={setSurface("panel")}
            hint="Inputs and inset areas inside a card."
          />
          <ColorField
            label="Line"
            name="surface.line"
            value={surface.line || ""}
            onChange={setSurface("line")}
            hint="Hairlines and dividers, drawn at low opacity. Usually the text colour."
          />
        </div>

        <div className="grid sm:grid-cols-3 gap-4 mt-4 pt-4 border-t border-line/10">
          <ColorField
            label="Text — primary"
            name="ink.primary"
            value={ink.primary || ""}
            onChange={setInk("primary")}
            hint="Headings, values, anything that must be read."
          />
          <ColorField
            label="Text — secondary"
            name="ink.secondary"
            value={ink.secondary || ""}
            onChange={setInk("secondary")}
            hint="Labels and supporting copy."
          />
          <ColorField
            label="Text — muted"
            name="ink.muted"
            value={ink.muted || ""}
            onChange={setInk("muted")}
            hint="Hints and timestamps."
          />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4">
          <ContrastReadout label="Primary text on card" ratio={bodyRatio} />
          <ContrastReadout label="Muted text on card" ratio={mutedRatio} />
        </div>

        <p className="text-xs text-ink-muted mt-4">
          Status colours — available, reserved, occupied, unavailable, overstay — stay on the
          product defaults unless a preset overrides them. They are deliberately separate from the
          accent so a green brand cannot make “available” and “branded” read as the same thing.
        </p>
      </Panel>
    </div>
  );
}
