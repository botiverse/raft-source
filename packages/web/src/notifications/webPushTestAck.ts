// The service worker's word that a test notification was (or was not)
// displayed (RAFT_NOTIFICATION_SHOWN, public/sw.js) becomes the ack the
// settings card waits for (contract §6). Every open tab hears it and may ack;
// the server keeps the first, and each page acks a test only once.

import { SW_NOTIFICATION_SHOWN_MESSAGE } from "@botiverse/raft-shared";

export interface NotificationShownMessage {
  testId: string;
  shown: boolean;
}

export function parseNotificationShownMessage(data: unknown): NotificationShownMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { type?: unknown; testId?: unknown; shown?: unknown };
  if (record.type !== SW_NOTIFICATION_SHOWN_MESSAGE) return null;
  if (typeof record.testId !== "string" || !record.testId || typeof record.shown !== "boolean") return null;
  return { testId: record.testId, shown: record.shown };
}

/** A worker-message handler that acks each test id once. */
export function createNotificationShownAcker(ack: (testId: string, shown: boolean) => unknown): (data: unknown) => boolean {
  const acked = new Set<string>();
  return (data) => {
    const message = parseNotificationShownMessage(data);
    if (!message || acked.has(message.testId)) return false;
    acked.add(message.testId);
    void ack(message.testId, message.shown);
    return true;
  };
}
