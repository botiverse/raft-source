import { Badge, Button, ScrollArea } from "@botiverse/raft-ui";
import { AlarmClock, Clock, Link, RefreshCw, Repeat } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { ReminderSummary } from "@botiverse/raft-shared";
import Banner from "../ui/Banner";
import EmptyState from "../ui/EmptyState";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import SurfaceListItem from "../ui/SurfaceListItem";
import SectionHeader from "../ui/SectionHeader";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";

function getRelativeTimeParts(value: string): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const date = new Date(value);
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (absMs < hour) return { value: Math.round(diffMs / minute), unit: "minute" };
  if (absMs < day) return { value: Math.round(diffMs / hour), unit: "hour" };
  return { value: Math.round(diffMs / day), unit: "day" };
}

// v0: human surface is read-only — the Cancel action lives on the agent
// side (MCP `cancel_reminder`). Do not wire a cancel button here until the
// v1 product decision on human-initiated cancel lands.
function ReminderCard({
  reminder,
  onOpenMsgRef,
}: {
  reminder: ReminderSummary;
  onOpenMsgRef?: (permalink: string) => void;
}) {
  const { locale } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const handleMsgRefClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!reminder.msgPermalink || !onOpenMsgRef) return;
    // Preserve default behavior for modifier clicks (new tab / new window / save).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpenMsgRef(reminder.msgPermalink);
  };

  return (
    <SurfaceListItem interactive={false}>
      <div className="min-w-0">
        <div className="break-words text-subhead font-semibold text-foreground">{reminder.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-caption text-foreground-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={14} className="shrink-0 text-foreground-muted" />
            {(() => {
              const parts = getRelativeTimeParts(reminder.fireAt);
              return formatRelativeTimeParts(parts.value, parts.unit, locale);
            })()}
          </span>
          <span className="font-mono text-mono-meta text-foreground-hint">{formatShortDateTime(reminder.fireAt)}</span>
          {reminder.recurrence && (
            <Badge appearance="outline">
              <Repeat size={14} className="shrink-0" />
              <span className="truncate">{reminder.recurrence.description}</span>
            </Badge>
          )}
        </div>
        {reminder.msgRef && (
          <div className="mt-2">
            {reminder.msgPermalink ? (
              <a
                href={reminder.msgPermalink}
                onClick={handleMsgRefClick}
                className="inline-flex h-[22px] md:pointer-fine:h-5 max-w-full cursor-default items-center gap-1 truncate rounded-sticker bg-info-soft px-1.5 font-mono text-mono-meta text-foreground outline-none hover:overlay-medium focus-visible:shadow-focus"
              >
                <Link size={14} className="shrink-0 text-foreground-muted" />
                <span className="truncate">{reminder.msgRef}</span>
              </a>
            ) : (
              <span className="inline-flex h-[22px] md:pointer-fine:h-5 max-w-full items-center gap-1 truncate rounded-sticker bg-inactive-soft px-1.5 font-mono text-mono-meta text-foreground-muted">
                <Link size={14} className="shrink-0 text-foreground-muted" />
                <span className="truncate">{reminder.msgRef}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </SurfaceListItem>
  );
}

export default function AgentRemindersSection({
  reminders,
  loading,
  error,
  onRetry,
  onOpenMsgRef,
  variant = "section",
}: {
  reminders: ReminderSummary[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void | Promise<void>;
  onOpenMsgRef?: (permalink: string) => void;
  variant?: "section" | "tab";
}) {
  const { formatMessage } = useIntl();
  const isTab = variant === "tab";
  const handleRetry = useCallback(() => {
    void onRetry?.();
  }, [onRetry]);
  const body = (
    <>
      {isTab ? (
        loading ? <div className="mb-3 text-footnote text-foreground-hint">{formatMessage({ id: "common.loading" })}</div> : null
      ) : (
        <SectionHeader
          className="mb-3"
          icon={<AlarmClock size={16} />}
          label={formatMessage({ id: "agent.reminders.pendingLabel" })}
          count={reminders.length}
          action={
            loading ? (
              <span className="text-caption text-foreground-hint">{formatMessage({ id: "common.loading" })}</span>
            ) : null
          }
        />
      )}

      {error ? (
        <Banner
          intent="warning"
          density="sm"
          actions={onRetry ? (
            <Button variant="outline" size="md" type="button" onClick={handleRetry}>
              <RefreshCw size={16} />
              {formatMessage({ id: "agent.reminders.retry" })}
            </Button>
          ) : undefined}
        >
          {error}
        </Banner>
      ) : reminders.length === 0 ? (
        isTab ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center bg-layer-canvas"
            icon={<AlarmClock size={36} />}
            title={formatMessage({ id: "emptyState.noRemindersTitle" })}
            description={formatMessage({ id: "emptyState.noRemindersDesc" })}
          />
        ) : (
          <div className="text-callout text-foreground-hint">{formatMessage({ id: "agent.reminders.noPending" })}</div>
        )
      ) : (
        <div className="stack-y-3">
          {reminders.map((reminder) => (
            <ReminderCard
              key={reminder.reminderId}
              reminder={reminder}
              onOpenMsgRef={onOpenMsgRef}
            />
          ))}
        </div>
      )}
    </>
  );
  // The tab is its own page and scrolls in a raft-ui ScrollArea, named like
  // the tab (a tab stop once it overflows). The padding stays on the area, so
  // the empty state's full height is the area's. `variant` is fixed per
  // caller, so the element never switches while mounted.
  return isTab ? (
    <ScrollArea
      role="region"
      aria-label={formatMessage({ id: "agent.detail.tab.reminders" })}
      className="flex-1 bg-layer-canvas px-(--surface-inset) py-5"
    >
      {body}
    </ScrollArea>
  ) : (
    <div className="px-(--surface-inset) py-4 border-t border-line-hairline">{body}</div>
  );
}
