import { Building2, Check, DoorOpen, Layers, Pencil, Plus, SquareDashedMousePointer, X } from "lucide-react";
import { plural } from "../lib/rooms.js";
import { BuildingSwitcher, FloorTabs } from "./SpaceNavigator.jsx";
import { Button } from "./ui/index.jsx";

/**
 * The editor's setup, as the sequence it really is:
 *
 *   1 Building   name it — or adopt the floors that predate buildings
 *   2 Floors     add the building's floors
 *   3 Rooms      draw a room on a floor, then choose what members book in it
 *
 * Each step holds its own controls (the building switcher lives in step 1,
 * the floor tabs in step 2), so the order of the page IS the order of the
 * work. The first step still to do is highlighted and says what to do
 * next; steps that cannot start yet say what they are waiting for, rather
 * than offering buttons that would fail.
 *
 * These existed before as a row of selects and buttons above the map —
 * Add building, Rename building, a Room tool, a Floors panel at the very
 * bottom of the page — and nothing said which came first.
 *
 * `limits` carries the plan's reading per step (lib/rooms.js readLimit):
 * "3 of 5 rooms", and at the cap a sentence in place of the Add button.
 * Unmanaged organizations have no limits, and see neither.
 */
export default function SetupSteps({
  buildings,
  building,
  floor,
  resourceNoun,
  drawing,
  limits = {},
  onBuilding,
  onFloor,
  onAddBuilding,
  onEditBuilding,
  onAddFloor,
  onDrawRoom,
  onStopDrawing,
}) {
  const choosable = buildings.filter((candidate) => candidate.floors.length || !candidate.unassigned);
  const needsSetup = Boolean(building?.unassigned);
  const floors = building?.floors || [];
  const rooms = floor?.rooms || [];

  const buildingDone = Boolean(building) && !needsSetup;
  const floorsDone = buildingDone && floors.length > 0;
  const current = !buildingDone ? 1 : !floorsDone ? 2 : rooms.length ? 0 : 3;

  return (
    <ol className="grid gap-3 lg:grid-cols-3" aria-label="Set up the space">
      <Step
        number={1}
        title="Building"
        icon={Building2}
        state={buildingDone ? "done" : "current"}
        summary={
          needsSetup
            ? "Your existing floors aren't in a building yet."
            : building
              ? building.name
              : "Start by adding the building your space is in."
        }
        detail={
          needsSetup &&
          "Name the building they belong to. Floor names, furniture and bookings stay exactly as they are."
        }
        usage={limits.buildings}
      >
        {choosable.length > 1 && (
          <BuildingSwitcher
            buildings={choosable.map((candidate) => ({
              ...candidate,
              name: candidate.unassigned ? `${candidate.name} — needs setup` : candidate.name,
            }))}
            value={building?.id}
            onChange={onBuilding}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {needsSetup && !limits.buildings?.blocked && (
            <Button size="sm" variant="primary" icon={Building2} onClick={onEditBuilding}>
              Set up building
            </Button>
          )}
          {buildingDone && (
            <Button size="sm" icon={Pencil} onClick={onEditBuilding}>
              Rename
            </Button>
          )}
          {!limits.buildings?.blocked && (
            <Button size="sm" variant={building ? "secondary" : "primary"} icon={Plus} onClick={onAddBuilding}>
              {building ? "Add building" : "Add a building"}
            </Button>
          )}
        </div>
      </Step>

      <Step
        number={2}
        title="Floors"
        icon={Layers}
        state={floorsDone ? "done" : current === 2 ? "current" : "waiting"}
        summary={
          !buildingDone
            ? "Once the building is set up."
            : floors.length
              ? `${floors.length} ${plural("floor", floors.length)} in ${building.name}`
              : `${building.name} has no floors yet.`
        }
        detail={buildingDone && !floors.length && "Each floor is a grid you place rooms and furniture on."}
        usage={buildingDone ? limits.floors : null}
      >
        {floorsDone && <FloorTabs floors={floors} value={floor?.id} onChange={onFloor} className="editor-floors" />}
        {buildingDone && !limits.floors?.blocked && (
          <div>
            <Button size="sm" variant={floors.length ? "secondary" : "primary"} icon={Plus} onClick={onAddFloor}>
              {floors.length ? "Add floor" : "Add the first floor"}
            </Button>
          </div>
        )}
      </Step>

      <Step
        number={3}
        title="Rooms"
        icon={DoorOpen}
        state={!floorsDone ? "waiting" : rooms.length ? "done" : "current"}
        summary={
          !floorsDone
            ? "Once there is a floor to draw on."
            : drawing
              ? "Drag a box on the map around the room."
              : rooms.length
                ? `${rooms.length} ${plural("room", rooms.length)} on ${floor.name}`
                : `No rooms on ${floor?.name} yet.`
        }
        detail={
          floorsDone &&
          (drawing
            ? "Corner to corner, around everything the room holds. Next you'll choose how members book it."
            : `Draw a room around a space, then choose what members book: the whole room, or ${plural(resourceNoun)} inside it.`)
        }
        usage={floorsDone ? limits.rooms : null}
      >
        {floorsDone && (drawing || !limits.rooms?.blocked) && (
          <div>
            {drawing ? (
              <Button size="sm" icon={X} onClick={onStopDrawing}>
                Stop drawing
              </Button>
            ) : (
              <Button size="sm" variant={rooms.length ? "secondary" : "primary"} icon={SquareDashedMousePointer} onClick={onDrawRoom}>
                {rooms.length ? "Draw another room" : "Draw a room"}
              </Button>
            )}
          </div>
        )}
      </Step>
    </ol>
  );
}

/**
 * One step: its number (a tick once done), what it is, where it stands,
 * the plan's reading for it when the plan limits it, and its controls.
 */
function Step({ number, title, icon: Icon, state, summary, detail, usage, children }) {
  const current = state === "current";
  const waiting = state === "waiting";
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors duration-fast ${
        current ? "" : "border-line/10 bg-bg-card"
      } ${waiting ? "opacity-60" : ""}`}
      style={current ? { borderColor: "rgb(var(--c-accent) / 0.55)", background: "rgb(var(--c-accent) / 0.06)" } : undefined}
    >
      <div className="flex items-start gap-3">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold"
          style={
            state === "done"
              ? { background: "rgb(var(--c-state-available) / 0.18)", color: "var(--color-state-available)" }
              : current
                ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
                : { background: "rgb(var(--c-line) / 0.1)", color: "var(--color-ink-muted)" }
          }
          aria-hidden="true"
        >
          {state === "done" ? <Check size={14} strokeWidth={3} /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            <Icon size={13} />
            Step {number} · {title}
          </p>
          <p className="mt-1 font-medium leading-snug">{summary}</p>
          {detail && <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{detail}</p>}
        </div>
      </div>
      {usage && <Usage {...usage} />}
      {children}
    </li>
  );
}

/** "3 of 5 rooms on your plan", a bar, and at the cap the reason there is no Add. */
export function Usage({ used, max, noun, blocked, blockedReason }) {
  const share = max ? Math.min(1, used / max) : 1;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-ink-secondary">
        <span className="font-semibold tabular-nums text-ink-primary">{used}</span> of {max} {noun} on your plan
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-line/10" aria-hidden="true">
        <div
          className="h-full rounded-full"
          style={{ width: `${share * 100}%`, background: `var(--color-state-${blocked ? "reserved" : "available"})` }}
        />
      </div>
      {blocked && <p className="text-xs leading-relaxed text-ink-secondary">{blockedReason}</p>}
    </div>
  );
}
