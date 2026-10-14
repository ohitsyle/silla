export const ROOM_MODES = {
  individual: { label: "Individual resources", description: "Book a seat, desk, or equipment inside." },
  whole: { label: "Whole room", description: "One reservation includes every level and its contents." },
  either: { label: "Either", description: "Book the room or individual resources. Overlapping bookings are blocked." },
};
export function roomUnit(room, status) {
  return { resourceId: room.resourceId, unitIndex: 0, unitLabel: "room", kind: "room", levels: room.levels, statusLabel: status[room.resourceId]?.[0]?.status || "available", roomId: room.id, type: { label: room.name, key: "__room" }, status: status[room.resourceId]?.[0] || { status: "available" } };
}
export function effectiveStatus(resource, unit, rooms, status) {
  const room = rooms.find((r) => r.id === resource.roomId);
  if (!room) return unit;
  const parent = status[room.resourceId]?.[0];
  if (parent?.status === "unavailable") return { ...unit, status: "unavailable", roomBlocked: true };
  if (["reserved", "occupied"].includes(parent?.status)) return { ...unit, status: parent.status, roomBlocked: true };
  if (room.bookingMode === "whole") return { ...unit, status: "unavailable", roomBlocked: true };
  return unit;
}
