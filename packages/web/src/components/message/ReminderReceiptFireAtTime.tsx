import { useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { currentDate } from "@botiverse/raft-shared";
import { subscribeDayTurn } from "../../hooks/useCurrentDay";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { formatReminderReceiptTime } from "../../utils/reminderReceiptTime";

/**
 * When a reminder fires, in a receipt line: "today at 15:00", "tomorrow at
 * 15:00", else the date. Its own component with the day's clock: the message
 * row around it stays mounted while the channel is open, so words read at the
 * row's render still said "tomorrow" on the day itself.
 */
export function ReminderReceiptFireAtTime({ value }: { value: string }) {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const read = () => formatReminderReceiptTime(value, formatMessage, currentDate(), options);
  return useSyncExternalStore(subscribeDayTurn, read, read);
}
