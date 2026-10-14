import { Building2, ChevronDown, ChevronRight, DoorOpen, Layers } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { ROOM_MODES } from "../lib/rooms.js";

export default function SpaceNavigator({ buildings = [], floorId, roomId, onFloor, onRoom }) {
  const current = buildings.find((b) => b.floors.some((f) => f.id === floorId));
  const [expanded, setExpanded] = useState(new Set());
  useEffect(() => { if (current) setExpanded((old) => new Set([...old, current.id])); }, [current?.id]);
  return <aside className="hidden w-60 shrink-0 flex-col border-r border-line/10 bg-bg-card/40 lg:flex" aria-label="Buildings, floors and rooms">
    <div className="border-b border-line/10 px-4 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-ink-muted">Explore the space</p>
      <p className="mt-1 text-xs text-ink-secondary">Building · floor · room</p>
    </div>
    <div className="flex-1 overflow-y-auto p-2">
      {buildings.map((b) => <div key={b.id} className="mb-3">
        <button aria-expanded={expanded.has(b.id)} onClick={() => setExpanded((old) => { const next = new Set(old); if (next.has(b.id)) next.delete(b.id); else next.add(b.id); return next; })} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold hover:bg-line/5"><Building2 size={16} className="text-accent" /><span className="min-w-0 flex-1 truncate">{b.name}</span>{expanded.has(b.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        {expanded.has(b.id) && !b.floors.length && <p className="px-3 py-2 text-xs text-ink-muted">No floors yet</p>}
        {expanded.has(b.id) && b.floors.map((floor) => <div key={floor.id}>
          <button onClick={() => onFloor(floor.id)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${floor.id === floorId && !roomId ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-line/5"}`} aria-current={floor.id === floorId && !roomId ? "page" : undefined}>
            {floor.id === floorId ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Layers size={14} /><span className="truncate">{floor.name}</span>
          </button>
          {floor.id === floorId && floor.rooms.map((room) => <button key={room.id} onClick={() => onRoom(room, floor.id)} className={`relative ml-5 flex w-[calc(100%-1.25rem)] items-start gap-2 rounded-md px-3 py-2 text-left transition-colors ${roomId === room.id && floor.id === floorId ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-line/5"}`} aria-current={roomId === room.id && floor.id === floorId ? "page" : undefined}>
            {roomId === room.id && floor.id === floorId && <motion.span layoutId="room-nav-marker" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
            <DoorOpen size={14} className="mt-0.5 shrink-0" /><span className="min-w-0"><span className="block truncate text-sm">{room.name}</span><span className="block text-[10px] text-ink-muted">{ROOM_MODES[room.bookingMode]?.label}{room.levels.length > 1 ? ` · ${room.levels.length} levels` : ""}</span></span>
          </button>)}
        </div>)}
      </div>)}
    </div>
    <div className="border-t border-line/10 px-4 py-3 text-xs text-ink-muted">{current?.siteName || "Choose a building"}</div>
  </aside>;
}
