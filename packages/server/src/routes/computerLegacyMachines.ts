/**
 * Computer legacy-machines roster — RFC v9.9 §X.2.
 *
 * `GET /api/computer/legacy-machines?serverSlug=<slug>` — USER-authenticated.
 * The caller has a `raft-computer login` user session and is asking the
 * server: "which legacy `sk_machine_*` daemons on this user's account belong
 * to the target server (and have a fingerprint we can intersect with my
 * local owner.json)?".
 *
 * OUT of the `routeAuthPolicy` registry BY DESIGN — same rationale as
 * `/api/computer/attach` and `/api/computer/adopt-legacy`: `/api/*`
 * user-authed pre-attach surface, not an `/internal/*` principal surface.
 * Gated by the same `SLOCK_DEVICE_LOGIN_ENABLED` feature flag so it ships
 * together with login + attach + adopt.
 *
 * Outcomes:
 *   200 success                        → { entries: LegacyMachineRosterEntry[] }
 *   400 server_slug_required           → query missing/invalid
 *   401 auth_required                  → no JWT
 *   403 not_authorized                 → cloak (server missing, soft-deleted,
 *                                        non-member — anti-enumeration)
 *   404 computer_legacy_roster_disabled→ feature flag off
 *
 * 200 with `entries: []` is a valid response (no visible legacy daemons)
 * — distinguishable from 403 only because the cloak case never returns
 * `entries`. The CLI driver treats 200 + empty as "no candidates"
 * (RFC v9.9 §X.4 fresh-attach trigger #1: empty intersection).
 * Already-migrated rows are still returned so an interrupted migration can
 * resume the existing linked Computer through fingerprint adoption.
 */
import { Router, type Router as RouterType } from "express";
import { requireAuth } from "../middleware/auth.js";
import { listLegacyMachineRoster } from "../services/legacyMachineService.js";
import { isDeviceAuthSurfaceEnabled } from "../services/deviceAuthService.js";

export const computerLegacyMachinesRouter: RouterType = Router();

computerLegacyMachinesRouter.get("/legacy-machines", requireAuth, async (req, res) => {
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({
      error: "Computer legacy roster is not enabled",
      code: "computer_legacy_roster_disabled",
    });
    return;
  }
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const serverSlug = req.query.serverSlug;
    if (typeof serverSlug !== "string" || serverSlug.length === 0) {
      res.status(400).json({
        error: "serverSlug is required",
        code: "server_slug_required",
      });
      return;
    }

    const includeAll = req.query.includeAll === "1" || req.query.includeAll === "true";
    const result = await listLegacyMachineRoster({ userId, serverSlug, includeAll });
    if (!result.ok) {
      res.status(403).json({
        error: "Not authorized to list legacy machines for this server",
        code: result.code,
      });
      return;
    }
    res.status(200).json({ entries: result.entries });
  } catch (err) {
    console.error("api.computer.legacy-machines error:", err);
    res.status(500).json({ error: "Failed to list legacy machines" });
  }
});
