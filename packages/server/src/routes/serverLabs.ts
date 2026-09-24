import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import {
  getServerLabsForActor,
  ServerLabServiceError,
  setServerLabEnrollment,
  setServerLabsAccess,
  type ServerLabActor,
  type ServerLabMutationResult,
} from "../services/serverLabService.js";

const LAB_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export const serverLabsRouter: RouterType = Router({ mergeParams: true });

function bodyObject(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function parseMutationBody(req: Request, res: Response): {
  enabled: boolean;
  expectedVersion: number;
} | null {
  const body = bodyObject(req);
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean", code: "invalid_enabled" });
    return null;
  }
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    res.status(400).json({
      error: "expectedVersion must be a non-negative safe integer",
      code: "invalid_expected_version",
    });
    return null;
  }
  return { enabled: body.enabled, expectedVersion: body.expectedVersion as number };
}

function requestId(req: Request): string {
  const supplied = req.headers["x-request-id"];
  return typeof supplied === "string" && supplied.trim() && supplied.length <= 200
    ? supplied.trim()
    : randomUUID();
}

function humanActor(req: Request): ServerLabActor {
  return { type: "human", id: req.userId! };
}

function agentActor(req: Request): ServerLabActor {
  return { type: "agent", id: req.actingAgentId! };
}

function routeParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return typeof value === "string" ? value : null;
}

function sendMutation(res: Response, result: ServerLabMutationResult): void {
  res.json({
    applied: result.applied,
    auditEventId: result.auditEventId,
    ...result.labs,
  });
}

export function sendServerLabError(res: Response, error: unknown): void {
  if (!(error instanceof ServerLabServiceError)) {
    console.error("Server Labs error:", error);
    res.status(500).json({ error: "Server Labs request failed", code: "server_labs_failed" });
    return;
  }

  switch (error.code) {
    case "SERVER_NOT_FOUND":
    case "LAB_NOT_FOUND":
      res.status(404).json({ error: error.message, code: error.code.toLowerCase() });
      return;
    case "SERVER_MEMBERSHIP_REQUIRED":
    case "SERVER_OWNER_REQUIRED":
    case "SERVER_ADMIN_REQUIRED":
      res.status(403).json({ error: error.message, code: error.code.toLowerCase() });
      return;
    case "SERVER_LABS_VERSION_CONFLICT":
      res.status(409).json({
        error: error.message,
        code: error.code.toLowerCase(),
        currentVersion: error.currentVersion,
      });
      return;
    case "SERVER_LABS_ACCESS_DISABLED":
    case "LAB_NOT_OPEN":
      res.status(409).json({ error: error.message, code: error.code.toLowerCase() });
      return;
  }

  res.status(500).json({ error: "Server Labs request failed", code: "server_labs_failed" });
}

function requireHumanServerScope(req: Request, res: Response): boolean {
  const serverId = routeParam(req, "id");
  if (!serverId) {
    res.status(400).json({ error: "Server id is required", code: "server_id_required" });
    return false;
  }
  const headerServerId = req.headers["x-server-id"];
  if (typeof headerServerId !== "string" || !headerServerId) {
    res.status(400).json({ error: "Missing X-Server-Id header", code: "server_scope_required" });
    return false;
  }
  if (headerServerId !== serverId) {
    res.status(403).json({ error: "Cross-server access is forbidden", code: "server_scope_forbidden" });
    return false;
  }
  return true;
}

serverLabsRouter.get("/", async (req, res) => {
  if (!requireHumanServerScope(req, res)) return;
  try {
    res.json(await getServerLabsForActor(routeParam(req, "id")!, humanActor(req)));
  } catch (error) {
    sendServerLabError(res, error);
  }
});

serverLabsRouter.patch("/access", async (req, res) => {
  if (!requireHumanServerScope(req, res)) return;
  const body = parseMutationBody(req, res);
  if (!body) return;
  try {
    sendMutation(res, await setServerLabsAccess({
      serverId: routeParam(req, "id")!,
      ...body,
      actor: humanActor(req),
      requestId: requestId(req),
    }));
  } catch (error) {
    sendServerLabError(res, error);
  }
});

serverLabsRouter.put("/:labKey", async (req, res) => {
  if (!requireHumanServerScope(req, res)) return;
  const labKey = routeParam(req, "labKey");
  if (!labKey || !LAB_KEY_RE.test(labKey)) {
    res.status(400).json({ error: "Invalid lab key", code: "invalid_lab_key" });
    return;
  }
  const body = parseMutationBody(req, res);
  if (!body) return;
  try {
    sendMutation(res, await setServerLabEnrollment({
      serverId: routeParam(req, "id")!,
      labKey,
      ...body,
      actor: humanActor(req),
      requestId: requestId(req),
    }));
  } catch (error) {
    sendServerLabError(res, error);
  }
});

export async function getAgentServerLabs(req: Request, res: Response): Promise<void> {
  try {
    res.json(await getServerLabsForActor(req.serverId!, agentActor(req)));
  } catch (error) {
    sendServerLabError(res, error);
  }
}

export async function patchAgentServerLabsAccess(req: Request, res: Response): Promise<void> {
  const body = parseMutationBody(req, res);
  if (!body) return;
  try {
    sendMutation(res, await setServerLabsAccess({
      serverId: req.serverId!,
      ...body,
      actor: agentActor(req),
      requestId: requestId(req),
    }));
  } catch (error) {
    sendServerLabError(res, error);
  }
}

export async function putAgentServerLabEnrollment(req: Request, res: Response): Promise<void> {
  const labKey = routeParam(req, "labKey");
  if (!labKey || !LAB_KEY_RE.test(labKey)) {
    res.status(400).json({ error: "Invalid lab key", code: "invalid_lab_key" });
    return;
  }
  const body = parseMutationBody(req, res);
  if (!body) return;
  try {
    sendMutation(res, await setServerLabEnrollment({
      serverId: req.serverId!,
      labKey,
      ...body,
      actor: agentActor(req),
      requestId: requestId(req),
    }));
  } catch (error) {
    sendServerLabError(res, error);
  }
}
