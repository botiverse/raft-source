import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { Badge, Card, CardContent, OtterIndicator, Text } from "@botiverse/raft-ui";
import { useAgentCurrentActivityState } from "../../store/agentStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import SectionEyebrow from "../ui/SectionEyebrow";
import { formatActivityText } from "../../utils/activity";
import { calendarDayKey } from "../../utils/timeFormatting";
import { formatTurnActions, formatTurnDuration, turnProblemCount } from "./AgentActivityOverview";
import type { RunningTurnView, TurnSummaryView } from "./AgentActivityOverview";
import { formatCompactTrigger } from "./compactTrigger";

/**
 * A clock time today, else a short date and time: a turn three days ago is
 * not "15:53". "Today" is the viewer's chosen time zone's, as the times are.
 */
function useTurnTime(): (ms: number) => string {
  const { formatClock, formatShortDateTime, options } = useTimeFormatter();
  return (ms) => (calendarDayKey(new Date(ms), options) === calendarDayKey(new Date(), options) ? formatClock(ms) : formatShortDateTime(ms));
}

/** Milliseconds since `startedAt`, counting each second while `active`. */
function useElapsed(startedAt: number | undefined, active: boolean): number {
  // A second tick only re-renders; the clock is read when rendering.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return startedAt === undefined ? 0 : Date.now() - startedAt;
}

/**
 * What the agent is doing now, in words, then who the running (else the last)
 * turn answers and what it has done; the profile adds its last turns, one line
 * each, and a way to the Activity tab (xxchan, 2026-11-05).
 *
 * `status` is the agent's status as the profile shows it (AgentStatusBadge:
 * every state it resolves, blocked, external, a stuck tool call and its Stop);
 * without it (the Activity overview) the card says the state itself.
 */
export function AgentNowCard({ agentId, turns, running, status, onOpenActivity, recentRows = 0 }: {
  agentId: string;
  /** Finished turns, newest first. */
  turns: readonly TurnSummaryView[];
  running: RunningTurnView | null;
  status?: ReactNode;
  onOpenActivity?: () => void;
  /** How many finished turns to list under it (the profile); none on the overview. */
  recentRows?: number;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const turnTime = useTurnTime();
  const current = useAgentCurrentActivityState(agentId);
  const activity = current?.activity ?? "offline";
  const busy = activity === "working" || activity === "thinking";
  const last = turns[0];
  // The running turn's endedAt is when the server read it: the card counts on from its start.
  const elapsed = useElapsed(running?.startedAt, !status && busy && running !== null);
  const headline = busy && running
    ? formatMessage({ id: "agent.now.workingFor" }, { state: formatMessage({ id: "activity.log.status.working" }), duration: formatTurnDuration(formatMessage, elapsed) })
    : activity === "online" && last
      ? formatMessage({ id: "agent.now.lastEnded" }, { state: formatMessage({ id: "activity.log.status.idle" }), time: turnTime(last.endedAt) })
      // Any other state reads as the overview always read it (a sign-in, a crash, a limit).
      : formatActivityText(formatMessage, activity, current?.activityDetail, current?.detailKind, current?.errorCode);
  const focus = running ?? last;
  const focusLine = focus
    ? formatMessage({ id: running ? "agent.now.thisTurn" : "agent.now.lastTurn" }, {
      trigger: <span key="trigger">{formatCompactTrigger(formatMessage, focus.trigger) ?? formatMessage({ id: "agent.now.trigger.unknown" })}</span>,
      actions: formatTurnActions(intl, focus.actions, focus.messagesSent),
    })
    : null;
  const rows = recentRows > 0 ? turns.slice(running ? 0 : 1, (running ? 0 : 1) + recentRows) : [];
  return (
    <Card data-testid="agent-now-card">
      <CardContent className="flex flex-col gap-3 py-4">
        {onOpenActivity ? (
          <SectionEyebrow
            as="button"
            onClick={onOpenActivity}
            data-testid="agent-now-open-activity"
            className="flex items-center gap-0.5 self-start rounded-[2px] outline-none hover:text-foreground hover:underline hover:decoration-[1.5px] hover:underline-offset-[3px] focus-visible:shadow-focus"
          >
            {formatMessage({ id: "activity.preview.recentActivity" })}
            <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
          </SectionEyebrow>
        ) : null}
        <div className="flex items-center gap-3">
          <OtterIndicator status={busy ? "process" : activity === "error" ? "error" : "wait"} width={40} height={40} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {status ? (
              <div className="min-w-0" data-testid="agent-now-status">{status}</div>
            ) : (
              <Text.Heading className="text-subhead font-bold tracking-normal" data-testid="agent-now-headline">{headline}</Text.Heading>
            )}
            {/* The step it is on: the status chip says it when there is one, and without a running turn the headline already does. */}
            {!status && busy && running && current?.activityDetail
              ? <Text.Sans className="truncate text-callout text-foreground" data-testid="agent-now-step">{formatActivityText(formatMessage, activity, current.activityDetail, current.detailKind)}</Text.Sans>
              : null}
            {focusLine ? <Text.Sans className="truncate text-callout text-foreground-muted" data-testid="agent-now-focus">{focusLine}</Text.Sans> : null}
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="stack-y-1.5 border-t border-line-hairline pt-3">
            {rows.map((turn) => <RecentTurnRow key={turn.id ?? `${turn.startedAt}`} turn={turn} turnTime={turnTime} />)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The overview's badges for a finished turn, compact: how it ended, and that it sent nothing. */
function TurnRowBadges({ turn }: { turn: TurnSummaryView }) {
  const { formatMessage } = useIntl();
  const problems = turnProblemCount(turn);
  return (
    <>
      {turn.outcome === "failed" ? (
        <Badge variant="warning" appearance="soft" className="shrink-0">{formatMessage({ id: "activity.overview.outcome.failed" })}</Badge>
      ) : turn.outcome === "completed" && problems > 0 ? (
        <Badge variant="warning" appearance="soft" className="shrink-0">{formatMessage({ id: "activity.overview.outcome.completedWithProblems" }, { count: problems })}</Badge>
      ) : turn.outcome !== "completed" ? (
        <Badge variant="muted" appearance="soft" className="shrink-0">{formatMessage({ id: turn.outcome === "interrupted" ? "activity.overview.outcome.interrupted" : "activity.overview.outcome.unknown" })}</Badge>
      ) : null}
      {!turn.lastReplyMessageId ? (
        <Badge variant="muted" appearance="soft" className="shrink-0">{formatMessage({ id: "activity.overview.outcome.noMessage" })}</Badge>
      ) : null}
    </>
  );
}

function RecentTurnRow({ turn, turnTime }: { turn: TurnSummaryView; turnTime: (ms: number) => string }) {
  const intl = useIntl();
  const trigger = formatCompactTrigger(intl.formatMessage, turn.trigger);
  return (
    <div data-testid="agent-now-row" className="flex min-w-0 items-center gap-2 overflow-hidden text-callout">
      <span className="shrink-0 whitespace-nowrap font-mono text-mono-meta text-foreground-hint">{turnTime(turn.startedAt)}</span>
      {trigger ? <span className="max-w-[45%] shrink-0 truncate text-foreground">{trigger}</span> : null}
      <span className="min-w-0 flex-1 truncate text-foreground-muted">{formatTurnActions(intl, turn.actions, turn.messagesSent)}</span>
      <TurnRowBadges turn={turn} />
    </div>
  );
}
