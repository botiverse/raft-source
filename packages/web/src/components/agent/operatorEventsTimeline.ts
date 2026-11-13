import type { IntlShape } from "react-intl";
import type { AgentOperatorEventView } from "@botiverse/raft-shared";

/**
 * #proj-runtime:#51: what people did to the agent (start, stop, restart,
 * reset, Stop Current Turn, migration, model change), and Raft's own
 * restarts, as thin system lines between the overview's turns (design A,
 * xxchan #proj-runtime:d9875bae). Three or more in a row fold into one line.
 * Raft's own restarts are fainter and name no one.
 */

/** Runs of this many lines or more fold into one disclosure. */
export const OPERATOR_EVENTS_FOLD_AT = 3;

export function operatorEventText(intl: IntlShape, event: AgentOperatorEventView): string {
  const actor = event.actor.kind === "user"
    ? event.actor.name ?? intl.formatMessage({ id: "activity.overview.operator.someone" })
    : "";
  const details = event.details ?? {};
  switch (event.kind) {
    case "start": return intl.formatMessage({ id: "activity.overview.operator.start" }, { actor });
    case "stop": return intl.formatMessage({ id: "activity.overview.operator.stop" }, { actor });
    case "restart": return intl.formatMessage({ id: "activity.overview.operator.restart" }, { actor });
    case "reset_session": return intl.formatMessage({ id: "activity.overview.operator.resetSession" }, { actor });
    case "reset_full": return intl.formatMessage({ id: "activity.overview.operator.resetFull" }, { actor });
    case "turn_stopped": return intl.formatMessage({ id: "activity.overview.operator.turnStopped" }, { actor });
    case "migration_started":
      return details.fromComputer && details.toComputer
        ? intl.formatMessage({ id: "activity.overview.operator.migrationStartedTo" }, { actor, from: details.fromComputer, to: details.toComputer })
        : intl.formatMessage({ id: "activity.overview.operator.migrationStarted" }, { actor });
    case "migration_cancelled": return intl.formatMessage({ id: "activity.overview.operator.migrationCancelled" }, { actor });
    case "config_changed":
      if (details.afterModel !== undefined && details.beforeModel !== undefined) {
        return intl.formatMessage({ id: "activity.overview.operator.modelChanged" }, { actor, before: details.beforeModel, after: details.afterModel });
      }
      if (details.afterRuntime !== undefined && details.beforeRuntime !== undefined) {
        return intl.formatMessage({ id: "activity.overview.operator.runtimeChanged" }, { actor, before: details.beforeRuntime, after: details.afterRuntime });
      }
      return intl.formatMessage({ id: "activity.overview.operator.configChanged" }, { actor });
    case "system_restart": return intl.formatMessage({ id: "activity.overview.operator.systemRestart" });
  }
}

export type OverviewSegment<T> =
  | { kind: "turns"; turns: T[] }
  | { kind: "events"; events: AgentOperatorEventView[] };

/**
 * Turns (oldest first) and events (any order) as segments in time order:
 * each run of events sits before the first turn that started after it.
 * Events after the last turn come back in `after`, for the caller to place
 * before or after the running turn.
 */
export function interleaveOperatorEvents<T extends { startedAt: number }>(
  turns: readonly T[],
  events: readonly AgentOperatorEventView[],
): { segments: OverviewSegment<T>[]; after: AgentOperatorEventView[] } {
  const pending = [...events].sort((a, b) => a.at - b.at);
  const segments: OverviewSegment<T>[] = [];
  let index = 0;
  for (const turn of turns) {
    const before: AgentOperatorEventView[] = [];
    while (index < pending.length && pending[index]!.at < turn.startedAt) before.push(pending[index++]!);
    if (before.length > 0) segments.push({ kind: "events", events: before });
    const last = segments[segments.length - 1];
    if (last?.kind === "turns") last.turns.push(turn);
    else segments.push({ kind: "turns", turns: [turn] });
  }
  return { segments, after: pending.slice(index) };
}
