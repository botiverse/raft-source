import { AgentProxyBindError, RuntimeExecutableNotFoundError, RuntimeModelNotFoundError } from "./spawnFailureErrors";
import { RuntimeAuthHost } from "./runtimeAuth/runtimeAuthHost";
import type { CredentialDiskWatch } from "./credentialDiskWatch";
import type { RuntimeLimitResetRedeemer, RuntimeLimitResetsReader } from "./runtimeAccountUsage/limitReset";
import { cursorSdkAvailable } from "./oarLoader";
import { type RuntimeModelSourceOutcome, SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1, runtimeAuthLogoutRuntimesOfComputer, runtimeAuthRuntimesOfComputer, type RuntimeAuthRuntime, type RuntimeAuthStatus, type RuntimeAuthLoginId, type RuntimeAuthProviderConnectInput, type AgentMigrationTransportLeaseMessage } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AxSurfaceText,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY,
  AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS,
  DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1,
  DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1,
  asAgentContextViewRequestId,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX,
  DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR,
  DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1,
  DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
  DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1,
  SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1,
  SERVER_CAPABILITY_START_SPAWN_ERROR_V1,
  SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1,
  SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1,
  SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET,
  DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY,
  DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS,
  type RuntimeLimitResetKind,
  type RuntimeLimitResetResult,
  createTraceScopeTracer,
  eventsForSpan,
  formatTraceparent,
  isRuntimeDeprecated,
  parseTraceparent,
  type AgentConfig,
  type ComputerLifecycleExecutionAck,
  type MachineToServerMessage,
  type RuntimeAccountUsageProvider,
  type RuntimeLimitResetIdempotencyKey,
  type RuntimeAccountUsageSnapshot,
  type ServerToMachineMessage,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
} from "@botiverse/raft-shared";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
  CLEANER_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol";
import { AgentProcessManager } from "./agentProcessManager";
import { providerLimitCredentialKey } from "./providerLimitLedger";
import { spawn as spawnProcess } from "node:child_process";
import { RuntimeProcessLedger, RUNTIME_PROCESS_LEDGER_FILE } from "./drivers/runtimeProcessLedger";
import { lookupCommandOnPath } from "./drivers/probe";
import { OpenCodeDriver } from "./drivers/opencode";
import { isRuntimeModelDetectionLookupReason } from "@botiverse/raft-shared";
import { OUTBOX_NORMAL_CAP, RuntimeOutcomeOutbox, nodeOutboxFs, type OutboxFrame } from "./runtimeOutcomeOutbox";
import { installDaemonFetchMockForTests } from "./daemonFetch";
import type { AgentAppInboxStore } from "./agentAppInbox";
import { AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY } from "./agentMigrationWorkspaceArchive";
import {
  DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  DaemonCore as RealDaemonCore,
  type ComputerControlContext,
  type DaemonCoreOptions,
  selectWakeDeliveryIndex,
  detectRuntimes,
  migrationTransferFailureCode,
  migrationTransferFailureDetailCode,
  unsafeAgentIdOf,
  withConfigRevision,
  pollMigrationResumableControl,
  retryMigrationTargetStep,
  type MigrationTargetImportView,
  parseDaemonCliArgs,
  readDaemonVersion,
  resolveRaftCliPath,
  runtimeModelCatalogFrame,
  sanitizeCatalogModels,
  subscribeDaemonLogs,
} from "./core";
import { streamAgentMigrationResumableBundle, validateAgentMigrationControlManifest } from "./agentMigrationResumableBundle";
import { getDaemonMachineLockId } from "./machineLock";
import { ProcJobManager } from "./procJobs";
import type { RuntimeDriver, ParsedEvent, SpawnContext, SpawnResult } from "./drivers/index";
import type { ConnectionOptions, WebSocketLike } from "./connection";
import { FakeClock } from "./testing/fakeClock";
import { traceRows } from "./testing/traceRows";
import { hostIdHashForServer, readHardwareId } from "./hostIdentity";
import { makeDeterministicTracer } from "./testing/deterministicTracer";

/**
 * The daemon under test never runs real runtime detection. Detection starts
 * CLI children (since #11103 a detected Claude Code is asked for its models
 * through OAR), which can outlive a test on a host where a runtime is
 * installed; a test that intercepts process.kill then catches their cleanup
 * and the child leaks. A test about detection passes its own
 * `runtimeDetector` or `runtimeDetectionRound` (core.runtimeDetection.test.ts
 * covers the real round). A test whose own detector lists a real runtime id
 * still gets that runtime's model listing after ready.
 */
class DaemonCore extends RealDaemonCore {
  constructor(options: DaemonCoreOptions) {
    super({
      runtimeDetector: () => ({ ids: [], versions: {} }),
      runtimeDetectionRound: () => ({
        result: Promise.resolve({ status: "complete", detection: { ids: [], versions: {} }, durationMs: 0 }),
        cancel: () => {},
      }),
      ...options,
    });
  }
}


/**
 * Fake children in these tests carry a pid because a real spawn sets one. The
 * daemon's shutdown orphan reaper (`reapOrphanProcesses`, after stopAll) sends
 * real signals to every snapshotted pid, probing with signal 0 and SIGKILLing
 * survivors, so a fake pid must never be a pid the host can hold. Linux caps
 * pids at 2^22 (4194304), macOS at 99999; anything here is answered with ESRCH.
 * (Small values like 4001 SIGKILLed whatever runner process held them:
 * #proj-dx:7a5efdf3, CI runs 38041317473 and 38041915630.)
 */
const IMPOSSIBLE_PID_BASE = 2_000_000_000;

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

test("migration transfer detail code keeps the real cause without free text", () => {
  assert.equal(
    migrationTransferFailureDetailCode(new Error("MIGRATION_WORKSPACE_ALREADY_EXISTS")),
    "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  );
  assert.equal(
    migrationTransferFailureDetailCode(new Error(
      "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
    )),
    "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
  );
  assert.equal(
    migrationTransferFailureDetailCode(new Error("MIGRATION_PRIVATE_DRIVER_FAILURE:password=secret")),
    "MIGRATION_PRIVATE_DRIVER_FAILURE",
  );
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  assert.equal(migrationTransferFailureDetailCode(enospc), "NODE_ENOSPC");
  const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  assert.equal(migrationTransferFailureDetailCode(fetchFailed), "FETCH_ECONNRESET");
  assert.equal(migrationTransferFailureDetailCode(new TypeError("fetch failed")), "FETCH_FAILED");
  assert.equal(migrationTransferFailureDetailCode(new RangeError("Invalid string length")), "JS_RangeError");
  assert.equal(migrationTransferFailureDetailCode("not an error"), undefined);
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

const TEST_MODEL_LIMITS = {
  contextWindow: { value: 200_000, source: "raft_default" },
  maxTokens: { value: 8192, source: "raft_default" },
} as const;

class FakeDriver implements RuntimeDriver {
  readonly id = "codex";
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only" } as const;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode = "none" as const;
  readonly spawnCalls: SpawnContext[] = [];
  readonly children: FakeChildProcess[] = [];
  /** Thrown by spawn: a start that fails before any process exists (e.g. an unavailable model). */
  failSpawn: Error | null = null;

  constructor(opts: { supportsStdinNotification?: boolean } = {}) {
    this.supportsStdinNotification = opts.supportsStdinNotification ?? false;
    this.lifecycle = this.supportsStdinNotification
      ? { kind: "persistent", stdin: "notification", inFlightWake: "queue" }
      : { kind: "per_turn", start: "immediate", exit: "natural", inFlightWake: "spawn_new" };
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    if (this.failSpawn) throw this.failSpawn;
    const child = new FakeChildProcess();
    this.children.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    if (line === "turn_end") return [{ kind: "turn_end", sessionId: "session-1" }];
    if (line === "text") return [{ kind: "text", text: "model output" }];
    // task #1357 item 1: as the Pi runtime session does, the revision of the config the spawn was built from.
    if (line === "model_limits") {
      const configRevision = this.spawnCalls.at(-1)?.config.configRevision;
      return [{ kind: "model_limits", sessionId: "session-1", configRevision: typeof configRevision === "number" ? configRevision : null, modelLimits: TEST_MODEL_LIMITS }];
    }
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

/** RFC 071 outbox: open the socket as an ack-capable server, optionally acking every outbox frame at once. */
function openAckingServer(socket: FakeWebSocket, options: { autoAck?: boolean } = {}): void {
  if (options.autoAck !== false) {
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      send(data);
      const msg = JSON.parse(data) as { type?: string; agentId?: string; daemonInstanceId?: string; clientSeq?: number; gapId?: string };
      const outbox = ["agent:runtime:outcome", "agent:process_spawned", "agent:process_exited", "agent:start:outcome"];
      if (msg.type && outbox.includes(msg.type)) {
        setImmediate(() => socket.emitServerMessage({ type: "agent:outcome:ack", agentId: msg.agentId!, daemonInstanceId: msg.daemonInstanceId, clientSeq: msg.clientSeq }));
      } else if (msg.type === "agent:runtime:outcome_gap" || msg.type === "agent:runtime:outcome_cross_instance_unknown") {
        setImmediate(() => socket.emitServerMessage({ type: "agent:outcome:ack", agentId: msg.agentId!, gapId: msg.gapId }));
      }
    };
  }
  socket.emitOpen({ machineContext: false });
  socket.emitServerMessage({
    type: "machine:context",
    machineId: "machine-test",
    serverId: "server-test",
    capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1],
  });
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
    const storageTraces = traceRows(sink, traceId);
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
    const trace = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.runtime_account_usage.refresh");
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

describe("DaemonCore limit reset", () => {
  const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f" as RuntimeLimitResetIdempotencyKey;
  const usage = (resets: number): RuntimeAccountUsageSnapshot => ({
    protocolVersion: 2,
    provider: "codex",
    collectedAt: "2026-11-07T10:00:00.000Z",
    staleAfter: "2026-11-07T10:30:00.000Z",
    collectorVersion: "test",
    accounts: [{ accountKey: "a".repeat(64), maskedLabel: "tea****r@example.com", health: "rate_limited", limitResetsAvailable: resets, windows: [] }],
  });

  async function withCore(
    options: {
      serverCapabilities: string[];
      redeem?: (provider: RuntimeAccountUsageProvider, key: string) => Promise<RuntimeLimitResetResult>;
      read?: () => Promise<RuntimeAccountUsageSnapshot>;
      redeemer?: RuntimeLimitResetRedeemer;
      reader?: RuntimeLimitResetsReader;
      platform?: NodeJS.Platform;
    },
    run: (input: { socket: FakeWebSocket; events: string[]; traceRows: () => Array<{ name: string; attrs?: Record<string, unknown> }> }) => Promise<void>,
  ) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-limit-reset-test-"));
    const sockets: FakeWebSocket[] = [];
    const events: string[] = [];
    const { sink, tracer, traceId } = makeDeterministicTracer();
    const core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      runtimeAccountUsageCollector: async (provider) => {
        events.push(`read:${provider}`);
        return options.read ? options.read() : usage(1);
      },
      ...(options.redeem ? {
        runtimeLimitResetRedeemer: async (provider: RuntimeAccountUsageProvider, key: string) => {
          events.push(`redeem:${provider}:${key}`);
          return options.redeem!(provider, key);
        },
      } : {}),
      ...(options.redeemer ? { runtimeLimitResetRedeemer: options.redeemer } : {}),
      ...(options.reader ? { runtimeLimitResetsReader: options.reader } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
    });
    try {
      core.start();
      const socket = sockets[0]!;
      socket.emitOpen({ machineContext: false });
      socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: options.serverCapabilities });
      await run({ socket, events, traceRows: () => traceRows(sink, traceId) as Array<{ name: string; attrs?: Record<string, unknown> }> });
    } finally {
      await core.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  const results = (socket: FakeWebSocket) => socket.sent.filter((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:limit_reset:result" }> =>
    (message as { type?: string }).type === "machine:runtime_account_usage:limit_reset:result");

  test("advertises the capability, redeems with the server's key, then reads usage and answers with both", async () => {
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1], redeem: async () => ({ kind: "reset" }) }, async ({ socket, events, traceRows }) => {
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
      const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as { capabilities?: string[] };
      assert.ok(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET));
      assert.ok(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY), "its OAR reads Antigravity's usage");

      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-1", provider: "codex", idempotencyKey: KEY });
      await waitFor(() => results(socket).length === 1, "limit reset result");
      assert.deepEqual(events, [`redeem:codex:${KEY}`, "read:codex"], "the key as given, and usage read after the redeem");
      assert.deepEqual(results(socket)[0], { type: "machine:runtime_account_usage:limit_reset:result", requestId: "redeem-1", result: { kind: "reset" }, snapshot: usage(1) });
      const trace = traceRows().find((row) => row.name === "daemon.runtime_account_usage.limit_reset");
      assert.equal(trace?.attrs?.outcome, "reset");
      assert.equal(trace?.attrs?.snapshot_sent, true);
      assert.ok(!JSON.stringify(traceRows()).includes(KEY), "the key is never traced");
    });
  });

  test("a Claude redeem carries the kind clicked to the redeemer; a bad kind is dropped; the Claude capability is advertised on Linux", async () => {
    const asked: unknown[] = [];
    const redeemer: RuntimeLimitResetRedeemer = async (provider, idempotencyKey, kind, observe) => {
      asked.push({ provider, idempotencyKey, kind });
      observe?.({ oarOutcome: "not_attempted:busy" });
      return { kind: "unsupported", reason: "not_attempted" };
    };
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1], redeemer, platform: "linux" }, async ({ socket, traceRows }) => {
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
      const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as { capabilities?: string[] };
      assert.ok(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS), "OAR drives Claude Code on Linux, whatever its version");

      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-c1", provider: "claude", idempotencyKey: KEY, kind: "fable" });
      await waitFor(() => results(socket).length === 1, "limit reset result");
      assert.deepEqual(asked, [{ provider: "claude", idempotencyKey: KEY, kind: "fable" }]);
      assert.deepEqual(results(socket)[0]?.result, { kind: "unsupported", reason: "not_attempted" });
      const trace = traceRows().find((row) => row.name === "daemon.runtime_account_usage.limit_reset");
      assert.deepEqual(
        { provider: trace?.attrs?.provider, outcome: trace?.attrs?.outcome, reason: trace?.attrs?.reason, reset_kind: trace?.attrs?.reset_kind, oar_outcome: trace?.attrs?.oar_outcome },
        { provider: "claude", outcome: "unsupported", reason: "not_attempted", reset_kind: "fable", oar_outcome: "not_attempted:busy" },
      );

      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-c3", provider: "claude", idempotencyKey: KEY, kind: "monthly" as RuntimeLimitResetKind });
      await waitFor(() => traceRows().some((row) => row.attrs?.outcome === "message_dropped"), "dropped message traced");
      assert.equal(asked.length, 1);
      assert.equal(results(socket).length, 1);
    });
  });

  test("on macOS the Claude capability is not advertised: OAR cannot drive Claude Code there, so the card keeps offering nothing", async () => {
    await withCore({ serverCapabilities: [], platform: "darwin" }, async ({ socket }) => {
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
      const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as { capabilities?: string[] };
      assert.ok(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET), "Codex resets are unchanged");
      assert.ok(!ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_LIMIT_RESET_CLAUDE_KINDS));
    });
  });

  test("a read of the resets held goes to the reader with the caller's consent as given, and answers once", async () => {
    const asked: unknown[] = [];
    const reader: RuntimeLimitResetsReader = async (provider, input, observe) => {
      asked.push(input);
      if (provider !== "claude") return { kind: "unsupported", reason: "capability_unavailable" };
      observe?.({ oarOutcome: "inspected", claudeVersion: "2.1.322" });
      return { kind: "read", resets: [{ kind: "five_hour", state: "not_checked" }, { kind: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 16, 4:59pm" }, { kind: "fable", state: "none" }, { kind: "full", state: "unknown" }] };
    };
    const reads = (socket: FakeWebSocket) => socket.sent.filter((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_account_usage:limit_resets:read:result" }> =>
      (message as { type?: string }).type === "machine:runtime_account_usage:limit_resets:read:result");
    await withCore({ serverCapabilities: [], reader }, async ({ socket, events, traceRows }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_resets:read", requestId: "read-1", provider: "claude", atFiveHourLimit: false });
      await waitFor(() => reads(socket).length === 1, "read result");
      assert.deepEqual(asked, [{ atFiveHourLimit: false, atFiveHourLimitConsent: false, includeFiveHour: false }]);
      assert.equal(reads(socket)[0]?.result.kind, "read");
      assert.deepEqual(events, [], "a read spends nothing, so usage is not read again");
      const trace = traceRows().find((row) => row.name === "daemon.runtime_account_usage.limit_reset");
      assert.deepEqual(
        { operation: trace?.attrs?.operation, outcome: trace?.attrs?.outcome, available_kinds: trace?.attrs?.available_kinds, unknown_kinds: trace?.attrs?.unknown_kinds, claude_version: trace?.attrs?.claude_version, oar_outcome: trace?.attrs?.oar_outcome },
        { operation: "read", outcome: "read", available_kinds: 1, unknown_kinds: 1, claude_version: "2.1.322", oar_outcome: "inspected" },
      );
      assert.ok(!JSON.stringify(traceRows()).includes("Nov 16"), "what the screen said is never traced");

      // A message that does not say the account is clear of its 5-hour limit is treated as at it.
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_resets:read", requestId: "read-2", provider: "claude", atFiveHourLimitConsent: true, includeFiveHour: true } as unknown as ServerToMachineMessage);
      await waitFor(() => reads(socket).length === 2, "second read result");
      assert.deepEqual(asked[1], { atFiveHourLimit: true, atFiveHourLimitConsent: true, includeFiveHour: true });

      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_resets:read", requestId: "read-3", provider: "codex", atFiveHourLimit: false });
      await waitFor(() => reads(socket).length === 3, "third read result");
      assert.deepEqual(reads(socket)[2]?.result, { kind: "unsupported", reason: "capability_unavailable" });
    });
  });

  test("a second redeem landing while the first one's usage read runs reads usage again on its own", async () => {
    const SECOND = "1f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f" as RuntimeLimitResetIdempotencyKey;
    let releaseReads = () => {};
    const readsHeld = new Promise<void>((resolve) => { releaseReads = resolve; });
    let finishSecond = (_result: RuntimeLimitResetResult) => {};
    const secondRedeem = new Promise<RuntimeLimitResetResult>((resolve) => { finishSecond = resolve; });
    await withCore({
      serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1],
      redeem: async (_provider, key) => (key === KEY ? { kind: "reset" } : secondRedeem),
      read: async () => { await readsHeld; return usage(1); },
    }, async ({ socket, events }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-a", provider: "codex", idempotencyKey: KEY });
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-b", provider: "codex", idempotencyKey: SECOND });
      await waitFor(() => events.includes("read:codex"), "first redeem's usage read started");
      finishSecond({ kind: "reset" });
      await waitFor(() => events.filter((event) => event === "read:codex").length === 2, "second redeem reads usage after its own redeem");
      releaseReads();
      await waitFor(() => results(socket).length === 2, "both results");
    });
  });

  test("a redeem that throws is unknown, and usage is still read", async () => {
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1], redeem: async () => { throw new Error("network"); } }, async ({ socket, events }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-2", provider: "codex", idempotencyKey: KEY });
      await waitFor(() => results(socket).length === 1, "limit reset result");
      assert.deepEqual(results(socket)[0]?.result, { kind: "unknown" });
      assert.deepEqual(events, [`redeem:codex:${KEY}`, "read:codex"]);
    });
  });

  test("an older server never sees limitResetsAvailable, in a refresh or after a redeem", async () => {
    await withCore({ serverCapabilities: [], redeem: async () => ({ kind: "nothing_to_reset" }) }, async ({ socket }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-3", provider: "codex", idempotencyKey: KEY });
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId: "usage-3", provider: "codex", reason: "manual" });
      await waitFor(() => results(socket).length === 1, "limit reset result");
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"), "snapshot");
      const { limitResetsAvailable: _dropped, ...stripped } = usage(1).accounts[0]!;
      assert.deepEqual(results(socket)[0]?.snapshot?.accounts, [stripped]);
      const refresh = socket.sent.find((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot") as { snapshot: RuntimeAccountUsageSnapshot };
      assert.deepEqual(refresh.snapshot.accounts, [stripped]);
    });
  });

  test("window scopes reach a server that reads them, and never an older one", async () => {
    const scoped = (): RuntimeAccountUsageSnapshot => ({
      ...usage(1),
      provider: "claude",
      accounts: [{
        accountKey: "a".repeat(64),
        health: "ok",
        windows: [
          { id: "w0_aaaaaaaaaaaa", label: "Current week (all models)", status: "ok", usedRatio: 0.6, scope: { kind: "account" } },
          { id: "w1_bbbbbbbbbbbb", label: "Current week (Opus)", status: "ok", usedRatio: 0.4, scope: { kind: "model", name: "Opus" } },
        ],
      }],
    });
    const snapshotOf = (socket: FakeWebSocket) => (socket.sent.find((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot") as { snapshot: RuntimeAccountUsageSnapshot }).snapshot;
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1], read: async () => scoped() }, async ({ socket }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId: "usage-s1", provider: "claude", reason: "manual" });
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"), "snapshot");
      assert.deepEqual(snapshotOf(socket).accounts[0]!.windows.map((window) => window.scope), [{ kind: "account" }, { kind: "model", name: "Opus" }]);
    });
    await withCore({ serverCapabilities: [], read: async () => scoped() }, async ({ socket }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId: "usage-s2", provider: "claude", reason: "manual" });
      await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"), "snapshot");
      assert.ok(snapshotOf(socket).accounts[0]!.windows.every((window) => !("scope" in window)), "an older server's strict schema would refuse the snapshot");
    });
  });

  test("a models scope (Antigravity's model groups) reaches a V2 server; a V1 server gets that window unscoped, the rest as is", async () => {
    const grouped = (): RuntimeAccountUsageSnapshot => ({
      ...usage(1),
      provider: "antigravity",
      accounts: [{
        accountKey: "a".repeat(64),
        health: "ok",
        windows: [
          { id: "w0_aaaaaaaaaaaa", label: "Gemini Models · Weekly", status: "limit_reached", usedRatio: 1, scope: { kind: "models", name: "Gemini Models" } },
          { id: "w1_bbbbbbbbbbbb", label: "Claude and GPT models · Weekly", status: "ok", usedRatio: 0.3, scope: { kind: "models", name: "Claude and GPT models" } },
          { id: "w2_cccccccccccc", label: "Opus", status: "ok", usedRatio: 0.4, scope: { kind: "model", name: "Opus" } },
        ],
      }],
    });
    const snapshotOf = (socket: FakeWebSocket) => (socket.sent.find((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot") as { snapshot: RuntimeAccountUsageSnapshot }).snapshot;
    const scopesSentTo = async (serverCapabilities: string[]) => {
      let scopes: unknown[] = [];
      await withCore({ serverCapabilities, read: async () => grouped() }, async ({ socket }) => {
        socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId: "usage-g1", provider: "antigravity", reason: "manual" });
        await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot"), "snapshot");
        const windows = snapshotOf(socket).accounts[0]!.windows;
        assert.deepEqual(windows.map((window) => window.status), ["limit_reached", "ok", "ok"], "the windows themselves are unchanged");
        scopes = windows.map((window) => ("scope" in window ? window.scope : "absent"));
      });
      return scopes;
    };
    assert.deepEqual(
      await scopesSentTo([SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V2]),
      [{ kind: "models", name: "Gemini Models" }, { kind: "models", name: "Claude and GPT models" }, { kind: "model", name: "Opus" }],
    );
    assert.deepEqual(
      await scopesSentTo([SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1]),
      ["absent", "absent", { kind: "model", name: "Opus" }],
      "a V1 server's strict schema would refuse the whole snapshot for a models scope",
    );
    assert.deepEqual(await scopesSentTo([]), ["absent", "absent", "absent"]);
  });

  test("a refresh's trace carries the most limit resets an account reports (#oar-raft:#3)", async () => {
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1], redeem: async () => ({ kind: "reset" }) }, async ({ socket, traceRows }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId: "usage-9", provider: "codex", reason: "manual" });
      await waitFor(() => traceRows().some((row) => row.name === "daemon.runtime_account_usage.refresh"), "refresh traced");
      const row = traceRows().find((candidate) => candidate.name === "daemon.runtime_account_usage.refresh")!;
      assert.equal(row.attrs?.limit_resets_available, usage(1).accounts[0]!.limitResetsAvailable);
    });
  });

  test("a malformed redeem is dropped without reaching OAR", async () => {
    await withCore({ serverCapabilities: [SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1], redeem: async () => ({ kind: "reset" }) }, async ({ socket, events, traceRows }) => {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-4", provider: "codex", idempotencyKey: "short" as RuntimeLimitResetIdempotencyKey });
      socket.emitServerMessage({ type: "machine:runtime_account_usage:limit_reset:redeem", requestId: "redeem-5", provider: "nope" as RuntimeAccountUsageProvider, idempotencyKey: KEY });
      await waitFor(() => traceRows().filter((row) => row.name === "daemon.runtime_account_usage.limit_reset").length === 2, "drops traced");
      assert.deepEqual(events, []);
      assert.equal(results(socket).length, 0);
    });
  });
});

test("DaemonCore pushes each ready runtime's model catalog after ready, and again after a rescan", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    // copilot has a static model source (claude now asks Claude Code, so it
    // would spawn a real claude on a dev box); the unknown runtime has neither a
    // driver nor a static list, so it must produce no catalog frame.
    runtimeDetector: () => ({ ids: ["copilot", "no-such-runtime"], versions: {} }),
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
    const catalogs = () => socket.sent.filter((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_models:catalog" }> =>
      typeof message === "object" && message !== null && (message as { type?: string }).type === "machine:runtime_models:catalog");
    await waitFor(() => catalogs().length === 1, "copilot catalog after ready");

    const readyIndex = socket.sent.findIndex((message) => (message as { type?: string }).type === "ready");
    const catalogIndex = socket.sent.indexOf(catalogs()[0]!);
    assert.ok(readyIndex >= 0 && readyIndex < catalogIndex, "the catalog follows ready");
    const [copilot] = catalogs();
    assert.equal(copilot!.runtime, "copilot");
    assert.ok(copilot!.models.length > 0);
    for (const model of copilot!.models) {
      assert.deepEqual(Object.keys(model).sort(), ["id", "label"], "only id and label cross the wire");
    }

    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogs().length === 2, "copilot catalog after rescan");
    assert.deepEqual(catalogs().map((message) => message.runtime), ["copilot", "copilot"]);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a Pi sign-out while a catalog round is already detecting clears the list in the round queued behind it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-pi-clear-test-"));
  const sockets: FakeWebSocket[] = [];
  const detections: Array<(outcome: RuntimeModelSourceOutcome) => void> = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: ["pi"], versions: {} }),
    // Each detection waits until the test answers it.
    runtimeModelDetector: () => new Promise<RuntimeModelSourceOutcome>((resolve) => { detections.push(resolve); }),
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const catalogs = () => socket.sent.filter((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_models:catalog" }> =>
      (message as { type?: string }).type === "machine:runtime_models:catalog");
    await waitFor(() => detections.length === 1, "the connect round is detecting Pi's models");

    // The last Pi provider is signed out from the web while that detection (from before) runs.
    (core as unknown as { rescanRuntimes(runtime: string): void }).rescanRuntimes("pi");
    await flush();
    detections[0]!({ kind: "live", value: { models: [{ id: "anthropic/opus", label: "Opus · Anthropic" }] } });
    await waitFor(() => catalogs().length === 1, "the old round reports what it read");
    assert.equal(catalogs()[0]!.authoritative, undefined, "a detection that began before the change does not take its clear");

    await waitFor(() => detections.length === 2, "the queued round detects again");
    detections[1]!({ kind: "no_models" });
    await waitFor(() => catalogs().length === 2, "the queued round answers for the change");
    assert.deepEqual(catalogs()[1], { type: "machine:runtime_models:catalog", runtime: "pi", models: [], authoritative: true });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconciler step 15 (B13): a missing-runtime local stop makes the core re-detect runtimes once, after the delay", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-absent-redetect-test-"));
  const sockets: FakeWebSocket[] = [];
  let detections = 0;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeAbsentRedetectDelayMs: 50,
    runtimeDetector: () => {
      detections += 1;
      return { ids: ["copilot"], versions: {} };
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
    const readies = () => socket.sent.filter((message) => (message as { type?: string }).type === "ready").length;
    await waitFor(() => readies() === 1, "the first ready");
    const detectionsBefore = detections;

    // Two agents of the runtime stop in the same moment: one re-detection.
    (core as any).scheduleRuntimeRedetectAfterAbsent("copilot");
    (core as any).scheduleRuntimeRedetectAfterAbsent("copilot");
    assert.equal(readies(), 1, "nothing before the delay");
    await waitFor(() => readies() === 2, "the re-detection's ready");
    assert.ok(detections > detectionsBefore, "the detector ran again");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readies(), 2, "one ready for both stops");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task #1242: a runtime_models:detect for a runtime this computer does not have answers runtime_not_found with the probe's lookup verdict on the wire", async (t) => {
  // Real entry (server frame) → real grok driver → serialized result frame. Only
  // meaningful where grok is absent; a host with grok installed skips.
  if (lookupCommandOnPath("grok").command) return t.skip();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-detect-reason-test-"));
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
    socket.emitServerMessage({ type: "machine:runtime_models:detect", requestId: "req-grok-missing", runtime: "grok" });
    const result = () => socket.sent.find((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_models:result" }> =>
      typeof message === "object" && message !== null
      && (message as { type?: string }).type === "machine:runtime_models:result"
      && (message as { requestId?: string }).requestId === "req-grok-missing");
    await waitFor(() => result() !== undefined, "runtime_models:result for grok", 20_000);
    const wire = JSON.parse(JSON.stringify(result()!));
    assert.equal(wire.outcome.kind, "error");
    assert.equal(wire.outcome.code, "runtime_not_found");
    assert.ok(
      isRuntimeModelDetectionLookupReason(wire.outcome.reason),
      `the probe's lookup verdict rides beside the code (got ${JSON.stringify(wire.outcome.reason)})`,
    );
    assert.equal(wire.error, "error", "the legacy field is unchanged");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a form's runtime_models:detect is served from the daemon's model cache; force runs a fresh detection", async () => {
  // Real entry (server frame) → DaemonCore cache → driver detection, with the
  // OpenCode driver's detection replaced by a counter.
  let detections = 0;
  const detectSpy = vi.spyOn(OpenCodeDriver.prototype, "detectModels").mockImplementation(async () => {
    detections += 1;
    return { kind: "live", value: { models: [{ id: `opencode/m${detections}`, label: `m${detections}`, verified: "launchable" }] } };
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-cache-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: ["opencode"], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  const modelIdOf = async (socket: FakeWebSocket, requestId: string, force?: boolean) => {
    socket.emitServerMessage({ type: "machine:runtime_models:detect", requestId, runtime: "opencode", ...(force ? { force } : {}) });
    const result = () => socket.sent.find((message): message is Extract<MachineToServerMessage, { type: "machine:runtime_models:result" }> =>
      typeof message === "object" && message !== null
      && (message as { type?: string }).type === "machine:runtime_models:result"
      && (message as { requestId?: string }).requestId === requestId);
    await waitFor(() => result() !== undefined, `runtime_models:result ${requestId}`);
    const outcome = result()!.outcome!;
    assert.equal(outcome.kind, "live");
    return outcome.kind === "live" ? outcome.value.models[0]!.id : "";
  };
  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    // The connect-time catalog push detects once and warms the cache.
    await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "machine:runtime_models:catalog"), "catalog push");
    assert.equal(detections, 1);
    assert.equal(await modelIdOf(socket, "first"), "opencode/m1", "the first form open is answered from the pushed list");
    assert.equal(await modelIdOf(socket, "second"), "opencode/m1", "a second form open inside the fresh window reuses the list");
    assert.equal(detections, 1);
    assert.equal(await modelIdOf(socket, "refresh", true), "opencode/m2", "the refresh action detects afresh");
    assert.equal(detections, 2);
    assert.equal(await modelIdOf(socket, "after-refresh"), "opencode/m2", "the forced result replaces the cached list");
    assert.equal(detections, 2);
  } finally {
    detectSpy.mockRestore();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore logs a missing optional runtime at INFO but installed-and-broken probes at WARN on ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-probe-log-level-test-"));
  const sockets: FakeWebSocket[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const unsubscribeLogs = subscribeDaemonLogs((event) => {
    if (event.message.startsWith("[Daemon] Runtime ")) logs.push({ level: event.level, message: event.message });
  });
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({
      ids: ["claude"],
      versions: {},
      diagnostics: {
        grok: "No Grok Build CLI was found on PATH.",
        codex: "codex rejected: app-server probe exit status 2",
        opencode: "probe timed out",
        cursor: "permission denied",
        kimi: "diagnostic without a structured reason",
      },
      unavailableReasons: {
        grok: "not_installed",
        codex: "probe_failed",
        opencode: "probe_timeout",
        cursor: "permission_denied",
      },
    }),
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
    await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
    const levelOf = (runtime: string) => logs.find((entry) => entry.message.startsWith(`[Daemon] Runtime ${runtime} diagnostic:`))?.level;
    assert.equal(levelOf("grok"), "INFO", JSON.stringify(logs));
    assert.equal(levelOf("codex"), "WARN", JSON.stringify(logs));
    assert.equal(levelOf("opencode"), "WARN", JSON.stringify(logs));
    assert.equal(levelOf("cursor"), "WARN", JSON.stringify(logs));
    assert.equal(levelOf("kimi"), "WARN", JSON.stringify(logs));
    // Diagnostic text is unchanged; only the level moved.
    assert.ok(logs.some((entry) => entry.message === "[Daemon] Runtime grok diagnostic: No Grok Build CLI was found on PATH."));
  } finally {
    unsubscribeLogs();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore removes stale agent-token files older daemons left, at startup, and leaves symlinks alone", { skip: process.platform === "win32" }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-stale-agent-token-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  const computerKey = "sk_computer_left_by_an_older_daemon";
  const transportRoot = path.join(rootDir, "cli-transport");
  const agentsDir = path.join(rootDir, "agents");
  const staleTokens = [
    path.join(transportRoot, "agent-a", "launch-1", "agent-token"),
    path.join(transportRoot, "agent-a", "launch-2", "agent-token"),
    path.join(transportRoot, "agent-b", "pid-4242", "agent-token"),
    // The location before cli-transport: the agent's workspace.
    path.join(agentsDir, "agent-a", ".slock", "agent-token"),
  ];
  const linkTarget = path.join(rootDir, "outside", "agent-token");
  const tokenLink = path.join(transportRoot, "agent-b", "launch-3", "agent-token");
  const keptWorkspaceFile = path.join(agentsDir, "agent-a", ".slock", "runtime-sessions.keep");
  let core: DaemonCore | null = null;
  try {
    for (const file of [...staleTokens, linkTarget]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, computerKey, { mode: 0o600 });
    }
    await writeFile(keptWorkspaceFile, "keep");
    await mkdir(path.dirname(tokenLink), { recursive: true });
    await symlink(linkTarget, tokenLink);

    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_computer_test",
      dataDir: agentsDir,
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
    sockets[0]?.emitOpen();
    await waitFor(() => (sockets[0]?.sent ?? []).some((message) => (message as { type?: string }).type === "ready"), "ready on first connect");

    for (const file of staleTokens) assert.equal(existsSync(file), false, `${path.relative(rootDir, file)} must be removed`);
    assert.equal((await lstat(tokenLink)).isSymbolicLink(), true, "a symlink named agent-token is left alone");
    assert.equal(readFileSync(linkTarget, "utf8"), computerKey, "the symlink's target is untouched");
    assert.equal(readFileSync(keptWorkspaceFile, "utf8"), "keep");
    const removal = traceRows(sink).filter((row) => row.name === "daemon.stale_agent_tokens.removed");
    assert.equal(removal.length, 1);
    assert.equal(removal[0]?.attrs?.removed_count, 4);
    assert.equal(removal[0]?.attrs?.skipped_count, 1);
    assert.ok(!JSON.stringify(removal).includes(computerKey) && !JSON.stringify(removal).includes(rootDir), "counts only: no contents, no paths");
  } finally {
    await core?.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore does not re-detect model catalogs on a quick reconnect; rescan always pushes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-throttle-test-"));
  const sockets: FakeWebSocket[] = [];
  let claudeVersion = "2.1.0";
  let core: DaemonCore | null = null;
  const catalogsOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).filter((message) => (message as { type?: string }).type === "machine:runtime_models:catalog");
  const readyOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).some((message) => (message as { type?: string }).type === "ready");

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: ["claude"], versions: { claude: claudeVersion } }),
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
    await waitFor(() => catalogsOn(sockets[0]).length === 1, "catalog on first connect");

    // Quick reconnect, same runtimes and versions: no second detection round.
    sockets[0]?.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    sockets[1]?.emitOpen();
    await waitFor(() => readyOn(sockets[1]), "ready after reconnect");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(catalogsOn(sockets[1]).length, 0, "a reconnect inside the interval must not re-detect");

    // rescan is explicit and always pushes.
    sockets[1]?.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogsOn(sockets[1]).length === 1, "catalog after rescan");

    // A changed runtime version does not lift the start floor: two daemons that
    // share one identity (task #354) can present different inventories on every
    // flap, so a signature change must not become a way around it. rescan (or the
    // next connect after the floor) picks the change up.
    claudeVersion = "2.2.0";
    sockets[1]?.terminate();
    await waitFor(() => sockets.length === 3, "second replacement websocket");
    sockets[2]?.emitOpen();
    await waitFor(() => readyOn(sockets[2]), "ready after the version change");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(catalogsOn(sockets[2]).length, 0, "a version change inside the start floor waits");
    sockets[2]?.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => catalogsOn(sockets[2]).length === 1, "rescan picks the version change up");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconciler step 15 (B12): a detection that differs from live processes' own CLI version is traced once per runtime with a count; nothing restarts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-cli-version-drift-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  const persistent = new FakeDriver({ supportsStdinNotification: true });
  const perTurn = new FakeDriver({ supportsStdinNotification: false });
  const versions: Record<string, string> = { codex: "codex-cli 0.150.0", cursor: "2026.01.01" };
  let manager: AgentProcessManager | null = null;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
    tracer,
    runtimeDetector: () => ({ ids: Object.keys(versions), versions: { ...versions } }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: (runtimeId) => (runtimeId === "cursor" ? perTurn : persistent),
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      });
      return manager;
    },
  });
  const drifts = () => traceRows(sink).filter((row) => row.name === "daemon.agent.cli_version_drift").map((row) => row.attrs);
  const readyCount = (socket: FakeWebSocket) => socket.sent.filter((message) => (message as { type?: string }).type === "ready").length;
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    await waitFor(() => readyCount(socket) === 1, "first ready");
    for (const [agentId, runtime] of [["agent-1", "codex"], ["agent-2", "codex"], ["agent-3", "cursor"]] as const) {
      socket.emitServerMessage({ type: "agent:start", agentId, config: makeConfig({ runtime, sessionId: `session-${agentId}` }), launchId: `launch-${agentId}` });
    }
    await waitFor(() => persistent.children.length === 2 && perTurn.children.length === 1, "three live processes");
    // Each process's own version, as its first turn latches it from the detection then.
    const ap = (agentId: string) => (manager as any).agents.get(agentId);
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) ap(agentId).runtimeCliVersion = versions[ap(agentId).config.runtime];
    assert.deepEqual(manager!.liveRuntimeCliVersions(), [
      { runtime: "codex", version: "codex-cli 0.150.0" },
      { runtime: "codex", version: "codex-cli 0.150.0" },
    ], "a per-turn process has no live session to drift");

    // Same versions: no drift.
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => readyCount(socket) === 2, "ready after a rescan with the same versions");
    assert.deepEqual(drifts(), []);

    // Both CLIs upgraded on disk: one event for codex (two live agents), none for the per-turn runtime.
    versions.codex = "codex-cli 0.163.0";
    versions.cursor = "2026.02.01";
    socket.emitServerMessage({ type: "machine:runtimes:rescan" });
    await waitFor(() => readyCount(socket) === 3, "ready after the upgrade");
    const rows = drifts();
    assert.equal(rows.length, 1, "one event per runtime per detection, not per agent");
    assert.deepEqual(
      { runtime: rows[0]?.runtime, from_version: rows[0]?.from_version, to_version: rows[0]?.to_version, direction: rows[0]?.direction, live_agents: rows[0]?.live_agents, from_versions: rows[0]?.from_versions },
      { runtime: "codex", from_version: "codex-cli 0.150.0", to_version: "codex-cli 0.163.0", direction: "upgrade", live_agents: 2, from_versions: 1 },
    );
    assert.ok(!JSON.stringify(rows).includes("agent-1"), "a count, never agent ids");
    assert.equal(persistent.children.length, 2, "measure only: nothing restarts");
    assert.equal(ap("agent-1").runtimeCliVersion, "codex-cli 0.150.0", "a process keeps its own version");
  } finally {
    // The machine-level version record is written after each detection; let it land before cleanup.
    await (core as any).runtimeCliVersionWrite;
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore starts at most one connect-triggered catalog round per interval even when every round is cut short (task #354 flapping)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-model-catalog-flap-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  const catalogsOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).filter((message) => (message as { type?: string }).type === "machine:runtime_models:catalog");
  const readyOn = (socket: FakeWebSocket | undefined) =>
    (socket?.sent ?? []).some((message) => (message as { type?: string }).type === "ready");

  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      // Two runtimes: the connection drops right after the first frame, so no
      // round ever completes and the completion-based throttle never engages.
      runtimeDetector: () => ({ ids: ["claude", "gemini"], versions: {} }),
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          const send = socket.send.bind(socket);
          socket.send = (data: string) => {
            send(data);
            if ((JSON.parse(data) as { type?: string }).type === "machine:runtime_models:catalog") socket.terminate();
          };
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    sockets[0]?.emitOpen();
    await waitFor(() => catalogsOn(sockets[0]).length === 1, "first round starts");

    for (let flap = 1; flap <= 3; flap += 1) {
      await waitFor(() => sockets.length === flap + 1, `replacement websocket ${flap}`);
      sockets[flap]?.emitOpen();
      await waitFor(() => readyOn(sockets[flap]), `ready after flap ${flap}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(catalogsOn(sockets[flap]).length, 0, `no new round inside the start interval (flap ${flap})`);
      sockets[flap]?.terminate();
    }

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a catalog frame clears a runtime's list only after a sign-in change says it has no models", () => {
  const live: RuntimeModelSourceOutcome = { kind: "live", value: { models: [{ id: "anthropic/opus", label: "Opus · Anthropic" }] } };
  assert.deepEqual(runtimeModelCatalogFrame("pi", live, false), { type: "machine:runtime_models:catalog", runtime: "pi", models: [{ id: "anthropic/opus", label: "Opus · Anthropic" }] });
  assert.deepEqual(runtimeModelCatalogFrame("pi", live, true), { type: "machine:runtime_models:catalog", runtime: "pi", models: [{ id: "anthropic/opus", label: "Opus · Anthropic" }] }, "a list is a list, authoritative or not");
  assert.deepEqual(runtimeModelCatalogFrame("pi", { kind: "no_models" }, true), { type: "machine:runtime_models:catalog", runtime: "pi", models: [], authoritative: true }, "the last provider signed out: the old models go");
  // A routine probe never clears: the server keeps its copy, as before.
  assert.equal(runtimeModelCatalogFrame("pi", { kind: "no_models" }, false), null);
  assert.equal(runtimeModelCatalogFrame("codex", { kind: "no_models" }, false), null);
  // A failed detection says nothing about the models, sign-in change or not.
  assert.equal(runtimeModelCatalogFrame("pi", { kind: "error", retryable: true }, true), null);
  assert.equal(runtimeModelCatalogFrame("pi", { kind: "unsupported" }, true), null);
});

test("sanitizeCatalogModels caps entries, strips control characters and never rewrites ids", () => {
  const many = Array.from({ length: 350 }, (_, index) => ({ id: `m-${index}`, label: `M ${index}` }));
  assert.equal(sanitizeCatalogModels(many).length, 300);
  assert.deepEqual(sanitizeCatalogModels([
    { id: "gpt-5.6-sol", label: " GPT-5.6-Sol\u0007 " },
    { id: "no-label", label: "" },
    { id: "bad\nid", label: "Bad" },
    { id: "", label: "Empty id" },
    { id: "long", label: "x".repeat(200) },
  ]), [
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    { id: "no-label", label: "no-label" },
    { id: "long", label: "x".repeat(80) },
  ]);
});

test("DaemonCore joins overlapping probes: two usage refreshes run the collector once and both requests get the snapshot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-probe-gate-test-"));
  const sockets: FakeWebSocket[] = [];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapshot: RuntimeAccountUsageSnapshot = {
    protocolVersion: 2,
    provider: "kimi",
    collectedAt: "2026-08-01T20:00:00.000Z",
    staleAfter: "2026-08-01T20:30:00.000Z",
    collectorVersion: "test",
    accounts: [],
  };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAccountUsageCollector: async () => {
      calls += 1;
      await gate;
      return snapshot;
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
    for (const requestId of ["usage-overlap-1", "usage-overlap-2"]) {
      socket.emitServerMessage({ type: "machine:runtime_account_usage:refresh", requestId, provider: "kimi", reason: "stale_or_missing" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "the second refresh joins the one already running");
    release();
    const snapshots = () => socket.sent.filter((message) => (message as { type?: string }).type === "machine:runtime_account_usage:snapshot");
    await waitFor(() => snapshots().length === 2, "both snapshots");
    assert.deepEqual(snapshots().map((message) => (message as { requestId?: string }).requestId).sort(), ["usage-overlap-1", "usage-overlap-2"]);
    assert.equal(calls, 1);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore says on ready when the Computer runner cannot reach its service", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-service-ipc-cap-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    onComputerControl: () => {},
    computerControlViaSupervisor: true,
    computerServiceIpcUnreachable: true,
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  try {
    core.start();
    sockets[0]!.emitOpen();
    const ready = sockets[0]!.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready");
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE), true);
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
    assert.equal(ready?.capabilities?.includes(COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE), false, "reachable unless the Computer says otherwise");

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

// 15 s, not 5 s: under CI load (280+ daemon test files in parallel) a real
// spawn through AgentProcessManager has taken longer than 5 s (staging run
// 42447975903, no daemon change since the green run before it). A passing
// wait returns as soon as the predicate holds, so only a failing test waits
// longer; the test timeout is 30 s (vitest.config.ts).
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
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

test("daemon credential-proxy trace contract preserves only typed cutover evidence", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.agent_proxy.request", {
    surface: "daemon",
    kind: "client",
    attrs: {
      agentId: "agent-proxy-contract",
      route_family: "tasks/claim",
      route_path_version: "v2",
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
      body_size_bucket: "10-50MiB",
      response_complete: false,
      failure_class: "mid_response_transport",
      cause_code: "ECONNRESET",
      third_party_ack_mode: "lease",
      third_party_served_count: 2,
      upstream_layer: "tcp",
      target_host_class: "api.raft.build",
      via_http_proxy: true,
      connect_attempted_addresses: 2,
      connect_timed_out_addresses: 1,
      raw_error: "secret body",
    },
  });

  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.agentId, "agent-proxy-contract");
  assert.equal(recorded.attrs?.route_path_version, "v2");
  assert.equal(recorded.attrs?.third_party_ack_mode, "lease");
  assert.equal(recorded.attrs?.third_party_served_count, 2);
  assert.equal(recorded.attrs?.route_family, "tasks/claim");
  assert.equal(recorded.attrs?.method, "POST");
  assert.equal(recorded.attrs?.trace_context_state, "continued");
  assert.equal(recorded.attrs?.proxy_launch_id_present, true);
  assert.equal(recorded.attrs?.correlation_id, "0123456789abcdef");
  assert.equal(recorded.attrs?.outcome, "upstream_5xx");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.normalized_code, "server_5xx");
  assert.equal(recorded.attrs?.response_started, true);
  assert.equal(recorded.attrs?.body_size_bucket, "10-50MiB");
  assert.equal(recorded.attrs?.response_complete, false);
  assert.equal(recorded.attrs?.failure_class, "mid_response_transport");
  assert.equal(recorded.attrs?.cause_code, "ECONNRESET");
  assert.equal(recorded.attrs?.upstream_layer, "tcp");
  assert.equal(recorded.attrs?.target_host_class, "api.raft.build");
  assert.equal(recorded.attrs?.via_http_proxy, true);
  assert.equal(recorded.attrs?.connect_attempted_addresses, 2);
  assert.equal(recorded.attrs?.connect_timed_out_addresses, 1);
  assert.equal(recorded.attrs?.raw_url, undefined);
  assert.equal(recorded.attrs?.raw_error, undefined);
});

test("daemon model detection trace keeps how the read was answered", () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createTraceScopeTracer(tracer, {}, {
    spanAttrContracts: DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  });
  const span = scopedTracer.startSpan("daemon.runtime_models.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: { runtime: "codex", request_id: "req-1", requestId: "dropped" },
  });
  span.end("ok", { attrs: { outcome: "models_returned", models_count: 3, cache: "stale", joined_in_flight: false } });
  const [recorded] = traceRows(sink, traceId);
  assert.equal(recorded.attrs?.request_id, "req-1");
  assert.equal(recorded.attrs?.cache, "stale");
  assert.equal(recorded.attrs?.joined_in_flight, false);
  assert.equal(recorded.attrs?.requestId, undefined);
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

  const [recorded] = traceRows(sink, traceId);
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

  const [recorded] = traceRows(sink, traceId);
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

  const [recorded] = traceRows(sink, traceId);
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
    runtime_session_id_present: true,
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
  // #424: the flag was renamed into the same family as the value it describes,
  // and the bare id is gone (dropped by the sink, no hash form). The fixture
  // still supplies a raw `runtime_session_id` above, so this proves the contract
  // drops it rather than the fixture never providing one.
  assert.equal(failure?.attrs?.runtime_session_id, undefined);
  assert.equal(failure?.attrs?.runtime_session_id_present, true);
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

  const recorded = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.builtin.session.create");
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
      error_class: "MigrationStepResponseError",
      error_code: "MIGRATION_UPLOAD_COMPLETE_FAILED",
      upstream_error_code: "migration_chunks_missing",
      http_status: 503,
      status: 503,
      url: "https://object-store.example.test/bundle?X-Amz-Signature=secret",
      signed_url: "https://object-store.example.test/bundle?token=secret",
      bearer_token: "raft-secret-token",
      bundle_path: "/tmp/raft-agent-migration-upload-secret/bundle.tar.gz",
      raw_response_body: "Migration chunks missing for private workspace /Users/alice",
      unknown_scalar: "must-not-survive",
    },
  });
  span.end("error");

  const recorded = traceRows(sink, traceId).find((candidate) =>
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
  assert.equal(recorded.attrs?.error_class, "MigrationStepResponseError");
  assert.equal(recorded.attrs?.error_code, "MIGRATION_UPLOAD_COMPLETE_FAILED");
  assert.equal(recorded.attrs?.upstream_error_code, "migration_chunks_missing");
  assert.equal(recorded.attrs?.http_status, 503);
  assert.equal(recorded.attrs?.status, undefined);
  assert.equal(recorded.attrs?.url, undefined);
  assert.equal(recorded.attrs?.signed_url, undefined);
  assert.equal(recorded.attrs?.bearer_token, undefined);
  assert.equal(recorded.attrs?.bundle_path, undefined);
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
      req.method === "POST"
      && req.url?.startsWith(`/internal/computer/agent-migrations/by-id/${migrationId}/resumable/stream-chunks/`)
    ) {
      await readRequestBody(req);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, uploaded: true }));
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
      bearerToken: "source-token-must-not-enter-trace",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
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
        const spans = traceRows(sink, traceId);
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
    const failedSpan = traceRows(sink, traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "failed"
      && span.attrs?.stage === "upload_complete"
    );
    assert.ok(failedSpan, "upload-complete conflict must emit a correlated failed span");
    assert.equal(failedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(failedSpan.attrs?.role, "source");
    assert.equal(failedSpan.attrs?.transfer_kind, "upload");
    assert.equal(failedSpan.attrs?.http_status, 409);

    const reportedSpan = traceRows(sink, traceId).find((span) =>
      span.name === "daemon.migration_transport.object_store"
      && span.attrs?.outcome === "transport_lost_reported"
    );
    assert.ok(reportedSpan);
    assert.equal(reportedSpan.attrs?.migration_ref, migrationRef);
    assert.equal(reportedSpan.attrs?.role, "source");
    assert.equal(reportedSpan.attrs?.stage, "transport_lost_report");
    assert.equal(reportedSpan.attrs?.upstream_error_code, undefined);
    const traceFamilyAttrs = traceRows(sink, traceId)
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
  assert.equal(traceFamilyAttrs.length, 4, "transfer, lease, failure, and loss-report rows must all be covered");
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

test("DaemonCore streams a source bundle: each chunk is recorded and uploaded before the control is registered", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-streamed-source-test-"));
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-streamed-source";
  const transportGeneration = "transport-generation-streamed";
  const leaseId = "lease-streamed";
  const events: string[] = [];
  const recorded = new Map<number, { sizeBytes: number; sha256: string }>();
  const stored = new Map<number, Buffer>();
  let registeredControl: Parameters<typeof validateAgentMigrationControlManifest>[0] | null = null;
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const streamChunk = req.url?.match(new RegExp(`^${base}/stream-chunks/(\\d+)$`));
    if (req.method === "POST" && streamChunk) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        migrationGeneration: string;
        leaseId: string;
        sizeBytes: number;
        sha256: string;
      };
      assert.equal(body.migrationGeneration, transportGeneration);
      assert.equal(body.leaseId, leaseId);
      const index = Number(streamChunk[1]);
      recorded.set(index, { sizeBytes: body.sizeBytes, sha256: body.sha256 });
      events.push(`stream:${index}`);
      json(200, { ok: true, uploaded: false, url: `${transferServer.baseUrl}/object-store/chunk-${index}` });
      return;
    }
    const objectPut = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "PUT" && objectPut) {
      const index = Number(objectPut[1]);
      stored.set(index, await readRequestBody(req));
      events.push(`put:${index}`);
      res.statusCode = 200;
      res.setHeader("ETag", `"etag-${index}"`);
      res.end();
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { role: string; etag?: string };
      assert.equal(body.role, "source");
      events.push(`receipt:${receipt[1]}:${body.etag ?? ""}`);
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/control`) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as {
        control: Parameters<typeof validateAgentMigrationControlManifest>[0];
      };
      registeredControl = body.control;
      events.push("control");
      json(200, { controlSha256: validateAgentMigrationControlManifest(body.control).sha256 });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      json(200, { complete: true, migrationGeneration: transportGeneration, leaseId, chunks: [] });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/upload-complete`) {
      await readRequestBody(req);
      events.push("complete");
      json(200, { ok: true, state: "ready" });
      return;
    }
    if (req.method === "POST" && (req.url === `${base}/source-quiesced` || req.url === `${base}/source-progress`)) {
      await readRequestBody(req);
      json(200, { ok: true });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;
  try {
    await mkdir(path.join(dataDir, "agent-streamed"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-streamed", "MEMORY.md"), "streamed source\n");
    await writeFile(path.join(dataDir, "agent-streamed", "payload.bin"), randomBytes(200_000));
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-streamed",
      migrationId,
      migrationRef: "mig_STREAMEDSOURCEAAAAAAAA",
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-streamed",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-streamed",
      targetMachineId: "target-machine-streamed",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => events.includes("complete"), "streamed upload completes");
    assert.deepEqual(events, ["stream:0", "put:0", 'receipt:0:"etag-0"', "control", "complete"]);
    assert.ok(registeredControl);
    const control = registeredControl as Parameters<typeof validateAgentMigrationControlManifest>[0];
    assert.equal(control.archive.entryCount, 2);
    assert.deepEqual(recorded.get(0), {
      sizeBytes: control.bundle.chunks[0]!.sizeBytes,
      sha256: control.bundle.chunks[0]!.sha256,
    });
    assert.equal(createHash("sha256").update(stored.get(0)!).digest("hex"), control.bundle.chunks[0]!.sha256);
    assert.equal(
      existsSync(path.join(dataDir, "migrations")) ? (await readdir(path.join(dataDir, "migrations"), { recursive: true })).some((name) => String(name).endsWith("bundle.tar.gz")) : false,
      false,
      "a streamed bundle is never written to disk",
    );
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * A source run for a lease carrying `userIgnoreAdditions`, against a fake
 * Server that advertises `serverCapabilities`. Returns what the Server saw.
 */
async function runUserIgnoreSourceMigration(input: {
  name: string;
  serverCapabilities: string[];
  prepare: (workspace: string) => Promise<void>;
  paths: string[];
}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `raft-daemon-migration-user-ignore-${input.name}-`));
  const sockets: FakeWebSocket[] = [];
  const migrationId = `migration-user-ignore-${input.name}`;
  const transportGeneration = `transport-generation-user-ignore-${input.name}`;
  const leaseId = `lease-user-ignore-${input.name}`;
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const progressReports: Array<Record<string, unknown>> = [];
  const transportLost: Array<Record<string, unknown>> = [];
  const requested: string[] = [];
  let control: Parameters<typeof validateAgentMigrationControlManifest>[0] | null = null;
  let done = false;
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    requested.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url?.startsWith(`${base}/stream-chunks/`)) {
      await readRequestBody(req);
      json(200, { ok: true, uploaded: true });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/control`) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { control: NonNullable<typeof control> };
      control = body.control;
      json(200, { controlSha256: validateAgentMigrationControlManifest(body.control).sha256 });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      json(200, { complete: true, migrationGeneration: transportGeneration, leaseId, chunks: [] });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/upload-complete`) {
      await readRequestBody(req);
      done = true;
      json(200, { ok: true, state: "ready" });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/source-progress`) {
      progressReports.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === `${base}/source-quiesced`) {
      await readRequestBody(req);
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`) {
      transportLost.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      done = true;
      json(200, { ok: true });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const workspace = path.join(dataDir, "agent-user-ignore");
  let core: DaemonCore | null = null;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "MEMORY.md"), "memory\n");
    await input.prepare(workspace);
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen({ machineContext: false });
    socket.emitServerMessage({
      type: "machine:context",
      machineId: "machine-test",
      serverId: "server-test",
      capabilities: input.serverCapabilities,
    });
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-user-ignore",
      migrationId,
      migrationRef: "mig_USERIGNORESOURCEAAAAAA",
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-user-ignore",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-user-ignore",
      targetMachineId: "target-machine-user-ignore",
      expectedMigrationRevision: 7,
      userIgnoreAdditions: { paths: input.paths, addedBy: "Alice", addedAt: "2026-11-04T08:30:00Z" },
    });
    await waitFor(() => done, "source run ends");
    // A progress report is fire-and-forget; let one in flight land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const userFile = await readFile(path.join(workspace, ".raftbackupignore.user"), "utf8").catch(() => null);
    return { control: control as Parameters<typeof validateAgentMigrationControlManifest>[0] | null, progressReports, transportLost, requested, userFile };
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a source lease's user ignore additions are written before packing, and the receipt goes only to a Server that accepts it", async () => {
  const prepare = async (workspace: string) => {
    await mkdir(path.join(workspace, "data"), { recursive: true });
    await writeFile(path.join(workspace, "data", "big.bin"), randomBytes(4096));
    await writeFile(path.join(workspace, "keep.txt"), "keep\n");
  };
  const receipt = { written: 1, alreadyPresent: 0, rejected: [{ path: "MEMORY.md", reason: "forced_keep" }] };

  const accepting = await runUserIgnoreSourceMigration({
    name: "accepting",
    serverCapabilities: [SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1],
    prepare,
    paths: ["data", "MEMORY.md"],
  });
  assert.deepEqual(accepting.transportLost, []);
  assert.equal(accepting.userFile, "# added by Alice at 2026-11-04T08:30:00.000Z (Raft)\ndata\n");
  assert.deepEqual(accepting.control?.transferSummary.excludedIgnored?.largest, [{ path: "data", bytes: 4096 }]);
  // The bundle carries MEMORY.md, keep.txt and the user file, never data/.
  assert.equal(accepting.control?.archive.entryCount, 3);
  assert.deepEqual(accepting.progressReports[0], {
    migrationGeneration: "transport-generation-user-ignore-accepting",
    phase: "scanning",
    files: 0,
    bytes: 0,
    userIgnoreAdditions: receipt,
  });
  assert.equal(accepting.progressReports.filter((report) => "userIgnoreAdditions" in report).length, 1);

  const older = await runUserIgnoreSourceMigration({ name: "older", serverCapabilities: [], prepare, paths: ["data", "MEMORY.md"] });
  assert.deepEqual(older.transportLost, []);
  assert.equal(older.userFile, accepting.userFile);
  assert.equal(older.control?.archive.entryCount, 3);
  // Exactly as before: no immediate report, and the first throttled one waits out the interval.
  assert.deepEqual(older.progressReports, []);
});

test("a source that cannot write the user ignore additions fails the migration with the reason before it packs", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-user-ignore-outside-"));
  try {
    const target = path.join(outside, "target.txt");
    await writeFile(target, "outside\n");
    const failed = await runUserIgnoreSourceMigration({
      name: "symlink",
      serverCapabilities: [SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1],
      prepare: (workspace) => symlink(target, path.join(workspace, ".raftbackupignore.user")),
      paths: ["data"],
    });
    assert.deepEqual(failed.transportLost, [{
      role: "source",
      transferKind: "upload",
      code: "MIGRATION_USER_IGNORE_WRITE_FAILED",
      transportGeneration: "transport-generation-user-ignore-symlink",
      detailCode: "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink",
      message: "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink",
    }]);
    assert.equal(failed.control, null);
    assert.equal(failed.requested.some((request) => request.includes("/stream-chunks/")), false, "nothing was packed");
    assert.equal(await readFile(target, "utf8"), "outside\n");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("DaemonCore fails a source upload that gets no response from object storage for 5 minutes instead of retrying until the lease expires", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-unreachable-test-"));
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-unreachable";
  const transportGeneration = "transport-generation-unreachable";
  const leaseId = "lease-unreachable";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const byId = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  // Object storage is a closed port: every PUT fails before any HTTP response.
  const closed = await withHttpServer((_req, res) => { res.end(); });
  const unreachableUrl = `${closed.baseUrl}/object-store/chunk-0`;
  await closed.close();
  const transportLost: Array<{ detailCode?: string }> = [];
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url?.startsWith(`${base}/stream-chunks/`)) {
      await readRequestBody(req);
      json(200, { ok: true, uploaded: false, url: unreachableUrl });
      return;
    }
    if (req.method === "POST" && (req.url === `${base}/source-quiesced` || req.url === `${base}/source-progress`)) {
      await readRequestBody(req);
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === `${byId}/transport-lost`) {
      transportLost.push(JSON.parse((await readRequestBody(req)).toString("utf8")));
      json(200, { ok: true });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const { sink, tracer } = makeDeterministicTracer();
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  let core: DaemonCore | null = null;
  try {
    await mkdir(path.join(dataDir, "agent-unreachable"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-unreachable", "MEMORY.md"), "stays on the source\n");
    core = new DaemonCore({
      tracer,
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-unreachable",
      migrationId,
      migrationRef: "mig_UNREACHABLESOURCEAAAAA",
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-unreachable",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-unreachable",
      targetMachineId: "target-machine-unreachable",
      expectedMigrationRevision: 7,
    });

    const uploadRetries = () => traceRows(sink).filter((row) =>
      row.name === "daemon.migration_transport.resumable"
      && row.attrs?.outcome === "retry"
      && row.attrs?.operation === "chunk_upload");
    await waitFor(() => uploadRetries().length > 0, "the first upload attempt fails and is retried");
    assert.equal(uploadRetries()[0]!.attrs?.http_status, null);
    assert.equal(transportLost.length, 0, "a short outage is retried, not reported");
    skewMs = 5 * 60 * 1000;
    await waitFor(() => transportLost.length > 0, "the upload gives up and reports the transport lost");
    assert.equal(transportLost[0]!.detailCode, "MIGRATION_OBJECT_STORE_UNREACHABLE");
  } finally {
    Date.now = realNow;
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unsafeAgentIdOf accepts one path segment and refuses anything that leaves the workspace root", () => {
  for (const ok of ["9d4329f3-67ae-40d0-b705-c184f087e274", "agent-streamed", "a.b"]) {
    assert.equal(unsafeAgentIdOf({ type: "agent:start", agentId: ok }), null, ok);
  }
  assert.equal(unsafeAgentIdOf({ type: "machine:context" }), null, "a message without agentId");
  for (const bad of ["", ".", "..", "../victim", "a/b", "a\\b", "C:victim", "a\0b"]) {
    assert.equal(unsafeAgentIdOf({ type: "agent:reset-workspace", agentId: bad }), bad, JSON.stringify(bad));
  }
  assert.equal(unsafeAgentIdOf({ type: "agent:start", agentId: 7 }), "7");
});

test("DaemonCore refuses a workspace reset whose agentId would reach outside its data directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-unsafe-agent-id-test-"));
  const dataDir = path.join(root, "agents");
  const victim = path.join(root, "victim");
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  let core: DaemonCore | null = null;
  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, "keep.txt"), "not an agent workspace\n");
    await mkdir(path.join(dataDir, "agent-ok"), { recursive: true });
    core = new DaemonCore({
      tracer,
      serverUrl: "http://127.0.0.1:9",
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: root,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({ type: "agent:reset-workspace", agentId: "../victim" });
    socket.emitServerMessage({ type: "agent:reset-workspace", agentId: "agent-ok" });

    await waitFor(() => !existsSync(path.join(dataDir, "agent-ok")), "a well-formed reset still runs");
    assert.ok(existsSync(path.join(victim, "keep.txt")), "the directory outside dataDir is untouched");
    const refused = traceRows(sink).filter((row) => row.name === "daemon.server_message.unsafe_agent_id");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.attrs?.message_type, "agent:reset-workspace");
  } finally {
    if (core) await core.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("DaemonCore never sends a migration control request, or its machine key, to an origin other than its server", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-cross-origin-test-"));
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-cross-origin";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const foreignRequests: Array<{ url?: string; authorization?: string }> = [];
  const foreign = await withHttpServer(async (req, res) => {
    foreignRequests.push({ url: req.url, authorization: req.headers.authorization });
    await readRequestBody(req);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  const transportLost: Array<{ detailCode?: string }> = [];
  const server = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/transport-lost`) {
      transportLost.push(JSON.parse((await readRequestBody(req)).toString("utf8")));
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
    await mkdir(path.join(dataDir, "agent-cross-origin"), { recursive: true });
    await writeFile(path.join(dataDir, "agent-cross-origin", "MEMORY.md"), "stays on the source\n");
    core = new DaemonCore({
      serverUrl: server.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-cross-origin",
      migrationId,
      migrationRef: "mig_CROSSORIGINSOURCEAAAAA",
      migrationGeneration: `agent_migration:${migrationId}:7`,
      sessionId: "session-cross-origin",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: `${foreign.baseUrl}${base}`,
      leaseId: "lease-cross-origin",
      transportGeneration: "transport-generation-cross-origin",
      sourceMachineId: "source-machine-cross-origin",
      targetMachineId: "target-machine-cross-origin",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => transportLost.length > 0, "the transfer is refused and reported to the Computer's own server");
    assert.equal(transportLost[0]!.detailCode, "MIGRATION_CONTROL_URL_CROSS_ORIGIN");
    assert.deepEqual(foreignRequests, [], "nothing, and no machine key, reached the other origin");
  } finally {
    if (core) await core.stop();
    await foreign.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore downloads target chunks three at a time, imports the bundle and drives start-transfer, flip-machine and arrived by migration id", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-target-import-test-"));
  const sourceWorkspace = path.join(dataDir, "source-workspace");
  const sockets: FakeWebSocket[] = [];
  const agentId = "agent-target-import";
  const migrationId = "migration-target-import";
  const migrationRef = "mig_TARGETIMPORTAAAAAAAAAA";
  const migrationGeneration = `agent_migration:${migrationId}:7`;
  const transportGeneration = "transport-generation-target-import";
  const leaseId = "lease-target-import";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const byId = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  await mkdir(sourceWorkspace, { recursive: true });
  await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "arrived on target\n");
  // Incompressible, so the bundle spans several 1 MiB chunks.
  await writeFile(path.join(sourceWorkspace, "payload.bin"), randomBytes(5 * 1024 * 1024));
  const chunks = new Map<number, Buffer>();
  const bundle = await streamAgentMigrationResumableBundle({
    agentId,
    migrationId,
    migrationGeneration: transportGeneration,
    leaseId,
    sourceMachineId: "source-machine-target-import",
    targetMachineId: "target-machine-target-import",
    workspacePath: sourceWorkspace,
    maxBytes: 104857600,
    chunkSizeBytes: 1024 * 1024,
    async uploadChunk(chunk, bytes) {
      chunks.set(chunk.index, Buffer.from(bytes));
    },
  });
  assert.ok(bundle.control.bundle.chunks.length >= 5);
  const receipted = new Set<number>();
  let downloadsInFlight = 0;
  let maxDownloadsInFlight = 0;
  const steps: Array<{ step: string; body: Record<string, unknown> }> = [];
  const view = (state: string) => ({
    migrationId,
    migrationRef,
    migrationGeneration,
    state,
    sourceMachineId: "source-machine-target-import",
    targetMachineId: "target-machine-target-import",
    agentId,
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  });
  const stepStates: Record<string, string> = { "start-transfer": "in_transit", "flip-machine": "in_transit", arrived: "arrived" };
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith(`${base}/control?`)) {
      json(200, { control: bundle.control, controlSha256: bundle.controlSha256, uploadComplete: true });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      const missing = bundle.control.bundle.chunks.filter((chunk) => !receipted.has(chunk.index));
      json(200, {
        complete: missing.length === 0,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: missing.map((chunk) => ({
          index: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          method: "GET",
          url: `${transferServer.baseUrl}/object-store/chunk-${chunk.index}`,
        })),
      });
      return;
    }
    const objectGet = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "GET" && objectGet) {
      downloadsInFlight += 1;
      maxDownloadsInFlight = Math.max(maxDownloadsInFlight, downloadsInFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      downloadsInFlight -= 1;
      res.statusCode = 200;
      res.end(chunks.get(Number(objectGet[1])));
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      const body = JSON.parse((await readRequestBody(req)).toString("utf8")) as { role: string };
      assert.equal(body.role, "target");
      receipted.add(Number(receipt[1]));
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "GET" && req.url === byId) {
      json(200, { migration: view("ready") });
      return;
    }
    const step = req.url?.startsWith(`${byId}/`) ? req.url.slice(byId.length + 1) : null;
    if (req.method === "POST" && step && step in stepStates) {
      steps.push({ step, body: JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown> });
      json(200, { migration: view(stepStates[step]!) });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const { sink, tracer } = makeDeterministicTracer();
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      tracer,
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef,
      migrationGeneration,
      sessionId: "session-target-import",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-target-import",
      targetMachineId: "target-machine-target-import",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => steps.some((entry) => entry.step === "arrived"), "target import reports arrival");
    assert.deepEqual(steps.map((entry) => entry.step), ["start-transfer", "flip-machine", "arrived"]);
    assert.deepEqual(steps.map((entry) => entry.body.migrationGeneration), [migrationGeneration, migrationGeneration, migrationGeneration]);
    assert.equal(typeof steps[2]!.body.reportSha256, "string");
    assert.equal(await readFile(path.join(dataDir, agentId, "MEMORY.md"), "utf8"), "arrived on target\n");
    assert.equal(receipted.size, bundle.control.bundle.chunks.length);
    assert.equal(maxDownloadsInFlight, 3, "chunks download three at a time");

    // The transfer span ends after the arrival request returns.
    await waitFor(
      () => traceRows(sink).some((row) => row.name === "daemon.migration_transport.transfer"),
      "transfer span ends",
    );
    const rows = traceRows(sink);
    const transfer = rows.find((row) => row.name === "daemon.migration_transport.transfer");
    assert.ok(transfer);
    assert.equal(transfer.attrs?.download_concurrency, 3);
    const placement = rows.filter((row) => row.name === "daemon.migration_transport.placement");
    assert.deepEqual(placement.map((row) => row.attrs?.stage), ["verify", "unpack", "commit"]);
    for (const row of placement) {
      assert.equal(row.context.parentSpanId, transfer.context.spanId, "each local step is a child of the transfer span");
      assert.equal(row.status, "ok");
      assert.equal(row.attrs?.migration_ref, migrationRef);
      assert.equal(row.attrs?.role, "target");
      assert.equal(row.attrs?.chunk_count, bundle.control.bundle.chunks.length);
      assert.equal(row.attrs?.file_count, 2);
      assert.equal(row.attrs?.expanded_bytes, bundle.control.archive.expandedBytes);
    }
    const timing = rows.filter((row) =>
      row.name === "daemon.migration_transport.resumable"
      && (row.attrs?.outcome === "control_received" || row.attrs?.outcome === "chunks_downloaded"));
    assert.deepEqual(
      timing.map((row) => [row.attrs?.stage, row.attrs?.outcome]),
      [["control_wait", "control_received"], ["chunk_download", "chunks_downloaded"]],
      "control wait and download are timed on the target's own clock, in order",
    );
    for (const row of timing) {
      assert.equal(row.context.parentSpanId, transfer.context.spanId, "timing events attach to the transfer span");
      assert.equal(row.attrs?.chunk_count, bundle.control.bundle.chunks.length);
      assert.equal(typeof row.attrs?.duration_ms, "number");
      assert.ok((row.attrs?.duration_ms as number) >= 0);
    }

    // Arrived and flipped: the compressed workspace copy is gone, the report stays.
    const committed = rows.find((row) =>
      row.name === "daemon.migration_transport.resumable" && row.attrs?.outcome === "committed");
    assert.equal(committed?.attrs?.chunks_removed, true);
    assert.equal(
      committed?.attrs?.chunks_freed_bytes,
      bundle.control.bundle.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0),
    );
    const leftover = (await readdir(path.join(dataDir, "migrations"), { recursive: true }))
      .map((entry) => path.basename(String(entry)));
    assert.ok(leftover.includes("arrival-report-v2.json"));
    assert.ok(!leftover.some((name) => name === "chunks" || name.endsWith(".chunk") || name.startsWith("extracting-")));
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore keeps one target control wait, without resetting its backoff, when the same lease is re-sent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-control-wait-resend-test-"));
  const sockets: FakeWebSocket[] = [];
  const migrationId = "migration-control-wait-resend";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  let controlPolls = 0;
  const pollTimes: number[] = [];
  let ended = false;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith(`${base}/control?role=target`)) {
      controlPolls += 1;
      pollTimes.push(performance.now());
      res.statusCode = ended ? 410 : 409;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(ended
        ? { code: "MIGRATION_TRANSFER_ENDED" }
        : { code: "MIGRATION_CONTROL_MANIFEST_MISSING" }));
      return;
    }
    if (req.method === "POST") await readRequestBody(req);
    res.statusCode = 404;
    res.end("not found");
  });
  const lease = {
    type: "machine:migration_transport:lease" as const,
    agentId: "agent-control-wait-resend",
    migrationId,
    migrationRef: "mig_CONTROLWAITRESENDAAAAA",
    migrationGeneration: `agent_migration:${migrationId}:4`,
    sessionId: "session-control-wait-resend",
    provider: "object_store" as const,
    leaseSource: "server" as const,
    role: "target" as const,
    transferKind: "download" as const,
    bearerToken: "target-token",
    expiresAt: "2999-07-09T13:00:00.000Z",
    maxBytes: 104857600,
    controlUrl: base,
    leaseId: "lease-control-wait-resend",
    transportGeneration: "transport-generation-control-wait-resend",
    sourceMachineId: "source-machine-control-wait-resend",
    targetMachineId: "target-machine-control-wait-resend",
    expectedMigrationRevision: 4,
  };
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage(lease);

    // Polls 1..6 sleep 25, 50, 100, 200, 400 ms between them; after the sixth
    // the loop sleeps 800 ms.
    await waitFor(() => controlPolls >= 6, "target polls the control six times");
    const pollsBeforeResend = controlPolls;
    for (let i = 0; i < 3; i += 1) socket.emitServerMessage({ ...lease });

    // 410 still stops the wait.
    ended = true;
    await waitFor(() => controlPolls > pollsBeforeResend, "the backed-off poll sees 410");
    // Timers only ever fire late, so a slow runner can only widen these gaps:
    // a second wait or a restarted backoff would poll within ~25-50 ms.
    const gapsAfterResend = pollTimes.slice(pollsBeforeResend - 1).map((at, i, all) => (i === 0 ? Infinity : at - all[i - 1]!));
    assert.ok(
      gapsAfterResend.every((gap) => gap >= 400),
      `a re-sent lease neither starts a second control wait nor restarts the backoff at 25 ms (gaps ${gapsAfterResend.slice(1).map(Math.round).join(", ")} ms)`,
    );
    const pollsAtEnd = controlPolls;
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.equal(controlPolls, pollsAtEnd, "no poll after 410");
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore retries a target chunk whose connection drops mid-body instead of failing the migration", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-body-retry-test-"));
  const sourceWorkspace = path.join(dataDir, "source-workspace");
  const sockets: FakeWebSocket[] = [];
  const agentId = "agent-body-retry";
  const migrationId = "migration-body-retry";
  const migrationRef = "mig_BODYRETRYAAAAAAAAAAAAA";
  const migrationGeneration = `agent_migration:${migrationId}:7`;
  const transportGeneration = "transport-generation-body-retry";
  const leaseId = "lease-body-retry";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const byId = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  await mkdir(sourceWorkspace, { recursive: true });
  await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "arrived after a dropped chunk\n");
  await writeFile(path.join(sourceWorkspace, "payload.bin"), randomBytes(3 * 1024 * 1024));
  const chunks = new Map<number, Buffer>();
  const bundle = await streamAgentMigrationResumableBundle({
    agentId,
    migrationId,
    migrationGeneration: transportGeneration,
    leaseId,
    sourceMachineId: "source-machine-body-retry",
    targetMachineId: "target-machine-body-retry",
    workspacePath: sourceWorkspace,
    maxBytes: 104857600,
    chunkSizeBytes: 1024 * 1024,
    async uploadChunk(chunk, bytes) {
      chunks.set(chunk.index, Buffer.from(bytes));
    },
  });
  const receipted = new Set<number>();
  const getsByChunk = new Map<number, number>();
  const steps: string[] = [];
  const transportLost: unknown[] = [];
  const view = (state: string) => ({
    migrationId,
    migrationRef,
    migrationGeneration,
    state,
    sourceMachineId: "source-machine-body-retry",
    targetMachineId: "target-machine-body-retry",
    agentId,
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  });
  const stepStates: Record<string, string> = { "start-transfer": "in_transit", "flip-machine": "in_transit", arrived: "arrived" };
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith(`${base}/control?`)) {
      json(200, { control: bundle.control, controlSha256: bundle.controlSha256, uploadComplete: true });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      const missing = bundle.control.bundle.chunks.filter((chunk) => !receipted.has(chunk.index));
      json(200, {
        complete: missing.length === 0,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: missing.map((chunk) => ({
          index: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          method: "GET",
          url: `${transferServer.baseUrl}/object-store/chunk-${chunk.index}`,
        })),
      });
      return;
    }
    const objectGet = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "GET" && objectGet) {
      const index = Number(objectGet[1]);
      const gets = (getsByChunk.get(index) ?? 0) + 1;
      getsByChunk.set(index, gets);
      const body = chunks.get(index)!;
      if (index === 0 && gets === 1) {
        // Headers and half the bytes arrive, then the connection drops.
        res.statusCode = 200;
        res.setHeader("Content-Length", String(body.byteLength));
        res.flushHeaders();
        res.write(body.subarray(0, Math.floor(body.byteLength / 2)));
        await new Promise((resolve) => setTimeout(resolve, 200));
        res.socket?.destroy();
        return;
      }
      res.statusCode = 200;
      res.end(body);
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      await readRequestBody(req);
      receipted.add(Number(receipt[1]));
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "POST" && req.url === `${byId}/transport-lost`) {
      transportLost.push(JSON.parse((await readRequestBody(req)).toString("utf8")));
      json(200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === byId) {
      json(200, { migration: view("ready") });
      return;
    }
    const step = req.url?.startsWith(`${byId}/`) ? req.url.slice(byId.length + 1) : null;
    if (req.method === "POST" && step && step in stepStates) {
      await readRequestBody(req);
      steps.push(step);
      json(200, { migration: view(stepStates[step]!) });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const { sink, tracer } = makeDeterministicTracer();
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      tracer,
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef,
      migrationGeneration,
      sessionId: "session-body-retry",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-body-retry",
      targetMachineId: "target-machine-body-retry",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => steps.includes("arrived") || transportLost.length > 0, "target import finishes");
    assert.deepEqual(transportLost, [], "a dropped body is retried, not reported as transport lost");
    assert.deepEqual(steps, ["start-transfer", "flip-machine", "arrived"]);
    assert.equal(getsByChunk.get(0), 2, "the dropped chunk is fetched again");
    assert.equal(await readFile(path.join(dataDir, agentId, "MEMORY.md"), "utf8"), "arrived after a dropped chunk\n");
    const retries = traceRows(sink).filter((row) =>
      row.name === "daemon.migration_transport.resumable"
      && row.attrs?.outcome === "retry"
      && row.attrs?.http_status === 200);
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.attrs?.operation, "chunk_download");
    assert.equal(retries[0]!.attrs?.attempt, 1);
  } finally {
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore fails a target chunk at once on a local file-system error instead of retrying it", async (ctx) => {
  // Root ignores directory permissions, so EACCES cannot be produced.
  if (process.getuid?.() === 0) ctx.skip();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-local-error-test-"));
  const sourceWorkspace = path.join(dataDir, "source-workspace");
  const sockets: FakeWebSocket[] = [];
  const agentId = "agent-local-error";
  const migrationId = "migration-local-error";
  const migrationRef = "mig_LOCALERRRAAAAAAAAAAAAA";
  const migrationGeneration = `agent_migration:${migrationId}:7`;
  const transportGeneration = "transport-generation-local-error";
  const leaseId = "lease-local-error";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`;
  const byId = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  await mkdir(sourceWorkspace, { recursive: true });
  await writeFile(path.join(sourceWorkspace, "MEMORY.md"), "never arrives\n");
  await writeFile(path.join(sourceWorkspace, "payload.bin"), randomBytes(3 * 1024 * 1024));
  const chunks = new Map<number, Buffer>();
  const bundle = await streamAgentMigrationResumableBundle({
    agentId,
    migrationId,
    migrationGeneration: transportGeneration,
    leaseId,
    sourceMachineId: "source-machine-local-error",
    targetMachineId: "target-machine-local-error",
    workspacePath: sourceWorkspace,
    maxBytes: 104857600,
    chunkSizeBytes: 1024 * 1024,
    async uploadChunk(chunk, bytes) {
      chunks.set(chunk.index, Buffer.from(bytes));
    },
  });
  const receipted = new Set<number>();
  const getsByChunk = new Map<number, number>();
  const steps: string[] = [];
  const lockedDirs: string[] = [];
  const transportLost: unknown[] = [];
  const view = (state: string) => ({
    migrationId,
    migrationRef,
    migrationGeneration,
    state,
    sourceMachineId: "source-machine-local-error",
    targetMachineId: "target-machine-local-error",
    agentId,
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  });
  const stepStates: Record<string, string> = { "start-transfer": "in_transit", "flip-machine": "in_transit", arrived: "arrived" };
  const transferServer = await withHttpServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url?.startsWith(`${base}/control?`)) {
      json(200, { control: bundle.control, controlSha256: bundle.controlSha256, uploadComplete: true });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith(`${base}/chunks?`)) {
      const missing = bundle.control.bundle.chunks.filter((chunk) => !receipted.has(chunk.index));
      json(200, {
        complete: missing.length === 0,
        migrationGeneration: transportGeneration,
        leaseId,
        chunks: missing.map((chunk) => ({
          index: chunk.index,
          sizeBytes: chunk.sizeBytes,
          sha256: chunk.sha256,
          method: "GET",
          url: `${transferServer.baseUrl}/object-store/chunk-${chunk.index}`,
        })),
      });
      return;
    }
    const objectGet = req.url?.match(/^\/object-store\/chunk-(\d+)$/);
    if (req.method === "GET" && objectGet) {
      const index = Number(objectGet[1]);
      const gets = (getsByChunk.get(index) ?? 0) + 1;
      getsByChunk.set(index, gets);
      const body = chunks.get(index)!;
      // The target cannot write into its chunks folder (like a full or
      // read-only disk): retrying the download can never help.
      for (const migrationDir of await readdir(path.join(dataDir, "migrations")).catch(() => [])) {
        const migrationPath = path.join(dataDir, "migrations", migrationDir);
        for (const generationDir of await readdir(migrationPath).catch(() => [])) {
          const chunksDir = path.join(migrationPath, generationDir, "chunks");
          await mkdir(chunksDir, { recursive: true });
          await chmod(chunksDir, 0o500);
          lockedDirs.push(chunksDir);
        }
      }
      res.statusCode = 200;
      res.end(body);
      return;
    }
    const receipt = req.url?.match(new RegExp(`^${base}/chunks/(\\d+)/receipt$`));
    if (req.method === "POST" && receipt) {
      await readRequestBody(req);
      receipted.add(Number(receipt[1]));
      json(200, { ok: true, outcome: "recorded" });
      return;
    }
    if (req.method === "POST" && req.url === `${byId}/transport-lost`) {
      transportLost.push(JSON.parse((await readRequestBody(req)).toString("utf8")));
      json(200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === byId) {
      json(200, { migration: view("ready") });
      return;
    }
    const step = req.url?.startsWith(`${byId}/`) ? req.url.slice(byId.length + 1) : null;
    if (req.method === "POST" && step && step in stepStates) {
      await readRequestBody(req);
      steps.push(step);
      json(200, { migration: view(stepStates[step]!) });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const { sink, tracer } = makeDeterministicTracer();
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      tracer,
      serverUrl: transferServer.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
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
    assert.ok(socket);
    socket.emitOpen();
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId,
      migrationId,
      migrationRef,
      migrationGeneration,
      sessionId: "session-local-error",
      provider: "object_store",
      leaseSource: "server",
      role: "target",
      transferKind: "download",
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: base,
      leaseId,
      transportGeneration,
      sourceMachineId: "source-machine-local-error",
      targetMachineId: "target-machine-local-error",
      expectedMigrationRevision: 7,
    });

    await waitFor(() => steps.includes("arrived") || transportLost.length > 0, "target import finishes");
    assert.ok(lockedDirs.length > 0, "the chunks folder was made read-only");
    assert.ok(!steps.includes("arrived"));
    assert.equal(transportLost.length, 1, "the local error is reported as a failure");
    for (const [index, gets] of getsByChunk) {
      assert.equal(gets, 1, `chunk ${index} is downloaded once, not retried`);
    }
    const bodyRetries = traceRows(sink).filter((row) =>
      row.name === "daemon.migration_transport.resumable"
      && row.attrs?.outcome === "retry"
      && row.attrs?.operation === "chunk_download");
    assert.deepEqual(bodyRetries, []);
  } finally {
    for (const dir of lockedDirs) await chmod(dir, 0o700).catch(() => undefined);
    if (core) await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
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
      bearerToken: "source-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-a/resumable",
      leaseId: "lease-a",
      transportGeneration: "transport-generation-a",
      sourceMachineId: "source-machine-a",
      targetMachineId: "target-machine-a",
      expectedMigrationRevision: 1,
    });
    await waitFor(
      () => traceRows(sink, traceId).filter((span) =>
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
      bearerToken: "target-token-not-traced",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-b/resumable",
      leaseId: "lease-b",
      transportGeneration: "transport-generation-b",
      sourceMachineId: "source-machine-b",
      targetMachineId: "target-machine-b",
      expectedMigrationRevision: 1,
    });
    await waitFor(
      () => traceRows(sink, traceId).filter((span) =>
        span.name === "daemon.migration_transport.lease" && span.attrs?.outcome === "applied"
      ).length === 2,
      "target B lease trace",
    );
    await waitFor(
      () => transportLostUrls.some((url) => url.includes("/by-id/migration-b/transport-lost")),
      "target B transport-loss completion",
    );

    const appliedLeaseTuples = traceRows(sink, traceId)
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
    const span = traceRows(sink, traceId).find((candidate) => candidate.name === "daemon.runtime.detect");
    assert.equal(span?.attrs?.known_runtime_count, 15);
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

test("detectRuntimes carries the structured not_installed reason for runtimes missing from PATH", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-detect-missing-"));
  const emptyBin = path.join(tmp, "bin");
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  try {
    await mkdir(emptyBin, { recursive: true });
    // Only the locator itself on PATH, so `which grok` runs and reports a miss.
    await symlink(execFileSync("which", ["which"], { encoding: "utf8" }).trim(), path.join(emptyBin, "which"));
    process.env.PATH = emptyBin;
    process.env.HOME = tmp;
    const detection = detectRuntimes();
    assert.equal(detection.ids.includes("grok"), false);
    assert.equal(detection.unavailableReasons?.grok, "not_installed");
    assert.equal(detection.diagnostics?.grok, "No Grok Build CLI was found on PATH.");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detectRuntimes reports an OAR-only runtime (Qwen Code, Qoder, CodeBuddy Code) only where the OAR host runs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-detect-oar-only-"));
  const binDir = path.join(tmp, "bin");
  const oldPath = process.env.PATH;
  const oldDisabled = process.env.RAFT_DAEMON_OAR_HOST_DISABLED;
  try {
    await mkdir(binDir, { recursive: true });
    for (const binary of ["qwen", "qodercli", "codebuddy"]) {
      await writeFile(path.join(binDir, binary), "#!/bin/sh\necho '0.4.0'\n", "utf8");
      await chmod(path.join(binDir, binary), 0o755);
    }
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    delete process.env.RAFT_DAEMON_OAR_HOST_DISABLED;
    const enabled = detectRuntimes();
    assert.equal(enabled.ids.includes("qwen"), true);
    assert.equal(enabled.ids.includes("qoder"), true);
    assert.equal(enabled.ids.includes("codebuddy"), true, "found as `codebuddy` on PATH");
    assert.equal(enabled.versions.qwen, "0.4.0");
    process.env.RAFT_DAEMON_OAR_HOST_DISABLED = "1";
    const disabled = detectRuntimes();
    assert.equal(disabled.ids.includes("qwen"), false, "nothing could run it");
    assert.equal(disabled.ids.includes("qoder"), false);
    assert.equal(disabled.ids.includes("codebuddy"), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldDisabled === undefined) delete process.env.RAFT_DAEMON_OAR_HOST_DISABLED;
    else process.env.RAFT_DAEMON_OAR_HOST_DISABLED = oldDisabled;
    await rm(tmp, { recursive: true, force: true });
  }
});

// Deprecation hides Copilot from new-agent / setup / detection-display surfaces
// (shared catalog helpers), but the daemon must keep REPORTING it: the server's
// existing-agent admission needs capabilityStatus "available" for a current
// copilot agent to stay editable and launchable.
test("detectRuntimes still reports deprecated Copilot when its CLI is on PATH", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "slock-runtime-detect-copilot-"));
  const binDir = path.join(tmp, "bin");
  const oldPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const copilotBin = path.join(binDir, "copilot");
    await writeFile(copilotBin, "#!/bin/sh\necho '1.0.0'\n", "utf8");
    await chmod(copilotBin, 0o755);

    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    assert.equal(isRuntimeDeprecated("copilot"), true);
    assert.equal(detectRuntimes().ids.includes("copilot"), true);
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
      computerBuildSha: "0570bc5395d3",
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

    const readySpan = traceRows(sink, traceId).find((span) => span.name === "daemon.ready.sent");
    assert.ok(readySpan);
    assert.equal(readySpan.attrs?.daemon_version, "0.55.6");
    assert.equal(readySpan.attrs?.daemon_version_present, true);
    assert.equal(readySpan.attrs?.computer_version, "0.0.23");
    assert.equal(readySpan.attrs?.computer_version_present, true);
    assert.equal(readySpan.attrs?.computer_build_sha, "0570bc5395d3");

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

test("task #917: DaemonCore settles a refused remote upgrade with computer:upgrade:done instead of waiting for a reconnect", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-refused-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: async (action) => {
        if (action === "upgrade") {
          throw new Error("UPGRADE_START_REJECTED: The Computer service runs under systemd unit raft-computer.service with KillMode=control-group. Set `KillMode=process`.");
        }
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
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-917", operationId: "upgrade-917", targetVersion: "9.9.9" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      socket.sent.find((message) => (message as { type?: string }).type === "computer:upgrade:done"),
      {
        type: "computer:upgrade:done",
        requestId: "upgrade-917",
        ok: false,
        code: "upgrade_start_rejected",
        reason: "UPGRADE_START_REJECTED: The Computer service runs under systemd unit raft-computer.service with KillMode=control-group. Set `KillMode=process`.",
      },
    );
    assert.equal(socket.sent.some((message) => (message as { type?: string }).type === "computer:restart:done"), false);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task #917: every upgrade control failure settles the request, not only the supervisor refusal", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-failed-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    const failures = [
      "CONTROL_BUSY: upgrade req-a is already in flight",
      "IPC_PROTOCOL_HANDSHAKE_FAILED: unable to connect to /home/x/.raft/computer/run/service.sock",
      "UPGRADE_INSTALLER_FAILED: owned by another package manager",
    ];
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: async () => { throw new Error(failures.shift() ?? "unexpected"); },
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
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-busy", operationId: "upgrade-busy" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-ipc", operationId: "upgrade-ipc" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-held", operationId: "upgrade-held" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const done = socket.sent.filter((message) => (message as { type?: string }).type === "computer:upgrade:done") as Array<{ requestId: string; ok: boolean; code?: string }>;
    assert.deepEqual(done.map((m) => [m.requestId, m.ok, m.code]), [
      ["upgrade-busy", false, "control_busy"],
      ["upgrade-ipc", false, "computer_control_failed"],
      ["upgrade-held", false, "upgrade_installer_failed"],
    ]);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Reconciler step 13 (PR 3): the Server's `drain` reaches the Computer's
// upgrade relay clamped, only on a runner with the drain channel; without it
// (an old Server) the relay sees exactly what it saw before.
// RED proof: drop `...(drain ? { drain } : {})` and the first upgrade's
// context has no drain.
test("step 13: a computer:upgrade with drain hands the clamped drain to the relay; without drain, or on a runner without the channel, none", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-drain-test-"));
  const run = async (withChannel: boolean, messages: ServerToMachineMessage[]) => {
    const sockets: FakeWebSocket[] = [];
    const contexts: ComputerControlContext[] = [];
    const core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      onComputerControl: async (_action, ctx) => { contexts.push(ctx); },
      ...(withChannel ? { computerUpgradeDrainPaths: { requestPath: path.join(dataDir, "upgrade-drain.json"), statePath: path.join(dataDir, "upgrade-drain-state.json") } } : {}),
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
      sockets[0]!.emitOpen();
      const ready = () => sockets[0]!.sent.find((message) => (message as { type?: string }).type === "ready") as { capabilities?: string[] } | undefined;
      await waitFor(() => ready() !== undefined, "ready");
      for (const message of messages) sockets[0]!.emitServerMessage(message);
      await waitFor(() => contexts.length === messages.length, "relayed");
      return { contexts, capabilities: ready()!.capabilities ?? [] };
    } finally {
      await core.stop();
    }
  };
  try {
    const managed = await run(true, [
      { type: "computer:upgrade", requestId: "up-1", operationId: "up-1", targetVersion: "9.9.9", drain: { deadlineMs: 60 * 60_000 } },
      { type: "computer:upgrade", requestId: "up-2", operationId: "up-2", targetVersion: "9.9.9" },
      { type: "computer:upgrade", requestId: "up-3", operationId: "up-3", targetVersion: "9.9.9", drain: { deadlineMs: -1 } },
    ]);
    assert.ok(managed.capabilities.includes(DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1));
    assert.deepEqual(managed.contexts.map((ctx) => [ctx.requestId, ctx.drain]), [
      ["up-1", { deadlineMs: COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS }],
      ["up-2", undefined],
      ["up-3", undefined],
    ]);
    const raw = await run(false, [
      { type: "computer:upgrade", requestId: "up-4", operationId: "up-4", targetVersion: "9.9.9", drain: { deadlineMs: 60_000 } },
    ]);
    assert.equal(raw.capabilities.includes(DAEMON_CAPABILITY_COMPUTER_UPGRADE_DRAIN_V1), false);
    assert.equal(raw.contexts[0]!.drain, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Tenny f8ae3b79 condition 2, through the core: the drain the service's
// request began is let go when the Server connection comes back.
// RED proof: drop `this.upgradeDrain?.onConnected()` in handleConnect and no
// `reconnected` release is recorded.
test("step 13: a drain begun from the service's request ends on a re-established Server connection", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-drain-reconnect-test-"));
  const sockets: FakeWebSocket[] = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const requestPath = path.join(dataDir, "upgrade-drain.json");
  const statePath = path.join(dataDir, "upgrade-drain-state.json");
  let core: DaemonCore | null = null;
  const named = (name: string) => events.filter((event) => event.name === name);
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      computerUpgradeDrainPaths: { requestPath, statePath },
      connectionOptions: {
        minReconnectDelayMs: 1,
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    const record = (core as any).recordDaemonEvent.bind(core);
    (core as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
      events.push({ name, attrs });
      return record(name, attrs, ...rest);
    };
    core.start();
    sockets[0]!.emitOpen();
    await writeFile(requestPath, JSON.stringify({ formatVersion: 1, requestId: "up-r", origin: true, deadlineAtMs: Date.now() + 60_000, servicePid: process.pid }));
    await waitFor(() => named("daemon.computer_upgrade.drain.began").length === 1, "the drain begins at the next poll");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { requestId: string; finished?: string };
    assert.equal(state.requestId, "up-r");
    await waitFor(() => sockets[0]!.sent.some((message) => (message as { type?: string }).type === "computer:upgrade:draining"), "the origin runner reports it");
    sockets[0]!.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    sockets[1]!.emitOpen();
    await waitFor(() => named("daemon.computer_upgrade.drain.released").length === 1, "released");
    assert.equal(named("daemon.computer_upgrade.drain.released")[0]!.attrs.reason, "reconnected");
    assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { finished?: string }).finished, "quiet", "no agents: it had finished quiet, which the service already read");
    assert.equal((core as any).upgradeDrain.activeRequestId, null);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(named("daemon.computer_upgrade.drain.began").length, 1, "not begun again for the same request");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task #34: ready carries the Computer's installer repair hint; a change after a failed upgrade is sent once, newest read last", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-installer-repair-hint-test-"));
  const sockets: FakeWebSocket[] = [];
  const HINT = { reason: "unrecovered_operation" as const };
  // Reads after ready: the first is slow and sees no hint, the second is fast
  // and sees the hint again. Serialized, the newer read is the one left standing.
  const reads: Array<{ delayMs: number; hint: typeof HINT | null }> = [{ delayMs: 40, hint: null }, { delayMs: 0, hint: HINT }];
  let core: DaemonCore | null = null;
  try {
    let readyRead = true;
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerInstallerRepairHint: async () => {
        if (readyRead) { readyRead = false; return HINT; }
        const read = reads.shift() ?? { delayMs: 0, hint: HINT };
        await new Promise<void>((resolve) => setTimeout(resolve, read.delayMs));
        return read.hint;
      },
      onComputerControl: async () => {
        throw new Error("UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.");
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
    const ready = () => socket.sent.find((message) => (message as { type?: string }).type === "ready") as { installerRepairHint?: unknown } | undefined;
    for (let i = 0; i < 20 && !ready(); i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(ready()?.installerRepairHint, HINT);
    const changes = () => socket.sent.filter((message) => (message as { type?: string }).type === "machine:installer_repair_hint");
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-a", operationId: "upgrade-a" });
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-b", operationId: "upgrade-b" });
    for (let i = 0; i < 40 && changes().length < 2; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(changes(), [
      { type: "machine:installer_repair_hint", hint: null },
      { type: "machine:installer_repair_hint", hint: HINT },
    ]);
    socket.emitServerMessage({ type: "computer:upgrade", requestId: "upgrade-c", operationId: "upgrade-c" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(changes().length, 2, "an unchanged hint is not sent again");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Raft Desktop's move: the first ready to the server carries migratedFrom, once; the Computer is told it went out; a reconnect's ready does not carry it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migrated-from-test-"));
  const sockets: FakeWebSocket[] = [];
  let reads = 0;
  let sent = 0;
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerMigratedFrom: async () => { reads += 1; return sent === 0 ? "electron" : null; },
      onComputerMigratedFromSent: async () => { sent += 1; },
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
    const readies = (socket: FakeWebSocket) => socket.sent.filter((message) => (message as { type?: string }).type === "ready") as Array<{ migratedFrom?: unknown }>;
    await waitFor(() => readies(sockets[0]!).length > 0 && sent === 1, "first ready");
    assert.equal(readies(sockets[0]!)[0]!.migratedFrom, "electron");
    for (const later of readies(sockets[0]!).slice(1)) assert.equal(later.migratedFrom, undefined, "later readies on this connection do not repeat it");
    const readsAfterFirst = reads;
    sockets[0]!.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    sockets[1]!.emitOpen();
    await waitFor(() => readies(sockets[1]!).length > 0, "ready after the reconnect");
    assert.equal(readies(sockets[1]!)[0]!.migratedFrom, undefined);
    assert.equal(sent, 1, "acknowledged once");
    assert.equal(reads, readsAfterFirst, "not even read again in this process");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a daemon without the Computer seam (or one that reads nothing) sends no migratedFrom", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migrated-from-none-test-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerMigratedFrom: async () => { throw new Error("EACCES"); },
      connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
    });
    core.start();
    sockets[0]!.emitOpen();
    await waitFor(() => sockets[0]!.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
    const ready = sockets[0]!.sent.find((message) => (message as { type?: string }).type === "ready") as Record<string, unknown>;
    assert.equal("migratedFrom" in ready, false, "a failed read never blocks or fills the ready");
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("remote upgrade steps from the Computer's log go out as trace events after ready, then are acked", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-steps-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  const collected: boolean[] = [];
  let acked = 0;
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLastUpgradeReceipt: async () => ({ targetVersion: "1.0.51", outcome: "rolled_back", reason: "1.0.51 didn't start" }),
      collectComputerUpgradeSteps: async ({ relayedInReady }) => {
        collected.push(relayedInReady);
        return {
          events: [{
            requestId: "req-1", step: "rolled_back", outcome: "failed", atMs: 1, deliveredLateMs: 1_900_000, afterDeadline: true,
            fromVersion: "1.0.50", targetVersion: "1.0.51", durationMs: 40_000, errorCode: "candidate_start_failed", reason: "1.0.51 didn't start",
            diagnostic: "candidate did not become ready", startFailure: "exited", startExitCode: 1,
            installerVersion: "0.4.0", receiptOutcome: "rolled_back", engineDiagnostic: "probe failed: candidate was not started successfully",
            enginePhase: "rolled-back", engineOutcome: "rolled-back", engineReason: "probe failed",
            lastStartSlot: "previous", lastStartVersion: "1.0.50", lastStartSucceeded: false, lastStartFailure: "exited", lastStartExitCode: 2,
            afterReceipt: true,
          }],
          ack: async () => { acked += 1; },
        };
      },
      watchComputerUpgradeOutcome: async () => { throw new Error("a ready that carried the receipt needs no watch"); },
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
    for (let i = 0; i < 20 && acked === 0; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(collected, [true], "the ready carried the receipt");
    assert.equal(acked, 1);
    const step = traceRows(sink).find((row) => row.name === "daemon.computer_upgrade.step");
    assert.deepEqual(step?.attrs && {
      request_id: step.attrs.request_id, step: step.attrs.step, outcome: step.attrs.outcome, error_code: step.attrs.error_code,
      from_version: step.attrs.from_version, after_deadline: step.attrs.after_deadline, delivered_late_ms: step.attrs.delivered_late_ms, status: step.attrs.status,
      diagnostic: step.attrs.diagnostic, start_failure: step.attrs.start_failure, start_exit_code: step.attrs.start_exit_code,
      installer_version: step.attrs.installer_version, receipt_outcome: step.attrs.receipt_outcome, engine_diagnostic: step.attrs.engine_diagnostic,
      engine_phase: step.attrs.engine_phase, engine_outcome: step.attrs.engine_outcome, engine_reason: step.attrs.engine_reason,
      last_start_slot: step.attrs.last_start_slot, last_start_version: step.attrs.last_start_version, last_start_succeeded: step.attrs.last_start_succeeded,
      last_start_failure: step.attrs.last_start_failure, last_start_exit_code: step.attrs.last_start_exit_code, after_receipt: step.attrs.after_receipt,
    }, {
      request_id: "req-1", step: "rolled_back", outcome: "failed", error_code: "candidate_start_failed",
      from_version: "1.0.50", after_deadline: true, delivered_late_ms: 1_900_000, status: "error",
      diagnostic: "candidate did not become ready", start_failure: "exited", start_exit_code: 1,
      installer_version: "0.4.0", receipt_outcome: "rolled_back", engine_diagnostic: "probe failed: candidate was not started successfully",
      engine_phase: "rolled-back", engine_outcome: "rolled-back", engine_reason: "probe failed",
      last_start_slot: "previous", last_start_version: "1.0.50", last_start_succeeded: false, last_start_failure: "exited", last_start_exit_code: 2,
      after_receipt: true,
    });
    assert.equal(traceRows(sink).some((row) => row.name === "daemon.connect.lifecycle_error"), false);
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the Computer's device session retire outcome goes out once as a trace event after ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-retire-report-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  let calls = 0;
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      // Claimed: the first call takes it, later ones get null.
      collectComputerDeviceSessionRetire: async () => {
        calls += 1;
        return calls === 1 ? { reason: "no_matching_key", deleted: true, keysTried: 1, attempt: 1, httpStatus: 403, logout: "ok" } : null;
      },
      connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
    });
    core.start();
    sockets[0]!.emitOpen();
    await waitFor(() => traceRows(sink).some((row) => row.name === "daemon.computer.device_session_retire"), "retire event");
    const rows = traceRows(sink).filter((row) => row.name === "daemon.computer.device_session_retire");
    assert.equal(rows.length, 1);
    const attrs = rows[0]!.attrs ?? {};
    assert.deepEqual(
      { reason: attrs.reason, deleted: attrs.deleted, keys_tried: attrs.keys_tried, attempt: attrs.attempt, http_status: attrs.http_status, logout: attrs.logout, status: attrs.status },
      { reason: "no_matching_key", deleted: true, keys_tried: 1, attempt: 1, http_status: 403, logout: "ok", status: "ok" },
    );
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("machine-lock conflicts other runners of the Computer exited on go out once each after ready, coarse only", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lock-conflict-relay-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  let calls = 0;
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      // Claimed: the first call takes them, later ones get none.
      collectComputerMachineLockConflicts: async () => {
        calls += 1;
        return calls === 1
          ? [{ ownerStartReadable: false, lockAgeDays: "gt_30" }, { ownerStartReadable: null, lockAgeDays: "unknown" }]
          : [];
      },
      connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
    });
    core.start();
    sockets[0]!.emitOpen();
    const conflictRows = () => traceRows(sink).filter((row) => row.name === "daemon.machine_lock.conflict");
    await waitFor(() => conflictRows().length === 2, "conflict events");
    assert.equal(calls, 1);
    assert.deepEqual(
      conflictRows().map(({ attrs = {} }) => ({
        platform: attrs.platform,
        owner_start_readable: attrs.owner_start_readable,
        lock_age_days: attrs.lock_age_days,
        status: attrs.status,
      })),
      [
        { platform: process.platform, owner_start_readable: false, lock_age_days: "gt_30", status: "error" },
        { platform: process.platform, owner_start_readable: undefined, lock_age_days: "unknown", status: "error" },
      ],
    );
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a daemon that took over a stale machine lock says so once, without a pid or a path; a released lock is no reclaim", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-lock-reclaim-test-"));
  const machineStateDir = path.join(dataDir, "machines");
  const lockDir = path.join(machineStateDir, getDaemonMachineLockId("sk_machine_test"), "daemon.lock");
  await mkdir(lockDir, { recursive: true });
  // A lock dir its writer never finished (no owner.json), long enough ago.
  const old = new Date(Date.now() - 120_000);
  await utimes(lockDir, old, old);
  const startCore = () => {
    const { sink, tracer } = makeDeterministicTracer();
    const core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      machineStateDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      connectionOptions: { wsFactory: () => new FakeWebSocket() },
    });
    core.start();
    return { core, reclaimed: () => traceRows(sink).filter((row) => row.name === "daemon.machine_lock.reclaimed") };
  };
  let first: ReturnType<typeof startCore> | null = null;
  let second: ReturnType<typeof startCore> | null = null;
  try {
    first = startCore();
    const rows = first.reclaimed();
    assert.equal(rows.length, 1);
    const attrs = rows[0]!.attrs ?? {};
    assert.deepEqual(
      { reason: attrs.reason, platform: attrs.platform, identity_source: attrs.identity_source, status: attrs.status },
      { reason: "incomplete", platform: process.platform, identity_source: undefined, status: "ok" },
    );
    assert.ok(!JSON.stringify(rows[0]).includes(machineStateDir), "no path in the event");
    assert.ok(!Object.values(attrs).includes(process.pid), "no pid in the event");
    await first.core.stop();
    first = null;

    second = startCore();
    assert.equal(second.reclaimed().length, 0);
  } finally {
    if (first) await first.core.stop();
    if (second) await second.core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("remote upgrade: a restored service whose receipt appears after ready settles the request with upgrade:done", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-upgrade-late-receipt-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  let watches = 0;
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      tracer,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      getComputerLastUpgradeReceipt: async () => null,
      collectComputerUpgradeSteps: async () => ({ events: [], ack: async () => {} }),
      watchComputerUpgradeOutcome: async () => {
        watches += 1;
        return { requestId: "req-rb", outcome: "rolled_back", reason: "1.0.51 didn't start\ncorrectly" };
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
    const done = () => socket.sent.find((message) => (message as { type?: string }).type === "computer:upgrade:done");
    for (let i = 0; i < 20 && !done(); i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(done(), {
      type: "computer:upgrade:done",
      requestId: "req-rb",
      ok: false,
      code: "upgrade_rolled_back",
      reason: "1.0.51 didn't start correctly",
    });
    assert.equal(watches, 1);
    const reported = traceRows(sink).find((row) => row.name === "daemon.computer_upgrade.step" && row.attrs?.step === "reported");
    assert.equal(reported?.attrs?.via, "late_receipt");
    assert.equal(reported?.attrs?.outcome, "ok");
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
      capabilities: [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY, AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY],
      // No live transfer run in a fresh process: the server may re-provision.
      activeLeases: [],
      observedAt: ready.migrationTransport?.observedAt,
    });
    assert.match(ready.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((ready.capabilities ?? []).some((capability) => capability.startsWith("migration:")), false);

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

test("DaemonCore refuses to archive a source workspace that a later migration committed", async () => {
  const slockHome = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-source-archive-newer-"));
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-back");
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;

  try {
    // The agent moved back onto this computer: its workspace carries a commit
    // marker newer than the migration whose source cleanup is being retried.
    await mkdir(path.join(source, ".raft-migration"), { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "live-again\n");
    await writeFile(path.join(source, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/")), `${JSON.stringify({
      schemaVersion: "agent-migration-commit/v1",
      migrationId: "migration-newer",
      migrationGeneration: "gen",
      leaseId: "lease",
      agentId: "agent-back",
      sourceMachineId: "machine-c",
      targetMachineId: "machine-b",
      controlSha256: "0".repeat(64),
      bundleSha256: "0".repeat(64),
      committedAt: "2026-09-02T00:00:00.000Z",
    })}\n`);
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
      requestId: "33333333-3333-4333-8333-333333333334",
      migrationId: "migration-older",
      agentId: "agent-back",
      migrationCreatedAt: "2026-09-01T00:00:00.000Z",
    });
    await waitFor(
      () => socket.sent.some((message) =>
        (message as { requestId?: string }).requestId === "33333333-3333-4333-8333-333333333334"
        && (message as { outcome?: string }).outcome === "error"
        && (message as { errorCode?: string }).errorCode === "MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER"),
      "archive refused for a newer owner",
    );
    assert.equal(await readFile(path.join(source, "MEMORY.md"), "utf8"), "live-again\n", "live workspace untouched");

    await core.stop();
    core = null;
  } finally {
    if (core) await core.stop();
    await rm(slockHome, { recursive: true, force: true });
  }
});

test("DaemonCore applies object-store migration transfer lease and re-emits provider-neutral ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-migration-transport-server-lease-test-"));
  const sockets: FakeWebSocket[] = [];
  let quiesceReceived = false;
  const transferServer = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/internal/computer/agent-migrations/by-id/migration-1/resumable/source-quiesced") {
      await readRequestBody(req);
      quiesceReceived = true;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  let core: DaemonCore | null = null;

  try {
    core = new DaemonCore({
      serverUrl: transferServer.baseUrl,
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
      bearerToken: "lease-token-1",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-1/resumable",
      leaseId: "lease-1",
      transportGeneration: "transport-generation-1",
      sourceMachineId: "source-machine-1",
      targetMachineId: "target-machine-1",
      expectedMigrationRevision: 3,
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
    assert.equal(serverReady?.migrationTransport?.endpoint, null);
    assert.deepEqual(serverReady?.migrationTransport?.capabilities, [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_TARGET_IGNORE_SOURCES_CAPABILITY, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY, AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY]);
    assert.equal(serverReady?.migrationTransport?.provider, "object_store");
    assert.equal(serverReady?.migrationTransport?.role, "source");
    assert.equal(serverReady?.migrationTransport?.transferKind, "upload");
    assert.equal(serverReady?.migrationTransport?.expiresAt, "2999-07-09T13:00:00.000Z");
    assert.equal(serverReady?.migrationTransport?.maxBytes, 104857600);
    assert.equal("token" in (serverReady?.migrationTransport ?? {}), false);
    assert.equal("bearerToken" in (serverReady?.migrationTransport ?? {}), false);
    assert.match(serverReady?.migrationTransport?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    await waitFor(() => quiesceReceived, "resumable source run after ready");

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
      bearerToken: "target-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
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
    "source-residue",
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
      bearerToken: "source-token",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
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
      bearerToken: "",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-1/resumable",
      leaseId: "lease-1",
      transportGeneration: "transport-generation-1",
      sourceMachineId: "source-machine-1",
      targetMachineId: "target-machine-1",
      expectedMigrationRevision: 3,
    });
    socket.emitServerMessage({
      type: "machine:migration_transport:lease",
      agentId: "agent-1",
      migrationId: "migration-2",
      migrationRef: "mig_HHHHHHHHHHHHHHHHHHHHHH",
      migrationGeneration: "agent_migration:migration-2:3",
      sessionId: "session-2",
      provider: "object_store",
      leaseSource: "server",
      role: "source",
      transferKind: "upload",
      bearerToken: "lease-token-2",
      expiresAt: "2999-07-09T13:00:00.000Z",
      maxBytes: 104857600,
      controlUrl: "/internal/computer/agent-migrations/by-id/migration-2/resumable",
      // A lease missing a required field is refused.
      leaseId: "",
      transportGeneration: "transport-generation-2",
      sourceMachineId: "source-machine-2",
      targetMachineId: "target-machine-2",
      expectedMigrationRevision: 3,
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
          getHeldRunnerCredentialIds: () => [],
          resendPendingServerWakes: () => {},
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
        getHeldRunnerCredentialIds: () => [],
        resendPendingServerWakes: () => {},
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
      getHeldRunnerCredentialIds: () => [],
      resendPendingServerWakes: () => {},
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

test("View Context: DaemonCore advertises agent-context-view:v0, hands a request to the agent manager and asks for availability after ready", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const sockets: FakeWebSocket[] = [];
  const requests: unknown[] = [];
  const availabilityTriggers: string[] = [];
  let connectedServerId: (() => string | null) | undefined;
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
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      connectedServerId = options?.connectedServerId;
      const manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => new FakeDriver(),
      });
      manager.handleAgentContextViewRequest = async (frame) => {
        requests.push(frame);
      };
      manager.reportAgentContextViewAvailability = (trigger) => {
        availabilityTriggers.push(trigger);
      };
      return manager;
    },
  });
  try {
    // The agent manager learns which server this daemon serves (its View Context data is kept per server).
    assert.equal(connectedServerId?.(), null);
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    await waitFor(() => socket.sent.some((msg) => (msg as { type?: string }).type === "ready"), "ready");
    const ready = socket.sent.find((msg) => (msg as { type?: string }).type === "ready") as { capabilities?: string[] };
    assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0), true);
    assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0), true);
    assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_CODEX_ROOT_V1), true);
    assert.equal(connectedServerId?.(), "server-test");
    await waitFor(() => availabilityTriggers.includes("ready"), "availability after ready");
    const frame = { type: "agent:context_view_request", requestId: asAgentContextViewRequestId("ctxv_0123456789abcdef0123")!, agentId: "agent-1", messageId: "m-1", maxBytes: 1000 } as const;
    socket.emitServerMessage(frame);
    await waitFor(() => requests.length === 1, "request handed over");
    assert.deepEqual(requests[0], frame);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071: DaemonCore advertises runtime outcomes, acks processInstanceId only on a rebind, and threads catchupBatchId to the echo", async () => {
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
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    openAckingServer(socket);
    await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");
    const ready = sentOfType(socket, "ready")[0]!;
    assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_OUTCOME_V1), true);
    assert.ok(ready.daemonInstanceId);

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ sessionId: "session-1" }),
      resumeMessages: [{
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "richard",
        sender_type: "human",
        content: "owed while paused",
        timestamp: "2026-09-29T10:00:00.000Z",
        message_id: "m1",
        seq: 1,
      }],
      catchupBatchId: "batch-1",
    });
    await waitFor(() => sentOfType(socket, "agent:process_spawned").length === 1, "process spawned");
    const spawned = sentOfType(socket, "agent:process_spawned")[0]!;
    assert.equal(spawned.launchId, "launch-1");
    assert.equal(spawned.daemonInstanceId, ready.daemonInstanceId, "the same daemon instance as ready");
    const firstAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-1");
    assert.ok(firstAck && firstAck.queueState !== "running" && firstAck.queueState !== "rebound", `fresh spawn ack (got ${firstAck?.queueState})`);
    assert.equal("processInstanceId" in firstAck, false, "a starting/queued ack never carries a processInstanceId");

    driver.children[0]!.stdout.emit("data", Buffer.from("text\nturn_end\n"));
    await waitFor(() => sentOfType(socket, "agent:runtime:outcome").length === 1, "turn_completed");
    const completed = sentOfType(socket, "agent:runtime:outcome")[0]!;
    assert.deepEqual(completed.outcome, { kind: "turn_completed", textEvents: 1, toolCalls: 0, catchupBatchId: "batch-1", catchupRenderedRows: 1 });
    assert.equal(completed.launchId, "launch-1");

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-2",
      launchId: "launch-2",
      config: makeConfig({ sessionId: "session-1" }),
    });
    await waitFor(() => sentOfType(socket, "agent:start:ack").some((ack) => ack.startDispatchId === "dispatch-2"), "rebind ack");
    const rebindAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-2")!;
    assert.equal(rebindAck.queueState, "running");
    assert.equal(rebindAck.processInstanceId, spawned.processInstanceId);

    driver.children[0]!.emit("exit", 1, null);
    await waitFor(() => sentOfType(socket, "agent:process_exited").length === 1, "process exited");
    const exited = sentOfType(socket, "agent:process_exited")[0]!;
    assert.deepEqual(
      { processInstanceId: exited.processInstanceId, spawnLaunchId: exited.spawnLaunchId, launchId: exited.launchId, code: exited.code },
      { processInstanceId: spawned.processInstanceId, spawnLaunchId: "launch-1", launchId: "launch-2", code: 1 },
    );
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an OAR-only runtime on a Computer with the OAR host turned off fails its start with the reason, never reaching the legacy host", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const previousDisabled = process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
  process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = "1";
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    oarHost: false,
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Outcome = Extract<MachineToServerMessage, { type: "agent:start:outcome" }>;
  type Activity = Extract<MachineToServerMessage, { type: "agent:activity" }>;
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ runtime: "qwen", agentCredentialKey: "sk_agent_test" }),
    });
    const outcomes = () => socket.sent.filter((msg): msg is Outcome => (msg as { type?: string }).type === "agent:start:outcome");
    await waitFor(() => outcomes().length >= 1, "start outcome");
    assert.equal(driver.spawnCalls.length, 0);
    assert.deepEqual(outcomes().map((frame) => frame.result), [{ kind: "not_spawned", reason: "start_rejected" }]);
    const failure = socket.sent.find((msg): msg is Activity =>
      (msg as { type?: string }).type === "agent:activity" && (msg as Activity).detailKind === "runtime_unavailable");
    assert.match(failure?.detail ?? "", /Qwen Code runs only on the OAR host, which is turned off on this Computer \(RAFT_DAEMON_OAR_HOST_DISABLED\)/);
  } finally {
    if (previousDisabled === undefined) delete process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
    else process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = previousDisabled;
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a start whose env vars set PATH or NODE_OPTIONS still starts: the Computer records the names and does not refuse", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const previousDisabled = process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
  process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = "1";
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Outcome = Extract<MachineToServerMessage, { type: "agent:start:outcome" }>;
  type Activity = Extract<MachineToServerMessage, { type: "agent:activity" }>;
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({
        agentCredentialKey: "sk_agent_test",
        envVars: { PATH: "/opt/evil-bin:/usr/bin", NODE_OPTIONS: "--require /tmp/evil.js", ANTHROPIC_BASE_URL: "https://example.com" },
      }),
    });
    await waitFor(() => driver.spawnCalls.length >= 1, "spawn");
    // xxchan (#proj-raft-computer:bbea62a0): the server refuses new writes of
    // these names; the Computer only records them, so existing agents keep running.
    assert.equal(driver.spawnCalls[0]?.config.envVars?.NODE_OPTIONS, "--require /tmp/evil.js");
    const outcomes = socket.sent.filter((msg): msg is Outcome => (msg as { type?: string }).type === "agent:start:outcome");
    assert.ok(!outcomes.some((frame) => frame.result.kind === "not_spawned"), "the start is not refused");
    const refused = socket.sent.find((msg): msg is Activity =>
      (msg as { type?: string }).type === "agent:activity" && (msg as Activity).spawnFailure?.reason === "env_var_not_allowed");
    assert.equal(refused, undefined);
    assert.doesNotMatch(JSON.stringify(socket.sent), /evil/);
  } finally {
    if (previousDisabled === undefined) delete process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
    else process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = previousDisabled;
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071: DaemonCore settles a start it rejects before any process as not_spawned(start_rejected), exactly once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const previousDisabled = process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
  process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = "1";
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Outcome = Extract<MachineToServerMessage, { type: "agent:start:outcome" }>;
  const outcomes = (socket: FakeWebSocket) =>
    socket.sent.filter((msg): msg is Outcome => (msg as { type?: string }).type === "agent:start:outcome");
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    // Credential mint refused (no key, minting disabled): no process can exist.
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ agentCredentialKey: undefined }),
    });
    // The process manager settles its own failure: spawn failed before a
    // child existed. DaemonCore's failure report must not add a second result.
    driver.spawn = () => { throw new Error("spawn ENOENT"); };
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-3",
      startDispatchId: "dispatch-3",
      launchId: "launch-3",
      config: makeConfig(),
    });
    await waitFor(() => outcomes(socket).length >= 2, "two start outcomes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(driver.spawnCalls.length, 0);
    assert.equal(socket.sent.filter((msg) => (msg as { type?: string }).type === "agent:process_spawned").length, 0);
    assert.deepEqual(outcomes(socket).map((frame) => [frame.agentId, frame.launchId, frame.result]).sort(), [
      ["agent-1", "launch-1", { kind: "not_spawned", reason: "start_rejected" }],
      ["agent-3", "launch-3", { kind: "not_spawned", reason: "spawn_failed" }],
    ]);
  } finally {
    if (previousDisabled === undefined) delete process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED;
    else process.env.SLOCK_AGENT_RUNNER_CREDENTIALS_DISABLED = previousDisabled;
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071 outbox through DaemonCore: an old server gets nothing; a supporting server gets the queue in order; blocked storage and unreliable storage refuse starts locally", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  let failWrites = false;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeOutcomeOutboxFs: {
      writeTempAndSync: (temp, data) => {
        if (failWrites) throw new Error("ENOSPC");
        nodeOutboxFs.writeTempAndSync(temp, data);
      },
      rename: (from, to) => nodeOutboxFs.rename(from, to),
      syncDir: (dir) => nodeOutboxFs.syncDir(dir),
    },
    connectionOptions: {
      minReconnectDelayMs: 1,
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  const ofType = (socket: FakeWebSocket | undefined, type: string) =>
    (socket?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>;
  const start = (socket: FakeWebSocket, agentId: string, launchId: string, extra: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>> = {}) =>
    socket.emitServerMessage({ type: "agent:start", agentId, launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra });

  try {
    core.start();
    // (11) An old server: machine:context without the ack capability. A never-engaged
    // agent's compat run produces no outbox frame: nothing is sent or queued.
    sockets[0]!.emitOpen();
    start(sockets[0]!, "agent-1", "launch-1");
    await waitFor(() => driver.spawnCalls.length === 1, "spawn on the old server");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(sockets[0], "agent:process_spawned").length, 0, "nothing is sent to a server that does not ack");
    const onOld = existsSync(path.join(outboxDir, "agent-1.json"))
      ? (JSON.parse(await readFile(path.join(outboxDir, "agent-1.json"), "utf8")) as { entries: unknown[] }).entries : [];
    assert.deepEqual(onOld, [], "and nothing is queued for it");

    // A supporting server on the next connection: nothing old to deliver (queued delivery with
    // original identity is covered by the outbox tests and the reconnect test below).
    sockets[0]!.terminate();
    await waitFor(() => sockets.length === 2, "replacement websocket");
    openAckingServer(sockets[1]!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ofType(sockets[1], "agent:process_spawned").length, 0);

    // Blocked storage: an older epoch fills the outbox; even a human start at a new epoch is refused.
    const filler = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-old", send: () => {} });
    for (let seq = 1; seq <= OUTBOX_NORMAL_CAP; seq += 1) {
      filler.enqueue({ type: "agent:process_exited", agentId: "agent-2", daemonInstanceId: "d-old", processInstanceId: `p-${seq}`, spawnLaunchId: "l", launchId: "l", clientSeq: seq, code: 0, signal: null });
    }
    (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.load();
    start(sockets[1]!, "agent-2", "launch-2", { humanStart: true, takeoverEpoch: 1 });
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-2"), "storage-blocked outcome");
    const blocked = ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-2")!;
    assert.deepEqual(blocked.result, { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 1, "the blocked human start spawned nothing");

    // A human start while storage works: it spawns and its process_spawned is stored and sent.
    start(sockets[1]!, "agent-3", "launch-3a", { humanStart: true });
    await waitFor(() => driver.spawnCalls.length === 2, "the human start spawned");
    await waitFor(() => ofType(sockets[1], "agent:process_spawned").some((frame) => frame.agentId === "agent-3"), "spawned frame");
    // Unreliable storage: the exit cannot be stored, so it is not sent (persist-then-send) and agent-3 is unreliable.
    failWrites = true;
    driver.children[1]!.emit("exit", 0, null);
    driver.children[1]!.emit("close", 0, null);
    await waitFor(() => ofType(sockets[1], "agent:runtime:outcome_unreliable").some((frame) => frame.agentId === "agent-3"), "unreliable notice");
    await waitFor(() => !(core as unknown as { agentManager: AgentProcessManager }).agentManager.getRunningAgentIds().includes("agent-3"), "agent-3 process gone");
    assert.equal(ofType(sockets[1], "agent:process_exited").filter((frame) => frame.agentId === "agent-3").length, 0);
    // Storage heals; the agent stays unreliable (the refusal below is stored and sent).
    failWrites = false;
    start(sockets[1]!, "agent-3", "launch-3b");
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-3b"), "automatic refusal");
    const refused = ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-3b")!;
    assert.deepEqual(refused.result, { kind: "not_spawned", reason: "terminal_failure_needs_manual" });
    assert.equal(driver.spawnCalls.length, 2);
    // Storage fails again: a human start whose resolution record cannot be
    // written is a failed recovery, refused storage_blocked (sent directly),
    // and agent-3 stays unreliable.
    failWrites = true;
    start(sockets[1]!, "agent-3", "launch-3c", { humanStart: true });
    await waitFor(() => ofType(sockets[1], "agent:start:outcome").some((frame) => frame.launchId === "launch-3c"), "failed-recovery refusal");
    assert.deepEqual(ofType(sockets[1], "agent:start:outcome").find((frame) => frame.launchId === "launch-3c")!.result,
      { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 2, "the failed recovery spawned nothing");

    // The next ready stops advertising outcomes for the unreliable agent.
    sockets[1]!.terminate();
    await waitFor(() => sockets.length === 3, "third websocket");
    sockets[2]!.emitOpen();
    await waitFor(() => ofType(sockets[2], "ready").length === 1, "ready");
    assert.deepEqual(ofType(sockets[2], "ready")[0]!.runtimeOutcomeUnreliableAgents, ["agent-3"]);

    // That connection is an older server (no ack capability). It gets no
    // RFC 071 frame, but a known unreliable agent is not exempt there: the
    // automatic start is refused locally, nothing spawns.
    start(sockets[2]!, "agent-3", "launch-3d");
    await waitFor(() => ofType(sockets[2], "agent:status").some((frame) => frame.agentId === "agent-3" && frame.launchId === "launch-3d" && frame.status === "inactive"), "refusal on the older server");
    assert.equal(driver.spawnCalls.length, 2, "no spawn for an unreliable agent on an older server");
    assert.equal(ofType(sockets[2], "agent:start:outcome").length, 0, "the older server gets no outbox frame");
    assert.equal(ofType(sockets[2], "agent:runtime:outcome_unreliable").length, 0);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RFC 071 outbox through DaemonCore: a durable unreliable marker survives a daemon restart; automatic starts stay refused until an admitted human start clears it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  // The previous daemon instance: its queue write failed, so it left only the marker.
  const previous = new RuntimeOutcomeOutbox({
    dir: outboxDir,
    daemonInstanceId: "d-previous",
    send: () => {},
    fs: { ...nodeOutboxFs, writeTempAndSync: (temp, data) => {
      if (path.basename(temp).startsWith("agent-9.json")) throw new Error("ENOSPC");
      nodeOutboxFs.writeTempAndSync(temp, data);
    } },
  });
  previous.enqueue({ type: "agent:process_exited", agentId: "agent-9", daemonInstanceId: "d-previous", processInstanceId: "p", spawnLaunchId: "l", launchId: "l", clientSeq: 1, code: 1, signal: null });
  assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), true);

  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      minReconnectDelayMs: 1,
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  const ofType = (socket: FakeWebSocket | undefined, type: string) =>
    (socket?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>;
  const start = (socket: FakeWebSocket, launchId: string, extra: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>> = {}) =>
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-9", launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra });
  try {
    core.start();
    openAckingServer(sockets[0]!);
    await waitFor(() => ofType(sockets[0], "ready").length === 1, "ready");
    assert.deepEqual(ofType(sockets[0], "ready")[0]!.runtimeOutcomeUnreliableAgents, ["agent-9"], "unreliable after the restart");

    start(sockets[0]!, "launch-auto");
    await waitFor(() => ofType(sockets[0], "agent:start:outcome").some((frame) => frame.launchId === "launch-auto"), "automatic refusal");
    assert.deepEqual(ofType(sockets[0], "agent:start:outcome").find((frame) => frame.launchId === "launch-auto")!.result,
      { kind: "not_spawned", reason: "terminal_failure_needs_manual" });
    assert.equal(driver.spawnCalls.length, 0);
    assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), true, "an automatic start does not clear the marker");

    start(sockets[0]!, "launch-human", { humanStart: true });
    await waitFor(() => driver.spawnCalls.length === 1, "the human start spawns");
    assert.equal(existsSync(path.join(outboxDir, "agent-9@unreliable.json")), false, "marker removed");
    const resolution = JSON.parse(await readFile(path.join(outboxDir, "agent-9@resolution.json"), "utf8")) as { launchId: string };
    assert.equal(resolution.launchId, "launch-human");
    const reloaded = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    reloaded.load();
    assert.equal(reloaded.isUnreliable("agent-9"), false, "cleared durably");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function withGatedCore(
  fn: (ctx: {
    core: DaemonCore;
    driver: FakeDriver;
    socket: FakeWebSocket;
    sockets: FakeWebSocket[];
    outboxDir: string;
    ctl: { failOpenProcessWrite: boolean; failExitQueueWrite: boolean };
    ofType: (type: string) => Array<Record<string, unknown>>;
    start: (launchId: string, extra?: Partial<Extract<ServerToMachineMessage, { type: "agent:start" }>>) => void;
  }) => Promise<void>,
  options: { acks?: boolean; autoAck?: boolean; seedOutbox?: (outboxDir: string) => void } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const outboxDir = path.join(dataDir, ".runtime-outcome-outbox");
  // What an earlier daemon run left on disk (loaded at start).
  options.seedOutbox?.(outboxDir);
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const ctl = { failOpenProcessWrite: false, failExitQueueWrite: false };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeOutcomeOutboxFs: {
      writeTempAndSync: (temp, data) => {
        // Fail only the open-launch write that adds a process (the spawn gate).
        if (ctl.failOpenProcessWrite && path.basename(temp).includes("@open-launches") && data.includes('"processes":[{')) throw new Error("ENOSPC");
        // Fail the agent's queue write that would store a process_exited frame.
        if (ctl.failExitQueueWrite && path.basename(temp).startsWith("agent-7.json.tmp-") && data.includes('"agent:process_exited"')) throw new Error("EIO");
        nodeOutboxFs.writeTempAndSync(temp, data);
      },
      rename: (from, to) => nodeOutboxFs.rename(from, to),
      syncDir: (dir) => nodeOutboxFs.syncDir(dir),
    },
    connectionOptions: {
      minReconnectDelayMs: 1,
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
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
        runtimeProcessGate: options?.runtimeProcessGate,
      }),
  });
  try {
    core.start();
    if (options.acks === false) sockets[0]!.emitOpen(); // an older server: machine:context without the ack capability
    else openAckingServer(sockets[0]!, { autoAck: options.autoAck });
    await waitFor(() => (sockets[0]?.sent ?? []).some((msg) => (msg as { type?: string }).type === "ready"), "ready");
    await fn({
      core,
      driver,
      socket: sockets[0]!,
      sockets,
      outboxDir,
      ctl,
      ofType: (type) => (sockets[0]?.sent ?? []).filter((msg) => (msg as { type?: string }).type === type) as Array<Record<string, unknown>>,
      start: (launchId, extra = {}) => sockets[0]!.emitServerMessage({
        type: "agent:start", agentId: "agent-7", launchId, startDispatchId: `dispatch-${launchId}`, config: makeConfig(), ...extra,
      }),
    });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("RFC 071 open launches through DaemonCore: a running process is durably open (a hard crash would leave it unknown); a graceful stop stores the exit and a restart is clean", async () => {
  await withGatedCore(async ({ core, driver, outboxDir, ofType, start }) => {
    start("launch-1");
    await waitFor(() => driver.spawnCalls.length === 1, "spawn");
    await waitFor(() => ofType("agent:process_spawned").length === 1, "spawned frame");
    const open = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { requests: unknown[]; processes: Array<{ processInstanceId: string }> };
    assert.deepEqual(open.requests, [], "the request has its result");
    assert.equal(open.processes.length, 1, "the running process is open");
    assert.equal(open.processes[0]!.processInstanceId, ofType("agent:process_spawned")[0]!.processInstanceId);
    // What a restart after a hard crash (kill -9) would load now: the documented cost.
    const crashed = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-after-crash", send: () => {} });
    crashed.load();
    assert.equal(crashed.isUnreliable("agent-7"), true);
    rmSync(path.join(outboxDir, "agent-7@unreliable.json"), { force: true }); // undo that probe's marker

    await core.stop();
    const restarted = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    restarted.load();
    assert.equal(restarted.isUnreliable("agent-7"), false, "graceful stop: the exit is stored, nothing is open");
    const after = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: unknown[] };
    assert.deepEqual(after.processes, []);
  });
});

test("RFC 071 open launches through DaemonCore: if the process cannot be recorded open, it is not spawned (storage_blocked) and the agent is unreliable", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1", { humanStart: true });
    await waitFor(() => ofType("agent:start:outcome").some((frame) => frame.launchId === "launch-1"), "refusal");
    assert.deepEqual(ofType("agent:start:outcome").find((frame) => frame.launchId === "launch-1")!.result,
      { kind: "not_spawned", reason: "terminal_failure_outcome_storage_blocked" });
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned");
    assert.equal((core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.isUnreliable("agent-7"), true);
  });
});

test("RFC 071 open launches through DaemonCore (old server): the process cannot be recorded open -> no spawn, unreliable; the next start is not stranded", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1");
    await waitFor(() => ofType("agent:status").some((frame) => frame.launchId === "launch-1" && frame.status === "inactive"), "spawn refused");
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned on the older server");
    const outbox = (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
    assert.equal(outbox.isUnreliable("agent-7"), true);
    ctl.failOpenProcessWrite = false;
    start("launch-2");
    await waitFor(() => driver.spawnCalls.length === 1, "the old server never sends a human start: the next start spawns");
    assert.equal(ofType("agent:start:outcome").length + ofType("agent:runtime:outcome_unreliable").length, 0, "the older server gets no RFC 071 frame");
  }, { acks: false });
});

test("RFC 071 open launches through DaemonCore: an internal start without a launchId is durably open (keyed by processInstanceId); its exit is recorded and clears it", async () => {
  await withGatedCore(async ({ core, driver, outboxDir }) => {
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 1);
    const open = JSON.parse(await readFile(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: Array<{ processInstanceId: string; spawnLaunchId: string | null }> };
    assert.equal(open.processes.length, 1, "the internal process is recorded before it runs");
    assert.equal(open.processes[0]!.spawnLaunchId, null, "no server launchId is invented");
    // What a restart after a hard crash would load now.
    const crashed = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-after-crash", send: () => {} });
    crashed.load();
    assert.equal(crashed.isUnreliable("agent-7"), true, "restart with the entry open -> unreliable");
    rmSync(path.join(outboxDir, "agent-7@unreliable.json"), { force: true }); // undo that probe's marker

    driver.children[0]!.emit("exit", 0, null);
    driver.children[0]!.emit("close", 0, null);
    await waitFor(() => (JSON.parse(readFileSync(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as { processes: unknown[] }).processes.length === 0, "the durable exit clears it");
    const restarted = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-next", send: () => {} });
    restarted.load();
    assert.equal(restarted.isUnreliable("agent-7"), false);
  });
});

test("RFC 071 open launches through DaemonCore: an internal start without a launchId whose record cannot be written does not spawn, and the agent is unreliable", async () => {
  await withGatedCore(async ({ core, driver, ctl }) => {
    ctl.failOpenProcessWrite = true;
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await assert.rejects(manager.startAgent("agent-7", makeConfig()), (err: Error) => err.name === "RuntimeOutcomeStorageBlockedError");
    assert.equal(driver.spawnCalls.length, 0, "nothing spawned");
    assert.equal((core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox.isUnreliable("agent-7"), true);
  });
});

type OpenLaunchesOnDisk = { requests: Array<{ launchId: string }>; processes: Array<{ processInstanceId: string; spawnLaunchId: string | null }> };

function openLaunchesOnDisk(outboxDir: string): OpenLaunchesOnDisk {
  return JSON.parse(readFileSync(path.join(outboxDir, "agent-7@open-launches.json"), "utf8")) as OpenLaunchesOnDisk;
}

/**
 * P1 is started by the daemon itself (no launchId), then server starts L1 and
 * L2 are rebound onto it. Its registry entry ends (close) and P2 is spawned
 * for L3 while P1's exit has not arrived yet. Returns the identities.
 */
async function internalProcessReboundThenReplaced(ctx: {
  core: DaemonCore;
  driver: FakeDriver;
  outboxDir: string;
  ofType: (type: string) => Array<Record<string, unknown>>;
  start: (launchId: string) => void;
}): Promise<{ p1: string; p2: string }> {
  const manager = (ctx.core as unknown as { agentManager: AgentProcessManager }).agentManager;
  await manager.startAgent("agent-7", makeConfig());
  assert.equal(ctx.driver.spawnCalls.length, 1);
  const p1 = openLaunchesOnDisk(ctx.outboxDir).processes[0]!.processInstanceId;
  assert.equal(openLaunchesOnDisk(ctx.outboxDir).processes[0]!.spawnLaunchId, null, "precondition: an internal start, no birth launch");
  for (const launchId of ["launch-1", "launch-2"]) {
    ctx.start(launchId);
    await waitFor(() => ctx.ofType("agent:start:outcome").some((frame) => frame.launchId === launchId), `${launchId} result`);
    assert.deepEqual(ctx.ofType("agent:start:outcome").find((frame) => frame.launchId === launchId)!.result, { kind: "rebound", processInstanceId: p1 });
  }
  // P1 leaves the registry before its exit event arrives.
  ctx.driver.children[0]!.emit("close", 1, null);
  await waitFor(() => !(manager as unknown as { agents: Map<string, unknown> }).agents.has("agent-7"), "P1 closed");
  ctx.start("launch-3");
  await waitFor(() => ctx.ofType("agent:process_spawned").some((frame) => frame.launchId === "launch-3"), "P2 spawned for launch-3");
  const p2 = ctx.ofType("agent:process_spawned").find((frame) => frame.launchId === "launch-3")!.processInstanceId as string;
  assert.notEqual(p2, p1);
  assert.deepEqual(
    openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]).sort(),
    [[p1, null], [p2, "launch-3"]].sort(),
    "precondition: both processes are open",
  );
  return { p1, p2 };
}

test("RFC 071 outbox through DaemonCore: an internal process rebound to L1 then L2 whose exit arrives after P2 spawned for L3 sends process_exited for the OLD identity (spawnLaunchId null, launchId L2); only P1's entry clears, P2's stays open", async () => {
  await withGatedCore(async (ctx) => {
    const { p1, p2 } = await internalProcessReboundThenReplaced(ctx);
    ctx.driver.children[0]!.emit("exit", 1, null);
    await waitFor(() => ctx.ofType("agent:process_exited").length === 1, "P1 exit frame");
    const exited = ctx.ofType("agent:process_exited")[0]!;
    assert.deepEqual(
      { processInstanceId: exited.processInstanceId, spawnLaunchId: exited.spawnLaunchId, launchId: exited.launchId, daemonInstanceId: exited.daemonInstanceId },
      { processInstanceId: p1, spawnLaunchId: null, launchId: "launch-2", daemonInstanceId: ctx.ofType("agent:process_spawned")[0]!.daemonInstanceId },
      "the old process identity; its birth had no launch, the last launch it carried is L2",
    );
    await waitFor(() => openLaunchesOnDisk(ctx.outboxDir).processes.length === 1, "P1's entry cleared once its exit was stored");
    assert.deepEqual(openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]), [[p2, "launch-3"]], "P2's entry stays open");
    const manager = (ctx.core as unknown as { agentManager: AgentProcessManager }).agentManager;
    assert.equal((manager as unknown as { agents: Map<string, { processInstanceId: string }> }).agents.get("agent-7")?.processInstanceId, p2, "P2 still runs");
  });
});

test("RFC 071 outbox through DaemonCore: that exit clears P1's entry only after its frame is durably stored (a failed store keeps it and the agent is unreliable)", async () => {
  await withGatedCore(async (ctx) => {
    const { p1, p2 } = await internalProcessReboundThenReplaced(ctx);
    ctx.ctl.failExitQueueWrite = true;
    ctx.driver.children[0]!.emit("exit", 1, null);
    const outbox = (ctx.core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
    await waitFor(() => outbox.isUnreliable("agent-7"), "the exit could not be stored");
    await flush();
    assert.equal(ctx.ofType("agent:process_exited").length, 0, "nothing sent that was not stored");
    assert.deepEqual(
      openLaunchesOnDisk(ctx.outboxDir).processes.map((entry) => [entry.processInstanceId, entry.spawnLaunchId]).sort(),
      [[p1, null], [p2, "launch-3"]].sort(),
      "P1 stays open (unknown), P2 untouched",
    );
  });
});

test("RFC 071 outbox through DaemonCore (old server): an unreliable agent is not stranded: the next server start and the daemon's own restart spawn it", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType, start }) => {
    ctl.failOpenProcessWrite = true;
    start("launch-1");
    await waitFor(() => ofType("agent:status").some((frame) => frame.launchId === "launch-1" && frame.status === "inactive"), "first start refused");
    ctl.failOpenProcessWrite = false;
    assert.equal(gatedOutbox(core).isUnreliable("agent-7"), true);

    // The old server never sends a human start: a server start goes through.
    start("launch-2");
    await waitFor(() => driver.spawnCalls.length === 1, "the server start spawns");
    driver.children[0]!.kill();
    await waitFor(() => !gatedManager(core).getRunningAgentIds().includes("agent-7"), "stopped");

    // The daemon's own restart too.
    await gatedManager(core).startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(ofType("agent:activity").some((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string)), false, "nothing refused");
    assert.equal(gatedOutbox(core).isUnreliable("agent-7"), true, "the state is kept for an acking server");
  }, { acks: false });
});

test("RFC 071 outbox through DaemonCore (acking server): the refusal says to start the agent manually, without the old-server sentence", async () => {
  await withGatedCore(async ({ core, driver, ctl, ofType }) => {
    ctl.failOpenProcessWrite = true;
    const manager = (core as unknown as { agentManager: AgentProcessManager }).agentManager;
    await assert.rejects(manager.startAgent("agent-7", makeConfig()));
    ctl.failOpenProcessWrite = false;
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(driver.spawnCalls.length, 0);
    const shown = ofType("agent:activity").filter((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string));
    assert.equal(shown.at(-1)?.detail, "Automatic start refused: runtime outcome evidence for this agent is incomplete; start it manually");
  });
});

// --- RFC 071: one automatic-start rule, human recovery bound to its launch, old-epoch gaps (review of #8688, round 6) ---

type GatedContext = Parameters<Parameters<typeof withGatedCore>[0]>[0];

function gatedOutbox(core: DaemonCore): RuntimeOutcomeOutbox {
  return (core as unknown as { runtimeOutcomeOutbox: RuntimeOutcomeOutbox }).runtimeOutcomeOutbox;
}

function gatedManager(core: DaemonCore): AgentProcessManager {
  return (core as unknown as { agentManager: AgentProcessManager }).agentManager;
}

/** The server acks every evidence frame of agent-7 still queued; un-acked markers stay (they are never acked here). */
function ackEvidenceFrames(ctx: GatedContext): void {
  for (const entry of [...gatedOutbox(ctx.core).state("agent-7").entries]) {
    if (entry.t !== "normal") continue;
    ctx.socket.emitServerMessage({ type: "agent:outcome:ack", agentId: "agent-7", daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }
}

/** Evidence frames of agent-7 still queued (they wait behind the un-acked gap: stop-and-wait). */
function queuedFrames(ctx: GatedContext, type: string): Array<Record<string, unknown>> {
  return gatedOutbox(ctx.core).state("agent-7").entries
    .flatMap((entry) => entry.t === "normal" && entry.frame.type === type ? [entry.frame as unknown as Record<string, unknown>] : []);
}

/** Un-acked gap / cross markers of agent-7 as `[takeoverEpoch, gapId]`. */
function unackedMarkers(ctx: GatedContext): Array<[number, string]> {
  return gatedOutbox(ctx.core).state("agent-7").entries
    .filter((entry) => entry.t !== "normal")
    .map((entry) => [entry.takeoverEpoch, (entry as { gapId: string }).gapId]);
}

/** A critical-frame gap: one E1 more than the queue holds folds an E1 into a gap; the server acks the rest, not the gap. */
function makeCriticalGap(ctx: GatedContext, firstSeq: number): void {
  const outbox = gatedOutbox(ctx.core);
  for (let seq = firstSeq; seq <= firstSeq + OUTBOX_NORMAL_CAP; seq += 1) {
    outbox.enqueue({
      type: "agent:runtime:outcome", v: 1, agentId: "agent-7", launchId: `launch-e1-${seq}`, sessionId: "s", daemonInstanceId: "d-e1",
      clientSeq: seq, observedAtMs: 1, outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
    } as OutboxFrame);
  }
  ackEvidenceFrames(ctx);
}

async function exitRunning(ctx: GatedContext, index: number, code: number): Promise<void> {
  ctx.driver.children[index]!.emit("exit", code, null);
  ctx.driver.children[index]!.emit("close", code, null);
  await waitFor(() => !(gatedManager(ctx.core) as unknown as { agents: Map<string, unknown> }).agents.has("agent-7"), "the process is gone");
}

function refusedShown(ctx: GatedContext): number {
  return ctx.ofType("agent:activity").filter((frame) => typeof frame.detail === "string" && /Automatic start refused/.test(frame.detail as string)).length;
}

test("RFC 071 automatic-start rule through DaemonCore: an un-acked gap refuses the daemon's own start; a human agent:start is admitted on its own grant and spawns; a restart right after it (same launchId, no new fault, gap still current) is refused: the grant is spent", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    makeCriticalGap(ctx, 1);
    assert.equal(unackedMarkers(ctx).length, 1, "precondition: one un-acked critical-frame gap");

    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 0, "the internal start is refused: the gap is un-acked");
    assert.equal(refusedShown(ctx), 1, "and the refusal is shown");

    // The human start carries no new epoch: the gap stays current.
    ctx.start("launch-human", { humanStart: true });
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "the admitted human start spawns on its own grant");
    assert.deepEqual(queuedFrames(ctx, "agent:process_spawned").map((frame) => frame.launchId), ["launch-human"]);
    assert.equal(unackedMarkers(ctx).length, 1, "the gap is kept, never deleted to pass");

    await exitRunning(ctx, 0, 1);
    // The daemon's restart of that process carries the same launchId (restart snapshot).
    await manager.startAgent("agent-7", makeConfig(), undefined, undefined, undefined, "launch-human");
    assert.equal(ctx.driver.spawnCalls.length, 1, "the restart is automatic again: refused");
    assert.equal(unackedMarkers(ctx).length, 1);
  }, { autoAck: false });
});

test("RFC 071 automatic-start rule through DaemonCore: an automatic agent:start with a larger epoch exempts no old gap; a human agent:start that durably takes over a new epoch makes it non-blocking; a new gap of that epoch blocks again", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    makeCriticalGap(ctx, 1);
    const [[oldEpoch]] = unackedMarkers(ctx) as [[number, string]];

    ctx.start("launch-auto", { takeoverEpoch: oldEpoch + 5 });
    await waitFor(() => queuedFrames(ctx, "agent:start:outcome").some((frame) => frame.launchId === "launch-auto"), "automatic start result");
    assert.deepEqual(queuedFrames(ctx, "agent:start:outcome").find((frame) => frame.launchId === "launch-auto")!.result,
      { kind: "not_spawned", reason: "terminal_failure_needs_manual" }, "a larger epoch on an automatic start exempts nothing");
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 0, "the old gap still blocks the daemon's own start");

    ackEvidenceFrames(ctx);
    ctx.start("launch-human", { humanStart: true, takeoverEpoch: oldEpoch + 6 });
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "the human takeover spawns");
    const onDisk = JSON.parse(readFileSync(path.join(ctx.outboxDir, "agent-7.json"), "utf8")) as { humanTakeoverEpoch?: number };
    assert.equal(onDisk.humanTakeoverEpoch, oldEpoch + 6, "the takeover is durable");

    await exitRunning(ctx, 0, 0);
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 2, "no new fault since the takeover: the internal restart proceeds");
    assert.deepEqual(unackedMarkers(ctx).map(([epoch]) => epoch), [oldEpoch], "the old gap is still un-acked (kept, not deleted)");

    await exitRunning(ctx, 1, 0);
    ackEvidenceFrames(ctx);
    makeCriticalGap(ctx, 10_000);
    assert.deepEqual(unackedMarkers(ctx).map(([epoch]) => epoch), [oldEpoch, oldEpoch + 6], "a new gap in the new epoch");
    await manager.startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 2, "the new gap blocks the next internal restart");
  }, { autoAck: false });
});

/** An earlier run under an acking server: one E1 more than the queue holds folded an E1 into a gap; the server acked the rest, never the gap. */
function seedCriticalGap(outboxDir: string): void {
  const earlier = new RuntimeOutcomeOutbox({ dir: outboxDir, daemonInstanceId: "d-earlier", send: () => {} });
  earlier.onServerContext(true);
  for (let seq = 1; seq <= OUTBOX_NORMAL_CAP + 1; seq += 1) {
    earlier.enqueue({
      type: "agent:runtime:outcome", v: 1, agentId: "agent-7", launchId: `launch-e1-${seq}`, sessionId: "s", daemonInstanceId: "d-earlier",
      clientSeq: seq, observedAtMs: 1, outcome: { kind: "terminal_failure", failureKind: "compaction_failed", fingerprint: "c4722931c8a1f172", errorClass: "RuntimeError" },
    });
  }
  for (const entry of [...earlier.state("agent-7").entries]) {
    if (entry.t === "normal") earlier.ack({ agentId: "agent-7", daemonInstanceId: entry.daemonInstanceId, clientSeq: entry.clientSeq });
  }
  earlier.stop();
}

test("RFC 071 outbox through DaemonCore (old server, regression): 200 start/exit cycles queue nothing, form no gap, and never refuse an automatic start; the daemon's own start still spawns", async () => {
  await withGatedCore(async (ctx) => {
    const outbox = gatedOutbox(ctx.core);
    const agents = (gatedManager(ctx.core) as unknown as { agents: Map<string, unknown> }).agents;
    for (let cycle = 0; cycle < 200; cycle += 1) {
      ctx.start(`launch-${cycle}`);
      await waitFor(() => ctx.driver.spawnCalls.length === cycle + 1, `cycle ${cycle}: the automatic start spawns`);
      ctx.driver.children[cycle]!.emit("exit", cycle % 2, null);
      ctx.driver.children[cycle]!.emit("close", cycle % 2, null);
      await waitFor(() => !agents.has("agent-7"), `cycle ${cycle}: exited`);
      assert.deepEqual(outbox.state("agent-7").entries, [], `cycle ${cycle}: nothing is queued for a server that never consumes it`);
      assert.equal(outbox.refusesAutomaticStart("agent-7"), false, `cycle ${cycle}: automatic starts are not refused`);
    }
    assert.equal(outbox.isUnreliable("agent-7"), false);
    await gatedManager(ctx.core).startAgent("agent-7", makeConfig());
    assert.equal(ctx.driver.spawnCalls.length, 201, "the daemon's own start spawns");
    const open = JSON.parse(readFileSync(path.join(ctx.outboxDir, "agent-7@open-launches.json"), "utf8")) as { requests: unknown[]; processes: unknown[] };
    assert.deepEqual([open.requests.length, open.processes.length], [0, 1], "every settled launch and exited process was closed; only the running one is open");
  }, { acks: false });
});

test("RFC 071 outbox through DaemonCore (reconnect to an upgraded server): last known was old; before the new connection's context a running process exits (kept) and a start is requested (held); the context says acks: the exit is sent with its original identity and the held start runs", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    const outbox = gatedOutbox(ctx.core);
    const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;
    ctx.start("launch-1");
    await waitFor(() => ctx.driver.spawnCalls.length === 1, "a compat process runs on the old server");
    assert.deepEqual(outbox.state("agent-7").entries, [], "precondition: nothing queued for the old server");

    ctx.socket.close();
    await waitFor(() => ctx.sockets.length === 2, "reconnect");
    ctx.sockets[1]!.emitOpen({ machineContext: false }); // the new (upgraded) server's context has not arrived yet
    assert.equal(outbox.currentServerCapability(), "unknown", "the last known 'old' does not stand in");

    ctx.driver.children[0]!.emit("exit", 1, null);
    ctx.driver.children[0]!.emit("close", 1, null);
    await waitFor(() => !agents.has("agent-7"), "the process exited");
    const kept = outbox.state("agent-7").entries.flatMap((entry) => entry.t === "normal" && entry.frame.type === "agent:process_exited" ? [entry.frame] : []);
    assert.equal(kept.length, 1, "the exit is kept");

    const held = manager.startAgent("agent-7", makeConfig());
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ctx.driver.spawnCalls.length, 1, "the start is held, not refused");

    ctx.sockets[1]!.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1] });
    await held;
    await waitFor(() => ctx.driver.spawnCalls.length === 2, "the held start runs after the context");
    await waitFor(() => ctx.sockets[1]!.sent.some((msg) => (msg as { type?: string }).type === "agent:process_exited"), "the exit is sent");
    const sentExit = ctx.sockets[1]!.sent.find((msg) => (msg as { type?: string }).type === "agent:process_exited") as Record<string, unknown>;
    assert.deepEqual([sentExit.daemonInstanceId, sentExit.clientSeq, sentExit.processInstanceId], [kept[0]!.daemonInstanceId, kept[0]!.clientSeq, kept[0]!.processInstanceId], "with its original identity");
  }, { acks: false });
});

test("RFC 071 automatic-start rule through DaemonCore (old server): a critical gap does not refuse the daemon's own restart or a server automatic agent:start; the gap is kept", async () => {
  await withGatedCore(async (ctx) => {
    const manager = gatedManager(ctx.core);
    assert.equal(unackedMarkers(ctx).length, 1, "precondition: the critical-frame gap an earlier run left is kept on the old server");

    await manager.startAgent("agent-7", makeConfig(), { channel_name: "general", sender_name: "richard", content: "wake while the gap is open" } as never);
    assert.equal(ctx.driver.spawnCalls.length, 1, "the internal restart spawns");
    ctx.driver.children[0]!.kill();
    await waitFor(() => !manager.getRunningAgentIds().includes("agent-7"), "stopped");

    ctx.start("launch-auto");
    await waitFor(() => ctx.driver.spawnCalls.length === 2, "the server's automatic start spawns");
    assert.equal(unackedMarkers(ctx).length, 1, "the gap is kept");
  }, { acks: false, seedOutbox: seedCriticalGap });
});

test("RFC 071 outbox through DaemonCore: a start that fails before its process exists, or whose spawn fails without an exit event, leaves no open process behind, so a restart is clean", async () => {
  for (const failure of ["before_spawn", "spawn_error"] as const) {
    await withGatedCore(async (ctx) => {
      if (failure === "before_spawn") ctx.driver.failSpawn = new Error("Model deepseek/deepseek-v4-flash is not available for the builtin runtime on this computer");
      ctx.start("launch-1");
      if (failure === "spawn_error") {
        await waitFor(() => ctx.driver.children.length === 1, "spawned");
        // What Node does on EACCES / ENOENT: `error`, then `close` with the negative errno; never `exit`.
        ctx.driver.children[0]!.emit("error", Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }));
        ctx.driver.children[0]!.emit("close", -13, null);
      }
      await waitFor(() => existsSync(path.join(ctx.outboxDir, "agent-7@open-launches.json"))
        && openLaunchesOnDisk(ctx.outboxDir).requests.length === 0
        && openLaunchesOnDisk(ctx.outboxDir).processes.length === 0, `${failure}: nothing left open`);
      const restarted = new RuntimeOutcomeOutbox({ dir: ctx.outboxDir, daemonInstanceId: "d-next", send: () => {} });
      restarted.load();
      assert.equal(restarted.isUnreliable("agent-7"), false, `${failure}: a restart is clean`);
      restarted.stop();
    }, { acks: false });
  }
});

test("DaemonCore mints a runner credential before starting an agent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const mintCalls: Array<{ url: string; headers: Headers; body: any }> = [];
  const revokeCalls: Array<{ url: string; headers: Headers; method?: string }> = [];
  // A host of its own, and only its mints and revokes count: an earlier test's
  // daemon can still reach this process-global mock (staging run 42565160244),
  // as in the ready and rebind tests (#13633).
  const serverUrl = "https://daemon-mint-first.example.com";
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== serverUrl) return new Response(null, { status: 404 });
    if (init?.method === "DELETE") {
      revokeCalls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        method: init.method,
      });
      return new Response(null, { status: 204 });
    }
    if (init?.method !== "POST" || !/^\/internal\/computer\/runners\/[^/]+\/credentials$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
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
    serverUrl,
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
        serverUrl: options?.serverUrl ?? serverUrl,
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

// #wg-rbac:#27: a start the hosts rebind onto the running process runs on that
// process's runner credential. Minting one for it left a key nothing used and
// nothing revoked, valid on the server for good.
// Teeth: mint unconditionally in handleAgentStart -> a second mint -> RED.
test("DaemonCore mints no runner credential for a start that rebinds the running process; stop revokes the running one once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  // A host of its own: late requests from an earlier test's daemon reach
  // this process-global mock too, and must not count as this test's mints.
  const serverUrl = "https://daemon-rebind-creds.example.com";
  const requests: string[] = [];
  let minted = 0;
  const revokedPaths: string[] = [];
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    // Only this host's revokes count, as only its mints do: a late DELETE from
    // an earlier test's daemon reached this process-global mock too.
    if (init?.method === "DELETE") {
      if (url.origin === serverUrl) revokedPaths.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    // Only a mint counts (see the ready test below).
    if (url.origin !== serverUrl || init?.method !== "POST" || !/^\/internal\/computer\/runners\/[^/]+\/credentials$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    minted += 1;
    return new Response(JSON.stringify({ apiKey: `sk_agent_minted_${minted}`, credentialId: `cred-${minted}` }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const core = new DaemonCore({
    serverUrl,
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
        serverUrl: options?.serverUrl ?? serverUrl,
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
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => minted === 1 && driver.spawnCalls.length === 1, "fresh start mints once and spawns");
    assert.equal(driver.spawnCalls[0]?.config.agentCredentialId, "cred-1");

    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-2",
      launchId: "launch-2",
      config: makeConfig({ agentCredentialKey: null }),
    });
    await waitFor(() => socket.sent.some((message) => (message as { type?: string; startDispatchId?: string }).type === "agent:start:ack"
      && (message as { startDispatchId?: string }).startDispatchId === "dispatch-2"), "rebound start acked");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(minted, 1, "the rebound start mints no credential");
    assert.equal(driver.spawnCalls.length, 1, "the start is rebound, not spawned");
    assert.deepEqual(revokedPaths, [], "the running process's credential is not revoked by the rebind");

    driver.children[0]?.kill();
    await waitFor(() => revokedPaths.length === 1, "running credential revoked at exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(revokedPaths, ["/internal/computer/runners/agent-1/credentials/cred-1"]);
  } finally {
    restoreFetch();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// #wg-rbac:#27: every ready declares runner-credential reconcile and lists the
// runner credentials the daemon's processes hold, read when the frame is
// built: none before any start, both live processes' after a reconnect, and
// no longer the one whose process ended.
// Teeth: drop the legacy host's list from AgentHostRouter.getHeldRunnerCredentialIds -> RED.
test("DaemonCore ready lists the runner credentials its live processes hold, with the reconcile capability", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  // A host of its own: late requests from an earlier test's daemon reach
  // this process-global mock too, and must not count as this test's mints.
  const serverUrl = "https://daemon-ready-creds.example.com";
  const requests: string[] = [];
  let minted = 0;
  const revokedPaths: string[] = [];
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    // Only this host's revokes count, as only its mints do: a late DELETE from
    // an earlier test's daemon reached this process-global mock too.
    if (init?.method === "DELETE") {
      if (url.origin === serverUrl) revokedPaths.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    // Only a mint counts: any other request through this process-global mock
    // (another test's late daemon, an upload) made `minted` run ahead of the
    // spawns, and the spawn waits below never matched (staging run 42513552475).
    if (url.origin !== serverUrl || init?.method !== "POST" || !/^\/internal\/computer\/runners\/[^/]+\/credentials$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    minted += 1;
    return new Response(JSON.stringify({ apiKey: `sk_agent_minted_${minted}`, credentialId: `cred-${minted}` }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  type ReadyFrame = { type: "ready"; capabilities?: string[]; runnerCredentialIds?: string[] };
  const readiesOn = (socket: FakeWebSocket | undefined): ReadyFrame[] =>
    (socket?.sent ?? []).filter((message): message is ReadyFrame => (message as { type?: string }).type === "ready");
  const reconnect = async (): Promise<FakeWebSocket> => {
    const count = sockets.length;
    sockets.at(-1)?.terminate();
    await waitFor(() => sockets.length === count + 1, "replacement websocket");
    const socket = sockets.at(-1)!;
    socket.emitOpen();
    await waitFor(() => readiesOn(socket).length > 0, "ready after reconnect");
    return socket;
  };
  const assertReadyLists = (socket: FakeWebSocket, expected: string[], label: string) => {
    for (const ready of readiesOn(socket)) {
      assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1), true, label);
      assert.deepEqual([...(ready.runnerCredentialIds ?? ["(absent)"])].sort(), expected, label);
    }
  };

  const core = new DaemonCore({
    serverUrl,
    apiKey: "sk_machine_test",
    dataDir,
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) =>
      new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? serverUrl,
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      }),
  });

  try {
    core.start();
    const first = sockets[0];
    assert.ok(first, "wsFactory should create a websocket");
    first.emitOpen();
    await waitFor(() => readiesOn(first).length > 0, "first ready");
    assertReadyLists(first, [], "no agent: the capability with an empty list");

    for (const [index, agentId] of ["agent-1", "agent-2"].entries()) {
      first.emitServerMessage({
        type: "agent:start",
        agentId,
        startDispatchId: `dispatch-${agentId}`,
        launchId: `launch-${agentId}`,
        config: makeConfig({ agentCredentialKey: null }),
      });
      // An exact target per agent: `spawnCalls.length === minted` alone already
      // holds for agent-2 on agent-1's state, before agent-2's mint is sent.
      const expected = index + 1;
      await waitFor(() => minted === expected && driver.spawnCalls.length === expected && driver.spawnCalls.at(-1)?.config.agentCredentialId === `cred-${expected}`, `${agentId} spawned (minted ${minted}, spawned ${driver.spawnCalls.map((call) => call.config.agentCredentialId).join(",")}; requests ${requests.join(" | ")})`);
    }
    assert.equal(minted, 2);

    const second = await reconnect();
    assertReadyLists(second, ["cred-1", "cred-2"], "both live processes' credentials");

    driver.children[0]?.kill();
    await waitFor(() => revokedPaths.length === 1, "ended process's credential revoked");
    const third = await reconnect();
    assertReadyLists(third, ["cred-2"], "the ended process's credential is gone");
  } finally {
    // Stopping revokes cred-2 through the mocked fetch.
    await core.stop();
    restoreFetch();
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
        daemonInstanceId: options?.daemonInstanceId,
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
    // RFC 069 §8: the start failure reports on the sequenced status channel.
    const status = socket.sent.find((message) => (message as { type?: string }).type === "agent:status") as
      | { agentId?: string; status?: string; daemonInstanceId?: string; clientSeq?: number }
      | undefined;
    assert.equal(status?.agentId, "agent-1");
    assert.equal(status?.status, "inactive");
    assert.equal(typeof status?.daemonInstanceId, "string");
    assert.equal(typeof status?.clientSeq, "number");
    const activity = socket.sent.find((message) => (message as { type?: string }).type === "agent:activity");
    assert.ok(activity);
    assert.equal((activity as { activity?: string }).activity, undefined);
    assert.equal((activity as { detailKind?: string }).detailKind, "runtime_unavailable");
    assert.match(JSON.stringify(activity), /Runner credential mint failed/);
    const failureSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runner_credential_mint.failed");
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
  // A host of its own: the fetch mock is process-global, so late requests from
  // an earlier test's daemon (same agent id, same default host) must not count
  // as this test's mints (seen on CI: 6 !== 3).
  const serverUrl = "https://daemon-mint-retry.example.com";
  const mintPath = "/internal/computer/runners/agent-1/credentials";
  let calls = 0;
  const restoreFetch = installDaemonFetchMockForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin !== serverUrl || url.pathname !== mintPath || method !== "POST") {
      return new Response(null, { status: 404 });
    }
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
    serverUrl,
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
        serverUrl: options?.serverUrl ?? serverUrl,
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
    // Stop before dropping the mock: stop revokes the minted credential over
    // the same fetch, and nothing may leave the process.
    await core.stop();
    restoreFetch();
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


test("DaemonCore answers a re-send of an already-acked plain delivery with the ack alone (task #1295)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let deliverCalls = 0;

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
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      const manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      });
      const deliver = manager.deliverMessage.bind(manager);
      manager.deliverMessage = ((...args: Parameters<typeof deliver>) => {
        deliverCalls += 1;
        return deliver(...args);
      }) as typeof manager.deliverMessage;
      return manager;
    },
  });

  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig() });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn before delivery");

    const delivery = {
      type: "agent:deliver" as const,
      agentId: "agent-1",
      seq: 43,
      deliveryId: "delivery-43",
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel" as const,
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human" as const,
        content: "acked once, re-sent by the server",
        timestamp: new Date(0).toISOString(),
        seq: 43,
        message_id: "msg-43",
      },
    };
    const acks = () => socket.sent.filter((msg: any) =>
      msg.type === "agent:deliver:ack" && msg.deliveryId === "delivery-43" && msg.seq === 43).length;

    socket.emitServerMessage(delivery);
    await waitFor(() => acks() === 1, "first ack");
    assert.equal(deliverCalls, 1);

    socket.emitServerMessage(delivery);
    await waitFor(() => acks() === 2, "the re-send is acked again");
    assert.equal(deliverCalls, 1, "the re-send is not routed to the agent a second time");

    socket.emitServerMessage({ ...delivery, deliveryId: "delivery-44", seq: 44, message: { ...delivery.message, seq: 44, message_id: "msg-44" } });
    await waitFor(() => deliverCalls === 2, "a new delivery id still goes to the agent");
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
    const receivedSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runtime_profile.control.received");
    const injectSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.runtime_profile.control.inject");
    const stdinSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.stdin_delivery");
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

    const daemonSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.delivery");
    assert.ok(daemonSpan, "daemon delivery span should be recorded");
    assert.equal(daemonSpan.context.parentSpanId, serverSpan.context.spanId);
    assert.equal(daemonSpan.attrs?.deliveryId, "delivery-42");
    assert.equal(daemonSpan.attrs?.delivery_correlation_id, "delivery-42");
    assert.equal(ackParent.spanId, daemonSpan.context.spanId);
    // The agent manager's routing fact is recorded while the delivery span is
    // active, so it nests under the delivery instead of floating as a root.
    // Same-millisecond events keep no meaningful order between the span's own
    // events and the manager's point fact, so check the two separately.
    const deliveryEvents = eventsForSpan(sink, traceId, "daemon.agent.delivery");
    assert.deepEqual(deliveryEvents.filter((event) => event.name !== "daemon.agent.delivery.routed").map((event) => event.name), [
      "daemon.receive",
      "daemon.deliver_to_agent_manager",
      "daemon.ack.sent",
    ]);
    const routed = deliveryEvents.filter((event) => event.name === "daemon.agent.delivery.routed");
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.attrs?.accepted, true);
    assert.equal(routed[0]?.attrs?.process_present, true);
  } finally {
    serverSpan.end();
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore keeps an idle auto-restart outside the delivery span", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  // The restart strips the managed runner credential and mints a fresh one.
  const restoreFetch = installDaemonFetchMockForTests((async () =>
    new Response(JSON.stringify({ apiKey: "sk_agent_minted_on_restart", credentialId: "cred-restart" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
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
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig() });
    await waitFor(() => driver.spawnCalls.length === 1, "first agent spawn");
    // A clean exit leaves the agent idle with a restart snapshot, so the next
    // delivery has to restart it from inside deliverMessage.
    driver.children[0]!.kill();
    await flush();

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 43,
      deliveryId: "delivery-43",
      traceparent: formatTraceparent(serverSpan.context),
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "wake an idle agent",
        timestamp: new Date(0).toISOString(),
        seq: 43,
        message_id: "msg-43",
      },
    });
    await waitFor(() => driver.spawnCalls.length === 2, "auto-restart spawn after delivery");
    await waitFor(
      () => traceRows(sink, traceId).some((row) => row.name === "daemon.agent.delivery" && row.attrs?.deliveryId === "delivery-43"),
      "delivery span to end after the restart accepted it",
    );

    const delivery = traceRows(sink, traceId).find((row) => row.name === "daemon.agent.delivery" && row.attrs?.deliveryId === "delivery-43");
    assert.ok(delivery, "delivery span should be recorded");
    const routed = eventsForSpan(sink, traceId, "daemon.agent.delivery").find((event) => event.name === "daemon.agent.delivery.routed");
    assert.equal(routed?.attrs?.outcome, "auto_restart_from_idle", "the routing fact belongs to the delivery");

    // The restart outlives the delivery: its start facts must not hang off the
    // delivery span that happened to trigger it.
    const rows = traceRows(sink);
    for (const name of ["daemon.agent.start.requested", "daemon.agent.start.queued", "daemon.agent.start.dequeued"]) {
      const facts = rows.filter((row) => row.name === name);
      assert.equal(facts.length, 2, `one ${name} fact per start`);
      for (const row of facts) assert.equal(row.context.parentSpanId, null, `${name} must not inherit the delivery span`);
    }
    const spawns = rows.filter((row) => row.name === "daemon.agent.spawn");
    assert.equal(spawns.length, 2);
    for (const row of spawns) assert.notEqual(row.context.parentSpanId, delivery.context.spanId);
  } finally {
    serverSpan.end();
    // Stop before dropping the mock: stop revokes the minted credential over
    // the same fetch, and nothing may leave the process.
    await core.stop();
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore puts the runtime CLI's own version on each start", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: ["opencode"], versions: { opencode: "1.18.35" } }),
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
      }),
    tracer,
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    await waitFor(() => socket.sent.some((m) => (m as { type?: string }).type === "ready"), "ready");
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig({ runtime: "opencode" }), launchId: "launch-1" });
    await waitFor(() => traceRows(sink).some((row) => row.name === "daemon.agent.start"), "start span");
    const start = traceRows(sink).find((row) => row.name === "daemon.agent.start");
    assert.equal(start?.attrs?.runtime_cli_version, "1.18.35");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore records a path-free launch_unresolved event when a runtime launch cannot be resolved", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  driver.failSpawn = new RuntimeExecutableNotFoundError({
    runtimeId: "cursor",
    reason: "batch_target_unresolved",
    message: "Cannot start cursor on Windows: cursor-agent.cmd is a batch wrapper (.cmd/.bat) whose target program could not be found",
  });
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer } = makeDeterministicTracer();
  const restoreFetch = installDaemonFetchMockForTests((async () =>
    new Response(JSON.stringify({ apiKey: "sk_agent_minted", credentialId: "cred-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);

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
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", launchId: "launch-1", config: makeConfig({ runtime: "cursor" }) });
    await waitFor(
      () => traceRows(sink).some((row) => row.name === "daemon.agent.launch_unresolved"),
      "launch_unresolved event",
    );
    const event = traceRows(sink).find((row) => row.name === "daemon.agent.launch_unresolved");
    assert.equal(event?.attrs?.runtime, "cursor");
    assert.equal(event?.attrs?.reason, "batch_target_unresolved");
    assert.equal(event?.attrs?.launchId, "launch-1");
    assert.equal(event?.attrs?.platform, process.platform);
    assert.equal(event?.status, "error");
    assert.ok(!JSON.stringify(event?.attrs).includes("cursor-agent.cmd"), "the event carries the reason, not the message");
  } finally {
    await core.stop();
    restoreFetch();
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
    assert.match(raw, /daemon\.connection\.connect"/);
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
  /** task #1120: classification is by typed code; the classified case must throw a typed error. */
  spawnError?: (rawDetail: string) => Error;
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
      throw options.spawnError ? options.spawnError(options.rawSpawnDetail) : new Error(options.rawSpawnDetail);
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

    const failureSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.agent.spawn.failed");
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

test("after a failed start, a delivery that finds no process shows that failure again, not a bare restart notice", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const sockets: FakeWebSocket[] = [];
  class MissingModelDriver extends FakeDriver {
    override spawn(ctx: SpawnContext): SpawnResult {
      this.spawnCalls.push(ctx);
      throw new RuntimeModelNotFoundError({ runtimeId: "pi", model: "deepseek/deepseek-v4-flash" });
    }
  }
  const driver = new MissingModelDriver();
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
  const activities = () => sockets[0]!.sent.filter((m: any) => m.type === "agent:activity" && m.agentId === "agent-1") as any[];
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig({ model: "deepseek/deepseek-v4-flash" }), launchId: "launch-1" });
    await waitFor(() => activities().length === 1, "start failure activity");
    const failure = activities()[0];
    assert.deepEqual(failure.spawnFailure, { reason: "model_not_found", model: "deepseek/deepseek-v4-flash" });
    assert.match(failure.detail, /renamed or removed/);

    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 0,
      deliveryId: "delivery-1",
      message: {
        channel_id: "channel-1", channel_name: "general", channel_type: "channel",
        sender_id: "user-1", sender_name: "tygg", sender_type: "human",
        content: "are you there?", timestamp: new Date(0).toISOString(), seq: 1, message_id: "msg-1",
      },
    });
    await waitFor(() => socket.sent.some((m: any) => m.type === "agent:delivery:rejected"), "typed rejection");
    const repeated = activities().at(-1);
    assert.equal(activities().length, 2);
    assert.deepEqual(repeated.spawnFailure, failure.spawnFailure, "the delivery re-shows the start failure");
    assert.equal(repeated.detail, failure.detail);
    assert.equal(repeated.launchId, "launch-1");
    assert.equal(activities().some((m) => m.detail === "Process unavailable; restart required"), false);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DaemonCore emits structured trace and user-friendly activity on classified spawn failure", async () => {
  await assertDaemonSpawnFailureProjection({
    rawSpawnDetail: "Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts: "
      + "listen EACCES; Bearer sk-reviewer-secret https://provider.example/private",
    spawnError: (rawDetail) => new AgentProxyBindError(rawDetail),
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

test("task #26: selectWakeDeliveryIndex never promotes server context to the wake slot", () => {
  const ownerFacts = { sender_type: "system", channel_id: "onboarding-context", content: "owner_name=Ada" };
  assert.equal(selectWakeDeliveryIndex([wakeD({ message: ownerFacts }), wakeD({})]), 1, "the real message wakes, not the facts");
  assert.equal(selectWakeDeliveryIndex([wakeD({ message: ownerFacts })]), -1);
});

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

test("DaemonCore answers an agent:deliver for an agent with no process and no snapshot with a typed agent:delivery:rejected (task #1113)", async () => {
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
    // No agent:start ever reached this daemon (e.g. it restarted): deliver straight away.
    socket.emitServerMessage({
      type: "agent:deliver",
      agentId: "agent-1",
      seq: 0,
      deliveryId: "delivery-77",
      message: {
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "tygg",
        sender_type: "human",
        content: "wake me",
        timestamp: new Date(0).toISOString(),
        seq: 77,
        message_id: "msg-77",
      },
    });
    await flush();
    assert.equal(driver.spawnCalls.length, 0, "the daemon has no config to spawn from");
    const rejections = socket.sent.filter((msg: any) => msg.type === "agent:delivery:rejected") as any[];
    assert.equal(rejections.length, 1, "exactly one typed rejection reaches the Server");
    assert.equal(rejections[0].agentId, "agent-1");
    assert.equal(rejections[0].seq, 77);
    assert.equal(rejections[0].deliveryId, "delivery-77");
    assert.equal(rejections[0].reason, "no_process");
    assert.ok(!socket.sent.some((msg: any) => msg.type === "agent:deliver:ack"), "a rejected delivery is never acked as delivered");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a server message type this Computer does not know is ignored: no reply, no workspace, no Agent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-unknown-type-"));
  const socket = new FakeWebSocket();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => socket },
  });
  try {
    core.start();
    socket.emitOpen();
    await waitFor(() => socket.sent.some((m) => (m as { type?: string }).type === "ready"), "ready");
    // A removed wire type (here the retired Wiki start) from an older Server.
    socket.emitServerMessage({ type: "agent:start:wiki", agentId: "unknown-type-agent", config: makeConfig() } as unknown as ServerToMachineMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(socket.sent.some((m) => JSON.stringify(m).includes("unknown-type-agent")), false);
    assert.equal(existsSync(path.join(dataDir, "unknown-type-agent")), false);
    assert.equal(existsSync(path.join(dataDir, "agents", "unknown-type-agent")), false);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("target control wait backs off from 25 ms to a 15 s cap while the source packs, and stops on 410", async () => {
  const signal = new AbortController().signal;
  let now = 0;
  const waits: number[] = [];
  const wait = async (delayMs: number) => {
    waits.push(delayMs);
    now += delayMs;
  };

  // A source that packs for 30 minutes: every poll answers "not ready" (409).
  const packingMs = 30 * 60_000;
  let polls = 0;
  const control = await pollMigrationResumableControl({
    expiresAtMs: 6 * 60 * 60_000,
    signal,
    wait,
    nowMs: () => now,
    poll: async () => {
      polls += 1;
      return now >= packingMs ? "control" : null;
    },
  });
  assert.equal(control, "control");
  assert.deepEqual(
    waits.slice(0, 11),
    [25, 50, 100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 15_000],
    "fast for the first seconds, then doubles up to the cap",
  );
  assert.ok(waits.slice(10).every((delayMs) => delayMs === 15_000), "stays at the 15 s cap");
  assert.ok(polls <= 135, `30 minutes of waiting costs ${polls} polls, not ~900 at the old 2 s cap`);
  assert.ok(now - packingMs < 15_000, "the control is picked up within one cap of being ready");

  // A quick source: ready after ~1 s is picked up within the fast phase.
  now = 0;
  waits.length = 0;
  await pollMigrationResumableControl({
    expiresAtMs: 6 * 60 * 60_000,
    signal,
    wait,
    nowMs: () => now,
    poll: async () => (now >= 1_000 ? "control" : null),
  });
  assert.ok(now < 1_600, `a quick migration is not delayed (${now} ms)`);

  // The last sleep is clamped to the lease, then the wait gives up.
  now = 0;
  waits.length = 0;
  await assert.rejects(
    pollMigrationResumableControl({ expiresAtMs: 20_000, signal, wait, nowMs: () => now, poll: async () => null }),
    /MIGRATION_LEASE_EXPIRED/,
  );
  assert.equal(now, 20_000);

  // A non-retryable answer (410) stops at once, without another sleep.
  now = 0;
  waits.length = 0;
  polls = 0;
  await assert.rejects(
    pollMigrationResumableControl({
      expiresAtMs: 6 * 60 * 60_000,
      signal,
      wait,
      nowMs: () => now,
      poll: async () => {
        polls += 1;
        if (polls === 4) throw new Error("MIGRATION_CONTROL_DOWNLOAD_FAILED:410");
        return null;
      },
    }),
    /MIGRATION_CONTROL_DOWNLOAD_FAILED:410/,
  );
  assert.equal(polls, 4);
  assert.deepEqual(waits, [25, 50, 100]);
});

test("target control steps retry transient failures and never replay a step that already committed", async () => {
  const view = (state: string, generation: string) => ({
    migrationId: "migration",
    migrationRef: "mig_FFFFFFFFFFFFFFFFFFFFFF",
    migrationGeneration: generation,
    state,
    sourceMachineId: "source",
    targetMachineId: "target",
    agentId: "agent",
    manifestPath: null,
    manifestSha256: null,
    canDriveTargetImport: true,
  }) as unknown as MigrationTargetImportView;
  const noWait = async () => undefined;

  // Lost response: the flip committed server-side; the retry reads the view and stops.
  const posted: string[] = [];
  const flipped = await retryMigrationTargetStep({
    step: "flip-machine",
    body: { migrationGeneration: "g6" },
    post: async (body) => {
      posted.push(body.migrationGeneration);
      throw new TypeError("fetch failed");
    },
    fetchView: async () => view("arriving", "g7"),
    wait: noWait,
  });
  assert.equal(flipped.state, "arriving");
  assert.deepEqual(posted, ["g6"], "a committed step is not replayed");

  // Deploy 503, not committed: resend the identical request until it succeeds.
  const attempts: string[] = [];
  const arrived = await retryMigrationTargetStep({
    step: "arrived",
    body: { migrationGeneration: "g7", reportPath: "r", reportSha256: "s" },
    post: async (body) => {
      attempts.push(body.migrationGeneration);
      if (attempts.length < 3) throw new Error("MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:http_error");
      return view("completed", "g9");
    },
    fetchView: async () => view("arriving", "g7"),
    wait: noWait,
  });
  assert.equal(arrived.state, "completed");
  assert.deepEqual(attempts, ["g7", "g7", "g7"]);

  // A superseded generation (canceled / re-provisioned) ends the run; it never borrows the new one.
  const superseded: string[] = [];
  await assert.rejects(retryMigrationTargetStep({
    step: "flip-machine",
    body: { migrationGeneration: "g6" },
    post: async (body) => {
      superseded.push(body.migrationGeneration);
      throw new Error("MIGRATION_TARGET_IMPORT_FLIP_MACHINE_FAILED:502:http_error");
    },
    fetchView: async () => view("in_transit", "g6-new"),
    wait: noWait,
  }), /MIGRATION_TARGET_STEP_GENERATION_SUPERSEDED/);
  assert.deepEqual(superseded, ["g6"]);

  // A 4xx decision is final.
  let decisions = 0;
  await assert.rejects(retryMigrationTargetStep({
    step: "start-transfer",
    body: { migrationGeneration: "g4" },
    post: async () => {
      decisions += 1;
      throw new Error("MIGRATION_TARGET_IMPORT_START_TRANSFER_FAILED:409:migration_not_ready");
    },
    fetchView: async () => view("ready", "g4"),
    wait: noWait,
  }), /409/);
  assert.equal(decisions, 1);

  // The retry budget is bounded.
  let clock = 0;
  await assert.rejects(retryMigrationTargetStep({
    step: "arrived",
    body: { migrationGeneration: "g7" },
    post: async () => { throw new Error("MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:502:http_error"); },
    fetchView: async () => view("arriving", "g7"),
    wait: async (ms) => { clock += ms; },
    nowMs: () => clock,
  }), /502/);
  assert.ok(clock <= 5 * 60_000);
});

test("source bundle-build progress is throttled, flushes the last skipped report, and stops after a 404", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-progress-test-"));
  const migrationId = "migration-progress";
  const reports: Array<Record<string, unknown>> = [];
  let status = 200;
  const server = await withHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/internal/computer/agent-migrations/by-id/${migrationId}/resumable/source-progress`) {
      reports.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = status;
      res.end("{}");
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const core = new DaemonCore({
    serverUrl: server.baseUrl,
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
  });
  try {
    const reporter = (core as unknown as {
      createMigrationSourceProgressReporter: (
        lease: Record<string, unknown>,
        signal: AbortSignal,
      ) => (progress: { phase: "scanning" | "packing" | "hashing"; files: number; bytes: number }) => void;
    }).createMigrationSourceProgressReporter({
      migrationId,
      transportGeneration: "generation-progress",
      bearerToken: "token-progress",
      controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
    }, new AbortController().signal);
    const waitForReports = async (count: number) => {
      for (let attempt = 0; attempt < 600 && reports.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    reporter({ phase: "scanning", files: 1, bytes: 10 });
    now += 29_999;
    reporter({ phase: "scanning", files: 2, bytes: 20 });
    now += 1;
    reporter({ phase: "scanning", files: 3, bytes: 30 });
    await waitForReports(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(reports, [
      { migrationGeneration: "generation-progress", phase: "scanning", files: 3, bytes: 30 },
    ]);

    // A report skipped by the throttle is flushed when the interval ends.
    now += 29_000;
    reporter({ phase: "scanning", files: 5, bytes: 50 });
    now += 1_000;
    await waitForReports(2);
    assert.deepEqual(reports[1], { migrationGeneration: "generation-progress", phase: "scanning", files: 5, bytes: 50 });

    status = 404;
    now += 30_000;
    reporter({ phase: "packing", files: 1, bytes: 5 });
    await waitForReports(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 30_000;
    reporter({ phase: "packing", files: 2, bytes: 9 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reports.length, 3, "a 404 disables further reports for this run");
  } finally {
    Date.now = realNow;
    await core.stop();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the user-ignore receipt is dropped after a 4xx, so the reports go on without it; a 5xx keeps it for the next report", async () => {
  const receipt = { written: 1, alreadyPresent: 0, rejected: [] };
  for (const [status, carriedAgain] of [[400, false], [503, true]] as const) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-receipt-test-"));
    const migrationId = `migration-receipt-${status}`;
    const reports: Array<Record<string, unknown>> = [];
    const server = await withHttpServer(async (req, res) => {
      reports.push(JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>);
      res.statusCode = reports.length === 1 ? status : 200;
      res.end("{}");
    });
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const core = new DaemonCore({
      serverUrl: server.baseUrl,
      apiKey: "sk_machine_test",
      dataDir,
      slockHome: dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
    });
    try {
      const internals = core as unknown as {
        serverContextCapabilities: Set<string>;
        createMigrationSourceProgressReporter: (
          lease: Record<string, unknown>,
          signal: AbortSignal,
          userIgnoreReceipt: { written: number; alreadyPresent: number; rejected: never[] },
        ) => (progress: { phase: "scanning" | "packing"; files: number; bytes: number }) => void;
      };
      internals.serverContextCapabilities = new Set([SERVER_CAPABILITY_MIGRATION_USER_IGNORE_RECEIPT_V1]);
      const reporter = internals.createMigrationSourceProgressReporter({
        migrationId,
        transportGeneration: "generation-receipt",
        bearerToken: "token-receipt",
        controlUrl: `/internal/computer/agent-migrations/by-id/${migrationId}/resumable`,
      }, new AbortController().signal, receipt);
      await waitFor(() => reports.length === 1, "immediate report");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(reports[0]?.userIgnoreAdditions, receipt);
      now += 30_000;
      reporter({ phase: "scanning", files: 4, bytes: 40 });
      await waitFor(() => reports.length === 2, "next report");
      assert.equal("userIgnoreAdditions" in reports[1]!, carriedAgain, `after ${status}`);
      assert.equal(reports[1]?.files, 4);
    } finally {
      Date.now = realNow;
      await core.stop();
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("task #365: the spawn_error report needs BOTH server capabilities (ack and start-spawn-error); otherwise the crash path stays", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const sockets: FakeWebSocket[] = [];
  let manager: AgentProcessManager | null = null;
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
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => new FakeDriver({ supportsStdinNotification: true }),
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      });
      return manager;
    },
  });
  const ACK = SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1;
  const SPAWN = SERVER_CAPABILITY_START_SPAWN_ERROR_V1;
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen({ machineContext: false });
    const cases: Array<[string[] | undefined, boolean]> = [
      [undefined, false],
      [[ACK], false],
      [[SPAWN], false],
      [[ACK, SPAWN], true],
      [[], false],
    ];
    for (const [capabilities, expected] of cases) {
      socket.emitServerMessage({
        type: "machine:context",
        machineId: "machine-test",
        serverId: "server-test",
        ...(capabilities ? { capabilities } : {}),
        connectionEpochId: "epoch-A",
      });
      assert.equal(manager!.reportsSpawnError, expected, JSON.stringify(capabilities ?? null));
    }
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task #365: an automatic start claimed against an earlier connection is refused where the process would be created (stale_dispatch), once per launch", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  // A created child has a pid (Node sets it synchronously on a successful spawn).
  const fakeSpawn = driver.spawn.bind(driver);
  driver.spawn = (ctx: SpawnContext) => {
    const result = fakeSpawn(ctx);
    (result.process as unknown as { pid: number }).pid = IMPOSSIBLE_PID_BASE + 4000 + driver.children.length;
    return result;
  };
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
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);
  const context = (connectionEpochId: string) => ({
    type: "machine:context" as const,
    machineId: "machine-test",
    serverId: "server-test",
    capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1],
    connectionEpochId,
  });
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    socket.emitServerMessage(context("epoch-A"));
    await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");

    // A replica claimed this automatic start on connection A; the frame left
    // that replica, then the machine reconnected (connection B) before the
    // frame was processed here.
    const heldFrame = {
      type: "agent:start" as const,
      agentId: "agent-1",
      startDispatchId: "dispatch-old",
      launchId: "launch-old",
      config: makeConfig({ sessionId: "session-1" }),
      connectionEpochId: "epoch-A",
    };
    socket.emitServerMessage(context("epoch-B"));
    socket.emitServerMessage(heldFrame);
    await waitFor(() => sentOfType(socket, "agent:start:outcome").length === 1, "the stale start is settled");
    assert.deepEqual(sentOfType(socket, "agent:start:outcome")[0]!.result, { kind: "not_spawned", reason: "stale_dispatch" });
    assert.equal(driver.spawnCalls.length, 0, "no process for a start claimed against another connection");

    // The current connection's claim spawns exactly one process.
    socket.emitServerMessage({ ...heldFrame, startDispatchId: "dispatch-new", launchId: "launch-new", connectionEpochId: "epoch-B" });
    await waitFor(() => sentOfType(socket, "agent:process_spawned").length === 1, "the current start spawns");
    // The stale frame replayed again changes nothing.
    socket.emitServerMessage(heldFrame);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(driver.spawnCalls.length, 1, "exactly one process");
    assert.equal(sentOfType(socket, "agent:process_spawned").length, 1);
  } finally {
    // The shutdown orphan reaper signals snapshotted pids for real. Intercept
    // it (no signal leaves the test) to prove the fake pid does reach it, and
    // that it can only be a pid no host process holds.
    const signalled: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      signalled.push(pid);
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      await core.stop();
    } finally {
      kill.mockRestore();
    }
    await rm(dataDir, { recursive: true, force: true });
    assert.ok(signalled.length > 0, "the shutdown reaper probes the fake child's pid");
    assert.ok(
      signalled.every((pid) => Math.abs(pid) >= IMPOSSIBLE_PID_BASE),
      `every pid the reaper signals is impossible on a real host: ${signalled.join(",")}`,
    );
  }
});

test("task #365: a start claimed on connection A that is still preparing (credential mint) when the machine reconnects as B never spawns", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const fakeSpawn = driver.spawn.bind(driver);
  driver.spawn = (ctx: SpawnContext) => {
    const result = fakeSpawn(ctx);
    (result.process as unknown as { pid: number }).pid = IMPOSSIBLE_PID_BASE + 5000 + driver.children.length;
    return result;
  };
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
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);
  const context = (connectionEpochId: string) => ({
    type: "machine:context" as const,
    machineId: "machine-test",
    serverId: "server-test",
    capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1],
    connectionEpochId,
  });
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    socket.emitServerMessage(context("epoch-A"));
    await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");

    // Hold the start at its credential mint (an await between the frame's arrival and the spawn).
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const mint = (core as any).mintRunnerCredential.bind(core);
    let minting = false;
    (core as any).mintRunnerCredential = async (...args: unknown[]) => {
      minting = true;
      await held;
      return mint(...args);
    };
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-A",
      launchId: "launch-A",
      config: makeConfig({ sessionId: "session-1" }),
      connectionEpochId: "epoch-A",
    });
    await waitFor(() => minting, "the start is preparing");
    socket.emitServerMessage(context("epoch-B"));
    release();

    await waitFor(() => sentOfType(socket, "agent:start:outcome").length === 1, "the stale start is settled");
    assert.deepEqual(sentOfType(socket, "agent:start:outcome")[0]!.result, { kind: "not_spawned", reason: "stale_dispatch" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(driver.spawnCalls.length, 0, "no process for a launch claimed on the old connection");
    assert.equal(sentOfType(socket, "agent:process_spawned").length, 0);
    assert.deepEqual(
      sentOfType(socket, "agent:status").filter((msg) => msg.launchId === "launch-A").map((msg) => msg.status),
      [],
      "the status is left to the current start",
    );
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** task #365: a DaemonCore on fake sockets whose server advertises the spawn-error capability, with a given driver. */
async function epochHarness(driver: RuntimeDriver) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
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
        daemonInstanceId: options?.daemonInstanceId,
      }),
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);
  const context = (connectionEpochId: string) => ({
    type: "machine:context" as const,
    machineId: "machine-test",
    serverId: "server-test",
    capabilities: [SERVER_CAPABILITY_RUNTIME_OUTCOME_ACK_V1, SERVER_CAPABILITY_START_SPAWN_ERROR_V1],
    connectionEpochId,
  });
  core.start();
  const socket = sockets[0]!;
  openAckingServer(socket);
  socket.emitServerMessage(context("epoch-A"));
  await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");
  return {
    core, socket, sentOfType, context,
    async close() {
      await core.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test("task #365: a reconnect during the driver's own async preparation stops the child from being created (checked after the driver's last await)", async () => {
  const inner = new FakeDriver({ supportsStdinNotification: true });
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => { release = resolve; });
  let inPreparation = false;
  // A driver shaped like the real ones: await preparation, then the check, then the child.
  const driver = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
    async spawn(ctx: SpawnContext): Promise<SpawnResult> {
      inPreparation = true;
      await preparing;
      ctx.assertLaunchCurrent?.();
      const result = inner.spawn(ctx);
      (result.process as unknown as { pid: number }).pid = IMPOSSIBLE_PID_BASE + 6000 + inner.children.length;
      return result;
    },
  }) as RuntimeDriver;
  const h = await epochHarness(driver);
  try {
    h.socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-A",
      launchId: "launch-A",
      config: makeConfig({ sessionId: "session-1" }),
      connectionEpochId: "epoch-A",
    });
    await waitFor(() => inPreparation, "the driver is preparing");
    h.socket.emitServerMessage(h.context("epoch-B"));
    release();
    await waitFor(() => h.sentOfType(h.socket, "agent:start:outcome").length === 1, "the stale start is settled");
    assert.deepEqual(h.sentOfType(h.socket, "agent:start:outcome")[0]!.result, { kind: "not_spawned", reason: "stale_dispatch" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inner.children.length, 0, "no child for a launch claimed on the old connection");
    assert.equal(h.sentOfType(h.socket, "agent:process_spawned").length, 0);
    assert.deepEqual(h.sentOfType(h.socket, "agent:status").filter((m) => m.launchId === "launch-A"), [], "status left alone");
  } finally {
    await h.close();
  }
});

test("task #365: a launch that already has its process is never rewritten as not_spawned when its frame is resent after a reconnect", async () => {
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const fakeSpawn = driver.spawn.bind(driver);
  driver.spawn = (ctx: SpawnContext) => {
    const result = fakeSpawn(ctx);
    (result.process as unknown as { pid: number }).pid = IMPOSSIBLE_PID_BASE + 7000 + driver.children.length;
    return result;
  };
  const h = await epochHarness(driver);
  try {
    const frame = {
      type: "agent:start" as const,
      agentId: "agent-1",
      startDispatchId: "dispatch-A",
      launchId: "launch-A",
      config: makeConfig({ sessionId: "session-1" }),
      connectionEpochId: "epoch-A",
    };
    h.socket.emitServerMessage(frame);
    await waitFor(() => h.sentOfType(h.socket, "agent:process_spawned").length === 1, "spawned");
    h.socket.emitServerMessage(h.context("epoch-B"));
    // The server resends the same dispatch (its ack was lost): a duplicate, not a stale start.
    h.socket.emitServerMessage(frame);
    await waitFor(() => h.sentOfType(h.socket, "agent:start:ack").length >= 2, "duplicate receipt");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      h.sentOfType(h.socket, "agent:start:outcome").filter((m) => m.launchId === "launch-A" && m.result.kind === "not_spawned"),
      [],
      "the started launch is not rewritten",
    );
    assert.equal(driver.spawnCalls.length, 1);
  } finally {
    await h.close();
  }
});

test("DaemonCore stop span records who stopped it and how long it ran", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-stop-source-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => new FakeWebSocket() },
  });
  try {
    core.start();
    await core.stop({ source: "service_unmanaged", signal: "SIGTERM" });
    const stop = traceRows(sink, traceId).find((span) => span.name === "daemon.lifecycle.stop");
    assert.equal(stop?.attrs?.stop_source, "service_unmanaged");
    assert.equal(stop?.attrs?.stop_signal, "SIGTERM");
    assert.equal(stop?.attrs?.shutdown_reason, "daemon_stop");
    assert.equal(typeof stop?.attrs?.uptime_ms, "number");
    assert.ok((stop?.attrs?.uptime_ms as number) >= 0);

    // A second start/stop with no source names it rather than omitting it.
    core.start();
    await core.stop();
    const stops = traceRows(sink, traceId).filter((span) => span.name === "daemon.lifecycle.stop");
    assert.equal(stops.at(-1)?.attrs?.stop_source, "unspecified");
    assert.equal(stops.at(-1)?.attrs?.stop_signal, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("reconciler step 15: a Computer runner's stop after its key was refused is traced with its outcome", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-revoked-stop-test-"));
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => new FakeWebSocket() },
  });
  try {
    core.start();
    await core.stop({ source: "machine_key_revoked" });
    const stop = traceRows(sink, traceId).find((span) => span.name === "daemon.lifecycle.stop");
    assert.equal(stop?.attrs?.stop_source, "machine_key_revoked");
    core.recordMachineKeyRevokedStop({
      reason: "computer_revoked",
      outcome: "deadline",
      agentCount: 2,
      remainingAgentCount: 1,
      durationMs: 20_000,
      deadlineMs: 20_000,
    });
    const event = traceRows(sink, traceId).find((row) => row.name === "daemon.machine_key.revoked_stop");
    assert.deepEqual(
      {
        reason: event?.attrs?.reason,
        outcome: event?.attrs?.outcome,
        agent_count: event?.attrs?.agent_count,
        remaining_agent_count: event?.attrs?.remaining_agent_count,
        duration_ms: event?.attrs?.duration_ms,
        deadline_ms: event?.attrs?.deadline_ms,
      },
      {
        reason: "computer_revoked",
        outcome: "deadline",
        agent_count: 2,
        remaining_agent_count: 1,
        duration_ms: 20_000,
        deadline_ms: 20_000,
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("DaemonCore answers a host identity request with its per-server hash, and only after authenticated context", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-host-identity-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir: path.join(rootDir, "agents"),
    slockHome: rootDir,
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
    socket.emitOpen({ machineContext: false });
    const replies = () => socket.sent.filter((msg) => (msg as { type?: string }).type === "machine:host_identity") as Array<{ hostIdHash: string }>;

    socket.emitServerMessage({ type: "machine:host_identity:request" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(replies(), [], "no reply before the server is authenticated");

    socket.emitServerMessage({ type: "machine:context", machineId: "machine-1", serverId: "server-1" });
    socket.emitServerMessage({ type: "machine:host_identity:request" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hardwareId = await readHardwareId();
    if (hardwareId === undefined) {
      assert.deepEqual(replies(), [], "no readable hardware ID means no reply");
    } else {
      assert.deepEqual(replies().map((msg) => msg.hostIdHash), [hostIdHashForServer(hardwareId, "server-1")]);
      assert.equal(JSON.stringify(socket.sent).includes(hardwareId), false, "the hardware ID itself is never sent");
    }
  } finally {
    await core.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ─── task #17: runtime auth at the core boundary ───
class RecordingRuntimeAuthHost extends RuntimeAuthHost {
  readonly calls: string[] = [];
  constructor() {
    super({ loadRuntime: async () => { throw new Error("no OAR in core tests"); }, kimiStatus: async () => ({ kind: "unknown" }), loadKimiAuth: async () => { throw new Error("no Kimi SDK in core tests"); }, loadProviderAuth: async () => null, send: () => undefined, recordEvent: () => undefined, now: () => 0, serverReads: () => null });
  }
  override async reportStatus(trigger: string): Promise<void> { this.calls.push(`report:${trigger}`); }
  override startLogin(loginId: RuntimeAuthLoginId, runtime: string, region?: string, providerId?: string): void {
    this.calls.push(`start:${runtime}${region ? `@${region}` : ""}${providerId ? `/${providerId}` : ""}:${loginId}`);
  }
  override async logout(requestId: string, runtime: string, providerId?: string): Promise<void> { this.calls.push(`logout:${runtime}${providerId ? `/${providerId}` : ""}:${requestId}`); }
  override submitCode(loginId: RuntimeAuthLoginId, code: string): void { this.calls.push(`code:${loginId}:${code.length}`); }
  override cancelLogin(): void { this.calls.push("cancel"); }
  override async listProviders(requestId: string, runtime: string): Promise<void> { this.calls.push(`providers:${runtime}:${requestId}`); }
  override async connectProvider(requestId: string, runtime: string, input: RuntimeAuthProviderConnectInput): Promise<void> {
    this.calls.push(`connect:${runtime}:${requestId}:${input.providerId}:${input.apiKey.length}`);
  }
}

test("task #17: malformed runtime-auth messages are dropped at the core boundary; a code is never logged", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-auth-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const host = new RecordingRuntimeAuthHost();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAuthHost: host,
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  const loginId = "rtl_aaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const send = (message: unknown) => socket.emitServerMessage(message as ServerToMachineMessage);
    send({ type: "machine:runtime_auth:login:start", loginId: "not-a-login-id", runtime: "claude" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "cursor" });
    // Kimi's start needs the region the person chose; no other runtime's takes one.
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "kimi" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "kimi", region: "auto" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "claude", region: "global" });
    send({ type: "machine:runtime_auth:login:code", loginId, code: 42 });
    send({ type: "machine:runtime_auth:login:code", loginId, code: "secret\nline" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "claude" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "kimi", region: "mainland-cn" });
    send({ type: "machine:runtime_auth:login:code", loginId, code: "secret-code#state" });
    await waitFor(() => host.calls.some((call) => call.startsWith("code:")), "the valid code");
    assert.deepEqual(host.calls.filter((call) => !call.startsWith("report:")), [
      `start:claude:${loginId}`,
      `start:kimi@mainland-cn:${loginId}`,
      `code:${loginId}:17`,
    ]);
    const dropped = traceRows(sink, traceId).filter((row) => row.name === "daemon.runtime_auth.message_dropped");
    assert.equal(dropped.length, 7);
    assert.ok(!JSON.stringify(traceRows(sink, traceId)).includes("secret"), "no trace carries a code");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Pi's login and logout name a provider, and no other runtime's do: anything else is dropped", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-auth-pi-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const host = new RecordingRuntimeAuthHost();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAuthHost: host,
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  const loginId = "rtl_bbbbbbbbbbbbbbbbbbbbbbbb";
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const send = (message: unknown) => socket.emitServerMessage(message as ServerToMachineMessage);
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "pi" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "pi", providerId: "../auth" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "claude", providerId: "anthropic" });
    send({ type: "machine:runtime_auth:logout", requestId: "req-a", runtime: "pi" });
    send({ type: "machine:runtime_auth:logout", requestId: "req-b", runtime: "codex", providerId: "openai" });
    send({ type: "machine:runtime_auth:login:start", loginId, runtime: "pi", providerId: "github-copilot" });
    send({ type: "machine:runtime_auth:logout", requestId: "req-c", runtime: "pi", providerId: "deepseek" });
    await waitFor(() => host.calls.some((call) => call.startsWith("logout:")), "the valid logout");
    assert.deepEqual(host.calls.filter((call) => !call.startsWith("report:")), [
      `start:pi/github-copilot:${loginId}`,
      "logout:pi/deepseek:req-c",
    ]);
    assert.equal(traceRows(sink, traceId).filter((row) => row.name === "daemon.runtime_auth.message_dropped").length, 5);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task #17: runtime auth status is reported only to a server that advertises it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-auth-cap-test-"));
  const sockets: FakeWebSocket[] = [];
  const host = new RecordingRuntimeAuthHost();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: ["claude"], versions: { claude: "2.1.304" } }),
    runtimeAuthHost: host,
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready" && Array.isArray((message as { runtimes?: unknown }).runtimes)), "ready with an inventory");
    await flush();
    assert.deepEqual(host.calls, [], "a server that does not read it gets no report and no status query runs");
    const ready = socket.sent.find((message): message is Extract<MachineToServerMessage, { type: "ready" }> => (message as { type?: string }).type === "ready");
    assert.deepEqual(runtimeAuthRuntimesOfComputer(ready?.capabilities ?? []), ["claude", "codex", "kimi", "qoder", "qwen", "antigravity", "pi", "grok", "opencode", "codebuddy"], "the server may send Kimi, Qoder, Antigravity, Pi, Grok, OpenCode and CodeBuddy sign-ins and Qwen provider connects here");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer(ready?.capabilities ?? []), ["claude", "codex", "kimi", "antigravity", "pi", "grok", "opencode", "codebuddy"], "and Antigravity (OAR 0.98), Pi, Grok (OAR 0.99), OpenCode (OAR 0.100) and CodeBuddy sign-outs");

    socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: [SERVER_CAPABILITY_RUNTIME_AUTH_V1] } as ServerToMachineMessage);
    await waitFor(() => host.calls.length > 0, "a report once the server says it reads one");
    assert.deepEqual(host.calls, ["report:context"]);

    // The same reader again changes nothing; one that reads more runtimes gets a new report.
    socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: [SERVER_CAPABILITY_RUNTIME_AUTH_V1] } as ServerToMachineMessage);
    socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: [SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_AUTH_V2] } as ServerToMachineMessage);
    await waitFor(() => host.calls.length > 1, "a report for the V2 reader");
    assert.deepEqual(host.calls, ["report:context", "report:context"]);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ─── Reconciler step 15 (PR 3): a terminal sign-in lifts the server's sign-in pauses ───
class FreshStatusRuntimeAuthHost extends RecordingRuntimeAuthHost {
  status: RuntimeAuthStatus | null = { kind: "logged_in" };
  override async reportFreshStatus(trigger: string, runtime: RuntimeAuthRuntime): Promise<RuntimeAuthStatus | null> {
    this.calls.push(`fresh:${trigger}:${runtime}`);
    return this.status;
  }
}

async function sharedCredentialCore(capabilities: string[]) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-shared-credentials-test-"));
  const home = path.join(dataDir, "home");
  const authFile = path.join(home, ".codex", "auth.json");
  await mkdir(path.dirname(authFile), { recursive: true });
  await writeFile(authFile, "{\"tokens\":{\"access_token\":\"old\"}}");
  const sockets: FakeWebSocket[] = [];
  const host = new FreshStatusRuntimeAuthHost();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: ["codex"], versions: { codex: "0.130.0" } }),
    runtimeAuthHost: host,
    credentialDiskWatch: { baseEnv: () => ({}), homeDir: home, platform: "linux", cwd: home, setInterval: () => ({}), clearInterval: () => undefined },
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  core.start();
  const socket = sockets[0]!;
  socket.emitOpen();
  await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready" && Array.isArray((message as { runtimes?: unknown }).runtimes)), "ready with an inventory");
  socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities } as ServerToMachineMessage);
  await flush();
  const watch = (core as unknown as { credentialDiskWatch: CredentialDiskWatch }).credentialDiskWatch;
  let mtime = Date.now() / 1000;
  const signIn = async (token: string) => {
    await writeFile(authFile, `{"tokens":{"access_token":"${token}"}}`);
    mtime += 60;
    await utimes(authFile, mtime, mtime);
  };
  const frames = () => socket.sent.filter((message) => (message as { type?: string }).type === "machine:runtime_credentials:changed");
  const outcomes = () => traceRows(sink, traceId).filter((row) => row.name === "daemon.runtime_credentials.changed");
  const close = async () => { await core.stop(); await rm(dataDir, { recursive: true, force: true }); };
  return { host, watch, signIn, frames, outcomes, close, sink, traceId, home };
}

const CREDENTIALS_CHANGED_SERVER = [SERVER_CAPABILITY_RUNTIME_AUTH_V1, SERVER_CAPABILITY_RUNTIME_CREDENTIALS_CHANGED_V1];

test("PR 3: a shared Codex sign-in on disk with a fresh logged_in status sends one machine:runtime_credentials:changed {runtime}", async () => {
  const t = await sharedCredentialCore(CREDENTIALS_CHANGED_SERVER);
  try {
    assert.deepEqual(t.watch.sharedRuntimes, ["codex"], "the detected runtime the server reads");
    assert.equal(t.watch.running, true);
    await t.watch.check();
    await flush();
    assert.deepEqual(t.host.calls.filter((call) => call.startsWith("fresh:")), [], "no change: no status query");
    assert.deepEqual(t.frames(), []);

    await t.signIn("new");
    await t.watch.check();
    await waitFor(() => t.outcomes().length === 1, "the change handled");
    assert.deepEqual(t.host.calls.filter((call) => call.startsWith("fresh:")), ["fresh:credentials_changed_on_disk:codex"]);
    // The runtime only: no path, digest or account crosses the wire.
    assert.deepEqual(t.frames(), [{ type: "machine:runtime_credentials:changed", runtime: "codex" }]);
    assert.ok(!JSON.stringify(traceRows(t.sink, t.traceId)).includes(t.home), "no trace carries a path");

    await t.watch.check();
    await flush();
    assert.equal(t.frames().length, 1, "no second frame without a second change");
  } finally {
    await t.close();
  }
});

test("PR 3: a change whose fresh status is logged_out, unknown or absent sends no frame", async () => {
  const t = await sharedCredentialCore(CREDENTIALS_CHANGED_SERVER);
  try {
    const statuses: Array<RuntimeAuthStatus | null> = [{ kind: "logged_out" }, { kind: "unknown" }, null];
    for (const [index, status] of statuses.entries()) {
      t.host.status = status;
      // Past the per-runtime gap between two reported changes.
      (t.watch as unknown as { shared: Map<string, { lastReportedAtMs: number | null }> }).shared.get("codex")!.lastReportedAtMs = null;
      await t.signIn(`token-${index}`);
      await t.watch.check();
      await waitFor(() => t.outcomes().length === index + 1, `change ${index} handled`);
    }
    assert.equal(t.host.calls.filter((call) => call.startsWith("fresh:")).length, 3, "each change ran the status query");
    assert.deepEqual(t.frames(), []);
    assert.deepEqual(t.outcomes().map((row) => row.attrs?.auth_status), ["logged_out", "unknown", "none"]);
  } finally {
    await t.close();
  }
});

test("PR 3: a server without the capability gets no frame and the shared homes are not watched (an old server)", async () => {
  const t = await sharedCredentialCore([SERVER_CAPABILITY_RUNTIME_AUTH_V1]);
  try {
    assert.deepEqual(t.watch.sharedRuntimes, []);
    assert.equal(t.watch.running, false, "no timer");
    await t.signIn("new");
    await t.watch.check();
    await flush();
    assert.deepEqual(t.host.calls.filter((call) => call.startsWith("fresh:")), []);
    assert.deepEqual(t.frames(), []);
  } finally {
    await t.close();
  }
});

// ── RFC 060 OAR host ────────────────────────────────────────────────────────

test("RFC 060: ready offers runtime-host:oar unless the daemon's OAR host is off", async () => {
  for (const [oarHost, expected] of [[undefined, true], [false, false]] as const) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-oar-ready-test-"));
    const sockets: FakeWebSocket[] = [];
    const core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      runtimeDetector: () => ({ ids: [], versions: {} }),
      ...(oarHost === undefined ? {} : { oarHost }),
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
      sockets[0]!.emitOpen();
      await waitFor(() => sockets[0]!.sent.some((msg) => (msg as { type?: string }).type === "ready"), "ready");
      const ready = sockets[0]!.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
        (msg as { type?: string }).type === "ready")!;
      assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_HOST_OAR), expected);
      assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX), expected);
      // #oar-raft:#10: with the OAR host, where this daemon can run the Cursor SDK's child (a daemon
      // dependency; the platform, SEA, Node and resolve rules: oarCursorLaunch.test.ts).
      assert.equal(ready.capabilities?.includes(DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR), expected && cursorSdkAvailable());
    } finally {
      await core.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("reconciler step 11c: the OAR host marks its spec-stop handbacks in the legacy host's store, which the legacy refusal reads", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-handback-test-"));
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    openOarSession: () => { throw new Error("not opened"); },
  });
  try {
    const oarHost = (core as any).agentHosts.oar;
    assert.ok(oarHost, "the OAR host is wired");
    assert.equal(oarHost.specHandbacks, (core as any).agentManager.specHandbacks);
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

/**
 * The Server's managed MCP tools endpoint for a test whose OAR Grok start asks
 * for the agent's tools (#14331): answered with no tools, only for that URL;
 * every other request still goes to the guarded fetch.
 */
function stubManagedMcpTools(serverUrl: string): () => void {
  const original = globalThis.fetch;
  const toolsUrl = `${serverUrl}/internal/agent-api/mcp/tools`;
  return installDaemonFetchMockForTests((async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.split("?")[0] !== toolsUrl) return original(input, init);
    return new Response(JSON.stringify({ catalogVersion: 1, tools: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
}

test("RFC 060 + RFC 071: an OAR-hosted grok start reports through the outbox like a driver start (spawned, E2 echo, rebind, exited)", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-oar-core-test-"));
  const dataDir = path.join(rootDir, "agents");
  const binDir = path.join(rootDir, "bin");
  await mkdir(binDir, { recursive: true });
  // prepareGrokLaunch resolves the CLI on PATH; the session itself is OAR's scripted runtime.
  await writeFile(path.join(binDir, "grok"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(binDir, "grok"), 0o755);
  const restoreFetch = stubManagedMcpTools("https://daemon.example.com");
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  const { scriptedRuntime } = await import("@botiverse/oar/testing");
  const inputs: string[] = [];
  const runtime = scriptedRuntime({ turn: (turn) => { inputs.push(turn.input); turn.say("ok"); } });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    slockCliPath: process.execPath,
    // Grok Build itself at a checked version (#oar-raft:#4): other programs in the slot keep the driver.
    runtimeDetector: () => ({ ids: ["grok"], versions: { grok: "grok 1.0.77" } }),
    openOarSession: (launch) => runtime.session({ kind: "available", via: "bundled" }, launch.options),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  type Sent = MachineToServerMessage;
  const sentOfType = <T extends Sent["type"]>(socket: FakeWebSocket, type: T) =>
    socket.sent.filter((msg): msg is Extract<Sent, { type: T }> => (msg as { type?: string }).type === type);
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    await waitFor(() => sentOfType(socket, "ready").length > 0, "ready");
    const ready = sentOfType(socket, "ready")[0]!;
    const grokConfig = makeConfig({ runtime: "grok", model: "default", runtimeHost: "oar", sessionId: "grok-session-1" });
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: grokConfig,
      resumeMessages: [{
        channel_id: "channel-1",
        channel_name: "general",
        channel_type: "channel",
        sender_id: "user-1",
        sender_name: "richard",
        sender_type: "human",
        content: "owed while paused",
        timestamp: "2026-09-29T10:00:00.000Z",
        message_id: "m1",
        seq: 1,
      }],
      catchupBatchId: "batch-1",
    });
    await waitFor(() => sentOfType(socket, "agent:process_spawned").length === 1, "process spawned");
    const spawned = sentOfType(socket, "agent:process_spawned")[0]!;
    assert.equal(spawned.launchId, "launch-1");
    assert.equal(spawned.daemonInstanceId, ready.daemonInstanceId);
    const firstAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-1");
    assert.equal(firstAck?.queueState, "starting");

    await waitFor(() => sentOfType(socket, "agent:runtime:outcome").length === 1, "turn_completed");
    assert.match(inputs[0] ?? "", /owed while paused/, "the resume catch-up rides the first input");
    assert.deepEqual(sentOfType(socket, "agent:runtime:outcome")[0]!.outcome, {
      kind: "turn_completed", textEvents: 1, toolCalls: 0, catchupBatchId: "batch-1", catchupRenderedRows: 1,
    });

    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", startDispatchId: "dispatch-2", launchId: "launch-2", config: grokConfig });
    await waitFor(() => sentOfType(socket, "agent:start:ack").some((ack) => ack.startDispatchId === "dispatch-2"), "rebind ack");
    const rebindAck = sentOfType(socket, "agent:start:ack").find((ack) => ack.startDispatchId === "dispatch-2")!;
    assert.equal(rebindAck.queueState, "running");
    assert.equal(rebindAck.processInstanceId, spawned.processInstanceId);
    await waitFor(() => sentOfType(socket, "agent:start:outcome").some((frame) => frame.launchId === "launch-2"), "rebound");
    assert.deepEqual(sentOfType(socket, "agent:start:outcome").find((frame) => frame.launchId === "launch-2")!.result, { kind: "rebound", processInstanceId: spawned.processInstanceId });

    socket.emitServerMessage({ type: "agent:stop", agentId: "agent-1" });
    await waitFor(() => sentOfType(socket, "agent:process_exited").length === 1, "process exited");
    const exited = sentOfType(socket, "agent:process_exited")[0]!;
    assert.deepEqual(
      { processInstanceId: exited.processInstanceId, spawnLaunchId: exited.spawnLaunchId, launchId: exited.launchId },
      { processInstanceId: spawned.processInstanceId, spawnLaunchId: "launch-1", launchId: "launch-2" },
    );
    assert.deepEqual(core.getRunningAgentIds(), []);
  } finally {
    restoreFetch();
    await core.stop();
    process.env.PATH = previousPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("RFC 060 + reconciler step 5: the daemon stop resolves only after the OAR runtime's ledger record is written: nothing writes into the machine dir after it", { skip: process.platform === "win32" }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-oar-stop-ledger-"));
  const dataDir = path.join(rootDir, "agents");
  const binDir = path.join(rootDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "grok"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(binDir, "grok"), 0o755);
  const restoreFetch = stubManagedMcpTools("https://daemon.example.com");
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  // The OAR runtime the open hook records: a real group-leading child, so its identity read is real.
  const runtimeChild = spawnProcess("sleep", ["30"], { detached: true, stdio: "ignore" });
  // The open hook's listing of this daemon's children is held until the stop has begun: the race, forced.
  let listingStarted = false;
  let releaseListing!: () => void;
  const listingGate = new Promise<void>((resolve) => { releaseListing = resolve; });
  const { scriptedRuntime } = await import("@botiverse/oar/testing");
  const runtime = scriptedRuntime({ turn: (turn) => { turn.say("ok"); } });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: rootDir,
    slockCliPath: process.execPath,
    runtimeDetector: () => ({ ids: ["grok"], versions: { grok: "grok 1.0.77" } }),
    openOarSession: (launch) => runtime.session({ kind: "available", via: "bundled" }, launch.options),
    agentManagerFactory: (sendToServer, daemonApiKey, options) => new AgentProcessManager(sendToServer, daemonApiKey, {
      ...options,
      serverUrl: options?.serverUrl ?? "https://daemon.example.com",
      runtimeProcessLedger: {
        tree: {
          listProcesses: async () => {
            listingStarted = true;
            await listingGate;
            return [{ pid: runtimeChild.pid!, ppid: process.pid, pgid: runtimeChild.pid! }];
          },
        },
      },
    }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  const machineDir = path.join(rootDir, "machines", getDaemonMachineLockId("sk_machine_test"));
  const ledgerFile = path.join(machineDir, "runtime-processes.json");
  let stopping: Promise<void> | null = null;
  try {
    core.start();
    const socket = sockets[0]!;
    openAckingServer(socket);
    await waitFor(() => socket.sent.some((msg) => (msg as { type?: string }).type === "ready"), "ready");
    socket.emitServerMessage({
      type: "agent:start",
      agentId: "agent-1",
      startDispatchId: "dispatch-1",
      launchId: "launch-1",
      config: makeConfig({ runtime: "grok", model: "default", runtimeHost: "oar", sessionId: "grok-session-1" }),
    });
    await waitFor(() => listingStarted, "the open hook's listing");
    const ledgerBefore = await readFile(ledgerFile, "utf8");

    let stopped = false;
    stopping = core.stop().then(() => { stopped = true; });
    await waitFor(() => socket.sent.some((msg) => (msg as { type?: string }).type === "agent:process_exited"), "agent stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false, "the stop waits for the ledger update still running");
    assert.equal(await readFile(ledgerFile, "utf8"), ledgerBefore, "and that update has not written yet");

    releaseListing();
    await stopping;
    stopping = null;
    const recorded = JSON.parse(await readFile(ledgerFile, "utf8")) as { processes: Array<{ pid: number; agentId: string; host: string }> };
    assert.deepEqual(recorded.processes.map((record) => [record.pid, record.agentId, record.host]), [[runtimeChild.pid, "agent-1", "oar"]], "written before the stop resolved");
  } finally {
    restoreFetch();
    releaseListing();
    await (stopping ?? core.stop());
    runtimeChild.kill("SIGKILL");
    process.env.PATH = previousPath;
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a Qwen provider connect reaches the auth host checked, its key in no trace; anything malformed is dropped", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-runtime-auth-provider-test-"));
  const sockets: FakeWebSocket[] = [];
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const host = new RecordingRuntimeAuthHost();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    runtimeAuthHost: host,
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  const KEY = "sk-provider-secret-key-0123456789";
  // Everything the daemon logs, through its logger and straight to the console.
  const logs: string[] = [];
  const unsubscribeLogs = subscribeDaemonLogs((event) => { logs.push(`${event.line} ${String(event.error ?? "")}`); });
  const consoleOriginals = (["log", "info", "warn", "error", "debug"] as const).map((name) => [name, console[name]] as const);
  for (const [name] of consoleOriginals) {
    console[name] = (...args: unknown[]) => { logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" ")); };
  }
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    const send = (message: unknown) => socket.emitServerMessage(message as ServerToMachineMessage);
    const connect = { type: "machine:runtime_auth:connect_provider", requestId: "req-1", runtime: "qwen", providerId: "deepseek", apiKey: KEY };
    send({ ...connect, runtime: "claude" }); // no provider key for Claude Code
    send({ ...connect, runtime: "grok" });
    send({ ...connect, apiKey: `${KEY} two` });
    send({ ...connect, providerId: "../x" });
    send({ ...connect, requestId: "" });
    send({ ...connect, baseUrl: "file:///etc/passwd" });
    send({ type: "machine:runtime_auth:providers", requestId: "req-list", runtime: "codex" });
    send({ type: "machine:runtime_auth:providers", requestId: "req-list", runtime: "qwen" });
    send({ ...connect });
    await waitFor(() => host.calls.some((call) => call.startsWith("connect:")), "the valid connect");
    // The handler itself, on a message object this test keeps: the key is gone from it once handled.
    const kept = { ...connect, requestId: "req-2" };
    (core as unknown as { handleMessage(msg: unknown): void }).handleMessage(kept);
    assert.ok(!("apiKey" in kept), "the message no longer holds the key after handling");
    const refused = { ...connect, requestId: "" };
    (core as unknown as { handleMessage(msg: unknown): void }).handleMessage(refused);
    assert.ok(!("apiKey" in refused), "nor after a refused one");
    assert.deepEqual(host.calls.filter((call) => !call.startsWith("report:")), [
      "providers:qwen:req-list",
      `connect:qwen:req-1:deepseek:${KEY.length}`,
      `connect:qwen:req-2:deepseek:${KEY.length}`,
    ]);
    const dropped = traceRows(sink, traceId).filter((row) => row.name === "daemon.runtime_auth.message_dropped");
    assert.equal(dropped.length, 8);
    assert.ok(!JSON.stringify(traceRows(sink, traceId)).includes("sk-provider-secret"), "no trace carries the key, valid or not");
    assert.ok(logs.some((line) => line.includes("machine:runtime_auth:connect_provider")), "the connects were logged, by type");
    assert.ok(!logs.join("\n").includes("sk-provider-secret"), "no daemon log line carries the key, valid or not");
  } finally {
    unsubscribeLogs();
    for (const [name, original] of consoleOriginals) console[name] = original;
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reconciler step 5: with local trace off, the runtime process ledger still starts with the machine lock: a crashed daemon's live orphan is reaped and starts wait for it", { skip: process.platform === "win32" }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-orphan-sweep-"));
  const dataDir = path.join(rootDir, "agents");
  const machineStateDir = path.join(rootDir, "machines");
  const apiKey = "sk_machine_test";
  const machineDir = path.join(machineStateDir, getDaemonMachineLockId(apiKey));
  await mkdir(machineDir, { recursive: true });
  // What a crashed daemon left: a runtime in its own group that ignores
  // SIGTERM, with a grandchild, reparented; recorded in the ledger.
  const pidFile = path.join(rootDir, "orphan.pid");
  const grandchildFile = path.join(rootDir, "grandchild.pid");
  const runtimeScript = `process.on("SIGTERM", () => {}); const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(grandchildFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const crashed = spawnProcess(process.execPath, ["-e", `const r = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(runtimeScript)}], { detached: true, stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(r.pid)); r.unref();`], { stdio: "ignore" });
  await new Promise((resolve) => crashed.on("exit", resolve));
  const readPid = async (file: string) => Number((await readFile(file, "utf8").catch(() => "")).trim()) || 0;
  let orphanPid = 0;
  let grandchildPid = 0;
  for (let i = 0; i < 200 && !(orphanPid && grandchildPid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    orphanPid = await readPid(pidFile);
    grandchildPid = await readPid(grandchildFile);
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(orphanPid > 0 && grandchildPid > 0, "precondition: the orphan and its grandchild run");
  await new RuntimeProcessLedger(path.join(machineDir, RUNTIME_PROCESS_LEDGER_FILE)).record(orphanPid, { agentId: "agent-1", launchId: "launch-old", host: "legacy" });

  const previousLocalTrace = process.env.SLOCK_DAEMON_LOCAL_TRACE;
  process.env.SLOCK_DAEMON_LOCAL_TRACE = "0";
  const events: string[] = [];
  const reapedAttrs: Array<Record<string, unknown>> = [];
  const driver = new FakeDriver();
  let started: Promise<unknown> = Promise.resolve();
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey,
    dataDir,
    machineStateDir,
    localTrace: true,
    connectionOptions: { wsFactory: () => new FakeWebSocket() },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      const manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        ...options,
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        stopKill: { graceMs: 300, confirmMs: 2_000 },
      });
      const record = (manager as any).recordDaemonEvent.bind(manager);
      (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
        events.push(name);
        if (name === "daemon.agent.orphan.reaped") reapedAttrs.push(attrs);
        return record(name, attrs, ...rest);
      };
      return manager;
    },
  });
  try {
    core.start();
    assert.equal(existsSync(path.join(machineDir, "traces")), false, "precondition: no local trace sink");
    started = (core as any).agentManager.startAgent("agent-1", {
      name: "agent", displayName: "Agent", description: "d", model: "m", runtime: "codex", reasoningEffort: null, envVars: null,
      sessionId: null, serverUrl: "https://daemon.example.com", authToken: apiKey, agentCredentialKey: "sk_agent_test", agentCredentialId: null,
    } as AgentConfig).catch(() => {});
    await waitFor(() => events.includes("daemon.agent.orphan.reaped"), "the orphan sweep", 5_000);

    assert.equal(alive(orphanPid), false, "the orphan is reaped");
    await waitFor(() => !alive(grandchildPid), "the grandchild's death", 2_000);
    assert.equal(reapedAttrs[0]?.pids, String(orphanPid));
    assert.equal(reapedAttrs[0]?.escalated_count, 1, "SIGTERM ignored: SIGKILLed after the grace");
    const waiting = events.indexOf("daemon.agent.start.waiting_for_orphan_reap");
    assert.ok(waiting >= 0 && waiting < events.indexOf("daemon.agent.orphan.reaped"), "the agent's start waited for the reap");
    assert.equal(driver.spawnCalls.length === 0 || events.indexOf("daemon.agent.orphan.reaped") < events.indexOf("daemon.agent.spawn.started"), true, "nothing spawned before the reap");
  } finally {
    await core.stop();
    if (previousLocalTrace === undefined) delete process.env.SLOCK_DAEMON_LOCAL_TRACE;
    else process.env.SLOCK_DAEMON_LOCAL_TRACE = previousLocalTrace;
    for (const pid of [orphanPid, grandchildPid]) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    // The start runs on after the reap and can still be writing the agent's
    // workspace when `core.stop()` returns (stop does not wait for in-flight
    // starts): let it settle, and retry the removal (ENOTEMPTY when a file
    // lands mid-rm, seen on CI). The timer covers a start that reached the
    // capability gate after the outbox stopped, which never settles.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([started, new Promise((resolve) => { settleTimer = setTimeout(resolve, 5_000); })]);
    clearTimeout(settleTimer);
    await rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// Reconciler step 11a: `agent:config` is ordered before any host sees it.
// RED proof: skip `acceptPush` in handleAgentConfigMessage and the stale
// revisions 4 and 6 replace the applied config; drop the `noteStart` call and
// revision 4 (older than the start's 5) applies.
test("DaemonCore orders agent:config by revision: older than the start or the last push is dropped, the newer one applies", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let manager!: AgentProcessManager;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    oarHost: false,
    connectionOptions: {
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
      });
      return manager;
    },
  });

  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    await waitFor(() => socket.sent.some((message) => (message as { type?: string }).type === "ready"), "ready");
    const ready = socket.sent.find((message) => (message as { type?: string }).type === "ready") as { capabilities: string[] };
    assert.ok(ready.capabilities.includes(DAEMON_CAPABILITY_AGENT_CONFIG_PUSH));

    socket.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig({ model: "sonnet" }), configRevision: 5 });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");
    const configOf = () => (manager as any).agents.get("agent-1").config as AgentConfig;

    socket.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ model: "haiku" }), revision: 4 });
    assert.equal(configOf().model, "sonnet", "older than the start's config");
    socket.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ model: "opus" }), revision: 7 });
    assert.equal(configOf().model, "opus");
    socket.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ model: "haiku" }), revision: 6 });
    assert.equal(configOf().model, "opus", "an older push arriving later is dropped");
    assert.equal(driver.spawnCalls.length, 1, "a push never starts a process");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Reconciler step 11d: every ready reports the config revision each running
// agent applied, so the server re-sends a push lost on the way; the highest
// one applied, so a stale start that kept a newer push reports the newer one.
// RED proof: drop `runningAgentConfigRevisions` from the ready frame and no
// revision is reported.
test("DaemonCore ready reports each running agent's applied config revision: a re-sent push advances it, a stale start does not lower it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let manager!: AgentProcessManager;
  type ReadyFrame = { type: "ready"; runningAgents: string[]; runningAgentConfigRevisions?: Record<string, number> };
  const readiesOn = (socket: FakeWebSocket): ReadyFrame[] =>
    socket.sent.filter((message): message is ReadyFrame => (message as { type?: string }).type === "ready");
  const reconnect = async (): Promise<FakeWebSocket> => {
    const count = sockets.length;
    sockets.at(-1)?.terminate();
    await waitFor(() => sockets.length === count + 1, "replacement websocket");
    const socket = sockets.at(-1)!;
    socket.emitOpen();
    await waitFor(() => readiesOn(socket).length > 0, "ready after reconnect");
    return socket;
  };
  const reportedOn = (socket: FakeWebSocket) => readiesOn(socket).at(-1)!.runningAgentConfigRevisions;
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    oarHost: false,
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
      });
      return manager;
    },
  });

  try {
    core.start();
    const first = sockets[0]!;
    first.emitOpen();
    await waitFor(() => readiesOn(first).length > 0, "first ready");
    assert.deepEqual(reportedOn(first), {}, "nothing runs");

    first.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig({ model: "sonnet" }), configRevision: 5 });
    // An older server's start names no revision: not reported, so never compared.
    first.emitServerMessage({ type: "agent:start", agentId: "agent-2", config: makeConfig({ model: "sonnet" }) });
    await waitFor(() => driver.spawnCalls.length === 2, "both agents spawned");
    const configOf = () => (manager as any).agents.get("agent-1").config as AgentConfig;

    // The push of revision 6 is lost with the first socket; the ready says 5.
    const second = await reconnect();
    assert.deepEqual(readiesOn(second).at(-1)!.runningAgents.sort(), ["agent-1", "agent-2"]);
    assert.deepEqual(reportedOn(second), { "agent-1": 5 });

    // The server re-sends it on the new connection: applied, the next ready says 6.
    second.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ model: "opus" }), revision: 6 });
    assert.equal(configOf().model, "opus");
    const third = await reconnect();
    assert.deepEqual(reportedOn(third), { "agent-1": 6 });

    // A push of 9, then a start of 8 (stale): the running config stays 9's, and so does the report.
    third.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ model: "haiku" }), revision: 9 });
    third.emitServerMessage({ type: "agent:start", agentId: "agent-1", config: makeConfig({ model: "sonnet" }), configRevision: 8 });
    await waitFor(() => configOf().model === "haiku", "the newer pushed config kept");
    const fourth = await reconnect();
    assert.equal(configOf().model, "haiku");
    assert.deepEqual(reportedOn(fourth), { "agent-1": 9 });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// task #1357 item 1: the daemon reports the limits of every session it builds
// with the revision of the config it was built from (stamped from
// `agent:start` / `agent:config`), declares the capability, and sends each
// live session's last report again after a reconnect: the same frame, with no
// new spawn.
// RED proof: drop withConfigRevision on the start and the spawn has no
// revision, so nothing is reported; drop the re-send after ready and the
// reconnect carries no frame; stamp the push onto the running session and the
// cached report claims revision 6.
test("DaemonCore reports a session's model limits with its build revision and re-sends the same frame after a reconnect", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-core-test-"));
  const driver = new FakeDriver();
  const sockets: FakeWebSocket[] = [];
  let manager!: AgentProcessManager;
  type LimitsFrame = Extract<MachineToServerMessage, { type: "agent:model_limits" }>;
  const framesOn = (socket: FakeWebSocket): LimitsFrame[] =>
    socket.sent.filter((message): message is LimitsFrame => (message as { type?: string }).type === "agent:model_limits");
  const readiesOn = (socket: FakeWebSocket) => socket.sent.filter((message) => (message as { type?: string }).type === "ready") as Array<{ capabilities: string[] }>;
  const reconnect = async (): Promise<FakeWebSocket> => {
    const count = sockets.length;
    sockets.at(-1)?.terminate();
    await waitFor(() => sockets.length === count + 1, "replacement websocket");
    const socket = sockets.at(-1)!;
    socket.emitOpen();
    await waitFor(() => readiesOn(socket).length > 0, "ready after reconnect");
    return socket;
  };
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    oarHost: false,
    connectionOptions: {
      minReconnectDelayMs: 1,
      wsFactory: (_url: string, _options?: Parameters<NonNullable<ConnectionOptions["wsFactory"]>>[1]) => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        tracer: options?.tracer,
        daemonInstanceId: options?.daemonInstanceId,
      });
      return manager;
    },
  });

  try {
    core.start();
    const first = sockets[0]!;
    first.emitOpen();
    await waitFor(() => readiesOn(first).length > 0, "first ready");
    assert.ok(readiesOn(first)[0]!.capabilities.includes(DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1));

    first.emitServerMessage({ type: "agent:start", agentId: "agent-1", launchId: "launch-1", config: makeConfig(), configRevision: 5 });
    await waitFor(() => driver.spawnCalls.length === 1, "agent spawn");
    assert.equal(driver.spawnCalls[0]!.config.configRevision, 5, "the spawn's config carries the start's revision");
    driver.children[0]!.stdout.emit("data", Buffer.from("model_limits\n"));
    await waitFor(() => framesOn(first).length === 1, "limits frame");
    const sent = framesOn(first)[0]!;
    assert.equal(typeof sent.daemonInstanceId, "string");
    assert.equal(sent.daemonInstanceId, (readiesOn(first)[0] as { daemonInstanceId?: string }).daemonInstanceId, "the frame names the instance its ready declared");
    assert.deepEqual({ ...sent, observedAtMs: 0 }, {
      type: "agent:model_limits",
      v: 1,
      agentId: "agent-1",
      launchId: "launch-1",
      sessionId: "session-1",
      configRevision: 5,
      daemonInstanceId: sent.daemonInstanceId,
      seq: 1,
      observedAtMs: 0,
      runtime: "codex",
      modelLimits: TEST_MODEL_LIMITS,
    });

    // A push applied to the running process: its config takes revision 6, the
    // session it runs was built from 5 and still says so.
    first.emitServerMessage({ type: "agent:config", agentId: "agent-1", config: makeConfig({ description: "renamed" }), revision: 6 });
    assert.equal(((manager as any).agents.get("agent-1").config as AgentConfig).configRevision, 6);
    assert.equal(framesOn(first).length, 1, "a push builds no session, so it reports nothing");

    const second = await reconnect();
    await waitFor(() => framesOn(second).length === 1, "limits frame re-sent after ready");
    assert.deepEqual(framesOn(second)[0], sent, "the same session result: same revision, seq and observation time");
    const readyIndex = second.sent.findIndex((message) => (message as { type?: string }).type === "ready");
    assert.ok(second.sent.indexOf(framesOn(second)[0]!) > readyIndex, "sent after the ready that declares the capability");
    assert.equal(driver.spawnCalls.length, 1, "nothing restarted to get it");
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("withConfigRevision stamps a known revision and leaves a config without one untouched", () => {
  const config = makeConfig();
  assert.equal(withConfigRevision(config, undefined), config);
  assert.equal(withConfigRevision(config, Number.NaN), config);
  assert.deepEqual(withConfigRevision(config, 3), { ...config, configRevision: 3 });
  assert.equal(config.configRevision, undefined, "the original is not mutated");
});

// Reconciler step 14 (Q-H): a /migrate source stops the agent only once it
// is quiet (the step 13 drain for that agent: core stopMigrationSourceAgent).
// RED proof: put back the immediate `stopAgent(wait, silent)` and the busy
// agent is killed and quiesced before its turn end, and the held delivery
// test sees the quiesce at once.
async function withMigrationSourceAgent(
  fn: (ctx: {
    core: DaemonCore;
    socket: FakeWebSocket;
    driver: FakeDriver;
    child: FakeChildProcess;
    manager: () => AgentProcessManager;
    /** In order: "kill", and the resumable control steps the source posted ("source-quiesced", then the bundle's, …). */
    steps: string[];
    cancelAcks: Array<Record<string, unknown>>;
    sendLease: (extra?: Partial<AgentMigrationTransportLeaseMessage>) => void;
    sendCancel: () => void;
    deliver: (seq: number, content: string) => void;
    sourceDrainEvents: () => Array<Record<string, unknown>>;
    /** The bodies posted to source-progress, in order. */
    progressReports: Array<Record<string, unknown>>;
  }) => Promise<void>,
  options: {
    /** Capabilities the Server's machine:context advertises (default: none). */
    serverCapabilities?: string[];
    /** source-progress answers this status, or drops the connection (default: 200). */
    sourceProgress?: number | "drop";
  } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-migration-source-drain-test-"));
  const agentId = "agent-source-drain";
  const migrationId = "migration-source-drain";
  const migrationRef = "mig_DRAINDRAINDRAINDRAINAA";
  const transportGeneration = "transport-generation-source-drain";
  const sessionId = "session-source-drain";
  const base = `/internal/computer/agent-migrations/by-id/${migrationId}`;
  const steps: string[] = [];
  const cancelAcks: Array<Record<string, unknown>> = [];
  const progressReports: Array<Record<string, unknown>> = [];
  const transferServer = await withHttpServer(async (req, res) => {
    await readRequestBody(req).then((body) => {
      if (req.url === `${base}/cancel-ack`) cancelAcks.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
      if (req.url === `${base}/resumable/source-progress`) progressReports.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
    });
    if (req.url?.startsWith(`${base}/resumable/`)) steps.push(req.url.slice(`${base}/resumable/`.length));
    res.setHeader("Content-Type", "application/json");
    if (req.url === `${base}/resumable/source-progress` && options.sourceProgress !== undefined) {
      if (options.sourceProgress === "drop") {
        req.socket.destroy();
        return;
      }
      res.statusCode = options.sourceProgress;
      res.end(JSON.stringify({ code: "test", error: "test" }));
      return;
    }
    if (req.url === `${base}/resumable/source-quiesced` || req.url === `${base}/resumable/source-progress` || req.url === `${base}/cancel-ack` || req.url === `${base}/transport-lost`) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // The bundle's first step: the flow went on past the quiesce; stop it here.
    res.statusCode = 409;
    res.end(JSON.stringify({ code: "migration_test_stop", error: "test stops here" }));
  });
  const { sink, tracer } = makeDeterministicTracer();
  let manager: AgentProcessManager | null = null;
  const driver = new FakeDriver({ supportsStdinNotification: true });
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: transferServer.baseUrl,
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: dataDir,
    machineStateDir: path.join(dataDir, "machines"),
    tracer,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    agentManagerFactory: (sendToServer, daemonApiKey, options) => {
      manager = new AgentProcessManager(sendToServer, daemonApiKey, {
        dataDir: options?.dataDir,
        serverUrl: options?.serverUrl ?? "https://daemon.example.com",
        driverResolver: () => driver,
        defaultAgentEnvVarsProvider: options?.defaultAgentEnvVarsProvider,
        tracer: options?.tracer,
      });
      return manager;
    },
  });
  try {
    await mkdir(path.join(dataDir, agentId), { recursive: true });
    await writeFile(path.join(dataDir, agentId, "notes.md"), "workspace\n");
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen({ machineContext: false });
    socket.emitServerMessage({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities: options.serverCapabilities ?? [] });
    socket.emitServerMessage({ type: "agent:start", agentId, config: makeConfig({ sessionId: "session-1" }), launchId: "launch-1" });
    await waitFor(() => driver.children.length === 1, "the agent's process");
    const child = driver.children[0]!;
    const kill = child.kill.bind(child);
    child.kill = (signal) => { steps.push("kill"); return kill(signal); };
    await fn({
      core,
      socket,
      driver,
      child,
      manager: () => manager!,
      steps,
      cancelAcks,
      sendLease: (extra = {}) => socket.emitServerMessage({
        type: "machine:migration_transport:lease",
        agentId,
        migrationId,
        migrationRef,
        migrationGeneration: `agent_migration:${migrationId}:6`,
        sessionId,
        provider: "object_store",
        leaseSource: "server",
        role: "source",
        transferKind: "upload",
        bearerToken: "source-token",
        expiresAt: "2999-07-09T13:00:00.000Z",
        maxBytes: 104857600,
        controlUrl: `${base}/resumable`,
        leaseId: "lease-source-drain",
        transportGeneration,
        sourceMachineId: "source-machine",
        targetMachineId: "target-machine",
        expectedMigrationRevision: 6,
        ...extra,
      }),
      sendCancel: () => socket.emitServerMessage({
        type: "machine:migration:cancel",
        agentId,
        migrationId,
        migrationRef,
        transportGeneration,
        cancelGeneration: "migration_cancel_generation_source_drain_1",
        migrationRevision: 7,
        sessionId,
        role: "source",
        disposition: "pre_flip_source_authoritative",
        stopAgent: false,
      }),
      deliver: (seq, content) => socket.emitServerMessage({
        type: "agent:deliver",
        agentId,
        seq,
        message: {
          channel_id: "channel-1",
          channel_name: "general",
          channel_type: "channel",
          sender_id: "user-1",
          sender_name: "tygg",
          sender_type: "human",
          content,
          timestamp: new Date(0).toISOString(),
          seq,
          message_id: `msg-${seq}`,
        },
      }),
      sourceDrainEvents: () => traceRows(sink)
        .filter((row) => row.name === "daemon.migration_transport.source_drain")
        .map((row) => row.attrs ?? {}),
      progressReports,
    });
  } finally {
    await core.stop();
    await transferServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const FAR_DRAIN_UNTIL = "2999-07-09T12:00:00.000Z";

test("migration source: a busy agent is stopped only after its turn end; a delivery meanwhile is held and not delivered here; then the flow goes on", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(ctx.steps, [], "the first turn runs: no stop, no quiesce yet");
    ctx.deliver(77, "held during the migration");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(ctx.steps, [], "a held delivery does not keep it busy, nor stop it");

    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await waitFor(() => ctx.steps.some((step) => !["kill", "source-quiesced", "source-progress"].includes(step)), "the flow past the quiesce (the bundle's chunk plan)");
    assert.deepEqual(ctx.steps.slice(0, 2), ["kill", "source-quiesced"], "stopped once quiet, then quiesced");
    assert.equal(ctx.child.stdinWrites.some((chunk) => chunk.includes("held during the migration")), false, "not delivered on the source");
    assert.equal(ctx.driver.spawnCalls.length, 1, "not started again here");
    const [event] = ctx.sourceDrainEvents();
    assert.equal(event?.outcome, "quiet");
    assert.equal(event?.hit_deadline, false);
    assert.ok(Number(event?.waited_ms) >= 150, `waited ${String(event?.waited_ms)} ms`);
    assert.equal(event?.deadline_ms, 600_000, "clamped to 10 min");
  });
});

test("migration source: an agent that never gets quiet is stopped at the deadline", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.sendLease({ sourceDrainUntil: new Date(Date.now() + 300).toISOString() });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce at the deadline");
    assert.deepEqual(ctx.steps.slice(0, 2), ["kill", "source-quiesced"]);
    const [event] = ctx.sourceDrainEvents();
    assert.equal(event?.outcome, "deadline");
    assert.equal(event?.hit_deadline, true);
    assert.equal(event?.not_quiet_reason, "agent_busy");
    assert.ok(Number(event?.waited_ms) >= 200, `waited ${String(event?.waited_ms)} ms`);
  });
});

test("migration source: an idle agent is stopped at once", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    const [event] = ctx.sourceDrainEvents();
    assert.equal(event?.outcome, "quiet");
    assert.ok(Number(event?.waited_ms) < 1_000);
  });
});

test("migration source: a lease without sourceDrainUntil (an older Server) stops at once, as before", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.sendLease();
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.deepEqual(ctx.steps.slice(0, 2), ["kill", "source-quiesced"], "killed mid-turn: today's behaviour");
    assert.deepEqual(ctx.sourceDrainEvents(), []);
  });
});

test("migration source: cancelled during the wait, the hold is released, the agent keeps running and gets the held delivery", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctx.deliver(78, "held then released");
    await new Promise((resolve) => setTimeout(resolve, 50));
    ctx.sendCancel();
    await waitFor(() => ctx.cancelAcks.length === 1, "the cancel acknowledgement");
    assert.equal(ctx.cancelAcks[0]!.outcome, "cleaned");
    const [event] = ctx.sourceDrainEvents();
    assert.equal(event?.outcome, "aborted");
    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await waitFor(() => ctx.child.stdinWrites.some((chunk) => chunk.includes("held then released")), "the held delivery");
    assert.deepEqual(ctx.steps, [], "never stopped nor quiesced");
  });
});

// tygg: an agent that cannot work (here: verification_required on its
// credential) is not waited for when only a turn would settle what keeps it
// (a delivery written to stdin that no turn took). The stop, the quiesce and
// the bundle follow as for a quiet one, and nothing is reported read. RED
// proof: drop agentStopWaitReason from the legacy host's computeDrainProgress
// and this waits until FAR_DRAIN_UNTIL (the test times out).
test("migration source: an agent that cannot run, idle, is not waited for; traced not_runnable; nothing is reported read", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();
    const manager = ctx.manager() as any;
    const ap = manager.agents.get("agent-source-drain");
    ap.deliveryConsumption.recordWrite("delivery-1", "stdin_idle_delivery", Date.now());
    manager.lifecycleRecords.providerLimitLedger.recordInvalid(
      providerLimitCredentialKey("agent-source-drain", ap.config),
      { invalidReason: "user_reauth", recordedAtMs: Date.now(), code: "verification_required" },
      { host: "legacy" },
    );
    const sentBefore = ctx.socket.sent.length;
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.deepEqual(ctx.steps.slice(0, 2), ["kill", "source-quiesced"], "stopped, then quiesced: the contract steps still run");
    const [event] = ctx.sourceDrainEvents();
    assert.equal(event?.outcome, "not_runnable");
    assert.equal(event?.not_runnable_reason, "credential_invalid");
    assert.equal(event?.not_waited_for, "delivery_in_flight");
    assert.ok(Number(event?.waited_ms) < 1_000, `waited ${String(event?.waited_ms)} ms`);
    const readFrames = ctx.socket.sent.slice(sentBefore).filter((frame) => ["agent:model-seen", "agent:turn:ended"].includes((frame as { type?: string }).type ?? ""));
    assert.deepEqual(readFrames, [], "nothing reported read: unread on the server for the target");
  });
});

test("migration source: the agent not running here is not waited for", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.socket.emitServerMessage({ type: "agent:stop", agentId: "agent-source-drain" });
    await waitFor(() => ctx.steps.includes("kill"), "the owner's stop");
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.equal(ctx.sourceDrainEvents()[0]?.outcome, "not_running");
  });
});

// The source tells the Server it is waiting for the agent (phase draining),
// once, as the drain begins, and only a Server that advertises
// SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1. RED proof
// (reverse-verified): drop the reportMigrationSourceDraining call and the
// first test sees no report.
const SOURCE_DRAIN_PROGRESS = { serverCapabilities: [SERVER_CAPABILITY_MIGRATION_SOURCE_DRAIN_PROGRESS_V1] };

test("migration source: a busy agent's drain is reported once as draining, with its deadline and turn, before the stop", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    const drainUntil = new Date(Date.now() + 60_000).toISOString();
    ctx.sendLease({ sourceDrainUntil: drainUntil });
    await waitFor(() => ctx.progressReports.length === 1, "the draining report");
    assert.deepEqual(ctx.steps, ["source-progress"], "reported while still waiting: no stop, no quiesce yet");
    assert.deepEqual(ctx.progressReports[0], {
      migrationGeneration: "transport-generation-source-drain",
      phase: "draining",
      drainUntil,
      waitingFor: "turn",
    });
    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.deepEqual(ctx.steps.slice(0, 3), ["source-progress", "kill", "source-quiesced"]);
    assert.equal(ctx.progressReports.filter((report) => report.phase === "draining").length, 1, "exactly one");
  }, SOURCE_DRAIN_PROGRESS);
});

test("migration source: a Server without the drain progress capability gets no draining report", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.sendLease({ sourceDrainUntil: new Date(Date.now() + 300).toISOString() });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce at the deadline");
    assert.deepEqual(ctx.steps.slice(0, 2), ["kill", "source-quiesced"]);
    assert.equal(ctx.progressReports.some((report) => report.phase === "draining"), false);
  });
});

test("migration source: an agent not running here, or already idle, is not reported as draining", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    ctx.socket.emitServerMessage({ type: "agent:stop", agentId: "agent-source-drain" });
    await waitFor(() => ctx.steps.includes("kill"), "the owner's stop");
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.equal(ctx.sourceDrainEvents()[0]?.outcome, "not_running");
    assert.equal(ctx.progressReports.some((report) => report.phase === "draining"), false);
  }, SOURCE_DRAIN_PROGRESS);
  await withMigrationSourceAgent(async (ctx) => {
    ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
    await flush();
    ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
    await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
    assert.equal(ctx.sourceDrainEvents()[0]?.outcome, "quiet");
    assert.equal(ctx.progressReports.some((report) => report.phase === "draining"), false);
  }, SOURCE_DRAIN_PROGRESS);
});

for (const sourceProgress of [503, "drop"] as const) {
  test(`migration source: a draining report that fails (${String(sourceProgress)}) costs the drain and stop nothing`, async () => {
    await withMigrationSourceAgent(async (ctx) => {
      ctx.sendLease({ sourceDrainUntil: FAR_DRAIN_UNTIL });
      await waitFor(() => ctx.progressReports.length === 1, "the draining report");
      ctx.child.stdout.emit("data", Buffer.from("turn_end\n"));
      await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
      assert.deepEqual(ctx.steps.slice(0, 3), ["source-progress", "kill", "source-quiesced"]);
      assert.equal(ctx.sourceDrainEvents()[0]?.outcome, "quiet");
    }, { ...SOURCE_DRAIN_PROGRESS, sourceProgress });
  });
}

// `raft proc` step 2 (#proj-raft-computer:#59): which stops end an agent's
// jobs. Real processes (POSIX). The core's job manager is replaced by one with
// a short grace and user systemd off, on the same machine dir. RED proofs
// (reverse-verified): drop the agent:stop wiring and the owner_stop job
// survives; stop jobs on every agent:stop and the lifecycle job dies; drop the
// workspace-delete or migration call and those jobs survive.
const procPosix = process.platform !== "win32";

async function useTestProcJobs(core: DaemonCore): Promise<ProcJobManager> {
  const internals = core as unknown as { procJobManager: ProcJobManager | null; machineLock: { machineDir: string } | null };
  await waitFor(() => internals.machineLock !== null && internals.procJobManager !== null, "the machine lock and job manager");
  await internals.procJobManager!.close();
  const manager = await ProcJobManager.open({
    machineDir: internals.machineLock!.machineDir,
    graceMs: 300,
    confirmMs: 2_000,
    rotateIntervalMs: 0,
    userSystemd: false,
  });
  internals.procJobManager = manager;
  return manager;
}

async function startProcSleep(manager: ProcJobManager, agentId: string, name: string): Promise<number> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const result = await manager.start(agentId, { name, argv: ["sleep", "60"], cwd: os.tmpdir(), env, stableEntryDir: null, runtime: "claude", launchId: null });
  assert.ok(result.ok, JSON.stringify(result));
  return result.job.pid;
}

function procGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withProcJobsCore(fn: (ctx: { core: DaemonCore; socket: FakeWebSocket; manager: ProcJobManager; dataDir: string; pids: number[] }) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-proc-stop-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: dataDir,
    machineStateDir: path.join(dataDir, "machines"),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  const pids: number[] = [];
  try {
    core.start();
    const socket = sockets[0];
    assert.ok(socket);
    socket.emitOpen();
    const manager = await useTestProcJobs(core);
    await fn({ core, socket, manager, dataDir, pids });
  } finally {
    for (const pid of pids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test.skipIf(!procPosix)("raft proc: the owner's Stop ends the agent's jobs; a lifecycle stop, no reason or an unknown one leaves them running", async () => {
  await withProcJobsCore(async ({ socket, manager, pids }) => {
    const owner = await startProcSleep(manager, "agent-owner", "web");
    const lifecycle = await startProcSleep(manager, "agent-lifecycle", "web");
    const bare = await startProcSleep(manager, "agent-bare", "web");
    const odd = await startProcSleep(manager, "agent-odd", "web");
    const other = await startProcSleep(manager, "agent-other", "web");
    pids.push(owner, lifecycle, bare, odd, other);

    socket.emitServerMessage({ type: "agent:stop", agentId: "agent-lifecycle", reason: "lifecycle" } as ServerToMachineMessage);
    socket.emitServerMessage({ type: "agent:stop", agentId: "agent-bare" });
    socket.emitServerMessage({ type: "agent:stop", agentId: "agent-odd", reason: "something-new" } as unknown as ServerToMachineMessage);
    socket.emitServerMessage({ type: "agent:stop", agentId: "agent-owner", reason: "owner_stop" } as ServerToMachineMessage);
    await waitFor(() => !procGroupAlive(owner), "the owner_stop job's group gone");
    assert.equal((await manager.list("agent-owner"))[0]?.state, "exited");
    // Given the same time the owner's job took, plus a grace.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const pid of [lifecycle, bare, odd, other]) assert.equal(procGroupAlive(pid), true, `job ${pid} still running`);
    assert.equal((await manager.list("agent-lifecycle"))[0]?.state, "running");
  });
});

test.skipIf(!procPosix)("raft proc: a deleted agent's workspace takes its jobs with it, and only its", async () => {
  await withProcJobsCore(async ({ socket, manager, dataDir, pids }) => {
    const agentId = "agent-deleted";
    await mkdir(path.join(dataDir, agentId), { recursive: true });
    const deleted = await startProcSleep(manager, agentId, "bot");
    const kept = await startProcSleep(manager, "agent-kept", "bot");
    pids.push(deleted, kept);
    socket.emitServerMessage({ type: "machine:workspace:delete", directoryName: agentId });
    await waitFor(() => !procGroupAlive(deleted), "the deleted agent's job gone");
    assert.equal(existsSync(path.join(dataDir, agentId)), false);
    assert.equal(procGroupAlive(kept), true);
  });
});

test.skipIf(!procPosix)("raft proc: an agent migrating away has its jobs stopped before the source quiesces", async () => {
  await withMigrationSourceAgent(async (ctx) => {
    const manager = await useTestProcJobs(ctx.core);
    const pid = await startProcSleep(manager, "agent-source-drain", "web");
    const other = await startProcSleep(manager, "agent-stays", "web");
    try {
      ctx.sendLease();
      await waitFor(() => ctx.steps.includes("source-quiesced"), "the quiesce");
      assert.equal(procGroupAlive(pid), false, "stopped before the quiesce");
      assert.equal(procGroupAlive(other), true);
    } finally {
      for (const each of [pid, other]) {
        try { process.kill(-each, "SIGKILL"); } catch { /* gone */ }
      }
    }
  });
});

test.skipIf(!procPosix)("raft proc: once stop() resolves nothing writes proc-jobs.json (no sweep, no exit seen later); the next start opens a new manager", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-proc-close-test-"));
  const sockets: FakeWebSocket[] = [];
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: "sk_machine_test",
    dataDir,
    slockHome: dataDir,
    machineStateDir: path.join(dataDir, "machines"),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: {
      wsFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  const internals = core as unknown as { procJobManager: ProcJobManager | null; machineLock: { machineDir: string } | null };
  let pid = 0;
  try {
    core.start();
    sockets[0]!.emitOpen();
    const manager = await useTestProcJobs(core);
    const machineDir = internals.machineLock!.machineDir;
    const ledger = path.join(machineDir, "proc-jobs.json");
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // Exits on its own shortly after stop(): a live manager would record that exit.
    const started = await manager.start("agent-close", { name: "brief", argv: ["sh", "-c", "sleep 0.4"], cwd: os.tmpdir(), env, stableEntryDir: null, runtime: "claude", launchId: null });
    assert.ok(started.ok, JSON.stringify(started));
    pid = started.job.pid;
    await core.stop();
    const before = await readFile(ledger, "utf8");
    const beforeMtime = (await stat(ledger)).mtimeMs;
    assert.equal(internals.procJobManager, null);
    assert.equal((manager as unknown as { timer: unknown }).timer, null, "the sweep is stopped");
    await waitFor(() => !procGroupAlive(pid), "the job's own exit");
    manager.sweep();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await readFile(ledger, "utf8"), before);
    assert.equal((await stat(ledger)).mtimeMs, beforeMtime);
    assert.equal((JSON.parse(before) as { jobs: Array<{ state: string }> }).jobs[0]?.state, "running", "left for the next daemon to find");
    // close is idempotent.
    await manager.close();

    core.start();
    await waitFor(() => internals.procJobManager !== null, "a new job manager");
    assert.notEqual(internals.procJobManager, manager);
    await internals.procJobManager!.ready;
    const [job] = await internals.procJobManager!.list("agent-close");
    assert.equal(job?.state, "exited", "the next manager finds it gone");
  } finally {
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
