import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Badge } from "raft-ui";
import { useAgentStore } from "../../store/agentStore";
import type { TrajectoryLogEntry } from "../../store/agentStore";
import StatusDot from "../ui/StatusDot";
import { getSocket } from "../../api/socket";
import { registerActivityTrajectoryLiveReload, registerActivityTrajectoryReconnectReload } from "../../utils/activityTrajectoryRecovery";
import { getToolLogLabel, shouldHideToolStartInActivityLog } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, SubagentLineage } from "@botiverse/raft-shared";
import { Activity, ChevronRight } from "lucide-react";
import EmptyState from "../ui/EmptyState";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { RefText, ThreadRefNoticeProvider } from "./RefText";
import type { MessageId } from "../../i18n/messages";

const EMPTY_LOG: TrajectoryLogEntry[] = [];

function isVisibleTrajectoryEntry(item: TrajectoryLogEntry): boolean {
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

function SubagentBadge({ subagentType }: { subagentType?: string }) {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="outline" variant="default" uppercase className="ml-1.5 font-mono align-middle">
      {subagentType
        ? formatMessage({ id: "activity.log.subagentWithType" }, { type: subagentType })
        : formatMessage({ id: "activity.log.subagent" })}
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
  if (detailKind === "runtime_crashed") return "activity.log.status.crashed";
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
        : detailKind === "runtime_crashed"
          ? "Crashed"
          : "Offline";
    const stoppedReason = detailKind === "stopped" && detail && detail !== primaryFallback ? detail : "";
    // For most offline rows, the label already encodes the cause, so detail would
    // duplicate. Stopped rows now carry a second-level reason that distinguishes
    // user stop from Computer shutdown without adding a new detailKind enum.
    return {
      primary,
      secondary: detailKind === "runtime_crashed"
        ? detail
        : stoppedReason
          ? ` - ${stoppedReason}`
          : "",
    };
  }

  return { primary: ACTIVITY_LABEL_IDS[activity] || { raw: activity }, secondary: detail };
}

type FormatTimestamp = (timestamp: number) => string;

function ThinkingEntry({ text, timestamp, formatTimestamp }: { text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" tone="bg-status-busy" pulse className="mt-1.5" />
      <div className="text-sm min-w-0 flex-1">
        <button
          type="button"
          onClick={() => isLong && setExpanded(!expanded)}
          className={`flex items-center gap-1 font-medium text-black ${isLong ? "hover:text-black/70" : "cursor-default"}`}
        >
          {formatMessage({ id: "activity.log.thinking" })}
          {isLong && (
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        <p
          className={`text-black/50 text-xs font-mono mt-0.5 whitespace-pre-wrap break-words ${
            !expanded && isLong ? "line-clamp-2" : ""
          }`}
        >
          {text}
        </p>
      </div>
    </div>
  );
}

function ToolStartEntry({ toolName, toolInput, timestamp, formatTimestamp, subagent }: { toolName: string; toolInput: string; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"] }) {
  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" tone="bg-status-busy" className="mt-1.5" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-medium text-black">{getToolLogLabel(toolName)}</span>
        {subagent && <SubagentBadge subagentType={subagent.subagentType} />}
        {toolInput && (
          <span className="text-black/50 ml-1.5 font-mono text-xs break-all">{toolInput}</span>
        )}
      </div>
    </div>
  );
}

function TextEntry({ text, timestamp, formatTimestamp }: { text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" tone="bg-brutal-cyan" className="mt-1.5" />
      <div className="text-sm min-w-0 flex-1">
        <button
          type="button"
          onClick={() => isLong && setExpanded(!expanded)}
          className={`flex items-center gap-1 font-medium text-black ${isLong ? "hover:text-black/70" : "cursor-default"}`}
        >
          {formatMessage({ id: "activity.log.output" })}
          {isLong && (
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        <p
          className={`text-black/50 text-xs font-mono mt-0.5 whitespace-pre-wrap break-words ${
            !expanded && isLong ? "line-clamp-2" : ""
          }`}
        >
          {text}
        </p>
      </div>
    </div>
  );
}

function SystemEntry({ title, text, timestamp, formatTimestamp }: { title: string; text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" tone="bg-brutal-orange" className="mt-1.5" />
      <div className="text-sm min-w-0 flex-1">
        <button
          type="button"
          onClick={() => isLong && setExpanded(!expanded)}
          className={`flex items-center gap-1 font-medium text-black ${isLong ? "hover:text-black/70" : "cursor-default"}`}
        >
          {title}
          {isLong && (
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        <p
          className={`text-black/50 text-xs font-mono mt-0.5 whitespace-pre-wrap break-words ${
            !expanded && isLong ? "line-clamp-2" : ""
          }`}
        >
          <RefText text={text} />
        </p>
      </div>
    </div>
  );
}

function SlockActionEntry({ title, text, timestamp, formatTimestamp }: { title: string; text: string; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" tone="bg-blue-300" className="mt-1.5" />
      <div className="text-sm min-w-0 flex-1">
        <button
          type="button"
          onClick={() => isLong && setExpanded(!expanded)}
          className={`flex items-center gap-1 font-medium text-black ${isLong ? "hover:text-black/70" : "cursor-default"}`}
        >
          {title}
          {isLong && (
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
        </button>
        <p
          className={`text-black/50 text-xs font-mono mt-0.5 whitespace-pre-wrap break-words ${
            !expanded && isLong ? "line-clamp-2" : ""
          }`}
        >
          {/* Ref linkification is scoped to the structured-metadata entry
              kinds — SlockAction (slock-cli target: #channel:shortid …),
              System, and Status — where a #channel / thread / dm token is a
              real navigation target. NOT Output/Thinking/Tool: those are
              free-form agent text where #x is incidental and linkifying it
              is noise. task #266 follow-up, xxchan #proj-uiux:2921feaf. */}
          <RefText text={text} />
        </p>
      </div>
    </div>
  );
}

function StatusEntry({ activity, detail, detailKind, timestamp, formatTimestamp, subagent }: { activity: AgentActivity; detail: string; detailKind?: AgentActivityDetailKind; timestamp: number; formatTimestamp: FormatTimestamp; subagent?: SubagentLineage["subagent"] }) {
  const { formatMessage } = useIntl();
  const { primary, secondary } = resolveStatusDisplay(activity, detail, detailKind);
  const primaryText = typeof primary === "string" ? formatMessage({ id: primary }) : primary.raw;
  return (
    <div className="flex items-start gap-2 py-1 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot size="sm" activity={activity} className="mt-1.5" />
      <span className="min-w-0 flex-1 text-sm text-black">
        <span className="font-medium">{primaryText}</span>
        {subagent && <SubagentBadge subagentType={subagent.subagentType} />}
        {secondary && (
          <span className="ml-1.5 break-words text-black/60">
            <RefText text={secondary} />
          </span>
        )}
      </span>
    </div>
  );
}

function CompactionEntry({ phase, timestamp, formatTimestamp }: { phase: "started" | "finished"; timestamp: number; formatTimestamp: FormatTimestamp }) {
  const { formatMessage } = useIntl();
  const isStarted = phase === "started";

  return (
    <div className="flex items-start gap-2 py-1.5 px-3 hover:bg-black/5 transition-colors">
      <span className="shrink-0 font-mono text-xs text-black/40 mt-0.5 whitespace-nowrap">
        {formatTimestamp(timestamp)}
      </span>
      <StatusDot
        size="sm"
        tone={isStarted ? "bg-brutal-orange" : "bg-brutal-lime"}
        className="mt-1.5"
      />
      <span className="text-sm text-black font-medium">
        {formatMessage({ id: isStarted ? "activity.log.compactionStarted" : "activity.log.compactionFinished" })}
      </span>
    </div>
  );
}

function TrajectoryItem({ item, formatTimestamp }: { item: TrajectoryLogEntry; formatTimestamp: FormatTimestamp }) {
  const { entry, timestamp } = item;
  const subagent = subagentLineage(item);

  switch (entry.kind) {
    case "thinking":
      return <ThinkingEntry text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "tool_start":
      return <ToolStartEntry toolName={entry.toolName} toolInput={entry.toolInput} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent} />;
    case "text":
      return <TextEntry text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "slock_action":
      return <SlockActionEntry title={entry.title} text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "system":
      return <SystemEntry title={entry.title} text={entry.text} timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "compaction_started":
      return <CompactionEntry phase="started" timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "compaction_finished":
      return <CompactionEntry phase="finished" timestamp={timestamp} formatTimestamp={formatTimestamp} />;
    case "status":
      return <StatusEntry activity={entry.activityKind ?? entry.activity} detail={entry.detail} detailKind={entry.detailKind} timestamp={timestamp} formatTimestamp={formatTimestamp} subagent={subagent} />;
  }
}

export default function AgentActivityLog({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const log = useAgentStore((s) => s.trajectoryLogs[agentId] ?? EMPTY_LOG);
  const visibleLog = log.filter(isVisibleTrajectoryEntry);
  const loadTrajectoryLog = useAgentStore((s) => s.loadTrajectoryLog);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { formatClockWithSeconds } = useTimeFormatter();
  const formatTimestamp = (timestamp: number) => formatClockWithSeconds(timestamp).toUpperCase();

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

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [log.length]);

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
        className="flex flex-1 flex-col items-center justify-center bg-white"
        icon={<Activity size={36} />}
        title={formatMessage({ id: "emptyState.noActivityTitle" })}
        description={formatMessage({ id: "emptyState.noActivityDesc" })}
      />
    );
  }

  return (
    <ThreadRefNoticeProvider onNotice={showThreadRefNotice}>
      <div className="flex flex-1 flex-col min-h-0 bg-white">
        <div className="flex-1 overflow-y-auto py-2">
          {visibleLog.map((item, i) => (
            <TrajectoryItem key={`${item.timestamp}-${i}`} item={item} formatTimestamp={formatTimestamp} />
          ))}
          <div ref={bottomRef} />
        </div>
        {threadRefNotice ? (
          <div className="shrink-0 border-t-2 border-black bg-brutal-orange/20 px-3 py-1.5 text-xs font-mono text-black">
            {formatMessage({ id: threadRefNotice })}
          </div>
        ) : null}
      </div>
    </ThreadRefNoticeProvider>
  );
}
