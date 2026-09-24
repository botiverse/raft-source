import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AxSurfaceText,
  BasicTracer,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  WIKI_WORKSPACE_PACK_CAPABILITY,
  canonicalizeWikiWorkspacePackFiles,
  createTraceScopeTracer,
  eventsForSpan,
  formatTraceparent,
  MemoryTraceSink,
  parseTraceparent,
  type AgentConfig,
  type ComputerLifecycleExecutionAck,
  type MachineToServerMessage,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  type WikiWorkspacePack,
} from "@botiverse/raft-shared";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
  CLEANER_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol.js";
import { AgentProcessManager } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import type { AgentAppInboxStore } from "./agentAppInbox.js";
import { AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY } from "./agentMigrationWorkspaceArchive.js";
import {
  DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  DaemonCore,
  selectWakeDeliveryIndex,
  detectRuntimes,
  migrationTransferFailureCode,
  parseDaemonCliArgs,
  readDaemonVersion,
  resolveRaftCliPath,
  subscribeDaemonLogs,
  validateAgentMigrationControlManifest,
  type AgentMigrationHttpTransport,
} from "./core.js";
import {
  AGENT_MIGRATION_TRANSPORT_HOST_ENV,
  AGENT_MIGRATION_TRANSPORT_PORT_ENV,
  AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV,
} from "./agentMigrationHttpTransport.js";
import {
  AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE,
  buildAgentMigrationObjectStoreBundle,
  stageAgentMigrationObjectStoreBundle,
} from "./agentMigrationObjectStoreBundle.js";
import { getDaemonMachineLockId } from "./machineLock.js";
import type { RuntimeDriver, ParsedEvent, SpawnContext, SpawnResult } from "./drivers/index.js";
import type { ConnectionOptions, WebSocketLike } from "./connection.js";
import { FakeClock } from "./testing/fakeClock.js";

test("migration transfer classification preserves the bounded entry-count failure", () => {
  assert.equal(
    migrationTransferFailureCode(new Error(
      "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=src%2F,250001",
    )),
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  );
  assert.equal(
    migrationTransferFailureCode(new Error("MIGRATION_PRIVATE_DRIVER_FAILURE:password=secret")),
    undefined,
  );
});
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class FakeDriver implements RuntimeDriver {
  readonly id = "codex";
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only" } as const;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode = "none" as const;
  readonly spawnCalls: SpawnContext[] = [];
  readonly children: FakeChildProcess[] = [];

  constructor(opts: { supportsStdinNotification?: boolean } = {}) {
    this.supportsStdinNotification = opts.supportsStdinNotification ?? false;
    this.lifecycle = this.supportsStdinNotification
      ? { kind: "persistent", stdin: "notification", inFlightWake: "queue" }
      : { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" };
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess();
    this.children.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    if (line === "turn_end") return [{ kind: "turn_end", sessionId: "session-1" }];
    return [];
  }

  encodeStdinMessage(_text: string, _sessionId: string | null): string | null {
    return this.supportsStdinNotification ? _text : null;
  }

  buildSystemPrompt(_config: AgentConfig, _agentId: string): AxSurfaceText {
    return asAxSurfaceText("test prompt");
  }
}

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  }

  emitOpen(options: { machineContext?: boolean } = {}): void {
    this.readyState = 1;
    this.emit("open");
    if (options.machineContext !== false) {
      this.emitServerMessage({
        type: "machine:context",
        machineId: "machine-test",
        serverId: "server-test",
      });
    }
  }

  emitServerMessage(message: ServerToMachineMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "codex-agent",
    displayName: "Codex Agent",
    description: "test agent",
    model: "gpt-5.3-codex",
    runtime: "codex",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "",
    agentCredentialKey: "sk_agent_existing",
    ...overrides,
  };
}

function makeCoreTestWikiPack(): WikiWorkspacePack {
  const files = [
    { relativePath: "AGENTS.md", content: "# Core Wiki Agent\n" },
    { relativePath: "CLAUDE.md", content: "@AGENTS.md\n" },
    { relativePath: ".agents/skills/ingest.md", content: "# Core Ingest\n" },
  ].map((file) => ({
    ...file,
    sha256: createHash("sha256").update(file.content).digest("hex"),
    size: Buffer.byteLength(file.content),
  }));
  return {
    protocolVersion: 1,
    packId: createHash("sha256")
      .update(canonicalizeWikiWorkspacePackFiles(files))
      .digest("hex"),
    files,
  };
}

test("daemon CLI accepts machine API key from a file instead of argv", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-api-key-file-test-"));
  try {
    const keyFile = path.join(tmp, "machine.key");
    await writeFile(keyFile, "sk_machine_secret\n", { mode: 0o600 });

    const parsed = parseDaemonCliArgs([
      "--server-url",
      "https://api.slock.ai",
      "--api-key-file",
      keyFile,
    ]);

    assert.deepEqual(parsed, {
      serverUrl: "https://api.slock.ai",
      apiKey: "sk_machine_secret",
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("readDaemonVersion accepts a Computer SEA build constant and ignores runtime env", () => {
  const previous = process.env.RAFT_DAEMON_VERSION;
  process.env.RAFT_DAEMON_VERSION = "42.0.0-env-must-not-win";
  try {
    const missingPackageUrl = new URL("file:///no-such-computer-sea/core.js").href;
    assert.equal(readDaemonVersion(missingPackageUrl, "0.72.4-sea"), "0.72.4-sea");
    assert.equal(readDaemonVersion(missingPackageUrl), "0.0.0-dev");
  } finally {
    if (previous === undefined) delete process.env.RAFT_DAEMON_VERSION;
    else process.env.RAFT_DAEMON_VERSION = previous;
  }
});

test("DaemonCore ready stamps the Computer SEA baked daemon version", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-sea-version-ready-test-"));
  const sockets: FakeWebSocket[] = [];
  const previous = process.env.RAFT_DAEMON_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_DAEMON_VERSION = "42.0.0-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      daemonVersion: "0.72.4-sea",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(ready?.daemonVersion, "0.72.4-sea");
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS), false);
    assert.equal(ready?.capabilities?.includes(REMINDER_FIRE_REQUEST_CAPABILITY), true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    if (previous === undefined) delete process.env.RAFT_DAEMON_VERSION;
    else process.env.RAFT_DAEMON_VERSION = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore binds App storage to authenticated machine context and revokes it on mismatch", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-scoped-app-storage-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const legacyPath = path.join(rootDir, "agent-inbox", "agent-1.json");
  const legacyReminderPath = path.join(rootDir, "reminders", "mirror.json");
  const scopedPath = path.join(
    rootDir,
    "app-storage",
    "v1",
    "machine-1",
    "server-1",
    "system.agent-inbox",
    "agents",
    "agent-1",
    "state.json",
  );
  let core: DaemonCore | null = null;
  try {
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '{"version":3,"items":[]}\n');
    await mkdir(path.dirname(legacyReminderPath), { recursive: true });
    await writeFile(legacyReminderPath, '{"version":4,"records":[]}\n');
    await mkdir(path.dirname(scopedPath), { recursive: true });
    await writeFile(scopedPath, "{invalid-json\n");
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir: path.join(rootDir, "agents"),
      slockHome: rootDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen({ machineContext: false });
    const storageAccess = core as unknown as {
      getAgentAppInbox(agentId: string): AgentAppInboxStore;
    };
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-1"),
      /before authenticated machine context/,
    );

    socket.emitServerMessage({
      type: "machine:context",
      machineId: "machine-1",
      serverId: "server-1",
    });
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-1"),
      /Unexpected token in agent app inbox persisted JSON/,
    );
    const storageTraces = sink.getTrace(traceId);
    const heartbeats = storageTraces.filter((span) =>
      span.name === "daemon.app_storage.heartbeat"
    );
    assert.equal(heartbeats.length, 6);
    assert.equal(heartbeats.every((span) => span.attrs?.server_id === "server-1"), true);
    const writerEpoch = heartbeats[0]?.attrs?.writer_epoch;
    assert.equal(typeof writerEpoch, "string");
    assert.equal(heartbeats.every((span) => span.attrs?.writer_epoch === writerEpoch), true);
    const invalidPayload = storageTraces.find((span) =>
      span.name === "daemon.app_storage.counter"
      && span.attrs?.app === "system.agent-inbox"
      && span.attrs?.family === "invalid_payload"
    );
    assert.deepEqual(invalidPayload?.attrs && {
      operation: invalidPayload.attrs.operation,
      reason: invalidPayload.attrs.reason,
      serverId: invalidPayload.attrs.server_id,
      writerEpoch: invalidPayload.attrs.writer_epoch,
      corruptionClass: invalidPayload.attrs.corruption_class,
    }, {
      operation: "decode",
      reason: "invalid_payload",
      serverId: "server-1",
      writerEpoch,
      corruptionClass: "edge",
    });
    await rm(scopedPath);
    const inbox = storageAccess.getAgentAppInbox("agent-1");
    const minted = inbox.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: {
        kind: "reminder",
        id: "11111111-1111-4111-8111-111111111111",
        revision: "1",
      },
    });
    assert.equal(minted.ok, true);
    assert.match(await readFile(scopedPath, "utf8"), /11111111-1111-4111-8111-111111111111/);
    await assert.rejects(stat(legacyPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(
      stat(legacyReminderPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    const quarantined = await readdir(path.join(
      rootDir,
      "app-storage-quarantine",
      "v1",
      "unscoped",
    ));
    assert.equal(
      quarantined.filter((name) => name.endsWith("-mirror.json")).length,
      1,
      "legacy global Reminder mirror is quarantined exactly once",
    );

    socket.emitServerMessage({
      type: "machine:context",
      machineId: "machine-1",
      serverId: "server-2",
    });
    assert.throws(() => inbox.clear(), /capability is revoked/);
    assert.throws(
      () => storageAccess.getAgentAppInbox("agent-2"),
      /after authenticated machine context conflict/,
    );
  } finally {
    if (core) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore refreshes one runtime usage provider and emits only the sanitized correlated snapshot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-usage-test-"));
  const sockets: FakeWebSocket[] = [];
  const calls: RuntimeAccountUsageProvider[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sanitizedSnapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-01T20:00:00.000Z",
    staleAfter: "2026-08-01T20:30:00.000Z",
    collectorVersion: "test",
    accounts: [{
      accountKey: "a".repeat(64),
      health: "ok",
      windows: [{
        id: "weekly_0",
        label: "Weekly limit",
        status: "ok",
        usedRatio: 0.4,
        resetsAt: "2026-08-07T13:07:35.341Z",
      }],
    }],
  };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAccountUsageCollector: async (provider) => {
      calls.push(provider);
      return sanitizedSnapshot;
    },
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:runtime_account_usage:refresh",
      requestId: "usage-request-1",
      provider: "kimi",
      reason: "stale_or_missing",
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"),
      "runtime usage snapshot",
    );

    assert.deepEqual(calls, ["kimi"]);
    const response = socket.sent.find((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:snapshot" }> =>
      typeof message === "object" && message !== null && (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"
    );
    assert.deepEqual(response, {
      type: "machine:runtime_account_usage:snapshot",
      requestId: "usage-request-1",
      snapshot: sanitizedSnapshot,
    });
    const trace = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime_account_usage.refresh");
    assert.equal(trace?.attrs?.outcome, "snapshot_sent");
    assert.equal(trace?.attrs?.provider, "kimi");
    assert.equal(trace?.attrs?.reason, "stale_or_missing");
    assert.equal(trace?.attrs?.account_count, 1);
    assert.equal(trace?.attrs?.window_count, 1);
    assert.equal(trace?.attrs?.health_classes, "ok");
    assert.equal(trace?.attrs?.parse_unavailable_count, 0);
    assert.equal(trace?.attrs?.account_key, undefined);
    assert.equal(trace?.attrs?.resets_at, undefined);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore advertises and executes inline Wiki workspace-pack v1 without sidecar assets", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-wiki-pack-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.ok(ready?.capabilities?.includes(WIKI_WORKSPACE_PACK_CAPABILITY));

    const pack = makeCoreTestWikiPack();
    socket.emitServerMessage({
      type: "agent:workspace:ensure-wiki",
      agentId: "wiki-agent",
      requestId: "wiki-pack-request",
      pack,
    });
    await waitFor(
      () => socket.sent.some((msg) =>
        typeof msg === "object"
        && msg !== null
        && (msg as { type?: string }).type === "agent:workspace:wiki_ensured"),
      "Wiki workspace receipt",
    );

    const receipt = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:workspace:wiki_ensured" }> =>
      typeof msg === "object"
      && msg !== null
      && (msg as { type?: string }).type === "agent:workspace:wiki_ensured"
    );
    assert.equal(receipt?.success, true);
    assert.equal(receipt?.packId, pack.packId);
    assert.equal(
      await readFile(path.join(dataDir, "wiki-agent", "AGENTS.md"), "utf8"),
      "# Core Wiki Agent\n",
    );
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore advertises machine-wide Computer controls only for supervisor-relay builds", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-control-cap-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: () => {},
      computerControlViaSupervisor: true,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS), true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore marks the connection before probing and recomputes ready after a 1006 during detection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-ready-reconnect-test-"));
  const sockets: FakeWebSocket[] = [];
  const lifecycleEvents: string[] = [];
  let detectionCount = 0;
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      lifecycleHooks: {
        onConnect: () => lifecycleEvents.push("connect"),
        onDisconnect: () => lifecycleEvents.push("disconnect"),
      },
      runtimeDetector: () => {
        detectionCount += 1;
        lifecycleEvents.push(`detect-${detectionCount}`);
        if (detectionCount === 1) sockets[0]?.terminate();
        return detectionCount === 1
          ? { ids: ["codex"], versions: {} as Record<string, string> }
          : { ids: ["claude"], versions: { claude: "2.1.0" } };
      },
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    sockets[0]?.emitOpen();
    await waitFor(() => sockets.length === 2, "replacement websocket after 1006");
    sockets[1]?.emitOpen();
    await waitFor(
      () => sockets[1]?.sent.some((message) => (message as { type?: string }).type === "ready") ?? false,
      "fresh ready after reconnect",
    );

    assert.deepEqual(lifecycleEvents.slice(0, 4), ["connect", "detect-1", "disconnect", "connect"]);
    assert.equal(lifecycleEvents[4], "detect-2");
    assert.equal(
      sockets[0]?.sent.some((message) => (message as { type?: string }).type === "ready"),
      false,
      "the disconnected socket must not retain a stale ready snapshot",
    );
    const ready = sockets[1]?.sent.find((message) => (message as { type?: string }).type === "ready") as
      | Extract<MachineToServerMessage, { type: "ready" }>
      | undefined;
    assert.deepEqual(ready?.runtimes, ["claude"], "reconnect must recompute current runtime inventory");
    assert.deepEqual(ready?.runtimeVersions, { claude: "2.1.0" }, "ready must carry the recomputed runtime version inventory");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore reports restart completion only after the new generation sends ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-restart-ready-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerRestartReconcile: (emitDone) => {
        emitDone({ requestId: "restart-1", ok: true });
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    assert.equal(socket.sent.length, 0, "no terminal receipt before connect/ready");
    socket.emitOpen();
    await flush();

    const messages = socket.sent.filter(
      (msg): msg is MachineToServerMessage =>
        typeof msg === "object" && msg !== null && "type" in msg,
    );
    const types = messages.map((msg) => msg.type);
    assert.ok(types.indexOf("ready") >= 0);
    assert.ok(types.indexOf("computer:restart:done") > types.indexOf("ready"));
    assert.deepEqual(
      messages.find((msg) => msg.type === "computer:restart:done"),
      { type: "computer:restart:done", requestId: "restart-1", ok: true },
    );

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

test("snapshot-authorized scoped Reminder holds item and wake until Server acceptance", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-reminder-local-test-"));
  const dataDir = path.join(rootDir, "agents");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const reminderClock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  const reminderId = "11111111-1111-4111-8111-111111111111";
  const legalLongMultilineTitle = `Local\n${"x".repeat(494)}`;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    reminderClock,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        appInboxForAgent: options?.appInboxForAgent,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "Reminder target Agent process");
    const child = driver.children[0]!;
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "reminder.snapshot",
      agentId: "agent-1",
      reminders: [],
    });

    socket.emitServerMessage({
      type: "reminder.upsert",
      agentId: "agent-1",
      reminder: {
        reminderId,
        ownerAgentId: "agent-1",
        msgId: null,
        title: legalLongMultilineTitle,
        fireAt: new Date(10_000).toISOString(),
        version: 3,
        recurrence: null,
      },
    });
    assert.ok(socket.sent.some((message) =>
      (message as { type?: string }).type === "reminder.armed"
    ));

    // A local due timer is only a request. Losing transport cannot bypass the
    // Server clock/revision authority by minting a user-visible item.
    socket.readyState = 3;
    reminderClock.advanceBy(10_000);
    await flush();

    assert.equal(child.stdinWrites.some((chunk) => chunk.includes("App items pending: 1")), false);
    assert.equal(socket.sent.some((message) =>
      (message as { type?: string }).type === "reminder.fire_request"
    ), false, "offline request is retained in the durable outbox");

    const appInbox = driver.spawnCalls[0]?.agentAppInbox;
    assert.ok(appInbox, "Core passes its per-agent Inbox store to the matching runtime");
    assert.deepEqual(appInbox.list(), []);
    const mirror = JSON.parse(await readFile(
      path.join(
        rootDir,
        "app-storage",
        "v1",
        "machine-test",
        "server-test",
        "system.reminder",
        "agents",
        "agent-1",
        "state.json",
      ),
      "utf8",
    )) as {
      records: Array<{
        receipts: Array<{
          job: { ownerAgentId: string };
          serverAcked: boolean;
          wakeEnqueued: boolean;
          requestId: string;
        }>;
      }>;
    };
    assert.deepEqual(
      mirror.records.flatMap((record) =>
        record.receipts.map((receipt) => [
          receipt.job.ownerAgentId,
          receipt.serverAcked,
          receipt.wakeEnqueued,
          typeof receipt.requestId,
        ])
      ),
      [["agent-1", false, false, "string"]],
      "the durable request remains retryable without exposing an item",
    );
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore dispatches generic app-config into the built-in local App runtime", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cleaner-core-dispatch-test-"));
  const dataDir = path.join(rootDir, "agents");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
        appInboxForAgent: options?.appInboxForAgent,
      }),
  });

  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-cleaner",
      config: makeConfig({ sessionId: "session-cleaner" }),
      launchId: "launch-cleaner",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "Cleaner target Agent process");
    const inbox = driver.spawnCalls[0]?.agentAppInbox;
    assert.ok(inbox, "Core exposes its per-owner typed Inbox to the runtime");

    const input = {
      appId: CLEANER_APP_ID,
      notificationClass: CLEANER_NOTIFICATION_CLASS,
      sourceRef: { kind: "memory_hint", agentId: "agent-cleaner" },
    } as const;
    assert.equal(inbox.mint(input).ok, false, "action remains closed before config dispatch");

    socket.emitServerMessage({
      type: "app_config.upsert",
      agentId: "agent-cleaner",
      config: {
        appId: CLEANER_APP_ID,
        ownerAgentId: "agent-cleaner",
        revision: 4,
        effective: { ...CLEANER_CONFIG_DEFAULTS },
      },
    });

    const minted = inbox.mint(input);
    assert.equal(minted.ok, true, "Core dispatch must install the applied config action");
    if (minted.ok) {
      assert.equal(
        minted.item.actionCli,
        `raft app config --app ${CLEANER_APP_ID} --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
      );
    }
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("unarmable Reminder emits rejection and never claims armed", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-reminder-reject-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
    reminderClock: new FakeClock(),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "reminder.snapshot",
      agentId: "agent-1",
      reminders: [],
    });
    socket.emitServerMessage({
      type: "reminder.upsert",
      agentId: "agent-1",
      reminder: {
        reminderId: "22222222-2222-4222-8222-222222222222",
        ownerAgentId: "agent-1",
        msgId: null,
        title: "invalid local schedule",
        fireAt: "not-an-iso-date",
        version: 1,
        recurrence: null,
      },
    });
    assert.equal(socket.sent.some((message) => (message as { type?: string }).type === "reminder.armed"), false);
    assert.ok(socket.sent.some((message) =>
      (message as { type?: string; reason?: string }).type === "reminder.arm_rejected"
      && (message as { reason?: string }).reason === "invalid_fire_at"
    ));
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readReadable(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function migrationUploadSpoolNames(): Promise<string[]> {
  return (await readdir(os.tmpdir()))
    .filter((name) => name.startsWith("raft-agent-migration-upload-"))
    .sort();
}

function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const spanIds = ["2".repeat(16), "3".repeat(16)];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => spanIds[spanIndex++] ?? "4".repeat(16),
  });
  return { sink, tracer, traceId };
}

test("daemon credential-proxy trace contract preserves only typed cutover evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent_proxy.request", {
    surface: "daemon",
    kind: "client",
    attrs: {
      route_family: "tasks/claim",
      method: "POST",
      trace_context_state: "continued",
      proxy_launch_id_present: true,
      correlation_id: "0123456789abcdef",
      raw_url: "https://example.test/private?token=secret",
    },
  });
  span.end("error", {
    attrs: {
      outcome: "upstream_5xx",
      http_status: 503,
      normalized_code: "server_5xx",
      response_started: true,
      raw_error: "secret body",
    },
  });

  const [recorded] = sink.getTrace(traceId);
  assert.equal(recorded.attrs?.route_family, "tasks/claim");
  assert.equal(recorded.attrs?.method, "POST");
  assert.equal(recorded.attrs?.trace_context_state, "continued");
  assert.equal(recorded.attrs?.proxy_launch_id_present, true);
  assert.equal(recorded.attrs?.correlation_id, "0123456789abcdef");
  assert.equal(recorded.attrs?.outcome, "upstream_5xx");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.normalized_code, "server_5xx");
  assert.equal(recorded.attrs?.response_started, true);
  assert.equal(recorded.attrs?.raw_url, undefined);
  assert.equal(recorded.attrs?.raw_error, undefined);
});

test("daemon start-dispatch receipt trace keeps only closed identity and queue evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent.start_dispatch.receipt", {
    surface: "daemon",
    kind: "consumer",
    attrs: {
      agent_id: "agent-1",
      launch_id: "launch-1",
      start_dispatch_id: "dispatch-1",
      queue_state: "queued",
      queue_depth: 2,
      queue_age_ms: 125,
      outcome: "accepted",
      raw_start_packet: "secret",
    },
  });
  span.end("ok");

  const [recorded] = sink.getTrace(traceId);
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.launch_id, "launch-1");
  assert.equal(recorded.attrs?.start_dispatch_id, "dispatch-1");
  assert.equal(recorded.attrs?.queue_state, "queued");
  assert.equal(recorded.attrs?.queue_depth, 2);
  assert.equal(recorded.attrs?.queue_age_ms, 125);
  assert.equal(recorded.attrs?.outcome, "accepted");
  assert.equal(recorded.attrs?.raw_start_packet, undefined);
});

test("daemon process-error trace keeps canonical process identity without raw failure state", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent.process.error", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agent_id: "agent-1",
      server_id: "server-1",
      machine_id: "machine-1",
      launch_id: "launch-1",
      start_dispatch_id: "dispatch-1",
      process_instance_id: "process-1",
      session_id_present: true,
      runtime: "codex",
      runtime_version: "1.2.3",
      error_class: "Error",
      model: "private-model",
      session_id: "private-session",
      pid: 1234,
      error: "Bearer sk-private https://provider.example/private",
    },
  });
  span.end("error");

  const [recorded] = sink.getTrace(traceId);
  assert.equal(recorded.attrs?.agent_id, "agent-1");
  assert.equal(recorded.attrs?.server_id, "server-1");
  assert.equal(recorded.attrs?.machine_id, "machine-1");
  assert.equal(recorded.attrs?.launch_id, "launch-1");
  assert.equal(recorded.attrs?.start_dispatch_id, "dispatch-1");
  assert.equal(recorded.attrs?.process_instance_id, "process-1");
  assert.equal(recorded.attrs?.runtime, "codex");
  assert.equal(recorded.attrs?.runtime_version, "1.2.3");
  assert.equal(recorded.attrs?.error_class, "Error");
  assert.equal(recorded.attrs?.model, undefined);
  assert.equal(recorded.attrs?.session_id, undefined);
  assert.equal(recorded.attrs?.pid, undefined);
  assert.equal(recorded.attrs?.error, undefined);
});

test("daemon runtime-progress suppression trace contract preserves only idle-fence evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.runtime.progress.activity.suppressed", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "grok",
      outcome: "apm_idle",
      source: "grok_acp_notification",
      itemType: "_x.ai/queue/changed",
      payloadBytes: 42,
      raw_payload: "secret",
    },
  });
  span.end("ok");

  const [recorded] = sink.getTrace(traceId);
  assert.equal(recorded.attrs?.agentId, "agent-1");
  assert.equal(recorded.attrs?.launchId, "launch-1");
  assert.equal(recorded.attrs?.runtime, "grok");
  assert.equal(recorded.attrs?.outcome, "apm_idle");
  assert.equal(recorded.attrs?.source, "grok_acp_notification");
  assert.equal(recorded.attrs?.itemType, "_x.ai/queue/changed");
  assert.equal(recorded.attrs?.payloadBytes, 42);
  assert.equal(recorded.attrs?.raw_payload, undefined);
});

test("daemon Pi provider failure trace contract keeps only the closed-set diagnostic", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.pi.prompt", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "builtin",
    },
  });
  span.addEvent("daemon.pi.provider_request.failed", {
    phase: "prompt_request",
    response_started: true,
    reason: "provider_auth_denied",
    http_status: 403,
    session_id_present: true,
    runtime_session_id: "session-1",
    launch_id_present: true,
    launch_id: "launch-1",
    body: "unsafe response body",
    headers: { authorization: "Bearer sk-unsafe-header" },
    token: "sk-unsafe-token",
    url: "https://gateway.example/private",
    payload: { prompt: "unsafe prompt" },
  });
  span.end("error");

  const [failure] = eventsForSpan(sink, traceId, "daemon.pi.prompt")
    .filter((event) => event.name === "daemon.pi.provider_request.failed");
  assert.equal(failure?.attrs?.phase, "prompt_request");
  assert.equal(failure?.attrs?.response_started, true);
  assert.equal(failure?.attrs?.reason, "provider_auth_denied");
  assert.equal(failure?.attrs?.http_status, 403);
  assert.equal(failure?.attrs?.runtime_session_id, "session-1");
  assert.equal(failure?.attrs?.launch_id, "launch-1");
  assert.equal(failure?.attrs?.body, undefined);
  assert.equal(failure?.attrs?.headers, undefined);
  assert.equal(failure?.attrs?.token, undefined);
  assert.equal(failure?.attrs?.url, undefined);
  assert.equal(failure?.attrs?.payload, undefined);
});

test("daemon Built-in session trace contract keeps isolation evidence and drops raw secret/path attrs", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });

  const span = scopedTracer.startSpan("daemon.builtin.session.create", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      agentId: "agent-1",
      launchId: "launch-1",
      runtime: "builtin",
      model: "openai/gpt-custom",
      session_id_present: true,
      requested_model: "openai/gpt-custom",
      config_source: "agent_config",
      host_user_state: "forbidden",
      provider_id: "openai-compatible",
      model_kind: "custom",
      base_url_present: true,
      base_url_host_class: "public",
      provider_key_present: true,
      provider_key_source: "runtime_config_plaintext",
      provider_env_key: "OPENAI_API_KEY",
      base_url_env_key: "OPENAI_BASE_URL",
      base_url_value: "https://gateway.example.test/v1",
      api_key_value: "sk-openai-test",
      raw_provider_payload: { apiKey: "sk-ds-test" },
      agent_dir_path: "/Users/local/.pi",
    },
  });
  span.addEvent("daemon.builtin.session.services_ready", {
    available_models_count: 1,
    diagnostics_count: 0,
    diagnostic_info_count: 0,
    diagnostic_warning_count: 0,
    agent_dir_source: "managed_builtin",
    config_source: "agent_config",
    host_user_state: "forbidden",
    provider_id: "openai-compatible",
    model_kind: "custom",
    base_url_present: true,
    base_url_host_class: "public",
    provider_key_present: true,
    provider_key_source: "runtime_config_plaintext",
    provider_env_key: "OPENAI_API_KEY",
    base_url_env_key: "OPENAI_BASE_URL",
    base_url_value: "https://gateway.example.test/v1",
    api_key_value: "sk-openai-test",
    raw_provider_payload: { apiKey: "sk-ds-test" },
    agent_dir_path: "/Users/local/.pi",
  });
  span.end("ok", {
    attrs: {
      outcome: "started",
      available_models_count: 1,
      diagnostics_count: 0,
      diagnostic_info_count: 0,
      diagnostic_warning_count: 0,
      requested_model: "openai/gpt-custom",
      resolved_model: "openai/gpt-custom",
      resolved_model_present: true,
      config_source: "agent_config",
      host_user_state: "forbidden",
      provider_id: "openai-compatible",
      model_kind: "custom",
      base_url_present: true,
      base_url_host_class: "public",
      provider_key_present: true,
      provider_key_source: "runtime_config_plaintext",
      provider_env_key: "OPENAI_API_KEY",
      base_url_env_key: "OPENAI_BASE_URL",
      base_url_value: "https://gateway.example.test/v1",
      api_key_value: "sk-openai-test",
      raw_provider_payload: { apiKey: "sk-ds-test" },
      agent_dir_path: "/Users/local/.pi",
    },
  });

  const recorded = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.builtin.session.create");
  assert.ok(recorded);
  assert.equal(recorded.attrs?.config_source, "agent_config");
  assert.equal(recorded.attrs?.host_user_state, "forbidden");
  assert.equal(recorded.attrs?.provider_id, "openai-compatible");
  assert.equal(recorded.attrs?.model_kind, "custom");
  assert.equal(recorded.attrs?.model_id, undefined);
  assert.equal(recorded.attrs?.base_url_present, true);
  assert.equal(recorded.attrs?.base_url_host_class, "public");
  assert.equal(recorded.attrs?.provider_key_present, true);
  assert.equal(recorded.attrs?.provider_key_source, "runtime_config_plaintext");
  assert.equal(recorded.attrs?.provider_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_value, undefined);
  assert.equal(recorded.attrs?.api_key_value, undefined);
  assert.equal(recorded.attrs?.raw_provider_payload, undefined);
  assert.equal(recorded.attrs?.agent_dir_path, undefined);

  const servicesReady = eventsForSpan(sink, traceId, "daemon.builtin.session.create")
    .find((event) => event.name === "daemon.builtin.session.services_ready");
  assert.equal(servicesReady?.attrs?.agent_dir_source, "managed_builtin");
  assert.equal(servicesReady?.attrs?.config_source, "agent_config");
  assert.equal(servicesReady?.attrs?.host_user_state, "forbidden");
  assert.equal(servicesReady?.attrs?.provider_id, "openai-compatible");
  assert.equal(servicesReady?.attrs?.model_kind, "custom");
  assert.equal(servicesReady?.attrs?.model_id, undefined);
  assert.equal(servicesReady?.attrs?.base_url_present, true);
  assert.equal(servicesReady?.attrs?.base_url_host_class, "public");
  assert.equal(servicesReady?.attrs?.provider_key_present, true);
  assert.equal(servicesReady?.attrs?.provider_key_source, "runtime_config_plaintext");
  assert.equal(servicesReady?.attrs?.provider_env_key, undefined);
  assert.equal(servicesReady?.attrs?.base_url_env_key, undefined);
  assert.equal(servicesReady?.attrs?.base_url_value, undefined);
  assert.equal(servicesReady?.attrs?.api_key_value, undefined);
  assert.equal(servicesReady?.attrs?.raw_provider_payload, undefined);
  assert.equal(servicesReady?.attrs?.agent_dir_path, undefined);

  assert.equal(recorded.status, "ok");
  assert.equal(recorded.attrs?.outcome, "started");
  assert.equal(recorded.attrs?.resolved_model, "openai/gpt-custom");
  assert.equal(recorded.attrs?.provider_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_env_key, undefined);
  assert.equal(recorded.attrs?.base_url_value, undefined);
  assert.equal(recorded.attrs?.api_key_value, undefined);
  assert.equal(recorded.attrs?.raw_provider_payload, undefined);
  assert.equal(recorded.attrs?.agent_dir_path, undefined);
});

test("daemon object-store trace contract keeps closed diagnostics and drops secret, URL, and path attrs", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });

  const span = scopedTracer.startSpan("daemon.migration_transport.object_store", {
    surface: "daemon",
    kind: "internal",
    attrs: {
      outcome: "failed",
      role: "source",
      transfer_kind: "upload",
      migration_ref: "mig_AAAAAAAAAAAAAAAAAAAAAA",
      stage: "upload_complete",
      operation: "chunk_upload",
      agent_id_present: true,
      migration_id_present: true,
      session_id_present: true,
      error_class: "MigrationObjectStoreUploadHttpError",
      error_code: "MIGRATION_UPLOAD_COMPLETE_FAILED",
      upstream_error_code: "migration_chunks_missing",
      endpoint_class: "object_store",
      http_status: 503,
      content_length_present: true,
      upload_body_mode: "spooled_file",
      bundle_size_bucket: "lt_1_mib",
      bundle_content_bytes: 128,
      max_bytes: 104857600,
      manifest_sha_present: true,
      attempt: 2,
      status: 503,
      retry_delay_ms: 50,
      url: "https://object-store.example.test/bundle?X-Amz-Signature=secret",
      signed_url: "https://object-store.example.test/bundle?token=secret",
      bearer_token: "raft-secret-token",
      spool_path: "/tmp/raft-agent-migration-upload-secret/bundle.tar.gz",
      raw_response_body: "Migration chunks missing for private workspace /Users/alice",
      unknown_scalar: "must-not-survive",
    },
  });
  span.end("error");

  const recorded = sink.getTrace(traceId).find((candidate) =>
    candidate.name === "daemon.migration_transport.object_store"
  );
  assert.ok(recorded);
  assert.equal(recorded.attrs?.outcome, "failed");
  assert.equal(recorded.attrs?.role, "source");
  assert.equal(recorded.attrs?.transfer_kind, "upload");
  assert.equal(recorded.attrs?.migration_ref, "mig_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(recorded.attrs?.stage, "upload_complete");
  assert.equal(recorded.attrs?.operation, "chunk_upload");
  assert.equal(recorded.attrs?.migration_id_present, true);
  assert.equal(recorded.attrs?.error_class, "MigrationObjectStoreUploadHttpError");
  assert.equal(recorded.attrs?.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(recorded.attrs?.upstream_error_code, "migration_chunks_missing");
  assert.equal(recorded.attrs?.endpoint_class, "object_store");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.content_length_present, true);
  assert.equal(recorded.attrs?.upload_body_mode, "spooled_file");
  assert.equal(recorded.attrs?.bundle_size_bucket, "lt_1_mib");
  assert.equal(recorded.attrs?.bundle_content_bytes, 128);
  assert.equal(recorded.attrs?.max_bytes, 104857600);
  assert.equal(recorded.attrs?.manifest_sha_present, true);
  assert.equal(recorded.attrs?.attempt, 2);
  assert.equal(recorded.attrs?.status, 503);
  assert.equal(recorded.attrs?.retry_delay_ms, 50);
  assert.equal(recorded.attrs?.url, undefined);
  assert.equal(recorded.attrs?.signed_url, undefined);
  assert.equal(recorded.attrs?.bearer_token, undefined);
  assert.equal(recorded.attrs?.spool_path, undefined);
  assert.equal(recorded.attrs?.raw_response_body, undefined);
  assert.equal(recorded.attrs?.unknown_scalar, undefined);
});

async function captureUploadCompleteConflictTrace(responseBody: {
  code: string;
  error: string;
}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-upload-complete-trace-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-upload-complete-trace";
  const migrationRef = "mig_TRACEUPLOADCOMPLETEAAA";
  const transportGeneration = "transport-generation-upload-complete-trace";
  const leaseId = "lease-upload-complete-trace";
  const transportLostReports: Array<Record<string, unknown>> = [];
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-quiesced`
    ) {
      await readRequestBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/control`
    ) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        control: Parameters<typeof validateAgentMigrationControlManifest>[0];
      };
      const validated = validateAgentMigrationControlManifest(body.control);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ controlSha256: validated.sha256 }));
      return;
    }
    if (
      req.method === "GET"
      && req.url?.startsWith(`/internal/computer/agent-migrations/by-id/${migrationId}/resumable/chunks?`)
    ) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        complete: true,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: [],
      }));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/upload-complete`
    ) {
      await readRequestBody(req);
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
      return;
    }
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`
    ) {
      transportLostReports.push(
        JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.join(dataDir, "agent-upload-complete-trace"), { recursive: true });
    await writeFile(
      path.join(dataDir, "agent-upload-complete-trace", "notes.md"),
      "trace correlation sentinel\n",
    );
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-upload-complete-trace",
      migrationId,
      migrationRef,
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-upload-complete-trace",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/object-store-bundle-unused`,
      bearerToken: "source-token-must-not-enter-trace",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-upload-complete-trace",
      targetMachineId: "target-machine-upload-complete-trace",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => transportLostReports.length === 1, "typed upload-complete transport-loss report");
    await waitFor(
      () => {
        const spans = sink.getTrace(traceId);
        return spans.some((span) =>
          span.name === "daemon.migration_transport.object_store"
          && span.attrs?.outcome === "failed"
          && span.attrs?.stage === "upload_complete"
        ) && spans.some((span) =>
          span.name === "daemon.migration_transport.object_store"
          && span.attrs?.outcome === "transport_lost_reported"
        );
      },
      "correlated upload-complete failure trace spans",
    );
    const failedSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "failed"
      && span.attrs?.stage === "upload_complete"
    );
    assert.ok(failedSpan, "upload-complete conflict must emit a correlated failed span");
    assert.equal(failedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(failedSpan.attrs?.role, "source");
    assert.equal(failedSpan.attrs?.transfer_kind, "upload");
    assert.equal(failedSpan.attrs?.http_status, 409);

    const reportedSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "transport_lost_reported"
    );
    assert.ok(reportedSpan);
    assert.equal(reportedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(reportedSpan.attrs?.role, "source");
    assert.equal(reportedSpan.attrs?.stage, "transport_lost_report");
    assert.equal(reportedSpan.attrs?.upstream_error_code, undefined);
    const traceFamilyAttrs = sink.getTrace(traceId)
      .filter((span) => span.name.startsWith("daemon.migration_transport."))
      .map((span) => span.attrs ?? {});
    return {
      failedAttrs: failedSpan.attrs ?? {},
      transportLostReport: transportLostReports[0] ?? {},
      traceFamilyAttrs,
    };
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("DaemonCore traces an upload-complete conflict with a safe exact join and typed stage", async () => {
  const hostileValues = [
    "token=sk_live_trace_secret",
    "https://evil.example/trace-secret",
    "/Users/alice/private-workspace",
  ];
  const { failedAttrs, transportLostReport, traceFamilyAttrs } = await captureUploadCompleteConflictTrace({
    code: "not_a_migration_code",
    error: hostileValues.join(" "),
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(failedAttrs.upstream_error_code, "http_409");
  assert.equal(traceFamilyAttrs.length, 3, "lease, failure, and loss-report spans must all be covered");
  for (const attrs of traceFamilyAttrs) {
    assert.equal(attrs.migration_ref, "mig_TRACEUPLOADCOMPLETEAAA");
    assert.equal(attrs.role, "source");
  }
  const serializedDiagnostics = JSON.stringify({ traceFamilyAttrs, transportLostReport });
  for (const hostileValue of hostileValues) {
    assert.equal(
      serializedDiagnostics.includes(hostileValue),
      false,
      `failed diagnostics must not contain hostile value ${hostileValue}`,
    );
  }
});

test("DaemonCore preserves exact lowercase and uppercase typed migration response codes", async () => {
  for (const upstreamCode of ["migration_chunks_missing", "MIGRATION_LEASE_EXPIRED"]) {
    const { failedAttrs } = await captureUploadCompleteConflictTrace({
      code: upstreamCode,
      error: "this branch must not replace a typed code",
    });

    assert.equal(failedAttrs.upstream_error_code, upstreamCode);
    assert.equal(failedAttrs.http_status, 409);
    assert.notEqual(failedAttrs.upstream_error_code, "http_409");
  }
});

test("DaemonCore preserves the exact transfer-summary conflict in the typed failure trace", async () => {
  const { failedAttrs } = await captureUploadCompleteConflictTrace({
    code: "MIGRATION_TRANSFER_SUMMARY_CONFLICT",
    error: "transfer summary does not match the control manifest",
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_TRANSFER_SUMMARY_CONFLICT");
  assert.equal(failedAttrs.upstream_error_code, "MIGRATION_TRANSFER_SUMMARY_CONFLICT");
  assert.equal(failedAttrs.http_status, 409);
});

test("DaemonCore keeps the resumable typed failure projection closed", async () => {
  const { failedAttrs } = await captureUploadCompleteConflictTrace({
    code: "MIGRATION_PRIVATE_DRIVER_FAILURE",
    error: "private implementation detail must remain outside the typed projection",
  });

  assert.equal(failedAttrs.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(failedAttrs.upstream_error_code, "MIGRATION_PRIVATE_DRIVER_FAILURE");
  assert.equal(failedAttrs.http_status, 409);
});

test("DaemonCore keeps migration ref and role exact when one Computer switches from source A to target B", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-trace-role-switch-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sockets: FakeWebSocket[] = [];
  const transportLostUrls: string[] = [];
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/transport-lost")) {
      await readRequestBody(req);
      transportLostUrls.push(req.url);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 400;
    res.end("invalid test transfer");
  });
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-role-switch",
      migrationId: "migration-a",
      migrationRef: "mig_SOURCEAAAAAAAAAAAAAAAA",
      migrationGeneration: "agent_migration:migration-a:1",
      sessionId: "session-a",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/migration-a`,
      bearerToken: "source-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });
    await waitFor(
      () => sink.getTrace(traceId).filter((span) =>
        span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied"
      ).length === 1,
      "source A lease trace",
    );

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-role-switch",
      migrationId: "migration-b",
      migrationRef: "mig_TARGETBBBBBBBBBBBBBBBB",
      migrationGeneration: "agent_migration:migration-b:1",
      sessionId: "session-b",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      url: `${transferServer.baseUrl}/migration-b`,
      bearerToken: "target-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });
    await waitFor(
      () => sink.getTrace(traceId).filter((span) =>
        span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied"
      ).length === 2,
      "target B lease trace",
    );
    await waitFor(
      () => transportLostUrls.some((url) => url.includes("/by-id/migration-b/transport-lost")),
      "target B transport-loss completion",
    );

    const appliedLeaseTuples = sink.getTrace(traceId)
      .filter((span) => span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied")
      .map((span) => ({
        migrationRef: span.attrs?.migration_ref,
        role: span.attrs?.role,
        transferKind: span.attrs?.transfer_kind,
      }));
    assert.deepEqual(appliedLeaseTuples, [
      {
        migrationRef: "mig_SOURCEAAAAAAAAAAAAAAAA",
        role: "source",
        transferKind: "upload",
      },
      {
        migrationRef: "mig_TARGETBBBBBBBBBBBBBBBB",
        role: "target",
        transferKind: "download",
      },
    ]);
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("resolveRaftCliPath prefers bundled dist cli when present", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cli-path-test-"));

  try {
    const daemonDistDir = path.join(tmp, "packages", "daemon", "dist");
    const bundledCliPath = path.join(daemonDistDir, "cli", "index.js");
    await mkdir(path.dirname(bundledCliPath), { recursive: true });
    await writeFile(bundledCliPath, "export {};\n", "utf8");

    const moduleUrl = new URL(`file://${path.join(daemonDistDir, "core.js")}`).href;
    assert.equal(resolveRaftCliPath(moduleUrl), bundledCliPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectRuntimes treats driver probe unavailable as authoritative", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-detect-test-"));
  const binDir = path.join(tmp, "bin");
  const oldPath = process.env.PATH;
  const { sink, tracer, traceId } = makeDeterministicTracer();

  try {
    await mkdir(binDir, { recursive: true });
    const opencodeBin = path.join(binDir, "opencode");
    await writeFile(opencodeBin, "#!/bin/sh\necho '1.14.20'\n", "utf8");
    await chmod(opencodeBin, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    const detection = detectRuntimes(tracer);

    assert.equal(detection.ids.includes("opencode"), false);
    assert.match(detection.versions.opencode ?? "", /requires >= 1\.14\.30/);
    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.detect");
    assert.equal(span?.attrs?.known_runtime_count, 12);
    assert.equal(span?.attrs?.detected_runtime_count, detection.ids.length);
    const opencodeEvent = eventsForSpan(sink, traceId, "daemon.runtime.detect")
      .find((event) => event.attrs?.runtime === "opencode");
    assert.equal(opencodeEvent?.attrs?.outcome, "unavailable");
    assert.equal(opencodeEvent?.attrs?.version_present, true);
    assert.equal(opencodeEvent?.attrs?.binary_path_present, false);
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test("DaemonCore scopes daemon traces with daemon and computer versions", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-trace-scope-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const oldComputerVersion = process.env.RAFT_COMPUTER_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_COMPUTER_VERSION = "77.7.7-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      daemonVersion: "0.55.6",
      computerVersion: "0.0.23",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const readySpan = sink.getTrace(traceId).find((span) => span.name === "daemon.ready.sent");
    assert.ok(readySpan);
    assert.equal(readySpan.attrs?.daemon_version, "0.55.6");
    assert.equal(readySpan.attrs?.daemon_version_present, true);
    assert.equal(readySpan.attrs?.computer_version, "0.0.23");
    assert.equal(readySpan.attrs?.computer_version_present, true);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    if (oldComputerVersion === undefined) {
      delete process.env.RAFT_COMPUTER_VERSION;
    } else {
      process.env.RAFT_COMPUTER_VERSION = oldComputerVersion;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore sends a machine shutdown notice before disconnecting", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-shutdown-notice-test-"));
  const sockets: FakeWebSocket[] = [];
  const oldComputerVersion = process.env.RAFT_COMPUTER_VERSION;
  let core: DaemonCore | null = null;

  try {
    process.env.RAFT_COMPUTER_VERSION = "77.7.7-env-must-not-win";
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      computerVersion: "0.0.23",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    await core.stop();
    core = null;

    const shutdownNotice = socket.sent.find((message) =>
      typeof message === "object"
      && message !== null
      && (message as { type?: unknown }).type === "machine:shutdown"
    ) as { type: "machine:shutdown"; reason: string } | undefined;
    assert.deepEqual(shutdownNotice, { type: "machine:shutdown", reason: "computer_stop" });
    assert.equal(socket.readyState, 3);
  } finally {
    if (core) await core.stop();
    if (oldComputerVersion === undefined) {
      delete process.env.RAFT_COMPUTER_VERSION;
    } else {
      process.env.RAFT_COMPUTER_VERSION = oldComputerVersion;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore replays durable lifecycle acknowledgements and receipts phases independently", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-ack-test-"));
  const sockets: FakeWebSocket[] = [];
  const receipts: Array<{ operationId: string; phase: string }> = [];
  let resolveReceipt!: () => void;
  const receiptObserved = new Promise<void>((resolve) => { resolveReceipt = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => [
        { operationId: "11111111-1111-4111-8111-111111111111", action: "restart", phase: "shutdown" },
        { operationId: "11111111-1111-4111-8111-111111111111", action: "restart", phase: "ready", loadedComputerVersion: "0.72.6" },
      ],
      onComputerLifecycleReceipt: (operationId, phase) => {
        receipts.push({ operationId, phase });
        resolveReceipt();
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as {
      lifecycleAcks?: unknown[];
    };
    assert.equal(ready.lifecycleAcks?.length, 2);

    socket.emitServerMessage({
      type: "computer:lifecycle:receipt",
      operationId: "11111111-1111-4111-8111-111111111111",
      phase: "ready",
    });
    await receiptObserved;
    assert.deepEqual(receipts, [{
      operationId: "11111111-1111-4111-8111-111111111111",
      phase: "ready",
    }]);

    await core.stop();
    core = null;
    const shutdown = socket.sent.find((message) => (message as { type?: string }).type === "machine:shutdown") as {
      lifecycleAcks?: Array<{ phase: string }>;
    };
    assert.deepEqual(shutdown.lifecycleAcks?.map((ack) => ack.phase), ["shutdown"]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore awaits fresh ready attestation instead of emitting cached lifecycle evidence", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-fresh-ready-ack-test-"));
  const sockets: FakeWebSocket[] = [];
  let releaseAttestation!: (acks: ComputerLifecycleExecutionAck[]) => void;
  const attested = new Promise<ComputerLifecycleExecutionAck[]>((resolve) => { releaseAttestation = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => [{
        operationId: "11111111-1111-4111-8111-111111111111",
        action: "upgrade",
        phase: "ready",
        loadedComputerVersion: "stale",
      }],
      getComputerLifecycleReadyAcks: () => attested,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    assert.equal(socket.sent.some((message) => (message as { type?: string }).type === "ready"), false);

    releaseAttestation([{
      operationId: "11111111-1111-4111-8111-111111111111",
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: "0.72.9",
      serviceGeneration: "fresh-generation",
      managedSetRevision: "fresh-revision",
      oldProcessIdentitiesDead: true,
      deadProcessIdentities: ["service:old"],
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as {
      lifecycleAcks?: Array<{ loadedComputerVersion?: string; serviceGeneration?: string }>;
    };
    assert.deepEqual(ready.lifecycleAcks, [{
      operationId: "11111111-1111-4111-8111-111111111111",
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: "0.72.9",
      serviceGeneration: "fresh-generation",
      managedSetRevision: "fresh-revision",
      oldProcessIdentitiesDead: true,
      deadProcessIdentities: ["service:old"],
    }]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore establishes online before legacy adoption and replays ready with the new exact acknowledgements", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-adoption-test-"));
  const sockets: FakeWebSocket[] = [];
  const operationId = "11111111-1111-4111-8111-111111111111";
  let lifecycleAcks: ComputerLifecycleExecutionAck[] = [];
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => lifecycleAcks,
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        const readyBeforeAdoption = sockets[0]!.sent.filter((message) =>
          (message as { type?: string }).type === "ready"
        );
        assert.equal(readyBeforeAdoption.length, 1, "ordinary ready must establish online first");
        assert.deepEqual(
          (readyBeforeAdoption[0] as { lifecycleAcks?: unknown[] }).lifecycleAcks,
          [],
          "the first ready must not fabricate the legacy receipt",
        );
        lifecycleAcks = [
          { operationId, action: "upgrade", phase: "shutdown" },
          {
            operationId,
            action: "upgrade",
            phase: "ready",
            loadedComputerVersion: "1.0.17",
            serviceGeneration: "generation-new",
            managedSetRevision: "revision-new",
            oldProcessIdentitiesDead: true,
            deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
          },
        ];
        return true;
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await waitFor(
      () => sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length === 2,
      "post-adoption ready replay",
    );
    const ready = sockets[0]!.sent.filter((message) =>
      (message as { type?: string }).type === "ready"
    ) as Array<{ lifecycleAcks?: ComputerLifecycleExecutionAck[] }>;
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(ready[1]?.lifecycleAcks, lifecycleAcks);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries one exact legacy adoption after ready visibility and replays the accepted acknowledgements", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-retry-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationId = "11111111-1111-4111-8111-111111111111";
  let lifecycleAcks: ComputerLifecycleExecutionAck[] = [];
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => lifecycleAcks,
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          return {
            status: "retryable_ready_pending",
            operationId,
            code: "computer_lifecycle_completion_ready_pending",
          };
        }
        lifecycleAcks = [
          { operationId, action: "upgrade", phase: "shutdown" },
          {
            operationId,
            action: "upgrade",
            phase: "ready",
            loadedComputerVersion: "1.0.17",
            serviceGeneration: "generation-new",
            managedSetRevision: "revision-new",
            oldProcessIdentitiesDead: true,
            deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
          },
        ];
        return { status: "adopted", operationId };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);

    clock.advanceBy(50);
    await waitFor(() => reconcileCalls === 2, "same-epoch lifecycle-origin retry");
    await waitFor(
      () => sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length === 2,
      "post-retry adoption ready replay",
    );
    const ready = sockets[0]!.sent.filter((message) =>
      (message as { type?: string }).type === "ready"
    ) as Array<{ lifecycleAcks?: ComputerLifecycleExecutionAck[] }>;
    assert.deepEqual(ready[1]?.lifecycleAcks, lifecycleAcks);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore stops a ready-pending legacy adoption when the exact operation identity drifts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-identity-drift-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationIdA = "11111111-1111-4111-8111-111111111111";
  const operationIdB = "22222222-2222-4222-8222-222222222222";
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleReadyAcks: async () => [
        { operationId: operationIdB, action: "upgrade", phase: "shutdown" },
        {
          operationId: operationIdB,
          action: "upgrade",
          phase: "ready",
          loadedComputerVersion: "1.0.17",
          serviceGeneration: "generation-new",
          managedSetRevision: "revision-new",
          oldProcessIdentitiesDead: true,
          deadProcessIdentities: ["service:5500", "runner:server-test:5555"],
        },
      ],
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          return {
            status: "retryable_ready_pending",
            operationId: operationIdA,
            code: "computer_lifecycle_completion_ready_pending",
          };
        }
        return { status: "adopted", operationId: operationIdB };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);

    clock.advanceBy(50);
    await waitFor(() => reconcileCalls === 2, "operation-identity drift retry");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length,
      1,
      "an adopted result for a different K operation must not emit a second ready/ack",
    );

    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 2, "operation identity drift must terminally stop the retry chain");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore bounds persistent ready-pending legacy adoption at three exact attempts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-bound-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  const operationId = "11111111-1111-4111-8111-111111111111";
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return { status: "retryable_ready_pending", operationId, code: "computer_offline" };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      clock.advanceBy(50);
      await waitFor(() => reconcileCalls === attempt, `legacy adoption attempt ${attempt}`);
    }
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 3);
    assert.equal(sockets[0]!.sent.filter((message) => (message as { type?: string }).type === "ready").length, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore cancels a ready-pending legacy adoption retry when its connection generation closes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-disconnect-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return {
          status: "retryable_ready_pending",
          operationId: "11111111-1111-4111-8111-111111111111",
          code: "computer_offline",
        };
      },
      connectionOptions: {
        clock,
        minReconnectDelayMs: 10_000,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
    sockets[0]!.terminate();
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not retry a permanent legacy adoption rejection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lifecycle-origin-permanent-test-"));
  const sockets: FakeWebSocket[] = [];
  const clock = new FakeClock();
  let core: DaemonCore | null = null;
  let reconcileCalls = 0;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      reconcileComputerLifecycleOrigin: async () => {
        reconcileCalls += 1;
        return { status: "not_adopted" };
      },
      connectionOptions: {
        clock,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]!.emitOpen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advanceBy(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore executes mixed-version computer control replay only once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-control-replay-test-"));
  const sockets: FakeWebSocket[] = [];
  const operationId = "22222222-2222-4222-8222-222222222222";
  let durable = false;
  let executions = 0;
  let resolveHandled!: () => void;
  const handled = new Promise<void>((resolve) => { resolveHandled = resolve; });
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLifecycleAcks: () => durable
        ? [{ operationId, action: "restart", phase: "shutdown" }]
        : [],
      onComputerControl: () => {
        executions += 1;
        durable = true;
        resolveHandled();
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({ type: "computer:restart", operationId, requestId: operationId });
    await handled;
    socket.emitServerMessage({ type: "computer:restart", requestId: operationId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executions, 1);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore returns request-scoped closed failures when Computer control is rejected", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-control-rejected-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: async () => {
        throw new Error("CONTROL_BUSY: another machine control is in flight");
      },
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "computer:restart",
      operationId: "33333333-3333-4333-8333-333333333333",
      requestId: "33333333-3333-4333-8333-333333333333",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      socket.sent.find((message) =>
        (message as { type?: string }).type === "computer:restart:done"
      ),
      {
        type: "computer:restart:done",
        requestId: "33333333-3333-4333-8333-333333333333",
        ok: false,
        error: "control_busy",
      },
    );
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore ready reports migration transport as not provisioned when no transport is configured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-ready-none-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.ok(ready, "daemon should send ready on connect");
    assert.deepEqual(ready.migrationTransport, {
      provisioned: false,
      endpoint: null,
      leaseSource: null,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [
        ...AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
        AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
      ],
      observedAt: ready.migrationTransport?.observedAt,
    });
    assert.match(ready.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore archives a completed migration source workspace and returns an idempotent receipt", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-archive-test-"));
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-archive");
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "archive-from-core\n");
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      slockHome,
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration:source_workspace_archive",
      requestId: "11111111-1111-4111-8111-111111111112",
      migrationId: "migration-archive",
      agentId: "agent-archive",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "11111111-1111-4111-8111-111111111112"
        && (message as { outcome?: string }).outcome === "archived"),
      "migration source workspace archive receipt",
    );

    const archive = path.join(
      slockHome,
      AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
      "agent-archive",
      "migration-archive",
    );
    assert.equal(await readFile(path.join(archive, "MEMORY.md"), "utf8"), "archive-from-core\n");
    await assert.rejects(readFile(path.join(source, "MEMORY.md")), { code: "ENOENT" });

    socket.emitServerMessage({
      type: "machine:migration:source_workspace_archive",
      requestId: "22222222-2222-4222-8222-222222222223",
      migrationId: "migration-archive",
      agentId: "agent-archive",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "22222222-2222-4222-8222-222222222223"
        && (message as { outcome?: string }).outcome === "already_archived"),
      "idempotent migration source workspace archive receipt",
    );

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(slockHome, { recursive: true, force: true });
  }
});

test("DaemonCore starts configured agent migration HTTP transport and stops it with daemon lifecycle", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-test-"));
  const lifecycle: string[] = [];
  const sockets: FakeWebSocket[] = [];
  const migrationTransport: AgentMigrationHttpTransport = {
    grants: {} as AgentMigrationHttpTransport["grants"],
    server: {} as AgentMigrationHttpTransport["server"],
    listen: async () => {
      lifecycle.push("listen");
      return { url: "http://source:4101" };
    },
    close: async () => {
      lifecycle.push("close");
    },
  };
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    await waitFor(() => lifecycle.includes("listen"), "migration transport listen");
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(ready?.migrationTransport?.provisioned, true);
    assert.equal(ready?.migrationTransport?.endpoint, "http://source:4101");
    assert.equal(ready?.migrationTransport?.leaseSource, "env");
    assert.match(ready?.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    await core.stop();
    core = null;

    assert.deepEqual(lifecycle, ["listen", "close"]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore applies object-store migration transfer lease and re-emits provider-neutral ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-server-lease-test-"));
  const lifecycle: string[] = [];
  const sockets: FakeWebSocket[] = [];
  let uploadReceived = false;
  let sourceReadyReceived = false;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "PUT" && req.url === "/migrations/lease-1") {
      await readRequestBody(req);
      uploadReceived = true;
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-1/source-ready") {
      sourceReadyReceived = true;
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { manifestSha256?: unknown };
      assert.equal(typeof body.manifestSha256, "string");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, migration: { id: "migration-1", state: "ready" } }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const migrationTransport: AgentMigrationHttpTransport = {
    grants: {} as AgentMigrationHttpTransport["grants"],
    server: {} as AgentMigrationHttpTransport["server"],
    listen: async () => {
      lifecycle.push("listen:env");
      return { url: "http://source:4101" };
    },
    close: async () => {
      lifecycle.push("close");
    },
  };
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    await waitFor(() => lifecycle.includes("listen:env"), "initial env migration transport listen");
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
      migrationGeneration: "agent_migration:migration-1:3",
      sessionId: "session-1",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/migrations/lease-1`,
      bearerToken: "lease-token-1",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });

    const readyMessages = () => socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    await waitFor(
      () => readyMessages().some((msg) => msg.migrationTransport?.leaseSource === "server"),
      "server migration transport ready",
    );

    const serverReady = readyMessages().find((msg) => msg.migrationTransport?.leaseSource === "server");
    assert.equal(serverReady?.migrationTransport?.provisioned, true);
    assert.equal(serverReady?.migrationTransport?.endpoint, `${transferServer.baseUrl}/migrations/lease-1`);
    assert.equal(serverReady?.migrationTransport?.url, `${transferServer.baseUrl}/migrations/lease-1`);
    assert.equal(serverReady?.migrationTransport?.provider, "object_store");
    assert.equal(serverReady?.migrationTransport?.role, "source");
    assert.equal(serverReady?.migrationTransport?.transferKind, "upload");
    assert.equal(serverReady?.migrationTransport?.expiresAt, "2999-07-09T13:00:00.000Z");
    assert.equal(serverReady?.migrationTransport?.maxBytes, 104857600);
    assert.equal("token" in (serverReady?.migrationTransport ?? {}), false);
    assert.equal("bearerToken" in (serverReady?.migrationTransport ?? {}), false);
    assert.match(serverReady?.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(lifecycle, ["listen:env"]);
    await waitFor(() => uploadReceived, "object-store upload after ready");
    await waitFor(() => sourceReadyReceived, "object-store source ready callback");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore uploads source object-store migration bundle to the leased URL", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-put-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const sockets: FakeWebSocket[] = [];
  const uploads: Array<{
    body: Buffer;
    token: string | null;
    contentType: string | null;
    contentLength: string | null;
    transferEncoding: string | null;
  }> = [];
  const sourceReadyReports: Array<Record<string, unknown>> = [];
  const transportLostReports: Array<Record<string, unknown>> = [];
  const spoolNamesBefore = await migrationUploadSpoolNames();
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "PUT" && req.url === "/bundle") {
      const contentLength = req.headers["content-length"]?.toString() ?? null;
      if (!contentLength) {
        res.statusCode = 411;
        res.end("length required");
        return;
      }
      const body = await readRequestBody(req);
      uploads.push({
        body,
        token: req.headers["x-raft-migration-token"]?.toString() ?? null,
        contentType: req.headers["content-type"]?.toString() ?? null,
        contentLength,
        transferEncoding: req.headers["transfer-encoding"]?.toString() ?? null,
      });
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    if (req.method === "PUT" && req.url === "/bundle-reject") {
      if (!req.headers["content-length"]) {
        res.statusCode = 411;
        res.end("length required");
        return;
      }
      await readRequestBody(req);
      res.statusCode = 503;
      res.end("unavailable");
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-source/source-ready") {
      sourceReadyReports.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, migration: { id: "migration-source", state: "ready" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-reject/transport-lost") {
      transportLostReports.push(
        JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, migration: { id: "migration-reject", state: "failed" } }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    const compressedLimitBytes = 64 * 1024;
    await mkdir(path.join(dataDir, "agent-source"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-source", "notes.md"), "hello source\n");
    await writeFile(
      path.join(dataDir, "agent-source", "compressible.bin"),
      Buffer.alloc(1024 * 1024, 0x5a),
    );
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-source",
      migrationId: "migration-source",
      migrationRef: "mig_BBBBBBBBBBBBBBBBBBBBBB",
      migrationGeneration: "agent_migration:migration-source:3",
      sessionId: "session-source",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/bundle`,
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: compressedLimitBytes,
    });

    await waitFor(() => uploads.length === 1, "object-store source upload");
    await waitFor(() => sourceReadyReports.length === 1, "object-store source ready callback");
    const upload = uploads[0]!;
    assert.equal(upload.token, "source-token");
    assert.equal(upload.contentType, AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE);
    assert.equal(Number(upload.contentLength), upload.body.byteLength);
    assert.ok(upload.body.byteLength < compressedLimitBytes);
    assert.equal(upload.transferEncoding, null);
    const staged = await stageAgentMigrationObjectStoreBundle({
      bundle: Readable.from([upload.body]),
      slockHome: dataDir,
      sessionId: "inspect-source-upload",
      maxBytes: compressedLimitBytes,
    });
    assert.equal(staged.manifest.agentId, "agent-source");
    assert.equal(
      await readFile(path.join(staged.stagingWorkspacePath, "notes.md"), "utf8"),
      "hello source\n",
    );
    assert.equal(
      (await stat(path.join(staged.stagingWorkspacePath, "compressible.bin"))).size,
      1024 * 1024,
    );
    assert.equal(sourceReadyReports[0]!.manifestPath, "object-store:session-source/manifest.json");
    assert.equal(typeof sourceReadyReports[0]!.manifestSha256, "string");
    assert.deepEqual(sourceReadyReports[0]!.transferSummary, {
      includedFileCount: 2,
      includedBytes: 1024 * 1024 + Buffer.byteLength("hello source\n"),
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: {
        memoryMdPresent: false,
        notesPresent: false,
      },
    });
    const uploadSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store" && span.attrs?.outcome === "uploaded"
    );
    assert.ok(uploadSpan, "successful upload should emit a closed object-store span");
    assert.equal(uploadSpan.attrs?.endpoint_class, "object_store");
    assert.equal(uploadSpan.attrs?.http_status, 200);
    assert.equal(uploadSpan.attrs?.content_length_present, true);
    assert.equal(uploadSpan.attrs?.upload_body_mode, "spooled_file");
    assert.equal(uploadSpan.attrs?.bundle_size_bucket, "lt_1_mib");
    assert.ok(Number(uploadSpan.attrs?.bundle_content_bytes) > compressedLimitBytes);
    assert.equal(uploadSpan.attrs?.url, undefined);

    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-source",
      migrationId: "migration-reject",
      migrationRef: "mig_CCCCCCCCCCCCCCCCCCCCCC",
      migrationGeneration: "agent_migration:migration-reject:3",
      sessionId: "session-reject",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/bundle-reject`,
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });
    await waitFor(() => transportLostReports.length === 1, "object-store upload rejection report");
    assert.equal(transportLostReports[0]!.message, "MIGRATION_OBJECT_STORE_UPLOAD_FAILED:503");
    const failedUploadSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "failed"
      && span.attrs?.http_status === 503
    );
    assert.ok(failedUploadSpan, "rejected upload should emit closed HTTP diagnostics");
    assert.equal(failedUploadSpan.attrs?.endpoint_class, "object_store");
    assert.equal(failedUploadSpan.attrs?.content_length_present, true);
    assert.equal(failedUploadSpan.attrs?.upload_body_mode, "spooled_file");
    assert.equal(failedUploadSpan.attrs?.bundle_size_bucket, "lt_1_mib");
    assert.equal(failedUploadSpan.attrs?.url, undefined);
    assert.deepEqual(await migrationUploadSpoolNames(), spoolNamesBefore);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore reports a typed compressed-bundle size failure before object-store upload", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-size-test-"));
  const sockets: FakeWebSocket[] = [];
  const transportLostReports: Array<Record<string, unknown>> = [];
  let uploadAttempts = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "PUT" && req.url === "/bundle") {
      uploadAttempts += 1;
      await readRequestBody(req);
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-size/transport-lost") {
      transportLostReports.push(
        JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>,
      );
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, migration: { id: "migration-size", state: "failed" } }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.join(dataDir, "agent-size"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-size", "notes.md"), "hello source\n");
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-size",
      migrationId: "migration-size",
      migrationRef: "mig_DDDDDDDDDDDDDDDDDDDDDD",
      migrationGeneration: "agent_migration:migration-size:3",
      sessionId: "session-size",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/bundle`,
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 4,
    });

    await waitFor(() => transportLostReports.length === 1, "typed size failure report");
    assert.equal(uploadAttempts, 0);
    assert.equal(transportLostReports[0]!.code, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
    assert.match(
      String(transportLostReports[0]!.message),
      /^MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=\d+:maxBytes=4:topEntries=notes\.md,13$/,
    );
    const actualBytes = Number(
      String(transportLostReports[0]!.message).match(/actualBytes=(\d+)/)?.[1],
    );
    assert.ok(actualBytes > 4, "reported bytes must be the observed compressed payload");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries target object-store bundle download until source upload becomes visible", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-target-get-test-"));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-target-source-"));
  const sockets: FakeWebSocket[] = [];
  const callbackPaths: string[] = [];
  const callbackGenerations: string[] = [];
  let downloadToken: string | null = null;
  let downloadAttempts = 0;
  let startTransferAttempts = 0;
  let bundle = new Uint8Array();
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/object-store-bundle") {
      downloadAttempts += 1;
      downloadToken = req.headers["x-raft-migration-token"]?.toString() ?? null;
      if (downloadAttempts === 1) {
        res.statusCode = 404;
        res.end("not yet visible");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE);
      res.end(bundle);
      return;
    }
    if (req.method === "GET" && req.url === "/internal/computer/agent-migrations/by-id/migration-target") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        migration: {
          grantKey: "grant-target",
          migrationRef: "mig_EEEEEEEEEEEEEEEEEEEEEE",
          migrationGeneration: "agent_migration:migration-target:4",
          state: "ready",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
          agentId: "agent-target",
          manifestPath: null,
          manifestSha256: null,
          canDriveTargetImport: true,
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/internal/computer/agent-migrations/grant-target") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        migration: {
          grantKey: "grant-target",
          migrationRef: "mig_EEEEEEEEEEEEEEEEEEEEEE",
          migrationGeneration: "agent_migration:migration-target:5",
          state: "ready",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
          agentId: "agent-target",
          manifestPath: null,
          manifestSha256: null,
          canDriveTargetImport: true,
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/internal/computer/agent-migrations/grant-target/")) {
      callbackPaths.push(req.url);
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { migrationGeneration?: string };
      callbackGenerations.push(body.migrationGeneration ?? "");
      if (req.url.endsWith("/start-transfer")) {
        startTransferAttempts += 1;
        if (startTransferAttempts === 1) {
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            code: "migration_generation_stale",
            error: "Migration generation is stale",
          }));
          return;
        }
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        migration: {
          grantKey: "grant-target",
          migrationRef: "mig_EEEEEEEEEEEEEEEEEEEEEE",
          migrationGeneration: req.url.endsWith("/start-transfer") ? "agent_migration:migration-target:6" : req.url.endsWith("/flip-machine") ? "agent_migration:migration-target:7" : "agent_migration:migration-target:8",
          state: req.url.endsWith("/start-transfer") ? "in_transit" : req.url.endsWith("/flip-machine") ? "arriving" : "completed",
          sourceMachineId: "source-machine",
          targetMachineId: "target-machine",
          agentId: "agent-target",
          manifestPath: null,
          manifestSha256: null,
          canDriveTargetImport: true,
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const serverBaseUrl = transferServer.baseUrl;
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.join(sourceRoot, "agent-target"), { recursive: true });
    await writeFile(path.join(sourceRoot, "agent-target", "notes.md"), "hello target\n");
    bundle = new Uint8Array(await readReadable((await buildAgentMigrationObjectStoreBundle({
      agentId: "agent-target",
      slockHome: sourceRoot,
      workspacePath: path.join(sourceRoot, "agent-target"),
      maxBytes: 104857600,
    })).bundle));
    core = new DaemonCore({
      serverUrl: serverBaseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-target",
      migrationId: "migration-target",
      migrationRef: "mig_EEEEEEEEEEEEEEEEEEEEEE",
      migrationGeneration: "agent_migration:migration-target:3",
      sessionId: "session-target",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      url: `${serverBaseUrl}/object-store-bundle`,
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });

    await waitFor(() => callbackPaths.includes("/internal/computer/agent-migrations/grant-target/arrived"), "target import arrival callback");
    assert.equal(downloadAttempts, 2);
    assert.equal(downloadToken, "target-token");
    assert.equal(startTransferAttempts, 2);
    assert.deepEqual(callbackPaths, [
      "/internal/computer/agent-migrations/grant-target/start-transfer",
      "/internal/computer/agent-migrations/grant-target/start-transfer",
      "/internal/computer/agent-migrations/grant-target/flip-machine",
      "/internal/computer/agent-migrations/grant-target/arrived",
    ]);
    assert.deepEqual(callbackGenerations, [
      "agent_migration:migration-target:4",
      "agent_migration:migration-target:5",
      "agent_migration:migration-target:6",
      "agent_migration:migration-target:7",
    ]);
    assert.equal(await readFile(path.join(dataDir, "agent-target", "notes.md"), "utf8"), "hello target\n");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore reports transport lost when target object-store download retries expire", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-target-get-expire-test-"));
  const sockets: FakeWebSocket[] = [];
  const callbackPaths: string[] = [];
  const transportLostReports: Array<{ url: string; body: Record<string, unknown> }> = [];
  let downloadAttempts = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/object-store-bundle") {
      downloadAttempts += 1;
      res.statusCode = 404;
      res.end("not yet visible");
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-target/transport-lost") {
      transportLostReports.push({
        url: req.url,
        body: JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        migration: {
          id: "migration-target",
          state: "failed",
          failureReason: "MIGRATION_TRANSPORT_LOST",
          transportErrorCode: "MIGRATION_TRANSPORT_LOST",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/internal/computer/agent-migrations/grant-target/")) {
      callbackPaths.push(req.url);
      await readRequestBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, migration: {} }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const serverBaseUrl = transferServer.baseUrl;
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: serverBaseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-target",
      migrationId: "migration-target",
      migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
      migrationGeneration: "agent_migration:migration-target:3",
      sessionId: "session-target",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      url: `${serverBaseUrl}/object-store-bundle`,
      bearerToken: "target-token",
      expiresAt: new Date(Date.now() + 80).toISOString(),
      maxBytes: 104857600,
    });

    await waitFor(() => transportLostReports.length === 1, "transport lost report", 2_000);
    assert.ok(downloadAttempts >= 2);
    assert.deepEqual(callbackPaths, []);
    assert.equal(transportLostReports[0]!.body.role, "target");
    assert.equal(transportLostReports[0]!.body.transferKind, "download");
    assert.equal(transportLostReports[0]!.body.message, "MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:404");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore generation-fences and idempotently acknowledges an in-flight resumable migration cancel", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-cancel-test-"));
  const resumableResiduePath = path.join(
    dataDir,
    "migrations",
    "migration-cancel",
    "transport-generation-cancel",
    "chunks",
    "0.part",
  );
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let transportLostReports = 0;
  let downloadAttempts = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "GET"
      && req.url?.startsWith("/internal/computer/agent-migrations/by-id/migration-cancel/resumable/control")
    ) {
      downloadAttempts += 1;
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "migration_control_not_ready" }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-cancel/cancel-ack") {
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-cancel/transport-lost") {
      transportLostReports += 1;
      await readRequestBody(req);
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await writeFile(resumableResiduePath, "partial chunk");
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-cancel",
      migrationId: "migration-cancel",
      migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
      migrationGeneration: "agent_migration:migration-cancel:3",
      sessionId: "session-cancel",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      url: `${transferServer.baseUrl}/object-store-bundle`,
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-cancel/resumable",
      leaseId: "lease-cancel",
      transportGeneration: "transport-generation-cancel",
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      expectedMigrationRevision: 3,
    });
    await waitFor(() => downloadAttempts >= 1, "initial target download attempt");

    const cancelMessage = {
      type: "machine:migration:cancel" as const,
      agentId: "agent-cancel",
      migrationId: "migration-cancel",
      migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
      transportGeneration: "transport-generation-cancel",
      cancelGeneration: "migration_cancel_generation_1",
      migrationRevision: 4,
      sessionId: "session-cancel",
      role: "target" as const,
      disposition: "pre_flip_source_authoritative" as const,
      stopAgent: false,
    };
    socket.emitServerMessage(cancelMessage);

    await waitFor(() => cancelAcks.length === 1, "migration cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.migrationRef, "mig_FFFFFFFFFFFFFFFFFFFFFF");
    assert.equal(cancelAcks[0]!.transportGeneration, "transport-generation-cancel");
    assert.equal(cancelAcks[0]!.cancelGeneration, "migration_cancel_generation_1");
    assert.equal(cancelAcks[0]!.outcome, "cleaned");
    assert.equal(transportLostReports, 0);
    await assert.rejects(() => readFile(resumableResiduePath), { code: "ENOENT" });

    const receiptPath = path.join(dataDir, "migrations", "session-cancel", "cancel-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    assert.equal(receipt.cancelGeneration, "migration_cancel_generation_1");
    socket.emitServerMessage(cancelMessage);
    await waitFor(() => cancelAcks.length === 2, "idempotent duplicate acknowledgement");
    assert.equal(cancelAcks[1]!.outcome, "cleaned");

    socket.emitServerMessage({ ...cancelMessage, transportGeneration: "stale-transport-generation" });
    await waitFor(() => cancelAcks.length === 3, "stale generation rejection acknowledgement");
    assert.equal(cancelAcks[2]!.outcome, "needs_attention");
    assert.equal(cancelAcks[2]!.errorMessage, "MIGRATION_CANCEL_GENERATION_STALE");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore removes only post-flip target migration-generation residue before acknowledging and preserves target authority", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-post-flip-cancel-test-"));
  const migrationId = "migration-post-flip-cancel";
  const transportGeneration = "transport-generation-post-flip-cancel";
  const sessionId = "session-post-flip-cancel";
  const agentId = "agent-post-flip-cancel";
  const generationRoot = path.join(dataDir, "migrations", migrationId, transportGeneration);
  const resumableResiduePath = path.join(generationRoot, "chunks", "0.part");
  const siblingGenerationPath = path.join(dataDir, "migrations", migrationId, "other-generation", "chunks", "0.part");
  const siblingMigrationPath = path.join(dataDir, "migrations", "other-migration", transportGeneration, "chunks", "0.part");
  const finalWorkspacePath = path.join(dataDir, agentId);
  const targetWorkspaceSentinel = path.join(finalWorkspacePath, "MEMORY.md");
  const markerPath = path.join(dataDir, "migrations", sessionId, "cancel-state.json");
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let residuePresentWhenAcked: boolean | null = null;
  let targetWorkspaceWhenAcked: string | null = null;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/cancel-ack`) {
      try {
        await readFile(resumableResiduePath);
        residuePresentWhenAcked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        residuePresentWhenAcked = false;
      }
      targetWorkspaceWhenAcked = await readFile(targetWorkspaceSentinel, "utf8");
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await mkdir(path.dirname(siblingGenerationPath), { recursive: true });
    await mkdir(path.dirname(siblingMigrationPath), { recursive: true });
    await mkdir(finalWorkspacePath, { recursive: true });
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(resumableResiduePath, "migration-owned partial chunk");
    await writeFile(siblingGenerationPath, "other generation");
    await writeFile(siblingMigrationPath, "other migration");
    await writeFile(targetWorkspaceSentinel, "authoritative target workspace");
    await writeFile(markerPath, `${JSON.stringify({
      schemaVersion: "agent-migration-cancel/v1",
      agentId,
      migrationId,
      migrationRef: "mig_PPPPPPPPPPPPPPPPPPPPPP",
      transportGeneration,
      sessionId,
      finalWorkspacePath: path.resolve(finalWorkspacePath),
      workspacePlacementStarted: true,
      workspacePlaced: true,
      flipCommitted: true,
    })}\n`);

    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration:cancel",
      agentId,
      migrationId,
      migrationRef: "mig_PPPPPPPPPPPPPPPPPPPPPP",
      transportGeneration,
      cancelGeneration: "migration_cancel_generation_post_flip_1",
      migrationRevision: 7,
      sessionId,
      role: "target",
      disposition: "post_flip_target_authoritative",
      stopAgent: true,
    });

    await waitFor(() => cancelAcks.length === 1, "post-flip migration cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.outcome, "stopped");
    assert.equal(residuePresentWhenAcked, false, "exact generation residue must be gone before ACK");
    assert.equal(targetWorkspaceWhenAcked, "authoritative target workspace");
    await assert.rejects(() => readFile(generationRoot), { code: "ENOENT" });
    assert.equal(await readFile(siblingGenerationPath, "utf8"), "other generation");
    assert.equal(await readFile(siblingMigrationPath, "utf8"), "other migration");
    assert.equal(await readFile(targetWorkspaceSentinel, "utf8"), "authoritative target workspace");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore aborts a post-flip source run and removes its exact generation residue before acknowledging", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-post-flip-source-cancel-test-"));
  const migrationId = "migration-post-flip-source-cancel";
  const transportGeneration = "transport-generation-post-flip-source-cancel";
  const sessionId = "session-post-flip-source-cancel";
  const agentId = "agent-post-flip-source-cancel";
  const resumableResiduePath = path.join(
    dataDir,
    "migrations",
    migrationId,
    transportGeneration,
    "source-spool",
    "partial.tar",
  );
  const sockets: FakeWebSocket[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  let sourceQuiesceStarted = false;
  let residuePresentWhenAcked: boolean | null = null;
  let transportLostReports = 0;
  const transferServer = await withHttpServer(async (req, res) => {
    if (
      req.method === "POST"
      && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-quiesced`
    ) {
      await readRequestBody(req);
      sourceQuiesceStarted = true;
      await new Promise<void>((resolve) => res.once("close", resolve));
      return;
    }
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/cancel-ack`) {
      try {
        await readFile(resumableResiduePath);
        residuePresentWhenAcked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        residuePresentWhenAcked = false;
      }
      cancelAcks.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`) {
      transportLostReports += 1;
      await readRequestBody(req);
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    await mkdir(path.dirname(resumableResiduePath), { recursive: true });
    await writeFile(resumableResiduePath, "source migration residue");
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef: "mig_SSSSSSSSSSSSSSSSSSSSSS",
      migrationGeneration: `agent_migration:${migrationId}:6`,
      sessionId,
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: `${transferServer.baseUrl}/object-store-bundle`,
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
      leaseId: "lease-post-flip-source-cancel",
      transportGeneration,
      sourceMachineId: "source-machine",
      targetMachineId: "target-machine",
      expectedMigrationRevision: 6,
    });
    await waitFor(() => sourceQuiesceStarted, "source quiesce request before cancellation");

    socket.emitServerMessage({
      type: "machine:migration:cancel",
      agentId,
      migrationId,
      migrationRef: "mig_SSSSSSSSSSSSSSSSSSSSSS",
      transportGeneration,
      cancelGeneration: "migration_cancel_generation_post_flip_source_1",
      migrationRevision: 7,
      sessionId,
      role: "source",
      disposition: "post_flip_target_authoritative",
      stopAgent: false,
    });

    await waitFor(() => cancelAcks.length === 1, "post-flip source cancellation acknowledgement");
    assert.equal(cancelAcks[0]!.outcome, "cleaned");
    assert.equal(residuePresentWhenAcked, false, "source generation residue must be gone before ACK");
    assert.equal(transportLostReports, 0, "aborted cancellation must not report transport lost");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore rejects malformed migration transfer leases without exposing token in ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-invalid-lease-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      migrationTransport: null,
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-1",
      migrationRef: "mig_GGGGGGGGGGGGGGGGGGGGGG",
      migrationGeneration: "agent_migration:migration-1:3",
      sessionId: "session-1",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      url: "https://r2.example.test/migrations/lease-1",
      bearerToken: "",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const readyMessages = socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.equal(readyMessages.some((msg) => msg.migrationTransport?.leaseSource === "server"), false);

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore starts the default agent migration HTTP transport when listen env is configured", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-env-test-"));
  const sockets: FakeWebSocket[] = [];
  const logs: string[] = [];
  const unsubscribe = subscribeDaemonLogs((event) => logs.push(event.message));
  const oldHost = process.env[AGENT_MIGRATION_TRANSPORT_HOST_ENV];
  const oldPort = process.env[AGENT_MIGRATION_TRANSPORT_PORT_ENV];
  const oldPublicUrl = process.env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV];
  let core: DaemonCore | null = null;

  try {
    process.env[AGENT_MIGRATION_TRANSPORT_HOST_ENV] = "127.0.0.1";
    delete process.env[AGENT_MIGRATION_TRANSPORT_PORT_ENV];
    delete process.env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV];
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: {
        wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });

    core.start();
    await waitFor(
      () => logs.some((line) => line.includes("Agent migration HTTP transport listening: http://127.0.0.1:")),
      "default migration transport env listen",
    );

    await core.stop();
    core = null;

    assert.ok(logs.includes("[Slock Daemon] Agent migration HTTP transport stopped"));
  } finally {
    if (core) await core.stop();
    if (oldHost === undefined) {
      delete process.env[AGENT_MIGRATION_TRANSPORT_HOST_ENV];
    } else {
      process.env[AGENT_MIGRATION_TRANSPORT_HOST_ENV] = oldHost;
    }
    if (oldPort === undefined) {
      delete process.env[AGENT_MIGRATION_TRANSPORT_PORT_ENV];
    } else {
      process.env[AGENT_MIGRATION_TRANSPORT_PORT_ENV] = oldPort;
    }
    if (oldPublicUrl === undefined) {
      delete process.env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV];
    } else {
      process.env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV] = oldPublicUrl;
    }
    unsubscribe();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore derives default agent dataDir from SLOCK_HOME", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-home-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;
  let capturedDataDir: string | undefined;
  let capturedDaemonInstanceId: string | undefined;

  try {
    process.env.SLOCK_HOME = rootDir;
    new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      agentManagerFactory: (_sendToServer, _daemonApiKey, options) => {
        capturedDataDir = options?.dataDir;
        capturedDaemonInstanceId = options?.daemonInstanceId;
        return {
          setTracer: () => {},
          stopAll: async () => {},
          getRunningAgentIds: () => [],
          startAgent: async () => {},
          stopAgent: () => {},
          resetWorkspace: () => {},
          deliverMessage: () => {},
          listWorkspace: async () => [],
          readWorkspaceFile: async () => null,
          deleteWorkspaceDirectory: async () => false,
          scanAllWorkspaces: async () => [],
          getAgentRuntimeProfileReports: () => [],
          handleRuntimeProfileNotification: () => {},
          listSkills: async () => ({ global: [], workspace: [] }),
          detectRuntimeModels: () => null,
        } as unknown as AgentProcessManager;
      },
    });

    assert.equal(capturedDataDir, path.join(rootDir, "agents"));
    assert.match(capturedDaemonInstanceId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(process.env.SLOCK_HOME, rootDir);
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore echoes skills list requestId on success and fallback replies", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-skills-request-id-test-"));
  const sockets: FakeWebSocket[] = [];
  let failNext = false;
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir: path.join(rootDir, "agents"),
      slockCliPath: "/tmp/slock-cli.js",
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
      agentManagerFactory: () => ({
        setTracer: () => {},
        stopAll: async () => {},
        getRunningAgentIds: () => [],
        getAgentSessionId: () => null,
        getAgentLaunchId: () => null,
        getIdleAgentSessionIds: () => [],
        startAgent: async () => {},
        stopAgent: () => {},
        resetWorkspace: () => {},
        deliverMessage: () => {},
        listWorkspace: async () => [],
        readWorkspaceFile: async () => null,
        deleteWorkspaceDirectory: async () => false,
        scanAllWorkspaces: async () => [],
        getAgentRuntimeProfileReports: () => [],
        handleRuntimeProfileNotification: () => {},
        listSkills: async () => {
          if (failNext) {
            failNext = false;
            throw new Error("skill scan failed");
          }
          return {
            global: [{ name: "global", displayName: "Global", description: "global", userInvocable: true }],
            workspace: [],
          };
        },
        detectRuntimeModels: () => null,
      }) as unknown as AgentProcessManager,
    });
    core.start();

    const socket = sockets[0]!;
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:skills:list",
      agentId: "agent-1",
      runtime: "codex",
      requestId: "skills-request-1",
    });
    await waitFor(
      () => socket.sent.some((msg) =>
        typeof msg === "object" && msg !== null &&
          (msg as MachineToServerMessage).type === "agent:skills:list_result" &&
          (msg as Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>).requestId === "skills-request-1"
      ),
      "skills list success reply",
    );

    failNext = true;
    socket.emitServerMessage({
      type: "agent:skills:list",
      agentId: "agent-1",
      requestId: "skills-request-2",
    });
    await waitFor(
      () => socket.sent.some((msg) =>
        typeof msg === "object" && msg !== null &&
          (msg as MachineToServerMessage).type === "agent:skills:list_result" &&
          (msg as Extract<MachineToServerMessage, { type: "agent:skills:list_result" }>).requestId === "skills-request-2"
      ),
      "skills list fallback reply",
    );

    const replies = socket.sent.filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:skills:list_result" }> =>
      typeof msg === "object" && msg !== null && (msg as MachineToServerMessage).type === "agent:skills:list_result"
    );
    assert.equal(replies.find((msg) => msg.requestId === "skills-request-1")?.global[0]?.name, "global");
    assert.deepEqual(replies.find((msg) => msg.requestId === "skills-request-2")?.global, []);
  } finally {
    if (core) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resolveRaftCliPath falls back to workspace cli dist in source tree", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cli-path-test-"));

  try {
    const daemonSrcDir = path.join(tmp, "packages", "daemon", "src");
    const workspaceCliPath = path.join(tmp, "packages", "cli", "dist", "index.js");
    await mkdir(path.dirname(workspaceCliPath), { recursive: true });
    await writeFile(workspaceCliPath, "export {};\n", "utf8");

    const moduleUrl = new URL(`file://${path.join(daemonSrcDir, "core.ts")}`).href;
    assert.equal(resolveRaftCliPath(moduleUrl), workspaceCliPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("DaemonCore prevents two daemon instances from sharing one machine key", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-machine-lock-test-"));
  const dataDir = path.join(rootDir, "agents");
  await mkdir(dataDir, { recursive: true });
  const firstSockets: FakeWebSocket[] = [];
  const secondSockets: FakeWebSocket[] = [];

  const makeCore = (sockets: FakeWebSocket[]) => new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  const first = makeCore(firstSockets);
  const second = makeCore(secondSockets);
  let firstStopped = false;
  let secondStarted = false;

  try {
    first.start();
    assert.equal(firstSockets.length, 1);

    assert.throws(() => second.start(), /Another Slock daemon is already running/);
    assert.equal(secondSockets.length, 0, "conflicting daemon must fail before opening a websocket");

    await first.stop();
    firstStopped = true;

    second.start();
    secondStarted = true;
    assert.equal(secondSockets.length, 1, "released lock should allow a later daemon to start");
  } finally {
    if (!firstStopped) await first.stop();
    if (secondStarted) await second.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore blocks legacy daemon startup after the key is adopted by Computer", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-computer-guard-test-"));
  const dataDir = path.join(rootDir, "agents");
  const oldSlockHome = process.env.SLOCK_HOME;
  const apiKey = "sk_machine_test";
  const serverId = "11111111-1111-4111-8111-111111111111";
  const legacyApiKeyFingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  const sockets: FakeWebSocket[] = [];

  await mkdir(path.join(rootDir, "computer", "servers", serverId), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(rootDir, "computer", "servers", serverId, "runner.state.json"),
    JSON.stringify(
      {
        kind: "computer-attachment",
        serverId,
        serverSlug: "alpha",
        serverMachineId: "cmp-1",
        apiKey: "sk_computer_test",
        serverUrl: "https://daemon.example.com",
        adoptedFromLegacy: true,
        legacyMachineId: "mch-1",
        legacyApiKeyFingerprint,
      },
      null,
      2,
    ),
    "utf8",
  );

  process.env.SLOCK_HOME = rootDir;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey,
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  let coreStarted = false;
  try {
    assert.throws(
      () => {
        core.start();
        coreStarted = true;
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "LegacyDaemonKeyAdoptedByComputerError");
        assert.match(error.message, /Legacy Raft daemon startup refused/);
        assert.match(error.message, /already migrated to Raft Computer for \/alpha/);
        assert.match(error.message, /do not restart raft-daemon with the migrated key/);
        assert.match(error.message, /raft-computer start \/alpha/);
        assert.match(error.message, /raft-computer status \/alpha/);
        return true;
      },
    );
    assert.equal(sockets.length, 0, "guard must fail before opening a websocket");
    await assert.rejects(
      () => stat(path.join(rootDir, "machines", getDaemonMachineLockId(apiKey), "daemon.lock", "owner.json")),
      { code: "ENOENT" },
    );
  } finally {
    if (coreStarted) await core.stop();
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore releases machine lock even when agent shutdown fails", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-machine-stop-failure-test-"));
  const dataDir = path.join(rootDir, "agents");
  await mkdir(dataDir, { recursive: true });
  const sockets: FakeWebSocket[] = [];
  const shutdownError = new Error("stop failed");

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: () => ({
      stopAll: () => Promise.reject(shutdownError),
      getRunningAgentIds: () => [],
      getAgentSessionId: () => null,
      getAgentLaunchId: () => null,
      getIdleAgentSessionIds: () => [],
      getAgentRuntimeProfileReports: () => [],
    }) as unknown as AgentProcessManager,
  });

  const replacement = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockCliPath: "/tmp/slock-cli.js",
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  let replacementStarted = false;
  try {
    core.start();
    await assert.rejects(() => core.stop(), /stop failed/);

    replacement.start();
    replacementStarted = true;
    assert.equal(sockets.length, 2, "replacement daemon should start after failed shutdown releases the lock");
  } finally {
    if (replacementStarted) await replacement.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore overrides server-provided agent serverUrl with the live daemon connection target", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ serverUrl: "http://localhost:3001" }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.serverUrl, "https://daemon.example.com");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore ACKs an accepted start dispatch and never spawns its replay twice", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    const startMessage = {
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig(),
    } satisfies Extract<ServerToMachineMessage, { type: "agent:start" }>;
    socket.emitServerMessage(startMessage);

    await waitFor(
      () => socket.sent.some((message) =>
        (message as { type?: string; startDispatchId?: string }).type === "agent:start:ack"
        && (message as { startDispatchId?: string }).startDispatchId === "dispatch-1"),
      "accepted start dispatch ACK",
    );
    await waitFor(() => driver.spawnCalls.length === 1, "initial agent spawn");

    socket.emitServerMessage(startMessage);
    await waitFor(
      () => socket.sent.filter((message) =>
        (message as { type?: string; startDispatchId?: string }).type === "agent:start:ack"
        && (message as { startDispatchId?: string }).startDispatchId === "dispatch-1").length === 2,
      "duplicate start dispatch ACK",
    );

    const receipts = socket.sent.filter(
      (message): message is Extract<MachineToServerMessage, { type: "agent:start:ack" }> =>
        (message as { type?: string }).type === "agent:start:ack",
    );
    assert.equal(driver.spawnCalls.length, 1, "replayed dispatch must not spawn a second process");
    assert.deepEqual(receipts.map((receipt) => ({
      agentId: receipt.agentId,
      launchId: receipt.launchId,
      startDispatchId: receipt.startDispatchId,
      queueState: receipt.queueState,
    })), [
      {
        agentId: "agent-1",
        launchId: "launch-1",
        startDispatchId: "dispatch-1",
        queueState: receipts[0]?.queueState,
      },
      {
        agentId: "agent-1",
        launchId: "launch-1",
        startDispatchId: "dispatch-1",
        queueState: receipts[0]?.queueState,
      },
    ]);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore mints a runner credential before starting an agent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const mintCalls: Array<{ url: string; headers: Headers; body: any }> = [];
  const revokeCalls: Array<{ url: string; headers: Headers; method?: string }> = [];
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      revokeCalls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        method: init.method,
      });
      return new Response(null, { status: 204 });
    }
    mintCalls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ apiKey: "sk_agent_minted", credentialId: "cred-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => mintCalls.length === 1 && driver.spawnCalls.length === 1, "runner credential mint and agent spawn");

    assert.equal(mintCalls.length, 1);
    const mintUrl = new URL(mintCalls[0]!.url);
    assert.equal(mintUrl.pathname, "/internal/computer/runners/agent-1/credentials");
    assert.equal(mintCalls[0]!.headers.get("Authorization"), "Bearer sk_machine_test");
    assert.deepEqual(mintCalls[0]!.body.scopes, ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"]);
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_minted");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-1");

    driver.children[0]?.kill();
    await waitFor(() => revokeCalls.length === 1, "managed runner credential revoke");
    const revokeUrl = new URL(revokeCalls[0]!.url);
    assert.equal(revokeUrl.pathname, "/internal/computer/runners/agent-1/credentials/cred-1");
    assert.equal(revokeCalls[0]!.headers.get("Authorization"), "Bearer sk_machine_test");
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore hard-fails start when runner credential mint is disabled by kill switch", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const restoreFetch = installDaemonFetchMockForTests((async () => new Response(JSON.stringify({
    error: "Experimental internal surface is disabled",
    code: "experimental_surface_disabled",
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  })) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
    tracer,
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "agent:activity"),
      "hard-fail status/activity",
    );

    assert.equal(driver.spawnCalls.length, 0);
    assert.ok(socket.sent.some((message) => JSON.stringify(message) === JSON.stringify({
      type: "agent:status",
      agentId: "agent-1",
      status: "inactive",
    })));
    const activity = socket.sent.find((message) => (message as { type?: string }).type === "agent:activity");
    assert.ok(activity);
    assert.equal((activity as { activity?: string }).activity, undefined);
    assert.equal((activity as { detailKind?: string }).detailKind, "runtime_unavailable");
    assert.match(JSON.stringify(activity), /Runner credential mint failed/);
    const failureSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.runner_credential_mint.failed");
    assert.ok(failureSpan, "hard-fail should trace runner credential mint failure");
    assert.equal(failureSpan.attrs?.code, "experimental_surface_disabled");
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries transient runner credential mint failure before spawn", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let calls = 0;
  const restoreFetch = installDaemonFetchMockForTests((async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: "temporary unavailable", code: "server_restarting" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ apiKey: "sk_agent_minted_after_retry", credentialId: "cred-retry" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn after transient runner credential retry");

    assert.equal(calls, 3);
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialKey, "sk_agent_minted_after_retry");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-retry");
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore acknowledges direct delivery using the embedded message seq when the envelope seq is missing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 0,
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "weak-network direct delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:deliver:ack"
      && msg.agentId === "agent-1"
      && msg.seq === 42
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore exposes tracked busy transition receipts and ACKs only after turn-end drain", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      launchId: "launch-1",
      config: makeConfig({ sessionId: "session-1" }),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before tracked delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 43,
      deliveryId: "mention-occurrence-43",
      mentionDelivery: {
        occurrenceId: "mention-occurrence-43",
        messageId: "mention-message-43",
        machineId: "machine-test",
        launchId: "launch-1",
        sessionId: "session-1",
      },
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "tracked busy mention",
        timestamp: new Date(0).toISOString(),
        seq: 43,
        message_id: "mention-message-43",
      },
    });
    await flush();

    assert.deepEqual(
      socket.sent
        .filter((msg: any) => msg.type === "agent:delivery:transition")
        .map((msg: any) => msg.stage),
      ["daemon_received", "daemon_pending"],
    );
    assert.equal(socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), false);

    driver.children[0]!.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    assert.deepEqual(
      socket.sent
        .filter((msg: any) => msg.type === "agent:delivery:transition")
        .map((msg: any) => msg.stage),
      ["daemon_received", "daemon_pending", "daemon_drained"],
    );
    const ack = socket.sent.find((msg: any) => msg.type === "agent:deliver:ack") as any;
    assert.ok(ack);
    assert.equal(ack.deliveryId, "mention-occurrence-43");
    assert.equal(ack.mentionDelivery?.occurrenceId, "mention-occurrence-43");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not acknowledge delivery when no process or idle cache can accept it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "delivery with no local runtime state",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    assert.equal(socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), false);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:status"
      && msg.agentId === "agent-1"
      && msg.status === "inactive"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.activity === undefined
      && msg.detailKind === "runtime_unavailable"
      && msg.detail === "Process unavailable; restart required"
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore queues delivery that races with a freshly queued start", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      message: {
        channel_id: "channel-1",
        channel_name: "all",
        channel_type: "channel",
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: "startup-race onboarding delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });

    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:deliver:ack"
      && msg.agentId === "agent-1"
      && msg.seq === 42
    ));
    assert.match(driver.spawnCalls[0]!.prompt, /#all/);
    assert.match(driver.spawnCalls[0]!.prompt, /msg-42/);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore completes legacy runtime profile migration without injection path", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      migrationKey: "migration-1",
      message: "Runtime Profile changed: Model changed",
      launchId: "launch-1",
    });
    await flush();

    assert.equal(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ), true);
    assert.equal(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ), true);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore treats legacy runtime profile wake messages as reset no-ops", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      wakeMessage: {
        channel_id: "system",
        channel_name: "system",
        channel_type: "dm",
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: "Runtime Profile changed: Runtime changed",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "runtime-profile-migration-migration-1",
      },
      unreadSummary: { "#general": 2 },
      launchId: "launch-1",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    const prompt = driver.spawnCalls[0]?.prompt;
    assert.ok(prompt);
    assert.doesNotMatch(prompt, /Runtime Profile notice/);
    assert.doesNotMatch(prompt, /Runtime Profile changed: Runtime changed/);
    assert.doesNotMatch(prompt, /\[target=dm:@system/);
    assert.match(prompt, /You have unread messages from while you were offline/);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore acknowledges runtime profile control mounted in agent config", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({
        sessionId: null,
        runtimeProfileControl: {
          kind: "daemon_release_notice",
          key: "release-1",
          message: "Runtime Profile notice: daemon upgraded 0.52.2 -> 0.53.0.",
        },
      }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");

    assert.equal(driver.spawnCalls[0]?.config.runtimeProfileControl?.key, "release-1");
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:daemon_release_notice:ack"
      && msg.agentId === "agent-1"
      && msg.noticeKey === "release-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile notice"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile notice"
        && entry.text.includes("Runtime Profile notice: daemon upgraded")
      )
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore completes runtime profile migration immediately for idle runtimes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const serverSpan = tracer.startSpan("server.runtime_profile.control.delivery", {
    surface: "server",
    kind: "producer",
  });

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "agent child process");
    const child = driver.children[0];
    assert.ok(child, "driver should spawn a child process");
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "agent:runtime_profile:migration",
      agentId: "agent-1",
      migrationKey: "migration-1",
      message: "Runtime Profile changed: Model changed",
      launchId: "launch-1",
      traceparent: formatTraceparent(serverSpan.context),
    });
    await flush();

    const runtimeProfileWrite = child.stdinWrites.find((chunk) => chunk.includes("Runtime Profile changed: Model changed"));
    assert.equal(runtimeProfileWrite, undefined);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    const ack = socket.sent.find((msg: any) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
    ) as any;
    assert.ok(ack?.traceparent, "runtime profile ack should carry traceparent");
    const ackParent = parseTraceparent(ack.traceparent);
    assert.ok(ackParent);
    assert.equal(ackParent.traceId, traceId);
    const receivedSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.runtime_profile.control.received");
    const injectSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.runtime_profile.control.inject");
    const stdinSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.agent.stdin_delivery");
    assert.ok(receivedSpan, "daemon should trace runtime profile control receive");
    assert.ok(injectSpan, "daemon should trace runtime profile no-op completion");
    assert.equal(stdinSpan, undefined);
    assert.equal(receivedSpan.context.parentSpanId, serverSpan.context.spanId);
    assert.equal(receivedSpan.attrs?.control_kind, "migration");
    assert.equal(receivedSpan.attrs?.key_present, true);
    assert.equal(injectSpan.context.parentSpanId, receivedSpan.context.spanId);
    assert.equal(injectSpan.attrs?.outcome, "deprecated_noop_completed");
    assert.equal(ackParent.spanId, injectSpan.context.spanId);
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile reset"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile reset"
        && entry.text.includes("Runtime Profile changed: Model changed")
      )
    ) === false);
  } finally {
    serverSpan.end();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore logs runtime profile daemon release notices to activity after injection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig({ sessionId: "session-1" }),
      launchId: "launch-1",
    });
    await waitFor(() => driver.children.length === 1, "agent child process");
    const child = driver.children[0];
    assert.ok(child, "driver should spawn a child process");
    child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();

    socket.emitServerMessage({
      type: "agent:runtime_profile:daemon_release_notice",
      agentId: "agent-1",
      noticeKey: "notice-1",
      message: "Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.",
      launchId: "launch-1",
    });
    await flush();

    assert.ok(child.stdinWrites.some((chunk) => chunk.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.")));

    // N24/N26 regression guard: daemon_release_notice deliveries MUST NOT
    // tell the agent to "complete the required runtime control action
    // before responding to normal inbox messages" — release_notice has
    // no associated tool call. The old wording poisoned stateful-session
    // drivers (claude), whose `--resume` carries history across turns:
    // a daemon upgrade stacks multiple release_notice deliveries on an
    // idle agent in one second, each carrying the contradictory
    // instruction. The agent then silently drops outbound sends, waiting
    // for an action that does not exist (confirmed N24 root cause:
    // 4 claude/opus agents, migration_status=stable, all wedged).
    const releaseNoticeWrite = child.stdinWrites.find((chunk) =>
      chunk.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2."),
    );
    assert.ok(releaseNoticeWrite);
    assert.match(releaseNoticeWrite, /Runtime Profile notice/);
    assert.match(
      releaseNoticeWrite,
      /No chat reply or runtime control action is required/,
    );
    assert.doesNotMatch(
      releaseNoticeWrite,
      /Complete the required runtime control action before reading or responding/,
    );

    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:runtime_profile:daemon_release_notice:ack"
      && msg.agentId === "agent-1"
      && msg.noticeKey === "notice-1"
      && msg.launchId === "launch-1"
    ));
    assert.ok(socket.sent.some((msg: any) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && msg.detail === "Runtime Profile notice"
      && msg.entries?.some((entry: any) =>
        entry.kind === "system"
        && entry.title === "Runtime Profile notice"
        && entry.text.includes("Runtime Profile notice: daemon upgraded 0.40.0 -> 0.40.2.")
      )
    ));
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore preserves delivery trace context on ack", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const serverSpan = tracer.startSpan("server.agent.delivery", { surface: "server", kind: "producer" });

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
    });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before delivery");

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 42,
      deliveryId: "delivery-42",
      traceparent: formatTraceparent(serverSpan.context),
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "weak-network traced direct delivery",
        timestamp: new Date(0).toISOString(),
        seq: 42,
        message_id: "msg-42",
      },
    });
    await flush();

    const ack = socket.sent.find((msg: any) => msg.type === "agent:deliver:ack");
    assert.ok(ack, "daemon should ack delivery");
    assert.equal((ack as any).seq, 42);
    assert.equal((ack as any).deliveryId, "delivery-42");
    const ackParent = parseTraceparent((ack as any).traceparent);
    assert.ok(ackParent, "ack should carry traceparent");
    assert.equal(ackParent.traceId, traceId);

    const daemonSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.agent.delivery");
    assert.ok(daemonSpan, "daemon delivery span should be recorded");
    assert.equal(daemonSpan.context.parentSpanId, serverSpan.context.spanId);
    assert.equal(daemonSpan.attrs?.deliveryId, "delivery-42");
    assert.equal(daemonSpan.attrs?.delivery_correlation_id, "delivery-42");
    assert.equal(ackParent.spanId, daemonSpan.context.spanId);
    assert.deepEqual(eventsForSpan(sink, traceId, "daemon.agent.delivery").map((event) => event.name), [
      "daemon.receive",
      "daemon.deliver_to_agent_manager",
      "daemon.ack.sent",
    ]);
  } finally {
    serverSpan.end();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore writes local rotating trace file under machine directory when enabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-core-test-"));
  const dataDir = path.join(rootDir, "agents");
  const machineStateDir = path.join(rootDir, "machines");
  const sockets: FakeWebSocket[] = [];
  let stopped = false;

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    machineStateDir,
    localTrace: true,
    localTraceMaxFileBytes: 1024 * 1024,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 7,
      message: {
        id: "message-1",
        message_id: "message-1",
        seq: 7,
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "hello",
        created_at: "2026-05-05T00:00:00.000Z",
        attachments: [],
      } as any,
    });
    await flush();
    await core.stop();
    stopped = true;

    const machineDirs = await readdir(machineStateDir);
    assert.equal(machineDirs.length, 1);
    const traceDir = path.join(machineStateDir, machineDirs[0], "traces");
    const traceFiles = await readdir(traceDir);
    assert.equal(traceFiles.length, 1);
    const raw = await readFile(path.join(traceDir, traceFiles[0]), "utf8");
    assert.match(raw, /daemon\.lifecycle\.start/);
    assert.match(raw, /daemon\.connection\.connected/);
    assert.match(raw, /daemon\.ready\.sent/);
    assert.match(raw, /daemon\.lifecycle\.stop/);
    assert.match(raw, /daemon\.agent\.delivery/);
    assert.equal(raw.includes("agent-1"), true);
    assert.equal(raw.includes("message-1"), true);
    assert.equal(raw.includes("hello"), false);
  } finally {
    if (!stopped) await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function assertDaemonSpawnFailureProjection(options: {
  rawSpawnDetail: string;
  expectedReason: string;
  expectedClassification: string;
  expectedUserMessage: string;
  sensitivePattern: RegExp;
}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const logMessages: string[] = [];
  const unsubscribeLogs = subscribeDaemonLogs((event) => {
    if (event.level === "ERROR") logMessages.push(event.message);
  });

  class FailingDriver extends FakeDriver {
    override spawn(ctx: SpawnContext): SpawnResult {
      this.spawnCalls.push(ctx);
      throw new Error(options.rawSpawnDetail);
    }
  }
  const driver = new FailingDriver();

  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
    tracer,
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      config: makeConfig(),
      launchId: "launch-1",
    });
    await waitFor(
      () => socket.sent.some((message) => (message as { type?: string }).type === "agent:activity"),
      "spawn failure activity",
    );

    assert.equal(driver.spawnCalls.length, 1);
    const status = socket.sent.find((message) =>
      (message as { type?: string; agentId?: string }).type === "agent:status" &&
      (message as { agentId?: string }).agentId === "agent-1"
    );
    assert.ok(status);
    assert.equal((status as { status?: string }).status, "inactive");

    const activity = socket.sent.find((message) =>
      (message as { type?: string; agentId?: string }).type === "agent:activity" &&
      (message as { agentId?: string }).agentId === "agent-1"
    );
    assert.ok(activity);
    assert.equal((activity as { detail?: string }).detail, options.expectedUserMessage);
    assert.doesNotMatch((activity as { detail?: string }).detail ?? "", options.sensitivePattern);
    assert.ok(
      logMessages.some((message) => message.includes(options.rawSpawnDetail)),
      "the same raw spawn detail must remain available in daemon logs",
    );

    const failureSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.agent.spawn.failed");
    assert.ok(failureSpan, "spawn failure should emit daemon.agent.spawn.failed trace");
    assert.equal(failureSpan.attrs?.failure_reason, options.expectedReason);
    assert.equal(failureSpan.attrs?.failure_classification, options.expectedClassification);
    assert.equal(failureSpan.attrs?.agentId, "agent-1");
    assert.equal(failureSpan.attrs?.launchId, "launch-1");
    assert.equal(failureSpan.attrs?.failure_detail, undefined);
    assert.doesNotMatch(JSON.stringify(failureSpan.attrs), options.sensitivePattern);
  } finally {
    unsubscribeLogs();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("DaemonCore keeps unclassified spawn detail in logs but out of user activity and traces", async () => {
  await assertDaemonSpawnFailureProjection({
    rawSpawnDetail:
      "bootstrap exploded: credential=credential-poison endpoint=https://private.example token=token-poison",
    expectedReason: "runtime_spawn_failed",
    expectedClassification: "unclassified_fallback",
    expectedUserMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
    sensitivePattern: /credential-poison|private\.example|token-poison/,
  });
});

test("DaemonCore emits structured trace and user-friendly activity on classified spawn failure", async () => {
  await assertDaemonSpawnFailureProjection({
    rawSpawnDetail: "Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts: "
      + "listen EACCES; Bearer sk-reviewer-secret https://provider.example/private",
    expectedReason: "agent_proxy_bind_failed",
    expectedClassification: "classified",
    expectedUserMessage:
      "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
    sensitivePattern: /sk-reviewer-secret|provider\.example/,
  });
});

// WAKE-SLOT EXCLUSION, added 2026-08-20. @Hipp found during review of #6700 that this clause was
// load-bearing with NO test: deleting `&& !delivery.mentionDelivery` would silently make mentions
// unrecoverable and nothing would go red.
//
// WHY IT IS LOAD-BEARING. The chosen wake delivery is SPLICED OUT of the replay list, so it never
// passes through handleMessage — and handleMessage is where the occurrence transitions
// (daemon_received / daemon_pending / daemon_drained) are emitted. A mention promoted to the wake
// slot would therefore be delivered while its occurrence stayed at "recorded, never delivered":
// exactly the unrecoverable state this spine exists to remove. Excluding mentions here keeps them
// on the instrumented path; it does not withhold them, and it does not stop the agent starting,
// because agent:start is what triggers the start, not the presence of a wake message.
//
// Tested through the extracted pure function rather than the live path on purpose: reaching the
// real call site needs a timing race against agent start, and a flaky arm here would be worse
// than no arm — it would produce reassurance at random.
const wakeD = (over: Record<string, unknown> = {}) => ({
  type: "agent:deliver", agentId: "agent-1", seq: 1, message: {}, ...over,
}) as never;

test("selectWakeDeliveryIndex never promotes a mention delivery to the wake slot", () => {
  // the whole list is mentions ⇒ nothing may be promoted
  assert.equal(selectWakeDeliveryIndex([
    wakeD({ mentionDelivery: { occurrenceId: "o1" } }),
    wakeD({ mentionDelivery: { occurrenceId: "o2" } }),
  ]), -1, "a list of only mentions must yield no wake delivery");

  // a mention must never be chosen even when it is first
  assert.equal(selectWakeDeliveryIndex([
    wakeD({ mentionDelivery: { occurrenceId: "o1" } }),
    wakeD({}),
  ]), 1, "the non-mention must be chosen over an earlier mention");

  // NEGATIVE CONTROL: without mentions the function still picks, so -1 above is about the
  // exclusion and not about the function being inert.
  assert.equal(selectWakeDeliveryIndex([wakeD({}), wakeD({})]), 0, "a plain delivery is promotable");

  // NOTE: no `transient` assertion lives in this arm. The first draft had one, labelled "fixture
  // precondition, never this arm's subject" — and @Hipp's criterion ⓓ killed it: suppressing the
  // UNRELATED transient clause reddened this arm, so it was not green "only because of" the
  // mention exclusion. A comment saying an assertion is out of scope does not put it out of scope.
  // transient gets its own arm below.
});

test("selectWakeDeliveryIndex never promotes a transient delivery to the wake slot", () => {
  assert.equal(selectWakeDeliveryIndex([wakeD({ transient: true })]), -1,
    "a transient-only list must yield no wake delivery");
  assert.equal(selectWakeDeliveryIndex([wakeD({ transient: true }), wakeD({})]), 1,
    "the durable delivery must be chosen over an earlier transient one");
  // NEGATIVE CONTROL, so -1 above is about `transient` and not about the function being inert.
  assert.equal(selectWakeDeliveryIndex([wakeD({})]), 0, "a plain delivery is promotable");
});
