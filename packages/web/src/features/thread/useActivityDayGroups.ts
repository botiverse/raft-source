import { useMemo } from "react";
import { useIntl } from "react-intl";
import { useCurrentDay } from "../../hooks/useCurrentDay";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { ActivitySortDirection, InboxItem } from "../../store/inboxStore";
import { groupInboxRowsByDay } from "./activityDayGroups";
import type { ActivityDayGroup } from "./activityDayGroups";

/** The listed rows by day, with headings that flip when the person's day ends. */
export function useActivityDayGroups(items: readonly InboxItem[], sortDirection: ActivitySortDirection): ActivityDayGroup[] {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const timeZone = options.timeZone ?? undefined;
  const today = useCurrentDay(timeZone);
  const { locale } = options;
  return useMemo(() => groupInboxRowsByDay(items, {
    today,
    timeZone,
    locale,
    todayLabel: formatMessage({ id: "message.dateDivider.today" }),
    yesterdayLabel: formatMessage({ id: "message.dateDivider.yesterday" }),
    sortDirection,
  }), [formatMessage, items, locale, sortDirection, timeZone, today]);
}
