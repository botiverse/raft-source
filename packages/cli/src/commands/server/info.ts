// `raft server info` — GET /internal/agent-api/server
//
// Returns the channels / agents / humans visible to the agent.
// Covers the MCP `list_server` tool surface.

import type { Command } from "commander";
import type { AgentApiServerInfoResponse } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { apiFailureError } from "../../core/apiFailure";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import {
  formatServerAgents,
  formatServerChannels,
  formatServerHumans,
  formatServerInfo,
  formatServerSummary,
} from "./_format";

interface ServerInfoOpts {
  full?: boolean;
  channels?: boolean;
  agents?: boolean;
  humans?: boolean;
  joined?: boolean;
  archived?: boolean;
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
  return Boolean(opts.joined || opts.archived || opts.query !== undefined || opts.limit !== undefined || opts.offset !== undefined);
}

function includesQuery(row: unknown, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  // A channel's last-post time is a timestamp, not text to match ("10" would match every date).
  const values = Object.entries(row as Record<string, unknown>)
    .filter(([key]) => key !== "lastPostAt")
    .map(([, value]) => value)
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
  if (opts.archived) parts.push("--archived");
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
      { flags: "--archived", description: "With --channels, list archived channels instead (read-only: you can read their history, nothing new can be posted)" },
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
        message: "--query, --limit, --offset, --joined, and --archived require --channels, --agents, or --humans",
      });
    }
    if (opts.joined && sections.some((section) => section !== "channels")) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--joined can only be used with --channels",
      });
    }
    if (opts.archived && sections.some((section) => section !== "channels")) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--archived can only be used with --channels",
      });
    }

    const limit = parsePositiveInt(opts.limit, "--limit", 50);
    const offset = parseNonNegativeInt(opts.offset, "--offset", 0);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    // Archived channels (read-only) come back only when asked for: --archived
    // lists them, and a --query search covers them too, so a name is never
    // "not found" just because the channel was archived.
    const wantsArchived = sections.includes("channels") && (opts.archived === true || Boolean(opts.query?.trim()));
    const res = await createAgentApiSurfaceClient(client).server.info(wantsArchived ? { archived: "include" } : undefined);
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
        const query = opts.query?.trim() || undefined;
        if (opts.archived && data.archivedChannelCount === undefined) {
          throw new CliError({
            code: "UNSUPPORTED_BY_SERVER",
            message: "This Server does not list archived channels yet; read one by name (its history is still readable).",
          });
        }
        const archivedCount = data.archivedChannelCount ?? 0;
        const archivedRows = (data.archivedChannels ?? []).map((channel) => ({ ...channel, archived: true }));
        const source = opts.archived ? archivedRows : query !== undefined ? [...(data.channels ?? []), ...archivedRows] : (data.channels ?? []);
        const rows = source
          .filter((channel) => !opts.joined || channel.joined)
          .filter((channel) => includesQuery(channel, opts.query));
        // The default listing says how many archived channels it leaves out (last page only).
        // Not with --joined: the count covers every visible archived channel, joined or not.
        const archivedNotShown = !opts.archived && query === undefined && !opts.joined && archivedCount > 0
          ? { count: archivedCount, listCommand: "raft server info --channels --archived" }
          : undefined;
        chunks.push(formatServerChannels(pageRows(rows, offset, limit), {
          total: rows.length,
          offset,
          limit,
          nextCommand: nextCommand(section, opts, offset, limit, rows.length),
        }, undefined, archivedNotShown));
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
