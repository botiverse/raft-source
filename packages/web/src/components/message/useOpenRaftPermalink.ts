import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { toast } from "@botiverse/raft-ui";
import { parseRaftPermalink } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import { useServerStore } from "../../store/serverStore";

/**
 * Opening a Raft message permalink from a text the message renderer draws
 * (PermalinkReferenceChip): in place on this server (a joint link from
 * another server through this server's projection of it), else in a new tab.
 */
export function useOpenRaftPermalink(): (href: string) => Promise<void> {
  const { formatMessage } = useIntl();
  // Read at click time, so a locale switch doesn't make a new handler.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const nav = useAppNavigate();
  const permalinkHostnames = useRaftPermalinkHostnames();
  const serverSlug = useServerStore((s) => s.current?.slug);
  return useCallback(async (href: string) => {
    let permalink = parseRaftPermalink(href, permalinkHostnames);
    if (!permalink) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    if (serverSlug && permalink.serverSlug !== serverSlug && permalink.routeKind === "channel") {
      const { serverEpoch, current } = useServerStore.getState();
      try {
        const { data } = await api.get<{
          channelId: string;
          targetMessageId: string;
          canonicalTarget?: { kind: string; channelId: string; threadParentMessageId: string };
        }>(`/messages/context/${encodeURIComponent(permalink.messageId)}`, {
          params: { channelId: permalink.channelId },
          headers: { "X-Server-Id": current?.id },
        });
        if (useServerStore.getState().serverEpoch !== serverEpoch) return;
        // The context endpoint authorizes the local projection and returns its
        // canonical navigation target, including reply-to-thread projection.
        const target = data.canonicalTarget;
        permalink = {
          ...permalink,
          serverSlug,
          channelId: target?.kind === "thread" ? target.channelId : data.channelId,
          messageId: data.targetMessageId ?? permalink.messageId,
          threadParentMessageId: target?.kind === "thread" ? target.threadParentMessageId : permalink.threadParentMessageId,
        };
      } catch (error) {
        if (useServerStore.getState().serverEpoch !== serverEpoch) return;
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status !== 404) {
          toast.error(formatMessageRef.current({ id: "message.messageItem.linkResolutionUnavailable" }));
          return;
        }
        // No readable local projection exists. An unrelated workspace link
        // keeps its original destination, whose own access checks still apply.
      }
    }

    if (serverSlug && permalink.serverSlug === serverSlug) {
      if (permalink.threadParentMessageId) {
        nav.toThreadMessage(
          permalink.channelId,
          permalink.threadParentMessageId,
          permalink.messageId,
          permalink.routeKind,
        );
      } else if (permalink.routeKind === "dm") {
        nav.toDmMessage(permalink.channelId, permalink.messageId);
      } else {
        nav.toMessage(permalink.channelId, permalink.messageId);
      }
      return;
    }

    window.open(href, "_blank", "noopener,noreferrer");
  }, [nav, permalinkHostnames, serverSlug]);
}
