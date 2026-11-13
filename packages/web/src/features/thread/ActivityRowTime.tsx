import { memo, useMemo, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { InboxItemTimestamp, Tooltip, TooltipContent, TooltipTrigger } from "@botiverse/raft-ui";
import { subscribeLiveTime } from "../../hooks/liveTimeClock";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { formatRowTime, rowTimeKey } from "../../utils/timeFormatting";
import type { RowTimeCopy } from "../../utils/timeFormatting";

/**
 * An Activity row's time, at the end of its first line (raft-design
 * patterns/lists.md, "Times in list rows"). Today's rows, and any row under an
 * hour old, show it short at rest; an older row shows its clock on hover or
 * keyboard focus, and on a touch screen not at all. `wordsId` names the time in
 * words for the row's trigger, on every row, shown or not.
 *
 * Its own component with its own clock: the row around it is memoized and has
 * none, so a time read at the row's render went stale. This re-renders alone,
 * when its words change, and is memoized since ObjectInboxRow isn't: a list's
 * render would otherwise render every Artifact row's time and tooltip again.
 */
export const ActivityRowTime = memo(function ActivityRowTime({ at, wordsId }: { at: string; wordsId: string }) {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const readKey = () => rowTimeKey(at, options);
  useSyncExternalStore(subscribeLiveTime, readKey, readKey);
  const copy = useMemo<RowTimeCopy>(() => ({
    now: formatMessage({ id: "activity.list.time.now" }),
    minutes: (count) => formatMessage({ id: "activity.list.time.minutes" }, { count }),
    hours: (count) => formatMessage({ id: "activity.list.time.hours" }, { count }),
    yesterdayAt: (time) => formatMessage({ id: "activity.list.time.yesterdayAt" }, { time }),
    dayAt: (day, time) => formatMessage({ id: "activity.list.time.dayAt" }, { day, time }),
  }), [formatMessage]);
  const time = formatRowTime(at, { ...options, copy });
  if (!time) return null;
  return (
    <>
      <Tooltip>
        {/* The trigger's own data-slot would replace the time's, so it says it
            again; the heading finds the time by data-inbox-item-time. */}
        <TooltipTrigger
          render={(
            <InboxItemTimestamp
              reveal={time.older ? "hover" : undefined}
              aria-hidden
              // A title that takes only the room it needs (a badge after it) leaves the time at the line's end.
              className="ml-auto"
              data-testid="conversation-card-timestamp"
            />
          )}
          data-slot="inbox-item-timestamp"
        >
          {time.shown}
        </TooltipTrigger>
        <TooltipContent>{time.words}</TooltipContent>
      </Tooltip>
      <span id={wordsId} hidden data-testid="conversation-card-time-words">{time.words}</span>
    </>
  );
});
