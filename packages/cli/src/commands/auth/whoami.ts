// `raft auth whoami` — print the bootstrapped agent context.
//
// Useful for debugging the daemon→cli env injection without making a
// network call. Token value is never echoed; only the client mode and local
// secret source are shown.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { writeJson } from "../../core/renderer.js";

export const whoamiCommand = defineCommand(
  {
    name: "whoami",
    description: "Print the agent context resolved from env (token value redacted)",
  },
  (ctx) => {
    const agentContext = ctx.loadAgentContext();
    writeJson(ctx.io, {
      ok: true,
      data: {
        agentId: agentContext.agentId,
        serverUrl: agentContext.serverUrl,
        serverId: agentContext.serverId,
        clientMode: agentContext.clientMode,
        secretSource: agentContext.secretSource,
        ...(agentContext.profileSlug ? { profileSlug: agentContext.profileSlug } : {}),
        ...(agentContext.profileCredentialPath ? { profileCredentialPath: agentContext.profileCredentialPath } : {}),
      },
    });
  },
);

export function registerWhoamiCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, whoamiCommand, runtimeOptions);
}
