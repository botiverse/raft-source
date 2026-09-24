import { type ServerCapability } from "@botiverse/raft-shared";
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { MANAGED_MCP_OAUTH_RESULT_CHANNEL } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents } from "../db/schema.js";
import { actorHasServerCapabilityInServer, getActorServerRoleInServer, userCanActOnAgentResource } from "../lib/actorPermissions.js";
import {
  applyManagedMcpAssignments,
  createManagedMcpServer,
  deleteManagedMcpServer,
  listAgentManagedMcpCatalog,
  listManagedMcpServerCatalog,
  refreshManagedMcpCatalog,
  setManagedMcpAssignment,
  testManagedMcpConfiguration,
  updateManagedMcpServer,
} from "../services/managedMcpService.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { ManagedMcpCredentialError } from "../services/managedMcpCredentialService.js";
import { ManagedMcpGatewayError } from "../services/managedMcpGateway.js";
import {
  completeManagedMcpOAuthConnection,
  disconnectManagedMcpOAuthConnection,
  failManagedMcpOAuthAttempt,
  ManagedMcpOAuthError,
  startManagedMcpOAuthConnection,
} from "../services/managedMcpOAuthService.js";
import { ManagedMcpServiceError } from "../services/managedMcpService.js";

export const managedMcpRouter: RouterType = Router();
export const managedMcpOAuthCallbackRouter: RouterType = Router();

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

type ManagedMcpOAuthResultPage = "connected" | "cancelled" | "failed";

function renderManagedMcpOAuthResultPage(result: ManagedMcpOAuthResultPage): string {
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
          message: "The authorization attempt failed or expired. Return to Raft and try again.",
          marker: "!",
          tone: "error",
        };
  const script = `<script>(function(){if(typeof BroadcastChannel!=="undefined"){var channel=new BroadcastChannel("${MANAGED_MCP_OAUTH_RESULT_CHANNEL}");channel.postMessage({type:"${MANAGED_MCP_OAUTH_RESULT_CHANNEL}",result:"${result}"})}document.getElementById("close-window").addEventListener("click",function(){window.close()})})()</script>`;
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

function sendManagedMcpOAuthResultPage(res: Response, status: number, result: ManagedMcpOAuthResultPage): void {
  res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(renderManagedMcpOAuthResultPage(result));
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

function optionalAllowedTools(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ManagedMcpCredentialError("allowedTools must be null or an array of tool names", "managed_mcp_credential_invalid");
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
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
    if (typeof assignment.enabled !== "boolean") {
      throw new ManagedMcpCredentialError("assignment enabled must be a boolean", "managed_mcp_credential_invalid");
    }
    return {
      mcpServerId: requiredString(assignment.mcpServerId, "mcpServerId", 64),
      enabled: assignment.enabled,
      allowedTools: optionalAllowedTools(assignment.allowedTools),
    };
  });
}

function sendManagedMcpError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ManagedMcpCredentialError || error instanceof ManagedMcpGatewayError || error instanceof ManagedMcpOAuthError) {
    const status = error.code === "managed_mcp_credential_key_missing"
      ? 503
      : error.code === "managed_mcp_oauth_busy"
        ? 503
        : error.code === "managed_mcp_unreachable"
          ? 502
          : 400;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManagedMcpServiceError) {
    res.status(error.code.endsWith("not_found") ? 404 : 409).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
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

function requireAgentCapabilityOrCreator(capability: ServerCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = pathParam(req.params.agentId);
      const [agent] = await getDb()
        .select({ creatorType: agents.creatorType, creatorId: agents.creatorId })
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

managedMcpRouter.get("/agents/:agentId", requireCapability("viewAgents"), async (req, res, next) => {
  try {
    res.json(await listAgentManagedMcpCatalog(req.serverId!, pathParam(req.params.agentId)));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.get("/servers", async (req, res, next) => {
  try {
    res.json(await listManagedMcpServerCatalog(req.serverId!));
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

managedMcpRouter.post("/servers/:mcpServerId/oauth/start", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const redirectUrl = new URL("/api/mcp/oauth/callback", managedMcpServerOrigin()).toString();
    res.json(await startManagedMcpOAuthConnection({
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

managedMcpRouter.put("/agents/:agentId/assignments/:mcpServerId", requireAgentCapabilityOrCreator("editAgents"), async (req, res, next) => {
  try {
    const input = body(req);
    if (typeof input.enabled !== "boolean") {
      throw new ManagedMcpCredentialError("enabled must be a boolean", "managed_mcp_credential_invalid");
    }
    res.json(await setManagedMcpAssignment({
      serverId: req.serverId!,
      userId: req.userId!,
      agentId: pathParam(req.params.agentId),
      mcpServerId: pathParam(req.params.mcpServerId),
      enabled: input.enabled,
      allowedTools: optionalAllowedTools(input.allowedTools),
    }));
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpRouter.put("/agents/:agentId/assignments", requireAgentCapabilityOrCreator("editAgents"), async (req, res, next) => {
  try {
    const agentId = pathParam(req.params.agentId);
    const catalog = await applyManagedMcpAssignments({
      serverId: req.serverId!,
      userId: req.userId!,
      agentId,
      assignments: requiredAssignmentUpdates(body(req).assignments),
    });
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    await agentOrchestrator.resetAgent(agentId, "restart", { restartIfStopped: false });
    res.json(catalog);
  } catch (error) {
    sendManagedMcpError(error, res, next);
  }
});

managedMcpOAuthCallbackRouter.get("/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!state || !code || typeof req.query.error === "string") {
    await failManagedMcpOAuthAttempt(state);
    sendManagedMcpOAuthResultPage(res, 400, "cancelled");
    return;
  }
  try {
    await completeManagedMcpOAuthConnection({ state, authorizationCode: code });
    sendManagedMcpOAuthResultPage(res, 200, "connected");
  } catch {
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
