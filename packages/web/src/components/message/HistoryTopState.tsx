import { Lock } from "lucide-react";
import { useIntl } from "react-intl";
import { getHistoryTopState } from "../../utils/historyTopState";
import type { MessageId } from "../../i18n/messages";
import { ContentLoading } from "../ui/ContentLoading";
import { TIMELINE_NOTICE_ROW } from "./composerHost";

// The history-top copy differs by list noun (channel/DM "messages" vs thread
// "replies"). zh grammar changes the noun's position per sentence, so each
// noun+sentence is its own catalog key rather than a spliced {noun} argument.
const NOUN_KEYS: Record<"messages" | "replies", { loadingOlder: MessageId; limited: MessageId; beginning: MessageId }> = {
  messages: {
    loadingOlder: "message.historyTop.loadingOlderMessages",
    limited: "message.historyTop.messagesLimited",
    beginning: "message.historyTop.beginningOfMessages",
  },
  replies: {
    loadingOlder: "message.historyTop.loadingOlderReplies",
    limited: "message.historyTop.repliesLimited",
    beginning: "message.historyTop.beginningOfReplies",
  },
};

export default function HistoryTopState({
  hasMore,
  historyLimited,
  loadingOlder,
  noun,
}: {
  hasMore: boolean;
  historyLimited: boolean;
  loadingOlder: boolean;
  noun: "messages" | "replies";
}) {
  const { formatMessage } = useIntl();
  const keys = NOUN_KEYS[noun];
  const state = getHistoryTopState({ hasMore, historyLimited });

  if (state === "load_older") {
    // MessageTimeline (loading pages near the loaded edges) is the single
    // pagination owner for channels, DMs, and threads. Keep progress visible while it fetches, but
    // never expose a second manual pagination path at the top of the list.
    if (loadingOlder) {
      // Stable hook for tests that must observe the CONVERSATION list's own
      // pagination hint (task #503). The noun discriminates the two consumers:
      // "messages" = channel/DM list, "replies" = thread panel. Scanning the
      // scroller's textContent for "Loading" was a false-positive: message
      // bodies and attachment states also contain that word.
      return (
        <div
          data-testid={noun === "messages" ? "list-loading-older" : "thread-loading-older"}
          className={TIMELINE_NOTICE_ROW}
        >
          <ContentLoading>{formatMessage({ id: keys.loadingOlder })}</ContentLoading>
        </div>
      );
    }
    return null;
  }

  if (state === "history_limited") {
    return (
      <div className={`${TIMELINE_NOTICE_ROW} text-center font-mono text-mono-meta text-foreground-hint`}>
        <span className="inline-flex items-center gap-1.5 rounded-chip border border-line-hairline bg-layer-canvas px-2 py-1">
          <Lock size={12} />
          {formatMessage({ id: keys.limited })}
        </span>
      </div>
    );
  }

  return (
    <div className={`${TIMELINE_NOTICE_ROW} text-center font-mono text-mono-meta text-foreground-hint`}>
      {formatMessage({ id: keys.beginning })}
    </div>
  );
}
