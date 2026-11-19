import assert from "node:assert/strict";

import { shutdownServerRuntime } from "./serverShutdown";

test("HTTP acceptance stops before machine ownership is released; traces flush after workers settle", async () => {
  const events: string[] = [];
  let finishHttpDrain!: () => void;
  const httpDrain = new Promise<void>((resolve) => {
    finishHttpDrain = resolve;
  });
  let finishWorkers!: () => void;
  const workers = new Promise<void>((resolve) => {
    finishWorkers = resolve;
  });

  const shutdown = shutdownServerRuntime({
    stopAcceptingHttp: () => {
      events.push("http_stop_started");
      return httpDrain;
    },
    releaseMachineOwnership: async () => {
      events.push("owner_release_started");
    },
    settleWorkers: () => {
      events.push("workers_settle_started");
      return workers;
    },
    flushTraces: async () => {
      events.push("trace_flush_started");
    },
    closeRemainingConnections: async () => {},
    shutdownSharedState: async () => {
      events.push("shared_state_stopped");
    },
    warn: () => {},
  });

  assert.deepEqual(events, [
    "http_stop_started",
    "owner_release_started",
    "workers_settle_started",
  ]);
  finishWorkers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1), "trace_flush_started", "a worker's last span is flushed");
  assert.equal(events.includes("shared_state_stopped"), false);

  finishHttpDrain();
  await shutdown;
  assert.equal(events.at(-1), "shared_state_stopped");
});

test("a synchronous HTTP stop failure does not release machine ownership", async () => {
  let ownerReleased = false;
  let sharedStateStopped = false;

  await assert.rejects(
    shutdownServerRuntime({
      stopAcceptingHttp: () => {
        throw new Error("cannot stop acceptance");
      },
      releaseMachineOwnership: async () => {
        ownerReleased = true;
      },
      settleWorkers: async () => {},
      flushTraces: async () => {},
      closeRemainingConnections: async () => {},
      shutdownSharedState: async () => {
        sharedStateStopped = true;
      },
      warn: () => {},
    }),
    /cannot stop acceptance/,
  );

  assert.equal(ownerReleased, false);
  assert.equal(sharedStateStopped, false);
});

// Deployment thread 3f292dc3: browser sockets still open when Redis (and the
// Socket.IO adapter on it) shut down silently missed every cross-replica emit.
test("remaining connections are closed before shared state shuts down, while the HTTP drain waits on them", async () => {
  const events: string[] = [];
  // `server.close()` resolves only once every open connection is gone, so
  // here the HTTP drain waits for the close below: closing after the drain
  // would never happen.
  let connectionsClosed!: () => void;
  const allConnectionsGone = new Promise<void>((resolve) => {
    connectionsClosed = resolve;
  });
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve;
  });

  const shutdown = shutdownServerRuntime({
    stopAcceptingHttp: () => allConnectionsGone.then(() => {
      events.push("http_drained");
    }),
    releaseMachineOwnership: async () => {},
    settleWorkers: async () => {},
    flushTraces: async () => {},
    closeRemainingConnections: () => {
      events.push("close_remaining_started");
      return closing.then(() => {
        events.push("close_remaining_done");
      });
    },
    shutdownSharedState: async () => {
      events.push("shared_state_stopped");
    },
    warn: () => {},
  });

  assert.deepEqual(events, ["close_remaining_started"], "closing does not wait for the HTTP drain");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("shared_state_stopped"), false);

  connectionsClosed();
  finishClose();
  await shutdown;
  assert.ok(events.indexOf("close_remaining_done") >= 0);
  assert.ok(events.indexOf("close_remaining_done") < events.indexOf("shared_state_stopped"), events.join(","));
  assert.equal(events.at(-1), "shared_state_stopped");
});

test("a failed close of the remaining connections is warned and shared state still shuts down", async () => {
  const warnings: string[] = [];
  let sharedStateStopped = false;

  await shutdownServerRuntime({
    stopAcceptingHttp: async () => {},
    releaseMachineOwnership: async () => {},
    settleWorkers: async () => {},
    flushTraces: async () => {},
    closeRemainingConnections: async () => {
      throw new Error("close failed");
    },
    shutdownSharedState: async () => {
      sharedStateStopped = true;
    },
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(warnings, ["Failed to close remaining browser connections"]);
  assert.equal(sharedStateStopped, true);
});
