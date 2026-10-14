/**
 * Writes the activity log (models/AuditEvent.js).
 *
 *   await audit(req, "order.status", { type: "order", id, label }, "Moved Harborview to provisioning", { from, to });
 *
 * Awaited, not fire-and-forget: if the trail cannot be written, the
 * caller should find out — the point of an audit log is that an action
 * without an entry did not quietly happen. Call it AFTER the change has
 * succeeded, so the log never records something that was then refused.
 */
import AuditEvent from "../models/AuditEvent.js";
import { staffRoleOf } from "../middleware/staff.js";

export async function audit(req, action, target, summary, meta = {}) {
  const actor = req?.account || null;
  return AuditEvent.create({
    actor: actor?._id || null,
    actorEmail: actor?.email || "system",
    actorRole: staffRoleOf(actor) || actor?.role || "system",
    action,
    target: { type: target?.type || "", id: String(target?.id || ""), label: target?.label || "" },
    summary,
    meta,
  });
}

/** For jobs with no request — the billing scheduler, for one. */
export const auditSystem = (action, target, summary, meta) => audit(null, action, target, summary, meta);
