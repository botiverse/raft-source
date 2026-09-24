import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as messageService from "../services/messageService.js";
import * as channelService from "../services/channelService.js";
import * as userService from "../services/userService.js";
import * as agentService from "../services/agentService.js";
import * as serverService from "../services/serverService.js";
import * as searchService from "../services/searchService.js";
import * as onboardingService from "../services/onboardingService.js";
import { getServerPlan, getHistoryCutoff, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "../services/planService.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { failpoints, type ServerId } from "@botiverse/raft-shared";
import { addTraceEvent, createTraceDbQueryTracer, safeAddTraceEvent, tracePhase } from "../tracing/semanticTrace.js";
import {
  boundedUnexpectedForwardError,
  forwardCommitState,
  recordForwardTerminal,
  type ForwardDiagnosticPhase,
} from "../tracing/messageForwardTrace.js";
import { messageSearchErrorTraceAttrs, messageSearchParamTraceAttrs } from "../tracing/messageSearchTrace.js";
import { getDb } from "../db/index.js";
import { getAttachmentsForMessages, normalizeAttachmentFilename, resolveAttachmentMimeType } from "./attachments.js";
import { AttachmentLinkError } from "../services/attachmentLinkingService.js";
import { isAttachmentPreviewUnifiedEnabledForServer } from "../config/attachmentPreviewUnified.js";
import { isMessageForwardingEnabledForServer } from "../config/messageForwarding.js";
import { bindRequestAbortSignal } from "./requestAbortSignal.js";
import {
  executeMentionActionId,
  type MentionActionExecutionOptions,
  type MentionActionKind,
  type MentionActionResult,
} from "../services/mentionActionService.js";
import { projectRichMessageSocketPayload } from "../services/messageRealtimeEvents.js";
import { CHANNEL_NOT_FOUND_BODY, denyChannelAccess } from "./channelAccessDenial.js";
import {
  hydrateReactionViewer,
  InvalidReactionActorsCursorError,
  listReactionActors,
  mutateMessageReaction,
  projectReactionViewerSnapshot,
  ReactionActorVisibilityChangedError,
  ReactionDiscussionVersionChangedError,
} from "../services/messageReactionService.js";
import {
  ForwardPersistenceError,
  persistForwardBundle,
  type InternalForwardBundleMetadata,
} from "../services/attachmentForwardService.js";
import { projectSlackBridgeOutboundAdmissionFailure } from "../services/externalDeliveryOutboxService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";

export const messageRouter: RouterType = Router();
export const messageV2Router: RouterType = Router();

const MAX_MESSAGE_LENGTH = 32_000;
const MAX_RANDOM_ID_LENGTH = 128;
const INVALID_RANDOM_ID = Symbol("invalidRandomId");
const MAX_REACTION_LENGTH = 16;
const MAX_FORWARD_BUNDLE_ITEMS = 20;
const MAX_FORWARD_DESTINATIONS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wire parser for picker-confirmed mention intent — payload contract / rationale
// lives next to messageService.StructuredMentionInput. Exported so the
// attachment-comment route (a sibling message transport) validates mentions
// identically instead of growing a second parser.
export function parseStructuredMentions(value: unknown): messageService.StructuredMentionInput[] | "invalid" {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "invalid";
  const mentions: messageService.StructuredMentionInput[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return "invalid";
    const raw = item as Record<string, unknown>;
    const { type, id, name } = raw;
    if ((type !== "user" && type !== "agent") || typeof id !== "string" || !UUID_RE.test(id)) return "invalid";
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 128) return "invalid";
    const mention: messageService.StructuredMentionInput = { type, id, name: name.trim() };
    const key = `${mention.type}:${mention.id}:${mention.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }
  return mentions;
}

function parseRandomId(value: unknown): string | undefined | typeof INVALID_RANDOM_ID {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return INVALID_RANDOM_ID;
  if (value.length === 0 || value.length > MAX_RANDOM_ID_LENGTH) return INVALID_RANDOM_ID;
  return value;
}

type HumanMessageCreateBody = {
  channelId: string;
  content: unknown;
  attachmentIds?: string[];
  asTask: boolean;
};

function parseHumanMessageCreateBody(value: unknown): HumanMessageCreateBody | "invalid" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const raw = value as Record<string, unknown>;
  if (typeof raw.channelId !== "string" || !UUID_RE.test(raw.channelId)) return "invalid";

  let attachmentIds: string[] | undefined;
  if (raw.attachmentIds !== undefined) {
    if (!Array.isArray(raw.attachmentIds)) return "invalid";
    if (raw.attachmentIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) return "invalid";
    attachmentIds = raw.attachmentIds;
  }

  let asTask = false;
  if (raw.asTask !== undefined) {
    if (typeof raw.asTask !== "boolean") return "invalid";
    asTask = raw.asTask;
  }

  return {
    channelId: raw.channelId,
    content: raw.content,
    attachmentIds,
    asTask,
  };
}

class ForwardRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly code: string,
    readonly diagnosticCode: string = code,
  ) {
    super(message);
  }
}

function parseForwardSourceMessageIds(value: unknown): string[] | "invalid" {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORWARD_BUNDLE_ITEMS) return "invalid";
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (ids.some((id) => !UUID_RE.test(id))) return "invalid";
  if (new Set(ids).size !== ids.length) return "invalid";
  return ids;
}

function parseForwardDestinationChannelIds(value: unknown): string[] | "invalid" | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (ids.some((id) => !UUID_RE.test(id))) return "invalid";
  const canonicalIds = [...new Set(ids)];
  if (canonicalIds.length > MAX_FORWARD_DESTINATIONS) return "invalid";
  return canonicalIds;
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
};

function sourceTargetSnapshot(channel: MessageChannel, displayType = channel.type) {
  if (channel.type === "channel") {
    return {
      id: channel.id,
      type: displayType,
      label: `#${channel.name}`,
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

  if (storageChannel.type === "thread") {
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

async function buildForwardedBundleMetadata(opts: {
  serverId: ServerId;
  forwarderUserId: string;
  sourceMessageIds: string[];
}) {
  const sourceRows: Array<{
    message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;
    channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
    storageChannel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
  }> = [];

  for (const id of opts.sourceMessageIds) {
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
    const canReadSource = await channelService.canUserAccessChannel(visibleChannel.id, opts.forwarderUserId, opts.serverId);
    if (!canReadSource) {
      throw new ForwardRequestError(404, "Source message not found", "source_not_found");
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
  }

  const selectedThreadChannelIds = new Set(
    sourceRows.flatMap(({ channel, storageChannel }) => storageChannel.type === "thread"
      ? [storageChannel.id, channel.id]
      : []),
  );
  const contextualSourceRows = await Promise.all(sourceRows.map(async ({ message, channel, storageChannel }) => ({
    message,
    channel: {
      ...channel,
      forwardSourceContext: await resolveForwardSourceContext({
        serverId: opts.serverId,
        message,
        messageChannel: channel,
        storageMessageChannel: storageChannel,
        selectedThreadChannelIds,
      }),
    },
  })));

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
    forwardedItems: await Promise.all(orderedRows.map(async ({ message, channel }, index) => {
      const sourceContext = channel.forwardSourceContext;
      const sourceSnapshot = sourceTargetSnapshot(sourceContext.snapshotChannel, sourceContext.displayType ?? channel.type);
      const exposesSourcePointers = sourceSnapshot.labelVisibility === "public" && Boolean(sourceContext.sourceTargetId);
      return {
        index,
        sourceIsThreadParent: sourceContext.sourceParentMessageId === message.id,
        sourceHostMessageId: message.id,
        sourceServerId: exposesSourcePointers ? opts.serverId : null,
        sourceTargetId: exposesSourcePointers ? sourceContext.sourceTargetId : null,
        ...(exposesSourcePointers && sourceContext.sourceThreadId ? { sourceThreadId: sourceContext.sourceThreadId } : {}),
        ...(exposesSourcePointers && sourceContext.parentChannelId ? { parentChannelId: sourceContext.parentChannelId } : {}),
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
    })),
  };
}

function parseReactionEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (!emoji || emoji.length > MAX_REACTION_LENGTH || /\s/.test(emoji)) return null;
  return emoji;
}

function parseReactionActorPageLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function parseMessagePageCursor(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "invalid";
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : "invalid";
}

function parseDateFilter(value: unknown): Date | undefined | "invalid" {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function parseSearchSort(value: unknown): searchService.MessageSearchSort | "invalid" {
  if (value == null || value === "") return "relevance";
  return value === "relevance" || value === "recent" ? value : "invalid";
}

function parseSearchSenderType(value: unknown): searchService.MessageSearchSenderType | undefined | "invalid" {
  if (value == null || value === "") return undefined;
  return value === "user" || value === "agent" ? value : "invalid";
}

function parseMentionTarget(value: unknown): "self" | undefined | "invalid" {
  if (value == null || value === "") return undefined;
  return value === "self" ? value : "invalid";
}

function parseMentionActionResolutionIds(value: unknown): string[] {
  const rawIds: unknown[] = Array.isArray(value)
    ? value
    : [];
  return [...new Set(rawIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean))]
    .slice(0, 100);
}

async function loadVisibleMessageForUser(
  messageId: string,
  userId: string,
  serverId: ServerId,
  res: Response,
): Promise<{
  message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;
  localChannelId: string;
  localServerId: string;
} | null> {
  // Message-child resource access seam.
  //
  // Reactions, attachment previews/URLs, read receipts, saved/pinned state,
  // translations, shares, and any future message-scoped capability must not
  // authorize against message.channelId directly. Joint-channel messages live
  // in canonical storage, while authority is held by the caller's local
  // projection channel. Resolve message -> canonical channel -> local
  // projection first, then run ordinary channel access/post checks on that
  // local projection. If another route needs the same shape, extract a shared
  // resolveMessageResourceAccess({ messageId, serverId, actor }) helper rather
  // than adding another bespoke joint-channel branch.
  const resolvedMessageId = await messageService.resolveMessageIdVisibleToUser(serverId, userId, messageId);
  if (!resolvedMessageId.ok) {
    res.status(resolvedMessageId.status).json({ error: resolvedMessageId.error });
    return null;
  }
  const message = await messageService.getMessage(resolvedMessageId.messageId);
  if (!message) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  const channel = await channelService.getChannel(message.channelId);
  if (!channel) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  let localChannelId = message.channelId;
  if (channel.serverId !== serverId) {
    if (channel.type === "thread") {
      const localThreadProjection = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(message.channelId))
        .find((projection) => projection.localServerId === serverId);
      localChannelId = localThreadProjection?.localThreadChannelId ?? "";
    } else {
      const localChannelProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(message.channelId))
        .find((projection) => projection.serverId === serverId);
      localChannelId = localChannelProjection?.localChannelId ?? "";
    }
  }

  if (!localChannelId) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  const canAccess = await channelService.canUserAccessChannel(localChannelId, userId, serverId);
  if (!canAccess) {
    res.status(404).json({ error: "Message not found" });
    return null;
  }

  return { message, localChannelId, localServerId: serverId };
}

async function isHiddenAllDirectoryScope(
  localChannel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<boolean> {
  if (channelService.isAllSystemChannel(localChannel)) return true;
  if (localChannel.type !== "thread") return false;

  const jointThread = await channelService.getJointThreadProjectionByLocalThread(
    localChannel.id,
    localChannel.serverId,
  );
  if (jointThread) {
    const localParent = await channelService.getChannel(jointThread.localParentChannelId);
    return !!localParent && channelService.isAllSystemChannel(localParent);
  }
  if (!localChannel.parentMessageId) return false;
  const parentMessage = await channelService.getMessage(localChannel.parentMessageId);
  if (!parentMessage) return false;
  const parentChannel = await channelService.getChannel(parentMessage.channelId);
  return !!parentChannel && channelService.isAllSystemChannel(parentChannel);
}

async function getVisibleReactionActorIds(
  localChannel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  requesterId: string,
) {
  const members = await channelService.getChannelMembers(localChannel.id);
  let visibleHumans = members.humans;
  if (
    await serverService.shouldHideHumanDirectoryFromRequester(localChannel.serverId, requesterId)
    && await isHiddenAllDirectoryScope(localChannel)
  ) {
    visibleHumans = visibleHumans.filter((human) =>
      serverService.shouldExposeHumanInHiddenDirectory(human, requesterId)
    );
  }
  return {
    users: visibleHumans.map((human) => human.id),
    agents: members.agents.map((agent) => agent.id),
  };
}

async function projectUpdatedMessageForLocalChannel(
  message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>,
  enriched: NonNullable<Awaited<ReturnType<typeof messageService.getMessageContext>>>["messages"][number],
  localChannelId: string,
  localServerId: string,
) {
  if (localChannelId === message.channelId) return enriched;
  const localChannel = await channelService.getChannel(localChannelId);
  if (localChannel?.type === "joint") {
    return (await messageService.projectJointMessagesToLocalChannel([enriched], localChannelId, localServerId))[0] ?? enriched;
  }
  return messageService.projectMessagesToChannel([enriched], localChannelId)[0] ?? enriched;
}

async function emitProjectedMessageUpdate(
  io: { to: (room: string) => { emit: (event: string, payload: unknown) => void } },
  message: NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>,
  enriched: NonNullable<Awaited<ReturnType<typeof messageService.getMessageContext>>>["messages"][number],
  currentLocalChannelId: string,
  currentServerId: string,
) {
  const storageChannel = await channelService.getChannel(message.channelId);
  const targets = new Map<string, { localChannelId: string; serverId: string }>();
  if (storageChannel?.type === "thread") {
    const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(message.channelId);
    for (const projection of projections) {
      targets.set(projection.localThreadChannelId, {
        localChannelId: projection.localThreadChannelId,
        serverId: projection.localServerId,
      });
    }
  } else {
    const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(message.channelId);
    for (const projection of projections) {
      targets.set(projection.localChannelId, {
        localChannelId: projection.localChannelId,
        serverId: projection.serverId,
      });
    }
  }

  if (targets.size === 0) {
    targets.set(currentLocalChannelId, { localChannelId: currentLocalChannelId, serverId: currentServerId });
  }

  for (const target of targets.values()) {
    const projected = await projectUpdatedMessageForLocalChannel(message, enriched, target.localChannelId, target.serverId);
    const broadcastProjected = messageService.sanitizeForwardedBundleMetadataForBroadcast(projected);
    // message-realtime-producer: route-message.updated.projected
    io.to(`channel:${target.localChannelId}`).emit(
      "message:updated",
      projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(broadcastProjected)),
    );
  }
}

messageRouter.get("/search", async (req, res) => {
  const requestAbort = bindRequestAbortSignal(req, res);
  let queryForErrorTrace = "";
  try {
    const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
    const query = rawQuery.trim();
    queryForErrorTrace = query;

    const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    if (channelId) {
      const channel = await channelService.getChannel(channelId);
      if (!channel || channel.serverId !== req.serverId) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, req.serverId!);
      if (!canAccess) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    }

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const senderId = typeof req.query.senderId === "string" ? req.query.senderId : undefined;
    const senderType = parseSearchSenderType(req.query.senderType);
    if (senderType === "invalid") {
      res.status(400).json({ error: "Invalid sender type" });
      return;
    }
    const mentionTarget = parseMentionTarget(req.query.mentionTarget);
    if (mentionTarget === "invalid") {
      res.status(400).json({ error: "Invalid mention target" });
      return;
    }
    const after = parseDateFilter(req.query.after);
    const before = parseDateFilter(req.query.before);
    if (after === "invalid" || before === "invalid") {
      res.status(400).json({ error: "Invalid date filter" });
      return;
    }
    const sort = parseSearchSort(req.query.sort);
    if (sort === "invalid") {
      res.status(400).json({ error: "Invalid search sort" });
      return;
    }
    const hasMeaningfulFilter = Boolean(channelId || senderId || senderType || mentionTarget || after || before);
    if (!query && !hasMeaningfulFilter) {
      addTraceEvent("message_search.response.ready", {
        ...messageSearchParamTraceAttrs({
          query,
          channelId,
          senderId,
          senderType,
          mentionTarget,
          after,
          before,
          sort: "recent",
          limit,
          offset,
        }),
        outcome: "success",
        reason: "empty_search",
        results_count: 0,
        has_more: false,
      });
      res.json({ results: [], hasMore: false });
      return;
    }

    addTraceEvent("message_search.request.accepted", {
      ...messageSearchParamTraceAttrs({
        query,
        channelId,
        senderId,
        senderType,
        mentionTarget,
        after,
        before,
        sort: query ? sort : "recent",
        limit,
        offset,
      }),
      outcome: "success",
      reason: "request_accepted",
    });

    const searchRole = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    const guestVisibleChannelIds = searchRole === "guest"
      ? (await channelService.listChannels(req.serverId!, req.userId!, { archived: "include" })).map((channel) => channel.id)
      : undefined;
    const searchResponse = await searchService.searchMessagesForUser({
      serverId: req.serverId!,
      userId: req.userId!,
      query,
      channelId,
      senderId,
      senderType,
      mentionTarget: mentionTarget === "self"
        ? { targetType: "user", targetId: req.userId! }
        : undefined,
      after,
      before,
      sort: query ? sort : "recent",
      limit,
      offset,
      signal: requestAbort.signal,
      allowedRootChannelIds: guestVisibleChannelIds,
    });
    addTraceEvent("message_search.response.ready", {
      ...messageSearchParamTraceAttrs({
        query,
        channelId,
        senderId,
        senderType,
        mentionTarget,
        after,
        before,
        sort: query ? sort : "recent",
        limit,
        offset,
      }),
      outcome: "success",
      reason: "response_ready",
      results_count: searchResponse.results.length,
      has_more: searchResponse.hasMore,
    });
    res.json(searchResponse);
  } catch (err) {
    if (searchService.isMessageSearchPublicError(err)) {
      addTraceEvent("message_search.route.rejected", {
        event_kind: "message_search",
        outcome: err.status === 422 ? "rejected" : "error",
        reason: err.code.toLowerCase(),
        http_status: err.status,
      });
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (requestAbort.signal.aborted || searchService.isSearchQueryAbortedError(err)) {
      addTraceEvent("message_search.route.aborted", {
        event_kind: "message_search",
        outcome: "canceled",
        reason: "client_aborted",
        http_status: 499,
        ...messageSearchErrorTraceAttrs(err, { query: queryForErrorTrace }),
      });
      return;
    }
    addTraceEvent("message_search.route.failed", {
      event_kind: "message_search",
      outcome: "error",
      reason: "route_failed",
      http_status: 500,
      ...messageSearchErrorTraceAttrs(err, { query: queryForErrorTrace }),
    });
    console.error("Search messages error:", serializeErrorForLog(err));
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to search messages" });
    }
  } finally {
    requestAbort.cleanup();
  }
});

messageRouter.get("/context/:messageId", async (req, res) => {
  try {
    const plan = await getServerPlan(req.serverId!);
    const historyCutoff = getHistoryCutoff(plan);
    const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const queryChannel = channelId ? await channelService.getChannel(channelId) : null;
    const queryJointResolved = queryChannel?.type === "joint" && channelId
      ? await channelService.resolveChannelAccess({ serverId: req.serverId!, channelId })
      : null;
    const queryJointThreadProjection = queryChannel?.type === "thread"
      ? await channelService.getJointThreadProjectionByLocalThread(channelId!, req.serverId!)
      : null;
    const contextChannelId = queryJointResolved?.kind === "joint"
      ? queryJointResolved.canonicalChannelId
      : queryJointThreadProjection?.canonicalThreadChannelId ?? channelId;
    if (channelId && !contextChannelId) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const looksLikeFullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.messageId);
    const contextQueryOptions = {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      forwardedBundleViewerServerId: req.serverId,
    };
    const context = channelId
      ? looksLikeFullUuid
        ? await messageService.getMessageContextInChannel(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
          ?? await messageService.getThreadReplyContextForParentChannel(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
          ?? await messageService.getThreadParentContextByThreadChannelIdForParentChannel(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
        : await messageService.getMessageContextByShortId(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
          ?? await messageService.getThreadReplyContextByShortIdForParentChannel(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
          ?? await messageService.getThreadParentContextByThreadChannelIdForParentChannel(contextChannelId!, req.params.messageId, 15, 15, historyCutoff, contextQueryOptions)
      : await messageService.getMessageContext(req.params.messageId, 15, 15, historyCutoff, contextQueryOptions);
    if (!context) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    let responseChannelId = queryJointResolved?.kind === "joint"
      ? queryJointResolved.localChannelId
      : queryJointThreadProjection?.localThreadChannelId ?? context.channelId;
    const canonicalTarget = ("canonicalTarget" in context ? context.canonicalTarget : null) as null | {
      kind?: string;
      channelId?: string;
      threadChannelId?: string;
    };
    if (
      canonicalTarget?.kind === "thread"
      && queryJointResolved?.kind === "joint"
      && typeof canonicalTarget.threadChannelId === "string"
    ) {
      const [localThreadProjection] = await channelService.getActiveJointThreadProjectionsByCanonicalThread(canonicalTarget.threadChannelId)
        .then((projections) => projections.filter((projection) => projection.localServerId === req.serverId));
      if (localThreadProjection) {
        responseChannelId = localThreadProjection.localThreadChannelId;
      }
    }
    const channel = await channelService.getChannel(responseChannelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    const canAccess = await channelService.canUserAccessChannel(responseChannelId, req.userId!, req.serverId!);
    if (!canAccess) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    let historyLimited = false;
    if (historyCutoff) {
      historyLimited = await messageService.hasOlderMessages(
        context.channelId,
        historyCutoff,
        context.messages[0]?.seq,
      );
    }

    const channelArchived = await channelService.isChannelArchived(context.channelId);
    const projectedContextMessages = responseChannelId === context.channelId
      ? context.messages
      : queryJointResolved?.kind === "joint"
        ? await messageService.projectJointMessagesToLocalChannel(context.messages, responseChannelId, req.serverId!)
        : messageService.projectMessagesToChannel(context.messages, responseChannelId);
    const contextParentMessageIds = projectedContextMessages.map((message) => message.id);
    const threadSummariesByParentMessageId = contextParentMessageIds.length === 0
      ? {}
      : await channelService.getThreadSummaries(responseChannelId, {
          userId: req.userId!,
          parentMessageIds: contextParentMessageIds,
          parentMessageScopeSource: "messages_context",
        });

    res.json({
      ...context,
      channelId: responseChannelId,
      canonicalTarget: canonicalTarget?.kind === "thread"
        ? { ...canonicalTarget, channelId: queryJointResolved?.localChannelId ?? canonicalTarget.channelId, threadChannelId: responseChannelId }
        : canonicalTarget ?? ("canonicalTarget" in context ? context.canonicalTarget : undefined),
      messages: projectedContextMessages,
      threadSummariesByParentMessageId,
      historyLimited,
      channelArchived,
    });
  } catch (err) {
    console.error("Get message context error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to load message context" });
  }
});

// List messages for a channel
messageRouter.get("/channel/:channelId", async (req, res) => {
  try {
    addTraceEvent("messages.page.started");
    // Verify channel belongs to this server
    const channel = await tracePhase(
      () => channelService.getChannel(req.params.channelId),
      (_durationMs, result) => ({
        name: "channel.loaded",
        attrs: {
          found: Boolean(result),
        },
      }),
    );
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }

    // Verify user can access this channel (DM access control)
    const canAccess = await tracePhase(
      () => channelService.canUserAccessChannel(req.params.channelId, req.userId!, req.serverId!),
      (_durationMs, result) => ({
        name: "channel.access.checked",
        attrs: {
          allowed: result,
          channel_type: channel.type,
        },
      }),
    );
    if (!canAccess) {
      await denyChannelAccess(res, req.userId!, req.params.channelId, "You do not have access to this channel");
      return;
    }
    const resolved = channel.type === "joint"
      ? await channelService.resolveChannelAccess({ serverId: req.serverId!, channelId: req.params.channelId })
      : null;
    const jointThreadProjection = channel.type === "thread"
      ? await channelService.getJointThreadProjectionByLocalThread(req.params.channelId, req.serverId!)
      : null;
    const storageChannelId = resolved?.kind === "joint"
      ? resolved.canonicalChannelId
      : jointThreadProjection?.canonicalThreadChannelId ?? req.params.channelId;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const beforeSeq = parseMessagePageCursor(req.query.before);
    const afterSeq = parseMessagePageCursor(req.query.after);
    if (
      beforeSeq === "invalid" ||
      afterSeq === "invalid" ||
      (beforeSeq !== undefined && afterSeq !== undefined)
    ) {
      res.status(400).json({ error: "Invalid message page cursor", code: "invalid_message_page_cursor" });
      return;
    }

    // Apply plan-based history limit
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (_durationMs, result) => ({
        name: "history.policy.checked",
        attrs: {
          plan: result,
        },
      }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    const direction = afterSeq !== undefined ? "after" : beforeSeq !== undefined ? "before" : "latest";
    const page = await tracePhase(
      () => messageService.listMessagesWithCoverage(storageChannelId, limit, beforeSeq, afterSeq, historyCutoff, {
        traceQuery: createTraceDbQueryTracer("messages.paged"),
        attachmentCommentViewerUserId: req.userId,
        forwardedBundleViewerUserId: req.userId,
        forwardedBundleViewerServerId: req.serverId,
      }),
      (_durationMs, result) => ({
        name: "messages.paged",
        attrs: {
          messages_count: result.messages.length,
          limit,
          direction,
          history_cutoff_present: Boolean(historyCutoff),
        },
      }),
    );
    const projectedMsgs = resolved?.kind === "joint"
      ? await messageService.projectJointMessagesToLocalChannel(page.messages, resolved.localChannelId, req.serverId!)
      : jointThreadProjection
        ? messageService.projectMessagesToChannel(page.messages, jointThreadProjection.localThreadChannelId)
      : page.messages;
    const responseScopeId = resolved?.kind === "joint"
      ? resolved.localChannelId
      : jointThreadProjection?.localThreadChannelId ?? req.params.channelId;

    // Check if there are older messages beyond the plan limit
    let historyLimited = false;
    if (historyCutoff && afterSeq === undefined) {
      historyLimited = await tracePhase(
        () => messageService.hasOlderMessages(storageChannelId, historyCutoff, beforeSeq, {
          traceQuery: createTraceDbQueryTracer("history.limit.checked"),
        }),
        (_durationMs, result) => ({
          name: "history.limit.checked",
          attrs: {
            history_limited: result,
          },
        }),
      );
    } else {
      addTraceEvent("history.limit.skipped", {
        reason: historyCutoff ? "after_cursor" : "unlimited_history",
      });
    }

    // task #809 (inline replies cold path): thread summaries for THIS page's
    // parents ride the same response — the client must never need a second
    // async round-trip (or suffer a late layout patch) for reply blocks.
    // Scope is exactly the page's projected message ids; channels without
    // threads yield an empty map; access/joint semantics follow the already
    // verified channel + projection above (summaries are addressed by the
    // same local scope id the messages are projected to).
    const threadParentScopeIds = projectedMsgs.map((message) => message.id);
    const threadSummariesByParentMessageId = threadParentScopeIds.length === 0
      ? {}
      : await tracePhase(
          () => channelService.getThreadSummaries(responseScopeId, {
            userId: req.userId!,
            parentMessageIds: threadParentScopeIds,
            parentMessageScopeSource: "messages_page",
            traceQuery: createTraceDbQueryTracer("messages.thread_summaries"),
          }),
          (_durationMs, result) => ({
            name: "messages.thread_summaries.loaded",
            attrs: {
              thread_summaries_count: Object.keys(result).length,
              parent_message_scope_count: threadParentScopeIds.length,
            },
          }),
        );

    addTraceEvent("response.ready", {
      messages_count: projectedMsgs.length,
      history_limited: historyLimited,
      thread_summaries_count: Object.keys(threadSummariesByParentMessageId).length,
    });
    res.json({
      messages: projectedMsgs,
      threadSummariesByParentMessageId,
      historyLimited,
      messageWindow: {
        schemaVersion: 1,
        domain: "receiver_visible_messages_v1",
        serverId: req.serverId!,
        receiverKind: "user",
        receiverId: req.userId!,
        scopeId: responseScopeId,
        ...page.coverage,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to list messages" });
  }
});

// Send message (user sends)
messageRouter.get("/attachment-preview/enabled", async (req, res) => {
  try {
    const enabled = await isAttachmentPreviewUnifiedEnabledForServer({
      app: req.app,
      userId: req.userId,
      serverId: req.serverId,
    });
    res.json({ enabled });
  } catch (err) {
    console.error("Attachment preview flag evaluation failed:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to evaluate attachment preview availability" });
  }
});

messageRouter.get("/forward/enabled", async (req, res) => {
  try {
    const enabled = await isMessageForwardingEnabledForServer({
      app: req.app,
      userId: req.userId,
      serverId: req.serverId,
    });
    res.json({ enabled });
  } catch (err) {
    console.error("Message forwarding flag evaluation failed:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to evaluate forwarding availability" });
  }
});

const MAX_FORWARD_SEARCH_LIMIT = 20;

messageRouter.get("/forward/targets/search", async (req, res) => {
  try {
    const forwardingEnabled = await isMessageForwardingEnabledForServer({
      app: req.app,
      userId: req.userId,
      serverId: req.serverId,
    });
    if (!forwardingEnabled) {
      res.status(404).json({ error: "Forwarding is not available" });
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const limit = Math.min(
      Math.max(1, parseInt(String(req.query.limit), 10) || MAX_FORWARD_SEARCH_LIMIT),
      MAX_FORWARD_SEARCH_LIMIT,
    );
    const serverId = req.serverId!;
    const userId = req.userId!;
    const requesterRole = await getActorServerRoleInServer(serverId, "user", userId);

    if (!q) {
      res.json({ targets: [] });
      return;
    }

    const [allChannels, dmChannels, allAgents, hideHumanDirectory] = await Promise.all([
      channelService.listChannels(serverId, userId),
      channelService.listDMChannels(serverId, userId),
      requesterRole === "guest" ? Promise.resolve([]) : agentService.listAgents(serverId, false),
      serverService.shouldHideHumanDirectoryFromRequester(serverId, userId),
    ]);
    const members = hideHumanDirectory || requesterRole === "guest"
      ? []
      : await serverService.getServerMembers(serverId, userId);

    type ScoredTarget = {
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
      score: number;
    };

    const results: ScoredTarget[] = [];

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
        score,
      });
    }

    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const targets = results.slice(0, limit).map(({ score: _score, ...rest }) => rest);
    res.json({ targets });
  } catch (err) {
    console.error("Forward target search failed:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to search forward targets" });
  }
});

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

function boundedForwardError(error: unknown): { stableCode: string; errorClass: string; status: number } {
  if (error instanceof ForwardRequestError) {
    return { stableCode: error.diagnosticCode, errorClass: "ForwardRequestError", status: error.status };
  }
  if (error instanceof ForwardPersistenceError) {
    return { stableCode: error.code, errorClass: "ForwardPersistenceError", status: 409 };
  }
  if (error instanceof channelService.ChannelArchivedError) {
    return { stableCode: "channel_archived", errorClass: "ChannelArchivedError", status: 409 };
  }
  if (error instanceof messageService.UserRandomIdConflictError) {
    return { stableCode: "request_conflict", errorClass: "UserRandomIdConflictError", status: 409 };
  }
  return boundedUnexpectedForwardError(error);
}

messageRouter.post("/forward", async (req, res) => {
  let phase: ForwardDiagnosticPhase = "gate";
  const errorPhases = new WeakMap<object, ForwardDiagnosticPhase>();
  try {
    const forwardingEnabled = await isMessageForwardingEnabledForServer({
      app: req.app,
      userId: req.userId,
      serverId: req.serverId,
    });
    if (!forwardingEnabled) {
      recordForwardTerminal(req, {
        phase,
        outcome: "rejected",
        status: 404,
        stableCode: "feature_disabled",
        errorClass: "FeatureGateDenied",
      });
      res.status(404).json({ error: "Forwarding is not available" });
      return;
    }

    phase = "validate";
    const destinationChannelId = typeof req.body?.destinationChannelId === "string"
      ? req.body.destinationChannelId.trim()
      : typeof req.body?.channelId === "string"
        ? req.body.channelId.trim()
        : "";
    const parsedDestinationChannelIds = parseForwardDestinationChannelIds(req.body?.destinationChannelIds);
    const sourceMessageIds = parseForwardSourceMessageIds(req.body?.sourceMessageIds);
    const rawNote = req.body?.note;
    const note = rawNote == null ? "" : typeof rawNote === "string" ? rawNote.trim() : null;
    const requestId = req.body?.requestId == null
      ? null
      : typeof req.body.requestId === "string" && UUID_RE.test(req.body.requestId.trim())
        ? req.body.requestId.trim()
        : "invalid";
    if (parsedDestinationChannelIds === "invalid") {
      recordForwardTerminal(req, { phase, outcome: "rejected", status: 400, stableCode: "invalid_request", errorClass: "ValidationError" });
      res.status(400).json({ error: "Destination channel and full source message ids are required" });
      return;
    }
    const isBatchRequest = parsedDestinationChannelIds !== null;
    const destinationChannelIds = parsedDestinationChannelIds === null
      ? (destinationChannelId ? [destinationChannelId] : [])
      : parsedDestinationChannelIds;
    const parsedRandomId = parseRandomId(req.body?.randomId);

    if (
      destinationChannelIds.length === 0
      || sourceMessageIds === "invalid"
      || note == null
      || requestId === "invalid"
      || (isBatchRequest && requestId == null)
      || parsedRandomId === INVALID_RANDOM_ID
    ) {
      recordForwardTerminal(req, { phase, outcome: "rejected", status: 400, stableCode: "invalid_request", errorClass: "ValidationError" });
      res.status(400).json({ error: "Destination channel and full source message ids are required" });
      return;
    }
    if (note.length > MAX_MESSAGE_LENGTH) {
      recordForwardTerminal(req, { phase, outcome: "rejected", status: 400, stableCode: "note_too_long", errorClass: "ValidationError" });
      res.status(400).json({ error: `Message content exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` });
      return;
    }

    const userId = req.userId!;
    phase = "source_snapshot";
    await failpoints.hit("server.message.forward.beforeSourceSnapshot");
    const baseActionMetadata = await buildForwardedBundleMetadata({
      serverId: req.serverId!,
      forwarderUserId: userId,
      sourceMessageIds,
    });

    const user = await userService.getUser(userId);
    const senderName = user?.displayName || user?.name || "User";
    const io = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    const content = note || `Forwarded ${baseActionMetadata.forwardedItems.length} message${baseActionMetadata.forwardedItems.length === 1 ? "" : "s"}`;

    const forwardToDestination = async (targetChannelId: string) => {
      let destinationPhase: ForwardDiagnosticPhase = "resolve_authorize";
      try {
        const destination = await channelService.getChannel(targetChannelId);
        if (!destination || destination.serverId !== req.serverId) {
          throw new ForwardRequestError(404, "Channel not found", "destination_unavailable", "destination_not_found");
        }
        if (!(await channelService.canUserPostToChannel(targetChannelId, userId))) {
          throw new ForwardRequestError(403, "You must join this channel to send messages", "destination_unavailable", "destination_membership_required");
        }
        if (await isChannelReadOnlyByBillingFeature(targetChannelId, req.serverId!)) {
          throw new ForwardRequestError(403, "Joint Channels require the Pro plan. Upgrade to continue.", "destination_unavailable", "destination_billing_read_only");
        }
        if (await isChannelReadOnlyByQuota(targetChannelId, req.serverId!)) {
          throw new ForwardRequestError(403, "This channel is read-only on your current plan. Upgrade to continue.", "destination_unavailable", "destination_quota_read_only");
        }

        const requestDigest = requestId
          ? forwardRequestDigest({
              serverId: req.serverId!,
              userId,
              sourceMessageIds,
              destinationChannelId: targetChannelId,
              note,
            })
          : null;
        const actionMetadata = {
          ...baseActionMetadata,
          destinationTargetId: targetChannelId,
          ...(requestDigest ? { _forwardRequestDigest: requestDigest } : {}),
        };
        const jointProjections = destination.type === "joint"
          ? await channelService.getActiveJointChannelProjectionsByLocalChannel(targetChannelId)
          : [];
        const destinationJointProjection = jointProjections.find((projection) => projection.localChannelId === targetChannelId);
        const destinationStorageChannelId = destinationJointProjection?.canonicalChannelId ?? targetChannelId;
        destinationPhase = "persist_broadcast";
        const persisted = await persistForwardBundle({
          destinationStorageChannelId,
          destinationRequestChannelId: targetChannelId,
          senderId: userId,
          content,
          randomId: requestId
            ? `forward:${requestId}:${targetChannelId}`
            : parsedRandomId ?? `forward-${randomUUID()}`,
          sourceMessageIds,
          requestServerId: req.serverId!,
          metadata: actionMetadata as InternalForwardBundleMetadata,
        });
        // slack-bridge-ordinary-message-producer: messages.forward_bundle
        const enriched = await messageService.broadcastAndDeliver(io, agentOrchestrator, {
          channelId: targetChannelId,
          senderType: "user",
          senderId: userId,
          senderName,
          content,
          randomId: persisted.message.randomId ?? undefined,
          actionMetadata: persisted.message.actionMetadata,
          prePersisted: persisted,
        });
        return {
          message: messageService.projectForwardDestinationMessage(enriched),
          replayed: persisted.replayed,
        };
      } catch (error) {
        if ((typeof error === "object" && error !== null) || typeof error === "function") {
          errorPhases.set(error as object, destinationPhase);
        }
        throw error;
      }
    };

    if (!isBatchRequest) {
      const result = await forwardToDestination(destinationChannelIds[0]!);
      await failpoints.hit("server.message.forward.beforeResponse");
      phase = "response";
      recordForwardTerminal(req, {
        phase,
        outcome: result.replayed ? "idempotent_replay" : "success",
        status: 200,
        stableCode: result.replayed ? "idempotent_replay" : "ok",
        errorClass: "none",
      });
      res.setHeader("X-Raft-Forward-Outcome", result.replayed ? "idempotent_replay" : "success");
      res.json(result.message);
      return;
    }

    safeAddTraceEvent("messages.forward.started", () => ({
      sourceCount: sourceMessageIds.length,
      destinationCount: destinationChannelIds.length,
      hasNote: note.length > 0,
    }));
    const results = await Promise.all(destinationChannelIds.map(async (targetChannelId) => {
      try {
        return {
          destinationChannelId: targetChannelId,
          status: "success" as const,
          ...await forwardToDestination(targetChannelId),
        };
      } catch (err) {
        if (
          err instanceof messageService.UserRandomIdConflictError
          || (err instanceof ForwardPersistenceError && err.code === "idempotency_conflict")
        ) {
          safeAddTraceEvent("messages.forward.destination.failed", () => ({
            route_family: "message_forward",
            phase: (typeof err === "object" && err !== null ? errorPhases.get(err) : undefined) ?? "persist_broadcast",
            code: "request_conflict",
            stable_code: boundedForwardError(err).stableCode,
            error_class: boundedForwardError(err).errorClass,
          }));
          return {
            destinationChannelId: targetChannelId,
            status: "failed" as const,
            code: "request_conflict",
            error: "Forward request conflicts with an earlier request",
          };
        }
        const detail = boundedForwardError(err);
        const code = err instanceof ForwardRequestError
          ? err.code
          : err instanceof channelService.ChannelArchivedError
            ? "destination_unavailable"
            : "forward_failed";
        safeAddTraceEvent("messages.forward.destination.failed", () => ({
          route_family: "message_forward",
          phase: (typeof err === "object" && err !== null ? errorPhases.get(err) : undefined) ?? "persist_broadcast",
          code,
          stable_code: detail.stableCode,
          error_class: detail.errorClass,
        }));
        return {
          destinationChannelId: targetChannelId,
          status: "failed" as const,
          code,
          error: "Could not forward to this target",
        };
      }
    }));
    const succeeded = results.filter((r) => r.status === "success").length;
    safeAddTraceEvent("messages.forward.completed", () => ({
      destinationCount: results.length,
      succeeded,
      failed: results.length - succeeded,
      failureCodes: results.flatMap((r) => (r.status === "failed" && r.code ? [r.code] : [])).join(","),
    }));
    phase = "response";
    const replayed = results.filter((r) => r.status === "success" && r.replayed).length;
    const failed = results.length - succeeded;
    recordForwardTerminal(req, {
      phase,
      outcome: failed > 0 ? "partial_failure" : replayed === results.length ? "idempotent_replay" : "success",
      status: 200,
      stableCode: failed > 0 ? (succeeded > 0 ? "partial_failure" : "all_failed") : replayed === results.length ? "idempotent_replay" : "ok",
      errorClass: failed > 0 ? "DestinationFailure" : "none",
      commitState: succeeded > 0 ? "committed" : "pre_commit",
    });
    res.setHeader(
      "X-Raft-Forward-Outcome",
      failed > 0 ? (succeeded > 0 ? "partial_failure" : "all_failed") : replayed === results.length ? "idempotent_replay" : "success",
    );
    res.json({
      results: results.map((result) => {
        if (result.status === "failed") return result;
        const { replayed: _replayed, ...publicResult } = result;
        return publicResult;
      }),
    });
  } catch (err) {
    const detail = boundedForwardError(err);
    const terminalPhase = (typeof err === "object" && err !== null ? errorPhases.get(err) : undefined) ?? phase;
    recordForwardTerminal(req, {
      phase: terminalPhase,
      outcome: detail.status >= 500 ? "error" : "rejected",
      status: detail.status,
      stableCode: detail.stableCode,
      errorClass: detail.errorClass,
    });
    if (err instanceof ForwardRequestError) {
      safeAddTraceEvent("messages.forward.rejected", () => ({ code: err.code, status: err.status }));
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ForwardPersistenceError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Forward request failed unexpectedly", {
      routeFamily: "message_forward",
      phase: terminalPhase,
      errorClass: detail.errorClass,
      commitState: forwardCommitState(terminalPhase),
    });
    res.status(500).json({ error: "Failed to forward message" });
  }
});

async function createHumanMessage(
  req: Request,
  res: Response,
  mentionContract: "v1" | "v2",
) {
  try {
    const parsedBody = parseHumanMessageCreateBody(req.body);
    if (parsedBody === "invalid") {
      res.status(400).json({ error: "Invalid message request body" });
      return;
    }
    const { channelId, content, attachmentIds, asTask } = parsedBody;
    const randomId = parseRandomId(req.body.randomId);
    if (randomId === INVALID_RANDOM_ID) {
      res.status(400).json({ error: `randomId must be a non-empty string with at most ${MAX_RANDOM_ID_LENGTH} characters` });
      return;
    }
    const mentions = parseStructuredMentions(req.body.mentions);
    if (mentions === "invalid") {
      res.status(400).json({ error: "Invalid mentions payload" });
      return;
    }
    if (!channelId || !content) {
      res.status(400).json({ error: "Channel ID and content are required" });
      return;
    }

    // Validate content
    if (typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "Message content cannot be empty" });
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `Message content exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` });
      return;
    }

    const userId = req.userId!;
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    // Verify user can post to this channel (must be a member)
    const canPost = await channelService.canUserPostToChannel(channelId, userId);
    if (!canPost) {
      res.status(403).json({ error: "You must join this channel to send messages" });
      return;
    }

    // Check if channel is read-only due to quota (excess channels on free plan)
    if (await isChannelReadOnlyByBillingFeature(channelId, req.serverId!)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }
    if (await isChannelReadOnlyByQuota(channelId, req.serverId!)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    // Get sender name from user record
    const user = await userService.getUser(userId);
    const senderName = user?.displayName || user?.name || "User";

    // Unified pipeline: DB write → broadcast → agent delivery
    const io = req.app.get("io");
    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    // slack-bridge-ordinary-message-producer: messages.create
    const enriched = await messageService.broadcastAndDeliver(io, agentOrchestrator, {
      channelId,
      senderType: "user",
      senderId: userId,
      senderName,
      content,
      mentions,
      attachmentIds,
      randomId,
      asTask,
      mentionContract,
    });

    if (mentions.some((m) => m.type === "agent")) {
      const io2 = req.app.get("io");
      const orch = req.app.get("agentOrchestrator") as AgentOrchestrator;
      void onboardingService
        .triggerCrossChannelHint(io2, orch, req.serverId!, userId, channelId)
        .catch(() => {});
    }

    const pendingMentionActions = messageService.getSenderPendingMentionActions(enriched);
    const unresolvedMentionHandles = messageService.getSenderUnresolvedMentionHandles(enriched);
    if (mentionContract === "v2") {
      res.json({
        message: enriched,
        ...(pendingMentionActions.length > 0 ? { pendingMentionActions } : {}),
        ...(unresolvedMentionHandles.length > 0 ? { unresolvedMentionHandles } : {}),
      });
      return;
    }
    if (pendingMentionActions.length > 0) {
      res.json({ message: enriched, pendingMentionActions });
      return;
    }

    res.json(enriched);
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (err instanceof messageService.MentionValidationError) {
      res.status(400).json(mentionContract === "v2"
        ? {
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
          }
        : { error: err.message });
      return;
    }
    if (err instanceof messageService.UserRandomIdConflictError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof AttachmentLinkError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    const projected = projectSlackBridgeOutboundAdmissionFailure(err, process.env.NODE_ENV);
    res.status(500).json({
      error: "Failed to send message",
      ...(projected ?? {}),
    });
  }
}

messageRouter.post("/", (req, res) => createHumanMessage(req, res, "v1"));
messageV2Router.post("/", (req, res) => createHumanMessage(req, res, "v2"));

messageRouter.post("/mention-actions/execute", async (req, res) => {
  try {
    const userId = req.userId!;
    const serverId = req.serverId!;
    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (action !== "notify" && action !== "add") {
      res.status(400).json({ error: "action must be notify or add" });
      return;
    }
    const actionKind: MentionActionKind = action;
    const resolutionIds = parseMentionActionResolutionIds(req.body?.resolutionIds)
      .concat(parseMentionActionResolutionIds(req.body?.ids))
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, 100);
    if (resolutionIds.length === 0) {
      res.status(400).json({ error: "resolutionIds must include at least one id" });
      return;
    }

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    const executionOptions: MentionActionExecutionOptions = agentOrchestrator
      ? {
          notifyAgent: ({ messageId, targetId }) =>
            messageService.deliverMessageToAgent(
              agentOrchestrator,
              messageId,
              targetId,
              { requireQueueReceipt: true, nonMemberMention: true },
            ),
        }
      : {};
    const results: MentionActionResult[] = [];
    for (const resolutionId of resolutionIds) {
      results.push(await executeMentionActionId(
        resolutionId,
        serverId,
        "user",
        userId,
        actionKind,
        executionOptions,
      ));
    }
    if (agentOrchestrator && actionKind === "add") {
      await Promise.all(
        results.map(async (result) => {
          if (
            result.status !== "delivered"
            || result.reason === "already_delivered"
            || result.targetType !== "agent"
            || !result.targetId
            || !result.messageId
          ) {
            return;
          }
          try {
            await messageService.deliverMessageToAgent(
              agentOrchestrator,
              result.messageId,
              result.targetId,
              { requireQueueReceipt: true, reconcileNonMemberMention: true },
            );
          } catch (err) {
            console.error(
              `[messages.mention-actions.execute] failed to deliver resolved mention ${result.resolutionId} to agent ${result.targetId}:`,
              err,
            );
          }
        }),
      );
    }
    res.json({ ok: true, action, results });
  } catch (err) {
    console.error("messages.mention-actions.execute error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to execute mention action" });
  }
});

messageRouter.get("/:messageId/reactions/actors", async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.query.emoji);
    if (!emoji) {
      res.status(400).json({ error: "A valid emoji is required", code: "invalid_reaction_emoji" });
      return;
    }
    const limit = parseReactionActorPageLimit(req.query.limit);
    if (limit === null) {
      res.status(400).json({ error: "limit must be an integer between 1 and 100", code: "invalid_reaction_actor_limit" });
      return;
    }
    const cursor = req.query.cursor;
    if (cursor !== undefined && typeof cursor !== "string") {
      res.status(400).json({ error: "Invalid reaction actors cursor", code: "invalid_reaction_actors_cursor" });
      return;
    }

    const visibleMessage = await loadVisibleMessageForUser(req.params.messageId, req.userId!, req.serverId!, res);
    if (!visibleMessage) return;
    const { message, localChannelId, localServerId } = visibleMessage;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }
    await channelService.assertChannelNotArchived(localChannelId);
    const localChannel = await channelService.getChannel(localChannelId);
    if (!localChannel) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const page = await listReactionActors({
      principalId: req.userId!,
      serverId: localServerId,
      parentScope: {
        kind: localChannel.type === "thread" ? "thread" : "channel",
        id: localChannelId,
      },
      messageId: message.id,
      emoji,
      limit,
      cursor,
      visibleActorIds: await getVisibleReactionActorIds(localChannel, req.userId!),
    });
    res.json({
      discussion: {
        root: { kind: "message", serverId: localServerId, id: message.id },
        relation: { kind: "reactionActors", emoji },
        parentScope: {
          serverId: localServerId,
          scopeKind: localChannel.type === "thread" ? "thread" : "channel",
          scopeId: localChannelId,
        },
      },
      discussionVersion: page.discussionVersion,
      actors: page.actors,
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    if (err instanceof InvalidReactionActorsCursorError) {
      res.status(400).json({ error: "Invalid reaction actors cursor", code: err.code });
      return;
    }
    if (err instanceof ReactionDiscussionVersionChangedError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        currentDiscussionVersion: err.currentDiscussionVersion,
        rebaselineRequired: true,
      });
      return;
    }
    if (err instanceof ReactionActorVisibilityChangedError) {
      res.status(409).json({ error: err.message, code: err.code, rebaselineRequired: true });
      return;
    }
    console.error("List reaction actors error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to list reaction actors" });
  }
});

messageRouter.get("/:messageId/reactions/viewer", async (req, res) => {
  try {
    const visibleMessage = await loadVisibleMessageForUser(req.params.messageId, req.userId!, req.serverId!, res);
    if (!visibleMessage) return;
    const { message, localChannelId, localServerId } = visibleMessage;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }
    await channelService.assertChannelNotArchived(localChannelId);
    res.json(projectReactionViewerSnapshot({
      serverId: localServerId,
      messageId: message.id,
      state: await hydrateReactionViewer({ messageId: message.id, userId: req.userId! }),
    }));
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Hydrate reaction viewer error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to hydrate reaction viewer state" });
  }
});

messageRouter.post("/:messageId/reactions", async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      res.status(400).json({ error: "A valid emoji is required" });
      return;
    }

    const visibleMessage = await loadVisibleMessageForUser(req.params.messageId, req.userId!, req.serverId!, res);
    if (!visibleMessage) return;
    const { message, localChannelId } = visibleMessage;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }

    const canPost = await channelService.canUserPostToChannel(localChannelId, req.userId!);
    if (!canPost) {
      res.status(403).json({ error: "You must join this channel to react to messages" });
      return;
    }

    await channelService.assertChannelNotArchived(localChannelId);

    if (await isChannelReadOnlyByBillingFeature(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }
    if (await isChannelReadOnlyByQuota(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    const mutation = await mutateMessageReaction({
      messageId: message.id,
      emoji,
      actor: { kind: "user", id: req.userId! },
      operation: "add",
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      forwardedBundleViewerServerId: req.serverId,
    });
    const enriched = context?.messages[0];
    if (!enriched) {
      res.status(500).json({ error: "Failed to reload updated message" });
      return;
    }

    const io = req.app.get("io");
    await emitProjectedMessageUpdate(io, message, enriched, localChannelId, req.serverId!);
    const reactionViewer = projectReactionViewerSnapshot({
      serverId: req.serverId!,
      messageId: message.id,
      state: mutation.viewerSnapshot!,
    });
    io.to(`user:${req.userId!}`).emit("reaction_viewer:updated", reactionViewer);
    res.json({
      ...await projectUpdatedMessageForLocalChannel(message, enriched, localChannelId, req.serverId!),
      reactionViewer,
    });
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Add reaction error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to add reaction" });
  }
});

messageRouter.delete("/:messageId/reactions", async (req, res) => {
  try {
    const emoji = parseReactionEmoji(req.body?.emoji);
    if (!emoji) {
      res.status(400).json({ error: "A valid emoji is required" });
      return;
    }

    const visibleMessage = await loadVisibleMessageForUser(req.params.messageId, req.userId!, req.serverId!, res);
    if (!visibleMessage) return;
    const { message, localChannelId } = visibleMessage;
    if (message.messageType === "system") {
      res.status(400).json({ error: "System messages cannot receive reactions" });
      return;
    }

    const canPost = await channelService.canUserPostToChannel(localChannelId, req.userId!);
    if (!canPost) {
      res.status(403).json({ error: "You must join this channel to react to messages" });
      return;
    }

    await channelService.assertChannelNotArchived(localChannelId);

    if (await isChannelReadOnlyByBillingFeature(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "Joint Channels require the Pro plan. Upgrade to continue." });
      return;
    }
    if (await isChannelReadOnlyByQuota(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    const mutation = await mutateMessageReaction({
      messageId: message.id,
      emoji,
      actor: { kind: "user", id: req.userId! },
      operation: "remove",
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      forwardedBundleViewerServerId: req.serverId,
    });
    const enriched = context?.messages[0];
    if (!enriched) {
      res.status(500).json({ error: "Failed to reload updated message" });
      return;
    }

    const io = req.app.get("io");
    await emitProjectedMessageUpdate(io, message, enriched, localChannelId, req.serverId!);
    const reactionViewer = projectReactionViewerSnapshot({
      serverId: req.serverId!,
      messageId: message.id,
      state: mutation.viewerSnapshot!,
    });
    io.to(`user:${req.userId!}`).emit("reaction_viewer:updated", reactionViewer);
    res.json({
      ...await projectUpdatedMessageForLocalChannel(message, enriched, localChannelId, req.serverId!),
      reactionViewer,
    });
  } catch (err) {
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    console.error("Remove reaction error:", serializeErrorForLog(err));
    res.status(500).json({ error: "Failed to remove reaction" });
  }
});

// Sync messages (gap sync after reconnection)
messageRouter.get("/sync", async (req, res) => {
  try {
    const sinceSeq = Number(req.query.since_seq) || 0;
    const channelId = req.query.channel_id as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    let jointResolved: channelService.ChannelAccessResolution | null = null;

    if (channelId) {
      // Verify channel belongs to this server + DM access control
      const channel = await channelService.getChannel(channelId);
      if (!channel || channel.serverId !== req.serverId) {
        res.status(404).json(CHANNEL_NOT_FOUND_BODY);
        return;
      }
      const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, req.serverId!);
      if (!canAccess) {
        await denyChannelAccess(res, req.userId!, channelId, "Access denied");
        return;
      }
      jointResolved = channel.type === "joint"
        ? await channelService.resolveChannelAccess({ serverId: req.serverId!, channelId })
        : null;
    }

    // Apply plan-based history limit
    const plan = await getServerPlan(req.serverId!);
    const historyCutoff = getHistoryCutoff(plan);

    // Always scope to current server
    if (jointResolved?.kind === "joint") {
      const msgs = await messageService.syncMessages(
        sinceSeq,
        jointResolved.canonicalChannelId,
        limit,
        undefined,
        historyCutoff,
        req.userId!,
        req.serverId!,
      );
      res.json(await messageService.projectJointMessagesToLocalChannel(msgs, jointResolved.localChannelId, req.serverId!));
      return;
    }

    const msgs = await messageService.syncMessages(sinceSeq, channelId, limit, req.serverId!, historyCutoff, req.userId!, req.serverId!);
    res.json(msgs);
  } catch {
    res.status(500).json({ error: "Failed to sync messages" });
  }
});
