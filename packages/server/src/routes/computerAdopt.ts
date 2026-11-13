/**
 * Computer legacy adoption — task #39 PR-J1 (RFC v0.8 v8.2 §5.11 / §10.13).
 *
 * `POST /api/computer/adopt-legacy` — USER-authenticated. The caller proves
 * authority for a legacy daemon either by supplying its raw `sk_machine_*`
 * key (legacy/manual path), by selecting a user-scoped legacy roster entry
 * (`serverSlug` + `legacyMachineId` + `apiKeyFingerprint`), or by using
 * `registerMachines` (owner / admin) to select a daemon row on the target
 * Server (`serverSlug` + `daemonId`): their own, or another member's. Moving
 * another member's machine is audited (`computer.legacy_adopted_by_other`)
 * and that member gets one email. Resuming a Computer whose key someone else
 * holds replaces it (`computer.key_rotated`), and that person gets one email
 * per takeover. Both only while they are still in the server. On success the
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
 *   403 requires_admin                    → member lacks registerMachines (owner/admin)
 *   404 legacy_machine_not_found          → daemon-id row absent from target Server
 *   400 legacy_api_key_required          → request shape invalid
 *   404 computer_adopt_disabled          → feature flag off
 *   500 internal                         → unexpected
 *
 * Second principal: a computer_migrate grant's migrate token
 * (`Authorization: Bearer dvmt_*`, migrateTokenAuth.ts), what
 * `raft-computer setup` uses to move an old daemon over. The adoption then
 * runs as the approver, on the server they picked only (another `serverSlug`
 * answers 403 `migrate_token_server_mismatch`), under the same rule as a
 * session: one of the approver's own legacy machines (a roster or daemon-id
 * selection), or by daemon id another member's when the approver holds
 * `registerMachines` at adoption time (403 `requires_admin` otherwise). A raw
 * legacy key is refused (403 `migrate_token_selection_required`), the roster
 * a token reads stays the approver's own, and a machine that already has a
 * live Computer someone else attached is refused as already migrated (409):
 * a token moves old daemons, it never takes over a Computer. The token is checked and
 * consumed in the adoption's own transaction, and the key records the grant
 * (`computers.key_issued_by_grant_id`), not a session.
 *
 * Raw-key hygiene: the inbound legacy key is read once into the service
 * call and never logged, never written back, never echoed in any response.
 */
import { Router, type Router as RouterType } from "express";
import { respondInvalidOrExpiredToken } from "../middleware/auth";
import {
  adoptLegacyMachine,
  adoptLegacyMachineByDaemonId,
  adoptLegacyMachineByFingerprint,
  notifyComputerKeyReplacedByOther,
  notifyLegacyMachineMovedByOther,
} from "../services/computerAdoptionService";
import { isDeviceAuthSurfaceEnabled, notifyDeviceSessionAction } from "../services/deviceAuthService";
import { sendDeviceGrantNotice } from "../services/deviceLoginGrantService";
import { addTraceEvent } from "../tracing/semanticTrace";
import { isMigrateTokenFailure, migrateGrantAllowsServer, migrateGrantOf, migrateTokenOrUserAuth, respondMigrateTokenFailure } from "./migrateTokenAuth";
import { deviceSessionFamilyOf, webSessionFamilyOf } from "../services/sessionService";
import { sendJsonServerError } from "./errorResponse";
import { refuse } from "../lib/refusal";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";

export const computerAdoptRouter: RouterType = Router();

computerAdoptRouter.post("/adopt-legacy", migrateTokenOrUserAuth, async (req, res) => {
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({
      error: "Computer legacy adoption is not enabled",
      code: "computer_adopt_disabled",
    });
    return;
  }
  try {
    const grant = migrateGrantOf(req);
    const userId = grant ? grant.approverUserId : req.userId;
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
    if (grant) {
      // A migrate token adopts a legacy machine by its roster identity or its
      // machine id (the approver's own, or with registerMachines another
      // member's old daemon): never by a raw legacy key.
      if (!hasRosterIdentity && !hasDaemonIdentity) {
        addTraceEvent("auth.device.grant.migrate_rejected", { reason: "migrate_token_selection_required", grant_id: grant.id });
        refuse(res, 403, {
          code: "migrate_token_selection_required",
          error: "A migrate token adopts a legacy machine picked from your roster: send its roster identity, not its key.",
        });
        return;
      }
      if (!migrateGrantAllowsServer(res, grant, body.serverSlug)) return;
    }
    let name: string | undefined;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        res.status(400).json({ error: "name must be a non-empty string up to 200 chars", code: "name_invalid" });
        return;
      }
      name = body.name;
    }

    const deviceSessionFamilyId = grant ? null : deviceSessionFamilyOf(req);
    const webSessionFamilyId = grant ? null : webSessionFamilyOf(req);
    const redemption = grant ? { grant: { id: grant.id, tokenLookupHash: grant.tokenLookupHash } } : {};
    // Adopting mints a computer key like attaching does: from a person's web
    // sign-in with two-step verification on, it passed the second factor in
    // the last 10 minutes (stepUpGate.ts). Not a device login's session
    // (`raft-computer login`) or a migrate token: their approval already
    // needed a verified sign-in.
    if (!grant && !deviceSessionFamilyId
      && await refuseWithoutRecentSecondFactor(res, userId, webSessionFamilyId, "computer_adopt")) return;
    const result = hasRosterIdentity
      ? await adoptLegacyMachineByFingerprint({
        userId,
        serverSlug: body.serverSlug as string,
        legacyMachineId: body.legacyMachineId as string,
        apiKeyFingerprint: body.apiKeyFingerprint as string,
        name,
        deviceSessionFamilyId,
        webSessionFamilyId,
        ...redemption,
      })
      : hasDaemonIdentity
        ? await adoptLegacyMachineByDaemonId({
          userId,
          serverSlug: body.serverSlug as string,
          daemonId: body.daemonId as string,
          name,
          deviceSessionFamilyId,
          webSessionFamilyId,
          ...redemption,
        })
      : await adoptLegacyMachine({
        userId,
        legacyApiKey: body.legacyApiKey as string,
        name,
        deviceSessionFamilyId,
        webSessionFamilyId,
      });

    if (!result.ok) {
      if (isMigrateTokenFailure(result.code)) {
        addTraceEvent("auth.device.grant.migrate_rejected", { reason: result.code, ...(grant ? { grant_id: grant.id } : {}) });
        respondMigrateTokenFailure(res, result.code);
        return;
      }
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
        case "session_revoked":
          respondInvalidOrExpiredToken(res);
          return;
      }
    }

    if (grant) {
      addTraceEvent("auth.device.grant.consumed", {
        grant_id: grant.id,
        kind: "computer_migrate",
        server_id: result.serverId,
        computer_id: result.computerId,
        user_id: userId,
      });
      // The same "You added X to Y" notice (with the Computer's revoke link) an attach token sends.
      void sendDeviceGrantNotice({ grantId: grant.id, event: "computer_attach", machineName: name ?? grant.machineName, serverId: result.serverId, computerId: result.computerId });
    } else {
      // Adopting mints a computer credential like attaching does.
      void notifyDeviceSessionAction({
        userId: req.userId,
        familyId: req.sessionFamilyId,
        scope: req.sessionScope,
        event: "computer_attach",
        ...(typeof body.serverSlug === "string" ? { target: { label: "Server", value: body.serverSlug } } : {}),
      });
    }
    if (result.movedMachineAddedByUserId) {
      void notifyLegacyMachineMovedByOther({
        serverId: result.serverId,
        machineId: result.machineId,
        machineAddedByUserId: result.movedMachineAddedByUserId,
        movedByUserId: userId,
      });
    }
    if (result.replacedKeyOf) {
      void notifyComputerKeyReplacedByOther({
        serverId: result.serverId,
        computerName: result.replacedKeyOf.computerName,
        keyHolderUserId: result.replacedKeyOf.userId,
        replacedByUserId: userId,
      });
    }
    res.status(201).json({
      apiKey: result.apiKey, // raw sk_computer_* — returned exactly once
      computerId: result.computerId,
      machineId: result.machineId,
      serverId: result.serverId,
      resumed: result.resumed,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to adopt legacy machine",
      logPrefix: "api.computer.adopt-legacy error:",
      err,
    });
  }
});
