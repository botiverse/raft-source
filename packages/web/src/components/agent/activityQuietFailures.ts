import type { ActivityTurnSummary } from "@botiverse/raft-shared";

/**
 * The turn fields a run is decided on. The overview's TurnSummaryView has
 * them all; kept structural so this module does not import the overview.
 */
export type QuietFailureTurn = Pick<ActivityTurnSummary, "startedAt" | "endedAt" | "outcome" | "toolCalls" | "messagesSent" | "problemCount" | "usageLimit"> & {
  lastReplyMessageId?: string;
  sentMessageIds?: string[];
  hiddenSentCount?: number;
};

export type QuietFailureItem<T> = { kind: "turn"; turn: T } | { kind: "run"; turns: T[] };

/**
 * A turn that failed having done nothing: no tool call, no message, nothing
 * gone wrong along the way. A runtime that cannot start (a used-up quota, a
 * provider outage) makes these one per retry, each its own row otherwise.
 */
export function isQuietFailure(turn: QuietFailureTurn): boolean {
  return turn.outcome === "failed"
    && turn.toolCalls === 0
    && turn.messagesSent === 0
    && !turn.lastReplyMessageId
    && (turn.sentMessageIds?.length ?? 0) === 0
    && (turn.hiddenSentCount ?? 0) === 0
    && turn.problemCount === 0;
}

/**
 * `turns` in order, with each run of two or more quiet failures in a row
 * (isQuietFailure) as one item. Turns that ended on the usage limit and
 * turns that did not are not one run: they say different things.
 */
export function groupQuietFailures<T extends QuietFailureTurn>(turns: readonly T[]): QuietFailureItem<T>[] {
  const items: QuietFailureItem<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length >= 2) items.push({ kind: "run", turns: run });
    else for (const turn of run) items.push({ kind: "turn", turn });
    run = [];
  };
  for (const turn of turns) {
    if (!isQuietFailure(turn)) {
      flush();
      items.push({ kind: "turn", turn });
      continue;
    }
    if (run.length > 0 && Boolean(run[0]!.usageLimit) !== Boolean(turn.usageLimit)) flush();
    run.push(turn);
  }
  flush();
  return items;
}
