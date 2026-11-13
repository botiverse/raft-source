// `raft integration list` — GET /internal/agent-api/integrations

import type { Command } from "commander";
import type {
  AgentLoginIntegrationInventoryProjection,
} from "@botiverse/raft-shared";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { writeJson, writeText, NL } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { apiFailureError } from "../_apiFailure";
import { formatIntegrationList, projectCurrentIntegrationList, type IntegrationListResponse } from "./_format";

interface ListOptions {
  json?: boolean;
}

export function integrationListJsonResponse(
  data: IntegrationListResponse,
  inventoryProjection: AgentLoginIntegrationInventoryProjection =
    AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
) {
  return {
    ok: true,
    data: projectCurrentIntegrationList(data),
    observationScope: inventoryProjection.observationScope,
  } as const;
}

export const integrationListCommand = defineCommand(
  {
    name: "list",
    description: "List the scoped Raft App inventory: Agent Login services, active logins, and MCP Apps",
    options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
  },
  async (ctx, opts: ListOptions) => {
    const agentContext = ctx.loadAgentContext();

    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).integrations.list();
    if (!res.ok || !res.data) {
      throw apiFailureError(res, "INTEGRATION_LIST_FAILED");
    }

    if (opts.json) {
      writeJson(ctx.io, integrationListJsonResponse(res.data));
      return;
    }

    writeText(ctx.io, formatIntegrationList(res.data), NL);
  },
);

export function registerIntegrationListCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationListCommand, runtimeOptions);
}
