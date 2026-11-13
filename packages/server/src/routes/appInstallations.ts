import { Router, type Request, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseTransaction } from "../db/index";
import {
  APP_INSTALLATION_TOKEN_AUDIENCE,
  verifyAppInstallationCredential,
  type VerifiedAppInstallationCredential,
} from "../services/appInstallationCredentialService";
import {
  AppOutboundProjectionError,
  getAppServerProjection,
  getAppHumanMemberRole,
  canAppHumanManageAgent,
  listAppAgentProjections,
  listAppComputerProjections,
  listAppPublicChannelProjections,
} from "../services/appOutboundProjectionService";
import { AGENT_REMINDERS_DM_PEER, AGENT_REMINDERS_DM_TARGET } from "../services/agentPrivateSurfaces";
import {
  AppAgentReminderMessageError,
  deliverAppAgentReminderMessage,
  writeAppAgentReminderMessage,
  type AppAgentReminderWriteResult,
} from "../services/appAgentReminderMessageService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { agentIdHashAttrs } from "../tracing/traceIdentity";
import { withTraceChildSpan } from "../tracing/semanticTrace";
import { encodePixelAvatarKey } from "../services/pixelAvatarService";
import { sendJsonServerError } from "./errorResponse";

export const appInstallationRouter: RouterType = Router();

type InstallationProjection<T> = {
  credential: VerifiedAppInstallationCredential;
  projection: T;
};

async function readInstallationProjection<T>(
  req: Request,
  res: Response,
  read: (credential: VerifiedAppInstallationCredential, tx: DatabaseTransaction) => Promise<T>,
): Promise<InstallationProjection<T> | null> {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Installation bearer token is required" });
    return null;
  }

  const result = await getDb().transaction(async (tx) => {
    const credential = await verifyAppInstallationCredential(
      authorization.slice("Bearer ".length),
      APP_INSTALLATION_TOKEN_AUDIENCE,
      tx,
    );
    if (!credential) return null;
    return { credential, projection: await read(credential, tx) };
  }, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  if (!result) {
    res.status(401).json({ error: "Invalid, expired, or stale installation credential" });
    return null;
  }
  res.setHeader("Cache-Control", "private, no-store");
  return result;
}

function handleProjectionError(req: Request, error: unknown, res: Response, operation: string) {
  if (error instanceof AppOutboundProjectionError) {
    res.status(403).json({ error: error.message });
    return;
  }
  sendJsonServerError(req, res, {
    error: `Failed to ${operation.toLowerCase()}`,
    logPrefix: `${operation} error:`,
    err: error,
  });
}

appInstallationRouter.get("/server", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, getAppServerProjection);
    if (!result) return;
    if (!result.projection) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({ installation_id: result.credential.installationId, server: result.projection });
  } catch (error) {
    handleProjectionError(req, error, res, "Read installation server projection");
  }
});

// App's installation names the only Server; sub cannot widen that scope.
// All user-level misses have the same response; app credential errors keep the
// existing 401/403 contract. No role decision should outlive this read.
appInstallationRouter.get("/members/:sub/role", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const result = await readInstallationProjection(req, res, (credential, tx) =>
      getAppHumanMemberRole(credential, req.params.sub, tx));
    if (!result) return;
    res.json({ role: result.projection?.role ?? null });
  } catch (error) {
    handleProjectionError(req, error, res, "Read installation member role");
  }
});

appInstallationRouter.get("/members/:sub/agents/:agentId/manage", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const result = await readInstallationProjection(req, res, (credential, tx) =>
      canAppHumanManageAgent(credential, req.params.sub, req.params.agentId, tx));
    if (!result) return;
    res.json({ allowed: result.projection });
  } catch (error) {
    handleProjectionError(req, error, res, "Check installation Agent management");
  }
});

appInstallationRouter.get("/agents", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppAgentProjections);
    if (!result) return;
    const origin = process.env.SERVER_URL?.trim() || `${req.protocol}://${req.get("host")}`;
    res.json({ installation_id: result.credential.installationId, agents: result.projection.map((agent) => {
      const pixelKey = agent.avatar_url ? encodePixelAvatarKey(agent.avatar_url) : null;
      const avatarPath = pixelKey ? `/api/avatars/pixel/${pixelKey}.svg` : agent.avatar_url;
      let avatarUrl: string | null = null;
      if (avatarPath && (/^https?:\/\//i.test(avatarPath) || avatarPath.startsWith("/"))) {
        try { avatarUrl = new URL(avatarPath, origin).toString(); }
        catch { /* An invalid stored avatar must not break the directory read. */ }
      }
      return { ...agent, avatar_url: avatarUrl };
    }) });
  } catch (error) {
    handleProjectionError(req, error, res, "List installation agent projections");
  }
});

appInstallationRouter.get("/channels", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppPublicChannelProjections);
    if (!result) return;
    res.json({ installation_id: result.credential.installationId, channels: result.projection });
  } catch (error) {
    handleProjectionError(req, error, res, "List installation channel projections");
  }
});

appInstallationRouter.get("/computers", async (req, res) => {
  try {
    const result = await readInstallationProjection(req, res, listAppComputerProjections);
    if (!result) return;
    res.json({ installation_id: result.credential.installationId, computers: result.projection });
  } catch (error) {
    handleProjectionError(req, error, res, "List installation computer projections");
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAgentReminderMessageBody(body: unknown): { agentId: string; idempotencyKey: string; text: string } | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object";
  const { agentId, idempotencyKey, text } = body as Record<string, unknown>;
  if (typeof agentId !== "string" || !UUID_RE.test(agentId)) return "agentId must be an Agent ID";
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    return "idempotencyKey must be a string of 1 to 200 characters";
  }
  if (typeof text !== "string" || text.trim().length < 1 || text.length > 8000) {
    return "text must be a non-empty string of at most 8000 characters";
  }
  return { agentId, idempotencyKey, text };
}

// Official apps only: write one reminder into an Agent's private
// `dm:@reminders` conversation. Idempotent per (app, agent, idempotencyKey).
appInstallationRouter.post("/agent-reminder-messages", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const traceAttrs: Record<string, string> = { outcome: "rejected" };
  try {
    await withTraceChildSpan("server.app_agent_message", { surface: "server", kind: "internal" }, async () => {
      const authorization = req.headers.authorization;
      const credential = authorization?.startsWith("Bearer ")
        ? await verifyAppInstallationCredential(authorization.slice("Bearer ".length), APP_INSTALLATION_TOKEN_AUDIENCE)
        : null;
      if (!credential) {
        res.status(401).json({ error: "Invalid, expired, or stale installation credential" });
        return;
      }
      traceAttrs.client_id = credential.clientId;
      const body = parseAgentReminderMessageBody(req.body);
      if (typeof body === "string") {
        res.status(400).json({ error: body });
        return;
      }
      Object.assign(traceAttrs, agentIdHashAttrs(body.agentId));
      let result: AppAgentReminderWriteResult;
      try {
        result = await writeAppAgentReminderMessage({ credential, ...body });
      } catch (error) {
        if (error instanceof AppAgentReminderMessageError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      traceAttrs.outcome = result.created ? "created" : "replayed";
      traceAttrs.delivery = await deliverAppAgentReminderMessage({
        io: (req.app.get("io") ?? null) as SocketServer | null,
        orchestrator: (req.app.get("agentOrchestrator") ?? null) as AgentOrchestrator | null,
        result,
      });
      res.json({
        messageId: result.messageId,
        created: result.created,
        surface: { channelType: "dm", channelName: AGENT_REMINDERS_DM_PEER, target: AGENT_REMINDERS_DM_TARGET },
      });
    }, { onSuccess: () => traceAttrs, onError: () => traceAttrs });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to write agent reminder message",
      logPrefix: "Write agent reminder message error:",
      err: error,
    });
  }
});
