// The personal export's producer (#triage:#512 design §4, §7;
// docs/development/data-export.md): a person's own data in the servers they
// chose. The archive:
//
//   account.json                                  the account, its preferences, sign-in methods
//                                                 (never a secret), accepted terms, and the
//                                                 membership of each server in scope
//   servers/<slug>-<id>/conversations/<name>-<id>/<YYYY-MM>.jsonl
//                                                 one message per line, a conversation's
//                                                 months in order (threads and task
//                                                 conversations are conversations of their own)
//   servers/<slug>-<id>/channels.json             the conversations above (type, name, parent)
//   servers/<slug>-<id>/users.json                who wrote them (id, name, person or agent)
//   servers/<slug>-<id>/files/<id>-<name>         the person's own uploads (includeFiles)
//   manifest.json                                 (the runner's) plus `rules` (what was
//                                                 exported) and `servers`: each server in
//                                                 scope, exported, partial or skipped and why
//
// What is the person's: the chat messages they sent (delegated ones too) in
// the conversations they can still see (visibilityService, as the person,
// every batch again: a guest only their channel; a joint channel through
// its canonical storage), up to the moment they asked. Messages they sent
// in a conversation they no longer see (a private channel they left) are not
// exported in v0 (decision D1, flagged for humans). Not cut by the free
// plan's 30 days (decision 3). Context (decision 2): the other messages of
// those conversations, only where the server's owner allows it
// (serverSettings.ts, read every batch), inside the plan's history window, no
// retracted ones and no one else's files. Not included (v3): app data,
// audit records, agent activity, member lists.
//
// A server the person left (or that closed) since asking is skipped (or,
// once some of it was written, partial), and the manifest says so; the
// export goes on with the others.
//
// The cursor walks the servers in scope in order. For each: its visible
// conversations in id order, each one's messages seeking on (created_at, id)
// within the conversation (idx_messages_channel_created_at), so no batch
// sorts more than one conversation's rows; then channels.json and
// users.json, from what the walk collected; then the files of the
// conversations that had messages. Repeatable: a batch read again from its
// cursor writes the same ops.
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { asServerId, DATA_EXPORT_MAX_SCOPE_SERVERS } from "@botiverse/raft-shared";
import type { JsonValue, PersonalDataExportScope } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import {
  agents,
  attachmentObjects,
  attachments,
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  ssoIdentities,
  userAuthIdentities,
  userLegalAcceptances,
  userNotificationSettings,
  users,
} from "../../db/schema";
import { getServerHistoryWindow } from "../planService";
import { uuidArray, visibleConversationSql, visibleRootChannelIds } from "../visibilityService";
import type { VisibleRoots } from "../visibilityService";
import { contextAllowedServerIds as ownerAllowsContext } from "./serverSettings";
import { isoOf, isPendingFiles, isSeenConversations, isStrings, messageArchiveColumns, messageExtrasOf, pendingFileOps, segment } from "./messageArchive";
import type { ConversationExported, MessageArchiveRow, PendingFile, SeenConversation } from "./messageArchive";
import type { DataExportBatch, DataExportJob, DataExportOp, DataExportProducer } from "./producer";

/** Messages per batch. */
export const PERSONAL_EXPORT_MESSAGE_BATCH = 500;
/** Files per batch (each is streamed from storage). */
export const PERSONAL_EXPORT_FILE_BATCH = 50;
/** Conversations one batch looks into at most (most hold none of the person's messages). */
export const PERSONAL_EXPORT_CONVERSATIONS_PER_BATCH = 200;

/** What the archive holds, in manifest.json (decision D1: only conversations still visible). */
export const PERSONAL_EXPORT_RULES = {
  ownMessages: "The chat messages you sent in the conversations you can still see, up to when you asked. Messages in conversations you no longer see (a private channel you left, a server you left) are not included.",
  context: "Other people's messages in those conversations, only where the server's owner allows it, inside the server plan's history window; never retracted ones or their files.",
  files: "With includeFiles: the files you uploaded to those messages that are still available.",
  notIncluded: "App data (tasks, Artifacts, reminders), audit records, agent activity, member lists.",
} as const;

type Job = DataExportJob<"personal">;

type Skip = "not_a_member" | "closed";
/** A server in scope, as the manifest reports it. */
type ServerOutcome =
  /**
   * `contextIncluded`: some batch of it held others' messages; `contextPartial`: the owner's switch
   * changed while it was written (read every batch), so only some of it did.
   */
  | { serverId: string; status: "exported"; contextIncluded: boolean; contextPartial?: true }
  /** Left (or closed) while it was being written: what was written stays, the rest is missing. */
  | { serverId: string; status: "partial"; reason: Skip }
  | { serverId: string; status: "skipped"; reason: Skip };

type ServerProgress = {
  step: "server";
  /** The servers in scope, sorted, as read at the first batch. */
  servers: string[];
  /** The server being written (servers.length: all done, the last batch). */
  index: number;
  outcomes: ServerOutcome[];
  /**
   * This server's conversations that had messages exported, in walk (id) order, as first seen:
   * `id` the storage id (a joint's canonical channel), `localId` the server's own, folder and name fixed then.
   */
  conversations: PersonalSeen[];
  /** Who wrote them: `user:<id>`, `agent:<id>`, `external_projection:<id>`, sorted. */
  authors: string[];
  /** Whether this server's message batches ran with context, and without (the owner's switch is read every batch). */
  context: { on: boolean; off: boolean };
};

type PersonalSeen = SeenConversation & { localId: string };

export type PersonalExportCursor =
  /** Nothing written yet: the servers are read and account.json written. */
  | { step: "account" }
  /**
   * The messages: from conversation `conversation` (null: the first), after [created_at as text, id]
   * there; `pending`: the person's files its lines written so far named (includeFiles).
   */
  | (ServerProgress & { phase: "messages"; conversation: string | null; after: [string, string] | null; pending: PendingFile[] })
  /** The files the lines of `conversation` named, written after its lines; then the messages of `then` (null: the summary). */
  | (ServerProgress & { phase: "files"; conversation: string; pending: PendingFile[]; then: string | null })
  | (ServerProgress & { phase: "summary" });

type ServerCursor = Exclude<PersonalExportCursor, { step: "account" }>;

export interface PersonalProducerDeps {
  /**
   * The servers among these whose owner allows members to export context
   * (design §4 "Owner 的开关", default off): servers.member_context_export_enabled
   * (serverSettings.ts), read at the request and at every batch. Tests may pass their own.
   */
  contextAllowedServerIds?: (serverIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Tests: smaller batches. */
  messageBatch?: number;
  fileBatch?: number;
  conversationsPerBatch?: number;
}

interface Limits { messageBatch: number; fileBatch: number; conversationsPerBatch: number }

/** A server the person is a member of now: its row and their membership. Null when not (or a joint's storage). */
async function membershipOf(userId: string, serverId: string) {
  const [row] = await getDb().select({
    id: servers.id,
    name: servers.name,
    slug: servers.slug,
    deletedAt: servers.deletedAt,
    role: serverMembers.role,
    joinedAt: serverMembers.joinedAt,
  }).from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.userId, userId), eq(serverMembers.serverId, serverId), ne(servers.kind, "joint_storage")));
  return row ?? null;
}

/** The servers a person may name: theirs, open, not a joint's storage. */
export async function memberServerIds(userId: string): Promise<string[]> {
  const rows = await getDb().select({ id: servers.id }).from(serverMembers)
    .innerJoin(servers, eq(servers.id, serverMembers.serverId))
    .where(and(eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)));
  return rows.map((row) => row.id).sort();
}

const serverDir = (server: { slug: string; id: string }) => `servers/${segment(server.slug)}-${server.id}`;

const asPerson = (job: Job, serverId: string) => visibleRootChannelIds({ type: "user", id: job.requesterUserId, serverId: asServerId(serverId) });

/** What one server's batches read: who looks, what they see, which messages are theirs to export. */
interface ServerView {
  server: { id: string; slug: string; name: string };
  roots: VisibleRoots;
  /** Local id of a joint root by its canonical storage id. */
  localByStorage: Map<string, string>;
  /** Which messages of a conversation this export takes (the messages table). */
  authorship: SQL;
  contextIncluded: boolean;
}

async function serverView(job: Job, server: { id: string; slug: string; name: string }, contextAllowed: boolean): Promise<ServerView> {
  const me = job.requesterUserId;
  const roots = await asPerson(job, server.id);
  const localByStorage = new Map<string, string>();
  for (const root of roots.roots) {
    const storage = root.type === "joint" ? roots.jointStorageByLocalId.get(root.id) : undefined;
    if (storage) localByStorage.set(storage, root.id);
  }
  const own = and(eq(messages.senderType, "user"), eq(messages.senderId, me))!;
  let authorship: SQL = own;
  const contextIncluded = job.scope.includeContext && contextAllowed;
  if (contextIncluded) {
    // Others' messages: inside the plan's history window (created after the cutoff, as
    // historyWindow.ts), never a retracted one. The plan is the server's plan now: plans keep
    // no history, so a server that changed plan since the request uses its new window.
    const { cutoff } = await getServerHistoryWindow(server.id, job.createdAt);
    authorship = or(own, and(isNull(messages.deletedAt), cutoff ? gt(messages.createdAt, cutoff) : undefined))!;
  }
  return { server, roots, localByStorage, authorship, contextIncluded };
}

type ConversationRow = { id: string; type: string; name: string; parentChannelId: string | null; parentMessageId: string | null; archivedAt: Date | null };

/**
 * The person's visible conversations from `from` on (inclusive), in id order:
 * the visible roots (a joint's canonical storage, not its local projection,
 * which holds no messages), their threads and task conversations, and
 * parentless threads (visibleConversationSql: a BitmapOr of the primary key
 * and idx_channels_parent_channel).
 */
async function conversationsFrom(view: ServerView, from: string | null, limit?: number): Promise<ConversationRow[]> {
  const projections = [...view.roots.jointStorageByLocalId.keys()];
  const query = getDb().select({ id: channels.id, type: channels.type, name: channels.name, parentChannelId: channels.parentChannelId, parentMessageId: channels.parentMessageId, archivedAt: channels.archivedAt })
    .from(channels)
    .where(and(
      visibleConversationSql(view.roots, channels.id, channels.parentChannelId),
      isNull(channels.deletedAt),
      projections.length > 0 ? sql`NOT (${channels.id} = ANY(${uuidArray(projections)}))` : undefined,
      from ? sql`${channels.id} >= ${from}::uuid` : undefined,
    ))
    .orderBy(asc(channels.id));
  return limit === undefined ? query : query.limit(limit);
}

function conversationOf(view: ServerView, row: ConversationRow): { id: string; dir: string; type: string; name: string; parentConversationId: string | null; parentMessageId: string | null } {
  const id = view.localByStorage.get(row.id) ?? row.id;
  const root = view.roots.roots.find((candidate) => candidate.id === id);
  const sub = row.type === "thread" || row.type === "task";
  const type = root?.type ?? row.type;
  // DM, thread and task names are internal: the type names them.
  const name = root && root.type !== "dm" ? root.name : type;
  const parent = row.parentChannelId ? view.localByStorage.get(row.parentChannelId) ?? row.parentChannelId : null;
  return { id, dir: `${segment(name)}-${id}`, type, name, parentConversationId: sub ? parent : null, parentMessageId: row.parentMessageId };
}

async function accountBatch(job: Job): Promise<DataExportBatch<PersonalExportCursor>> {
  const me = job.requesterUserId;
  const db = getDb();
  const scopeIds = job.scope.serverIds === "all" ? await memberServerIds(me) : [...job.scope.serverIds].sort();
  const [user] = await db.select().from(users).where(eq(users.id, me));
  if (!user) throw new Error("DATA_EXPORT_REQUESTER_MISSING");
  const [identities, sso, legal, notifications] = await Promise.all([
    db.select({ provider: userAuthIdentities.provider, email: userAuthIdentities.providerEmail, linkedAt: userAuthIdentities.createdAt })
      .from(userAuthIdentities).where(eq(userAuthIdentities.userId, me)).orderBy(asc(userAuthIdentities.provider)),
    db.select({ connectionId: ssoIdentities.connectionId, email: ssoIdentities.emailAtLink, linkedAt: ssoIdentities.createdAt, lastLoginAt: ssoIdentities.lastLoginAt })
      .from(ssoIdentities).where(eq(ssoIdentities.userId, me)).orderBy(asc(ssoIdentities.createdAt)),
    db.select({ termsVersion: userLegalAcceptances.termsVersion, privacyVersion: userLegalAcceptances.privacyVersion, source: userLegalAcceptances.source, acceptedAt: userLegalAcceptances.acceptedAt })
      .from(userLegalAcceptances).where(eq(userLegalAcceptances.userId, me)).orderBy(asc(userLegalAcceptances.acceptedAt)),
    db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, me)),
  ]);
  const memberships: JsonValue[] = [];
  for (const serverId of scopeIds) {
    const membership = await membershipOf(me, serverId);
    if (!membership || membership.deletedAt) continue;
    // The channels they joined that they still see (a guest's other memberships, say, are not theirs to see).
    const visible = new Set((await asPerson(job, serverId)).roots.map((root) => root.id));
    const joined = await db.select({ id: channels.id, type: channels.type, name: channels.name, joinedAt: channelHumans.joinedAt })
      .from(channelHumans)
      .innerJoin(channels, eq(channels.id, channelHumans.channelId))
      .where(and(eq(channelHumans.userId, me), eq(channels.serverId, serverId), isNull(channels.deletedAt), inArray(channels.type, ["channel", "private", "joint", "dm"])))
      .orderBy(asc(channels.name), asc(channels.id));
    memberships.push({
      serverId,
      name: membership.name,
      slug: membership.slug,
      role: membership.role,
      joinedAt: isoOf(membership.joinedAt),
      channels: joined.filter((channel) => visible.has(channel.id))
        .map((channel) => ({ id: channel.id, type: channel.type, name: channel.type === "dm" ? "dm" : channel.name, joinedAt: isoOf(channel.joinedAt) })),
    });
  }
  const notification = notifications[0];
  const account: JsonValue = {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    handle: user.name,
    displayName: user.displayName,
    description: user.description,
    avatarUrl: user.avatarUrl,
    createdAt: isoOf(user.createdAt),
    preferences: {
      displayLanguage: user.displayLanguage,
      translationLanguage: user.preferredLanguage,
      timezone: user.preferredTimezone,
      translationMode: user.preferredTranslationMode,
      translationDisplay: user.preferredTranslationDisplay,
      timeFormat: user.preferredTimeFormat,
      messageBodyFontSize: user.preferredMessageBodyFontSize,
      composerSendKey: user.composerSendKey,
      shareUsageData: user.shareUsageData,
      productAnalyticsOptedOutAt: isoOf(user.analyticsOptedOutAt),
      notifications: notification ? {
        pausedUntil: isoOf(notification.pausedUntil),
        quietHoursEnabled: notification.quietHoursEnabled,
        quietStartMinute: notification.quietStartMinute,
        quietEndMinute: notification.quietEndMinute,
        timeZone: notification.timeZone,
        previewMode: notification.previewMode,
        soundEnabled: notification.soundEnabled,
        mobileDelay: notification.mobileDelay,
        followedThreadReplies: notification.followedThreadReplies,
      } : null,
    },
    // Which ways in exist, never their secrets (password hashes, keys, tokens).
    signIn: {
      password: user.passwordCredentialEstablishedAt !== null,
      twoStepVerificationSince: isoOf(user.secondFactorRequiredAt),
      connectedAccounts: identities.map((identity) => ({ provider: identity.provider, email: identity.email, linkedAt: isoOf(identity.linkedAt) })),
      sso: sso.map((identity) => ({ connectionId: identity.connectionId, email: identity.email, linkedAt: isoOf(identity.linkedAt), lastSignInAt: isoOf(identity.lastLoginAt) })),
    },
    acceptedTerms: legal.map((row) => ({ termsVersion: row.termsVersion, privacyVersion: row.privacyVersion, source: row.source, acceptedAt: isoOf(row.acceptedAt) })),
    memberships,
  };
  return {
    ops: [{ type: "json", path: "account.json", value: account }],
    next: { step: "server", servers: scopeIds, index: 0, outcomes: [], conversations: [], authors: [], context: { on: false, off: false }, phase: "messages", conversation: null, after: null, pending: [] },
  };
}

/** Each message's line, and the person's own files it names (includeFiles): written after the conversation's lines. */
async function messageLines(job: Job, view: ServerView, localId: string, rows: MessageArchiveRow[]): Promise<Array<{ line: JsonValue; files: PendingFile[] }>> {
  const me = job.requesterUserId;
  const { reactions, mentions, files } = await messageExtrasOf(rows.map((row) => row.id));
  return rows.map((row) => {
    const mine = row.senderType === "user" && row.senderId === me;
    const retracted = row.deletedAt !== null;
    const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const reaction of reactions) {
      if (reaction.messageId !== row.id) continue;
      const entry = byEmoji.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
      entry.count += 1;
      if (reaction.reactorType === "user" && reaction.reactorId === me) entry.mine = true;
      byEmoji.set(reaction.emoji, entry);
    }
    const live = retracted ? [] : files.filter((file) => file.messageId === row.id && file.lifecycleState === "active");
    const own = job.scope.includeFiles ? live.filter((file) => isOwnUpload(file, me)) : [];
    const line = {
      id: row.id,
      conversationId: localId,
      createdAt: row.createdAt.toISOString(),
      authorType: row.senderType === "external_projection" ? "external" : row.senderType,
      authorId: row.senderId,
      mine,
      ...(row.delegatedByAgentId ? { sentByAssistantId: row.delegatedByAgentId } : {}),
      retracted,
      // Retraction can be a moderator's removal and the stored text may survive it: the
      // placeholder only, no body, no files.
      content: retracted ? null : row.content,
      // A thread's parent message: the thread conversation hanging off it.
      threadConversationId: row.threadId ? view.localByStorage.get(row.threadId) ?? row.threadId : null,
      reactions: [...byEmoji.values()],
      // A retracted message keeps only its placeholder: no mentions of who it named.
      mentions: retracted ? [] : mentions.filter((mention) => mention.messageId === row.id).map((mention) => ({ type: mention.targetType, id: mention.targetId, handle: mention.handle })),
      attachments: live.map((file) => ({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        // In the archive only when asked for and the person's own upload.
        file: own.includes(file) ? filePath(view, file) : null,
      })),
    };
    return { line, files: own.map((file): PendingFile => [file.id, filePath(view, file)]) };
  });
}

const isOwnUpload = (file: { uploaderType: string; uploaderId: string }, me: string) => file.uploaderType === "user" && file.uploaderId === me;
const filePath = (view: ServerView, file: { id: string; filename: string }) => `${serverDir(view.server)}/files/${file.id}-${segment(file.filename)}`;

/** The messages of this export in one conversation, after `after`: a seek on idx_messages_channel_created_at. */
function conversationMessages(job: Job, view: ServerView, conversationId: string, after: [string, string] | null, limit: number): Promise<MessageArchiveRow[]> {
  return getDb().select(messageArchiveColumns).from(messages)
    .where(and(
      eq(messages.channelId, conversationId),
      lte(messages.createdAt, job.createdAt),
      eq(messages.messageType, "chat"),
      view.authorship,
      after ? sql`(${messages.createdAt}, ${messages.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
    ))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit);
}

const mergeSorted = (into: readonly string[], more: Iterable<string>): string[] => [...new Set([...into, ...more])].sort();

async function messagesBatch(job: Job, view: ServerView, cursor: Extract<ServerCursor, { phase: "messages" }>, limits: Limits): Promise<DataExportBatch<PersonalExportCursor>> {
  const conversations = await conversationsFrom(view, cursor.conversation, limits.conversationsPerBatch + 1);
  // The conversation being written is no longer one the person sees: the files its lines named are listed, not written.
  if (cursor.pending.length > 0 && conversations[0]?.id !== cursor.conversation) {
    return { ops: [], next: { ...cursor, pending: [] }, missingFiles: cursor.pending.map(([, path]) => path) };
  }
  const ops: DataExportOp[] = [];
  const seen = [...cursor.conversations];
  // By id, built once a batch from the cursor's list (which keeps the walk order).
  const seenById = new Map(seen.map((entry) => [entry.id, entry]));
  const authors = new Set<string>();
  let budget = limits.messageBatch;
  let own = 0;
  let written = 0;
  // Whether this batch read with context (the owner's switch, read every batch).
  const context = job.scope.includeContext ? { on: cursor.context.on || view.contextIncluded, off: cursor.context.off || !view.contextIncluded } : cursor.context;
  const progress = (): ServerProgress => ({ ...progressOf(cursor), conversations: seen, authors: mergeSorted(cursor.authors, authors), context });
  const counts = () => ({ messages: own, contextMessages: written - own });
  const batched = conversations.slice(0, limits.conversationsPerBatch);
  for (const [i, conversation] of batched.entries()) {
    const continuing = conversation.id === cursor.conversation;
    const after = continuing ? cursor.after : null;
    const pending: PendingFile[] = continuing ? [...cursor.pending] : [];
    const rows = await conversationMessages(job, view, conversation.id, after, budget);
    if (rows.length > 0) {
      // Its folder and name as first seen: a rename later in the run moves nothing.
      let known = seenById.get(conversation.id);
      if (!known) {
        const fresh = conversationOf(view, conversation);
        known = { id: conversation.id, localId: fresh.id, type: fresh.type, name: fresh.name, dir: fresh.dir };
        seen.push(known);
        seenById.set(known.id, known);
      }
      const lines = await messageLines(job, view, known.localId, rows);
      const dir = `${serverDir(view.server)}/conversations/${known.dir}`;
      rows.forEach((row, n) => {
        const line = lines[n]!;
        const path = `${dir}/${row.createdAt.toISOString().slice(0, 7)}.jsonl`;
        const last = ops[ops.length - 1];
        if (last?.type === "lines" && last.path === path) last.lines.push(line.line);
        else ops.push({ type: "lines", path, lines: [line.line] });
        pending.push(...line.files);
        authors.add(`${row.senderType}:${row.senderId}`);
        if (row.senderType === "user" && row.senderId === job.requesterUserId) own += 1;
      });
      written += rows.length;
      budget -= rows.length;
    }
    if (budget === 0) {
      const last = rows[rows.length - 1]!;
      return { ops, next: { ...progress(), phase: "messages", conversation: conversation.id, after: [last.createdAtKey, last.id], pending }, counts: counts() };
    }
    // This conversation's lines are all written: its files next, before another conversation's lines.
    if (pending.length > 0) {
      return { ops, next: { ...progress(), phase: "files", conversation: conversation.id, pending, then: conversations[i + 1]?.id ?? null }, counts: counts() };
    }
  }
  const more = conversations[limits.conversationsPerBatch];
  const next: PersonalExportCursor = more ? { ...progress(), phase: "messages", conversation: more.id, after: null, pending: [] } : { ...progress(), phase: "summary" };
  return { ops, next, counts: counts() };
}

/** The server's progress without the phase's own fields. */
function progressOf(cursor: ServerProgress): ServerProgress {
  return { step: "server", servers: cursor.servers, index: cursor.index, outcomes: cursor.outcomes, conversations: cursor.conversations, authors: cursor.authors, context: cursor.context };
}

/** The person's files the lines of one conversation named, `fileBatch` at a time; then back to the messages. */
async function filesBatch(view: ServerView, cursor: Extract<ServerCursor, { phase: "files" }>, limits: Limits): Promise<DataExportBatch<PersonalExportCursor>> {
  const now = cursor.pending.slice(0, limits.fileBatch);
  const rest = cursor.pending.slice(limits.fileBatch);
  const stillSeen = (await visibleAmong(view, [cursor.conversation])).has(cursor.conversation);
  const { ops, missing } = await pendingFileOps(cursor.conversation, now, stillSeen);
  const next: PersonalExportCursor = rest.length > 0
    ? { ...progressOf(cursor), phase: "files", conversation: cursor.conversation, pending: rest, then: cursor.then }
    : cursor.then ? { ...progressOf(cursor), phase: "messages", conversation: cursor.then, after: null, pending: [] } : { ...progressOf(cursor), phase: "summary" };
  return { ops, next, missingFiles: missing };
}

/** Which of these conversations (storage ids) the person still sees. */
async function visibleAmong(view: ServerView, ids: readonly string[]): Promise<Set<string>> {
  const visible = new Set<string>();
  for (let at = 0; at < ids.length; at += 500) {
    const rows = await getDb().select({ id: channels.id }).from(channels)
      .where(and(visibleConversationSql(view.roots, channels.id, channels.parentChannelId), isNull(channels.deletedAt), inArray(channels.id, ids.slice(at, at + 500))));
    for (const row of rows) visible.add(row.id);
  }
  return visible;
}

async function summaryBatch(view: ServerView, cursor: Extract<ServerCursor, { phase: "summary" }>): Promise<DataExportBatch<PersonalExportCursor>> {
  const db = getDb();
  const ids = cursor.conversations.map((entry) => entry.id);
  const rows = new Map<string, ConversationRow>();
  for (let at = 0; at < ids.length; at += 500) {
    for (const row of await db.select({ id: channels.id, type: channels.type, name: channels.name, parentChannelId: channels.parentChannelId, parentMessageId: channels.parentMessageId, archivedAt: channels.archivedAt })
      .from(channels).where(inArray(channels.id, ids.slice(at, at + 500)))) rows.set(row.id, row);
  }
  const stillSeen = await visibleAmong(view, ids);
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
  const names = new Map<string, { handle: string; displayName: string | null }>();
  for (const row of [...people, ...bots]) names.set(row.id, { handle: row.name, displayName: row.displayName });
  const dir = serverDir(view.server);
  const ops: DataExportOp[] = [
    {
      type: "json",
      path: `${dir}/channels.json`,
      value: {
        server: { id: view.server.id, name: view.server.name, slug: view.server.slug },
        contextIncluded: cursor.context.on,
        // As first seen (name, folder); a conversation that left the person's view during the run is `partial`.
        conversations: [...cursor.conversations].sort((a, b) => (a.localId < b.localId ? -1 : a.localId > b.localId ? 1 : 0)).map((seen) => {
          const row = rows.get(seen.id);
          const sub = seen.type === "thread" || seen.type === "task";
          const parent = row?.parentChannelId ? view.localByStorage.get(row.parentChannelId) ?? row.parentChannelId : null;
          const exported: ConversationExported = stillSeen.has(seen.id) ? "whole" : "partial";
          return {
            id: seen.localId,
            type: seen.type,
            name: seen.name,
            parentConversationId: sub ? parent : null,
            parentMessageId: row?.parentMessageId ?? null,
            archived: row ? row.archivedAt !== null : false,
            exported,
            path: `${dir}/conversations/${seen.dir}/`,
          };
        }),
      },
    },
    {
      type: "json",
      path: `${dir}/users.json`,
      value: authors.map((author) => ({
        id: author.id,
        type: author.type === "external_projection" ? "external" : author.type,
        handle: names.get(author.id)?.handle ?? null,
        displayName: names.get(author.id)?.displayName ?? null,
      })),
    },
  ];
  return { ops, next: nextServer(cursor) };
}

function nextServer(cursor: ServerCursor, lost?: Skip): PersonalExportCursor {
  const serverId = cursor.servers[cursor.index]!;
  // Anything of it written already: partial, not skipped.
  const started = cursor.conversations.length > 0;
  const outcome: ServerOutcome = lost
    ? { serverId, status: started ? "partial" : "skipped", reason: lost }
    : { serverId, status: "exported", contextIncluded: cursor.context.on, ...(cursor.context.on && cursor.context.off ? { contextPartial: true as const } : {}) };
  return { step: "server", servers: cursor.servers, index: cursor.index + 1, outcomes: [...cursor.outcomes, outcome], conversations: [], authors: [], context: { on: false, off: false }, phase: "messages", conversation: null, after: null, pending: [] };
}

const isContext = (value: unknown): value is { on: boolean; off: boolean } =>
  typeof value === "object" && value !== null && typeof (value as { on?: unknown }).on === "boolean" && typeof (value as { off?: unknown }).off === "boolean";

function isCursor(raw: JsonValue): raw is PersonalExportCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (raw.step === "account") return Object.keys(raw).length === 1;
  if (raw.step !== "server" || !isStrings(raw.servers) || !isSeenConversations(raw.conversations) || !isStrings(raw.authors) || !Array.isArray(raw.outcomes) || !isContext(raw.context)) return false;
  if (!(raw.conversations as unknown[]).every((entry) => typeof (entry as { localId?: unknown }).localId === "string")) return false;
  if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > raw.servers.length) return false;
  switch (raw.phase) {
    case "messages": return (raw.conversation === null || typeof raw.conversation === "string") && (raw.after === null || isStrings(raw.after, 2)) && isPendingFiles(raw.pending);
    case "files": return typeof raw.conversation === "string" && isPendingFiles(raw.pending) && (raw.then === null || typeof raw.then === "string");
    case "summary": return true;
    default: return false;
  }
}

export function createPersonalDataExportProducer(deps: PersonalProducerDeps = {}): DataExportProducer<"personal", PersonalExportCursor> {
  const contextAllowedServerIds = deps.contextAllowedServerIds ?? ownerAllowsContext;
  const limits: Limits = {
    messageBatch: deps.messageBatch ?? PERSONAL_EXPORT_MESSAGE_BATCH,
    fileBatch: deps.fileBatch ?? PERSONAL_EXPORT_FILE_BATCH,
    conversationsPerBatch: deps.conversationsPerBatch ?? PERSONAL_EXPORT_CONVERSATIONS_PER_BATCH,
  };
  return {
    kind: "personal",

    async validateScope({ requesterUserId, scope }) {
      const own = await memberServerIds(requesterUserId);
      const named = scope.serverIds === "all" ? own : scope.serverIds;
      if (scope.serverIds !== "all" && named.some((id) => !own.includes(id))) {
        return { ok: false, status: 404, code: "data_export_server_not_found", error: "One of those servers was not found, or you are not a member of it." };
      }
      if (scope.includeContext && (await contextAllowedServerIds(named)).size === 0) {
        return { ok: false, status: 400, code: "data_export_context_not_allowed", error: "None of those servers lets members export other people's messages." };
      }
      // "all" is the servers the person is in when asking; past the scope's limit (or none) it is read at the first batch.
      const resolved: PersonalDataExportScope = scope.serverIds === "all" && own.length > 0 && own.length <= DATA_EXPORT_MAX_SCOPE_SERVERS
        ? { ...scope, serverIds: own }
        : scope;
      return { ok: true, scope: resolved };
    },

    // The person's own data: theirs as long as the account is live. Which
    // servers and conversations they still see is each batch's (skipped,
    // never failed: the rest is still theirs).
    async authorize(job) {
      const [user] = await getDb().select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, job.requesterUserId));
      return user && !user.retiredAt ? { ok: true } : { ok: false, code: "data_export_account_inactive", error: "This account is no longer active." };
    },

    initialCursor: () => ({ step: "account" }),

    decodeCursor(raw) {
      if (!isCursor(raw)) throw new Error("DATA_EXPORT_PERSONAL_CURSOR_INVALID");
      return raw;
    },

    async nextBatch(job, cursor) {
      if (cursor.step === "account") return accountBatch(job);
      if (cursor.index >= cursor.servers.length) {
        return { ops: [], next: null, manifest: { rules: PERSONAL_EXPORT_RULES, servers: cursor.outcomes } };
      }
      const serverId = cursor.servers[cursor.index]!;
      const membership = await membershipOf(job.requesterUserId, serverId);
      if (!membership || membership.deletedAt) {
        // Left (or closed) between a conversation's lines and its files: those files are listed, not written.
        const pending = cursor.phase === "summary" ? [] : cursor.pending;
        return { ops: [], next: nextServer(cursor, membership ? "closed" : "not_a_member"), ...(pending.length > 0 ? { missingFiles: pending.map(([, path]) => path) } : {}) };
      }
      const allowed = job.scope.includeContext ? (await contextAllowedServerIds([serverId])).has(serverId) : false;
      const view = await serverView(job, { id: membership.id, slug: membership.slug, name: membership.name }, allowed);
      switch (cursor.phase) {
        case "messages": return messagesBatch(job, view, cursor, limits);
        case "files": return filesBatch(view, cursor, limits);
        case "summary": return summaryBatch(view, cursor);
      }
    },
  };
}

/** The process's personal producer (server.ts registers it). */
export const personalDataExportProducer = createPersonalDataExportProducer();
