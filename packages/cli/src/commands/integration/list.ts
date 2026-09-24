// `raft integration list` — GET /internal/agent-api/integrations

import type { Command } from "commander";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  type AgentLoginIntegrationInventoryProjection,
} from "@botiverse/raft-shared";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { writeJson, writeText, NL } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { apiFailureError } from "../_apiFailure.js";
import { formatIntegrationList, type IntegrationListResponse } from "./_format.js";

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
    data,
    observationScope: inventoryProjection.observationScope,
  } as const;
}

export const integrationListCommand = defineCommand(
  {
    name: "list",
    description: "List the scoped Raft Agent Login service and active-login inventory",
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
