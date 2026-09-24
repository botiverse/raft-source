import { Router, type NextFunction, type Response, type Router as RouterType } from "express";
import { isCompleteWikiWorkspaceEnsureReceipt, MIN_WIKI_DAEMON_VERSION } from "@botiverse/raft-shared";
import { WIKI_AGENT_WORKSPACE_PACK } from "../generated/wikiAgentWorkspacePack.js";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import * as wikiService from "../services/wikiService.js";

export const wikiRouter: RouterType = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function sendWikiError(res: Response, err: unknown) {
  if (err instanceof wikiService.WikiError) {
    const status = err.code === "not_found"
      ? 404
      : err.code === "forbidden"
        ? 403
        : err.code === "conflict"
          ? 409
          : err.code === "daemon_upgrade_required"
            ? 409
            : err.code === "storage_unavailable" || err.code === "workspace_unavailable"
            ? 503
            : 400;
    res.status(status).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  console.error("[wiki] unexpected error:", err);
  res.status(500).json({ error: "Failed to handle Wiki request" });
}

function reminderSync(orchestrator: AgentOrchestrator | undefined) {
  if (!orchestrator) return undefined;
  return async (instruction: wikiService.WikiScheduleSyncInstruction): Promise<void> => {
    if (instruction.kind === "upsert") {
      await orchestrator.pushReminderUpsert(instruction.row.ownerAgentId, instruction.row);
    } else {
      await orchestrator.pushReminderCancel(
        instruction.ownerAgentId,
        instruction.reminderId,
        instruction.version,
      );
    }
  };
}

async function requireWikiSetupCapability(req: { serverId?: string; userId?: string }, res: Response): Promise<boolean> {
  const [canEditAgents, canEditChannels] = await Promise.all([
    actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "editAgents"),
    actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, "editChannelMetadata"),
  ]);
  if (!canEditAgents || !canEditChannels) {
    res.status(403).json({ error: "Only admins can set up Wiki" });
    return false;
  }
  return true;
}

async function requireWikiResetCapability(req: { serverId?: string; userId?: string }, res: Response): Promise<boolean> {
  const canManageServer = await actorHasServerCapabilityInServer(
    req.serverId!,
    "user",
    req.userId!,
    "editServerSettings",
  );
  if (!canManageServer) {
    res.status(403).json({ error: "Only owners and admins can reset Wiki" });
    return false;
  }
  return true;
}

async function requireWikiFeatureEnabled(req: { serverId?: string }, res: Response, next: NextFunction): Promise<void> {
  if (!await wikiService.isWikiFeatureEnabledForServer(req.serverId!)) {
    res.status(404).json({ error: "Wiki is not available on this server", code: "not_found" });
    return;
  }
  next();
}

wikiRouter.use(requireWikiFeatureEnabled);

wikiRouter.get("/status", async (req, res) => {
  try {
    res.json(await wikiService.getStatus(req.serverId!));
  } catch (err) {
    sendWikiError(res, err);
  }
});

wikiRouter.post("/setup", async (req, res) => {
  try {
    if (!await requireWikiSetupCapability(req, res)) return;
    const body = bodyObject(req.body);
    const agentId = parseUuid(body.agentId ?? body.wikiAgentId);
    const channelId = parseUuid(body.channelId ?? body.wikiChannelId);
    if (!agentId || !channelId) {
      res.status(400).json({ error: "agentId and channelId are required" });
      return;
    }
    const { agent: candidateAgent } = await wikiService.validateWikiSetupResources({
      serverId: req.serverId!,
      agentId,
      channelId,
    });
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    if (!orchestrator) {
      throw new wikiService.WikiError(
        "workspace_unavailable",
        "Wiki setup requires the Wiki Agent Computer to be online.",
      );
    }
    const daemonVersion = await orchestrator.getAgentDaemonVersion(agentId);
    if (!daemonVersion) {
      throw new wikiService.WikiError(
        "workspace_unavailable",
        `Wiki setup requires an online Computer running daemon ${MIN_WIKI_DAEMON_VERSION} or newer.`,
        { minimumDaemonVersion: MIN_WIKI_DAEMON_VERSION, daemonVersion: null },
      );
    }
    if (!await orchestrator.agentSupportsWikiWorkspacePack(agentId)) {
      throw new wikiService.WikiError(
        "daemon_upgrade_required",
        `Update the Wiki Agent Computer daemon to ${MIN_WIKI_DAEMON_VERSION} or newer before finishing Wiki setup.`,
        { minimumDaemonVersion: MIN_WIKI_DAEMON_VERSION, daemonVersion },
      );
    }
    let workspaceReceipt;
    try {
      workspaceReceipt = await orchestrator.ensureWikiAgentWorkspace(agentId);
      if (!isCompleteWikiWorkspaceEnsureReceipt(workspaceReceipt, agentId, WIKI_AGENT_WORKSPACE_PACK)) {
        throw new Error("Wiki workspace ensure returned an incomplete receipt");
      }
    } catch (err) {
      console.error("[wiki] Wiki Agent workspace ensure failed:", err);
      throw new wikiService.WikiError(
        "workspace_unavailable",
        "The Wiki Agent workspace could not be installed and verified on its Computer. Check the Computer connection and try again.",
      );
    }
    const result = await wikiService.setupWikiSpace({
      serverId: req.serverId!,
      userId: req.userId!,
      agentId,
      channelId,
      syncReminder: reminderSync(orchestrator),
    });
    orchestrator.evictCache(agentId);
    if (candidateAgent.status === "active") {
      await orchestrator.resetAgent(agentId, "restart", {
        restartEvenIfInactive: false,
        restartIfStopped: false,
      });
    }
    res.json({
      ...result,
      reviewSummary: {
        ...result.reviewSummary,
        workspace: workspaceReceipt,
      },
    });
  } catch (err) {
    sendWikiError(res, err);
  }
});

wikiRouter.post("/refresh", async (req, res) => {
  try {
    if (!await requireWikiSetupCapability(req, res)) return;
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    res.json(await wikiService.refreshWiki(
      req.serverId!,
      req.userId!,
      "user",
      true,
      reminderSync(orchestrator),
    ));
  } catch (err) {
    sendWikiError(res, err);
  }
});

wikiRouter.post("/reset", async (req, res) => {
  try {
    if (!await requireWikiResetCapability(req, res)) return;
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    res.json(await wikiService.resetWiki(
      req.serverId!,
      req.userId!,
      reminderSync(orchestrator),
    ));
  } catch (err) {
    sendWikiError(res, err);
  }
});

wikiRouter.get("/directory", async (req, res) => {
  try {
    res.json(await wikiService.getDirectory(req.serverId!));
  } catch (err) {
    sendWikiError(res, err);
  }
});

wikiRouter.get("/artifacts/:artifactId", async (req, res) => {
  try {
    const artifactId = parseUuid(req.params.artifactId);
    if (!artifactId) {
      res.status(400).json({ error: "Invalid artifact id" });
      return;
    }
    res.json(await wikiService.getArtifact(req.serverId!, artifactId));
  } catch (err) {
    sendWikiError(res, err);
  }
});
