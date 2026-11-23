import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useIntl } from "react-intl";
import { toast } from "@botiverse/raft-ui";
import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useMessageStore } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { registerServerReset } from "../../store/serverResetRegistry";
import { openMessagePlace } from "../../utils/messagePlace";

const QUOTE_JUMP_PASSAGE_HIGHLIGHT_MS = 2200;

interface QuoteJumpHighlightTarget {
  messageId: string;
  passage: string;
  token: number;
}

interface QuoteJumpHighlightState {
  target: QuoteJumpHighlightTarget | null;
  flash: (messageId: string, passage: string) => void;
  clear: () => void;
}

let quoteJumpClearTimer: ReturnType<typeof setTimeout> | null = null;
let quoteJumpToken = 0;

function extractPassageHighlightPhrase(passage: string): string {
  // Match the first non-empty line without trailing ellipsis so the remark
  // phrase highlighter locates the exact quoted passage cleanly.
  const firstLine = passage
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/(?:\.\.\.|…)$/, "").trim();
}

export const useQuoteJumpHighlightStore = create<QuoteJumpHighlightState>((set) => ({
  target: null,
  flash: (messageId, rawPassage) => {
    const passage = extractPassageHighlightPhrase(rawPassage);
    if (!passage) return;
    if (quoteJumpClearTimer) {
      clearTimeout(quoteJumpClearTimer);
      quoteJumpClearTimer = null;
    }
    const token = ++quoteJumpToken;
    set({ target: { messageId, passage, token } });
    quoteJumpClearTimer = setTimeout(() => {
      quoteJumpClearTimer = null;
      set((state) => (state.target?.token === token ? { target: null } : state));
    }, QUOTE_JUMP_PASSAGE_HIGHLIGHT_MS);
  },
  clear: () => {
    if (quoteJumpClearTimer) {
      clearTimeout(quoteJumpClearTimer);
      quoteJumpClearTimer = null;
    }
    set({ target: null });
  },
}));

export function useQuoteJumpPassageHighlight(messageId: string, disabled = false): string | undefined {
  return useQuoteJumpHighlightStore((s) => (
    !disabled && s.target?.messageId === messageId ? s.target.passage : undefined
  ));
}

registerServerReset(() => {
  useQuoteJumpHighlightStore.getState().clear();
});

/**
 * Fast-path jump handler provided by the enclosing conversation surface
 * (ChatPanel or AuthenticatedThreadPanel). Returns `true` when the quoted
 * message is already present in that surface and was scrolled + located
 * immediately; returns `false` to fall back to `GET /messages/context/:id`.
 */
export type QuotedMessageLocalJump = (messageId: string) => boolean;

export const QuotedMessageLocalJumpContext = createContext<QuotedMessageLocalJump | null>(null);

export function useThreadLocalQuoteJump(
  parentMessageId: string | null | undefined,
  messages: ReadonlyArray<{ id: string }>,
  onJump: (messageId: string) => void,
): QuotedMessageLocalJump {
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  return useCallback((messageId: string): boolean => {
    if ((parentMessageId && messageId === parentMessageId) || messagesRef.current.some((message) => message.id === messageId)) {
      onJump(messageId);
      return true;
    }
    return false;
  }, [onJump, parentMessageId]);
}

interface ContextJumpResponse {
  channelId?: string;
  channelType?: string;
  parentChannelId?: string;
  parentChannelType?: string;
  taskId?: string;
  targetMessageId?: string;
  canonicalTarget?: {
    kind?: string;
    channelId?: string;
    threadChannelId?: string;
    threadParentMessageId?: string;
    messageId?: string;
  } | null;
}

function resolveRouteKind(
  channelId: string | undefined,
  hintType: string | undefined,
): "channel" | "dm" {
  if (hintType === "dm") return "dm";
  if (channelId) {
    const channel = findStoredChannel(useChannelStore.getState(), channelId);
    if (channel?.type === "dm") return "dm";
  }
  return "channel";
}

/**
 * Jumps to a quoted message following the exact same visibility boundary as a
 * permalink (`GET /api/messages/context/:messageId`):
 * - Already in the current open conversation: instant VirtualList scroll + located highlight.
 * - Elsewhere or outside the loaded slice: calls `/messages/context/:messageId`.
 * - Partial quotes (`passage` provided): flashes a subtle ~2.2s inline passage
 *   highlight on the target message alongside the standard 2s located row flash.
 * - Any 404 (missing, deleted, private channel, DM, other server, behind Free
 *   history window): shows ONE uniform, non-leaking message without revealing why.
 */
export function useJumpToQuotedMessage(): {
  jumpToQuotedMessage: (messageId: string, passage?: string) => Promise<void>;
  jumping: boolean;
} {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const localJump = useContext(QuotedMessageLocalJumpContext);
  const [jumping, setJumping] = useState(false);

  const jumpToQuotedMessage = useCallback(async (messageId: string, passage?: string) => {
    if (!messageId) return;
    if (localJump) {
      if (localJump(messageId)) {
        if (passage?.trim()) {
          useQuoteJumpHighlightStore.getState().flash(messageId, passage);
        }
        return;
      }
    } else {
      const store = useMessageStore.getState();
      const loaded = store.currentChannelId ? (store.channelMessages[store.currentChannelId] ?? []) : [];
      if (loaded.some((message) => message.id === messageId)) {
        store.setHighlightedMessageId(messageId);
        if (passage?.trim()) {
          useQuoteJumpHighlightStore.getState().flash(messageId, passage);
        }
        return;
      }
    }

    const { serverEpoch } = useServerStore.getState();
    setJumping(true);
    try {
      const { data } = await api.get<ContextJumpResponse>(
        `/messages/context/${encodeURIComponent(messageId)}`,
        { params: { before: 0, after: 0 } },
      );
      if (useServerStore.getState().serverEpoch !== serverEpoch) return;

      const target = data.canonicalTarget;
      const targetMsgId = data.targetMessageId ?? messageId;
      const maybeFlashPassage = () => {
        if (passage?.trim()) {
          useQuoteJumpHighlightStore.getState().flash(targetMsgId, passage);
        }
      };

      if (data.channelType === "task" && data.parentChannelId && data.taskId) {
        const parentRouteKind = resolveRouteKind(data.parentChannelId, data.parentChannelType);
        openMessagePlace({
          kind: "task",
          taskId: data.taskId,
          parentChannelId: data.parentChannelId,
          parentRouteKind,
          conversationChannelId: data.parentChannelType === "joint" ? null : (data.channelId ?? null),
          messageId: targetMsgId,
        }, nav);
        maybeFlashPassage();
        return;
      }
      if (target?.kind === "thread" && target.channelId && target.threadParentMessageId) {
        const parentRouteKind = resolveRouteKind(target.channelId, data.parentChannelType);
        openMessagePlace({
          kind: "thread",
          parentChannelId: target.channelId,
          parentRouteKind,
          parentMessageId: target.threadParentMessageId,
          messageId: targetMsgId,
        }, nav);
        maybeFlashPassage();
        return;
      }
      if (data.channelId) {
        const routeKind = resolveRouteKind(data.channelId, data.channelType);
        openMessagePlace({
          kind: routeKind,
          channelId: data.channelId,
          messageId: targetMsgId,
        }, nav);
        maybeFlashPassage();
        return;
      }
      toast.info(formatMessage({ id: "message.quoteReply.originalUnavailable" }));
    } catch (error) {
      if (useServerStore.getState().serverEpoch !== serverEpoch) return;
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        // Uniform non-leaking feedback across missing / deleted / private / DM /
        // other-server / Free history-window 404s.
        toast.info(formatMessage({ id: "message.quoteReply.originalUnavailable" }));
        return;
      }
      toast.error(formatMessage({ id: "message.messageItem.linkResolutionUnavailable" }));
    } finally {
      setJumping(false);
    }
  }, [formatMessage, localJump, nav]);

  return { jumpToQuotedMessage, jumping };
}
