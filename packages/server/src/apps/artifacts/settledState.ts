// Settled's state as the item row holds it (#334; the rule is settle.ts):
// a leaf the readers share (cards, summaries, a push's hold), so none of
// them imports the write side. A settle is on the item (`settled_*`): who,
// when, and the version that was current then; `settled_lapsed_version` is
// set by the version that took it back to Working, keeping the settle it
// ended. Whether any of it is shown is the flag artifact_settled_v0 of the
// Artifact's own server.
import { ARTIFACT_SETTLED_FEATURE_FLAG_KEY, type ServerId } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../../platform/db";
import { appEnabled, appEnabledOnCached } from "../../platform/flags";
import type { ArtifactActorRef } from "./apiCommon";
import type { ArtifactItemRow } from "./schema";

/** A settle that stands: who, when, and the version that was current then. */
export interface SettledState {
  by: ArtifactActorRef;
  at: Date;
  version: number;
}

/** Settled on for the Artifact's server (a write's check, read fresh). */
export function settledEnabled(serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return appEnabled(serverId, ARTIFACT_SETTLED_FEATURE_FLAG_KEY, opts);
}

/**
 * Of these servers, those with Settled on, through the short flag cache
 * (platform/flags appEnabledOnCached): for the reads that say whether an
 * Artifact is settled (cards, summaries), never for a write.
 */
export async function settledServers(serverIds: readonly ServerId[]): Promise<ReadonlySet<ServerId>> {
  const distinct = [...new Set(serverIds)];
  if (distinct.length === 0) return new Set();
  const answers = await appEnabledOnCached(distinct, ARTIFACT_SETTLED_FEATURE_FLAG_KEY);
  return new Set(distinct.filter((_, index) => answers[index]));
}

type SettledColumns = Pick<ArtifactItemRow, "settledAt" | "settledByType" | "settledById" | "settledVersionNumber" | "settledLapsedVersion">;

/** The last settle, standing or lapsed; null when there is none. */
function lastSettleOf(item: SettledColumns): SettledState | null {
  if (item.settledAt === null || item.settledByType === null || item.settledById === null || item.settledVersionNumber === null) return null;
  return { by: { type: item.settledByType, id: item.settledById }, at: item.settledAt, version: item.settledVersionNumber };
}

/** The settle that stands now (no new version since it); null while the Artifact is Working. */
export function settledOf(item: SettledColumns): SettledState | null {
  return item.settledLapsedVersion === null ? lastSettleOf(item) : null;
}

/** Working again: the version that took it back, and the settle it ended; null otherwise. */
export function reopenedOf(item: SettledColumns): { version: number; was: SettledState } | null {
  const was = lastSettleOf(item);
  return was && item.settledLapsedVersion !== null ? { version: item.settledLapsedVersion, was } : null;
}
