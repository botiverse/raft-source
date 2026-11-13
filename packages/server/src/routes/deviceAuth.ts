/**
 * Device-code login grant — task #30 PR-A2 (RFC v0.8 contract v3 §3/§5/§9).
 *
 * `POST /api/auth/device/authorize` — unauthenticated public, env/feature
 *     gated. Issues device_code + user_code, and records who asked (the
 *     visitor's IP and location when trusted, the user agent).
 * `POST /api/auth/device/describe`  — USER-authenticated. What the approval
 *     page shows about a typed code before anyone approves it: the client
 *     name it gave, when and where it was started; and the approval ticket.
 * `POST /api/auth/device/approve`   — USER-authenticated. Binds the
 *     approving user identity. Approving needs describe's approval ticket,
 *     so a page that approves a code straight from its link (any web bundle
 *     from before describe, still served from a service worker's cache) is
 *     refused and told to reload. An approval mails the person a one-time
 *     revoke link.
 * `POST /api/auth/device/revoke`    — unauthenticated, the revoke link's
 *     token. Mounted on its own (app.ts), outside the kill switch, so a link
 *     already mailed keeps working. A `dvcr_*` token is a Computer's revoke
 *     link instead (computerKeyRevocation.ts): it revokes that Computer only.
 * `POST /api/auth/device/token`     — unauthenticated public poll. On a
 *     legitimately approved + unconsumed grant, single-consumes it and
 *     issues a device session (accessToken + refreshToken), only while the
 *     web sign-in that approved it is live.
 *
 * OUT of the `routeAuthPolicy` registry BY DESIGN (contract v3 §3): these
 * are `/api/*` pre-credential surfaces, not claimed `/internal/*` principal
 * surfaces. Documented intentional — not an auth-policy omission. Mirrors
 * the `/api/agent/login` bootstrap-token surface 1:1 (public + gated +
 * stable fail-closed codes + zero existence enumeration); the shared grant
 * lifecycle lives in deviceAuthService (same pepper, no parallel auth path).
 *
 * Without `grant`, this login does NOT mint `sk_computer_*` / `sk_agent_*`
 * (contract §5): it establishes a device session; `raft-computer attach` /
 * external-agent bootstrap later consume that identity under their own
 * principal contract (the legacy path, kept for older clients).
 *
 * With `grant` (device-auth design v2, deviceLoginGrantService) it is a
 * one-time grant instead: describe lists what the person may pick, approve
 * requires the explicit pick, and token returns an attach token
 * (computer_attach), a migrate token (computer_migrate) or the `sk_agent_*`
 * itself (agent_key), once, and no session.
 */
import { Router, type Request, type Response, type Router as RouterType } from "express";
import {
  createDeviceAuthorization,
  describeDeviceAuthorization,
  approveDeviceAuthorization,
  consumeDeviceAuthorization,
  isDeviceAuthSurfaceEnabled,
  recordDeviceLoginSession,
  revokeDeviceLoginByLink,
  revokeDeviceLoginSession,
  sendDeviceLoginNotice,
} from "../services/deviceAuthService";
import {
  issueAttachToken,
  mintGrantAgentKey,
  oneTimeGrantOf,
  parseDeviceLoginGrantRequest,
  sendDeviceGrantNotice,
  type DeviceLoginGrantRequest,
} from "../services/deviceLoginGrantService";
import { listAttachableServers, listKeyableAgents } from "../services/deviceLoginGrantChoices";
import { looksLikeComputerRevokeToken, revokeComputerByLink } from "../services/computerKeyRevocation";
import { noticeOwnersOfDetachedComputer } from "../services/computerDetachedNotices";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { addTraceEvent } from "../tracing/semanticTrace";
import { respondInvalidOrExpiredToken, signAccessToken, requireAuth } from "../middleware/auth";
import { attachAuthTraceIdentity } from "../middleware/requestObservability";
import { getConfiguredAppUrl } from "../config/appUrl";
import { trustedViewerIp } from "../lib/clientIpForRateLimit";
import { visitorOrigin } from "../lib/visitorOrigin";
import { recordAuthSessionIssuedTrace } from "./authRefreshTrace";
import { sendJsonServerError } from "./errorResponse";
import { refuseUnverifiedApprover } from "./secondFactor";

export const deviceAuthRouter: RouterType = Router();
const DEVICE_LOGIN_PATH = "/login/device";

function appUrl(): string | null {
  return getConfiguredAppUrl();
}

// The approval page's fixed address. There is no `verificationUriComplete`
// with the code in it: a link that carries the code lets someone send a
// person a login of theirs to approve in one click. The person types the code
// their own terminal shows. Clients older than this fall back to
// `verificationUri` plus the code (CLI and raft-computer both do).
function buildVerificationUri(): { verificationUri: string } | null {
  const base = appUrl();
  if (!base) return null;
  return { verificationUri: `${base}${DEVICE_LOGIN_PATH}` };
}

function surfaceDisabled(res: import("express").Response): boolean {
  if (isDeviceAuthSurfaceEnabled()) return false;
  // Defense-in-depth: even though app.ts mounts this behind the same gate,
  // re-check so a misconfigured mount cannot expose the surface.
  res.status(404).json({
    error: "Device login is not enabled",
    code: "device_login_disabled",
  });
  return true;
}

// --- authorize: unauthenticated public ---
deviceAuthRouter.post("/authorize", async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { clientName?: unknown; grant?: unknown };
    let grantRequest: DeviceLoginGrantRequest | null = null;
    if (body.grant !== undefined && body.grant !== null) {
      const parsed = parseDeviceLoginGrantRequest(body.grant);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code });
        return;
      }
      grantRequest = parsed.grant;
    }
    let clientName: string | null = null;
    if (body.clientName !== undefined && body.clientName !== null) {
      if (typeof body.clientName !== "string" || body.clientName.length > 200) {
        res.status(400).json({ error: "clientName must be a string up to 200 chars", code: "client_name_invalid" });
        return;
      }
      clientName = body.clientName;
    }
    const verification = buildVerificationUri();
    if (!verification) {
      res.status(503).json({
        error: "Device login URL is not configured",
        code: "DEVICE_LOGIN_URL_UNAVAILABLE",
      });
      return;
    }
    const origin = visitorOrigin(req);
    const grant = await createDeviceAuthorization({
      clientName,
      requester: origin,
      requesterUserAgent: req.get("user-agent") ?? null,
      ...(grantRequest ? { grant: grantRequest } : {}),
    });
    res.status(201).json({
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      // Human approval happens on the web origin, not the API/server origin.
      ...verification,
      expiresIn: grant.expiresInSeconds,
      interval: grant.pollIntervalSeconds,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to start device authorization",
      logPrefix: "api.auth.device.authorize error:",
      err,
    });
  }
});

function userCodeFailureStatus(error: "user_code_invalid" | "already_resolved" | "expired"): number {
  return error === "expired" ? 410 : error === "already_resolved" ? 409 : 404;
}

// --- describe: USER-authenticated, read only ---
deviceAuthRouter.post("/describe", requireAuth, async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { userCode?: unknown };
    if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
      res.status(400).json({ error: "userCode is required", code: "user_code_required" });
      return;
    }
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const result = await describeDeviceAuthorization({ userCode: body.userCode, userId });
    if (!result.ok) {
      res.status(userCodeFailureStatus(result.error)).json({ error: "Device authorization can't be approved", code: result.error });
      return;
    }
    // A one-time grant: what it asks for and what this person may pick. The
    // page must have the person pick one, even when there is only one.
    const grant = result.grant
      ? {
          kind: result.grant.kind,
          machineName: result.grant.machineName,
          hostname: result.grant.hostname,
          os: result.grant.os,
          ...(result.grant.kind === "computer_attach" || result.grant.kind === "computer_migrate"
            ? { servers: await listAttachableServers(userId) }
            : result.grant.kind === "agent_key"
              ? { requestedAgentId: result.grant.requestedAgentId, agents: await listKeyableAgents(userId) }
              : {}),
        }
      : null;
    res.status(200).json({
      userCode: result.userCode,
      clientName: result.clientName,
      requestedAt: result.requestedAt.toISOString(),
      requester: result.requester,
      approvalTicket: result.approvalTicket,
      ...(grant ? { grant } : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read device authorization",
      logPrefix: "api.auth.device.describe error:",
      err,
    });
  }
});

// --- approve: USER-authenticated ---
deviceAuthRouter.post("/approve", requireAuth, async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { userCode?: unknown; approve?: unknown; approvalTicket?: unknown; serverId?: unknown; agentId?: unknown };
    if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
      res.status(400).json({ error: "userCode is required", code: "user_code_required" });
      return;
    }
    const approve = body.approve === undefined ? true : body.approve === true;
    const userId = req.userId;
    if (!userId) {
      // requireAuth should guarantee this; fail closed if not.
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    // requireAuth admits only a person's own full session here (approve is
    // not a device-session route); the family it verified live.
    const approverSessionFamilyId = req.sessionScope === "full" ? req.sessionFamilyId ?? null : null;
    if (approve && await refuseUnverifiedApprover(res, userId, approverSessionFamilyId)) return;
    const result = await approveDeviceAuthorization({
      userCode: body.userCode,
      userId,
      approve,
      approvalTicket: body.approvalTicket,
      selection: { serverId: body.serverId, agentId: body.agentId },
      approverSessionFamilyId,
    });
    if (!result.ok) {
      const { error } = result;
      if (error === "approval_ticket_required") {
        // Older approval pages show `error` as is.
        res.status(400).json({ error: "Reload this page and type the code again.", code: error });
        return;
      }
      if (error === "grant_selection_required") {
        // An approval page from before one-time grants never sends a pick.
        res.status(400).json({ error: "Choose where this is for: reload this page and type the code again.", code: error });
        return;
      }
      if (error === "grant_selection_not_allowed") {
        res.status(403).json({ error: "You can't approve this for that choice.", code: error });
        return;
      }
      if (error === "approver_session_revoked") {
        respondInvalidOrExpiredToken(res);
        return;
      }
      if (error === "grant_kind_unsupported") {
        res.status(400).json({ error: "This kind of device login isn't supported.", code: error });
        return;
      }
      res.status(userCodeFailureStatus(error)).json({ error: "Device authorization could not be updated", code: error });
      return;
    }
    if (result.oneTime) {
      addTraceEvent(approve ? "auth.device.grant.approved" : "auth.device.grant.denied", {
        grant_id: result.oneTime.id,
        kind: result.oneTime.kind,
        user_id: userId,
        ...(result.oneTime.serverId ? { server_id: result.oneTime.serverId } : {}),
        ...(result.oneTime.agentId ? { agent_id: result.oneTime.agentId } : {}),
      });
    } else if (approve) {
      // A one-time grant mails when it is used (what it added), not here: the
      // device-session notice says the program can act for the person, which
      // a one-time grant never can.
      await sendDeviceLoginNotice({ userId, grant: result.grant, event: "approved" });
    }
    res.status(200).json({ ok: true, action: approve ? "approved" : "denied" });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update device authorization",
      logPrefix: "api.auth.device.approve error:",
      err,
    });
  }
});

// --- token: unauthenticated public poll → issues user session on success ---
deviceAuthRouter.post("/token", async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { deviceCode?: unknown };
    if (typeof body.deviceCode !== "string" || body.deviceCode.length === 0) {
      res.status(400).json({ error: "deviceCode is required", code: "device_code_required" });
      return;
    }
    const result = await consumeDeviceAuthorization(body.deviceCode, {
      // The visitor's address or nothing, never the edge's (lib/visitorOrigin.ts).
      ip: trustedViewerIp(req),
      userAgent: req.get("user-agent") ?? null,
    });
    if (!result.ok) {
      // RFC-8628-ish: pending/slow_down are 400; terminal failures map to
      // their own status. All are stable codes, zero enumeration.
      const status = result.error === "authorization_pending" ? 400
        : result.error === "expired_token" ? 410
        : result.error === "access_denied" ? 403
        : result.error === "device_code_consumed" ? 410
        : 400; // device_code_invalid
      res.status(status).json({ error: "Device authorization not ready", code: result.error });
      return;
    }
    // A one-time grant: an attach token or the agent key, once; never a session.
    // The device code is already consumed here, so a failure below (grant
    // expired, server deleted, approver lost the permission) leaves this login
    // unusable: the client is told to start a new one (terminal codes, as for
    // an expired or denied code; a re-poll gets device_code_consumed).
    const oneTime = await oneTimeGrantOf(result.grantId);
    if (oneTime) {
      res.setHeader("Cache-Control", "no-store");
      const startAgain = (error: "expired_token" | "access_denied") => {
        res.status(error === "expired_token" ? 410 : 403).json({
          error: "This device login can't be completed. Start it again.",
          code: error,
        });
      };
      if (oneTime.kind === "computer_attach") {
        const issued = await issueAttachToken(oneTime);
        if (!issued.ok) {
          startAgain(issued.error);
          return;
        }
        res.status(200).json({
          kind: "computer_attach",
          attachToken: issued.attachToken, // raw dvat_* — returned exactly once
          expiresIn: Math.max(0, Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000)),
          serverId: issued.server.id,
          serverSlug: issued.server.slug,
          serverName: issued.server.name,
        });
        return;
      }
      if (oneTime.kind === "computer_migrate") {
        const issued = await issueAttachToken(oneTime);
        if (!issued.ok) {
          startAgain(issued.error);
          return;
        }
        res.status(200).json({
          kind: "computer_migrate",
          migrateToken: issued.attachToken, // raw dvmt_* — returned exactly once
          expiresIn: Math.max(0, Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000)),
          serverId: issued.server.id,
          serverSlug: issued.server.slug,
          serverName: issued.server.name,
        });
        return;
      }
      if (oneTime.kind === "agent_key") {
        const minted = await mintGrantAgentKey(oneTime);
        if (!minted.ok) {
          startAgain(minted.error);
          return;
        }
        void sendDeviceGrantNotice({
          grantId: oneTime.id,
          event: "agent_key",
          machineName: oneTime.machineName,
          serverId: minted.credential.serverId,
          agentName: minted.credential.agentName,
        });
        res.status(200).json({ kind: "agent_key", ...minted.credential }); // raw sk_agent_* — returned exactly once
        return;
      }
      startAgain("access_denied");
      return;
    }
    // Grant established a user identity: the consume issued its device
    // session (in its transaction, while the approving sign-in was live).
    // (This grant never mints sk_* itself — contract §5.) No session means the
    // code was a one-time grant's, handled above: fail closed if it wasn't.
    if (!result.session) {
      res.status(403).json({ error: "Device authorization not ready", code: "access_denied" });
      return;
    }
    const { sessionId, familyId, refreshToken } = result.session;
    const recorded = await recordDeviceLoginSession(result.grantId, { sessionId, familyId });
    if (recorded.revoked) {
      // The person used the revoke link while this poll was being answered.
      await revokeDeviceLoginSession(result.approvedByUserId, familyId);
      res.status(403).json({ error: "Device authorization not ready", code: "access_denied" });
      return;
    }
    const accessToken = signAccessToken(result.approvedByUserId, familyId);
    attachAuthTraceIdentity(req, { userId: result.approvedByUserId, sessionId, source: "device_auth" });
    recordAuthSessionIssuedTrace({ flow: "device_auth", userId: result.approvedByUserId, sessionId });
    res.status(200).json({ accessToken, refreshToken, userId: result.approvedByUserId });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to complete device authorization",
      logPrefix: "api.auth.device.token error:",
      err,
    });
  }
});

// --- revoke: the revoke link's token (unauthenticated, single use) ---
export async function deviceLoginRevokeHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { token?: unknown };
    // The same page and route serve a Computer's revoke link (`dvcr_*`, mailed
    // with "You added X to Y"): it revokes that Computer only.
    const result = looksLikeComputerRevokeToken(body.token)
      ? await revokeComputerByLink(body.token)
      : await revokeDeviceLoginByLink(body.token);
    if (!result.ok) {
      const status = result.error === "revoke_link_invalid" ? 404 : result.error === "revoke_link_used" ? 409 : 410;
      res.status(status).json({ error: "This revoke link can't be used", code: result.error });
      return;
    }
    if ("detached" in result) {
      await noticeOwnersOfDetachedComputer(
        req.app.get("io") as SocketServer | undefined,
        req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
        result.detached,
      );
    }
    res.status(200).json({ ok: true, revoked: result.revoked });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to revoke device login",
      logPrefix: "api.auth.device.revoke error:",
      err,
    });
  }
}
