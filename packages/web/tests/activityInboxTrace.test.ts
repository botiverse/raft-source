import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  activityInboxTraceScope,
  beginActivityInboxTraceCycle,
  currentActivityInboxTraceCycle,
  resetActivityInboxTraceForTests,
  traceActivityInboxTransition,
} from "../src/utils/activityInboxTrace";
import { __setStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace";

afterEach(() => {
  resetActivityInboxTraceForTests();
  __setStateTransitionEmitterForTest(null);
});

test("Activity socket and refresh diagnostics share a bounded correlation id without message content", () => {
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setStateTransitionEmitterForTest((name, attrs) => traces.push({ name, attrs }));
  const scope = activityInboxTraceScope({ serverId: "server-1", principalId: "viewer", generation: 7 }, "thread:thread-1");
  const cycle = beginActivityInboxTraceCycle(scope, 1_000);

  traceActivityInboxTransition({
    source: "socket_thread_reply",
    itemKey: "thread:thread-1",
    marker: "message-2",
    fromIndex: 21,
    toIndex: 0,
    unreadCount: 1,
    focusOwner: true,
  }, cycle);
  traceActivityInboxTransition({
    source: "http_reset",
    itemKey: "thread:thread-1",
    marker: "message-2",
    fromIndex: 0,
    toIndex: 1,
    unreadCount: 1,
    focusOwner: true,
  }, currentActivityInboxTraceCycle(scope, 1_150));

  assert.equal(traces.length, 2);
  assert.equal(traces[0]?.name, "slock.state.transition");
  assert.equal((traces[0]?.attrs.join as { clientEventId?: string }).clientEventId, cycle);
  assert.equal((traces[1]?.attrs.join as { clientEventId?: string }).clientEventId, cycle);
  assert.deepEqual((traces[0]?.attrs.key as Record<string, unknown>), {
    domain: "inbox",
    event: "activity:socket_thread_reply",
    outcome: "applied",
    entityId: "thread:thread-1",
  });
  assert.equal(
    (traces[0]?.attrs.meta as { outcomeDetail?: string }).outcomeDetail,
    "from=21;to=0;unread=1;focus=1;marker=message-2",
  );
  assert.equal(JSON.stringify(traces).includes("message body"), false);
});

test("Activity trace correlation expires instead of joining unrelated later refreshes", () => {
  const scope = activityInboxTraceScope({ serverId: "server-1", principalId: "viewer", generation: 7 }, "thread:thread-1");
  beginActivityInboxTraceCycle(scope, 1_000);
  assert.ok(currentActivityInboxTraceCycle(scope, 2_999));
  assert.equal(currentActivityInboxTraceCycle(scope, 3_001), undefined);
});

test("Activity trace correlation fails closed across overlapping identities and item scopes", () => {
  const a = activityInboxTraceScope({ serverId: "server-1", principalId: "viewer-a", generation: 7 }, "thread:a");
  const b = activityInboxTraceScope({ serverId: "server-1", principalId: "viewer-b", generation: 8 }, "thread:b");
  const cycleA = beginActivityInboxTraceCycle(a, 1_000);
  const cycleB = beginActivityInboxTraceCycle(b, 1_100);

  assert.notEqual(cycleA, cycleB);
  assert.equal(currentActivityInboxTraceCycle(a, 1_150), cycleA);
  assert.equal(currentActivityInboxTraceCycle(b, 1_150), cycleB);
  assert.equal(currentActivityInboxTraceCycle(null, 1_150), undefined);
  assert.equal(
    currentActivityInboxTraceCycle(
      activityInboxTraceScope({ serverId: "server-1", principalId: "viewer-a", generation: 7 }, "thread:unrelated"),
      1_150,
    ),
    undefined,
  );
});
