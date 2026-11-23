import { type ServerCapability, type ServerRole } from "@botiverse/raft-shared";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { MANAGED_MCP_OAUTH_RESULT_CHANNEL } from "@botiverse/raft-shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb, type DatabaseTransaction } from "../db/index";
import { agents, managedMcpAssignments, managedMcpServers } from "../db/schema";
import { actorHasServerCapabilityInServer, actorRoleHasServerCapability, getActorServerRoleInServer, userCanActOnAgentResource } from "../lib/actorPermissions";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import {
  createManagedMcpServer,
  deleteManagedMcpServer,
  listAgentManagedMcpCatalog,
  listManagedMcpServerCatalog,
  refreshManagedMcpCatalog,
  setManagedMcpAssignment,
  testManagedMcpConfiguration,
  updateManagedMcpServer,
  writeManagedMcpAssignments,
} from "../services/managedMcpService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { bumpAgentConfigRevision } from "../services/agentConfigRevision";
import type { Server as SocketServer } from "socket.io";
import { announceResolvedActionCards } from "../services/actionCardsService";
import { ManagedMcpCredentialError } from "../services/managedMcpCredentialService";
import { normalizeManagedMcpOAuthClient } from "../services/managedMcpOAuthClient";
import { ManagedMcpGatewayError, managedMcpOAuthFailureDetail } from "../services/managedMcpGateway";
import {
  disconnectManagedMcpOAuthConnection,
  failManagedMcpOAuthAttempt,
  getManagedMcpOAuthAttemptStatus,
  MANAGED_MCP_OAUTH_ATTEMPT_TTL_SECONDS,
  ManagedMcpOAuthError,
  startManagedMcpOAuthConnection,
  type ManagedMcpOAuthIntent,
} from "../services/managedMcpOAuthService";
import {
  completeManagedMcpOAuthCallback,
  createManagedMcpHeaderConnection,
  describeManagedMcpDefaultImpact,
  listManagedMcpConnections,
  setServerDefaultConnection,
  updateManagedMcpConnection,
} from "../services/managedMcpConnectionService";
import { projectMcpConnectionAuthorization, resolveMcpConnectionViewerRole } from "../services/managedMcpConnectionCardService";
import {
  assertMayEditMcpConnection,
  auditSharedPinChanges,
  deleteMcpConnection,
  mcpConnectionKind,
  signOutMcpConnection,
  listMcpAccounts,
  readSharedPins,
  setMcpConnectionAgents,
  setMembersCanConnect,
} from "../services/managedMcpAccountsService";
import { notifyPersonalGrants } from "../services/managedMcpAccountNotices";
import { mcpPersonalAccountsEnabled, PERSONAL_ACCOUNT_REFUSAL_MESSAGES, personalSignInRefusal } from "../services/managedMcpPersonalAccounts";
import { MAX_AGENTS_PER_WRITE, requireAgentsVisibleTo } from "../services/managedMcpPersonalGrants";
import { ManagedMcpServiceError } from "../services/managedMcpService";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { agentIdAsFoundBy, hideUnfindableAgentsByParam } from "./unfindableAgentGate";
import { handleLogoUploadError, isPersonsOwnSession, runSingleLogoUpload } from "./integrations";
import { refuseUnverifiedApprover } from "./secondFactor";
import { webSessionFamilyOf } from "../services/sessionService";
import { refuse } from "../lib/refusal";
import rateLimit from "express-rate-limit";
import {
  createMcpApp,
  deleteMcpApp,
  getMcpAppView,
  listMcpApps,
  clearMcpAppLogo,
  refreshMcpApp,
  setMcpAppServerVouch,
  updateMcpApp,
  updateMcpAppLogo,
  type McpAppProfileInput,
  type McpAppSource,
} from "../services/managedMcpAppService";
import { probeManagedMcpEndpoint } from "../services/managedMcpProbe";
import { getBundledMcpAppTemplates, listMcpAppTemplates } from "../services/mcpAppTemplates";
import { clientLogoUrl } from "../config/privacyMode";
import { UUID_RE } from "../lib/messageId";
import {
  MANAGED_MCP_OAUTH_CALLBACK_PATH,
  clearManagedMcpOAuthBindingCookie,
  managedMcpOAuthBindingCookie,
  managedMcpOAuthCallbackIsBound,
} from "../services/managedMcpOAuthBrowserBinding";

export const managedMcpRouter: RouterType = Router();
export const managedMcpOAuthCallbackRouter: RouterType = Router();
// Recommended-App templates are validated when the routes load, not on the first request.
getBundledMcpAppTemplates();
// Uniform 404 for non-UUID path params (task #12).
guardUuidPathParams(managedMcpRouter, {
  agentId: "Agent",
  mcpServerId: "MCP server",
  appId: "MCP App",
  connectionId: "MCP connection",
  attemptId: "MCP OAuth attempt",
});
// Another person's personal assistant reads as an unknown agent (agentFindableBy).
hideUnfindableAgentsByParam(managedMcpRouter, "agentId");

function body(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function pathParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function managedMcpServerOrigin(): string {
  return process.env.SERVER_URL?.trim() || `http://localhost:${process.env.PORT || 3001}`;
}

/** Answers a started sign-in, binding it to this browser (see managedMcpOAuthBrowserBinding). */
function sendManagedMcpOAuthStart(
  res: Response,
  started: { authorizationUrl: string; attemptId: string; connectionId: string; state: string },
): void {
  const { state, ...body } = started;
  res.append("Set-Cookie", managedMcpOAuthBindingCookie(state, MANAGED_MCP_OAUTH_ATTEMPT_TTL_SECONDS));
  res.json(body);
}

type ManagedMcpOAuthResultPage = "connected" | "cancelled" | "failed";

function renderManagedMcpOAuthResultPage(result: ManagedMcpOAuthResultPage, attemptId: string | null): string {
  const copy = result === "connected"
    ? {
        eyebrow: "Connection complete",
        title: "MCP connected",
        message: "This MCP connection is ready in Raft.",
        marker: "&#10003;",
        tone: "success",
      }
    : result === "cancelled"
      ? {
          eyebrow: "Connection incomplete",
          title: "Authorization not completed",
          message: "Return to Raft and start Connect again when you are ready.",
          marker: "!",
          tone: "warning",
        }
      : {
          eyebrow: "Connection failed",
          title: "MCP was not connected",
          message: "The authorization attempt failed or expired. Return to Raft and try again. If the provider refused it, the Connection shows its reason.",
          marker: "!",
          tone: "error",
        };
  const script = `<script>(function(){if(typeof BroadcastChannel!=="undefined"){var channel=new BroadcastChannel("${MANAGED_MCP_OAUTH_RESULT_CHANNEL}");channel.postMessage({type:"${MANAGED_MCP_OAUTH_RESULT_CHANNEL}",result:"${result}"${attemptId && UUID_RE.test(attemptId) ? `,attemptId:"${attemptId}"` : ""}})}document.getElementById("close-window").addEventListener("click",function(){window.close()})})()</script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title} | Raft</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f4f5;color:#111}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#f4f4f5}
main{width:min(100%,460px);border:2px solid #111;background:#fff;box-shadow:8px 8px 0 #111}
header{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #111;padding:14px 16px;background:#fff}
.brand{font-size:14px;font-weight:900;letter-spacing:0}.product{font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#666}
.content{padding:32px 28px 28px}.marker{display:grid;width:48px;height:48px;place-items:center;border:2px solid #111;font-size:24px;font-weight:900;box-shadow:4px 4px 0 #111}
.success{background:#b9f57b}.warning{background:#ffe071}.error{background:#ff9f9f}
.eyebrow{margin:24px 0 8px;font:800 11px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;color:#555}
h1{margin:0;font-size:28px;line-height:1.15;letter-spacing:0}p{margin:12px 0 0;font-size:15px;line-height:1.55;color:#555}
button{width:100%;height:42px;margin-top:28px;border:2px solid #111;background:#ff4fa3;color:#111;font:900 14px inherit;cursor:pointer;box-shadow:3px 3px 0 #111}
button:hover{transform:translate(1px,1px);box-shadow:2px 2px 0 #111}button:focus-visible{outline:3px solid #6d5dfc;outline-offset:3px}
@media(max-width:520px){body{padding:16px;place-items:center}main{box-shadow:5px 5px 0 #111}.content{padding:28px 22px 24px}h1{font-size:24px}}
</style>
</head>
<body>
<main>
<header><span class="brand">RAFT</span><span class="product">MANAGED MCP</span></header>
<section class="content">
<div class="marker ${copy.tone}" aria-hidden="true">${copy.marker}</div>
<p class="eyebrow">${copy.eyebrow}</p>
<h1>${copy.title}</h1>
<p>${copy.message}</p>
<button id="close-window" type="button">Close window</button>
</section>
</main>
${script}
</body>
</html>`;
}

function sendManagedMcpOAuthResultPage(res: Response, status: number, result: ManagedMcpOAuthResultPage, attemptId: string | null = null): void {
  res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(renderManagedMcpOAuthResultPage(result, attemptId));
}

function requiredString(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ManagedMcpCredentialError(`${label} is required`, "managed_mcp_credential_invalid");
  }
  return value.trim();
}

function optionalString(value: unknown, label: string, maxLength = 4_000): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new ManagedMcpCredentialError(`${label} is invalid`, "managed_mcp_credential_invalid");
  }
  return value.trim();
}

function optionalHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpCredentialError("headers must be an object", "managed_mcp_credential_invalid");
  }
  return value as Record<string, string>;
}

function optionalProvider(value: unknown): "notion" | "linear" | "custom" | undefined {
  if (value === undefined) return undefined;
  if (value === "notion" || value === "linear" || value === "custom") return value;
  throw new ManagedMcpCredentialError("provider is invalid", "managed_mcp_credential_invalid");
}

function optionalAuthMode(value: unknown): "oauth" | "headers" | "none" | undefined {
  if (value === undefined) return undefined;
  if (value === "oauth" || value === "headers" || value === "none") return value;
  throw new ManagedMcpCredentialError("authMode is invalid", "managed_mcp_credential_invalid");
}

function optionalCredentialPatch(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpCredentialError("credentialPatch is invalid", "managed_mcp_credential_invalid");
  }
  const patch = value as Record<string, unknown>;
  const upsertHeaders = optionalHeaders(patch.upsertHeaders);
  if (!upsertHeaders || !Array.isArray(patch.removeHeaderNames) || patch.removeHeaderNames.some((name) => typeof name !== "string")) {
    throw new ManagedMcpCredentialError("credentialPatch is invalid", "managed_mcp_credential_invalid");
  }
  return { upsertHeaders, removeHeaderNames: patch.removeHeaderNames as string[] };
}

/** `undefined` keeps the current restriction; `null` lifts it; an array sets it. */
function optionalAllowedTools(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ManagedMcpCredentialError("allowedTools must be null or an array of tool names", "managed_mcp_credential_invalid");
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

/**
 * The Connection an assignment is bound to (task #21, 0342).
 *
 * Three distinct answers, and the difference between the first two is the whole reason this is not
 * just `string | undefined`:
 *   absent  leave the existing binding alone -- an unrelated edit to `allowedTools` must not
 *           silently revoke someone's Connection
 *   null    unbind, explicitly
 *   string  pin to this Connection
 * Who may change it is the route's (`assertMayChangeBinding`: admins only, under the membership fence); what may be
 * pinned (a shared Connection of this App) is `resolveAssignmentBinding`'s, inside the same
 * transaction as the write.
 */
function optionalConnectionVisibility(value: unknown): "private" | "server_shared" | undefined {
  if (value === undefined) return undefined;
  if (value === "private" || value === "server_shared") return value;
  throw new ManagedMcpCredentialError("visibility is invalid", "managed_mcp_credential_invalid");
}

function optionalConnectionId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredString(value, "connectionId", 64);
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ManagedMcpCredentialError(`${label} is invalid`, "managed_mcp_credential_invalid");
  }
  return value;
}

/** Where a sign-in was started from (an Agent, an action card). Stored with the attempt; secret-free. */
async function optionalOAuthIntentOrigin(serverId: string, value: unknown): Promise<Pick<ManagedMcpOAuthIntent, "agentId" | "actionCardMessageId">> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedMcpCredentialError("intent is invalid", "managed_mcp_credential_invalid");
  }
  const intent = value as Record<string, unknown>;
  const agentId = intent.agentId === undefined ? undefined : requiredUuid(intent.agentId, "intent.agentId");
  const actionCardMessageId = intent.actionCardMessageId === undefined
    ? undefined
    : requiredUuid(intent.actionCardMessageId, "intent.actionCardMessageId");
  if (agentId !== undefined) {
    const [agent] = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId)))
      .limit(1);
    if (!agent) throw new ManagedMcpServiceError("Agent not found", "managed_mcp_agent_not_found");
  }
  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(actionCardMessageId !== undefined ? { actionCardMessageId } : {}),
  };
}

/** `agentIds` of a request: 0 to MAX_AGENTS_PER_WRITE Agent ids, deduplicated. */
function agentIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS_PER_WRITE) {
    throw new ManagedMcpCredentialError(`${label} must be an array of at most ${MAX_AGENTS_PER_WRITE} agent ids`, "managed_mcp_credential_invalid");
  }
  return [...new Set(value.map((item) => requiredUuid(item, label)))];
}

/**
 * RFC 087 §6: every write about whose account an Agent uses (connecting, giving, revoking, the
 * toggle) is a person's own session, as the server vouch: never an assistant acting as its owner,
 * a confirmed card's dispatch or an agent's credential. Answers the refusal and returns true.
 */
function refuseUnlessPersonsOwnSession(req: Request, res: Response): boolean {
  if (isPersonsOwnSession(req)) return false;
  refuse(res, 403, { code: "MCP_ACCOUNT_PERSON_ONLY", error: "Only a person signed in themselves can connect, give or remove an App account." });
  return true;
}

/**
 * `refuseUnlessPersonsOwnSession` as route middleware: first in the chain, so a refused request
 * reads nothing, writes nothing and spends no rate-limit token. RFC 087 §6: a person's own session
 * for every sign-in start and every assignment write, shared or personal (defense in depth: today no
 * assistant owner action, card dispatch or device session reaches these routes).
 */
function requirePersonsOwnSession(req: Request, res: Response, next: NextFunction): void {
  if (refuseUnlessPersonsOwnSession(req, res)) return;
  next();
}

function requiredAssignmentUpdates(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ManagedMcpCredentialError("assignments must contain between 1 and 100 updates", "managed_mcp_credential_invalid");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ManagedMcpCredentialError("assignment update is invalid", "managed_mcp_credential_invalid");
    }
    const assignment = item as Record<string, unknown>;
    if (assignment.enabled !== undefined && typeof assignment.enabled !== "boolean") {
      throw new ManagedMcpCredentialError("assignment enabled must be a boolean", "managed_mcp_credential_invalid");
    }
    return {
      mcpServerId: requiredString(assignment.mcpServerId, "mcpServerId", 64),
      enabled: assignment.enabled as boolean | undefined,
      allowedTools: optionalAllowedTools(assignment.allowedTools),
      connectionId: optionalConnectionId(assignment.connectionId),
    };
  });
}

const BAD_REQUEST_SERVICE_CODES = new Set<ManagedMcpServiceError["code"]>([
  "managed_mcp_headers_incomplete",
  "managed_mcp_app_section_not_supported",
  "managed_mcp_app_invalid",
  "managed_mcp_personal_oauth_only",
  "managed_mcp_connection_request_invalid",
]);

/**
 * Refusals of who may use what: pinning to a personal Connection, or pinning without being an admin;
 * a member's own account (RFC 087) where the App or the person does not allow it, or someone else's.
 * (`managed_mcp_personal_accounts_off`, the Server flag, is a 409.)
 */
const FORBIDDEN_SERVICE_CODES = new Set<ManagedMcpServiceError["code"]>([
  "managed_mcp_connection_not_usable",
  "managed_mcp_pin_forbidden",
  "managed_mcp_members_cannot_connect",
  "managed_mcp_personal_not_member",
  "managed_mcp_connection_forbidden",
]);

function sendManagedMcpError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ManagedMcpCredentialError || error instanceof ManagedMcpGatewayError || error instanceof ManagedMcpOAuthError) {
    const status = error.code === "managed_mcp_endpoint_blocked"
      ? 403
      : error.code.endsWith("not_found")
      ? 404
      : error.code === "managed_mcp_credential_key_missing"
      ? 503
      : error.code === "managed_mcp_oauth_busy"
        ? 503
        // 503, not 502: Cloudflare replaces an origin's 502 body with its own error page, so the
        // reason below never reached the browser and the UI fell back to "try again".
        : error.code === "managed_mcp_unreachable"
          ? 503
          : 400;
    setRequestTraceErrorCode(res, error.code);
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedMcpServiceError) {
    const status = error.code.endsWith("not_found")
      ? 404
      : BAD_REQUEST_SERVICE_CODES.has(error.code)
        ? 400
        : FORBIDDEN_SERVICE_CODES.has(error.code) ? 403 : 409;
    setRequestTraceErrorCode(res, error.code);
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
}

/** sendManagedMcpError for a write under the membership fence. */
function sendFencedManagedMcpError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ServerMembershipRevokedError) {
    refuse(res, 403, { code: error.code, error: error.message });
    return;
  }
  if (error instanceof FencedAuthorizationDeniedError) {
    if (error.reason === "not_found") {
      refuse(res, 404, { code: "managed_mcp_connection_not_found", error: "This Connection does not exist on this server, or you cannot see it." });
    } else {
      refuse(res, 403, { code: "managed_mcp_forbidden", error: "You are not allowed to change this Connection; ask its owner or a server admin." });
    }
    return;
  }
  sendManagedMcpError(error, res, next);
}

function requireCapability(capability: ServerCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, capability)) {
        res.status(403).json({ error: `${capability} capability required`, code: "managed_mcp_forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Which shared account an Agent uses (pinned to a shared Connection, or following the default) is
 * managing the shared account, an admin's decision (RFC 087 §6): `manageExternalAuth`, read under the
 * caller's membership fence, for any write that CHANGES `connection_mode` / `bound_connection_id`.
 * A write that names the current choice again (a UI sending the whole row) is not a change, so the
 * Agent's creator may still send it; `enabled` and `allowedTools` keep their writers.
 */
async function assertMayChangeBinding(
  tx: DatabaseTransaction,
  callerRole: ServerRole | null,
  agentId: string,
  updates: ReadonlyArray<{ mcpServerId: string; connectionId: string | null | undefined }>,
): Promise<void> {
  if (actorRoleHasServerCapability(callerRole, "manageExternalAuth")) return;
  const asked = updates.filter((update) => update.connectionId !== undefined);
  if (asked.length === 0) return;
  const current = new Map((await tx
    .select({ mcpServerId: managedMcpAssignments.mcpServerId, connectionMode: managedMcpAssignments.connectionMode, boundConnectionId: managedMcpAssignments.boundConnectionId })
    .from(managedMcpAssignments)
    .where(and(eq(managedMcpAssignments.agentId, agentId), inArray(managedMcpAssignments.mcpServerId, asked.map((update) => update.mcpServerId)))))
    .map((row) => [row.mcpServerId, row]));
  const changes = asked.some(({ mcpServerId, connectionId }) => {
    const row = current.get(mcpServerId);
    // No row follows the default.
    const pinned = row?.connectionMode === "pinned";
    return connectionId === null ? pinned : !(pinned && row?.boundConnectionId === connectionId);
  });
  if (changes) {
    throw new ManagedMcpServiceError("Only a server admin can change which shared Connection an agent uses", "managed_mcp_pin_forbidden");
  }
}

function requireAgentCapabilityOrCreator(capability: ServerCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = pathParam(req.params.agentId);
      const [agent] = await getDb()
        .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.serverId, req.serverId!)));
      const callerRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
      if (!agent || !userCanActOnAgentResource(callerRole, req.userId!, agent, capability)) {
        res.status(403).json({ error: `${capability} capability or agent creator authority required`, code: "managed_mcp_forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}


/**
 * Connect cards this request's write closed (an Agent now admitted), announced once it committed:
 * the card redraws and the Agent that asked gets its result reply (#triage:#170).
 */
async function announceClosedConnectCards(req: Request, closedCards: readonly string[], confirmerUserId: string): Promise<void> {
  if (closedCards.length === 0) return;
  await announceResolvedActionCards({
    io: req.app.get("io") as SocketServer | undefined,
    orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    messageIds: closedCards,
    confirmerUserId,
  });
}

managedMcpRouter.get("/agents/:agentId", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    const agentId = pathParam(req.params.agentId);
    const [agent] = await getDb()
      .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.serverId, req.serverId!)));
    // Connection names only for someone who may change this Agent's Apps; an observer sees each
    // App's state and nothing about which Connection it uses.
    const viewerRole = await resolveMcpConnectionViewerRole(req.serverId!, req.userId!, agent ?? null);
    // The Agent was read just above; pass it on rather than reading it again (an unknown Agent is
    // still answered 404 by the catalogue's own lookup).
    res.json(await listAgentManagedMcpCatalog(req.serverId!, agentId, {
      includeConnectionNames: viewerRole !== "observer",
      ...(agent ? { agent } : {}),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

// The Server's MCP catalogue (endpoints, tool lists, credential header names, last errors) is
// member reading like the per-Agent catalogue beside it; a guest gets 403.
managedMcpRouter.get("/servers", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    res.json(await listManagedMcpServerCatalog(req.serverId!));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * What THIS viewer may do about an Agent blocked on an MCP Connection: which Connections they may
 * bind, and whether they may create one or set a Server default.
 *
 * ⚠️ Deliberately NOT behind `requireCapability`. An Agent manager with no Server-wide capability is
 * precisely the person this endpoint exists for, and gating it on `manageIntegrations` is what left
 * them unable to authorize their own Agent (@Huarong). The authority lives in the projection, which
 * derives the viewer's role itself and degrades to an observer view -- no Connection ids, no counts
 * -- for anyone else. Route-level gating here would be a second, weaker copy of that decision.
 */
managedMcpRouter.get("/servers/:mcpServerId/connection-authorization", async (req, res, next) => {
  try {
    res.json(await projectMcpConnectionAuthorization({
      serverId: req.serverId!,
      viewerUserId: req.userId!,
      mcpServerId: pathParam(req.params.mcpServerId),
      agentId: await agentIdAsFoundBy(req.userId, requiredString(req.query.agentId, "agentId", 64)),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.post("/servers", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const input = body(req);
    const provider = optionalProvider(input.provider) ?? "custom";
    const authMode = optionalAuthMode(input.authMode) ?? (input.headers === undefined ? "none" : "headers");
    res.status(201).json(await createManagedMcpServer({
      serverId: req.serverId!,
      userId: req.userId!,
      // As POST /apps: a server owner or admin in their own session vouches for it.
      vouchAsCreator: isPersonsOwnSession(req),
      name: requiredString(input.name, "name", 120),
      description: optionalString(input.description, "description"),
      provider,
      authMode,
      endpointUrl: requiredString(input.endpointUrl, "endpointUrl", 2_000),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(input.headers !== undefined ? { headers: optionalHeaders(input.headers)! } : {}),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.post("/servers/test-configuration", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const input = body(req);
    const authMode = optionalAuthMode(input.authMode);
    if (authMode === "oauth") {
      throw new ManagedMcpCredentialError("OAuth connections must be saved before connecting", "managed_mcp_credential_invalid");
    }
    const tools = await testManagedMcpConfiguration({
      serverId: req.serverId!,
      ...(typeof input.mcpServerId === "string" && input.mcpServerId.trim()
        ? { mcpServerId: requiredString(input.mcpServerId, "mcpServerId", 64) }
        : {}),
      endpointUrl: requiredString(input.endpointUrl, "endpointUrl", 2_000),
      ...(authMode ? { authMode } : {}),
      ...(input.headers !== undefined ? { headers: optionalHeaders(input.headers)! } : {}),
      ...(input.credentialPatch !== undefined ? { credentialPatch: optionalCredentialPatch(input.credentialPatch)! } : {}),
    });
    res.json({ tools });
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.patch("/servers/:mcpServerId", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const input = body(req);
    res.json(await updateManagedMcpServer({
      serverId: req.serverId!,
      userId: req.userId!,
      mcpServerId: pathParam(req.params.mcpServerId),
      ...(input.name !== undefined ? { name: requiredString(input.name, "name", 120) } : {}),
      ...(input.description !== undefined ? { description: optionalString(input.description, "description") } : {}),
      ...(input.provider !== undefined ? { provider: optionalProvider(input.provider)! } : {}),
      ...(input.authMode !== undefined ? { authMode: optionalAuthMode(input.authMode)! } : {}),
      ...(input.endpointUrl !== undefined ? { endpointUrl: requiredString(input.endpointUrl, "endpointUrl", 2_000) } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(input.headers !== undefined ? { headers: optionalHeaders(input.headers)! } : {}),
      ...(input.credentialPatch !== undefined ? { credentialPatch: optionalCredentialPatch(input.credentialPatch)! } : {}),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.delete("/servers/:mcpServerId", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    await deleteManagedMcpServer(req.serverId!, pathParam(req.params.mcpServerId));
    res.status(204).end();
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.post("/servers/:mcpServerId/test", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    res.json(await refreshManagedMcpCatalog(req.serverId!, pathParam(req.params.mcpServerId)));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.post("/servers/:mcpServerId/oauth/start", requirePersonsOwnSession, requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const redirectUrl = new URL(MANAGED_MCP_OAUTH_CALLBACK_PATH, managedMcpServerOrigin()).toString();
    sendManagedMcpOAuthStart(res, await startManagedMcpOAuthConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      mcpServerId: pathParam(req.params.mcpServerId),
      redirectUrl,
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.delete("/servers/:mcpServerId/oauth", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    await disconnectManagedMcpOAuthConnection(req.serverId!, pathParam(req.params.mcpServerId));
    res.status(204).end();
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * Starts a sign-in for one Connection of an App: a new Connection (`name`) or an existing one
 * (`connectionId`, reauthorize; the row is reused). A new Connection is written as `pending` before
 * the provider is contacted and is removed again if the start fails.
 */
/**
 * Member-triggered account writes (RFC 087), keyed by Server + person like the other per-person
 * limiters here (probeLimiter) and in assistantWeChat.ts: a personal sign-in start writes a pending
 * row and contacts the provider; the agents API writes grants and notifies people. In-memory, per
 * replica, as every limiter in this server.
 */
const personalStartRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mcp-personal-start:${req.serverId ?? "none"}:${req.userId ?? "none"}`,
  message: { error: "Too many sign-ins started; wait a minute", code: "managed_mcp_rate_limited" },
});
const accountWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mcp-account-agents:${req.serverId ?? "none"}:${req.userId ?? "none"}`,
  message: { error: "Too many account changes; wait a minute", code: "managed_mcp_rate_limited" },
});
/** Only a personal sign-in spends the personal start budget; a shared one is the admins' as before. */
const personalStartLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (body(req).kind === "personal") {
    void personalStartRateLimit(req, res, next);
    return;
  }
  next();
};

/**
 * `kind: "personal"` (RFC 087 §7.1): the caller's own Connection, a member who is not a guest, in
 * their own session, while the Server flag and the App's members_can_connect are on (OAuth Apps
 * only); `intent.agentIds` are given it at the callback, re-checked then. Otherwise (`shared`, the
 * default) the admins' as before; while the flag is on a shared sign-in may name `intent.agentIds`
 * too (the Connect card's agent), pinned at the callback after the same re-check. Either way the
 * kind is stored in the attempt's intent.
 */
function oauthStartKind(req: Request): "personal" | "shared" {
  const kind = body(req).kind;
  if (kind === undefined || kind === "shared") return "shared";
  if (kind === "personal") return "personal";
  throw new ManagedMcpCredentialError("kind must be personal or shared", "managed_mcp_credential_invalid");
}

function requireOAuthStartAuthority() {
  const integrations = requireCapability("manageIntegrations");
  const externalAuth = requireCapability("manageExternalAuth");
  return (req: Request, res: Response, next: NextFunction) => {
    let kind: "personal" | "shared";
    try {
      kind = oauthStartKind(req);
    } catch (error) {
      sendManagedMcpError(error, res, next);
      return;
    }
    // A personal sign-in's authority is the person's own (checked in the handler).
    if (kind === "personal") {
      next();
      return;
    }
    void integrations(req, res, (error?: unknown) => (error ? next(error) : void externalAuth(req, res, next)));
  };
}

managedMcpRouter.post(
  "/apps/:appId/connections/oauth/start",
  requirePersonsOwnSession,
  requireOAuthStartAuthority(),
  personalStartLimiter,
  async (req, res, next) => {
    try {
      const input = body(req);
      const kind = oauthStartKind(req);
      const appId = pathParam(req.params.appId);
      const connectionId = input.connectionId === undefined ? undefined : requiredUuid(input.connectionId, "connectionId");
      if (input.makeDefault !== undefined && typeof input.makeDefault !== "boolean") {
        throw new ManagedMcpCredentialError("makeDefault must be a boolean", "managed_mcp_credential_invalid");
      }
      const rawIntent = typeof input.intent === "object" && input.intent !== null && !Array.isArray(input.intent)
        ? input.intent as Record<string, unknown>
        : null;
      let agentIds: string[] | undefined;
      if (kind === "personal") {
        const refusal = await personalSignInRefusal(getDb(), { serverId: req.serverId!, appId, userId: req.userId! });
        if (refusal) throw new ManagedMcpServiceError(PERSONAL_ACCOUNT_REFUSAL_MESSAGES[refusal], refusal);
        if (input.makeDefault === true) {
          throw new ManagedMcpServiceError("A member's own account can't be the App's default Connection.", "managed_mcp_connection_request_invalid");
        }
        if (rawIntent?.agentIds !== undefined) {
          agentIds = agentIdList(rawIntent.agentIds, "intent.agentIds");
          // Checked now as the agents API would; the callback checks again.
          await requireAgentsVisibleTo(getDb(), req.serverId!, req.userId!, agentIds);
        }
      } else if (rawIntent?.agentIds !== undefined) {
        // RFC 087 §7.1: the Connect card's "connect a new shared account" for its agent. Behind the
        // flag (off: refused as before). The starter manages external auth (requireOAuthStartAuthority);
        // the callback pins them, asking manageExternalAuth and the agents again then.
        if (!await mcpPersonalAccountsEnabled(req.serverId!)) {
          throw new ManagedMcpServiceError("A shared sign-in doesn't choose agents; pin them after it.", "managed_mcp_connection_request_invalid");
        }
        agentIds = agentIdList(rawIntent.agentIds, "intent.agentIds");
        await requireAgentsVisibleTo(getDb(), req.serverId!, req.userId!, agentIds);
      }
      const intent: ManagedMcpOAuthIntent = {
        kind,
        ...(input.makeDefault === true ? { makeDefault: true } : {}),
        ...(await optionalOAuthIntentOrigin(req.serverId!, rawIntent ? { ...rawIntent, agentIds: undefined } : input.intent)),
        ...(agentIds && agentIds.length > 0 ? { agentIds } : {}),
      };
      const redirectUrl = new URL(MANAGED_MCP_OAUTH_CALLBACK_PATH, managedMcpServerOrigin()).toString();
      sendManagedMcpOAuthStart(res, await startManagedMcpOAuthConnection({
        serverId: req.serverId!,
        userId: req.userId!,
        mcpServerId: appId,
        redirectUrl,
        oauthClient: normalizeManagedMcpOAuthClient(input.oauthClient),
        connection: connectionId !== undefined
          ? { connectionId }
          : { newConnectionName: requiredString(input.name, "name", 120) },
        intent,
      }));
    } catch (error) {
      sendManagedMcpError(error, res, next);
    }
  },
);

/**
 * Signs a Connection out (tokens deleted, the Connection kept): a shared one by those who manage
 * integrations and external auth, as before; a member's own one by its owner, or by an admin (a
 * revoke: audited, the owner told), in the person's own session (signOutMcpConnection).
 */
managedMcpRouter.delete(
  "/apps/:appId/connections/:connectionId/oauth",
  async (req, res, next) => {
    try {
      const appId = pathParam(req.params.appId);
      const connectionId = pathParam(req.params.connectionId);
      if (await mcpConnectionKind(req.serverId!, connectionId, appId) === "personal" && refuseUnlessPersonsOwnSession(req, res)) return;
      await signOutMcpConnection({ serverId: req.serverId!, appId, connectionId, actorUserId: req.userId! });
      res.status(204).end();
    } catch (error) {
      sendFencedManagedMcpError(error, res, next);
    }
  },
);

// Raft's recommended Apps. listMcpAppTemplates reads the admin-curated catalog (mcp_app_templates)
// and falls back to the bundled JSON on a read error, so the route never 500s on a catalog miss.
// Each template is annotated `installed` when this server already has an App created from it, so the
// picker can mark it instead of letting the user hit the name-unique error on submit. The installed
// lookup is wrapped in its own try: a read error there must degrade to `installed: false`, never 500.
managedMcpRouter.get("/app-templates", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const templates = await listMcpAppTemplates();
    let installedKeys = new Set<string>();
    try {
      const rows = await getDb()
        .select({ templateKey: managedMcpServers.templateKey })
        .from(managedMcpServers)
        .where(and(eq(managedMcpServers.serverId, req.serverId!), isNotNull(managedMcpServers.templateKey)));
      installedKeys = new Set(rows.map((row) => row.templateKey!));
    } catch (installedLookupError) {
      console.error("mcp.app_templates.installed_lookup_failed", installedLookupError);
    }
    res.json({ templates: templates.map((template) => ({ ...template, logoUrl: clientLogoUrl(template.logoUrl), installed: installedKeys.has(template.key) })) });
  } catch (error) {
    next(error);
  }
});

/**
 * Outbound-request budget for the routes that contact an arbitrary MCP server on a manager's behalf:
 * `POST /probe`, `POST /apps` with a URL source (it re-probes server-side) and
 * `POST /apps/:appId/refresh`. ONE limiter instance, so the three share one budget per key.
 *
 * Keyed by Raft server + user, on top of the capability gate. The store is express-rate-limit's
 * in-memory default, so the budget is per replica (N replicas allow up to N x max): the same trade-off
 * every other limiter in this server makes, as none uses a shared store. The SSRF-safe fetch, the
 * 15 s probe deadline and the manageIntegrations gate bound what one request can do.
 */
const probeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.serverId ?? "none"}:${req.userId ?? "none"}`,
  message: { error: "Too many MCP server checks; wait a minute", code: "managed_mcp_probe_rate_limited" },
});

managedMcpRouter.post("/probe", requireCapability("manageIntegrations"), probeLimiter, async (req, res, next) => {
  try {
    res.json(await probeManagedMcpEndpoint(requiredString(body(req).endpointUrl, "endpointUrl", 2_000)));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

function requiredAppSource(value: unknown): McpAppSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpCredentialError("source is required", "managed_mcp_credential_invalid");
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "url") return { kind: "url", endpointUrl: requiredString(source.endpointUrl, "source.endpointUrl", 2_000) };
  if (source.kind === "template") {
    return {
      kind: "template",
      templateKey: requiredString(source.templateKey, "source.templateKey", 64),
      ...(source.endpointUrl !== undefined ? { endpointUrl: String(source.endpointUrl) } : {}),
    };
  }
  throw new ManagedMcpCredentialError("source.kind must be url or template", "managed_mcp_credential_invalid");
}

function optionalProfile(value: unknown): McpAppProfileInput {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpCredentialError("profile must be an object", "managed_mcp_credential_invalid");
  }
  return value as McpAppProfileInput;
}

managedMcpRouter.get("/apps", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    res.json({ apps: await listMcpApps(req.serverId!, req.userId!) });
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/** Only a URL source makes outbound requests; creating from a template does not spend the budget. */
const probeLimiterForUrlSource = (req: Request, res: Response, next: NextFunction) => {
  const source = body(req).source;
  if (typeof source === "object" && source !== null && (source as { kind?: unknown }).kind === "url") {
    probeLimiter(req, res, next);
    return;
  }
  next();
};

managedMcpRouter.post("/apps", requireCapability("manageIntegrations"), probeLimiterForUrlSource, async (req, res, next) => {
  try {
    const input = body(req);
    res.status(201).json(await createMcpApp({
      serverId: req.serverId!,
      userId: req.userId!,
      // A server owner or admin creating it vouches for it; insertMcpAppRow checks the capability.
      vouchAsCreator: isPersonsOwnSession(req),
      source: requiredAppSource(input.source),
      profile: optionalProfile(input.profile),
      ...(input.authKind !== undefined ? { authKind: optionalAuthMode(input.authKind)! } : {}),
      ...(input.requiredHeaderNames !== undefined ? { requiredHeaderNames: input.requiredHeaderNames } : {}),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.get("/apps/:appId", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    res.json(await getMcpAppView(req.serverId!, pathParam(req.params.appId), req.userId!));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.patch("/apps/:appId", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    res.json(await updateMcpApp({
      serverId: req.serverId!,
      userId: req.userId!,
      appId: pathParam(req.params.appId),
      patch: body(req),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * Vouch for this Server's MCP App, or end the vouch: `{ vouched: boolean }`. A vouched App is
 * granted to every agent here automatically (mcpAutoGrantCoversAgent), whatever its creator's role.
 * manageExternalAuth, as granting an agent an App; a person's own session only (never delegable,
 * no agent API); vouching asks the approver's second step. Ending it stops future automatic grants
 * only: assignment rows already written stay (setMcpAppServerVouch). Answers the App view.
 */
managedMcpRouter.put("/apps/:appId/server-vouch", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    if (!isPersonsOwnSession(req)) {
      refuse(res, 403, { code: "SERVER_VOUCH_PERSON_ONLY", error: "Only a server owner or admin, signed in themselves, can vouch for an App." });
      return;
    }
    const vouched = body(req).vouched;
    if (typeof vouched !== "boolean") {
      throw new ManagedMcpCredentialError("vouched must be a boolean", "managed_mcp_credential_invalid");
    }
    // Vouching lets every agent here use the App: the same second step as approving one agent's access.
    if (vouched && await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before letting every agent use this app.")) return;
    const appId = pathParam(req.params.appId);
    const result = await setMcpAppServerVouch({ serverId: req.serverId!, appId, actorUserId: req.userId!, vouched });
    if (result.status === "not_found") throw new ManagedMcpServiceError("MCP App not found", "managed_mcp_server_not_found");
    res.json(await getMcpAppView(req.serverId!, appId, req.userId!));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * "Members can connect their own account" for this App (RFC 087 D1): `{ enabled: boolean }`.
 * manageIntegrations + manageExternalAuth, a person's own session, while the Server flag
 * `mcp_personal_accounts` is on (409 otherwise). Off stops new personal Connections only; existing
 * ones and their agents stay (Q26). Audited when it changes. Answers the App view.
 */
managedMcpRouter.put(
  "/apps/:appId/members-can-connect",
  requireCapability("manageIntegrations"),
  requireCapability("manageExternalAuth"),
  async (req, res, next) => {
    try {
      if (refuseUnlessPersonsOwnSession(req, res)) return;
      const enabled = body(req).enabled;
      if (typeof enabled !== "boolean") {
        throw new ManagedMcpCredentialError("enabled must be a boolean", "managed_mcp_credential_invalid");
      }
      if (!await mcpPersonalAccountsEnabled(req.serverId!)) {
        throw new ManagedMcpServiceError(PERSONAL_ACCOUNT_REFUSAL_MESSAGES.managed_mcp_personal_accounts_off, "managed_mcp_personal_accounts_off");
      }
      const appId = pathParam(req.params.appId);
      await withActorMembershipFence(req.serverId!, req.userId!, async (tx, lockedRole) => {
        if (!actorRoleHasServerCapability(lockedRole, "manageIntegrations") || !actorRoleHasServerCapability(lockedRole, "manageExternalAuth")) {
          throw new FencedAuthorizationDeniedError("forbidden");
        }
        await setMembersCanConnect(tx, { serverId: req.serverId!, appId, actorUserId: req.userId!, actorRole: lockedRole, enabled });
      });
      res.json(await getMcpAppView(req.serverId!, appId, req.userId!));
    } catch (error) {
      sendFencedManagedMcpError(error, res, next);
    }
  },
);

managedMcpRouter.post("/apps/:appId/refresh", requireCapability("manageIntegrations"), probeLimiter, async (req, res, next) => {
  try {
    res.json(await refreshMcpApp(req.serverId!, pathParam(req.params.appId), req.userId!));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.delete("/apps/:appId", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    await deleteMcpApp(req.serverId!, pathParam(req.params.appId));
    res.status(204).end();
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/** An MCP App's logo: same upload, size limit, formats and storage as an ordinary App's. */
managedMcpRouter.post("/apps/:appId/logo", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const file = await runSingleLogoUpload(req);
    if (!file) {
      res.status(400).json({ error: "No logo file provided" });
      return;
    }
    res.json(await updateMcpAppLogo({ serverId: req.serverId!, userId: req.userId!, appId: pathParam(req.params.appId), fileBuffer: file.buffer }));
  } catch (error) {
    if (handleLogoUploadError(error, res)) return;
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.delete("/apps/:appId/logo", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    res.json(await clearMcpAppLogo({ serverId: req.serverId!, userId: req.userId!, appId: pathParam(req.params.appId) }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.get("/apps/:appId/connections", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    res.json({ connections: await listManagedMcpConnections(req.serverId!, pathParam(req.params.appId)) });
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/** An API-key Connection. The handshake runs first; a refused or unreachable server writes nothing. */
managedMcpRouter.post("/apps/:appId/connections", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const input = body(req);
    if (input.makeDefault !== undefined && typeof input.makeDefault !== "boolean") {
      throw new ManagedMcpCredentialError("makeDefault must be a boolean", "managed_mcp_credential_invalid");
    }
    const closedCards: string[] = [];
    const created = await createManagedMcpHeaderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      mcpServerId: pathParam(req.params.appId),
      name: requiredString(input.name, "name", 120),
      headers: optionalHeaders(input.headers) ?? {},
      makeDefault: input.makeDefault === true,
    }, {}, closedCards);
    await announceClosedConnectCards(req, closedCards, req.userId!);
    res.status(201).json(created);
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * Renames a Connection or replaces its key: a shared one by those who manage integrations; a
 * member's own one by its owner only (a name only), in their own session (RFC 087 §6).
 */
managedMcpRouter.patch("/apps/:appId/connections/:connectionId", async (req, res, next) => {
  try {
    const input = body(req);
    const kind = await assertMayEditMcpConnection({
      serverId: req.serverId!,
      appId: pathParam(req.params.appId),
      connectionId: pathParam(req.params.connectionId),
      actorUserId: req.userId!,
      replacesKey: input.headers !== undefined,
    });
    if (kind === "personal" && refuseUnlessPersonsOwnSession(req, res)) return;
    const closedCards: string[] = [];
    const updated = await updateManagedMcpConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      mcpServerId: pathParam(req.params.appId),
      connectionId: pathParam(req.params.connectionId),
      ...(input.name !== undefined ? { name: requiredString(input.name, "name", 120) } : {}),
      ...(input.headers !== undefined ? { headers: optionalHeaders(input.headers)! } : {}),
    }, {}, closedCards);
    await announceClosedConnectCards(req, closedCards, req.userId!);
    res.json(updated);
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * Deletes a Connection (the App-scoped route), the same rule as DELETE /connections/:connectionId:
 * a shared one by those who manage integrations, a member's own by its owner or an admin (a revoke:
 * its owner told); a person's own session; tokens go first. Agents pinned to a deleted shared one
 * are refused from then on and do NOT fall back to the server default (the dead-pin rule); if it
 * was the default, the App has none until one is set.
 */
managedMcpRouter.delete("/apps/:appId/connections/:connectionId", async (req, res, next) => {
  try {
    if (refuseUnlessPersonsOwnSession(req, res)) return;
    await deleteMcpConnection({
      serverId: req.serverId!,
      appId: pathParam(req.params.appId),
      connectionId: pathParam(req.params.connectionId),
      actorUserId: req.userId!,
    });
    res.status(204).end();
  } catch (error) {
    sendFencedManagedMcpError(error, res, next);
  }
});

/**
 * The accounts of this Server (RFC 087 §7.2): `{ mine, shared?, members?, personalAccounts }`.
 * Everyone who may view agents gets their own personal Connections; those who manage integrations
 * also every shared one and every other member's (D5). Agents a viewer can't find are left out.
 */
managedMcpRouter.get("/accounts", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    res.json(await listMcpAccounts(req.serverId!, req.userId!));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/**
 * Which Agents use this Connection (RFC 087 §6, §7.2): `{ allAgents?: boolean, agentIds: string[] }`.
 * A member's own Connection: its owner, while the Server flag is on (personal grants; a grant on
 * another member's agent moves it; `allAgents` refused). A shared one: manageExternalAuth
 * (`allAgents: true` makes it the default; `agentIds` are its pins). A person's own session, under
 * the membership fence. Answers what changed, including the Agents moved from another account.
 */
managedMcpRouter.put("/connections/:connectionId/agents", accountWriteLimiter, async (req, res, next) => {
  try {
    if (refuseUnlessPersonsOwnSession(req, res)) return;
    const input = body(req);
    if (input.allAgents !== undefined && typeof input.allAgents !== "boolean") {
      throw new ManagedMcpCredentialError("allAgents must be a boolean", "managed_mcp_credential_invalid");
    }
    const agentIds = input.agentIds === undefined ? [] : agentIdList(input.agentIds, "agentIds");
    const closedCards: string[] = [];
    const written = await withActorMembershipFence(req.serverId!, req.userId!, (tx, lockedRole) => setMcpConnectionAgents(tx, {
      serverId: req.serverId!,
      connectionId: pathParam(req.params.connectionId),
      actorUserId: req.userId!,
      actorRole: lockedRole,
      ...(input.allAgents !== undefined ? { allAgents: input.allAgents as boolean } : {}),
      agentIds,
    }, closedCards));
    await announceClosedConnectCards(req, closedCards, req.userId!);
    if (written.personal?.notice) await notifyPersonalGrants(written.personal.notice);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    for (const agentId of written.changedAgentIds) {
      await orchestrator?.applyAgentConfig(agentId, { fallbackRestartMode: "restart" });
    }
    res.json(written.result);
  } catch (error) {
    sendFencedManagedMcpError(error, res, next);
  }
});

/**
 * The Connect card's "use this account" (RFC 087 §7.1, D6): this Agent uses this Connection, and
 * the Connection keeps its other Agents (setMcpConnectionAgents `add`). No body.
 * A member's own Connection: its owner only, while the Server flag is on, an Agent they can find
 * (personal grant; a grant replacing another member's moves it; the agent's owner and the admins
 * told). A shared one: manageExternalAuth (a pin; the App's default is not touched; `enabled` is
 * left alone). A person's own session, under the membership fence. Closes the card it satisfies.
 * An Agent the caller can't find answers 404 (hideUnfindableAgentsByParam).
 */
managedMcpRouter.put("/connections/:connectionId/agents/:agentId", requirePersonsOwnSession, accountWriteLimiter, async (req, res, next) => {
  try {
    const closedCards: string[] = [];
    const written = await withActorMembershipFence(req.serverId!, req.userId!, (tx, lockedRole) => setMcpConnectionAgents(tx, {
      serverId: req.serverId!,
      connectionId: pathParam(req.params.connectionId),
      actorUserId: req.userId!,
      actorRole: lockedRole,
      agentIds: [pathParam(req.params.agentId)],
      mode: "add",
    }, closedCards));
    await announceClosedConnectCards(req, closedCards, req.userId!);
    if (written.personal?.notice) await notifyPersonalGrants(written.personal.notice);
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    for (const agentId of written.changedAgentIds) await orchestrator?.applyAgentConfig(agentId, { fallbackRestartMode: "restart" });
    res.json(written.result);
  } catch (error) {
    sendFencedManagedMcpError(error, res, next);
  }
});

/**
 * Deletes a Connection (RFC 087 §6, §7.2): a member's own by its owner or an admin (revoke; the
 * owner is told), a shared one by those who manage integrations. A person's own session. Tokens go
 * first, then the row; its personal grants go with it and those Agents fall back to their shared account.
 */
managedMcpRouter.delete("/connections/:connectionId", async (req, res, next) => {
  try {
    if (refuseUnlessPersonsOwnSession(req, res)) return;
    await deleteMcpConnection({
      serverId: req.serverId!,
      connectionId: pathParam(req.params.connectionId),
      actorUserId: req.userId!,
    });
    res.status(204).end();
  } catch (error) {
    sendFencedManagedMcpError(error, res, next);
  }
});

managedMcpRouter.get("/apps/:appId/default/impact", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const raw = req.query.connectionId;
    res.json(await describeManagedMcpDefaultImpact({
      serverId: req.serverId!,
      mcpServerId: pathParam(req.params.appId),
      connectionId: raw === undefined || raw === "" ? null : requiredUuid(raw, "connectionId"),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/** `{connectionId}` becomes the App's server default (`null`: none). Closes the cards it satisfies. */
managedMcpRouter.put("/apps/:appId/default", requireCapability("manageIntegrations"), async (req, res, next) => {
  try {
    const input = body(req);
    if (!("connectionId" in input)) {
      throw new ManagedMcpCredentialError("connectionId is required (null for no default)", "managed_mcp_credential_invalid");
    }
    const connectionId = input.connectionId === null ? null : requiredUuid(input.connectionId, "connectionId");
    const mcpServerId = pathParam(req.params.appId);
    const closedCards: string[] = [];
    const actorRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    // Audited by setServerDefaultConnection (`mcp_connection.agents_changed`, `allAgents`).
    const result = await getDb().transaction((tx) => setServerDefaultConnection(tx, {
      serverId: req.serverId!,
      mcpServerId,
      connectionId,
      userId: req.userId!,
      actorRole,
      via: "default",
    }, closedCards));
    await announceClosedConnectCards(req, closedCards, req.userId!);
    res.json({ ...result, connections: await listManagedMcpConnections(req.serverId!, mcpServerId) });
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

/** Only the user who started the sign-in can read it; anyone else gets the not-found answer. */
managedMcpRouter.get("/oauth/attempts/:attemptId", async (req, res, next) => {
  try {
    res.json(await getManagedMcpOAuthAttemptStatus({
      serverId: req.serverId!,
      userId: req.userId!,
      attemptId: pathParam(req.params.attemptId),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

// Granting, revoking and choosing an MCP App's Connection for one Agent: the agent's creator or
// whoever manages external auth, exactly who may grant or revoke an ordinary App for it
// (`canManageAgentAccess` in routes/integrations.ts). Changing which shared Connection it uses (a pin,
// or back to the default) is the admins' alone (`assertMayChangeBinding`, RFC 087 §6).
managedMcpRouter.put("/agents/:agentId/assignments/:mcpServerId", requirePersonsOwnSession, requireAgentCapabilityOrCreator("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = body(req);
    // Every field is optional and an omitted one is left as it is, so a control that only changes the
    // Connection cannot lift a tool restriction or switch an Agent back on.
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new ManagedMcpCredentialError("enabled must be a boolean", "managed_mcp_credential_invalid");
    }
    const agentId = pathParam(req.params.agentId);
    const allowedTools = optionalAllowedTools(input.allowedTools);
    const connectionId = optionalConnectionId(input.connectionId);
    const enabled = input.enabled as boolean | undefined;
    // Task #91: re-authorize the assignment write inside the write transaction under a share lock on the caller's
    // membership row (member row first), then the agent row (same predicate as requireAgentCapabilityOrCreator).
    const closedCards: string[] = [];
    const view = await withActorMembershipFence(req.serverId!, req.userId!, async (tx, lockedRole) => {
      const [lockedAgent] = await tx
        .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.serverId, req.serverId!)))
        .for("share");
      if (!lockedAgent || !userCanActOnAgentResource(lockedRole, req.userId!, lockedAgent, "manageExternalAuth")) {
        throw new FencedAuthorizationDeniedError(lockedAgent ? "forbidden" : "not_found");
      }
      await assertMayChangeBinding(tx, lockedRole, agentId, [{ mcpServerId: pathParam(req.params.mcpServerId), connectionId }]);
      const pinsAsked = connectionId === undefined ? [] : [{ agentId, mcpServerId: pathParam(req.params.mcpServerId) }];
      const pinsBefore = await readSharedPins(tx, req.serverId!, pinsAsked);
      const assigned = await setManagedMcpAssignment({
        serverId: req.serverId!,
        userId: req.userId!,
        agentId,
        mcpServerId: pathParam(req.params.mcpServerId),
        enabled,
        allowedTools,
        connectionId,
      }, { executor: tx, closedCards });
      // RFC 087 §7.4: a pin changed is `mcp_connection.agents_changed` (who added the Connection, too).
      await auditSharedPinChanges(tx, {
        serverId: req.serverId!,
        actorUserId: req.userId!,
        actorRole: lockedRole,
        before: pinsBefore,
        after: await readSharedPins(tx, req.serverId!, pinsAsked),
        via: "assignments",
      });
      await bumpAgentConfigRevision(tx, [agentId]);
      return assigned;
    });
    await announceClosedConnectCards(req, closedCards, req.userId!);
    // Reconciler step 11b + #proj-runtime:#80: push to capable daemons, or run
    // the idle-safe server fallback restart on older Computers.
    await (req.app.get("agentOrchestrator") as AgentOrchestrator | undefined)?.applyAgentConfig(agentId, { fallbackRestartMode: "restart" });
    // task #1357 item 1: the revision moved, so a limits status is pending now.
    await (req.app.get("agentOrchestrator") as AgentOrchestrator | undefined)?.notifyModelLimitsChanged?.({ agentIds: [agentId] });
    res.json(view);
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      res.status(403).json({ error: "manageExternalAuth capability or agent creator authority required", code: "managed_mcp_forbidden" });
      return;
    }
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.put("/agents/:agentId/assignments", requirePersonsOwnSession, requireAgentCapabilityOrCreator("manageExternalAuth"), async (req, res, next) => {
  try {
    const agentId = pathParam(req.params.agentId);
    const assignments = requiredAssignmentUpdates(body(req).assignments);
    // Task #91: the bulk write re-authorizes inside its transaction exactly like the single assignment route (member
    // row share lock first, then the agent row). The catalog read-back and the Agent restart run after commit; the
    // restart is a runtime effect that task #93 fences.
    const closedCards: string[] = [];
    await withActorMembershipFence(req.serverId!, req.userId!, async (tx, lockedRole) => {
      const [lockedAgent] = await tx
        .select({ creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.serverId, req.serverId!)))
        .for("share");
      if (!lockedAgent || !userCanActOnAgentResource(lockedRole, req.userId!, lockedAgent, "manageExternalAuth")) {
        throw new FencedAuthorizationDeniedError(lockedAgent ? "forbidden" : "not_found");
      }
      await assertMayChangeBinding(tx, lockedRole, agentId, assignments);
      const pinsAsked = assignments
        .filter((assignment) => assignment.connectionId !== undefined)
        .map((assignment) => ({ agentId, mcpServerId: assignment.mcpServerId }));
      const pinsBefore = await readSharedPins(tx, req.serverId!, pinsAsked);
      await writeManagedMcpAssignments({
        serverId: req.serverId!,
        userId: req.userId!,
        agentId,
        assignments,
      }, { executor: tx, closedCards });
      await auditSharedPinChanges(tx, {
        serverId: req.serverId!,
        actorUserId: req.userId!,
        actorRole: lockedRole,
        before: pinsBefore,
        after: await readSharedPins(tx, req.serverId!, pinsAsked),
        via: "assignments",
      });
      await bumpAgentConfigRevision(tx, [agentId]);
    });
    await announceClosedConnectCards(req, closedCards, req.userId!);
    const catalog = await listAgentManagedMcpCatalog(req.serverId!, agentId);
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // Reconciler step 11b + #proj-runtime:#80: push to capable daemons, or run
    // the idle-safe server fallback restart on older Computers (never kills a
    // running foreground turn).
    await agentOrchestrator.applyAgentConfig(agentId, { fallbackRestartMode: "restart" });
    await agentOrchestrator.notifyModelLimitsChanged?.({ agentIds: [agentId] });
    res.json(catalog);
  } catch (error) {
    if (error instanceof ServerMembershipRevokedError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof FencedAuthorizationDeniedError) {
      res.status(403).json({ error: "manageExternalAuth capability or agent creator authority required", code: "managed_mcp_forbidden" });
      return;
    }
    sendManagedMcpError(error, res, next);
  }
});

managedMcpOAuthCallbackRouter.get("/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  // One callback per sign-in: whatever happens next, this browser's binding is spent.
  if (state) res.append("Set-Cookie", clearManagedMcpOAuthBindingCookie(state));
  if (!state || !code || typeof req.query.error === "string") {
    await failManagedMcpOAuthAttempt(state);
    sendManagedMcpOAuthResultPage(res, 400, "cancelled");
    return;
  }
  // Only the browser that started the sign-in may finish it. Anyone else who
  // opens the authorization link would otherwise attach their own account to
  // the starter's Connection; the attempt fails and nothing is stored.
  if (!managedMcpOAuthCallbackIsBound(req.headers.cookie, state)) {
    await failManagedMcpOAuthAttempt(state);
    sendManagedMcpOAuthResultPage(res, 400, "failed");
    return;
  }
  try {
    const closedCards: string[] = [];
    const completion = await completeManagedMcpOAuthCallback({ state, authorizationCode: code }, closedCards);
    // The sign-in's starter is who satisfied the cards (the callback carries no session).
    await announceClosedConnectCards(req, closedCards, completion.userId);
    // Agents a personal sign-in was given to take their new config automatically.
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    for (const agentId of completion.changedAgentIds) {
      await orchestrator?.applyAgentConfig(agentId, { fallbackRestartMode: "restart" });
    }
    sendManagedMcpOAuthResultPage(res, 200, "connected", completion.attemptId);
  } catch (error) {
    // The page stays generic; the Connection's status line and this log carry the provider's reason.
    console.warn("mcp.oauth.callback_failed", {
      code: (error as { code?: unknown } | null)?.code ?? null,
      detail: managedMcpOAuthFailureDetail(error) ?? (error instanceof Error ? error.name : "unknown"),
    });
    sendManagedMcpOAuthResultPage(res, 400, "failed");
  }
});

managedMcpOAuthCallbackRouter.get("/client-metadata", (_req, res) => {
  const clientId = new URL("/api/mcp/oauth/client-metadata", managedMcpServerOrigin()).toString();
  res.set("Cache-Control", "no-store");
  res.json({
    client_id: clientId,
    client_name: "Raft Managed MCP",
    redirect_uris: [new URL("/api/mcp/oauth/callback", managedMcpServerOrigin()).toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});
