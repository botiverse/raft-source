// `raft artifact list [--query <words>] [--target <conversation>] [--cursor <c>] [--limit <n>]`
// → GET /internal/agent-api/artifacts (the SDK's artifacts.list)

import type { Command } from "commander";
import { formatArtifactList } from "./_format";
import { artifactsList } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { artifactCliError } from "./_shared";

interface ListOpts {
  query?: string;
  target?: string;
  cursor?: string;
  limit?: string;
}

export const artifactListCommand = defineCommand(
  {
    name: "list",
    description: "List the artifacts you can see, most recently updated first (an artifact: a versioned page or set of files in Raft); --query searches their titles",
    options: [
      { flags: "--query <words>", description: "Search titles: only artifacts whose title has every word, most relevant first" },
      { flags: "--target <target>", description: "Only artifacts whose home is this conversation ('#channel', 'dm:@peer'; a thread means its conversation)" },
      { flags: "--cursor <cursor>", description: "Continue from the More line of the previous page" },
      { flags: "--limit <n>", description: "Artifacts per page (default 20, at most 50)" },
    ],
  },
  async (ctx, opts: ListOpts = {}) => {
    let limit: number | undefined;
    if (opts.limit !== undefined) {
      if (!/^\d+$/.test(opts.limit) || Number(opts.limit) < 1) throw new CliError({ code: "INVALID_ARG", message: "--limit must be a positive integer" });
      limit = Number(opts.limit);
    }
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsList(api, {
      ...(opts.query === undefined ? {} : { query: opts.query }),
      ...(opts.target === undefined ? {} : { target: opts.target }),
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (!outcome.ok) throw artifactCliError(outcome);
    writeText(ctx.io, formatArtifactList(outcome.data, {
      ...(limit === undefined ? {} : { limit }),
      ...(opts.query === undefined ? {} : { query: opts.query.trim() }),
    }));
  },
);

export function registerArtifactListCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactListCommand, runtimeOptions);
}
