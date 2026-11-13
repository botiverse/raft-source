// Server discovery and profile operations: the summary an agent starts from,
// the paged channel / agent / human listings, one user's visible facts, and
// profile show / update. Text is the CLI's (`raft server info`, `raft user
// info`, `raft profile show`) from the shared formatters; paging follows the
// CLI's offset/limit and `More:` line.

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient, AgentApiClientResult } from "../agentApiClient";
import {
  AGENT_API_USER_CHANNELS_DEFAULT_LIMIT,
  AGENT_API_USER_CHANNELS_MAX_LIMIT,
  AGENT_API_USER_NOT_FOUND_CODE,
  agentApiProfileUpdateBodySchema,
  type AgentApiProfileUpdateBody,
  type AgentApiProfileView,
  type AgentApiServerInfoResponse,
} from "../agentApiContract";
import {
  formatAgentServerAgents,
  formatAgentUserInfo,
  type AgentAgentInfo,
  type AgentChannelInfo,
  type AgentHumanInfo,
  formatAgentServerChannels,
  formatAgentServerHumans,
  formatAgentServerInfo,
  formatAgentServerSummary,
  type AgentPageInfo,
} from "../agentText/server";
import { formatAgentProfile, type AgentProfileTextOptions } from "../agentText/threadsProfile";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export type ServerInfoSection = "channels" | "agents" | "humans";

export interface ServerInfoRequest {
  /** Omit for the compact summary; `full` for the whole overview; a section for a paged listing. */
  view?: "summary" | "full" | ServerInfoSection;
  offset?: number;
  /** Default 50. */
  limit?: number;
  /** Channels only: restrict to joined channels. */
  joined?: boolean;
  /** Channels only: list archived (read-only) channels instead of live ones. */
  archived?: boolean;
  /** Sections only: keep rows whose visible text contains this (case-insensitive), like the CLI's `--query`. */
  query?: string;
}

export const serverInfoRequestSchema = lazySchema("serverInfoRequestSchema", () => requestSchema<ServerInfoRequest>()(z.object({
  view: z.enum(["summary", "full", "channels", "agents", "humans"]).optional().describe("summary (default): counts; full: the whole overview; channels / agents / humans: one paged section."),
  offset: z.number().optional().describe("Section paging: rows to skip."),
  limit: z.number().optional().describe("Section paging: rows per page (default 50)."),
  joined: z.boolean().optional().describe("channels view only: only channels you have joined."),
  archived: z.boolean().optional().describe("channels view only: list archived channels (read-only: their history can be read, nothing new can be posted) instead of live ones."),
  query: z.string().optional().describe("channels / agents / humans view only: keep rows whose name, description, or other visible text contains this (case-insensitive)."),
})));

export const showProfileRequestSchema = lazySchema("showProfileRequestSchema", () => requestSchema<{ target?: string }>()(z.object({
  target: z.string().optional().describe("`@handle` of someone else; omit for your own profile."),
})));

/** The Agent API's profile body schema; at least one field is required (checked by the operation). */
export const updateProfileRequestSchema = agentApiProfileUpdateBodySchema;

export interface RaftServerInfo {
  view: NonNullable<ServerInfoRequest["view"]>;
  server: AgentApiServerInfoResponse;
  /** Present for a paged section. */
  page: (AgentPageInfo & { section: ServerInfoSection }) | null;
}

/** The next page of a section, or null on the last page (`--query` / `--joined` carried, in the CLI's order). */
function nextPageArgs(section: ServerInfoSection, request: ServerInfoRequest, offset: number, limit: number, total: number) {
  const nextOffset = offset + limit;
  if (nextOffset >= total) return null;
  const query = request.query?.trim() || undefined;
  const joined = section === "channels" && request.joined === true ? true : undefined;
  const archived = section === "channels" && request.archived === true ? true : undefined;
  return { view: section, offset: nextOffset, limit, ...(query === undefined ? {} : { query }), ...(joined ? { joined } : {}), ...(archived ? { archived } : {}) };
}

/** The CLI's `--query` match: any string field contains the needle, case-insensitively. */
function includesQuery(row: object, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  // A channel's last-post time is a timestamp, not text to match ("10" would match every date).
  return Object.entries(row).some(([key, value]) => key !== "lastPostAt" && typeof value === "string" && value.toLowerCase().includes(needle));
}

export async function serverInfo(
  client: Pick<AgentApiClient, "server">,
  request: ServerInfoRequest = {},
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftServerInfo, "info">> {
  const invalid = validateOpRequest(serverInfoRequestSchema, request); if (invalid) return invalid;
  const style: RaftHintStyle = options.hints ?? "cli";
  const view = request.view ?? "summary";
  const query = request.query?.trim() || undefined;
  // Archived channels come back only when asked for: `--archived` lists them,
  // and a `--query` search covers them too (so a name is never "not found"
  // just because the channel was archived).
  const wantsArchived = view === "channels" && (request.archived === true || query !== undefined);
  const result = await client.server.info(wantsArchived ? { archived: "include" } : undefined);
  if (!result.ok) return failureFromClientResult(result);
  const server = result.data;
  if (view === "channels" && request.archived === true && server.archivedChannelCount === undefined) {
    return failureOutcome(opError("UNAVAILABLE", {
      message: "This Server does not list archived channels yet; read one by name (its history is still readable).",
    }));
  }
  const archivedRows = (server.archivedChannels ?? []).map((c) => ({ ...c, archived: true as const }));
  if (view === "summary") {
    const next = hintStep("list_channels", RAFT_HINTS.serverInfo({ view: "channels" }), "The summary only counts; list a section to see names.", style);
    return { ok: true, state: "info", data: { view, server, page: null }, next, text: formatAgentServerSummary(server, style) };
  }
  if (view === "full") {
    return { ok: true, state: "info", data: { view, server, page: null }, next: null, text: formatAgentServerInfo(server, style) };
  }
  const limit = Math.max(1, Math.trunc(request.limit ?? 50));
  const offset = Math.max(0, Math.trunc(request.offset ?? 0));
  const channelRows = request.archived === true
    ? archivedRows
    : query !== undefined ? [...server.channels, ...archivedRows] : server.channels;
  const sectionRows: object[] = view === "channels"
    ? channelRows.filter((c) => !request.joined || c.joined)
    : view === "agents" ? server.agents : server.humans;
  const rows = sectionRows.filter((row) => includesQuery(row, request.query));
  const pageRows = rows.slice(offset, offset + limit);
  const nextArgs = nextPageArgs(view, request, offset, limit, rows.length);
  const nextHint = nextArgs ? RAFT_HINTS.serverInfo(nextArgs) : null;
  const page: AgentPageInfo & { section: ServerInfoSection } = {
    section: view,
    total: rows.length,
    offset,
    limit,
    nextCommand: nextHint ? formatHint(nextHint, style) : undefined,
  };
  // The default listing leaves archived channels out; say how many, once (last page).
  // Not with --joined: the count covers every visible archived channel, joined or not.
  const archivedNotShown = view === "channels" && request.archived !== true && query === undefined && !request.joined
    && (server.archivedChannelCount ?? 0) > 0
    ? { count: server.archivedChannelCount ?? 0, listCommand: formatHint(RAFT_HINTS.serverInfo({ view: "channels", archived: true }), style) }
    : undefined;
  const text = view === "channels"
    ? formatAgentServerChannels(pageRows as never, page, undefined, archivedNotShown)
    : view === "agents"
      ? formatAgentServerAgents(pageRows as never, page)
      : formatAgentServerHumans(pageRows as never, page);
  const next: RaftNextStep | null = nextArgs && nextHint
    ? hintStep("next_page", nextHint, "More rows exist; one page is one page.", style, nextArgs)
    : null;
  return { ok: true, state: "info", data: { view, server, page }, next, text };
}

export async function showProfile(
  client: Pick<AgentApiClient, "profile">,
  request: { target?: string } = {},
  options: AgentProfileTextOptions = {},
): Promise<RaftOutcome<AgentApiProfileView, "profile">> {
  const invalid = validateOpRequest(showProfileRequestSchema, request); if (invalid) return invalid;
  const result = await client.profile.show(request.target ? { target: request.target } : {});
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "profile", data: result.data, next: null, text: formatAgentProfile(result.data, options) };
}

export async function updateProfile(
  client: Pick<AgentApiClient, "profile">,
  request: AgentApiProfileUpdateBody,
  options: AgentProfileTextOptions = {},
): Promise<RaftOutcome<AgentApiProfileView, "updated">> {
  const invalid = validateOpRequest(updateProfileRequestSchema, request); if (invalid) return invalid;
  if (request.displayName === undefined && request.description === undefined && request.avatarUrl === undefined) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a displayName, description, or avatarUrl to update." }));
  }
  const result = await client.profile.update(request);
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "updated", data: result.data, next: null, text: formatAgentProfile(result.data, options) };
}

export interface UserInfoRequest {
  /** The user's handle, `@name` or `name`. */
  name: string;
  /** Visible channels to skip before inspecting memberships (default 0). */
  offset?: number;
  /** Visible channels to inspect for memberships (default 50, at most 200). */
  limit?: number;
}

export const userInfoRequestSchema = lazySchema("userInfoRequestSchema", () => requestSchema<UserInfoRequest>()(z.object({
  name: z.string().describe("The human or agent, `@handle` (or the bare handle)."),
  offset: z.number().int().nonnegative().optional().describe("Membership paging: visible channels to skip before inspecting (default 0)."),
  limit: z.number().int().positive().max(AGENT_API_USER_CHANNELS_MAX_LIMIT).optional().describe(`Membership paging: visible channels to inspect (default ${AGENT_API_USER_CHANNELS_DEFAULT_LIMIT}, at most ${AGENT_API_USER_CHANNELS_MAX_LIMIT}).`),
})));

export type RaftUserRef = { kind: "agent"; value: AgentAgentInfo } | { kind: "human"; value: AgentHumanInfo };

export interface RaftUserInfo {
  user: RaftUserRef;
  /** The inspected visible channels whose roster lists the user (`joined` is the user's, not yours). */
  memberships: AgentChannelInfo[];
  /** Inspected channels whose roster the Server refused; they are not counted either way. */
  skippedChannels: number;
  /** Paging over the visible channels (`total` is all visible channels). */
  page: AgentPageInfo;
}

type UserChannelsFailure = Extract<AgentApiClientResult<"userChannels">, { ok: false }>;

/** The route's gate refused this credential (capability, grant, or runner session); `server.info` decides what remains visible. */
function isUserChannelsGateRefusal(result: UserChannelsFailure): boolean {
  if (result.error.kind !== "http") return false;
  return result.error.status === 403
    || (result.error.status === 501 && result.error.errorCode === "unsupported_capability");
}

function isUserNotFound(result: UserChannelsFailure): boolean {
  return result.error.kind === "http" && result.error.status === 404 && result.error.errorCode === AGENT_API_USER_NOT_FOUND_CODE;
}

/**
 * `raft user info <name>`: the user's visible facts (their `server.info`
 * entry) and their memberships among one page of the visible channels, in one
 * `users.channels` request. A channel whose roster the Server would refuse is
 * skipped and counted. A credential the route refuses (no `channels`
 * capability or `channel:read` grant) can read no roster, so the user is
 * looked up in `server.info` and every inspected channel is skipped.
 */
export async function userInfo(
  client: Pick<AgentApiClient, "server" | "users">,
  request: UserInfoRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftUserInfo, "info">> {
  const invalid = validateOpRequest(userInfoRequestSchema, request); if (invalid) return invalid;
  const trimmed = request.name.trim();
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!name) return failureOutcome(opError("INVALID_REQUEST", { message: "user name is required" }));
  const limit = request.limit ?? AGENT_API_USER_CHANNELS_DEFAULT_LIMIT;
  const offset = request.offset ?? 0;
  const notFound = () => failureOutcome(opError("NOT_FOUND", {
    message: `User not found or not visible: @${name}`,
    nextAction: `Run \`${formatHint(RAFT_HINTS.serverInfo({ view: "agents", query: true }), options.hints)}\` or \`${formatHint(RAFT_HINTS.serverInfo({ view: "humans", query: true }), options.hints)}\` to inspect visible users.`,
  }));

  let user: RaftUserRef;
  let memberships: AgentChannelInfo[];
  let skippedChannels: number;
  let total: number;
  const result = await client.users.channels({ name }, { offset: String(offset), limit: String(limit) });
  if (result.ok) {
    user = result.data.kind === "agent"
      ? { kind: "agent", value: result.data.user as AgentAgentInfo }
      : { kind: "human", value: result.data.user as AgentHumanInfo };
    // Current Servers send rows that describe the channel and the subject's
    // membership only; older ones sent the caller's server.info rows, whose
    // attention flags are the caller's, so those are still cleared here.
    memberships = (result.data.memberships as AgentChannelInfo[])
      .map((channel) => ({ ...channel, joined: true, muted: undefined, activityMuted: undefined }));
    skippedChannels = result.data.uncheckedCount;
    total = result.data.page.total;
  } else if (isUserNotFound(result)) {
    return notFound();
  } else if (isUserChannelsGateRefusal(result)) {
    const info = await client.server.info();
    if (!info.ok) return failureFromClientResult(info);
    const agent = info.data.agents.find((candidate) => candidate.name === name);
    const human = info.data.humans.find((candidate) => candidate.name === name);
    if (agent) user = { kind: "agent", value: agent as AgentAgentInfo };
    else if (human) user = { kind: "human", value: human as AgentHumanInfo };
    else return notFound();
    memberships = [];
    skippedChannels = info.data.channels.slice(offset, offset + limit).length;
    total = info.data.channels.length;
  } else {
    return failureFromClientResult(result);
  }

  const nextOffset = offset + limit;
  const nextHint = nextOffset < total ? RAFT_HINTS.userInfo({ name, offset: nextOffset, limit }) : null;
  const page: AgentPageInfo = {
    total,
    offset,
    limit,
    nextCommand: nextHint ? formatHint(nextHint, options.hints) : undefined,
  };
  const next: RaftNextStep | null = nextHint
    ? hintStep("next_page", nextHint, "Only one page of visible channels was inspected for memberships.", options.hints, { name: `@${name}`, offset: nextOffset, limit })
    : null;
  return {
    ok: true,
    state: "info",
    data: { user, memberships, skippedChannels, page },
    next,
    text: formatAgentUserInfo(user, memberships, page, skippedChannels),
  };
}
