import { MessageListDateDivider } from "@botiverse/raft-ui";
import { PLAN_CONFIG } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { useCurrentDay } from "../../hooks/useCurrentDay";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { formatDayLabel } from "../../utils/timeFormatting";

/**
 * Day-boundary divider for the message timeline (task #44). Rendered before the
 * first message of each calendar day. Also used as the content of the sticky
 * current-day header (task #44), where `sticky` swaps the flat rule for a
 * self-contained pill so it reads over scrolling messages.
 *
 * The flat form is the RUI event row (Space Mono 12, ink-3, between hairlines);
 * the sticky pill keeps the same machine-text treatment on a paper chip.
 */
export function DateDivider({
  createdAt,
  sticky = false,
  recentHistory = false,
  testId,
}: {
  createdAt: string;
  sticky?: boolean;
  /** The first day under the history paywall: "Last 30 days · <day>", so the eye sees where the window starts. */
  recentHistory?: boolean;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const timeZone = options.timeZone ?? undefined;
  // Re-rendered when the day ends: a divider left on screen past midnight
  // turns from "Today" to "Yesterday".
  const today = useCurrentDay(timeZone);
  const label = formatDayLabel(createdAt, {
    today,
    locale: options.locale,
    timeZone,
    todayLabel: formatMessage({ id: "message.dateDivider.today" }),
    yesterdayLabel: formatMessage({ id: "message.dateDivider.yesterday" }),
  });
  if (!label) return null;

  if (sticky) {
    return (
      <div className="pointer-events-none flex justify-center pt-1" data-testid={testId}>
        <span className="rounded-chip border border-line-hairline bg-layer-canvas px-2 py-0.5 font-mono text-mono-meta text-foreground-hint">
          {label}
        </span>
      </div>
    );
  }
  return (
    <MessageListDateDivider data-testid={testId}>
      {recentHistory
        ? formatMessage({ id: "message.historyPaywall.recentDividerWithDate" }, { days: PLAN_CONFIG.free.limits.messageHistoryDays, date: label })
        : label}
    </MessageListDateDivider>
  );
}
