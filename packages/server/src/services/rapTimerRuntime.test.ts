import assert from "node:assert/strict";
import { test } from "vitest";
import type { AppId } from "./rapRegistry.js";
import type { RapTimerData } from "./rapSyscalls.js";
import {
  createRapTimerRuntime,
  type RapTimerClock,
  type RapTimerDispatch,
} from "./rapTimerRuntime.js";

const APP_ID = "x.timer" as AppId;

function createManualClock(initialNow = 1_000): RapTimerClock & {
  advance(ms: number): Promise<void>;
  queued(): number;
} {
  let now = initialNow;
  let nextHandle = 1;
  const callbacks = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    arm(callback, delayMs) {
      const handle = nextHandle++;
      callbacks.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    disarm(handle) {
      callbacks.delete(handle as number);
    },
    queued: () => callbacks.size,
    async advance(ms) {
      now += ms;
      // Remove first, like the platform event loop. A callback may schedule its
      // next bounded wait while this batch is being drained.
      while (true) {
        const due = [...callbacks.entries()]
          .filter(([, entry]) => entry.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        for (const [handle, entry] of due) {
          callbacks.delete(handle);
          entry.callback();
        }
        await Promise.resolve();
      }
    },
  };
}

function recordingDispatch(): RapTimerDispatch & {
  calls: Array<{ serverId: string; appId: AppId; subjectAgentId: string; data: unknown }>;
} {
  const calls: Array<{ serverId: string; appId: AppId; subjectAgentId: string; data: unknown }> = [];
  return {
    calls,
    async raiseDue(input) {
      calls.push(input);
    },
  };
}

const input = (overrides: Partial<{
  fireAtMs: number;
  sourceId: string;
  data: RapTimerData;
}> = {}) => ({
  serverId: "server-1",
  appId: APP_ID,
  subjectAgentId: "agent-1",
  fireAtMs: 1_100,
  sourceId: "source-1",
  data: { reminderId: "source-1", version: 1, catchup: false },
  ...overrides,
});

test("same-key schedule is an upsert: only the new deadline and snapshotted data fire", async () => {
  const clock = createManualClock();
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  const firstData = { reminderId: "source-1", version: 1, catchup: false };

  const first = await runtime.schedule(input({ data: firstData }));
  firstData.version = 99;
  const second = await runtime.schedule(input({
    fireAtMs: 1_200,
    data: { reminderId: "source-1", version: 2, catchup: true },
  }));

  assert.equal(first.timerId, second.timerId, "the four-tuple owns one stable logical timer");
  assert.equal(clock.queued(), 1, "upsert must replace, not add, the physical callback");
  await clock.advance(100);
  assert.deepEqual(dispatch.calls, [], "the replaced deadline must not leak through");
  await clock.advance(100);
  assert.deepEqual(dispatch.calls, [{
    serverId: "server-1",
    appId: APP_ID,
    subjectAgentId: "agent-1",
    data: { reminderId: "source-1", version: 2, catchup: true },
  }]);
  assert.equal(clock.queued(), 0, "a logical timer is one-shot");
});

test("a stale callback already dequeued before upsert cannot dispatch", async () => {
  let now = 1_000;
  let firstCallback: (() => void) | undefined;
  const callbacks: Array<() => void> = [];
  const clock: RapTimerClock = {
    now: () => now,
    arm(callback) {
      callbacks.push(callback);
      firstCallback ??= callback;
      return callbacks.length;
    },
    disarm() {
      // Deliberately does not retract a callback already handed to the event
      // loop. The runtime generation/entry fence, not disarm(), must stop it.
    },
  };
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  await runtime.schedule(input());
  await runtime.schedule(input({
    fireAtMs: 1_200,
    data: { reminderId: "source-1", version: 2, catchup: false },
  }));

  now = 1_100;
  firstCallback?.();
  await Promise.resolve();
  assert.deepEqual(dispatch.calls, [], "a replaced callback must fail its entry fence");
});

test("cancel is idempotent and the cancelled timer can never fire", async () => {
  const clock = createManualClock();
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  await runtime.schedule(input());

  assert.equal(await runtime.cancel(input()), "cancelled");
  assert.equal(await runtime.cancel(input()), "not_found");
  await clock.advance(500);
  assert.deepEqual(dispatch.calls, []);
});

test("isArmed is a read-only exact identity, deadline, and data inspector", async () => {
  const clock = createManualClock();
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  const scheduled = input();
  await runtime.schedule(scheduled);

  assert.equal(runtime.isArmed(scheduled), true);
  assert.equal(runtime.isArmed(input({ fireAtMs: scheduled.fireAtMs + 1 })), false);
  assert.equal(runtime.isArmed(input({
    data: { reminderId: "source-1", version: 2, catchup: false },
  })), false);
  assert.equal(runtime.isArmed({ ...scheduled, sourceId: "other-source" }), false);
  assert.equal(clock.queued(), 1, "inspection must not arm or disarm a callback");
  assert.deepEqual(dispatch.calls, [], "inspection must not dispatch");

  assert.equal(await runtime.cancel(scheduled), "cancelled");
  assert.equal(runtime.isArmed(scheduled), false, "a cancelled entry is absent");
});

test("a far-future logical timer re-arms bounded platform waits without firing early", async () => {
  const clock = createManualClock();
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  const fireAtMs = 3_000_000_000;
  await runtime.schedule(input({ fireAtMs }));

  await clock.advance(2_147_483_647);
  assert.deepEqual(dispatch.calls, []);
  assert.equal(clock.queued(), 1, "the logical timer must retain the remaining wait");
  await clock.advance(fireAtMs - clock.now());
  assert.equal(dispatch.calls.length, 1);
  assert.equal(clock.queued(), 0);
});

test("schedule rejects data that cannot be boundedly serialized before creating a timer", async () => {
  const clock = createManualClock();
  const dispatch = recordingDispatch();
  const runtime = createRapTimerRuntime({ clock, dispatch });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  await assert.rejects(() => runtime.schedule(input({ data: cyclic as never })), /RAP_TIMER_DATA_INVALID/);
  await assert.rejects(
    () => runtime.schedule(input({ data: { body: "x".repeat(4_097) } })),
    /RAP_TIMER_DATA_TOO_LARGE/,
  );
  assert.equal(clock.queued(), 0);
  assert.deepEqual(dispatch.calls, []);
});
