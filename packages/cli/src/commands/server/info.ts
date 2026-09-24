// `raft server info` — GET /internal/agent-api/server
//
// Returns the channels / agents / humans visible to the agent.
// Covers the MCP `list_server` tool surface.

import type { Command } from "commander";
import type { AgentApiServerInfoResponse } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { apiFailureError } from "../../core/apiFailure.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import {
  formatServerAgents,
  formatServerChannels,
  formatServerHumans,
  formatServerInfo,
  formatServerSummary,
} from "./_format.js";

interface ServerInfoOpts {
  full?: boolean;
  channels?: boolean;
  agents?: boolean;
  humans?: boolean;
  joined?: boolean;
  query?: string;
  limit?: string;
  offset?: string;
}

type ServerInfoSection = "channels" | "agents" | "humans";

function parseNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be a non-negative integer`,
    });
  }
  return Number(raw);
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  const value = parseNonNegativeInt(raw, name, fallback);
  if (value <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${name} must be greater than 0`,
    });
  }
  return value;
}

function selectedSections(opts: ServerInfoOpts): ServerInfoSection[] {
  const sections: ServerInfoSection[] = [];
  if (opts.channels) sections.push("channels");
  if (opts.agents) sections.push("agents");
  if (opts.humans) sections.push("humans");
  return sections;
}

function hasListModifier(opts: ServerInfoOpts): boolean {
  return Boolean(opts.joined || opts.query !== undefined || opts.limit !== undefined || opts.offset !== undefined);
}

function includesQuery(row: unknown, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  const values = Object.values(row as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return values.some((value) => value.includes(needle));
}

function pageRows<T>(rows: T[], offset: number, limit: number): T[] {
  return rows.slice(offset, offset + limit);
}

function nextCommand(section: ServerInfoSection, opts: ServerInfoOpts, offset: number, limit: number, total: number): string | undefined {
  const nextOffset = offset + limit;
  if (nextOffset >= total) return undefined;
  const parts = ["raft server info", `--${section}`, `--offset ${nextOffset}`, `--limit ${limit}`];
  if (opts.query?.trim()) parts.push(`--query ${JSON.stringify(opts.query.trim())}`);
  if (opts.joined) parts.push("--joined");
  return parts.join(" ");
}

export const serverInfoCommand = defineCommand(
  {
    name: "info",
    description: "Show bounded server facts; use --full for the legacy full inventory",
    options: [
      { flags: "--full", description: "Print the full channels, agents, humans, and runtime inventory" },
      { flags: "--channels", description: "List visible channels only" },
      { flags: "--agents", description: "List agents only" },
      { flags: "--humans", description: "List humans only" },
      { flags: "--joined", description: "With --channels, show only joined channels" },
      { flags: "--query <text>", description: "Filter the selected list by visible text" },
      { flags: "--limit <n>", description: "Maximum rows for list output (default: 50)" },
      { flags: "--offset <n>", description: "Rows to skip for list output (default: 0)" },
    ],
  },
  async (ctx, opts: ServerInfoOpts = {}) => {
    const sections = selectedSections(opts);
    if (opts.full && sections.length > 0) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--full cannot be combined with --channels, --agents, or --humans",
      });
    }
    if (sections.length === 0 && hasListModifier(opts)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--query, --limit, --offset, and --joined require --channels, --agents, or --humans",
      });
    }
    if (opts.joined && sections.some((section) => section !== "channels")) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--joined can only be used with --channels",
      });
    }

    const limit = parsePositiveInt(opts.limit, "--limit", 50);
    const offset = parseNonNegativeInt(opts.offset, "--offset", 0);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).server.info();
    if (!res.ok) {
      throw apiFailureError(res, "INFO_FAILED");
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API serverInfo returned an empty response body",
      });
    }
    const data: AgentApiServerInfoResponse = {
      ...res.data,
      runtimeContext: {
        ...res.data.runtimeContext,
        workspacePath: res.data.runtimeContext.workspacePath ?? ctx.env.SLOCK_CURRENT_WORKSPACE_PATH ?? null,
      },
    };
    if (opts.full) {
      writeText(ctx.io, formatServerInfo(data));
      return;
    }
    if (sections.length === 0) {
      writeText(ctx.io, formatServerSummary(data));
      return;
    }

    const chunks: string[] = [];
    for (const section of sections) {
      if (section === "channels") {
        const rows = (data.channels ?? [])
          .filter((channel) => !opts.joined || channel.joined)
          .filter((channel) => includesQuery(channel, opts.query));
        chunks.push(formatServerChannels(pageRows(rows, offset, limit), {
          total: rows.length,
          offset,
          limit,
          nextCommand: nextCommand(section, opts, offset, limit, rows.length),
        }));
      } else if (section === "agents") {
        const rows = (data.agents ?? []).filter((agent) => includesQuery(agent, opts.query));
        chunks.push(formatServerAgents(pageRows(rows, offset, limit), {
          total: rows.length,
          offset,
          limit,
          nextCommand: nextCommand(section, opts, offset, limit, rows.length),
        }));
      } else {
        const rows = (data.humans ?? []).filter((human) => includesQuery(human, opts.query));
        chunks.push(formatServerHumans(pageRows(rows, offset, limit), {
          total: rows.length,
          offset,
          limit,
          nextCommand: nextCommand(section, opts, offset, limit, rows.length),
        }));
      }
    }
    writeText(ctx.io, adoptCliReplyText(chunks.join("\n")));
  },
);

export function registerServerInfoCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, serverInfoCommand, runtimeOptions);
}
