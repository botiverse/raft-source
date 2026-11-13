import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { Separator } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import { formatActivityText, freshnessHoldLabelId, getActivityText } from "../../utils/activity";
import type { TrajectoryLogEntry } from "../../store/agentStore";
import { getToolLogLabel, shouldHideToolStartInActivityLog } from "@botiverse/raft-shared";
import type { AgentActivity } from "@botiverse/raft-shared";
import StatusDot from "../ui/StatusDot";
import SectionEyebrow from "../ui/SectionEyebrow";
import Tooltip from "../ui/Tooltip";

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
   * Optional: the card also renders where there is nothing to open (no
   * agent-activity handler from its host), and the heading stays static text
   * there rather than offering a dead click.
   */
  onOpenActivity?: () => void;
}

// Entry kinds this preview knows how to describe. A newer daemon or server may
// send a kind this bundle predates; it is skipped rather than rendered.
// Record keyed by every kind: adding a kind to TrajectoryEntry fails to compile until it is listed here.
const PREVIEW_ENTRY_KIND_SHOWN = {
  thinking: true,
  tool_start: true,
  text: true,
  slock_action: true,
  system: true,
  compaction_started: true,
  compaction_finished: true,
  status: true,
  // A per-turn record for the Activity overview, not a step of recent activity.
  turn_summary: false,
} satisfies Record<TrajectoryLogEntry["entry"]["kind"], boolean>;
const PREVIEW_ENTRY_KINDS: ReadonlySet<string> = new Set(
  Object.entries(PREVIEW_ENTRY_KIND_SHOWN).filter(([, shown]) => shown).map(([kind]) => kind),
);

function isVisibleTrajectoryPreviewEntry(item: TrajectoryLogEntry): boolean {
  if (!PREVIEW_ENTRY_KINDS.has(item.entry.kind)) return false;
  // A freshness hold arrives as a status row and an action entry with the
  // same label; show it once, like the raw log.
  if (item.entry.kind === "status" && item.entry.detailKind === "freshness_hold") return false;
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
    case "slock_action": {
      const freshnessHold = freshnessHoldLabelId(entry.title);
      return freshnessHold && formatMessage ? formatMessage({ id: freshnessHold }) : entry.title;
    }
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
    case "turn_summary":
      return "";
    default: {
      // Compile-time: every known kind is handled above. Runtime: an unknown
      // kind from a newer producer yields no text instead of the entry object.
      const _exhaustive: never = entry;
      void _exhaustive;
      return "";
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
    <>
    <Separator />
    <div className="px-4 py-3 last:pb-4">
      {/* The heading itself is the link, which is what the request asked for.
          Both forms are the DS section title (13/18 700, ink-3, no caps); the
          clickable one adds the ink underline of a UI text link on hover. */}
      {onOpenActivity ? (
        <SectionEyebrow
          as="button"
          onClick={onOpenActivity}
          data-testid="mention-hover-activity-open"
          className="mb-2 flex items-center gap-0.5 rounded-[2px] outline-none hover:text-foreground hover:underline hover:decoration-[1.5px] hover:underline-offset-[3px] focus-visible:shadow-focus"
        >
          {formatMessage({ id: "activity.preview.recentActivity" })}
          <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
        </SectionEyebrow>
      ) : (
        <SectionEyebrow as="div" className="mb-2">
          {formatMessage({ id: "activity.preview.recentActivity" })}
        </SectionEyebrow>
      )}
      <div className="stack-y-1.5">
        {recentEntries.map((entry) => (
          <div
            key={entry.key}
            data-testid="mention-hover-activity-row"
            className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-mono-meta"
          >
            <span className="shrink-0 whitespace-nowrap text-foreground-hint">
              {formatTimestamp(entry.timestamp)}
            </span>
            <StatusDot activity={entry.activity} size="sm" className="shrink-0" />
            <Tooltip content={entry.text}>
              <span className="min-w-0 flex-1 truncate text-foreground-muted">
                {entry.text}
              </span>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
    </>
  );
}
