import { Layers, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge, Button, Card, Field, Notice, Panel, Toggle } from "../components/ui.jsx";

/**
 * Step 6 — the floors and how big each grid is.
 *
 * A buyer never draws a map during onboarding, so a floor here is only a
 * name and a grid. The starter layout is generated from the catalog when
 * the profile is emitted, which is why this step sets whether there is
 * one rather than what is on it.
 */

const MIN_SIDE = 1;
const MAX_SIDE = 60; // matches GRID_LIMITS in server/src/routes/floor.routes.js

/** App keys errors by the dotted field path validate() reports. */
const errorFor = (errors, field) => errors?.[field];

const positiveInt = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
};

const clampSide = (value) =>
  value === "" ? "" : Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.floor(Number(value)) || MIN_SIDE));

export default function FloorsStep({ config, update, errors }) {
  const floors = config.floors || [];
  const demoLayout = config.demoLayout !== false;

  const writeFloors = (next) =>
    // `order` is what the floor switcher sorts by, so it is derived from
    // position rather than being a number anyone has to maintain.
    update({ floors: next.map((floor, index) => ({ ...floor, order: index })) });

  const changeFloor = (index, patch) =>
    writeFloors(floors.map((floor, i) => (i === index ? { ...floor, ...patch } : floor)));

  const addFloor = () =>
    writeFloors([...floors, { name: `Floor ${floors.length + 1}`, cols: 20, rows: 12 }]);

  const removeFloor = (index) => writeFloors(floors.filter((_, i) => i !== index));

  return (
    <div className="space-y-4">
      <Panel
        title="Floors"
        icon={Layers}
        action={
          <Button icon={Plus} size="sm" onClick={addFloor}>
            Add floor
          </Button>
        }
      >
        <p className="text-sm text-ink-secondary">
          Each floor is a grid of whole cells. Pick a size that mirrors the real room's proportions —
          pieces are placed cell by cell in the map editor after provisioning, so a grid that is
          roughly the right shape is worth more than one that is exactly the right area.
        </p>

        {floors.length === 0 && (
          <Notice tone="error" className="mt-4">
            {errorFor(errors, "floors") ||
              "A deployment needs at least one floor. There is nowhere to put anything otherwise."}
          </Notice>
        )}

        <div className="space-y-3 mt-4">
          {floors.map((floor, index) => {
            const cols = positiveInt(floor.cols);
            const rows = positiveInt(floor.rows);
            const cells = cols && rows ? cols * rows : null;

            return (
              <Card key={floor.id || index}>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-start">
                  <Field
                    label="Floor name"
                    name={`floor-${index}-name`}
                    className="lg:col-span-2"
                    value={floor.name || ""}
                    onChange={(e) => changeFloor(index, { name: e.target.value })}
                    error={errorFor(errors, `floors.${index}.name`)}
                    hint="What people see in the floor switcher."
                  />
                  <Field
                    label="Columns"
                    name={`floor-${index}-cols`}
                    type="number"
                    min={MIN_SIDE}
                    max={MAX_SIDE}
                    value={floor.cols ?? ""}
                    onChange={(e) => changeFloor(index, { cols: clampSide(e.target.value) })}
                    error={errorFor(errors, `floors.${index}.cols`)}
                    hint={`${MIN_SIDE}–${MAX_SIDE}`}
                  />
                  <Field
                    label="Rows"
                    name={`floor-${index}-rows`}
                    type="number"
                    min={MIN_SIDE}
                    max={MAX_SIDE}
                    value={floor.rows ?? ""}
                    onChange={(e) => changeFloor(index, { rows: clampSide(e.target.value) })}
                    error={errorFor(errors, `floors.${index}.rows`)}
                    hint={`${MIN_SIDE}–${MAX_SIDE}`}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 mt-4">
                  <Badge>{cells === null ? "grid incomplete" : `${cols} × ${rows} — ${cells} cells`}</Badge>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    className="ml-auto"
                    disabled={floors.length <= 1}
                    onClick={() => removeFloor(index)}
                    title={
                      floors.length <= 1
                        ? "A deployment needs at least one floor."
                        : "Removes this floor."
                    }
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </Panel>

      <Panel title="Starter layout" icon={Sparkles}>
        <Toggle
          label="Fill each floor with a demonstration layout"
          checked={demoLayout}
          onChange={(next) => update({ demoLayout: next })}
          hint="Pieces from your catalog, laid out to fit the grid, with a couple of zones and
                labels. Staff rearrange them in the map editor once the system is live."
        />
        <p className="text-xs text-ink-muted mt-3">
          {demoLayout
            ? "Turn this off only if your own layout is going in on day one — a first boot onto an empty grid looks broken rather than new."
            : "Every floor will be provisioned empty, so the first thing staff see is a blank grid waiting for the map editor."}
        </p>
      </Panel>
    </div>
  );
}
