import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  classifyScopedAppStorageFailureReason,
  createScopedAppStorageFactory,
  type ScopedAppStorageFailureEvent,
} from "./scopedAppStorage.js";

test("scoped storage classifies every retryable lock code as lock_contention", () => {
  for (const code of ["EAGAIN", "EBUSY", "EEXIST"]) {
    assert.equal(
      classifyScopedAppStorageFailureReason(Object.assign(new Error("private"), { code })),
      "lock_contention",
    );
  }
  assert.equal(
    classifyScopedAppStorageFailureReason(Object.assign(new Error("private"), { code: "EIO" })),
    "storage_io",
  );
});

function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...allFiles(entryPath));
    else result.push(entryPath);
  }
  return result;
}

test("scoped App storage isolates the same App and Agent across Servers", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-"));
  try {
    const serverA = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
    }).open({ appId: "system.agent-inbox", agentId: "agent-1" });
    const serverB = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-b" },
    }).open({ appId: "system.agent-inbox", agentId: "agent-1" });

    serverA.writeTextAtomic("server-a\n");
    assert.equal(serverA.readText(), "server-a\n");
    assert.equal(serverB.readText(), null);

    serverB.writeTextAtomic("server-b\n");
    assert.equal(serverA.readText(), "server-a\n");
    assert.equal(serverB.readText(), "server-b\n");
    assert.equal(
      allFiles(path.join(slockHome, "app-storage")).filter((file) => file.endsWith("state.json")).length,
      2,
    );
    assert.equal(allFiles(path.join(slockHome, "app-storage")).some((file) => file.endsWith(".tmp")), false);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("scoped App storage isolates two Agent owners inside one Server and App", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-agents-"));
  try {
    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
    });
    const agentA = factory.open({ appId: "system.agent-inbox", agentId: "agent-a" });
    const agentB = factory.open({ appId: "system.agent-inbox", agentId: "agent-b" });
    agentA.writeTextAtomic("agent-a\n");
    assert.equal(agentA.readText(), "agent-a\n");
    assert.equal(agentB.readText(), null);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("unknown legacy App bytes are quarantined outside every Server scope", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-legacy-"));
  try {
    const legacyPath = path.join(slockHome, "agent-inbox", "agent-1.json");
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "legacy-owner-unknown\n");

    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
    });
    assert.equal(
      factory.quarantineLegacyFile("agent-inbox/agent-1.json", "system.agent-inbox"),
      "quarantined",
    );
    assert.equal(
      factory.quarantineLegacyFile("agent-inbox/agent-1.json", "system.agent-inbox"),
      "absent",
    );
    assert.equal(existsSync(legacyPath), false);
    assert.equal(factory.open({ appId: "system.agent-inbox", agentId: "agent-1" }).readText(), null);

    const quarantined = allFiles(path.join(slockHome, "app-storage-quarantine"));
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(quarantined[0]!, "utf8"), "legacy-owner-unknown\n");
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("legacy quarantine directory failures emit one privacy-safe typed event", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-quarantine-failure-"));
  try {
    const legacyPath = path.join(slockHome, "agent-inbox", "agent-1.json");
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "legacy bytes must not enter telemetry\n");
    writeFileSync(path.join(slockHome, "app-storage-quarantine"), "blocks mkdir");

    const failures: ScopedAppStorageFailureEvent[] = [];
    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => failures.push(event),
    });

    assert.throws(
      () => factory.quarantineLegacyFile("agent-inbox/agent-1.json", "system.agent-inbox"),
    );
    assert.deepEqual(failures, [{
      operation: "legacy_quarantine",
      store: "legacy_unscoped",
      appId: "system.agent-inbox",
      serverId: "server-a",
      writerEpoch: "writer-1",
      outcome: "failed",
      reason: "storage_io",
    }]);
    const serialized = JSON.stringify(failures);
    assert.equal(serialized.includes("legacy bytes"), false);
    assert.equal(serialized.includes(legacyPath), false);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("scope identities and legacy paths fail closed before path construction", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-invalid-"));
  try {
    assert.throws(() => createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "../machine", serverId: "server-a" },
    }), /machine id is invalid/);
    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
    });
    assert.throws(
      () => factory.open({ appId: "system.agent-inbox", agentId: "../agent" }),
      /agent id is invalid/,
    );
    assert.throws(
      () => factory.quarantineLegacyFile("../other-server.json", "system.agent-inbox"),
      /escapes root/,
    );
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("revocation closes capabilities that were already handed to an App", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-revoke-"));
  try {
    const failures: ScopedAppStorageFailureEvent[] = [];
    const factory = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => failures.push(event),
    });
    const storage = factory.open({ appId: "system.agent-inbox", agentId: "agent-1" });
    storage.writeTextAtomic("before revoke\n");
    factory.revoke();
    assert.throws(() => storage.assertActive(), /capability is revoked/);
    assert.throws(() => storage.readText(), /capability is revoked/);
    assert.throws(() => storage.writeTextAtomic("after revoke\n"), /capability is revoked/);
    assert.throws(
      () => factory.open({ appId: "system.agent-inbox", agentId: "agent-2" }),
      /capability is revoked/,
    );
    assert.deepEqual(failures, [
      {
        operation: "access",
        store: "app_state",
        appId: "system.agent-inbox",
        serverId: "server-a",
        writerEpoch: "writer-1",
        outcome: "denied",
        reason: "capability_revoked",
      },
      {
        operation: "access",
        store: "app_state",
        appId: "system.agent-inbox",
        serverId: "server-a",
        writerEpoch: "writer-1",
        outcome: "denied",
        reason: "capability_revoked",
      },
      {
        operation: "access",
        store: "app_state",
        appId: "system.agent-inbox",
        serverId: "server-a",
        writerEpoch: "writer-1",
        outcome: "denied",
        reason: "capability_revoked",
      },
      {
        operation: "access",
        store: "app_state",
        appId: "system.agent-inbox",
        serverId: "server-a",
        writerEpoch: "writer-1",
        outcome: "denied",
        reason: "capability_revoked",
      },
    ]);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("write failures emit one privacy-safe typed event before rethrow", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-failure-"));
  const slockHome = path.join(root, "not-a-directory");
  writeFileSync(slockHome, "blocks mkdir");
  try {
    const failures: ScopedAppStorageFailureEvent[] = [];
    const storage = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "system.agent-inbox", agentId: "agent-1" });
    assert.throws(() => storage.writeTextAtomic("payload must not enter telemetry"));
    assert.deepEqual(failures, [{
      operation: "write",
      store: "app_state",
      appId: "system.agent-inbox",
      serverId: "server-a",
      writerEpoch: "writer-1",
      outcome: "failed",
      reason: "storage_io",
    }]);
    assert.equal(JSON.stringify(failures).includes("payload"), false);
    assert.equal(JSON.stringify(failures).includes(slockHome), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("App decode failures reuse the scoped owner envelope without leaking bytes", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-decode-"));
  try {
    const failures: ScopedAppStorageFailureEvent[] = [];
    const storage = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "system.agent-inbox", agentId: "agent-secret" });
    storage.writeTextAtomic("secret malformed bytes");
    assert.equal(storage.readText(), "secret malformed bytes");
    storage.reportDataFailure("invalid_payload");
    storage.reportDataFailure("invalid_payload");
    assert.equal(failures.length, 2);
    assert.deepEqual(failures.map(({ failureInstanceId: _failureInstanceId, ...event }) => event), [{
      operation: "decode",
      store: "app_state",
      appId: "system.agent-inbox",
      serverId: "server-a",
      writerEpoch: "writer-1",
      outcome: "failed",
      reason: "invalid_payload",
      observation: "edge",
    }, {
      operation: "decode",
      store: "app_state",
      appId: "system.agent-inbox",
      serverId: "server-a",
      writerEpoch: "writer-1",
      outcome: "failed",
      reason: "invalid_payload",
      observation: "level",
    }]);
    assert.equal(typeof failures[0]?.failureInstanceId, "string");
    assert.equal(failures[0]?.failureInstanceId, failures[1]?.failureInstanceId);
    const serialized = JSON.stringify(failures);
    assert.equal(serialized.includes("secret malformed bytes"), false);
    assert.equal(serialized.includes("agent-secret"), false);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});

test("an atomic rewrite creates a new corruption EDGE instead of extending the prior LEVEL", () => {
  const slockHome = mkdtempSync(path.join(os.tmpdir(), "scoped-app-storage-generation-"));
  try {
    const failures: ScopedAppStorageFailureEvent[] = [];
    const storage = createScopedAppStorageFactory({
      slockHome,
      owner: { machineId: "machine-1", serverId: "server-a" },
      writerEpoch: "writer-1",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "system.reminder", agentId: "agent-secret" });

    storage.writeTextAtomic("first malformed generation");
    assert.equal(storage.readText(), "first malformed generation");
    storage.reportDataFailure("invalid_payload");
    storage.reportDataFailure("invalid_payload");

    storage.writeTextAtomic("second malformed generation");
    assert.equal(storage.readText(), "second malformed generation");
    storage.reportDataFailure("invalid_payload");

    assert.deepEqual(failures.map((event) => event.observation), ["edge", "level", "edge"]);
    assert.equal(failures[0]?.failureInstanceId, failures[1]?.failureInstanceId);
    assert.notEqual(failures[1]?.failureInstanceId, failures[2]?.failureInstanceId);
    const serialized = JSON.stringify(failures);
    assert.equal(serialized.includes("first malformed generation"), false);
    assert.equal(serialized.includes("second malformed generation"), false);
    assert.equal(serialized.includes("agent-secret"), false);
  } finally {
    rmSync(slockHome, { recursive: true, force: true });
  }
});
