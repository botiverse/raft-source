import { createContext, useContext } from "react";

/**
 * Message scope for the per-@mentioned-agent read badge (task #693).
 *
 * `MentionLink` renders inside markdown and therefore has no idea which message
 * it belongs to. Rather than thread `channelId`/`seq` props through the markdown
 * renderer — which would make the markdown layer aware of read receipts, a
 * concern it must not own — the message row publishes its scope here and the
 * mention consumes it.
 *
 * `enabled` carries the whole visibility decision (feature flag + "only the
 * human sender of this message sees it") so the mention never re-derives
 * authorization on its own.
 */
export interface MessageReadReceiptScope {
  channelId: string;
  /** `undefined` for optimistic rows that have no server seq yet — read
   *  state is genuinely unknown then, so no badge renders. */
  messageSeq: number | undefined;
  enabled: boolean;
}

const MessageReadReceiptScopeContext = createContext<MessageReadReceiptScope | null>(null);

export const MessageReadReceiptScopeProvider = MessageReadReceiptScopeContext.Provider;

export function useMessageReadReceiptScope(): MessageReadReceiptScope | null {
  return useContext(MessageReadReceiptScopeContext);
}
