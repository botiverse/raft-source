import { create } from "zustand";
import {
  buildWholeMessageQuoteExcerpt,
  serializeInlineQuoteReply,
} from "@botiverse/raft-shared";
import type { ResolvedInlineQuotesMap } from "@botiverse/raft-shared";
import type { QuoteReplyAuthorType, SelectedTextQuoteDetail } from "../../components/message/selectedTextQuote";
import { registerServerReset } from "../../store/serverResetRegistry";

export interface PendingComposerQuote {
  messageId: string;
  authorName: string;
  authorType: QuoteReplyAuthorType;
  excerpt: string;
  isPartial: boolean;
  createdAt: string;
}

interface ComposerQuoteState {
  byChannelId: Record<string, PendingComposerQuote>;
  setPendingQuote: (channelId: string, quote: PendingComposerQuote) => void;
  clearPendingQuote: (channelId: string) => void;
  clearAll: () => void;
}

export const useComposerQuoteStore = create<ComposerQuoteState>((set) => ({
  byChannelId: {},
  setPendingQuote: (channelId, quote) =>
    set((state) => ({
      byChannelId: { ...state.byChannelId, [channelId]: quote },
    })),
  clearPendingQuote: (channelId) =>
    set((state) => {
      if (!(channelId in state.byChannelId)) return state;
      const next = { ...state.byChannelId };
      delete next[channelId];
      return { byChannelId: next };
    }),
  clearAll: () => set({ byChannelId: {} }),
}));

export function usePendingComposerQuote(channelId: string): PendingComposerQuote | null {
  return useComposerQuoteStore((s) => s.byChannelId[channelId] ?? null);
}

export function setPendingComposerQuote(channelId: string, quote: PendingComposerQuote): void {
  useComposerQuoteStore.getState().setPendingQuote(channelId, quote);
}

export function clearPendingComposerQuote(channelId: string): void {
  useComposerQuoteStore.getState().clearPendingQuote(channelId);
}

export function getPendingComposerQuote(channelId: string): PendingComposerQuote | null {
  return useComposerQuoteStore.getState().byChannelId[channelId] ?? null;
}

export function buildPendingQuoteFromEvent(
  detail: SelectedTextQuoteDetail,
  fallbackAuthorName: string,
): PendingComposerQuote | null {
  const source = detail.source;
  if (!source?.messageId || source.messageId.startsWith("optimistic-")) return null;
  const raw = (detail.rawText ?? "").trim();
  const isPartial = source.isPartial ?? true;
  const excerpt = isPartial ? raw : (buildWholeMessageQuoteExcerpt(raw).excerpt || raw);
  return {
    messageId: source.messageId,
    authorName: source.authorName || fallbackAuthorName,
    authorType: source.authorType ?? "user",
    excerpt,
    isPartial,
    createdAt: source.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Serialize a Composer pending quote directly into the unified Markdown body
 * (`> <excerpt>\n> msg=<8-char-shortId>\n\n<body>`) and build a local
 * optimistic `resolvedQuotes` entry for block `"0"` so the sender sees zero
 * flicker while the server verifies and echoes the message.
 */
export function buildInlineQuoteSendArtifacts(
  pending: PendingComposerQuote | null,
  replyBody: string,
): {
  content: string;
  optimisticResolvedQuotes: ResolvedInlineQuotesMap | undefined;
} {
  if (!pending) {
    return { content: replyBody, optimisticResolvedQuotes: undefined };
  }
  const content = serializeInlineQuoteReply(pending.excerpt, pending.messageId, replyBody);
  return {
    content,
    optimisticResolvedQuotes: {
      "0": {
        messageId: pending.messageId,
        shortId: pending.messageId.slice(0, 8).toLowerCase(),
        author: {
          name: pending.authorName,
          type: pending.authorType,
        },
        createdAt: pending.createdAt,
        isPartial: pending.isPartial,
      },
    },
  };
}

registerServerReset(() => {
  useComposerQuoteStore.getState().clearAll();
});
