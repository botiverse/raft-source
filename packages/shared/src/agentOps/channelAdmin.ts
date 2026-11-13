// Channel and server administration: create, update, archive, unarchive, add
// and remove members, and update the server profile. The Server decides on
// every call, from the agent's server role and, for update / archive /
// unarchive / remove-member, its channel-admin role in that channel; these
// operations never pre-check. A refusal's `code` and `suggestedNextAction`
// reach the caller as `serverCode` and `nextAction`; a 403 that carries no
// next action gets a permission one here (`adminFailure`), so the model is
// never left with "read the error code" and no code. Text is the CLI's
// (`raft channel create|update|archive|unarchive|add-member|remove-member`,
// `raft server update`).

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type {
  AgentApiChannelMemberAddResponse,
  AgentApiChannelMemberRemoveResponse,
  AgentApiServerUpdateResponse,
} from "../agentApiContract";
import { parseRaftRegularChannelTarget } from "../agentApiChannelJoin";
import { resolveRegularChannel } from "./channels";
import { formatHintName, hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import type { AgentApiClientFailure } from "../agentApiClient";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftFailure, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";
import { formatAgentChannelUpdated, formatChannelDeletedWithLastMember, formatLastMemberRefusal, LAST_MEMBER_DELETES_CHANNEL } from "../agentText/server";
import { CHANNEL_ANNOUNCEMENT_REF_INVALID, channelAnnouncementArtifactId } from "../channelAnnouncement";

export type RaftChannelVisibility = "public" | "private";

/** A channel after create or update: its target, id and visibility. */
export interface RaftChannelSummary {
  target: string;
  channelId: string;
  visibility: RaftChannelVisibility;
}

const visibilitySchema = lazySchema("visibilitySchema", () => z.enum(["public", "private"]));
const descriptionSchema = lazySchema("descriptionSchema", () => z.string().max(500));

export interface CreateChannelRequest {
  name: string;
  description?: string;
  visibility?: RaftChannelVisibility;
}

export const createChannelRequestSchema = lazySchema("createChannelRequestSchema", () => requestSchema<CreateChannelRequest>()(z.object({
  name: z.string().describe("The new channel's name, with or without a leading `#`."),
  description: descriptionSchema.optional().describe("What the channel is for (at most 500 characters)."),
  visibility: visibilitySchema.optional().describe("`public` (default) or `private`."),
})));

export interface UpdateChannelRequest {
  target: string;
  name?: string;
  description?: string;
  visibility?: RaftChannelVisibility;
  /** An Artifact homed in the channel (`pt_…` id or link) to make its announcement; null removes it. */
  announcement?: string | null;
}

export const updateChannelRequestSchema = lazySchema("updateChannelRequestSchema", () => requestSchema<UpdateChannelRequest>()(z.object({
  target: z.string().describe("The channel, `#channel-name`."),
  name: z.string().optional().describe("New name, with or without a leading `#`."),
  description: descriptionSchema.optional().describe("New description (at most 500 characters)."),
  visibility: visibilitySchema.optional().describe("`public` or `private`. Needs your server role (a channel-admin role is not enough), and you must be in the channel."),
  announcement: z.string().nullable().optional().describe("An Artifact homed in this channel (`pt_…` id or link) to make the channel's announcement, replacing any other; `null` removes it. The channel's owner (channel admin) or a server owner or admin only."),
})));

export interface ChannelMemberRequest {
  target: string;
  /** A human, `@handle`. Pass exactly one of `user` and `agent`. */
  user?: string;
  /** An agent, `@handle`. Pass exactly one of `user` and `agent`. */
  agent?: string;
}

export const channelMemberRequestSchema = lazySchema("channelMemberRequestSchema", () => requestSchema<ChannelMemberRequest>()(z.object({
  target: z.string().describe("The channel, `#channel-name`."),
  user: z.string().optional().describe("A human, `@handle`. Pass exactly one of user and agent."),
  agent: z.string().optional().describe("An agent, `@handle`. Pass exactly one of user and agent."),
})));

export interface ChannelMemberRemoveRequest extends ChannelMemberRequest {
  /** They may be the private channel's last member: removing them then deletes it and all its messages. Without it that removal is refused and nothing changes. */
  deleteIfLast?: boolean;
}

export const channelMemberRemoveRequestSchema = lazySchema("channelMemberRemoveRequestSchema", () => requestSchema<ChannelMemberRemoveRequest>()(z.object({
  target: z.string().describe("The channel, `#channel-name`."),
  user: z.string().optional().describe("A human, `@handle`. Pass exactly one of user and agent."),
  agent: z.string().optional().describe("An agent, `@handle`. Pass exactly one of user and agent."),
  deleteIfLast: z.boolean().optional().describe("Only when the channel and all its messages should go: if they are a private channel's last member, removing them deletes it, which can't be undone. Without it that removal is refused and nothing changes."),
})));

export interface UpdateServerRequest {
  name?: string;
  hideHumansFromMembers?: boolean;
}

export const updateServerRequestSchema = lazySchema("updateServerRequestSchema", () => requestSchema<UpdateServerRequest>()(z.object({
  name: z.string().optional().describe("The server's new name (at most 100 characters)."),
  hideHumansFromMembers: z.boolean().optional().describe("`true` hides the server's humans from ordinary members' member lists; `false` shows them."),
})));

/** A 403 with neither a server code nor a next action: a permission problem. */
export const ADMIN_PERMISSION_NEXT_ACTION = "Your role does not allow this here; ask a server owner or admin to do it, or to change your role.";

/** Next actions for the known non-role 403 codes, used when the Server sends none. */
function knownRefusalNextAction(serverCode: string, options: RaftHintOptions): string | null {
  if (serverCode === "channel_membership_required") return `Join the channel first (\`${formatHintName(RAFT_HINTS.channelJoinName(), options.hints)}\`), then retry.`;
  if (serverCode === "all_channel_visibility_managed_separately") return "Only a human can change #all's visibility, from channel settings or server settings.";
  return null;
}

/**
 * A 403 whose Server sent no next action would leave the model with "read the
 * error code". Known codes get their own next action; a 403 with no code at
 * all gets the permission sentence. Anything else is unchanged.
 */
function adminFailure(result: AgentApiClientFailure, options: RaftHintOptions = {}): RaftFailure {
  const failure = failureFromClientResult(result);
  const error = failure.error;
  if (error.status !== 403 || error.code !== "HTTP_ERROR" || error.nextAction !== opError("HTTP_ERROR").nextAction) return failure;
  const nextAction = error.serverCode === undefined ? ADMIN_PERMISSION_NEXT_ACTION : knownRefusalNextAction(error.serverCode, options);
  return nextAction ? failureOutcome({ ...error, nextAction }) : failure;
}

function visibilityOf(type: string | undefined): RaftChannelVisibility {
  return type === "private" ? "private" : "public";
}

function bareChannelName(raw: string): string {
  return raw.trim().replace(/^#/, "");
}

function bareHandle(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^@/, "");
}

export async function createChannel(
  client: Pick<AgentApiClient, "channels">,
  request: CreateChannelRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftChannelSummary, "created">> {
  const invalid = validateOpRequest(createChannelRequestSchema, request); if (invalid) return invalid;
  const name = bareChannelName(request.name);
  if (!name) return failureOutcome(opError("INVALID_REQUEST", { message: "Pass the channel name. Nothing was sent." }));
  const result = await client.channels.create({
    name,
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.visibility !== undefined ? { visibility: request.visibility } : {}),
  });
  if (!result.ok) return adminFailure(result, options);
  const target = `#${result.data.name}`;
  const visibility = visibilityOf(result.data.type);
  return {
    ok: true,
    state: "created",
    data: { target, channelId: result.data.id, visibility },
    next: hintStep("read_target", RAFT_HINTS.messageRead({ target }), "Read the new channel.", options.hints, { target }),
    text: `Created ${target} (${visibility}). You are joined and can send messages there.`,
  };
}

export async function updateChannel(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: UpdateChannelRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftChannelSummary, "updated">> {
  const invalid = validateOpRequest(updateChannelRequestSchema, request); if (invalid) return invalid;
  const name = request.name === undefined ? undefined : bareChannelName(request.name);
  if (name === "") return failureOutcome(opError("INVALID_REQUEST", { message: "The new name is empty. Nothing was sent." }));
  if (name === undefined && request.description === undefined && request.visibility === undefined && request.announcement === undefined) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a name, description, visibility, or announcement to change. Nothing was sent." }));
  }
  let channelAnnouncementId: string | null | undefined;
  if (request.announcement === null) channelAnnouncementId = null;
  else if (request.announcement !== undefined) {
    channelAnnouncementId = channelAnnouncementArtifactId(request.announcement) ?? undefined;
    if (channelAnnouncementId === undefined) return failureOutcome(opError("INVALID_REQUEST", { message: CHANNEL_ANNOUNCEMENT_REF_INVALID }));
  }
  const channel = await resolveRegularChannel(client, request.target, options);
  if ("ok" in channel) return channel;
  const result = await client.channels.update({ channelId: channel.id as never }, {
    ...(name !== undefined ? { name } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.visibility !== undefined ? { visibility: request.visibility } : {}),
    ...(channelAnnouncementId !== undefined ? { announcement: channelAnnouncementId } : {}),
  });
  if (!result.ok) return adminFailure(result, options);
  const target = `#${result.data.name}`;
  const visibility = visibilityOf(result.data.type);
  return {
    ok: true,
    state: "updated",
    data: { target, channelId: result.data.id, visibility },
    next: null,
    text: formatAgentChannelUpdated(result.data, { channelAnnouncementChanged: channelAnnouncementId !== undefined }, options.hints),
  };
}

export interface RaftChannelArchiveState {
  target: string;
  channelId: string;
  archivedAt: string | null;
}

const INVALID_CHANNEL_TARGET = "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.";

async function setChannelArchived(
  client: Pick<AgentApiClient, "channels">,
  request: { target: string },
  archived: boolean,
): Promise<RaftOutcome<RaftChannelArchiveState, "archived" | "unarchived">> {
  if (!parseRaftRegularChannelTarget(request.target ?? "")) {
    return failureOutcome(opError("INVALID_REQUEST", { message: INVALID_CHANNEL_TARGET }));
  }
  const result = archived
    ? await client.channels.archive({ target: request.target })
    : await client.channels.unarchive({ target: request.target });
  if (!result.ok) return adminFailure(result);
  const target = `#${result.data.name}`;
  const data = { target, channelId: result.data.id, archivedAt: result.data.archivedAt ?? null };
  return archived
    ? { ok: true, state: "archived", data, next: null, text: `Archived ${target}. The channel is read-only until unarchived.` }
    : { ok: true, state: "unarchived", data, next: null, text: `Unarchived ${target}. Messages and other writes are enabled again.` };
}

export async function archiveChannel(
  client: Pick<AgentApiClient, "channels">,
  request: { target: string },
): Promise<RaftOutcome<RaftChannelArchiveState, "archived" | "unarchived">> {
  return setChannelArchived(client, request, true);
}

export async function unarchiveChannel(
  client: Pick<AgentApiClient, "channels">,
  request: { target: string },
): Promise<RaftOutcome<RaftChannelArchiveState, "archived" | "unarchived">> {
  return setChannelArchived(client, request, false);
}

function memberBody(request: ChannelMemberRequest): { user: string } | { agent: string } | null {
  const user = bareHandle(request.user);
  const agent = bareHandle(request.agent);
  if ((user ? 1 : 0) + (agent ? 1 : 0) !== 1) return null;
  return user ? { user } : { agent };
}

const MEMBER_REQUIRED = "Pass exactly one of user (a human, `@handle`) and agent (an agent, `@handle`). Nothing was sent.";

export async function addChannelMember(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: ChannelMemberRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiChannelMemberAddResponse, "added" | "already_member">> {
  const invalid = validateOpRequest(channelMemberRequestSchema, request); if (invalid) return invalid;
  const body = memberBody(request);
  if (!body) return failureOutcome(opError("INVALID_REQUEST", { message: MEMBER_REQUIRED }));
  const channel = await resolveRegularChannel(client, request.target, options);
  if ("ok" in channel) return channel;
  const result = await client.channels.addMember({ channelId: channel.id as never }, body);
  if (!result.ok) return adminFailure(result, options);
  const target = `#${channel.name}`;
  const member = `@${result.data.member.name}`;
  return result.data.alreadyMember
    ? { ok: true, state: "already_member", data: result.data, next: null, text: `${member} is already in ${target}.` }
    : { ok: true, state: "added", data: result.data, next: null, text: `Added ${member} to ${target} as ${result.data.member.type === "agent" ? "an agent" : "a user"}.` };
}

interface MemberRemovalAttention {
  ordinaryActivity?: string;
  stillArrives?: string[];
  threadBoundary?: string;
  manageCommand?: string;
  manageApi?: string;
}

export async function removeChannelMember(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: ChannelMemberRemoveRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiChannelMemberRemoveResponse, "removed" | "not_member">> {
  const invalid = validateOpRequest(channelMemberRemoveRequestSchema, request); if (invalid) return invalid;
  const body = memberBody(request);
  if (!body) return failureOutcome(opError("INVALID_REQUEST", { message: MEMBER_REQUIRED }));
  const channel = await resolveRegularChannel(client, request.target, options);
  if ("ok" in channel) return channel;
  const target = `#${channel.name}`;
  const result = await client.channels.removeMember({ channelId: channel.id as never }, request.deleteIfLast ? { ...body, deleteIfLast: true } : body);
  if (!result.ok) {
    const failure = adminFailure(result, options);
    if (failure.error.serverCode !== LAST_MEMBER_DELETES_CHANNEL) return failure;
    const member = "user" in body ? { user: `@${body.user}` } : { agent: `@${body.agent}` };
    return failureOutcome({ ...failure.error, ...formatLastMemberRefusal({ target, member }, options.hints) });
  }
  const member = `@${result.data.member.name}`;
  if (!result.data.wasMember) {
    return { ok: true, state: "not_member", data: result.data, next: null, text: `${member} was not in ${target}.` };
  }
  if (result.data.channelDeleted) {
    return { ok: true, state: "removed", data: result.data, next: null, text: formatChannelDeletedWithLastMember(target, member) };
  }
  const lines = [`Removed ${member} from ${target}.`];
  const attention = (result.data.attention ?? {}) as MemberRemovalAttention;
  if (attention.ordinaryActivity) lines.push(attention.ordinaryActivity);
  if (attention.stillArrives?.length) {
    lines.push("Still arrives:");
    for (const item of attention.stillArrives) lines.push(`- ${item}`);
  }
  if (attention.threadBoundary) lines.push(attention.threadBoundary);
  return { ok: true, state: "removed", data: result.data, next: null, text: lines.join("\n") };
}

export async function updateServer(
  client: Pick<AgentApiClient, "server">,
  request: UpdateServerRequest,
): Promise<RaftOutcome<AgentApiServerUpdateResponse, "updated">> {
  const invalid = validateOpRequest(updateServerRequestSchema, request); if (invalid) return invalid;
  const name = request.name?.trim();
  if (name === "") return failureOutcome(opError("INVALID_REQUEST", { message: "The new server name is empty. Nothing was sent." }));
  if (name === undefined && request.hideHumansFromMembers === undefined) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a name or hideHumansFromMembers to change. Nothing was sent." }));
  }
  const result = await client.server.update({
    ...(name !== undefined ? { name } : {}),
    ...(request.hideHumansFromMembers !== undefined ? { hideHumansFromMembers: request.hideHumansFromMembers } : {}),
  });
  if (!result.ok) return adminFailure(result);
  return { ok: true, state: "updated", data: result.data, next: null, text: `Updated server ${result.data.name}.` };
}
