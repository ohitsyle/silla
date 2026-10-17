/**
 * The activity log (models/AuditEvent.js), read-only. Mounted in app.js
 * at /api/vendor/audit. See docs/control-plane.md §5.
 *
 * There is deliberately no write, update or delete here: entries are
 * made by lib/audit.js as a side effect of the action they record, and a
 * trail its subjects could edit would not be a trail.
 */
import { Router } from "express";
import mongoose from "mongoose";
import AuditEvent from "../models/AuditEvent.js";
import { requireAccount } from "../middleware/auth.js";
import { requirePermission } from "../middleware/staff.js";

const router = Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAccount, requirePermission("audit.read"));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const eventShape = (e) => ({
  id: e._id.toString(),
  at: e.at,
  actor: e.actor ? e.actor.toString() : null,
  actorEmail: e.actorEmail,
  actorRole: e.actorRole,
  action: e.action,
  target: e.target,
  summary: e.summary,
  meta: e.meta || {},
});

/**
 * GET /api/vendor/audit
 *   ?action=order.status     one verb, or a family: "staff" matches staff.*
 *   ?actor=<accountId>       one person's actions
 *   ?targetType=order&targetId=<id>
 *   ?q=harborview            words in the summary or the target's label
 *   ?before=<cursor>         the next page, as returned in `next`
 *   ?limit=50                up to 200
 *
 * Paged by a cursor (time, then id) rather than by offset, because new
 * entries arrive at the top while someone reads: an offset would shift
 * under them and repeat or skip rows. The id breaks ties between two
 * entries written in the same millisecond, which a time alone would split
 * across pages and lose one of.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { action, actor, targetType, targetId, q, before } = req.query;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const and = [];
    if (action) {
      const verb = String(action);
      and.push({ action: verb.includes(".") ? verb : { $regex: `^${escapeRegex(verb)}(\\.|$)` } });
    }
    if (actor) {
      if (!mongoose.isValidObjectId(actor)) return res.status(400).json({ error: "Invalid actor id" });
      and.push({ actor: new mongoose.Types.ObjectId(String(actor)) });
    }
    if (targetType) and.push({ "target.type": String(targetType) });
    if (targetId) and.push({ "target.id": String(targetId) });
    if (q && String(q).trim()) {
      const rx = { $regex: escapeRegex(String(q).trim().slice(0, 80)), $options: "i" };
      and.push({ $or: [{ summary: rx }, { "target.label": rx }, { actorEmail: rx }] });
    }
    if (before) {
      const [iso, id] = String(before).split("|");
      const at = new Date(iso);
      if (Number.isNaN(at.getTime()) || (id && !mongoose.isValidObjectId(id))) {
        return res.status(400).json({ error: "Invalid page cursor" });
      }
      and.push(
        id
          ? { $or: [{ at: { $lt: at } }, { at, _id: { $lt: new mongoose.Types.ObjectId(id) } }] }
          : { at: { $lt: at } }
      );
    }

    // One more than asked for, to know whether there is a next page
    // without a second count query.
    const rows = await AuditEvent.find(and.length ? { $and: and } : {})
      .sort({ at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    res.json({
      events: page.map(eventShape),
      next: rows.length > limit ? `${new Date(last.at).toISOString()}|${last._id}` : null,
    });
  })
);

/** The verbs that exist so far, for the log's filter. Families first, then each verb. */
router.get(
  "/actions",
  asyncHandler(async (_req, res) => {
    const actions = (await AuditEvent.distinct("action")).sort();
    res.json({ actions });
  })
);

export default router;
