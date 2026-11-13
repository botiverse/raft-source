import type { IntlShape } from "react-intl";
import { readChannelAnnouncementNotice } from "@botiverse/raft-shared";
import type { ChannelAnnouncementNotice } from "@botiverse/raft-shared";

/**
 * The event line a channel's announcement change posts (#proj-chat:#29: set,
 * replaced, removed; shared ChannelAnnouncementNotice in the system message's
 * `actionMetadata`), in the reader's language: "Martin set the announcement:
 * Release rules for 1.9". The stored text (English, `@handle`) is the record
 * agents and older clients read; null for any other system message.
 */
export function channelAnnouncementNoticeLine(actionMetadata: unknown, formatMessage: IntlShape["formatMessage"]): string | null {
  const notice = readChannelAnnouncementNotice(actionMetadata);
  return notice ? lineOf(notice, formatMessage) : null;
}

function lineOf(notice: ChannelAnnouncementNotice, formatMessage: IntlShape["formatMessage"]): string {
  const name = notice.actor.name ?? formatMessage({ id: "channel.announcement.someone" });
  if (notice.title === null) {
    switch (notice.change) {
      case "set": return formatMessage({ id: "channel.announcement.event.setUntitled" }, { name });
      case "replaced": return formatMessage({ id: "channel.announcement.event.replacedUntitled" }, { name });
      case "removed": return formatMessage({ id: "channel.announcement.event.removedUntitled" }, { name });
    }
  }
  const values = { name, title: notice.title };
  switch (notice.change) {
    case "set": return formatMessage({ id: "channel.announcement.event.set" }, values);
    case "replaced": return formatMessage({ id: "channel.announcement.event.replaced" }, values);
    case "removed": return formatMessage({ id: "channel.announcement.event.removed" }, values);
  }
}
