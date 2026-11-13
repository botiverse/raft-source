import { useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import api from "../../api/client";
import { artifactLinkSendNoteKey } from "../../apps/artifacts";
import { normalizeSendMessageResponse } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { detectBrowserTimezone } from "../../utils/timeFormatting";
import type { ForwardOutcome, ForwardResolved, ForwardSource } from "./forwardComposerModel";

/** The note's cap as for a Forward of messages (4000), less the room the link takes after it. */
const NOTE_MAX_CHARS = 4000;

/** The message's text: the note, if any, then the link on a line of its own. */
export function artifactLinkMessage(link: string, note: string): string {
  const said = note.trim();
  return said ? `${said}\n\n${link}` : link;
}

/**
 * An Artifact's link as what the Forward dialog sends (the public page's
 * "Send to conversation", #proj-workspace:#128): one ordinary message per
 * chosen conversation (POST /v2/messages, the composer's send), its text the
 * link (the note before it). The conversation draws the link as the
 * Artifact's card. Each goes with its destination's server (X-Server-Id): the
 * current one, or another server's found by the search across servers. Each
 * conversation keeps its randomId until it has the message, so a retry is the
 * same send. Nothing is put into the open server's message lists: the page
 * shows none. `onSent` hears each server a message reached.
 */
export function useArtifactLinkForwardSource({ link, preview, onSent }: {
  link: string;
  preview: ReactNode;
  onSent?: (serverId: string) => void;
}): ForwardSource {
  const { formatMessage } = useIntl();
  const randomIds = useRef(new Map<string, string>());

  const send = useCallback(async (destinations: ForwardResolved[], note: string): Promise<ForwardOutcome> => {
    const content = artifactLinkMessage(link, note);
    const currentServerId = useServerStore.getState().current?.id ?? null;
    const results = await Promise.allSettled(destinations.map(async ({ channelId, serverId: found }) => {
      const serverId = found ?? currentServerId;
      if (!serverId) throw new Error("no server");
      let randomId = randomIds.current.get(channelId);
      if (!randomId) {
        randomId = crypto.randomUUID();
        randomIds.current.set(channelId, randomId);
      }
      const { data } = await api.post("/v2/messages", {
        channelId,
        content,
        randomId,
        timezone: detectBrowserTimezone() ?? undefined,
      }, { headers: { "X-Server-Id": serverId } });
      const { message } = normalizeSendMessageResponse(data);
      randomIds.current.delete(channelId);
      onSent?.(serverId);
      return { channelId, messageId: message.id, serverId };
    }));
    // The rest failed: they stay chosen, to try again (the dialog says how many).
    return { sent: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])), held: null };
  }, [link, onSent]);

  return useMemo(() => ({
    title: formatMessage({ id: "artifacts.share.title" }),
    // The preview card names it and its version (#250).
    summary: null,
    sendLabel: formatMessage({ id: "artifacts.share.send" }),
    detailTitle: null,
    renderPreview: () => preview,
    notices: null,
    blockedReason: null,
    // A link, not a snapshot: whoever opens it there sees what the Artifact's own server lets them.
    warnsJoint: false,
    // Plain text: the server resolves no mentions in it, as in an Artifact's own share note.
    note: { draftKey: artifactLinkSendNoteKey(link), maxLength: NOTE_MAX_CHARS - link.length - 2, plainText: true },
    send,
  }), [formatMessage, preview, link, send]);
}
