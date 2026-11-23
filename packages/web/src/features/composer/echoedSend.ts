import { useMessageStore } from "../../store/messageStore";

/**
 * True when the server already persisted this send: its socket echo (matched by
 * `randomId`) replaced the optimistic row with the server message. A send whose
 * HTTP response is lost after the commit (timeout, network drop) rejects even
 * though the message went out; the composer must treat it as delivered, not
 * restore the draft for a duplicate resend (#triage:#482).
 */
export function isSendAlreadyEchoed(channelId: string, randomId: string): boolean {
  const bucket = useMessageStore.getState().channelMessages[channelId] ?? [];
  return bucket.some((message) => message.randomId === randomId && !message.id.startsWith("optimistic-"));
}
