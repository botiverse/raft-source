// `raft app config --app <app-id> [--set key=value ...] [--unset key ...]`
// → GET/PATCH /internal/agent-api/apps/:appId/config

import type { Command } from "commander";
import type {
  AgentApiAppConfigPatchBody,
  AgentApiAppConfigResponse,
} from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, NL, adoptCliReplyText } from "../../core/renderer.js";
import { formatAppConfig } from "./_format.js";

interface AppConfigOpts {
  app?: string;
  set?: string[];
  unset?: string[];
}

function parseScalar(raw: string): boolean | number {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?(0|[1-9]\d*)$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return value;
    throw cliError("INVALID_ARG", `Config integer is outside the safe range: ${raw}`);
  }
  throw cliError("INVALID_ARG", `Config values must be true, false, or an integer; got ${raw}`);
}

function parseMutation(opts: AppConfigOpts): Pick<AgentApiAppConfigPatchBody, "set" | "unset"> {
  const set: Record<string, unknown> = {};
  const unset = opts.unset ?? [];
  const unsetSeen = new Set<string>();
  for (const key of unset) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw cliError("INVALID_ARG", `Invalid config key for --unset: ${key}`);
    }
    if (unsetSeen.has(key)) throw cliError("INVALID_ARG", `Config key appears more than once: ${key}`);
    unsetSeen.add(key);
  }
  for (const entry of opts.set ?? []) {
    const equals = entry.indexOf("=");
    if (equals <= 0 || equals === entry.length - 1) {
      throw cliError("INVALID_ARG", `--set must use key=value; got ${entry}`);
    }
    const key = entry.slice(0, equals);
    const raw = entry.slice(equals + 1);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw cliError("INVALID_ARG", `Invalid config key for --set: ${key}`);
    }
    if (Object.hasOwn(set, key) || unsetSeen.has(key)) {
      throw cliError("INVALID_ARG", `Config key appears more than once: ${key}`);
    }
    set[key] = parseScalar(raw);
  }
  return { set, unset };
}

export const appConfigCommand = defineCommand(
  {
    name: "config",
    description: "Show or atomically update a built-in RAP App's durable config",
    options: [
      { flags: "--app <app-id>", description: "Built-in RAP App id" },
      {
        flags: "--set <key=value>",
        description: "Set a boolean or integer config value (repeatable)",
        parse: (value, previous: string[] = []) => previous.concat(value),
      },
      {
        flags: "--unset <key>",
        description: "Remove an override and return to its declared default (repeatable)",
        parse: (value, previous: string[] = []) => previous.concat(value),
      },
    ],
  },
  async (ctx, opts: AppConfigOpts) => {
    const appId = opts.app?.trim();
    if (!appId) throw cliError("INVALID_ARG", "--app is required");
    const mutation = parseMutation(opts);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).apps;

    const current = await api.getConfig({ appId });
    if (!current.ok) {
      throw cliError(current.errorCode ?? (current.status >= 500 ? "SERVER_5XX" : "APP_CONFIG_FAILED"), current.error ?? `HTTP ${current.status}`);
    }
    if (!current.data) throw cliError("INVALID_JSON_RESPONSE", "Agent API appConfigGet returned an empty response body");

    if (Object.keys(mutation.set).length === 0 && mutation.unset.length === 0) {
      writeText(ctx.io, formatAppConfig(current.data), NL);
      return;
    }

    const updated = await api.patchConfig(
      { appId },
      { expectedRevision: current.data.revision, ...mutation },
    );
    if (!updated.ok) {
      throw cliError(updated.errorCode ?? (updated.status >= 500 ? "SERVER_5XX" : "APP_CONFIG_FAILED"), updated.error ?? `HTTP ${updated.status}`, {
        suggestedNextAction: updated.status === 409
          ? "Rerun the same command to refresh the revision and retry."
          : updated.suggestedNextAction ?? undefined,
      });
    }
    if (!updated.data) throw cliError("INVALID_JSON_RESPONSE", "Agent API appConfigPatch returned an empty response body");
    writeText(ctx.io, formatAppConfig(updated.data), NL);
  },
);

export function registerAppConfigCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, appConfigCommand, runtimeOptions);
}
