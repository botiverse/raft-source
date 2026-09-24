import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import { CLEANER_CONFIG_DEFAULTS } from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";

import { createAgentAppInboxStore } from "./agentAppInbox.js";
import { createBuiltInLocalScheduleRuntime } from "./registry.manifest.js";
import { createScopedAppStorageFactory } from "./scopedAppStorage.js";

const cleanerClock = {
  now: () => 0,
  schedule: () => 1,
  cancel: () => {},
};

test("daemon config receiver emits truthful stale, invalid, and empty-removal terminals", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-config-trace-"));
  const traces: Array<{
    name: string;
    attrs: Record<string, unknown>;
    status?: "ok" | "error";
  }> = [];
  const runtime = createBuiltInLocalScheduleRuntime({
    agentsDataDir: root,
    cleanerClock,
    getInbox: () => createAgentAppInboxStore(),
    notifyInbox: async () => false,
    send: () => {},
    trace: (name, attrs, status) =>
      traces.push({ name, attrs: { ...attrs }, status }),
  });
  const storageFactory = createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  });
  runtime.bindScopedStorage(storageFactory);
  const wire = (revision: number) => ({
    appId: "system.cleaner" as const,
    ownerAgentId: "agent-a",
    revision,
    effective: { ...CLEANER_CONFIG_DEFAULTS },
  });

  try {
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: wire(2),
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: wire(1),
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: "agent-a",
      config: {
        ...wire(3),
        effective: { ...CLEANER_CONFIG_DEFAULTS, forbidden: 1 },
      },
    }), true);
    assert.equal(runtime.handleServerMessage({
      type: "app_config.snapshot",
      agentId: "agent-a",
      configs: [],
    }), true);

    const terminals = traces.filter((trace) =>
      trace.name === "daemon.app_config.receive"
    );
    assert.deepEqual(
      terminals.map(({ attrs, status }) => ({
        outcome: attrs.outcome,
        reason: attrs.reason,
        status,
        correlation: attrs.app_correlation_id,
      })),
      [
        {
          outcome: "applied",
          reason: undefined,
          status: "ok",
          correlation: "config:system.cleaner:agent-a:2",
        },
        {
          outcome: "stale",
          reason: undefined,
          status: "error",
          correlation: "config:system.cleaner:agent-a:1",
        },
        {
          outcome: "invalid",
          reason: "config_invalid",
          status: "error",
          correlation: "config:system.cleaner:agent-a:3",
        },
        {
          outcome: "removed",
          reason: undefined,
          status: "ok",
          correlation: "snapshot:app_config:system.cleaner:agent-a",
        },
      ],
    );
  } finally {
    runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
