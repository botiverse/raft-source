// The server export's producer (#triage:#512 design §5, §7;
// docs/development/data-export.md): a server's public channels, for its
// owner. The archive:
//
//   conversations/<name>-<id>/<YYYY-MM>.jsonl     one message per line, a conversation's months
//                                                 in order (threads and task conversations of a
//                                                 public channel are conversations of their own)
//   channels.json                                 the conversations above (type, name, parent)
//   users.json                                    who wrote them: id, display name, type (person
//                                                 or agent); never an email or a role
//   files/<attachment id>-<name>                  the files of those messages (includeFiles);
//                                                 their metadata is in the lines either way
//   manifest.json                                 (the runner's) plus `rules` and `historyFrom`
//
// What: the chat messages of the server's public channels (decision 1: no
// private channel, no DM; decision 6: no joint channel, nor one with an active
// joint projection mid-conversion), their threads and
// task conversations, as the requester (an owner) sees them, every batch
// again: a channel made private (or joint, or deleted) since the request is
// left out from the next batch on. Up to the request; on the free plan only
// inside its history window (decision 3; the plan's window as of the
// request, getServerHistoryWindow), with `fullHistoryAfterClose` (a closed
// server, before its purge) the whole history. A retracted message is a
// placeholder only (no text, mentions or files), as in the personal export.
// Not included (v3): member lists, emails, app data, audit records, agent activity.
//
// The cursor walks the public conversations in id order, each one's messages
// seeking on (created_at, id) within the conversation
// (idx_messages_channel_created_at), each one's files (includeFiles) right
// after its lines: exactly those its lines named, any no longer live listed in
// missingFiles; then channels.json and users.json from what the walk
// collected. A conversation's folder and name are fixed when the walk first
// writes it (a rename during the run moves nothing). Repeatable: a batch read
// again from its cursor writes the same ops.
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { JsonValue, ServerDataExportSummary, ServerId } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { agents, attachmentObjects, attachments, channels, jointChannelServers, messages, servers, users } from "../../db/schema";
import { getServerHistoryWindow } from "../planService";
import { visibleConversationSql, visibleRootChannelIds } from "../visibilityService";
import type { VisibleRoots } from "../visibilityService";
import { canExportServer, serverExportAccessOf } from "./jobs";
import { isoOf, isPendingFiles, isSeenConversations, isStrings, messageArchiveColumns, messageExtrasOf, pendingFileOps, segment } from "./messageArchive";
import type { ConversationExported, MessageArchiveRow, PendingFile, SeenConversation } from "./messageArchive";
import type { DataExportBatch, DataExportJob, DataExportOp, DataExportProducer } from "./producer";

/** Messages per batch. */
export const SERVER_EXPORT_MESSAGE_BATCH = 500;
/** Files per batch (each is streamed from storage). */
export const SERVER_EXPORT_FILE_BATCH = 50;
/** Conversations one batch looks into at most (many hold nothing inside the window). */
export const SERVER_EXPORT_CONVERSATIONS_PER_BATCH = 200;
/** The summary counts messages and files up to this many each (a bounded read). */
export const SERVER_EXPORT_SUMMARY_CAP = 100_000;

/** What the archive holds, in manifest.json. */
export const SERVER_EXPORT_RULES = {
  messages: "The chat messages of the server's public channels, their threads and task conversations, as the owner who asked saw them, up to when they asked. On the free plan only the plan's history window; after the server closed, with fullHistoryAfterClose, all of it. Retracted messages are a placeholder only.",
  notIncluded: "Private channels, direct messages, channels shared with other servers, member lists and emails, app data (tasks, Artifacts, reminders), audit records, agent activity.",
  users: "Only the people and agents who wrote the exported messages: id, display name, and whether a person or an agent.",
  files: "Metadata of every file of those messages; with includeFiles the files themselves, except those no longer stored (listed in missingFiles).",
} as const;

type Job = DataExportJob<"server">;

type Progress = {
  /** The conversations that had messages exported, in walk (id) order, as first seen (folder, name). */
  conversations: SeenConversation[];
  /** Who wrote them: `user:<id>`, `agent:<id>`, `external_projection:<id>`, sorted. */
  authors: string[];
};

export type ServerExportCursor =
  /**
   * The messages: from conversation `conversation` (null: the first), after [created_at as text, id]
   * there; `pending`: the files its lines written so far named (includeFiles).
   */
  | (Progress & { phase: "messages"; conversation: string | null; after: [string, string] | null; pending: PendingFile[] })
  /** The files the lines of `conversation` named, written after its lines; then the messages of `then` (null: the summary). */
  | (Progress & { phase: "files"; conversation: string; pending: PendingFile[]; then: string | null })
  | (Progress & { phase: "summary" });

export interface ServerProducerDeps {
  /** Tests: smaller batches. */
  messageBatch?: number;
  fileBatch?: number;
  conversationsPerBatch?: number;
}

interface Limits { messageBatch: number; fileBatch: number; conversationsPerBatch: number }

/** What one batch reads: the server, its public conversations as the requester sees them now, the window. */
interface View {
  server: { id: string; slug: string; name: string };
  /** The public roots only: no private channel, DM or joint, no parentless thread. */
  roots: VisibleRoots;
  /** Messages created after this; undefined: all history. */
  cutoff: Date | undefined;
}

/**
 * The public roots the requester sees in the server now (visibilityService), and nothing else:
 * not a channel that already has an active joint projection (one being converted into a channel
 * shared with other servers keeps `type: "channel"` until the conversion's cutover), so no joint
 * conversation is exported (decision 6). A disconnected projection doesn't exclude it.
 */
async function publicRoots(serverId: ServerId, requesterUserId: string): Promise<VisibleRoots> {
  const seen = await visibleRootChannelIds({ type: "user", id: requesterUserId, serverId });
  const candidates = seen.roots.filter((root) => root.type === "channel");
  const projected = candidates.length === 0 ? new Set<string>() : new Set((await getDb().select({ id: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(and(inArray(jointChannelServers.localChannelId, candidates.map((root) => root.id)), eq(jointChannelServers.status, "active")))).map((row) => row.id));
  return { serverId, roots: candidates.filter((root) => !projected.has(root.id)), parentlessThreadIds: [], jointStorageByLocalId: new Map() };
}

/** The free plan's window as of `at`, or none (paid, or the full history of a closed server). */
async function cutoffOf(serverId: string, fullHistory: boolean, at: Date): Promise<Date | undefined> {
  return fullHistory ? undefined : (await getServerHistoryWindow(serverId, at)).cutoff;
}

async function viewOf(job: Job): Promise<View> {
  const serverId = job.serverId!;
  const [server] = await getDb().select({ id: servers.id, slug: servers.slug, name: servers.name }).from(servers).where(eq(servers.id, serverId));
  if (!server) throw new Error("DATA_EXPORT_SERVER_MISSING");
  const [roots, cutoff] = await Promise.all([
    publicRoots(serverId, job.requesterUserId),
    cutoffOf(serverId, job.scope.fullHistoryAfterClose, job.createdAt),
  ]);
  return { server, roots, cutoff };
}

/** A conversation row of the view: a public channel, or a thread or task conversation under one. */
function inView(view: View) {
  return and(
    visibleConversationSql(view.roots, channels.id, channels.parentChannelId),
    eq(channels.serverId, view.server.id),
    inArray(channels.type, ["channel", "thread", "task"]),
    isNull(channels.deletedAt),
  )!;
}

type ConversationRow = { id: string; type: string; name: string; parentChannelId: string | null; parentMessageId: string | null; archivedAt: Date | null };
const conversationColumns = { id: channels.id, type: channels.type, name: channels.name, parentChannelId: channels.parentChannelId, parentMessageId: channels.parentMessageId, archivedAt: channels.archivedAt };

/** The view's conversations from `from` on (inclusive), in id order. */
function conversationsFrom(view: View, from: string | null, limit: number): Promise<ConversationRow[]> {
  return getDb().select(conversationColumns).from(channels)
    .where(and(inView(view), from ? sql`${channels.id} >= ${from}::uuid` : undefined))
    .orderBy(asc(channels.id))
    .limit(limit);
}

/** A thread's or task's name is internal: the type names it. */
function conversationOf(view: View, row: ConversationRow) {
  const sub = row.type === "thread" || row.type === "task";
  const root = view.roots.roots.find((candidate) => candidate.id === row.id);
  const name = sub ? row.type : root?.name ?? row.name;
  return { id: row.id, dir: `${segment(name)}-${row.id}`, type: row.type, name, parentConversationId: sub ? row.parentChannelId : null, parentMessageId: row.parentMessageId };
}

/** Which messages the export takes: chat, up to the request, inside the window. */
function exported(job: Job, view: View) {
  return and(
    lte(messages.createdAt, job.createdAt),
    eq(messages.messageType, "chat"),
    view.cutoff ? gt(messages.createdAt, view.cutoff) : undefined,
  );
}

const filePath = (file: { id: string; filename: string }) => `files/${file.id}-${segment(file.filename)}`;

/** Each message's line, and the files it names (includeFiles): written after the conversation's lines. */
async function messageLines(job: Job, conversationId: string, rows: MessageArchiveRow[]): Promise<Array<{ line: JsonValue; files: PendingFile[] }>> {
  const { reactions, mentions, files } = await messageExtrasOf(rows.map((row) => row.id));
  return rows.map((row) => {
    const retracted = row.deletedAt !== null;
    const live = retracted ? [] : files.filter((file) => file.messageId === row.id && file.lifecycleState === "active");
    const byEmoji = new Map<string, { emoji: string; count: number }>();
    for (const reaction of reactions) {
      if (reaction.messageId !== row.id) continue;
      const entry = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0 };
      entry.count += 1;
      byEmoji.set(reaction.emoji, entry);
    }
    const line = {
      id: row.id,
      conversationId,
      createdAt: row.createdAt.toISOString(),
      authorType: row.senderType === "external_projection" ? "external" : row.senderType,
      authorId: row.senderId,
      ...(row.delegatedByAgentId ? { sentByAssistantId: row.delegatedByAgentId } : {}),
      retracted,
      // Retraction can be a moderator's removal and the stored text may survive it: the placeholder only.
      content: retracted ? null : row.content,
      threadConversationId: row.threadId,
      reactions: [...byEmoji.values()],
      mentions: retracted ? [] : mentions.filter((mention) => mention.messageId === row.id).map((mention) => ({ type: mention.targetType, id: mention.targetId, handle: mention.handle })),
      attachments: live.map((file) => ({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        file: job.scope.includeFiles ? filePath(file) : null,
      })),
    };
    return { line, files: job.scope.includeFiles ? live.map((file): PendingFile => [file.id, filePath(file)]) : [] };
  });
}

const mergeSorted = (into: readonly string[], more: Iterable<string>): string[] => [...new Set([...into, ...more])].sort();

async function messagesBatch(job: Job, view: View, cursor: Extract<ServerExportCursor, { phase: "messages" }>, limits: Limits): Promise<DataExportBatch<ServerExportCursor>> {
  const conversations = await conversationsFrom(view, cursor.conversation, limits.conversationsPerBatch + 1);
  // The conversation being written left the view: the files its lines named are not written, and listed.
  if (cursor.pending.length > 0 && conversations[0]?.id !== cursor.conversation) {
    return { ops: [], next: { ...cursor, pending: [] }, missingFiles: cursor.pending.map(([, path]) => path) };
  }
  const ops: DataExportOp[] = [];
  const seen = [...cursor.conversations];
  // By id, built once a batch from the cursor's list (which keeps the walk order).
  const seenById = new Map(seen.map((entry) => [entry.id, entry]));
  const authors = new Set<string>();
  let budget = limits.messageBatch;
  let written = 0;
  const progress = (): Progress => ({ conversations: seen, authors: mergeSorted(cursor.authors, authors) });
  const batched = conversations.slice(0, limits.conversationsPerBatch);
  for (const [i, conversation] of batched.entries()) {
    const continuing = conversation.id === cursor.conversation;
    const after = continuing ? cursor.after : null;
    const pending: PendingFile[] = continuing ? [...cursor.pending] : [];
    const rows = await getDb().select(messageArchiveColumns).from(messages)
      .where(and(
        eq(messages.channelId, conversation.id),
        exported(job, view),
        after ? sql`(${messages.createdAt}, ${messages.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(budget);
    if (rows.length > 0) {
      // Its folder and name as first seen: a rename later in the run moves nothing.
      let known = seenById.get(conversation.id);
      if (!known) {
        const fresh = conversationOf(view, conversation);
        known = { id: conversation.id, type: fresh.type, name: fresh.name, dir: fresh.dir };
        seen.push(known);
        seenById.set(known.id, known);
      }
      const lines = await messageLines(job, conversation.id, rows);
      const dir = `conversations/${known.dir}`;
      rows.forEach((row, n) => {
        const line = lines[n]!;
        const path = `${dir}/${row.createdAt.toISOString().slice(0, 7)}.jsonl`;
        const last = ops[ops.length - 1];
        if (last?.type === "lines" && last.path === path) last.lines.push(line.line);
        else ops.push({ type: "lines", path, lines: [line.line] });
        pending.push(...line.files);
        authors.add(`${row.senderType}:${row.senderId}`);
      });
      written += rows.length;
      budget -= rows.length;
    }
    if (budget === 0) {
      const last = rows[rows.length - 1]!;
      return { ops, next: { ...progress(), phase: "messages", conversation: conversation.id, after: [last.createdAtKey, last.id], pending }, counts: { messages: written } };
    }
    // This conversation's lines are all written: its files next, before another conversation's lines.
    if (pending.length > 0) {
      return { ops, next: { ...progress(), phase: "files", conversation: conversation.id, pending, then: conversations[i + 1]?.id ?? null }, counts: { messages: written } };
    }
  }
  const more = conversations[limits.conversationsPerBatch];
  const next: ServerExportCursor = more ? { ...progress(), phase: "messages", conversation: more.id, after: null, pending: [] } : { ...progress(), phase: "summary" };
  return { ops, next, counts: { messages: written } };
}

/** The files the lines of one conversation named, `fileBatch` at a time; then back to the messages. */
async function filesBatch(view: View, cursor: Extract<ServerExportCursor, { phase: "files" }>, limits: Limits): Promise<DataExportBatch<ServerExportCursor>> {
  const now = cursor.pending.slice(0, limits.fileBatch);
  const rest = cursor.pending.slice(limits.fileBatch);
  const [still] = await getDb().select({ id: channels.id }).from(channels).where(and(inView(view), eq(channels.id, cursor.conversation)));
  const { ops, missing } = await pendingFileOps(cursor.conversation, now, still !== undefined);
  const progress: Progress = { conversations: cursor.conversations, authors: cursor.authors };
  const next: ServerExportCursor = rest.length > 0
    ? { ...progress, phase: "files", conversation: cursor.conversation, pending: rest, then: cursor.then }
    : cursor.then ? { ...progress, phase: "messages", conversation: cursor.then, after: null, pending: [] } : { ...progress, phase: "summary" };
  return { ops, next, missingFiles: missing };
}

function manifestOf(view: View): Record<string, JsonValue> {
  return { rules: SERVER_EXPORT_RULES, historyFrom: isoOf(view.cutoff) };
}

async function summaryBatch(view: View, cursor: Extract<ServerExportCursor, { phase: "summary" }>): Promise<DataExportBatch<ServerExportCursor>> {
  const db = getDb();
  const ids = cursor.conversations.map((entry) => entry.id);
  const rows = new Map<string, ConversationRow>();
  const stillInView = new Set<string>();
  for (let at = 0; at < ids.length; at += 500) {
    const chunk = ids.slice(at, at + 500);
    for (const row of await db.select(conversationColumns).from(channels).where(inArray(channels.id, chunk))) rows.set(row.id, row);
    for (const row of await db.select({ id: channels.id }).from(channels).where(and(inView(view), inArray(channels.id, chunk)))) stillInView.add(row.id);
  }
  const authors = cursor.authors.map((key) => {
    const colon = key.indexOf(":");
    return { type: key.slice(0, colon), id: key.slice(colon + 1) };
  });
  const userIds = authors.filter((author) => author.type === "user").map((author) => author.id);
  const agentIds = authors.filter((author) => author.type === "agent").map((author) => author.id);
  const [people, bots] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.name, displayName: users.displayName }).from(users).where(inArray(users.id, userIds)) : [],
    agentIds.length ? db.select({ id: agents.id, name: agents.name, displayName: agents.displayName }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  const names = new Map<string, string>();
  for (const row of [...people, ...bots]) names.set(row.id, row.displayName || row.name);
  const ops: DataExportOp[] = [
    {
      type: "json",
      path: "channels.json",
      value: {
        server: { id: view.server.id, name: view.server.name, slug: view.server.slug },
        historyFrom: isoOf(view.cutoff),
        // As first seen (name, folder); a conversation that left the view during the run is `partial`.
        conversations: [...cursor.conversations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((seen) => {
          const row = rows.get(seen.id);
          const sub = seen.type === "thread" || seen.type === "task";
          const exported: ConversationExported = stillInView.has(seen.id) ? "whole" : "partial";
          return {
            id: seen.id,
            type: seen.type,
            name: seen.name,
            parentConversationId: sub ? row?.parentChannelId ?? null : null,
            parentMessageId: row?.parentMessageId ?? null,
            archived: row ? row.archivedAt !== null : false,
            exported,
            path: `conversations/${seen.dir}/`,
          };
        }),
      },
    },
    {
      type: "json",
      path: "users.json",
      // Only what reading the messages needs (design §5): no email, no role, no membership.
      value: authors.map((author) => ({
        id: author.id,
        type: author.type === "external_projection" ? "external" : author.type,
        displayName: names.get(author.id) ?? null,
      })),
    },
  ];
  return { ops, next: null, manifest: manifestOf(view) };
}

function isCursor(raw: JsonValue): raw is ServerExportCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (!isSeenConversations(raw.conversations) || !isStrings(raw.authors)) return false;
  switch (raw.phase) {
    case "messages": return (raw.conversation === null || typeof raw.conversation === "string") && (raw.after === null || isStrings(raw.after, 2)) && isPendingFiles(raw.pending);
    case "files": return typeof raw.conversation === "string" && isPendingFiles(raw.pending) && (raw.then === null || typeof raw.then === "string");
    case "summary": return true;
    default: return false;
  }
}

/**
 * What an export of this server would hold now, for the request dialog
 * (design §5 "导出范围的摘要"): the public channels, and the messages and
 * files inside the window, each counted up to SERVER_EXPORT_SUMMARY_CAP.
 * A closed server's is its full history (the only export it accepts).
 */
export async function serverExportSummary(input: { serverId: ServerId; requesterUserId: string; fullHistory: boolean; now: Date }): Promise<ServerDataExportSummary> {
  const db = getDb();
  const [roots, cutoff] = await Promise.all([
    publicRoots(input.serverId, input.requesterUserId),
    cutoffOf(input.serverId, input.fullHistory, input.now),
  ]);
  const view: View = { server: { id: input.serverId, slug: "", name: "" }, roots, cutoff };
  const conversationIds = db.select({ id: channels.id }).from(channels).where(inView(view));
  const inWindow = and(
    inArray(messages.channelId, conversationIds),
    lte(messages.createdAt, input.now),
    eq(messages.messageType, "chat"),
    cutoff ? gt(messages.createdAt, cutoff) : undefined,
  );
  const cap = SERVER_EXPORT_SUMMARY_CAP;
  const counted = db.select({ one: sql`1` }).from(messages).where(inWindow).limit(cap + 1).as("counted");
  const filed = db.select({ sizeBytes: attachmentObjects.sizeBytes }).from(messages)
    .innerJoin(attachments, eq(attachments.messageId, messages.id))
    .innerJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
    .where(and(inWindow, isNull(messages.deletedAt), isNull(attachments.revokedAt), eq(attachmentObjects.lifecycleState, "active")))
    .limit(cap + 1)
    .as("filed");
  const [[messageCount], [fileCount]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(counted),
    db.select({ n: sql<number>`count(*)::int`, bytes: sql<string>`coalesce(sum(${filed.sizeBytes}), 0)::text` }).from(filed),
  ]);
  const messagesN = messageCount?.n ?? 0;
  const filesN = fileCount?.n ?? 0;
  return {
    publicChannels: roots.roots.length,
    messages: Math.min(messagesN, cap),
    messagesCapped: messagesN > cap,
    files: Math.min(filesN, cap),
    fileBytes: Number(fileCount?.bytes ?? 0),
    filesCapped: filesN > cap,
    historyFrom: isoOf(cutoff),
  };
}

export function createServerDataExportProducer(deps: ServerProducerDeps = {}): DataExportProducer<"server", ServerExportCursor> {
  const limits: Limits = {
    messageBatch: deps.messageBatch ?? SERVER_EXPORT_MESSAGE_BATCH,
    fileBatch: deps.fileBatch ?? SERVER_EXPORT_FILE_BATCH,
    conversationsPerBatch: deps.conversationsPerBatch ?? SERVER_EXPORT_CONVERSATIONS_PER_BATCH,
  };
  return {
    kind: "server",

    // The framework parsed the scope and checked the close rule; nothing of the producer's own to narrow.
    async validateScope({ scope }) {
      return { ok: true, scope };
    },

    // At the request, before every batch and at every download: the requester's account is live
    // and they still hold exportServerData there (an owner; not after the purge began). The runner
    // and the routes check exportServerData too; this keeps the producer's answer whole on its own.
    async authorize(job) {
      const [user] = await getDb().select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, job.requesterUserId));
      if (!user || user.retiredAt) return { ok: false, code: "data_export_account_inactive", error: "This account is no longer active." };
      if (!job.serverId || !canExportServer(await serverExportAccessOf(job.serverId, job.requesterUserId))) {
        return { ok: false, code: "data_export_owner_only", error: "Only the server's owner can export its data." };
      }
      return { ok: true };
    },

    initialCursor: () => ({ phase: "messages", conversations: [], authors: [], conversation: null, after: null, pending: [] }),

    decodeCursor(raw) {
      if (!isCursor(raw)) throw new Error("DATA_EXPORT_SERVER_CURSOR_INVALID");
      return raw;
    },

    async nextBatch(job, cursor) {
      const view = await viewOf(job);
      switch (cursor.phase) {
        case "messages": return messagesBatch(job, view, cursor, limits);
        case "files": return filesBatch(view, cursor, limits);
        case "summary": return summaryBatch(view, cursor);
      }
    },
  };
}

/** The process's server producer (server.ts registers it). */
export const serverDataExportProducer = createServerDataExportProducer();
