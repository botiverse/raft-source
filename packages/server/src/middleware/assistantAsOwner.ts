/**
 * A personal assistant acting as its owner on the owner's own web route
 * (#proj-assistant:#19; the table and its rules: services/assistantOwnerActions.ts).
 *
 * requireAuth hands an `sk_agent_*` bearer here. It is answered as the owner
 * only when every link holds: the credential is live, its agent is a personal
 * assistant whose owner link is live (flag on, owner still a member, not
 * paused), the owner's account is live, the method and path are a `direct`
 * table entry, the request has no query and only the entry's body fields, any
 * `X-Server-Id` is the assistant's server, and the entry admits the target
 * (in the assistant's server). Then `req.userId` is the owner,
 * `req.sessionScope` is `assistant_as_owner` (never `full`; no session family)
 * and `req.viaAssistant` says who acted. Anything else is refused here, before
 * any handler runs; nothing else about requireAuth changes.
 *
 * After a 2xx the response gains `assistant: { done, undo }` (Raft's text, the
 * client passes it through), and a change is audited as
 * `assistant.owner_action` (actor the assistant, subject the owner).
 *
 * A `read` entry (a GET; assistantOwnerReads.ts) may take its own query
 * options and answers only
 * `assistant: { text }`, Raft's text from the route's JSON (never the JSON);
 * audited as `assistant.owner_read` with the tool only.
 */
import { ASSISTANT_OWNER_SSO_REQUIRED_BODY, assistantOwnerPassesSso } from "../services/sso/ssoEnforcement";
import type { Request, Response, NextFunction } from "express";
import type { Server as SocketServer } from "socket.io";
import { isOwnerDispatch } from "../services/assistantOwnerActionCards";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { accountDeletionRequests, agents, servers, users } from "../db/schema";
import { findAgentCredentialByApiKey } from "../services/agentCredentialService";
import { isAssistantPaused, resolveAssistantOwner } from "../services/assistantService";
import {
  ASSISTANT_OWNER_ACTION_EVENT,
  matchAssistantOwnerAction,
  matchAssistantOwnerActionRoute,
  ownerLabel,
  type AssistantOwnerActionRequestScope,
} from "../services/assistantOwnerActions";
import { recordIntegrationAuditEventBestEffort } from "../services/integrationAuditService";
import { OWNER_READ_FILTER_MAX } from "../services/assistantOwnerReads";
import { addTraceEvent } from "../tracing/semanticTrace";
import { isUnambiguousTarget, respondInvalidOrExpiredToken } from "./auth";

export const ASSISTANT_OWNER_ACTION_NOT_ALLOWED_CODE = "assistant_owner_action_not_allowed";
export const ASSISTANT_OWNER_ACTION_TARGET_NOT_FOUND_CODE = "assistant_owner_action_target_not_found";

export { ASSISTANT_OWNER_ACTION_EVENT };

const NOT_ALLOWED_BODY = {
  error: "This isn't one of the things you can do as your owner: the owner-action tools you were given are the full list.",
  code: ASSISTANT_OWNER_ACTION_NOT_ALLOWED_CODE,
  suggestedNextAction: "Use one of your owner actions, or tell your owner they can do this themselves in Raft. Retrying will not help.",
} as const;

/** The audit event of a read: who read which tool, never what it read. */
export const ASSISTANT_OWNER_READ_EVENT = "assistant.owner_read" as const;

const TARGET_NOT_FOUND_BODY = {
  error: "Your owner can't see that here. Use a channel of this server they can see.",
  code: ASSISTANT_OWNER_ACTION_TARGET_NOT_FOUND_CODE,
} as const;

/**
 * Any agent key that is not a live personal assistant gets exactly what an
 * agent key on a web route got before #19: 401, the ordinary token body.
 */
function notALiveAssistant(res: Response, reason: string): void {
  addTraceEvent("assistant_as_owner.refused", { reason });
  respondInvalidOrExpiredToken(res);
}

function refuse(res: Response, status: number, body: object, reason: string): void {
  addTraceEvent("assistant_as_owner.refused", { reason });
  res.status(status).json(body);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function authenticateAssistantAsOwner(req: Request, res: Response, next: NextFunction, apiKey: string): Promise<void> {
  // A chain that runs requireAuth twice is admitted once (the response hook is installed once).
  if (req.viaAssistant && req.sessionScope === "assistant_as_owner") { next(); return; }
  // A request an owner-action Confirm dispatched never comes back in as the assistant.
  if (isOwnerDispatch(req)) { refuse(res, 403, NOT_ALLOWED_BODY, "nested_dispatch"); return; }
  const credential = await findAgentCredentialByApiKey(apiKey);
  if (!credential) {
    respondInvalidOrExpiredToken(res);
    return;
  }
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, serverId: agents.serverId, ownerUserId: agents.assistantOwnerUserId, managed: agents.managedByAppInstallId })
    .from(agents)
    .innerJoin(servers, and(eq(servers.id, agents.serverId), isNull(servers.deletedAt)))
    .where(and(eq(agents.id, credential.agentId), eq(agents.serverId, credential.serverId), isNull(agents.deletedAt)))
    .limit(1);
  if (!agent) {
    respondInvalidOrExpiredToken(res);
    return;
  }
  // Any other agent's credential never reaches a web route.
  if (!agent.ownerUserId || agent.managed) { notALiveAssistant(res, "not_an_assistant"); return; }
  const ownerUserId = await resolveAssistantOwner(agent.id, agent.serverId);
  if (!ownerUserId || await isAssistantPaused(agent.id)) { notALiveAssistant(res, "not_enabled"); return; }
  const [owner] = await db
    .select({ id: users.id, email: users.email, retiredAt: users.retiredAt, emailVerified: users.emailVerified, profileSetupCompletedAt: users.profileSetupCompletedAt, name: users.name, deletionScheduledFor: accountDeletionRequests.scheduledFor })
    .from(users)
    .leftJoin(accountDeletionRequests, and(eq(accountDeletionRequests.userId, users.id), eq(accountDeletionRequests.state, "pending")))
    .where(eq(users.id, ownerUserId))
    .limit(1);
  if (!owner || owner.retiredAt || owner.deletionScheduledFor) { notALiveAssistant(res, "owner_account"); return; }
  // It acts as its owner: only while the owner's organization lets the owner (RFC 083 §6.2).
  if (!(await assistantOwnerPassesSso({ userId: ownerUserId, email: owner.email })).ok) { refuse(res, 403, ASSISTANT_OWNER_SSO_REQUIRED_BODY, "owner_sso_required"); return; }

  // A target Express reads differently from this check (`#`, `\\`, whitespace) never passes.
  if (!isUnambiguousTarget(req.originalUrl)) { refuse(res, 401, NOT_ALLOWED_BODY, "ambiguous_target"); return; }
  const path = req.originalUrl.split("?")[0]!.replace(/\/+$/, "") || "/";
  // A route outside the table answers 401, as for any agent key on a web route; the text is
  // NOT_ALLOWED because this assistant's context already lists every owner action (Sage).
  if (matchAssistantOwnerActionRoute(req.method, path).length === 0) { refuse(res, 401, NOT_ALLOWED_BODY, "not_in_table"); return; }
  // The query: only a read's own options (its queryFields), each once, as plain text; nothing else.
  const query: Record<string, string> = {};
  if (req.originalUrl.includes("?")) {
    const readEntry = matchAssistantOwnerActionRoute(req.method, path).find(({ action }) => action.tier === "read")?.action;
    const params = new URLSearchParams(req.originalUrl.slice(req.originalUrl.indexOf("?") + 1));
    for (const [key, value] of params) {
      if (!readEntry?.queryFields?.includes(key) || key in query || value.length > OWNER_READ_FILTER_MAX) { refuse(res, 403, NOT_ALLOWED_BODY, "query"); return; }
      query[key] = value;
    }
  }
  // The body must already be parsed (express.json runs before these routers): an unparsed
  // body would be checked as empty here and read in full by the handler. A GET sends none.
  const body = req.method === "GET" && (req.body === undefined || req.body === null) ? {} : req.body;
  if (!plainObject(body)) { refuse(res, 403, NOT_ALLOWED_BODY, "field"); return; }
  // A GET never carries a body to the handler.
  if (req.method === "GET" && Object.keys(body).length > 0) { refuse(res, 403, NOT_ALLOWED_BODY, "field"); return; }
  // The body's keys pick the entry where two share a route; a key no entry allows is refused.
  const match = matchAssistantOwnerAction(req.method, path, body);
  if (!match || Object.keys(body).some((key) => !match.action.allowedFields.includes(key))) {
    refuse(res, 403, NOT_ALLOWED_BODY, "field");
    return;
  }
  if (match.action.tier !== "direct" && match.action.tier !== "confirm" && match.action.tier !== "read") { refuse(res, 403, NOT_ALLOWED_BODY, "not_in_table"); return; }
  const { action, params } = match;
  // A read is only a GET with a render; a GET is only a read.
  if ((action.tier === "read") !== (action.method === "GET") || (action.tier === "read" && !action.render)) { refuse(res, 403, NOT_ALLOWED_BODY, "not_in_table"); return; }
  // A turn a WeChat message triggered reads as any other: tygg (#proj-assistant msg ab720538,
  // 2026-11-05) ruled WeChat has the same permissions as Raft. The saved-message read keeps
  // its content to what the assistant itself can read (assistantOwnerSaved.ts).
  const headerServerId = req.headers["x-server-id"];
  if (headerServerId !== undefined && headerServerId !== agent.serverId) { refuse(res, 403, NOT_ALLOWED_BODY, "server"); return; }
  // The owner's routes read the server from the header (requireServer); it is the assistant's.
  req.headers["x-server-id"] = agent.serverId;

  const scope: AssistantOwnerActionRequestScope = { agentId: agent.id, serverId: agent.serverId, ownerUserId, params, body };
  const label = await ownerLabel(ownerUserId);
  const admitted = await action.admit(scope, label);
  if (!admitted.ok) {
    if (admitted.refusal) {
      refuse(res, admitted.refusal.status, { error: admitted.refusal.error, code: admitted.refusal.code }, "entry");
    } else {
      refuse(res, 404, TARGET_NOT_FOUND_BODY, "target");
    }
    return;
  }
  // A transform entry: the handler reads the route body Raft computed from the owner's
  // state in admit (the tool's own fields were checked against allowedFields above).
  if (admitted.routeBody) req.body = admitted.routeBody;

  // Confirm tier: nothing runs now. Raft posts a card in the owner's DM with the assistant,
  // or answers with the one already waiting, or with the owner's decline (assistantOwnerActionCards.ts).
  if (action.tier === "confirm") {
    if (action.method === "GET") { refuse(res, 403, NOT_ALLOWED_BODY, "confirm_get"); return; }
    const { requestOwnerActionConfirmation } = await import("../services/assistantOwnerActionCards");
    const answer = await requestOwnerActionConfirmation({
      io: (req.app.get("io") ?? null) as SocketServer | null,
      action,
      scope,
      before: admitted.before,
      owner: label,
      request: { method: action.method, path, body: (admitted.routeBody ?? body) as Record<string, unknown> },
    });
    addTraceEvent("assistant_as_owner.confirm_requested", { action: action.key, status: answer.status });
    res.status(answer.status).json(answer.body);
    return;
  }

  req.userId = ownerUserId;
  req.sessionScope = "assistant_as_owner";
  req.sessionFamilyId = undefined;
  req.authAccount = { userId: owner.id, emailVerified: owner.emailVerified, profileSetupCompletedAt: owner.profileSetupCompletedAt, name: owner.name };
  req.viaAssistant = { agentId: agent.id, serverId: agent.serverId, actionKey: action.key };
  addTraceEvent("assistant_as_owner.admitted", { action: action.key });

  const sendJson = res.json.bind(res);
  if (action.tier === "read") {
    // The route's JSON never reaches the assistant: only Raft's text from it (assistantOwnerReads.ts).
    res.json = ((payload: unknown) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // The handler's own refusal: its sentence and code only (never the rest of its body).
        const refused = plainObject(payload) ? payload : {};
        return sendJson({
          error: typeof refused.error === "string" ? refused.error : "Raft couldn't read that for your owner.",
          ...(typeof refused.code === "string" ? { code: refused.code } : {}),
        });
      }
      void (async () => {
        let text: string;
        try {
          text = await action.render!(scope, payload, query);
          await recordIntegrationAuditEventBestEffort({
            serverId: agent.serverId,
            eventType: ASSISTANT_OWNER_READ_EVENT,
            outcome: "success",
            source: "api",
            actor: { type: "agent", id: agent.id },
            subject: { type: "human", id: ownerUserId },
            target: { type: "user", id: ownerUserId },
            metadata: { action: action.key, tool: action.tool },
          });
        } catch (err) {
          console.warn("[assistant-as-owner] render_failed", err instanceof Error ? err.message : err);
          res.status(500);
          return sendJson({ error: "Raft couldn't read that for your owner right now. Try again in a moment.", code: "assistant_owner_read_failed" });
        }
        sendJson({ assistant: { text } });
      })();
      return res;
    }) as Response["json"];
    next();
    return;
  }
  res.json = ((payload: unknown) => {
    if (!plainObject(payload)) return sendJson(payload);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // The handler's own refusal, in Raft's words for the assistant where the entry has them (code kept).
      const rewrite = typeof payload.code === "string" ? action.errorText?.[payload.code] : undefined;
      return sendJson(rewrite ? { ...payload, error: rewrite(label) } : payload);
    }
    void (async () => {
      let assistant: { done: string; undo: { tool: string; args: Record<string, unknown>; text: string } | null } | null = null;
      try {
        const result = await action.describe!(scope, admitted.before, label, payload);
        assistant = { done: result.done, undo: result.undo };
        if (result.audit.previousValue !== result.audit.nextValue) {
          await recordIntegrationAuditEventBestEffort({
            serverId: agent.serverId,
            eventType: ASSISTANT_OWNER_ACTION_EVENT,
            outcome: "success",
            source: "api",
            actor: { type: "agent", id: agent.id },
            subject: { type: "human", id: ownerUserId },
            target: { type: "user", id: ownerUserId },
            metadata: { action: action.key, tool: action.tool, targetId: result.audit.targetId, previousValue: result.audit.previousValue, nextValue: result.audit.nextValue },
          });
        }
      } catch (err) {
        console.warn("[assistant-as-owner] describe_failed", err instanceof Error ? err.message : err);
      }
      sendJson(assistant ? { ...payload, assistant } : payload);
    })();
    return res;
  }) as Response["json"];

  next();
}
