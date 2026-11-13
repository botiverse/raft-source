import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Badge, Button, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
  ListRow, ListRowBody, ListRowBottom, ListRowDescription, ListRowGroup, ListRowIcon, ListRowMeta, ListRowTitle, ListRowTop,
  SegmentedControl, SegmentedControlCount, SegmentedControlItem, SegmentedControlLabel, Status, Text, TextLink,
  ScrollArea,
} from "@botiverse/raft-ui";
import { MessageListJumpControls, MessageListJumpPill } from "@botiverse/raft-ui/wip";
import type { Presence } from "@botiverse/raft-ui";
import { useAgentStore } from "../../store/agentStore";
import type { TrajectoryLogEntry } from "../../store/agentStore";
import { getSocket } from "../../api/socket";
import { registerActivityTrajectoryLiveReload, registerActivityTrajectoryReconnectReload } from "../../utils/activityTrajectoryRecovery";
import { piResponseNoticeKind, getToolLogLabel, shouldHideToolStartInActivityLog } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, SubagentLineage } from "@botiverse/raft-shared";
import { Activity, ArrowDown, ArrowLeft, Bot, ChevronRight } from "lucide-react";
import EmptyState from "../ui/EmptyState";
import AgentActivityOverview, { formatTurnDuration } from "./AgentActivityOverview";
import { groupSubagents, subagentKeyResolver, subagentRowPresence } from "./subagentGroups";
import { stopSubagentWithFeedback } from "./stopSubagent";
import { useFollowNewest } from "./useFollowNewest";
import type { SubagentGroup, SubagentState } from "./subagentGroups";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { RefText, ThreadRefNoticeProvider } from "./RefText";
import type { MessageId } from "../../i18n/messages";
import { activityPresence, freshnessHoldLabelId, parseFreshnessHoldText } from "../../utils/activity";

const EMPTY_LOG: TrajectoryLogEntry[] = [];

// A row's React key is the entry's own: the store keeps each entry the same
// object across live appends and reloads, but the entries carry no id, and
// their place in the list shifts by one on every step once the log is at its
// 500-entry limit. Keyed by place, every row remounted on each new step (and a
// reader's place, and an expanded row, went with it).
const entryKeys = new WeakMap<TrajectoryLogEntry, string>();
let nextEntryKey = 0;
function trajectoryEntryKey(item: TrajectoryLogEntry): string {
  let key = entryKeys.get(item);
  if (key === undefined) {
    key = `entry-${nextEntryKey++}`;
    entryKeys.set(item, key);
  }
  return key;
}

function isVisibleTrajectoryEntry(item: TrajectoryLogEntry): boolean {
  // A freshness hold arrives as a status row and an action entry; the action
  // entry says it, so the status row would only repeat it.
  if (item.entry.kind === "status" && item.entry.detailKind === "freshness_hold") return false;
  return item.entry.kind !== "tool_start" || !shouldHideToolStartInActivityLog(item.entry.toolName);
}

// APM 1.6 6b: a lineage-bearing row (explicit parent_tool_use_id / task lineage
// preserved on the entry by the daemon) is marked as subagent activity. We keep
// the log FLAT — rows without lineage render exactly as before, and we never
// synthesize a subagent group/card. Lineage-bearing rows just gain a small
// inline "Subagent" badge (with the bounded role, never any prompt/output).
function subagentLineage(item: TrajectoryLogEntry): SubagentLineage["subagent"] | undefined {
  return (item.entry as SubagentLineage).subagent;
}

/**
 * #proj-runtime:#41 — the raw log's way into the Sub-agents view: a spawn row
 * whose call started a sub-agent links to it. Absent outside the toggle.
 */
const SubagentLinkContext = createContext<{ keyByCall: ReadonlyMap<string, string>; keyOfRow: (lineage: NonNullable<SubagentLineage["subagent"]>) => string | undefined; open: (key: string) => void } | null>(null);

/** The row's sub-agent marker; in the toggle it opens that sub-agent in the Sub-agents view (artin, #proj-runtime:#43). */
function SubagentBadge({ lineage }: { lineage: NonNullable<SubagentLineage["subagent"]> }) {
  const { formatMessage } = useIntl();
  const subagentLink = useContext(SubagentLinkContext);
  const key = subagentLink?.keyOfRow(lineage);
  const label = lineage.subagentType
    ? formatMessage({ id: "activity.log.subagentWithType" }, { type: lineage.subagentType })
    : formatMessage({ id: "activity.log.subagent" });
  if (!key || !subagentLink) {
    return <Badge appearance="outline" variant="default" className="ml-1.5 align-middle">{label}</Badge>;
  }
  return (
    <Badge
      render={<button type="button" onClick={() => subagentLink.open(key)} data-testid="activity-log-subagent-open" />}
      appearance="outline"
      variant="default"
      className="ml-1.5 align-middle hover:text-foreground focus-visible:outline-2"
    >
      {label}
    </Badge>
  );
}

const ACTIVITY_LABEL_IDS: Record<string, MessageId> = {
  online: "activity.log.status.idle",
  thinking: "activity.log.status.thinking",
  working: "activity.log.status.working",
};


// "Stopped" is reserved for manual/reconcile-driven stops. Other offline causes
// (machine disconnect, crash, unknown) show their own labels so a transient
// disconnect doesn't look like a terminal state in the activity log.
function resolveOfflineLabelId(detailKind?: AgentActivityDetailKind): MessageId {
  if (detailKind === "stopped") return "activity.log.status.stopped";
  if (detailKind === "machine_disconnected") return "activity.log.status.disconnected";
  if ((detailKind === "runtime_crashed" || detailKind === "claude_root_privileges")) return "activity.log.status.crashed";
  return "activity.log.status.offline";
}

function resolveStatusDisplay(
  activity: AgentActivity,
  detail: string,
  detailKind?: AgentActivityDetailKind,
): { primary: MessageId | { raw: string }; secondary: string } {
  if (activity === "working" && detailKind === "starting") {
    return { primary: "activity.log.status.starting", secondary: "" };
  }

  if (detailKind === "freshness_hold") {
    return { primary: freshnessHoldLabelId(detail) ?? "activity.log.freshnessHold.send", secondary: "" };
  }

  if (activity === "online") {
    const lifecycleLabel: MessageId | null = detailKind === "computer_started"
      ? "activity.log.status.started"
      : detailKind === "computer_restarted"
        ? "activity.log.status.restarted"
        : detailKind === "computer_upgraded"
          ? "activity.log.status.upgraded"
          : null;
    if (lifecycleLabel) return { primary: lifecycleLabel, secondary: "" };
  }

  if (activity === "error" && detailKind === "computer_operation_failed") {
    return { primary: "activity.log.status.computerOperationFailed", secondary: detail };
  }

  if (activity === "offline") {
    const primary = resolveOfflineLabelId(detailKind);
    const primaryFallback = detailKind === "stopped"
      ? "Stopped"
      : detailKind === "machine_disconnected"
        ? "Disconnected"
        : (detailKind === "runtime_crashed" || detailKind === "claude_root_privileges")
          ? "Crashed"
          : "Offline";
    const stoppedReason = detailKind === "stopped" && detail && detail !== primaryFallback ? detail : "";
    // For most offline rows, the label already encodes the cause, so detail would
    // duplicate. Stopped rows now carry a second-level reason that distinguishes
    // user stop from Computer shutdown without adding a new detailKind enum.
    return {
      primary,
      secondary: (detailKind === "runtime_crashed" || detailKind === "claude_root_privileges")
        ? detail
        : stoppedReason
          ? ` - ${stoppedReason}`
          : "",
    };
  }

  return { primary: ACTIVITY_LABEL_IDS[activity] || { raw: activity }, secondary: detail };
}

type FormatTimestamp = (timestamp: number) => string;

// DS Timeline, activity-log variant (`.rf-tl.rf-tl--log`): one square presence
// pixel per entry, strung on a hairline; title and detail in Space Mono, the
// time on the right. Hand-rolled: raft-ui's Timeline has no log variant.
const LOG_ITEM_CLASS = [
  "relative grid grid-cols-[10px_minmax(0,1fr)_auto] gap-x-3 py-1.5",
  // The 1px hairline through the 10px pixel: an even pixel has no centre
  // column, so it takes the one just right of the middle (5px of pixel on its
  // left, 4px on its right) on a whole pixel, where 4.5px would blur at 1x.
  "before:absolute before:top-0 before:bottom-0 before:left-[5px] before:border-l before:border-line-hairline",
  "first:before:top-4 last:before:bottom-auto last:before:h-4 only:before:hidden",
].join(" ");
// The entry's presence light (raft-ui Status: busy yellow, error orange, online
// lime, offline stone; never animated), centred on the first 20px line and
// knocked out of the timeline's hairline: (20px line - 10px pixel) / 2.
const LOG_PIXEL_CLASS = "z-raised mt-[5px] shadow-[0_0_0_2px_var(--layer-canvas)]";
const LOG_TITLE_CLASS = "font-mono text-mono-code text-foreground-muted wrap-anywhere";
const LOG_DETAIL_CLASS = "mt-0.5 font-mono text-mono-meta text-foreground-hint wrap-anywhere";
const LOG_TIME_CLASS = "font-mono text-mono-meta leading-5 whitespace-nowrap text-foreground-hint";

function LogItem({ presence, timestamp, formatTimestamp, children }: { presence: Presence; timestamp: number; formatTimestamp: FormatTimestamp; children: ReactNode }) {
  return (
    <li className={LOG_ITEM_CLASS}>
      <Status aria-hidden="true" presence={presence} className={LOG_PIXEL_CLASS} />
      <div className="min-w-0">{children}</div>
      <span className={LOG_TIME_CLASS}>{formatTimestamp(timestamp)}</span>
    </li>
  );
}

/** A titled entry whose detail clamps to two lines until the title is clicked (only when long). */
function ExpandableEntry({ presence, title, text, timestamp, formatTimestamp, subagent, children }: { presence: Presence; title: string; text: string; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"]; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <LogItem presence={presence} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      {/* The badge may itself be a button: beside the title's, never inside it. */}
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => isLong && setExpanded(!expanded)}
          className={`flex items-center gap-1 text-left ${LOG_TITLE_CLASS} ${isLong ? "hover:text-foreground" : "cursor-default"}`}
        >
          {title}
          {isLong && (
            <ChevronRight
              size={14}
              className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        {subagent && <SubagentBadge lineage={subagent} />}
      </span>
      <p
        className={`${LOG_DETAIL_CLASS} whitespace-pre-wrap ${
          !expanded && isLong ? "line-clamp-2" : ""
        }`}
      >
        {children}
      </p>
    </LogItem>
  );
}

function ThinkingEntry({ text, timestamp, formatTimestamp }: { text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  return (
    <ExpandableEntry presence="busy" title={formatMessage({ id: "activity.log.thinking" })} text={text} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      {text}
    </ExpandableEntry>
  );
}


function ToolStartEntry({ toolName, toolInput, callId, timestamp, formatTimestamp, subagent }: { toolName: string; toolInput: string; callId?: string; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"] }) {
  const { formatMessage } = useIntl();
  const subagentLink = useContext(SubagentLinkContext);
  const subagentKey = callId ? subagentLink?.keyByCall.get(callId) : undefined;
  const startsSubagent = subagentKey !== undefined;
  const openSubagent = useCallback(() => { if (subagentKey) subagentLink?.open(subagentKey); }, [subagentKey, subagentLink]);
  return (
    <LogItem presence="busy" timestamp={timestamp} formatTimestamp={formatTimestamp}>
      <span className={`block ${LOG_TITLE_CLASS}`}>
        {getToolLogLabel(toolName)}
        {subagent && <SubagentBadge lineage={subagent} />}
      </span>
      {toolInput && (
        <span className={`block break-all ${LOG_DETAIL_CLASS}`}>{toolInput}</span>
      )}
      {startsSubagent && (
        <TextLink className="mt-0.5 block font-mono text-mono-meta" onClick={openSubagent}>
          {formatMessage({ id: "activity.subagents.openFromLog" })}
        </TextLink>
      )}
    </LogItem>
  );
}

function TextEntry({ text, timestamp, formatTimestamp }: { text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  return (
    <ExpandableEntry presence="online" title={formatMessage({ id: "activity.log.output" })} text={text} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      {text}
    </ExpandableEntry>
  );
}

function SystemEntry({ title, text, timestamp, formatTimestamp, subagent }: { title: string; text: string; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"] }) {
  const { formatMessage } = useIntl();
  const notice = piResponseNoticeKind(title, text);
  if (notice) {
    const message = formatMessage({ id: notice === "empty_response" ? "activity.log.piResponseEmpty" : "activity.log.piResponseWhitespace" });
    return (
      <ExpandableEntry presence="online" title={formatMessage({ id: "activity.log.piResponseNotice" })} text={message} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent}>
        {message}
      </ExpandableEntry>
    );
  }
  return (
    <ExpandableEntry presence={subagentRowPresence(subagent) ?? "error"} title={title} text={text} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent}>
      <RefText text={text} />
    </ExpandableEntry>
  );
}

function SlockActionEntry({ title, text: rawText, timestamp, formatTimestamp }: { title: string; text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  const freshnessHold = freshnessHoldLabelId(title);
  // A hold is the normal "read the new messages first" step: say how many and where.
  const holdDetail = freshnessHold ? parseFreshnessHoldText(rawText) : null;
  const text = holdDetail
    ? formatMessage({ id: "activity.log.freshnessHold.detail" }, { count: holdDetail.count, target: holdDetail.target })
    : rawText;
  return (
    <ExpandableEntry presence="online" title={freshnessHold ? formatMessage({ id: freshnessHold }) : title} text={text} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      {/* Ref linkification is scoped to the structured-metadata entry
          kinds — SlockAction (slock-cli target: #channel:shortid …),
          System, and Status — where a #channel / thread / dm token is a
          real navigation target. NOT Output/Thinking/Tool: those are
          free-form agent text where #x is incidental and linkifying it
          is noise. task #266 follow-up, xxchan #proj-uiux:2921feaf. */}
      <RefText text={text} />
    </ExpandableEntry>
  );
}

function StatusEntry({ activity, detail, detailKind, timestamp, formatTimestamp, subagent }: { activity: AgentActivity; detail: string; detailKind?: AgentActivityDetailKind; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"] }) {
  const { formatMessage } = useIntl();
  const { primary, secondary } = resolveStatusDisplay(activity, detail, detailKind);
  const secondaryText = detailKind === "claude_root_privileges"
    ? formatMessage({ id: "agent.runtimeError.rootPrivileges" }) : secondary;
  const primaryText = typeof primary === "string" ? formatMessage({ id: primary }) : primary.raw;
  return (
    <LogItem presence={activityPresence(activity)} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      <span className={`block ${LOG_TITLE_CLASS}`}>
        <span>{primaryText}</span>
        {subagent && <SubagentBadge lineage={subagent} />}
        {secondary && (
          <span className="ml-1.5 break-words text-foreground-hint">
            <RefText text={secondaryText} />
          </span>
        )}
      </span>
    </LogItem>
  );
}

function CompactionEntry({ phase, timestamp, formatTimestamp }: { phase: "started" | "finished"; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  const isStarted = phase === "started";

  return (
    <LogItem presence={isStarted ? "busy" : "online"} timestamp={timestamp} formatTimestamp={formatTimestamp}>
      <span className={`block ${LOG_TITLE_CLASS}`}>
        {formatMessage({ id: isStarted ? "activity.log.compactionStarted" : "activity.log.compactionFinished" })}
      </span>
    </LogItem>
  );
}

function TrajectoryItem({ item, formatTimestamp }: { item: TrajectoryLogEntry; formatTimestamp: FormatTimestamp }) {
  const { entry, timestamp } = item;
  const subagent = subagentLineage(item);

  switch (entry.kind) {
    case "thinking":
      return <ThinkingEntry text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "tool_start":
      return <ToolStartEntry toolName={entry.toolName} toolInput={entry.toolInput} callId={entry.callId} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent} />;
    case "text":
      return <TextEntry text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "slock_action":
      return <SlockActionEntry title={entry.title} text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "system":
      return <SystemEntry title={entry.title} text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent} />;
    case "compaction_started":
      return <CompactionEntry phase="started" timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "compaction_finished":
      return <CompactionEntry phase="finished" timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "status":
      return <StatusEntry activity={entry.activityKind ?? entry.activity} detail={entry.detail} detailKind={entry.detailKind} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent} />;
  }
}

/** The raw activity log alone (the Activity tab's Raw view). */
export function RawActivityLog({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const log = useAgentStore((s) => s.trajectoryLogs[agentId] ?? EMPTY_LOG);
  const visibleLog = useMemo(() => log.filter(isVisibleTrajectoryEntry), [log]);
  const loadTrajectoryLog = useAgentStore((s) => s.loadTrajectoryLog);
  const { formatClockWithSeconds } = useTimeFormatter();
  const formatTimestamp = useCallback(
    (timestamp: number) => formatClockWithSeconds(timestamp).toUpperCase(),
    [formatClockWithSeconds],
  );

  // Ephemeral notice when a (legitimate) thread ref can't be resolved at
  // click time — mirrors MessageItem's threadRefNotice behaviour.
  const [threadRefNotice, setThreadRefNotice] = useState<MessageId | null>(null);
  const threadRefNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showThreadRefNotice = useCallback((message: MessageId) => {
    if (threadRefNoticeTimerRef.current) clearTimeout(threadRefNoticeTimerRef.current);
    setThreadRefNotice(message);
    threadRefNoticeTimerRef.current = setTimeout(() => {
      setThreadRefNotice(null);
      threadRefNoticeTimerRef.current = null;
    }, 4000);
  }, []);
  useEffect(() => () => {
    if (threadRefNoticeTimerRef.current) clearTimeout(threadRefNoticeTimerRef.current);
  }, []);

  // Following the newest (raft-design Conversation): opens at the newest
  // step, follows it while the end is in view, else keeps the reader's place
  // and counts what arrived for the Back to bottom pill.
  const { scrollRef, listRef, onScroll, atEnd, newCount: newSteps, jumpToNewest } = useFollowNewest(visibleLog, trajectoryEntryKey);

  useEffect(() => {
    void loadTrajectoryLog(agentId);
  }, [agentId, loadTrajectoryLog]);

  useEffect(() => {
    const socket = getSocket();
    return registerActivityTrajectoryReconnectReload({
      socket,
      agentId,
      loadTrajectoryLog,
    });
  }, [agentId, loadTrajectoryLog]);

  useEffect(() => {
    const socket = getSocket();
    return registerActivityTrajectoryLiveReload({
      socket,
      agentId,
      loadTrajectoryLog,
    });
  }, [agentId, loadTrajectoryLog]);

  if (visibleLog.length === 0) {
    return (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center bg-layer-canvas"
        icon={<Activity size={36} />}
        title={formatMessage({ id: "emptyState.noActivityTitle" })}
      />
    );
  }

  return (
    <ThreadRefNoticeProvider onNotice={showThreadRefNotice}>
      <div className="flex flex-1 flex-col min-h-0 bg-layer-canvas">
        {/* The log scrolls in a raft-ui ScrollArea, its padding on the
            content. A log to read: a region named like the tab, a tab stop
            once it overflows. It keeps the reader's place itself, so the
            browser's scroll anchoring stays out of it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ScrollArea
            ref={scrollRef}
            onScroll={onScroll}
            role="region"
            aria-label={formatMessage({ id: "agent.detail.tab.activity" })}
            className="flex-1 [overflow-anchor:none]"
            contentClassName="px-(--surface-inset) py-3 max-md:px-4"
          >
            <ol ref={listRef} className="m-0 flex list-none flex-col p-0">
              {visibleLog.map((item) => (
                <TrajectoryItem key={trajectoryEntryKey(item)} item={item} formatTimestamp={formatTimestamp} />
              ))}
            </ol>
          </ScrollArea>
          {/* The conversation's Back to bottom pill, counting steps. */}
          <MessageListJumpControls hidden={atEnd}>
            {!atEnd && (
              <MessageListJumpPill onClick={jumpToNewest} data-testid="activity-log-new-steps">
                <ArrowDown aria-hidden />
                {newSteps > 0
                  ? formatMessage({ id: "activity.log.newSteps" }, { count: newSteps })
                  : formatMessage({ id: "message.chatPanel.backToBottom" })}
              </MessageListJumpPill>
            )}
          </MessageListJumpControls>
        </div>
        {threadRefNotice ? (
          <div className="shrink-0 bg-warning-soft px-4 py-2 text-callout text-foreground">
            {formatMessage({ id: threadRefNotice })}
          </div>
        ) : null}
      </div>
    </ThreadRefNoticeProvider>
  );
}

/**
 * The agent state chip (raft-ui Status page): a soft Badge with a presence
 * light and its word, on the soft tint of the light's family. Only the
 * presence lights and the task Done colour: a failure or a limit is the
 * error light (warning family), a stop or an end the offline one.
 */
const SUBAGENT_STATE_CHIP: Record<SubagentState, { badge: "busy" | "success" | "warning" | "muted"; light: { presence: "busy" | "error" | "offline" } | { variant: "success" }; labelId: MessageId }> = {
  running: { badge: "busy", light: { presence: "busy" }, labelId: "activity.subagents.state.running" },
  done: { badge: "success", light: { variant: "success" }, labelId: "activity.subagents.state.done" },
  failed: { badge: "warning", light: { presence: "error" }, labelId: "activity.subagents.state.failed" },
  ceiling: { badge: "warning", light: { presence: "error" }, labelId: "activity.subagents.state.ceiling" },
  stopped: { badge: "muted", light: { presence: "offline" }, labelId: "activity.subagents.state.stopped" },
  ended: { badge: "muted", light: { presence: "offline" }, labelId: "activity.subagents.state.ended" },
};

function SubagentStateChip({ state }: { state: SubagentState }) {
  const { formatMessage } = useIntl();
  const chip = SUBAGENT_STATE_CHIP[state];
  return (
    <Badge appearance="soft" variant={chip.badge}>
      <Status {...chip.light} aria-hidden />
      {formatMessage({ id: chip.labelId })}
    </Badge>
  );
}

function useSubagentText() {
  const intl = useIntl();
  return {
    title: (group: SubagentGroup) => group.title ?? group.subagentType ?? intl.formatMessage({ id: "activity.subagents.untitled" }),
    duration: (group: SubagentGroup) => intl.formatMessage(
      { id: group.state === "running" ? "activity.overview.turn.runningFor" : "activity.overview.turn.took" },
      { duration: formatTurnDuration(intl.formatMessage, (group.endedAt ?? Date.now()) - group.startedAt) },
    ),
    steps: (group: SubagentGroup) => intl.formatMessage({ id: "activity.subagents.steps" }, { count: group.steps }),
  };
}

function SubagentRow({ group, onOpen }: { group: SubagentGroup; onOpen: (key: string) => void }) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => onOpen(group.key), [onOpen, group.key]);
  const text = useSubagentText();
  const { formatClock } = useTimeFormatter();
  const facts = [
    group.title ? group.subagentType : undefined,
    text.steps(group),
    group.state === "running" && group.lastToolName
      ? formatMessage({ id: "activity.subagents.now" }, { tool: getToolLogLabel(group.lastToolName) })
      : text.duration(group),
  ].filter(Boolean).join(" · ");
  return (
    <ListRow onClick={open} data-testid="subagent-row">
      <ListRowIcon><Bot /></ListRowIcon>
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle>{text.title(group)}</ListRowTitle>
          <ListRowMeta>{formatClock(group.startedAt)}</ListRowMeta>
        </ListRowTop>
        <ListRowBottom>
          <ListRowDescription>{facts}</ListRowDescription>
          <SubagentStateChip state={group.state} />
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function SubagentGroupHeading({ running, count }: { running: boolean; count: number }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5 pt-3">
      <Status presence={running ? "busy" : "offline"} aria-hidden />
      <Text.Sans size="group" variant="muted">{formatMessage({ id: running ? "activity.subagents.group.running" : "activity.subagents.group.ended" })}</Text.Sans>
      <Text.Mono size="meta" variant="muted">{count}</Text.Mono>
    </div>
  );
}

function SubagentsList({ groups, onOpen }: { groups: readonly SubagentGroup[]; onOpen: (key: string) => void }) {
  const { formatMessage } = useIntl();
  if (groups.length === 0) {
    return (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center bg-layer-canvas"
        icon={<Bot size={36} />}
        title={formatMessage({ id: "activity.subagents.emptyTitle" })}
        description={formatMessage({ id: "activity.subagents.recentOnly" })}
      />
    );
  }
  const running = groups.filter((group) => group.state === "running");
  const ended = groups.filter((group) => group.state !== "running");
  return (
    // Each subagent row opens it (takes focus), so the list is no tab stop.
    <ScrollArea tabIndex={-1} className="flex-1" contentClassName="px-(--surface-inset) pb-4 max-md:px-4" data-testid="subagents-list">
      {running.length > 0 && (
        <>
          <SubagentGroupHeading running count={running.length} />
          <ListRowGroup>{running.map((group) => <SubagentRow key={group.key} group={group} onOpen={onOpen} />)}</ListRowGroup>
        </>
      )}
      {ended.length > 0 && (
        <>
          <SubagentGroupHeading running={false} count={ended.length} />
          <ListRowGroup>{ended.map((group) => <SubagentRow key={group.key} group={group} onOpen={onOpen} />)}</ListRowGroup>
        </>
      )}
      <Text.Sans size="caption" variant="muted" className="block px-1 pt-3">{formatMessage({ id: "activity.subagents.recentOnly" })}</Text.Sans>
    </ScrollArea>
  );
}

function SubagentDetail({ group, onBack, onStop }: { group: SubagentGroup; onBack: () => void; onStop?: (taskId: string) => void }) {
  const { formatMessage } = useIntl();
  // Only a running subagent of a runtime that can stop one (Codex, Claude Code) offers Stop.
  const stopTaskId = onStop && group.state === "running" ? group.taskId : undefined;
  const stop = useCallback(() => { if (stopTaskId) onStop?.(stopTaskId); }, [onStop, stopTaskId]);
  const text = useSubagentText();
  const { formatClockWithSeconds } = useTimeFormatter();
  const formatTimestamp = useCallback((timestamp: number) => formatClockWithSeconds(timestamp).toUpperCase(), [formatClockWithSeconds]);
  const items = group.items.filter(isVisibleTrajectoryEntry);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="subagent-detail">
      <div className="flex items-start gap-2 border-b border-line-seam px-(--surface-inset) py-3 max-md:px-4">
        <Button variant="ghost" size="icon-md" aria-label={formatMessage({ id: "activity.subagents.back" })} onClick={onBack}><ArrowLeft /></Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 className="m-0"><Text.Sans size="large" render={<span />} className="line-clamp-2 font-semibold">{text.title(group)}</Text.Sans></h3>
          <div><SubagentStateChip state={group.state} /></div>
        </div>
        {stopTaskId && (
          <Button variant="outline" size="md" onClick={stop} data-testid="subagent-stop">
            {formatMessage({ id: "activity.subagents.stop" })}
          </Button>
        )}
      </div>
      {/* The subagent's details and steps scroll in a raft-ui ScrollArea
          under its head, a region named after it (a tab stop once it
          overflows). */}
      <ScrollArea role="region" aria-label={text.title(group)} className="flex-1">
        <DescriptionList direction="horizontal" className="border-b border-line-seam px-(--surface-inset) py-3 max-md:px-4">
          {group.subagentType && (
            <DescriptionItem><DescriptionTerm>{formatMessage({ id: "activity.subagents.detail.type" })}</DescriptionTerm><DescriptionDetails>{group.subagentType}</DescriptionDetails></DescriptionItem>
          )}
          <DescriptionItem><DescriptionTerm>{formatMessage({ id: "activity.subagents.detail.started" })}</DescriptionTerm><DescriptionDetails>{formatTimestamp(group.startedAt)}</DescriptionDetails></DescriptionItem>
          <DescriptionItem><DescriptionTerm>{formatMessage({ id: "activity.subagents.detail.time" })}</DescriptionTerm><DescriptionDetails>{[text.duration(group), text.steps(group)].join(" · ")}</DescriptionDetails></DescriptionItem>
        </DescriptionList>
        <ol className="m-0 flex list-none flex-col px-(--surface-inset) py-3 max-md:px-4">
          {items.map((item) => <TrajectoryItem key={trajectoryEntryKey(item)} item={item} formatTimestamp={formatTimestamp} />)}
        </ol>
      </ScrollArea>
    </div>
  );
}

type ActivityView = "overview" | "raw" | "subagents";

/**
 * The Activity tab: it opens on the per-turn Overview (task #17), with the
 * raw log one toggle away.
 */
export default function AgentActivityLog({ agentId, machineId, canStopSubagents = false }: {
  agentId: string;
  machineId?: string | null;
  /** #proj-runtime:#41: the viewer may stop a running subagent (Stop turn's authority, a runtime that can: Codex, Claude Code). */
  canStopSubagents?: boolean;
}) {
  const { formatMessage } = useIntl();
  const stopSubagent = useCallback((taskId: string) => { void stopSubagentWithFeedback(agentId, taskId, formatMessage); }, [agentId, formatMessage]);
  const [view, setView] = useState<ActivityView>("overview");
  const hasRawActivity = useAgentStore((s) => (s.trajectoryLogs[agentId]?.length ?? 0) > 0);
  const showRaw = useCallback(() => setView("raw"), []);
  const loadTrajectoryLog = useAgentStore((s) => s.loadTrajectoryLog);
  const log = useAgentStore((s) => s.trajectoryLogs[agentId] ?? EMPTY_LOG);
  const subagents = useMemo(() => groupSubagents(log), [log]);
  const keyOfRow = useMemo(() => subagentKeyResolver(log), [log]);
  const subagentKeys = useMemo(() => new Set(subagents.map((group) => group.key)), [subagents]);
  const [openSubagent, setOpenSubagent] = useState<string | null>(null);
  const subagentLink = useMemo(() => ({
    // The row that started a subagent opens it (the first listed, when one call started several).
    keyByCall: new Map([...subagents].reverse().flatMap((group) => (group.parentToolUseId ? [[group.parentToolUseId, group.key] as const] : []))),
    // A sub-agent's own row opens its own run, keyed exactly as the grouping keys it.
    keyOfRow: (lineage: NonNullable<SubagentLineage["subagent"]>) => {
      const key = keyOfRow(lineage);
      return key !== undefined && subagentKeys.has(key) ? key : undefined;
    },
    open: (key: string) => { setOpenSubagent(key); setView("subagents"); },
  }), [subagents, keyOfRow, subagentKeys]);
  const openGroup = subagents.find((group) => group.key === openSubagent);
  const closeSubagent = useCallback(() => setOpenSubagent(null), []);
  const changeView = useCallback((next: ActivityView) => { setView(next); setOpenSubagent(null); }, []);
  // The overview needs to know whether the agent has any raw activity at all
  // (to tell "no turns yet" from "this computer records no turns").
  useEffect(() => {
    void loadTrajectoryLog(agentId);
  }, [agentId, loadTrajectoryLog]);
  // The Sub-agents segment appears once the agent has had one.
  const showSubagents = subagents.length > 0 || view === "subagents";
  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* The view switch is the only control here, so it is no bar of its own:
          no divider, the turns start right under it, and it sits at the start
          of the row like the content it switches (stdrc, 2026-11-04). With a
          mouse it is part of the content: the content's 12px top inset above it,
          8px to the content under it (the overview starts 8 down), so the
          gap above is the larger one (stdrc, 2026-11-05). */}
      <div className="flex min-h-(--header-height) shrink-0 items-center justify-start px-(--surface-inset) py-3 max-md:px-4 md:pointer-fine:min-h-0 md:pointer-fine:pt-(--page-top) md:pointer-fine:pb-0" data-testid="activity-view-toolbar">
        <SegmentedControl<ActivityView>
          value={view}
          aria-label={formatMessage({ id: "activity.overview.view.label" })}
          onValueChange={changeView}
        >
          <SegmentedControlItem value="overview" data-testid="activity-view-overview">
            <SegmentedControlLabel>{formatMessage({ id: "activity.overview.view.overview" })}</SegmentedControlLabel>
          </SegmentedControlItem>
          <SegmentedControlItem value="raw" data-testid="activity-view-raw">
            <SegmentedControlLabel>{formatMessage({ id: "activity.overview.view.raw" })}</SegmentedControlLabel>
          </SegmentedControlItem>
          {showSubagents && (
            <SegmentedControlItem value="subagents" data-testid="activity-view-subagents">
              <SegmentedControlLabel>{formatMessage({ id: "activity.overview.view.subagents" })}</SegmentedControlLabel>
              <SegmentedControlCount>{subagents.length}</SegmentedControlCount>
            </SegmentedControlItem>
          )}
        </SegmentedControl>
      </div>
      {view === "overview"
        ? <AgentActivityOverview key={agentId} agentId={agentId} machineId={machineId} hasRawActivity={hasRawActivity} onShowRaw={showRaw} />
        : view === "subagents"
          ? openGroup
            ? <SubagentDetail group={openGroup} onBack={closeSubagent} onStop={canStopSubagents ? stopSubagent : undefined} />
            : <SubagentsList groups={subagents} onOpen={setOpenSubagent} />
          : (
            <SubagentLinkContext.Provider value={subagentLink}>
              <RawActivityLog agentId={agentId} />
            </SubagentLinkContext.Provider>
          )}
    </div>
  );
}
