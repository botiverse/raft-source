import { AGENT_TURN_ENDED_MAX_SHOWN_TARGETS, type AgentTurnEndedOutcome } from "@botiverse/raft-shared";
import type { UnowedReadBacklogTarget } from "./unowedReadBacklog";

/** The unread summary a start showed: target -> the conversations behind it and their latest seq then. */
export type UnreadSummarySnapshotTargets = ReadonlyMap<string, ReadonlyArray<{ channelId: string; latestSeq: number }>>;

/** The snapshot of a capped unread summary: only targets it names (its folded "more" line names no conversation). */
export function snapshotForUnreadSummary(
  summaryTargets: UnreadSummarySnapshotTargets,
  unreadSummary: Readonly<Record<string, number>>,
): UnreadSummarySnapshotTargets {
  return new Map([...summaryTargets].filter(([target]) => Object.hasOwn(unreadSummary, target)));
}

/**
 * What a completed turn may settle: the reported targets the snapshot also
 * holds, each up to the seq the snapshot recorded. The report never widens it.
 */
export function shownSnapshotTargets(
  snapshotTargets: UnreadSummarySnapshotTargets,
  shownUnreadTargets: readonly string[],
): { targets: UnowedReadBacklogTarget[]; shownCount: number; ignoredCount: number } {
  const shown = shownUnreadTargets.slice(0, AGENT_TURN_ENDED_MAX_SHOWN_TARGETS);
  const targets: UnowedReadBacklogTarget[] = [];
  let ignored = 0;
  for (const target of new Set(shown)) {
    const conversations = snapshotTargets.get(target);
    if (!conversations) {
      ignored += 1;
      continue;
    }
    for (const conversation of conversations) targets.push({ channelId: conversation.channelId, throughSeq: conversation.latestSeq });
  }
  return { targets, shownCount: shown.length, ignoredCount: ignored };
}

/** Past this a launch's first turn is not "the turn that saw the summary" any more. */
export const TURN_END_UNREAD_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export type TurnEndUnreadTake =
  | { kind: "no_snapshot" }
  | { kind: "stale_launch" }
  | { kind: "expired" }
  | { kind: "not_completed" }
  | { kind: "settle"; targets: UnowedReadBacklogTarget[]; shownCount: number; ignoredCount: number };

/**
 * Per agent, the unread summary its current launch's start showed, kept until
 * that launch's first turn ends. In memory only: a restart or a launch that
 * reports to another replica finds nothing, and nothing is settled.
 */
export class TurnEndUnreadSnapshots {
  private readonly byAgent = new Map<string, { launchId: string; targets: UnreadSummarySnapshotTargets; recordedAtMs: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = TURN_END_UNREAD_SNAPSHOT_TTL_MS,
  ) {}

  /** A new start replaces whatever the previous launch left. */
  record(agentId: string, launchId: string | undefined, targets: UnreadSummarySnapshotTargets): void {
    if (!launchId || targets.size === 0) {
      this.byAgent.delete(agentId);
      return;
    }
    this.byAgent.set(agentId, { launchId, targets, recordedAtMs: this.now() });
  }

  /**
   * The launch's first `agent:turn:ended`. A frame from another launch leaves
   * the snapshot alone; the matching one consumes it whatever its outcome, and
   * only `completed` yields targets: the shown targets the snapshot also holds,
   * each up to the seq the snapshot recorded. The daemon's list never widens it.
   */
  take(agentId: string, frame: { launchId: string; outcome: AgentTurnEndedOutcome; shownUnreadTargets: readonly string[] }): TurnEndUnreadTake {
    const snapshot = this.byAgent.get(agentId);
    if (!snapshot) return { kind: "no_snapshot" };
    if (snapshot.launchId !== frame.launchId) return { kind: "stale_launch" };
    this.byAgent.delete(agentId);
    if (this.now() - snapshot.recordedAtMs > this.ttlMs) return { kind: "expired" };
    if (frame.outcome !== "completed") return { kind: "not_completed" };
    return { kind: "settle", ...shownSnapshotTargets(snapshot.targets, frame.shownUnreadTargets) };
  }

  clear(agentId: string): void {
    this.byAgent.delete(agentId);
  }
}
