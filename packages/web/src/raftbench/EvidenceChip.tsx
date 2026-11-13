import { useCallback, useState } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { MessageSquareText } from "lucide-react";
import api from "../api/client";
import { ReferenceChip } from "../components/message/ReferenceChip";
import { useThreadStore } from "../store/threadStore";
import { readHistoryLimitedError } from "../store/hiddenHistoryStore";
import type { ContextCanonicalTarget } from "../store/hiddenHistoryStore";
import { resolveThreadTargetByShortId } from "../utils/threadRefNavigation";
import { parseEvidenceTarget } from "./evidenceTarget";

/** A cited message, drawn as the chat's own message-reference chip. Opening it
 *  uses the side thread panel, the same surface as channel → thread, so the
 *  source is read through the normal message permissions and never copied into
 *  findings. A reply resolves its parent the way a chat thread reference does
 *  and opens focused on the reply. A source outside the readable channels, or a
 *  thread that no longer resolves, stays a static chip. */
export function EvidenceChip({ target, messageId, channelId }: { target: string; messageId: string; channelId: string | null }) {
  const { formatMessage: t } = useIntl();
  const openThread = useThreadStore(s => s.openThread);
  const [unavailable, setUnavailable] = useState(false);
  const { threadShortId } = parseEvidenceTarget(target);
  const open = useCallback(async (event: MouseEvent) => {
    event.preventDefault();
    if (!channelId) return;
    if (!threadShortId) { void openThread({ parentChannelId: channelId, parentMessageId: messageId, intent: "thread" }); return; }
    const { summaries, followedThreads } = useThreadStore.getState();
    const thread = await resolveThreadTargetByShortId({
      serverSlug: "", parentChannelId: channelId, shortId: threadShortId, summaries, followedThreads,
      loadContext: async (parentChannelId, shortId) => {
        try {
          const { data } = await api.get<{ targetMessageId?: string | null; canonicalTarget?: ContextCanonicalTarget | null }>(`/messages/context/${shortId}`, { params: { channelId: parentChannelId } });
          return data;
        } catch (error) {
          const hidden = readHistoryLimitedError(error);
          if (hidden) return hidden;
          throw error;
        }
      },
    });
    if (!thread) { setUnavailable(true); return; }
    void openThread({ parentChannelId: thread.parentChannelId, parentMessageId: thread.parentMessageId, threadChannelId: thread.threadChannelId ?? null, focusedMessageId: messageId, intent: "thread" });
  }, [openThread, channelId, messageId, threadShortId]);
  const label = <>{target}<span className="ml-1 font-mono text-label font-normal text-foreground-hint">{messageId.slice(0, 8)}</span></>;
  return channelId && !unavailable
    ? <ReferenceChip as="a" href="#" onClick={open} icon={MessageSquareText} variant="link" label={label} />
    : <ReferenceChip icon={MessageSquareText} variant="muted" label={label} title={t({ id: "raftbench.aiSourceUnavailable" })} />;
}
