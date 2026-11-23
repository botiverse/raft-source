// What the personal (personalProducer.ts) and server (serverProducer.ts)
// exports share about a conversation's messages in an archive: path
// segments, the columns a message line is read from, and the reactions,
// mentions and files of a page of messages (idx_message_reactions_message,
// message_mentions by message, idx_attachments_message). Which messages and
// which files each kind takes, and how a line reads, stay the kind's own.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../../db/index";
import { attachmentObjects, attachments, messageMentions, messageReactions, messages } from "../../db/schema";

/** A path segment: letters, digits, `.`, `_` and `-` kept, the rest `-`, at most 60 characters. */
export function segment(raw: string): string {
  const cleaned = raw.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60);
  return cleaned || "unnamed";
}

export const isoOf = (at: Date | null | undefined): string | null => at ? at.toISOString() : null;

/** The columns of a message line (and its cursor key). */
export const messageArchiveColumns = {
  id: messages.id,
  senderType: messages.senderType,
  senderId: messages.senderId,
  content: messages.content,
  createdAt: messages.createdAt,
  // Postgres keeps microseconds a Date drops: the cursor keeps the exact value.
  createdAtKey: sql<string>`${messages.createdAt}::text`,
  deletedAt: messages.deletedAt,
  threadId: messages.threadId,
  delegatedByAgentId: messages.delegatedByAgentId,
};

export type MessageArchiveRow = {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
  content: string;
  createdAt: Date;
  createdAtKey: string;
  deletedAt: Date | null;
  threadId: string | null;
  delegatedByAgentId: string | null;
};

/** The reactions, mentions and live attachments of these messages, each in a stable order. */
export async function messageExtrasOf(ids: readonly string[]) {
  const db = getDb();
  const [reactions, mentions, files] = await Promise.all([
    db.select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji, reactorType: messageReactions.reactorType, reactorId: messageReactions.reactorId })
      .from(messageReactions).where(inArray(messageReactions.messageId, [...ids]))
      .orderBy(asc(messageReactions.createdAt), asc(messageReactions.emoji)),
    db.select({ messageId: messageMentions.messageId, targetType: messageMentions.targetType, targetId: messageMentions.targetId, handle: messageMentions.handleAtSendTime })
      .from(messageMentions).where(inArray(messageMentions.messageId, [...ids])).orderBy(asc(messageMentions.handleAtSendTime), asc(messageMentions.targetId)),
    db.select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
      uploaderType: attachments.uploaderType,
      uploaderId: attachments.uploaderId,
      mimeType: attachmentObjects.mimeType,
      sizeBytes: attachmentObjects.sizeBytes,
      lifecycleState: attachmentObjects.lifecycleState,
    }).from(attachments)
      .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
      .where(and(inArray(attachments.messageId, [...ids]), isNull(attachments.revokedAt)))
      .orderBy(asc(attachments.messagePosition), asc(attachments.createdAt), asc(attachments.id)),
  ]);
  return { reactions, mentions, files };
}

/** A file a written line names: [attachment id, its path in the archive]. */
export type PendingFile = [string, string];

/**
 * The files the lines of one conversation named, written right after its
 * lines (so a line never names a file the archive doesn't account for):
 * each still stored and still live (its message not retracted, the file not
 * revoked, its object active, the conversation still in view: `inView`)
 * becomes a `file` op at the path the line named; any other is reported
 * missing (manifest.json `missingFiles`). Its path was in a line already, so
 * reporting it tells nothing new.
 */
export async function pendingFileOps(conversationId: string, pending: readonly PendingFile[], inView: boolean): Promise<{ ops: Array<{ type: "file"; path: string; storageKey: string }>; missing: string[] }> {
  if (pending.length === 0) return { ops: [], missing: [] };
  const live = !inView ? [] : await getDb().select({ id: attachments.id, storageKey: attachmentObjects.storageKey }).from(attachments)
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(
      inArray(attachments.id, pending.map(([id]) => id)),
      eq(messages.channelId, conversationId),
      isNull(messages.deletedAt),
      isNull(attachments.revokedAt),
      eq(attachmentObjects.lifecycleState, "active"),
    ));
  const keys = new Map(live.map((row) => [row.id, row.storageKey]));
  const ops: Array<{ type: "file"; path: string; storageKey: string }> = [];
  const missing: string[] = [];
  for (const [id, path] of pending) {
    const storageKey = keys.get(id);
    if (storageKey) ops.push({ type: "file", path, storageKey });
    else missing.push(path);
  }
  return { ops, missing };
}

/** A conversation as first seen by the walk: its folder and name stay these for the whole export (a rename meanwhile changes neither). */
export type SeenConversation = { id: string; type: string; name: string; dir: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isStrings = (value: unknown, length?: number): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === "string") && (length === undefined || value.length === length);
/** A cursor's `conversations` (SeenConversation[]). */
export const isSeenConversations = (value: unknown): value is SeenConversation[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.type === "string" && typeof entry.name === "string" && typeof entry.dir === "string");
/** A cursor's `pending` (PendingFile[]). */
export const isPendingFiles = (value: unknown): value is PendingFile[] => Array.isArray(value) && value.every((entry) => isStrings(entry, 2));

/**
 * channels.json's `exported` of a conversation: `whole`, or `partial` when it
 * left the export's view during the run (made private, joint or deleted, or
 * no longer visible to the requester): what was written before stays, the
 * rest (later messages, its files) is not in the archive.
 */
export type ConversationExported = "whole" | "partial";
