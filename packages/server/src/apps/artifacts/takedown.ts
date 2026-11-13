// Taking an Artifact down and restoring it: moderation, not a delete
// (runbook: docs/operations/artifact-takedown.md). Its author deletes; a
// takedown is for what was reported (the public page's "Report abuse").
//
// Who may (by `ArtifactModerator`):
// - `member`: the owners and admins of the Artifact's own server, while
//   standing in it (mayManageArtifact "moderate", platform/visibility
//   canManageObject; never its author or an agent's manager as such, never
//   another server's people, an agent or an assistant acting for its owner).
//   Like a delete, they needn't see it. One who may not: forbidden if they
//   see it, else not_visible; a taken-down Artifact is seen by no one, so a
//   restore by one who may not is always not_visible.
// - `ops`: a Raft operator, through the operator's script
//   (scripts/artifacts-takedown.ts, run with the server's DATABASE_URL, as
//   the legacy import's), recorded as the moderation ops actor (import.ts
//   ARTIFACT_OPS_MODERATION_ACTOR, not the import's) with `ops: { operator }`
//   in the audit row.
//
// takedownArtifact, with the item row locked: sets `items.revoked_at`, and
// `revoked_at` / `revoked_by_*` on every version not revoked yet (the same
// `now()`, so a restore finds exactly those), writes the audit row
// (`taken_down`: the reason, how many versions), drops its pending notices
// and its people's Activity rows (forgetArtifactActivity; the caller
// announces them after the commit). Every read leaves a revoked item out
// (visibility.ts; the content Worker's authorize, contentRoutes.ts), with
// the deleted one's refusal (the one 404, `deleted` to the Worker). Its
// search row stays: search lists live items only (liveArtifactsIn), so a
// restore needs no reindex. Already down: `changed: false`, nothing written.
//
// restoreArtifact, the same people, with the item row locked: clears
// `revoked_at` on the item and on the versions the takedown revoked, and
// writes the audit row (`restored`, the reason). Another live Artifact of
// its home took its name meanwhile: name_taken. Not down: `changed: false`.
// What the takedown dropped (Activity rows, pending notices) stays dropped.
import { and, eq, isNull, sql } from "drizzle-orm";
import { ARTIFACT_TAKEDOWN_REASON_MAX_CHARS, asArtifactId, type ArtifactWebTakedown } from "@botiverse/raft-shared";
import type { ForgottenActivityRow } from "../../platform/activity";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { assertNeverViewActor, type ViewActor } from "../../platform/visibility";
import { forgetArtifactActivity } from "./activity";
import type { ArtifactActorRef } from "./apiCommon";
import { ARTIFACT_OPS_MODERATION_ACTOR } from "./import";
import { mayManageArtifact, type ArtifactManageRefusal } from "./manage";
import { isNameTakenInHome, isUniqueViolation, type ArtifactHomeRef } from "./names";
import { artifactAudit, artifactItems, artifactPendingNotices, artifactVersions, type ArtifactItemRow } from "./schema";
import { canViewArtifacts } from "./visibility";

/** Who takes an Artifact down or restores it: a person of its server (checked), or a Raft operator through the operator's script. */
export type ArtifactModerator =
  | { kind: "member"; actor: ViewActor }
  | { kind: "ops"; operator: string };

export type ArtifactTakedownOutcome =
  | { kind: "done"; item: ArtifactItemRow; changed: boolean; forgotten: ForgottenActivityRow[] }
  | Extract<ArtifactManageRefusal, { kind: "not_visible" | "forbidden" | "name_taken" }>;

type Refusal = Extract<ArtifactManageRefusal, { kind: "not_visible" | "forbidden" | "name_taken" }>;

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.kind);
  }
}

const MAY_NOT_MODERATE: Refusal = { kind: "forbidden", reason: "Only the owners and admins of the artifact's server can take it down or restore it: ask one of them to." };

/** The reason as recorded: trimmed, 1 to ARTIFACT_TAKEDOWN_REASON_MAX_CHARS characters; null otherwise. */
export function takedownReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason.length > 0 && reason.length <= ARTIFACT_TAKEDOWN_REASON_MAX_CHARS ? reason : null;
}

/** Who acts, as the audit and the versions record it, or the refusal (the header's rule). */
async function moderatorOf(tx: DatabaseExecutor, by: ArtifactModerator, item: ArtifactItemRow): Promise<{ actor: ArtifactActorRef; ops?: { operator: string } }> {
  if (by.kind === "ops") return { actor: ARTIFACT_OPS_MODERATION_ACTOR, ops: { operator: by.operator } };
  const { actor } = by;
  switch (actor.type) {
    case "user":
      if (await mayManageArtifact(actor, item, "moderate", { executor: tx })) return { actor: { type: "user", id: actor.id } };
      break;
    // Only a person moderates: an agent, or one acting for a person, never does.
    case "agent":
    case "delegated":
      break;
    default:
      return assertNeverViewActor(actor);
  }
  // One who may not learns nothing about an Artifact they can't see (a taken-down one: nobody sees it).
  const [visible] = await canViewArtifacts(actor, [item], { executor: tx });
  throw new Refused(visible ? MAY_NOT_MODERATE : { kind: "not_visible" });
}

async function run(work: () => Promise<ArtifactTakedownOutcome>, itemId: string): Promise<ArtifactTakedownOutcome> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    // Another Artifact took the name in its home between the check and the restore.
    if (isUniqueViolation(error)) {
      const [item] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
      return { kind: "name_taken", name: item?.name ?? "" };
    }
    throw error;
  }
}

/** Take the item down (the header's checks and writes). `reason`: takedownReason's. */
export function takedownArtifact(by: ArtifactModerator, itemId: string, reason: string): Promise<ArtifactTakedownOutcome> {
  return run(() => getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
    if (!locked) throw new Refused({ kind: "not_visible" });
    const { actor, ops } = await moderatorOf(tx, by, locked);
    if (locked.revokedAt !== null) return { kind: "done" as const, item: locked, changed: false, forgotten: [] };

    const [revoked] = await tx.update(artifactItems).set({ revokedAt: sql`now()` }).where(eq(artifactItems.id, locked.id)).returning();
    const versions = await tx.update(artifactVersions)
      .set({ revokedAt: sql`now()`, revokedByType: actor.type, revokedById: actor.id })
      .where(and(eq(artifactVersions.itemId, locked.id), isNull(artifactVersions.revokedAt)))
      .returning({ id: artifactVersions.id });
    await tx.insert(artifactAudit).values({
      itemId: locked.id,
      actorType: actor.type,
      actorId: actor.id,
      action: "taken_down",
      before: { revoked_at: null },
      after: { revoked_at: revoked!.revokedAt!.toISOString(), reason, versions_revoked: versions.length, ...(ops ? { ops } : {}) },
    });
    // Nothing about it goes out any more, nor is it in anyone's Activity (as a delete).
    await tx.delete(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, locked.id));
    const forgotten = await forgetArtifactActivity(tx, locked.id);
    return { kind: "done" as const, item: revoked!, changed: true, forgotten };
  }), itemId);
}

/** The home a name is unique in, or null for an orphan (no channel: no name to collide with). */
const nameHomeOf = (item: ArtifactItemRow): ArtifactHomeRef | null => {
  if (item.homeKind !== "conversation") return { kind: item.homeKind };
  return item.homeChannelId ? { kind: "conversation", channelId: item.homeChannelId } : null;
};

/** Undo a takedown (the header's checks and writes). `reason`: takedownReason's. */
export function restoreArtifact(by: ArtifactModerator, itemId: string, reason: string): Promise<ArtifactTakedownOutcome> {
  return run(() => getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
    if (!locked) throw new Refused({ kind: "not_visible" });
    const { actor, ops } = await moderatorOf(tx, by, locked);
    if (locked.revokedAt === null) return { kind: "done" as const, item: locked, changed: false, forgotten: [] };
    const home = nameHomeOf(locked);
    if (locked.deletedAt === null && home && locked.name !== null && (await isNameTakenInHome(tx, locked.serverId, home, locked.name))) {
      throw new Refused({ kind: "name_taken", name: locked.name });
    }

    // Exactly the versions the takedown revoked: the same now() as the item's (compared in the database, to the microsecond).
    const versions = await tx.update(artifactVersions)
      .set({ revokedAt: null, revokedByType: null, revokedById: null })
      .where(and(
        eq(artifactVersions.itemId, locked.id),
        sql`${artifactVersions.revokedAt} = (SELECT i.revoked_at FROM ${artifactItems} i WHERE i.id = ${locked.id})`,
      ))
      .returning({ id: artifactVersions.id });
    const [restored] = await tx.update(artifactItems).set({ revokedAt: null }).where(eq(artifactItems.id, locked.id)).returning();
    await tx.insert(artifactAudit).values({
      itemId: locked.id,
      actorType: actor.type,
      actorId: actor.id,
      action: "restored",
      before: { revoked_at: locked.revokedAt.toISOString() },
      after: { revoked_at: null, reason, versions_restored: versions.length, ...(ops ? { ops } : {}) },
    });
    return { kind: "done" as const, item: restored!, changed: true, forgotten: [] };
  }), itemId);
}

/** The answer of the web routes (and the operator's script). */
export const takedownAnswer = (outcome: Extract<ArtifactTakedownOutcome, { kind: "done" }>): ArtifactWebTakedown => ({
  id: asArtifactId(outcome.item.id),
  takenDown: outcome.item.revokedAt !== null,
  revokedAt: outcome.item.revokedAt?.toISOString() ?? null,
  changed: outcome.changed,
});
