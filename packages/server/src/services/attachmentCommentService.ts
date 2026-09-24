import { createHash } from "node:crypto";
import { makeIsMember, type ServerId } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { eq, inArray, sql, asc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { attachmentCommentRefs, attachments, messages, messageReactions, users, agents } from "../db/schema.js";
import * as channelService from "./channelService.js";
import * as messageService from "./messageService.js";
import { renderAgentCommentScopeLine, renderAnchorLabel } from "./attachmentCommentAnchorLabel.js";
import { normalizeAttachmentFilename } from "../routes/attachments.js";
import { isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "./planService.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import { ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService.js";
import { resolveReadableAttachmentAuthorityContext } from "./attachmentAuthorityService.js";

// Attachment comments — service layer (attachment-comments MVP spec §4).
//
// A comment is a NORMAL message in the attachment's parent-message thread,
// created through the same pipeline as any thread reply (broadcastAndDeliver:
// mentions, thread follows, realtime, agent delivery), plus one narrow ref row
// that scopes it to the attachment. Both the HTTP route (user senders, PR1)
// and the agent transport (PR3) must go through this service so there is a
// single pipeline.
//
// Atomicity note (deviation from spec wording, flagged for review): the ref
// insert cannot share a DB transaction with the message insert because message
// creation goes through broadcastAndDeliver, which performs its own write and
// non-transactional side effects (socket broadcast, agent delivery). The ref
// is inserted immediately after; if that insert fails the comment survives as
// an ordinary unscoped thread reply and the caller receives an error. With
// both rows freshly created, a failure here requires the DB itself to be
// failing mid-request.

// Single length contract for BOTH transports (user route + agent-api route).
export const MAX_COMMENT_LENGTH = 32_000;

// Feature flag gate. It is checked at every user/agent API entry AND in the
// create pipeline so no present or future transport bypasses it.
export async function attachmentCommentsEnabledForServer(
  serverId: string,
  actorUserId?: string | null,
): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
    userId: actorUserId ?? null,
    serverId,
  });
  return evaluation.enabled;
}

export function attachmentCommentsDisabledError(): AttachmentCommentError {
  return new AttachmentCommentError(
    403,
    "attachment_comments_disabled",
    "Attachment comments are not enabled on this server",
  );
}

// Structural anchors (spec §3, enabled for native renderers per cindyz 6/10).
// The discriminator is allowlisted server-side so anchor_type stays a closed
// vocabulary clients can render exhaustively; the payload is shape-checked
// per type. html-region (task #16) = content-coordinate region captured by
// the comment-mode overlay over the sandboxed HTML preview; its numbers
// originate from the untrusted measurement bridge, so they are clamped here
// in addition to the client-side clamping.
export const ANCHOR_TYPES = ["md-section", "lines", "csv-rows", "html-region", "video-timestamp"] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];
const isAnchorType = makeIsMember(ANCHOR_TYPES);
// Anchors carry a short quote + location fields, never document content —
// cap well below message length so refs stay narrow.
export const MAX_ANCHOR_DATA_BYTES = 4_096;

export type CommentAnchor = { type: AnchorType; data: Record<string, unknown> };

function validateAnchor(anchor: unknown): CommentAnchor | null {
  if (anchor === undefined || anchor === null) return null;
  if (typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new AttachmentCommentError(400, "anchor_invalid", "Anchor must be an object");
  }
  const { type, data } = anchor as { type?: unknown; data?: unknown };
  if (!isAnchorType(type)) {
    throw new AttachmentCommentError(
      400,
      "anchor_type_invalid",
      `Anchor type must be one of: ${ANCHOR_TYPES.join(", ")}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new AttachmentCommentError(400, "anchor_invalid", "Anchor data must be an object");
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_ANCHOR_DATA_BYTES) {
    throw new AttachmentCommentError(
      400,
      "anchor_too_large",
      `Anchor data exceeds ${MAX_ANCHOR_DATA_BYTES} bytes`,
    );
  }
  // Per-type payload shape (Dozy review on 3831678a): required fields are
  // enforced AND the stored object is rebuilt from known fields only, so a
  // malformed or padded payload can neither persist nor reach clients as a
  // dead/degraded chip. Validation failure writes nothing.
  const raw = data as Record<string, unknown>;
  const quote = typeof raw.quote === "string" && raw.quote.length > 0 ? raw.quote : undefined;
  if (type === "md-section") {
    const headingId = raw.headingId;
    const headingTitle = raw.headingTitle;
    if (typeof headingId !== "string" || headingId.length === 0
      || typeof headingTitle !== "string" || headingTitle.length === 0) {
      throw new AttachmentCommentError(
        400,
        "anchor_invalid",
        "md-section anchor requires non-empty string headingId and headingTitle",
      );
    }
    return { type, data: { headingId, headingTitle, ...(quote ? { quote } : {}) } };
  }
  if (type === "html-region") {
    // Content-coordinate region in CSS px. All values come from the untrusted
    // bridge: require finite, non-negative, and clamp to a sane ceiling so a
    // hostile document cannot persist absurd geometry.
    const MAX_COORD = 10_000_000;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const x = num(raw.x);
    const y = num(raw.y);
    const w = num(raw.w);
    const h = num(raw.h);
    const viewportWidth = num(raw.viewportWidth);
    const documentWidth = num(raw.documentWidth);
    const documentHeight = num(raw.documentHeight);
    if (
      x === null || y === null || w === null || h === null
      || x < 0 || y < 0 || w < 0 || h < 0
      || viewportWidth === null || viewportWidth <= 0
      || documentWidth === null || documentWidth <= 0
      || documentHeight === null || documentHeight <= 0
    ) {
      throw new AttachmentCommentError(
        400,
        "anchor_invalid",
        "html-region anchor requires finite non-negative x/y/w/h and positive viewportWidth/documentWidth/documentHeight",
      );
    }
    const clamp = (v: number) => Math.min(Math.round(v), MAX_COORD);
    return {
      type,
      data: {
        x: clamp(x),
        y: clamp(y),
        w: clamp(w),
        h: clamp(h),
        viewportWidth: clamp(viewportWidth),
        documentWidth: clamp(documentWidth),
        documentHeight: clamp(documentHeight),
        ...(quote ? { quote } : {}),
      },
    };
  }
  if (type === "video-timestamp") {
    const time = raw.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
      throw new AttachmentCommentError(
        400,
        "anchor_invalid",
        "video-timestamp anchor requires a finite non-negative time in seconds",
      );
    }
    return { type, data: { time: Math.round(time * 1000) / 1000 } };
  }
  // lines | csv-rows: 1-based integer range, start <= end.
  const start = raw.start;
  const end = raw.end;
  if (
    typeof start !== "number" || !Number.isInteger(start) || start < 1
    || typeof end !== "number" || !Number.isInteger(end) || end < start
  ) {
    throw new AttachmentCommentError(
      400,
      "anchor_invalid",
      `${type} anchor requires integer start >= 1 and end >= start`,
    );
  }
  return { type, data: { start, end, ...(quote ? { quote } : {}) } };
}

export class AttachmentCommentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function createAttachmentComment(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  opts: {
    attachmentId: string;
    serverId: string;
    senderType: "user" | "agent";
    senderId: string;
    senderName: string;
    content: string;
    // Optional structural anchor; validated against the closed type
    // vocabulary + per-type payload cap before anything is written.
    anchor?: unknown;
    // Picker-confirmed mentions, ALREADY validated by the route (the wire
    // parser lives in routes/messages.ts and is shared by both transports).
    mentions?: messageService.StructuredMentionInput[];
    // Transport-supplied authorization, called once the parent channel is
    // resolved (routes own WHO may post; this service owns the mechanics).
    // Implementations throw AttachmentCommentError to deny.
    authorize: (parentChannelId: string) => Promise<void>;
  },
): Promise<{ message: Record<string, unknown>; threadChannelId: string }> {
  const db = getDb();

  // Feature flag gate dominates everything: outside enabled scope the feature
  // does not exist, regardless of sender type/state.
  if (!(await attachmentCommentsEnabledForServer(opts.serverId, opts.senderType === "user" ? opts.senderId : null))) {
    throw attachmentCommentsDisabledError();
  }

  // Product descope (spec v3.5, cindyz 6/10): agents do not CREATE comments
  // for now — they read scoped lists and reply in-thread as ordinary
  // discussion. Gated here, not per-transport, so every present and future
  // transport inherits the rule. Re-enabling = deleting this block.
  if (opts.senderType === "agent") {
    throw new AttachmentCommentError(
      403,
      "agent_comment_create_disabled",
      "Agents cannot create attachment comments; reply in the thread instead",
    );
  }

  const anchor = validateAnchor(opts.anchor);

  // Content contract enforced here so no transport can bypass it.
  if (typeof opts.content !== "string" || opts.content.trim().length === 0) {
    throw new AttachmentCommentError(400, "comment_empty", "Comment content cannot be empty");
  }
  if (opts.content.length > MAX_COMMENT_LENGTH) {
    throw new AttachmentCommentError(
      400,
      "comment_too_long",
      `Comment exceeds maximum length of ${MAX_COMMENT_LENGTH} characters`,
    );
  }

  const [attachment] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, opts.attachmentId))
    .limit(1);
  if (!attachment) {
    throw new AttachmentCommentError(404, "attachment_not_found", "Attachment not found");
  }
  if (attachment.objectId) {
    const readable = await resolveReadableAttachmentAuthorityContext({
      projectionId: attachment.id,
      requestServerId: opts.serverId as ServerId,
      principal: { type: opts.senderType, id: opts.senderId },
    });
    if (!readable) {
      throw new AttachmentCommentError(404, "attachment_not_found", "Attachment not found");
    }
  }

  // Server-scope boundary FIRST (before any state-revealing branch): a
  // cross-server attachment UUID must be indistinguishable from a nonexistent
  // one, matching the existing attachment routes. The attachment's own
  // channelId is the anchor here because unlinked attachments have no message.
  const attachmentChannel = await channelService.getChannel(attachment.channelId);
  if (!attachmentChannel || attachmentChannel.serverId !== opts.serverId) {
    throw new AttachmentCommentError(404, "attachment_not_found", "Attachment not found");
  }

  // v0 scope rule (spec §2.4): only message-linked attachments accept comments.
  if (!attachment.messageId) {
    throw new AttachmentCommentError(
      422,
      "attachment_not_linked",
      "Attachment is not linked to a message yet; comments require a sent message",
    );
  }

  const [parentMessage] = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, attachment.messageId))
    .limit(1);
  if (!parentMessage) {
    throw new AttachmentCommentError(404, "parent_message_not_found", "Parent message not found");
  }

  const parentChannel = await channelService.getChannel(parentMessage.channelId);
  if (!parentChannel || parentChannel.serverId !== opts.serverId) {
    throw new AttachmentCommentError(404, "attachment_not_found", "Attachment not found");
  }
  if (parentChannel.archivedAt) {
    throw new AttachmentCommentError(409, "channel_archived", "This channel is archived");
  }
  if (await isChannelReadOnlyByBillingFeature(parentMessage.channelId, opts.serverId)) {
    throw new AttachmentCommentError(
      403,
      "channel_read_only",
      "Joint Channels require the Pro plan. Upgrade to continue.",
    );
  }
  // Plan gates live in the shared pipeline so user and agent transports cannot
  // diverge (PR3 review parity gate).
  if (await isChannelReadOnlyByQuota(parentMessage.channelId, opts.serverId)) {
    throw new AttachmentCommentError(
      403,
      "channel_read_only",
      "This channel is read-only on your current plan. Upgrade to continue.",
    );
  }

  await opts.authorize(parentMessage.channelId);

  // Review conversation resolution (spec v3.4, "attachment host message"):
  // - host on a normal channel message -> the host message's thread
  //   (created on first comment);
  // - host on a THREAD REPLY -> the existing thread itself. There is no
  //   thread-in-thread in Slock; calling getOrCreateThreadForChannel on a
  //   thread-hosted message would attempt exactly that.
  const reviewChannelId = parentChannel.type === "thread"
    ? parentChannel.id
    : (await channelService.getOrCreateThreadForChannel(
        parentMessage.channelId,
        parentMessage.id,
        opts.senderId,
        opts.senderType,
      )).id;

  // slack-bridge-ordinary-message-producer: attachment_comment.text
  const enriched = await messageService.broadcastAndDeliver(io, agentOrchestrator, {
    channelId: reviewChannelId,
    senderType: opts.senderType,
    senderId: opts.senderId,
    senderName: opts.senderName,
    content: opts.content,
    mentions: opts.mentions,
    // Agents receive this comment as an ordinary thread message — without a
    // scope line they cannot tell WHAT it annotates (task #37, huxijin). The
    // anchor is passed directly because the ref row is inserted only after
    // delivery (honest two-step, §3) — first delivery must not lose scope.
    agentContentPrefix: renderAgentCommentScopeLine(
      normalizeAttachmentFilename(attachment.filename),
      anchor?.type ?? null,
      anchor?.data ?? null,
    ),
  });

  const commentMessageId = (enriched as { id?: string }).id;
  if (!commentMessageId) {
    throw new AttachmentCommentError(500, "comment_create_failed", "Failed to create comment message");
  }

  try {
    await db.insert(attachmentCommentRefs).values({
      commentMessageId,
      attachmentId: attachment.id,
      anchorType: anchor?.type ?? null,
      anchorData: anchor?.data ?? null,
    });
  } catch (err) {
    // The message exists as an ordinary thread reply; only the scope failed.
    throw new AttachmentCommentError(
      500,
      "comment_scope_failed",
      "Comment was posted to the thread but could not be scoped to the attachment",
    );
  }

  // The ref row now exists but shared channel-room updates cannot carry
  // viewer-scoped metadata: user-deny rules are per viewer, while this socket
  // payload is shared by every subscriber in the room.
  const isThreadHosted = parentChannel.type === "thread";
  let hostSource: Record<string, unknown> | null;
  if (isThreadHosted) {
    const threadParentMsgId = parentChannel.parentMessageId;
    if (threadParentMsgId) {
      const [threadParentMsg] = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(eq(messages.id, threadParentMsgId))
        .limit(1);
      const threadParentChannel = threadParentMsg
        ? await channelService.getChannel(threadParentMsg.channelId)
        : null;
      hostSource = threadParentChannel
        ? {
            type: "thread",
            routeKind: threadParentChannel.type === "dm" ? "dm" : "channel",
            channelId: threadParentChannel.id,
            parentMessageId: threadParentMsgId,
            threadChannelId: parentChannel.id,
          }
        : null;
    } else {
      hostSource = null;
    }
  } else {
    hostSource = {
      type: "channel",
      routeKind: parentChannel.type === "dm" ? "dm" : "channel",
      channelId: parentChannel.id,
      rootThreadChannelId: reviewChannelId,
    };
  }

  const anchorData = anchor?.data as Record<string, unknown> | null | undefined;
  const rawQuote = anchorData && typeof anchorData.quote === "string" ? anchorData.quote.trim() : null;
  const commentRef = {
    attachmentId: attachment.id,
    filename: normalizeAttachmentFilename(attachment.filename),
    hostMessageId: attachment.messageId,
    hostSource,
    anchorLabel: renderAnchorLabel(anchor?.type ?? null, anchor?.data ?? null),
    anchorQuote: rawQuote || null,
  };

  // message-realtime-producer: attachment-comment.privacy-scrub
  io.to(`channel:${reviewChannelId}`).emit(
    "message:updated",
    messageService.stripViewerScopedAttachmentCommentMetadata({
      id: commentMessageId,
      channelId: reviewChannelId,
      commentRef,
    }),
  );

  return { message: { ...(enriched as Record<string, unknown>), commentRef }, threadChannelId: reviewChannelId };
}

export async function listAttachmentComments(
  attachmentId: string,
  opts: { limit?: number } = {},
): Promise<{
  comments: Array<Record<string, unknown> & { reactions: Array<{ emoji: string; reactorType: string; reactorId: string; createdAt: Date }> }>;
  threadChannelId: string | null;
}> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

  const rows = await db
    .select({
      message: messages,
      anchorType: attachmentCommentRefs.anchorType,
      anchorData: attachmentCommentRefs.anchorData,
    })
    .from(attachmentCommentRefs)
    .innerJoin(messages, eq(attachmentCommentRefs.commentMessageId, messages.id))
    .where(eq(attachmentCommentRefs.attachmentId, attachmentId))
    .orderBy(asc(messages.seq))
    .limit(limit);

  const commentMessages = rows.map((r) => r.message);
  const anchorByMessage = new Map(
    rows
      .filter((r) => r.anchorType)
      .map((r) => [r.message.id, { type: r.anchorType as string, data: r.anchorData ?? {} }]),
  );
  const threadChannelId = commentMessages.length > 0 ? commentMessages[0].channelId : null;

  // Sender display names + avatar identity so the panel renders author rows
  // like a thread (Figma-list presentation, cindyz 6/11).
  const nameMap = new Map<string, string>();
  const avatarMap = new Map<string, { avatarUrl: string | null; gravatarHash: string | null }>();
  const userIds = [...new Set(commentMessages.filter((m) => m.senderType === "user").map((m) => m.senderId))];
  const agentIds = [...new Set(commentMessages.filter((m) => m.senderType === "agent").map((m) => m.senderId))];
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName, avatarUrl: users.avatarUrl, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of rows) {
      nameMap.set(u.id, u.displayName || u.name);
      avatarMap.set(u.id, {
        avatarUrl: u.avatarUrl ?? null,
        gravatarHash: u.email ? createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex") : null,
      });
    }
  }
  if (agentIds.length > 0) {
    const rows = await db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName, avatarUrl: agents.avatarUrl })
      .from(agents)
      .where(inArray(agents.id, agentIds));
    for (const a of rows) {
      nameMap.set(a.id, a.displayName || a.name);
      avatarMap.set(a.id, { avatarUrl: a.avatarUrl ?? null, gravatarHash: null });
    }
  }

  const ids = commentMessages.map((m) => m.id);
  const reactionRows = ids.length
    ? await db
        .select({
          messageId: messageReactions.messageId,
          emoji: messageReactions.emoji,
          reactorType: messageReactions.reactorType,
          reactorId: messageReactions.reactorId,
          createdAt: messageReactions.createdAt,
        })
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, ids))
    : [];
  const reactionsByMessage = new Map<string, Array<{ emoji: string; reactorType: string; reactorId: string; createdAt: Date }>>();
  for (const r of reactionRows) {
    const list = reactionsByMessage.get(r.messageId) ?? [];
    list.push({ emoji: r.emoji, reactorType: r.reactorType, reactorId: r.reactorId, createdAt: r.createdAt });
    reactionsByMessage.set(r.messageId, list);
  }

  return {
    comments: commentMessages.map((m) => ({
      ...m,
      senderName: nameMap.get(m.senderId) ?? "Unknown",
      senderAvatarUrl: avatarMap.get(m.senderId)?.avatarUrl ?? null,
      senderGravatarHash: avatarMap.get(m.senderId)?.gravatarHash ?? null,
      reactions: reactionsByMessage.get(m.id) ?? [],
      anchor: anchorByMessage.get(m.id) ?? null,
    })),
    threadChannelId,
  };
}

// §5 resolve rule (server-side mirror of the frontend isResolved). Resolved
// iff ✅ from comment author OR parent-message author; if parent-message
// author is an agent, a ✅ from any human also counts.
type ParentMessageInfo = { senderId: string; senderType: string };
type ReactionWithTime = { emoji: string; reactorType: string; reactorId: string; createdAt: Date };

function findResolvingReaction(
  reactions: ReactionWithTime[],
  commentSenderId: string,
  parentMessage: ParentMessageInfo,
): ReactionWithTime | null {
  return reactions.find((r) => {
    if (r.emoji !== "✅") return false;
    if (r.reactorId === commentSenderId) return true;
    if (r.reactorId === parentMessage.senderId) return true;
    if (parentMessage.senderType === "agent" && r.reactorType === "user") return true;
    return false;
  }) ?? null;
}

export function enrichCommentsWithResolveStatus(
  comments: Array<Record<string, unknown> & { senderId: string; reactions: ReactionWithTime[] }>,
  parentMessage: ParentMessageInfo,
): Array<Record<string, unknown> & { resolved: boolean; resolvedBy: { reactorId: string; reactorType: string } | null; resolvedAt: string | null }> {
  return comments.map((c) => {
    const resolving = findResolvingReaction(c.reactions, c.senderId as string, parentMessage);
    return {
      ...c,
      resolved: !!resolving,
      resolvedBy: resolving ? { reactorId: resolving.reactorId, reactorType: resolving.reactorType } : null,
      resolvedAt: resolving ? resolving.createdAt.toISOString() : null,
    };
  });
}

export async function getAttachmentCommentCounts(
  attachmentIds: string[],
): Promise<Record<string, number>> {
  if (attachmentIds.length === 0) return {};
  const db = getDb();
  const rows = await db
    .select({
      attachmentId: attachmentCommentRefs.attachmentId,
      count: sql<number>`count(*)::int`,
    })
    .from(attachmentCommentRefs)
    .where(inArray(attachmentCommentRefs.attachmentId, attachmentIds))
    .groupBy(attachmentCommentRefs.attachmentId);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.attachmentId] = row.count;
  return out;
}
