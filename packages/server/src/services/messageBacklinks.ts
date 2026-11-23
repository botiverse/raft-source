// The chat messages that link a first-party object, for one viewer
// (#proj-workspace:#336 step 2, "Linked from"): core's read of the rows
// services/messageReferences.ts writes (object_references, source
// `message`), joined to the live messages and filtered by who may read them
// in the same statement, so a page and its count hold only what the viewer
// can read now. Apps reach it through platform/references (messageBacklinks).
//
// Who reads what, the rules of message search (searchService
// searchMessagesForUser / searchMessagesForAgent):
// - the viewer's visible conversations (visibilityService
//   visibleRootChannelIds: an agent's through filterAgentAccessibleChannelIds,
//   a delegated assistant's its owner's, narrowed by the owner's DM switch),
//   as one condition on the message's channel (visibleConversationSql, the
//   channel side of search's row check: a local channel of the viewer's
//   server, or a joint's canonical storage the viewer sees through its own
//   projection); a person who is a guest of the server only in the
//   conversations listed to them (listChannels, search's guest prefilter);
//   the caller's `allowedRootChannelIds` narrow it further (a personal
//   assistant confined to its owner's DM: intersectVisibleRoots), never
//   widen it;
// - the plan's history window of the viewer's server
//   (getServerHistoryWindowForRead: created after the cutoff);
// - live: `m.deleted_at IS NULL` (a retraction), the channel not deleted;
//   chat messages only (`message_type = 'chat'`: a system line is no
//   discussion, and the backfill reads only chat messages).
// A legacy thread with no parent message is left out (there is no
// conversation to name it by without a lookup per row).
//
// Stale rows: a message's rows are replaced after the commit of each edit
// (messageReferences.ts), so for a moment, or for good when a write failed,
// a row can name an object the text no longer links. The page re-reads each
// message's text now (firstPartyAppMessageLinks.messageObjectLinks, the walk
// the rows were written from) and drops one that no longer links the target.
// To keep such rows out of the count too, the statement also asks that the
// text still names one of Raft's link hosts (messageReferenceHosts, the
// check a new message's write makes: a `strpos` per host). Known limit: a
// message that still names some Raft address, but no longer this object,
// is still counted (not listed).
//
// Each page row's excerpt is read from the message's text in the same
// statement (never stored): plain text (shared notificationPlainText, what
// notification and outline previews read: no Markdown, a link by its text),
// on one line, at most MESSAGE_BACKLINK_EXCERPT_CHARS.
//
// Cost: a constant number of queries, however many messages link the
// object: the viewer's role, the visible conversations
// (visibleRootChannelIds' own few) and the history window at once (a
// guest's channel list after them); then the count and the page at once,
// each over the target's rows (idx_object_references_target), each message
// by its primary key and its channel by its own. The count stops at
// `countCap + 1` rows; the page sorts every visible linking message (no
// index orders them), which is the target's backlinks, not the server's
// messages.
import { sql, type SQL } from "drizzle-orm";
import { isGuestRole, notificationPlainText } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, messages } from "../db/schema";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { listChannels } from "./channelService";
import { messageObjectLinks } from "./firstPartyAppMessageLinks";
import { historyLimitedPreview } from "./historyPreview";
import { getServerHistoryWindowForRead } from "./historyWindow";
import { MESSAGE_REFERENCE_SOURCE_KIND, messageReferenceHosts } from "./messageReferences";
import { OBJECT_REFERENCES_MAX_PER_SOURCE, sourcesReferencingSql } from "./objectReferences";
import {
  assertNeverViewActor,
  intersectVisibleRoots,
  uuidArray,
  visibleConversationSql,
  visibleRootChannelIds,
  type ViewActor,
  type VisibleRoots,
} from "./visibilityService";

/** The most characters of a message's excerpt (its plain text on one line, "…" included). */
export const MESSAGE_BACKLINK_EXCERPT_CHARS = 120;

/** A message that links the object, where the viewer reads it. */
export interface MessageBacklink {
  messageId: string;
  /** Its top-level conversation as the viewer's server has it: a thread's or task conversation's parent; a joint by the viewer's projection. */
  conversationId: string;
  /** For a reply in a thread: the message the thread hangs off. Null otherwise (a task conversation's message too). */
  threadRootId: string | null;
  /** Who sent it, as stored. */
  sender: { type: "user" | "agent" | "external_projection"; id: string };
  createdAt: Date;
  /** Its text now, as plain text on one line, at most MESSAGE_BACKLINK_EXCERPT_CHARS. */
  excerpt: string;
}

/** The newest messages that link the object (`items`) and how many the viewer can read (`total`, up to the cap; `capped` past it). */
export interface MessageBacklinks {
  items: MessageBacklink[];
  total: number;
  capped: boolean;
}

const NONE: MessageBacklinks = { items: [], total: 0, capped: false };

/** A person whose guest role narrows what they read (search's guest prefilter): a user, or a delegated assistant's owner. */
function personOf(viewer: ViewActor): string | null {
  switch (viewer.type) {
    case "user":
    case "delegated":
      return viewer.id;
    case "agent":
      return null;
    default:
      return assertNeverViewActor(viewer);
  }
}

/** The canonical storage channels of the visible joint roots (search's jointStorageRootIds). */
const jointStorageRootIds = (roots: VisibleRoots): string[] =>
  roots.roots.flatMap((root) => {
    const storage = root.type === "joint" ? roots.jointStorageByLocalId.get(root.id) : undefined;
    return storage ? [storage] : [];
  });

/**
 * The viewer's visible conversations, narrowed for a guest (their listed
 * channels) and by `allowed`: search's set, in a constant number of queries.
 */
async function readableRoots(viewer: ViewActor, allowed: readonly string[] | undefined): Promise<VisibleRoots> {
  const person = personOf(viewer);
  const [visible, role] = await Promise.all([
    visibleRootChannelIds(viewer),
    person === null ? null : getActorServerRoleInServer(viewer.serverId, "user", person),
  ]);
  let roots = visible;
  if (person !== null && isGuestRole(role)) {
    roots = intersectVisibleRoots(roots, (await listChannels(viewer.serverId, person, { archived: "include" })).map((channel) => channel.id));
  }
  return allowed ? intersectVisibleRoots(roots, allowed) : roots;
}

/**
 * The FROM and WHERE of the viewer's messages that link `target` (the
 * header's rules), `m` the message and `c` its channel.
 */
function linkingMessagesSql(target: { kind: string; id: string }, roots: VisibleRoots, cutoff: Date | undefined, hosts: readonly string[]): SQL {
  return sql`FROM ${messages} m
    JOIN ${channels} c ON c.id = m.channel_id
    WHERE m.id IN ${sourcesReferencingSql(MESSAGE_REFERENCE_SOURCE_KIND, target, { uuid: true })}
      AND m.deleted_at IS NULL
      AND m.message_type = 'chat'
      AND c.deleted_at IS NULL
      AND ${visibleConversationSql(roots, sql`c.id`, sql`c.parent_channel_id`)}
      AND (c.server_id = ${roots.serverId} OR COALESCE(c.parent_channel_id, c.id) = ANY(${uuidArray(jointStorageRootIds(roots))}))
      AND (c.type NOT IN ('thread', 'task') OR (c.parent_channel_id IS NOT NULL AND (c.type = 'task' OR c.parent_message_id IS NOT NULL)))
      ${cutoff ? sql`AND m.created_at > ${cutoff.toISOString()}::timestamptz` : sql``}
      AND strpos(m.content, '://') > 0
      AND (${sql.join(hosts.map((host) => sql`strpos(lower(m.content), ${host}) > 0`), sql` OR `)})`;
}

interface PageRow {
  id: string;
  content: string;
  sender_type: MessageBacklink["sender"]["type"];
  sender_id: string;
  created_at: Date | string;
  root_id: string;
  thread_root_id: string | null;
}

/** Whether `content`'s links still name `target` (the walk the rows were written from). */
const stillLinks = (content: string, target: { kind: string; id: string }): boolean =>
  messageObjectLinks(content, OBJECT_REFERENCES_MAX_PER_SOURCE).some((link) => link.entry.objectKind.kind === target.kind && link.id === target.id);

/**
 * The chat messages that link `target` (a registered object kind and id) as
 * `viewer` reads them (the header's rules): the newest `limit`, each where
 * the viewer reads it, and how many there are, counted up to `countCap`
 * (`capped` past it). The caller decides whether the viewer is told of
 * messages at all (an Artifact's: only a reader inside its server).
 */
export async function messageBacklinks(
  viewer: ViewActor,
  target: { kind: string; id: string },
  opts: { limit: number; countCap: number; allowedRootChannelIds?: readonly string[] },
): Promise<MessageBacklinks> {
  const hosts = messageReferenceHosts();
  if (hosts.length === 0 || opts.limit <= 0) return NONE;
  const [roots, window] = await Promise.all([
    readableRoots(viewer, opts.allowedRootChannelIds),
    getServerHistoryWindowForRead(viewer.serverId),
  ]);
  if (roots.roots.length === 0) return NONE;
  const linking = linkingMessagesSql(target, roots, window.cutoff, hosts);
  const db = getDb();
  const [counted, page] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS n FROM (SELECT 1 ${linking} LIMIT ${opts.countCap + 1}) linking`),
    db.execute(sql`SELECT m.id::text AS id, m.content, m.sender_type, m.sender_id, m.created_at,
        (CASE WHEN c.type IN ('thread', 'task') THEN c.parent_channel_id ELSE c.id END)::text AS root_id,
        (CASE WHEN c.type = 'thread' THEN c.parent_message_id END)::text AS thread_root_id
      ${linking}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${opts.limit}`),
  ]);
  const n = Number((counted.rows[0] as { n?: number } | undefined)?.n ?? 0);
  // A joint's messages live in its canonical storage: named by the viewer's own projection.
  const localByStorage = new Map([...roots.jointStorageByLocalId].map(([localId, storageId]) => [storageId, localId]));
  const localRoots = new Set(roots.roots.map((root) => root.id));
  const items = (page.rows as unknown as PageRow[]).flatMap((row): MessageBacklink[] => {
    const conversationId = localByStorage.get(row.root_id) ?? row.root_id;
    if (!localRoots.has(conversationId) || !stillLinks(row.content, target)) return [];
    return [{
      messageId: row.id,
      conversationId,
      threadRootId: row.thread_root_id,
      sender: { type: row.sender_type, id: row.sender_id },
      createdAt: new Date(row.created_at),
      excerpt: historyLimitedPreview(notificationPlainText(row.content), MESSAGE_BACKLINK_EXCERPT_CHARS) ?? "",
    }];
  });
  return { items, total: Math.min(n, opts.countCap), capped: n > opts.countCap };
}
