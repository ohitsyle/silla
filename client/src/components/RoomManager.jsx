import { useEffect, useState } from "react";
import { Building2, DoorOpen, Pencil, Plus, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { api } from "../lib/api.js";
import { ROOM_MODE_ORDER, roomMode } from "../lib/rooms.js";
import { Badge, Button, EmptyState, Field, Modal, Notice, Panel, Segmented, Select } from "./ui/index.jsx";

export function RoomDialog({ draft, floors, onClose, onSaved, onDraw }) {
  const [name, setName] = useState(draft?.name || "");
  const [mode, setMode] = useState(draft?.bookingMode || "individual");
  const [levels, setLevels] = useState(draft?.levels || []);
  const [drawingFloor, setDrawingFloor] = useState(floors[0]?.id || "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(null);
  useEffect(() => { if (draft?.id) api.adminResourceHistory(draft.resourceId).then(setHistory).catch(() => {}); }, [draft?.id]);
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const payload = { name, bookingMode: mode, buildingId: draft.buildingId, levels };
      if (draft.id) await api.updateRoom(draft.id, payload); else await api.createRoom(payload);
      onSaved(); onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <Modal open={Boolean(draft)} onClose={busy ? undefined : onClose} title={draft?.id ? "Configure room" : "Create a room"} subtitle="A clear boundary with one set of booking rules." icon={DoorOpen}>
    <form onSubmit={save} className="space-y-5">
      <Field label="Room name" required data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Meeting room, reading room, equipment lab…" />
      <div><p className="mb-2 text-sm font-medium text-ink-secondary">What can be reserved?</p>
        <Segmented value={mode} onChange={setMode} options={ROOM_MODE_ORDER.map((value) => ({ value, label: roomMode(value).label }))} />
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{roomMode(mode).admin}</p>
      </div>
      <div><div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium text-ink-secondary">Room levels</p><Badge>{levels.length} level{levels.length === 1 ? "" : "s"}</Badge></div>
        <p className="mb-3 text-xs text-ink-muted">All levels belong to the same room. Booking it as a whole includes every level.</p>
        <div className="space-y-2">{levels.map((l) => <div key={l.floorId} className="rounded-md border border-line/10 bg-bg-panel/40 p-3">
          <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{floors.find((f) => f.id === l.floorId)?.name || "Floor"}</span>
            {levels.length > 1 && <button type="button" className="text-ink-muted hover:text-state-unavailable" aria-label="Remove this room level" onClick={() => setLevels((all) => all.filter((v) => v.floorId !== l.floorId))}><Trash2 size={14} /></button>}
          </div>
          <Field label="Level name" maxLength={80} placeholder="Optional, e.g. Balcony" value={l.name || ""} onChange={(e) => setLevels((all) => all.map((v) => v.floorId === l.floorId ? { ...v, name: e.target.value } : v))} />
          <p className="mt-2 text-[11px] text-ink-muted">{l.bounds.w} × {l.bounds.h} cells · corner {l.bounds.col}, {l.bounds.row}</p>
        </div>)}</div>
        <div className="mt-3 flex items-end gap-2"><Select label="Draw on floor" value={drawingFloor} onChange={(e) => setDrawingFloor(e.target.value)} className="min-w-0 flex-1">{floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
          <Button type="button" icon={SquareDashedMousePointer} disabled={!drawingFloor || busy} onClick={() => { onDraw({ ...draft, name, bookingMode: mode, levels }, drawingFloor); onClose(); }}>Draw level</Button>
        </div>
      </div>
      {history?.schedule?.length > 0 && <Notice>This room has reservations. Cancel them before changing its boundaries or booking mode.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {confirmDelete ? <div className="rounded-md border border-state-unavailable/30 p-3"><p className="text-sm">Remove this room? The furniture stays on the floor, and existing booking history is kept.</p><div className="mt-3 flex gap-2"><Button type="button" onClick={() => setConfirmDelete(false)}>Keep room</Button><Button type="button" variant="danger" disabled={busy} onClick={async () => { setBusy(true); try { await api.deleteRoom(draft.id); onSaved(); onClose(); } catch (e) { setError(e.message); setBusy(false); } }}>Remove room</Button></div></div> : <div className="flex items-center justify-between gap-2">{draft?.id ? <Button type="button" icon={Trash2} onClick={() => setConfirmDelete(true)}>Remove room</Button> : <span />}
        <div className="flex gap-2"><Button type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" disabled={!name.trim() || !levels.length || busy}>{busy ? "Saving…" : "Save room"}</Button></div>
      </div>}
    </form>
  </Modal>;
}

export default function RoomManager({ rooms = [], floor, building, floors, status, isSuperadmin, onSaved, onDraw, onError }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [historyRoom, setHistoryRoom] = useState(null);
  const [history, setHistory] = useState(null);
  useEffect(() => { setHistory(null); if (historyRoom) api.adminResourceHistory(historyRoom.resourceId).then(setHistory).catch((e) => onError(e.message)); }, [historyRoom?.id]);
  const roomFloors = building?.floors || floors;
  return <Panel title="Rooms" icon={DoorOpen} className="mt-4">
    {!rooms.length ? <EmptyState title="Define the rooms on this floor" body={building && !building.unassigned ? "Choose the Room tool, then drag a boundary around a space. Existing pieces inside become part of the room." : "Set up a building first, then draw rooms on its floors."} /> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rooms.map((room) => {
      const state = status[room.resourceId]?.[0]?.status || "available";
      return <div key={room.id} className="rounded-lg border border-line/10 bg-bg-panel/40 p-4">
        <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{room.name}</p><p className="mt-1 text-xs text-ink-muted">{roomMode(room.bookingMode).label} · {room.levels.length} level{room.levels.length > 1 ? "s" : ""}</p></div><Badge tone={state}>{state}</Badge></div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || ["reserved", "occupied"].includes(state)} onClick={async () => { setBusy(true); try { await api.setRoomAvailability(room.id, state === "unavailable" ? "available" : "unavailable"); onSaved(); } catch (e) { onError(e.message); } finally { setBusy(false); } }}>{state === "unavailable" ? "Reopen room" : "Close room"}</Button>
          <Button size="sm" onClick={() => setHistoryRoom(room)}>Schedule</Button>
          {isSuperadmin && <Button size="sm" icon={Pencil} onClick={() => setEditing(room)}>Configure</Button>}
        </div>
      </div>;
    })}</div>}
    {editing && <RoomDialog key={editing.id} draft={editing} floors={roomFloors} onClose={() => setEditing(null)} onSaved={onSaved} onDraw={onDraw} />}
    <Modal open={Boolean(historyRoom)} onClose={() => setHistoryRoom(null)} title={historyRoom?.name || "Room schedule"} subtitle="Whole-room and individual reservations" icon={DoorOpen}>
      {!history ? <p className="text-sm text-ink-muted">Loading schedule…</p> : <div className="space-y-3">{[...(history.schedule || []), ...(history.history || [])].map((r) => <div key={r.id} className="rounded-md border border-line/10 p-3"><div className="flex items-center justify-between"><span className="text-sm">{new Date(r.startTime).toLocaleString()}</span><Badge tone={r.status === "active" ? "occupied" : r.status === "held" ? "reserved" : undefined}>{r.status}</Badge></div><p className="mt-1 text-sm text-ink-secondary">{r.resourceLabel} · {r.member?.name || "Member"}</p><p className="mt-1 text-xs text-ink-muted">Until {new Date(r.endTime).toLocaleString()}</p>{["held", "active"].includes(r.status) && <Button size="sm" className="mt-2" onClick={async () => { try { await api.adminCancelReservation(r.id, "Room schedule updated by staff"); setHistory(await api.adminResourceHistory(historyRoom.resourceId)); onSaved(); } catch (e) { onError(e.message); } }}>Cancel reservation</Button>}</div>)}{!history.schedule?.length && !history.history?.length && <EmptyState title="No reservations yet" body="Reservations for this room and the resources inside will appear here." />}</div>}
    </Modal>
  </Panel>;
}

export function BuildingDialog({ building, siteId, onClose, onSaved }) {
  const [name, setName] = useState(building && !building.unassigned ? building.name : "");
  const [adopt, setAdopt] = useState(Boolean(building?.unassigned));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <Modal open onClose={busy ? undefined : onClose} title={building && !building.unassigned ? "Rename building" : "Create a building"} subtitle="Keep its floors and rooms together." icon={Building2}>
    <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { const result = building && !building.unassigned ? await api.updateBuilding(building.id, { name }) : await api.createBuilding({ name, siteId, adoptExisting: adopt }); onSaved(result); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>
      <Field label="Building name" required data-autofocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Building 1" />
      {building?.unassigned && <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line/10 p-3 text-sm"><input type="checkbox" className="mt-1" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} /><span>Move the existing floors into this building.<span className="mt-1 block text-xs text-ink-muted">Floor names, room layouts, furniture and reservations are preserved.</span></span></label>}
      {error && <Notice tone="error">{error}</Notice>}
      {confirmDelete ? <div className="rounded-md border border-state-unavailable/30 p-3"><p className="text-sm">Remove this empty building?</p><div className="mt-3 flex gap-2"><Button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep building</Button><Button type="button" variant="danger" disabled={busy} onClick={async () => { setBusy(true); try { await api.deleteBuilding(building.id); onSaved(); onClose(); } catch (e) { setError(e.message); setBusy(false); } }}>Remove building</Button></div></div> : <div className="flex justify-between gap-2">{building && !building.unassigned && !building.floors.length ? <Button type="button" icon={Trash2} onClick={() => setConfirmDelete(true)}>Remove empty building</Button> : <span />}<div className="flex gap-2"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!name.trim() || busy}>{busy ? "Saving…" : "Save building"}</Button></div></div>}
    </form>
  </Modal>;
}
