import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { isThreadMismatch, parseMessageLink } from "../../utils/messageLinkLanding";
import { buildMessagePath } from "../../utils/messagePath";

interface MessageContextAnswer {
  channelId: string;
  targetMessageId?: string;
  canonicalTarget?: { kind: string; channelId: string; threadParentMessageId: string };
}

/**
 * A channel message link this server can't show: a joint channel the reader
 * takes part in only through another of their servers (a link copied by a
 * member of this server names this server's copy). Asks each other server
 * the reader belongs to whether it can show the message, the same way
 * MessageItem resolves a link from another server, and moves the link to
 * the first that can (that server's copy of the channel, with the thread).
 *
 * `missing`: this server answered that the channel isn't there for the
 * reader. Returns true while the other servers are asked, so the caller
 * keeps its loading state instead of flashing "not found".
 */
export function useOtherServerMessageLink(channelId: string, missing: boolean): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const target = parseMessageLink(location.pathname, location.search);
  // A link whose thread names another conversation stays rejected (MainLayout's landing block).
  const usable = target?.routeKind === "channel" && target.channelId === channelId && !isThreadMismatch(target);
  const linkMessageId = usable ? target.messageId : null;
  const threadParentMessageId = usable ? target.threadParentMessageId : null;
  // What to look up: the message, or for a thread-only link its parent.
  const lookupId = linkMessageId ?? threadParentMessageId;
  const hasOtherServers = useServerStore((s) => s.servers.some((server) => server.id !== s.current?.id));
  const askKey = missing && lookupId && hasOtherServers ? `${channelId}\u0000${lookupId}` : null;
  const [askedKey, setAskedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!askKey || !lookupId) return;
    const { current, servers, serverEpoch } = useServerStore.getState();
    const others = servers.filter((server) => server.id !== current?.id);
    let cancelled = false;
    void (async () => {
      // One server at a time: a reader has few servers, and the first that
      // can show the message is enough.
      for (const server of others) {
        try {
          const { data } = await api.get<MessageContextAnswer>(`/messages/context/${encodeURIComponent(lookupId)}`, {
            params: { channelId },
            headers: { "X-Server-Id": server.id },
          });
          if (cancelled) return;
          if (useServerStore.getState().serverEpoch !== serverEpoch) break;
          const thread = data.canonicalTarget?.kind === "thread" ? data.canonicalTarget : null;
          const localChannelId = thread ? thread.channelId : data.channelId;
          const localThreadParentId = thread ? thread.threadParentMessageId : threadParentMessageId;
          const base = `/s/${encodeURIComponent(server.slug)}`;
          navigate(
            linkMessageId
              ? buildMessagePath(base, localChannelId, data.targetMessageId ?? linkMessageId, { threadParentMessageId: localThreadParentId })
              : `${base}/channel/${encodeURIComponent(localChannelId)}?${new URLSearchParams({ thread: `${localChannelId}:${localThreadParentId}` }).toString()}`,
            { replace: true },
          );
          return;
        } catch {
          // Not readable from this server either (or it didn't answer): ask the next.
          if (cancelled) return;
        }
      }
      if (!cancelled) setAskedKey(askKey);
    })();
    return () => {
      cancelled = true;
    };
  }, [askKey, channelId, lookupId, linkMessageId, threadParentMessageId, navigate]);

  return askKey !== null && askedKey !== askKey;
}
