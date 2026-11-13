import { EMPTY_WAKE_CONTINUATION_MS, isEmptyWake, type ActivityTurnSummary, type RunningActivityTurnSummary } from "@botiverse/raft-shared";

/**
 * Task #17: under Claude Code the daemon hears "turn over" at a `result` while
 * the runtime often keeps working (queued notices, background-task reports).
 * A message handed over in that window opens a turn that the next `result`
 * closes about a second later having done nothing, and the real work then
 * runs as a turn of its own with no trigger. The overview shows the two as
 * the one turn they are; the stored rows stay as the daemon wrote them.
 */

type StoredTurn = ActivityTurnSummary & { id: string };

/**
 * Whether work with no trigger of its own that started at `startedAt` is what
 * went on after `wake`: an empty wake (`isEmptyWake`) it follows within
 * EMPTY_WAKE_CONTINUATION_MS. A stored follower starts at its first tool
 * call, a running one earlier (a thinking or progress row the server timed),
 * and daemon and server clocks differ, hence either side of the wake's end.
 */
export function continuesEmptyWake(wake: ActivityTurnSummary, startedAt: number): boolean {
  return isEmptyWake(wake) && Math.abs(startedAt - wake.endedAt) <= EMPTY_WAKE_CONTINUATION_MS;
}

/**
 * A page of finished turns from `rows` (newest first; read `limit + 2` so a
 * pair across the page's end can be joined and whether more follow is
 * known). An empty wake directly followed by a turn with no trigger becomes
 * one turn: the wake's trigger, start and id with the follower's work,
 * outcome, end and last text (the wake's when the follower output none). The
 * id is the wake's, so the turn keeps one identity from the time it runs (see
 * `absorbEmptyWake`). `consumed` is how many rows the
 * page used; the next page starts after them. The follower must start within
 * EMPTY_WAKE_CONTINUATION_MS of the wake's end.
 */
export function pageTurnSummaries<T extends StoredTurn>(rows: readonly T[], limit: number): { summaries: T[]; consumed: number } {
  const summaries: T[] = [];
  let index = 0;
  while (index < limit && index < rows.length) {
    const turn = rows[index]!;
    const older = rows[index + 1];
    if (older && !turn.trigger && continuesEmptyWake(older, turn.startedAt)) {
      summaries.push({ ...turn, id: older.id, startedAt: older.startedAt, trigger: older.trigger, ...lastTextOf(turn, older) });
      index += 2;
    } else {
      summaries.push(turn);
      index += 1;
    }
  }
  return { summaries, consumed: index };
}

/**
 * The joined turn's last text: the work's, else the wake's (a wake that
 * output text, work after it that output none).
 */
export function lastTextOf(work: Pick<ActivityTurnSummary, "lastText">, wake: Pick<ActivityTurnSummary, "lastText">): Pick<ActivityTurnSummary, "lastText"> {
  const lastText = work.lastText ?? wake.lastText;
  return lastText === undefined ? {} : { lastText };
}

/** The turn still running, as the orchestrator folds it from the activity rows. */
export interface RunningTurn {
  turn: RunningActivityTurnSummary;
  /**
   * It opened at runtime output (a tool call or a progress status), not at a
   * message handed over, a start or a recovery: the work the runtime went on
   * with after the daemon took the previous turn as over.
   */
  continuesPreviousTurn: boolean;
}

/** The overview's running turn: the stored id of the empty wake it took over, if any. */
export type CurrentTurn = RunningActivityTurnSummary & { id?: string };

/**
 * When the newest finished turn is an empty wake and the running turn is the
 * work that went on right after it (EMPTY_WAKE_CONTINUATION_MS), the running turn takes the wake's trigger,
 * start and id (and its last text while it has none of its own), and the wake
 * leaves the list. `summaries` is the first page, newest first.
 */
export function absorbEmptyWake<T extends StoredTurn>(
  summaries: readonly T[],
  running: RunningTurn | null,
): { summaries: T[]; current: CurrentTurn | null } {
  if (!running) return { summaries: [...summaries], current: null };
  const newest = summaries[0];
  if (!newest || !running.continuesPreviousTurn || running.turn.trigger || !continuesEmptyWake(newest, running.turn.startedAt)) {
    return { summaries: [...summaries], current: running.turn };
  }
  return {
    summaries: summaries.slice(1),
    current: { ...running.turn, id: newest.id, startedAt: newest.startedAt, trigger: newest.trigger, ...lastTextOf(running.turn, newest) },
  };
}

/** What withRunningTurn reads the running turn from (AgentOrchestrator.getRunningTurn). */
export interface RunningTurnSource {
  getRunningTurn(agentId: string, afterMs: number | null): Promise<RunningTurn | null>;
}

/**
 * The Activity overview's split of an agent's turns (`/activity-summaries`):
 * `finished` is the first page of stored turns (newest first); while the
 * agent is `busy` (its live activity is working or thinking: rows left open
 * by an error or a lost idle are no running turn) the running turn is folded
 * from the rows after the newest finished one and takes over an empty wake it
 * continues (absorbEmptyWake).
 */
export async function withRunningTurn<T extends StoredTurn>(
  source: RunningTurnSource,
  agentId: string,
  finished: readonly T[],
  busy: boolean,
): Promise<{ summaries: T[]; current: CurrentTurn | null }> {
  if (!busy) return { summaries: [...finished], current: null };
  return absorbEmptyWake(finished, await source.getRunningTurn(agentId, finished[0]?.endedAt ?? null));
}
