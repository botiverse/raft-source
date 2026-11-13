// Resolving comment threads (#proj-workspace:#249): the one rule the agent
// API (comments.ts) and the web API (webComments.ts) resolve and reopen by.
//
// - A thread is a root comment (no `reply_to`) and the replies under it; only
//   the root carries the resolution (`resolved_at`, `resolved_by_*`: the
//   actor as a comment's author is stored), so a reply is never resolved
//   (409 COMMENT_IS_REPLY, naming its root). A placeholder root (deleted,
//   kept for its replies) is still a thread.
// - Who may, besides seeing the Artifact and taking part in it (as for
//   commenting): the thread's author; the Artifact's author (its creator, a
//   person or an agent: items.created_by_*, the `author` notices name) or,
//   for an agent author, the person who manages it, by the same author check
//   a delete uses (canManageObject `delete`: the author or its agentManager,
//   standing in the server); and the owners and admins of its server
//   (`moderate`: people only). Anyone else: 403 FORBIDDEN.
// - In one transaction, the item row locked: the root again (gone: 404), a
//   resolve that stands already (or a reopen of an open one) writes nothing
//   (`changed: false`, no note), an agent's hold (a resolve is held as a
//   reply in that thread would be), the note (a reply by the resolver,
//   written by insertComment, before the root is resolved), the root, the
//   object event (`comment_resolved` for the thread's author when a person
//   and someone else; `comment_reopened` for no one), and, resolving, the
//   notice to the thread's author when an agent and someone else
//   (noticeResolved, whether it follows or not). After the commit the
//   notices are pushed and people's Activity is told (`activity:changed`,
//   the ping every comment write sends).
// - A reply in a resolved thread reopens it in the reply's transaction
//   (reopenThreadsOf, from insertComment and a review's writer).
import { and, eq, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { announceObjectEvents } from "../../platform/activity";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { canManageObjectActions, type ServerViewActor } from "../../platform/visibility";
import { currentVersionOf, readableVersion, type ArtifactActorRef, type ArtifactNoticeOutbox } from "./apiCommon";
import type { CommentHold, WrittenComment } from "./comments";
import { recordArtifactEvent } from "./events";
import { noticeResolved, sendQueued, type QueuedNotice } from "./notices";
import { artifactComments, artifactItems, artifactVersionFiles, artifactVersions, type ArtifactCommentRow, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";

const sameActor = (a: ArtifactActorRef, b: ArtifactActorRef): boolean => a.type === b.type && a.id === b.id;
export const threadAuthorOf = (root: Pick<ArtifactCommentRow, "authorType" | "authorId">): ArtifactActorRef => ({ type: root.authorType, id: root.authorId });
export const artifactAuthorOf = (item: Pick<ArtifactItemRow, "createdByType" | "createdById">): ArtifactActorRef => ({ type: item.createdByType, id: item.createdById });
/** Who resolved a root, or null while it is open. */
export const resolverOf = (row: Pick<ArtifactCommentRow, "resolvedByType" | "resolvedById">): ArtifactActorRef | null =>
  (row.resolvedByType === null || row.resolvedById === null ? null : { type: row.resolvedByType, id: row.resolvedById });

/** The root of the thread `commentId` is in (itself for a root), or null when the item has no such comment. */
export async function threadRootIdOf(executor: DatabaseExecutor, itemId: string, commentId: string): Promise<string | null> {
  const rows = await executor.execute<{ id: string }>(sql`
    WITH RECURSIVE up(id, reply_to) AS (
      SELECT id, reply_to FROM ${artifactComments} WHERE item_id = ${itemId} AND id = ${commentId}
      UNION
      SELECT c.id, c.reply_to FROM ${artifactComments} c JOIN up ON c.id = up.reply_to WHERE c.item_id = ${itemId}
    )
    SELECT id FROM up WHERE reply_to IS NULL LIMIT 1`);
  return rows.rows[0]?.id ?? null;
}

/**
 * In the transaction writing replies to `replyTo` (each a comment of the
 * item, or null for a new thread): reopen the threads they are in. UNION
 * stops at a cycle, which a reply chain never has.
 */
export async function reopenThreadsOf(tx: DatabaseExecutor, itemId: string, replyTo: readonly (string | null)[]): Promise<void> {
  const parents = [...new Set(replyTo.filter((id): id is string => id !== null))];
  if (parents.length === 0) return;
  await tx.execute(sql`
    WITH RECURSIVE up(id, reply_to) AS (
      SELECT id, reply_to FROM ${artifactComments} WHERE item_id = ${itemId} AND id IN (${sql.join(parents.map((id) => sql`${id}`), sql`, `)})
      UNION
      SELECT c.id, c.reply_to FROM ${artifactComments} c JOIN up ON c.id = up.reply_to WHERE c.item_id = ${itemId}
    )
    UPDATE ${artifactComments} SET resolved_at = NULL, resolved_by_type = NULL, resolved_by_id = NULL
    WHERE item_id = ${itemId} AND resolved_at IS NOT NULL AND id IN (SELECT id FROM up WHERE reply_to IS NULL)`);
}

/**
 * Whether the actor may resolve or reopen this thread: its author; the
 * Artifact's author or the person who manages an agent author (the author
 * check `delete` makes, visibilityService.canManageHomedObject); or an owner
 * or admin of the Artifact's server (`moderate`). Both asked in the same
 * queries.
 */
export async function mayResolve(actor: ServerViewActor, item: ArtifactItemRow, root: Pick<ArtifactCommentRow, "authorType" | "authorId">): Promise<boolean> {
  if (sameActor(actor, threadAuthorOf(root))) return true;
  const [asAuthor, asModerator] = await canManageObjectActions(actor, { serverId: item.serverId, author: artifactAuthorOf(item) }, ["delete", "moderate"]);
  return asAuthor! || asModerator!;
}

export type ResolvableThread =
  | { kind: "ok"; root: ArtifactCommentRow }
  | { kind: "not_found" }
  | { kind: "reply"; thread: string | null }
  | { kind: "forbidden"; threadAuthor: ArtifactActorRef; author: ArtifactActorRef };

/**
 * The checks before the transaction, for a caller who sees the Artifact and
 * takes part in it: the comment is the item's (a placeholder root counts),
 * a root, and the caller may resolve it.
 */
export async function resolvableThread(actor: ServerViewActor, item: ArtifactItemRow, commentId: string): Promise<ResolvableThread> {
  const [row] = await getDb().select().from(artifactComments).where(and(eq(artifactComments.itemId, item.id), eq(artifactComments.id, commentId))).limit(1);
  if (!row) return { kind: "not_found" };
  if (row.replyTo !== null) return { kind: "reply", thread: await threadRootIdOf(getDb(), item.id, row.id) };
  if (!(await mayResolve(actor, item, row))) return { kind: "forbidden", threadAuthor: threadAuthorOf(row), author: artifactAuthorOf(item) };
  return { kind: "ok", root: row };
}

/**
 * The version a note goes on: the current one, unless the thread is on a
 * file the current version no longer has (then the root's own, which has
 * it). Null only for an Artifact with no readable version.
 */
export async function noteVersionFor(item: ArtifactItemRow, root: ArtifactCommentRow): Promise<ArtifactVersionRow | null> {
  const current = await currentVersionOf(item);
  if (current && root.path === null) return current;
  if (current) {
    const [file] = await getDb().select({ path: artifactVersionFiles.path }).from(artifactVersionFiles)
      .where(and(eq(artifactVersionFiles.versionId, current.id), eq(artifactVersionFiles.path, root.path!))).limit(1);
    if (file) return current;
  }
  const [own] = await getDb().select().from(artifactVersions).where(and(readableVersion(item.id), eq(artifactVersions.id, root.versionId))).limit(1);
  return own ?? current;
}

export type ResolutionOutcome =
  | { kind: "gone" }
  | { kind: "not_found" }
  | { kind: "held"; hold: CommentHold }
  | {
    kind: "done";
    /** The root as it stands now. */
    root: ArtifactCommentRow;
    changed: boolean;
    note: WrittenComment | null;
    /** The thread's author, told of the resolve (an agent), by id; null when no one was. */
    toldAgent: string | null;
  };

/**
 * Resolve (`resolve`) or reopen a checked thread for `by`. `hold`: an
 * agent's, evaluated (and its read position moved) under the lock before a
 * resolve writes anything. `note`: writes the note in the transaction
 * (insertComment), given the locked item and the agent ids not to tell of it
 * as followers (the thread's author, told of the resolve instead).
 */
export async function changeResolution(input: {
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  rootId: string;
  by: ArtifactActorRef;
  resolve: boolean;
  hold?: (tx: DatabaseExecutor, locked: ArtifactItemRow, root: ArtifactCommentRow) => Promise<CommentHold | null>;
  note?: (tx: DatabaseExecutor, locked: ArtifactItemRow, quiet: readonly string[]) => Promise<WrittenComment>;
}): Promise<ResolutionOutcome> {
  const { by, resolve } = input;
  const now = currentDate();
  const outcome = await getDb().transaction(async (tx): Promise<ResolutionOutcome & { queued?: QueuedNotice[]; eventIds?: string[] }> => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, input.item.id)).for("update");
    if (!locked || locked.deletedAt || locked.revokedAt) return { kind: "gone" };
    const [root] = await tx.select().from(artifactComments).where(and(eq(artifactComments.itemId, locked.id), eq(artifactComments.id, input.rootId))).limit(1);
    if (!root) return { kind: "not_found" };
    if ((root.resolvedAt !== null) === resolve) return { kind: "done", root, changed: false, note: null, toldAgent: null };
    if (resolve && input.hold) {
      const hold = await input.hold(tx, locked, root);
      if (hold) return { kind: "held", hold };
    }
    const threadAuthor = threadAuthorOf(root);
    const tellsAuthor = resolve && !sameActor(threadAuthor, by);
    const note = resolve && input.note ? await input.note(tx, locked, tellsAuthor && threadAuthor.type === "agent" ? [threadAuthor.id] : []) : null;
    const [row] = await tx.update(artifactComments)
      .set(resolve ? { resolvedAt: now, resolvedByType: by.type, resolvedById: by.id } : { resolvedAt: null, resolvedByType: null, resolvedById: null })
      .where(and(eq(artifactComments.itemId, locked.id), eq(artifactComments.id, root.id)))
      .returning();
    // The item as the note left it (its position, the list's order).
    const [item] = note ? await tx.select().from(artifactItems).where(eq(artifactItems.id, locked.id)).limit(1) : [locked];
    const event = await recordArtifactEvent(tx, {
      item: item!,
      eventKind: resolve ? "comment_resolved" : "comment_reopened",
      actor: by,
      data: { comment: root.id, position: root.position, ...(note ? { note: note.comment.id } : {}) },
      // A person whose thread someone else resolved hears through their Activity; a reopen tells no one.
      recipients: tellsAuthor && threadAuthor.type === "user" ? [{ actor: threadAuthor, reason: "following" as const }] : [],
    });
    const told = tellsAuthor && threadAuthor.type === "agent"
      ? await noticeResolved({ executor: tx, outbox: input.outbox, item: item!, root: row!, by, note: note?.comment ?? null, now })
      : { queued: [], told: null };
    return {
      kind: "done",
      root: row!,
      changed: true,
      note,
      toldAgent: told.told,
      queued: [...(note?.queued ?? []), ...told.queued],
      eventIds: [...(note ? [note.eventId] : []), event.id],
    };
  });
  if (outcome.kind !== "done") return outcome;
  const { queued = [], eventIds = [], ...done } = outcome;
  await sendQueued(input.outbox, queued);
  await announceObjectEvents(eventIds);
  return done;
}
