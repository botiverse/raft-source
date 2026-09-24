// `raft message search [--query <q>] [--target <t>] [--sender <handle>]
//                       [--sort relevance|recent]
//                       [--before <ts>] [--after <ts>] [--limit N] [--offset N]`
// → GET /internal/agent-api/search

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError, type CliErrorCode } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { resolveTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatSearchResults } from "./_format.js";

interface SearchOpts extends TargetAliasOpts {
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: string;
  offset?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPLICIT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;
const LOCAL_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

function normalizeMemberHandleRef(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--sender must not be empty",
    });
  }
  if (UUID_RE.test(trimmed)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--sender expects a member handle like @alice, not a UUID",
    });
  }
  const handle = trimmed.replace(/^@/, "").trim();
  if (!handle) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--sender handle must not be empty",
    });
  }
  return handle;
}

function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be a positive integer; got ${raw}`,
    });
  }
  return n;
}

function parseNonNegativeInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be a non-negative integer; got ${raw}`,
    });
  }
  return n;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function formatLocalOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatLocalOffsetIso(date: Date): string {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    "T",
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    `.${pad3(date.getMilliseconds())}`,
    formatLocalOffset(date),
  ].join("");
}

function parseLocalNaiveTimestamp(raw: string): Date | undefined {
  const match = LOCAL_TIMESTAMP_RE.exec(raw);
  if (!match) return undefined;
  const [, y, mo, d, h = "00", mi = "00", s = "00", msRaw = "0"] = match;
  const ms = Number(msRaw.padEnd(3, "0"));
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (
    date.getFullYear() !== Number(y)
    || date.getMonth() !== Number(mo) - 1
    || date.getDate() !== Number(d)
    || date.getHours() !== Number(h)
    || date.getMinutes() !== Number(mi)
    || date.getSeconds() !== Number(s)
    || date.getMilliseconds() !== ms
  ) {
    return undefined;
  }
  return date;
}

function normalizeSearchTimestampArg(name: "before" | "after", raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must not be empty`,
    });
  }
  const parsed = EXPLICIT_OFFSET_RE.test(trimmed)
    ? new Date(trimmed)
    : parseLocalNaiveTimestamp(trimmed);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be an ISO datetime; naive values are interpreted in the CLI display timezone`,
    });
  }
  return formatLocalOffsetIso(parsed);
}

function normalizeSearchOpts(opts: Partial<SearchOpts & { sort?: string }>): Omit<SearchOpts, "limit" | "sender" | "offset"> & {
  query?: string;
  displayQuery: string;
  limit?: number;
  offset?: number;
  sender?: string;
} {
  const query = opts.query?.trim();
  if (opts.sort !== undefined && opts.sort !== "relevance" && opts.sort !== "recent") {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--sort must be "relevance" or "recent"; got ${opts.sort}`,
    });
  }
  const channel = resolveTargetAlias(opts);
  const sender = opts.sender ? normalizeMemberHandleRef(opts.sender) : undefined;
  const hasFilter = Boolean(channel || sender || opts.before || opts.after);
  if (!query && !hasFilter) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--query is required unless --sender, --target, --before, or --after is provided",
    });
  }
  if (!query && opts.sort === "relevance") {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--sort relevance requires --query; filter-only search is sorted by recent",
    });
  }
  const limit = parsePositiveInt("limit", opts.limit);
  const offset = parseNonNegativeInt("offset", opts.offset);
  const sort = opts.sort ?? (query ? undefined : "recent");
  const before = normalizeSearchTimestampArg("before", opts.before);
  const after = normalizeSearchTimestampArg("after", opts.after);
  return {
    ...(query ? { query } : {}),
    displayQuery: query ?? "",
    ...(channel ? { channel } : {}),
    ...(sender ? { sender } : {}),
    ...(sort ? { sort } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

function toSearchErrorCode(errorCode: string | null | undefined, status: number): CliErrorCode {
  switch (errorCode) {
    case "SCOPE_DENIED":
    case "INVALID_JSON_RESPONSE":
    case "QUERY_TOO_BROAD":
    case "SEARCH_TIMEOUT":
    case "SEARCH_UNAVAILABLE":
      return errorCode;
    default:
      return status >= 500 ? "SERVER_5XX" : "SEARCH_FAILED";
  }
}

export const messageSearchCommand = defineCommand(
  {
    name: "search",
    description: "Search messages across channels the agent can see",
    options: [
      { flags: "--query <q>", description: "Search query string (optional when filters are provided)" },
      { flags: "--target <target>", description: "Restrict to a single channel/DM/thread" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--sender <handle>", description: "Restrict to messages by sender handle, e.g. @alice" },
      { flags: "--sort <mode>", description: "Sort results by relevance or recent (default: relevance; filter-only searches use recent)" },
      { flags: "--before <iso>", description: "Only messages before this ISO datetime" },
      { flags: "--after <iso>", description: "Only messages after this ISO datetime" },
      { flags: "--limit <n>", description: "Max results (server default applies if omitted)" },
      { flags: "--offset <n>", description: "Skip this many results (server default applies if omitted)" },
    ],
  },
  async (ctx, opts: Partial<SearchOpts>) => {
    const searchOpts = normalizeSearchOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.messages.search({
      ...(searchOpts.query ? { q: searchOpts.query } : {}),
      ...(searchOpts.channel ? { channel: searchOpts.channel } : {}),
      ...(searchOpts.sender ? { sender: searchOpts.sender } : {}),
      ...(searchOpts.sort ? { sort: searchOpts.sort } : {}),
      ...(searchOpts.before ? { before: searchOpts.before } : {}),
      ...(searchOpts.after ? { after: searchOpts.after } : {}),
      ...(searchOpts.limit !== undefined ? { limit: String(searchOpts.limit) } : {}),
      ...(searchOpts.offset !== undefined ? { offset: String(searchOpts.offset) } : {}),
    });
    if (!res.ok) {
      throw new CliError({
        code: toSearchErrorCode(res.errorCode, res.status),
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    writeText(ctx.io, formatSearchResults(searchOpts.displayQuery, res.data as any), NL);
  },
);

export function registerSearchCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageSearchCommand, runtimeOptions);
}
