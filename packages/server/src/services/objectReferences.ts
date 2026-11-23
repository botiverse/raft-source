/**
 * Core side of `object_references` (#proj-workspace:#336): what a first-party
 * object's latest content names. An app replaces all of one source's rows at
 * once, in its own short transaction, after it has read the content outside
 * any transaction (replaceReferences), and deletes them with the source
 * (deleteReferencesOfSource). Kinds are the registry's
 * (apps/firstPartyApps.ts), checked here as recordObjectEvent checks them;
 * a source may also be one of core's own objects (CORE_SOURCE_KINDS: a chat
 * message, services/messageReferences.ts), never a target: nothing links to
 * a message through this table.
 * Who may see a reference is not stored: a reader checks the source's and
 * the target's visibility. A server's rows go with its closed-server purge
 * (closedServerPurgeClassification.ts, by server_id).
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { firstPartyApps, registeredObjectKind } from "../apps/firstPartyApps";
import type { DatabaseExecutor } from "../db/index";
import { objectReferences, type ObjectReferenceDetail } from "../db/schema";

export type { ObjectReferenceDetail };

/** The most rows one source keeps: its first references in its own order. */
export const OBJECT_REFERENCES_MAX_PER_SOURCE = 200;

/**
 * Core objects that may be a SOURCE (never a target) besides the registry's
 * kinds: `message`, a chat message whose links name first-party objects, so
 * an Artifact can list the messages that link it (#proj-workspace:#336 step
 * 2). Not a registered object kind (no app owns messages), so a target of
 * this kind is refused as any unknown one is.
 */
export const CORE_SOURCE_KINDS: ReadonlySet<string> = new Set(["message"]);

/** The object whose content names others: a registered kind or a core one (CORE_SOURCE_KINDS), its id, its own server. */
export interface ObjectReferenceSource {
  serverId: ServerId;
  kind: string;
  id: string;
}

/** One object the source names, with the target kind's facts about the reference (at most 4 KiB as stored). */
export interface ObjectReference {
  kind: string;
  id: string;
  detail: ObjectReferenceDetail;
}

/** A kind the registry doesn't have. */
export class ObjectReferenceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectReferenceRejected";
  }
}

/** A registered kind, or on the source side also a core one (CORE_SOURCE_KINDS). */
function checkKind(kind: string, side: "source" | "target"): void {
  if (registeredObjectKind(kind)) return;
  if (side === "source" && CORE_SOURCE_KINDS.has(kind)) return;
  const known = firstPartyApps().flatMap((app) => app.objectKinds.map((objectKind) => objectKind.kind));
  const core = side === "source" ? `; core sources: ${[...CORE_SOURCE_KINDS].join(", ")}` : "";
  throw new ObjectReferenceRejected(`object kind ${JSON.stringify(kind)} is not registered as a ${side} (registered: ${known.join(", ")}${core})`);
}

/**
 * Make `refs` the source's references, in order (positions from 0), in place
 * of all it had; none leaves it with none. Past OBJECT_REFERENCES_MAX_PER_SOURCE
 * the rest are left out. Throws ObjectReferenceRejected for an unregistered
 * kind (nothing written): a source's kind may be a core one (CORE_SOURCE_KINDS),
 * a target's only a registered one. Run in the caller's transaction, with the source
 * locked against another replace of it (two at once would collide on the
 * key).
 */
export async function replaceReferences(executor: DatabaseExecutor, source: ObjectReferenceSource, refs: readonly ObjectReference[]): Promise<void> {
  checkKind(source.kind, "source");
  const kept = refs.slice(0, OBJECT_REFERENCES_MAX_PER_SOURCE);
  for (const kind of new Set(kept.map((ref) => ref.kind))) checkKind(kind, "target");
  await deleteReferencesOfSource(executor, source.kind, source.id);
  if (kept.length === 0) return;
  await executor.insert(objectReferences).values(kept.map((ref, position) => ({
    serverId: source.serverId,
    sourceKind: source.kind,
    sourceId: source.id,
    position,
    targetKind: ref.kind,
    targetId: ref.id,
    targetDetail: ref.detail,
  })));
}

/** Delete every reference of one source (it is gone, or no longer shown), in the caller's transaction; how many went. */
export async function deleteReferencesOfSource(executor: DatabaseExecutor, kind: string, id: string): Promise<number> {
  const deleted = await executor.delete(objectReferences)
    .where(and(eq(objectReferences.sourceKind, kind), eq(objectReferences.sourceId, id)))
    .returning({ position: objectReferences.position });
  return deleted.length;
}

/** One source's references, in order (what its latest content names). */
export async function referencesOfSource(executor: DatabaseExecutor, kind: string, id: string): Promise<ObjectReference[]> {
  const rows = await executor.select({ kind: objectReferences.targetKind, id: objectReferences.targetId, detail: objectReferences.targetDetail })
    .from(objectReferences)
    .where(and(eq(objectReferences.sourceKind, kind), eq(objectReferences.sourceId, id)))
    .orderBy(objectReferences.position);
  return rows;
}

/**
 * The ids of the sources of kind `sourceKind` whose references name `target`,
 * as a subquery for an `IN (...)` (an id once per row: a source naming the
 * target twice is twice here, which `IN` reads once): what names an object,
 * through idx_object_references_target (#proj-workspace:#336 step 2, "Linked
 * from"). `uuid`: the ids as uuids, for a source keyed by one (a message),
 * so its primary key matches them; the cast only ever reads this kind's
 * rows (a CASE, whatever order the planner checks the conditions in). The
 * reader joins the sources' live rows and checks who may see them in the
 * same statement; nothing about sight is stored here.
 */
export function sourcesReferencingSql(sourceKind: string, target: { kind: string; id: string }, opts?: { uuid?: true }): SQL {
  const id = opts?.uuid
    ? sql`CASE WHEN ${objectReferences.sourceKind} = ${sourceKind} THEN ${objectReferences.sourceId}::uuid END`
    : sql`${objectReferences.sourceId}`;
  return sql`(SELECT ${id} FROM ${objectReferences}
    WHERE ${objectReferences.targetKind} = ${target.kind}
      AND ${objectReferences.targetId} = ${target.id}
      AND ${objectReferences.sourceKind} = ${sourceKind})`;
}
