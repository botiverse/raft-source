import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentMigrationUpdatedPayload } from "@botiverse/raft-shared";
import {
  applyAgentMigrationSnapshot,
  createAgentMigrationRealtimeSync,
} from "../src/store/agentMigrationRealtime.js";
import type {
  AgentMigrationRealtimeSocket,
  AgentMigrationStatusResponse,
} from "../src/store/agentMigrationRealtime.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MIGRATION_REF = "mig_abcdefghijklmnopqrstuv";

function snapshot(revision: number, state = "prep"): AgentMigrationStatusResponse {
  return {
    migration: {
      agentId: AGENT_ID,
      migrationRef: MIGRATION_REF,
      state,
      revision,
      sourceMachineId: "source",
      targetMachineId: "target",
      updatedAt: `2026-07-20T00:00:0${revision}.000Z`,
    },
  };
}

function event(revision: number, state = "in_transit"): AgentMigrationUpdatedPayload {
  return {
    agentId: AGENT_ID,
    migrationRef: MIGRATION_REF,
    state: state as AgentMigrationUpdatedPayload["state"],
    revision,
    authority: "target",
    disposition: "post_flip_target_authoritative",
    needsAttention: false,
    dispatchAttempts: 0,
    attentionDeadlineAt: null,
    sourceAcknowledgedAt: null,
    targetAcknowledgedAt: null,
    targetOutcome: null,
    canceledAt: null,
    updatedAt: "2026-07-20T00:00:09.000Z",
  };
}

class FakeSocket implements AgentMigrationRealtimeSocket {
  connected = true;
  handlers = new Map<string, Set<(payload?: unknown) => void>>();

  on(eventName: string, handler: (payload?: unknown) => void) {
    const handlers = this.handlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
  }

  off(eventName: string, handler: (payload?: unknown) => void) {
    this.handlers.get(eventName)?.delete(handler);
  }

  emit(eventName: string, payload?: unknown) {
    for (const handler of this.handlers.get(eventName) ?? []) handler(payload);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("authoritative owner snapshots replace the complete latest-only read model", () => {
  const first = applyAgentMigrationSnapshot(snapshot(8, "completed"));
  const replaced = applyAgentMigrationSnapshot(snapshot(1, "provisioning"));

  assert.equal(first.migration?.revision, 8);
  assert.deepEqual(replaced, snapshot(1, "provisioning"));
  assert.equal("history" in replaced, false);
});

test("a late response from a stopped controller cannot overwrite a newer controller snapshot", async () => {
  const socket = new FakeSocket();
  const oldRead = deferred<AgentMigrationStatusResponse>();
  const applied: AgentMigrationStatusResponse[] = [];
  const oldSync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: () => oldRead.promise,
    applySnapshot: (value) => applied.push(value),
    onError: assert.fail,
    onHealthy: () => {},
  });
  oldSync.start();
  oldSync.stop();

  const newSync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: async () => snapshot(9, "completed"),
    applySnapshot: (value) => applied.push(value),
    onError: assert.fail,
    onHealthy: () => {},
  });
  newSync.start();
  await flush();
  oldRead.resolve(snapshot(1, "prep"));
  await flush();

  assert.deepEqual(applied, [snapshot(9, "completed")]);
  newSync.stop();
});

test("socket event payloads only invalidate and never project state into the read model", async () => {
  const socket = new FakeSocket();
  const reads = [snapshot(1, "prep"), snapshot(2, "arriving")];
  const applied: AgentMigrationStatusResponse[] = [];
  const sync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: async () => reads.shift()!,
    applySnapshot: (value) => applied.push(value),
    onError: assert.fail,
    onHealthy: () => {},
    pollMs: 60_000,
  });

  sync.start();
  await flush();
  socket.emit("agent:migration-updated", event(99, "canceled_post_flip"));
  await flush();

  assert.deepEqual(applied.map((value) => value.migration?.state), ["prep", "arriving"]);
  assert.equal(applied.some((value) => value.migration?.revision === 99), false);
  sync.stop();
});

test("initial, connect, rooms, event, and manual signals coalesce through one latest-read function", async () => {
  const socket = new FakeSocket();
  const first = deferred<AgentMigrationStatusResponse>();
  let reads = 0;
  const sync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: () => {
      reads += 1;
      return reads === 1 ? first.promise : Promise.resolve(snapshot(2, "completed"));
    },
    applySnapshot: () => {},
    onError: assert.fail,
    onHealthy: () => {},
  });

  sync.start();
  socket.emit("connect");
  socket.emit("rooms:joined");
  socket.emit("agent:migration-updated", event(4));
  const manual = sync.refreshLatestMigration();
  assert.equal(reads, 1);
  assert.equal(sync.debugState().refreshQueued, true);

  first.resolve(snapshot(1, "prep"));
  await manual;
  assert.equal(reads, 2);
  assert.equal(sync.debugState().requestInFlight, false);
  sync.stop();
});

test("the same latest read polls every two seconds only while the authoritative state is active", async () => {
  const socket = new FakeSocket();
  const reads = [snapshot(1, "prep"), snapshot(2, "completed")];
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimer = 1;
  const sync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: async () => reads.shift()!,
    applySnapshot: () => {},
    onError: assert.fail,
    onHealthy: () => {},
    schedule: (callback, delayMs) => {
      const id = nextTimer++;
      scheduled.set(id, { callback, delayMs });
      return id;
    },
    cancel: (handle) => scheduled.delete(handle as number),
  });

  sync.start();
  await flush();
  assert.equal(scheduled.size, 1);
  const [timerId, timer] = [...scheduled.entries()][0]!;
  assert.equal(timer.delayMs, 2_000);
  scheduled.delete(timerId);
  timer.callback();
  await flush();
  assert.equal(scheduled.size, 0);
  sync.stop();
});

test("null latest status stops active polling", async () => {
  const socket = new FakeSocket();
  const scheduled = new Map<number, () => void>();
  let nextTimer = 1;
  const sync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: async () => ({ migration: null }),
    applySnapshot: () => {},
    onError: assert.fail,
    onHealthy: () => {},
    schedule: (callback) => {
      const id = nextTimer++;
      scheduled.set(id, callback);
      return id;
    },
    cancel: (handle) => scheduled.delete(handle as number),
  });

  sync.start();
  await flush();
  assert.equal(scheduled.size, 0);
  sync.stop();
});

test("a temporary read failure preserves active polling until a terminal snapshot arrives", async () => {
  const socket = new FakeSocket();
  const scheduled = new Map<number, () => void>();
  let nextTimer = 1;
  let reads = 0;
  let errors = 0;
  const sync = createAgentMigrationRealtimeSync({
    agentId: AGENT_ID,
    socket,
    readLatestMigration: async () => {
      reads += 1;
      if (reads === 1) return snapshot(1, "in_transit");
      if (reads === 2) throw new Error("temporary outage");
      return snapshot(2, "completed");
    },
    applySnapshot: () => {},
    onError: () => { errors += 1; },
    onHealthy: () => {},
    schedule: (callback) => {
      const id = nextTimer++;
      scheduled.set(id, callback);
      return id;
    },
    cancel: (handle) => scheduled.delete(handle as number),
  });

  sync.start();
  await flush();
  let [timerId, timer] = [...scheduled.entries()][0]!;
  scheduled.delete(timerId);
  timer();
  await flush();
  assert.equal(errors, 1);
  assert.equal(scheduled.size, 1);

  [timerId, timer] = [...scheduled.entries()][0]!;
  scheduled.delete(timerId);
  timer();
  await flush();
  assert.equal(scheduled.size, 0);
  sync.stop();
});

test("the whole Web product tree contains canonical references and no owner UUID field", () => {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const ignoredDirectories = new Set(["coverage", "dist", "node_modules", "test-results"]);
  const productExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx"]);
  const forbiddenField = ["migration", "Id"].join("");
  const pending = [packageRoot];
  const violations: string[] = [];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !productExtensions.has(extname(entry.name))) continue;
      if (readFileSync(absolutePath, "utf8").includes(forbiddenField)) {
        violations.push(absolutePath.slice(packageRoot.length));
      }
    }
  }

  assert.deepEqual(violations.sort(), [], "Web product files must not expose the internal migration UUID");
});
