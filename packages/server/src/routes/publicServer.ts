import { Router, type Router as ExpressRouter } from "express";
import { createRaftStructuredUserRefRegex, extractRaftMentionHandles, normalizeTranslationLanguageCode } from "@botiverse/raft-shared";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import { agentFindableBy } from "../services/agentMemberListPolicy";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import {
  agents,
  attachmentObjects,
  attachments,
  channels,
  externalActorProjections,
  externalMentionFacts,
  externalReactionStates,
  messageMentions,
  messageReactions,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { guardUuidPathParams } from "../lib/uuidPathParams";
import * as channelService from "../services/channelService";
import * as onboardingService from "../services/onboardingService";
import * as serverAgreementService from "../services/serverAgreementService";
import * as serverService from "../services/serverService";
import { getProductEventSink, getPublicVisitorSink } from "../services/productEventIngest";
import { publicVisitorIdOffered } from "../services/publicVisitCounts";
import { publicVisitorIdMode } from "../services/publicVisitorRegion";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import { isShownUserAvatarUrl, isStoredServerScopedAvatarUrl } from "../services/avatarService";
import { isPublicPixelAvatarUrl } from "../services/pixelAvatarService";
import { projectServerPublicProfile } from "../services/serverProfileProjection";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  evaluateFeatureFlag,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
} from "../services/featureFlagService";
import { sendJsonServerError } from "./errorResponse";
import {
  buildAttachmentContentDisposition,
  buildAttachmentContentLengthHeader,
  buildAttachmentDownloadContentDisposition,
  buildAttachmentInlinePreviewContentDisposition,
  buildAttachmentInlinePreviewContentSecurityPolicy,
  buildAttachmentResponseContentType,
  isPdfAttachmentMimeType,
  isPreviewableImageMimeType,
  normalizeAttachmentFilename,
  resolveAttachmentMimeType,
  shouldStreamAttachmentThroughServerForRequest,
} from "./attachments";
import { getAttachmentsForMessagesWithExecutor } from "../services/attachmentLinkingService";
import { getStorage, isStorageNotFoundError } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";
import {
  isTranslationProviderConfigured,
  translatePublicMessagesBatch,
  type TranslationMode,
} from "../services/messageTranslationService";

/**
 * Task #70 — the logged-out read surface for a public server.
 *
 * This is deliberately a SEPARATE narrow path rather than letting an anonymous
 * caller through the ordinary authorization chain (@cindyz approved this shape).
 * That chain assumes a principal everywhere — `req.userId!` appears in ~571
 * places and `canUserAccessChannel` in ~59 — so threading "no principal" through
 * it means auditing every one of them. Every widening here has to be written
 * out in this file, where it is visible, instead of arriving as a side effect of
 * someone relaxing a shared helper.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **Revocation applies on the next request.** Every request re-reads
 *     `publiclyVisible` from the row. There is no cache, anonymous session or
 *     token, so a reader's next list/page request is refused after the toggle
 *     turns off. Content already downloaded by the browser cannot be revoked,
 *     nor can a database query be cancelled after it has passed this check.
 *
 *  2. **Public means public.** The slug is guessable, so this surface must never
 *     be described as "only people with the link". A semi-private mode needs
 *     tokens plus expiry and is separate work.
 */
export const publicServerRouter: ExpressRouter = Router();
// Uniform 404 for non-UUID path params (task #12); `slug` is not a uuid.
guardUuidPathParams(publicServerRouter, { channelId: "Channel", threadChannelId: "Thread", attachmentId: "Attachment" });

// A browser/CDN cache would outlive the database decision and violate the
// next-request revocation contract even if every request handler re-queries it.
publicServerRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** The one place that decides a server is readable by anyone. */
async function findPubliclyVisibleServer(slug: string) {
  const [row] = await getDb()
    .select({
      id: servers.id,
      name: servers.name,
      slug: servers.slug,
      avatarUrl: servers.avatarUrl,
      translationEnabled: servers.translationEnabled,
    })
    .from(servers)
    .where(and(
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .limit(1);
  if (!row) return null;
  return {
    ...projectServerPublicProfile(row),
    translationEnabled: row.translationEnabled,
  };
}

/**
 * The channel predicate, spelled out rather than reused.
 *
 * `guestVisible` alone is NOT sufficient: it is also set on channels of other
 * kinds, and an anonymous reader must never reach a private, dm, joint or
 * thread surface. Requiring `type = "channel"` explicitly means a future change
 * to what `guestVisible` means cannot quietly widen the anonymous surface.
 */
function anonymousReadableChannel(serverId: string, channelId?: string) {
  const conditions = [
    eq(channels.serverId, serverId),
    eq(channels.type, "channel"),
    eq(channels.guestVisible, true),
    isNull(channels.deletedAt),
    isNull(channels.archivedAt),
  ];
  if (channelId) conditions.push(eq(channels.id, channelId));
  return and(...conditions);
}

/**
 * Authorize a message-page request in one indexed query. Keeping the server
 * toggle and channel predicate in the same query preserves next-request
 * revocation without adding a separate database round trip to every page.
 */
async function findAnonymousReadableChannel(slug: string, channelId: string) {
  const [row] = await getDb()
    .select({ id: channels.id, serverId: servers.id })
    .from(channels)
    .innerJoin(servers, and(
      eq(servers.id, channels.serverId),
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .where(and(
      eq(channels.id, channelId),
      eq(channels.type, "channel"),
      eq(channels.guestVisible, true),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Thread summaries for a page of public parent messages: reply count, last
 * reply time and the newest replies (at most 3 per thread), from the same
 * channel-view read members get, with no viewer.
 *
 * Bounded by the page: thread rows for the given parents, at most 3 replies
 * per thread, and those replies' senders. Participants are switched off: that
 * read scans each thread's whole history, the public page does not show them,
 * and an anonymous request has no reason to read those ids (Ark, review of
 * PR 9695). Unread state needs a viewer and is never read here.
 */
export async function loadPublicThreadPreviews(
  channelId: string,
  serverId: string,
  parentMessageIds: string[],
  traceQuery?: DbQueryTracer,
) {
  if (parentMessageIds.length === 0) return {};
  return channelService.getThreadSummaries(channelId, {
    parentMessageIds,
    parentMessageScopeSource: "messages_page",
    includeParticipants: false,
    // Reply agents resolve like the parent rows in listPublicMessages: only
    // this server's agents, else "Unknown agent" (wg-rbac #56).
    agentServerId: serverId,
    ...(traceQuery ? { traceQuery } : {}),
  });
}

/**
 * Attachments of a page of public messages: file metadata only. Physical
 * metadata comes from the same linked-projection read members get (revoked
 * projections and non-active objects are already dropped there). CDN
 * thumbnail URLs are deliberately not projected: they are long-lived
 * capabilities that would outlive the server toggle. The bytes are served by
 * the public attachment route below, which rechecks authority per request.
 */
async function loadPublicAttachments(messageIds: string[]) {
  const byMessage = await getAttachmentsForMessagesWithExecutor(getDb(), messageIds);
  return new Map([...byMessage].map(([messageId, rows]) => [messageId, rows.map((row) => {
    const filename = normalizeAttachmentFilename(row.filename);
    return {
      id: row.id,
      filename,
      mimeType: resolveAttachmentMimeType(filename, row.mimeType),
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
    };
  })]));
}

/**
 * Mentions of a page of public messages, projected for display only: the
 * `@token` as written in the content (so the page can highlight it) and the
 * target's display name. No user/agent/projection id crosses the boundary.
 *
 * Same fact set the member read renders (notifiable or later notified rows,
 * plus provider-side facts). A fact whose token no longer occurs in the
 * content (edited away) is dropped, so this projection never reveals a handle
 * the content itself does not already show.
 */
async function loadPublicMentions(messages: Array<{ id: string; content: string; senderType: string }>, serverId: string) {
  const byMessage = new Map<string, Array<{ type: "user" | "agent" | "external"; name: string; displayName: string }>>();
  if (messages.length === 0) return byMessage;
  const messageIds = messages.map((message) => message.id);
  const db = getDb();
  const [raftRows, externalRows] = await Promise.all([
    db
      .select({
        messageId: messageMentions.messageId,
        type: messageMentions.targetType,
        token: messageMentions.handleAtSendTime,
        displayName: sql<string | null>`CASE
          WHEN ${messageMentions.targetType} = 'user' THEN ${users.displayName}
          ELSE ${agents.displayName}
        END`,
      })
      .from(messageMentions)
      .leftJoin(users, and(eq(messageMentions.targetType, "user"), eq(messageMentions.targetId, users.id)))
      .leftJoin(agents, and(
        eq(messageMentions.targetType, "agent"),
        eq(messageMentions.targetId, agents.id),
        eq(agents.serverId, serverId),
      ))
      .where(and(
        inArray(messageMentions.messageId, messageIds),
        or(eq(messageMentions.notifiableAtSend, true), isNotNull(messageMentions.notifiedAt)),
      ))
      .orderBy(messageMentions.createdAt, messageMentions.handleAtSendTime),
    db
      .select({ messageId: externalMentionFacts.messageId, token: externalMentionFacts.handleAtSendTime })
      .from(externalMentionFacts)
      .where(inArray(externalMentionFacts.messageId, messageIds)),
  ]);
  const contentById = new Map(messages.map((message) => [message.id, message.content]));
  const facts = [
    ...raftRows,
    ...externalRows.map((row) => ({ ...row, type: "external" as const, displayName: row.token })),
  ];
  for (const fact of facts) {
    const pattern = createRaftStructuredUserRefRegex(fact.token);
    const content = contentById.get(fact.messageId) ?? "";
    if (!pattern || !pattern.test(content)) continue;
    const list = byMessage.get(fact.messageId) ?? [];
    if (list.some((mention) => mention.name === fact.token)) continue;
    list.push({ type: fact.type, name: fact.token, displayName: fact.displayName || fact.token });
    byMessage.set(fact.messageId, list);
  }

  // Typed `@name`s with no stored fact (written before mention facts existed,
  // or naming someone outside the channel at send time). The member view
  // highlights these by matching against the directory it already holds; a
  // public reader has no directory, so the match happens here instead. Only
  // names already present in the content are looked up, so this reveals that
  // those names are members, never the member list.
  const unmatchedByMessage = new Map<string, string[]>();
  const wanted = new Set<string>();
  for (const message of messages) {
    // External-origin text (e.g. Slack) has no Raft mention authority of its
    // own: the member view renders its free-text `@name`s inert and highlights
    // only stored facts (MessageItem's EXTERNAL_MESSAGE_MENTION_MAP). Mirror
    // that, so untrusted provider text cannot confirm who is a member here.
    if (message.senderType === "external_projection") continue;
    const known = new Set((byMessage.get(message.id) ?? []).map((mention) => mention.name));
    const handles = extractRaftMentionHandles(message.content).filter((handle) => !known.has(handle));
    if (handles.length === 0) continue;
    unmatchedByMessage.set(message.id, handles);
    for (const handle of handles) wanted.add(handle);
  }
  if (wanted.size === 0) return byMessage;
  const names = [...wanted].slice(0, 500);
  const [memberRows, agentRows] = await Promise.all([
    db
      .select({ name: users.name, displayName: users.displayName })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, serverId), inArray(users.name, names))),
    db
      .select({ name: agents.name, displayName: agents.displayName })
      .from(agents)
      // No personal assistant: nobody but its owner finds one (agentFindableBy).
      .where(and(eq(agents.serverId, serverId), isNull(agents.deletedAt), inArray(agents.name, names), agentFindableBy({}))),
  ]);
  // Agents first, then humans, so a human wins a name collision exactly as in
  // the member view's `buildMentionMap`.
  const directory = new Map<string, { type: "user" | "agent"; displayName: string }>();
  for (const row of agentRows) directory.set(row.name, { type: "agent", displayName: row.displayName || row.name });
  for (const row of memberRows) directory.set(row.name, { type: "user", displayName: row.displayName || row.name });
  for (const [messageId, handles] of unmatchedByMessage) {
    const list = byMessage.get(messageId) ?? [];
    for (const handle of handles) {
      const entry = directory.get(handle);
      if (!entry) continue;
      list.push({ type: entry.type, name: handle, displayName: entry.displayName });
    }
    if (list.length > 0) byMessage.set(messageId, list);
  }
  return byMessage;
}

/**
 * Reactions of a page of public messages: emoji and count only. Reactor ids
 * and names are never read on this path. Counts include provider-side
 * reactions from active projections, matching the member read.
 */
async function loadPublicReactions(messageIds: string[]) {
  const byMessage = new Map<string, Array<{ emoji: string; count: number }>>();
  if (messageIds.length === 0) return byMessage;
  const db = getDb();
  const firstAt = sql<string>`min(${messageReactions.createdAt})`;
  const externalFirstAt = sql<string>`min(${externalReactionStates.createdAt})`;
  const [raftRows, externalRows] = await Promise.all([
    db
      .select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji, count: sql<number>`count(*)::int`, firstAt })
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds))
      .groupBy(messageReactions.messageId, messageReactions.emoji)
      .orderBy(firstAt, messageReactions.emoji),
    db
      .select({
        messageId: externalReactionStates.raftMessageId,
        emoji: externalReactionStates.canonicalEmoji,
        count: sql<number>`count(*)::int`,
        firstAt: externalFirstAt,
      })
      .from(externalReactionStates)
      .innerJoin(externalActorProjections, and(
        eq(externalActorProjections.id, externalReactionStates.projectionId),
        eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false),
      ))
      .where(and(
        inArray(externalReactionStates.raftMessageId, messageIds),
        eq(externalReactionStates.present, true),
      ))
      .groupBy(externalReactionStates.raftMessageId, externalReactionStates.canonicalEmoji)
      .orderBy(externalFirstAt, externalReactionStates.canonicalEmoji),
  ]);
  for (const row of [...raftRows, ...externalRows]) {
    const list = byMessage.get(row.messageId) ?? [];
    const existing = list.find((reaction) => reaction.emoji === row.emoji);
    if (existing) existing.count += Number(row.count);
    else list.push({ emoji: row.emoji, count: Number(row.count) });
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/**
 * Anonymous history is an explicit public projection, not the authenticated
 * message DTO. In particular it excludes actor ids, task/action
 * metadata, reactor identities and attachment storage/thumbnail URLs.
 * Attachments (file metadata), mentions (token + display name) and reactions
 * (emoji + count) are projected by the loaders above; widening this response
 * requires an intentional change at this boundary.
 */
// The plan's history window does not apply here: public server pages are the
// one marked exception to it (cindyz, #proj-commercial task #8: "公开服务器页
// 暂时不是问题，不考虑"; services/historyWindow.ts).
/** An agent's avatar on the anonymous projection: its own server-scoped
 *  upload, or a valid client-rendered `pixel:*` key (no URL, no personal
 *  data). Anything else — another server's upload, third-party or signed
 *  URLs, unknown pixel keys — is null. */
function publicAgentAvatarUrl(avatarUrl: string | null, serverId: string): string | null {
  return isStoredServerScopedAvatarUrl(avatarUrl, serverId) || isPublicPixelAvatarUrl(avatarUrl) ? avatarUrl : null;
}

async function listPublicMessages(channelId: string, serverId: string, limit: number, beforeMessageId?: string) {
  const conditions = [eq(messages.channelId, channelId)];
  if (beforeMessageId !== undefined) {
    const [cursor] = await getDb()
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, beforeMessageId), eq(messages.channelId, channelId)))
      .limit(1);
    if (!cursor) return null;
    conditions.push(lt(messages.seq, cursor.seq));
  }
  const rows = await getDb()
    .select({
      id: messages.id,
      senderType: messages.senderType,
      senderName: sql<string>`CASE
        WHEN ${messages.messageType} = 'system' THEN 'System'
        WHEN ${messages.senderType} = 'user' THEN COALESCE(${users.displayName}, ${users.name}, 'Unknown user')
        WHEN ${messages.senderType} = 'agent' THEN COALESCE(${agents.displayName}, ${agents.name}, 'Unknown agent')
        ELSE 'External'
      END`,
      senderHandle: sql<string | null>`CASE
        WHEN ${messages.senderType} = 'user' THEN ${users.name}
        WHEN ${messages.senderType} = 'agent' THEN ${agents.name}
        ELSE NULL
      END`,
      userAvatarUrl: users.avatarUrl,
      userDescription: users.description,
      agentAvatarUrl: agents.avatarUrl,
      agentDescription: agents.description,
      messageType: messages.messageType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, and(
      eq(messages.senderType, "user"),
      sql`${messages.senderId} = ${users.id}::text`,
    ))
    .leftJoin(agents, and(
      eq(messages.senderType, "agent"),
      sql`${messages.senderId} = ${agents.id}::text`,
      eq(agents.serverId, serverId),
    ))
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  const messageIds = rows.map((row) => row.id);
  const [summaries, attachmentsByMessage, mentionsByMessage, reactionsByMessage] = await Promise.all([
    loadPublicThreadPreviews(channelId, serverId, messageIds),
    loadPublicAttachments(messageIds),
    loadPublicMentions(rows, serverId),
    loadPublicReactions(messageIds),
  ]);
  return rows.reverse().map((row) => ({
    id: row.id,
    senderType: row.senderType,
    sender: {
      displayName: row.senderName,
      handle: row.senderHandle,
      // Human uploads are capability URLs served by the public avatar route;
      // a built pixel avatar is only option ids. Historical third-party
      // profile URLs are deliberately not projected.
      avatarUrl: row.senderType === "user"
        ? (isShownUserAvatarUrl(row.userAvatarUrl) ? row.userAvatarUrl : null)
        : row.senderType === "agent"
          ? publicAgentAvatarUrl(row.agentAvatarUrl, serverId)
          : null,
      description: row.senderType === "user"
        ? row.userDescription
        : row.senderType === "agent"
          ? row.agentDescription
          : null,
    },
    messageType: row.messageType,
    content: row.content,
    createdAt: row.createdAt,
    attachments: attachmentsByMessage.get(row.id) ?? [],
    mentions: mentionsByMessage.get(row.id) ?? [],
    reactions: reactionsByMessage.get(row.id) ?? [],
    threadId: summaries[row.id]?.threadChannelId ?? null,
    replyCount: summaries[row.id]?.replyCount ?? 0,
    lastReplyAt: summaries[row.id]?.lastReplyAt ?? null,
    // The newest replies, so the public page can show the same inline preview
    // a member sees instead of a bare count. Nothing new becomes readable: the
    // same replies are served by the public thread endpoint below. Projected
    // like the parent rows: display name only (no sender id, no handle) and
    // avatars through the same rule (stored upload or built pixel avatar;
    // agents also pixel keys).
    latestReplies: (summaries[row.id]?.latestReplies ?? []).map((reply) => ({
      messageId: reply.messageId,
      seq: reply.seq,
      preview: reply.preview,
      senderType: reply.senderType,
      senderName: reply.senderDisplayName,
      senderAvatarUrl: reply.senderType === "user"
        ? (isShownUserAvatarUrl(reply.senderAvatarUrl) ? reply.senderAvatarUrl : null)
        : reply.senderType === "agent"
          ? publicAgentAvatarUrl(reply.senderAvatarUrl, serverId)
          : null,
      createdAt: reply.createdAt,
    })),
  }));
}

async function findPublicThread(slug: string, threadChannelId: string) {
  const [thread] = await getDb()
    .select({
      id: channels.id,
      serverId: channels.serverId,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  if (!thread?.parentMessageId) return null;

  const [parent] = await getDb()
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, thread.parentMessageId))
    .limit(1);
  if (!parent) return null;

  const readableParent = await findAnonymousReadableChannel(slug, parent.channelId);
  if (!readableParent || readableParent.serverId !== thread.serverId) return null;
  return thread;
}

const MAX_PUBLIC_TRANSLATION_BATCH_SIZE = 200;

// POST /api/public/servers/:slug/message-translations:batch — paid public
// translation for anonymous and nonmember visitors. This route intentionally
// carries no auth middleware: authority is the current public projection, not
// membership or login state. app.ts applies a separate IP-only limiter first.
publicServerRouter.post("/servers/:slug/message-translations:batch", async (req, res) => {
  try {
    const targetLanguage = typeof req.body?.targetLanguage === "string"
      ? normalizeTranslationLanguageCode(req.body.targetLanguage)
      : null;
    const mode: TranslationMode | null = req.body?.mode === "auto" || req.body?.mode === "manual"
      ? req.body.mode
      : null;
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id))
      : null;
    if (!targetLanguage || !mode || !messageIds || messageIds.length > MAX_PUBLIC_TRANSLATION_BATCH_SIZE) {
      res.status(400).json({ error: "Invalid public translation request" });
      return;
    }
    const server = await findPubliclyVisibleServer(req.params.slug);
    if (!server?.translationEnabled || !isTranslationProviderConfigured()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const publicGate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: server.id,
      platform: "web",
    });
    if (!publicGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const results = await translatePublicMessagesBatch({
      serverSlug: req.params.slug,
      targetLanguage,
      mode,
      messageIds,
    });
    res.json({ results });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to translate public messages", logPrefix: "Public translation batch error:", err });
  }
});

// GET /api/public/servers/:slug — server card + the channels a stranger may read.
publicServerRouter.get("/servers/:slug", async (req, res) => {
  try {
    const server = await findPubliclyVisibleServer(req.params.slug);
    // 404, not 403: a non-public server must not be distinguishable from one
    // that does not exist, or this endpoint becomes a server-slug oracle.
    if (!server) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const publicGate = await evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: server.id, platform: "web" });
    if (!publicGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const visible = await getDb()
      .select({ id: channels.id, name: channels.name, description: channels.description })
      .from(channels)
      .where(anonymousReadableChannel(server.id))
      .orderBy(channels.name);

    // A visitor id only where it would be kept (flags + the server's analytics
    // switch); never fail the page on it. Then the visitor's country decides
    // whether the page asks first or turns it on by default (cindyz,
    // 2026-10-15). The router's no-store keeps a CDN from serving one
    // visitor's answer to another.
    const visitorIdMode = await publicVisitorIdOffered(req.params.slug).catch(() => false)
      ? publicVisitorIdMode({
        country: req.get("cloudfront-viewer-country"),
        region: req.get("cloudfront-viewer-country-region"),
        gpc: req.get("sec-gpc"),
      })
      : undefined;
    res.json({
      server,
      channels: visible,
      translationAvailable: isTranslationProviderConfigured(),
      visitorIdMode,
    });
  } catch {
    res.status(500).json({ error: "Failed to load public server" });
  }
});

// GET /api/public/servers/:slug/threads/:threadChannelId/messages — replies
// inherit the anonymous-read decision from their ordinary parent channel.
// The thread row alone is never authority: every request rechecks the server
// toggle and the parent's guest-visible ordinary-channel predicate.
publicServerRouter.get("/servers/:slug/threads/:threadChannelId/messages", async (req, res) => {
  try {
    const thread = await findPublicThread(req.params.slug, req.params.threadChannelId);
    if (!thread) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const publicGate = await evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: thread.serverId, platform: "web" });
    if (!publicGate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
    const rawBefore = typeof req.query.beforeMessageId === "string"
      ? req.query.beforeMessageId
      : undefined;
    const beforeMessageId = rawBefore && UUID_RE.test(rawBefore) ? rawBefore : undefined;
    if (rawBefore !== undefined && beforeMessageId === undefined) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const page = await listPublicMessages(thread.id, thread.serverId, limit, beforeMessageId);
    if (!page) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ messages: page });
  } catch {
    res.status(500).json({ error: "Failed to load public thread" });
  }
});

/**
 * Presigned object-storage URLs handed to anonymous readers live one minute,
 * not the member route's five: the redirect itself is `no-store`, but the URL
 * it points at stays valid until expiry even after the server toggle flips.
 */
export const PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS = 60;

/**
 * Authorize one anonymous attachment read. Authority is the message, never
 * the attachment row: the projection must be bound to a message (draft
 * uploads have none), not revoked, and backed by an active object (size, type
 * and key come only from that object; a projection without one is a data
 * error answered as a missing file). That message's channel must then pass the same
 * predicate as the history routes: an anonymously readable ordinary channel,
 * or a thread whose parent message lives in one, on this slug's public server.
 *
 * Deliberately not `resolveReadableAttachmentAuthorityContext`: that resolver
 * is principal-based (and maps joint projections into a requesting server);
 * the anonymous rule is the narrower one spelled out here.
 */
async function findPublicAttachment(slug: string, attachmentId: string) {
  const [row] = await getDb()
    .select({ projection: attachments, object: attachmentObjects, channelId: messages.channelId })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(and(
      eq(attachments.id, attachmentId),
      isNull(attachments.revokedAt),
      isNull(attachments.pendingChannelId),
    ))
    .limit(1);
  if (!row) return null;
  const { object } = row;
  if (object.lifecycleState !== "active") return null;
  const readable = await findAnonymousReadableChannel(slug, row.channelId)
    ?? await findPublicThread(slug, row.channelId);
  if (!readable) return null;
  const filename = normalizeAttachmentFilename(row.projection.filename);
  return {
    serverId: readable.serverId,
    filename,
    mimeType: resolveAttachmentMimeType(filename, object.mimeType),
    sizeBytes: object.sizeBytes,
    storageKey: object.storageKey,
  };
}

// GET /api/public/servers/:slug/attachments/:attachmentId — the bytes behind
// a public message's attachment, for anonymous and nonmember readers. Every
// request reauthorizes (see findPublicAttachment) and answers a uniform 404
// otherwise. Only raster images on the preview allowlist render inline by
// default; a PDF renders inline only when the read-only preview frame asks for
// it with `?disposition=inline` (the member route's opt-in, PDF only here).
// Every other type (HTML, SVG, ...) is a download, and `?download=1` forces a
// download for images and PDFs too. app.ts applies a separate IP-only limiter
// first.
publicServerRouter.get("/servers/:slug/attachments/:attachmentId", async (req, res) => {
  try {
    const attachment = await findPublicAttachment(req.params.slug, req.params.attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const gate = await evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId: attachment.serverId, platform: "web" });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const storage = getStorage();
    if (!storage) {
      res.status(503).json({ error: "File storage is not configured on this server" });
      return;
    }
    const forceDownload = req.query.download === "1";
    const inlineImage = !forceDownload && isPreviewableImageMimeType(attachment.mimeType);
    const inlinePdf = !forceDownload && req.query.disposition === "inline" && isPdfAttachmentMimeType(attachment.mimeType);
    const contentDisposition = inlinePdf
      ? buildAttachmentInlinePreviewContentDisposition(attachment.filename, attachment.mimeType)
      : inlineImage
        ? buildAttachmentContentDisposition(attachment.filename, attachment.mimeType)
        : buildAttachmentDownloadContentDisposition(attachment.filename);
    const contentType = buildAttachmentResponseContentType(attachment.mimeType);
    // The public page (app origin) loads these with <img> from the API origin.
    // Helmet's default `same-origin` CORP makes the browser block that no-cors
    // load, including on the redirect hop, so every authorized response here
    // opts out; the bytes are anonymously readable by construction.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    if (storage.getPresignedUrl && !shouldStreamAttachmentThroughServerForRequest(req)) {
      const presignedUrl = await storage.getPresignedUrl(attachment.storageKey, {
        expiresIn: PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
        responseContentDisposition: contentDisposition,
        responseContentType: contentType,
      });
      res.redirect(302, presignedUrl);
      return;
    }

    const stream = await storage.get(attachment.storageKey);
    res.setHeader("Content-Type", contentType);
    const contentLength = buildAttachmentContentLengthHeader(attachment.sizeBytes);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Content-Disposition", contentDisposition);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (inlinePdf) {
      // Same headers as the member inline preview: Chromium's PDF viewer cannot
      // run under a `sandbox` CSP, so the framed PDF is bounded by
      // frame-ancestors and the cross-origin frame check in the web client.
      res.removeHeader("X-Frame-Options");
      res.setHeader("Content-Security-Policy", buildAttachmentInlinePreviewContentSecurityPolicy());
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Referrer-Policy", "no-referrer");
    } else {
      // Defense in depth if a browser ever renders a non-image response.
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    }
    await streamStorageResponse(stream, res);
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    if (isStorageNotFoundError(err)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to serve public attachment", logPrefix: "Public attachment error:", err });
  }
});

// GET /api/public/servers/:slug/channels/:channelId/messages
publicServerRouter.get("/servers/:slug/channels/:channelId/messages", async (req, res) => {
  try {
    // Re-resolved on every page request, but as one join rather than a server
    // lookup followed by a channel lookup. See property 1 above.
    const channel = await findAnonymousReadableChannel(req.params.slug, req.params.channelId);
    if (!channel) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: channel.serverId,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
    const rawBefore = typeof req.query.beforeMessageId === "string"
      ? req.query.beforeMessageId
      : undefined;
    const beforeMessageId = rawBefore && UUID_RE.test(rawBefore) ? rawBefore : undefined;
    if (rawBefore !== undefined && beforeMessageId === undefined) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rows = await listPublicMessages(channel.id, channel.serverId, limit, beforeMessageId);
    if (!rows) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ messages: rows });
  } catch {
    res.status(500).json({ error: "Failed to load public channel messages" });
  }
});
