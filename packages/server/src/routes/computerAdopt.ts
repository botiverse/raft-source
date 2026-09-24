/**
 * Computer legacy adoption — task #39 PR-J1 (RFC v0.8 v8.2 §5.11 / §10.13).
 *
 * `POST /api/computer/adopt-legacy` — USER-authenticated. The caller proves
 * authority for a legacy daemon either by supplying its raw `sk_machine_*`
 * key (legacy/manual path), by selecting a user-scoped legacy roster entry
 * (`serverSlug` + `legacyMachineId` + `apiKeyFingerprint`), or by using
 * `manageMachines` to select a daemon row on the target Server
 * (`serverSlug` + `daemonId`) after `raft-computer login`. On success the
 * server exchanges it for a fresh `sk_computer_*` Computer attachment on the
 * same server. One-time per machine.
 *
 * OUT of the `routeAuthPolicy` registry BY DESIGN (same rationale as
 * `/api/computer/attach`): /api/* user-authed pre-attach, not an /internal/*
 * principal surface. Gated by `SLOCK_DEVICE_LOGIN_ENABLED` so it ships
 * together with login + attach.
 *
 * Outcomes (§10.13):
 *   201 success                          → { apiKey, computerId, machineId, serverId, resumed }
 *   401 legacy_key_invalid               → unknown / wrong-server / malformed key
 *   409 legacy_machine_key_migrated      → already migrated (canonical concurrent loser)
 *   403 not_authorized                   → user not a member of machine's server
 *   403 requires_admin                    → member lacks manageMachines (owner/admin)
 *   404 legacy_machine_not_found          → daemon-id row absent from target Server
 *   400 legacy_api_key_required          → request shape invalid
 *   404 computer_adopt_disabled          → feature flag off
 *   500 internal                         → unexpected
 *
 * Raw-key hygiene: the inbound legacy key is read once into the service
 * call and never logged, never written back, never echoed in any response.
 */
import { Router, type Router as RouterType } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  adoptLegacyMachine,
  adoptLegacyMachineByDaemonId,
  adoptLegacyMachineByFingerprint,
} from "../services/computerAdoptionService.js";
import { isDeviceAuthSurfaceEnabled } from "../services/deviceAuthService.js";

export const computerAdoptRouter: RouterType = Router();

computerAdoptRouter.post("/adopt-legacy", requireAuth, async (req, res) => {
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({
      error: "Computer legacy adoption is not enabled",
      code: "computer_adopt_disabled",
    });
    return;
  }
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const body = (req.body ?? {}) as {
      legacyApiKey?: unknown;
      serverSlug?: unknown;
      legacyMachineId?: unknown;
      daemonId?: unknown;
      apiKeyFingerprint?: unknown;
      name?: unknown;
    };
    const hasRawLegacyKey = typeof body.legacyApiKey === "string" && body.legacyApiKey.length > 0;
    const hasRosterIdentity =
      typeof body.serverSlug === "string" &&
      body.serverSlug.length > 0 &&
      typeof body.legacyMachineId === "string" &&
      body.legacyMachineId.length > 0 &&
      typeof body.apiKeyFingerprint === "string" &&
      body.apiKeyFingerprint.length > 0;
    const hasDaemonIdentity =
      typeof body.serverSlug === "string" &&
      body.serverSlug.length > 0 &&
      typeof body.daemonId === "string" &&
      body.daemonId.length > 0;
    if (!hasRawLegacyKey && !hasRosterIdentity && !hasDaemonIdentity) {
      res.status(400).json({
        error: "legacyApiKey, fingerprint roster identity, or daemonId identity is required",
        code: "legacy_api_key_required",
      });
      return;
    }
    let name: string | undefined;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        res.status(400).json({ error: "name must be a non-empty string up to 200 chars", code: "name_invalid" });
        return;
      }
      name = body.name;
    }

    const result = hasRosterIdentity
      ? await adoptLegacyMachineByFingerprint({
        userId,
        serverSlug: body.serverSlug as string,
        legacyMachineId: body.legacyMachineId as string,
        apiKeyFingerprint: body.apiKeyFingerprint as string,
        name,
      })
      : hasDaemonIdentity
        ? await adoptLegacyMachineByDaemonId({
          userId,
          serverSlug: body.serverSlug as string,
          daemonId: body.daemonId as string,
          name,
        })
      : await adoptLegacyMachine({
        userId,
        legacyApiKey: body.legacyApiKey as string,
        name,
      });

    if (!result.ok) {
      switch (result.code) {
        case "legacy_key_invalid":
          res.status(401).json({ error: "Invalid legacy machine key", code: "legacy_key_invalid" });
          return;
        case "legacy_machine_key_migrated":
          res.status(409).json({
            error: "This machine has already been migrated to a Computer attachment",
            code: "legacy_machine_key_migrated",
          });
          return;
        case "legacy_machine_not_found":
          res.status(404).json({
            error: "Legacy machine was not found on this server",
            code: "legacy_machine_not_found",
          });
          return;
        case "not_authorized":
          res.status(403).json({
            error: "Not authorized to adopt this machine",
            code: "not_authorized",
          });
          return;
        case "requires_admin":
          res.status(403).json({
            error: "Adopting a Computer requires the admin or owner role on this server",
            code: "requires_admin",
          });
          return;
      }
    }

    res.status(201).json({
      apiKey: result.apiKey, // raw sk_computer_* — returned exactly once
      computerId: result.computerId,
      machineId: result.machineId,
      serverId: result.serverId,
      resumed: result.resumed,
    });
  } catch (err) {
    console.error("api.computer.adopt-legacy error:", err);
    res.status(500).json({ error: "Failed to adopt legacy machine" });
  }
});
