// The old comments of a page moved from the standalone Raft Artifacts app
// (raft-artifacts.com), copied onto the Artifact its import made: an
// operator's job (legacyBulkImport.ts: right after each page a server move
// imports, and the `comments` mode for pages imported before), never a
// request of a person or agent. The on-demand import (import.ts) doesn't
// copy them: the old server usually isn't frozen then, and the standalone
// app serves a server's comments only once it is. The design is Tenny's
// (approved): no table and no migration of its own:
//
// - each old comment is one row of `comments`, id `lc_<old id>`, inserted
//   with ON CONFLICT (id) DO NOTHING, so a rerun never makes a second one;
//   only a row actually inserted takes a position: the item's next one, as a
//   comment takes it (comments.ts insertComment: the item row locked, its
//   `last_position` moved), all of one Artifact's in one transaction, oldest
//   first;
// - on the Artifact's version 1 (the imported one), `created_at` the old
//   comment's time, no path, anchor, reply or mention: a reply's structure is
//   flattened into its body, as is the file it was on;
// - its author is the old one when Raft confirms it, by import.ts's rule for
//   a page's creator (legacyAuthor: that id, now, a live principal of exactly
//   that type in the server), else the system identity an import with an
//   unconfirmed creator has (ARTIFACT_OPS_IMPORT_ACTOR), its body then
//   starting with `<old author's name> (from raft-artifacts.com)`;
// - its body: that line when needed, `On <path>:` when it was on a file,
//   `Reply to <name>:` when it replied to a comment of the same answer (a
//   parent not in it: no such line), then the old body, cut to a comment's
//   limit (AGENT_API_ARTIFACT_MAX_COMMENT_CHARS);
// - nobody is woken: no object event, no notice, no Activity announcement,
//   no follow and no read position is written. Search is of titles only
//   (search.ts) and the comment counts are counted from the rows (webCards
//   artifactCardFacts), so nothing else is kept beside them; the item's
//   `updated_at` moves only up to the newest copied comment's time (a
//   comment moves it to now: the list orders by activity, and the copies are
//   no new activity);
// - one `import_comments` audit row per Artifact that got any, by the ops
//   actor, naming the old Artifact, how many, the operator and (the
//   `comments` mode) the approval.
import { and, eq, inArray, sql } from "drizzle-orm";
import { AGENT_API_ARTIFACT_MAX_COMMENT_CHARS, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import type { ArtifactActorRef } from "./apiCommon";
import { ARTIFACT_OPS_IMPORT_ACTOR, legacyAuthor } from "./import";
import { fetchLegacyComments, LegacyWorkerUnavailable, type LegacyComment, type LegacyWorkerConfig } from "./legacyWorker";
import { artifactAudit, artifactComments, artifactItems, artifactVersions } from "./schema";

/** The audit action a copy of old comments writes (one row per Artifact that got any). */
export const ARTIFACT_IMPORT_COMMENTS_AUDIT_ACTION = "import_comments";

/** The id an old comment's copy has: deterministic, so a rerun finds it. */
export const legacyCommentId = (oldId: string): string => `lc_${oldId}`;

/** One old comment as it is written here. */
export interface LegacyCommentRow {
  /** `lc_<old id>`. */
  id: string;
  oldId: string;
  author: ArtifactActorRef;
  /** The old author is the author here (legacyAuthor confirmed it); else the system identity, its name in the body. */
  matched: boolean;
  /** Who wrote it there, for counting distinct authors. */
  authorKey: string;
  body: string;
  createdAt: Date;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const cutTo = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};
const shownName = (name: string): string => cutTo(oneLine(name), 200) || "Someone";

/**
 * The rows the old comments become in `serverId` (read only), oldest first
 * (the standalone app's order, kept for comments of the same time): each
 * one's author (legacyAuthor, asked once per old author) and body with its
 * lines (see the top of this file).
 */
export async function legacyCommentRows(serverId: ServerId, comments: readonly LegacyComment[]): Promise<LegacyCommentRow[]> {
  const nameOf = new Map(comments.map((comment) => [comment.id, comment.author.name]));
  const authors = new Map<string, ArtifactActorRef | null>();
  const rows: LegacyCommentRow[] = [];
  const ordered = comments.map((comment, index) => ({ comment, index })).sort((a, b) => a.comment.createdAt - b.comment.createdAt || a.index - b.index);
  for (const { comment } of ordered) {
    const { type, raftId, name } = comment.author;
    const authorKey = raftId ? `${type}:${raftId.toLowerCase()}` : `name:${oneLine(name)}`;
    if (!authors.has(authorKey)) authors.set(authorKey, raftId ? await legacyAuthor(serverId, { type, raftId, name }) : null);
    const author = authors.get(authorKey) ?? null;
    const lines: string[] = [];
    if (!author) lines.push(`${shownName(name)} (from raft-artifacts.com)`);
    if (comment.path) lines.push(`On ${comment.path}:`);
    const parent = comment.replyTo === null ? undefined : nameOf.get(comment.replyTo);
    if (parent !== undefined) lines.push(`Reply to ${shownName(parent)}:`);
    lines.push(comment.body.trim());
    rows.push({
      id: legacyCommentId(comment.id),
      oldId: comment.id,
      author: author ?? ARTIFACT_OPS_IMPORT_ACTOR,
      matched: author !== null,
      authorKey,
      body: cutTo(lines.join("\n").trim(), AGENT_API_ARTIFACT_MAX_COMMENT_CHARS),
      createdAt: new Date(comment.createdAt),
    });
  }
  return rows;
}

/** Of these ids, the ones a copy already has: on this Artifact (`here`), or on another one (`elsewhere`: its id is taken, it is never copied here). Read only. */
export async function presentLegacyComments(itemId: string, ids: readonly string[]): Promise<{ here: Set<string>; elsewhere: Set<string> }> {
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  if (ids.length === 0) return { here, elsewhere };
  const rows = await getDb().select({ id: artifactComments.id, itemId: artifactComments.itemId }).from(artifactComments)
    .where(inArray(artifactComments.id, [...ids]));
  for (const row of rows) (row.itemId === itemId ? here : elsewhere).add(row.id);
  return { here, elsewhere };
}

/** What writing one Artifact's old comments did: how many were inserted, how many were there already (by id); `gone`: the Artifact is deleted or revoked, nothing written. */
export type LegacyCommentsWrite = { kind: "written"; inserted: number; present: number } | { kind: "gone" };

/**
 * Write the rows onto the Artifact, in one transaction, its item row locked
 * (FOR UPDATE, as a comment does): each inserted (ON CONFLICT (id) DO
 * NOTHING) takes the item's next position, on version 1. No event, notice,
 * follow or read position (see the top of this file). The audit row names
 * the old Artifact, the operator and, when there is one, the approval.
 */
export async function writeLegacyComments(input: {
  itemId: string;
  legacyArtifactId: string;
  rows: readonly LegacyCommentRow[];
  operator: string;
  approval?: { approver: { id: string; name: string }; approvalRef: string };
}): Promise<LegacyCommentsWrite> {
  const { itemId, rows } = input;
  return getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
    if (!locked || locked.deletedAt || locked.revokedAt) return { kind: "gone" as const };
    const [version] = await tx.select({ id: artifactVersions.id }).from(artifactVersions)
      .where(and(eq(artifactVersions.itemId, itemId), eq(artifactVersions.number, 1))).limit(1);
    if (!version) throw new Error(`artifact ${itemId} has no version 1 to put its old comments on`);
    let last = locked.lastPosition;
    let inserted = 0;
    let newest: Date | null = null;
    for (const row of rows) {
      const [done] = await tx.insert(artifactComments).values({
        id: row.id,
        itemId,
        versionId: version.id,
        path: null,
        anchor: null,
        replyTo: null,
        authorType: row.author.type,
        authorId: row.author.id,
        body: row.body,
        mentions: [],
        position: last + 1,
        createdAt: row.createdAt,
      }).onConflictDoNothing({ target: artifactComments.id }).returning({ id: artifactComments.id });
      if (!done) continue;
      last += 1;
      inserted += 1;
      if (!newest || row.createdAt > newest) newest = row.createdAt;
    }
    if (inserted > 0) {
      await tx.update(artifactItems).set({
        lastPosition: last,
        updatedAt: sql`GREATEST(${artifactItems.updatedAt}, ${newest!.toISOString()}::timestamptz)`,
      }).where(eq(artifactItems.id, itemId));
      await tx.insert(artifactAudit).values({
        itemId,
        actorType: ARTIFACT_OPS_IMPORT_ACTOR.type,
        actorId: ARTIFACT_OPS_IMPORT_ACTOR.id,
        action: ARTIFACT_IMPORT_COMMENTS_AUDIT_ACTION,
        before: null,
        after: {
          legacyArtifactId: input.legacyArtifactId,
          comments: inserted,
          ops: { operator: input.operator },
          ...(input.approval
            ? { approvedBy: { type: "user", id: input.approval.approver.id, name: input.approval.approver.name }, approvalRef: input.approval.approvalRef }
            : {}),
        },
      });
    }
    return { kind: "written" as const, inserted, present: rows.length - inserted };
  });
}

/** What copying one page's old comments came to, as a server move's report keeps it. */
export type LegacyCommentsResult =
  /** Fetched and written: `imported` new, `alreadyImported` there before (by id), `systemAuthor` of all of them by the system identity. */
  | { outcome: "imported"; comments: number; imported: number; alreadyImported: number; systemAuthor: number }
  /** The standalone app has no such page (404): nothing to copy. */
  | { outcome: "not_found" }
  /** Not copied: the fetch failed (its reason: unreachable, bad_answer, rate_limited, not_frozen, too_many), or the write did (`error`), or the Artifact is gone. */
  | { outcome: "failed"; reason: string; message?: string };

/**
 * Fetch the old comments of `name` and write them onto `itemId` (a server
 * move, right after its import). Never throws: a failure is the result.
 */
export async function copyLegacyComments(input: {
  config: LegacyWorkerConfig;
  serverId: ServerId;
  name: string;
  itemId: string;
  legacyArtifactId: string;
  operator: string;
}): Promise<LegacyCommentsResult> {
  try {
    const answer = await fetchLegacyComments(input.config, input.serverId, input.name);
    if (answer.kind === "not_found") return { outcome: "not_found" };
    if (answer.kind === "not_frozen") return { outcome: "failed", reason: "not_frozen" };
    if (answer.kind === "too_many") return { outcome: "failed", reason: "too_many" };
    const rows = await legacyCommentRows(input.serverId, answer.comments);
    const written = await writeLegacyComments({ itemId: input.itemId, legacyArtifactId: input.legacyArtifactId, rows, operator: input.operator });
    if (written.kind === "gone") return { outcome: "failed", reason: "gone" };
    return {
      outcome: "imported",
      comments: rows.length,
      imported: written.inserted,
      alreadyImported: written.present,
      systemAuthor: rows.filter((row) => !row.matched).length,
    };
  } catch (error) {
    if (error instanceof LegacyWorkerUnavailable) return { outcome: "failed", reason: error.reason };
    return { outcome: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
