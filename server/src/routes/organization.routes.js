import { Router } from "express";
import Organization from "../models/Organization.js";

const router = Router();

/**
 * GET /api/organizations/:id/config
 *
 * This is the single most important read in a white-label system
 * (spec §16): the client boots by fetching this record and rendering
 * itself from it — branding, terminology, check-in method, policy
 * numbers — rather than any of that being hardcoded in the frontend.
 */
router.get("/:id/config", async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id).select(
      "name branding terminology identity policy privacy status"
    );
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json(org);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organizations/:id/terms
 *
 * AUTH-3 — the terms text a first-time user must accept (spec §16 lists
 * terms-of-service text as a per-organization config point). Served
 * separately from /config so the boot payload every screen fetches
 * doesn't carry a wall of legal text.
 */
router.get("/:id/terms", async (req, res, next) => {
  try {
    const org = await Organization.findById(req.params.id).select("name termsOfServiceText");
    if (!org) return res.status(404).json({ error: "Organization not found" });
    res.json({
      organizationName: org.name,
      termsOfServiceText: org.termsOfServiceText || "",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
