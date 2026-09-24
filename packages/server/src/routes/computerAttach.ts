/**
 * Computer attach — task #30 PR-B 3/n (RFC v0.8 contract v3 §6/§9).
 *
 * `POST /api/computer/attach` — USER-authenticated (the caller has a
 * `raft-computer login` user session). Establishes this machine's
 * `sk_computer_*` Computer attachment for one server.
 *
 * OUT of the `routeAuthPolicy` registry BY DESIGN (contract v3 §3):
 * `/api/*` user-authed pre-attach surface, not a claimed `/internal/*`
 * principal surface. Documented intentional — mirrors `/api/agent/login`
 * and the device-code grant. Gated by the same Computer-login feature
 * flag (`SLOCK_DEVICE_LOGIN_ENABLED`) so login + attach ship together.
 *
 * This issues the Computer principal itself; it does NOT mint
 * `sk_agent_*` (that is the sk_computer-gated /internal surface). Stable,
 * zero-enumeration failures.
 */
import { Router, type Router as RouterType } from "express";
import { requireAuth } from "../middleware/auth.js";
import { attachComputer } from "../services/computerCredentialService.js";
import { enqueueComputerMobileAppEmailJourney } from "../services/computerMobileAppEmailJourneyService.js";
import { isDeviceAuthSurfaceEnabled } from "../services/deviceAuthService.js";

export const computerAttachRouter: RouterType = Router();

computerAttachRouter.post("/attach", requireAuth, async (req, res) => {
  // Defense-in-depth: app.ts mounts this behind the same gate, re-check
  // so a misconfigured mount cannot expose the surface.
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({ error: "Computer attach is not enabled", code: "computer_attach_disabled" });
    return;
  }
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const body = (req.body ?? {}) as { serverSlug?: unknown; name?: unknown };
    if (typeof body.serverSlug !== "string" || body.serverSlug.length === 0) {
      res.status(400).json({ error: "serverSlug is required", code: "server_slug_required" });
      return;
    }
    let name = "raft-computer";
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        res.status(400).json({ error: "name must be a non-empty string up to 200 chars", code: "name_invalid" });
        return;
      }
      name = body.name;
    }
    const result = await attachComputer({ userId, serverSlug: body.serverSlug, name });
    if (!result.ok) {
      if (result.error === "computer_name_collision") {
        res.status(409).json({
          error: "A Computer with this display name already exists on this server",
          code: "COMPUTER_NAME_COLLISION",
        });
        return;
      }
      // Uniform 403. `not_authorized` collapses non-member / missing / deleted
      // server (no existence enumeration). `requires_admin` is the distinct
      // member-without-manageMachines case — safe to disclose since the caller
      // already knows they are a member; lets the CLI say "ask an admin".
      const error =
        result.error === "requires_admin"
          ? "Attaching a Computer requires the admin or owner role on this server"
          : "Not authorized to attach a Computer to this server";
      res.status(403).json({ error, code: result.error });
      return;
    }
    try {
      await enqueueComputerMobileAppEmailJourney({
        userId,
        computerId: result.serverMachineId,
      });
    } catch {
      // Computer attachment is the primary user action. A lifecycle-email
      // control-plane failure must not turn a successful credential issue into
      // a failed/ambiguous attach response.
      console.warn("api.computer.attach mobile lifecycle email enqueue failed");
    }
    res.status(201).json({
      apiKey: result.apiKey, // raw sk_computer_* — returned exactly once
      serverMachineId: result.serverMachineId,
      // `machineId` is the linked `machines.id` (vs `serverMachineId` =
      // `computers.id`). The dashboard's `/s/<slug>/computer/:machineId`
      // route resolves against `machines.id`; the lib threads this through
      // to `ServerStatusRow.machineId` so the menu-bar "Open This Computer
      // in Browser" link points at a real row
      // (#wg-raft-computer:f2a02081 task #99 bug 2 RCA).
      machineId: result.machineId,
      serverId: result.serverId,
      serverSlug: result.serverSlug,
      resumed: result.resumed,
    });
  } catch (err) {
    console.error("api.computer.attach error:", err);
    res.status(500).json({ error: "Failed to attach Computer" });
  }
});
