import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeJson, writeText, NL } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { formatProfile } from "./_format.js";

interface ShowOptions {
  json?: boolean;
}

function normalizeTarget(target: string | undefined): string | null {
  if (target === undefined) return null;
  const trimmed = target.trim();
  if (!trimmed) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "profile target must not be empty",
    });
  }
  if (!trimmed.startsWith("@")) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "profile target must start with @",
    });
  }
  return trimmed;
}

export const profileShowCommand = defineCommand(
  {
    name: "show",
    description: "Show a profile. Omit the target to show your own profile.",
    arguments: ["[target]"],
    options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
  },
  async (ctx, target: string | undefined, opts: ShowOptions = {}) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const normalizedTarget = normalizeTarget(target);
    const res = await createAgentApiSurfaceClient(client).profile.show({
      target: normalizedTarget ?? undefined,
    });
    if (!res.ok || !res.data) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "PROFILE_SHOW_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }

    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: res.data });
      return;
    }

    writeText(ctx.io, formatProfile(res.data), NL);
  },
);

export function registerProfileShowCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, profileShowCommand, runtimeOptions);
}
