// Settled (#334; flag artifact_settled_v0, evaluated on the Artifact's own
// server): the one rule the agent API (`POST …/:artifact/settle | unsettle`)
// and the web API (`POST | DELETE /:id/settle`) settle and unsettle by, and
// how the rest of the module reads the state off the item row.
//
// - Settled says an Artifact is done, no longer a draft under discussion. Who
//   may: whoever may comment on it (sees it, may write to it, takes part in
//   it: the callers check, as for a comment). Nothing is locked and no
//   permission changes.
// - The state is on the item (`settled_*`): who, when, and the version that
//   was current then. A new version (publish.ts) leaves those as they are and
//   sets `settled_lapsed_version`, so the Artifact reads as Working again with
//   the settle it ended still known (`reopenedOf`); comments, replies,
//   resolves, renames and a push that changes nothing leave it alone.
//   Settling again overwrites the settle and clears the lapse; unsettling
//   clears everything (one with only a lapsed settle left, too: then quietly,
//   with no event or notice, since it was Working already).
// - In one transaction, the item row locked: already so writes nothing
//   (`changed: false`); otherwise the item, the object event (`settled` or
//   `unsettled`, for its following people, recorded read: it adds no unread
//   and pushes nothing, xxchan's rule: settling asks nothing of anyone), the
//   settler's follow (settling follows it, as commenting does, so its next
//   version reaches them), the settler's push hold (they know it is settled:
//   their own next push isn't held for it) and the notices to its following
//   agents and its agent author (queued, never pushed). After the commit,
//   people's Activity is told (`activity:changed`).
import { and, eq, max } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { announceObjectEvents } from "../../platform/activity";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { currentVersionOf, type ArtifactActorRef, type ArtifactNoticeOutbox } from "./apiCommon";
import { followerRecipients, recordArtifactEvent } from "./events";
import { autoSubscribe, followersOf, noticeSettlement } from "./notices";
import { artifactItems, artifactSettledHolds, artifactVersions, type ArtifactItemRow } from "./schema";
import { settledOf, type SettledState } from "./settledState";

/**
 * Whether `reader` (a push's, publish.ts Publisher.reader) was told of the
 * settle that stands on `item`: its hold row names that settle's time.
 */
export async function toldOfSettle(executor: DatabaseExecutor, reader: ArtifactActorRef, item: ArtifactItemRow, settled: SettledState): Promise<boolean> {
  const [row] = await executor.select({ settledAt: artifactSettledHolds.settledAt }).from(artifactSettledHolds).where(and(
    eq(artifactSettledHolds.itemId, item.id),
    eq(artifactSettledHolds.actorType, reader.type),
    eq(artifactSettledHolds.actorId, reader.id),
  )).limit(1);
  return row !== undefined && row.settledAt.getTime() === settled.at.getTime();
}

/** Record that `reader` was told of this settle (a held push, or its own settle): the same push again goes through. */
export async function recordToldOfSettle(executor: DatabaseExecutor, reader: ArtifactActorRef, itemId: string, settled: SettledState): Promise<void> {
  await executor.insert(artifactSettledHolds)
    .values({ itemId, actorType: reader.type, actorId: reader.id, settledAt: settled.at })
    .onConflictDoUpdate({
      target: [artifactSettledHolds.itemId, artifactSettledHolds.actorType, artifactSettledHolds.actorId],
      set: { settledAt: settled.at, createdAt: currentDate() },
    });
}

/** The number a new version of the item would take now (publish.ts commit: the highest so far, plus one). */
export async function nextVersionNumber(executor: DatabaseExecutor, itemId: string): Promise<number> {
  const [{ last } = { last: 0 }] = await executor.select({ last: max(artifactVersions.number) }).from(artifactVersions).where(eq(artifactVersions.itemId, itemId));
  return (last ?? 0) + 1;
}

export type SettlementOutcome =
  | { kind: "gone" }
  /** No readable current version: nothing to settle at. */
  | { kind: "no_version" }
  | {
    kind: "done";
    /** The item as it stands now. */
    item: ArtifactItemRow;
    changed: boolean;
    newlySubscribed: boolean;
    /** Agents told (queued, never pushed). */
    told: string[];
  };

/**
 * Settle (`settle`) or unsettle the item for `by`, a caller already checked
 * (sees it, may write to it, takes part in it, the flag on), in one
 * transaction with the item row locked (the file's header has the order).
 */
export async function changeSettlement(input: {
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  by: ArtifactActorRef;
  settle: boolean;
}): Promise<SettlementOutcome> {
  const { by, settle } = input;
  const outcome = await getDb().transaction(async (tx): Promise<SettlementOutcome & { eventId?: string }> => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, input.item.id)).for("update");
    if (!locked || locked.deletedAt || locked.revokedAt) return { kind: "gone" };
    const standing = settledOf(locked);
    const unchanged = { kind: "done" as const, item: locked, changed: false, newlySubscribed: false, told: [] };
    if (settle && standing !== null) return unchanged;
    if (!settle && standing === null) {
      if (locked.settledAt === null) return unchanged;
      // Only a lapsed settle is left ("working again"): unsettling clears it. It was Working already, so
      // nothing changes for anyone else: no event, no notice.
      const [cleared] = await tx.update(artifactItems)
        .set({ settledAt: null, settledByType: null, settledById: null, settledVersionNumber: null, settledLapsedVersion: null })
        .where(eq(artifactItems.id, locked.id))
        .returning() as [ArtifactItemRow];
      return { kind: "done", item: cleared, changed: true, newlySubscribed: false, told: [] };
    }

    let version: number;
    let updated: ArtifactItemRow;
    if (settle) {
      const current = await currentVersionOf(locked, tx);
      if (!current) return { kind: "no_version" };
      version = current.number;
      const now = currentDate();
      [updated] = await tx.update(artifactItems)
        .set({ settledAt: now, settledByType: by.type, settledById: by.id, settledVersionNumber: version, settledLapsedVersion: null })
        .where(eq(artifactItems.id, locked.id))
        .returning() as [ArtifactItemRow];
      // The settler knows it is settled: its own next push isn't held for it.
      await recordToldOfSettle(tx, by, locked.id, { by, at: now, version });
    } else {
      version = standing!.version;
      [updated] = await tx.update(artifactItems)
        .set({ settledAt: null, settledByType: null, settledById: null, settledVersionNumber: null, settledLapsedVersion: null })
        .where(eq(artifactItems.id, locked.id))
        .returning() as [ArtifactItemRow];
    }

    // Its people's Activity rows show it, read: a status change asks nothing of anyone.
    const following = await followersOf(tx, locked.id);
    const event = await recordArtifactEvent(tx, {
      item: updated,
      eventKind: settle ? "settled" : "unsettled",
      actor: by,
      // `position`: none of its own (it takes no item position), so a read up to the item's last position covers it.
      data: { position: updated.lastPosition, version },
      recipients: followerRecipients(updated, following).map((recipient) => ({ ...recipient, read: true as const })),
    });
    // Settling follows it, as commenting does (unless the settler stopped following it).
    const newlySubscribed = settle ? await autoSubscribe(tx, locked.id, by, "followed") : false;
    const told = await noticeSettlement({ executor: tx, outbox: input.outbox, item: updated, by, settled: settle, version, following, now: currentDate() });
    return { kind: "done", item: updated, changed: true, newlySubscribed, told, eventId: event.id };
  });
  if (outcome.kind !== "done") return outcome;
  const { eventId, ...done } = outcome;
  if (eventId) await announceObjectEvents([eventId]);
  return done;
}
