import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import type { IntlShape } from "react-intl";
import { formatActivityText, getActivityText } from "../../utils/activity";
import type { TrajectoryLogEntry } from "../../store/agentStore";
import { getToolLogLabel, shouldHideToolStartInActivityLog } from "@botiverse/raft-shared";
import type { AgentActivity } from "@botiverse/raft-shared";
import StatusDot from "../ui/StatusDot";

const MAX_RECENT_ACTIVITY_ROWS = 5;

interface ActivityPreviewRow {
  key: string;
  timestamp: number;
  activity: AgentActivity;
  text: string;
}

interface MentionHoverActivityPreviewProps {
  entries: TrajectoryLogEntry[];
  formatTimestamp: (timestamp: number) => string;
  /**
   * Opens this agent's activity. Supplied by the surface that owns the hover
   * card, because that surface is the one that can dismiss it first — see the
   * `close()`-before-navigate rule the sibling mention/avatar clicks follow.
   *
   * Optional: the card also renders where there is nothing to open (settings
   * member graph), and the heading stays static text there rather than
   * offering a dead click.
   */
  onOpenActivity?: () => void;
}

function isVisibleTrajectoryPreviewEntry(item: TrajectoryLogEntry): boolean {
  return item.entry.kind !== "tool_start" || !shouldHideToolStartInActivityLog(item.entry.toolName);
}

function getTrajectoryPreviewText(item: TrajectoryLogEntry, formatMessage?: IntlShape["formatMessage"]): string {
  const { entry } = item;
  switch (entry.kind) {
    case "thinking":
      return entry.text || (formatMessage
        ? formatMessage({ id: "mention.activity.thinking" })
        : "Thinking");
    case "tool_start":
      return getToolLogLabel(entry.toolName);
    case "text":
      return entry.text || (formatMessage
        ? formatMessage({ id: "mention.activity.output" })
        : "Output");
    case "slock_action":
    case "system":
      return entry.title;
    case "compaction_started":
      return formatMessage
        ? formatMessage({ id: "mention.activity.compactionStarted" })
        : "Context Compaction Started";
    case "compaction_finished":
      return formatMessage
        ? formatMessage({ id: "mention.activity.compactionFinished" })
        : "Context Compaction Finished";
    case "status":
      return formatMessage
        ? formatActivityText(formatMessage, entry.activityKind ?? entry.activity, entry.detail, entry.detailKind)
        : getActivityText(entry.activityKind ?? entry.activity, entry.detail, entry.detailKind);
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

function getTrajectoryPreviewActivity(item: TrajectoryLogEntry): AgentActivity {
  // Per-row icon mapping only: trajectory entries do not infer current state or freshness.
  const { entry } = item;
  switch (entry.kind) {
    case "thinking":
      return "thinking";
    case "compaction_finished":
      return "online";
    case "status":
      return entry.activityKind ?? entry.activity;
    default:
      return "working";
  }
}

export function getRecentActivityPreviewRows(
  entries: TrajectoryLogEntry[],
  formatMessage?: IntlShape["formatMessage"],
): ActivityPreviewRow[] {
  return entries
    .filter(isVisibleTrajectoryPreviewEntry)
    .slice(-MAX_RECENT_ACTIVITY_ROWS)
    .map((entry) => ({
      key: `${entry.timestamp}:${entry.entry.kind}:${getTrajectoryPreviewText(entry, formatMessage)}`,
      timestamp: entry.timestamp,
      activity: getTrajectoryPreviewActivity(entry),
      text: getTrajectoryPreviewText(entry, formatMessage),
    }));
}

export default function MentionHoverActivityPreview({ entries, formatTimestamp, onOpenActivity }: MentionHoverActivityPreviewProps) {
  const { formatMessage } = useIntl();
  const recentEntries = getRecentActivityPreviewRows(entries, formatMessage);
  if (recentEntries.length === 0) return null;
  return (
    <div className="border-t-2 border-black px-3 py-2">
      {/* The heading itself is the link, which is what the request asked for.
          It therefore drops `uppercase`: `clickableCaseContract` requires
          clickable labels to be Title Case and reserves UPPERCASE for static
          dividers, so a clickable uppercase heading is exactly the mismatch
          that doctrine exists to prevent. The copy is already Title Case. */}
      {onOpenActivity ? (
        <button
          type="button"
          onClick={onOpenActivity}
          data-testid="mention-hover-activity-open"
          className="mb-1.5 flex items-center gap-0.5 text-[10px] font-bold tracking-wide text-black/50 hover:text-black hover:underline"
        >
          {formatMessage({ id: "activity.preview.recentActivity" })}
          <ChevronRight size={10} className="shrink-0" aria-hidden="true" />
        </button>
      ) : (
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-black/50">
          {formatMessage({ id: "activity.preview.recentActivity" })}
        </div>
      )}
      <div className="space-y-1.5">
        {recentEntries.map((entry) => (
          <div
            key={entry.key}
            data-testid="mention-hover-activity-row"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs"
          >
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-black/40">
              {formatTimestamp(entry.timestamp)}
            </span>
            <StatusDot activity={entry.activity} size="sm" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-black/70" title={entry.text}>
              {entry.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
