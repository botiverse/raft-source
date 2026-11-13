import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import { refuse } from "../lib/refusal";
import { DmPeerNotMemberError } from "../services/dmSendPolicy";
import { CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, channelTypeSupportsThreadSort, decodeChannelActivityCursor, isMessageCardMetadata, isSubConversationType } from "@botiverse/raft-shared";
import { listMessageCardRevisions } from "../services/messageCardService";
import { getTaskForConversationChannel } from "../services/taskConversationService";
import rateLimit from "express-rate-limit";
import { resolveAppLinkPreviews } from "../services/appLinkPreviewService";
import { LINK_CARD_READ_MAX_BODY_BYTES, LINK_CARD_READ_URLS_PER_MINUTE, parseLinkCardReadBody, readLinkCards } from "../services/linkCardReadService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router as RouterType } from "express";
import { isMessageShortId, UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import { and, eq } from "drizzle-orm";
import * as messageService from "../services/messageService";
import * as channelService from "../services/channelService";
import * as userService from "../services/userService";
import * as serverService from "../services/serverService";
import * as searchService from "../services/searchService";
import * as onboardingService from "../services/onboardingService";
import { getServerPlan, getHistoryCutoff, getServerHistoryWindow, channelBillingReadOnlyBody, getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "../services/planService";
import { notePaywallHit } from "./paywallHit";
import { getRequestHistoryWindow, getServerHistoryWindowForRead, humanHistoryLimitedError, isBehindHistoryWindow } from "../services/historyWindow";
import { personLocalConversationId, resolveMessageResourceAccess } from "../services/messageResourceAccess";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { failpoints, type ServerId, AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT, AGENT_API_MESSAGE_SEARCH_MAX_LIMIT, FORWARD_TOO_MANY_MESSAGES_CODE, MAX_FORWARD_DESTINATIONS } from "@botiverse/raft-shared";
import { addTraceEvent, createTraceDbQueryTracer, safeAddTraceEvent, tracePhase } from "../tracing/semanticTrace";
import { traceRouteFailure } from "../tracing/routeFailure";
import { traceIdentityHash } from "../tracing/traceIdentity";
import {
  boundedUnexpectedForwardError,
  forwardCommitState,
  noteForwardTargets,
  recordForwardTerminal,
  type ForwardDiagnosticPhase,
} from "../tracing/messageForwardTrace";
import { messageSearchErrorTraceAttrs, messageSearchParamTraceAttrs } from "../tracing/messageSearchTrace";
import { getDb } from "../db/index";
import { messageMentions } from "../db/schema";
import { listMentionDeliveryOccurrencesForMessage, evaluateMentionDeliveryOccurrence } from "../services/mentionDeliveryOccurrenceService";
import { projectMentionDeliveryForSender } from "../services/senderMentionDeliveryProjection";
import { AttachmentLinkError } from "../services/attachmentLinkingService";
import { isAttachmentPreviewUnifiedEnabledForServer } from "../config/attachmentPreviewUnified";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { bindRequestAbortSignal } from "./requestAbortSignal";
import { sendJsonServerError } from "./errorResponse";
import {
  executeMentionActionId,
  type MentionActionExecutionOptions,
  type MentionActionKind,
  type MentionActionResult,
} from "../services/mentionActionService";
import { projectRichMessageSocketPayload } from "../services/messageRealtimeEvents";
import { CHANNEL_NOT_FOUND_BODY, denyChannelAccess } from "./channelAccessDenial";
import {
  hydrateReactionViewer,
  InvalidReactionActorsCursorError,
  listReactionActors,
  mutateMessageReaction,
  projectReactionViewerSnapshot,
  ReactionActorVisibilityChangedError,
  ReactionDiscussionVersionChangedError,
} from "../services/messageReactionService";
import { ForwardPersistenceError } from "../services/attachmentForwardService";
import {
  admitForwardConversationTargets,
  buildForwardedBundleMetadata,
  forwardBundleAsUser,
  FORWARD_TOO_MANY_MESSAGES_ERROR,
  forwardMessageContent,
  ForwardRequestError,
  isOverForwardMessageCap,
  parseForwardSourceMessageIds,
  searchForwardTargets,
} from "../services/messageForwardService";
import {
  assertChannelConversionWritable,
  ChannelConversionInProgressError,
  resolveChannelConversionLockTarget,
} from "../services/channelConversionFenceService";
import { projectSlackBridgeOutboundAdmissionFailure } from "../services/externalDeliveryOutboxService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { canView } from "../services/visibilityService";
import { checkHumanPostAdmission, HUMAN_POST_REFUSALS } from "../services/humanPostAdmission";
import {
  forwardParentContent,
  listForwardConversationCandidates,
  type ForwardConversationCandidate,
  type ForwardConversationTarget,
} from "../services/forwardConversationTargets";
import { parseOptionalIanaTimezone } from "../lib/ianaTimezone";
import { parseSyncHorizon, readSyncHorizon, SYNC_HORIZON_HEADER, SYNC_HORIZON_RESET_HEADER } from "../services/syncHorizon";
import { parseOffsetQueryParam } from "../lib/offsetQueryParam";

export const messageRouter: RouterType = Router();
export const messageV2Router: RouterType = Router();
// Uniform 404 for non-UUID path params (task #12). `messageId` stays unguarded:
// /context/:messageId also takes the 8-hex short id and validates inline.
guardUuidPathParams(messageRouter, { channelId: "Channel" });

export const MAX_MESSAGE_LENGTH = 32_000;
const HUMAN_OUTLINE_DEFAULT_LIMIT = 200;
const HUMAN_OUTLINE_MAX_LIMIT = 500;
const MAX_RANDOM_ID_LENGTH = 128;
const INVALID_RANDOM_ID = Symbol("invalidRandomId");
const MAX_REACTION_LENGTH = 16;
// The authenticated human author can inspect only coarse outcomes of their own
// mentions while they still have access to the original conversation. Runtime
// identities and terminal provenance remain on the existing diagnostic surface.
messageRouter.get("/:messageId/mention-deliveries", async (req, res) => {
  try {
    const messageId = req.params.messageId;
    const message = UUID_RE.test(messageId) ? await messageService.getMessage(messageId) : null;
    if (!message || message.senderType !== "user" || message.senderId !== req.userId
      || !await channelService.canUserAccessChannel(message.channelId, req.userId!, req.serverId!)) {
      res.status(404).json({ status: "NOT_JOINABLE" });
      return;
    }
    const mentions = await getDb().select({
      id: messageMentions.id, targetId: messageMentions.targetId,
      handle: messageMentions.handleAtSendTime,
    }).from(messageMentions).where(and(
      eq(messageMentions.messageId, messageId),
      eq(messageMentions.serverId, req.serverId!),
      eq(messageMentions.targetType, "agent"),
      eq(messageMentions.notifiableAtSend, true),
    ));
    const occurrences = new Map((await listMentionDeliveryOccurrencesForMessage(messageId))
      .map((row) => [row.occurrenceId, row]));
    res.json({ messageId, deliveries: mentions.map((mention) => {
      const row = occurrences.get(mention.id);
      return {
        targetId: mention.targetId,
        ...projectMentionDeliveryForSender(mention.handle, row
          ? evaluateMentionDeliveryOccurrence(row) : { status: "NOT_JOINABLE" }),
      };
    }) });
  } catch (err) {
    console.error("messages.mention-deliveries error:", serializeErrorForLog(err));
    res.status(500).json({ status: "LOOKUP_FAILED" });
  }
});

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
    if (type !== "user" && type !== "agent" && type !== "external") return "invalid";
    if (typeof id !== "string" || !UUID_RE.test(id)) return "invalid";
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

function parseForwardDestinationChannelIds(value: unknown): string[] | "invalid" | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (ids.some((id) => !UUID_RE.test(id))) return "invalid";
  const canonicalIds = [...new Set(ids)];
  if (canonicalIds.length > MAX_FORWARD_DESTINATIONS) return "invalid";
  return canonicalIds;
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
  // Message-child resource access seam (services/messageResourceAccess.ts).
  //
  // Reactions, attachment previews/URLs, read receipts, saved/pinned state,
  // translations, shares, and any future message-scoped capability must not
  // authorize against message.channelId directly. Joint-channel messages live
  // in canonical storage, while authority is held by the caller's local
  // projection channel; the resolver authorizes there, then checks the plan's
  // history window (a message behind it takes no reactions and shows none).
  const access = await resolveMessageResourceAccess({ messageId, serverId, actor: { type: "user", id: userId } });
  if (access.kind === "no_access") {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  if (access.kind === "history_limited") {
    res.status(404).json(humanHistoryLimitedError(access.historyWindow));
    return null;
  }
  return { message: access.message, localChannelId: access.localChannelId, localServerId: serverId };
}

async function isHiddenAllDirectoryScope(
  localChannel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<boolean> {
  if (channelService.isAllSystemChannel(localChannel)) return true;
  if (!isSubConversationType(localChannel.type)) return false;

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

export async function projectUpdatedMessageForLocalChannel(
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

/**
 * One message as this person's message list shows it, or null when they may
 * not read it: the list's access (the conversation through their local
 * projection, the plan's history window; services/messageResourceAccess.ts),
 * the list's per-viewer read and projection. GET /api/sync/changes rebuilds a
 * `message` change with it (RFC 082 §4.4).
 */
export async function readVisibleMessageRow(messageId: string, userId: string, serverId: ServerId) {
  const access = await resolveMessageResourceAccess({ messageId, serverId, actor: { type: "user", id: userId } });
  if (access.kind !== "readable") return null;
  const context = await messageService.getMessageContext(access.message.id, 0, 0, undefined, {
    attachmentCommentViewerUserId: userId, forwardedBundleViewerUserId: userId, viewerServerId: serverId,
  });
  const enriched = context?.messages.find((item) => item.id === access.message.id);
  if (!enriched) return null;
  return projectUpdatedMessageForLocalChannel(access.message, enriched, access.localChannelId, serverId);
}

// RFC 082 §4.5: a card message's kept versions, oldest first, read from the
// message by whoever may read it, and only by them: the message's own
// visibility (messageVisibleToViewer), so a private channel's or a DM's
// are its members' only; an owner or admin outside it gets the unknown
// message's 404, as does a deleted message. A card message can be in a Joint
// Channel (its channel converted to one since it was sent): then each viewer
// reads it through their own Server's projection, under their own Server's
// history window. A person's session only (requireAuth): never an App's OAuth
// token or an agent key, so the sender's App cannot read them. Any other
// message: none.
messageRouter.get("/:messageId/card-revisions", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const messageId = req.params.messageId;
  if (typeof messageId !== "string" || !UUID_RE.test(messageId)) { res.status(404).json({ error: "Message not found" }); return; }
  try {
    const message = await messageService.getMessage(messageId);
    // getMessage does not filter deleted rows: a deleted (or retracted) message is the unknown one's 404.
    if (!message || message.deletedAt || !await messageVisibleToViewer(req, message)) { res.status(404).json({ error: "Message not found" }); return; }
    const revisions = isMessageCardMetadata(message.actionMetadata) ? await listMessageCardRevisions(message.id) : [];
    res.json({ messageId: message.id, revisions });
  } catch {
    res.status(500).json({ error: "Failed to read card revisions" });
  }
});

type MessageUpdateIo = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
type UpdatedMessage = NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;
type EnrichedUpdatedMessage = NonNullable<Awaited<ReturnType<typeof messageService.getMessageContext>>>["messages"][number];

/** Every local channel a message update reaches: its joint projections, or the current channel. */
async function collectMessageUpdateTargets(
  message: UpdatedMessage,
  currentLocalChannelId: string,
  currentServerId: string,
): Promise<{ localChannelId: string; serverId: string }[]> {
  const storageChannel = await channelService.getChannel(message.channelId);
  const targets = new Map<string, { localChannelId: string; serverId: string }>();
  if (isSubConversationType(storageChannel?.type)) {
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
  return [...targets.values()];
}

export async function emitProjectedMessageUpdate(
  io: MessageUpdateIo,
  message: UpdatedMessage,
  enriched: EnrichedUpdatedMessage,
  currentLocalChannelId: string,
  currentServerId: string,
) {
  for (const target of await collectMessageUpdateTargets(message, currentLocalChannelId, currentServerId)) {
    const projected = await projectUpdatedMessageForLocalChannel(message, enriched, target.localChannelId, target.serverId);
    const broadcastProjected = messageService.sanitizeForwardedBundleMetadataForBroadcast(projected);
    // message-realtime-producer: route-message.updated.projected
    io.to(`channel:${target.localChannelId}`).emit(
      "message:updated",
      projectRichMessageSocketPayload(messageService.stripViewerScopedAttachmentCommentMetadata(broadcastProjected)),
    );
  }
}

/**
 * Re-broadcast a message whose attachment gained a preview after it was sent
 * (a direct upload's thumbnail, task #57), so open clients swap the original
 * for the thumbnail. Same rooms and projection as an edit.
 */
export async function emitAttachmentPreviewMessageUpdate(io: MessageUpdateIo, messageId: string): Promise<void> {
  const message = await messageService.getMessage(messageId);
  if (!message) return;
  const channel = await channelService.getChannel(message.channelId);
  if (!channel) return;
  const context = await messageService.getMessageContext(message.id, 0, 0, undefined, { viewerServerId: channel.serverId });
  const enriched = context?.messages[0];
  if (!enriched) return;
  for (const target of await collectMessageUpdateTargets(message, message.channelId, channel.serverId)) {
    const projected = await projectUpdatedMessageForLocalChannel(message, enriched, target.localChannelId, target.serverId);
    const broadcastProjected = messageService.sanitizeForwardedBundleMetadataForBroadcast(projected);
    // message-realtime-producer: route-message.updated.attachment-preview
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
    const scopedChannel = channelId ? await channelService.getChannel(channelId) : undefined;
    if (channelId) {
      if (!scopedChannel || scopedChannel.serverId !== req.serverId) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
      const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, req.serverId!);
      if (!canAccess) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }
    }

    const limit = Math.min(
      Number(req.query.limit) || AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
      AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
    );
    const offset = parseOffsetQueryParam(req.query.offset);
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
    const rawCursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
    const cursor = rawCursor === undefined ? undefined : searchService.parseMessageSearchWalkCursor(rawCursor);
    // A cursor continues a recent page, or a relevance page answered newest
    // first (relevanceFallback).
    if (cursor === null || (cursor && !query)) {
      res.status(400).json({ error: "Invalid search cursor" });
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
      res.json({ results: [], hasMore: false, historyLimited: false });
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

    const [searchRole, historyWindow] = await Promise.all([
      getActorServerRoleInServer(req.serverId!, "user", req.userId!),
      getServerHistoryWindow(req.serverId!),
    ]);
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
      historyCutoff: historyWindow.cutoff,
      sort: query ? sort : "recent",
      limit,
      offset,
      cursor,
      signal: requestAbort.signal,
      allowedRootChannelIds: guestVisibleChannelIds,
    });
    // `historyLimited`: the cutoff may have narrowed this search, because the
    // searched scope (the channel, else the server) existed before it.
    // Creation time stands in for "has older messages", which would cost a
    // second search. It records the paywall hit; the web's search notice no
    // longer reads it (it shows on every Free search, 2026-10-29).
    const scopeCreatedAt = scopedChannel?.createdAt ?? historyWindow.serverCreatedAt;
    const historyLimited = historyWindow.cutoff !== undefined
      && scopeCreatedAt !== undefined
      && scopeCreatedAt < historyWindow.cutoff
      && (!after || after < historyWindow.cutoff);
    if (historyLimited) notePaywallHit(req, "history_30d");
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
      history_limited: historyLimited,
    });
    res.json({ ...searchResponse, historyLimited });
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

// Messages on each side of a context target. Callers that only need the target
// (the thread panel's parent message) pass before=0&after=0 instead of paying
// for a 31-message window; absent or invalid values keep the default.
const MESSAGE_CONTEXT_WINDOW_DEFAULT = 15;
function parseContextWindowSide(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return MESSAGE_CONTEXT_WINDOW_DEFAULT;
  return Math.min(Number(raw), MESSAGE_CONTEXT_WINDOW_DEFAULT);
}

const appLinkPreviewLimiter = rateLimit({
  windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
  // One budget per person, not per Server: joining more Servers must not
  // multiply the outbound callback volume one account can drive.
  keyGenerator: (req) => req.userId!,
  message: { previews: [], prompts: [] },
});
/**
 * Whether the viewer may read `message` from this request's Server, as the
 * people branch of services/messageResourceAccess.ts decides it: through the
 * conversation they hold it by (its own channel on this Server, or this
 * Server's active projection of the Joint Channel or thread that stores it:
 * personLocalConversationId), which they can see (canView), within this
 * Server's history window; null otherwise. The one check behind both the card
 * revisions read and link previews (readPreviewableMessage), so they can't
 * drift. `joint`: the message is read through a Joint Channel or thread, not a
 * local conversation of this Server.
 */
async function messageVisibleToViewer(req: Request, message: { channelId: string; createdAt: Date }) {
  const visibility = await messageVisibility(req, message);
  return "refusal" in visibility ? null : visibility;
}

/** Why a preview read answers 404, recorded as `preview_refusal` (#proj-o11y:#29). */
type PreviewRefusal = "not_found" | "not_previewable" | "not_visible" | "out_of_history";

async function messageVisibility(
  req: Request,
  message: { channelId: string; createdAt: Date },
): Promise<{ refusal: "not_visible" | "out_of_history" } | { historyWindow: Awaited<ReturnType<typeof getServerHistoryWindowForRead>>; joint: boolean }> {
  const serverId = req.serverId!;
  const channel = await channelService.getChannel(message.channelId);
  if (!channel) return { refusal: "not_visible" };
  const localChannelId = await personLocalConversationId(channel, serverId);
  if (!localChannelId || !(await canView({ type: "user", id: req.userId!, serverId }, [{ kind: "conversation", channelId: localChannelId }]))[0]) return { refusal: "not_visible" };
  const historyWindow = await getServerHistoryWindowForRead(serverId);
  if (isBehindHistoryWindow(message.createdAt, historyWindow)) return { refusal: "out_of_history" };
  return { historyWindow, joint: channel.serverId !== serverId || channel.type === "joint" };
}

/**
 * The message whose links a preview read may resolve, as the viewer sees it, or
 * null (404). Ordinary chat the viewer can read from the request's Server
 * (messageVisibleToViewer): a local channel of it, or a Joint Channel or thread
 * this Server holds a projection of (RFC 076 §16). Shared by the v1 GET, the batched link-card
 * read and the link-card actions (routes/linkCards.ts), so all apply the same
 * checks. Everything the read does with the message after this is keyed to the
 * request's Server, never the Server that stores the message.
 */
export async function readPreviewableMessage(req: Request, messageId: string) {
  const result = await readPreviewableMessageOrRefusal(req, messageId);
  return "refusal" in result ? null : result.message;
}

type PreviewableMessage = NonNullable<Awaited<ReturnType<typeof messageService.getMessageContext>>>["messages"][number];

async function readPreviewableMessageOrRefusal(req: Request, messageId: string): Promise<{ message: PreviewableMessage } | { refusal: PreviewRefusal }> {
  const message = await messageService.getMessage(messageId);
  if (!message) return { refusal: "not_found" };
  if (message.messageType !== "chat" || message.actionMetadata) return { refusal: "not_previewable" };
  const visibility = await messageVisibility(req, message);
  if ("refusal" in visibility) return { refusal: visibility.refusal };
  const context = await messageService.getMessageContext(message.id, 0, 0, visibility.historyWindow.cutoff, {
    attachmentCommentViewerUserId: req.userId, forwardedBundleViewerUserId: req.userId, viewerServerId: req.serverId,
  });
  const visible = context?.messages.find((item) => item.id === message.id);
  return visible ? { message: visible } : { refusal: "not_visible" };
}

/**
 * A preview read's 404 or failure, on its request span: which check refused it
 * (never which one to the client, which keeps the unknown message's 404), and
 * the message as its keyed trace hash, never the raw id. A failure keeps its
 * empty 200 for the web but is no longer silent.
 */
function tracePreviewRefusal(route: "app_link_previews" | "link_cards_read", messageId: string, refusal: PreviewRefusal) {
  const messageIdHash = traceIdentityHash("message_id_hash", messageId);
  addTraceEvent("link_preview.refused", {
    route_action: route,
    preview_refusal: refusal,
    ...(messageIdHash ? { message_id_hash: messageIdHash } : {}),
  });
}
function tracePreviewFailure(route: "app_link_previews" | "link_cards_read", messageId: string, err: unknown) {
  const messageIdHash = traceIdentityHash("message_id_hash", messageId);
  traceRouteFailure("link_preview.failed", err, {
    route_action: route,
    outcome: "error",
    ...(messageIdHash ? { message_id_hash: messageIdHash } : {}),
  });
}

// Third-party previews are personal, transient views, never persisted into chat.
// `prompts` (Apps the viewer has neither consented to nor declined) is a field
// older web clients drop: their response schema is not strict at the top level.
messageRouter.get("/:messageId/app-link-previews", appLinkPreviewLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const messageId = req.params.messageId;
  if (typeof messageId !== "string" || !UUID_RE.test(messageId)) { res.status(404).json({ error: "Message not found" }); return; }
  const readVisible = () => readPreviewableMessage(req, messageId);
  try {
    const first = await readPreviewableMessageOrRefusal(req, messageId);
    if ("refusal" in first) { tracePreviewRefusal("app_link_previews", messageId, first.refusal); res.status(404).json({ error: "Message not found" }); return; }
    const message = first.message;
    const { previews, prompts, appIcons } = await resolveAppLinkPreviews({ serverId: req.serverId!, userId: req.userId!, content: message.content,
      stillVisible: async () => (await readVisible())?.content === message.content });
    res.json({ previews, prompts, appIcons });
  } catch (err) {
    tracePreviewFailure("app_link_previews", messageId, err);
    res.json({ previews: [], prompts: [], appIcons: {} });
  }
});

// The batched interactive link-card read (RFC 076 §6.1; services/linkCardReadService.ts).
// Its body is parsed by its own bounded parser, registered in app.ts ahead of
// the global one, so an oversized body is refused before it is parsed.
export const LINK_CARD_READ_PATH = "/api/messages/:messageId/link-cards/read";
export const linkCardReadBodyParser: RequestHandler = express.json({ limit: LINK_CARD_READ_MAX_BODY_BYTES });
export const linkCardReadBodyErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const tooLarge = (err as { type?: unknown }).type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Link card read request too large" : "Invalid link card read request" });
};
/** Under the /api/messages mount: a read, so the message-sending limiter skips it. */
export const isLinkCardReadRequest = (req: Request) => req.method === "POST" && /^\/[^/]+\/link-cards\/read\/?$/i.test(req.path);
// Requests per person (one budget across Servers, like the GET). Set to the
// per-link budget, so a read that carries links is bounded by the per-link
// limiter first and comes back item by item, not as a whole-request 429.
const linkCardReadLimiter = rateLimit({
  windowMs: 60_000, limit: LINK_CARD_READ_URLS_PER_MINUTE, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.userId!,
  message: { items: [], prompts: [] },
});
messageRouter.post("/:messageId/link-cards/read", linkCardReadLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const messageId = req.params.messageId;
  if (typeof messageId !== "string" || !UUID_RE.test(messageId)) { res.status(404).json({ error: "Message not found" }); return; }
  const request = parseLinkCardReadBody(req.body);
  if (!request) { res.status(400).json({ error: "Invalid link card read request" }); return; }
  const readVisible = () => readPreviewableMessage(req, messageId);
  try {
    const first = await readPreviewableMessageOrRefusal(req, messageId);
    if ("refusal" in first) { tracePreviewRefusal("link_cards_read", messageId, first.refusal); res.status(404).json({ error: "Message not found" }); return; }
    const message = first.message;
    res.json(await readLinkCards({ serverId: req.serverId!, userId: req.userId!, messageId, content: message.content, request,
      stillVisible: async () => (await readVisible())?.content === message.content }));
  } catch (err) {
    tracePreviewFailure("link_cards_read", messageId, err);
    res.json({ items: [], prompts: [] });
  }
});

messageRouter.get("/context/:messageId", async (req, res) => {
  // A malformed id (e.g. a permalink whose `msg=` swallowed the CJK text after
  // it) is a client error, not a uuid-cast 500.
  const looksLikeFullUuid = UUID_RE.test(req.params.messageId);
  if (!looksLikeFullUuid && !isMessageShortId(req.params.messageId)) {
    res.status(400).json({ error: "Invalid message id" });
    return;
  }
  if (typeof req.query.channelId === "string" && !UUID_RE.test(req.query.channelId)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }
  try {
    const plan = await tracePhase(
      () => getServerPlan(req.serverId!),
      (_durationMs, result) => ({ name: "history.policy.checked", attrs: { plan: result } }),
    );
    const historyCutoff = getHistoryCutoff(plan);
    const channelId = typeof req.query.channelId === "string" ? req.query.channelId : undefined;
    const queryChannel = channelId ? await channelService.getChannel(channelId) : null;
    // Historical permalinks retain the source workspace's local channel ID.
    // Resolve only an active projection in the caller's current workspace;
    // the local membership check below remains the read authority.
    const localJointProjection = queryChannel?.type === "joint" && channelId
      ? (await channelService.getActiveJointChannelProjectionsByLocalChannel(channelId))
        .find((projection) => projection.serverId === req.serverId)
      : null;
    const queryJointResolved = localJointProjection
      ? await channelService.resolveChannelAccess({ serverId: req.serverId!, channelId: localJointProjection.localChannelId })
      : null;
    const sourceJointThreadProjection = isSubConversationType(queryChannel?.type)
      ? await channelService.getJointThreadProjectionByLocalThread(channelId!)
      : null;
    const queryJointThreadProjection = sourceJointThreadProjection?.localServerId === req.serverId
      ? sourceJointThreadProjection
      : sourceJointThreadProjection
        ? (await channelService.getActiveJointThreadProjectionsByCanonicalThread(sourceJointThreadProjection.canonicalThreadChannelId))
          .find((projection) => projection.localServerId === req.serverId) ?? null
        : null;
    const contextChannelId = queryJointResolved?.kind === "joint"
      ? queryJointResolved.canonicalChannelId
      : queryJointThreadProjection?.canonicalThreadChannelId ?? channelId;
    if (channelId && !contextChannelId) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const contextBefore = parseContextWindowSide(req.query.before);
    const contextAfter = parseContextWindowSide(req.query.after);
    const contextQueryOptions = {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      viewerServerId: req.serverId,
    };
    const findContext = async (
      cutoff: Date | undefined,
      before: typeof contextBefore = contextBefore,
      after: typeof contextAfter = contextAfter,
    ) => channelId
      ? looksLikeFullUuid
        ? await messageService.getMessageContextInChannel(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
          ?? await messageService.getThreadReplyContextForParentChannel(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
          ?? await messageService.getThreadParentContextByThreadChannelIdForParentChannel(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
        : await messageService.getMessageContextByShortId(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
          ?? await messageService.getThreadReplyContextByShortIdForParentChannel(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
          ?? await messageService.getThreadParentContextByThreadChannelIdForParentChannel(contextChannelId!, req.params.messageId, before, after, cutoff, contextQueryOptions)
      : await messageService.getMessageContext(req.params.messageId, before, after, cutoff, contextQueryOptions);
    type FoundContext = NonNullable<Awaited<ReturnType<typeof findContext>>>;
    // Where the found message is read from, and whether this person may read
    // it there: the same answer for a message inside the window and one behind it.
    const authorizeContext = async (found: FoundContext) => {
      let responseChannelId = queryJointResolved?.kind === "joint"
        ? queryJointResolved.localChannelId
        : queryJointThreadProjection?.localThreadChannelId ?? found.channelId;
      const canonicalTarget = (("canonicalTarget" in found ? found.canonicalTarget : null)
        ?? (queryJointThreadProjection ? {
          kind: "thread",
          channelId: queryJointThreadProjection.localParentChannelId,
          threadChannelId: queryJointThreadProjection.localThreadChannelId,
          threadParentMessageId: queryJointThreadProjection.canonicalParentMessageId,
          messageId: found.targetMessageId,
        } : null)) as null | {
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
      // A batch may already have rehomed the target while the local channel
      // intentionally remains ordinary until final cutover. Authorize its local
      // projection below, never the storage namespace.
      const localReadProjection = (await channelService.getActiveJointChannelProjectionsByLocalChannel(responseChannelId))
        .find((projection) => projection.serverId === req.serverId);
      if (localReadProjection) responseChannelId = localReadProjection.localChannelId;
      const channel = await channelService.getChannel(responseChannelId);
      if (!channel || channel.serverId !== req.serverId) return { denied: "channel" as const };
      const canAccess = await channelService.canUserAccessChannel(responseChannelId, req.userId!, req.serverId!);
      if (!canAccess) return { denied: "message" as const };
      // Local ids only: a thread target names this server's projection of it.
      const projectedTarget = canonicalTarget?.kind === "thread"
        ? { ...canonicalTarget, channelId: queryJointResolved?.localChannelId ?? canonicalTarget.channelId, threadChannelId: responseChannelId }
        : canonicalTarget ?? ("canonicalTarget" in found ? found.canonicalTarget : undefined);
      return { denied: null, responseChannelId, canonicalTarget, projectedTarget };
    };
    const context = await findContext(historyCutoff);
    if (!context) {
      // Context queries apply the plan cutoff, so a target behind it lands
      // here too (task #14). Find it without the cutoff: one this person may
      // read is "older than the history window", not "not found", and the
      // history paywall centers on it (task #8, frames 4, 5, 8, 9).
      // Only its location is needed: no window around it.
      const hiddenContext = historyCutoff ? await findContext(undefined, 0, 0) : null;
      const hiddenAccess = hiddenContext ? await authorizeContext(hiddenContext) : null;
      const hiddenTarget = hiddenContext && hiddenAccess?.denied === null && historyCutoff
        ? await messageService.getHiddenTargetPreview(hiddenContext.channelId, hiddenContext.targetMessageId, historyCutoff, {
          traceQuery: createTraceDbQueryTracer("history.hidden_target"),
          viewerServerId: req.serverId,
        })
        : null;
      addTraceEvent("message_context.not_found", {
        plan,
        history_cutoff_present: Boolean(historyCutoff),
        history_limited: Boolean(hiddenTarget),
      });
      if (hiddenTarget && hiddenAccess?.denied === null) {
        notePaywallHit(req, "history_30d");
        // Still a 404 for older clients, which treat it as not found.
        res.status(404).json({
          ...humanHistoryLimitedError({ plan, cutoff: historyCutoff }),
          channelId: hiddenAccess.responseChannelId,
          targetMessageId: hiddenContext!.targetMessageId,
          // Where it sits (a thread reply names its thread), so a link to it
          // can open the thread on the paywall: ids only.
          ...(hiddenAccess.projectedTarget ? { canonicalTarget: hiddenAccess.projectedTarget } : {}),
          hiddenTarget,
        });
        return;
      }
      res.status(404).json({ error: "Message not found" });
      return;
    }

    const access = await authorizeContext(context);
    if (access.denied === "channel") {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (access.denied === "message") {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const { responseChannelId } = access;

    let historyLimited = false;
    if (historyCutoff) {
      historyLimited = await messageService.hasOlderMessages(
        context.channelId,
        historyCutoff,
        context.messages[0]?.seq,
      );
      if (!historyLimited && !context.hasOlder) {
        historyLimited = await messageService.isThreadParentHidden(context.channelId, historyCutoff);
      }
    }
    // The window reaches the start of what the plan shows: say what the cutoff
    // hides there, as a channel page that reaches it does.
    const hiddenHistory = historyLimited && historyCutoff && !context.hasOlder
      ? await messageService.getHiddenHistoryPreview(context.channelId, historyCutoff, {
        traceQuery: createTraceDbQueryTracer("history.hidden_preview"),
        viewerServerId: req.serverId,
      })
      : undefined;
    if (hiddenHistory) notePaywallHit(req, "history_30d");
    addTraceEvent("history.limit.checked", {
      plan,
      history_cutoff_present: Boolean(historyCutoff),
      history_limited: historyLimited,
    });

    const channelArchived = await channelService.isChannelArchived(responseChannelId);
    const projectedContextMessages = await messageService.projectJointMessagesToLocalChannel(
      context.messages, responseChannelId, req.serverId!,
    );
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
      canonicalTarget: access.projectedTarget,
      messages: projectedContextMessages,
      threadSummariesByParentMessageId,
      historyLimited,
      ...(hiddenHistory ? { hiddenHistory } : {}),
      channelArchived,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load message context",
      logPrefix: "Get message context error:",
      err,
    });
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
    const jointThreadProjection = isSubConversationType(channel.type)
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
    // The latest page reports a sync horizon taken before it reads
    // (services/syncHorizon.ts): every transaction below it had finished, so
    // its rows were visible to this read. A client whose first history read
    // this is can start sync:resume from it instead of racing the socket's
    // `sync:horizon` against this request. Keep this read BEFORE the page
    // query: a horizon taken after it could pass rows the page never saw.
    const startingHorizon = direction === "latest" ? await readSyncHorizon() : null;
    const page = await tracePhase(
      () => messageService.listMessagesWithCoverage(storageChannelId, limit, beforeSeq, afterSeq, historyCutoff, {
        traceQuery: createTraceDbQueryTracer("messages.paged"),
        attachmentCommentViewerUserId: req.userId,
        forwardedBundleViewerUserId: req.userId,
        viewerServerId: req.serverId,
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
      : await messageService.projectJointMessagesToLocalChannel(page.messages, req.params.channelId, req.serverId!);
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
    // A thread whose replies are all in the window can still have its first
    // message (in the parent channel) behind the cutoff: that is hidden
    // history too, and only matters where the page reached the start.
    if (!historyLimited && historyCutoff && afterSeq === undefined && page.messages.length < limit) {
      historyLimited = await messageService.isThreadParentHidden(storageChannelId, historyCutoff, {
        traceQuery: createTraceDbQueryTracer("history.thread_parent.checked"),
      });
    }
    // A short page reached the start of the visible window, so the web shows
    // the history paywall next: say what the cutoff hides there (a count and
    // a faded preview of the newest hidden messages).
    const hiddenHistory = historyLimited && historyCutoff && page.messages.length < limit
      ? await tracePhase(
          () => messageService.getHiddenHistoryPreview(storageChannelId, historyCutoff, {
            traceQuery: createTraceDbQueryTracer("history.hidden_preview"),
            viewerServerId: req.serverId,
          }),
          (_durationMs, result) => ({
            name: "history.hidden_preview.loaded",
            attrs: {
              hidden_count: result.hiddenCount,
              hidden_count_capped: result.hiddenCountCapped,
              preview_count: result.latest.length,
            },
          }),
        )
      : undefined;
    // The cutoff did leave older messages out of what this person reads.
    if (hiddenHistory) notePaywallHit(req, "history_30d");

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
    if (startingHorizon) res.setHeader(SYNC_HORIZON_HEADER, startingHorizon.horizon);
    res.json({
      messages: projectedMsgs,
      threadSummariesByParentMessageId,
      historyLimited,
      ...(hiddenHistory ? { hiddenHistory } : {}),
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

// The conversation outline (消息时间线): a page of what people themselves wrote,
// newest first, `before` a seq. Same access, joint storage and history window
// as GET /channel/:channelId. A hidden human directory (hideHumansFromMembers)
// changes nothing here: it hides the member list, not who wrote what in a
// conversation the reader can open, which that route shows too.
messageRouter.get("/channel/:channelId/human-outline", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.channelId);
    if (!channel || channel.serverId !== req.serverId) {
      refuse(res, 404, { code: "channel_not_found", error: "That conversation doesn't exist on this server or you can't see it; check the channel id." });
      return;
    }
    const [visible] = await canView({ type: "user", id: req.userId!, serverId: req.serverId! }, [{ kind: "conversation", channelId: channel.id }]);
    if (!visible) {
      await denyChannelAccess(res, req.userId!, req.params.channelId, "You do not have access to this channel");
      return;
    }
    const beforeSeq = parseMessagePageCursor(req.query.before);
    if (beforeSeq === "invalid") {
      refuse(res, 400, { code: "invalid_message_page_cursor", error: "The before cursor isn't a message seq; pass the seq of the oldest item already read." });
      return;
    }
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? ""), 10) || HUMAN_OUTLINE_DEFAULT_LIMIT, HUMAN_OUTLINE_MAX_LIMIT));
    const resolved = channel.type === "joint"
      ? await channelService.resolveChannelAccess({ serverId: req.serverId!, channelId: req.params.channelId })
      : null;
    const jointThreadProjection = isSubConversationType(channel.type)
      ? await channelService.getJointThreadProjectionByLocalThread(req.params.channelId, req.serverId!)
      : null;
    const storageChannelId = resolved?.kind === "joint"
      ? resolved.canonicalChannelId
      : jointThreadProjection?.canonicalThreadChannelId ?? req.params.channelId;
    const historyCutoff = getHistoryCutoff(await getServerPlan(req.serverId!));
    const page = await messageService.listHumanOutlineMessages(storageChannelId, limit, beforeSeq, historyCutoff, {
      traceQuery: createTraceDbQueryTracer("messages.human_outline"),
    });
    res.json({ items: page.items, hasMore: page.hasMore });
  } catch {
    res.status(500).json({ error: "Failed to list the conversation outline" });
  }
});

// Forum-style channels (#proj-chat:#24): a page of the channel's top-level
// messages ordered by latest activity (own time or latest thread reply),
// oldest first, newest activity last. `before` is the opaque keyset cursor the
// previous page returned (`nextCursor`). 404 while channel_thread_sort_v0 is
// off or the channel is not a regular channel set to `activity`; same access
// and history window as GET /channel/:channelId.
messageRouter.get("/channel/:channelId/by-activity", async (req, res) => {
  try {
    const channel = await channelService.getChannel(req.params.channelId);
    if (!channel || channel.serverId !== req.serverId) {
      res.status(404).json(CHANNEL_NOT_FOUND_BODY);
      return;
    }
    const [visible] = await canView({ type: "user", id: req.userId!, serverId: req.serverId! }, [{ kind: "conversation", channelId: channel.id }]);
    if (!visible) {
      await denyChannelAccess(res, req.userId!, req.params.channelId, "You do not have access to this channel");
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
      serverId: req.serverId!,
      userId: req.userId!,
    });
    if (!gate.enabled || !channelTypeSupportsThreadSort(channel.type) || channel.threadSort !== "activity") {
      res.status(404).json({ error: "This channel is not ordered by activity", code: "thread_sort_not_activity" });
      return;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const before = req.query.before === undefined ? null : decodeChannelActivityCursor(req.query.before);
    if (req.query.before !== undefined && !before) {
      res.status(400).json({ error: "Invalid message page cursor", code: "invalid_message_page_cursor" });
      return;
    }
    const historyCutoff = getHistoryCutoff(await getServerPlan(req.serverId!));
    const page = await messageService.listTopLevelMessagesByActivity(channel.id, limit, before, historyCutoff, {
      traceQuery: createTraceDbQueryTracer("messages.activity_paged"),
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      viewerServerId: req.serverId,
    });
    // Joint channels never get here (type gate above): no joint thread
    // projection, only the conversion scope's rows shown under this channel.
    const projected = messageService.projectMessagesToChannel(page.messages, channel.id);
    const activityById = new Map(page.messages.map((message) => [message.id, message.activityAt]));
    const pageMessages = projected.map((message) => ({ ...message, activityAt: activityById.get(message.id) ?? null }));
    const historyLimited = Boolean(historyCutoff) && !page.hasMore
      && await messageService.hasOlderMessages(channel.id, historyCutoff!, undefined, {});
    const threadSummariesByParentMessageId = pageMessages.length === 0
      ? {}
      : await channelService.getThreadSummaries(channel.id, {
          userId: req.userId!,
          parentMessageIds: pageMessages.map((message) => message.id),
          parentMessageScopeSource: "messages_page",
          traceQuery: createTraceDbQueryTracer("messages.activity_thread_summaries"),
        });
    res.json({
      messages: pageMessages,
      threadSummariesByParentMessageId,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      historyLimited,
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
    sendJsonServerError(req, res, {
      error: "Failed to evaluate attachment preview availability",
      logPrefix: "Attachment preview flag evaluation failed:",
      err,
    });
  }
});

// Kept as a compatibility read for clients released before forwarding was
// stable. The feature is now always available; access is enforced by the
// ordinary message/channel authorization below.
messageRouter.get("/forward/enabled", (_req, res) => {
  res.json({ enabled: true });
});

const MAX_FORWARD_CONVERSATIONS_LIMIT = 4;

/**
 * The picker's "Threads & tasks" group: up to 4 threads / task conversations
 * the person takes part in (follows: replied, authored, assigned, followed),
 * newest activity first, each visible and open to a forward now. A current
 * thread / task conversation the person can post in comes first (`current`).
 */
messageRouter.get("/forward/targets/conversations", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(1, parseInt(String(req.query.limit), 10) || MAX_FORWARD_CONVERSATIONS_LIMIT),
      MAX_FORWARD_CONVERSATIONS_LIMIT,
    );
    const currentChannelId = typeof req.query.currentChannelId === "string" && UUID_RE.test(req.query.currentChannelId.trim())
      ? req.query.currentChannelId.trim()
      : null;
    const serverId = req.serverId!;
    const userId = req.userId!;
    // Parents behind the plan's history window show only their glimpse (forwardParentContent).
    const historyCutoff = (await getRequestHistoryWindow(req, serverId)).cutoff;
    const current = currentChannelId
      ? (await admitForwardConversationTargets({
          serverId,
          userId,
          candidates: await listCurrentForwardConversationCandidate(currentChannelId, serverId, historyCutoff),
          limit: 1,
        })).map((target): ForwardConversationTarget => ({ ...target, current: true }))
      : [];
    const recent = await admitForwardConversationTargets({
      serverId,
      userId,
      candidates: await listForwardConversationCandidates({ serverId, userId, excludeChannelId: current[0]?.channelId ?? null, historyCutoff }),
      limit: limit - current.length,
    });
    res.json({ targets: [...current, ...recent] });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list forward conversations",
      logPrefix: "Forward conversation targets failed:",
      err,
    });
  }
});

/** The current conversation as a candidate, when it is a live thread / task conversation of this server. */
async function listCurrentForwardConversationCandidate(channelId: string, serverId: string, historyCutoff: Date | undefined): Promise<ForwardConversationCandidate[]> {
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== serverId || !isSubConversationType(channel.type)) return [];
  if (channel.type === "task") {
    const jointThread = await channelService.getJointThreadProjectionByLocalThread(channel.id, serverId);
    const task = await getTaskForConversationChannel(jointThread?.canonicalThreadChannelId ?? channel.id);
    if (!task) return [];
    return [{ channelId, type: "task", parentMessageContent: null, taskNumber: task.taskNumber, taskTitle: task.taskTitle }];
  }
  const jointThread = await channelService.getJointThreadProjectionByLocalThread(channel.id, serverId);
  const storage = jointThread ? await channelService.getChannel(jointThread.canonicalThreadChannelId) : channel;
  const parentMessage = storage?.parentMessageId ? await messageService.getMessage(storage.parentMessageId) : null;
  if (!parentMessage || parentMessage.deletedAt) return [];
  return [{
    channelId,
    type: "thread",
    parentMessageContent: forwardParentContent(parentMessage.content, parentMessage.createdAt, historyCutoff),
    taskNumber: null,
    taskTitle: null,
  }];
}

messageRouter.get("/forward/targets/search", async (req, res) => {
  try {
    const { targets, conversations } = await searchForwardTargets({
      serverId: req.serverId!,
      userId: req.userId!,
      q: typeof req.query.q === "string" ? req.query.q : "",
      limit: parseInt(String(req.query.limit), 10),
    });
    res.json({ targets: [...targets.map(({ handle: _handle, peerKind: _peerKind, ...target }) => target), ...conversations] });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to search forward targets",
      logPrefix: "Forward target search failed:",
      err,
    });
  }
});

function boundedForwardError(error: unknown): { stableCode: string; errorClass: string; status: number } {
  if (error instanceof DmPeerNotMemberError || error instanceof JointChannelAccessChangedError) return { stableCode: error.code, errorClass: error.name, status: error.status };
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
  let phase: ForwardDiagnosticPhase = "validate";
  const errorPhases = new WeakMap<object, ForwardDiagnosticPhase>();
  try {
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

    if (isOverForwardMessageCap(req.body?.sourceMessageIds)) {
      recordForwardTerminal(req, { phase, outcome: "rejected", status: 400, stableCode: FORWARD_TOO_MANY_MESSAGES_CODE, errorClass: "ValidationError" });
      res.status(400).json({ error: FORWARD_TOO_MANY_MESSAGES_ERROR, code: FORWARD_TOO_MANY_MESSAGES_CODE });
      return;
    }
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

    noteForwardTargets(req, { destinationChannelIds, sourceMessageIds });
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
    const content = forwardMessageContent(note, baseActionMetadata.forwardedItems.length);

    const forwardToDestination = async (targetChannelId: string) => {
      let destinationPhase: ForwardDiagnosticPhase = "resolve_authorize";
      try {
        return await forwardBundleAsUser({
          io,
          orchestrator: agentOrchestrator,
          serverId: req.serverId!,
          userId,
          senderName,
          targetChannelId,
          content,
          note,
          sourceMessageIds,
          bundleMetadata: baseActionMetadata,
          requestId,
          randomId: parsedRandomId,
          onPaywallHit: (kind) => notePaywallHit(req, kind),
          onPhase: (next) => { destinationPhase = next; },
        });
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
        if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
          return { destinationChannelId: targetChannelId, status: "failed" as const, code: err.code, error: err.message };
        }
        if (err instanceof ChannelConversionInProgressError) {
          // Bounded fields only: the destination as its keyed hash, never the raw id or error text.
          safeAddTraceEvent("messages.forward.destination.failed", () => {
            const conversationIdHash = traceIdentityHash("conversation_id_hash", targetChannelId);
            return {
              route_family: "message_forward",
              phase: errorPhases.get(err) ?? "persist_broadcast",
              code: err.code,
              ...(conversationIdHash ? { conversation_id_hash: conversationIdHash } : {}),
            };
          });
          return {
            destinationChannelId: targetChannelId,
            status: "failed" as const,
            code: err.code,
            error: err.message,
            conversionEpoch: err.conversionEpoch,
          };
        }
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
    if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
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
    // Best-effort: the web client reports its IANA zone for agents. A bad or
    // missing value is stored as null and never fails the send.
    const senderTimezone = parseOptionalIanaTimezone(req.body.timezone);
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
    const admission = await checkHumanPostAdmission(req.serverId!, userId, channelId);
    if (!admission.ok) {
      if (admission.refusal === "billing_read_only") {
        if (admission.billing.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
        res.status(403).json(channelBillingReadOnlyBody(admission.billing));
        return;
      }
      const refusal = HUMAN_POST_REFUSALS[admission.refusal];
      res.status(refusal.status).json({ error: refusal.error, ...(admission.refusal === "joint_task_read_only" ? { code: "joint_task_read_only" } : {}) });
      return;
    }
    const { channel } = admission;
    // Agent Lounge: posting is joining (announced as POST /channels/:id/join does).
    if (channel.type === "channel" && await channelService.ensureLoungeHumanMember(channelId, userId)) {
      req.app.get("io")?.to(`server:${req.serverId}`).emit("channel:members-updated", { channelId });
    }

    // Fast typed rejection for an already-fenced source. The persistence
    // boundary repeats this check while holding the same per-source lock, so
    // this user-facing precheck is not the TOCTOU authority.
    const conversionTarget = await resolveChannelConversionLockTarget(getDb(), channelId);
    if (conversionTarget) {
      await assertChannelConversionWritable(conversionTarget.sourceChannelId);
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
      senderTimezone,
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
    const deliveryWarnings = messageService.getSenderDeliveryWarnings(enriched);
    if (mentionContract === "v2") {
      res.json({
        message: enriched,
        ...(pendingMentionActions.length > 0 ? { pendingMentionActions } : {}),
        ...(unresolvedMentionHandles.length > 0 ? { unresolvedMentionHandles } : {}),
        ...(deliveryWarnings.length > 0 ? { deliveryWarnings } : {}),
      });
      return;
    }
    if (pendingMentionActions.length > 0) {
      res.json({ message: enriched, pendingMentionActions });
      return;
    }

    res.json(enriched);
  } catch (err) {
    if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
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
    sendJsonServerError(req, res, {
      error: "Failed to execute mention action",
      logPrefix: "messages.mention-actions.execute error:",
      err,
    });
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
    sendJsonServerError(req, res, { error: "Failed to list reaction actors", logPrefix: "List reaction actors error:", err });
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
    sendJsonServerError(req, res, { error: "Failed to hydrate reaction viewer state", logPrefix: "Hydrate reaction viewer error:", err });
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

    const billingReadOnly = await getChannelBillingReadOnly(localChannelId, req.serverId!);
    if (billingReadOnly) {
      if (billingReadOnly.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
      res.status(403).json(channelBillingReadOnlyBody(billingReadOnly));
      return;
    }
    if (await isChannelReadOnlyByQuota(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    const mutation = await mutateMessageReaction({
      channelId: localChannelId,
      messageId: message.id,
      emoji,
      actor: { kind: "user", id: req.userId! },
      operation: "add",
      noticeDeliverer: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
      message,
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      viewerServerId: req.serverId,
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
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to add reaction", logPrefix: "Add reaction error:", err });
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

    const billingReadOnly = await getChannelBillingReadOnly(localChannelId, req.serverId!);
    if (billingReadOnly) {
      if (billingReadOnly.reason === "joint_over_limit") notePaywallHit(req, "joint_channel_read_only");
      res.status(403).json(channelBillingReadOnlyBody(billingReadOnly));
      return;
    }
    if (await isChannelReadOnlyByQuota(localChannelId, req.serverId!)) {
      res.status(403).json({ error: "This channel is read-only on your current plan. Upgrade to continue." });
      return;
    }

    const mutation = await mutateMessageReaction({
      channelId: localChannelId,
      messageId: message.id,
      emoji,
      actor: { kind: "user", id: req.userId! },
      operation: "remove",
      noticeDeliverer: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
      message,
    });

    const context = await messageService.getMessageContext(message.id, 0, 0, undefined, {
      attachmentCommentViewerUserId: req.userId,
      forwardedBundleViewerUserId: req.userId,
      viewerServerId: req.serverId,
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
    if (err instanceof ChannelConversionInProgressError) {
      res.status(err.status).json({ error: err.message, code: err.code, conversionEpoch: err.conversionEpoch });
      return;
    }
    if (err instanceof channelService.ChannelArchivedError) {
      res.status(409).json({ error: "This channel is archived", code: "channel_archived" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to remove reaction", logPrefix: "Remove reaction error:", err });
  }
});

// Sync messages (gap sync after reconnection).
//
// Body: a bare Message[] (unchanged). Response header X-Sync-Horizon: the
// read's sync horizon (decimal xid8, see services/syncHorizon.ts).
// Paging rule: send `since_horizon` only on a round's FIRST page; the next
// round's since_horizon is the X-Sync-Horizon of this round's first page; later
// pages of a round omit it. With since_horizon the page holds only rows whose
// transaction finished, plus the "late" rows (seq <= since_seq that finished
// after that horizon). If more than SYNC_LATE_CAP late rows qualify, none are
// returned and X-Sync-Horizon-Reset: 1 is set: the client refetches its
// visible scope instead of paging the late rows. Late rows have
// seq <= since_seq: the client's cursor is max(since_seq, max seq of the body),
// and "has more" counts only rows with seq > since_seq. Without since_horizon
// the rows are exactly what they were before the horizon existed.
messageRouter.get("/sync", async (req, res) => {
  try {
    const sinceSeq = Number(req.query.since_seq) || 0;
    const channelId = req.query.channel_id as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rawSinceHorizon = req.query.since_horizon;
    const sinceHorizon = rawSinceHorizon === undefined ? null : parseSyncHorizon(rawSinceHorizon);
    if (rawSinceHorizon !== undefined && !sinceHorizon) {
      addTraceEvent("messages.sync.rejected", { reason: "since_horizon_invalid" });
      res.status(400).json({ error: "since_horizon must be the decimal string of a non-negative 64-bit transaction id", code: "invalid_since_horizon" });
      return;
    }
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

    const sendSync = (result: Awaited<ReturnType<typeof messageService.syncMessagesWithHorizon>>, body: unknown[]) => {
      addTraceEvent("messages.sync.read", {
        horizon_requested: Boolean(sinceHorizon),
        late_count: result.lateCount,
        horizon_reset: result.horizonReset,
        ...(result.snapshotXidSpan === null ? {} : { snapshot_xid_span: result.snapshotXidSpan }),
        messages_count: body.length,
        channel_scoped: Boolean(channelId),
      });
      res.setHeader(SYNC_HORIZON_HEADER, result.horizon);
      if (result.horizonReset) res.setHeader(SYNC_HORIZON_RESET_HEADER, "1");
      res.json(body);
    };

    // Always scope to current server
    if (jointResolved?.kind === "joint") {
      const result = await messageService.syncMessagesWithHorizon(
        sinceSeq,
        jointResolved.canonicalChannelId,
        limit,
        undefined,
        historyCutoff,
        req.userId!,
        req.serverId!,
        { sinceHorizon },
      );
      sendSync(result, await messageService.projectJointMessagesToLocalChannel(result.messages, jointResolved.localChannelId, req.serverId!));
      return;
    }

    const result = await messageService.syncMessagesWithHorizon(sinceSeq, channelId, limit, req.serverId!, historyCutoff, req.userId!, req.serverId!, { sinceHorizon });
    sendSync(result, result.messages);
  } catch {
    res.status(500).json({ error: "Failed to sync messages" });
  }
});
