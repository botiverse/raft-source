import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { AlertTriangle, AppWindow, FlaskConical, History, MessageSquareDashed } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  IconTile,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowMeta,
  ListRowTitle,
  ListRowTop,
  Status,
  Text,
  TextLink,
  PanelScrollViewport,
} from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import type { Presence } from "@botiverse/raft-ui";
import { Ellipsis } from "@botiverse/raft-ui/wip";
import type {
  ActivityActionKind,
  ActivityTurnAppEventsView,
  ActivityTurnAppEventView,
  ActivityTurnSummary,
  ActivityTurnTrigger,
  ActivityTurnTriggerAppEvent,
  ActivityTurnTriggerDisplay,
  AgentOperatorEventsPage,
  AgentOperatorEventView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import type { Message } from "../../store/messageStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useOpenMessage } from "../../hooks/useOpenMessage";
import { registerActivityTrajectoryLiveReload, registerActivityTrajectoryReconnectReload } from "../../utils/activityTrajectoryRecovery";
import EmptyState from "../ui/EmptyState";
import { RefText } from "./RefText";
import { AgentNowCard } from "./AgentNowCard";
import { TurnsWithQuietFailureRuns } from "./ActivityQuietFailureRuns";
import { OperatorEventLines } from "./ActivityOperatorEvents";
import { interleaveOperatorEvents } from "./operatorEventsTimeline";
import type { MessageId } from "../../i18n/messages";
import InlineMarkdownPreview from "../markdown/InlineMarkdownPreview";
import { ConnectedAppLogo } from "../settings/ConnectedAppLogo";
import { readHistoryLimitedError } from "../../store/hiddenHistoryStore";
import { OlderMessageNotice } from "../message/HistoryWindowNotices";

/**
 * A turn as the server returns it: a trigger the viewer cannot see comes back
 * hidden. Servers that list app events add the ones delivered in the turn
 * (`appEvents`, `appEventCount`) and name the one that woke it
 * (`trigger.appEvent`); older servers send neither. Newer servers also name
 * a visible trigger's place and sender from their own records
 * (`trigger.display`), and return one those records do not bear out as
 * `unresolved`; with neither (an older server) the trigger's own text is read.
 */
export type TurnSummaryView = Omit<ActivityTurnSummary, "trigger"> & ActivityTurnAppEventsView & {
  /** Row id from the server (absent from older servers). */
  id?: string;
  trigger?:
    | (ActivityTurnTrigger & { hidden?: undefined; unresolved?: undefined; appEvent?: ActivityTurnTriggerAppEvent; display?: ActivityTurnTriggerDisplay })
    | { hidden: "private_channel" | "dm"; unresolved?: undefined }
    | { unresolved: true; hidden?: undefined };
  /** Every message the turn sent that the viewer can see, in order (servers that list them). */
  sentMessageIds?: string[];
  /** How many the viewer can see (the id list is capped). */
  sentMessageCount?: number;
  /** Messages the turn sent where the viewer cannot see: counted, never named. */
  hiddenSentCount?: number;
};

/**
 * The turn still running (`current` on the first page, servers that fold
 * it): no outcome yet, and `endedAt` is when the server read it. When it is
 * the work that went on after an empty wake, `id` is that wake's row id and
 * the wake is not listed among the finished turns.
 */
export type RunningTurnView = Omit<TurnSummaryView, "outcome"> & { running: true };
type TurnProblem = ActivityTurnSummary["problems"][number];

/**
 * A command that exits non-zero (failing tests included) is ordinary
 * development (run, see the error, fix), not a step that went wrong (Tenny
 * for tests, xxchan for every command). Only a tool call that itself failed
 * counts.
 */
export function countsAsProblem(problem: TurnProblem): boolean {
  return problem.reason !== "exit_nonzero" && !isRoutineHold(problem);
}

/**
 * A send held until the agent reads newer messages is the normal flow, not
 * something that went wrong: the overview neither shows nor counts it
 * (xxchan). Older summaries still record it.
 */
function isRoutineHold(problem: TurnProblem): boolean {
  return problem.reason === "send_held";
}

/**
 * The problems the overview lists. A plain command's non-zero exit is not one
 * of them: an exit code (mostly grep finding nothing) tells a reader nothing
 * (xxchan); the raw log keeps it. Failing tests or checks stay, as process
 * information.
 */
function isListedProblem(problem: TurnProblem): boolean {
  return !isRoutineHold(problem) && !(problem.reason === "exit_nonzero" && problem.kind !== "run_checks");
}

/**
 * Only the listed problems that count. The list is capped (shared
 * ACTIVITY_TURN_PROBLEM_LIMIT), and what lies past the cap is of unknown kind,
 * mostly non-zero exits from a loop of runs: it is not counted as gone wrong.
 */
export function turnProblemCount(turn: Pick<TurnSummaryView, "problems">): number {
  return turn.problems.filter(countsAsProblem).length;
}

function turnKey(turn: TurnSummaryView): string {
  return turn.id ?? `${turn.startedAt}-${turn.endedAt}`;
}

/** Newest first in the server's page order (ended, then id), each turn once, whichever page it came from. */
function mergeTurnPages(...pages: TurnSummaryView[][]): TurnSummaryView[] {
  const byKey = new Map<string, TurnSummaryView>();
  for (const page of pages) for (const turn of page) if (!byKey.has(turnKey(turn))) byKey.set(turnKey(turn), turn);
  return [...byKey.values()].sort((a, b) => b.endedAt - a.endedAt || (turnKey(b) > turnKey(a) ? 1 : turnKey(b) < turnKey(a) ? -1 : 0));
}

/** The turn at the top of the view and how far below the view's top it starts. */
interface ReadingAnchor {
  key: string;
  offset: number;
}

/** How close to the bottom still counts as "at the bottom" for following new turns. */
const NEAR_BOTTOM_PX = 80;

export interface SummaryPage {
  summaries: TurnSummaryView[];
  next?: string;
  current?: RunningTurnView;
}

const PAGE_SIZE = 30;

export function formatTurnDuration(formatMessage: IntlShape["formatMessage"], ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return formatMessage({ id: "activity.overview.duration.seconds" }, { seconds: totalSeconds });
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return formatMessage({ id: "activity.overview.duration.minutes" }, { minutes: totalMinutes, seconds: totalSeconds % 60 });
  return formatMessage({ id: "activity.overview.duration.hours" }, { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 });
}

/**
 * Who woke the turn, in words a person reads: "replying to @Tenny in
 * #proj-runtime" (the channel a link, as in the raw log), a thread in a
 * channel, a DM from someone, or only the kind of place when the viewer
 * cannot see it.
 */
export function formatTurnTrigger(formatMessage: IntlShape["formatMessage"], trigger: TurnSummaryView["trigger"]): ReactNode | null {
  if (!trigger) return null;
  if (trigger.hidden !== undefined) {
    return formatMessage({ id: trigger.hidden === "dm" ? "activity.overview.trigger.dm" : "activity.overview.trigger.privateChannel" });
  }
  // The server could not match the trigger to its channel and message: none of the producer's text.
  if (trigger.unresolved) return formatMessage({ id: "activity.overview.trigger.unresolved" });
  if (trigger.display) return formatTriggerDisplay(formatMessage, trigger.display);
  const target = trigger.target;
  if (!target) return null;
  if (target.startsWith("agent-event:")) {
    // Pruned or ambiguous events, and older servers, keep the generic sentence.
    if (!trigger.appEvent) return formatMessage({ id: "activity.overview.trigger.appEvent" });
    const { appName, summary } = trigger.appEvent;
    // Cut by CSS at the line's end, never mid-character; the whole summary
    // stays in the DOM (screen readers) and in the turn's list of app events,
    // which shows it in full (touch and keyboard). The title is for hovering.
    return formatMessage({ id: "activity.overview.trigger.appEventFrom" }, {
      app: appName,
      summary: (
        <span key="summary" title={summary} className="inline-block max-w-full truncate align-bottom" data-testid="activity-overview-trigger-app-summary">
          {summary}
        </span>
      ),
    });
  }
  // An older server: the producer's own text.
  const sender = trigger.sender ? `@${trigger.sender}` : null;
  const dm = /^dm:(@[^:]+)/.exec(target);
  if (dm) return formatMessage({ id: "activity.overview.trigger.dmFrom" }, { peer: dm[1] });
  const [channelName, threadShortId] = target.split(":");
  const channel = <RefText key="channel" text={channelName ?? target} />;
  if (!sender) return formatMessage({ id: "activity.overview.trigger.target" }, { channel });
  return formatMessage({ id: threadShortId ? "activity.overview.trigger.thread" : "activity.overview.trigger.message" }, { sender, channel });
}

/** The trigger sentence from the server's names (`trigger.display`). */
function formatTriggerDisplay(formatMessage: IntlShape["formatMessage"], display: ActivityTurnTriggerDisplay): ReactNode {
  if (display.kind === "dm") {
    const peer = display.senderName ?? display.peerName;
    return peer
      ? formatMessage({ id: "activity.overview.trigger.dmFrom" }, { peer: `@${peer}` })
      : formatMessage({ id: "activity.overview.trigger.dm" });
  }
  const channel = <RefText key="channel" text={`#${display.channelName}`} />;
  if (!display.senderName) return formatMessage({ id: "activity.overview.trigger.target" }, { channel });
  return formatMessage(
    { id: display.kind === "thread" ? "activity.overview.trigger.thread" : "activity.overview.trigger.message" },
    { sender: `@${display.senderName}`, channel },
  );
}

/**
 * "02:38–02:44" from two clock strings: one time when both are the same
 * minute, and a shared day-period word ("上午", "AM") written once.
 */
export function formatClockRange(start: string, end: string): { start: string; end?: string } {
  if (start === end) return { start };
  const prefix = /^\D+/.exec(start)?.[0];
  if (prefix && end.startsWith(prefix)) return { start, end: end.slice(prefix.length) };
  const suffix = /\D+$/.exec(start)?.[0];
  if (suffix && end.endsWith(suffix)) return { start: start.slice(0, -suffix.length), end };
  return { start, end };
}

/** "ran 3 commands, read a file" from the turn's action counts (fixed wording per kind). */
export function formatTurnActions(intl: IntlShape, actions: ActivityTurnSummary["actions"], messagesSent = 0): string {
  if (actions.length === 0) return intl.formatMessage({ id: "activity.overview.actions.none" });
  // One send command can post several messages (xxchan): count what was sent, not the commands.
  const parts = actions.map(({ kind, count }) => intl.formatMessage(
    { id: `activity.overview.action.${kind satisfies ActivityActionKind}` as MessageId },
    { count: kind === "send_message" && messagesSent > 0 ? messagesSent : count },
  ));
  return intl.formatList(parts, { type: "conjunction" }) as string;
}

/** The status chip's square pixel (DS StatusChip: a word plus its fixed
 *  status colour): raft-ui Status with the outcome's presence light. */
function OutcomePixel({ presence }: { presence: Presence }) {
  return <Status aria-hidden="true" presence={presence} />;
}

/**
 * Only a turn that needs a look gets a badge (Tenny, #proj-runtime:9b526607):
 * a plain finished turn has none, since "Done" read as "the work is done" when
 * it only meant "this turn ended". Steps that went wrong, an error ending, a
 * stop or an unknown ending get their own badge; a turn that sent nothing gets
 * a muted one.
 */
function TurnBadges({ turn }: { turn: TurnSummaryView | RunningTurnView }) {
  const { formatMessage } = useIntl();
  if ("running" in turn) {
    return (
      <Badge variant="busy" appearance="soft" data-testid="activity-overview-running">
        <OutcomePixel presence="busy" />
        {formatMessage({ id: "activity.overview.outcome.running" })}
      </Badge>
    );
  }
  const problems = turnProblemCount(turn);
  const badges: ReactNode[] = [];
  if (turn.outcome === "completed" && problems > 0) {
    // Steps that went wrong along the way are not a failed turn: amber, not red (Tenny).
    badges.push(
      <Badge key="outcome" variant="warning" appearance="soft">
        <OutcomePixel presence="error" />
        {formatMessage({ id: "activity.overview.outcome.completedWithProblems" }, { count: problems })}
      </Badge>,
    );
  } else if (turn.outcome === "failed") {
    // A problem, not an irreversible consequence: orange (DS rule 5), never red.
    badges.push(
      <Badge key="outcome" variant="warning" appearance="soft">
        <OutcomePixel presence="error" />
        {formatMessage({ id: "activity.overview.outcome.failed" })}
      </Badge>,
    );
  } else if (turn.outcome !== "completed") {
    badges.push(
      <Badge key="outcome" variant="muted" appearance="soft">
        <OutcomePixel presence="offline" />
        {formatMessage({ id: turn.outcome === "interrupted" ? "activity.overview.outcome.interrupted" : "activity.overview.outcome.unknown" })}
      </Badge>,
    );
  }
  if (!turn.lastReplyMessageId) {
    badges.push(
      <Badge key="no-message" variant="muted" appearance="soft" data-testid="activity-overview-no-message">
        {formatMessage({ id: "activity.overview.outcome.noMessage" })}
      </Badge>,
    );
  }
  return <>{badges}</>;
}

function ProblemLine({ problem }: { problem: TurnProblem }) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const time = formatClock(problem.at);
  // A test run that reports failures is ordinary work, not an agent error: lighter wording (Tenny).
  const text = problem.reason === "exit_nonzero" && problem.kind === "run_checks"
    ? formatMessage({ id: "activity.overview.problem.checksFailed" }, { time })
    : formatMessage({ id: "activity.overview.problem.callFailed" }, { time });
  return (
    <div className="flex items-center gap-1.5 text-caption text-foreground-muted" data-testid="activity-overview-problem">
      {countsAsProblem(problem)
        ? <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-warning-strong" />
        : <FlaskConical size={14} aria-hidden="true" className="shrink-0 text-foreground-hint" />}
      <span>{text}</span>
    </div>
  );
}

/**
 * The last text the runtime output in the turn (`lastText`): the agent's own
 * account of what it did and why, which went to no one (xxchan). It must
 * never read as a message: no card (the turn's messages are cards), a dashed
 * message icon before it, and the text in the muted tier, two lines at most
 * until clicked (raft-ui Ellipsis `expandOnClick`: the cut text is the button
 * that shows the rest, for touch and keyboard too). No visible label: the
 * icon and tier say enough (xxchan); screen readers still hear that it was
 * not sent. Plain text, line breaks kept: it is not rendered as Markdown.
 */
function TurnOutput({ text }: { text: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-callout" data-testid="activity-overview-output">
      <MessageSquareDashed size={14} aria-hidden="true" className="mt-[calc((1lh-14px)/2)] shrink-0 text-foreground-hint" />
      <span className="sr-only">{formatMessage({ id: "activity.overview.output.label" })}</span>
      <Ellipsis lines={2} expandOnClick tooltip={false} className="min-w-0 flex-1 whitespace-pre-line break-words text-callout text-foreground-muted" data-testid="activity-overview-output-text">
        {text}
      </Ellipsis>
    </div>
  );
}

/** "older": behind the plan's history window, so it says that rather than "unavailable". */
type ReplyState = { status: "loading" } | { status: "loaded"; message: Message } | { status: "unavailable" } | { status: "older" };

/** The turn's last reply, fetched by id under the message's own permissions. */
function LastReply({ messageId, count }: { messageId: string; count: number }) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const [state, setState] = useState<ReplyState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void api.get(`/messages/context/${messageId}`, { params: { before: 0, after: 0 } })
      .then(({ data }) => {
        if (cancelled) return;
        const payload = data as { messages?: Message[]; targetMessageId?: string };
        const target = (payload.messages ?? []).find((message) => message.id === (payload.targetMessageId ?? messageId));
        setState(target ? { status: "loaded", message: target } : { status: "unavailable" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: readHistoryLimitedError(error) ? "older" : "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const label = state.status === "loaded"
    ? formatMessage({ id: "activity.overview.reply.labelAt" }, { time: formatClock(state.message.createdAt) })
    : formatMessage({ id: "activity.overview.reply.label" });
  return (
    <Card className="flex flex-col gap-1 p-3" data-testid="activity-overview-reply">
      <span className="flex items-center gap-1 text-caption text-foreground-hint">
        <MessageIcon width={14} height={14} aria-hidden="true" className="shrink-0" />
        {label}
        {count > 1 ? <span>{formatMessage({ id: "activity.overview.reply.count" }, { count })}</span> : null}
      </span>
      <span className="line-clamp-3 break-words text-callout text-foreground">
        {state.status === "loaded"
          ? <InlineMarkdownPreview markdown={state.message.content} />
          : state.status === "older" ? <OlderMessageNotice surface="agent_activity" testId="activity-overview-reply-older" />
          : formatMessage({ id: state.status === "loading" ? "activity.overview.reply.loading" : "activity.overview.reply.unavailable" })}
      </span>
    </Card>
  );
}

const EMPTY_IDS: readonly string[] = [];

/**
 * The exact waking message, a link in the trigger sentence. It opens where the
 * message is read (useOpenMessage): a thread reply in its parent channel with
 * the thread open, a task message in the task's conversation (#triage:#107).
 */
function TriggerMessageLink({ channelId, messageId }: { channelId: string; messageId: string }) {
  const { formatMessage } = useIntl();
  const openMessage = useOpenMessage();
  const open = useCallback(() => { void openMessage(channelId, messageId); }, [channelId, messageId, openMessage]);
  return (
    <TextLink variant="strong" data-testid="activity-overview-trigger-open" onClick={open}>
      {formatMessage({ id: "activity.overview.trigger.open" })}
    </TextLink>
  );
}

/** How many sent messages show before "Show N more". */
const SENT_MESSAGES_SHOWN = 3;

/**
 * One message the turn sent, fetched by id under its own permissions: a
 * compact list row like an app event, not a card, so a turn that sent a few
 * messages stays short (xxchan). The time, then the message at footnote size
 * cut to two lines; the whole row opens the message. The clamp is visual
 * only: the hover title keeps the whole message.
 */
function SentMessageRow({ messageId }: { messageId: string }) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const openMessage = useOpenMessage();
  const [state, setState] = useState<ReplyState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void api.get(`/messages/context/${messageId}`, { params: { before: 0, after: 0 } })
      .then(({ data }) => {
        if (cancelled) return;
        const payload = data as { messages?: Message[]; targetMessageId?: string };
        const target = (payload.messages ?? []).find((message) => message.id === (payload.targetMessageId ?? messageId));
        setState(target ? { status: "loaded", message: target } : { status: "unavailable" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: readHistoryLimitedError(error) ? "older" : "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);
  const loaded = state.status === "loaded" ? state.message : null;
  const open = useCallback(() => {
    if (loaded) void openMessage(loaded.channelId, loaded.id);
  }, [loaded, openMessage]);
  return (
    <li>
      <ListRow
        variant="plain"
        interactive={loaded !== null}
        onClick={loaded ? open : undefined}
        className="items-start gap-2 px-3 py-2 [--list-row-rule-start:12px]"
        data-testid="activity-overview-sent-message"
      >
        <MessageIcon width={14} height={14} aria-hidden="true" className="mt-0.5 shrink-0 text-foreground-hint" />
        <ListRowBody>
          <ListRowDescription wrap className="line-clamp-2 text-footnote text-foreground" title={loaded?.content}>
            {loaded
              ? <InlineMarkdownPreview markdown={loaded.content} />
              : state.status === "older" ? <OlderMessageNotice surface="agent_activity" testId="activity-overview-sent-older" withIcon={false} />
              : formatMessage({ id: state.status === "loading" ? "activity.overview.reply.loading" : "activity.overview.reply.unavailable" })}
          </ListRowDescription>
        </ListRowBody>
        {loaded ? <ListRowMeta className="shrink-0">{formatClock(loaded.createdAt)}</ListRowMeta> : null}
      </ListRow>
    </li>
  );
}

/** Every message the turn sent (xxchan), the first few shown and the rest a click away. */
function SentMessages({ ids, visible, hidden }: { ids: readonly string[]; visible: number; hidden: number }) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const shown = expanded ? ids : ids.slice(0, SENT_MESSAGES_SHOWN);
  return (
    <div className="flex flex-col gap-2" data-testid="activity-overview-sent">
      {/* No title: the actions line above already says how many it sent (xxchan). */}
      <ListRowGroup render={<ul />}>
        {shown.map((id) => <SentMessageRow key={id} messageId={id} />)}
      </ListRowGroup>
      {!expanded && ids.length > SENT_MESSAGES_SHOWN ? (
        <TextLink className="self-start text-caption" onClick={expand}>
          {formatMessage({ id: "activity.overview.sent.more" }, { count: ids.length - SENT_MESSAGES_SHOWN })}
        </TextLink>
      ) : null}
      {visible > ids.length ? (
        <span className="text-caption text-foreground-hint">{formatMessage({ id: "activity.overview.sent.unlisted" }, { count: visible - ids.length })}</span>
      ) : null}
      {hidden > 0 ? (
        <span className="text-caption text-foreground-hint">{formatMessage({ id: "activity.overview.sent.hidden" }, { count: hidden })}</span>
      ) : null}
    </div>
  );
}

/** How many app events show before "Show N more". */
const APP_EVENTS_SHOWN = 5;

/**
 * One app event delivered in the turn: a compact list row, not a message
 * card, so what the agent received never reads as something it sent. The
 * app's logo (or the generic app tile), its name and the time, then the
 * summary at footnote size, cut to two lines, with tighter padding than a
 * default ListRow: the events are a side note of the turn and should not
 * outweigh it (xxchan). The clamp is visual only: the text and its hover
 * title keep the whole summary for a screen reader and a mouse, and the raw
 * log keeps every event in full.
 * The Apps tab has no way to open one event, so the row links nowhere.
 */
function AppEventRow({ event }: { event: ActivityTurnAppEventView }) {
  const { formatClock } = useTimeFormatter();
  return (
    <li>
      <ListRow variant="plain" interactive={false} className="items-start gap-2 px-3 py-2 [--list-row-rule-start:12px]" data-testid="activity-overview-app-event">
        {event.logoUrl
          ? <ConnectedAppLogo name={event.appName} logoUrl={event.logoUrl} seed={event.clientKey} size="xs" />
          : (
            <IconTile size="sm">
              <AppWindow />
            </IconTile>
          )}
        <ListRowBody>
          <ListRowTop>
            <ListRowTitle className="text-footnote">{event.appName}</ListRowTitle>
            <ListRowMeta>{formatClock(event.deliveredAt)}</ListRowMeta>
          </ListRowTop>
          <ListRowBottom>
            <ListRowDescription wrap className="line-clamp-2 text-footnote" title={event.summary} data-testid="activity-overview-app-event-summary">
              {event.summary}
            </ListRowDescription>
          </ListRowBottom>
        </ListRowBody>
      </ListRow>
    </li>
  );
}

/** The app events delivered in the turn (xxchan), oldest first, the first few shown and the rest a click away. */
function AppEvents({ events, count }: { events: readonly ActivityTurnAppEventView[]; count: number }) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const shown = expanded ? events : events.slice(0, APP_EVENTS_SHOWN);
  return (
    <div className="flex flex-col gap-2" data-testid="activity-overview-app-events">
      <span className="text-caption text-foreground-hint">
        {formatMessage({ id: "activity.overview.appEvents.title" }, { count })}
      </span>
      <ListRowGroup render={<ul />}>
        {shown.map((event) => <AppEventRow key={event.id} event={event} />)}
      </ListRowGroup>
      {!expanded && events.length > APP_EVENTS_SHOWN ? (
        <TextLink className="self-start text-caption" onClick={expand}>
          {formatMessage({ id: "activity.overview.appEvents.more" }, { count: events.length - APP_EVENTS_SHOWN })}
        </TextLink>
      ) : null}
      {count > events.length ? (
        <span className="text-caption text-foreground-hint">{formatMessage({ id: "activity.overview.appEvents.unlisted" }, { count: count - events.length })}</span>
      ) : null}
    </div>
  );
}

const NO_APP_EVENTS: readonly ActivityTurnAppEventView[] = [];
const NO_OPERATOR_EVENTS: AgentOperatorEventView[] = [];

function TurnSection({ turn, turnKey }: { turn: TurnSummaryView | RunningTurnView; turnKey: string }) {
  const intl = useIntl();
  const { formatClock } = useTimeFormatter();
  const running = "running" in turn;
  const trigger = formatTurnTrigger(intl.formatMessage, turn.trigger);
  // A running turn has no end yet: its start time only.
  const range: { start: string; end?: string } = running ? { start: formatClock(turn.startedAt) } : formatClockRange(formatClock(turn.startedAt), formatClock(turn.endedAt));
  const duration = formatTurnDuration(intl.formatMessage, turn.endedAt - turn.startedAt);
  // The exact waking message, only where the viewer may see it (the server hides the rest).
  const triggerMessage = turn.trigger && turn.trigger.hidden === undefined && !turn.trigger.unresolved && turn.trigger.messageId && turn.trigger.channelId
    ? { channelId: turn.trigger.channelId, messageId: turn.trigger.messageId }
    : null;
  const sentIds = turn.sentMessageIds ?? EMPTY_IDS;
  const hiddenSent = turn.hiddenSentCount ?? 0;
  const appEvents = turn.appEvents ?? NO_APP_EVENTS;
  return (
    <section className="flex flex-col gap-2" data-testid="activity-overview-turn" data-turn-key={turnKey}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Text.Heading className="font-mono text-mono-code font-bold tracking-normal text-foreground">{range.end === undefined ? range.start : intl.formatMessage({ id: "activity.overview.turn.range" }, { start: range.start, end: range.end })}</Text.Heading>
        {/* Badges sit right after the time so they stay on the first line (Kirby). */}
        <TurnBadges turn={turn} />
        <span className="min-w-0 max-w-full text-caption text-foreground-hint">
          {trigger
            ? intl.formatMessage({ id: running ? "activity.overview.turn.triggerAndRunningFor" : "activity.overview.turn.triggerAndDuration" }, {
              trigger: triggerMessage
                ? <span key="trigger">{trigger} <TriggerMessageLink channelId={triggerMessage.channelId} messageId={triggerMessage.messageId} /></span>
                : <span key="trigger">{trigger}</span>,
              duration,
            })
            : intl.formatMessage({ id: running ? "activity.overview.turn.runningFor" : "activity.overview.turn.took" }, { duration })}
        </span>
      </div>
      <span className="text-callout text-foreground-muted">{formatTurnActions(intl, turn.actions, turn.messagesSent)}</span>
      {/* What lies past the capped list is of unknown kind, mostly plain exits the overview no longer lists: no "N more". */}
      {turn.problems.map((problem, index) => (isListedProblem(problem) ? <ProblemLine key={`${problem.at}-${index}`} problem={problem} /> : null))}
      {turn.lastText ? <TurnOutput text={turn.lastText} /> : null}
      {/* What the turn received, then what it sent: two lists, each in time order. */}
      {appEvents.length > 0 ? <AppEvents events={appEvents} count={turn.appEventCount ?? appEvents.length} /> : null}
      {sentIds.length > 0 || hiddenSent > 0
        ? <SentMessages ids={sentIds} visible={turn.sentMessageCount ?? sentIds.length} hidden={hiddenSent} />
        : turn.lastReplyMessageId ? <LastReply messageId={turn.lastReplyMessageId} count={turn.messagesSent} /> : null}
    </section>
  );
}


/**
 * Activity tab "Overview" (task #17): one block per finished turn in time
 * order, oldest at the top like the raw log, then the turn still running (if
 * the server reports one), then what the agent is doing now at the bottom,
 * from the per-turn summaries. It follows the bottom as turns
 * finish; earlier turns load above without moving what is on screen. Detail
 * stays in the raw log (`onShowRaw`).
 */
export default function AgentActivityOverview({
  agentId,
  machineId,
  hasRawActivity,
  onShowRaw,
}: {
  agentId: string;
  machineId?: string | null;
  hasRawActivity: boolean;
  onShowRaw: () => void;
}) {
  const { formatMessage } = useIntl();
  const { toMachine } = useAppNavigate();
  const [turns, setTurns] = useState<TurnSummaryView[]>([]);
  const [next, setNext] = useState<string | undefined>();
  // Only the newest page carries it.
  const [running, setRunning] = useState<RunningTurnView | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  // #proj-runtime:#51: what people did to the agent, shown between the turns.
  const [operatorEvents, setOperatorEvents] = useState<AgentOperatorEventView[]>([]);
  // Bumped by every reload of the turns, so a Stop or Restart with no new turn shows too.
  const [reloads, setReloads] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // State, not a ref: the content mounts again when the first turn arrives
  // after an empty load, and the resize observer must follow it.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const turnsRef = useRef(turns);
  useLayoutEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  // What the person was reading, so earlier pages and replies that load above
  // it do not move it.
  const readingAnchor = useRef<ReadingAnchor | null>(null);
  const nearBottom = useRef(true);
  const followedOnce = useRef(false);
  // Where a restore put the view: the scroll event it fires may arrive after
  // more content grew above, and must not re-read the anchor from there.
  const restoredScrollTop = useRef<number | null>(null);
  const earlierLoaded = useRef(false);
  // Bumped when the held turns are replaced; an earlier page asked for before
  // that no longer joins up with them.
  const generation = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const loadLatest = useCallback(async (id: string) => {
    try {
      const { data } = await api.get<SummaryPage>(`/agents/${id}/activity-summaries`, { params: { limit: PAGE_SIZE } });
      const held = new Set(turnsRef.current.map(turnKey));
      const gap = data.next !== undefined && held.size > 0 && !data.summaries.some((turn) => held.has(turnKey(turn)));
      if (gap) {
        // More turns finished than one page while away (e.g. a reconnect):
        // start again from the newest page instead of keeping a hidden gap.
        generation.current += 1;
        earlierLoaded.current = false;
        // What was being read is gone: show the newest, like a first load.
        readingAnchor.current = null;
        followedOnce.current = false;
        nearBottom.current = true;
        setNewTurnBelow(false);
        setTurns(data.summaries);
        setNext(data.next);
        setRunning(data.current ?? null);
      } else {
        // Merge, never replace: earlier pages the person loaded stay, and a
        // reload racing "Show Earlier Turns" cannot drop a page.
        setTurns((previous) => mergeTurnPages(data.summaries, previous));
        if (!earlierLoaded.current) setNext(data.next);
        setRunning(data.current ?? null);
      }
      setStatus("loaded");
      setReloads((count) => count + 1);
    } catch {
      setStatus((previous) => (previous === "loaded" ? previous : "error"));
    }
  }, []);

  const loadEarlier = useCallback(() => {
    if (!next || loadingEarlier) return;
    setLoadingEarlier(true);
    const asked = generation.current;
    void api.get<SummaryPage>(`/agents/${agentId}/activity-summaries`, { params: { limit: PAGE_SIZE, before: next } })
      .then(({ data }) => {
        if (asked !== generation.current) return;
        earlierLoaded.current = true;
        setTurns((previous) => mergeTurnPages(previous, data.summaries));
        setNext(data.next);
      })
      .catch(() => undefined)
      .finally(() => setLoadingEarlier(false));
  }, [agentId, next, loadingEarlier]);
  const retry = useCallback(() => {
    void loadLatest(agentId);
  }, [agentId, loadLatest]);
  const openComputer = useCallback(() => {
    if (machineId) toMachine(machineId);
  }, [machineId, toMachine]);

  // The parent keys this component by agent, so state starts fresh per agent.
  useEffect(() => {
    void loadLatest(agentId);
  }, [agentId, loadLatest]);

  // A finished turn arrives with the agent's activity push; refresh the same way the raw log does.
  useEffect(() => registerActivityTrajectoryLiveReload({ socket: getSocket(), agentId, loadTrajectoryLog: loadLatest }), [agentId, loadLatest]);
  useEffect(() => registerActivityTrajectoryReconnectReload({ socket: getSocket(), agentId, loadTrajectoryLog: loadLatest }), [agentId, loadLatest]);

  // Events as far back as the turns held: all of them once no earlier page is left.
  const oldestHeldStart = turns.length > 0 ? Math.min(...turns.map((turn) => turn.startedAt)) : undefined;
  const eventsSince = next !== undefined ? oldestHeldStart : undefined;
  useEffect(() => {
    if (status !== "loaded") return;
    let cancelled = false;
    void api.get<AgentOperatorEventsPage>(`/agents/${agentId}/operator-events`, { params: eventsSince !== undefined ? { since: eventsSince } : {} })
      .then(({ data }) => {
        if (!cancelled) setOperatorEvents(Array.isArray(data?.events) ? data.events : []);
      })
      // An older server has no such route: the overview shows the turns alone.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentId, eventsSince, reloads, status]);

  // The empty wake a running turn took over shows only as that turn.
  const runningId = running?.id;
  const finished = useMemo(() => (runningId ? turns.filter((turn) => turn.id !== runningId) : turns), [turns, runningId]);
  const runningStart = running?.startedAt;
  const { segments, eventsBeforeRunning, eventsDuringRunning } = useMemo(() => {
    // The API pages newest first; the overview reads in time order like the log.
    const { segments: interleaved, after } = interleaveOperatorEvents([...finished].reverse(), operatorEvents);
    return {
      segments: interleaved,
      eventsBeforeRunning: runningStart === undefined ? after : after.filter((event) => event.at < runningStart),
      eventsDuringRunning: runningStart === undefined ? NO_OPERATOR_EVENTS : after.filter((event) => event.at >= runningStart),
    };
  }, [finished, operatorEvents, runningStart]);
  const runningKey = running ? `running:${running.id ?? running.startedAt}` : null;
  const latestTurnKey = runningKey ?? (finished[0] ? turnKey(finished[0]) : null);
  // Follow the bottom when a turn finishes only if the person is already at
  // the bottom (and on first load); someone reading earlier turns stays put
  // and gets a "new turn" hint instead (Tenny).
  const [newTurnBelow, setNewTurnBelow] = useState(false);
  const measureNearBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    nearBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom.current) setNewTurnBelow(false);
  }, []);
  const turnElements = useCallback(() => [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-turn-key]") ?? [])], []);
  const onScroll = useCallback(() => {
    measureNearBottom();
    const container = scrollRef.current;
    if (!container) return;
    if (restoredScrollTop.current !== null && Math.abs(container.scrollTop - restoredScrollTop.current) < 1) return;
    restoredScrollTop.current = null;
    // Turns grow at their bottom (the reply loads last). Anchor a turn that
    // starts near the top of the view, not one whose last lines peek in above
    // it; failing that, the turn the top of the view is in.
    const viewTop = container.scrollTop;
    const elements = turnElements();
    const top = elements.find((element) => element.offsetTop >= viewTop && element.offsetTop < viewTop + container.clientHeight / 3)
      ?? elements.find((element) => element.offsetTop + element.offsetHeight > viewTop);
    readingAnchor.current = top ? { key: top.dataset.turnKey ?? "", offset: top.offsetTop - container.scrollTop } : null;
  }, [measureNearBottom, turnElements]);
  // Put the turn being read back where it was. Safe to repeat, so it does
  // not fight the browser if that anchors too.
  const restoreReadingAnchor = useCallback(() => {
    const container = scrollRef.current;
    const anchor = readingAnchor.current;
    if (!container || !anchor) return;
    const element = turnElements().find((candidate) => candidate.dataset.turnKey === anchor.key);
    if (!element) return;
    const target = element.offsetTop - anchor.offset;
    if (Math.abs(target - container.scrollTop) < 1) return;
    container.scrollTop = target;
    restoredScrollTop.current = container.scrollTop;
  }, [turnElements]);
  useLayoutEffect(() => {
    if (!nearBottom.current) restoreReadingAnchor();
  }, [turns, restoreReadingAnchor]);
  const pinToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);
  // Instant, not smooth: a restore of the reading anchor during an animated
  // scroll would stop it short of the bottom.
  const jumpToNewest = useCallback(() => {
    nearBottom.current = true;
    readingAnchor.current = null;
    bottomRef.current?.scrollIntoView();
    setNewTurnBelow(false);
  }, []);
  useLayoutEffect(() => {
    if (status !== "loaded") return;
    if (!followedOnce.current || nearBottom.current) {
      followedOnce.current = true;
      pinToBottom();
      bottomRef.current?.scrollIntoView();
    } else {
      setNewTurnBelow(true);
    }
  }, [latestTurnKey, status, pinToBottom]);
  // Replies load after the first paint and grow their cards; keep a reader
  // who is at the bottom there, and drop a stale hint once nothing overflows.
  useEffect(() => {
    if (!contentEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) {
        pinToBottom();
      } else {
        restoreReadingAnchor();
        measureNearBottom();
      }
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [contentEl, pinToBottom, restoreReadingAnchor, measureNearBottom]);

  // The tab's one scroller, raft-ui PanelScrollViewport. The column and its gap
  // are on its content (its gutters layer is its first child), which fills it so
  // the empty state can take the rest of the height.
  const withNowCard = (empty: ReactNode) => (
    <PanelScrollViewport className="flex flex-1 flex-col px-(--surface-inset) py-4 max-md:px-4 md:pointer-fine:pt-2" contentClassName="flex flex-1 flex-col gap-6" data-testid="activity-overview">
      <AgentNowCard agentId={agentId} turns={finished} running={running} />
      {empty}
    </PanelScrollViewport>
  );

  if (status === "error") {
    return (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<History size={36} />}
        title={formatMessage({ id: "activity.overview.loadError" })}
        action={<Button size="md" variant="outline" onClick={retry}>{formatMessage({ id: "activity.overview.retry" })}</Button>}
      />
    );
  }
  // With no finished turns yet the "now" card stays above the empty state: it is
  // what shows a live error (e.g. a usage limit), and it is already on screen
  // while loading, so dropping it here made the error flash and vanish.
  if (status === "loaded" && finished.length === 0 && !running && !hasRawActivity) {
    return withNowCard(
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<History size={36} />}
        title={formatMessage({ id: "emptyState.noActivityTitle" })}
      />
    );
  }
  if (status === "loaded" && finished.length === 0 && !running) {
    return withNowCard(
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<History size={36} />}
        title={formatMessage({ id: "activity.overview.empty.title" })}
        description={formatMessage({ id: machineId ? "activity.overview.empty.upgradeDesc" : "activity.overview.empty.externalDesc" })}
        action={(
          <div className="flex flex-wrap justify-center gap-2">
            {machineId ? (
              <Button size="md" variant="outline" onClick={openComputer} data-testid="activity-overview-open-computer">
                {formatMessage({ id: "activity.overview.empty.openComputer" })}
              </Button>
            ) : null}
            <Button size="md" variant="outline" onClick={onShowRaw}>{formatMessage({ id: "activity.overview.empty.showRaw" })}</Button>
          </div>
        )}
      />
    );
  }
  return (
    // The view keeps its place itself when earlier turns load, so the
    // browser's own scroll anchoring must not move it a second time
    // (`[overflow-anchor:none]` replaces the panel viewport's `auto`). The
    // ScrollArea's gutters layer is the column's zero-height first row; the
    // turns are one child, the new-turn button another.
    <PanelScrollViewport ref={scrollRef} onScroll={onScroll} className="relative flex flex-1 flex-col px-(--surface-inset) py-4 max-md:px-4 md:pointer-fine:pt-2 [overflow-anchor:none]" data-testid="activity-overview">
      <div ref={setContentEl} className="flex flex-col gap-6">
        {next ? (
          <Button size="md" variant="default" className="self-start" onClick={loadEarlier} disabled={loadingEarlier}>
            {formatMessage({ id: "activity.overview.loadMore" })}
          </Button>
        ) : null}
        {segments.map((segment) => (segment.kind === "turns"
          ? <TurnsWithQuietFailureRuns key={`turns:${turnKey(segment.turns[0]!)}`} turns={segment.turns} keyOf={turnKey} Turn={TurnSection} Badges={TurnBadges} />
          : <OperatorEventLines key={`events:${segment.events[0]!.id}`} events={segment.events} />))}
        <OperatorEventLines events={eventsBeforeRunning} />
        {running && runningKey ? <TurnSection key={runningKey} turnKey={runningKey} turn={running} /> : null}
        <OperatorEventLines events={eventsDuringRunning} />
        <AgentNowCard agentId={agentId} turns={finished} running={running} />
        <div ref={bottomRef} />
      </div>
      {newTurnBelow ? (
        <Button size="md" variant="primary" className="sticky bottom-0 self-center" onClick={jumpToNewest} data-testid="activity-overview-new-turn">
          {formatMessage({ id: "activity.overview.newTurn" })}
        </Button>
      ) : null}
    </PanelScrollViewport>
  );
}
