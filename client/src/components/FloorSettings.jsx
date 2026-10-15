import { useEffect, useState } from "react";
import { Layers, Ruler, Trash2 } from "lucide-react";
import { api } from "../lib/api.js";
import GridSketch from "./GridSketch.jsx";
import { shapeSize } from "../lib/shapeWords.js";
import { Button, Field, Modal, Notice, Panel, Select } from "./ui/index.jsx";

/**
 * Floors in the editor — superadmin only (floor.routes.js refuses anyone
 * else): adding one to a building, and the open floor's own settings.
 *
 * A floor is a grid of whole cells and, for a building that is not a
 * rectangle, an outline inside it. 1–60 each way is the server's own limit
 * (validateGrid); offering a bigger sketch than it accepts would be a trap.
 * An existing floor's outline is redrawn on the map itself, with the
 * editor's Shape tool.
 */
const GRID = { min: 1, max: 60 };
const DEFAULT_OUTLINE = { cols: 20, rows: 12, areas: [] };

/**
 * "Add a floor" — a dialog, not a form that grows out of the page: the
 * floor sketch needs room, and step 2 should not push the map away.
 */
export function AddFloorDialog({ open, building, onClose, onCreated }) {
  const [name, setName] = useState("");
  /** { cols, rows, areas }: the grid, and the outline inside it (none for a rectangle). */
  const [outline, setOutline] = useState(DEFAULT_OUTLINE);
  const [nameError, setNameError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setOutline(DEFAULT_OUTLINE);
    setNameError(null);
    setError(null);
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setNameError("Give this floor a name.");
      return;
    }
    setBusy(true);
    try {
      const { cols, rows, areas } = outline;
      const created = await api.createFloor({
        name,
        buildingId: building.id,
        grid: { cols, rows },
        ...(areas.length ? { shape: { areas } } : {}),
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={`Add a floor to ${building?.name || "the building"}`}
      subtitle="A name and a shape. Both can be changed later."
      icon={Layers}
      width="max-w-xl"
    >
      <form onSubmit={submit} noValidate>
        <Field
          label="Floor name"
          data-autofocus
          placeholder="Ground floor, Level 2, Mezzanine…"
          value={name}
          error={nameError}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />
        {/* Sketch the floor rather than describing it in two numbers. The
            fields stay for whoever does know the figure — each drives the
            other — while the floor is a rectangle; a shaped floor is only
            described by its sketch. */}
        <div className="mt-4">
          <span className="text-sm font-medium text-ink-secondary">Shape</span>
          <div className="mt-1.5">
            <GridSketch cols={outline.cols} rows={outline.rows} areas={outline.areas} onChange={setOutline} />
          </div>
        </div>
        {outline.areas.length ? (
          <p className="mt-3 text-sm text-ink-secondary">
            {shapeSize(outline.areas)}. Rooms and furniture can only go inside the outline.
          </p>
        ) : (
          <GridFields grid={outline} onChange={(grid) => setOutline({ ...grid, areas: [] })} />
        )}
        {error && (
          <Notice tone="error" className="mt-4">
            {error}
          </Notice>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Add floor
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function GridFields({ grid, onChange, className = "mt-4 grid grid-cols-2 gap-3" }) {
  const set = (key) => (e) => onChange({ cols: grid.cols, rows: grid.rows, [key]: Number(e.target.value) });
  return (
    <div className={className}>
      <Field label="Columns" type="number" min={GRID.min} max={GRID.max} value={grid.cols} onChange={set("cols")} />
      <Field label="Rows" type="number" min={GRID.min} max={GRID.max} value={grid.rows} onChange={set("rows")} />
    </div>
  );
}

/**
 * The open floor's name, size and building, and removing it. Shrinking is
 * refused while anything would fall outside the new edge, and only an
 * empty floor can be removed — the server says which, and that message is
 * shown as it is.
 */
export function FloorSettings({ floor, buildings = [], onChanged, onDeleted }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!floor) return;
    setDraft({ name: floor.name, buildingId: floor.building?.id || "", cols: floor.grid.cols, rows: floor.grid.rows });
    setError(null);
    setNotice(null);
  }, [floor?.id, floor?.name, floor?.grid?.cols, floor?.grid?.rows, floor?.building?.id]);

  if (!floor || !draft) return null;

  const run = async (action, message) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setNotice(message);
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      setError("Give this floor a name.");
      return;
    }
    const result = await run(
      () =>
        api.updateFloor(floor.id, {
          name: draft.name,
          ...(draft.buildingId ? { buildingId: draft.buildingId } : {}),
          grid: { cols: draft.cols, rows: draft.rows },
        }),
      "Floor saved."
    );
    if (result) onChanged(result);
  };

  const remove = async () => {
    const result = await run(() => api.deleteFloor(floor.id), `Removed "${floor.name}".`);
    if (result) {
      setRemoving(false);
      onDeleted(floor.id);
    }
  };

  return (
    <Panel title={`Floor settings · ${floor.name}`} icon={Ruler} className="mt-4">
      <form onSubmit={save} className="flex flex-wrap items-end gap-3" noValidate>
        <Field
          label="Name"
          className="w-48"
          value={draft.name}
          onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
        />
        {buildings.length > 1 && (
          <Select
            label="Building"
            value={draft.buildingId}
            onChange={(e) => setDraft((current) => ({ ...current, buildingId: e.target.value }))}
          >
            {buildings.map((building) => (
              <option key={building.id} value={building.id}>
                {building.name}
              </option>
            ))}
          </Select>
        )}
        <GridFields
          className="flex gap-3 [&>label]:w-24"
          grid={{ cols: draft.cols, rows: draft.rows }}
          onChange={(grid) => setDraft((current) => ({ ...current, ...grid }))}
        />
        <Button type="submit" variant="primary" loading={busy}>
          Save floor
        </Button>
        <Button icon={Trash2} variant="ghost" className="ml-auto" disabled={busy} onClick={() => setRemoving(true)}>
          Remove floor
        </Button>
      </form>
      {error && (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mt-3">
          {notice}
        </Notice>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        Shrinking is refused while anything would fall outside the new edge, and trims a shaped floor's outline to
        fit. Reshape the outline itself with the Shape tool above the map. Move a floor's rooms off it before moving
        it to another building.
      </p>

      <Modal open={removing} onClose={busy ? undefined : () => setRemoving(false)} title="Remove floor" subtitle={floor.name} icon={Trash2}>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Only an empty floor can be removed: move or remove its rooms and furniture first. Booking history is kept.
        </p>
        {error && (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={busy} onClick={() => setRemoving(false)}>
            Keep floor
          </Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Remove floor
          </Button>
        </div>
      </Modal>
    </Panel>
  );
}
