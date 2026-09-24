import assert from "node:assert/strict";
import { test } from "vitest";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport.js";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";

import { receiveCleanerConfigMessage } from "./configReceiver.js";
import { SystemCleanerRuntime, type CleanerClock } from "./runtime.js";

type UpsertMessage = Extract<ServerToMachineMessage, { type: "app_config.upsert" }>;
type SnapshotMessage = Extract<ServerToMachineMessage, { type: "app_config.snapshot" }>;

class CountingClock implements CleanerClock {
  private nextId = 1;
  private readonly active = new Set<number>();

  now(): number {
    return 1_000;
  }

  schedule(): unknown {
    const id = this.nextId++;
    this.active.add(id);
    return id;
  }

  cancel(timer: unknown): void {
    this.active.delete(timer as number);
  }

  activeCount(): number {
    return this.active.size;
  }
}

function wire(ownerAgentId: string, revision = 1): AppConfigWireSnapshot {
  return {
    appId: CLEANER_APP_ID,
    ownerAgentId,
    revision,
    effective: { ...CLEANER_CONFIG_DEFAULTS },
  };
}

function fixture() {
  const clock = new CountingClock();
  const runtime = new SystemCleanerRuntime({
    agentsDataDir: "/computer/agents",
    clock,
    wake: () => {},
  });
  return { runtime, clock };
}

test("generic upsert applies the closed Cleaner effective map", () => {
  const { runtime } = fixture();
  const result = receiveCleanerConfigMessage(runtime, {
    type: "app_config.upsert",
    agentId: "owner-a",
    config: wire("owner-a", 7),
  } satisfies UpsertMessage);

  assert.deepEqual(result, {
    kind: "upsert",
    result: { kind: "applied", activeSchedules: 1 },
    terminals: [{
      attrs: {
        app_id: CLEANER_APP_ID,
        owner_agent_id: "owner-a",
        config_revision: 7,
        app_correlation_id: `config:${CLEANER_APP_ID}:owner-a:7`,
      },
      outcome: "applied",
      status: "ok",
    }],
  });
  assert.deepEqual(runtime.getAppliedConfig("owner-a"), {
    appId: CLEANER_APP_ID,
    ownerAgentId: "owner-a",
    revision: 7,
    ...CLEANER_CONFIG_DEFAULTS,
  });
});

test("misrouted upsert is fail-closed with zero schedule", () => {
  const { runtime, clock } = fixture();
  const result = receiveCleanerConfigMessage(runtime, {
    type: "app_config.upsert",
    agentId: "owner-a",
    config: wire("owner-b"),
  } satisfies UpsertMessage);

  assert.equal(result.kind, "invalid");
  assert.equal(result.kind === "invalid" ? result.reason : null, "owner_agent_id_mismatch");
  assert.deepEqual(result.terminals.map(({ outcome, status, reason }) => ({ outcome, status, reason })), [
    { outcome: "invalid", status: "error", reason: "owner_agent_id_mismatch" },
  ]);
  assert.equal(clock.activeCount(), 0);
  assert.equal(runtime.getAppliedConfig("owner-a"), null);
  assert.equal(runtime.getAppliedConfig("owner-b"), null);
});

test("unknown, missing, or mistyped effective keys never reach the mirror", () => {
  const { runtime, clock } = fixture();
  const invalidEffectiveMaps = [
    { ...CLEANER_CONFIG_DEFAULTS, rawActionEnabled: true },
    {
      enabled: CLEANER_CONFIG_DEFAULTS.enabled,
      thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes,
    },
    { ...CLEANER_CONFIG_DEFAULTS, enabled: 1 },
  ];
  for (const effective of invalidEffectiveMaps) {
    const result = receiveCleanerConfigMessage(runtime, {
      type: "app_config.upsert",
      agentId: "owner-a",
      config: { ...wire("owner-a"), effective } as AppConfigWireSnapshot,
    } satisfies UpsertMessage);
    assert.equal(result.kind, "invalid");
    assert.equal(result.kind === "invalid" ? result.reason : null, "config_invalid");
    assert.equal(result.terminals[0]?.status, "error");
  }
  assert.equal(clock.activeCount(), 0);
});

test("owner-scoped snapshot replaces A without retiring B", () => {
  const { runtime } = fixture();
  receiveCleanerConfigMessage(runtime, {
    type: "app_config.upsert",
    agentId: "owner-a",
    config: wire("owner-a", 1),
  } satisfies UpsertMessage);
  receiveCleanerConfigMessage(runtime, {
    type: "app_config.upsert",
    agentId: "owner-b",
    config: wire("owner-b", 1),
  } satisfies UpsertMessage);

  const result = receiveCleanerConfigMessage(runtime, {
    type: "app_config.snapshot",
    agentId: "owner-a",
    configs: [wire("owner-a", 2), { ...wire("owner-a"), appId: "x.other" }],
  } satisfies SnapshotMessage);

  assert.equal(result.kind, "snapshot");
  assert.equal(runtime.getAppliedConfig("owner-a")?.revision, 2);
  assert.equal(runtime.getAppliedConfig("owner-b")?.revision, 1);
  assert.equal(runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(runtime.activeScheduleCount("owner-b"), 1);
});

test("empty owner snapshot removes only that owner's transient state", () => {
  const { runtime } = fixture();
  for (const ownerAgentId of ["owner-a", "owner-b"]) {
    receiveCleanerConfigMessage(runtime, {
      type: "app_config.upsert",
      agentId: ownerAgentId,
      config: wire(ownerAgentId),
    } satisfies UpsertMessage);
  }

  const result = receiveCleanerConfigMessage(runtime, {
    type: "app_config.snapshot",
    agentId: "owner-a",
    configs: [],
  } satisfies SnapshotMessage);

  assert.deepEqual(result, {
    kind: "snapshot",
    result: { kind: "removed", activeSchedules: 0 },
    terminals: [{
      attrs: {
        app_id: CLEANER_APP_ID,
        owner_agent_id: "owner-a",
        snapshot_kind: "app_config",
        app_correlation_id: `snapshot:app_config:${CLEANER_APP_ID}:owner-a`,
      },
      outcome: "removed",
      status: "ok",
    }],
  });
  assert.equal(runtime.getAppliedConfig("owner-a"), null);
  assert.equal(runtime.getAppliedConfig("owner-b")?.ownerAgentId, "owner-b");
});

test("snapshot rejects duplicate or cross-owner Cleaner rows atomically", () => {
  const { runtime, clock } = fixture();
  const messages: SnapshotMessage[] = [
    {
      type: "app_config.snapshot",
      agentId: "owner-a",
      configs: [wire("owner-a"), wire("owner-a")],
    },
    {
      type: "app_config.snapshot",
      agentId: "owner-a",
      configs: [wire("owner-b")],
    },
  ];
  for (const message of messages) {
    assert.equal(receiveCleanerConfigMessage(runtime, message).kind, "invalid");
  }
  assert.equal(clock.activeCount(), 0);
  assert.equal(runtime.getAppliedConfig("owner-a"), null);
  assert.equal(runtime.getAppliedConfig("owner-b"), null);
});

test("other app envelopes remain available to generic dispatch", () => {
  const { runtime, clock } = fixture();
  const result = receiveCleanerConfigMessage(runtime, {
    type: "app_config.upsert",
    agentId: "owner-a",
    config: { ...wire("owner-a"), appId: "x.other" },
  } satisfies UpsertMessage);
  assert.equal(result.kind, "ignored");
  assert.deepEqual(result.terminals.map(({ outcome, status, reason }) => ({ outcome, status, reason })), [
    { outcome: "ignored", status: "error", reason: "unsupported_app" },
  ]);
  assert.equal(clock.activeCount(), 0);
});

test("snapshot trace terminals are per-row and empty Cleaner removal stays visible", () => {
  const { runtime } = fixture();
  const applied = receiveCleanerConfigMessage(runtime, {
    type: "app_config.snapshot",
    agentId: "owner-a",
    configs: [
      wire("owner-a", 2),
      { ...wire("owner-a", 9), appId: "x.other" },
    ],
  } satisfies SnapshotMessage);
  assert.deepEqual(
    applied.terminals.map((terminal) => ({
      appId: terminal.attrs.app_id,
      revision: terminal.attrs.config_revision,
      outcome: terminal.outcome,
      status: terminal.status,
    })),
    [
      { appId: "x.other", revision: 9, outcome: "ignored", status: "error" },
      { appId: CLEANER_APP_ID, revision: 2, outcome: "applied", status: "ok" },
    ],
  );

  const stale = receiveCleanerConfigMessage(runtime, {
    type: "app_config.snapshot",
    agentId: "owner-a",
    configs: [wire("owner-a", 1)],
  } satisfies SnapshotMessage);
  assert.deepEqual(stale.terminals.map(({ outcome, status }) => ({ outcome, status })), [
    { outcome: "stale", status: "error" },
  ]);

  const removed = receiveCleanerConfigMessage(runtime, {
    type: "app_config.snapshot",
    agentId: "owner-a",
    configs: [],
  } satisfies SnapshotMessage);
  assert.equal(removed.terminals[0]?.attrs.app_correlation_id,
    `snapshot:app_config:${CLEANER_APP_ID}:owner-a`);
  assert.equal(removed.terminals[0]?.outcome, "removed");
});
