import {
  Armchair, BookOpen, Boxes, Coffee, DoorClosed, LayoutGrid, Laptop, Monitor, Phone, Plus,
  Presentation, Sofa, Square, Trash2, Users,
} from "lucide-react";
import { Badge, Button, Card, Field, Notice, Panel, Segmented, Select } from "../components/ui.jsx";

/**
 * Step 5 — the catalog of things that can be placed on a map.
 *
 * A type's key is derived from its label rather than typed, because the
 * key is what the emitted layout references and the seeder rejects a
 * piece pointing at a type that is not in the catalog. Two things named
 * the same would collide on the org-scoped unique index, so a duplicate
 * is suffixed here instead of failing at provisioning time.
 *
 * The starter layout is generated from this catalog at emit time, so
 * there are no placed pieces to keep in step — editing a type changes
 * what the seeder draws, not a stored map.
 */

/**
 * The icon names the map renderer ships with, mirroring CATALOG_ICONS in
 * lib/profile.js. A free-text icon field would let a buyer provision a
 * system whose map draws nothing.
 */
const ICONS = {
  Square, Boxes, Armchair, Sofa, Monitor, Laptop, Users, Presentation, Phone, DoorClosed,
  Coffee, BookOpen, LayoutGrid,
};

/** Vertical-neutral, so an unedited row never implies a library or an office. */
const DEFAULT_ICON = "Square";

const MAX_FOOTPRINT = 12;
const MAX_SEATS = 40;

/** App keys errors by the dotted field path validate() reports. */
const errorFor = (errors, field) => errors?.[field];

const keyFor = (label) =>
  String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

const uniqueKey = (base, taken) => {
  const root = base || "type";
  if (!taken.has(root)) return root;
  let suffix = 2;
  while (taken.has(`${root}_${suffix}`)) suffix += 1;
  return `${root}_${suffix}`;
};

const positiveInt = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
};

/** The footprint drawn as the cells it occupies — the constraint is easier to see than to read. */
function FootprintDiagram({ w, h }) {
  const cols = positiveInt(w);
  const rows = positiveInt(h);
  if (!cols || !rows || cols > MAX_FOOTPRINT || rows > MAX_FOOTPRINT) return null;
  return (
    <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, 0.625rem)` }}>
      {Array.from({ length: cols * rows }, (_, index) => (
        <span key={index} className="w-2.5 h-2.5 rounded-[2px] bg-line/10 border border-line/20" />
      ))}
    </div>
  );
}

export default function CatalogStep({ config, update, errors }) {
  const catalog = config.catalog || [];
  const resourceNoun = config.terminology?.resourceNoun || "resource";

  const changeType = (index, patch) => {
    const next = { ...catalog[index], ...patch };

    // The key is the reference the generated layout holds, so it follows
    // the label instead of being a second thing to keep in step by hand.
    if (patch.label !== undefined) {
      const taken = new Set(catalog.filter((_, i) => i !== index).map((type) => type.key));
      next.key = uniqueKey(keyFor(patch.label), taken);
    }

    update({ catalog: catalog.map((type, i) => (i === index ? next : type)) });
  };

  const addType = () => {
    const taken = new Set(catalog.map((type) => type.key));
    update({
      catalog: [
        ...catalog,
        { key: uniqueKey("new_type", taken), label: "New type", w: 1, h: 1, seatCount: 1, icon: DEFAULT_ICON },
      ],
    });
  };

  const removeType = (index) => update({ catalog: catalog.filter((_, i) => i !== index) });

  return (
    <Panel
      title="Resource catalog"
      icon={Boxes}
      action={
        <Button icon={Plus} size="sm" onClick={addType}>
          Add type
        </Button>
      }
    >
      <Notice>
        A type's footprint is a fixed block of grid cells — no free-shaping, no resizing on the map.
        That constraint is deliberate: it is what lets the editor place a piece by clicking one cell
        and check for overlap by counting cells, instead of shipping a drawing tool. Model a bigger
        table as a bigger footprint here.
      </Notice>

      {catalog.length === 0 && (
        <Notice tone="error" className="mt-4">
          {errorFor(errors, "catalog") ||
            `Nothing to place yet. Add at least one type — a floor with no ${resourceNoun} on it is not worth provisioning.`}
        </Notice>
      )}

      <div className="space-y-3 mt-4">
        {catalog.map((type, index) => {
          const Icon = ICONS[type.icon] || ICONS[DEFAULT_ICON];
          const seats = positiveInt(type.seatCount);
          // The key has no control of its own — it is derived from the
          // label — so a key problem is reported against the field that
          // would fix it rather than left with nowhere to appear.
          const labelError =
            errorFor(errors, `catalog.${index}.label`) || errorFor(errors, `catalog.${index}.key`);

          return (
            // Keyed by position, not by key: the key is re-derived on every
            // keystroke in the label field, and a changing React key would
            // remount the card and take the focus with it.
            <Card key={index}>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="w-9 h-9 rounded-md bg-bg-panel flex items-center justify-center text-ink-secondary shrink-0">
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink-primary">{type.label || "Untitled type"}</div>
                  <div className="text-xs text-ink-muted font-mono">{type.key}</div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Badge>{seats ? `${seats} units each` : "unit count not set"}</Badge>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    onClick={() => removeType(index)}
                    title="Removes this type, and everything the starter layout would have placed of it."
                  >
                    Remove
                  </Button>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-start">
                <Field
                  label="Label"
                  name={`catalog-${index}-label`}
                  className="lg:col-span-2"
                  value={type.label || ""}
                  onChange={(e) => changeType(index, { label: e.target.value })}
                  error={labelError}
                  hint="What staff pick from the editor's palette."
                />
                <Field
                  label="Width (cells)"
                  name={`catalog-${index}-w`}
                  type="number"
                  min={1}
                  max={MAX_FOOTPRINT}
                  value={type.w ?? ""}
                  onChange={(e) => changeType(index, { w: e.target.value === "" ? "" : Number(e.target.value) })}
                  error={errorFor(errors, `catalog.${index}.w`)}
                />
                <Field
                  label="Height (cells)"
                  name={`catalog-${index}-h`}
                  type="number"
                  min={1}
                  max={MAX_FOOTPRINT}
                  value={type.h ?? ""}
                  onChange={(e) => changeType(index, { h: e.target.value === "" ? "" : Number(e.target.value) })}
                  error={errorFor(errors, `catalog.${index}.h`)}
                />
                <Field
                  label="Bookable units"
                  name={`catalog-${index}-seats`}
                  type="number"
                  min={1}
                  max={MAX_SEATS}
                  value={type.seatCount ?? ""}
                  onChange={(e) =>
                    changeType(index, { seatCount: e.target.value === "" ? "" : Number(e.target.value) })
                  }
                  error={errorFor(errors, `catalog.${index}.seatCount`)}
                  hint="How many people can book this piece at once."
                />
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-start mt-3">
                <Select
                  label="Icon"
                  className="lg:col-span-2"
                  value={type.icon || DEFAULT_ICON}
                  onChange={(e) => changeType(index, { icon: e.target.value })}
                  hint="Drawn on the piece so a unit is never identified by colour alone."
                >
                  {Object.keys(ICONS).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>

                <div className="lg:col-span-2">
                  <span className="text-sm text-ink-secondary">Tracks service status</span>
                  <div className="mt-1.5">
                    <Segmented
                      size="sm"
                      value={type.hasServiceStatus ? "yes" : "no"}
                      onChange={(next) => changeType(index, { hasServiceStatus: next === "yes" })}
                      options={[
                        { value: "no", label: "No" },
                        { value: "yes", label: "Yes" },
                      ]}
                    />
                  </div>
                  <span className="text-xs mt-1 block text-ink-muted">
                    For equipment that can break. Staff can mark one out of service, which reads
                    differently from simply being unavailable.
                  </span>
                </div>

                <div>
                  <span className="text-sm text-ink-secondary">Footprint</span>
                  <div className="mt-2">
                    <FootprintDiagram w={type.w} h={type.h} />
                  </div>
                  <span className="text-xs mt-2 block text-ink-muted">
                    {positiveInt(type.w) && positiveInt(type.h)
                      ? `${type.w} × ${type.h} cells · ${seats || "?"} units`
                      : "Set a whole number of cells."}
                  </span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </Panel>
  );
}
