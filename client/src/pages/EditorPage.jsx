import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Ban, CircleCheck, Layers, MousePointerClick, Plus, Tag, Trash2, Wrench } from "lucide-react";
import { api } from "../lib/api.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import SpaceMap from "../components/SpaceMap.jsx";
import GridSketch from "../components/GridSketch.jsx";
import {
  Badge, Button, Card, EmptyState, Field, Loading, Modal, Notice, Page, PageHeader, Panel,
  Segmented, Skeleton, Spinner,
} from "../components/ui/index.jsx";

/**
 * EditorPage — MAP-3, MAP-4, MAP-5 and floor management (spec §12, §14).
 *
 * "One shared layout model renders both the admin editor and the
 * member-facing map", so this reuses SpaceMap unchanged and adds an
 * editing layer on top.
 *
 * ── Roles ──────────────────────────────────────────────────────────
 * The two admin roles get genuinely different powers here, matching
 * spec §14's split between running the space and configuring it:
 *
 *   staff       availability only — mark a desk unavailable, or a
 *               machine out of service. They operate the space.
 *   superadmin  everything above, plus placing and removing pieces,
 *               zones, labels, and the floors themselves. They define
 *               what the space IS.
 *
 * The gate is enforced on the server (the resource and floor-write
 * routes are superadmin-only); hiding tools here is so staff aren't
 * offered buttons that would only ever 403.
 */

const TOOL = {
  AVAILABILITY: "availability",
  PLACE: "place",
  REMOVE: "remove",
  ZONE: "zone",
  LABEL: "label",
};

export default function EditorPage() {
  const { org } = useOrg();
  const { user, booting, isAuthenticated } = useAuth();
  const { floorId } = useParams();
  const navigate = useNavigate();

  const [floors, setFloors] = useState([]);
  const [data, setData] = useState(null);
  const [tool, setTool] = useState(TOOL.AVAILABILITY);
  const [typeKey, setTypeKey] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);
  /** A rectangle drawn on the map, waiting for its name. */
  const [pendingZone, setPendingZone] = useState(null);
  const [zoneName, setZoneName] = useState("");
  const [labelDraft, setLabelDraft] = useState({ text: "", col: 0, row: 0 });

  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const isSuperadmin = user?.role === "superadmin";

  const loadFloors = useCallback(() => {
    api.getFloors(import.meta.env.VITE_DEMO_ORG_ID).then((d) => {
      setFloors(d.floors);
      if (!floorId && d.floors.length) navigate(`/editor/${d.floors[0].id}`, { replace: true });
    });
  }, [floorId, navigate]);
  useEffect(loadFloors, [loadFloors]);

  const load = useCallback(() => {
    if (!floorId) return;
    api
      .getFloorLayout(floorId)
      .then((d) => {
        setData(d);
        setTypeKey((current) => current || d.resourceTypes[0]?.key || null);
      })
      .catch((e) => setError(e.message));
  }, [floorId]);
  useEffect(load, [load]);

  // Staff never get the structural tools, so make sure the selected one
  // is legal for this role.
  useEffect(() => {
    if (!isSuperadmin && tool !== TOOL.AVAILABILITY) setTool(TOOL.AVAILABILITY);
  }, [isSuperadmin, tool]);

  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user && !["staff", "superadmin"].includes(user.role)) {
    return (
      <Page>
        <Notice tone="error">The map editor is a staff surface.</Notice>
        <Link to="/map" className="mt-4 inline-block text-sm text-accent underline underline-offset-4">
          Back to the map
        </Link>
      </Page>
    );
  }

  const act = async (fn, successMessage) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Clicking a unit: remove its piece, or open the availability panel. */
  const onSelectUnit = (unit) => {
    setError(null);
    if (tool === TOOL.REMOVE && isSuperadmin) {
      act(() => api.removeResource(unit.resourceId), "Removed.");
      setSelectedUnit(null);
      return;
    }
    if (tool === TOOL.AVAILABILITY) setSelectedUnit(unit);
  };

  /** Clicking an empty cell places, or seeds a zone/label position. */
  /**
   * A rectangle was dragged out. Zones need a name, so the geometry is
   * held and the dialog asks for the one thing a drag cannot express.
   */
  const onRegionSelect = (rect) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.ZONE) setPendingZone(rect);
  };

  const onCellClick = (col, row) => {
    if (!isSuperadmin) return;
    if (tool === TOOL.PLACE) {
      act(() => api.placeResource({ floorId, resourceTypeKey: typeKey, col, row }));
    } else if (tool === TOOL.ZONE) {
      setZoneDraft((z) => ({ ...z, col, row }));
    } else if (tool === TOOL.LABEL) {
      setLabelDraft((l) => ({ ...l, col, row }));
    }
  };

  const setUnitState = (patch, message) =>
    act(() => api.adminSetUnit(selectedUnit.resourceId, selectedUnit.unitLabel, patch), message);

  const tools = [
    { value: TOOL.AVAILABILITY, label: "Availability", icon: CircleCheck, title: "ADM-2 — staff & superadmin" },
    ...(isSuperadmin
      ? [
          { value: TOOL.PLACE, label: `Place ${resourceNoun}`, icon: MousePointerClick, title: "MAP-3" },
          { value: TOOL.REMOVE, label: "Remove", icon: Trash2, title: "MAP-3" },
          { value: TOOL.ZONE, label: "Zone", icon: Layers, title: "MAP-4" },
          { value: TOOL.LABEL, label: "Label", icon: Tag, title: "MAP-5" },
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title="Map editor"
        subtitle={
          data
            ? `${data.floor.site.name} · ${data.floor.name} · ${data.floor.grid.cols}×${data.floor.grid.rows}`
            : "Loading…"
        }
        action={<Button onClick={() => navigate(`/map/${floorId}`)}>View as member</Button>}
      />

      {!isSuperadmin && (
        <Notice className="mb-4">
          You can change any {resourceNoun}'s availability here. Placing or removing them, and editing
          floors, is a superadmin task.
        </Notice>
      )}

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Layers size={16} className="text-ink-muted" />
        <Segmented
          className="editorfloors"
          value={floorId}
          onChange={(id) => {
            setSelectedUnit(null);
            navigate(`/editor/${id}`);
          }}
          options={floors.map((f) => ({ value: f.id, label: f.name }))}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Segmented className="editortools" value={tool} onChange={setTool} options={tools} />
        {busy && <Spinner className="text-ink-muted" />}
      </div>

      {/* Catalog palette (spec §8: pick-from-palette, fixed footprints) */}
      {tool === TOOL.PLACE && data && (
        <div className="mb-3">
          <Segmented
            className="catalog"
            size="sm"
            value={typeKey}
            onChange={setTypeKey}
            options={data.resourceTypes.map((t) => ({
              value: t.key,
              label: `${t.label} · ${t.footprint.w}×${t.footprint.h} · ${t.seatCount}`,
            }))}
          />
        </div>
      )}

      {/*
        Zones are DRAWN, not typed.
        This asked for a corner by click and then width and height as
        numbers, which is the wrong instrument for a spatial editor: you
        know where the room is, you do not know that it is 7 cells wide.
        Drag the box on the map and name it afterwards.
      */}
      {tool === TOOL.ZONE && isSuperadmin && (
        <Notice className="mb-4">
          Drag a box on the map to draw a zone. Membership is derived from position — nothing is tagged
          by hand.
        </Notice>
      )}

      {tool === TOOL.LABEL && isSuperadmin && (
        <InlineForm
          onSubmit={() =>
            act(() => api.createLabel({ floorId, ...labelDraft }), "Label added.").then(() =>
              setLabelDraft((l) => ({ ...l, text: "" }))
            )
          }
          fields={[
            { label: "Text", value: labelDraft.text, onChange: (v) => setLabelDraft((l) => ({ ...l, text: v })) },
            { label: "Col", value: labelDraft.col, type: "number", onChange: (v) => setLabelDraft((l) => ({ ...l, col: +v })) },
            { label: "Row", value: labelDraft.row, type: "number", onChange: (v) => setLabelDraft((l) => ({ ...l, row: +v })) },
          ]}
          submitLabel="Add label"
          hint="Orientation text only — not reservable, excluded from analytics."
        />
      )}

      {error && (
        <Notice tone="error" className="mb-3">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="success" className="mb-3">
          {notice}
        </Notice>
      )}

      <Card padded={false} className="overflow-hidden">
        {data ? (
          <SpaceMap
            floor={data.floor}
            layout={data.layout}
            resourceTypes={data.resourceTypes}
            status={data.status}
            resourceNoun={resourceNoun}
            showOverstay
            palette={palette}
            selectedUnit={selectedUnit}
            onSelectUnit={onSelectUnit}
            onCellClick={onCellClick}
            regionMode={isSuperadmin && tool === TOOL.ZONE}
            onRegionSelect={onRegionSelect}
            editing={isSuperadmin && tool !== TOOL.REMOVE && tool !== TOOL.AVAILABILITY}
          />
        ) : (
          <div className="h-[46vh] p-4">
            <Skeleton className="w-full h-full" rounded="rounded-md" />
          </div>
        )}
      </Card>

      <p className="mt-3 text-xs text-ink-muted">
        {tool === TOOL.AVAILABILITY && `Click any ${resourceNoun} to change its availability.`}
        {tool === TOOL.PLACE && "Click an empty cell to place the selected piece."}
        {tool === TOOL.REMOVE && "Click a piece to remove it."}
        {tool === TOOL.ZONE && "Drag a box on the map, then name it."}
        {tool === TOOL.LABEL && "Click the map to set the position, then submit above."}
      </p>

      {/* ADM-2 — availability, the one editing power staff also have. */}
      {tool === TOOL.AVAILABILITY && selectedUnit && (
        <AvailabilityPanel
          unit={selectedUnit}
          resourceNoun={resourceNoun}
          busy={busy}
          onClose={() => setSelectedUnit(null)}
          onSet={setUnitState}
        />
      )}

      {data && (
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <ListPanel
            title={`Zones (${data.layout.zones.length})`}
            readOnly={!isSuperadmin}
            items={data.layout.zones.map((z) => ({
              id: z.id,
              primary: z.name,
              secondary: `(${z.bounds.col}, ${z.bounds.row}) ${z.bounds.w}×${z.bounds.h}`,
            }))}
            onRemove={(id) => act(() => api.deleteZone(id), "Zone removed.")}
          />
          <ListPanel
            title={`Labels (${data.layout.labels.length})`}
            readOnly={!isSuperadmin}
            items={data.layout.labels.map((l) => ({
              id: l.id,
              primary: l.text,
              secondary: `(${l.position.col}, ${l.position.row})`,
            }))}
            onRemove={(id) => act(() => api.deleteLabel(id), "Label removed.")}
          />
        </div>
      )}

      {isSuperadmin && (
        <FloorManager
          floors={floors}
          current={data?.floor}
          busy={busy}
          onChanged={() => {
            loadFloors();
            load();
          }}
          onError={setError}
          onNotice={setNotice}
          onDeleted={(id) => {
            if (id === floorId) navigate("/editor", { replace: true });
          }}
        />
      )}

      <p className="mt-4 text-xs text-ink-muted">
        Fixed footprints, integer cells, no rotation — that constraint is what keeps the editor simple.
        Overlap and bounds are enforced server-side.
      </p>
      <Modal
        open={Boolean(pendingZone)}
        onClose={() => { setPendingZone(null); setZoneName(""); }}
        title="Name this zone"
        subtitle={pendingZone ? `${pendingZone.w} × ${pendingZone.h} cells at (${pendingZone.col}, ${pendingZone.row})` : ""}
        icon={Layers}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const rect = pendingZone;
            const name = zoneName.trim();
            if (!rect || !name) return;
            setPendingZone(null);
            setZoneName("");
            act(() => api.createZone({ floorId, name, ...rect }), `Zone "${name}" added.`);
          }}
        >
          <Field
            label="Zone name"
            data-autofocus
            required
            placeholder="Quiet Study"
            value={zoneName}
            onChange={(e) => setZoneName(e.target.value)}
          />
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => { setPendingZone(null); setZoneName(""); }}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!zoneName.trim()}>
              Add zone
            </Button>
          </div>
        </form>
      </Modal>

    </Page>
  );
}

/* ─────────────────────── availability (ADM-2) ─────────────────────── */

function AvailabilityPanel({ unit, resourceNoun, busy, onClose, onSet }) {
  const current = unit.status?.status;
  const oos = unit.status?.serviceStatus === "out_of_service";
  // Occupied/reserved are derived from reservations — the server refuses
  // to set them directly, so don't offer it.
  const derived = current === "occupied" || current === "reserved";

  return (
    <Panel
      className="mt-4"
      title={`${unit.type.label} · ${resourceNoun} ${unit.unitLabel}`}
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="text-ink-secondary">Currently</span>
        <Badge tone={current}>{unit.statusLabel}</Badge>
        <span className="text-xs text-ink-muted">
          at ({unit.position.col}, {unit.position.row})
        </span>
      </div>

      {derived ? (
        <Notice>
          This {resourceNoun} is {current} because of a live reservation. Cancel it from the console's
          Resources &amp; Rules view to free it.
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            icon={CircleCheck}
            disabled={busy || (current === "available" && !oos)}
            onClick={() => onSet({ status: "available", serviceStatus: "working" }, "Marked available.")}
          >
            Available
          </Button>
          <Button
            icon={Ban}
            disabled={busy || (current === "unavailable" && !oos)}
            onClick={() => onSet({ status: "unavailable" }, "Marked unavailable.")}
          >
            Unavailable
          </Button>
          {unit.type.hasServiceStatus && (
            <Button
              icon={Wrench}
              disabled={busy}
              onClick={() =>
                onSet(
                  oos ? { serviceStatus: "working", status: "available" } : { serviceStatus: "out_of_service" },
                  oos ? "Marked working." : "Marked out of service."
                )
              }
            >
              {oos ? "Mark working" : "Out of service"}
            </Button>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        Staff and superadmins can both change availability. Only a superadmin can add or remove{" "}
        {resourceNoun}s.
      </p>
    </Panel>
  );
}

/* ───────────────────── floors (superadmin only) ───────────────────── */

function FloorManager({ floors, current, busy, onChanged, onError, onNotice, onDeleted }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", cols: 20, rows: 12 });
  const [resize, setResize] = useState(null);

  useEffect(() => {
    if (current) setResize({ name: current.name, cols: current.grid.cols, rows: current.grid.rows });
  }, [current?.id, current?.grid?.cols, current?.grid?.rows, current?.name]);

  const run = async (fn, message) => {
    onError(null);
    onNotice(null);
    try {
      await fn();
      onNotice(message);
      onChanged();
      return true;
    } catch (e) {
      onError(e.message);
      return false;
    }
  };

  return (
    <Panel
      className="mt-4"
      title="Floors"
      icon={Layers}
      action={
        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
          Add floor
        </Button>
      }
    >
      {/*
        A dialog, not a toggle that grows a form out of the panel.
        "Add floor" pushed the floor list down while you were reading it
        and turned its own trigger into a Cancel button, so the control
        you pressed changed meaning underneath the cursor.
      */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a floor"
        subtitle="Give it a name and a grid size. Both can be changed later."
        icon={Layers}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () => api.createFloor({ name: draft.name, grid: { cols: draft.cols, rows: draft.rows } }),
              `Added "${draft.name}".`
            );
            if (ok) {
              setDraft({ name: "", cols: 20, rows: 12 });
              setAdding(false);
            }
          }}
        >
          <Field
            label="Floor name"
            required
            data-autofocus
            placeholder="Second Floor"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {/* Sketch the room rather than describing it in two numbers.
              The fields stay, below, for whoever does know the figure —
              the drag sets them and they set the drag. */}
          <div className="mt-4">
            <span className="text-sm font-medium text-ink-secondary">Room size</span>
            <div className="mt-1.5">
              <GridSketch
                cols={draft.cols}
                rows={draft.rows}
                onChange={({ cols, rows }) => setDraft((d) => ({ ...d, cols, rows }))}
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field
              label="Columns"
              type="number"
              min={1}
              max={60}
              value={draft.cols}
              onChange={(e) => setDraft((d) => ({ ...d, cols: Number(e.target.value) }))}
            />
            <Field
              label="Rows"
              type="number"
              min={1}
              max={60}
              value={draft.rows}
              onChange={(e) => setDraft((d) => ({ ...d, rows: Number(e.target.value) }))}
            />
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!draft.name.trim() || busy}>
              Create floor
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rename / resize the floor currently open */}
      {current && resize && (
        <form
          className="flex flex-wrap gap-2 items-end mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () =>
                api.updateFloor(current.id, {
                  name: resize.name,
                  grid: { cols: resize.cols, rows: resize.rows },
                }),
              "Floor updated."
            );
          }}
        >
          <Field
            label="Name"
            value={resize.name}
            onChange={(e) => setResize((r) => ({ ...r, name: e.target.value }))}
            className="w-48"
          />
          <Field
            label="Columns"
            type="number"
            min={1}
            max={60}
            value={resize.cols}
            onChange={(e) => setResize((r) => ({ ...r, cols: Number(e.target.value) }))}
            className="w-24"
          />
          <Field
            label="Rows"
            type="number"
            min={1}
            max={60}
            value={resize.rows}
            onChange={(e) => setResize((r) => ({ ...r, rows: Number(e.target.value) }))}
            className="w-24"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            Save size
          </Button>
        </form>
      )}

      <ul className="divide-y divide-line/10">
        {floors.map((f) => (
          <li key={f.id} className="py-2 flex items-center gap-3 text-sm">
            <span className="text-ink-primary mr-auto">
              {f.name}
              {current?.id === f.id && <span className="ml-2 text-xs text-ink-muted">(editing)</span>}
            </span>
            <span className="text-xs text-ink-muted tabular-nums">
              {f.grid.cols}×{f.grid.rows}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="border border-line/10"
              disabled={busy || floors.length <= 1}
              title={floors.length <= 1 ? "A site must keep at least one floor" : "Delete this floor"}
              onClick={async () => {
                const ok = await run(() => api.deleteFloor(f.id), `Deleted "${f.name}".`);
                if (ok) onDeleted(f.id);
              }}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">
        Shrinking a room is refused while anything would fall outside the new bounds, and a floor with
        placed items or live reservations can't be deleted.
      </p>
    </Panel>
  );
}

/* ─────────────────────────────── bits ─────────────────────────────── */

function InlineForm({ fields, onSubmit, submitLabel, hint }) {
  return (
    <Card className="mb-3 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex flex-wrap gap-2 items-end"
      >
        {fields.map((f) => (
          <Field
            key={f.label}
            label={f.label}
            required
            type={f.type || "text"}
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
            className={f.type === "number" ? "w-20" : "w-48"}
          />
        ))}
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
      </form>
      {hint && <p className="text-xs text-ink-muted mt-2">{hint}</p>}
    </Card>
  );
}

function ListPanel({ title, items, onRemove, readOnly }) {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <EmptyState
          title="None yet"
          body={readOnly ? "A superadmin can add these." : "Use the tool above to add one."}
        />
      ) : (
        <ul className="divide-y divide-line/10">
          {items.map((i) => (
            <li key={i.id} className="py-2 flex items-center gap-2 text-sm">
              <span className="text-ink-primary mr-auto">{i.primary}</span>
              <span className="text-xs text-ink-muted">{i.secondary}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => onRemove(i.id)}
                  className="text-ink-muted hover:text-state-unavailable transition-colors duration-fast ease-out rounded-sm"
                  aria-label={`Remove ${i.primary}`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
