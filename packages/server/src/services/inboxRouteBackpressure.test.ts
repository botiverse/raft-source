import assert from "node:assert/strict";
import { test } from "vitest";
import {
  InboxBackpressureRejectedError,
  InboxRouteBackpressure,
} from "./inboxRouteBackpressure.js";

test("inbox backpressure bounds active work, queues FIFO, and never double-releases", async () => {
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 2,
    maxQueue: 2,
    queueTimeoutMs: 1_000,
  });
  const first = await gate.acquire();
  const second = await gate.acquire();
  const thirdPromise = gate.acquire();
  const fourthPromise = gate.acquire();

  assert.deepEqual(gate.snapshot(), {
    active: 2,
    queued: 2,
    maxConcurrency: 2,
    maxQueue: 2,
    admittedTotal: 2,
    queuedTotal: 2,
    rejectedTotal: 0,
    timedOutTotal: 0,
    maxObservedActive: 2,
    maxObservedQueued: 2,
  });

  first.release();
  first.release();
  const third = await thirdPromise;
  assert.equal(third.queued, true);
  assert.equal(gate.snapshot().active, 2);
  assert.equal(gate.snapshot().queued, 1);

  second.release();
  const fourth = await fourthPromise;
  assert.equal(fourth.queued, true);
  assert.equal(gate.snapshot().active, 2);
  assert.equal(gate.snapshot().queued, 0);
  third.release();
  fourth.release();
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().maxObservedActive, 2);
});

test("inbox backpressure rejects a full queue without admitting more work", async () => {
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 1,
    maxQueue: 1,
    queueTimeoutMs: 1_000,
  });
  const active = await gate.acquire();
  const queuedPromise = gate.acquire();
  await assert.rejects(
    gate.acquire(),
    (error: unknown) => error instanceof InboxBackpressureRejectedError
      && error.reason === "queue_full",
  );
  assert.equal(gate.snapshot().active, 1);
  assert.equal(gate.snapshot().queued, 1);
  assert.equal(gate.snapshot().rejectedTotal, 1);

  active.release();
  const queued = await queuedPromise;
  queued.release();
});

test("inbox backpressure expires queued work and does not run it later", async () => {
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 1,
    maxQueue: 1,
    queueTimeoutMs: 20,
  });
  const active = await gate.acquire();
  await assert.rejects(
    gate.acquire(),
    (error: unknown) => error instanceof InboxBackpressureRejectedError
      && error.reason === "queue_timeout",
  );
  assert.equal(gate.snapshot().active, 1);
  assert.equal(gate.snapshot().queued, 0);
  assert.equal(gate.snapshot().timedOutTotal, 1);
  active.release();
  assert.equal(gate.snapshot().active, 0);
});

test("inbox backpressure removes an aborted queued request", async () => {
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 1,
    maxQueue: 1,
    queueTimeoutMs: 1_000,
  });
  const active = await gate.acquire();
  const controller = new AbortController();
  const queuedPromise = gate.acquire({ signal: controller.signal });
  controller.abort();
  await assert.rejects(
    queuedPromise,
    (error: unknown) => error instanceof InboxBackpressureRejectedError
      && error.reason === "request_aborted",
  );
  assert.equal(gate.snapshot().queued, 0);
  active.release();
});
