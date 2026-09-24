import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createSyncCore } from "@botiverse/raft-shared";
import type { SyncCore, SyncDomainConfig, SyncFrame } from "@botiverse/raft-shared";
import {
  NOTIFICATION_PREFS_SYNC_DOMAIN,
  applyNotificationPrefsDomainEvent,
  consumeNotificationPrefsUpdateWithSyncCore,
  createInitialNotificationPrefsDomainState,
  createNotificationPrefsSyncDomain,
  resetNotificationPrefsSyncCoreForTests,
  scopeIdForNotificationPrefsUpdate,
  __setNotificationPrefsSyncCoreForTests,
} from "../src/store/notificationPrefsSyncDomain.js";
import type {
  NotificationPrefsDomainEvent,
} from "../src/store/notificationPrefsSyncDomain.js";
import { __setStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace.js";
import {
  __resetStateViolationCoalescerForTest,
  __setStateViolationEmitterForTest,
} from "../src/utils/stateViolationTrace.js";

const channelId = "channel-notification-prefs";
const serverId = "server-notification-prefs";
const channelScopeId = `channel:${channelId}`;

function channelEvent(version: number, muted: boolean): NotificationPrefsDomainEvent {
  return {
    kind: "notification_prefs:updated",
    update: {
      type: "channel",
      serverId,
      channelId,
      state: {
        activityMuted: muted,
        muteFromSeq: muted ? 42 : null,
        prefsVersion: version,
      },
    },
  };
}

function frame(seq: number, event: NotificationPrefsDomainEvent): SyncFrame<NotificationPrefsDomainEvent> {
  return { scopeId: scopeIdForNotificationPrefsUpdate(event.update), seq, epoch: null, event };
}

function notificationPrefsDomain(): SyncDomainConfig<unknown, unknown> {
  return createNotificationPrefsSyncDomain() as SyncDomainConfig<unknown, unknown>;
}

afterEach(() => {
  __setStateTransitionEmitterForTest(null);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();
  resetNotificationPrefsSyncCoreForTests();
});

test("notification prefs sync domain: core-mediated fold equals direct fold", () => {
  const events = [
    frame(1, channelEvent(1, true)),
    frame(2, channelEvent(2, false)),
  ];
  const core = createSyncCore({ domains: [notificationPrefsDomain()] });
  let direct = createInitialNotificationPrefsDomainState();

  for (const item of events) {
    core.ingestFrame(NOTIFICATION_PREFS_SYNC_DOMAIN, item);
    direct = applyNotificationPrefsDomainEvent(direct, item.event);
  }

  assert.deepEqual(core.state(NOTIFICATION_PREFS_SYNC_DOMAIN, channelScopeId), direct);
  assert.deepEqual(direct.prefsByScopeId[channelScopeId], channelEvent(2, false).update);
  assert.equal(core.scopeSyncState(NOTIFICATION_PREFS_SYNC_DOMAIN, channelScopeId)?.appliedSeq, 2);
});

test("notification prefs sync consumer: duplicate prefsVersion is dropped before store consumption", () => {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setStateTransitionEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);

  const first = consumeNotificationPrefsUpdateWithSyncCore(channelEvent(7, true).update);
  const duplicate = consumeNotificationPrefsUpdateWithSyncCore(channelEvent(7, false).update);

  assert.equal(first.kind, "applied");
  assert.equal(duplicate.kind, "duplicate_dropped");
  assert.deepEqual(records.map((record) => record.attrs.key), [
    {
      domain: "notification_prefs",
      event: "notification_prefs:updated",
      outcome: "applied",
      entityId: channelScopeId,
    },
    {
      domain: "notification_prefs",
      event: "notification_prefs:updated",
      outcome: "noop",
      entityId: channelScopeId,
    },
  ]);
});

test("notification prefs sync consumer: non-applying sync outcomes do not fall through to store writes", () => {
  const core = {
    ingestFrame: () => ({ kind: "epoch_rebaseline_requested" as const, scopeId: channelScopeId }),
    violations: () => ({ records: [], nextIndex: 0 }),
    state: () => ({
      prefsByScopeId: {
        [channelScopeId]: channelEvent(10, false).update,
      },
    }),
  } as unknown as SyncCore;
  __setNotificationPrefsSyncCoreForTests(core);

  const result = consumeNotificationPrefsUpdateWithSyncCore(channelEvent(10, true).update);

  assert.equal(result.kind, "no_op");
  assert.equal(result.outcome.kind, "epoch_rebaseline_requested");
});

test("notification prefs sync consumer: missing prefsVersion stays on legacy fallback path", () => {
  const result = consumeNotificationPrefsUpdateWithSyncCore({
    type: "channel",
    serverId,
    channelId,
    state: { activityMuted: true, muteFromSeq: 42 },
  });

  assert.deepEqual(result, {
    kind: "fallback",
    reason: "missing_prefs_version",
    update: {
      type: "channel",
      serverId,
      channelId,
      state: { activityMuted: true, muteFromSeq: 42 },
    },
  });
});
