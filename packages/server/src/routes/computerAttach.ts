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
 * Second principal: a one-time device-login grant's attach token
 * (`Authorization: Bearer dvat_*`, device-auth design v2 §3.1). The attach runs
 * as the person who approved the grant, for the server they picked only;
 * the token is checked and consumed in the attach's own transaction and the
 * key records the grant (`computers.key_issued_by_grant_id`), not a session.
 *
 * This issues the Computer principal itself; it does NOT mint
 * `sk_agent_*` (that is the sk_computer-gated /internal surface). Stable,
 * zero-enumeration failures.
 */
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { requireAuth, respondInvalidOrExpiredToken } from "../middleware/auth";
import { attachComputer } from "../services/computerCredentialService";
import { isDeviceAuthSurfaceEnabled, notifyDeviceSessionAction } from "../services/deviceAuthService";
import { deviceSessionFamilyOf, webSessionFamilyOf } from "../services/sessionService";
import { findAttachTokenGrant, looksLikeAttachToken, sendDeviceGrantNotice, type FindAttachTokenGrantResult } from "../services/deviceLoginGrantService";
import { findPendingAccountDeletion } from "../services/accountDeletion/requests";
import { getDb } from "../db/index";
import { addTraceEvent } from "../tracing/semanticTrace";
import { sendJsonServerError } from "./errorResponse";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";

export const computerAttachRouter: RouterType = Router();

type AttachGrant = Extract<FindAttachTokenGrantResult, { ok: true }>["grant"];
const attachGrants = new WeakMap<Request, AttachGrant>();

const ATTACH_TOKEN_FAILURE: Record<Exclude<FindAttachTokenGrantResult, { ok: true }>["error"], { status: number; error: string }> = {
  attach_token_invalid: { status: 401, error: "Invalid attach token" },
  attach_token_expired: { status: 410, error: "This attach token has expired: approve the machine again" },
  attach_token_consumed: { status: 410, error: "This attach token was already used" },
};

function respondAttachTokenFailure(res: Response, error: keyof typeof ATTACH_TOKEN_FAILURE): void {
  const failure = ATTACH_TOKEN_FAILURE[error];
  res.status(failure.status).json({ error: failure.error, code: error });
}

/** A `dvat_*` attach token, or else the person's session (requireAuth). */
function attachTokenOrUserAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!raw || !looksLikeAttachToken(raw)) { requireAuth(req, res, next); return; }
  void findAttachTokenGrant(raw).then((found) => {
    if (!found.ok) {
      addTraceEvent("auth.device.grant.attach_rejected", { reason: found.error });
      respondAttachTokenFailure(res, found.error);
      return;
    }
    attachGrants.set(req, found.grant);
    next();
  }).catch(next);
}

computerAttachRouter.post("/attach", attachTokenOrUserAuth, async (req, res) => {
  // Defense-in-depth: app.ts mounts this behind the same gate, re-check
  // so a misconfigured mount cannot expose the surface.
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({ error: "Computer attach is not enabled", code: "computer_attach_disabled" });
    return;
  }
  try {
    const grant = attachGrants.get(req) ?? null;
    const userId = grant ? grant.approverUserId : req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    // An account scheduled for deletion attaches nothing. A session of such
    // a person never gets here (requireAuth answers account_deletion_pending);
    // an attach token approved before the request is expired by its
    // security-revoke cascade, and refused here in case that has not run yet.
    if (grant) {
      const pending = await findPendingAccountDeletion(getDb(), userId);
      if (pending) {
        res.status(403).json({
          error: "This account is scheduled for deletion. Cancel the deletion to use it again.",
          code: "account_deletion_pending",
          scheduledFor: pending.scheduledFor.toISOString(),
        });
        return;
      }
    }
    const body = (req.body ?? {}) as { serverSlug?: unknown; name?: unknown };
    // With an attach token the server is the one the person picked; a
    // serverSlug, when sent, must name it.
    if (grant) {
      if (body.serverSlug !== undefined && body.serverSlug !== null && body.serverSlug !== grant.serverSlug) {
        addTraceEvent("auth.device.grant.attach_rejected", { reason: "attach_token_server_mismatch", grant_id: grant.id });
        res.status(403).json({ error: "This attach token is for another server", code: "attach_token_server_mismatch" });
        return;
      }
    } else if (typeof body.serverSlug !== "string" || body.serverSlug.length === 0) {
      res.status(400).json({ error: "serverSlug is required", code: "server_slug_required" });
      return;
    }
    const serverSlug = grant ? grant.serverSlug : body.serverSlug as string;
    // With an attach token the Computer gets the name the approver saw on the
    // approval page (sanitized at authorize); a client-sent name is ignored.
    let name = grant?.machineName ?? "raft-computer";
    if (!grant && body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 200) {
        res.status(400).json({ error: "name must be a non-empty string up to 200 chars", code: "name_invalid" });
        return;
      }
      name = body.name;
    }
    const deviceSessionFamilyId = grant ? null : deviceSessionFamilyOf(req);
    const webSessionFamilyId = grant ? null : webSessionFamilyOf(req);
    // From a person's web sign-in, with two-step verification on: it passed
    // the second factor in the last 10 minutes (stepUpGate.ts). Not an attach
    // token or a device login's session (`raft-computer login`): their
    // approval already needed a verified sign-in (approverSecondFactorCheck).
    if (!grant && !deviceSessionFamilyId
      && await refuseWithoutRecentSecondFactor(res, userId, webSessionFamilyId, "computer_attach")) return;
    const result = await attachComputer(grant
      ? { userId, serverSlug, name, grant: { id: grant.id, tokenLookupHash: grant.tokenLookupHash } }
      : { userId, serverSlug, name, deviceSessionFamilyId, webSessionFamilyId });
    if (!result.ok) {
      if (result.error === "attach_token_invalid" || result.error === "attach_token_expired" || result.error === "attach_token_consumed") {
        addTraceEvent("auth.device.grant.attach_rejected", { reason: result.error, ...(grant ? { grant_id: grant.id } : {}) });
        respondAttachTokenFailure(res, result.error);
        return;
      }
      if (result.error === "session_revoked") {
        respondInvalidOrExpiredToken(res);
        return;
      }
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
    if (grant) {
      addTraceEvent("auth.device.grant.consumed", {
        grant_id: grant.id,
        kind: "computer_attach",
        server_id: result.serverId,
        computer_id: result.serverMachineId,
        user_id: userId,
      });
      void sendDeviceGrantNotice({ grantId: grant.id, event: "computer_attach", machineName: name, serverId: result.serverId, computerId: result.serverMachineId });
    } else {
      void notifyDeviceSessionAction({
        userId: req.userId,
        familyId: req.sessionFamilyId,
        scope: req.sessionScope,
        event: "computer_attach",
        target: { label: "Server", value: result.serverSlug },
      });
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
    sendJsonServerError(req, res, {
      error: "Failed to attach Computer",
      logPrefix: "api.computer.attach error:",
      err,
    });
  }
});
