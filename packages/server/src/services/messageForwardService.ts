/**
 * The one path a person forwards messages by: the web's `POST /messages/forward`
 * and a personal assistant forwarding as its owner (RFC 077 send-as-owner with
 * `forwardMessageIds`) both run these functions as that person, so whatever
 * the owner can forward, and only that, the assistant can forward for them.
 *
 * - `parseForwardSourceMessageIds`: 1 to MAX_FORWARD_BUNDLE_ITEMS distinct full ids.
 * - `buildForwardedBundleMetadata`: every source is in this server (or a joint
 *   projection of it), the forwarder can read it, it is inside the plan's
 *   history window, an ordinary chat message (not itself a forward), and all
 *   come from one conversation. A source the forwarder cannot read is a 404
 *   that names nothing about it. Only public channels' pointers are carried.
 * - `forwardBundleAsUser`: the forwarder can post in the destination and it is
 *   writable on the plan, then `persistForwardBundle` re-checks source and
 *   destination authority in the writing transaction.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import {
  formatRaftChannelTaskRef,
  isSubConversationType,
  MAX_FORWARD_MESSAGES,
  type ForwardedBundleAuthorSnapshot,
  type ForwardedBundleItem,
  type ForwardedBundleMetadata as ServedForwardedBundleMetadata,
  type ForwardedBundleTargetSnapshot,
  type ServerId,
} from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as userService from "./userService";
import * as agentService from "./agentService";
import * as serverService from "./serverService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { getTaskForConversationChannel } from "./taskConversationService";
import { getServerHistoryWindowForRead, humanHistoryLimitedError, isBehindHistoryWindow } from "./historyWindow";
import { channelBillingReadOnlyBody, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "./planService";
import { checkHumanPostAdmission, HUMAN_POST_REFUSALS } from "./humanPostAdmission";
import { canView } from "./visibilityService";
import {
  firstLine,
  formatForwardConversationTarget,
  listForwardConversationCandidates,
  parseForwardConversationQuery,
  type ForwardConversationCandidate,
  type ForwardConversationTarget,
} from "./forwardConversationTargets";
import { persistForwardBundle, type InternalForwardBundleMetadata } from "./attachmentForwardService";
import { getAttachmentsForMessages, normalizeAttachmentFilename, resolveAttachmentMimeType } from "../routes/attachments";
import { isMessageShortId, UUID_RE } from "../lib/messageId";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";

/** Source messages resolved at once: a forward carries at most 20 (the web's cap), each a few reads. */
const FORWARD_SOURCE_CONCURRENCY = 4;

/** At most this many messages in one forward (shared with the web's composer). */
export const MAX_FORWARD_BUNDLE_ITEMS = MAX_FORWARD_MESSAGES;

/** More ids than one forward may carry: the request gets `too_many_messages`, not the generic 400. */
export function isOverForwardMessageCap(value: unknown): boolean {
  return Array.isArray(value) && value.length > MAX_FORWARD_BUNDLE_ITEMS;
}

export const FORWARD_TOO_MANY_MESSAGES_ERROR = `You can forward up to ${MAX_FORWARD_MESSAGES} messages at a time`;

export class ForwardRequestError extends Error {
  /** A refusal because of one source message: its position in the request's list. */
  sourceIndex?: number;

  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly code: string,
    readonly diagnosticCode: string = code,
  ) {
    super(message);
  }
}

/** Tags a ForwardRequestError thrown for one source message with that message's position. */
async function atSourceIndex<T>(index: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ForwardRequestError && err.sourceIndex === undefined) err.sourceIndex = index;
    throw err;
  }
}

export function parseForwardSourceMessageIds(value: unknown): string[] | "invalid" {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORWARD_BUNDLE_ITEMS) return "invalid";
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (ids.some((id) => !UUID_RE.test(id))) return "invalid";
  if (new Set(ids).size !== ids.length) return "invalid";
  return ids;
}


/**
 * The agent API's form of the same list: each id full, or the 8-character
 * short id agents read as `msg=`, resolved in this server the way the rest of
 * the agent API resolves message ids, then `parseForwardSourceMessageIds` (the
 * cap, distinct ids). A short id that matches nothing is the same 404 as a
 * message the forwarder cannot read; visibility is still checked by
 * `buildForwardedBundleMetadata`.
 */
export async function resolveForwardSourceMessageIds(serverId: string, value: unknown): Promise<string[] | "invalid"> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORWARD_BUNDLE_ITEMS) return "invalid";
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    const id = typeof item === "string" ? item.trim() : "";
    if (UUID_RE.test(id)) {
      ids.push(id);
      continue;
    }
    if (!isMessageShortId(id)) return "invalid";
    const resolved = await messageService.resolveMessageIdInServer(serverId, id);
    if (!resolved.ok) {
      const err = resolved.status === 404
        ? new ForwardRequestError(404, "Source message not found", "source_not_found")
        : new ForwardRequestError(400, resolved.error, "invalid_request");
      err.sourceIndex = index;
      throw err;
    }
    ids.push(resolved.messageId);
  }
  return parseForwardSourceMessageIds(ids);
}

function forwardRequestDigest(opts: {
  serverId: string;
  userId: string;
  sourceMessageIds: string[];
  destinationChannelId: string;
  note: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      serverId: opts.serverId,
      userId: opts.userId,
      sourceMessageIds: opts.sourceMessageIds,
      destinationChannelId: opts.destinationChannelId,
      note: opts.note,
    }))
    .digest("hex");
}

function hasActionMetadata(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function isForwardedBundleActionMetadata(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "forwarded-bundle";
}

async function getSenderSnapshot(
  senderType: "user" | "agent" | "external_projection",
  senderId: string,
  externalAuthor?: messageService.EnrichedMessageRow["externalAuthor"],
) {
  if (senderType === "user") {
    const user = await userService.getUser(senderId);
    return {
      type: senderType,
      id: senderId,
      name: user?.displayName || user?.name || "User",
      uniqueName: user?.name || "unknown",
    };
  }

  if (senderType === "external_projection") {
    return {
      type: senderType,
      id: senderId,
      name: externalAuthor?.displayName ?? "External user",
    };
  }

  const agent = await agentService.getAgent(senderId);
  return {
    type: senderType,
    id: senderId,
    name: agent?.displayName || agent?.name || "Agent",
    uniqueName: agent?.name || "unknown",
  };
}

type MessageChannel = NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;

type ForwardSourceContext = {
  bundleSourceId: string;
  sourceTargetId: string | null;
  sourceThreadId?: string;
  sourceParentMessageId?: string;
  parentChannelId?: string;
  displayType?: MessageChannel["type"];
  snapshotChannel: MessageChannel;
  /** Task v2: the source is a task conversation; the label names the task (`#channel:#7`). */
  sourceTask?: { id: string; number: number; title: string };
};

function sourceTargetSnapshot(channel: MessageChannel, displayType = channel.type, sourceTask?: { number: number }) {
  if (channel.type === "channel") {
    return {
      id: channel.id,
      type: displayType,
      label: sourceTask ? formatRaftChannelTaskRef(channel.name, sourceTask.number) : `#${channel.name}`,
      labelVisibility: "public",
    };
  }

  return {
    id: null,
    type: displayType,
    label: "",
    labelVisibility: "restricted",
  };
}

async function resolveForwardSourceVisibleChannel(opts: {
  serverId: ServerId;
  storageChannel: MessageChannel;
}): Promise<MessageChannel | null> {
  const { serverId, storageChannel } = opts;

  if (isSubConversationType(storageChannel.type)) {
    if (storageChannel.serverId === serverId) return storageChannel;
    const localThreadProjection = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(storageChannel.id))
      .find((projection) => projection.localServerId === serverId);
    return localThreadProjection?.threadChannel ?? null;
  }

  // Joint messages live in a dedicated canonical storage channel whose type
  // is `channel`, not `joint`. Resolve both that canonical id and a caller's
  // local projection through the active joint mapping before applying the
  // ordinary same-server fence.
  const localChannelProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(storageChannel.id))
    .find((projection) => projection.serverId === serverId);
  if (localChannelProjection) return localChannelProjection.channel;

  if (storageChannel.serverId !== serverId) return null;
  return storageChannel;
}

async function resolveForwardSourceContext(opts: {
  serverId: ServerId;
  message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;
  messageChannel: MessageChannel;
  storageMessageChannel?: MessageChannel;
  selectedThreadChannelIds: ReadonlySet<string>;
}): Promise<ForwardSourceContext> {
  const { message, messageChannel } = opts;
  const storageMessageChannel = opts.storageMessageChannel ?? messageChannel;
  if (messageChannel.type === "task") {
    // Task v2: a message of a task conversation. The parent channel (on the
    // visible conversation's row: the local channel of a joint projection)
    // supplies visibility and the label; the task names the source.
    const parentChannel = messageChannel.parentChannelId
      ? await channelService.getChannel(messageChannel.parentChannelId)
      : null;
    const task = await getTaskForConversationChannel(storageMessageChannel.id);
    if (!parentChannel || isSubConversationType(parentChannel.type) || !task) {
      throw new ForwardRequestError(400, "Forwarding from this task is not supported", "unsupported_source");
    }
    const publicTaskSource = parentChannel.type === "channel";
    return {
      bundleSourceId: storageMessageChannel.id,
      sourceTargetId: publicTaskSource ? messageChannel.id : null,
      parentChannelId: publicTaskSource ? parentChannel.id : undefined,
      displayType: "task",
      snapshotChannel: parentChannel,
      sourceTask: { id: task.taskId, number: task.taskNumber, title: task.taskTitle },
    };
  }
  if (messageChannel.type !== "thread") {
    const threadInfo = await channelService.getThreadInfo(message.id);
    const threadChannelId = threadInfo?.threadChannelId ?? message.threadId;
    if (threadChannelId && opts.selectedThreadChannelIds.has(threadChannelId)) {
      return {
        bundleSourceId: threadChannelId,
        sourceTargetId: messageChannel.type === "channel" ? threadChannelId : null,
        sourceThreadId: threadChannelId,
        sourceParentMessageId: message.id,
        parentChannelId: messageChannel.id,
        displayType: "thread",
        snapshotChannel: messageChannel,
      };
    }
    return {
      bundleSourceId: messageChannel.id,
      sourceTargetId: messageChannel.type === "channel" ? messageChannel.id : null,
      snapshotChannel: messageChannel,
    };
  }

  const parentMessageId = storageMessageChannel.parentMessageId ?? messageChannel.parentMessageId;
  if (!parentMessageId) {
    throw new ForwardRequestError(400, "Forwarding from this thread is not supported", "unsupported_source");
  }
  const parentMessage = await messageService.getMessage(parentMessageId);
  if (!parentMessage) {
    throw new ForwardRequestError(400, "Forwarding from this thread is not supported", "unsupported_source");
  }
  const storageParentChannel = await channelService.getChannel(parentMessage.channelId);
  if (!storageParentChannel || storageParentChannel.type === "thread") {
    throw new ForwardRequestError(400, "Forwarding from this thread is not supported", "unsupported_source");
  }
  const parentChannel = await resolveForwardSourceVisibleChannel({
    serverId: opts.serverId,
    storageChannel: storageParentChannel,
  });
  if (!parentChannel || parentChannel.type === "thread") {
    throw new ForwardRequestError(400, "Forwarding from this thread is not supported", "unsupported_source");
  }

  const publicThreadSource = parentChannel.type === "channel";
  return {
    bundleSourceId: storageMessageChannel.id,
    sourceTargetId: publicThreadSource ? messageChannel.id : null,
    sourceThreadId: publicThreadSource ? messageChannel.id : undefined,
    sourceParentMessageId: parentMessage.id,
    parentChannelId: publicThreadSource ? parentChannel.id : undefined,
    displayType: "thread",
    snapshotChannel: parentChannel,
  };
}

export async function buildForwardedBundleMetadata(opts: {
  serverId: ServerId;
  forwarderUserId: string;
  /**
   * RFC 077: an assistant forwarding for its owner (`forwarderUserId`). Each
   * source is then read as the delegated actor: the owner's visibility minus
   * the DMs the assistant may not read (assistantDmScope), so a source in a
   * DM (or a thread or task conversation under one) is the same
   * `source_not_found` as one the owner cannot see.
   */
  delegatedByAgentId?: string;
  sourceMessageIds: string[];
}) {
  const sourceRows: Array<{
    message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;
    channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
    storageChannel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
  }> = [];

  const historyWindow = await getServerHistoryWindowForRead(opts.serverId);
  for (const [index, id] of opts.sourceMessageIds.entries()) {
    await atSourceIndex(index, async () => {
      const resolved = await messageService.resolveMessageIdInServer(opts.serverId, id);
      if (!resolved.ok) {
        throw new ForwardRequestError(resolved.status, resolved.error, "source_not_found");
      }

      const message = await messageService.getMessage(resolved.messageId);
      if (!message) throw new ForwardRequestError(404, "Source message not found", "source_not_found");

      const channel = await channelService.getChannel(message.channelId);
      if (!channel) {
        throw new ForwardRequestError(400, "Forwarding across servers is not supported", "cross_server_source");
      }
      const visibleChannel = await resolveForwardSourceVisibleChannel({
        serverId: opts.serverId,
        storageChannel: channel,
      });
      if (!visibleChannel) {
        throw new ForwardRequestError(400, "Forwarding across servers is not supported", "cross_server_source");
      }
      // The forwarder must see the source conversation (canView; re-checked
      // under lock by persistForwardBundle's source authority). An assistant
      // forwarding for its owner reads it as the delegated actor.
      const [canReadSource] = await canView(
        opts.delegatedByAgentId
          ? { type: "delegated", id: opts.forwarderUserId, agentId: opts.delegatedByAgentId, serverId: opts.serverId }
          : { type: "user", id: opts.forwarderUserId, serverId: opts.serverId },
        [{ kind: "conversation", channelId: visibleChannel.id }],
      );
      if (!canReadSource) {
        throw new ForwardRequestError(404, "Source message not found", "source_not_found");
      }
      // After access: a source behind the plan's history window can't be copied
      // into a message inside it (services/historyWindow.ts).
      if (isBehindHistoryWindow(message.createdAt, historyWindow)) {
        throw new ForwardRequestError(404, humanHistoryLimitedError(historyWindow).error, "history_limited");
      }

      if (isForwardedBundleActionMetadata(message.actionMetadata)) {
        throw new ForwardRequestError(
          400,
          "Forwarded messages can't be forwarded. Select the original message instead.",
          "forwarded_source_not_supported",
        );
      }

      if (message.messageType !== "chat" || hasActionMetadata(message.actionMetadata)) {
        throw new ForwardRequestError(400, "Only ordinary chat messages can be forwarded", "unsupported_source_message");
      }

      sourceRows.push({ message, channel: visibleChannel, storageChannel: channel });
    });
  }

  const selectedThreadChannelIds = new Set(
    sourceRows.flatMap(({ channel, storageChannel }) => storageChannel.type === "thread"
      ? [storageChannel.id, channel.id]
      : []),
  );
  const contextualSourceRows = await mapWithConcurrency(sourceRows, FORWARD_SOURCE_CONCURRENCY, async ({ message, channel, storageChannel }, index) => ({
    message,
    channel: {
      ...channel,
      forwardSourceContext: await atSourceIndex(index, () => resolveForwardSourceContext({
        serverId: opts.serverId,
        message,
        messageChannel: channel,
        storageMessageChannel: storageChannel,
        selectedThreadChannelIds,
      })),
    },
  }));

  const sourceChannelIds = new Set(contextualSourceRows.map((row) => row.channel.forwardSourceContext.bundleSourceId));
  if (sourceChannelIds.size !== 1) {
    throw new ForwardRequestError(400, "Forwarded bundles must come from a single source", "cross_source_bundle");
  }

  const forwarder = await getSenderSnapshot("user", opts.forwarderUserId);
  const forwardedAt = new Date().toISOString();
  const orderedRows = [...contextualSourceRows].sort((a, b) => {
    const aParent = a.channel.forwardSourceContext.sourceParentMessageId === a.message.id;
    const bParent = b.channel.forwardSourceContext.sourceParentMessageId === b.message.id;
    if (aParent !== bParent) return aParent ? -1 : 1;
    const createdAtDelta = a.message.createdAt.getTime() - b.message.createdAt.getTime();
    if (createdAtDelta !== 0) return createdAtDelta;
    const seqDelta = a.message.seq - b.message.seq;
    if (seqDelta !== 0) return seqDelta;
    return a.message.id.localeCompare(b.message.id);
  });
  const attachmentMap = await getAttachmentsForMessages(orderedRows.map(({ message }) => message.id));

  return {
    kind: "forwarded-bundle",
    version: 1,
    sourceAuthorityChannelIds: orderedRows.map(({ channel }) => channel.forwardSourceContext.snapshotChannel.id),
    forwardedBy: forwarder,
    forwardedAt,
    forwardedItems: await mapWithConcurrency(orderedRows, FORWARD_SOURCE_CONCURRENCY, async ({ message, channel }, index) => {
      const sourceContext = channel.forwardSourceContext;
      const sourceSnapshot = sourceTargetSnapshot(sourceContext.snapshotChannel, sourceContext.displayType ?? channel.type, sourceContext.sourceTask);
      const exposesSourcePointers = sourceSnapshot.labelVisibility === "public" && Boolean(sourceContext.sourceTargetId);
      return {
        index,
        sourceIsThreadParent: sourceContext.sourceParentMessageId === message.id,
        sourceHostMessageId: message.id,
        sourceServerId: exposesSourcePointers ? opts.serverId : null,
        sourceTargetId: exposesSourcePointers ? sourceContext.sourceTargetId : null,
        ...(exposesSourcePointers && sourceContext.sourceThreadId ? { sourceThreadId: sourceContext.sourceThreadId } : {}),
        ...(exposesSourcePointers && sourceContext.parentChannelId ? { parentChannelId: sourceContext.parentChannelId } : {}),
        ...(exposesSourcePointers && sourceContext.sourceTask
          ? {
              sourceTaskId: sourceContext.sourceTask.id,
              sourceTaskNumber: sourceContext.sourceTask.number,
              sourceTaskTitle: sourceContext.sourceTask.title,
            }
          : {}),
        sourceMessageId: exposesSourcePointers ? message.id : null,
        sourceMessageSeq: exposesSourcePointers ? message.seq : null,
        sourceTargetSnapshot: sourceSnapshot,
        sourceAuthorSnapshot: await getSenderSnapshot(message.senderType, message.senderId),
        sourceCreatedAt: message.createdAt.toISOString(),
        contentSnapshot: message.content,
        attachmentSnapshots: (attachmentMap.get(message.id) ?? [])
          .map((attachment) => ({
            sourceProjectionId: attachment.id,
            filename: normalizeAttachmentFilename(attachment.filename),
            mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
          })),
        attachmentPolicy: "pending-projection",
        provenanceState: "available",
      };
    }),
  };
}


/** A forward's message text: its note, or "Forwarded N messages" without one. */
export function forwardMessageContent(note: string, itemCount: number): string {
  return note || `Forwarded ${itemCount} message${itemCount === 1 ? "" : "s"}`;
}

export type ForwardedBundleMetadata = Awaited<ReturnType<typeof buildForwardedBundleMetadata>>;

// A client is served a forward with exactly the keys of shared
// ForwardedBundleMetadata, which FORWARDED_BUNDLE_*_KEYS mark for the mobile
// App's V2: this bundle as persistForwardBundle stores it (each item without
// sourceHostMessageId, its attachments the destination's copies, checked
// there) plus what forwardBundleAsUser adds (checked there); reads only take
// keys out. So a key added here fails to compile until the shared type, and
// the App's list of it, have it.
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type SameKeys<Built, Served> =
  [Exclude<KeysOfUnion<Built>, KeysOfUnion<Served>>, Exclude<KeysOfUnion<Served>, KeysOfUnion<Built>>] extends [never, never]
    ? true
    : { notInShared: Exclude<KeysOfUnion<Built>, KeysOfUnion<Served>>; notBuilt: Exclude<KeysOfUnion<Served>, KeysOfUnion<Built>> };
type Assert<T extends true> = T;
type BuiltForwardedItem = ForwardedBundleMetadata["forwardedItems"][number];
type _ServedForwardedItemKeys = [
  Assert<SameKeys<Omit<BuiltForwardedItem, "sourceHostMessageId">, ForwardedBundleItem>>,
  Assert<SameKeys<BuiltForwardedItem["sourceAuthorSnapshot"] | ForwardedBundleMetadata["forwardedBy"], ForwardedBundleAuthorSnapshot>>,
  Assert<SameKeys<BuiltForwardedItem["sourceTargetSnapshot"], ForwardedBundleTargetSnapshot>>,
];

/**
 * Where a forward into `destination` is stored, and (for a thread or task
 * conversation) the channel holding it, whose membership admits the post.
 * A thread qualifies while its parent message is live and top-level; a task
 * conversation while its task exists. Joint faces store in canonical storage.
 */
export async function resolveForwardDestinationStorage(
  serverId: string,
  destination: MessageChannel,
): Promise<{ storageChannelId: string; parentChannelId: string | null }> {
  if (destination.type === "joint") {
    const projection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(destination.id))
      .find((candidate) => candidate.localChannelId === destination.id);
    return { storageChannelId: projection?.canonicalChannelId ?? destination.id, parentChannelId: null };
  }
  if (!isSubConversationType(destination.type)) return { storageChannelId: destination.id, parentChannelId: null };

  const unavailable = () => new ForwardRequestError(404, "Conversation not found", "destination_unavailable", "destination_conversation_unavailable");
  const jointThread = await channelService.getJointThreadProjectionByLocalThread(destination.id, serverId);
  const storageChannelId = jointThread?.canonicalThreadChannelId ?? destination.id;
  if (destination.type === "task") {
    const task = await getTaskForConversationChannel(storageChannelId);
    const parentChannelId = jointThread?.localParentChannelId ?? destination.parentChannelId;
    if (!task || !parentChannelId) throw unavailable();
    return { storageChannelId, parentChannelId };
  }
  const storageChannel = jointThread ? await channelService.getChannel(storageChannelId) : destination;
  const parentMessage = storageChannel?.parentMessageId ? await messageService.getMessage(storageChannel.parentMessageId) : null;
  const parentMessageChannel = parentMessage && !parentMessage.deletedAt ? await channelService.getChannel(parentMessage.channelId) : null;
  // Never under a reply: the parent message must sit in a top-level conversation.
  if (!parentMessage || !parentMessageChannel || isSubConversationType(parentMessageChannel.type)) throw unavailable();
  return { storageChannelId, parentChannelId: jointThread?.localParentChannelId ?? parentMessage.channelId };
}

/** The idempotency key a forward with `requestId` stores on its message in `channelId` (`messages.random_id`). */
export function forwardRequestRandomId(requestId: string, channelId: string): string {
  return `forward:${requestId}:${channelId}`;
}

/**
 * Forward a bundle built by `buildForwardedBundleMetadata` into one
 * destination as `userId`: the destination checks, then the transactional
 * persist (which re-checks every authority) and the ordinary broadcast.
 * `delegatedByAgentId` marks a forward an assistant made for its owner.
 */
export async function forwardBundleAsUser(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: string;
  userId: string;
  senderName: string;
  targetChannelId: string;
  /** The message text: the note, or "Forwarded N messages". */
  content: string;
  note: string;
  sourceMessageIds: string[];
  bundleMetadata: ForwardedBundleMetadata;
  requestId?: string | null;
  randomId?: string | null;
  delegatedByAgentId?: string | null;
  onPaywallHit?: (gate: "joint_channel_read_only") => void;
  onPhase?: (phase: "persist_broadcast") => void;
}) {
  const { serverId, userId, targetChannelId, requestId } = input;
  // The same admission as a send / reply in this conversation.
  const admission = await checkHumanPostAdmission(serverId, userId, targetChannelId);
  if (!admission.ok) {
    if (admission.refusal === "billing_read_only") {
      if (admission.billing.reason === "joint_over_limit") input.onPaywallHit?.("joint_channel_read_only");
      throw new ForwardRequestError(403, channelBillingReadOnlyBody(admission.billing).error, "destination_unavailable", "destination_billing_read_only");
    }
    const refusal = HUMAN_POST_REFUSALS[admission.refusal];
    throw new ForwardRequestError(refusal.status, refusal.error, "destination_unavailable", `destination_${admission.refusal}`);
  }
  const destination = admission.channel;
  const { storageChannelId: destinationStorageChannelId, parentChannelId: destinationParentChannelId } =
    await resolveForwardDestinationStorage(serverId, destination);
  // The pipeline's archive gate (an archived parent freezes its threads
  // and task conversations), run before the bundle is persisted.
  await channelService.assertChannelNotArchived(targetChannelId);

  const requestDigest = requestId
    ? forwardRequestDigest({
        serverId,
        userId,
        sourceMessageIds: input.sourceMessageIds,
        destinationChannelId: targetChannelId,
        note: input.note,
      })
    : null;
  const actionMetadata = {
    ...input.bundleMetadata,
    destinationTargetId: targetChannelId,
    ...(requestDigest ? { _forwardRequestDigest: requestDigest } : {}),
  };
  // Stored without sourceAuthorityChannelIds; no read serves the digest.
  type _ServedForwardedBundleKeys = Assert<SameKeys<
    Omit<typeof actionMetadata, "sourceAuthorityChannelIds" | "_forwardRequestDigest">, ServedForwardedBundleMetadata
  >>;
  input.onPhase?.("persist_broadcast");
  const persisted = await persistForwardBundle({
    destinationStorageChannelId,
    destinationRequestChannelId: targetChannelId,
    destinationParentChannelId,
    senderId: userId,
    content: input.content,
    randomId: requestId
      ? forwardRequestRandomId(requestId, targetChannelId)
      : input.randomId ?? `forward-${randomUUID()}`,
    sourceMessageIds: input.sourceMessageIds,
    requestServerId: serverId,
    metadata: actionMetadata as InternalForwardBundleMetadata,
    ...(input.delegatedByAgentId ? { delegatedByAgentId: input.delegatedByAgentId } : {}),
  });
  // slack-bridge-ordinary-message-producer: messages.forward_bundle
  const enriched = await messageService.broadcastAndDeliver(input.io, input.orchestrator, {
    channelId: targetChannelId,
    senderType: "user",
    senderId: userId,
    senderName: input.senderName,
    content: input.content,
    randomId: persisted.message.randomId ?? undefined,
    actionMetadata: persisted.message.actionMetadata,
    prePersisted: persisted,
    ...(input.delegatedByAgentId ? { delegatedByAgentId: input.delegatedByAgentId } : {}),
  });
  // A thread / task destination: the context its message:new carries, so
  // "View in chat" opens that conversation.
  const conversationContext = await messageService.frontendConversationContextFor(destination, destinationParentChannelId);
  return {
    message: messageService.projectForwardDestinationMessage(conversationContext ? { ...enriched, conversationContext } : enriched),
    replayed: persisted.replayed,
    messageId: persisted.message.id,
    createdAt: persisted.message.createdAt,
  };
}

const MAX_FORWARD_SEARCH_LIMIT = 20;

/** One place a person can forward to, as the web's forward composer lists it. */
export type ForwardSearchTarget = {
  type: "channel" | "dm" | "human" | "agent";
  channelType: "channel" | "private" | "joint" | "dm" | null;
  id: string;
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  channelId: string | null;
  joined: boolean | null;
  dmExists: boolean | null;
  canForwardNow: boolean;
  requiredAction: "join_channel" | "create_dm" | null;
  /** Not on the web's response: the unique name (channel name, or the person's / agent's handle). */
  handle: string;
  /** Not on the web's response: what a DM's peer (or a person / agent row) is. */
  peerKind: "human" | "agent" | null;
};

function scoreMatch(query: string, candidate: string): number {
  if (!candidate) return 0;
  if (candidate === query) return 400;
  if (candidate.startsWith(query)) return 300;
  const wordBoundaryIndex = candidate.indexOf(` ${query}`);
  if (wordBoundaryIndex >= 0) return 250;
  const containsIndex = candidate.indexOf(query);
  if (containsIndex >= 0) return Math.max(1, 150 - containsIndex);
  return 0;
}

/**
 * Of `candidates` (in order), the first `limit` the person can see and could
 * forward into right now: canView on the conversation, then the send / reply
 * admission and archive gate a forward there would pass, then a live parent.
 * Labels are built only for admitted rows, so nothing about a conversation the
 * person can't see or post in leaves the server.
 */
export async function admitForwardConversationTargets(opts: {
  serverId: ServerId;
  userId: string;
  candidates: ForwardConversationCandidate[];
  limit: number;
  dmChannels?: Awaited<ReturnType<typeof channelService.listDMChannels>>;
}): Promise<ForwardConversationTarget[]> {
  const { serverId, userId, candidates, limit } = opts;
  if (candidates.length === 0 || limit <= 0) return [];
  const visible = await canView(
    { type: "user", id: userId, serverId },
    candidates.map((candidate) => ({ kind: "conversation" as const, channelId: candidate.channelId })),
  );
  let dmChannels = opts.dmChannels;
  const admitted: ForwardConversationTarget[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (admitted.length >= limit) break;
    if (!visible[index]) continue;
    const admission = await checkHumanPostAdmission(serverId, userId, candidate.channelId);
    if (!admission.ok || await channelService.isChannelArchived(candidate.channelId)) continue;
    let parentChannelId: string | null;
    try {
      parentChannelId = (await resolveForwardDestinationStorage(serverId, admission.channel)).parentChannelId;
    } catch (error) {
      if (error instanceof ForwardRequestError) continue;
      throw error;
    }
    const parent = parentChannelId ? await channelService.getChannel(parentChannelId) : null;
    if (!parent) continue;
    const parentType = parent.type;
    if (isSubConversationType(parentType)) continue;
    let dmPeerName: string | null = null;
    if (parent.type === "dm") {
      dmChannels ??= await channelService.listDMChannels(serverId, userId);
      const dm = dmChannels.find((candidateDm) => candidateDm.id === parent.id);
      if (!dm) continue;
      dmPeerName = dm.peerName || dm.peerDisplayName || dm.name;
    }
    admitted.push(formatForwardConversationTarget(
      candidate,
      { id: parent.id, name: parent.name, type: parentType },
      dmPeerName,
    ));
  }
  return admitted;
}

/**
 * Search order of thread / task candidates: a thread by its parent message's
 * first line, a task by its title or its number (`7`, `#7`). A candidate the
 * SQL prefilter kept only for text past the first line is dropped.
 */
function rankForwardConversationCandidates(q: string, candidates: ForwardConversationCandidate[]): ForwardConversationCandidate[] {
  const { taskNumber } = parseForwardConversationQuery(q);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: candidate.type === "task"
        ? Math.max(
            taskNumber !== null && candidate.taskNumber === taskNumber ? 400 : 0,
            scoreMatch(q, (candidate.taskTitle ?? "").toLowerCase()),
          )
        : scoreMatch(q, firstLine(candidate.parentMessageContent ?? "").toLowerCase()),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

/**
 * The web forward composer's target search (`GET /messages/forward/targets/search`),
 * as `userId` sees this server: channels they can forward to (an unjoined
 * public channel marked join_channel), their DMs, and agents and people they
 * could open a new DM with (create_dm); then, ranked after every other kind
 * while the limit leaves room, threads and task conversations they take part
 * in (`conversations`). Also the personal assistant's
 * `assistantSearchForwardTargets`, run as its owner.
 */
export async function searchForwardTargets(input: {
  serverId: ServerId;
  userId: string;
  q: string;
  limit?: number;
}): Promise<{ targets: ForwardSearchTarget[]; conversations: ForwardConversationTarget[] }> {
  const { serverId, userId } = input;
  const q = input.q.trim().toLowerCase();
  const limit = Math.min(Math.max(1, input.limit || MAX_FORWARD_SEARCH_LIMIT), MAX_FORWARD_SEARCH_LIMIT);
  if (!q) return { targets: [], conversations: [] };
  const requesterRole = await getActorServerRoleInServer(serverId, "user", userId);

  const [allChannels, dmChannels, allAgents, hideHumanDirectory] = await Promise.all([
    channelService.listChannels(serverId, userId),
    channelService.listDMChannels(serverId, userId),
    requesterRole === "guest" ? Promise.resolve([]) : agentService.listAgents(serverId, false, { memberListsOnly: true }),
    serverService.shouldHideHumanDirectoryFromRequester(serverId, userId),
  ]);
  const members = hideHumanDirectory || requesterRole === "guest"
    ? []
    : await serverService.getServerMembers(serverId, userId);

  const results: Array<ForwardSearchTarget & { score: number }> = [];

  for (const ch of allChannels) {
    if ((ch.type !== "channel" && ch.type !== "private" && ch.type !== "joint") || ch.archivedAt) continue;
    const name = ch.name.toLowerCase();
    const score = scoreMatch(q, name);
    if (score <= 0) continue;
    const isJoined = (ch as { joined?: boolean }).joined === true;
    if (requesterRole === "guest" && !(await channelService.canUserPostToChannel(ch.id, userId))) continue;
    if (ch.type !== "channel") {
      if (!isJoined || !(await channelService.canUserPostToChannel(ch.id, userId))) continue;
      if (
        await isChannelReadOnlyByBillingFeature(ch.id, serverId)
        || await isChannelReadOnlyByQuota(ch.id, serverId)
      ) continue;
    }
    results.push({
      type: "channel",
      channelType: ch.type,
      id: ch.id,
      title: `#${ch.name}`,
      subtitle: ch.description ?? "",
      avatarUrl: null,
      channelId: ch.id,
      joined: isJoined,
      dmExists: null,
      canForwardNow: ch.type !== "channel" || isJoined,
      requiredAction: ch.type === "channel" && !isJoined ? "join_channel" : null,
      handle: ch.name,
      peerKind: null,
      score: score + (isJoined ? 50 : 0),
    });
  }

  for (const dm of dmChannels) {
    const label = dm.peerDisplayName || dm.peerName || dm.name;
    const searchable = [label, dm.peerName, dm.peerDisplayName].filter(Boolean).map((s) => s!.toLowerCase());
    const score = Math.max(...searchable.map((s) => scoreMatch(q, s)));
    if (score <= 0) continue;
    results.push({
      type: "dm",
      channelType: "dm",
      id: dm.peerId,
      title: `@${label}`,
      subtitle: dm.peerType === "agent" ? "agent" : "",
      avatarUrl: dm.peerAvatarUrl ?? null,
      channelId: dm.id,
      joined: null,
      dmExists: true,
      canForwardNow: true,
      requiredAction: null,
      handle: dm.peerName,
      peerKind: dm.peerType === "agent" ? "agent" : "human",
      score: score + 50,
    });
  }

  const existingDmPeerIds = new Set(dmChannels.map((dm) => dm.peerId));
  for (const agent of allAgents) {
    if (existingDmPeerIds.has(agent.id)) continue;
    const searchable = [agent.name, agent.displayName].filter(Boolean).map((s) => s!.toLowerCase());
    const score = Math.max(0, ...searchable.map((s) => scoreMatch(q, s)));
    if (score <= 0) continue;
    results.push({
      type: "agent",
      channelType: null,
      id: agent.id,
      title: `@${agent.displayName || agent.name}`,
      subtitle: "agent",
      avatarUrl: agent.avatarUrl ?? null,
      channelId: null,
      joined: null,
      dmExists: false,
      canForwardNow: false,
      requiredAction: "create_dm",
      handle: agent.name,
      peerKind: "agent",
      score,
    });
  }

  for (const member of members) {
    if (member.userId === userId) continue;
    if (existingDmPeerIds.has(member.userId)) continue;
    const searchable = [member.name, member.displayName].filter(Boolean).map((s) => s!.toLowerCase());
    const score = Math.max(0, ...searchable.map((s) => scoreMatch(q, s)));
    if (score <= 0) continue;
    results.push({
      type: "human",
      channelType: null,
      id: member.userId,
      title: `@${member.displayName || member.name}`,
      subtitle: "",
      avatarUrl: member.avatarUrl ?? null,
      channelId: null,
      joined: null,
      dmExists: false,
      canForwardNow: false,
      requiredAction: "create_dm",
      handle: member.name,
      peerKind: "human",
      score,
    });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const targets = results.slice(0, limit).map(({ score: _score, ...rest }) => rest);
  // Threads and task conversations rank after every other kind of target.
  const conversations = targets.length >= limit ? [] : await admitForwardConversationTargets({
    serverId,
    userId,
    candidates: rankForwardConversationCandidates(
      q,
      await listForwardConversationCandidates({
        serverId,
        userId,
        query: parseForwardConversationQuery(q),
        // Parents behind the plan's history window match and show only their glimpse.
        historyCutoff: (await getServerHistoryWindowForRead(serverId)).cutoff,
      }),
    ),
    limit: limit - targets.length,
    dmChannels,
  });
  return { targets, conversations };
}
