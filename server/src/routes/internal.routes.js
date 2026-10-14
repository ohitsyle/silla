/**
 * The control-plane API: what SILLA's commerce service (vendor/) may do
 * to this deployment. Every route here is signed with
 * CONTROL_PLANE_SECRET (lib/controlPlane.js) and never reachable with a
 * user's token. See docs/control-plane.md for the contract.
 */
import { Router } from "express";
import { requireControlPlane } from "../lib/controlPlane.js";

const router = Router();
router.use(requireControlPlane);

/** Lets the control plane check the channel (secret, clock, routing) before relying on it. */
router.get("/ping", (_req, res) => res.json({ ok: true, service: "silla-server" }));

export default router;
