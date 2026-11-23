// A message this client may already hold changed in place: apply its new copy
// by id, merge-only (never appended, no unread). One path for both ways it
// arrives: the live `message:updated` (socketBridge.ts) and the sync log's
// `message` entity (GET /api/sync/changes, RFC 082 §4.4), which is how a tab
// that was asleep catches up on a card message's update.

import { isRetractedMessage } from "../components/message/delegatedMessage";
import { useInboxStore } from "./inboxStore";
import { noteOutlineMessageUpdated } from "./messageOutlineStore";
import { useMessageStore } from "./messageStore";
import type { Message, ReceiverPrivateIngressContext } from "./messageStore";
import { consumeThreadReplyUpdateWithSyncCore } from "./threadRepliesSyncDomain";
import { useThreadStore } from "./threadStore";
import { hydrateLiveMessageResolvedQuotes } from "./resolvedQuotesHydrationStore";

/** A thread reply's new copy, into its thread's reply scope (when that scope is held). */
export function applyThreadReplyUpdate(msg: Message, ingressContext: ReceiverPrivateIngressContext): void {
  const parentMessageId = msg.conversationContext?.parentMessageId;
  const replyUpdate = consumeThreadReplyUpdateWithSyncCore(msg, {
    serverId: ingressContext.serverId,
    principalId: ingressContext.principalId,
    ingressContext,
  }, parentMessageId ? useThreadStore.getState().replyScopes[parentMessageId] : undefined);
  if (replyUpdate) useThreadStore.getState().applyReplyScope(replyUpdate.parentMessageId, replyUpdate.scope);
}

export type MessageUpdatePatch = Pick<Message, "id" | "channelId"> & Partial<Message>;

const messageUpdatedListeners = new Set<(msg: MessageUpdatePatch) => void>();

/** Hear every message's new copy or local mutation patch, live or from the sync log (open thread parent and reply surfaces). */
export function subscribeMessageUpdated(listener: (msg: MessageUpdatePatch) => void): () => void {
  messageUpdatedListeners.add(listener);
  return () => { messageUpdatedListeners.delete(listener); };
}

/** Apply an authoritative local mutation patch (such as an action-card execute response) to cached buckets and open thread surfaces. */
export function applyLocalMessagePatch(patch: MessageUpdatePatch): void {
  useMessageStore.getState().updateMessage(patch);
  for (const listener of [...messageUpdatedListeners]) listener(patch);
}

/** A message's new copy: the conversation's rows, its thread's replies, (RFC 077) a retraction's Activity preview, and its listeners. */
export function applyMessageUpdated(msg: Message, ingressContext: ReceiverPrivateIngressContext): void {
  useMessageStore.getState().updateMessage(msg);
  noteOutlineMessageUpdated(msg);
  applyThreadReplyUpdate(msg, ingressContext);
  hydrateLiveMessageResolvedQuotes(msg, { force: true });
  if (isRetractedMessage(msg)) useInboxStore.getState().retractPreview(msg.id, msg.content);
  for (const listener of [...messageUpdatedListeners]) listener(msg);
}
