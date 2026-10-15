import { useEffect, useState } from "react";
import {
  Building2, CalendarClock, DoorOpen, Grid2x2, LayoutGrid, Lock, LockOpen, Settings2, SquareDashedMousePointer, Trash2,
} from "lucide-react";
import { api } from "../lib/api.js";
import { ROOM_MODE_ORDER, levelName, plural, roomMode } from "../lib/rooms.js";
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, Select } from "./ui/index.jsx";

/**
 * Rooms in the editor: the panel listing a floor's rooms, the dialog that
 * creates or configures one, and the dialog for buildings.
 *
 * Who may do what follows the server (routes/space.routes.js): staff close
 * and reopen rooms and read their schedules; only a superadmin draws a
 * room, changes its booking mode or touches buildings. Staff are not shown
 * the controls that would refuse them.
 */

/** What the room's own state reads as, for staff. */
const ROOM_STATE = {
  available: { label: "Open", tone: "available" },
  reserved: { label: "Booked now", tone: "reserved" },
  occupied: { label: "In use", tone: "occupied" },
  unavailable: { label: "Closed", tone: "unavailable" },
};

/* ───────────────────────────── the rooms panel ───────────────────────────── */

export default function RoomManager({
  rooms = [],
  floor,
  floors = [],
  status = {},
  resourceNoun = "resource",
  isSuperadmin = false,
  canDraw = false,
  onSaved,
  onConfigure,
  onError,
}) {
  const [busyRoom, setBusyRoom] = useState(null);
  const [scheduleRoom, setScheduleRoom] = useState(null);

  const toggleOpen = async (room, closed) => {
    setBusyRoom(room.id);
    try {
      await api.setRoomAvailability(room.id, closed ? "available" : "unavailable");
      onSaved();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusyRoom(null);
    }
  };

  return (
    <Panel title={floor ? `Rooms on ${floor.name}` : "Rooms"} icon={DoorOpen} className="mt-4">
      {!rooms.length ? (
        <EmptyState
          icon={DoorOpen}
          title="No rooms on this floor"
          body={
            isSuperadmin
              ? canDraw
                ? "Use Draw a room in step 3 above. Furniture inside the boundary becomes part of the room."
                : "Set up the building first; rooms are drawn on its floors."
              : "A superadmin draws rooms. Until then, everything here is booked one item at a time."
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => {
            const state = ROOM_STATE[status[room.resourceId]?.[0]?.status] || ROOM_STATE.available;
            const closed = state === ROOM_STATE.unavailable;
            const inUse = state === ROOM_STATE.reserved || state === ROOM_STATE.occupied;
            const levelNames = room.levels.map((level) => levelName(level, floors));
            return (
              <li key={room.id} className="flex flex-col gap-3 rounded-lg border border-line/10 bg-bg-panel/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{room.name}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {roomMode(room.bookingMode, resourceNoun).label}
                      {room.levels.length > 1 && ` · ${levelNames.join(" + ")}`}
                    </p>
                  </div>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    icon={closed ? LockOpen : Lock}
                    loading={busyRoom === room.id}
                    disabled={inUse}
                    title={inUse ? "It has a booking right now. Cancel it from the schedule first." : undefined}
                    onClick={() => toggleOpen(room, closed)}
                  >
                    {closed ? "Reopen" : "Close"}
                  </Button>
                  <Button size="sm" icon={CalendarClock} onClick={() => setScheduleRoom(room)}>
                    Schedule
                  </Button>
                  {isSuperadmin && (
                    <Button size="sm" icon={Settings2} onClick={() => onConfigure(room)}>
                      Settings
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ScheduleDialog
        room={scheduleRoom}
        onClose={() => setScheduleRoom(null)}
        onChanged={onSaved}
        onError={onError}
      />
    </Panel>
  );
}

/**
 * Everything booked in a room — the room itself and every unit inside it,
 * on every level — with a way to cancel, which is how staff clear a room
 * before closing or changing it.
 */
function ScheduleDialog({ room, onClose, onChanged, onError }) {
  const [history, setHistory] = useState(null);

  const load = () => {
    if (!room) return;
    api.adminResourceHistory(room.resourceId).then(setHistory).catch((err) => onError(err.message));
  };
  useEffect(() => {
    setHistory(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  const cancel = async (reservation) => {
    try {
      await api.adminCancelReservation(reservation.id, "Room schedule updated by staff");
      load();
      onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  const entries = history ? [...(history.schedule || []), ...(history.history || [])] : [];
  return (
    <Modal
      open={Boolean(room)}
      onClose={onClose}
      title={room?.name || "Room schedule"}
      subtitle="The whole room and everything inside it"
      icon={CalendarClock}
    >
      {!history ? (
        <p className="text-sm text-ink-muted">Loading the schedule…</p>
      ) : !entries.length ? (
        <EmptyState title="No reservations yet" body="Bookings of this room, and of anything inside it, appear here." />
      ) : (
        <ul className="space-y-3">
          {entries.map((reservation) => {
            const live = ["held", "active"].includes(reservation.status);
            return (
              <li key={reservation.id} className="rounded-md border border-line/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm">{new Date(reservation.startTime).toLocaleString()}</span>
                  <Badge tone={reservation.status === "active" ? "occupied" : reservation.status === "held" ? "reserved" : undefined}>
                    {reservation.status}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-ink-secondary">
                  {reservation.resourceLabel} · {reservation.member?.name || "Member"}
                </p>
                <p className="mt-1 text-xs text-ink-muted">Until {new Date(reservation.endTime).toLocaleString()}</p>
                {live && (
                  <Button size="sm" variant="danger" className="mt-2" onClick={() => cancel(reservation)}>
                    Cancel reservation
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/* ───────────────────────────── the room dialog ───────────────────────────── */

const MODE_ICON = { individual: Grid2x2, whole: DoorOpen, either: LayoutGrid };

/**
 * Creating a room, straight after its boundary is drawn — or configuring
 * one later. The last step of the setup sequence: a name, and what members
 * book here, said in plain words rather than as a mode.
 *
 * `draft` = { id?, name, bookingMode, buildingId, levels, resourceId? }.
 * `onDraw(draft, floorId)` hands back to the map to draw a level (on
 * another floor, or again on this one) and reopens the dialog after.
 *
 * `wholeRoomAllowed` is the plan's wholeRoomBooking feature. Without it the
 * two whole-room choices are shown but not offered, with the reason — the
 * server would refuse them (PLAN_FEATURE). A room already booked whole
 * keeps its choice: a downgrade never takes away what exists.
 */
export function RoomDialog({
  draft, floors = [], resourceNoun = "resource", wholeRoomAllowed = true, onClose, onSaved, onDraw,
}) {
  const [name, setName] = useState(draft?.name || "");
  const [mode, setMode] = useState(draft?.bookingMode || "individual");
  const [levels, setLevels] = useState(draft?.levels || []);
  // Offer a floor the room does not reach yet, since adding a level is the usual reason to draw again.
  const [drawOn, setDrawOn] = useState(() => {
    const unused = floors.find((floor) => !draft?.levels?.some((level) => level.floorId === floor.id));
    return unused?.id || floors[0]?.id || "";
  });
  const [nameError, setNameError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [booked, setBooked] = useState(false);

  const editing = Boolean(draft?.id);

  // A room with bookings can't be redrawn or switched mode; say so up front.
  useEffect(() => {
    if (!editing) return;
    api
      .adminResourceHistory(draft.resourceId)
      .then((history) => setBooked(Boolean(history?.schedule?.length)))
      .catch(() => {});
  }, [editing, draft?.resourceId]);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setNameError("Give this room a name.");
      return;
    }
    setBusy(true);
    try {
      const payload = { name, bookingMode: mode, buildingId: draft.buildingId, levels };
      if (editing) await api.updateRoom(draft.id, payload);
      else await api.createRoom(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteRoom(draft.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const floorName = (floorId) => floors.find((floor) => floor.id === floorId)?.name || "Floor";
  const first = levels[0];

  return (
    <Modal
      open={Boolean(draft)}
      onClose={busy ? undefined : onClose}
      title={editing ? "Room settings" : "Name the room, then choose how it's booked"}
      subtitle={
        editing
          ? `${draft.name} · ${levels.length} ${plural("floor", levels.length)}`
          : first && `${first.bounds.w} × ${first.bounds.h} cells on ${floorName(first.floorId)}`
      }
      icon={DoorOpen}
      width="max-w-xl"
    >
      <form onSubmit={save} className="space-y-6" noValidate>
        <Field
          label="Room name"
          data-autofocus
          value={name}
          maxLength={120}
          placeholder="Meeting room, reading room, studio…"
          error={nameError}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />

        <fieldset>
          <legend className="text-sm font-medium text-ink-secondary">What can members book here?</legend>
          <div className="mt-2 grid gap-2">
            {ROOM_MODE_ORDER.map((value) => {
              const words = roomMode(value, resourceNoun);
              const Icon = MODE_ICON[value];
              const chosen = mode === value;
              const withheld = !wholeRoomAllowed && value !== "individual" && value !== draft?.bookingMode;
              return (
                <label
                  key={value}
                  className={`flex items-start gap-3 rounded-lg border p-3 transition-colors duration-fast ${
                    chosen ? "" : "border-line/10"
                  } ${withheld ? "cursor-not-allowed opacity-50" : `cursor-pointer ${chosen ? "" : "hover:border-line/25"}`}`}
                  style={chosen ? { borderColor: "rgb(var(--c-accent) / 0.6)", background: "rgb(var(--c-accent) / 0.08)" } : undefined}
                >
                  <input
                    type="radio"
                    name="booking-mode"
                    value={value}
                    checked={chosen}
                    disabled={withheld}
                    onChange={() => setMode(value)}
                    className="sr-only"
                  />
                  <Icon
                    size={18}
                    className="mt-0.5 shrink-0"
                    style={{ color: chosen ? "var(--color-accent)" : "var(--color-ink-muted)" }}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{words.label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-secondary">{words.admin}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {!wholeRoomAllowed && (
            <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
              Booking whole rooms isn't included in your plan, so new rooms are booked one {resourceNoun} at a time;
              a room set up before keeps its choice. Ask SILLA to add it to offer the whole-room choices.
            </p>
          )}
        </fieldset>

        <section aria-labelledby="room-levels-title">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="room-levels-title" className="text-sm font-medium text-ink-secondary">
              Where it is
            </h3>
            <span className="text-xs text-ink-muted">
              {levels.length} {plural("floor", levels.length)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            A room can reach several floors of its building — a hall and its balcony, say. Every level shares one
            booking.
          </p>
          <ul className="mt-3 space-y-2">
            {levels.map((level) => (
              <li key={level.floorId} className="rounded-md border border-line/10 bg-bg-panel/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{floorName(level.floorId)}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-muted">
                    {level.bounds.w} × {level.bounds.h} cells
                    {levels.length > 1 && (
                      <button
                        type="button"
                        className="grid h-7 w-7 place-items-center rounded-md text-ink-muted transition-colors
                                   hover:bg-line/10 hover:text-state-unavailable"
                        aria-label={`Remove the level on ${floorName(level.floorId)}`}
                        onClick={() => setLevels((all) => all.filter((other) => other.floorId !== level.floorId))}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </span>
                </div>
                {levels.length > 1 && (
                  <Field
                    label="Name for this level"
                    className="mt-2"
                    maxLength={80}
                    placeholder="Optional, e.g. Balcony"
                    value={level.name || ""}
                    onChange={(e) =>
                      setLevels((all) => all.map((other) => (other.floorId === level.floorId ? { ...other, name: e.target.value } : other)))
                    }
                  />
                )}
              </li>
            ))}
          </ul>
          {floors.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Select label="Draw a level on" value={drawOn} onChange={(e) => setDrawOn(e.target.value)} className="min-w-0 flex-1">
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                    {levels.some((level) => level.floorId === floor.id) ? " (redraw)" : ""}
                  </option>
                ))}
              </Select>
              <Button
                icon={SquareDashedMousePointer}
                disabled={busy || !drawOn}
                onClick={() => {
                  onDraw({ ...draft, name, bookingMode: mode, levels }, drawOn);
                  onClose();
                }}
              >
                Draw it
              </Button>
            </div>
          )}
        </section>

        {booked && (
          <Notice>This room has bookings. Cancel them from its schedule before changing where it is or how it's booked.</Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}

        {confirmRemove ? (
          <div className="rounded-md border border-state-unavailable/30 p-3">
            <p className="text-sm">Remove this room? Its furniture stays on the floor, and its booking history is kept.</p>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => setConfirmRemove(false)}>Keep it</Button>
              <Button variant="danger" loading={busy} onClick={remove}>
                Remove room
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {editing ? (
              <Button icon={Trash2} variant="ghost" onClick={() => setConfirmRemove(true)}>
                Remove room
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {editing ? "Save changes" : "Create room"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

/* ─────────────────────────── the building dialog ─────────────────────────── */

/**
 * Three jobs, one form:
 *
 *   set up    floors that predate buildings are named into one (adoption);
 *             their ids, furniture and bookings stay exactly as they are
 *   add       a new, empty building at the same site
 *   rename    an existing building, which can be removed while it is empty
 */
export function BuildingDialog({ building, siteId, onClose, onSaved }) {
  const settingUp = Boolean(building?.unassigned);
  const renaming = Boolean(building) && !settingUp;

  const [name, setName] = useState(renaming ? building.name : "");
  const [adopt, setAdopt] = useState(settingUp);
  const [nameError, setNameError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setNameError("Give this building a name.");
      return;
    }
    setBusy(true);
    try {
      const result = renaming
        ? await api.updateBuilding(building.id, { name })
        : await api.createBuilding({ name, siteId, adoptExisting: adopt });
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteBuilding(building.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const floorNames = settingUp ? building.floors.map((floor) => floor.name) : [];
  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={settingUp ? "Set up the building" : renaming ? "Rename building" : "Add a building"}
      subtitle={
        settingUp
          ? "Name the building your existing floors are in."
          : renaming
            ? undefined
            : "Its floors and rooms are added in the next steps."
      }
      icon={Building2}
    >
      <form className="space-y-4" onSubmit={save} noValidate>
        <Field
          label="Building name"
          data-autofocus
          maxLength={120}
          value={name}
          placeholder={settingUp ? building.name : "Main building"}
          error={nameError}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
        />

        {settingUp && (
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line/10 p-3 text-sm">
            <input type="checkbox" className="mt-1" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
            <span>
              Move {floorNames.length === 1 ? `"${floorNames[0]}"` : `the ${floorNames.length} existing floors`} into this building
              <span className="mt-1 block text-xs text-ink-muted">
                Floor names, furniture, zones and every booking are kept exactly as they are.
              </span>
            </span>
          </label>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        {confirmRemove ? (
          <div className="rounded-md border border-state-unavailable/30 p-3">
            <p className="text-sm">Remove this empty building?</p>
            <div className="mt-3 flex gap-2">
              <Button disabled={busy} onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
              <Button variant="danger" loading={busy} onClick={remove}>
                Remove building
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-between gap-2">
            {renaming && !building.floors.length ? (
              <Button icon={Trash2} variant="ghost" onClick={() => setConfirmRemove(true)}>
                Remove building
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {settingUp ? "Set up building" : renaming ? "Save" : "Add building"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
