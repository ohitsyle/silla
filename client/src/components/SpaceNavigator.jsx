import { Building2, ChevronDown, ChevronRight, DoorOpen, Layers } from "lucide-react";
import { motion } from "framer-motion";
import { roomMode } from "../lib/rooms.js";
import { Segmented } from "./ui/index.jsx";

/**
 * The map's hierarchy, read top to bottom the way the space is:
 *
 *   Building 1 › Ground › Commons          where you are
 *   BUILDING [Building 1 ▾]  FLOOR [Ground|Upper]
 *   ROOMS ON GROUND [All of Ground] [Commons] [Meeting room]
 *
 * It replaced a second sidebar holding a collapsible tree. The tree held
 * the same information, but it put the hierarchy beside the map instead of
 * above it, took 240px from the map on every screen, and vanished entirely
 * below `lg`, where phones got two unlabelled selects instead. Each level
 * now has its own labelled row that works the same at every width: the
 * building only when there is a choice to make, floors as tabs, and the
 * rooms on the chosen floor as a row you can scroll.
 *
 * `focused` (a room is open) folds the choosing rows away below `lg`:
 * on a phone the panel needs the height, and the breadcrumb alone is
 * enough to step back out — tapping the floor returns to every row.
 *
 * Each part is exported on its own so the editor can reuse the switcher
 * and the tabs without the member-facing room row.
 */
export default function SpaceNavigator({
  buildings = [],
  floorId,
  rooms = [],
  roomId = null,
  status = {},
  resourceNoun = "resource",
  actions = null,
  focused = false,
  onFloor,
  onRoom,
  onFloorView,
}) {
  const choosable = buildings.filter((building) => building.floors.length);
  const building = choosable.find((candidate) => candidate.floors.some((floor) => floor.id === floorId));
  const floor = building?.floors.find((candidate) => candidate.id === floorId);
  const room = rooms.find((candidate) => candidate.id === roomId) || null;

  return (
    <header className="shrink-0 border-b border-line/10">
      <div className="flex min-h-[3rem] items-center gap-3 px-4 pt-3">
        <Breadcrumb building={building} floor={floor} room={room} onFloorView={onFloorView} />
        {actions && <div className="ml-auto flex shrink-0 items-center gap-3">{actions}</div>}
      </div>

      <div className={`flex-wrap items-end gap-x-5 gap-y-3 px-4 pt-2 ${focused ? "hidden lg:flex" : "flex"}`}>
        {choosable.length > 1 && (
          <Level caption="Building">
            <BuildingSwitcher
              buildings={choosable}
              value={building?.id}
              onChange={(next) => onFloor(next.floors[0].id)}
            />
          </Level>
        )}
        {building && (
          <Level caption="Floor">
            <FloorTabs floors={building.floors} value={floorId} onChange={onFloor} />
          </Level>
        )}
      </div>

      {floor && rooms.length > 0 ? (
        <Level caption={`Rooms on ${floor.name}`} className={`px-4 pb-3 pt-3 ${focused ? "hidden lg:block" : ""}`}>
          <RoomTabs
            floorName={floor.name}
            rooms={rooms}
            value={roomId}
            status={status}
            resourceNoun={resourceNoun}
            onRoom={onRoom}
            onFloorView={onFloorView}
          />
        </Level>
      ) : (
        <div className="h-3" />
      )}
    </header>
  );
}

/** A small caption over one level of the hierarchy, so each row says what it chooses. */
function Level({ caption, className = "", children }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{caption}</p>
      {children}
    </div>
  );
}

/**
 * Building › Floor › Room. The floor steps back out of a room; the last
 * part is where you are. Long names truncate rather than wrapping, so the
 * row keeps its height on a phone.
 */
export function Breadcrumb({ building, floor, room, onFloorView }) {
  const separator = <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />;
  return (
    <nav aria-label="Where you are" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-[15px]">
        <li className="flex min-w-0 shrink items-center gap-1.5 text-ink-secondary">
          <Building2 size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
          <span className="truncate">{building?.name || "…"}</span>
        </li>
        {floor && (
          <>
            {separator}
            <li className="min-w-0 shrink">
              {room ? (
                <button
                  type="button"
                  onClick={onFloorView}
                  className="max-w-full truncate rounded-sm text-ink-secondary transition-colors duration-fast hover:text-ink-primary"
                >
                  {floor.name}
                </button>
              ) : (
                <span aria-current="page" className="block truncate font-semibold text-ink-primary">
                  {floor.name}
                </span>
              )}
            </li>
          </>
        )}
        {room && (
          <>
            {separator}
            <li aria-current="page" className="min-w-0 shrink truncate font-semibold text-ink-primary">
              {room.name}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

/**
 * Which building — only rendered when there is more than one to choose.
 * A native select under a styled face: it is the one control that already
 * works everywhere, including the platform pickers on a phone.
 */
export function BuildingSwitcher({ buildings, value, onChange, label = "Building" }) {
  const current = buildings.find((building) => building.id === value);
  return (
    <label
      className="relative flex h-9 max-w-[16rem] cursor-pointer items-center gap-2 rounded-md border border-line/10
                 bg-bg-panel pl-3 pr-8 text-sm font-medium transition-colors duration-fast
                 hover:border-line/25 focus-within:border-line/40"
    >
      <Building2 size={15} className="shrink-0 text-ink-muted" />
      <span className="truncate">{current?.name || "Choose a building"}</span>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-ink-muted" />
      <select
        aria-label={label}
        value={value || ""}
        onChange={(e) => onChange(buildings.find((building) => building.id === e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {!current && <option value="">Choose a building</option>}
        {buildings.map((building) => (
          <option key={building.id} value={building.id}>
            {building.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The building's floors as tabs — every floor visible at once, the current one filled. */
export function FloorTabs({ floors, value, onChange, className = "map-floors" }) {
  return (
    <Segmented
      size="sm"
      className={className}
      value={value}
      onChange={onChange}
      options={floors.map((floor) => ({ value: floor.id, label: floor.name }))}
    />
  );
}

/** A room's own live state, as its tab says it. Free rooms say what they offer instead. */
const ROOM_STATE_WORDS = { reserved: "Booked now", occupied: "In use now", unavailable: "Closed" };

/**
 * The rooms on this floor, each saying what it lets you book. "All of
 * <floor>" leads back to the whole plan. Scrolls sideways when there are
 * more than fit, rather than wrapping into a wall of chips above the map.
 */
export function RoomTabs({ floorName, rooms, value, status, resourceNoun, onRoom, onFloorView }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-1">
      <ul className="flex w-max gap-2">
        <li>
          <RoomTab
            selected={!value}
            onClick={onFloorView}
            icon={Layers}
            title={`All of ${floorName}`}
            detail="The whole floor plan"
          />
        </li>
        {rooms.map((room) => {
          const state = status[room.resourceId]?.[0]?.status || "available";
          return (
            <li key={room.id}>
              <RoomTab
                selected={value === room.id}
                onClick={() => onRoom(room)}
                icon={DoorOpen}
                title={room.name}
                detail={roomMode(room.bookingMode, resourceNoun).short}
                state={ROOM_STATE_WORDS[state] ? state : null}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RoomTab({ selected, onClick, icon: Icon, title, detail, state }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={`relative flex h-12 min-w-[9rem] max-w-[15rem] items-center gap-2.5 rounded-md border px-3 text-left
                  transition-colors duration-fast ${selected ? "" : "border-line/10 bg-bg-panel/40 hover:border-line/25"}`}
      style={
        selected
          ? { borderColor: "rgb(var(--c-accent) / 0.6)", background: "rgb(var(--c-accent) / 0.1)" }
          : undefined
      }
    >
      {selected && (
        <motion.span
          layoutId="room-tab-marker"
          className="absolute inset-x-3 -bottom-px h-0.5 rounded-full"
          style={{ background: "var(--color-accent)" }}
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      <Icon size={16} className="shrink-0" style={{ color: selected ? "var(--color-accent)" : "var(--color-ink-muted)" }} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium leading-tight">{title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-ink-muted">
          {state && (
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: `var(--color-state-${state})` }}
            />
          )}
          <span className="truncate">{state ? ROOM_STATE_WORDS[state] : detail}</span>
        </span>
      </span>
    </button>
  );
}
