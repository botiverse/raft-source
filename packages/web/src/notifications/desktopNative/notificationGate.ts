// The device-local gate every Raft Desktop notification (all of them come from
// the server stream, serverNotificationStream.ts) passes before the shell
// posts it (raftDesktop.notifications.show; main owns the OS notification,
// grouping, replace in place, rate limiting and click routing):
//   - an in-app route only (the shell checks again);
//   - nothing while the window is attended (visible, focused, not away):
//     the user is in front of Raft, so no OS notification for any
//     conversation, the one on screen or another (Raft Desktop's rule from
//     the start);
//   - each id once (the shell dedupes again).
// A test notification (`testId`, POST /notifications/test) skips the
// attended rule (the user is looking at Settings on purpose), and its show
// result is acked to the server (contract §6).

import { isDesktopNotificationRoute } from "@botiverse/raft-shared";
import type { DesktopNotificationRequest, RaftDesktopBridge } from "@botiverse/raft-shared";

/** Bounded set of recently submitted notification ids. */
export function createRecentIds(limit = 500) {
  const ids = new Set<string>();
  return {
    /** True the first time an id is seen; false for a repeat. */
    claim(id: string): boolean {
      if (ids.has(id)) return false;
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value as string);
      return true;
    },
    has: (id: string) => ids.has(id),
  };
}

export type NotificationsBridge = Pick<RaftDesktopBridge, "notifications">;

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

export function createNotificationGate(deps: {
  bridge: NotificationsBridge;
  isAttended(): boolean;
  recentIds?: ReturnType<typeof createRecentIds>;
  /** POST /notifications/test/:testId/ack (ackTestNotification). */
  ackTest?: (testId: string, shown: boolean) => void;
  /** A test notification the shell could not confirm (show() returned nothing). */
  noteUnconfirmed?: (testId: string) => void;
}) {
  const recent = deps.recentIds ?? createRecentIds();
  const ack = (testId: string | undefined, shown: boolean) => {
    if (testId) deps.ackTest?.(testId, shown);
  };
  /**
   * What happened to a request: `posted` to the shell, `held` back on
   * purpose (the window is attended, or a repeat), or `dropped` (a bad
   * route, or the shell's show() threw). Only posted and held are delivered
   * in the server's sense (the ack that keeps the phone quiet, §1.3).
   */
  const deliver = (request: DesktopNotificationRequest): "posted" | "held" | "dropped" => {
      const testId = request.testId;
      if (!isDesktopNotificationRoute(request.route)) {
        ack(testId, false);
        return "dropped";
      }
      // An attended window raises nothing; a test notification answers this device's own request.
      if (!testId && deps.isAttended()) return "held";
      if (!recent.claim(request.id)) return "held";
      let result: ReturnType<NotificationsBridge["notifications"]["show"]>;
      try {
        result = deps.bridge.notifications.show(request);
      } catch {
        ack(testId, false);
        return "dropped";
      }
      // Newer shells resolve once the OS showed it (or refused). An older shell
      // returns undefined and cannot tell: nothing is acked (the ack has no
      // "unconfirmed"), and the settings card reports "sent, couldn't confirm"
      // rather than sending the user to the OS settings for nothing.
      if (testId && isPromiseLike<{ shown?: unknown }>(result)) {
        result.then((outcome) => ack(testId, outcome?.shown === true), () => ack(testId, false));
      } else if (testId) {
        deps.noteUnconfirmed?.(testId);
      }
      return "posted";
  };
  return {
    deliver,
    /** Posts `request` unless the gate holds it back. True when posted. */
    post: (request: DesktopNotificationRequest): boolean => deliver(request) === "posted",
  };
}
