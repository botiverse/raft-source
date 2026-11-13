import { TextLink } from "@botiverse/raft-ui";
import type { ToolStuckActivityDiagnostic } from "@botiverse/raft-shared";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import Tooltip from "../ui/Tooltip";
import type { AgentDisplayState } from "../../store/agentStore";

const MINUTE_MS = 60_000;

/**
 * Whole minutes the agent has been quiet on the tool call. `quietSinceMs` is
 * the agent's Computer clock, so a small skew against the browser is expected;
 * it is shown in minutes and never below the reported threshold.
 */
export function toolStuckMinutes(toolStuck: ToolStuckActivityDiagnostic, nowMs: number): number {
  const quietMs = Math.max(nowMs - toolStuck.quietSinceMs, toolStuck.thresholdMs);
  return Math.max(1, Math.floor(quietMs / MINUTE_MS));
}

/**
 * The stuck report to show, if any. A blocked or offline agent's status says
 * that instead, even if a stuck snapshot is still stored.
 */
export function visibleToolStuck(
  toolStuck: ToolStuckActivityDiagnostic | undefined,
  displayState: Pick<AgentDisplayState, "isOnline" | "blocked">,
): ToolStuckActivityDiagnostic | undefined {
  return toolStuck && displayState.isOnline && !displayState.blocked ? toolStuck : undefined;
}

/**
 * The "stuck on <tool> · X min · N waiting" line, re-rendered once a minute
 * while the agent is stuck (no timer otherwise). Null when not stuck.
 */
export function useToolStuckText(toolStuck: ToolStuckActivityDiagnostic | undefined): string | null {
  const { formatMessage } = useIntl();
  // A minute tick only re-renders; the clock is read when rendering.
  const [, setMinuteTick] = useState(0);
  const stuck = toolStuck !== undefined;
  useEffect(() => {
    if (!stuck) return;
    const timer = setInterval(() => setMinuteTick((tick) => tick + 1), MINUTE_MS);
    return () => clearInterval(timer);
  }, [stuck]);
  if (!toolStuck) return null;
  return formatMessage(
    { id: "agent.status.toolStuck" },
    { tool: toolStuck.toolName, minutes: toolStuckMinutes(toolStuck, Date.now()), queued: toolStuck.queuedMessages },
  );
}

/**
 * Task #25 / #triage #36: the agent is stuck on one tool call — no output for
 * the daemon's threshold — so new messages queue behind it. Says so instead of
 * a plain "busy", with how long and how much is waiting, and (for whoever can
 * control the agent) the way out: stop just this turn; the agent stays.
 * This status line is the only place it shows: the owner gets no DM or
 * notification about a stuck tool call.
 */
export function AgentToolStuckNotice({
  toolStuck,
  onStop,
}: {
  toolStuck: ToolStuckActivityDiagnostic;
  /** Stops the current turn. Absent when the viewer can't control this agent. */
  onStop?: () => void;
}) {
  const { formatMessage } = useIntl();
  const text = useToolStuckText(toolStuck);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="agent-tool-stuck">
      <Tooltip content={formatMessage({ id: "agent.status.toolStuckHint" })}>
        <span className="min-w-0 truncate text-footnote text-warning-strong">{text}</span>
      </Tooltip>
      {onStop && (
        <TextLink onClick={onStop} data-testid="agent-tool-stuck-stop">
          {formatMessage({ id: "agent.detail.stopTurn" })}
        </TextLink>
      )}
    </div>
  );
}
