// Channel and thread attention operations: info, join, leave, mute, unmute,
// members, followed threads, unfollow. Joining is explicit and idempotent (never a side
// effect of sending). Regular-channel targets (`#name`) are resolved to ids
// through `server.info`, exactly as the CLI does; DMs and threads are not
// join/leave/mute targets.

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import { joinRaftChannelByTarget, parseRaftRegularChannelTarget } from "../agentApiChannelJoin";
import type { AgentApiChannelMembersResponse, AgentApiThreadListItem } from "../agentApiContract";
import { formatAgentChannelInfo, formatAgentChannelMembers, formatChannelDeletedWithLastMember, formatLastMemberRefusal, LAST_MEMBER_DELETES_CHANNEL, type AgentChannelInfo } from "../agentText/server";
import { formatAgentThreadList } from "../agentText/threadsProfile";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftFailure, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

/** `{ target }` of a regular channel (join, leave, mute, unmute). */
export const channelTargetRequestSchema = lazySchema("channelTargetRequestSchema", () => requestSchema<{ target: string }>()(z.object({
  target: z.string().describe("A regular channel, `#channel-name`. DMs and threads are not accepted."),
})));

export interface ChannelLeaveRequest {
  target: string;
  /** You may be the private channel's last member: leaving then deletes it and all its messages. Without it that leave is refused and nothing changes. */
  deleteIfLast?: boolean;
}

/** `{ target, deleteIfLast? }` for `channels.leave`. */
export const channelLeaveRequestSchema = lazySchema("channelLeaveRequestSchema", () => requestSchema<ChannelLeaveRequest>()(z.object({
  target: z.string().describe("A regular channel, `#channel-name`. DMs and threads are not accepted."),
  deleteIfLast: z.boolean().optional().describe("Only when the channel and all its messages should go: if you are a private channel's last member, leaving deletes it, which can't be undone. Without it that leave is refused and nothing changes."),
})));

export const channelMembersRequestSchema = lazySchema("channelMembersRequestSchema", () => requestSchema<{ target: string }>()(z.object({
  target: z.string().describe("A channel, DM, or thread target."),
})));

/** `threads.list` takes no arguments. */
export const listThreadsRequestSchema = lazySchema("listThreadsRequestSchema", () => z.object({}));

export const unfollowThreadRequestSchema = lazySchema("unfollowThreadRequestSchema", () => requestSchema<{ target: string; reason?: string }>()(z.object({
  target: z.string().describe("The thread, for example `#channel:shortid` or `dm:@peer:shortid`."),
  reason: z.string().optional().describe("Short reason, kept with the unfollow."),
})));

const INVALID_CHANNEL_TARGET = "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.";

export async function resolveRegularChannel(
  client: Pick<AgentApiClient, "server">,
  target: string,
  options: RaftHintOptions,
): Promise<{ id: string; name: string; joined: boolean } | RaftFailure> {
  const name = parseRaftRegularChannelTarget(target ?? "");
  if (!name) return failureOutcome(opError("INVALID_REQUEST", { message: INVALID_CHANNEL_TARGET }));
  const info = await client.server.info();
  if (!info.ok) return failureFromClientResult(info);
  const channel = info.data.channels.find((candidate) => candidate.name === name);
  if (!channel) {
    return failureOutcome(opError("NOT_FOUND", {
      message: `Channel not found: ${target}`,
      nextAction: `List visible channels with \`${formatHint(RAFT_HINTS.serverInfo({ view: "channels" }), options.hints)}\`; private channels need a human to add you.`,
    }));
  }
  return { id: channel.id, name: channel.name, joined: channel.joined };
}

export interface RaftChannelRef {
  target: string;
  channelId: string;
}

export async function joinChannel(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: { target: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftChannelRef, "joined" | "already_joined">> {
  const invalid = validateOpRequest(channelTargetRequestSchema, request); if (invalid) return invalid;
  const result = await joinRaftChannelByTarget(client, { target: request.target });
  if (!result.ok) {
    const error = result.error;
    if (error.kind === "validation") {
      return error.reason === "target_not_found"
        ? failureOutcome(opError("NOT_FOUND", { message: error.message, nextAction: "Only visible public channels can be joined; private and joint channels need an invitation." }))
        : failureOutcome(opError("INVALID_REQUEST", { message: error.message }));
    }
    if (error.kind === "http") {
      return failureOutcome(opError("HTTP_ERROR", {
        message: error.message,
        status: error.status,
        ...(error.errorCode ? { serverCode: error.errorCode } : {}),
        ...(error.suggestedNextAction ? { nextAction: error.suggestedNextAction } : {}),
      }));
    }
    return failureOutcome(opError("TRANSPORT_ERROR", { message: error.message }));
  }
  const state = result.data.state;
  return {
    ok: true,
    state,
    data: { target: result.data.target, channelId: result.data.channelId },
    next: hintStep("read_target", RAFT_HINTS.messageRead({ target: result.data.target }), "Read the channel before posting.", options.hints, { target: result.data.target }),
    text: state === "joined" ? `Joined ${result.data.target}.` : `Already a member of ${result.data.target}.`,
  };
}

export async function leaveChannel(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: ChannelLeaveRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftChannelRef & { channelDeleted?: true }, "left" | "not_joined">> {
  const invalid = validateOpRequest(channelLeaveRequestSchema, request); if (invalid) return invalid;
  const channel = await resolveRegularChannel(client, request.target, options);
  if ("ok" in channel) return channel;
  if (!channel.joined) {
    return { ok: true, state: "not_joined", data: { target: request.target, channelId: channel.id }, next: null, text: `You are not a member of ${request.target}; nothing to leave.` };
  }
  const result = await client.channels.leave({ channelId: channel.id as never }, request.deleteIfLast ? { deleteIfLast: true } : {});
  if (!result.ok) {
    const failure = failureFromClientResult(result);
    if (failure.error.serverCode !== LAST_MEMBER_DELETES_CHANNEL) return failure;
    return failureOutcome({ ...failure.error, ...formatLastMemberRefusal({ target: request.target }, options.hints) });
  }
  if (result.data.channelDeleted) {
    return { ok: true, state: "left", data: { target: request.target, channelId: channel.id, channelDeleted: true }, next: null, text: formatChannelDeletedWithLastMember(request.target) };
  }
  const lines = [
    `Left ${request.target}. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.`,
  ];
  const attention = (result.data as { attention?: { ordinaryActivity?: string } }).attention;
  if (attention?.ordinaryActivity) lines.push(attention.ordinaryActivity);
  return { ok: true, state: "left", data: { target: request.target, channelId: channel.id }, next: null, text: lines.join("\n") };
}

export interface RaftChannelMuteState extends RaftChannelRef {
  activityMuted: boolean;
  muteFromSeq: number | null;
  stillArrives: string[];
}

function formatSeq(value: number | null | undefined): string {
  return value == null ? "none" : String(value);
}

async function setChannelMute(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: { target: string },
  action: "mute" | "unmute",
  options: RaftHintOptions,
): Promise<RaftOutcome<RaftChannelMuteState, "muted" | "unmuted">> {
  const invalid = validateOpRequest(channelTargetRequestSchema, request); if (invalid) return invalid;
  const channel = await resolveRegularChannel(client, request.target, options);
  if ("ok" in channel) return channel;
  const result = action === "mute"
    ? await client.channels.mute({ channelId: channel.id as never }, {})
    : await client.channels.unmute({ channelId: channel.id as never });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const lines = [
    `${data.activityMuted ? "Muted" : "Unmuted"} ${request.target}.`,
    `Activity muted: ${data.activityMuted ? "yes" : "no"}`,
    `Mute from seq: ${formatSeq(data.muteFromSeq)}`,
  ];
  if (data.attention?.ordinaryActivity) lines.push(data.attention.ordinaryActivity);
  if (data.attention?.stillArrives?.length) {
    lines.push("Still arrives:");
    for (const item of data.attention.stillArrives) lines.push(`- ${item}`);
  }
  if (data.attention?.threadBoundary) lines.push(data.attention.threadBoundary);
  if (data.attention?.catchUp) lines.push(data.attention.catchUp);
  if (data.attention?.unmuteCommand) lines.push(`To unmute: ${data.attention.unmuteCommand}`);
  if (data.attention?.unmuteApi) lines.push(`Agent API: ${data.attention.unmuteApi}`);
  if (data.attention?.muteCommand) lines.push(`To mute: ${data.attention.muteCommand}`);
  if (data.attention?.muteApi) lines.push(`Agent API: ${data.attention.muteApi}`);
  return {
    ok: true,
    state: data.activityMuted ? "muted" : "unmuted",
    data: {
      target: request.target,
      channelId: channel.id,
      activityMuted: data.activityMuted === true,
      muteFromSeq: data.muteFromSeq ?? null,
      stillArrives: data.attention?.stillArrives ?? [],
    },
    next: null,
    text: lines.join("\n"),
  };
}

export function muteChannel(client: Pick<AgentApiClient, "server" | "channels">, request: { target: string }, options: RaftHintOptions = {}) {
  return setChannelMute(client, request, "mute", options);
}

export function unmuteChannel(client: Pick<AgentApiClient, "server" | "channels">, request: { target: string }, options: RaftHintOptions = {}) {
  return setChannelMute(client, request, "unmute", options);
}

export async function channelMembers(
  client: Pick<AgentApiClient, "channels">,
  request: { target: string },
): Promise<RaftOutcome<AgentApiChannelMembersResponse, "members">> {
  const invalid = validateOpRequest(channelMembersRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A channel, DM, or thread target is required." }));
  const result = await client.channels.members({ channel: request.target });
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "members", data: result.data, next: null, text: formatAgentChannelMembers(result.data) };
}

export async function listThreads(
  client: Pick<AgentApiClient, "threads">,
): Promise<RaftOutcome<AgentApiThreadListItem[], "threads" | "empty">> {
  const result = await client.threads.list();
  if (!result.ok) return failureFromClientResult(result);
  const threads = result.data.threads;
  return { ok: true, state: threads.length > 0 ? "threads" : "empty", data: threads, next: null, text: formatAgentThreadList(threads) };
}

export async function unfollowThread(
  client: Pick<AgentApiClient, "threads">,
  request: { target: string; reason?: string },
): Promise<RaftOutcome<{ target: string }, "unfollowed">> {
  const invalid = validateOpRequest(unfollowThreadRequestSchema, request); if (invalid) return invalid;
  if (!request.target?.includes(":")) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A thread target is required, for example '#channel:shortid' or 'dm:@peer:shortid'." }));
  }
  const result = await client.threads.unfollow({ thread: request.target, ...(request.reason ? { reason: request.reason } : {}) });
  if (!result.ok) return failureFromClientResult(result);
  return {
    ok: true,
    state: "unfollowed",
    data: { target: request.target },
    next: null,
    text: `Unfollowed ${request.target}. Ordinary delivery from this thread stops; a direct @mention reactivates the follow.`,
  };
}

export const channelInfoRequestSchema = lazySchema("channelInfoRequestSchema", () => requestSchema<{ target: string }>()(z.object({
  target: z.string().describe("A regular channel, `#channel-name` (the `#` may be omitted). DMs and threads are not accepted."),
})));

export interface RaftChannelInfo {
  /** The channel as `server.info` lists it (`joined` and the attention flags are yours). */
  channel: AgentChannelInfo;
  /** Roster counts, or null when the Server refused the roster (the text then omits `Members:`). */
  memberCounts: { agents: number; humans: number } | null;
}

/**
 * `raft channel info <target>`: the channel's facts from `server.info`, plus
 * member counts from its roster when the Server shows it.
 */
export async function channelInfo(
  client: Pick<AgentApiClient, "server" | "channels">,
  request: { target: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftChannelInfo, "info">> {
  const invalid = validateOpRequest(channelInfoRequestSchema, request); if (invalid) return invalid;
  const trimmed = request.target.trim();
  const input = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  const name = parseRaftRegularChannelTarget(input);
  if (!name) {
    return failureOutcome(opError("INVALID_REQUEST", {
      message: "Target must be a regular channel name, e.g. '#engineering' or 'engineering'. DMs and thread targets are not supported.",
    }));
  }
  const info = await client.server.info();
  if (!info.ok) return failureFromClientResult(info);
  let channel = (info.data.channels as AgentChannelInfo[]).find((candidate) => candidate.name === name);
  // Not a live channel: it may be archived (read-only, still readable), which
  // the default listing leaves out. Ask once more for the archived ones.
  if (!channel && (info.data.archivedChannelCount ?? 0) > 0) {
    const archived = await client.server.info({ archived: "include" });
    if (!archived.ok) return failureFromClientResult(archived);
    const row = (archived.data.archivedChannels as AgentChannelInfo[] | undefined)?.find((candidate) => candidate.name === name);
    if (row) channel = { ...row, archived: true };
  }
  if (!channel) {
    return failureOutcome(opError("NOT_FOUND", {
      message: `Channel not found or not visible: ${input}`,
      nextAction: `Run \`${formatHint(RAFT_HINTS.serverInfo({ view: "channels", query: true }), options.hints)}\` to inspect visible channels, or ask a channel member to add you if this is private.`,
    }));
  }
  const members = await client.channels.members({ channel: `#${name}` });
  const memberCounts = members.ok
    ? { agents: members.data.agents?.length ?? 0, humans: members.data.humans?.length ?? 0 }
    : null;
  return {
    ok: true,
    state: "info",
    data: { channel, memberCounts },
    next: null,
    text: formatAgentChannelInfo(channel, memberCounts, options.hints),
  };
}
