import { parseAgentTaskRef, parseDmPeerRef } from "@botiverse/raft-shared";
import * as assistantService from "../services/assistantService";
import { resolveAppBotDmPeerUserId } from "../services/appBotIdentityService";
import { type AppSubject, parseAppSubject } from "../services/appSubjectService";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/index";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { channels, messages, tasks } from "../db/schema";
import * as channelService from "../services/channelService";
import { ensureTaskConversation, resolveLocalTaskConversationId } from "../services/taskConversationService";
import { isTaskV2ConversationsEnabled } from "../services/taskConversationsGate";
import { broadcastCreatedTaskConversation } from "../services/taskMutationBroadcast";
import { taskUsesOwnConversation } from "../services/taskV2Mode";
import { isHistoricalJointTaskReadOnly, resolveTaskChannelSurface } from "../services/taskChannelSurface";
import type { Response } from "express";
import { refuse } from "../lib/refusal";
import type { Server as SocketServer } from "socket.io";
import { messageIdShortPrefixConditions, uuidShortIdRange } from "../lib/messageId";
import { isAppId } from "../services/rapRegistry";
import { AGENT_REMINDERS_DM_PEER } from "../services/agentPrivateSurfaces";
import { getBuiltInConversationChannel } from "../services/rapRegistryStore";

type ParsedThreadTarget =
  | { kind: "channel"; channelName: string; shortId: string }
  | { kind: "dm"; peerName: string; shortId: string };

export type ResolvedWritableAgentTarget =
  | { channelId: string; type: "channel" | "private" | "joint" | "dm" | "thread" }
  | "forbidden"
  | UnwritableTaskConversation
  | "peer-not-found"
  | "self-dm"
  | null;

function parseThreadTarget(target: string): ParsedThreadTarget | null {
  const channelMatch = target.match(/^#(.+):([0-9a-f]{8})$/i);
  if (channelMatch) {
    const [, channelName, shortId] = channelMatch;
    return { kind: "channel", channelName, shortId };
  }

  if (target.startsWith("dm:@") || target.startsWith("DM:@")) {
    const rest = target.slice(4);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const peerName = rest.slice(0, lastColon);
      const shortId = rest.slice(lastColon + 1);
      if (/^[0-9a-f]{8}$/i.test(shortId)) {
        return { kind: "dm", peerName, shortId };
      }
    }
  }

  return null;
}

export function isThreadTarget(target: string): boolean {
  return parseThreadTarget(target) !== null;
}

/**
 * The root message a thread target's 8-hex suffix names. Read-only. The suffix
 * is tried as a message short id in `parentLookupChannelId`, then as a thread
 * channel id short form anywhere in the server (`threadId=` in the header):
 * a thread id names a thread that already exists, and the reply still lands on
 * its parent message. Callers check that the message belongs to the parent
 * target they named.
 */
async function findThreadTargetParentMessage(
  serverId: string,
  parentLookupChannelId: string,
  shortId: string,
): Promise<{ id: string; channelId: string } | null> {
  const db = getDb();
  let parentMsgs = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(and(
      eq(messages.channelId, parentLookupChannelId),
      ...messageIdShortPrefixConditions(shortId),
    ))
    .limit(2);

  if (parentMsgs.length !== 1) {
    const bounds = uuidShortIdRange(shortId);
    const threadCandidates = await db
      .select({ id: channels.id, parentMessageId: channels.parentMessageId })
      .from(channels)
      .where(and(
        eq(channels.serverId, serverId),
        eq(channels.type, "thread"),
        gte(channels.id, bounds.lower),
        ...(bounds.upper ? [lt(channels.id, bounds.upper)] : []),
        isNull(channels.deletedAt),
        isNotNull(channels.parentMessageId),
      ))
      .limit(2);
    if (threadCandidates.length !== 1 || !threadCandidates[0].parentMessageId) return null;
    parentMsgs = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, threadCandidates[0].parentMessageId))
      .limit(1);
    if (parentMsgs.length !== 1) return null;
  }

  return parentMsgs[0] ?? null;
}

async function resolveOrCreateThreadTarget(
  serverId: string,
  agentId: string,
  target: string
): Promise<string | "forbidden" | null> {
  const parsed = parseThreadTarget(target);
  if (!parsed) return null;

  let localParentChannelId: string | null = null;
  let parentLookupChannelId: string | null = null;
  let builtInAppParentChannelId: string | null = null;
  if (parsed.kind === "channel") {
    const localChannel = await channelService.resolveChannelByName(serverId, agentId, `#${parsed.channelName}`);
    if (!localChannel || !["channel", "private", "joint"].includes(localChannel.type)) {
      return null;
    }
    parentLookupChannelId = localChannel.channelId;
    if (localChannel.type === "joint") {
      const resolved = await channelService.resolveChannelAccess({ serverId, channelId: localChannel.channelId });
      if (resolved?.kind === "joint") {
        localParentChannelId = localChannel.channelId;
        parentLookupChannelId = resolved.canonicalChannelId;
      }
    }
  } else {
    const dmChannel = await channelService.resolveChannelByName(serverId, agentId, `dm:@${parsed.peerName}`);
    if (!dmChannel || dmChannel.type !== "dm") return null;
    parentLookupChannelId = dmChannel.channelId;
    if (isAppId(parsed.peerName)) {
      const builtInAppDm = await getBuiltInConversationChannel(serverId, parsed.peerName, agentId);
      if (builtInAppDm?.id === dmChannel.channelId) {
        builtInAppParentChannelId = builtInAppDm.id;
      }
    }
  }

  const parentMsg = await findThreadTargetParentMessage(serverId, parentLookupChannelId, parsed.shortId);
  if (!parentMsg) return null;
  const parentChannel = await channelService.getChannel(parentMsg.channelId);
  if (!parentChannel) return null;

  if (parsed.kind === "channel") {
    const visibleParentChannel = localParentChannelId ? await channelService.getChannel(localParentChannelId) : parentChannel;
    if (!visibleParentChannel || !["channel", "private", "joint"].includes(visibleParentChannel.type) || visibleParentChannel.name !== parsed.channelName) {
      return null;
    }
  } else {
    if (parentChannel.type !== "dm") return null;
    // `peerName` may carry an explicit kind (`Twin~agent`); compare members
    // against the bare name, and only members of that kind.
    const parsedPeer = parseDmPeerRef(parsed.peerName);
    if (!parsedPeer.ok) return null;
    const { peerName: bareName, peerKind } = parsedPeer;
    const humans = peerKind === "agent" ? [] : await channelService.getChannelHumans(parentMsg.channelId);
    const agents = peerKind === "human" ? [] : await channelService.getChannelAgents(parentMsg.channelId);
    if (
      !humans.some((human) => human.name === bareName)
      && !agents.some((agent) => agent.name === bareName && (peerKind !== "agent" || agent.id !== agentId))
      && builtInAppParentChannelId !== parentMsg.channelId
    ) {
      return null;
    }
  }

  // Thread post authority = parent channel/DM membership. Following a thread
  // grants listen access only; it must not grant send rights.
  const canPostToParent = await channelService.canAgentPostToChannel(localParentChannelId ?? parentMsg.channelId, agentId);
  if (!canPostToParent) return "forbidden";

  const thread = await channelService.getOrCreateThreadForChannel(localParentChannelId ?? parentMsg.channelId, parentMsg.id, agentId, "agent");
  return thread.id;
}

/**
 * Task v2: the task conversation a task ref (`#channel:#7`, `dm:@peer:#7`)
 * names, as this agent's server sees it (a joint channel's local projection).
 * This is how every message target — `message send`, `message read`, action
 * cards — reaches a task conversation, so daemons and CLIs from before task
 * v2, which copy the delivered target `#parent:#7`, keep working; newer CLIs
 * use `raft task reply|read` instead.
 *
 * - `{ kind: "conversation" }`: it exists (`create`: created now, lazily —
 *   for a v2 task whatever the flag, for a task from before task v2 on a
 *   server with task conversations).
 * - `{ kind: "pending" }` (`create: false`): no conversation yet, same rule.
 * - `"forbidden"` (`create`): the agent may not post in the task's channel.
 * - `"read-only"` (`create`): a historical joint task, from a participant
 *   workspace; `"archived"` (`create`): its channel is archived. Neither
 *   creates a conversation.
 * - null: no such task, or a pre-v2 task without a conversation on a server
 *   with task conversations off — the ref then keeps its pre-v2 answer (not
 *   found).
 */
export type AgentTaskRefConversation =
  | { kind: "conversation"; channelId: string; taskId: string; boardChannelId: string; ref: string; created: boolean }
  | { kind: "pending"; taskId: string; boardChannelId: string; ref: string }
  | "forbidden"
  | UnwritableTaskConversation
  | null;

/** A task conversation no one may post in from here (see `resolveAgentTaskRefConversation`). */
export type UnwritableTaskConversation = "read-only" | "archived";

/** Answers a send to an unwritable task conversation: 403 read-only, 409 archived. True when it answered. */
export function rejectUnwritableTaskConversation(resolved: unknown, res: Response): resolved is UnwritableTaskConversation {
  if (resolved === "read-only") {
    refuse(res, 403, { code: "joint_task_read_only", error: "Historical tasks are read-only from a participant workspace" });
    return true;
  }
  if (resolved === "archived") {
    refuse(res, 409, { code: "channel_archived", error: "This channel is archived" });
    return true;
  }
  return false;
}

export async function resolveAgentTaskRefConversation(
  serverId: string,
  agentId: string,
  target: string,
  opts: { create: boolean; io?: SocketServer | null },
): Promise<AgentTaskRefConversation> {
  const parsed = parseAgentTaskRef(target);
  if (!parsed) return null;
  const board = await channelService.resolveChannelByName(serverId, agentId, parsed.target);
  if (!board || board.type === "thread") return null;
  let storageChannelId = board.channelId;
  if (board.type === "joint") {
    const access = await channelService.resolveChannelAccess({ serverId, channelId: board.channelId });
    if (access?.kind !== "joint") return null;
    storageChannelId = access.canonicalChannelId;
  }
  const [task] = await getDb()
    .select({ id: tasks.id, conversationChannelId: tasks.conversationChannelId, ownConversation: tasks.ownConversation, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.channelId, storageChannelId), eq(tasks.taskNumber, parsed.taskNumber)))
    .limit(1);
  if (!task) return null;
  // Per-task mode: a v2 task keeps its conversation whatever the flag; a
  // pre-v2 task gets one only where the flag is on.
  if (!taskUsesOwnConversation(task, await isTaskV2ConversationsEnabled(serverId))) return null;
  if (opts.create) {
    if (!await channelService.canAgentPostToChannel(board.channelId, agentId)) return "forbidden";
    // Before a conversation is created: a task that is read-only here, or one
    // in an archived channel, gets none. (Posting in an existing one under an
    // archived channel is refused by the send's own archive check.)
    const surface = await resolveTaskChannelSurface(serverId, board.channelId);
    if (surface && isHistoricalJointTaskReadOnly(surface, task.createdAt)) return "read-only";
    if (!task.conversationChannelId && await channelService.isChannelArchived(board.channelId)) return "archived";
  }
  let created = false;
  if (!task.conversationChannelId) {
    if (!opts.create) return { kind: "pending", taskId: task.id, boardChannelId: board.channelId, ref: parsed.ref };
    const ensured = await ensureTaskConversation(task.id, { initiatingServerId: serverId });
    if (!ensured) return null;
    created = ensured.created;
    if (created) await broadcastCreatedTaskConversation(opts.io, task.id);
  }
  const channelId = await resolveLocalTaskConversationId(task.id, board.channelId);
  if (!channelId) return opts.create ? null : { kind: "pending", taskId: task.id, boardChannelId: board.channelId, ref: parsed.ref };
  return { kind: "conversation", channelId, taskId: task.id, boardChannelId: board.channelId, ref: parsed.ref, created };
}

/** `#parent:#7`, or `#parent:#7:<8 hex>` (a pre-v2 CLI's per-row reply target), as the task ref. */
/**
 * The task ref a message target names: the ref itself (`#parent:#7`), or the
 * reply target a CLI from before task v2 prints for each row it read there
 * (`#parent:#7:<msg short id>`), which is the same conversation.
 */
export function taskRefOfMessageTarget(target: string): string | null {
  const trimmed = target.trim();
  if (parseAgentTaskRef(trimmed)) return trimmed;
  const rowTarget = /^(.+):[0-9a-f]{8}$/i.exec(trimmed);
  return rowTarget && parseAgentTaskRef(rowTarget[1]!) ? rowTarget[1]! : null;
}

export async function resolveWritableAgentTarget(
  serverId: string,
  agentId: string,
  target: string,
  opts: {
    /** Realtime: a task conversation created here (lazily) is announced on its boards. */
    io?: SocketServer | null;
    /**
     * The message send routes only: the request's credential, so a live App
     * Bot may name a DM `dm:sub:<sub>` (the one exception to the agent-facing
     * identity reference contract, packages/cli/AGENTS.md). Without it the
     * form is a target like any other unknown string.
     */
    appSubjectDm?: { credentialId: string | undefined };
  } = {},
): Promise<ResolvedWritableAgentTarget> {
  if (opts.appSubjectDm && target.startsWith(APP_SUBJECT_DM_TARGET_PREFIX)) {
    return resolveWritableAppSubjectDm(serverId, agentId, opts.appSubjectDm.credentialId, target);
  }

  // Task v2: a task ref names the task's conversation (a thread-like
  // sub-conversation); its first post creates it for an older task. A CLI
  // from before task v2 reading `#parent:#7` prints each row's reply target
  // as `#parent:#7:<msg short id>` — that is the same conversation.
  const taskRefTarget = taskRefOfMessageTarget(target);
  if (taskRefTarget) {
    const conversation = await resolveAgentTaskRefConversation(serverId, agentId, taskRefTarget, { create: true, io: opts.io });
    if (conversation === "forbidden" || conversation === "read-only" || conversation === "archived") return conversation;
    if (conversation?.kind === "conversation") return { channelId: conversation.channelId, type: "thread" };
  }

  const isDmTarget = target.startsWith("dm:@") || target.startsWith("DM:@");
  const dmPeerPart = isDmTarget ? target.slice(4) : "";
  const dmLastColon = dmPeerPart.lastIndexOf(":");
  const isDmThread = isDmTarget && dmLastColon > 0 && /^[0-9a-f]+$/i.test(dmPeerPart.slice(dmLastColon + 1));
  const dmPeerName = isDmThread ? dmPeerPart.slice(0, dmLastColon) : dmPeerPart;
  // `~agent` / `~human` is the --peer-kind suffix; it never makes the reserved
  // reminders handle sendable.
  if (isDmTarget && dmPeerName.replace(/~(agent|human)$/i, "").toLowerCase() === AGENT_REMINDERS_DM_PEER) {
    throw DmTargetResolutionError.privateReminderSurface();
  }

  if (isDmTarget && !isDmThread) {
    const peerName = dmPeerPart;
    // Existing DMs are resolved through the authenticated-agent path first.
    // This includes registry-owned built-in app conversations, whose physical
    // identity is derived from this exact agentId. The ref never carries an
    // owner, so Agent A cannot resolve (and therefore cannot write to) Agent
    // B's app conversation.
    const existingDm = await channelService.resolveChannelByName(serverId, agentId, target);
    if (existingDm?.type === "dm" && await channelService.isAgentMigrationReceiptChannel(existingDm.channelId)) {
      throw DmTargetResolutionError.migrationReceiptReadOnly(target);
    }
    if (existingDm?.type === "dm") {
      const canPost = await channelService.canAgentPostToChannel(existingDm.channelId, agentId);
      return canPost ? existingDm : "forbidden";
    }

    // resolveChannelByName above already refused an unknown peer kind.
    const parsedPeer = parseDmPeerRef(peerName);
    if (!parsedPeer.ok) return "peer-not-found";
    const { peerName: bareName, peerKind } = parsedPeer;
    const targetUserId = peerKind === "agent" ? null : await channelService.resolveUserByName(serverId, bareName);
    const targetAgentId = peerKind === "human" ? null : await channelService.resolveAgentByName(serverId, bareName, { agentId });
    // Creating a new DM from a bare name shared by a human and an agent would
    // silently pick the human; make the caller name the one they mean.
    if (peerKind === null && targetUserId && targetAgentId && targetAgentId !== agentId) {
      throw DmTargetResolutionError.ambiguous(bareName);
    }

    if (targetUserId) return resolveWritableHumanDm(serverId, agentId, targetUserId);

    // RFC 074 §2: an assistant may open a DM only with its owner, a human
    // (resolveWritableHumanDm holds the rule for human peers).
    if (await assistantService.getAssistantOwnerUserId(agentId)) return "forbidden";

    if (!targetAgentId) return "peer-not-found";
    if (targetAgentId === agentId) {
      return "self-dm";
    }

    const dmChannel = await channelService.findOrCreateAgentDM(serverId, agentId, targetAgentId);
    return dmChannel ? { channelId: dmChannel.id, type: "dm" } : null;
  }

  const threadResult = await resolveOrCreateThreadTarget(serverId, agentId, target);
  if (threadResult === "forbidden") return "forbidden";
  if (threadResult) return { channelId: threadResult, type: "thread" };

  const resolved = await channelService.resolveChannelByName(serverId, agentId, target);
  if (resolved) {
    const canPost = await channelService.canAgentPostToChannel(resolved.channelId, agentId);
    return canPost ? resolved : "forbidden";
  }

  return null;
}

/**
 * Post access to the DM between `agentId` and the human `targetUserId`,
 * opening it when there is none yet: the one human-peer DM path. `dm:@name`
 * and `dm:@name~human` reach it once the name resolved to a person,
 * `dm:sub:<sub>` once the App subject did.
 */
async function resolveWritableHumanDm(
  serverId: string,
  agentId: string,
  targetUserId: string,
): Promise<ResolvedWritableAgentTarget> {
  const existingDm = await channelService.findHumanAgentDm(serverId, agentId, targetUserId);
  if (existingDm) {
    return await channelService.canAgentPostToChannel(existingDm.channelId, agentId) ? existingDm : "forbidden";
  }
  // RFC 074 §2: an assistant may open a DM only with its owner.
  const assistantOwnerUserId = await assistantService.getAssistantOwnerUserId(agentId);
  if (assistantOwnerUserId && targetUserId !== assistantOwnerUserId) return "forbidden";
  // Mirrors POST /channels/dm: a guest can't be added to a NEW DM (existing DMs resolved above).
  if (await getActorServerRoleInServer(serverId, "user", targetUserId) === "guest") return "forbidden";
  const dmChannel = await channelService.findOrCreateDM(serverId, targetUserId, agentId);
  return dmChannel ? { channelId: dmChannel.id, type: "dm" } : null;
}

/**
 * `dm:sub:<sub>`: an App Bot's DM with a person, named by the `sub` its App
 * received when they signed in with Raft. App Bots only, top-level DMs only
 * (no `:<short id>` thread suffix); see packages/cli/AGENTS.md. Not
 * `dm:user:`: that is the inert spelling of `dm:@name` (thirdPartyInertRenderer,
 * search previews) and a legacy alias of it in task refs, so a person's name
 * and an App's subject never share a prefix.
 */
export const APP_SUBJECT_DM_TARGET_PREFIX = "dm:sub:";

/** The App subject a `dm:sub:<sub>` target names; null for anything else, a thread suffix included. */
export function parseAppSubjectDmTarget(target: string): AppSubject | null {
  if (!target.startsWith(APP_SUBJECT_DM_TARGET_PREFIX)) return null;
  return parseAppSubject(target.slice(APP_SUBJECT_DM_TARGET_PREFIX.length));
}

/**
 * Every miss is null, which the send routes answer exactly as they answer any
 * target they cannot resolve (404 `target_not_found`, agentRouteRefusals.ts): a caller that is
 * not a live App Bot, a malformed or unknown subject, a person outside the
 * Bot's Server, a guest, a retired account. A resolved person then goes
 * through the same DM path as `dm:@name~human`.
 */
async function resolveWritableAppSubjectDm(
  serverId: string,
  agentId: string,
  credentialId: string | undefined,
  target: string,
): Promise<ResolvedWritableAgentTarget> {
  const sub = parseAppSubjectDmTarget(target);
  if (!sub) return null;
  const userId = await resolveAppBotDmPeerUserId({ serverId, agentId, credentialId, sub });
  if (!userId) return null;
  return resolveWritableHumanDm(serverId, agentId, userId);
}

/** Where a `raft message send --target` would land, for the typing line: the conversation and, for a thread reply, its root message. */
export type AgentPostTargetPreview = { channelId: string; parentMessageId: string | null };

/** Same cap the CLI target can reasonably reach; anything longer is not a target. */
export const AGENT_POST_TARGET_PREVIEW_MAX_LENGTH = 512;

/**
 * Read-only twin of `resolveWritableAgentTarget` for the agent typing line
 * (`agent:send_intent`): it never creates a thread or a DM, and answers null
 * for anything it cannot resolve to exactly one conversation the agent may
 * post to now.
 *
 *   - `#chan`                       -> that channel (channel / private / #all)
 *   - `#chan:<id>`, `dm:@peer:<id>` -> the parent conversation plus the root
 *                                      message (the thread may not exist yet)
 *   - `dm:@peer[~agent|~human]`     -> the EXISTING DM with that peer, else null
 *
 * Refused (null): joint channels (their room fan-out runs through
 * projections), the private reminders DM, migration receipts, an ambiguous or
 * malformed peer, an archived conversation, and anything the agent may not
 * post to (`canAgentPostToChannel`, the send path's own check).
 */
export async function previewAgentPostTarget(
  serverId: string,
  agentId: string,
  target: string,
): Promise<AgentPostTargetPreview | null> {
  if (!target || target.length > AGENT_POST_TARGET_PREVIEW_MAX_LENGTH) return null;
  try {
    return await previewAgentPostTargetUnchecked(serverId, agentId, target);
  } catch (err) {
    // Ambiguous / malformed DM peers throw on the send path; here they are simply not a target.
    if (err instanceof DmTargetResolutionError) return null;
    throw err;
  }
}

async function previewAgentPostTargetUnchecked(
  serverId: string,
  agentId: string,
  target: string,
): Promise<AgentPostTargetPreview | null> {
  const isDmTarget = target.startsWith("dm:@") || target.startsWith("DM:@");
  const thread = parseThreadTarget(target);
  if (isDmTarget) {
    const peerName = thread?.kind === "dm" ? thread.peerName : target.slice(4);
    if (peerName.replace(/~(agent|human)$/i, "").toLowerCase() === AGENT_REMINDERS_DM_PEER) return null;
  }

  if (thread) {
    const parent = thread.kind === "channel"
      ? await channelService.resolveChannelByName(serverId, agentId, `#${thread.channelName}`)
      : await channelService.resolveChannelByName(serverId, agentId, `dm:@${thread.peerName}`);
    if (!parent || !isPreviewableConversationType(parent.type)) return null;
    if (thread.kind === "channel" ? parent.type === "dm" : parent.type !== "dm") return null;
    const parentMsg = await findThreadTargetParentMessage(serverId, parent.channelId, thread.shortId);
    if (!parentMsg || parentMsg.channelId !== parent.channelId) return null;
    if (!await agentMayPostNow(parent.channelId, parent.type, agentId)) return null;
    return { channelId: parent.channelId, parentMessageId: parentMsg.id };
  }

  const resolved = await channelService.resolveChannelByName(serverId, agentId, target);
  if (!resolved || !isPreviewableConversationType(resolved.type)) return null;
  if (!await agentMayPostNow(resolved.channelId, resolved.type, agentId)) return null;
  return { channelId: resolved.channelId, parentMessageId: null };
}

function isPreviewableConversationType(type: string): type is "channel" | "private" | "dm" {
  return type === "channel" || type === "private" || type === "dm";
}

/** The send path's checks, without its side effects: post permission, migration receipt (DM), archive. */
async function agentMayPostNow(channelId: string, type: "channel" | "private" | "dm", agentId: string): Promise<boolean> {
  if (type === "dm" && await channelService.isAgentMigrationReceiptChannel(channelId)) return false;
  if (!await channelService.canAgentPostToChannel(channelId, agentId)) return false;
  return !await channelService.isChannelArchived(channelId);
}
