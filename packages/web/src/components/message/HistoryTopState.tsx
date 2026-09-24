import { Lock } from "lucide-react";
import { useIntl } from "react-intl";
import { getHistoryTopState } from "../../utils/historyTopState";
import type { MessageId } from "../../i18n/messages";

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
    // MessageTimeline's geometric sentinel is the single pagination owner for
    // channels, DMs, and threads. Keep progress visible while it fetches, but
    // never expose a second manual pagination path at the top of the list.
    if (loadingOlder) {
      return (
        <div className="pb-2 text-center text-black/50 font-mono text-xs">
          {formatMessage({ id: keys.loadingOlder })}
        </div>
      );
    }
    return null;
  }

  if (state === "history_limited") {
    return (
      <div className="pb-2 text-center text-black/50 font-mono text-xs">
        <span className="inline-flex items-center gap-1.5 border border-black/20 bg-white/70 px-2 py-1">
          <Lock size={12} />
          {formatMessage({ id: keys.limited })}
        </span>
      </div>
    );
  }

  return (
    <div className="pb-2 text-center text-black/40 font-mono text-xs">
      {formatMessage({ id: keys.beginning })}
    </div>
  );
}
