import { Router } from "express";
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import { publicEntitlements } from "../services/entitlements.js";

const router = Router();

/**
 * GET /api/organizations/:id/config
 *
 * This is the single most important read in a white-label system
 * (spec §16): the client boots by fetching this record and rendering
 * itself from it — branding, terminology, check-in method, policy
 * numbers — rather than any of that being hardcoded in the frontend.
 */
const CONFIG_FIELDS = "name slug branding terminology identity policy privacy status entitlements";

/**
 * What a client needs to render an organization. `entitlements` is the
 * PUBLIC reading of the plan snapshot (services/entitlements.js) — enough
 * for a screen to explain a limit before someone hits it.
 */
function configOf(org) {
  const { entitlements, ...rest } = org;
  return { ...rest, entitlements: publicEntitlements(org) };
}

/**
 * How the product finds an organization from its address
 * (<client>/<slug>/…). Registered BEFORE "/:id/config" so "by-slug" is
 * never mistaken for an id.
 */
router.get("/by-slug/:slug/config", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    const org = await Organization.findOne({ slug }).select(CONFIG_FIELDS).lean();
    if (!org) return res.status(404).json({ error: "We couldn't find an organization at that address." });
    res.json(configOf(org));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/config", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Organization not found" });
    const org = await Organization.findById(req.params.id).select(CONFIG_FIELDS).lean();
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json(configOf(org));
  } catch (err) {
    next(err);
  }
});

/**
 * The line every seeded profile used to end its terms with — a note to the
 * superadmin about where the text is edited, which every member then read
 * at the bottom of what they were asked to accept. New profiles no longer
 * carry it; organizations provisioned before still hold it in their stored
 * text. It is left out of what members are SHOWN rather than migrated, so
 * no read rewrites live data and nothing an administrator wrote is touched:
 * only this exact sentence, on a line of its own, is dropped.
 */
export const LEGACY_TERMS_NOTE =
  "This text is configured per organization and can be edited by a superadmin in Settings.";

export function termsForMembers(text) {
  const lines = String(text || "").split("\n");
  if (!lines.some((line) => line.trim() === LEGACY_TERMS_NOTE)) return String(text || "");
  return lines.filter((line) => line.trim() !== LEGACY_TERMS_NOTE).join("\n").trimEnd();
}

router.get("/:id/terms", async (req, res, next) => {
  try {
    // A malformed id is "not found", not a cast error surfacing as a 500.
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Organization not found" });
    const org = await Organization.findById(req.params.id).select("name termsOfServiceText");
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json({
      organizationName: org.name,
      termsOfServiceText: termsForMembers(org.termsOfServiceText),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
