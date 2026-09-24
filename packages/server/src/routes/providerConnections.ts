import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import {
  isProviderConnectionProviderId,
  type ProviderConnectionProviderOption,
  type ServerCapability,
} from "@botiverse/raft-shared";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions.js";
import { isProviderConnectionsEnabled } from "../services/providerConnectionFeature.js";
import { buildBuiltInPiFormOptionSource } from "../services/runtimeFormDefinitionService.js";
import {
  createProviderConnection,
  deleteProviderConnection,
  listProviderConnections,
  listProviderConnectionModels,
  ProviderConnectionError,
  rotateProviderConnectionCredential,
  testProviderConnection,
  updateProviderConnection,
} from "../services/providerConnectionService.js";

export const providerConnectionRouter: RouterType = Router();

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new ProviderConnectionError("Request body must be an object", "provider_connection_invalid");
  }
  return req.body as Record<string, unknown>;
}

function exactBody(req: Request, allowed: readonly string[]): Record<string, unknown> {
  const value = body(req);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProviderConnectionError("Request body contains unknown fields", "provider_connection_invalid");
  }
  return value;
}

function connectionId(req: Request): string {
  const value = req.params.connectionId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) {
    throw new ProviderConnectionError("Provider connection id is invalid", "provider_connection_invalid");
  }
  return value;
}

function requireCapability(capability: ServerCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!await actorHasServerCapabilityInServer(req.serverId!, "user", req.userId!, capability)) {
        res.status(403).json({ error: `${capability} capability required`, code: "provider_connection_forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function requireProviderConnectionsFeature(req: Request, res: Response, next: NextFunction) {
  try {
    if (!await isProviderConnectionsEnabled(req.serverId!)) {
      res.status(404).json({
        error: "Provider connections are not enabled for this server",
        code: "provider_connections_disabled",
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

function sendError(error: unknown, res: Response, next: NextFunction) {
  if (!(error instanceof ProviderConnectionError)) {
    next(error);
    return;
  }
  const status = error.code === "provider_connection_not_found"
    ? 404
    : error.code === "provider_connection_key_missing"
      ? 503
      : error.code === "provider_connection_test_failed" || error.code === "provider_connection_model_list_failed"
        ? 502
        : error.code === "provider_connection_invalid"
          ? 400
          : 409;
  res.status(status).json({ error: error.message, code: error.code });
}

providerConnectionRouter.use(requireProviderConnectionsFeature);

export function listProviderConnectionProviderOptions(): ProviderConnectionProviderOption[] {
  const source = buildBuiltInPiFormOptionSource("provider");
  if (!source || source.kind !== "select") {
    throw new ProviderConnectionError("Built-in provider catalog is unavailable", "provider_connection_unavailable");
  }
  return source.options.map((option) => {
    if (
      !isProviderConnectionProviderId(option.value)
      || (option.providerKind !== "preset" && option.providerKind !== "gateway")
    ) {
      throw new ProviderConnectionError("Built-in provider catalog is out of sync", "provider_connection_unavailable");
    }
    return {
      id: option.value,
      label: option.label,
      providerKind: option.providerKind,
    };
  });
}

providerConnectionRouter.get("/", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    res.json({
      connections: await listProviderConnections(req.serverId!),
      providerOptions: listProviderConnectionProviderOptions(),
    });
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.post("/", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["name", "providerId", "endpointUrl", "supportsImageInput", "apiKey"]);
    res.status(201).json(await createProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      name: input.name,
      providerId: input.providerId,
      endpointUrl: input.endpointUrl,
      supportsImageInput: input.supportsImageInput,
      apiKey: input.apiKey,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.patch("/:connectionId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["name", "enabled"]);
    res.json(await updateProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      ...input,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.post("/:connectionId/credentials/rotate", requireCapability("rotateServerSecrets"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["apiKey", "endpointUrl", "supportsImageInput"]);
    res.json(await rotateProviderConnectionCredential({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      apiKey: input.apiKey,
      endpointUrl: input.endpointUrl,
      supportsImageInput: input.supportsImageInput,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.delete("/:connectionId", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    await deleteProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
    });
    res.status(204).end();
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.get("/:connectionId/models", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    res.json(await listProviderConnectionModels({
      serverId: req.serverId!,
      connectionId: connectionId(req),
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});

providerConnectionRouter.post("/:connectionId/test", requireCapability("manageExternalAuth"), async (req, res, next) => {
  try {
    const input = exactBody(req, ["model", "message"]);
    res.json(await testProviderConnection({
      serverId: req.serverId!,
      userId: req.userId!,
      connectionId: connectionId(req),
      model: input.model,
      message: input.message,
    }));
  } catch (error) {
    sendError(error, res, next);
  }
});
