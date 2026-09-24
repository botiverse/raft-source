import { MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER } from "@botiverse/raft-shared";

const eligibleThreadRepliesSyncWindowProducers = new Set<string>([
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
]);

export function isKnownThreadRepliesSyncWindowProducer(
  producer: string | null,
): boolean {
  return producer !== null
    && eligibleThreadRepliesSyncWindowProducers.has(producer);
}

export function isThreadRepliesSyncWindowProducerEligible(input: {
  producer: string | null;
  serverId: string | null;
}): boolean {
  if (!input.serverId) return false;
  return isKnownThreadRepliesSyncWindowProducer(input.producer);
}
