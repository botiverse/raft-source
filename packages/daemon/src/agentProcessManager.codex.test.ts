import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { type AxSurfaceText,
  BasicTracer,
  assertSurfaceProducerFactLineage,
  createScopedTracer,
  createSpanAttrContractTracer,
  eventsForSpan,
  MemoryTraceSink,
  RUNTIME_CONFIG_VERSION,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
  type TrajectoryEntry,
  type Tracer,
  canonicalizeWikiWorkspacePackFiles,
  type WikiWorkspacePack,
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
} from "@botiverse/raft-shared";
import { AgentProcessManager, DecisionErrorWindow, resolveRuntimeSessionRef } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import {
  LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN,
  LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN,
  assertLaunchReadinessPairing,
  assertLaunchActivationPairing,
  type LaunchTransitionRow,
} from "./launchPhaseTransition.js";
import type { RuntimeDriver, RuntimeSendResult, RuntimeSession, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index.js";
import { buildCliTransportSystemPrompt } from "./drivers/cliTransport.js";
import {
  createPiSdkEventMappingState,
  mapPiSdkEventToParsedEvents,
} from "./drivers/pi.js";
import { buildCliSystemPrompt } from "./drivers/systemPrompt.js";
import { RuntimeNotificationState } from "./runtimeNotificationState.js";
import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox.js";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition.js";
import { setSessionReadyDeliveryRetrySchedulerFactoryForTesting } from "./agentInboxDeliveryDebt.js";
import {
  __resetAgentCredentialProxyForTest,
  registerAgentCredentialProxy,
  unregisterAgentCredentialProxyForLaunch,
} from "./agentCredentialProxy.js";
import {
  __resetManagedMcpRuntimeProxyForTest,
  installManagedMcpRuntimeJsonOverlay,
  registerManagedMcpRuntimeProxy,
  unregisterManagedMcpRuntimeProxyForLaunch,
} from "./managedMcpRuntimeProxy.js";
import { ensureWikiAgentWorkspace } from "./wikiAgentWorkspace.js";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "./core.js";
import { FakeClock, waitForExactCount } from "./testing/drydock.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeTestWikiWorkspacePack(): WikiWorkspacePack {
  const files = [
    { relativePath: "AGENTS.md", content: "# Test Wiki Agent\n" },
    { relativePath: "CLAUDE.md", content: "@AGENTS.md\n" },
    { relativePath: ".agents/skills/ingest.md", content: "# Test Ingest\n" },
    {
      relativePath: ".claude/skills/ingest.md",
      content: "# Test Ingest\n\nSee `../../.agents/skills/ingest.md`.\n",
    },
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

test("runtime profile session refs resolve local JSONL paths", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "slock-session-ref-"));
  try {
    const codexSessionId = "019d9fcb-9b2d-7220-b19e-e0282e056e04";
    const codexSessionPath = path.join(
      homeDir,
      ".codex",
      "sessions",
      "2026",
      "04",
      "29",
      `rollout-2026-04-29T00-00-00-000Z-${codexSessionId}.jsonl`,
    );
    await mkdir(path.dirname(codexSessionPath), { recursive: true });
    await writeFile(codexSessionPath, "{}\n");

    assert.deepEqual(resolveRuntimeSessionRef("codex", codexSessionId, homeDir), {
      label: codexSessionId,
      path: codexSessionPath,
      runtime: "codex",
      reachable: true,
    });

    const codexHomeRoot = path.join(homeDir, "codex-home");
    const codexRootSessionId = "019d9fcb-9b2d-7220-b19e-codexhome";
    const codexRootSessionPath = path.join(
      codexHomeRoot,
      "sessions",
      "2026",
      "04",
      "29",
      `rollout-2026-04-29T00-00-00-000Z-${codexRootSessionId}.jsonl`,
    );
    await mkdir(path.dirname(codexRootSessionPath), { recursive: true });
    await writeFile(codexRootSessionPath, "{}\n");

    assert.deepEqual(resolveRuntimeSessionRef("codex", codexRootSessionId, codexHomeRoot), {
      label: codexRootSessionId,
      path: codexRootSessionPath,
      runtime: "codex",
      reachable: true,
    });

    const claudeSessionId = "0618f17e-577e-4e6a-a7f0-31dc50611388";
    const claudeSessionPath = path.join(
      homeDir,
      ".claude",
      "projects",
      "-Users-example-project",
      `${claudeSessionId}.jsonl`,
    );
    await mkdir(path.dirname(claudeSessionPath), { recursive: true });
    await writeFile(claudeSessionPath, "{}\n");

    assert.deepEqual(resolveRuntimeSessionRef("claude", claudeSessionId, homeDir), {
      label: claudeSessionId,
      path: claudeSessionPath,
      runtime: "claude",
      reachable: true,
    });

    const kimiRef = resolveRuntimeSessionRef("kimi", "session-1", homeDir);
    assert.deepEqual(
      { label: kimiRef.label, path: kimiRef.path, runtime: kimiRef.runtime, reachable: kimiRef.reachable },
      { label: "session-1", path: "session-1", runtime: "kimi", reachable: false },
    );
    // #3870 appends an optional `searched=[...]` negative-space clause to the reason.
    assert.match(
      kimiRef.reason ?? "",
      /^session file path not found; attempted_lookup=kimi_sdk_index(; searched=\[.*\])?$/,
    );

    const kimiSessionId = "session_93b650c7-6883-4fa3-9605-f122b1523ebc";
    const kimiAgentId = "d2bf1e2c-3648-4590-a0e2-46c6998b2c38";
    const kimiSessionDir = path.join(homeDir, ".kimi", "sessions", `wd_${kimiAgentId}_3e30f444bcda`, kimiSessionId);
    await mkdir(kimiSessionDir, { recursive: true });
    await writeFile(path.join(kimiSessionDir, "state.json"), "{}", { mode: 0o600 });
    await writeFile(
      path.join(homeDir, ".kimi", "session_index.jsonl"),
      JSON.stringify({ sessionId: kimiSessionId, sessionDir: kimiSessionDir, workDir: "/tmp/ws" }) + "\n",
    );

    assert.deepEqual(resolveRuntimeSessionRef("kimi-sdk", kimiSessionId, homeDir, undefined, { agentId: kimiAgentId }), {
      label: kimiSessionId,
      path: kimiSessionDir,
      runtime: "kimi-sdk",
      reachable: true,
    });

    const piSessionId = "pi-session-001";
    const piWorkspace = path.join(homeDir, "pi-workspace");
    const piSessionPath = path.join(piWorkspace, ".pi-sessions", `2026-06-17T00-00-00-000Z_${piSessionId}.jsonl`);
    await mkdir(path.dirname(piSessionPath), { recursive: true });
    await writeFile(piSessionPath, "{}\n");

    assert.deepEqual(resolveRuntimeSessionRef("pi", piSessionId, homeDir, undefined, { workingDirectory: piWorkspace }), {
      label: piSessionId,
      path: piSessionPath,
      runtime: "pi",
      reachable: true,
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  ignoredKillSignals = new Set<NodeJS.Signals | number | undefined>();
  stdin = {
    writes: [] as string[],
    write: (chunk: string) => {
      this.stdin.writes.push(String(chunk));
      return true;
    },
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    if (this.ignoredKillSignals.has(signal)) return true;
    const exitSignal = typeof signal === "string" ? signal : null;
    const exitCode = exitSignal ? null : 0;
    this.emit("exit", exitCode, exitSignal);
    this.emit("close", exitCode, exitSignal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit("close", code, signal);
  }

  fail(message: string, name?: string) {
    const error = new Error(message);
    if (name) error.name = name;
    this.emit("error", error);
  }
}

class FakeCodexDriver implements RuntimeDriver {
  readonly id: string;
  readonly lifecycle: RuntimeDriver["lifecycle"];
  readonly communication: RuntimeDriver["communication"];
  readonly stdoutChannel: RuntimeDriver["stdoutChannel"];
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only" } as const;
  readonly startupReadiness?: RuntimeDriver["startupReadiness"];
  readonly requiresSessionInitForDelivery?: boolean;
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode: "direct" | "notification" | "none";
  readonly supportsNativeStandingPrompt: boolean;
  readonly terminateProcessOnTurnEnd?: boolean;
  readonly deferSpawnUntilMessage?: boolean;
  readonly deferredWakePattern?: RegExp;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  readonly encodedCalls: Array<{ text: string; mode: "idle" | "busy" }> = [];
  readonly failEncodeModes = new Set<"idle" | "busy">();
  readonly ignoredKillSignals = new Set<NodeJS.Signals | number | undefined>();

  constructor(opts: {
    id?: string;
    supportsStdinNotification?: boolean;
    busyDeliveryMode?: "direct" | "notification" | "none";
    supportsNativeStandingPrompt?: boolean;
    terminateProcessOnTurnEnd?: boolean;
    deferSpawnUntilMessage?: boolean;
    deferredWakePattern?: RegExp;
    failEncodeModes?: Array<"idle" | "busy">;
    ignoredKillSignals?: Array<NodeJS.Signals | number | undefined>;
    startupReadiness?: RuntimeDriver["startupReadiness"];
    requiresSessionInitForDelivery?: boolean;
  } = {}) {
    this.id = opts.id || "codex";
    this.stdoutChannel = this.id === "codex" ? "structured_protocol" : "diagnostic";
    this.supportsStdinNotification = opts.supportsStdinNotification ?? false;
    this.busyDeliveryMode = opts.busyDeliveryMode ?? "none";
    this.lifecycle = this.supportsStdinNotification
      ? {
        kind: "persistent",
        stdin: this.busyDeliveryMode === "none" ? "notification" : this.busyDeliveryMode,
        inFlightWake: "steer",
      }
      : {
        kind: "per_turn",
        start: opts.deferSpawnUntilMessage ? "defer_until_concrete_message" : "immediate",
        exit: opts.terminateProcessOnTurnEnd ? "terminate_on_turn_end" : "natural",
        inFlightWake: opts.deferSpawnUntilMessage ? "coalesce_into_pending" : "spawn_new",
      };
    this.communication = {
      chat: "slock_cli",
      runtimeControl: "none",
    };
    this.supportsNativeStandingPrompt = opts.supportsNativeStandingPrompt ?? false;
    this.startupReadiness = opts.startupReadiness;
    this.requiresSessionInitForDelivery = opts.requiresSessionInitForDelivery;
    this.terminateProcessOnTurnEnd = opts.terminateProcessOnTurnEnd;
    this.deferSpawnUntilMessage = opts.deferSpawnUntilMessage;
    this.deferredWakePattern = opts.deferredWakePattern;
    for (const mode of opts.failEncodeModes || []) {
      this.failEncodeModes.add(mode);
    }
    for (const signal of opts.ignoredKillSignals || []) {
      this.ignoredKillSignals.add(signal);
    }
  }

  shouldDeferWakeMessage(message: AgentMessage): boolean {
    return !!this.deferredWakePattern?.test(message.content);
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const proc = new FakeChildProcess();
    proc.ignoredKillSignals = new Set(this.ignoredKillSignals);
    this.processes.push(proc);
    return { process: proc as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) || [];
  }

  encodeStdinMessage(
    text?: string,
    _sessionId?: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    if (!this.supportsStdinNotification || !text) return null;
    const mode = opts?.mode || "busy";
    if (this.failEncodeModes.has(mode)) return null;
    this.encodedCalls.push({ text, mode });
    return JSON.stringify({ mode, text });
  }

  buildSystemPrompt(config: AgentConfig): AxSurfaceText {
    const builder = this.supportsNativeStandingPrompt
      ? buildCliTransportSystemPrompt
      : buildCliSystemPrompt;
    return builder(config, {
      extraCriticalRules: this.id === "claude"
        ? ["- Do NOT bypass the `slock` CLI with bash/curl/sqlite for messaging."]
        : ["- Do NOT bypass the `slock` CLI with shell commands or custom scripts."],
    });
  }

}

class FailingStartRuntimeSession implements RuntimeSession {
  constructor(private readonly error = "sdk boot rejected") {}

  readonly descriptor: RuntimeSession["descriptor"] = {
    transport: "sdk",
    lifecycle: "sdk_session",
    stdout: { channel: "structured_protocol" },
    input: {
      initial: "request",
      idle: "sdk_prompt",
      busy: "sdk_steer",
    },
    readiness: "sdk_ready",
    turnBoundary: "sdk_event",
    startPolicy: "immediate",
    inFlightWake: "steer",
    busyDelivery: "direct",
    postTurn: "keep_alive",
  };
  readonly pid = undefined;
  readonly currentSessionId = null;
  readonly currentRuntimeHomeDir = null;
  readonly exitCode = null;
  readonly signalCode = null;
  readonly closed = false;

  isAlive(): boolean | undefined {
    return undefined;
  }

  on(event: "runtime_event", cb: (event: ParsedEvent) => void): void;
  on(event: "stdout", cb: (text: string) => void): void;
  on(event: "stderr", cb: (text: string) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "exit" | "close", cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  on(
    _event: "runtime_event" | "stdout" | "stderr" | "error" | "exit" | "close",
    _cb:
      | ((event: ParsedEvent) => void)
      | ((text: string) => void)
      | ((error: Error) => void)
      | ((info: { code: number | null; signal: NodeJS.Signals | null }) => void),
  ): void {}

  async start(): Promise<RuntimeSendResult> {
    return { ok: false, reason: "runtime_error", error: this.error };
  }

  send(): RuntimeSendResult {
    return { ok: false, reason: "closed" };
  }

  async stop(): Promise<void> {}
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
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: "cred-test",
    ...overrides,
  };
}

test("managed provider credentials are fetched only for spawn and excluded from restart state", async () => {
  await withManager(async ({ driver, manager }) => {
    const previousFetch = globalThis.fetch;
    const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/provider-connection") && (init?.method ?? "GET") === "POST") {
        const raw = init?.body;
        const text = typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : String(raw);
        assert.deepEqual(JSON.parse(text), {
          connectionId: "11111111-1111-4111-8111-111111111111",
        });
        return new Response(JSON.stringify({
          envVars: { DEEPSEEK_API_KEY: "spawn-only-provider-secret" },
          providerConnection: {
            providerId: "deepseek",
            endpointUrl: null,
            supportsImageInput: false,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return previousFetch(input, init);
    }) as typeof fetch);
    try {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "builtin",
        model: "deepseek/deepseek-v4-pro",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }), undefined, undefined, undefined, "managed-provider-launch");

      assert.equal(driver.spawnCalls.length, 1);
      assert.equal(driver.spawnCalls[0]?.config.envVars?.DEEPSEEK_API_KEY, "spawn-only-provider-secret");
      assert.equal(driver.spawnCalls[0]?.config.providerConnection?.providerId, "deepseek");
      const live = (manager as any).agents.get("agent-1");
      assert.ok(live);
      assert.equal(JSON.stringify(live.config).includes("spawn-only-provider-secret"), false);
      const restart = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
      assert.ok(restart);
      assert.equal(JSON.stringify(restart.config).includes("spawn-only-provider-secret"), false);
      assert.equal(restart.config.providerConnection, undefined);
    } finally {
      restoreFetch();
    }
  }, { driver: new FakeCodexDriver({ id: "builtin", supportsStdinNotification: true }) });
});

function makeMessage(content: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    timestamp: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

test("tracked mention delivered to an idle runtime emits receive, drain, then one transport ack", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    driver.parsedLines.set("tracked-idle-ready", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tracked-idle-ready\n"));
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    const message = makeMessage("tracked idle mention", { message_id: "mention-idle-message", seq: 7001 });
    const transitions: string[] = [];
    let ackCount = 0;
    const accepted = manager.deliverMessage("agent-1", message, {
      deliveryId: "mention-idle-occurrence",
      mentionDelivery: {
        occurrenceId: "mention-idle-occurrence",
        messageId: "mention-idle-message",
        machineId: "machine-1",
        launchId: ap.launchId,
        sessionId: "session-1",
      },
      onMentionTransition: (stage) => transitions.push(stage),
      onMentionAck: () => { ackCount += 1; },
    });

    assert.equal(accepted, true);
    assert.deepEqual(transitions, ["daemon_received", "daemon_drained"]);
    assert.equal(ackCount, 1);
    assert.equal(driver.encodedCalls.at(-1)?.mode, "idle");
  });
});

test("tracked mention accepted while busy drains exactly once at turn end", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    const ap = (manager as any).agents.get("agent-1");
    const transitions: string[] = [];
    let ackCount = 0;
    const message = makeMessage("tracked busy mention", { message_id: "mention-busy-message", seq: 7002 });
    const accepted = manager.deliverMessage("agent-1", message, {
      deliveryId: "mention-busy-occurrence",
      mentionDelivery: {
        occurrenceId: "mention-busy-occurrence",
        messageId: "mention-busy-message",
        machineId: "machine-1",
        launchId: ap.launchId,
        sessionId: "session-1",
      },
      onMentionTransition: (stage) => transitions.push(stage),
      onMentionAck: () => { ackCount += 1; },
    });

    assert.equal(accepted, true);
    assert.deepEqual(transitions, ["daemon_received", "daemon_pending"]);
    assert.equal(ackCount, 0);
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.hasTimer, false, "tracked busy delivery must not force-wake");

    driver.parsedLines.set("tracked-busy-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tracked-busy-turn-end\n"));
    await flush();

    assert.deepEqual(transitions, ["daemon_received", "daemon_pending", "daemon_drained"]);
    assert.equal(ackCount, 1);
    assert.equal(driver.encodedCalls.length, 1);
  });
});

test("duplicate tracked push coalesces one pending row and never double-delivers", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    const ap = (manager as any).agents.get("agent-1");
    const transitions: Array<[string, string]> = [];
    let ackCount = 0;
    const message = makeMessage("duplicate tracked mention", { message_id: "mention-duplicate-message", seq: 7003 });
    const context = {
      deliveryId: "mention-duplicate-occurrence",
      mentionDelivery: {
        occurrenceId: "mention-duplicate-occurrence",
        messageId: "mention-duplicate-message",
        machineId: "machine-1",
        launchId: ap.launchId,
        sessionId: "session-1",
      },
      onMentionTransition: (stage: string, outcome: string) => transitions.push([stage, outcome]),
      onMentionAck: () => { ackCount += 1; },
    };

    assert.equal(manager.deliverMessage("agent-1", message, context as any), true);
    assert.equal(manager.deliverMessage("agent-1", message, context as any), true);
    assert.equal(ap.inbox.length, 1);

    driver.parsedLines.set("tracked-duplicate-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tracked-duplicate-turn-end\n"));
    await flush();

    assert.deepEqual(transitions, [
      ["daemon_received", "accepted"],
      ["daemon_pending", "accepted"],
      ["daemon_pending", "coalesced"],
      ["daemon_drained", "accepted"],
    ]);
    assert.equal(ackCount, 1);
    assert.equal(driver.encodedCalls.length, 1);
  });
});

test("tracked mention with stale launch identity fails closed without local delivery", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    const ap = (manager as any).agents.get("agent-1");
    const terminalCodes: string[] = [];
    let ackCount = 0;
    const accepted = manager.deliverMessage("agent-1", makeMessage("stale launch mention", {
      message_id: "mention-stale-message",
      seq: 7004,
    }), {
      deliveryId: "mention-stale-occurrence",
      mentionDelivery: {
        occurrenceId: "mention-stale-occurrence",
        messageId: "mention-stale-message",
        machineId: "machine-1",
        launchId: `${ap.launchId}-stale`,
        sessionId: "session-1",
      },
      onMentionTerminalError: (code) => terminalCodes.push(code),
      onMentionAck: () => { ackCount += 1; },
    });

    assert.equal(accepted, false);
    assert.deepEqual(terminalCodes, ["IDENTITY_DRIFT"]);
    assert.equal(ackCount, 0);
    assert.equal(ap.inbox.length, 0);
  });
});

test("daemon restart replays one durable busy mention with the same occurrence id", async () => {
  const occurrenceId = "mention-restart-occurrence";
  const messageId = "mention-restart-message";
  const observedOccurrenceIds: string[] = [];
  let ackCount = 0;

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    const message = makeMessage("survive daemon restart", { message_id: messageId, seq: 7005 });
    const accepted = manager.deliverMessage("agent-1", message, {
      deliveryId: occurrenceId,
      mentionDelivery: {
        occurrenceId,
        messageId,
        machineId: "machine-1",
        launchId: "launch-1",
        sessionId: "session-1",
      },
      onMentionTransition: () => observedOccurrenceIds.push(occurrenceId),
      onMentionAck: () => { ackCount += 1; },
    });
    assert.equal(accepted, true);
    assert.equal((manager as any).agents.get("agent-1").inbox.length, 1);
    assert.equal(ackCount, 0, "busy acceptance must remain non-terminal before restart");
  });

  // A new manager represents the restarted daemon. Its local coalescing map and
  // inbox are empty; the Server's durable non-terminal row replays the same
  // occurrence identity once after ready/session reconciliation.
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");
    const message = makeMessage("survive daemon restart", { message_id: messageId, seq: 7005 });
    const accepted = manager.deliverMessage("agent-1", message, {
      deliveryId: occurrenceId,
      mentionDelivery: {
        occurrenceId,
        messageId,
        machineId: "machine-1",
        launchId: "launch-1",
        sessionId: "session-1",
      },
      onMentionTransition: () => observedOccurrenceIds.push(occurrenceId),
      onMentionAck: () => { ackCount += 1; },
    });
    assert.equal(accepted, true);
    assert.equal((manager as any).agents.get("agent-1").inbox.length, 1);

    driver.parsedLines.set("tracked-restart-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tracked-restart-turn-end\n"));
    await flush();

    assert.equal(ackCount, 1);
    assert.equal(driver.encodedCalls.length, 1);
  });

  assert.ok(observedOccurrenceIds.length >= 5, "both daemon instances and the drain path must execute");
  assert.equal(new Set(observedOccurrenceIds).size, 1);
  assert.equal(observedOccurrenceIds[0], occurrenceId);
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function agentStartSnapshot(manager: AgentProcessManager) {
  return (manager as any).agentStarts.snapshot();
}

function markAgentStarting(manager: AgentProcessManager, agentId: string): void {
  (manager as any).agentStarts.markStarting(agentId);
}

function setAgentStartCapacityFull(manager: AgentProcessManager): void {
  (manager as any).agentStarts.setMaxConcurrentStartsForTesting(1);
  (manager as any).agentStarts.setActiveStartsForTesting(1);
}

function queuedAgentStart(manager: AgentProcessManager, agentId: string) {
  return (manager as any).agentStarts.getQueued(agentId);
}

async function readTranscriptFixture(name: string): Promise<string> {
  return readFile(new URL(`./testdata/runtime-transcripts/${name}`, import.meta.url), "utf8");
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function makeSessionReadyDeliveryRetryScheduler() {
  const clock = new FakeClock();
  return {
    clock,
    factory: () => new RuntimeNotificationState({
      schedule: (fn, ms) => clock.setTimeout(fn, ms),
      cancel: (timer) => clock.clearTimeout(timer),
    }),
  };
}

const TEST_ACTIVITY_BY_FACT_KIND: Readonly<Record<string, string>> = {
  message_received: "working",
  freshness_hold: "working",
  starting: "working",
  runtime_starting: "working",
  idle: "online",
  running_command: "working",
  checking_messages: "working",
  compacting_context: "working",
  compaction_finished: "working",
  compaction_stale: "working",
  reviewing_changes: "working",
  review_finished: "working",
  review_stale: "working",
  runtime_reconnecting: "working",
  runtime_error: "error",
  runtime_crashed: "offline",
  runtime_unavailable: "offline",
  runtime_stalled: "error",
  stalled_recovery: "working",
  stopped: "offline",
  ready: "online",
  runtime_interrupted: "offline",
  machine_disconnected: "offline",
  computer_started: "online",
  computer_restarted: "online",
  computer_upgraded: "online",
  computer_operation_failed: "error",
  synthetic_repair: "online",
  system_message: "working",
  runtime_progress: "working",
  model_request_started: "working",
  model_response_started: "working",
  tool_started: "working",
  tool_end: "working",
  thinking_started: "thinking",
  thinking_end: "working",
  subagent_activity: "working",
};

function projectFactActivity(
  msg: Extract<MachineToServerMessage, { type: "agent:activity" }>,
): string | undefined {
  return msg.detailKind ? TEST_ACTIVITY_BY_FACT_KIND[msg.detailKind] : msg.activity ?? msg.activityKind;
}

function findLastActivity(sent: MachineToServerMessage[], activity: string) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const msg = sent[i];
    if (msg?.type === "agent:activity" && projectFactActivity(msg) === activity) {
      return { ...msg, activity };
    }
  }
  return undefined;
}

function activityDetailKinds(sent: MachineToServerMessage[]): string[] {
  return sent
    .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
    .map((msg) => msg.detailKind ?? "none");
}

function assertContentFreeInboxUpdatePrompt(prompt: string, forbiddenContent: string | RegExp | Array<string | RegExp> = []) {
  assert.match(prompt, /^\[Raft inbox notice:/);
  assert.match(prompt, /Inbox update: .*changed target/);
  const forbidden = Array.isArray(forbiddenContent) ? forbiddenContent : [forbiddenContent];
  for (const value of forbidden) {
    if (typeof value === "string") {
      assert.doesNotMatch(prompt, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } else {
      assert.doesNotMatch(prompt, value);
    }
  }
  assert.doesNotMatch(prompt, /^New messages? received:/);
  assert.doesNotMatch(prompt, /producerFactId=/);
}

test("Pi retryable provider errors stay outside APM until the SDK retry settles", async () => {
  const driver = new FakeCodexDriver({
    id: "pi",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "pi", sessionId: "pi-session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);

    const pendingTrajectoryTimer = setTimeout(() => {}, 60_000);
    ap.pendingTrajectory = { kind: "text", text: "buffered trajectory", timer: pendingTrajectoryTimer };
    ap.compaction = { kind: "active", startedAt: Date.now(), watchdog: null };
    ap.gatedSteering.compacting = true;
    ap.gatedSteering.reviewing = true;
    const runtimeTraceBefore = ap.runtimeTraceSpan;
    const backoffBefore = ap.runtimeErrorDeliveryBackoff;
    const gatedIdleBefore = ap.gatedSteering.isIdle;
    const state = createPiSdkEventMappingState("pi-session-1");
    const intermediateSequence = [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "429: rate limited" },
      },
      { type: "agent_end", messages: [], willRetry: true },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1_000,
        errorMessage: "429: rate limited",
      },
    ] as unknown as AgentSessionEvent[];

    const intermediateEvents = intermediateSequence.flatMap((event) =>
      mapPiSdkEventToParsedEvents(event, state)
    );
    for (const event of intermediateEvents) {
      (manager as any).handleParsedEvent("agent-1", event, driver);
    }

    assert.equal(intermediateEvents.some((event) => event.kind === "error"), false);
    assert.equal(ap.gatedSteering.compacting, true, "retryable error must not interrupt compaction");
    assert.equal(ap.gatedSteering.reviewing, true, "retryable error must not interrupt review");
    assert.ok(ap.pendingTrajectory, "retryable error must not flush pending trajectory");
    assert.deepEqual(ap.decisionErrorWindow.currentErrorCandidates(), []);
    assert.equal(ap.lastRuntimeError, null, "retryable error must not populate the terminal error view");
    assert.deepEqual(ap.runtimeErrorDeliveryBackoff, backoffBefore, "retryable error must not schedule runtime backoff");
    assert.equal(ap.gatedSteering.isIdle, gatedIdleBefore, "retryable error must not reduce terminal steering state");
    assert.equal(ap.runtimeTraceSpan, runtimeTraceBefore, "retryable error must not end the active runtime trace");
    assert.equal(sink.getAllSpans().flatMap((span) => span.events ?? []).some((event) => event.name === "runtime.error"), false);
    assert.equal(sent.some((msg: MachineToServerMessage) =>
      msg.type === "agent:activity" && projectFactActivity(msg) === "error"
    ), false);

    clearTimeout(pendingTrajectoryTimer);
    ap.pendingTrajectory = null;
    ap.compaction = { kind: "none" };
    ap.gatedSteering.compacting = false;
    ap.gatedSteering.reviewing = false;

    const successSequence = [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      },
      { type: "auto_retry_end", success: true, attempt: 1 },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ] as unknown as AgentSessionEvent[];
    for (const event of successSequence.flatMap((sdkEvent) =>
      mapPiSdkEventToParsedEvents(sdkEvent, state)
    )) {
      (manager as any).handleParsedEvent("agent-1", event, driver);
    }
    assert.equal(sent.filter((msg: MachineToServerMessage) =>
      msg.type === "agent:activity" && projectFactActivity(msg) === "error"
    ).length, 0, "successful retry must not emit provider error Activity");

    const finalState = createPiSdkEventMappingState("pi-session-1");
    const errorActivitiesBeforeFinal = sent.filter((msg: MachineToServerMessage) =>
      msg.type === "agent:activity" && projectFactActivity(msg) === "error"
    ).length;
    const runtimeErrorEventsBeforeFinal = sink.getAllSpans()
      .flatMap((span) => span.events ?? [])
      .filter((event) => event.name === "runtime.error").length;
    const finalEvents = [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "401: auth required" },
      },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ].flatMap((sdkEvent) => mapPiSdkEventToParsedEvents(sdkEvent as AgentSessionEvent, finalState));
    for (const event of finalEvents) {
      (manager as any).handleParsedEvent("agent-1", event, driver);
    }
    assert.deepEqual(finalEvents.filter((event) => event.kind === "error"), [
      { kind: "error", message: "401: auth required" },
    ]);
    const runtimeErrorEventsAfterFinal = sink.getAllSpans()
      .flatMap((span) => span.events ?? [])
      .filter((event) => event.name === "runtime.error").length;
    assert.equal(
      runtimeErrorEventsAfterFinal,
      runtimeErrorEventsBeforeFinal + 1,
      "terminal provider error must record exactly one existing runtime error trace event",
    );
    assert.ok(
      sent.filter((msg: MachineToServerMessage) =>
        msg.type === "agent:activity" && projectFactActivity(msg) === "error"
      ).length > errorActivitiesBeforeFinal,
      "terminal provider error must use the existing APM Activity path",
    );
  }, { driver, tracer });
});

function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => (++spanIndex).toString(16).padStart(16, "0"),
  });
  return { sink, tracer, traceId };
}

function mintReminderAppItem(
  store: AgentAppInboxStore,
  revision: string,
  id = "11111111-1111-4111-8111-111111111111",
) {
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id,
      revision,
    },
  });
  if (!minted.ok) assert.fail("failed to mint reminder app item");
  return minted.item;
}

function appInboxNoticeOutcomes(sink: MemoryTraceSink, itemId: string) {
  return sink.getAllSpans()
    .filter((span) => span.name === "daemon.agent.app_inbox_notice" && span.attrs?.item_id === itemId)
    .map((span) => span.attrs?.outcome);
}

test("app inbox notice queued while busy drains once on the first idle transition", async () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const item = mintReminderAppItem(store, "1");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", item), false);
    assert.equal(driver.encodedCalls.length, 0, "busy notification-only runtime cannot accept the app notice");

    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-1\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "first idle transition must deliver exactly one app inbox wake");
    assert.equal(driver.encodedCalls[0]?.mode, "idle");
    assert.match(driver.encodedCalls[0]?.text ?? "", /App items pending: 1/);

    driver.parsedLines.set("turn-end-2", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-2\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "same pending app item must not wake again on a repeated idle transition");
  }, { driver, appInboxForAgent: () => store });
});

test("idle-transition App Inbox read failure is caught at the runtime event boundary", async () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });
  const { sink, tracer } = makeDeterministicTracer();
  let failStoreRead = false;

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const item = mintReminderAppItem(store, "1");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", item), false);
    failStoreRead = true;

    driver.parsedLines.set("turn-end-store-failure", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-store-failure\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 0, "caught store failure cannot fabricate a delivered wake");
    const failureSpans = sink.getAllSpans().filter(
      (span) => span.name === "daemon.agent.app_inbox_notice" && span.attrs?.outcome === "store_read_failed",
    );
    assert.equal(failureSpans.length, 1, "store failure must emit one closed typed trace");
    assert.equal(
      Object.hasOwn(failureSpans[0]!.attrs ?? {}, "pending_app_items"),
      false,
      "an unreadable store must not fabricate a zero pending-item count",
    );
  }, {
    driver,
    tracer,
    appInboxForAgent: () => {
      if (failStoreRead) throw new Error("APP_INBOX_STORE_UNAVAILABLE");
      return store;
    },
  });
});

test("a later distinct app inbox item wakes once without merging with the prior pending item", async () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const first = mintReminderAppItem(store, "1", "11111111-1111-4111-8111-111111111111");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", first), false);

    driver.parsedLines.set("turn-end-first", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-first\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1);

    const second = mintReminderAppItem(store, "1", "22222222-2222-4222-8222-222222222222");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", second), false);

    driver.parsedLines.set("turn-end-second", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-second\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 2, "distinct later app item must get its own wake");
    assert.match(driver.encodedCalls[1]?.text ?? "", /App items pending: 2/);

    driver.parsedLines.set("turn-end-third", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-third\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, 2, "already noticed distinct items must not repeat");
  }, { driver, appInboxForAgent: () => store });
});

test("repeated app inbox notify for the same pending item records already delivered without waking again", async () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    await flush();

    const first = mintReminderAppItem(store, "1", "11111111-1111-4111-8111-111111111111");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", first), false);

    driver.parsedLines.set("turn-end-first", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-first\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "first idle transition must deliver the pending app item");

    driver.parsedLines.set("turn-end-before-repeat", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0]!.stdout.emit("data", Buffer.from("turn-end-before-repeat\n"));
    await flush();

    const repeatedReceipt = mintReminderAppItem(store, "1", "11111111-1111-4111-8111-111111111111");
    assert.equal(repeatedReceipt.itemId, first.itemId, "same source revision must rematerialize as the same inbox item");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", repeatedReceipt), true);
    assert.equal(driver.encodedCalls.length, 1, "idle duplicate receipt for the same pending item must not wake again");

    const reconnectSnapshotReplay = mintReminderAppItem(store, "1", "11111111-1111-4111-8111-111111111111");
    assert.equal(reconnectSnapshotReplay.itemId, first.itemId, "reconnect snapshot replay keeps the same inbox item id");
    assert.equal(await manager.notifyAgentAppInbox("agent-1", reconnectSnapshotReplay), true);
    assert.equal(driver.encodedCalls.length, 1, "reconnect replay for the same pending item must not wake again");

    assert.deepEqual(
      appInboxNoticeOutcomes(sink, first.itemId),
      ["unsupported_delivery", "written", "already_delivered", "already_delivered"],
      "duplicate entrypoints must hit already_delivered rather than skipping notifyAgentAppInbox",
    );
  }, { driver, appInboxForAgent: () => store, tracer });
});

function installManagedRunnerMintFetch(): () => void {
  const originalFetch = globalThis.fetch;
  let credentialSeq = 0;
  return installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      credentialSeq += 1;
      return new Response(JSON.stringify({
        apiKey: `sk_agent_test_${credentialSeq}`,
        credentialId: `cred-test-${credentialSeq}`,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
}

async function withRunnerCredentialMintFailure(fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const restore = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return new Response(JSON.stringify({
        error: "Experimental internal surface is disabled.",
        code: "experimental_surface_disabled",
      }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  try {
    await fn();
  } finally {
    restore();
  }
}

async function withRunnerCredentialMintNetworkFailure(
  fn: (ctx: { getCredentialFetchCount: () => number }) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let credentialFetchCount = 0;
  const restore = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      credentialFetchCount += 1;
      throw new Error("fetch failed");
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  try {
    await fn({ getCredentialFetchCount: () => credentialFetchCount });
  } finally {
    restore();
  }
}

async function withManager(fn: (ctx: {
  driver: FakeCodexDriver;
  sent: MachineToServerMessage[];
  manager: AgentProcessManager;
  dataDir: string;
}) => Promise<void>, options: {
  driver?: FakeCodexDriver;
  defaultAgentEnvVarsProvider?: (config: Pick<AgentConfig, "runtime" | "model" | "envVars">) => Promise<Record<string, string> | null> | Record<string, string> | null;
  tracer?: Tracer;
  daemonVersion?: string | null;
  daemonInstanceId?: string | null;
  computerVersion?: string | null;
  stdinNotificationRetryMs?: number;
  sessionReadyDeliveryRetryMs?: number;
  sessionReadyDeliveryRetrySchedulerFactory?: () => RuntimeNotificationState;
  runtimeErrorDeliveryBackoff?: {
    baseMs?: number;
    maxMs?: number;
    jitterRatio?: number;
    jitterRandom?: () => number;
    failPointForTesting?: (args: { agentId: string; message: string }) => {
      terminalFailure?: { detail: string; actionRequired: boolean; entries?: TrajectoryEntry[] } | null;
      stickyTerminalFailure?: { detail: string; actionRequired: boolean; entries?: TrajectoryEntry[] } | null;
      reason?: string | null;
    } | null | undefined;
  };
  runtimeSessionHomeDir?: string;
  slockHome?: string;
  runtimeStartScheduler?: {
    maxConcurrentStarts?: number;
    minStartIntervalMs?: number;
  };
  appInboxForAgent?: (agentId: string) => AgentAppInboxStore;
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-test-"));
  const sent: MachineToServerMessage[] = [];
  const restoreFetch = installManagedRunnerMintFetch();
  const driver = options.driver || new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      slockHome: options.slockHome ?? dataDir,
      driverResolver: () => driver,
      defaultAgentEnvVarsProvider: options.defaultAgentEnvVarsProvider,
      tracer: options.tracer,
      daemonVersion: options.daemonVersion,
      daemonInstanceId: options.daemonInstanceId,
      computerVersion: options.computerVersion,
      stdinNotificationRetryMs: options.stdinNotificationRetryMs,
      sessionReadyDeliveryRetryMs: options.sessionReadyDeliveryRetryMs,
      runtimeErrorDeliveryBackoff: options.runtimeErrorDeliveryBackoff,
      runtimeSessionHomeDir: options.runtimeSessionHomeDir ?? dataDir,
      runtimeStartScheduler: options.runtimeStartScheduler,
      appInboxForAgent: options.appInboxForAgent,
    },
  );
  setSessionReadyDeliveryRetrySchedulerFactoryForTesting(options.sessionReadyDeliveryRetrySchedulerFactory ?? null);

  try {
    await fn({ driver, sent, manager, dataDir });
  } finally {
    setSessionReadyDeliveryRetrySchedulerFactoryForTesting(null);
    cleanupTestManager(manager);
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function cleanupTestManager(manager: AgentProcessManager): void {
  if ((manager as any).agentStartPumpTimer) clearTimeout((manager as any).agentStartPumpTimer);
  for (const timer of (manager as any).runtimeErrorProcessRestartTimers?.values?.() ?? []) {
    clearTimeout(timer);
  }
  (manager as any).runtimeErrorProcessRestartTimers?.clear?.();
  for (const ap of (manager as any).agents?.values?.() ?? []) {
    ap.notifications.clearTimer();
    if (ap.sessionReadyDeliveryRetry?.kind === "scheduled") {
      ap.sessionReadyDeliveryRetry.scheduler.clearTimer();
    }
    if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
    if (ap.activityHeartbeat?.kind === "active") clearInterval(ap.activityHeartbeat.timer);
    if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
    if (ap.exit?.kind === "live" && ap.exit.stalledRecoverySigtermTimer) clearTimeout(ap.exit.stalledRecoverySigtermTimer);
    if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    if (ap.runtimeErrorDeliveryBackoff?.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
  }
  (manager as any).agents?.clear?.();
}

test("runtime binding rejects dual-server crossed stdin with zero foreign-child bytes", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ sent, manager }) => {
    await Promise.all([
      manager.startAgent("agent-server-a", makeConfig({
        name: "agent-server-a",
        runtimeContext: {
          serverId: "server-a",
          machineId: "shared-machine",
        },
      }), undefined, undefined, undefined, "launch-a"),
      manager.startAgent("agent-server-b", makeConfig({
        name: "agent-server-b",
        runtimeContext: {
          serverId: "server-b",
          machineId: "shared-machine",
        },
      }), undefined, undefined, undefined, "launch-b"),
    ]);

    const apA = (manager as any).agents.get("agent-server-a");
    const apB = (manager as any).agents.get("agent-server-b");
    assert.ok(apA && apB);
    const runtimeA = apA.runtime;
    const processAWritesBefore = driver.processes[0].stdin.writes.length;
    const processBWritesBefore = driver.processes[1].stdin.writes.length;

    // Deterministic adversarial seam: a live APM row points at another
    // server/agent's runtime object. The crossed child must receive zero bytes.
    apA.runtime = apB.runtime;
    const directMessage = makeMessage("server-a content must never reach server-b child", {
      message_id: "dual-server-crossed-input",
    });
    const inboxMessage = makeMessage("server-a inbox delta must never reach server-b child", {
      message_id: "dual-server-crossed-inbox",
    });
    const noticeMessage = makeMessage("server-a notice must never reach server-b child", {
      message_id: "dual-server-crossed-notice",
    });
    let directAccepted: boolean;
    let inboxAccepted: boolean;
    let noticeAccepted: boolean;
    try {
      directAccepted = (manager as any).deliverMessagesViaStdin(
        "agent-server-a",
        apA,
        [directMessage],
        "busy",
      );
      inboxAccepted = (manager as any).deliverInboxUpdateViaStdin(
        "agent-server-a",
        apA,
        [inboxMessage],
        "idle",
        "adversarial_idle_inbox",
      );
      apA.gatedSteering.isIdle = false;
      apA.sessionId = "session-a";
      apA.sessionReadyForDelivery = true;
      apA.inbox = [noticeMessage];
      apA.notifications.clear();
      apA.notifications.add();
      noticeAccepted = (manager as any).sendStdinNotification("agent-server-a");
    } finally {
      apA.runtime = runtimeA;
    }

    assert.equal(directAccepted, false);
    assert.equal(inboxAccepted, false);
    assert.equal(noticeAccepted, false);
    assert.equal(driver.processes[0].stdin.writes.length, processAWritesBefore);
    assert.equal(driver.processes[1].stdin.writes.length, processBWritesBefore);
    const rejected = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.runtime_binding.rejected");
    assert.deepEqual(
      rejected.map((span) => span.attrs?.source).sort(),
      ["adversarial_idle_inbox", "busy_stdin_notification", "stdin_busy_delivery"],
    );
    assert.equal(rejected.every((span) =>
      span.attrs?.direction === "input"
      && span.attrs?.reason === "agent_mismatch"
      && span.attrs?.stdin_write_attempted === false
    ), true);
    assert.equal(
      activityDetailKinds(sent).filter((kind) => kind === "model_request_started").length,
      0,
      "binding-rejected stdin paths must not emit model_request_started",
    );
  }, { driver, tracer });
});

test("runtime binding rejects each mutable identity-axis mismatch before stdin write", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-identity", makeConfig({
      name: "agent-identity",
      sessionId: "session-bound",
      runtimeContext: {
        serverId: "server-bound",
        machineId: "machine-bound",
      },
    }), undefined, undefined, undefined, "launch-bound");

    const ap = (manager as any).agents.get("agent-identity");
    assert.ok(ap);
    const binding = (manager as any).runtimeProcessBindingFence.getBinding(ap.runtime);
    assert.ok(binding);
    assert.equal(Object.isFrozen(binding), true);
    assert.deepEqual({
      agentId: binding.agentId,
      serverId: binding.serverId,
      machineId: binding.machineId,
      configuredRuntimeId: binding.configuredRuntimeId,
      driverId: binding.driverId,
      initialLaunchId: binding.initialLaunchId,
      activeLaunchId: binding.activeLaunchId,
      startSessionId: binding.startSessionId,
      activeSessionId: binding.activeSessionId,
      processInstanceId: binding.processInstanceId,
    }, {
      agentId: "agent-identity",
      serverId: "server-bound",
      machineId: "machine-bound",
      configuredRuntimeId: "codex",
      driverId: "codex",
      initialLaunchId: "launch-bound",
      activeLaunchId: "launch-bound",
      startSessionId: "session-bound",
      activeSessionId: "session-bound",
      processInstanceId: ap.processInstanceId,
    });

    const baseline = {
      config: ap.config,
      launchId: ap.launchId,
      sessionId: ap.sessionId,
      processInstanceId: ap.processInstanceId,
    };
    const axes: Array<{
      reason: string;
      mutate: () => void;
    }> = [
      {
        reason: "server_mismatch",
        mutate: () => {
          ap.config = {
            ...baseline.config,
            runtimeContext: {
              ...baseline.config.runtimeContext,
              serverId: "server-crossed",
            },
          };
        },
      },
      {
        reason: "machine_mismatch",
        mutate: () => {
          ap.config = {
            ...baseline.config,
            runtimeContext: {
              ...baseline.config.runtimeContext,
              machineId: "machine-crossed",
            },
          };
        },
      },
      {
        reason: "runtime_mismatch",
        mutate: () => {
          ap.config = { ...baseline.config, runtime: "claude" };
        },
      },
      {
        reason: "launch_mismatch",
        mutate: () => {
          ap.launchId = "launch-crossed";
        },
      },
      {
        reason: "session_mismatch",
        mutate: () => {
          ap.sessionId = "session-crossed";
        },
      },
      {
        reason: "process_instance_mismatch",
        mutate: () => {
          ap.processInstanceId = "process-crossed";
        },
      },
    ];

    for (const [index, axis] of axes.entries()) {
      ap.config = baseline.config;
      ap.launchId = baseline.launchId;
      ap.sessionId = baseline.sessionId;
      ap.processInstanceId = baseline.processInstanceId;
      axis.mutate();

      const writesBefore = driver.processes[0].stdin.writes.length;
      const accepted = (manager as any).deliverMessagesViaStdin(
        "agent-identity",
        ap,
        [makeMessage(`identity-axis-${axis.reason}`, {
          message_id: `identity-axis-${index}`,
        })],
        "busy",
      );
      assert.equal(accepted, false, axis.reason);
      assert.equal(driver.processes[0].stdin.writes.length, writesBefore, axis.reason);

      const rejected = sink.getAllSpans()
        .filter((span) => span.name === "daemon.agent.runtime_binding.rejected")
        .at(-1);
      assert.ok(rejected, axis.reason);
      assert.equal(rejected.attrs?.reason, axis.reason);
      assert.equal(rejected.attrs?.direction, "input");
      assert.equal(rejected.attrs?.source, "stdin_busy_delivery");
      assert.equal(rejected.attrs?.stdin_write_attempted, false);
      assert.equal(rejected.attrs?.bound_agent_id, "agent-identity");
      assert.equal(rejected.attrs?.bound_server_id, "server-bound");
      assert.equal(rejected.attrs?.bound_machine_id, "machine-bound");
      assert.equal(rejected.attrs?.bound_configured_runtime, "codex");
      assert.equal(rejected.attrs?.bound_driver, "codex");
      assert.equal(rejected.attrs?.bound_active_launch_id, "launch-bound");
      assert.equal(rejected.attrs?.bound_active_session_id, "session-bound");
      assert.equal(rejected.attrs?.bound_process_instance_id, baseline.processInstanceId);
      assert.equal(rejected.attrs?.observed_session_id, ap.sessionId);
    }
    assert.equal(
      activityDetailKinds(sent).filter((kind) => kind === "model_request_started").length,
      0,
      "identity-axis binding rejects must not emit model_request_started",
    );

    ap.config = baseline.config;
    ap.launchId = baseline.launchId;
    ap.sessionId = baseline.sessionId;
    ap.processInstanceId = baseline.processInstanceId;
  }, { driver, tracer });
});

test("runtime binding permits an accepted session_init to rebind only the active session", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-session-rebind", makeConfig({
      name: "agent-session-rebind",
      sessionId: "resume-target",
      runtimeContext: {
        serverId: "server-bound",
        machineId: "machine-bound",
      },
    }), undefined, undefined, undefined, "launch-bound");

    const ap = (manager as any).agents.get("agent-session-rebind");
    assert.ok(ap);
    const initialBinding = (manager as any).runtimeProcessBindingFence.getBinding(ap.runtime);
    assert.equal(initialBinding.startSessionId, "resume-target");
    assert.equal(initialBinding.activeSessionId, null);

    driver.parsedLines.set("session-init", [{
      kind: "session_init",
      sessionId: "live-session",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    assert.equal(ap.sessionId, "live-session");
    const reboundBinding = (manager as any).runtimeProcessBindingFence.getBinding(ap.runtime);
    assert.equal(Object.isFrozen(reboundBinding), true);
    assert.equal(reboundBinding.startSessionId, "resume-target");
    assert.equal(reboundBinding.activeSessionId, "live-session");
    assert.equal(reboundBinding.initialLaunchId, "launch-bound");
    assert.equal(reboundBinding.activeLaunchId, "launch-bound");
    assert.ok(sink.getAllSpans().some((span) =>
      span.name === "daemon.agent.runtime_binding.rebound"
      && span.attrs?.source === "session_init"
      && span.attrs?.previous_active_session_id === undefined
      && span.attrs?.next_active_session_id === "live-session"
    ));

    const writesBefore = driver.processes[0].stdin.writes.length;
    const accepted = (manager as any).deliverMessagesViaStdin(
      "agent-session-rebind",
      ap,
      [makeMessage("legal post-session-init input", {
        message_id: "legal-post-session-init-input",
      })],
      "busy",
    );
    assert.equal(accepted, true);
    assert.equal(driver.processes[0].stdin.writes.length, writesBefore + 1);
    assert.equal(
      sink.getAllSpans().some((span) => span.name === "daemon.agent.runtime_binding.rejected"),
      false,
    );
  }, { driver, tracer });
});

test("runtime binding rejects stale reconnect replay output before it mutates the active session", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-reconnect", makeConfig({
      name: "agent-reconnect",
      sessionId: "old-session",
      runtimeContext: {
        serverId: "server-old",
        machineId: "shared-machine",
      },
    }), undefined, undefined, undefined, "launch-old");
    const staleProcess = driver.processes[0];

    await manager.stopAgent("agent-reconnect");
    await manager.startAgent("agent-reconnect", makeConfig({
      name: "agent-reconnect",
      sessionId: "current-session",
      runtimeContext: {
        serverId: "server-current",
        machineId: "shared-machine",
      },
    }), undefined, undefined, undefined, "launch-current");

    driver.parsedLines.set("stale-replay", [{
      kind: "session_init",
      sessionId: "foreign-replayed-session",
    }]);
    staleProcess.stdout.emit("data", Buffer.from("stale-replay\n"));
    staleProcess.stdout.emit("data", Buffer.from("stale-unparsed-output\n"));
    staleProcess.stderr.emit("data", Buffer.from("stale stderr must stay inert"));
    staleProcess.fail("stale process error must stay inert");
    await flush();

    assert.equal(manager.getAgentSessionId("agent-reconnect"), "current-session");
    const current = (manager as any).agents.get("agent-reconnect");
    assert.deepEqual(current.recentStderr, []);
    assert.equal(current.spawnError, null);
    const rejected = sink.getAllSpans().filter((span) =>
      span.name === "daemon.agent.runtime_binding.rejected"
    );
    assert.deepEqual(
      [...new Set(rejected.map((span) => span.attrs?.source))].sort(),
      ["error", "runtime_event:session_init", "stderr", "stdout"],
    );
    assert.equal(rejected.every((span) =>
      span.attrs?.direction === "output"
      && span.attrs?.reason === "inactive_process_generation"
      && span.attrs?.output_applied === false
    ), true);
  }, { driver, tracer });
});

test("startAgent releases the local scheduler slot after spawn instead of first turn end", async () => {
  await withManager(async ({ driver, manager }) => {
    const firstStart = manager.startAgent("agent-1", makeConfig({ name: "agent-1" }));
    const secondStart = manager.startAgent("agent-2", makeConfig({ name: "agent-2" }));

    await flush();
    await firstStart;
    assert.deepEqual(driver.spawnCalls.map((call) => call.agentId), ["agent-1"]);

    await new Promise((resolve) => setTimeout(resolve, 35));
    await secondStart;
    assert.deepEqual(driver.spawnCalls.map((call) => call.agentId), ["agent-1", "agent-2"]);

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
  }, {
    runtimeStartScheduler: {
      maxConcurrentStarts: 1,
      minStartIntervalMs: 25,
    },
  });
});

test("agent activity carries the daemon process identity in its wire and producer fact", async () => {
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "thread-1" }));

    (manager as any).broadcastActivity("agent-1", "working", "Working");

    const activity = sent.filter((msg) => msg.type === "agent:activity").at(-1);
    assert.ok(activity && activity.type === "agent:activity");
    assert.equal(activity.daemonInstanceId, "daemon-instance-1");
    assert.match(
      activity.producerFactId ?? "",
      /^daemon_activity:agent-1:legacy:daemon-instance-1:\d+$/,
    );
  }, { daemonInstanceId: "daemon-instance-1" });
});


test("start scheduler tracing records queue dequeue spawn and slot release", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ driver, manager }) => {
    const firstStart = manager.startAgent("agent-1", makeConfig({ name: "agent-1" }));
    const secondStart = manager.startAgent("agent-2", makeConfig({ name: "agent-2" }));

    await flush();
    await firstStart;
    await new Promise((resolve) => setTimeout(resolve, 35));
    await secondStart;

    assert.deepEqual(driver.spawnCalls.map((call) => call.agentId), ["agent-1", "agent-2"]);
    const spanNames = sink.getAllSpans().map((span) => span.name);
    for (const expected of [
      "daemon.agent.start.requested",
      "daemon.agent.start.queued",
      "daemon.agent.start.dequeued",
      "daemon.agent.spawn.started",
      "daemon.agent.spawn.created",
      "daemon.agent.start.slot_released",
    ]) {
      assert.ok(spanNames.includes(expected), `expected ${expected}`);
    }
    assert.equal(
      sink.getAllSpans().some((span) =>
        span.name === "daemon.agent.start.slot_released"
        && span.attrs?.reason === "spawn attempted"
        && span.attrs?.queue_depth === 1
      ),
      true,
      "first spawn should release the slot while the second start is queued",
    );
  }, {
    tracer,
    runtimeStartScheduler: {
      maxConcurrentStarts: 1,
      minStartIntervalMs: 25,
    },
  });
});

test("start scheduler emits launch residency enter close rows with stable pairing ids", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtimeContext: {
        serverId: "server-1",
        machineId: "machine-1",
      },
    }), makeMessage("wake"), undefined, undefined, "launch-1");

    const rows = sink.getAllSpans()
      .filter((span) => span.name === "launch_residency_transition")
      .map((span) => span.attrs);
    assert.equal(rows.length, 4);

    const [queuedEnter, queuedClose, startingEnter, startingClose] = rows;
    assert.equal(queuedEnter?.transition_kind, "enter");
    assert.equal(queuedEnter?.state, "queued_start");
    assert.equal(queuedEnter?.agent_launch_id, "launch-1");
    assert.equal(queuedEnter?.agent_id, "agent-1");
    assert.equal(queuedEnter?.server_id, "server-1");
    assert.equal(queuedEnter?.machine_id, "machine-1");
    assert.equal(queuedEnter?.runtime, "codex");
    assert.equal(queuedEnter?.driver, "codex");
    assert.equal(queuedEnter?.launch_source, "wake_message");
    assert.equal(queuedEnter?.is_wait_state, true);
    assert.equal(queuedEnter?.fence_kind, "start_scheduler");
    assert.equal(typeof queuedEnter?.deadline_unix_ms, "number");
    assert.equal(queuedEnter?.state_instance_id, queuedEnter?.residency_state_instance_id);

    assert.equal(queuedClose?.transition_kind, "close");
    assert.equal(queuedClose?.close_result, "advanced");
    assert.equal(queuedClose?.state_instance_id, queuedEnter?.state_instance_id);

    assert.equal(startingEnter?.transition_kind, "enter");
    assert.equal(startingEnter?.state, "starting_process");
    assert.equal(startingEnter?.is_wait_state, true);
    assert.equal(startingEnter?.fence_kind, "runtime_start_timeout");
    assert.equal(typeof startingEnter?.deadline_unix_ms, "number");
    assert.equal(startingEnter?.state_instance_id, startingEnter?.residency_state_instance_id);
    assert.notEqual(startingEnter?.state_instance_id, queuedEnter?.state_instance_id);

    assert.equal(startingClose?.transition_kind, "close");
    assert.equal(startingClose?.close_result, "advanced");
    assert.equal(startingClose?.state_instance_id, startingEnter?.state_instance_id);
    assert.deepEqual(rows.map((row) => row?.transition_seq), [1, 2, 3, 4]);
    assert.deepEqual(rows.map((row) => row?.residency_transition_seq), [1, 2, 3, 4]);
  }, { tracer });
});

test("custom Claude provider launch policy is trace-visible", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
      busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "claude",
      model: "deepseek-v4-flash",
      envVars: {
        ANTHROPIC_BASE_URL: "https://provider.example.test/anthropic",
        ANTHROPIC_API_KEY: "test-secret-key",
        ANTHROPIC_CUSTOM_MODEL_OPTION: "deepseek-v4-flash",
      },
    }), undefined, undefined, undefined, "launch-claude-custom");

    await waitFor(() => driver.processes.length === 1, "custom Claude provider spawn");
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await flush();

    const runtimeSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.runtime.turn");
    assert.ok(runtimeSpan, "custom-provider launch should create a runtime turn span");
    assert.equal(runtimeSpan.attrs?.claude_custom_provider, true);
    assert.equal(runtimeSpan.attrs?.claude_custom_provider_settings_sources_policy, "project,local");
    assert.equal(runtimeSpan.attrs?.claude_custom_provider_inherited_provider_scrub, true);
    assert.equal(runtimeSpan.attrs?.claude_custom_provider_host_managed_flag, false);
    assert.equal(runtimeSpan.attrs?.claude_custom_provider_home_override, false);
    assert.equal(runtimeSpan.attrs?.claude_custom_provider_config_dir_override, false);

    const started = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "daemon.turn.started");
    assert.equal(started?.attrs?.claude_custom_provider_settings_sources_policy, "project,local");

    const spawnCreated = sink.getAllSpans().find((span) => span.name === "daemon.agent.spawn.created");
    assert.ok(spawnCreated, "custom-provider launch should create a spawn-created trace");
    assert.equal(spawnCreated.attrs?.claude_custom_provider, true);
    assert.equal(spawnCreated.attrs?.claude_custom_provider_settings_sources_policy, "project,local");
    assert.equal(spawnCreated.attrs?.claude_custom_provider_host_managed_flag, false);
    assert.equal(spawnCreated.attrs?.claude_custom_provider_home_override, false);
    assert.equal(spawnCreated.attrs?.claude_custom_provider_config_dir_override, false);

    const serializedTraceAttrs = JSON.stringify({
      runtime: runtimeSpan.attrs,
      spawn: spawnCreated.attrs,
    });
    assert.doesNotMatch(serializedTraceAttrs, /provider\.example\.test|test-secret-key/);
  }, { driver, tracer });
});

test("runtime start rejection leaves no active runtime or idle fallback behind", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  class StartRejectingDriver extends FakeCodexDriver {
    rejectNextStart = true;

    override spawn(ctx: SpawnContext): SpawnResult {
      if (this.rejectNextStart) {
        this.rejectNextStart = false;
        this.spawnCalls.push(ctx);
        throw new Error("spawn failed before process attachment");
      }
      return super.spawn(ctx);
    }
  }

  const driver = new StartRejectingDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await assert.rejects(
      manager.startAgent("agent-1", makeConfig({ name: "agent-1", sessionId: "session-1" })),
      /spawn failed before process attachment/,
    );

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.equal(agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), false);

    const failedSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.runtime.turn" &&
      span.attrs?.outcome === "runtime-start-failed"
    );
    assert.ok(failedSpan, "runtime trace should be ended for a failed start");
    assert.equal(failedSpan.status, "error");
    const startFailureSpan = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.agent.runtime_start.failed"
    );
    assert.ok(startFailureSpan, "start failures should have a daemon trace span");
    assert.equal(startFailureSpan.status, "error");
    assert.equal(startFailureSpan.attrs?.runtime_start_reason, "runtime_error");
    assert.equal(startFailureSpan.attrs?.error_present, true);

    await manager.startAgent("agent-1", makeConfig({ name: "agent-1", sessionId: "session-1" }));
    assert.equal(driver.spawnCalls.length, 2);
    assert.equal((manager as any).agents.has("agent-1"), true);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), true);

    const retryProcess = driver.processes.at(-1);
    retryProcess?.exit(0);
    retryProcess?.close(0);
    await flush();
  }, { driver, tracer });
});

test("runtime start rejection closes starting residency with terminal negative evidence", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  class StartFailureDriver extends FakeCodexDriver {
    createSession(ctx: SpawnContext): RuntimeSession {
      this.spawnCalls.push(ctx);
      return new FailingStartRuntimeSession();
    }
  }

  const driver = new StartFailureDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await assert.rejects(
      manager.startAgent("agent-1", makeConfig({
        name: "agent-1",
        sessionId: "session-1",
        runtimeContext: {
          serverId: "server-1",
          machineId: "machine-1",
        },
      }), makeMessage("wake"), undefined, undefined, "launch-1"),
      /Runtime session failed to start: runtime_error \(sdk boot rejected\)/,
    );

    const rows = sink.getAllSpans()
      .filter((span) => span.name === "launch_residency_transition")
      .map((span) => span.attrs);
    assert.equal(rows.length, 4);
    const startingEnter = rows.find((row) =>
      row?.transition_kind === "enter" && row.state === "starting_process"
    );
    assert.ok(startingEnter, "starting_process enter row should be emitted");
    const startingCloses = rows.filter((row) =>
      row?.transition_kind === "close" && row.state === "starting_process"
    );
    assert.equal(startingCloses.length, 1);
    assert.equal(startingCloses[0]?.state_instance_id, startingEnter.state_instance_id);
    assert.equal(startingCloses[0]?.residency_state_instance_id, startingEnter.residency_state_instance_id);
    assert.equal(startingCloses[0]?.close_result, "terminal");
    assert.equal(startingCloses[0]?.negative_evidence_bucket, "runtime_start_failed");
    assert.equal(
      rows.some((row) =>
        row?.transition_kind === "close" &&
        row.state === "starting_process" &&
        row.close_result === "advanced" &&
        row.state_instance_id === startingEnter.state_instance_id
      ),
      false,
      "failed runtime start must not emit an early advanced close for the starting residency",
    );
  }, { driver, tracer });
});

test("built-in provider auth failure during SDK start is surfaced as runtime error activity", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  class BuiltInAuthFailureDriver extends FakeCodexDriver {
    createSession(ctx: SpawnContext): RuntimeSession {
      this.spawnCalls.push(ctx);
      return new FailingStartRuntimeSession("API Error: 401 Unauthorized");
    }
  }

  const driver = new BuiltInAuthFailureDriver({
    id: "builtin",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ sent, manager }) => {
    await assert.rejects(
      manager.startAgent("agent-1", makeConfig({ runtime: "builtin", sessionId: "session-1" }), undefined, undefined, undefined, "launch-1"),
      /Runtime session failed to start: runtime_error \(API Error: 401 Unauthorized\)/,
    );

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(errorEvent.launchId, "launch-1");
    assert.equal(
      errorEvent.detail,
      "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.",
    );
    assert.equal(
      errorEvent.entries?.some((entry) => entry.kind === "text" && /Built-in provider authentication failed/.test(entry.text)),
      true,
    );
    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);

    const runtimeStartFailure = sink.getTrace(traceId).find((span) =>
      span.name === "daemon.agent.runtime_start.failed"
    );
    assert.equal(runtimeStartFailure?.attrs?.runtime_error_class, "AuthError");
  }, { driver, tracer });
});

test("stopAgent cancels a queued runtime start before it can spawn", async () => {
  await withManager(async ({ driver, manager }) => {
    const firstStart = manager.startAgent("agent-1", makeConfig({ name: "agent-1" }));
    const secondStart = manager.startAgent("agent-2", makeConfig({ name: "agent-2" }));

    await flush();
    const stopSecond = manager.stopAgent("agent-2");
    await firstStart;
    await stopSecond;
    await secondStart;
    await new Promise((resolve) => setTimeout(resolve, 35));

    assert.deepEqual(driver.spawnCalls.map((call) => call.agentId), ["agent-1"]);
  }, {
    runtimeStartScheduler: {
      maxConcurrentStarts: 1,
      minStartIntervalMs: 25,
    },
  });
});

test("cancelAllQueuedAgentStarts settles every queued caller promise and clears tracking", async () => {
  await withManager(async ({ manager }) => {
    setAgentStartCapacityFull(manager);

    const secondStart = manager.startAgent("agent-2", makeConfig({ name: "agent-2" }));
    const thirdStart = manager.startAgent("agent-3", makeConfig({ name: "agent-3" }));

    await flush();
    assert.equal(agentStartSnapshot(manager).queueDepth, 2);

    (manager as any).cancelAllQueuedAgentStarts("daemon shutdown");

    await Promise.all([secondStart, thirdStart]);
    assert.equal(agentStartSnapshot(manager).queueDepth, 0);
    assert.deepEqual(agentStartSnapshot(manager).queuedAgentIds, []);
    assert.equal((manager as any).startingInboxes.size, 0);
  });
});

test("explicit start seeds an idle fallback config for later delivery recovery", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.ok(cached, "expected an explicit start to keep a fallback config");
    assert.equal(cached.sessionId, "session-1");
    assert.equal(cached.config.sessionId, "session-1");
    assert.deepEqual(manager.getIdleAgentSessionIds(), []);
  });
});

test("Codex session_init settles pre-session delivery debt without waiting for turn_end", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: "stored-thread-1",
    }));

    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");
    assert.equal(ap.sessionId, null);
    assert.equal(ap.config.sessionId, "stored-thread-1");
    assert.equal(manager.getAgentSessionId("agent-1"), null);

    const accepted = manager.deliverMessage("agent-1", makeMessage("arrived while resume is pending", {
      message_id: "pending-resume-delivery",
    }));
    assert.equal(accepted, true);
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(ap.inbox.length, 1);

    const routed = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed"
      && span.attrs?.delivery_correlation_id === "pending-resume-delivery"
    );
    assert.equal(routed?.attrs?.outcome, "queued_before_session");
    assert.equal(routed?.attrs?.session_id_present, false);

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "stored-thread-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    retryScheduler.clock.advanceBy(4);
    assert.equal(driver.encodedCalls.length, 0, "session_init retry must wait for the configured settlement delay");
    retryScheduler.clock.advanceBy(1);

    assert.equal(ap.sessionId, "stored-thread-1");
    assert.equal(manager.getAgentSessionId("agent-1"), "stored-thread-1");
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assertContentFreeInboxUpdatePrompt(
      driver.encodedCalls[0].text,
      "arrived while resume is pending",
    );
    const readySettlement = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.session_ready_delivery_retry.scheduled"
      && span.attrs?.reason === "session_init_ready_with_pending_delivery"
    );
    assert.equal(readySettlement?.attrs?.session_ready_for_delivery, true);
    assert.equal(readySettlement?.attrs?.delay_ms, 5);

    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1, "duplicate session_init must not duplicate delivery");
  }, { driver, tracer, sessionReadyDeliveryRetryMs: 5, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("Codex session_init rebind re-drives pending debt on the new session", async () => {
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: null }));
    const message = makeMessage("survive runtime session rebind", {
      message_id: "codex-rebind-pending-delivery",
    });
    manager.deliverMessage("agent-1", message);

    driver.parsedLines.set("session-init-first", [{ kind: "session_init", sessionId: "thread-first" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init-first\n"));
    await flush();
    retryScheduler.clock.advanceBy(5);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.sessionReadyForDelivery, true);
    assert.equal(ap.inbox.length, 1, "delivery contribution is not an inbox consume boundary");
    assert.equal(ap.notifications.hasContributedMessage(message, "thread-first"), true);

    driver.parsedLines.set("session-init-second", [{ kind: "session_init", sessionId: "thread-second" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init-second\n"));
    await flush();
    retryScheduler.clock.advanceBy(5);

    assert.equal(ap.sessionId, "thread-second");
    assert.equal(driver.encodedCalls[1].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[1].text, "survive runtime session rebind");
    assert.equal(ap.notifications.hasContributedMessage(message, "thread-second"), true);
  }, { driver, sessionReadyDeliveryRetryMs: 5, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("Pi session_init settles pre-session delivery debt without waiting for turn_end", async () => {
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();
  const driver = new FakeCodexDriver({
    id: "pi",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "pi",
      sessionId: null,
    }));

    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");
    assert.equal(ap.sessionId, null);

    const accepted = manager.deliverMessage("agent-1", makeMessage("arrived while Pi session factory is pending", {
      message_id: "pending-pi-session-delivery",
    }));
    assert.equal(accepted, true);
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(ap.inbox.length, 1);

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "pi-live-session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    retryScheduler.clock.advanceBy(5);

    assert.equal(ap.sessionId, "pi-live-session-1");
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assertContentFreeInboxUpdatePrompt(
      driver.encodedCalls[0].text,
      "arrived while Pi session factory is pending",
    );

    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1, "duplicate session_init must not duplicate delivery");
  }, { driver, sessionReadyDeliveryRetryMs: 5, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("turn_end cancels ready-transition settlement timer and delivers pre-session debt once", async () => {
  const retryScheduler = makeSessionReadyDeliveryRetryScheduler();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: null }));
    manager.deliverMessage("agent-1", makeMessage("settle once across session_init and turn_end", {
      message_id: "ready-turn-end-race-message",
    }));

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "thread-race" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.sessionReadyDeliveryRetry.kind, "scheduled");
    assert.equal(driver.encodedCalls.length, 0);

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "thread-race" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1, "turn_end must settle pending delivery synchronously");
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.equal(retryScheduler.clock.pendingTimerCount(), 0, "turn_end must cancel the ready-transition timer");

    retryScheduler.clock.advanceBy(25);
    assert.equal(driver.encodedCalls.length, 1, "cleared ready-transition timer must not duplicate delivery");
    assert.equal(ap.sessionReadyDeliveryRetry.kind, "idle");
  }, { driver, sessionReadyDeliveryRetryMs: 25, sessionReadyDeliveryRetrySchedulerFactory: retryScheduler.factory });
});

test("session-init gated rebind replaces the pending resume target without making it deliverable", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: "stored-thread-1",
    }));

    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");
    assert.equal(ap.sessionId, null);
    assert.equal(ap.config.sessionId, "stored-thread-1");

    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: "stored-thread-2",
    }));

    assert.equal(driver.spawnCalls.length, 1, "rebind must not spawn a second process");
    assert.equal(ap.sessionId, null, "pending resume target must not become a live delivery session");
    assert.equal(ap.config.sessionId, "stored-thread-2", "restart-safe resume target should follow latest rebind");
    assert.equal(manager.getAgentSessionId("agent-1"), null);
    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.equal(cached?.sessionId, "stored-thread-2");
    assert.equal(cached?.config.sessionId, "stored-thread-2");

    const accepted = manager.deliverMessage("agent-1", makeMessage("arrived after rebind while resume is pending", {
      message_id: "pending-resume-rebind-delivery",
    }));
    assert.equal(accepted, true);
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(ap.inbox.length, 1);
  }, { driver });
});

test("session-init gated rebind can reset a pending resume target to fresh start", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
    requiresSessionInitForDelivery: true,
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: "stored-thread-1",
    }));

    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");
    assert.equal(ap.sessionId, null);
    assert.equal(ap.config.sessionId, "stored-thread-1");

    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: null,
    }));

    assert.equal(driver.spawnCalls.length, 1, "rebind must not spawn a second process");
    assert.equal(ap.sessionId, null);
    assert.equal(ap.config.sessionId, null, "latest reset intent should clear restart-safe resume target");
    assert.equal(manager.getAgentSessionId("agent-1"), null);
    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.equal(cached?.sessionId, null);
    assert.equal(cached?.config.sessionId, null);
  }, { driver });
});

test("persistent runtimes exiting before parsed turn boundary are not marked idle", async () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );

  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await flush();

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      false,
      "exit 0 before turn_end must not cache a healthy idle runtime",
    );
    assert.ok(sent.some((msg) =>
      msg.type === "agent:status"
      && msg.agentId === "agent-1"
      && msg.status === "inactive"
    ));
    assert.equal(findLastActivity(sent, "error"), undefined);
    const offlineActivity = findLastActivity(sent, "offline");
    assert.ok(offlineActivity && offlineActivity.type === "agent:activity");
    assert.equal(offlineActivity.detail, "Crashed (exit code 0)");

    const runtimeSpan = sink.getAllSpans().find((span) => span.name === "daemon.runtime.turn");
    assert.ok(runtimeSpan, "expected runtime trace to close on early process exit");
    assert.equal(runtimeSpan.status, "error");
    assert.equal(runtimeSpan.attrs?.runtime_turn_boundary, "parsed_event");
    assert.equal(runtimeSpan.attrs?.runtime_turn_boundary_satisfied, false);
    assert.equal(runtimeSpan.attrs?.runtime_exit_before_turn_boundary, true);

    const statusSpans = sink.getAllSpans().filter((span) => span.name === "daemon.agent.status.transition");
    const activeSpan = statusSpans.find((span) => span.attrs?.status === "active");
    assert.ok(activeSpan, "expected active agent status transition span");
    assert.equal(activeSpan.attrs?.agent_id, "agent-1");
    assert.equal(activeSpan.attrs?.previous_status, "unknown");
    assert.equal(activeSpan.attrs?.previous_status_present, false);
    assert.equal(activeSpan.attrs?.status_changed, true);
    assert.equal(activeSpan.attrs?.launch_id_present, true);
    assert.equal(activeSpan.attrs?.previous_launch_id_present, false);
    assert.equal(activeSpan.attrs?.launch_id_changed, true);
    assert.equal(activeSpan.attrs?.runtime, "codex");
    assert.equal(activeSpan.attrs?.session_id_present, true);
    assert.equal(typeof activeSpan.attrs?.status_transition_seq, "number");
    assert.equal(typeof activeSpan.attrs?.observed_at_ms, "number");

    const inactiveSpan = statusSpans.find((span) => span.attrs?.status === "inactive");
    assert.ok(inactiveSpan, "expected inactive agent status transition span");
    assert.equal(inactiveSpan.attrs?.previous_status, "active");
    assert.equal(inactiveSpan.attrs?.previous_status_present, true);
    assert.equal(inactiveSpan.attrs?.status_changed, true);
    assert.equal(inactiveSpan.attrs?.launch_id_present, true);
    assert.equal(inactiveSpan.attrs?.previous_launch_id_present, true);
    assert.equal(inactiveSpan.attrs?.launch_id_changed, false);
    assert.equal(inactiveSpan.attrs?.process_instance_id, activeSpan.attrs?.process_instance_id);
    assert.ok(
      Number(inactiveSpan.attrs?.status_transition_seq) > Number(activeSpan.attrs?.status_transition_seq),
      "status transition sequence should preserve emission order",
    );
  }, { tracer });
});

test("persistent runtimes exiting after parsed turn boundary can be cached idle", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await flush();

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), true);
    assert.ok(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      "exit 0 after a parsed turn boundary can cache healthy idle state",
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:status" && msg.agentId === "agent-1" && msg.status === "inactive"),
      false,
    );
  });
});

test("stdin clean exit preserves pending inbox queued after turn_end", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(manager.deliverMessage("agent-1", makeMessage("queued between turn_end and close")), true);
    assert.equal(driver.encodedCalls.length, 0, "message is queued locally while the stdin session is unavailable");

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await waitFor(() => driver.spawnCalls.length === 2, "restart with pending inbox after clean stdin close");

    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "queued between turn_end and close");
  }, { driver });
});

test("idle auto-restart queues a second delivery without rejecting it", async () => {
  await withManager(async ({ manager, sent }) => {
    (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({ sessionId: "session-1" }),
      sessionId: "session-1",
      launchId: "launch-1",
    });

    const firstAccepted = manager.deliverMessage("agent-1", makeMessage("wake from idle cache"));
    const secondAccepted = manager.deliverMessage("agent-1", makeMessage("arrived during restart"));

    assert.ok(firstAccepted instanceof Promise, "idle restart acceptance resolves after spawn starts");
    assert.equal(secondAccepted, true);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.equal((manager as any).startingInboxes.values("agent-1")?.length, 1);
    assert.equal((manager as any).startingInboxes.values("agent-1")?.[0]?.content, "arrived during restart");
    assert.ok(!sent.some((msg) =>
      msg.type === "agent:status"
      && msg.agentId === "agent-1"
      && msg.status === "inactive"
    ));
    assert.ok(!sent.some((msg) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && projectFactActivity(msg) === "offline"
      && msg.detail === "Process unavailable; restart required"
    ));

    // The auto-restart continues asynchronously after the synchronous delivery
    // assertions above. Stop it before the temp workspace cleanup runs.
    for (let i = 0; i < 10 && !(manager as any).agents.has("agent-1"); i++) {
      await flush();
    }
    assert.equal(await firstAccepted, true);
    await manager.stopAgent("agent-1", { wait: true, silent: true });
  });
});

test("stop during STARTING prevents the late runtime registration from resurrecting the agent", async () => {
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = () => resolve(null);
  });

  await withManager(async ({ driver, manager }) => {
    const start = manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );
    await waitFor(() => agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), "start to enter STARTING window");

    await manager.stopAgent("agent-1");
    releaseDefaults();
    await start;

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.equal(agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), false);
    assert.equal(driver.spawnCalls.length, 0, "stop fence must dismantle before the runtime is spawned");
  }, {
    defaultAgentEnvVarsProvider: () => defaultsReady,
  });
});

test("fresh start after stop during STARTING is not suppressed with the stopped generation", async () => {
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = () => resolve(null);
  });

  await withManager(async ({ driver, manager }) => {
    const firstStart = manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );
    await waitFor(() => agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), "start to enter STARTING window");

    await manager.stopAgent("agent-1");
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-2" }),
      makeMessage("fresh wake after stop"),
      undefined,
      undefined,
      "launch-2",
    );
    releaseDefaults();
    await firstStart;

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.launchId, "launch-2");
    assert.equal(driver.spawnCalls[0]?.config.sessionId, "session-2");
    assert.equal((manager as any).agents.has("agent-1"), true);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), true);
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-2");
  }, {
    defaultAgentEnvVarsProvider: () => defaultsReady,
  });
});

test("stop during failed idle auto-restart prevents restart snapshot resurrection", async () => {
  await withManager(async ({ driver, manager }) => {
    (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({ sessionId: "session-1" }),
      sessionId: "session-1",
      launchId: "launch-1",
    });

    let resolveEnteredStart!: () => void;
    let rejectStart!: () => void;
    const enteredStart = new Promise<void>((resolve) => {
      resolveEnteredStart = resolve;
    });
    const originalStartAgent = manager.startAgent.bind(manager);
    (manager as any).startAgent = (agentId: string) => {
      markAgentStarting(manager, agentId);
      resolveEnteredStart();
      return new Promise<void>((_resolve, reject) => {
        rejectStart = () => {
          (manager as any).agentStarts.clearStarting(agentId);
          reject(new Error("spawn failed after stop"));
        };
      });
    };

    const accepted = manager.deliverMessage("agent-1", makeMessage("wake from idle cache"));
    assert.ok(accepted instanceof Promise, "idle restart acceptance resolves after the start attempt settles");
    await enteredStart;

    await manager.stopAgent("agent-1");
    rejectStart();

    assert.equal(await accepted, false);
    (manager as any).startAgent = originalStartAgent;
    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.equal(agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), false);

    const secondAccepted = manager.deliverMessage("agent-1", makeMessage("must not auto-restart after stopped failure"));
    assert.equal(secondAccepted, false);
    assert.equal(driver.spawnCalls.length, 0);
  });
});

test("idle auto-restart preserves restart residency after managed credential mint failure", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({
        sessionId: "session-1",
        agentCredentialKey: undefined,
        agentCredentialId: undefined,
      }),
      sessionId: "session-1",
      launchId: "launch-1",
    });

    await withRunnerCredentialMintFailure(async () => {
      const accepted = await manager.deliverMessage("agent-1", makeMessage("wake from idle cache"));

      assert.equal(accepted, false);
      assert.equal(driver.spawnCalls.length, 0);
      const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
      assert.ok(cached, "credential mint failure keeps restart-safe idle residency");
      assert.equal(cached.config.agentCredentialKey, undefined, "cached retry config must not retain failed runner credentials");
      const state = getSpawnFailBackoffState(manager, "agent-1");
      assert.ok(state?.untilMs > 0, "credential mint failure arms cooldown residency for the next wake");
      assert.ok(sent.some((msg) =>
        msg.type === "agent:status"
        && msg.agentId === "agent-1"
        && msg.status === "inactive"
        && msg.launchId === "launch-1"
      ));
      assert.ok(sent.some((msg) =>
        msg.type === "agent:activity"
        && msg.agentId === "agent-1"
        && projectFactActivity(msg) === "error"
        && msg.detail.includes("runner_credential_mint_failed")
      ));
      assert.equal(findLastActivity(sent, "online"), undefined);
    });
  });
});

test("delivery with no process and no idle fallback is rejected and marks agent inactive", async () => {
  await withManager(async ({ manager, sent }) => {
    const accepted = manager.deliverMessage("agent-1", makeMessage("lost if acked"));

    assert.equal(accepted, false);
    assert.ok(sent.some((msg) =>
      msg.type === "agent:status"
      && msg.agentId === "agent-1"
      && msg.status === "inactive"
    ));
    assert.ok(sent.some((msg) =>
      msg.type === "agent:activity"
      && msg.agentId === "agent-1"
      && projectFactActivity(msg) === "offline"
      && msg.detail === "Process unavailable; restart required"
    ));
  });
});

test("machine-level default env vars are injected into spawn config", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", envVars: null }));

    assert.equal(driver.spawnCalls.length, 1);
    assert.deepEqual(driver.spawnCalls[0]?.config.envVars, {
      OPENAI_API_KEY: "sk-machine-openai",
      OPENAI_BASE_URL: "https://proxy.example.com/v1",
    });
  }, {
    defaultAgentEnvVarsProvider: async (config) => config.runtime === "codex"
      ? {
          OPENAI_API_KEY: "sk-machine-openai",
          OPENAI_BASE_URL: "https://proxy.example.com/v1",
        }
      : null,
  });
});

test("daemon serverUrl overrides server-provided agent config for spawn", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ serverUrl: "http://localhost:3001" }),
    );

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.spawnCalls[0]?.config.serverUrl, "https://daemon.example.com");
  });
});

test("start while already running rebinds launchId for future lifecycle reports", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-A",
    );
    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-A");

    const duplicateStartOffset = sent.length;
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "server-session-ignored" }),
      makeMessage("wake while server thought inactive"),
      undefined,
      undefined,
      "launch-B",
    );

    assert.equal(driver.spawnCalls.length, 1, "duplicate guarded start must not spawn a second process");
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-B");
    assert.equal(manager.getAgentRuntimeProfileReport("agent-1")?.launchId, "launch-B");
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "active" && msg.launchId === "launch-B"),
      "expected active status to be re-sent with the new launch id",
    );
    assert.ok(
      sent.some((msg) => msg.type === "agent:session" && msg.sessionId === "session-1" && msg.launchId === "launch-B"),
      "expected session to be re-sent with the current session and new launch id",
    );
    const rebound = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.runtime_binding.rebound"
      && span.attrs?.source === "server_start_rebind"
      && span.attrs?.next_active_launch_id === "launch-B"
    );
    assert.ok(rebound, "expected an explicit active-launch binding rebind");

    driver.parsedLines.set("tool-call", [{ kind: "tool_call", name: "Bash", input: { command: "echo ok" } }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-call\n"));

    const activity = findLastActivity(sent, "working");
    assert.ok(activity && activity.type === "agent:activity");
    assert.equal(activity.launchId, "launch-B");
    assert.deepEqual(
      sent
        .slice(duplicateStartOffset)
        .filter((msg) => "launchId" in msg && msg.launchId === "launch-A")
        .map((msg) => msg.type),
      [],
      "no lifecycle signal after the duplicate start may keep the old launch id",
    );
  }, { tracer });
});

test("live launch rebind keeps immutable proxy cleanup ownership", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const overlayPath = path.join(dataDir, ".cursor", "mcp.json");
    const originalConfig = '{\n  "mcpServers": { "user": { "url": "https://user.example/mcp" } }\n}';
    await mkdir(path.dirname(overlayPath), { recursive: true });
    await writeFile(overlayPath, originalConfig, { mode: 0o640 });

    try {
      await manager.startAgent(
        "agent-rebind-resources",
        makeConfig({ sessionId: "session-L1" }),
        undefined,
        undefined,
        undefined,
        "launch-L1",
      );
      const ap = (manager as any).agents.get("agent-rebind-resources") as {
        launchId: string | null;
        config: AgentConfig;
      };
      const originalCredentialId = ap.config.agentCredentialId;
      const originalCredentialKey = ap.config.agentCredentialKey;

      const managedHandle = await registerManagedMcpRuntimeProxy({
        agentId: "agent-rebind-resources",
        launchId: "launch-L1",
        snapshot: { catalogVersion: 1, tools: [] },
        async callTool() {
          throw new Error("not reached");
        },
      });
      const credentialHandle = await registerAgentCredentialProxy({
        agentId: "agent-rebind-resources",
        launchId: "launch-L1",
        serverUrl: "https://upstream.invalid",
        apiKey: "sk_agent_server_side",
        activeCapabilities: "read",
      });
      installManagedMcpRuntimeJsonOverlay({
        agentId: "agent-rebind-resources",
        launchId: "launch-L1",
        filePath: overlayPath,
        apply: (config) => ({
          ...config,
          mcpServers: {
            ...(config.mcpServers as Record<string, unknown>),
            managed_l1: { url: managedHandle.url },
          },
        }),
      });

      await manager.startAgent(
        "agent-rebind-resources",
        makeConfig({
          sessionId: "server-session-L2",
          agentCredentialKey: undefined,
          agentCredentialId: undefined,
        }),
        makeMessage("wake after rebind"),
        undefined,
        undefined,
        "launch-L2",
      );
      const rebound = (manager as any).agents.get("agent-rebind-resources") as {
        launchId: string | null;
        config: AgentConfig;
      };
      assert.equal(rebound.launchId, "launch-L2");
      assert.equal(rebound.config.agentCredentialId, originalCredentialId);
      assert.equal(rebound.config.agentCredentialKey, originalCredentialKey);

      await manager.stopAgent("agent-rebind-resources");
      assert.equal(await readFile(overlayPath, "utf8"), originalConfig);
      assert.equal((await stat(overlayPath)).mode & 0o777, 0o640);
      assert.equal(
        unregisterManagedMcpRuntimeProxyForLaunch({
          agentId: "agent-rebind-resources",
          launchId: "launch-L1",
        }),
        0,
      );
      assert.equal(
        unregisterManagedMcpRuntimeProxyForLaunch({
          agentId: "agent-rebind-resources",
          launchId: "launch-L2",
        }),
        0,
      );
      assert.equal(
        unregisterAgentCredentialProxyForLaunch({
          agentId: "agent-rebind-resources",
          launchId: "launch-L1",
        }),
        0,
      );

      const staleManaged = await fetch(managedHandle.url, { method: "POST" });
      assert.equal(staleManaged.status, 404);
      const staleCredential = await fetch(
        `${credentialHandle.proxyUrl}/internal/agent-api/server`,
        { headers: { Authorization: `Bearer ${credentialHandle.proxyToken}` } },
      );
      assert.equal(staleCredential.status, 401);

      await manager.startAgent(
        "agent-rebind-resources",
        makeConfig({ sessionId: "session-L3" }),
        undefined,
        undefined,
        undefined,
        "launch-L3",
      );
      installManagedMcpRuntimeJsonOverlay({
        agentId: "agent-rebind-resources",
        launchId: "launch-L3",
        filePath: overlayPath,
        apply: (config) => ({
          ...config,
          mcpServers: {
            ...(config.mcpServers as Record<string, unknown>),
            managed_l3: { url: "http://127.0.0.1/new" },
          },
        }),
      });
      const restarted = JSON.parse(await readFile(overlayPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(restarted.mcpServers).sort(), [
        "managed_l3",
        "user",
      ]);
      await manager.stopAgent("agent-rebind-resources");
      assert.equal(await readFile(overlayPath, "utf8"), originalConfig);
    } finally {
      await __resetManagedMcpRuntimeProxyForTest();
      await __resetAgentCredentialProxyForTest();
    }
  });
});

test("start while startup is in progress rebinds launchId once the process is registered", async () => {
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = () => resolve(null);
  });

  await withManager(async ({ driver, sent, manager }) => {
    const firstStart = manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-A",
    );
    await waitFor(() => agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), "first start to enter startup window");

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-B" }),
      makeMessage("wake during startup"),
      undefined,
      undefined,
      "launch-B",
    );
    assert.equal(driver.spawnCalls.length, 0, "second start must not spawn while first start is still blocked");

    releaseDefaults();
    await firstStart;

    assert.equal(driver.spawnCalls.length, 1, "startup rebind must keep single-spawn semantics");
    assert.equal(driver.spawnCalls[0]?.launchId, "launch-B", "spawned runtime context must use the latest server launch id");
    assert.equal(driver.spawnCalls[0]?.config.sessionId, "session-B", "spawned runtime config must use the latest start config");
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-B");
    assert.equal(manager.getAgentRuntimeProfileReport("agent-1")?.launchId, "launch-B");
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "active" && msg.launchId === "launch-B"),
      "expected active status to use the latest server launch id",
    );
    assert.ok(
      sent.some((msg) => msg.type === "agent:session" && msg.sessionId === "session-B" && msg.launchId === "launch-B"),
      "expected session to use the latest server launch id",
    );
    assert.deepEqual(
      sent
        .filter((msg) => "launchId" in msg && msg.launchId === "launch-A")
        .map((msg) => msg.type),
      [],
      "startup rebind must not emit stale lifecycle signals with the original launch id",
    );
  }, {
    defaultAgentEnvVarsProvider: () => defaultsReady,
  });
});

test("start while startup is in progress rebuilds spawn inputs from the latest config", async () => {
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = () => resolve(null);
  });
  const runtimeProfileControl = {
    kind: "daemon_release_notice",
    key: "release-B",
    message: "Runtime Profile notice: daemon upgraded.",
  } as const;

  await withManager(async ({ driver, manager }) => {
    const firstStart = manager.startAgent(
      "agent-1",
      makeConfig({
        model: "model-A",
        reasoningEffort: "low",
        sessionId: "session-A",
        envVars: { OPENAI_API_KEY: "sk-agent-A" },
        runtimeProfileControl: null,
      }),
      undefined,
      undefined,
      undefined,
      "launch-A",
    );
    await waitFor(() => agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), "first start to enter startup window");

    await manager.startAgent(
      "agent-1",
      makeConfig({
        model: "model-B",
        reasoningEffort: "high",
        sessionId: "session-B",
        envVars: {
          OPENAI_API_KEY: "sk-agent-B",
          CUSTOM_FLAG: "B",
          GIT_AUTHOR_NAME: "Caller Selected",
          GIT_AUTHOR_EMAIL: "caller@example.test",
        },
        runtimeProfileControl,
      }),
      undefined,
      undefined,
      undefined,
      "launch-B",
    );

    releaseDefaults();
    await firstStart;

    assert.equal(driver.spawnCalls.length, 1, "startup rebind must keep single-spawn semantics");
    const spawnConfig = driver.spawnCalls[0]?.config;
    assert.equal(driver.spawnCalls[0]?.launchId, "launch-B");
    assert.equal(spawnConfig?.model, "model-B");
    assert.equal(spawnConfig?.reasoningEffort, "high");
    assert.equal(spawnConfig?.sessionId, "session-B");
    assert.deepEqual(spawnConfig?.envVars, {
      OPENAI_API_KEY: "sk-agent-B",
      CUSTOM_FLAG: "B",
      GIT_AUTHOR_NAME: "Caller Selected",
      GIT_AUTHOR_EMAIL: "caller@example.test",
    });
    assert.deepEqual(spawnConfig?.runtimeProfileControl, runtimeProfileControl);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap?.config.model, "model-B");
    assert.equal(ap?.config.reasoningEffort, "high");
    assert.equal(ap?.sessionId, "session-B");
    assert.equal(ap?.runtimeProfileTurnControl?.kind, "daemon_release_notice");
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-B");
  }, {
    defaultAgentEnvVarsProvider: () => defaultsReady,
  });
});

test("startup rebind wake message prevents empty-start deferral and uses latest launchId", async () => {
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = () => resolve(null);
  });
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    deferSpawnUntilMessage: true,
  });

  await withManager(async ({ sent, manager }) => {
    const firstStart = manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "opencode", sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-A",
    );
    await waitFor(() => agentStartSnapshot(manager).startingAgentIds.includes("agent-1"), "first deferred runtime start to enter startup window");

    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "opencode", sessionId: "server-session-ignored" }),
      makeMessage("wake during deferred startup"),
      undefined,
      undefined,
      "launch-B",
    );

    releaseDefaults();
    await firstStart;
    await flush();

    assert.equal(driver.spawnCalls.length, 1, "pending rebind wake must force a concrete spawn");
    assert.equal(driver.spawnCalls[0]?.launchId, "launch-B", "spawned runtime context must use the latest server launch id");
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-B");
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "active" && msg.launchId === "launch-B"),
      "expected active status to use the latest server launch id",
    );
    assert.deepEqual(
      sent
        .filter((msg) => "launchId" in msg && msg.launchId === "launch-A")
        .map((msg) => msg.type),
      [],
      "deferred-start rebind must not emit stale lifecycle signals with the original launch id",
    );
  }, {
    driver,
    defaultAgentEnvVarsProvider: () => defaultsReady,
  });
});

test("start while already queued rebinds queued item to latest launchId before dequeue", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, sent, manager }) => {
    setAgentStartCapacityFull(manager);

    const firstStart = manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      makeMessage("wake A", { message_id: "message-A" }),
      undefined,
      undefined,
      "launch-A",
      false,
      undefined,
      "dispatch-A",
    );
    await flush();
    assert.equal(agentStartSnapshot(manager).queueDepth, 1);

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-B" }),
      makeMessage("wake B", { message_id: "message-B" }),
      undefined,
      undefined,
      "launch-B",
      false,
      undefined,
      "dispatch-B",
    );

    assert.equal(agentStartSnapshot(manager).queueDepth, 1, "duplicate queued start must keep single-queue semantics");
    const queued = queuedAgentStart(manager, "agent-1");
    assert.equal(queued?.launchId, "launch-B", "queued start must be rebound before dequeue");
    assert.equal(
      queued?.startDispatchId,
      "dispatch-B",
      "queued start must carry the latest dispatch identity before dequeue",
    );

    (manager as any).releaseAgentStartSlot("slot-holder", "test: slot freed");
    await firstStart;

    assert.equal(driver.spawnCalls.length, 1, "queued rebind must not spawn twice");
    assert.equal(driver.spawnCalls[0]?.launchId, "launch-B", "dequeued runtime context must use the latest server launch id");
    assert.equal(manager.getAgentLaunchId("agent-1"), "launch-B");
    assert.equal(manager.getAgentRuntimeProfileReport("agent-1")?.launchId, "launch-B");
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "active" && msg.launchId === "launch-B"),
      "expected active status to use the latest server launch id",
    );
    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "runtime-session-B" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    const session = sent.find((msg) => msg.type === "agent:session" && msg.sessionId === "runtime-session-B");
    assert.ok(session && session.type === "agent:session");
    assert.equal(session.launchId, "launch-B", "runtime-originated session signal must use the rebound launch id");
    assert.deepEqual(
      sent
        .filter((msg) => "launchId" in msg && msg.launchId === "launch-A")
        .map((msg) => msg.type),
      [],
      "queued rebind must not emit stale lifecycle signals with the original launch id",
    );
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap?.startDispatchId, "dispatch-B");
    const spawn = sink.getAllSpans().find((span) => span.name === "daemon.agent.spawn.created");
    assert.equal(spawn?.attrs?.start_dispatch_id, "dispatch-B");
    assert.equal(spawn?.attrs?.launchId, "launch-B");
    assert.deepEqual(
      ap?.inbox.map((message: AgentMessage) => message.message_id),
      ["message-B", "message-A"],
      "queued rebind must keep the latest wake as startup input without dropping the original queued wake",
    );
  }, { tracer });
});

test("stopAgent refreshes runtime profile session ref from local JSONL", async () => {
  await withManager(async ({ driver, manager, sent, dataDir }) => {
    const sessionId = "019dd549-cc6b-7642-917e-fd658b11c941";
    const codexHome = path.join(dataDir, "codex-home");
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      envVars: { CODEX_HOME: codexHome },
    }), undefined, undefined, undefined, "launch-1");

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    const initialReport = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:runtime_profile" }> => msg.type === "agent:runtime_profile")
      .at(-1);
    const initialSessionRef = initialReport?.facts.sessionRef;
    assert.ok(initialSessionRef && typeof initialSessionRef === "object");
    assert.equal(initialSessionRef.reachable, true);
    const initialSessionPath = initialSessionRef.path;
    if (typeof initialSessionPath !== "string") {
      throw new Error("expected string handoff session path");
    }
    assert.match(initialSessionPath, /\/agent-1\/\.slock\/runtime-sessions\/codex-019dd549-cc6b-7642-917e-fd658b11c941\.jsonl$/);
    assert.match(initialSessionRef.reason ?? "", /native session file path not found/);
    assert.match(await readFile(initialSessionPath, "utf8"), /runtime_session_handoff/);

    const sessionPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "04",
      "29",
      `rollout-2026-04-29T02-11-16-${sessionId}.jsonl`,
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, "{}\n");

    await manager.stopAgent("agent-1");
    await flush();

    const stopReport = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:runtime_profile" }> => msg.type === "agent:runtime_profile")
      .at(-1);
    const stopSessionRef = stopReport?.facts.sessionRef;
    assert.ok(stopSessionRef && typeof stopSessionRef === "object");
    assert.equal(stopReport?.launchId, "launch-1");
    assert.deepEqual(stopSessionRef, {
      label: sessionId,
      path: sessionPath,
      runtime: "codex",
      reachable: true,
    });
  });
});

test("codex profile transcript and global skills use configured CODEX_HOME root", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const codexHome = path.join(dataDir, "codex-home");
    const sessionId = "019dd549-cc6b-7642-917e-codehome";
    const sessionPath = path.join(
      codexHome,
      "sessions",
      "2026",
      "04",
      "29",
      `rollout-2026-04-29T02-11-16-${sessionId}.jsonl`,
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, "{\"type\":\"codex-home-session\"}\n");

    const skillDir = path.join(codexHome, "skills", "global-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: Global Helper",
      "description: CODEX_HOME scoped skill",
      "user-invocable: true",
      "---",
      "",
      "Use this skill for CODEX_HOME scoped work.",
    ].join("\n"));

    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId,
      envVars: { CODEX_HOME: codexHome },
    }));

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    assert.deepEqual(manager.getAgentRuntimeProfileReport("agent-1")?.facts.sessionRef, {
      label: sessionId,
      path: sessionPath,
      runtime: "codex",
      reachable: true,
    });

    const transcript = await manager.getSessionTranscript("agent-1");
    assert.equal(transcript.reachable, true);
    assert.equal(transcript.path, sessionPath);
    assert.match(transcript.transcript ?? "", /codex-home-session/);

    const skills = await manager.listSkills("agent-1");
    assert.ok(
      skills.global.some((skill) =>
        skill.name === "global-helper"
        && skill.displayName === "Global Helper"
        && skill.userInvocable
      ),
      "expected Codex global skills to be read from CODEX_HOME/skills",
    );
  });
});

test("custom Claude provider runtime profile session refs use daemon handoff when host JSONL is absent", async () => {
  await withManager(async ({ driver, manager, dataDir }) => {
    const sessionId = "0618f17e-577e-4e6a-a7f0-31dc50611388";
    await manager.startAgent("agent-1", makeConfig({
      runtime: "claude",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
        model: { kind: "preset", id: "opus" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: null,
      },
    }));

    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    const sessionPath = path.join(
      dataDir,
      "agent-1",
      ".slock",
      "runtime-sessions",
      `claude-${sessionId}.jsonl`,
    );

    const sessionRef = manager.getAgentRuntimeProfileReport("agent-1")?.facts.sessionRef;
    assert.ok(sessionRef && typeof sessionRef === "object", "sessionRef should resolve to a ref object");
    assert.deepEqual(
      { label: sessionRef.label, path: sessionRef.path, runtime: sessionRef.runtime, reachable: sessionRef.reachable },
      { label: sessionId, path: sessionPath, runtime: "claude", reachable: true },
    );
    // #3870 inserts an optional `searched=[...]` negative-space clause into the reason.
    assert.match(
      sessionRef.reason ?? "",
      /^native session file path not found; using daemon handoff file(; searched=\[.*\])?; attempted_lookup=claude_jsonl$/,
    );
  }, {
    driver: new FakeCodexDriver({
      id: "claude",
      supportsStdinNotification: true,
      busyDeliveryMode: "notification",
      supportsNativeStandingPrompt: true,
    }),
  });
});

test("custom Claude provider skills use host Claude home without isolated bridge", async () => {
  const hostHome = await mkdtemp(path.join(os.tmpdir(), "slock-host-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = hostHome;
  try {
    const hostSkillDir = path.join(hostHome, ".claude", "skills", "global-helper");
    await mkdir(hostSkillDir, { recursive: true });
    await writeFile(path.join(hostSkillDir, "SKILL.md"), [
      "---",
      "name: Global Helper",
      "description: Shared Claude skill",
      "user-invocable: true",
      "---",
      "",
      "Use this skill for shared helper work.",
    ].join("\n"));
    await writeFile(path.join(hostHome, ".claude", "settings.json"), "{\"account\":\"host\"}\n");

    await withManager(async ({ manager, dataDir }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "claude",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "preset", id: "opus" },
          mode: { kind: "default" },
          reasoningEffort: null,
          envVars: null,
        },
      }));

      const skills = await manager.listSkills("agent-1");
      assert.ok(
        skills.global.some((skill) =>
          skill.name === "global-helper"
          && skill.displayName === "Global Helper"
          && skill.userInvocable
        ),
        "expected custom-provider Claude agents to keep host global skills visible from host Claude home",
      );

      const isolatedClaudeDir = path.join(dataDir, "agent-1", ".slock", "claude-provider", "home", ".claude");
      assert.equal(existsSync(isolatedClaudeDir), false);
    }, {
      driver: new FakeCodexDriver({
        id: "claude",
        supportsStdinNotification: true,
        busyDeliveryMode: "notification",
        supportsNativeStandingPrompt: true,
      }),
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(hostHome, { recursive: true, force: true });
  }
});

test("spawn-time legacy runtime profile migration is completed without prompt control", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtimeProfileControl: {
        kind: "migration",
        key: "migration-key-1",
        message: "Runtime Profile changed: model changed",
      },
    }));

    assert.ok(sent.some((msg) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-key-1"
    ));
    assert.ok(sent.some((msg) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-key-1"
    ));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
    assert.ok(span);
    assert.equal(span.attrs?.runtime_profile_control_kind, undefined);
    assert.equal(span.attrs?.runtime_profile_turn_outcome, undefined);

    const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
    assert.ok(!events.includes("runtime_profile.migration.turn_without_ack"));
  }, { tracer });
});

test("runtime error turns record scrubbed diagnostic envelope", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());

    driver.parsedLines.set("provider-error", [{
      kind: "error",
      message: "ProviderModelNotFoundError: API Error: 404 for /Users/alice/secret.txt with Bearer abcdefghijklmnopqrstuvwxyz",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("provider-error\n"));
    await flush();

    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
    assert.ok(span);
    assert.equal(span.status, "error");
    assert.equal(span.attrs?.turn_outcome, "failed");
    assert.equal(span.attrs?.turn_subtype, "runtime_error");
    assert.equal(span.attrs?.turn_reason, "unclassified_runtime_error");
    assert.equal(span.attrs?.runtime_error_class, "ProviderModelNotFoundError");
    assert.equal(span.attrs?.runtime_error_http_status, 404);
    assert.equal(span.attrs?.runtime_error_message_present, true);
    assert.equal(span.attrs?.runtime_error_message_length_bucket, "<1k");
    assert.equal(typeof span.attrs?.runtime_error_fingerprint, "string");
    assert.equal(Object.hasOwn(span.attrs ?? {}, "errorMessage"), false);

    const runtimeError = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "runtime.error");
    assert.ok(runtimeError);
    assert.equal(runtimeError.attrs?.runtime_error_class, "ProviderModelNotFoundError");
    assert.equal(runtimeError.attrs?.runtime_error_http_status, 404);
    assert.equal(runtimeError.attrs?.runtime_events_count, 1);
    assert.equal(runtimeError.attrs?.runtime_tool_calls_count, 0);
    assert.equal(runtimeError.attrs?.runtime_tool_outputs_count, 0);
    assert.equal(String(runtimeError.attrs?.runtime_error_message_excerpt).includes("[REDACTED_PATH]"), true);
    assert.equal(String(runtimeError.attrs?.runtime_error_message_excerpt).includes("Bearer [REDACTED_TOKEN]"), true);
    assert.equal(String(runtimeError.attrs?.runtime_error_message_excerpt).includes("secret.txt"), false);
    assert.equal(Object.hasOwn(runtimeError.attrs ?? {}, "message"), false);

    const activity = [...sent].reverse().find((message) => message.type === "agent:activity" && projectFactActivity(message) === "error");
    assert.ok(activity && activity.type === "agent:activity");
    assert.deepEqual(activity.runtimeError, {
      errorClass: "RuntimeError",
      errorReason: "unclassified_runtime_error",
      fingerprint: span.attrs?.runtime_error_fingerprint,
      reasonProvenance: "runtime_error_event",
    });
    assert.equal(Object.hasOwn(activity.runtimeError ?? {}, "message"), false);
    assert.equal(Object.hasOwn(activity.runtimeError ?? {}, "path"), false);
    assert.doesNotMatch(JSON.stringify(activity.runtimeError), /alice|secret|Bearer/i);
  }, { tracer });
});

test("runtime error activity preserves explicit missing-native-reason provenance", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());
    driver.parsedLines.set("system-error-without-reason", [{
      kind: "error",
      message: "Codex thread entered system error state",
      nativeReasonPresent: false,
      reasonProvenance: "daemon_fallback",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("system-error-without-reason\n"));
    await flush();

    const activity = [...sent].reverse().find((message) => message.type === "agent:activity" && projectFactActivity(message) === "error");
    assert.ok(activity && activity.type === "agent:activity");
    assert.equal(activity.runtimeError?.nativeReasonPresent, false);
    assert.equal(activity.runtimeError?.reasonProvenance, "daemon_fallback");
    assert.equal(activity.runtimeError?.errorClass, "RuntimeError");
    assert.equal(activity.runtimeError?.errorReason, "unclassified_runtime_error");
    assert.match(activity.runtimeError?.fingerprint ?? "", /^[0-9a-f]{16}$/);
  });
});

test("spawn runtime trace records low-sensitive input size buckets", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    const wakeMessage = makeMessage("x".repeat(2048), {
      attachments: [{ id: "attachment-secret-id", filename: "customer-contract.png", mimeType: "image/png", sizeBytes: 64 * 1024 }],
      thread_join_context: {
        reason: "mentioned",
        parent_target: "#private:parent",
        thread_target: "#private:thread",
        suggested_read_history_target: "#private:thread",
        parent_message: {
          message_id: "parent-message-id",
          sender_name: "alice",
          sender_type: "human",
          content: "parent context ".repeat(100),
          timestamp: "2026-05-13T08:00:00.000Z",
        },
        recent_messages: [{
          message_id: "recent-message-id",
          sender_name: "bob",
          sender_type: "agent",
          content: "recent context ".repeat(80),
          timestamp: "2026-05-13T08:01:00.000Z",
        }],
        history_truncated: false,
      },
    });

    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), wakeMessage, { "#other": 3 });
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
    assert.ok(span);
    assert.equal(span.attrs?.runtime_input_source, "wake_thread_context");
    assert.equal(span.attrs?.runtime_input_session_present, true);
    assert.equal(span.attrs?.runtime_input_unread_channels_count, 1);
    assert.equal(span.attrs?.runtime_input_messages_count, 1);
    assert.equal(span.attrs?.runtime_input_messages_content_bytes_bucket, "1KB-10KB");
    assert.equal(span.attrs?.runtime_input_attachments_count, 1);
    assert.equal(span.attrs?.runtime_input_image_attachments_count, 1);
    assert.equal(span.attrs?.runtime_input_attachments_size_known_count, 1);
    assert.equal(span.attrs?.runtime_input_attachments_bytes_bucket, "10KB-100KB");
    assert.equal(span.attrs?.runtime_input_image_attachments_size_known_count, 1);
    assert.equal(span.attrs?.runtime_input_image_attachments_bytes_bucket, "10KB-100KB");
    assert.equal(span.attrs?.runtime_input_largest_attachment_bytes_bucket, "10KB-100KB");
    assert.equal(span.attrs?.runtime_input_thread_context_messages_count, 2);
    assert.equal(span.attrs?.runtime_input_thread_context_content_bytes_bucket, "1KB-10KB");
    assert.equal(typeof span.attrs?.runtime_input_prompt_bytes_bucket, "string");
    assert.equal(typeof span.attrs?.runtime_input_standing_prompt_bytes_bucket, "string");
    assert.equal(Object.hasOwn(span.attrs ?? {}, "content"), false);
    assert.equal(Object.hasOwn(span.attrs ?? {}, "filename"), false);
    assert.equal(Object.hasOwn(span.attrs ?? {}, "id"), false);

    const started = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "daemon.turn.started");
    assert.equal(started?.attrs?.runtime_input_messages_count, 1);
    assert.equal(started?.attrs?.runtime_input_messages_content_bytes_bucket, "1KB-10KB");

    await manager.stopAgent("agent-1");
  }, { tracer });
});

test("resume start injects concrete catch-up messages instead of only unread summary", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    const resumeMessage = makeMessage("manual-stopped durable request", {
      channel_id: "dm-channel-1",
      channel_name: "richard",
      channel_type: "dm",
      message_id: "message-1",
      seq: 42,
    });

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      { "DM:@richard": 1 },
      undefined,
      undefined,
      false,
      [resumeMessage],
    );
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.spawnCalls[0].prompt.includes("manual-stopped durable request"), true);
    assert.equal(driver.spawnCalls[0].prompt.includes("New message received:"), true);
    assert.equal(driver.spawnCalls[0].prompt.includes("Some unread channels may not be included"), true);

    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
    assert.ok(span);
    assert.equal(span.attrs?.runtime_input_source, "resume_catchup_inbox");
    assert.equal(span.attrs?.runtime_input_session_present, true);
    assert.equal(span.attrs?.runtime_input_unread_channels_count, 1);
    assert.equal(span.attrs?.runtime_input_messages_count, 1);

    const started = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "daemon.turn.started");
    assert.equal(started?.attrs?.runtime_input_source, "resume_catchup_inbox");
    assert.equal(started?.attrs?.runtime_input_messages_count, 1);

    await manager.stopAgent("agent-1");
  }, { tracer });
});

test("resume start preserves catch-up salience before buffered startup inbox", async () => {
  await withManager(async ({ driver, manager }) => {
    const freshPierce = makeMessage("fresh direct wake request", {
      channel_id: "dm-channel-1",
      channel_name: "ray",
      channel_type: "dm",
      message_id: "fresh-message-1",
      seq: 200,
    });
    const staleDebt = makeMessage("old unread debt", {
      channel_id: "channel-old",
      channel_name: "old-channel",
      channel_type: "channel",
      message_id: "old-message-1",
      seq: 10,
    });
    const bufferedStartup = makeMessage("buffered startup delivery", {
      channel_id: "channel-buffered",
      channel_name: "buffered",
      message_id: "buffered-message-1",
      seq: 201,
    });
    (manager as any).startingInboxes.bufferMessagesDuringStart("agent-1", [bufferedStartup]);

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      [freshPierce, staleDebt],
    );

    const prompt = driver.spawnCalls[0].prompt;
    assert.equal(prompt.includes("New messages received:"), true);
    assert.ok(prompt.indexOf("fresh direct wake request") < prompt.indexOf("old unread debt"));
    assert.ok(prompt.indexOf("old unread debt") < prompt.indexOf("buffered startup delivery"));
  });
});

test("cli transport live delivery attachment hint uses raft attachment view", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const accepted = await manager.deliverMessage("agent-1", makeMessage("please inspect the attachment", {
      attachments: [{ id: "attachment-1", filename: "trace.log", mimeType: "text/plain", sizeBytes: 2048 }],
    }), { transient: true });

    assert.equal(accepted, true);
    await flush();
    const prompt = driver.encodedCalls.at(-1)?.text || "";
    assert.match(prompt, /trace\.log \(id:attachment-1\).*`raft attachment view --id <attachmentId> --output <path>`/s);
    assert.doesNotMatch(prompt, /use view_file to download/);
  });
});

function deferRuntimeStop(manager: AgentProcessManager, agentId: string) {
  const runtime: RuntimeSession = (manager as any).agents.get(agentId).runtime;
  const originalStop = runtime.stop.bind(runtime);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(runtime, "stop").mockImplementationOnce(async (options) => {
    await ready;
    await originalStop(options);
  });
  return { release, spy };
}

for (const launchId of [undefined, "same-launch"]) {
  test(`late stop completion preserves a running replacement (launch=${launchId ?? "absent"})`, async () => {
    await withManager(async ({ manager, sent, driver }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "old-session" }), undefined, undefined, undefined, launchId);
      const oldStop = deferRuntimeStop(manager, "agent-1");
      const stopping = manager.stopAgent("agent-1");
      assert.equal(oldStop.spy.mock.calls.length, 1);
      assert.equal(manager.getRunningAgentIds().includes("agent-1"), false);
      try {
        await manager.startAgent("agent-1", makeConfig({ sessionId: "new-session" }), undefined, undefined, undefined, launchId);
        assert.equal(driver.processes.length, 2, "replacement must start before the old stop resolves");
        const before = sent.length;
        oldStop.release();
        await stopping;
        assert.deepEqual(
          sent.slice(before).filter((m) => m.type === "agent:status" || m.type === "agent:activity" || m.type === "agent:runtime_profile"),
          [],
          "old stop must not publish status, activity, or profile for the replacement",
        );
        assert.equal(manager.getAgentSessionId("agent-1"), "new-session");
        driver.parsedLines.set("replacement-idle", [{ kind: "turn_end", sessionId: "new-session" }]);
        driver.processes[1].stdout.emit("data", Buffer.from("replacement-idle\n"));
        await flush();
        assert.equal(await manager.deliverMessage("agent-1", makeMessage("still working"), { transient: true }), true);
        assert.ok(driver.processes[1].stdin.writes.some((s) => s.includes("still working")));
      } finally {
        oldStop.release();
        await stopping;
      }
    });
  });
}

test("late stop completion does not overwrite a queued replacement", async () => {
  await withManager(async ({ manager, sent, driver }) => {
    await manager.startAgent("agent-1", makeConfig());
    const oldStop = deferRuntimeStop(manager, "agent-1");
    const stopping = manager.stopAgent("agent-1");
    setAgentStartCapacityFull(manager);
    const starting = manager.startAgent("agent-1", makeConfig({ sessionId: "queued-session" }));
    try {
      assert.equal(agentStartSnapshot(manager).queueDepth, 1);
      const before = sent.length;
      oldStop.release();
      await stopping;
      assert.deepEqual(sent.slice(before).filter((m) => m.type === "agent:status" || m.type === "agent:activity" || m.type === "agent:runtime_profile"), []);
    } finally {
      oldStop.release();
      await stopping;
      (manager as any).releaseAgentStartSlot("slot-holder", "test: slot freed");
      await starting;
    }
    assert.equal(driver.processes.length, 2);
  });
});

test("late stop completion preserves a replacement's startup failure", async () => {
  await withManager(async ({ manager, sent, driver }) => {
    await manager.startAgent("agent-1", makeConfig());
    const oldStop = deferRuntimeStop(manager, "agent-1");
    const stopping = manager.stopAgent("agent-1");
    try {
      vi.spyOn(driver, "spawn").mockImplementationOnce(() => { throw new Error("replacement spawn failed"); });
      await assert.rejects(manager.startAgent("agent-1", makeConfig()), /replacement spawn failed/);
      assert.equal(manager.getRunningAgentIds().includes("agent-1"), false);
      const before = sent.length;
      oldStop.release();
      await stopping;
      assert.deepEqual(sent.slice(before).filter((m) => m.type === "agent:status" || m.type === "agent:activity" || m.type === "agent:runtime_profile"), [], "old stop must not replace the newer failure with Stopped");
    } finally {
      oldStop.release();
      await stopping;
    }
  });
});

test("late stop completion still reports an ordinary stop with no replacement", async () => {
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());
    const oldStop = deferRuntimeStop(manager, "agent-1");
    const stopping = manager.stopAgent("agent-1");
    const before = sent.length;
    oldStop.release();
    await stopping;
    const messages = sent.slice(before);
    assert.ok(messages.some((m) => m.type === "agent:status" && m.status === "inactive"));
    assert.ok(messages.some((m) => m.type === "agent:activity" && m.detailKind === "stopped"));
    assert.ok(messages.some((m) => m.type === "agent:runtime_profile"));
  });
});

test("stopAgent records explicit stop source on process exit trace", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig());

    await manager.stopAgent("agent-1");
    await flush();

    const span = sink.getAllSpans().find((candidate) => candidate.name === "daemon.agent.process.exited");
    assert.ok(span);
    assert.equal(span.attrs?.stop_source, "explicit_request");
    assert.equal(span.attrs?.stop_silent, false);
  }, { tracer });
});

test("process error and exit preserve the same dispatch and process identity", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-error",
      makeConfig({
        runtimeContext: {
          serverId: "server-error",
          machineId: "machine-error",
        },
      }),
      undefined,
      undefined,
      undefined,
      "launch-error",
      false,
      undefined,
      "dispatch-error",
    );

    driver.processes[0].fail(
      "private runtime failure",
      "Bearer sk-reviewer-secret https://provider.example/private",
    );
    driver.processes[0].exit(1);
    await flush();

    const processError = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.agent.process.error");
    const processExit = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.runtime.process.exit");
    assert.ok(processError);
    assert.ok(processExit);
    for (const span of [processError, processExit]) {
      assert.equal(span.attrs?.agent_id, "agent-error");
      assert.equal(span.attrs?.server_id, "server-error");
      assert.equal(span.attrs?.machine_id, "machine-error");
      assert.equal(span.attrs?.launch_id, "launch-error");
      assert.equal(span.attrs?.start_dispatch_id, "dispatch-error");
      assert.equal(typeof span.attrs?.process_instance_id, "string");
    }
    assert.equal(
      processError.attrs?.process_instance_id,
      processExit.attrs?.process_instance_id,
    );
    assert.equal(processError.attrs?.error_class, "Error");
    assert.doesNotMatch(JSON.stringify(processError.attrs), /sk-reviewer-secret|provider\.example/);
  }, { tracer });
});

test("stopAgent disposes all agent process timers", async () => {
  const realClearTimeout = globalThis.clearTimeout;
  const realClearInterval = globalThis.clearInterval;
  const clearedTimeouts = new Set<unknown>();
  const clearedIntervals = new Set<unknown>();

  (globalThis as any).clearTimeout = ((timer: unknown) => {
    clearedTimeouts.add(timer);
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    clearedIntervals.add(timer);
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  const pendingTrajectoryTimer = setTimeout(() => {}, 60_000);
  const startupTimeoutTimer = setTimeout(() => {}, 60_000);
  const compactionWatchdog = setTimeout(() => {}, 60_000);
  const stalledRecoverySigtermTimer = setTimeout(() => {}, 60_000);
  const backoffTimer = setTimeout(() => {}, 60_000);
  const activityHeartbeat = setInterval(() => {}, 60_000);

  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig());
      const ap = (manager as any).agents.get("agent-1");
      assert.ok(ap, "agent process should exist");

      if (ap.startup.kind === "waiting" && ap.startup.timer) realClearTimeout(ap.startup.timer);
      ap.pendingTrajectory = {
        kind: "text",
        text: "queued trajectory",
        timer: pendingTrajectoryTimer,
      };
      assert.equal(ap.startup.kind, "waiting");
      ap.startup = { ...ap.startup, timer: startupTimeoutTimer };
      ap.compaction = { kind: "active", startedAt: Date.now(), watchdog: compactionWatchdog };
      assert.equal(ap.exit.kind, "live");
      ap.exit = { ...ap.exit, stalledRecoverySigtermTimer };
      ap.runtimeErrorDeliveryBackoff = {
        kind: "backing_off",
        attempts: 1,
        untilMs: Date.now() + 60_000,
        timer: backoffTimer,
        reason: "test",
      };
      ap.activityHeartbeat = { kind: "active", timer: activityHeartbeat };

      await manager.stopAgent("agent-1", { silent: true });

      for (const timer of [
        pendingTrajectoryTimer,
        startupTimeoutTimer,
        compactionWatchdog,
        stalledRecoverySigtermTimer,
        backoffTimer,
      ]) {
        assert.equal(clearedTimeouts.has(timer), true, "expected stopAgent to clear timeout handle");
      }
      assert.equal(clearedIntervals.has(activityHeartbeat), true, "expected stopAgent to clear heartbeat interval");
      assert.equal(ap.pendingTrajectory, null);
      assert.equal(ap.startup.kind, "waiting");
      assert.equal(ap.startup.timer, null);
      assert.deepEqual(ap.compaction, { kind: "none" });
      assert.equal(ap.exit.kind, "live");
      assert.equal(ap.exit.stalledRecoverySigtermTimer, null);
      assert.deepEqual(ap.runtimeErrorDeliveryBackoff, {
        kind: "idle",
        attempts: 0,
        untilMs: 0,
        timer: null,
        reason: null,
      });
      assert.deepEqual(ap.activityHeartbeat, { kind: "inactive" });
    });
  } finally {
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
    realClearTimeout(pendingTrajectoryTimer);
    realClearTimeout(startupTimeoutTimer);
    realClearTimeout(compactionWatchdog);
    realClearTimeout(stalledRecoverySigtermTimer);
    realClearTimeout(backoffTimer);
    realClearInterval(activityHeartbeat);
  }
});

test("CLI slock bash calls are normalized back to canonical activity semantics", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());

    driver.parsedLines.set("tool-call", [{
      kind: "tool_call",
      name: "Bash",
      input: { command: "slock message send --target '#general' --content 'hello'" },
    }]);

    driver.processes[0].stdout.emit("data", Buffer.from("tool-call\n"));
    await flush();

    const workingEvent = findLastActivity(sent, "working");
    assert.ok(workingEvent && workingEvent.type === "agent:activity");
    assert.equal(workingEvent.detail, "Sending message…");
    assert.deepEqual(workingEvent.entries, [{
      kind: "tool_start",
      toolName: "send_message",
      toolInput: "#general",
    }]);
  });
});

test("compaction start emits finish markers when the runtime resumes without an explicit finish event", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.parsedLines.set("tool-after-compact", [{ kind: "tool_call", name: "shell", input: { command: "echo ok" } }]);

    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();
    driver.processes[0].stdout.emit("data", Buffer.from("tool-after-compact\n"));
    await flush();

    const activities = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .filter((msg) => msg.detail !== "Starting…");
    assert.deepEqual(activities.map((msg) => msg.detail), [
      "Compacting context",
      "Context compaction finished (inferred from resumed tool use)",
      "Running command…",
    ]);
    assert.deepEqual(activities[0].entries?.[0], { kind: "compaction_started" });
    assert.deepEqual(activities[1].entries?.[0], { kind: "compaction_finished" });

    const ap = (manager as any).agents.get("agent-1");
    assert.deepEqual(ap.compaction, { kind: "none" });
  });
});

test("stale compaction watchdog surfaces a missing finish event", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timerCallback: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      timerCallback = callback;
      return { fake: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
      await flush();

      assert.ok(timerCallback, "compaction start should install a watchdog");
      timerCallback!();
      await flush();

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Compacting context",
        "Context compaction still running; no finish event observed",
      ]);

      const ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.compaction.kind, "active");
      assert.equal(ap.compaction.watchdog, null);
      assert.ok(ap.compaction.startedAt, "watchdog warning should not clear the active compaction marker");
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("stale review watchdog surfaces missing review_finished and restores delivery", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timerCallback: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      timerCallback = callback;
      return { fake: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("review-start", [{ kind: "review_started" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("review-start\n"));
      await flush();

      assert.ok(timerCallback, "review start should install a watchdog");

      // Queue a message during review — should be suppressed
      manager.deliverMessage("agent-1", makeMessage("msg during review"));
      (manager as any).sendStdinNotification("agent-1");
      await flush();

      const apDuringReview = (manager as any).agents.get("agent-1");
      assert.equal(apDuringReview.gatedSteering.reviewing, true);
      assert.equal(apDuringReview.inbox.length, 1);

      // Fire the watchdog — should complete review and restore delivery
      timerCallback!();
      await flush();

      const apAfterStale = (manager as any).agents.get("agent-1");
      assert.equal(apAfterStale.gatedSteering.reviewing, false);
      assert.equal(apAfterStale.review.kind, "active");
      assert.equal(apAfterStale.review.watchdog, null);

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Reviewing changes",
        "Review mode still active; no finish event observed",
      ]);

      // Delivery should be restored after watchdog
      assert.equal(apAfterStale.notifications.pendingCount, 0);
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("activity heartbeat marks silent runtime progress as stalled", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  let now = 1_000_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "sleep 999" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      const ap = (manager as any).agents.get("agent-1");
      const diagnosticInputs: unknown[] = [];
      ap.runtime.emitToolDiagnosticSnapshots = (input: unknown) => {
        diagnosticInputs.push(input);
        return [{
          classification: "running_no_observed_progress",
          toolExecutionInstanceId: "tool-execution-1",
          processInstanceId: "process-1",
          toolPending: true,
          toolAgeMs: 20 * 60_000,
          processLiveness: "alive",
          progressState: "never_observed",
          negativeEvidenceBucket: "none",
        }];
      };
      now += 16 * 60_000;
      intervalCallback!();
      await flush();

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Running command…",
        "Bash tool has been running for 20m; process is alive; no output/update observed for 20m.",
      ]);
      assert.equal(projectFactActivity(activities[1]), "error");

      assert.ok(ap.runtimeProgress.isStale, "stalled marker should be latched");
      assert.deepEqual(diagnosticInputs, [{
        trigger: "runtime_inactivity_tripwire",
        runtimeInactivityAgeMs: 16 * 60_000,
        observationIntervalMs: 15 * 60_000,
      }]);
    });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("activity heartbeat keeps alive silent runtime out of stalled error", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const realProcessKill = process.kill;
  const runtimePid = 42_452;
  let now = 1_500_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (process as any).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === runtimePid && signal === 0) return true;
    return realProcessKill(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());
      (driver.processes[0] as any).pid = runtimePid;

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "sleep 1200" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 20 * 60_000;
      intervalCallback!();
      await flush();

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Running command…",
        "Running command…",
      ]);
      assert.equal(
        activities.some((msg) => projectFactActivity(msg) === "error" && msg.detail.startsWith("Runtime stalled:")),
        false,
      );

      const ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.runtimeProgress.isStale, false, "alive runtime should not be latched stale");
    });
  } finally {
    (Date as any).now = realDateNow;
    (process as any).kill = realProcessKill;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("activity heartbeat marks dead silent runtime process as stalled", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const realProcessKill = process.kill;
  const runtimePid = 42_453;
  let now = 1_700_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (process as any).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === runtimePid && signal === 0) {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return realProcessKill(pid, signal as NodeJS.Signals | number | undefined);
  }) as typeof process.kill;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());
      (driver.processes[0] as any).pid = runtimePid;

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "sleep 1200" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 20 * 60_000;
      intervalCallback!();
      await flush();

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Running command…",
        "Runtime stalled: no runtime events for 20m (after Running command…, tools=1)",
      ]);
      assert.equal(projectFactActivity(activities[1]), "error");

      const ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.runtimeProgress.isStale, true, "dead runtime should still be latched stale");
    });
  } finally {
    (Date as any).now = realDateNow;
    (process as any).kill = realProcessKill;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("activity heartbeat treats codex raw response items as internal progress", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let now = 2_000_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      const sessionId = "019e05d7-false-stall-session";
      await manager.startAgent("agent-1", makeConfig({ sessionId }));

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "pnpm test" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 15 * 60_000;
      driver.parsedLines.set("raw-progress", [{
        kind: "internal_progress",
        source: "codex_raw_response_item",
        itemType: "function_call_output",
        payloadBytes: 128,
      }]);
      driver.processes[0].stdout.emit("data", Buffer.from("raw-progress\n"));
      await flush();
      now += 60_000;
      intervalCallback!();
      await flush();

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Running command…",
        "Running command…",
      ]);
      assert.equal(
        activities.some((msg) => projectFactActivity(msg) === "error" && msg.detail.startsWith("Runtime stalled:")),
        false,
      );

      const ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.runtimeProgress.staleSince, null);
      assert.equal(ap.runtimeProgress.lastEventKind, "tool_call");
      assert.ok(ap.runtimeProgress.lastEventAt >= now - 60_000 - 10);

      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId }]);
      driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
      await flush();

      const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
      assert.ok(events.includes("runtime.progress.internal_observed"));
      assert.equal(events.includes("runtime.progress.stalled"), false);
      const observed = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.progress.internal_observed");
      assert.equal(observed?.attrs?.turn_outcome, "held");
      assert.equal(observed?.attrs?.turn_subtype, "runtime_progress");
      assert.equal(observed?.attrs?.turn_reason, "internal_activity_observed");
      assert.equal(observed?.attrs?.signal, "codex_raw_response_item");
      assert.equal(observed?.attrs?.source, "runtime_event");
      assert.equal(observed?.attrs?.runtime, "codex");
      assert.equal(observed?.attrs?.itemType, "function_call_output");
      assert.equal(observed?.attrs?.payloadBytes, 128);
    }, { tracer });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("codex status-only system errors surface as runtime error activity", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "thread-1" }));

    driver.parsedLines.set("thread-status-system-error", [{
      kind: "error",
      message: "turn is not steerable",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thread-status-system-error\n"));
    await flush();

    const errorActivity = findLastActivity(sent, "error");
    assert.ok(errorActivity);
    assert.equal(errorActivity.detail, "turn is not steerable");
    assert.deepEqual(errorActivity.entries, [{
      kind: "text",
      text: "Error: turn is not steerable",
    }, {
      kind: "status",
      detail: "turn is not steerable",
      detailKind: "runtime_error",
    }]);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.lastRuntimeError, "turn is not steerable");
    assert.equal(ap.runtimeProgress.lastEventKind, "error");
  });
});

test("codex status-only system errors without a reason emit scrub-safe diagnostics", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "thread-1" }));

    driver.parsedLines.set("thread-status-system-error-without-reason", [{
      kind: "runtime_diagnostic",
      severity: "warning",
      source: "codex_app_server_notification",
      itemType: "codex_thread_system_error_without_reason",
      message: "Codex thread entered system error state without a reason",
      payloadBytes: 64,
      reasonPresent: false,
      sessionId: "thread-1",
    }, {
      kind: "error",
      message: "Codex thread entered system error state",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thread-status-system-error-without-reason\n"));
    await flush();

    const errorActivity = findLastActivity(sent, "error");
    assert.equal(errorActivity?.detail, "Codex thread entered system error state");
    const diagnostic = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "runtime.event.received"
        && event.attrs?.itemType === "codex_thread_system_error_without_reason");
    assert.ok(diagnostic);
    assert.equal(diagnostic.attrs?.reason_present, false);
    assert.equal(diagnostic.attrs?.payloadBytes, 64);
    assert.equal(diagnostic.attrs?.details_present, false);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.lastRuntimeError, "Codex thread entered system error state");
  }, { tracer });
});

test("codex no-op completion error remains visible after turn_end", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "thread-1" }));

    const message =
      "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)";
    driver.parsedLines.set("noop-complete", [
      {
        kind: "runtime_diagnostic",
        severity: "warning",
        source: "codex_app_server_notification",
        itemType: "codex_zero_evidence_turn_completed",
        message: "Codex runtime completed an empty turn with no output, progress, or token usage",
        inputEvidence: "nonempty",
      },
      { kind: "error", message },
      { kind: "turn_end", sessionId: "thread-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("noop-complete\n"));
    await flush();

    const activities = sent.filter((msg) => msg.type === "agent:activity");
    const lastActivity = activities.at(-1);
    assert.equal(lastActivity ? projectFactActivity(lastActivity) : undefined, "error");
    assert.equal(lastActivity?.detail, message);
    assert.equal(lastActivity?.detailKind, "runtime_error");

    const inactiveStatus = sent.find((msg) => msg.type === "agent:status" && msg.status === "inactive");
    assert.ok(inactiveStatus, "no-op completion is a sticky runtime failure, not a clean idle turn");
  }, { tracer });

  const diagnosticTrace = eventsForSpan(sink, traceId, "daemon.runtime.turn")
    .find((event) =>
      event.name === "runtime.event.received" &&
      event.attrs?.itemType === "codex_zero_evidence_turn_completed"
    );
  assert.ok(diagnosticTrace, "zero-evidence completion diagnostic must be trace-visible");
  assert.equal(diagnosticTrace.attrs?.source, "codex_app_server_notification");
  assert.equal(diagnosticTrace.attrs?.details_present, false);
  assert.equal(diagnosticTrace.attrs?.input_evidence, "nonempty");
});

test("codex runtime diagnostics are visible without satisfying initial-turn readiness", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "thread-1" }));

    driver.parsedLines.set("diagnostic", [{
      kind: "runtime_diagnostic",
      severity: "warning",
      source: "codex_app_server_notification",
      itemType: "configWarning",
      message: "Ignored option",
      details: "Old option is deprecated",
      path: "/tmp/codex/config.toml",
      payloadBytes: 128,
      sessionId: "thread-1",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("diagnostic\n"));
    await flush();

    const activities = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity");
    const diagnosticActivity = activities.at(-1);
    assert.ok(diagnosticActivity);
    assert.equal(projectFactActivity(diagnosticActivity), "working");
    assert.equal(diagnosticActivity.detail, "Starting…");
    assert.deepEqual(diagnosticActivity.entries, [{
      kind: "system",
      title: "Codex config warning",
      text: "Ignored option\nOld option is deprecated\nPath: /tmp/codex/config.toml",
    }]);
    assert.equal(activities.some((msg) => projectFactActivity(msg) === "error"), false);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.startup.kind, "waiting");
    assert.equal(ap.runtimeProgress.lastEventKind, "runtime_diagnostic");
    assert.equal(ap.runtimeProgress.staleSince, null);
  }, { driver });
});

test("runtime tracing pinpoints tool output followed by silent stall", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let now = 3_000_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "slockdev status" } }]);
      driver.parsedLines.set("tool-output", [{ kind: "tool_output", name: "shell" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      driver.processes[0].stdout.emit("data", Buffer.from("tool-output\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 16 * 60_000;
      intervalCallback!();
      await flush();

      const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
      assert.deepEqual(events, [
        "daemon.turn.started",
        "runtime.event.received",
        "tool.call.started",
        "runtime.event.received",
        "tool.output.observed",
        "runtime.continuation.expected",
        "runtime.progress.stalled",
      ]);
      const stalled = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.progress.stalled");
      assert.equal(stalled?.attrs?.turn_outcome, "failed");
      assert.equal(stalled?.attrs?.turn_subtype, "runtime_stalled");
      assert.equal(stalled?.attrs?.turn_reason, "harness_post_tool_silent_wedge");
      assert.equal(stalled?.attrs?.lastActivityDetail, undefined);
      assert.equal(stalled?.attrs?.lastActivityDetailPresent, true);
      assert.equal(stalled?.attrs?.lastActivityDetailKind, "tool_end");
      assert.equal(stalled?.attrs?.outstandingToolUses, 0);
      assert.equal(stalled?.attrs?.inboxCount, 0);
      assert.equal(stalled?.attrs?.runtime, "codex");
      assert.equal(stalled?.attrs?.runtime_tool_calls_count, 1);
      assert.equal(stalled?.attrs?.runtime_tool_outputs_count, 1);
      const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
      assert.equal(span?.attrs?.turn_outcome, "failed");
      assert.equal(span?.attrs?.turn_subtype, "runtime_stalled");
      assert.equal(span?.status, "error");
      assert.equal(span?.attrs?.turn_reason, "harness_post_tool_silent_wedge");
      assert.equal(span?.attrs?.lastActivityDetail, undefined);
      assert.equal(span?.attrs?.lastActivityDetailKind, "tool_end");
      assert.equal(span?.attrs?.runtime_tool_calls_count, 1);
      assert.equal(span?.attrs?.runtime_tool_outputs_count, 1);
    }, { tracer });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("claude transcript queue-op appends do not suppress post-tool silent stall detection", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let now = 3_500_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
      busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ manager, dataDir }) => {
      const sessionId = "76c021e1-fcb2-419e-b5e5-92ea8090f4ef";
      const transcriptPath = path.join(
        dataDir,
        ".claude",
        "projects",
        "-Users-redacted-slock-agents-agent",
        `${sessionId}.jsonl`,
      );
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, await readTranscriptFixture("claude-tool-boundary-queue-op-redacted.jsonl"));

      await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId }));

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "Read", input: { file_path: "/tmp/pr2086.diff" } }]);
      driver.parsedLines.set("tool-output", [{ kind: "tool_output", name: "Read" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      driver.processes[0].stdout.emit("data", Buffer.from("tool-output\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 16 * 60_000;
      const transcriptMtime = new Date(now - 60_000);
      await writeFile(transcriptPath, "{\"type\":\"queue-operation\",\"redacted\":true,\"note\":\"daemon delivered inbox marker\"}\n", { flag: "a" });
      await utimes(transcriptPath, transcriptMtime, transcriptMtime);
      intervalCallback!();
      await flush();

      const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
      assert.equal(events.includes("runtime.progress.internal_observed"), false);
      assert.ok(events.includes("runtime.progress.stalled"));
      const stalled = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.progress.stalled");
      assert.equal(stalled?.attrs?.turn_outcome, "failed");
      assert.equal(stalled?.attrs?.turn_subtype, "runtime_stalled");
      assert.equal(stalled?.attrs?.turn_reason, "harness_post_tool_silent_wedge");
      assert.equal(stalled?.attrs?.runtime, "claude");
      assert.equal(stalled?.attrs?.runtime_tool_calls_count, 1);
      assert.equal(stalled?.attrs?.runtime_tool_outputs_count, 1);
    }, { driver, tracer });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("stalled recovery trace redacts non-allowlisted activity detail", async () => {
  const realDateNow = Date.now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let now = 7_000_000;
  (Date as any).now = () => now;
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "codex",
        sessionId: "session-1",
      }));

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.lastActivityKind = "error";
      ap.runtimeProgress.markStale(now - 60_000);
      ap.lastActivity = "error";
      ap.lastActivityDetail = "Provider failed with raw request id secret-abc123";
      ap.lastActivityDetailKind = "other";

      manager.deliverMessage("agent-1", makeMessage("follow-up after raw error"));
      await flush();
      await flush();

      const stalled = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.progress.stalled");
      assert.equal(stalled?.attrs?.lastActivityDetail, undefined);
      assert.equal(stalled?.attrs?.lastActivityDetailPresent, true);
      assert.equal(stalled?.attrs?.lastActivityDetailKind, "other");
      assert.equal(stalled?.attrs?.recovery, "terminate_for_queued_message");

      const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
      assert.equal(span?.attrs?.lastActivityDetail, undefined);
      assert.equal(span?.attrs?.lastActivityDetailKind, "other");
    }, { driver, tracer });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("decision error window makes pre-progress errors invisible without relying on a manual clear", () => {
  const window = new DecisionErrorWindow();

  window.recordStderr("ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session");
  window.recordRuntimeError("Runtime request failed before progress");
  assert.deepEqual(window.currentErrorCandidates(), [
    "Runtime request failed before progress",
    "ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session",
  ]);

  // Proof-of-catch for the old discipline bug: progress advances the window
  // epoch. Even if an implementation accidentally stopped clearing old arrays,
  // classifiers read only current-epoch entries and cannot observe stale errors.
  window.noteRuntimeProgress();
  assert.deepEqual(window.currentErrorCandidates(), []);

  window.recordStderr("fresh write_stdin failed after progress");
  assert.deepEqual(window.currentErrorCandidates(), ["fresh write_stdin failed after progress"]);
});

test("runtime progress variants clear recovered stdin errors before stalled recovery", async () => {
  const realDateNow = Date.now;
  let now = 0;
  (Date as any).now = () => now;

  try {
    const progressEvents: ParsedEvent[] = [
      { kind: "text", text: "still working on the tool" },
      {
        kind: "internal_progress",
        source: "codex_raw_response_item",
        itemType: "function_call_output",
        payloadBytes: 256,
      },
    ];
    for (const [index, progressEvent] of progressEvents.entries()) {
      now = 9_000_000 + index * 2_000_000;
      const { sink, tracer, traceId } = makeDeterministicTracer();
      const driver = new FakeCodexDriver({
        id: "codex",
        supportsStdinNotification: true,
        busyDeliveryMode: "direct",
      });
      await withManager(async ({ manager }) => {
        await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));
        driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "long-running" } }]);
        driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
        await flush();

        const ap = (manager as any).agents.get("agent-1");
        assert.equal(ap.gatedSteering.outstandingToolUses, 1);
        driver.processes[0].stderr.emit(
          "data",
          Buffer.from("ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session\n"),
        );
        await flush();
        assert.ok(ap.decisionErrorWindow.currentErrorCandidates().some((line: string) => line.includes("write_stdin failed")));

        driver.parsedLines.set("recovered", [progressEvent]);
        driver.processes[0].stdout.emit("data", Buffer.from("recovered\n"));
        await flush();
        now += 16 * 60_000;
        ap.runtimeProgress.markStale(now - 60_000);
        manager.deliverMessage("agent-1", makeMessage("queued during long tool-wait"));
        await flush();
        await flush();

        const stalledTurns = sink.getTrace(traceId).filter(
          (span) => span.name === "daemon.runtime.turn" && span.attrs?.turn_subtype === "runtime_stalled",
        );
        assert.equal(stalledTurns.length, 0, `${progressEvent.kind} must clear stale stdin recovery evidence`);
      }, { driver, tracer });
    }
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("runtime tracing does not treat activity heartbeat as runtime progress", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let now = 4_000_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "sleep 999" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 60_000;
      intervalCallback!();
      await flush();

      now += 15 * 60_000;
      intervalCallback!();
      await flush();

      const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
      assert.ok(events.includes("activity.heartbeat.sent"));
      assert.ok(events.includes("runtime.progress.stalled"));
      assert.equal(events.filter((name) => name === "runtime.event.received").length, 1);
    }, { tracer });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("runtime telemetry records sidecar metrics without refreshing turn progress", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");

    ap.runtimeProgress.noteRuntimeEvent("tool_output", 123);
    ap.runtimeProgress.markStale(456);

    driver.parsedLines.set("telemetry", [{
      kind: "telemetry",
      name: "token_usage",
      attrs: {
        totalTokens: 1000,
        inputTokens: 800,
        cachedInputTokens: 200,
        outputTokens: 150,
        modelContextWindow: 2000,
        contextUtilization: 0.5,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("telemetry\n"));
    await flush();

    assert.equal(ap.runtimeProgress.lastEventAt, 123);
    assert.equal(ap.runtimeProgress.lastEventKind, "tool_output");
    assert.equal(ap.runtimeProgress.staleSince, 456);

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const runtimeEvents = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
    assert.deepEqual(runtimeEvents, [
      "daemon.turn.started",
      "runtime.telemetry.token_usage",
      "runtime.event.received",
      "runtime.progress.observed",
      "runtime.turn.completed",
    ]);

    const telemetrySpan = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.ok(telemetrySpan, "telemetry sidecar span should be recorded");
    assert.equal(telemetrySpan.attrs?.contextUtilization, 0.5);
    assert.equal(telemetrySpan.attrs?.cachedInputTokens, 200);
  }, { tracer });
});

test("Codex tooling exposure traces resume facts without claiming an unreported native inventory", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");

    ap.runtimeProgress.noteRuntimeEvent("tool_output", 123);
    ap.runtimeProgress.markStale(456);
    driver.parsedLines.set("tooling", [{
      kind: "runtime_tooling",
      source: "codex_app_server",
      sessionRequestMethod: "thread/resume",
      nativeToolInventoryObservation: "unreported_by_app_server",
      cliTransportConfigured: true,
      managedMcpConfigured: true,
      managedMcpStatus: "ready",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tooling\n"));
    await flush();

    assert.equal(ap.runtimeProgress.lastEventAt, 123);
    assert.equal(ap.runtimeProgress.lastEventKind, "tool_output");
    assert.equal(ap.runtimeProgress.staleSince, 456);

    driver.parsedLines.set("tooling-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tooling-turn-end\n"));
    await flush();

    const sidecar = sink.getTrace(traceId)
      .find((candidate) => candidate.name === "daemon.runtime.tooling.exposure");
    assert.ok(sidecar);
    assert.equal(sidecar.attrs?.session_request_method, "thread/resume");
    assert.equal(sidecar.attrs?.native_tool_inventory_observation, "unreported_by_app_server");
    assert.equal(sidecar.attrs?.cli_transport_configured, true);
    assert.equal(sidecar.attrs?.managed_mcp_configured, true);
    assert.equal(sidecar.attrs?.managed_mcp_status, "ready");
    assert.doesNotMatch(JSON.stringify(sidecar.attrs), /command|args|cwd|prompt|output|credential/i);

    const turnEvent = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .find((event) => event.name === "runtime.tooling.exposure");
    assert.ok(turnEvent);
    assert.equal(turnEvent.attrs?.session_request_method, "thread/resume");
  }, { tracer });
});

test("Codex final with zero tools and zero Raft sends emits a payload-free communication-gap fact", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("silent-final", [
      { kind: "text", text: "Raft CLI unavailable" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("silent-final\n"));
    await flush();

    const gapSpans = sink.getAllSpans()
      .filter((span) => span.name === "daemon.runtime.turn.communication_gap");
    assert.equal(gapSpans.length, 1);
    assert.equal(gapSpans[0].attrs?.classification, "final_without_tool_or_raft_send");
    assert.equal(gapSpans[0].attrs?.zero_tool_zero_send, true);
    assert.equal(gapSpans[0].attrs?.runtime_tool_calls_count, 0);
    assert.equal(gapSpans[0].attrs?.runtime_raft_message_send_attempts_count, 0);
    assert.equal(gapSpans[0].attrs?.runtime_text_events_count, 1);
    assert.doesNotMatch(JSON.stringify(gapSpans[0].attrs), /Raft CLI unavailable|command|args|prompt|output/i);

    const firstTurn = sink.getAllSpans()
      .find((span) => span.name === "daemon.runtime.turn");
    assert.ok(firstTurn);
    assert.equal(firstTurn.attrs?.runtime_raft_message_send_attempts_count, 0);
    assert.ok(firstTurn.events.some((event) => event.name === "runtime.turn.communication_gap"));

    driver.parsedLines.set("sent-final", [
      {
        kind: "tool_call",
        name: "shell",
        input: { command: "raft message send --target '#general'" },
      },
      { kind: "tool_output", name: "shell" },
      { kind: "text", text: "Sent through Raft" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("sent-final\n"));
    await flush();

    assert.equal(
      sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn.communication_gap").length,
      1,
      "a turn with a normalized Raft send attempt must not emit the zero-tool/zero-send fact",
    );
    const turnSpans = sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn");
    assert.equal(turnSpans.length, 2);
    assert.equal(turnSpans[1].attrs?.runtime_tool_calls_count, 1);
    assert.equal(turnSpans[1].attrs?.runtime_raft_message_send_attempts_count, 1);

    driver.parsedLines.set("worked-final", [
      { kind: "tool_call", name: "shell", input: { command: "git status --short" } },
      { kind: "tool_output", name: "shell" },
      { kind: "text", text: "Work completed without a message send" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("worked-final\n"));
    await flush();

    assert.equal(
      sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn.communication_gap").length,
      1,
      "a turn with non-send tool work must not emit the zero-tool/zero-send fact",
    );
    const workedTurn = sink.getAllSpans()
      .filter((span) => span.name === "daemon.runtime.turn")[2];
    assert.ok(workedTurn);
    assert.equal(workedTurn.attrs?.runtime_tool_calls_count, 1);
    assert.equal(workedTurn.attrs?.runtime_raft_message_send_attempts_count, 0);
  }, { tracer });
});

test("runtime telemetry records Codex missing-rollout recovery signal", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });

  await withManager(async ({ sent, driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "missing-thread-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");

    ap.runtimeProgress.noteRuntimeEvent("tool_output", 123);
    ap.runtimeProgress.markStale(456);

    driver.parsedLines.set("recovery", [{
      kind: "telemetry",
      name: "recovery",
      source: "codex_resume_missing_rollout",
      attrs: {
        resume_error_class: "missing_rollout",
        recovery_action: "fallback_fresh_thread",
      },
    }, {
      kind: "runtime_recovery",
      source: "codex_resume_missing_rollout",
      resumeErrorClass: "missing_rollout",
      recoveryAction: "fallback_fresh_thread",
      message: "Codex could not resume its previous thread; Slock started a fresh Codex thread.",
      details: "Use Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
      requestedSessionId: "missing-thread-1",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("recovery\n"));
    await flush();

    assert.equal(ap.runtimeProgress.lastEventAt, 123);
    assert.equal(ap.runtimeProgress.lastEventKind, "tool_output");
    assert.equal(ap.runtimeProgress.staleSince, 456);
    assert.equal(ap.startup.kind, "waiting");

    const recoveryActivity = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .at(-1);
    assert.ok(recoveryActivity);
    assert.equal(projectFactActivity(recoveryActivity), "working");
    assert.equal(recoveryActivity.detail, "Starting…");
    assert.deepEqual(recoveryActivity.entries, [{
      kind: "system",
      title: "Codex resume recovery",
      text: "Codex could not resume its previous thread; Slock started a fresh Codex thread.\nUse Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
    }]);

    const recoverySpan = sink.getTrace(traceId)
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.recovery");
    assert.ok(recoverySpan, "recovery sidecar span should be recorded");
    assert.equal(recoverySpan.attrs?.runtime, "codex");
    assert.equal(recoverySpan.attrs?.telemetry_name, "recovery");
    assert.equal(recoverySpan.attrs?.resume_error_class, "missing_rollout");
    assert.equal(recoverySpan.attrs?.recovery_action, "fallback_fresh_thread");
    assert.equal(recoverySpan.attrs?.source, "codex_resume_missing_rollout");

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "fresh-thread-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const turnEvents = eventsForSpan(sink, traceId, "daemon.runtime.turn");
    const runtimeEvents = turnEvents.filter((event) => event.name === "runtime.telemetry.recovery");
    assert.equal(runtimeEvents.length, 1);
    assert.equal(runtimeEvents[0].attrs?.resume_error_class, "missing_rollout");
    assert.equal(runtimeEvents[0].attrs?.recovery_action, "fallback_fresh_thread");
    assert.equal(runtimeEvents[0].attrs?.source, "codex_resume_missing_rollout");
    assert.equal(
      turnEvents.filter((event) => event.name === "runtime.progress.observed").length,
      1,
      "runtime_recovery should not add a progress-observed trace before the real turn_end progress event",
    );
  }, { driver, tracer });
});

test("runtime telemetry records Codex active-writer recovery signal", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });

  await withManager(async ({ sent, driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "busy-thread-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap, "agent process should exist");

    ap.runtimeProgress.noteRuntimeEvent("tool_output", 123);
    ap.runtimeProgress.markStale(456);

    driver.parsedLines.set("recovery", [{
      kind: "telemetry",
      name: "recovery",
      source: "codex_resume_thread_writer_busy",
      attrs: {
        resume_error_class: "thread_writer_busy",
        recovery_action: "fallback_fresh_thread",
      },
    }, {
      kind: "runtime_recovery",
      source: "codex_resume_thread_writer_busy",
      resumeErrorClass: "thread_writer_busy",
      recoveryAction: "fallback_fresh_thread",
      message: "Codex could not resume its previous thread because another writer is active; Slock started a fresh Codex thread.",
      details: "Use Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
      requestedSessionId: "busy-thread-1",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("recovery\n"));
    await flush();

    assert.equal(ap.runtimeProgress.lastEventAt, 123);
    assert.equal(ap.runtimeProgress.lastEventKind, "tool_output");
    assert.equal(ap.runtimeProgress.staleSince, 456);
    assert.equal(ap.startup.kind, "waiting");

    const recoveryActivity = sent
      .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
      .at(-1);
    assert.ok(recoveryActivity);
    assert.equal(projectFactActivity(recoveryActivity), "working");
    assert.equal(recoveryActivity.detail, "Starting…");
    assert.deepEqual(recoveryActivity.entries, [{
      kind: "system",
      title: "Codex resume recovery",
      text: "Codex could not resume its previous thread because another writer is active; Slock started a fresh Codex thread.\nUse Slock conversation history and local MEMORY.md/notes as the recovery point; do not assume prior Codex thread context is loaded.",
    }]);

    const recoverySpan = sink.getTrace(traceId)
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.recovery");
    assert.ok(recoverySpan, "recovery sidecar span should be recorded");
    assert.equal(recoverySpan.attrs?.runtime, "codex");
    assert.equal(recoverySpan.attrs?.telemetry_name, "recovery");
    assert.equal(recoverySpan.attrs?.resume_error_class, "thread_writer_busy");
    assert.equal(recoverySpan.attrs?.recovery_action, "fallback_fresh_thread");
    assert.equal(recoverySpan.attrs?.source, "codex_resume_thread_writer_busy");

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "fresh-thread-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const turnEvents = eventsForSpan(sink, traceId, "daemon.runtime.turn");
    const runtimeEvents = turnEvents.filter((event) => event.name === "runtime.telemetry.recovery");
    assert.equal(runtimeEvents.length, 1);
    assert.equal(runtimeEvents[0].attrs?.resume_error_class, "thread_writer_busy");
    assert.equal(runtimeEvents[0].attrs?.recovery_action, "fallback_fresh_thread");
    assert.equal(runtimeEvents[0].attrs?.source, "codex_resume_thread_writer_busy");
    assert.equal(
      turnEvents.filter((event) => event.name === "runtime.progress.observed").length,
      1,
      "runtime_recovery should not add a progress-observed trace before the real turn_end progress event",
    );
  }, { driver, tracer });
});

test("runtime telemetry records current session and turn identity for rate readout", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const scopedTracer = createScopedTracer(tracer, {
    daemonVersion: "0.55.6",
    daemon_version: "0.55.6",
    computerVersion: "0.0.23",
    computer_version: "0.0.23",
  });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "launch-session" }));

    driver.parsedLines.set("session-a-telemetry", [{
      kind: "telemetry",
      name: "token_usage",
      source: "codex_thread_token_usage_updated",
      usageKind: "cumulative_session",
      sessionId: "session-a",
      turnId: "turn-a",
      attrs: {
        daemonVersion: "payload-daemon",
        daemon_version: "payload-daemon",
        computerVersion: "payload-computer",
        computer_version: "payload-computer",
        sessionId: "payload-session",
        source: "payload-source",
        usageKind: "per_turn",
        totalTokens: 1000,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-a-telemetry\n"));
    await flush();

    driver.parsedLines.set("session-b-telemetry", [{
      kind: "telemetry",
      name: "token_usage",
      source: "codex_thread_token_usage_updated",
      usageKind: "cumulative_session",
      sessionId: "session-b",
      turnId: "turn-b",
      attrs: {
        totalTokens: 2000,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-b-telemetry\n"));
    await flush();

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-b" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const runtimeTelemetryEvents = eventsForSpan(sink, traceId, "daemon.runtime.turn")
      .filter((event) => event.name === "runtime.telemetry.token_usage");
    assert.equal(runtimeTelemetryEvents.length, 2);
    for (const event of runtimeTelemetryEvents) {
      assert.equal(Object.hasOwn(event.attrs ?? {}, "daemonVersion"), false);
      assert.equal(Object.hasOwn(event.attrs ?? {}, "daemon_version"), false);
      assert.equal(Object.hasOwn(event.attrs ?? {}, "computerVersion"), false);
      assert.equal(Object.hasOwn(event.attrs ?? {}, "computer_version"), false);
    }
    assert.deepEqual(runtimeTelemetryEvents.map((event) => ({
      sessionId: event.attrs?.sessionId,
      turnId: event.attrs?.turnId,
      source: event.attrs?.source,
      usageKind: event.attrs?.usageKind,
      totalTokens: event.attrs?.totalTokens,
    })), [
      {
        sessionId: "session-a",
        turnId: "turn-a",
        source: "codex_thread_token_usage_updated",
        usageKind: "cumulative_session",
        totalTokens: 1000,
      },
      {
        sessionId: "session-b",
        turnId: "turn-b",
        source: "codex_thread_token_usage_updated",
        usageKind: "cumulative_session",
        totalTokens: 2000,
      },
    ]);

    const telemetrySpans = sink.getTrace(traceId)
      .filter((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.equal(telemetrySpans.length, 2);
    assert.deepEqual(telemetrySpans.map((span) => ({
      sessionId: span.attrs?.sessionId,
      turnId: span.attrs?.turnId,
      source: span.attrs?.source,
      usageKind: span.attrs?.usageKind,
      daemonVersion: span.attrs?.daemonVersion,
      daemon_version: span.attrs?.daemon_version,
      computerVersion: span.attrs?.computerVersion,
      computer_version: span.attrs?.computer_version,
      agentId: span.attrs?.agentId,
      runtime: span.attrs?.runtime,
      model: span.attrs?.model,
      totalTokens: span.attrs?.totalTokens,
    })), [
      {
        sessionId: "session-a",
        turnId: "turn-a",
        source: "codex_thread_token_usage_updated",
        usageKind: "cumulative_session",
        daemonVersion: "0.55.6",
        daemon_version: "0.55.6",
        computerVersion: "0.0.23",
        computer_version: "0.0.23",
        agentId: "agent-1",
        runtime: "codex",
        model: "gpt-5.3-codex",
        totalTokens: 1000,
      },
      {
        sessionId: "session-b",
        turnId: "turn-b",
        source: "codex_thread_token_usage_updated",
        usageKind: "cumulative_session",
        daemonVersion: "0.55.6",
        daemon_version: "0.55.6",
        computerVersion: "0.0.23",
        computer_version: "0.0.23",
        agentId: "agent-1",
        runtime: "codex",
        model: "gpt-5.3-codex",
        totalTokens: 2000,
      },
    ]);
    assert.equal(telemetrySpans.some((span) => span.attrs?.sessionId === "launch-session"), false);
  }, { tracer: scopedTracer });
});

test("runtime telemetry sidecar spans include daemon and computer version scope", async () => {
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("telemetry", [{
      kind: "telemetry",
      name: "token_usage",
      source: "codex_thread_token_usage_updated",
      usageKind: "cumulative_session",
      sessionId: "session-a",
      turnId: "turn-a",
      attrs: {
        daemonVersion: "payload-daemon",
        daemon_version: "payload-daemon",
        daemon_version_present: false,
        computerVersion: "payload-computer",
        computer_version: "payload-computer",
        computer_version_present: false,
        totalTokens: 1000,
      },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("telemetry\n"));
    await flush();

    const telemetrySpan = sink.getAllSpans()
      .find((candidate) => candidate.name === "daemon.runtime.telemetry.token_usage");
    assert.ok(telemetrySpan, "telemetry sidecar span should be recorded");
    assert.equal(telemetrySpan.attrs?.daemonVersion, "0.56.0");
    assert.equal(telemetrySpan.attrs?.daemon_version, "0.56.0");
    assert.equal(telemetrySpan.attrs?.daemon_version_present, true);
    assert.equal(telemetrySpan.attrs?.computerVersion, "0.0.26");
    assert.equal(telemetrySpan.attrs?.computer_version, "0.0.26");
    assert.equal(telemetrySpan.attrs?.computer_version_present, true);
    assert.equal(telemetrySpan.attrs?.source, "codex_thread_token_usage_updated");
    assert.equal(telemetrySpan.attrs?.usageKind, "cumulative_session");
    assert.equal(telemetrySpan.attrs?.sessionId, "session-a");
    assert.equal(telemetrySpan.attrs?.turnId, "turn-a");
  }, {
    tracer,
    daemonVersion: "0.56.0",
    computerVersion: "0.0.26",
  });
});

test("runtime tracing records normal tool continuation through turn completion", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "slockdev status" } }]);
    driver.parsedLines.set("tool-output", [{ kind: "tool_output", name: "shell" }]);
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
    driver.processes[0].stdout.emit("data", Buffer.from("tool-output\n"));
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
    assert.deepEqual(events, [
      "daemon.turn.started",
      "runtime.event.received",
      "tool.call.started",
      "runtime.event.received",
      "tool.output.observed",
      "runtime.continuation.expected",
      "runtime.event.received",
      "runtime.turn.completed",
    ]);
    const span = sink.getTrace(traceId).find((candidate) => candidate.name === "daemon.runtime.turn");
    assert.equal(span?.status, "ok");
    assert.equal(span?.attrs?.outcome, "turn-completed");
  }, { tracer });
});

test("parsed runtime progress recovers from a silent runtime stall marker", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realDateNow = Date.now;
  let now = 2_000_000;
  let intervalCallback: (() => void) | null = null;
  (Date as any).now = () => now;
  (globalThis as any).setInterval = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms && ms > 1000) {
      intervalCallback = callback;
      return { fake: true };
    }
    return realSetInterval(callback, ms, ...args);
  }) as typeof setInterval;
  (globalThis as any).clearInterval = ((timer: unknown) => {
    if ((timer as any)?.fake) return;
    return realClearInterval(timer as ReturnType<typeof setInterval>);
  }) as typeof clearInterval;

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("tool-start", [{ kind: "tool_call", name: "shell", input: { command: "sleep 999" } }]);
      driver.parsedLines.set("tool-resumed", [{ kind: "tool_call", name: "shell", input: { command: "echo resumed" } }]);
      driver.processes[0].stdout.emit("data", Buffer.from("tool-start\n"));
      await flush();

      assert.ok(intervalCallback, "working activity should install heartbeat");
      now += 16 * 60_000;
      intervalCallback!();
      await flush();

      let ap = (manager as any).agents.get("agent-1");
      assert.ok(ap.runtimeProgress.isStale, "stalled marker should be latched");

      driver.processes[0].stdout.emit("data", Buffer.from("tool-resumed\n"));
      await flush();

      ap = (manager as any).agents.get("agent-1");
      assert.equal(ap.runtimeProgress.staleSince, null);

      const activities = sent
        .filter((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> => msg.type === "agent:activity")
        .filter((msg) => msg.detail !== "Starting…");
      assert.deepEqual(activities.map((msg) => msg.detail), [
        "Running command…",
        "Runtime stalled: no runtime events for 16m (after Running command…, tools=1)",
        "Running command…",
      ]);
      assert.equal(activities.at(-1) ? projectFactActivity(activities.at(-1)!) : undefined, "working");
    });
  } finally {
    (Date as any).now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("deferred-spawn runtimes cache idle state until a concrete message arrives", async () => {
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    deferSpawnUntilMessage: true,
    deferredWakePattern: /First message task/,
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "opencode",
      sessionId: "session-1",
    }));

    assert.equal(driver.spawnCalls.length, 0);
    assert.ok(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      "expected deferred runtime to surface as idle",
    );
    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.ok(cached, "deferred spawn should cache a restart config");
    assert.equal(cached.config.agentCredentialKey, undefined);
    assert.equal(cached.config.agentCredentialId, undefined);
    assert.equal(cached.config.envVars ?? undefined, undefined);

    manager.deliverMessage("agent-1", makeMessage("First message task (system-triggered): post in #all"));
    await flush();
    await flush();

    assert.equal(driver.spawnCalls.length, 0);

    await manager.deliverMessage("agent-1", makeMessage("concrete wake message"));

    assert.equal(driver.spawnCalls.length, 1);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[0].prompt, "concrete wake message");
    assert.equal(driver.spawnCalls[0].config.sessionId, "session-1");
    assert.deepEqual(driver.spawnCalls[0].config.envVars, {
      OPENCODE_BASE_URL: "https://provider-default.example.com/v1",
    });
  }, {
    driver,
    defaultAgentEnvVarsProvider: async () => ({
      OPENCODE_BASE_URL: "https://provider-default.example.com/v1",
    }),
  });
});

test("non-stdin runtimes skip deferred wake messages before restarting after turn exit", async () => {
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
    deferredWakePattern: /First message task/,
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "opencode",
      sessionId: "session-1",
    }));

    const ap = (manager as any).agents.get("agent-1");
    ap.inbox.push(makeMessage("First message task (system-triggered): post in #all", {
      channel_id: "system-task-channel",
      channel_name: "system-task",
    }));
    manager.deliverMessage("agent-1", makeMessage("actual user task", {
      channel_id: "user-task-channel",
      channel_name: "user-task",
    }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await waitFor(
      () => driver.spawnCalls.length === 2,
      "non-stdin restart after deferred wake skip",
    );

    assert.equal(driver.spawnCalls.length, 2);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /First message task/);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, ["actual user task", "First message task"]);
    assert.match(driver.spawnCalls[1].prompt, /Inbox update: .*2 changed targets/);
    assert.match(driver.spawnCalls[1].prompt, /#system-task\s+pending: 1 message/);
    assert.match(driver.spawnCalls[1].prompt, /#user-task\s+pending: 1 message/);
  }, { driver });
});

test("non-stdin runtimes do not restart when clean exit only has deferred wake messages", async () => {
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
    deferredWakePattern: /First message task/,
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "opencode",
      sessionId: "session-1",
    }));

    const ap = (manager as any).agents.get("agent-1");
    ap.inbox.push(makeMessage("First message task (system-triggered): post in #all"));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    await flush();

    assert.equal(driver.spawnCalls.length, 1, "deferred-only clean exit must not spawn a forbidden wake turn");
    assert.ok(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      "deferred-only clean exit should still cache idle restart state",
    );
    assert.ok((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"));
  }, { driver });
});

test("explicit agent env vars override machine defaults and idle restart re-resolves defaults", async () => {
  let machineKey = "sk-machine-openai-a";
  let machineBaseUrl = "https://proxy-a.example.com/v1";

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      envVars: {
        OPENAI_API_KEY: "sk-agent-explicit",
        OPENAI_ORG_ID: "org-explicit",
      },
      sessionId: "session-1",
    }));

    assert.equal(driver.spawnCalls.length, 1);
    assert.deepEqual(driver.spawnCalls[0]?.config.envVars, {
      OPENAI_API_KEY: "sk-agent-explicit",
      OPENAI_BASE_URL: "https://proxy-a.example.com/v1",
      OPENAI_ORG_ID: "org-explicit",
    });
    const cachedAfterSpawn = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.ok(cachedAfterSpawn, "spawn registration should cache restart config");
    assert.deepEqual(cachedAfterSpawn.config.envVars, {
      OPENAI_API_KEY: "sk-agent-explicit",
      OPENAI_ORG_ID: "org-explicit",
    });

    machineKey = "sk-machine-openai-b";
    machineBaseUrl = "https://proxy-b.example.com/v1";
    manager.deliverMessage("agent-1", makeMessage("wake up again"));
    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await waitFor(() => driver.spawnCalls.length === 2, "non-stdin restart after env override update");

    assert.equal(driver.spawnCalls.length, 2);
    assert.deepEqual(driver.spawnCalls[1]?.config.envVars, {
      OPENAI_API_KEY: "sk-agent-explicit",
      OPENAI_BASE_URL: "https://proxy-b.example.com/v1",
      OPENAI_ORG_ID: "org-explicit",
    });
  }, {
    driver: new FakeCodexDriver({ id: "execlike", supportsStdinNotification: false }),
    defaultAgentEnvVarsProvider: async (config) => config.runtime === "codex"
      ? {
          OPENAI_API_KEY: machineKey,
          OPENAI_BASE_URL: machineBaseUrl,
        }
      : null,
  });
});

test("non-stdin runtimes resume immediately after normal exit when messages arrived while busy", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    assert.equal(driver.spawnCalls.length, 1);

    manager.deliverMessage("agent-1", makeMessage("follow-up while busy"));
    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await waitFor(() => driver.spawnCalls.length === 2, "non-stdin restart after queued messages");

    assert.equal(driver.spawnCalls.length, 2);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up while busy");
    assert.ok(
      sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Message received"),
      "expected a working activity event before the follow-up turn",
    );
  }, {
    driver: new FakeCodexDriver({ id: "execlike", supportsStdinNotification: false }),
  });
});

test("non-stdin stale busy runtimes terminate and restart for queued messages", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
  });

  try {
    await withManager(async ({ sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "opencode",
        sessionId: "session-1",
      }));
      assert.equal(driver.spawnCalls.length, 1);

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      manager.deliverMessage("agent-1", makeMessage("follow-up after stuck turn"));
      await waitFor(() => driver.spawnCalls.length === 2, "non-stdin stale busy restart");

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      assert.equal(driver.spawnCalls.length, 2);
      assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up after stuck turn");
      assert.equal(driver.spawnCalls[1].config.sessionId, "session-1");
      assert.equal(
        sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
        false,
        "expected stale recovery not to mark the agent inactive",
      );
      assert.ok(
        sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Restarting stalled OpenCode runtime for queued message"),
        "expected stale recovery activity",
      );
      assert.ok(
        sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Message received"),
        "expected queued message to start a follow-up turn",
      );
    }, { driver });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("non-stdin stale recovery traces and force-kills when SIGTERM does not exit", async () => {
  const realDateNow = Date.now;
  const previousTimeout = process.env.SLOCK_DAEMON_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS;
  let now = 1_000_000;
  (Date as any).now = () => now;
  process.env.SLOCK_DAEMON_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS = "0";
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
    ignoredKillSignals: ["SIGTERM"],
  });

  try {
    await withManager(async ({ sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "opencode",
        sessionId: "session-1",
      }));

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      manager.deliverMessage("agent-1", makeMessage("follow-up after unresponsive SIGTERM"));
      for (let i = 0; i < 10 && driver.spawnCalls.length < 2; i++) {
        await flush();
      }

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(driver.spawnCalls.length, 2);
      assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up after unresponsive SIGTERM");
      assert.equal(
        sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
        false,
        "expected SIGTERM timeout recovery not to mark the agent inactive",
      );

      const timeoutSpan = sink.getAllSpans().find((span) =>
        span.name === "daemon.agent.stalled_recovery.sigterm_timeout"
      );
      assert.ok(timeoutSpan, "expected SIGTERM timeout telemetry");
      assert.equal(timeoutSpan.status, "error");
      assert.equal(timeoutSpan.attrs?.runtime, "opencode");
      assert.equal(timeoutSpan.attrs?.queued_messages_at_signal, 1);
      assert.equal(timeoutSpan.attrs?.timeout_ms, 0);

      const exitSpan = sink.getAllSpans().find((span) =>
        span.name === "daemon.agent.process.exited"
        && span.attrs?.exit_signal === "SIGKILL"
      );
      assert.equal(exitSpan?.attrs?.stalled_recovery_sigterm_timeout, true);
      assert.equal(exitSpan?.attrs?.stalled_recovery_sigterm_timeout_ms, 0);

      driver.processes[1].exit(0);
      driver.processes[1].close(0);
    }, { driver, tracer });
  } finally {
    (Date as any).now = realDateNow;
    if (previousTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_STALLED_RECOVERY_SIGTERM_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("stalled direct-stdin runtimes terminate and restart for queued messages", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "codex",
        sessionId: "session-1",
      }));
      assert.equal(driver.spawnCalls.length, 1);

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      manager.deliverMessage("agent-1", makeMessage("follow-up after stale stdin turn"));
      await waitFor(() => driver.spawnCalls.length === 2, "stale direct-stdin recovery restart");

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      assert.equal(driver.spawnCalls.length, 2);
      assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up after stale stdin turn");
      assert.equal(driver.spawnCalls[1].config.sessionId, "session-1");
      assert.equal(driver.encodedCalls.length, 0, "expected recovery restart instead of another busy stdin injection");
      assert.equal(
        sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
        false,
        "expected stale recovery not to mark the agent inactive",
      );
      assert.ok(
        sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Restarting stalled Codex CLI runtime for queued message"),
        "expected stale recovery activity",
      );
      assert.ok(
        sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Message received"),
        "expected queued message to start a follow-up turn",
      );
    }, { driver });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("queued recovery treats codex raw response items as internal progress", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ sent, manager }) => {
      const sessionId = "019e05d7-recovery-session";
      await manager.startAgent("agent-1", makeConfig({
        runtime: "codex",
        sessionId,
      }));
      assert.equal(driver.spawnCalls.length, 1);

      now += 15 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      driver.parsedLines.set("raw-progress", [{
        kind: "internal_progress",
        source: "codex_raw_response_item",
        itemType: "function_call_output",
        payloadBytes: 256,
      }]);
      driver.processes[0].stdout.emit("data", Buffer.from("raw-progress\n"));
      await flush();
      now += 60_000;

      manager.deliverMessage("agent-1", makeMessage("follow-up while internally active"));
      await flush();
      await flush();

      assert.deepEqual(driver.processes[0].killedSignals, []);
      assert.equal(driver.spawnCalls.length, 1);
      assert.equal(ap.runtimeProgress.staleSince, null);
      assert.equal(ap.inbox.length, 1);
      assert.equal(
        sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Restarting stalled Codex CLI runtime for queued message"),
        false,
      );

      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId }]);
      driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
      await flush();

      const events = eventsForSpan(sink, traceId, "daemon.runtime.turn").map((event) => event.name);
      assert.ok(events.includes("runtime.progress.internal_observed"));
      assert.equal(events.includes("runtime.progress.stalled"), false);
      const observed = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.progress.internal_observed");
      assert.equal(observed?.attrs?.turn_outcome, "held");
      assert.equal(observed?.attrs?.turn_subtype, "runtime_progress");
      assert.equal(observed?.attrs?.turn_reason, "internal_activity_observed");
      assert.equal(observed?.attrs?.signal, "codex_raw_response_item");
      assert.equal(observed?.attrs?.source, "runtime_event");
      assert.equal(observed?.attrs?.runtime, "codex");
      assert.equal(observed?.attrs?.itemType, "function_call_output");
      assert.equal(observed?.attrs?.payloadBytes, 256);
    }, { driver, tracer });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("stalled direct-stdin runtimes do not restart while an active tool is still running", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "codex",
        sessionId: "session-1",
      }));
      assert.equal(driver.spawnCalls.length, 1);

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      ap.gatedSteering.outstandingToolUses = 1;

      manager.deliverMessage("agent-1", makeMessage("follow-up during long shell command"));
      await flush();
      await flush();

      assert.deepEqual(driver.processes[0].killedSignals, []);
      assert.equal(driver.spawnCalls.length, 1);
      assert.equal(ap.inbox.length, 1);

      (manager as any).sendStdinNotification("agent-1");
      assert.equal(driver.encodedCalls.length, 1);
      assert.equal(driver.encodedCalls[0].mode, "busy");
      assert.match(driver.encodedCalls[0].text, /Inbox update:/);
      assert.match(driver.encodedCalls[0].text, /Raft inbox notice/);
      assert.doesNotMatch(driver.encodedCalls[0].text, /System notification/);
      assert.doesNotMatch(driver.encodedCalls[0].text, /follow-up during long shell command/);
      const deltaSpan = sink.getAllSpans().find((span) => span.name === "daemon.agent.inbox_projection.delta");
      assert.equal(deltaSpan?.attrs?.source, "busy_stdin_notification");
      assert.equal(deltaSpan?.attrs?.target_count, 1);
      assert.equal(deltaSpan?.attrs?.changed_target_count, 1);
      assert.equal(deltaSpan?.attrs?.inbox_target_count, 1);
      assert.equal(deltaSpan?.attrs?.pending_message_count, 1);
      const pushedSpan = sink.getAllSpans().find((span) => span.name === "daemon.agent.inbox_update.pushed");
      assert.equal(pushedSpan?.attrs?.source, "busy_stdin_notification");
      assert.equal(pushedSpan?.attrs?.target_count, 1);
      assert.equal(pushedSpan?.attrs?.changed_target_count, 1);
      assert.equal(pushedSpan?.attrs?.inbox_target_count, 1);
      assert.equal(pushedSpan?.attrs?.pending_message_count, 1);
      assert.equal(typeof pushedSpan?.attrs?.notification_byte_count, "number");
      assert.doesNotMatch(
        JSON.stringify([deltaSpan?.attrs, pushedSpan?.attrs]),
        /follow-up during long shell command/,
        "inbox projection traces must not include message content",
      );
    }, { driver, tracer });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("stalled direct-stdin runtimes restart active tools when stdin is already broken", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  (Date as any).now = () => now;
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "codex",
        sessionId: "session-1",
      }));
      assert.equal(driver.spawnCalls.length, 1);

      now += 16 * 60_000;
      const ap = (manager as any).agents.get("agent-1");
      ap.runtimeProgress.markStale(now - 60_000);
      ap.gatedSteering.outstandingToolUses = 1;
      // Seed the broken-stdin evidence through the real stderr path (not a direct
      // field write) so it populates the liveness-bounded decision view that
      // hasDirectStdinRecoveryEvidence reads. No progress event follows, so the
      // evidence stays live and the stale tool-wait is treated as a broken session.
      driver.processes[0].stderr.emit(
        "data",
        Buffer.from("codex_core::tools::router: error=write_stdin failed: stdin is closed for this session\n"),
      );
      await flush();

      manager.deliverMessage("agent-1", makeMessage("follow-up after broken stdin"));
      await waitFor(
        () => driver.spawnCalls.length === 2,
        "direct stdin restart after broken stdin",
      );

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      assert.equal(driver.spawnCalls.length, 2);
      assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up after broken stdin");
      assert.equal(driver.encodedCalls.length, 0, "expected restart instead of writing into a broken stdin session");
    }, { driver });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("non-stdin turn-complete runtimes are terminated after turn_end and restart on next message", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "opencode",
      sessionId: "session-1",
    }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    await flush();

    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
    const exitSpan = sink.getAllSpans().find((span) => span.name === "daemon.agent.process.exited");
    assert.ok(exitSpan, "turn_end termination must trace process exit");
    assert.equal(exitSpan.attrs?.stop_source, "turn_end");
    assert.equal(exitSpan.attrs?.expectedTerminationReason, "turn_end");
    assert.equal(driver.spawnCalls.length, 1);
    assert.ok(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      "expected normal idle state after terminating the completed turn",
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      false,
      "expected turn-complete termination not to mark the agent inactive",
    );

    manager.deliverMessage("agent-1", makeMessage("follow-up after completed turn"));
    await waitFor(() => driver.spawnCalls.length === 2, "non-stdin restart after completed turn");

    assert.equal(driver.spawnCalls.length, 2);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "follow-up after completed turn");
    assert.equal(driver.spawnCalls[1].config.sessionId, "session-1");
  }, { driver, tracer });
});

test("non-stdin turn-complete termination still surfaces runtime errors as failures", async () => {
  const driver = new FakeCodexDriver({
    id: "opencode",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
    terminateProcessOnTurnEnd: true,
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "opencode",
      sessionId: "session-1",
    }));

    driver.parsedLines.set("error-turn-end", [
      { kind: "error", message: "OpenCode provider failed" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("error-turn-end\n"));
    await flush();
    await flush();

    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /OpenCode provider failed/);
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online" && msg.detail === "Process idle"),
      false,
      "expected runtime errors not to be converted into clean idle state",
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      true,
      "expected runtime errors to mark the agent inactive",
    );

    manager.deliverMessage("agent-1", makeMessage("should not auto-restart after failed turn"));
    await flush();
    await flush();

    assert.equal(driver.spawnCalls.length, 1);
  }, { driver });
});

test("direct busy stdin delivery does not overwrite current activity with Message received", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("queued while busy"));
    (manager as any).sendStdinNotification("agent-1");
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /queued while busy/);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 1);
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && msg.detail === "Message received"),
      false,
    );
  }, { driver });
});

test("direct stdin runtimes do not re-contribute identified pending messages at turn_end after busy notice", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("identified already notified", {
      seq: 77,
      message_id: "identified-already-notified",
    }));
    (manager as any).sendStdinNotification("agent-1");

    const apBeforeTurnEnd = (manager as any).agents.get("agent-1");
    assert.equal(apBeforeTurnEnd.inbox.length, 1);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "identified already notified");

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "turn_end must not re-push a row that already contributed");
    const apAfterTurnEnd = (manager as any).agents.get("agent-1");
    assert.equal(apAfterTurnEnd.inbox.length, 1, "content-free contribution is not a consume boundary");
    assert.equal(apAfterTurnEnd.gatedSteering.isIdle, true, "suppressed turn_end delivery should leave the agent idle");

    const effectSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.apm.gated_effect"
      && span.attrs?.effect_kind === "deliver_stdin"
      && span.attrs?.reason === "turn_end"
    );
    assert.ok(effectSpan, "turn_end suppression must emit an APM gated effect trace");
    assert.equal(effectSpan.attrs?.outcome, "suppressed_already_contributed");
    assert.equal(effectSpan.attrs?.delivered_messages_count, 0);
  }, { driver, tracer });
});

test("direct stdin runtimes do not re-contribute identified pending messages on orphan tool output", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("identified already notified", {
      seq: 78,
      message_id: "identified-already-notified-before-orphan-output",
    }));
    (manager as any).sendStdinNotification("agent-1");

    const apBeforeOrphan = (manager as any).agents.get("agent-1");
    assert.equal(apBeforeOrphan.inbox.length, 1);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "identified already notified");

    driver.parsedLines.set("orphan-tool-result", [{ kind: "tool_output", name: "Bash" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("orphan-tool-result\n"));
    await flush();

    const apAfterOrphan = (manager as any).agents.get("agent-1");
    assert.equal(apAfterOrphan.inbox.length, 1, "an orphan tool output must not consume pending inbox work");
    assert.equal(driver.encodedCalls.length, 1, "an orphan tool output must not re-push an already contributed row");

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1, "turn_end must retain the same at-most-once contribution contract");
  }, { driver });
});

test("idle stdin delivery pushes a content-free inbox update without consuming the message", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const apBeforeDelivery = (manager as any).agents.get("agent-1");
    apBeforeDelivery.inbox.push(makeMessage("older unrelated pending body", {
      message_id: "message-old-1",
      channel_name: "older-target",
    }));

    manager.deliverMessage("agent-1", makeMessage("new turn from idle", {
      message_id: "message-idle-1",
      producerFactId: "fact-stdin-readout",
    }), { deliveryId: "delivery-idle-1" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.match(driver.encodedCalls[0].text, /^\[Raft inbox notice:/);
    assert.match(driver.encodedCalls[0].text, /Inbox update: 2 unread messages total; 1 changed target/);
    assert.match(driver.encodedCalls[0].text, /#general/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /#older-target/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /older unrelated pending body/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /new turn from idle/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /producerFactId=fact-stdin-readout/);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 2);
    assert.equal(ap.inbox[0]?.message_id, "message-old-1");
    assert.equal(ap.inbox[1]?.message_id, "message-idle-1");
    assert.deepEqual(
      (manager as any).allPendingVisibleMessages("agent-1").map((message: AgentMessage) => message.message_id),
      ["message-old-1", "message-idle-1"],
      "every stable-id row counted by the content-free notice must remain visible to message check",
    );
    driver.parsedLines.set("turn-end-2", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-2\n"));
    await flush();

    const workingEvent = findLastActivity(sent, "working");
    assert.ok(workingEvent && workingEvent.type === "agent:activity");
    assert.equal(workingEvent.detail, "Message received");
    assert.equal(workingEvent.detailKind, "model_request_started");
    const stdinSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.stdin_delivery" && span.attrs?.mode === "idle" && span.attrs?.deliveryId === "delivery-idle-1"
    );
    assert.equal(stdinSpan?.status, "ok");
    assert.equal(stdinSpan?.attrs?.outcome, "written");
    assert.equal(stdinSpan?.attrs?.messages_count, 1);
    assert.equal(stdinSpan?.attrs?.deliveryId, "delivery-idle-1");
    assert.equal(stdinSpan?.attrs?.delivery_correlation_id, "delivery-idle-1");
    assert.equal(stdinSpan?.attrs?.messageId, "message-idle-1");
    assert.equal(stdinSpan?.attrs?.message_producer_fact_count, 1);
    assert.equal(stdinSpan?.attrs?.message_producer_fact_id, "fact-stdin-readout");
    assert.equal(stdinSpan?.attrs?.cursors_advanced, "none");
    assert.equal(stdinSpan?.attrs?.inbox_target_count, 1);
    assert.equal(stdinSpan?.attrs?.pending_message_count, 2);
    assert.doesNotMatch(JSON.stringify(stdinSpan?.attrs), /new turn from idle/);
    const routedSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed" && span.attrs?.outcome === "stdin_idle_delivery"
    );
    assert.equal(routedSpan?.attrs?.stdin_delivery_accepted, true);
    assert.equal(routedSpan?.attrs?.deliveryId, "delivery-idle-1");
    assert.equal(routedSpan?.attrs?.delivery_correlation_id, "delivery-idle-1");
    const runtimeSpan = sink.getAllSpans().find((span) => span.name === "daemon.runtime.turn" && span.attrs?.reason === "stdin-idle-delivery");
    assert.equal(runtimeSpan?.attrs?.deliveryId, "delivery-idle-1");
    assert.equal(runtimeSpan?.attrs?.delivery_correlation_id, "delivery-idle-1");
    assert.equal(runtimeSpan?.attrs?.message_producer_fact_count, 1);
    assert.equal(runtimeSpan?.attrs?.message_producer_fact_id, "fact-stdin-readout");
    assertSurfaceProducerFactLineage(
      [stdinSpan?.attrs, runtimeSpan?.attrs],
      ["fact-stdin-readout"],
      "daemon stdin trace surfaces",
    );
  }, { driver, tracer });
});

test("idle stdin encode failure retries without waiting for another message", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    failEncodeModes: ["idle"],
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("retry this idle message", {
      message_id: "message-idle-retry-1",
    }), { deliveryId: "delivery-idle-retry-1" });
    await flush();

    const apAfterFailure = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(apAfterFailure.inbox.length, 1);
    assert.equal(apAfterFailure.notifications.pendingCount, 1);
    assert.equal(apAfterFailure.notifications.hasTimer, true);
    assert.equal(apAfterFailure.gatedSteering.isIdle, true);
    assert.equal(activityDetailKinds(sent).includes("model_request_started"), false);

    driver.failEncodeModes.delete("idle");
    await waitFor(() => driver.encodedCalls.length === 1, "idle stdin encode retry");

    const apAfterRetry = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "retry this idle message");
    assert.equal(apAfterRetry.inbox.length, 1);
    assert.equal(apAfterRetry.notifications.pendingCount, 0);
    assert.equal(apAfterRetry.notifications.hasTimer, false);
    assert.equal(
      apAfterRetry.notifications.hasContributedMessage(apAfterRetry.inbox[0], "session-1"),
      true,
    );
    assert.equal(apAfterRetry.gatedSteering.isIdle, false);
    assert.equal(
      activityDetailKinds(sent).filter((kind) => kind === "model_request_started").length,
      1,
      "retry write acceptance should emit exactly one model_request_started",
    );

    const failureTrace = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.stdin_delivery" && span.attrs?.deliveryId === "delivery-idle-retry-1"
    );
    assert.equal(failureTrace?.status, "error");
    assert.equal(failureTrace?.attrs?.outcome, "encode_failed");
    assert.equal(failureTrace?.attrs?.retry_scheduled, true);
    assert.equal(failureTrace?.attrs?.requeued_messages_count, 1);

    const retryTrace = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.stdin_delivery.idle_retry" && span.attrs?.outcome === "written"
    );
    assert.equal(retryTrace?.attrs?.messages_count, 1);
  }, { driver, tracer, stdinNotificationRetryMs: 25 });
});

test("idle stdin delivery writes the same pending message at most once per session without dropping it", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-1\n"));
    await flush();

    const pendingMessage = makeMessage("Lead reply body must stay pending but not be re-written", {
      message_id: "cc7cb4d5-7491-405f-83a3-041d68105373",
      seq: 6125219,
    });

    manager.deliverMessage("agent-1", pendingMessage, { deliveryId: "delivery-first" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.match(driver.encodedCalls[0].text, /Inbox update: 1 unread message total; 1 changed target/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /Lead reply body/);

    const apAfterFirst = (manager as any).agents.get("agent-1");
    assert.equal(apAfterFirst.inbox.length, 1);
    assert.equal(apAfterFirst.inbox[0]?.message_id, "cc7cb4d5-7491-405f-83a3-041d68105373");
    assert.equal(apAfterFirst.inbox[0]?.seq, 6125219);

    (manager as any).commitApmIdleState("agent-1", apAfterFirst, true);

    manager.deliverMessage("agent-1", makeMessage("same server push instance", {
      message_id: "cc7cb4d5-7491-405f-83a3-041d68105373",
      seq: 6125219,
    }), { deliveryId: "delivery-repeat" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    const apAfterRepeat = (manager as any).agents.get("agent-1");
    assert.equal(apAfterRepeat.inbox.length, 1);
    assert.equal(apAfterRepeat.inbox[0]?.message_id, "cc7cb4d5-7491-405f-83a3-041d68105373");
    assert.equal(apAfterRepeat.inbox[0]?.seq, 6125219);

    const repeatStdinSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.stdin_delivery" && span.attrs?.deliveryId === "delivery-repeat"
    );
    assert.equal(repeatStdinSpan, undefined);
    const suppressedSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed" && span.attrs?.deliveryId === "delivery-repeat"
    );
    assert.equal(suppressedSpan?.attrs?.outcome, "suppressed_duplicate_stdin_idle_delivery");
    assert.equal(suppressedSpan?.attrs?.inbox_count, 1);

    manager.deliverMessage("agent-1", makeMessage("fresh message reopens idle delivery", {
      message_id: "fresh-message-idle-1",
      seq: 6125220,
    }), { deliveryId: "delivery-fresh" });
    await flush();

    assert.equal(driver.encodedCalls.length, 2);
    assert.equal(driver.encodedCalls[1].mode, "idle");
    assert.match(driver.encodedCalls[1].text, /Inbox update: 2 unread messages total; 1 changed target/);
    assert.doesNotMatch(driver.encodedCalls[1].text, /fresh message reopens idle delivery/);
    const apAfterFresh = (manager as any).agents.get("agent-1");
    assert.equal(apAfterFresh.inbox.length, 2);
    assert.deepEqual(apAfterFresh.inbox.map((message: AgentMessage) => message.message_id), [
      "cc7cb4d5-7491-405f-83a3-041d68105373",
      "fresh-message-idle-1",
    ]);
  }, { driver, tracer });
});

test("third-party app events use concrete agent-event target for pending freshness lookup", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-1\n"));
    await flush();

    const message = makeMessage("Third-party event: build ready", {
      channel_id: "third-party-agent-events:agent-1",
      channel_name: "third-party-agent-events:agent-1",
      channel_type: "dm",
      sender_id: "oauth-client-row-1",
      sender_name: "external-build-app",
      sender_description: "External Build App",
      sender_type: "third_party_app",
      message_id: "12345678-0000-4000-8000-000000000000",
      seq: 6125300,
      third_party_event: {
        id: "12345678-0000-4000-8000-000000000000",
        kind: "event",
        client_id: "external-build-app",
        client_name: "External Build App",
        payload_hash: "a".repeat(64),
        payload: { status: "ready" },
        expires_at: "2026-03-25T10:00:00.000Z",
        source: {
          client_id: "external-build-app",
          client_name: "External Build App",
          oauth_client_id: "oauth-client-row-1",
          access_token_id_hash: "b".repeat(64),
          resource: "urn:raft:server:server-1:agent-inbound",
        },
      },
    });

    manager.deliverMessage("agent-1", message, { deliveryId: "third-party-delivery" });
    await flush();

    assert.equal((manager as any).pendingVisibleMessages("agent-1", "agent-event:12345678").length, 1);
    assert.equal((manager as any).pendingVisibleMessages("agent-1", "dm:@third-party-agent-events:agent-1").length, 0);
    assert.equal(driver.encodedCalls.length, 1);
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "Third-party event: build ready");
  }, { driver });
});

test("idle stdin duplicate memo does not hide a re-arrived message after the pending row is gone", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-1\n"));
    await flush();

    const message = makeMessage("first write leaves only a stale notice memo after local clear", {
      message_id: "stale-memo-message-id",
      seq: 6125301,
    });
    manager.deliverMessage("agent-1", message, { deliveryId: "delivery-first" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 1);
    ap.inbox.splice(0, ap.inbox.length);
    assert.equal(ap.inbox.length, 0);
    (manager as any).commitApmIdleState("agent-1", ap, true);

    manager.deliverMessage("agent-1", makeMessage("same fingerprint re-arrives after local clear", {
      message_id: "stale-memo-message-id",
      seq: 6125301,
    }), { deliveryId: "delivery-rearrived" });
    await flush();

    assert.equal(driver.encodedCalls.length, 2);
    assert.equal(driver.encodedCalls[1].mode, "idle");
    assert.match(driver.encodedCalls[1].text, /Inbox update: 1 unread message total; 1 changed target/);
    assert.doesNotMatch(driver.encodedCalls[1].text, /same fingerprint re-arrives/);
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.inbox[0]?.message_id, "stale-memo-message-id");
    assert.equal(ap.inbox[0]?.seq, 6125301);
  }, { driver });
});

test("idle stdin duplicate suppression still works with multiple pending messages", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end-1", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end-1\n"));
    await flush();

    const apBeforeDelivery = (manager as any).agents.get("agent-1");
    apBeforeDelivery.inbox.push(makeMessage("older pending body must remain pending", {
      message_id: "older-pending-message-id",
      seq: 6125400,
      channel_name: "older-target",
    }));

    manager.deliverMessage("agent-1", makeMessage("new idle message", {
      message_id: "multi-pending-new-id",
      seq: 6125401,
    }), { deliveryId: "delivery-first" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.match(driver.encodedCalls[0].text, /Inbox update: 2 unread messages total; 1 changed target/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /older pending body/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /new idle message/);

    const apAfterFirst = (manager as any).agents.get("agent-1");
    assert.equal(apAfterFirst.inbox.length, 2);
    assert.deepEqual(apAfterFirst.inbox.map((message: AgentMessage) => message.message_id), [
      "older-pending-message-id",
      "multi-pending-new-id",
    ]);
    (manager as any).commitApmIdleState("agent-1", apAfterFirst, true);

    manager.deliverMessage("agent-1", makeMessage("same new idle message re-pushed", {
      message_id: "multi-pending-new-id",
      seq: 6125401,
    }), { deliveryId: "delivery-repeat" });
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(apAfterFirst.inbox.length, 2);
    assert.deepEqual(apAfterFirst.inbox.map((message: AgentMessage) => message.message_id), [
      "older-pending-message-id",
      "multi-pending-new-id",
    ]);
    const suppressedSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed" && span.attrs?.deliveryId === "delivery-repeat"
    );
    assert.equal(suppressedSpan?.attrs?.outcome, "suppressed_duplicate_stdin_idle_delivery");
    assert.equal(suppressedSpan?.attrs?.inbox_count, 2);
  }, { driver, tracer });
});

test("transient idle stdin delivery is one-shot and does not enter pending inbox", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const accepted = manager.deliverMessage(
      "agent-1",
      makeMessage("Reminder: one-shot only", {
        channel_type: "dm",
        channel_name: "HaoHao",
        sender_name: "system",
        sender_type: "system",
      }),
      { transient: true },
    );
    assert.equal(accepted, true);
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.match(driver.encodedCalls[0].text, /^New message received:/);
    assert.match(driver.encodedCalls[0].text, /Reminder: one-shot only/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /^\[Raft inbox notice:/);

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 0);
  }, { driver });
});

test("third-party app runtime input exposes source type and inert payload without warning prose", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const accepted = manager.deliverMessage(
      "agent-1",
      makeMessage("Third-party event: build ready", {
        channel_id: "third-party-agent-events:agent-1",
        channel_name: "third-party-agent-events:agent-1",
        channel_type: "dm",
        sender_id: "oauth-client-row-1",
        sender_name: "external-build-app",
        sender_description: "External Build App",
        sender_type: "third_party_app",
        message_id: "12345678-0000-4000-8000-000000000000",
        third_party_event: {
          id: "12345678-0000-4000-8000-000000000000",
          kind: "event",
          client_id: "external-build-app",
          client_name: "External Build App",
          payload_hash: "a".repeat(64),
          payload: {
            meeting_title: "Weekly sync",
            join_url: "https://meet.example.test/weekly-sync",
            organizer: "@Ray",
          },
          expires_at: "2026-03-25T10:00:00.000Z",
          source: {
            client_id: "external-build-app",
            client_name: "External Build App",
            oauth_client_id: "oauth-client-row-1",
            access_token_id_hash: "b".repeat(64),
            resource: "urn:raft:server:server-1:agent-inbound",
          },
        },
      }),
      { transient: true },
    );
    assert.equal(accepted, true);
    await flush();

    const prompt = driver.encodedCalls.at(-1)?.text ?? "";
    assert.match(prompt, /type=third_party_app/);
    assert.doesNotMatch(prompt, /trust_class|untrusted/i);
    assert.match(prompt, /"meeting_title": "Weekly sync"/);
    assert.match(prompt, /"join_url": "https:\/\/meet\.example\.test\/weekly-sync"/);
    assert.match(prompt, /"organizer": "user:Ray"/);
    assert.doesNotMatch(prompt, /@Ray\b/);
    assert.doesNotMatch(prompt, /treat .* as data|not instructions/i);
  }, { driver });
});

test("non-stdin runtimes restart with a content-free inbox update for queued channels", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("first queued message"));
    manager.deliverMessage(
      "agent-1",
      makeMessage("dm arrived too", {
        channel_id: "dm-1",
        channel_name: "alice",
        channel_type: "dm",
      }),
    );

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await waitFor(() => driver.spawnCalls.length === 2, "non-stdin restart with queued channel summary");

    assert.equal(driver.spawnCalls.length, 2);
    assert.match(driver.spawnCalls[1].prompt, /^\[Raft inbox notice:/);
    assert.match(driver.spawnCalls[1].prompt, /Inbox update: .*2 changed targets/);
    assert.match(driver.spawnCalls[1].prompt, /#general\s+pending: 1 message/);
    assert.match(driver.spawnCalls[1].prompt, /dm:@alice\s+pending: 1 message/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /first queued message/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /dm arrived too/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /You also have unread messages in other channels:/);
  }, {
    driver: new FakeCodexDriver({ id: "execlike", supportsStdinNotification: false }),
  });
});

test("messages arriving while a non-stdin auto-resume is starting are preserved", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("first queued message"));
    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    manager.deliverMessage("agent-1", makeMessage("second queued message during restart"));
    await waitFor(() => driver.spawnCalls.length === 2, "non-stdin auto-resume first restart");

    assert.equal(driver.spawnCalls.length, 2);

    driver.processes[1].exit(0);
    driver.processes[1].close(0);
    await waitFor(
      () => driver.spawnCalls.length === 3,
      "non-stdin restart after message arrives during auto-resume",
    );

    assert.equal(driver.spawnCalls.length, 3);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[2].prompt, "second queued message during restart");
  }, {
    driver: new FakeCodexDriver({ id: "execlike", supportsStdinNotification: false }),
  });
});

test("queued continuation preserves restart residency after managed credential mint failure", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    assert.equal(driver.spawnCalls.length, 1);

    assert.equal(manager.deliverMessage("agent-1", makeMessage("first queued message")), true);

    await withRunnerCredentialMintFailure(async () => {
      driver.processes[0].exit(0);
      driver.processes[0].close(0);
      await waitFor(
        () => sent.some((msg) => msg.type === "agent:activity" && msg.detail.includes("runner_credential_mint_failed")),
        "queued continuation managed credential failure activity",
      );

      assert.equal(driver.spawnCalls.length, 1);
      const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
      assert.ok(cached, "queued continuation mint failure keeps restart-safe idle residency");
      assert.equal(cached.config.agentCredentialKey, undefined, "cached retry config must not retain failed runner credentials");
      const state = getSpawnFailBackoffState(manager, "agent-1");
      assert.ok(state?.untilMs > 0, "queued continuation mint failure arms cooldown residency");
      assert.equal(await manager.deliverMessage("agent-1", makeMessage("second queued message during cooldown")), true);
      assert.equal((manager as any).startingInboxes.values("agent-1")?.length, 1);
      assert.ok(sent.some((msg) =>
        msg.type === "agent:status"
        && msg.agentId === "agent-1"
        && msg.status === "inactive"
      ));
      assert.equal(findLastActivity(sent, "online"), undefined);
    });
  }, {
    driver: new FakeCodexDriver({ id: "execlike", supportsStdinNotification: false }),
  });
});

test("stdin runtimes start a new turn after turn_end instead of steering the next message", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeCodexDriver({ id: "claude", supportsStdinNotification: true });
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
    },
  );

  try {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));
    manager.deliverMessage("agent-1", makeMessage("queued while busy"));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "queued while busy");
  } finally {
    cleanupTestManager(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("stdin runtimes batch multiple queued messages into the next turn", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeCodexDriver({ id: "claude", supportsStdinNotification: true });
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
    },
  );

  try {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));
    manager.deliverMessage("agent-1", makeMessage("first follow-up"));
    manager.deliverMessage("agent-1", makeMessage("second follow-up"));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, ["first follow-up", "second follow-up"]);
  } finally {
    cleanupTestManager(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("direct stdin runtimes pause busy delivery until compaction finishes", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("direct message during compaction"));
    (manager as any).sendStdinNotification("agent-1");

    const apDuringCompaction = (manager as any).agents.get("agent-1");
    assert.equal(apDuringCompaction.gatedSteering.compacting, true);
    assert.equal(apDuringCompaction.inbox.length, 1);
    assert.equal(apDuringCompaction.notifications.pendingCount, 1);
    assert.equal(apDuringCompaction.notifications.timer, null);
    assert.equal(driver.encodedCalls.length, 0);
    const routedDuringCompaction = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed" &&
      span.attrs?.outcome === "queued_compaction_boundary"
    );
    assert.ok(routedDuringCompaction, "direct delivery should queue without starting a timer during compaction");
    assert.equal(routedDuringCompaction.attrs?.busy_delivery_mode, "direct");
    assert.equal(routedDuringCompaction.attrs?.notification_timer_present, false);

    driver.parsedLines.set("compact-finish", [{ kind: "compaction_finished" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-finish\n"));
    await flush();

    const apAfterCompaction = (manager as any).agents.get("agent-1");
    assert.equal(apAfterCompaction.inbox.length, 1);
    assert.equal(apAfterCompaction.notifications.pendingCount, 0);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /direct message during compaction/);
  }, { driver, tracer });
});

test("direct stdin runtimes pause busy delivery until review mode finishes", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("review-start", [{ kind: "review_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("review-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("direct message during review"));
    (manager as any).sendStdinNotification("agent-1");

    const apDuringReview = (manager as any).agents.get("agent-1");
    assert.equal(apDuringReview.gatedSteering.reviewing, true);
    assert.equal(apDuringReview.inbox.length, 1);
    assert.equal(apDuringReview.notifications.pendingCount, 1);
    assert.equal(apDuringReview.notifications.timer, null);
    assert.equal(driver.encodedCalls.length, 0);
    const routedDuringReview = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.delivery.routed" &&
      span.attrs?.outcome === "queued_review_boundary"
    );
    assert.ok(routedDuringReview, "direct delivery should queue without starting a timer during review");
    assert.equal(routedDuringReview.attrs?.busy_delivery_mode, "direct");
    assert.equal(routedDuringReview.attrs?.notification_timer_present, false);

    driver.parsedLines.set("review-finish", [{ kind: "review_finished" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("review-finish\n"));
    await flush();

    const apAfterReview = (manager as any).agents.get("agent-1");
    assert.equal(apAfterReview.gatedSteering.reviewing, false);
    assert.equal(apAfterReview.inbox.length, 1);
    assert.equal(apAfterReview.notifications.pendingCount, 0);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /direct message during review/);
  }, { driver, tracer });
});

test("direct stdin runtimes notify about compaction-boundary messages on inferred resumed output", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("direct question delivered during compacted turn"));

    driver.parsedLines.set("text-after-compact", [{ kind: "text", text: "resumed" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("text-after-compact\n"));
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.gatedSteering.compacting, false);
    assert.deepEqual(ap.compaction, { kind: "none" });
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /direct question delivered during compacted turn/);
  }, { driver });
});

test("runtime error clears compaction state without successful finish activity or stdin flush", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("queued message should not flush into errored runtime"));

    driver.parsedLines.set("runtime-error", [{ kind: "error", message: "provider failed" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("runtime-error\n"));
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.gatedSteering.compacting, false);
    assert.deepEqual(ap.compaction, { kind: "none" });
    assert.equal(ap.inbox.length, 1);
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.entries?.some((entry) => entry.kind === "compaction_finished")
      ),
      false,
      "runtime errors should not emit a successful compaction finish",
    );
  }, { driver });
});

test("failed compaction stays terminal through turn_end without a success claim or queued recovery prompt", async () => {
  const driver = new FakeCodexDriver({
    id: "pi",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const { sink, tracer } = makeDeterministicTracer();

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "pi", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("queued message must remain held after terminal compaction"));
    const apBeforeTerminal = (manager as any).agents.get("agent-1");
    driver.parsedLines.set("compact-terminal", [
      {
        kind: "compaction_interrupted",
        outcome: "compaction_failed_or_exhausted",
        reason: "overflow",
        failureReason: "recovery_exhausted",
      },
      {
        kind: "telemetry",
        name: "recovery",
        source: "pi_compaction",
        attrs: {
          recovery_outcome: "compaction_failed_or_exhausted",
          compaction_reason: "overflow",
          failure_reason: "recovery_exhausted",
          message_count_capped: 30,
          message_count_was_capped: false,
          input_length_bucket: "4097_16384",
          configured_context_limit: 983_616,
          input_range_classification: "upper_bound_overflow",
          will_retry: false,
        },
      },
      {
        kind: "error",
        message: "InputTooLargeError",
        terminalReason: "compaction_failed_or_exhausted",
      },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-terminal\n"));
    await flush();

    assert.equal(apBeforeTerminal.gatedSteering.compacting, false);
    assert.deepEqual(apBeforeTerminal.compaction, { kind: "none" });
    assert.equal(apBeforeTerminal.inbox.length, 1);
    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        (msg.detailKind === "compaction_finished" ||
          msg.entries?.some((entry) => entry.kind === "compaction_finished"))
      ),
      false,
    );
    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(errorEvent.detailKind, "runtime_error");
    assert.match(errorEvent.detail, /^Pi reported input that is too large/);
    assert.equal(errorEvent.runtimeError?.errorClass, "InputTooLargeError");
    assert.equal(errorEvent.runtimeError?.errorReason, "input_too_large");
    assert.doesNotMatch(JSON.stringify(errorEvent), /queued message must remain held/iu);

    const recoverySpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.runtime.telemetry.recovery" &&
      span.attrs?.recovery_outcome === "compaction_failed_or_exhausted"
    );
    assert.ok(recoverySpan);
    assert.equal(recoverySpan.attrs?.input_length_bucket, "4097_16384");
    assert.equal(recoverySpan.attrs?.message_count_capped, 30);
    assert.doesNotMatch(
      JSON.stringify(recoverySpan.attrs),
      /queued message must remain held|prompt|summary|tool.args|provider.payload/iu,
    );
  }, { driver, tracer });
});

test("compaction interruption trace reprojects every untrusted field to closed sets", async () => {
  const driver = new FakeCodexDriver({ id: "pi" });
  const { sink, tracer, traceId } = makeDeterministicTracer();

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "pi", sessionId: "session-1" }));
    driver.parsedLines.set("malicious-interruption", [
      { kind: "compaction_started" },
      {
        kind: "compaction_interrupted",
        outcome: "aborted; Bearer sk-reviewer-outcome-secret",
        reason: "overflow; Bearer sk-reviewer-secret https://provider.example/private",
        failureReason: "compaction_failed; https://provider.example/failure",
      },
      { kind: "turn_end", sessionId: "session-1" },
    ] as ParsedEvent[]);
    driver.processes[0].stdout.emit("data", Buffer.from("malicious-interruption\n"));
    await flush();

    const interruptedEvent = eventsForSpan(sink, traceId, "daemon.runtime.turn").find((event) =>
      event.name === "runtime.context_compaction.interrupted"
    );
    assert.ok(interruptedEvent);
    assert.equal(interruptedEvent.attrs?.outcome, "unknown");
    assert.equal(interruptedEvent.attrs?.reason, "unknown");
    assert.equal(interruptedEvent.attrs?.failure_reason, "unknown");
    assert.doesNotMatch(
      JSON.stringify(interruptedEvent.attrs),
      /reviewer|secret|provider\.example|private/iu,
    );
  }, { driver, tracer });
});

test("async delivery rejection during compaction clears compaction state and surfaces failure", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    const queuedMessage = makeMessage("queued message should survive failed compaction", {
      message_id: "compaction-rejected-boundary-message-1",
      seq: 6201003,
    });
    manager.deliverMessage("agent-1", queuedMessage);

    driver.parsedLines.set("delivery-error", [{
      kind: "delivery_error",
      message: "API Error: 429 Too Many Requests",
      requestMethod: "turn/steer",
      source: "codex_app_server_response",
      payloadBytes: 41,
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("delivery-error\n"));
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.gatedSteering.compacting, false);
    assert.deepEqual(ap.compaction, { kind: "none" });
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(ap.notifications.hasContributedMessage(queuedMessage, "session-1"), true);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "queued message should survive failed compaction");
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.entries?.some((entry) => entry.kind === "compaction_finished")
      ),
      false,
      "delivery rejection during compaction must not emit a successful compaction finish",
    );
    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /Context compaction interrupted/);
    assert.match(errorEvent.detail, /429 Too Many Requests/);
  }, { driver });
});

test("process exit clears compaction state without successful finish activity or stdin flush", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex", sessionId: "session-1" }));

    driver.parsedLines.set("compact-start", [{ kind: "compaction_started" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("compact-start\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("queued message should not flush into closed runtime"));

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await flush();

    assert.equal(driver.encodedCalls.length, 0);
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detail === "Context compaction finished (inferred from process exit)"
      ),
      false,
      "process exit should not emit a successful inferred compaction finish",
    );
  }, { driver });
});

test("direct stdin runtimes keep daemon release notices separate from ordinary pending inbox work", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    assert.equal(manager.deliverMessage("agent-1", makeMessage("ordinary pending first")), true);
    assert.equal((manager as any).deliverRuntimeProfileNotification(
      "agent-1",
      "notice-1",
      "daemon_release_notice",
      "Runtime Profile notice: daemon upgraded 0.44.1 -> 0.44.2.",
    ), true);

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Runtime Profile notice/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /ordinary pending first/);
    assert.ok(sent.some((msg) =>
      msg.type === "agent:runtime_profile:daemon_release_notice:ack"
      && msg.agentId === "agent-1"
      && msg.noticeKey === "notice-1"
    ));

    const apAfterControl = (manager as any).agents.get("agent-1");
    assert.equal(apAfterControl.inbox.length, 1, "the ordinary message must remain pending after direct control delivery");
    assert.equal(apAfterControl.notifications.pendingCount, 1);

    (manager as any).sendStdinNotification("agent-1");

    assert.equal(driver.encodedCalls.length, 2);
    assert.equal(driver.encodedCalls[1].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[1].text, "ordinary pending first");
    assert.doesNotMatch(driver.encodedCalls[1].text, /Runtime Profile notice/);
    assert.equal(apAfterControl.inbox.length, 1);
    assert.equal(apAfterControl.notifications.pendingCount, 0);
  }, { driver });
});

test("deprecated runtime profile migrations complete without joining ordinary direct inbox delivery", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    assert.equal(manager.deliverMessage("agent-1", makeMessage("ordinary pending first")), true);
    assert.equal((manager as any).deliverRuntimeProfileNotification(
      "agent-1",
      "migration-1",
      "migration",
      "Runtime Profile changed. Migration key: migration-1.",
    ), true);

    assert.equal(driver.encodedCalls.length, 0, "deprecated migration control must not be injected into the runtime");
    assert.ok(sent.some((msg) =>
      msg.type === "agent:runtime_profile:migration:ack"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
    ));
    assert.ok(sent.some((msg) =>
      msg.type === "agent:runtime_profile:migration_done"
      && msg.agentId === "agent-1"
      && msg.migrationKey === "migration-1"
    ));

    const apAfterMigration = (manager as any).agents.get("agent-1");
    assert.equal(apAfterMigration.inbox.length, 1);
    assert.equal(apAfterMigration.notifications.pendingCount, 1);

    (manager as any).sendStdinNotification("agent-1");

    assert.equal(driver.encodedCalls.length, 1);
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "ordinary pending first");
    assert.doesNotMatch(driver.encodedCalls[0].text, /Migration key: migration-1/);
    assert.equal(apAfterMigration.inbox.length, 1);
    assert.equal(apAfterMigration.notifications.pendingCount, 0);
  }, { driver });
});

test("deprecated runtime profile migrations complete during startup without queuing", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
  });
  let releaseDefaults: ((value: Record<string, string> | null) => void) | null = null;
  const defaultEnvVarsProvider = () => new Promise<Record<string, string> | null>((resolve) => {
    releaseDefaults = resolve;
  });

  await withManager(async ({ manager, sent }) => {
    const start = manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));
    try {
      for (let i = 0; i < 10; i++) {
        const snapshot = agentStartSnapshot(manager);
        if (snapshot.startingAgentIds.includes("agent-1") || snapshot.queuedAgentIds.includes("agent-1")) break;
        await flush();
      }

      (manager as any).deliverRuntimeProfileNotification(
        "agent-1",
        "migration-1",
        "migration",
        "Runtime Profile changed. Migration key: migration-1.",
      );

      assert.equal(
        agentStartSnapshot(manager).startingAgentIds.includes("agent-1") || agentStartSnapshot(manager).queuedAgentIds.includes("agent-1"),
        true,
      );
      assert.equal((manager as any).startingInboxes.values("agent-1")?.length ?? 0, 0);
      assert.ok(sent.some((msg) =>
        msg.type === "agent:runtime_profile:migration:ack"
        && msg.agentId === "agent-1"
        && msg.migrationKey === "migration-1"
      ));
      assert.ok(sent.some((msg) =>
        msg.type === "agent:runtime_profile:migration_done"
        && msg.agentId === "agent-1"
        && msg.migrationKey === "migration-1"
      ));

      for (let i = 0; i < 20 && !releaseDefaults; i++) {
        await flush();
      }
      assert.ok(releaseDefaults, "expected startup to wait on default env vars");
      releaseDefaults(null);
      releaseDefaults = null;
      await start;
      await flush();

      const apAfterSpawn = (manager as any).agents.get("agent-1");
      assert.equal(apAfterSpawn.inbox.length, 0);
      assert.equal(driver.encodedCalls.length, 0);

      driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
      await flush();

      assert.equal(driver.spawnCalls.length, 1);
      assert.equal(driver.encodedCalls.length, 0);
      driver.processes[0].exit(0);
      driver.processes[0].close(0);
    } finally {
      releaseDefaults?.(null);
    }
  }, { driver, defaultAgentEnvVarsProvider: defaultEnvVarsProvider, runtimeStartScheduler: { minStartIntervalMs: 0 } });
});

test("deprecated runtime profile migration does not auto-restart idle runtimes", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({
        runtime: "claude",
        sessionId: "session-1",
        agentCredentialKey: undefined,
        agentCredentialId: undefined,
      }),
      sessionId: "session-1",
      launchId: "launch-1",
    });

    await withRunnerCredentialMintFailure(async () => {
      const accepted = await (manager as any).deliverRuntimeProfileNotification(
        "agent-1",
        "migration-1",
        "migration",
        "Runtime Profile changed. Migration key: migration-1.",
      );

      assert.equal(accepted, true);
      assert.equal(driver.spawnCalls.length, 0);
      assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), true);
      assert.ok(sent.some((msg) =>
        msg.type === "agent:runtime_profile:migration:ack"
        && msg.agentId === "agent-1"
        && msg.migrationKey === "migration-1"
      ));
      assert.ok(sent.some((msg) =>
        msg.type === "agent:runtime_profile:migration_done"
        && msg.agentId === "agent-1"
        && msg.migrationKey === "migration-1"
      ));
      assert.ok(sent.some((msg) =>
        msg.type === "agent:status"
        && msg.agentId === "agent-1"
        && msg.status === "inactive"
        && msg.launchId === "launch-1"
      ) === false);
      assert.ok(sent.some((msg) =>
        msg.type === "agent:activity"
        && msg.agentId === "agent-1"
        && projectFactActivity(msg) === "error"
        && msg.detail.includes("runner_credential_mint_failed")
      ) === false);
      assert.equal(findLastActivity(sent, "online"), undefined);
    });
  }, {
    driver: new FakeCodexDriver({ id: "claude", supportsStdinNotification: true, busyDeliveryMode: "direct" }),
  });
});

test("codex delivers queued follow-up into the next turn without restarting the process", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("queued while busy"));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "queued while busy");
  });
});

test("codex notifies about queued inbox while busy without consuming message content", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("interrupt current work with this"));
    (manager as any).sendStdinNotification("agent-1");

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /interrupt current work with this/);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.pendingCount, 0);
  });
});

test("codex restores busy notification debt after async app-server rejection", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    const message = makeMessage("keep this visible after rejected steer", {
      message_id: "busy-rejected-message-1",
      seq: 6201001,
    });
    manager.deliverMessage("agent-1", message);
    (manager as any).sendStdinNotification("agent-1");

    const apAfterWrite = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.equal(apAfterWrite.inbox.length, 1);
    assert.equal(apAfterWrite.notifications.pendingCount, 0);
    assert.equal(apAfterWrite.notifications.hasContributedMessage(message, "session-1"), true);

    const sentBeforeReject = sent.length;
    driver.parsedLines.set("delivery-error", [{
      kind: "delivery_error",
      message: "Codex app-server rejected turn/steer",
      requestMethod: "turn/steer",
      source: "codex_app_server_response",
      payloadBytes: 41,
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("delivery-error\n"));
    await flush();

    const apAfterReject = (manager as any).agents.get("agent-1");
    assert.equal(apAfterReject.inbox.length, 1);
    assert.equal(apAfterReject.notifications.pendingCount, 1);
    assert.equal(apAfterReject.notifications.hasContributedMessage(message, "session-1"), false);
    assert.equal(
      sent.slice(sentBeforeReject).some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "error"),
      false,
      "async delivery rejection must not become visible runtime error activity",
    );

    const rejectionTrace = sink.getAllSpans().find((span) => span.name === "daemon.agent.stdin_delivery.async_rejected");
    assert.equal(rejectionTrace?.attrs?.request_method, "turn/steer");
    assert.equal(rejectionTrace?.attrs?.restored_messages_count, 1);
    assert.equal(rejectionTrace?.attrs?.pending_notification_count_after, 1);

    (manager as any).sendStdinNotification("agent-1");
    assert.equal(driver.encodedCalls.length, 2);
    assert.equal(driver.encodedCalls[1].mode, "busy");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[1].text, "keep this visible after rejected steer");
    assert.equal(apAfterReject.notifications.pendingCount, 0);
  }, { driver, tracer });
});

test("codex restores idle notification debt after async app-server rejection", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const message = makeMessage("keep this visible after rejected turn start", {
      message_id: "idle-rejected-message-1",
      seq: 6201002,
    });
    manager.deliverMessage("agent-1", message);
    await flush();

    const apAfterWrite = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assert.equal(apAfterWrite.inbox.length, 1);
    assert.equal(apAfterWrite.notifications.pendingCount, 0);
    assert.equal(apAfterWrite.notifications.hasContributedMessage(message, "session-1"), true);

    const sentBeforeReject = sent.length;
    driver.parsedLines.set("delivery-error", [{
      kind: "delivery_error",
      message: "Codex app-server rejected turn/start",
      requestMethod: "turn/start",
      source: "codex_app_server_response",
      payloadBytes: 41,
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("delivery-error\n"));
    await flush();

    const apAfterReject = (manager as any).agents.get("agent-1");
    assert.equal(apAfterReject.inbox.length, 1);
    assert.equal(apAfterReject.notifications.pendingCount, 1);
    assert.equal(apAfterReject.gatedSteering.isIdle, true);
    assert.equal(apAfterReject.notifications.hasContributedMessage(message, "session-1"), false);
    assert.equal(
      sent.slice(sentBeforeReject).some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "error"),
      false,
      "async idle delivery rejection must not become visible runtime error activity",
    );

    const rejectionTrace = sink.getAllSpans().find((span) => span.name === "daemon.agent.stdin_delivery.async_rejected");
    assert.equal(rejectionTrace?.attrs?.request_method, "turn/start");
    assert.equal(rejectionTrace?.attrs?.restored_messages_count, 1);
    assert.equal(rejectionTrace?.attrs?.pending_notification_count_after, 1);
    assert.equal(rejectionTrace?.attrs?.restored_idle_state, true);
    assert.equal(rejectionTrace?.attrs?.idle_retry_scheduled, true);

    assert.equal(apAfterReject.notifications.hasTimer, true);
    await waitFor(() => driver.encodedCalls.length === 2, "async rejected idle delivery retry");

    const apAfterRetry = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls[1].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[1].text, "keep this visible after rejected turn start");
    assert.equal(apAfterRetry.inbox.length, 1);
    assert.equal(apAfterRetry.notifications.pendingCount, 0);
    assert.equal(apAfterRetry.notifications.hasContributedMessage(message, "session-1"), true);
    assert.equal(apAfterRetry.gatedSteering.isIdle, false);
    assert.equal(
      sent.slice(sentBeforeReject).some((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "error"),
      false,
      "idle retry after async rejection must not emit runtime error activity",
    );
  }, { driver, tracer, stdinNotificationRetryMs: 25 });
});

test("Pi typed deferred rejection restores busy and idle delivery debt", async () => {
  const driver = new FakeCodexDriver({
    id: "pi",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-busy", makeConfig({
      name: "agent-busy",
      runtime: "pi",
      sessionId: "pi-session-busy",
    }));
    const busyMessage = makeMessage("restore rejected Pi steer", {
      message_id: "pi-busy-rejected-message",
      seq: 6202001,
    });
    manager.deliverMessage("agent-busy", busyMessage);
    (manager as any).sendStdinNotification("agent-busy");
    const busyAp = (manager as any).agents.get("agent-busy");
    assert.equal(busyAp.notifications.hasContributedMessage(busyMessage, "pi-session-busy"), true);

    driver.parsedLines.set("pi-busy-delivery-error", [{
      kind: "delivery_error",
      message: "Pi SDK rejected steer",
      requestMethod: "turn/steer",
      source: "pi_sdk_response",
      code: "runtime.delivery_error",
      payloadBytes: 31,
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("pi-busy-delivery-error\n"));
    await flush();

    assert.equal(busyAp.notifications.pendingCount, 1);
    assert.equal(busyAp.notifications.hasContributedMessage(busyMessage, "pi-session-busy"), false);

    await manager.startAgent("agent-idle", makeConfig({
      name: "agent-idle",
      runtime: "pi",
      sessionId: "pi-session-idle",
    }));
    driver.parsedLines.set("pi-idle-turn-end", [{ kind: "turn_end", sessionId: "pi-session-idle" }]);
    driver.processes[1].stdout.emit("data", Buffer.from("pi-idle-turn-end\n"));
    await flush();

    const idleMessage = makeMessage("restore rejected Pi prompt", {
      message_id: "pi-idle-rejected-message",
      seq: 6202002,
    });
    manager.deliverMessage("agent-idle", idleMessage);
    await flush();
    const idleAp = (manager as any).agents.get("agent-idle");
    assert.equal(idleAp.notifications.hasContributedMessage(idleMessage, "pi-session-idle"), true);

    const errorActivityCountBefore = sent.filter((msg) =>
      msg.type === "agent:activity" && msg.activity === "error"
    ).length;
    driver.parsedLines.set("pi-idle-delivery-error", [{
      kind: "delivery_error",
      message: "Pi SDK rejected prompt",
      requestMethod: "turn/start",
      source: "pi_sdk_response",
      code: "runtime.delivery_error",
      payloadBytes: 32,
    }]);
    driver.processes[1].stdout.emit("data", Buffer.from("pi-idle-delivery-error\n"));
    await flush();

    assert.equal(idleAp.gatedSteering.isIdle, true);
    assert.equal(idleAp.notifications.pendingCount, 1);
    assert.equal(idleAp.notifications.hasContributedMessage(idleMessage, "pi-session-idle"), false);
    assert.equal(idleAp.notifications.hasTimer, true);
    await waitFor(() => driver.encodedCalls.length === 3, "Pi async rejected idle retry");
    assert.equal(driver.encodedCalls.at(-1)?.mode, "idle");
    assertContentFreeInboxUpdatePrompt(
      driver.encodedCalls.at(-1)?.text ?? "",
      "restore rejected Pi prompt",
    );
    assert.equal(
      sent.filter((msg) => msg.type === "agent:activity" && msg.activity === "error").length,
      errorActivityCountBefore,
      "Pi delivery rejection must not surface as terminal runtime error activity",
    );

    const piRejections = sink.getAllSpans().filter((span) =>
      span.name === "daemon.agent.stdin_delivery.async_rejected"
      && span.attrs?.source === "pi_sdk_response"
    );
    assert.deepEqual(piRejections.map((span) => span.attrs?.request_method).sort(), [
      "turn/start",
      "turn/steer",
    ]);
    assert.doesNotMatch(
      JSON.stringify(piRejections.map((span) => span.attrs)),
      /restore rejected Pi steer|restore rejected Pi prompt/u,
      "Pi async rejection traces must remain content-free",
    );
  }, { driver, tracer, stdinNotificationRetryMs: 10 });
});

test("codex re-queues busy direct delivery when encode fails and delivers on turn_end", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    failEncodeModes: ["busy"],
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("keep this queued"));
    (manager as any).sendStdinNotification("agent-1");

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.pendingCount, 1);
    assert.equal(ap.notifications.hasTimer, false);
    assert.equal(driver.encodedCalls.length, 0);

    (manager as any).sendStdinNotification("agent-1");
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.notifications.pendingCount, 1);
    assert.equal(ap.notifications.hasTimer, false);
    assert.equal(driver.encodedCalls.length, 0);

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "keep this queued");
  }, { driver });
});

test("codex retries failed busy notification only after runtime progress can reopen steering", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    failEncodeModes: ["busy"],
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    manager.deliverMessage("agent-1", makeMessage("keep this visible during a long turn"));
    (manager as any).sendStdinNotification("agent-1");

    const apAfterFailure = (manager as any).agents.get("agent-1");
    assert.equal(apAfterFailure.inbox.length, 1);
    assert.equal(apAfterFailure.notifications.pendingCount, 1);
    assert.equal(apAfterFailure.notifications.hasTimer, false);
    assert.equal(driver.encodedCalls.length, 0);

    (manager as any).sendStdinNotification("agent-1");
    const apAfterDuplicate = (manager as any).agents.get("agent-1");
    assert.equal(apAfterDuplicate.notifications.pendingCount, 1);
    assert.equal(apAfterDuplicate.notifications.hasTimer, false);
    assert.equal(driver.encodedCalls.length, 0);

    vi.advanceTimersByTime(1_000);
    assert.equal(driver.encodedCalls.length, 0, "unsupported busy encode must not blind-retry on a fixed timer");

    driver.failEncodeModes.delete("busy");
    driver.parsedLines.set("progress", [{ kind: "text", text: "still working" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("progress\n"));

    const apAfterRetry = (manager as any).agents.get("agent-1");
    assert.equal(apAfterRetry.notifications.pendingCount, 0);
    assert.equal(apAfterRetry.notifications.hasTimer, false);
    assert.equal(driver.encodedCalls[0].mode, "busy");
    assert.match(driver.encodedCalls[0].text, /Inbox update:/);
    assert.doesNotMatch(driver.encodedCalls[0].text, /keep this visible during a long turn/);
  }, { driver, stdinNotificationRetryMs: 1 });
});

test("codex drains re-queued inbox on the first recovery turn after a tool-timeout error", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    failEncodeModes: ["busy"],
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    manager.deliverMessage("agent-1", makeMessage("process this after the timeout"));
    (manager as any).sendStdinNotification("agent-1");

    const apBeforeRecovery = (manager as any).agents.get("agent-1");
    assert.equal(apBeforeRecovery.inbox.length, 1);
    assert.equal(driver.encodedCalls.length, 0);

    driver.parsedLines.set("tool-timeout", [
      { kind: "error", message: "read_history timed out after 60000ms (target: #engineering)" },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-timeout\n"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "process this after the timeout");

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /read_history timed out/i);

    const workingEvent = findLastActivity(sent, "working");
    assert.ok(workingEvent && workingEvent.type === "agent:activity");
    assert.match(workingEvent.detail, /Message received/);

    const apAfterRecovery = (manager as any).agents.get("agent-1");
    assert.equal(apAfterRecovery.inbox.length, 1);
  }, { driver });
});

test("codex fail point cools down idle delivery after a recoverable terminal runtime error without re-contributing old inbox rows", async () => {
  const realDateNow = Date.now;
  let now = 1_000_000;
  const cooldownFailPoint = "failpoint: recoverable terminal runtime error";
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  (Date as any).now = () => now;
  try {
    await withManager(async ({ manager, sent }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

      driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
      await flush();

      manager.deliverMessage("agent-1", makeMessage("message that trips the quota limit", {
        channel_id: "channel-quota-limit",
        channel_name: "quota-limit",
        message_id: "message-quota-limit",
      }));
      await flush();

      assert.equal(driver.encodedCalls.length, 1);
      assert.equal(driver.encodedCalls[0].mode, "idle");
      assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "message that trips the quota limit");
      assert.match(driver.encodedCalls[0].text, /#quota-limit/);

      driver.parsedLines.set("cooldown-failpoint", [
        { kind: "error", message: cooldownFailPoint },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from("cooldown-failpoint\n"));
      await flush();

      const apAfterError = (manager as any).agents.get("agent-1");
      assert.equal(apAfterError.gatedSteering.isIdle, true);
      assert.equal(apAfterError.inbox.length, 1);
      assert.equal(apAfterError.notifications.pendingCount, 0);
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.attempts, 1);
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.untilMs, now + 100_000);

      const errorEvent = findLastActivity(sent, "error");
      assert.ok(errorEvent && errorEvent.type === "agent:activity");
      assert.match(errorEvent.detail, /failpoint/);

      const postErrorActivity = [...sent].reverse().find((msg) => msg.type === "agent:activity");
      assert.ok(postErrorActivity && postErrorActivity.type === "agent:activity");
      assert.equal(projectFactActivity(postErrorActivity), "error");
      assert.match(postErrorActivity.detail, /failpoint/);

      manager.deliverMessage("agent-1", makeMessage("retry after credits are restored", {
        channel_id: "channel-retry-restored",
        channel_name: "retry-restored",
        message_id: "message-retry-restored",
      }));
      await flush();

      const apDuringCooldown = (manager as any).agents.get("agent-1");
      assert.equal(apDuringCooldown.inbox.length, 2);
      assert.equal(driver.encodedCalls.length, 1, "cooldown must batch the retry instead of starting a turn immediately");

      now += 99_999;
      assert.equal((manager as any).flushRuntimeErrorDeliveryBackoff("agent-1"), false);
      assert.equal(driver.encodedCalls.length, 1);

      now += 1;
      assert.equal((manager as any).flushRuntimeErrorDeliveryBackoff("agent-1"), true);

      assert.equal(driver.encodedCalls.length, 2);
      assert.equal(driver.encodedCalls[1].mode, "idle");
      assertContentFreeInboxUpdatePrompt(driver.encodedCalls[1].text, [
        "message that trips the quota limit",
        "retry after credits are restored",
      ]);
      assert.match(driver.encodedCalls[1].text, /Inbox update: 2 unread messages total; 1 changed target/);
      assert.match(driver.encodedCalls[1].text, /#retry-restored/);
      assert.doesNotMatch(driver.encodedCalls[1].text, /#quota-limit/);
      assert.equal(apDuringCooldown.inbox.length, 2);
      assert.equal(apDuringCooldown.notifications.pendingCount, 0);
    }, {
      driver,
      runtimeErrorDeliveryBackoff: {
        baseMs: 100_000,
        maxMs: 100_000,
        jitterRatio: 0,
        failPointForTesting: ({ message }) => message === cooldownFailPoint
          ? {
            terminalFailure: { detail: "Synthetic recoverable terminal runtime failure", actionRequired: false },
            stickyTerminalFailure: null,
            reason: "test_recoverable_terminal_runtime_error",
          }
          : undefined,
      },
    });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("manual restart clears runtime error delivery cooldown state", async () => {
  const cooldownFailPoint = "failpoint: restart clears cooldown";
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("message that hits upstream 429"));
    await flush();

    driver.parsedLines.set("cooldown-failpoint", [
      { kind: "error", message: cooldownFailPoint },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("cooldown-failpoint\n"));
    await flush();

    const apAfterError = (manager as any).agents.get("agent-1");
    assert.equal(apAfterError.runtimeErrorDeliveryBackoff.attempts, 1);
    assert.ok(apAfterError.runtimeErrorDeliveryBackoff.untilMs > Date.now());

    await manager.stopAgent("agent-1");
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-2" }));

    const apAfterRestart = (manager as any).agents.get("agent-1");
    assert.equal(apAfterRestart.runtimeErrorDeliveryBackoff.attempts, 0);
    assert.equal(apAfterRestart.runtimeErrorDeliveryBackoff.untilMs, 0);
    assert.equal(apAfterRestart.runtimeErrorDeliveryBackoff.reason, null);
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 100_000,
      maxMs: 100_000,
      jitterRatio: 0,
      failPointForTesting: ({ message }) => message === cooldownFailPoint
        ? {
          terminalFailure: null,
          stickyTerminalFailure: null,
          reason: "test_restart_recoverable_error",
        }
        : undefined,
    },
  });
});

test("codex fail point retires sticky terminal runtime errors without delivery cooldown", async () => {
  const stickyFailPoint = "failpoint: sticky terminal runtime error";
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("message before sticky failure"));
    await flush();

    driver.parsedLines.set("sticky-failpoint", [
      { kind: "error", message: stickyFailPoint },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("sticky-failpoint\n"));
    await flush();

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
    const terminalFailure = (manager as any).lifecycleRecords.terminalFailures.get("agent-1");
    assert.ok(terminalFailure);
    assert.equal(terminalFailure.detail, "Synthetic sticky terminal runtime failure");
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 100_000,
      maxMs: 100_000,
      jitterRatio: 0,
      failPointForTesting: ({ message }) => message === stickyFailPoint
        ? {
          terminalFailure: { detail: "Synthetic sticky terminal runtime failure", actionRequired: false },
          stickyTerminalFailure: { detail: "Synthetic sticky terminal runtime failure", actionRequired: false },
          reason: "test_sticky_must_not_cool_down",
        }
        : undefined,
    },
  });
});

test("codex auth refresh errors terminate the stale process and require explicit restart", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("message that hits invalidated Codex auth"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");

    driver.parsedLines.set("codex-auth-error", [
      {
        kind: "error",
        message: "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("codex-auth-error\n"));
    await flush();
    await flush();

    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      "expected auth-required runtime errors to mark the agent inactive",
    );

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(
      errorEvent.detail,
      "Codex CLI is not logged in on this machine. Please log in to Codex CLI locally, then retry starting this agent.",
    );

    manager.deliverMessage("agent-1", makeMessage("do not route into stale auth process"));
    await flush();
    await flush();

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(driver.encodedCalls.length, 1);
  }, { driver });
});

test("generic provider 403 errors remain non-auth failures without terminating the runtime", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("provider-forbidden", [
      { kind: "error", message: "API Error: 403 Request not allowed" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("provider-forbidden\n"));
    await flush();

    assert.deepEqual(driver.processes[0].killedSignals, []);
    assert.equal((manager as any).agents.has("agent-1"), true);
    assert.equal(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      false,
    );

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(errorEvent.detail, "API Error: 403 Request not allowed");
    assert.equal(errorEvent.runtimeError?.errorClass, "ProviderApiError");
    assert.equal(errorEvent.runtimeError?.errorReason, "provider_api_error");
  }, { driver });
});

test("provider 403 errors with explicit auth evidence still terminate for user reauth", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("provider-auth-forbidden", [
      { kind: "error", message: "API Error: 403 Forbidden: invalid api key" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("provider-auth-forbidden\n"));
    await flush();
    await flush();

    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      "expected an explicit 403 auth failure to mark the agent inactive",
    );

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(
      errorEvent.detail,
      "Codex CLI is not logged in on this machine. Please log in to Codex CLI locally, then retry starting this agent.",
    );
    assert.equal(errorEvent.runtimeError?.errorClass, "AuthError");
    assert.equal(errorEvent.runtimeError?.errorReason, "auth_failed");
  }, { driver });
});

test("codex terminal model errors are not masked by turn_end or clean close", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("message that hits unsupported Codex model"));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");

    const apBeforeFailure = (manager as any).agents.get("agent-1");
    apBeforeFailure.inbox.push(makeMessage("must stay queued until explicit recovery"));
    const queuedBeforeFailure = apBeforeFailure.inbox.length;

    const modelError = "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
    driver.parsedLines.set("codex-model-error-turn-end", [
      { kind: "error", message: modelError },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("codex-model-error-turn-end\n"));
    await flush();

    const apAfterTurnEnd = (manager as any).agents.get("agent-1");
    assert.equal(driver.encodedCalls.length, 1, "turn_end must not deliver queued messages into a terminally failed runtime");
    assert.equal(apAfterTurnEnd, undefined, "terminal runtime errors must retire the stale runtime entry");
    assert.equal((manager as any).startingInboxes.values("agent-1").length, queuedBeforeFailure, "queued work must wait for explicit recovery");
    assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"], "terminal runtime errors should stop the stale process");
    const cleanupSpan = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.terminal_runtime_error.cleanup"
    );
    assert.ok(cleanupSpan, "terminal cleanup should be visible in daemon tracing");
    assert.equal(cleanupSpan.status, "error");
    assert.equal(cleanupSpan.attrs?.runtime, "codex");
    assert.equal(cleanupSpan.attrs?.model, "gpt-5.3-codex");
    assert.equal(cleanupSpan.attrs?.inbox_count, queuedBeforeFailure);
    assert.equal(cleanupSpan.attrs?.process_pid_present, false);

    const lastAfterTurnEnd = [...sent].reverse().find((msg) => msg.type === "agent:activity");
    assert.ok(lastAfterTurnEnd && lastAfterTurnEnd.type === "agent:activity");
    assert.equal(projectFactActivity(lastAfterTurnEnd), "error");
    assert.match(lastAfterTurnEnd.detail, /model is not supported/i);
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      "terminal model errors should mark the lane inactive at turn_end",
    );

    manager.deliverMessage("agent-1", makeMessage("do not route into the terminally failed runtime"));
    await flush();

    const apAfterBlockedDelivery = (manager as any).agents.get("agent-1");
    assert.equal(
      driver.encodedCalls.length,
      1,
      "new messages must not be delivered into a terminally failed runtime before explicit recovery",
    );
    assert.equal(apAfterBlockedDelivery, undefined, "queued messages must not recreate a stale running entry");
    assert.equal((manager as any).startingInboxes.values("agent-1").length, queuedBeforeFailure + 1);

    const lastAfterBlockedDelivery = [...sent].reverse().find((msg) => msg.type === "agent:activity");
    assert.ok(lastAfterBlockedDelivery && lastAfterBlockedDelivery.type === "agent:activity");
    assert.equal(projectFactActivity(lastAfterBlockedDelivery), "error");
    assert.match(lastAfterBlockedDelivery.detail, /model is not supported/i);

    const beforeExplicitRecoveryMessageCount = sent.length;
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-2" }),
      makeMessage("explicit recovery start"),
      undefined,
      undefined,
      "launch-2",
    );
    await flush();

    assert.equal(driver.spawnCalls.length, 2, "explicit recovery start should spawn a fresh runtime");
    assert.equal((manager as any).agents.has("agent-1"), true);
    assert.equal((manager as any).lifecycleRecords.terminalFailures.has("agent-1"), false);
    assert.equal((manager as any).startingInboxes.has("agent-1"), false);

    driver.processes[1].exit(0);
    driver.processes[1].close(0);
    await flush();

    const lastAfterClose = [...sent].reverse().find((msg) => msg.type === "agent:activity");
    assert.ok(lastAfterClose && lastAfterClose.type === "agent:activity");
    assert.equal(projectFactActivity(lastAfterClose), "offline");
    assert.match(lastAfterClose.detail, /Crashed/);
    assert.ok(
      sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"),
      "terminal model errors should not leave the owner lane projected online",
    );

    const errorIndex = sent.findIndex((msg) =>
      msg.type === "agent:activity" && projectFactActivity(msg) === "error" && /model is not supported/i.test(msg.detail)
    );
    assert.ok(errorIndex >= 0);
    const onlineAfterError = sent.slice(errorIndex + 1, beforeExplicitRecoveryMessageCount).find((msg) => msg.type === "agent:activity" && projectFactActivity(msg) === "online");
    assert.equal(onlineAfterError, undefined, "online projection must not mask the terminal model error");
  }, { driver, tracer });
});

test("stdin runtime keeps a result error visible after turn_end until new work starts", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
      busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    driver.parsedLines.set("image-error-turn-end", [
      {
        kind: "error",
        message: "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.",
      },
      { kind: "turn_end", sessionId: "session-1" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("image-error-turn-end\n"));
    await flush();

    const lastActivity = [...sent].reverse().find((msg) => msg.type === "agent:activity");
    assert.ok(lastActivity && lastActivity.type === "agent:activity");
    assert.equal(projectFactActivity(lastActivity), "error");
    assert.match(lastActivity.detail, /dimension limit/i);

    const apAfterError = (manager as any).agents.get("agent-1");
    assert.equal(apAfterError.gatedSteering.isIdle, true);
    assert.match(apAfterError.lastRuntimeError, /dimension limit/i);

    manager.deliverMessage("agent-1", makeMessage("retry with no images"));
    await flush();

    const apAfterRetry = (manager as any).agents.get("agent-1");
    assert.equal(apAfterRetry.lastRuntimeError, null);
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");
    assertContentFreeInboxUpdatePrompt(driver.encodedCalls[0].text, "retry with no images");

    const lastAfterRetry = [...sent].reverse().find((msg) => msg.type === "agent:activity");
    assert.ok(lastAfterRetry && lastAfterRetry.type === "agent:activity");
    assert.equal(projectFactActivity(lastAfterRetry), "working");
    assert.equal(lastAfterRetry.detail, "Message received");

    driver.processes[0].exit(0);
    driver.processes[0].close(0);
  }, { driver });
});

test("codex fail point cools down busy delivery after recoverable provider errors", async () => {
  const realDateNow = Date.now;
  let now = 2_000_000;
  const cooldownFailPoint = "failpoint: recoverable provider error";
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  (Date as any).now = () => now;
  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

      driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
      await flush();

      manager.deliverMessage("agent-1", makeMessage("message during provider instability"));
      await flush();

      assert.equal(driver.encodedCalls.length, 1);
      assert.equal(driver.encodedCalls[0].mode, "idle");

      driver.parsedLines.set("cooldown-failpoint", [
        { kind: "error", message: cooldownFailPoint },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from("cooldown-failpoint\n"));
      await flush();

      const apAfterError = (manager as any).agents.get("agent-1");
      assert.equal(apAfterError.gatedSteering.isIdle, false);
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.attempts, 1);

      manager.deliverMessage("agent-1", makeMessage("do not reset this active turn"));
      (manager as any).sendStdinNotification("agent-1");

      assert.equal(driver.encodedCalls.length, 1, "provider-error cooldown should suppress immediate busy wake");

      now += 100_000;
      assert.equal((manager as any).flushRuntimeErrorDeliveryBackoff("agent-1"), true);

      assert.equal(driver.encodedCalls.length, 2);
      assert.equal(driver.encodedCalls[1].mode, "busy");
      assert.match(driver.encodedCalls[1].text, /Inbox update:/);
      assert.doesNotMatch(driver.encodedCalls[1].text, /do not reset this active turn/);
    }, {
      driver,
      runtimeErrorDeliveryBackoff: {
        baseMs: 100_000,
        maxMs: 100_000,
        jitterRatio: 0,
        failPointForTesting: ({ message }) => message === cooldownFailPoint
          ? {
            terminalFailure: null,
            stickyTerminalFailure: null,
            reason: "test_recoverable_provider_error",
          }
          : undefined,
      },
    });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("codex unknown non-sticky runtime errors enter delivery cooldown", async () => {
  const realDateNow = Date.now;
  let now = 3_000_000;
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  (Date as any).now = () => now;
  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

      driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
      await flush();

      manager.deliverMessage("agent-1", makeMessage("message before unknown runtime error"));
      await flush();

      assert.equal(driver.encodedCalls.length, 1);
      assert.equal(driver.encodedCalls[0].mode, "idle");

      driver.parsedLines.set("unknown-runtime-error", [
        { kind: "error", message: "worker died with unclassified upstream failure" },
      ]);
      driver.processes[0].stdout.emit("data", Buffer.from("unknown-runtime-error\n"));
      await flush();

      const apAfterError = (manager as any).agents.get("agent-1");
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.attempts, 1);
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.reason, "runtime_error");
      assert.equal(apAfterError.runtimeErrorDeliveryBackoff.untilMs, now + 100_000);

      manager.deliverMessage("agent-1", makeMessage("message batched by unknown-error cooldown"));
      (manager as any).sendStdinNotification("agent-1");

      assert.equal(driver.encodedCalls.length, 1, "unknown-error cooldown should suppress immediate retry wake");

      now += 100_000;
      assert.equal((manager as any).flushRuntimeErrorDeliveryBackoff("agent-1"), true);

      assert.equal(driver.encodedCalls.length, 2);
      assert.equal(driver.encodedCalls[1].mode, "busy");
      assert.match(driver.encodedCalls[1].text, /Inbox update:/);
      assert.doesNotMatch(driver.encodedCalls[1].text, /message batched by unknown-error cooldown/);
    }, {
      driver,
      runtimeErrorDeliveryBackoff: {
        baseMs: 100_000,
        maxMs: 100_000,
        jitterRatio: 0,
      },
    });
  } finally {
    (Date as any).now = realDateNow;
  }
});

test("cold start wakeMessage enters the first prompt as a content-free inbox update", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: null }),
      makeMessage("hello from cold start", {
        message_id: "wake-message-1",
        producerFactId: "fact-wake-readout",
      }),
    );

    assert.equal(driver.spawnCalls.length, 1);
    assert.match(driver.spawnCalls[0].prompt, /^\[Raft inbox notice:/);
    assert.match(driver.spawnCalls[0].prompt, /Inbox update: .*1 changed target/);
    assert.match(driver.spawnCalls[0].prompt, /#general/);
    assert.doesNotMatch(driver.spawnCalls[0].prompt, /hello from cold start/);
    assert.doesNotMatch(driver.spawnCalls[0].prompt, /producerFactId=fact-wake-readout/);
    assert.doesNotMatch(driver.spawnCalls[0].prompt, /^New message received:/);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.inbox[0]?.message_id, "wake-message-1");
  });
});

test("transient cold start wakeMessage enters prompt once without pending inbox retention", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: null }),
      makeMessage("Reminder: write the update", {
        message_id: undefined,
        channel_type: "dm",
        channel_name: "HaoHao",
        sender_name: "system",
        sender_type: "system",
      }),
      undefined,
      undefined,
      undefined,
      true,
    );

    assert.equal(driver.spawnCalls.length, 1);
    assert.match(driver.spawnCalls[0].prompt, /^System notice received:/);
    assert.match(driver.spawnCalls[0].prompt, /Reminder: write the update/);
    assert.doesNotMatch(driver.spawnCalls[0].prompt, /^\[Raft inbox notice:/);
    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.inbox.length, 0);
  });
});

function makeThreadContextMention(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return makeMessage("@kuku can you take a look?", {
    channel_name: "thread-a1b2c3d4",
    channel_type: "thread",
    parent_channel_name: "engineering",
    parent_channel_type: "channel",
    message_id: "f3a4b5c6-d7e8-49f0-a111-222233334444",
    seq: 122,
    thread_join_context: {
      reason: "mentioned",
      parent_target: "#engineering",
      thread_target: "#engineering:a1b2c3d4",
      suggested_read_history_target: "#engineering:a1b2c3d4",
      parent_message: {
        message_id: "a1b2c3d4-0000-4000-8000-111122223333",
        sender_name: "xxchan",
        sender_type: "human",
        content: "设计一个改进方案",
        timestamp: "2026-04-08T19:09:59.000Z",
        seq: 120,
      },
      recent_messages: [
        {
          message_id: "b1b2c3d4-0000-4000-8000-111122223333",
          sender_name: "Ray",
          sender_type: "agent",
          content: "我建议先加 thread-enter event。",
          timestamp: "2026-04-08T19:10:32.000Z",
          seq: 121,
        },
      ],
      history_truncated: false,
    },
    ...overrides,
  });
}

test("model-unseen thread context is rendered and receipted ahead of the triggering wake message", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: null }),
      makeThreadContextMention(),
    );

    assert.equal(driver.spawnCalls.length, 1);
    assert.match(driver.spawnCalls[0].prompt, /^New message received:/);
    assert.match(driver.spawnCalls[0].prompt, /mentioned in a thread without model-visible context/);
    assert.match(driver.spawnCalls[0].prompt, /msg=a1b2c3d4 seq=120/);
    assert.match(driver.spawnCalls[0].prompt, /msg=b1b2c3d4 seq=121/);
    assert.match(driver.spawnCalls[0].prompt, /设计一个改进方案/);
    assert.match(driver.spawnCalls[0].prompt, /我建议先加 thread-enter event。/);
    assert.match(driver.spawnCalls[0].prompt, /@kuku can you take a look\?/);
    assert.match(driver.spawnCalls[0].prompt, /#engineering:a1b2c3d4/);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering:a1b2c3d4"), 121);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering"), undefined);
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering")?.has(
        "a1b2c3d4-0000-4000-8000-111122223333",
      ),
      true,
    );
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering:a1b2c3d4")?.has(
        "b1b2c3d4-0000-4000-8000-111122223333",
      ),
      true,
    );
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering:a1b2c3d4")?.has(
        "f3a4b5c6-d7e8-49f0-a111-222233334444",
      ),
      true,
    );
  });
});

test("existing thread model-seen boundary keeps repeated context out of runtime input", async () => {
  await withManager(async ({ driver, manager }) => {
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [makeThreadContextMention({
        content: "prior model-visible thread message",
        message_id: "prior-thread-message-id",
        seq: 119,
        thread_join_context: undefined,
      })],
      source: "verified_contiguous_content_consumption",
    });

    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: null }),
      makeThreadContextMention(),
    );

    assert.equal(driver.spawnCalls.length, 1);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[0].prompt, [
      /thread context/,
      /设计一个改进方案/,
      /我建议先加 thread-enter event。/,
      /@kuku can you take a look\?/,
    ]);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering:a1b2c3d4"), 119);
    assert.equal((manager as any).getVisibleMessageIdSet("agent-1", "#engineering"), undefined);
  });
});

test("idle stdin renders model-unseen thread context and writes the same receipts", async () => {
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeThreadContextMention());
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.match(driver.encodedCalls[0].text, /^New message received:/);
    assert.match(driver.encodedCalls[0].text, /msg=a1b2c3d4 seq=120/);
    assert.match(driver.encodedCalls[0].text, /msg=b1b2c3d4 seq=121/);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering:a1b2c3d4"), 121);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering"), undefined);
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering")?.has(
        "a1b2c3d4-0000-4000-8000-111122223333",
      ),
      true,
    );
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering:a1b2c3d4")?.has(
        "b1b2c3d4-0000-4000-8000-111122223333",
      ),
      true,
    );
    assert.equal(
      (manager as any).getVisibleMessageIdSet("agent-1", "#engineering:a1b2c3d4")?.has(
        "f3a4b5c6-d7e8-49f0-a111-222233334444",
      ),
      true,
    );

    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();
    manager.deliverMessage("agent-1", makeThreadContextMention({
      content: "new reply that arrived after the context package",
      message_id: "newer-thread-message-id",
      seq: 123,
      thread_join_context: undefined,
    }));
    await flush();

    assert.equal(driver.encodedCalls.length, 2);
    assertContentFreeInboxUpdatePrompt(
      driver.encodedCalls[1].text,
      "new reply that arrived after the context package",
    );
    assert.equal((manager as any).agents.get("agent-1").inbox.length, 1);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering:a1b2c3d4"), 121);
  }, { driver });
});

test("failed stdin rendering leaves thread context unreceipted and retryable", async () => {
  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    failEncodeModes: ["idle"],
  });
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeThreadContextMention());
    await flush();

    assert.equal(driver.encodedCalls.length, 0);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#engineering:a1b2c3d4"), undefined);
    assert.equal((manager as any).getVisibleMessageIdSet("agent-1", "#engineering"), undefined);
    assert.equal((manager as any).getVisibleMessageIdSet("agent-1", "#engineering:a1b2c3d4"), undefined);
    assert.equal((manager as any).agents.get("agent-1").inbox.length, 1);
  }, { driver });
});

test("notify-only outsider mention renders an honest reply limitation", async () => {
  const driver = new FakeCodexDriver({
    id: "direct",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.parsedLines.set("turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("@codex-agent please review", {
      mentioned: true,
      non_member_mention: true,
    }));
    await flush();

    assert.equal(driver.encodedCalls.length, 1);
    assert.match(driver.encodedCalls[0].text, /^\[Raft inbox notice:/);
    assert.match(driver.encodedCalls[0].text, /you were mentioned/);
    assert.match(
      driver.encodedCalls[0].text,
      /If no reply is needed, no action is required\. Otherwise, DM the person who mentioned you or join the channel to participate/,
    );
  }, { driver });
});

test("crash activity detail includes stderr and runtime error context", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.processes[0].stderr.emit("data", Buffer.from("fatal: provider process crashed\n"));
    driver.parsedLines.set("{\"type\":\"error\"}", [{ kind: "error", message: "Provider failed" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("{\"type\":\"error\"}\n"));
    driver.processes[0].exit(-1);
    driver.processes[0].close(-1);
    await flush();

    const offlineEvent = findLastActivity(sent, "offline");
    assert.ok(offlineEvent && offlineEvent.type === "agent:activity");
    assert.match(offlineEvent.detail, /exit code -1/);
    assert.doesNotMatch(offlineEvent.detail, /Provider failed/);
    assert.doesNotMatch(offlineEvent.detail, /fatal: provider process crashed/);
  });
});

test("terminal login-required failures are surfaced as action-oriented activity", async () => {
  const driver = new FakeCodexDriver({
    id: "antigravity",
    supportsStdinNotification: false,
    busyDeliveryMode: "none",
  });

  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "antigravity", sessionId: "session-1" }));

    driver.parsedLines.set("login-required", [{
      kind: "error",
      message: "Antigravity CLI is not logged in. Please log in first.",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("login-required\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(
      errorEvent.detail,
      "Antigravity CLI is not logged in on this machine. Please log in to Antigravity CLI locally, then retry starting this agent.",
    );
    const textEntry = errorEvent.entries?.find((entry) => entry.kind === "text");
    assert.ok(textEntry && textEntry.kind === "text");
    assert.match(textEntry.text, /Please log in to Antigravity CLI locally/);
  }, { driver });
});

test("spawn auth failures are surfaced as action-oriented activity", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
      busyDeliveryMode: "direct",
  });

  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "session-1" }));

    driver.processes[0].stderr.emit("data", Buffer.from("Authentication failed: missing API token\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(
      errorEvent.detail,
      "Claude Code is not logged in on this machine. Please log in to Claude Code locally, then retry starting this agent.",
    );
    const textEntries = errorEvent.entries?.filter((entry) => entry.kind === "text").map((entry) => entry.text) ?? [];
    assert.ok(textEntries.some((text) => text.includes("Runtime auth diagnostic: runtime_auth_error")));
    assert.ok(textEntries.some((text) => text.includes("Raw error excerpt (redacted): Authentication failed: missing API token")));
    assert.ok(textEntries.some((text) => text.includes("Claude auth mode: default host login")));
  }, { driver });
});

test("Claude custom provider auth failures point at agent provider config", async () => {
  const driver = new FakeCodexDriver({
    id: "claude",
    supportsStdinNotification: true,
      busyDeliveryMode: "direct",
  });

  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "claude",
      sessionId: "session-1",
      envVars: {
        ANTHROPIC_BASE_URL: "https://provider.example.test/anthropic",
        ANTHROPIC_API_KEY: "sk-test-secret",
      },
    }));

    driver.processes[0].stderr.emit("data", Buffer.from("Authentication failed: invalid api key sk-test-secret for user test@example.com\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.equal(
      errorEvent.detail,
      "Claude Code custom provider authentication failed. Check this agent's custom Claude provider API key/API URL, then retry starting this agent.",
    );
    const textEntries = errorEvent.entries?.filter((entry) => entry.kind === "text").map((entry) => entry.text) ?? [];
    assert.ok(textEntries.some((text) => text.includes("Runtime auth diagnostic: custom_provider_invalid_key")));
    assert.ok(textEntries.some((text) => text.includes("Raw error excerpt (redacted): Authentication failed: invalid api key [REDACTED_TOKEN] for user [REDACTED_EMAIL]")));
    assert.ok(textEntries.some((text) => text.includes("Claude auth mode: custom provider")));
    assert.ok(textEntries.every((text) => !text.includes("sk-test-secret")));
    assert.ok(textEntries.every((text) => !text.includes("test@example.com")));
  }, { driver });
});

test("Codex startup request errors fail closed before routing later deliveries", async () => {
  const cases = [
    {
      method: "initialize" as const,
      sessionId: "session-1",
      line: "initialize-error",
      detail: "initialize rejected by app-server",
    },
    {
      method: "thread/resume" as const,
      sessionId: "forbidden-thread-1",
      line: "resume-permission-error",
      detail: "No permission to access thread forbidden-thread-1",
    },
    {
      method: "turn/start" as const,
      sessionId: null,
      line: "initial-turn-error",
      detail: "initial turn rejected by app-server",
    },
  ];

  for (const specimen of cases) {
    const { sink, tracer, traceId } = makeDeterministicTracer();
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: specimen.sessionId }));
      driver.parsedLines.set(specimen.line, [{
        kind: "error",
        message: specimen.detail,
        startupRequestMethod: specimen.method,
      }]);
      driver.processes[0].stdout.emit("data", Buffer.from(`${specimen.line}\n`));
      await waitFor(() => !(manager as any).agents.has("agent-1"), `${specimen.method} startup failure cleanup`);

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
      assert.ok(sent.some((msg) =>
        msg.type === "agent:status"
        && msg.agentId === "agent-1"
        && msg.status === "inactive"
      ));
      const errorEvent = findLastActivity(sent, "error");
      assert.ok(errorEvent && errorEvent.type === "agent:activity");
      assert.equal(errorEvent.detail, specimen.detail);
      if (specimen.method === "initialize") assert.equal(findLastActivity(sent, "offline"), undefined);

      const accepted = manager.deliverMessage("agent-1", makeMessage("must not route after failed startup"));
      assert.equal(accepted, false);
      assert.equal(driver.encodedCalls.length, 0);
      assert.equal(driver.spawnCalls.length, 1);

      if (specimen.method === "initialize") {
        const requestFailedEvent = eventsForSpan(sink, traceId, "daemon.runtime.turn")
          .find((event) => event.name === "runtime.start.request_failed");
        assert.equal(requestFailedEvent?.attrs?.startup_request_method, "initialize");
        assert.equal(requestFailedEvent?.attrs?.runtime_start_failure_kind, "startup_request_error");
        const exitSpan = sink.getAllSpans().find((span) =>
          span.name === "daemon.agent.process.exited" && span.attrs?.stop_source === "startup_request_error"
        );
        assert.equal(exitSpan?.attrs?.expectedTerminationReason, "startup_request_error");
        assert.equal(exitSpan?.attrs?.startup_request_method, "initialize");
      }
    }, { tracer });
  }
});

test("startup timeout surfaces stuck starting runtimes and terminates the process", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  const { sink, tracer, traceId } = makeDeterministicTracer();
  let startupTimeoutCallback: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 2_500) {
      startupTimeoutCallback = callback;
      return { startupTimeout: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.startupTimeout) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "2500";

  const driver = new FakeCodexDriver({
    id: "gemini",
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "gemini",
        model: "gemini-3.1-pro-preview",
        sessionId: "session-1",
      }));

      assert.ok(startupTimeoutCallback, "starting activity should install startup timeout");
      startupTimeoutCallback!();
      await flush();

      const errorEvent = findLastActivity(sent, "error");
      assert.ok(errorEvent && errorEvent.type === "agent:activity");
      assert.equal(
        errorEvent.detail,
        "Gemini CLI did not finish starting on this machine. Check that Gemini CLI is installed, logged in, and can run non-interactively, then retry starting this agent.",
      );
      const timeoutEvent = eventsForSpan(sink, traceId, "daemon.runtime.turn")
        .find((event) => event.name === "runtime.start.timeout");
      assert.equal(timeoutEvent?.attrs?.runtime_start_failure_kind, "runtime_start_timeout");
      assert.equal(timeoutEvent?.attrs?.runtime, "gemini");
      assert.equal(timeoutEvent?.attrs?.model, "gemini-3.1-pro-preview");
      assert.equal(timeoutEvent?.attrs?.platform, process.platform);
      assert.equal(timeoutEvent?.attrs?.arch, process.arch);
      assert.equal(timeoutEvent?.attrs?.timeout_ms, 2_500);
      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      const exitSpan = sink.getAllSpans().find((span) =>
        span.name === "daemon.agent.process.exited" && span.attrs?.stop_source === "startup_timeout"
      );
      assert.equal(exitSpan?.attrs?.expectedTerminationReason, "startup_timeout");
      assert.equal(exitSpan?.attrs?.timeout_ms, 2_500);
      assert.equal((manager as any).agents.has("agent-1"), false);
    }, { driver, tracer });
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = originalTimeout;
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("codex startup timeout waits past session init until the initial turn starts", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  let startupTimeoutCallback: (() => void) | null = null;
  let startupTimeoutCleared = false;
  const startupTimer = { startupTimeout: true };
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 2_500) {
      startupTimeoutCallback = callback;
      return startupTimer;
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if (timer === startupTimer) {
      startupTimeoutCleared = true;
      return;
    }
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "2500";

  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "codex-thread-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
      await flush();

      assert.equal(startupTimeoutCleared, false, "session_init alone must not clear Codex startup timeout");
      assert.ok(startupTimeoutCallback, "starting activity should install startup timeout");
      startupTimeoutCallback!();
      await flush();

      assert.deepEqual(driver.processes[0].killedSignals, ["SIGTERM"]);
      assert.equal((manager as any).agents.has("agent-1"), false);
      const errorEvent = findLastActivity(sent, "error");
      assert.ok(errorEvent && errorEvent.type === "agent:activity");
      assert.match(errorEvent.detail, /Codex.*did not finish starting|codex.*did not finish starting/i);
    }, { driver });
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = originalTimeout;
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("codex startup timeout is cleared once the initial turn starts", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  let startupTimeoutCallback: (() => void) | null = null;
  let startupTimeoutCleared = false;
  const startupTimer = { startupTimeout: true };
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 2_500) {
      startupTimeoutCallback = callback;
      return startupTimer;
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if (timer === startupTimer) {
      startupTimeoutCleared = true;
      return;
    }
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "2500";

  const driver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig());

      driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "codex-thread-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
      await flush();
      assert.equal(startupTimeoutCleared, false, "session_init alone must not clear Codex startup timeout");

      driver.parsedLines.set("turn-started", [{ kind: "thinking", text: "" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("turn-started\n"));
      await flush();
      assert.equal(startupTimeoutCleared, true, "initial turn start must clear Codex startup timeout");

      assert.ok(startupTimeoutCallback, "starting activity should install startup timeout");
      startupTimeoutCallback!();
      await flush();

      assert.equal(driver.processes[0].killedSignals.length, 0);
      assert.equal(findLastActivity(sent, "error"), undefined);
      assert.equal((manager as any).agents.has("agent-1"), true);
    }, { driver });
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = originalTimeout;
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("startup timeout is cleared once the runtime emits a first event", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  let startupTimeoutCallback: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 2_500) {
      startupTimeoutCallback = callback;
      return { startupTimeout: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.startupTimeout) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "2500";

  const driver = new FakeCodexDriver({
    id: "gemini",
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });

  try {
    await withManager(async ({ driver, sent, manager }) => {
      await manager.startAgent("agent-1", makeConfig({
        runtime: "gemini",
        model: "gemini-3.1-pro-preview",
        sessionId: "session-1",
      }));

      driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "gemini-session-1" }]);
      driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
      await flush();

      assert.ok(startupTimeoutCallback, "starting activity should install startup timeout");
      startupTimeoutCallback!();
      await flush();

      assert.equal(driver.processes[0].killedSignals.length, 0);
      assert.equal(findLastActivity(sent, "error"), undefined);
      assert.equal((manager as any).agents.has("agent-1"), true);
    }, { driver });
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = originalTimeout;
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("crash activity detail includes signal and spawn error context", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    driver.processes[0].fail("spawn ENOENT");
    driver.processes[0].exit(null, "SIGTERM");
    driver.processes[0].close(null, "SIGTERM");
    await flush();

    const offlineEvent = findLastActivity(sent, "offline");
    assert.ok(offlineEvent && offlineEvent.type === "agent:activity");
    assert.match(offlineEvent.detail, /signal SIGTERM/);
    assert.doesNotMatch(offlineEvent.detail, /spawn ENOENT/);
  });
});

test("daemon crash log includes stderr that arrives after exit but before close", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      driver.processes[0].exit(-1);
      driver.processes[0].stderr.emit("data", Buffer.from("late fatal line\n"));
      driver.processes[0].close(-1);
      await flush();
    } finally {
      console.error = originalError;
    }

    const crashLine = errors.find((line) => line.includes("Process crashed"));
    assert.ok(crashLine);
    assert.match(crashLine, /late fatal line/);
  });
});

test("daemon crash log falls back to diagnostic stdout when no runtime error or stderr is available", async () => {
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      driver.processes[0].stdout.emit("data", Buffer.from("Error: unexpected status 403 Forbidden: Usage not included in your plan\n"));
      driver.processes[0].exit(1);
      driver.processes[0].close(1);
      await flush();
    } finally {
      console.error = originalError;
    }

    const crashLine = errors.find((line) => line.includes("Process crashed"));
    assert.ok(crashLine);
    assert.match(crashLine, /stdout: Error: unexpected status 403 Forbidden: Usage not included in your plan/);
  }, {
    driver: new FakeCodexDriver({ id: "execlike" }),
  });
});

test("codex structured stdout is not reused as crash diagnostics", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    const fakeSecret = "fake_secret_SHOULD_NOT_LEAK_3102";
    const rawProtocolFrame = JSON.stringify({
      method: "rawResponseItem/completed",
      params: {
        item: {
          type: "message",
          content: fakeSecret,
        },
      },
    });

    try {
      driver.processes[0].stdout.emit("data", Buffer.from(`${rawProtocolFrame}\n`));
      driver.processes[0].exit(1);
      driver.processes[0].close(1);
      await flush();
    } finally {
      console.error = originalError;
    }

    const crashLine = errors.find((line) => line.includes("Process crashed"));
    assert.ok(crashLine);
    assert.doesNotMatch(crashLine, /rawResponseItem\/completed/);
    assert.doesNotMatch(crashLine, /fake_secret_SHOULD_NOT_LEAK_3102/);

    const sentPayload = JSON.stringify(sent);
    assert.doesNotMatch(sentPayload, /rawResponseItem\/completed/);
    assert.doesNotMatch(sentPayload, /fake_secret_SHOULD_NOT_LEAK_3102/);
    const offlineEvent = findLastActivity(sent, "offline");
    assert.ok(offlineEvent && offlineEvent.type === "agent:activity");
    assert.equal(offlineEvent.detail, "Crashed (exit code 1)");
  });
});

test("terminal quota failures are surfaced as error activity with launchId", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.parsedLines.set("{\"type\":\"error\"}", [{ kind: "error", message: "You've hit your usage limit. Upgrade your plan or try again later." }]);
    driver.processes[0].stdout.emit("data", Buffer.from("{\"type\":\"error\"}\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /usage limit/i);
    assert.equal(errorEvent.launchId, "launch-1");

    const lastOfflineEvent = findLastActivity(sent, "offline");
    assert.equal(lastOfflineEvent, undefined);
  });
});

test("codex reconnect stderr is surfaced as working activity instead of an error", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.processes[0].stderr.emit("data", Buffer.from("Reconnecting... 2/5\n"));
    await flush();

    const activity = findLastActivity(sent, "working");
    assert.ok(activity && activity.type === "agent:activity");
    assert.equal(activity.detail, "Codex reconnecting to provider…");
    assert.equal(activity.entries?.[0]?.kind, "text");
    assert.match(String(activity.entries?.[0]?.text), /Reconnecting\.\.\. 2\/5/);

    const ap = (manager as any).agents.get("agent-1");
    assert.deepEqual(ap.recentStderr, ["Reconnecting... 2/5"]);
  }, { driver });
});

test("codex provider stream failures stay wakeable after process close", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    assert.deepEqual(driver.spawnCalls[0]?.config.envVars, {
      OPENAI_BASE_URL: "https://provider-default.example.com/v1",
    });

    driver.parsedLines.set("stream-error", [
      { kind: "error", message: "stream closed before response.completed" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("stream-error\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /stream closed before response\.completed/i);
    assert.equal((manager as any).agents.has("agent-1"), false);
    const cached = (manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1");
    assert.ok(cached, "provider stream failure should keep a restart cache");
    assert.equal(cached.config.agentCredentialKey, undefined);
    assert.equal(cached.config.agentCredentialId, undefined);
    assert.equal(cached.config.envVars ?? undefined, undefined);

    manager.deliverMessage("agent-1", makeMessage("retry after provider stream failure"));
    await waitForExactCount(
      () => driver.spawnCalls.length,
      2,
      "provider stream failure wake restart",
    );

    assert.equal(driver.spawnCalls.length, 2);
    assert.deepEqual(driver.spawnCalls[1]?.config.envVars, {
      OPENAI_BASE_URL: "https://provider-default.example.com/v1",
    });
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "retry after provider stream failure");
  }, {
    driver,
    defaultAgentEnvVarsProvider: async () => ({
      OPENAI_BASE_URL: "https://provider-default.example.com/v1",
    }),
  });
});

test("codex recoverable close preserves the queued wake when cooldown expires before timer dispatch", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    const emitStreamErrorAndClose = (processIndex: number) => {
      const line = `stream-error-${processIndex}`;
      driver.parsedLines.set(line, [
        { kind: "error", message: "stream closed before response.completed" },
      ]);
      driver.processes[processIndex].stdout.emit("data", Buffer.from(`${line}\n`));
      driver.processes[processIndex].exit(1);
      driver.processes[processIndex].close(1);
    };

    emitStreamErrorAndClose(0);
    await flush();
    assert.ok((manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1"));

    const retainedWake = makeMessage("retry obligation retained across timer lag");
    manager.deliverMessage("agent-1", retainedWake);
    await waitFor(() => driver.spawnCalls.length === 2, "first provider stream failure restart");

    emitStreamErrorAndClose(1);
    const cooldown = (manager as any).lifecycleRecords.activeSpawnFailBackoffs.get("agent-1");
    assert.ok(cooldown?.untilMs > (manager as any).clockNow());

    // Model event-loop lag after the deadline but before the already-scheduled
    // restart timer callback. Delivery must not replace the wake obligation that
    // the failed process transferred into recovery ownership.
    cooldown.untilMs = (manager as any).clockNow() - 1;
    const newMessage = makeMessage("new message after cooldown deadline");
    await manager.deliverMessage("agent-1", newMessage);

    assert.equal(driver.spawnCalls.length, 3);
    const restartedInbox = (manager as any).agents.get("agent-1").inbox as AgentMessage[];
    assert.equal(restartedInbox[0], retainedWake, "recovery must retain the original queued-wake object");
    assert.equal(restartedInbox[1], newMessage, "the later message must remain ordered after the retained wake");
    assert.deepEqual(
      restartedInbox.map((message) => message.content),
      [
        "retry obligation retained across timer lag",
        "new message after cooldown deadline",
      ],
    );
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 1_000,
      maxMs: 1_000,
      jitterRatio: 0,
    },
  });
});

test("codex recoverable close timer drains the transferred wake exactly once", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    const emitStreamErrorAndClose = async (processIndex: number) => {
      const line = `stream-error-${processIndex}`;
      driver.parsedLines.set(line, [
        { kind: "error", message: "stream closed before response.completed" },
      ]);
      driver.processes[processIndex].stdout.emit("data", Buffer.from(`${line}\n`));
      driver.processes[processIndex].exit(1);
      driver.processes[processIndex].close(1);
      await flush();
    };

    await emitStreamErrorAndClose(0);
    const transferredWake = makeMessage("single transferred retry obligation");
    manager.deliverMessage("agent-1", transferredWake);
    await waitFor(() => driver.spawnCalls.length === 2, "first provider stream failure restart");

    await emitStreamErrorAndClose(1);
    await waitFor(() => driver.spawnCalls.length === 3, "timer-owned provider stream failure restart");

    assert.equal(driver.spawnCalls.length, 3, "one restart timer must schedule exactly one spawn");
    const restartedInbox = (manager as any).agents.get("agent-1").inbox as AgentMessage[];
    assert.equal(restartedInbox.length, 1, "the transferred wake must be present exactly once");
    assert.equal(restartedInbox[0], transferredWake, "timer restart must drain the original queued-wake object");
    assert.deepEqual(
      restartedInbox.map((message) => message.content),
      ["single transferred retry obligation"],
      "the timer trigger and durable buffer must not both deliver the same wake",
    );
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 5,
      maxMs: 5,
      jitterRatio: 0,
    },
  });
});

test("codex capacity process close retries the same pending obligation after bounded backoff", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("capacity-hit obligation"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1);
    assert.equal(driver.encodedCalls[0].mode, "idle");

    driver.parsedLines.set("capacity-error", [
      { kind: "error", message: "Selected model is at capacity. Please try a different model." },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("capacity-error\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.terminalFailures.has("agent-1"), false);
    assert.ok((manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1"), "capacity failure keeps restart residency");
    assert.equal(driver.spawnCalls.length, 1, "capacity backoff must not restart immediately");
    assert.equal(
      sent.some((msg) => msg.type === "agent:status" && msg.agentId === "agent-1" && msg.status === "inactive"),
      false,
      "capacity failure must not mark the agent inactive",
    );
    const cooldown = (manager as any).lifecycleRecords.activeSpawnFailBackoffs.get("agent-1");
    assert.equal(cooldown?.reason, "rate_limited");
    assert.ok(cooldown?.untilMs > (manager as any).clockNow(), "capacity retry must be bounded by a future backoff deadline");

    await waitFor(() => driver.spawnCalls.length === 2, "capacity backoff retry");
    assert.equal(driver.spawnCalls.length, 2);
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "capacity-hit obligation");

    driver.parsedLines.set("retry-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[1].stdout.emit("data", Buffer.from("retry-turn-end\n"));
    await flush();
    assert.equal((manager as any).lifecycleRecords.activeSpawnFailBackoffs.has("agent-1"), false);
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 25,
      maxMs: 25,
      jitterRatio: 0,
    },
  });
});

test("codex repeated same-fingerprint capacity closes fence before a fourth restart", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    const emitTurnEnd = async (processIndex: number, line: string) => {
      driver.parsedLines.set(line, [{ kind: "turn_end", sessionId: "session-1" }]);
      driver.processes[processIndex].stdout.emit("data", Buffer.from(`${line}\n`));
      await flush();
    };

    const emitCapacityErrorAndClose = async (processIndex: number) => {
      const line = `capacity-error-${processIndex}`;
      driver.parsedLines.set(line, [
        { kind: "error", message: "Selected model is at capacity. Please try a different model." },
      ]);
      driver.processes[processIndex].stdout.emit("data", Buffer.from(`${line}\n`));
      driver.processes[processIndex].exit(1);
      driver.processes[processIndex].close(1);
      await flush();
    };

    await emitTurnEnd(0, "initial-turn-end");

    manager.deliverMessage("agent-1", makeMessage("capacity fence obligation one"));
    await flush();
    await emitCapacityErrorAndClose(0);
    assert.equal(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1")?.attempts,
      1,
      "first capacity failure should stay below the same-fingerprint fence",
    );
    await waitFor(() => driver.spawnCalls.length === 2, "first capacity retry");
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[1].prompt, "capacity fence obligation one");

    manager.deliverMessage("agent-1", makeMessage("capacity fence obligation two"));
    await flush();
    await emitCapacityErrorAndClose(1);
    assert.equal(
      (manager as any).lifecycleRecords.getRuntimeErrorFingerprintFence("agent-1")?.attempts,
      2,
      "second capacity failure should still stay below the same-fingerprint fence",
    );
    await waitFor(() => driver.spawnCalls.length === 3, "second capacity retry");
    assertContentFreeInboxUpdatePrompt(driver.spawnCalls[2].prompt, "capacity fence obligation two");

    manager.deliverMessage("agent-1", makeMessage("capacity fence obligation three"));
    await flush();
    await emitCapacityErrorAndClose(2);

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false, "fenced capacity failure must delete restart residency");
    assert.equal((manager as any).lifecycleRecords.activeSpawnFailBackoffs.has("agent-1"), false, "fenced capacity failure must not leave a close-path retry armed");
    assert.ok(sent.some((msg) => msg.type === "agent:status" && msg.agentId === "agent-1" && msg.status === "inactive"));
    const fencedFailure = (manager as any).lifecycleRecords.terminalFailures.get("agent-1");
    assert.ok(fencedFailure);
    assert.match(fencedFailure.detail, /Runtime stopped after 3 repeated runtime errors with the same fingerprint/);
    assert.match(fencedFailure.detail, /Selected model is at capacity/);

    await flush();
    await flush();
    assert.equal(driver.spawnCalls.length, 3, "fenced same-fingerprint capacity close must not schedule a fourth spawn");
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 5,
      maxMs: 5,
      jitterRatio: 0,
    },
  });
});

test("codex credential process close remains terminal and does not schedule retry", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.parsedLines.set("initial-turn-end", [{ kind: "turn_end", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("initial-turn-end\n"));
    await flush();

    manager.deliverMessage("agent-1", makeMessage("credential-failure obligation"));
    await flush();
    assert.equal(driver.encodedCalls.length, 1);

    driver.parsedLines.set("credential-error", [
      { kind: "error", message: "Authentication failed: missing API token" },
    ]);
    driver.processes[0].stdout.emit("data", Buffer.from("credential-error\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    assert.equal(driver.spawnCalls.length, 1, "credential failure must not schedule a retry");
    assert.equal((manager as any).lifecycleRecords.activeSpawnFailBackoffs.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false);
    assert.ok(sent.some((msg) => msg.type === "agent:status" && msg.agentId === "agent-1" && msg.status === "inactive"));
    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /Codex CLI is not logged in/i);
  }, { driver });
});

test("codex repeated same-fingerprint provider stream failures fence idle restarts", async () => {
  const driver = new FakeCodexDriver({
    id: "codex",
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
  });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    const emitStreamErrorAndClose = async (processIndex: number) => {
      const line = `stream-error-${processIndex}`;
      driver.parsedLines.set(line, [
        { kind: "error", message: "stream closed before response.completed" },
      ]);
      driver.processes[processIndex].stdout.emit("data", Buffer.from(`${line}\n`));
      if ((manager as any).agents.has("agent-1")) {
        driver.processes[processIndex].exit(1);
        driver.processes[processIndex].close(1);
      }
      await flush();
    };

    await emitStreamErrorAndClose(0);
    assert.ok((manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1"), "first same-fingerprint failure should stay wakeable");
    manager.deliverMessage("agent-1", makeMessage("retry after first provider stream failure"));
    await waitFor(
      () => driver.spawnCalls.length === 2,
      "first same-fingerprint provider stream failure restart",
    );
    assert.equal(driver.spawnCalls.length, 2);

    await emitStreamErrorAndClose(1);
    assert.ok((manager as any).lifecycleRecords.idleRestartSnapshots.get("agent-1"), "second same-fingerprint failure should still stay wakeable");
    manager.deliverMessage("agent-1", makeMessage("retry after second provider stream failure"));
    await waitFor(
      () => driver.spawnCalls.length === 3,
      "second same-fingerprint provider stream failure restart",
    );
    assert.equal(driver.spawnCalls.length, 3);

    await emitStreamErrorAndClose(2);

    assert.equal((manager as any).agents.has("agent-1"), false);
    assert.equal((manager as any).lifecycleRecords.idleRestartSnapshots.has("agent-1"), false, "fenced same-fingerprint failure must not cache another idle restart");
    const fencedFailure = (manager as any).lifecycleRecords.terminalFailures.get("agent-1");
    assert.ok(fencedFailure);
    assert.match(fencedFailure.detail, /Runtime stopped after 3 repeated runtime errors with the same fingerprint/);
    assert.match(fencedFailure.detail, /stream closed before response\.completed/);

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /Runtime stopped after 3 repeated runtime errors with the same fingerprint/);

    manager.deliverMessage("agent-1", makeMessage("retry after fenced provider stream failure"));
    await flush();

    assert.equal(driver.spawnCalls.length, 3, "fenced same-fingerprint failure should not respawn on the next message");
    const queued = (manager as any).startingInboxes.values("agent-1");
    assert.equal(queued?.length, 3, "fenced retries should be kept pending for explicit recovery");
    assert.deepEqual(queued?.map((message: AgentMessage) => message.content), [
      "retry after first provider stream failure",
      "retry after second provider stream failure",
      "retry after fenced provider stream failure",
    ]);
  }, {
    driver,
    runtimeErrorDeliveryBackoff: {
      baseMs: 5,
      maxMs: 5,
      jitterRatio: 0,
    },
  });
});

test("quota-like text in normal stdout does not get misclassified as terminal runtime error", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.processes[0].stdout.emit("data", Buffer.from("Here are the common causes: usage limit, quota exceeded, model not found.\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.equal(errorEvent, undefined);

    const offlineEvent = findLastActivity(sent, "offline");
    assert.ok(offlineEvent && offlineEvent.type === "agent:activity");
    assert.match(offlineEvent.detail, /Crashed/);
  });
});

test("terminal model-not-found failures from runtime error are surfaced as error activity", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

    driver.parsedLines.set("{\"type\":\"error\"}", [{ kind: "error", message: "ModelNotFoundError: Requested entity was not found." }]);
    driver.processes[0].stdout.emit("data", Buffer.from("{\"type\":\"error\"}\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    const errorEvent = findLastActivity(sent, "error");
    assert.ok(errorEvent && errorEvent.type === "agent:activity");
    assert.match(errorEvent.detail, /requested entity was not found/i);
    assert.equal(errorEvent.launchId, "launch-1");
  });
});

test("missing Claude resume session falls back to a cold start", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-test-"));
  const sent: MachineToServerMessage[] = [];
  const restoreFetch = installManagedRunnerMintFetch();
  const driver = new FakeCodexDriver({ id: "claude", supportsStdinNotification: true });
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
    },
  );

  try {
    await manager.startAgent("agent-1", makeConfig({ runtime: "claude", sessionId: "missing-session" }), undefined, undefined, undefined, "launch-1");
    assert.equal(driver.spawnCalls.length, 1);

    driver.parsedLines.set("{\"type\":\"result_error\"}", [{
      kind: "error",
      message: "No conversation found with session ID: missing-session",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("{\"type\":\"result_error\"}\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await waitFor(() => driver.spawnCalls.length === 2, "missing Claude session cold restart");

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1].config.sessionId, null);
    const invalidation = sent.find((msg) => msg.type === "agent:session:invalidate");
    assert.deepEqual(invalidation, {
      type: "agent:session:invalidate",
      agentId: "agent-1",
      sessionId: "missing-session",
      launchId: "launch-1",
      reason: "missing",
    });
    assert.ok(
      sent.indexOf(invalidation!) < sent.findIndex((msg, index) =>
        index > sent.indexOf(invalidation!) &&
        msg.type === "agent:status" &&
        msg.status === "active" &&
        msg.launchId === "launch-1"
      ),
      "the exact stale generation must be invalidated before cold-start activation",
    );
    assert.equal(
      sent.filter((msg) => msg.type === "agent:status" && msg.status === "active" && msg.launchId === "launch-1").length,
      2,
    );
    assert.ok(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detailKind === "runtime_unavailable" &&
        projectFactActivity(msg) === "offline" &&
        /cold-starting a new session/i.test(msg.detail),
      ),
    );

    driver.processes[1].stdout.emit("data", Buffer.from("{\"type\":\"result_error\"}\n"));
    driver.processes[1].exit(1);
    driver.processes[1].close(1);
    await waitFor(
      () => sent.some((msg) =>
        msg.type === "agent:status" &&
        msg.status === "inactive" &&
        msg.launchId === "launch-1"
      ),
      "failed cold start becomes inactive",
    );

    assert.equal(driver.spawnCalls.length, 2, "a failed cold start must not resume the known-terminal session again");
    assert.equal(
      sent.filter((msg) => msg.type === "agent:session:invalidate").length,
      1,
      "the known-terminal session is invalidated once",
    );

    await manager.stopAgent("agent-1");
  } finally {
    cleanupTestManager(manager);
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing-session error without a bound session sends no invalidation", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "claude", sessionId: null }),
      undefined,
      undefined,
      undefined,
      "launch-1",
    );

    driver.parsedLines.set("{\"type\":\"result_error\"}", [{
      kind: "error",
      message: "No conversation found with session ID: unbound-session",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("{\"type\":\"result_error\"}\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await flush();

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(sent.some((msg) => msg.type === "agent:session:invalidate"), false);
    assert.ok(findLastActivity(sent, "offline"));
  }, {
    driver: new FakeCodexDriver({ id: "claude", supportsStdinNotification: true }),
  });
});

test("missing OpenCode resume session on stderr falls back to a cold start", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    const wakeMessage = makeMessage("please handle this wake");

    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "opencode", sessionId: "ses_missing" }),
      wakeMessage,
      undefined,
      undefined,
      "launch-1",
    );
    assert.equal(driver.spawnCalls.length, 1);

    driver.processes[0].stderr.emit(
      "data",
      Buffer.from('NotFoundError: NotFoundError\n data: {\n  message: "Session not found: ses_missing",\n}\n'),
    );
    driver.processes[0].exit(0);
    driver.processes[0].close(0);
    await waitFor(() => driver.spawnCalls.length === 2, "missing OpenCode session cold restart");

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1].config.sessionId, null);
    assert.match(driver.spawnCalls[1].prompt, /^\[Raft inbox notice:/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /please handle this wake/);
    assert.ok(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detailKind === "runtime_unavailable" &&
        projectFactActivity(msg) === "offline" &&
        /Stored OpenCode session missing; cold-starting a new session/i.test(msg.detail),
      ),
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_crashed"),
      false,
    );

    await manager.stopAgent("agent-1");
  }, {
    driver: new FakeCodexDriver({ id: "opencode" }),
  });
});

test("OpenCode provider rejection from replayed empty assistant tool call falls back to a cold start", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    const wakeMessage = makeMessage("retry without bad replay history");

    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "opencode", model: "opencode-go/kimi-k2.6", sessionId: "ses_bad_history" }),
      wakeMessage,
      undefined,
      undefined,
      "launch-1",
    );
    assert.equal(driver.spawnCalls.length, 1);

    driver.parsedLines.set("moonshot-replay-error", [{
      kind: "error",
      message: "Provider returned error: Invalid request: the message at position 110 with role 'assistant' must not be empty",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("moonshot-replay-error\n"));
    driver.processes[0].exit(1);
    driver.processes[0].close(1);
    await waitFor(() => driver.spawnCalls.length === 2, "OpenCode provider replay rejection cold restart");

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1].config.sessionId, null);
    assert.match(driver.spawnCalls[1].prompt, /^\[Raft inbox notice:/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /retry without bad replay history/);
    assert.ok(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detailKind === "runtime_unavailable" &&
        projectFactActivity(msg) === "offline" &&
        /Stored OpenCode session replay rejected; cold-starting a new session/i.test(msg.detail),
      ),
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_crashed"),
      false,
    );

    await manager.stopAgent("agent-1");
  }, {
    driver: new FakeCodexDriver({ id: "opencode" }),
  });
});

test("Pi replay rejection from assistant continuation falls back to a cold start", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    const wakeMessage = makeMessage("recover Pi from bad replay history");

    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "pi", model: "default", sessionId: "pi_bad_history" }),
      wakeMessage,
      undefined,
      undefined,
      "launch-1",
    );
    assert.equal(driver.spawnCalls.length, 1);

    driver.parsedLines.set("pi-replay-error", [{
      kind: "error",
      message: "Cannot continue from message role: assistant",
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("pi-replay-error\n"));
    driver.processes[0].exit(null, "SIGTERM");
    driver.processes[0].close(null, "SIGTERM");
    await waitFor(() => driver.spawnCalls.length === 2, "Pi provider replay rejection cold restart");

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1].config.sessionId, null);
    assert.match(driver.spawnCalls[1].prompt, /^\[Raft inbox notice:/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /recover Pi from bad replay history/);
    assert.ok(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detailKind === "runtime_unavailable" &&
        projectFactActivity(msg) === "offline" &&
        /Stored Pi session replay rejected; cold-starting a new session/i.test(msg.detail),
      ),
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_crashed"),
      false,
    );

    await manager.stopAgent("agent-1");
  }, {
    driver: new FakeCodexDriver({ id: "pi", supportsStdinNotification: true, busyDeliveryMode: "direct" }),
  });
});

test("missing Gemini resume session on stderr falls back to a cold start", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    const wakeMessage = makeMessage("please handle this Gemini wake");
    const missingSessionId = "dccb084d-718e-4608-886d-cc00cbaf766e";

    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "gemini", sessionId: missingSessionId }),
      wakeMessage,
      undefined,
      undefined,
      "launch-1",
    );
    assert.equal(driver.spawnCalls.length, 1);

    driver.processes[0].stderr.emit(
      "data",
      Buffer.from(
        `Error resuming session: Invalid session identifier "${missingSessionId}".\n` +
        "Searched for sessions in C:\\Users\\tenny\\.gemini\\tmp\\agent-1\\chats.\n" +
        "Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.\n",
      ),
    );
    driver.processes[0].exit(42);
    driver.processes[0].close(42);
    await waitFor(() => driver.spawnCalls.length === 2, "missing Gemini session cold restart");

    assert.equal(driver.spawnCalls.length, 2);
    assert.equal(driver.spawnCalls[1].config.sessionId, null);
    assert.match(driver.spawnCalls[1].prompt, /^\[Raft inbox notice:/);
    assert.doesNotMatch(driver.spawnCalls[1].prompt, /please handle this Gemini wake/);
    assert.ok(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        msg.detailKind === "runtime_unavailable" &&
        projectFactActivity(msg) === "offline" &&
        /Stored Gemini CLI session missing; cold-starting a new session/i.test(msg.detail) &&
        msg.entries?.some((entry) =>
          entry.kind === "text" &&
          /earlier runtime context may not be restored/i.test(entry.text),
        ),
      ),
    );
    assert.equal(
      sent.some((msg) => msg.type === "agent:activity" && msg.detailKind === "runtime_crashed"),
      false,
    );

    await manager.stopAgent("agent-1");
  }, {
    driver: new FakeCodexDriver({ id: "gemini" }),
  });
});

test("Gemini invalid-session stderr without the cached session id does not cold-start", async () => {
  await withManager(async ({ driver, sent, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ runtime: "gemini", sessionId: "cached-session-id" }),
      makeMessage("please handle this Gemini wake"),
      undefined,
      undefined,
      "launch-1",
    );
    assert.equal(driver.spawnCalls.length, 1);

    driver.processes[0].stderr.emit(
      "data",
      Buffer.from('Error resuming session: Invalid session identifier "different-session-id".\n'),
    );
    driver.processes[0].exit(42);
    driver.processes[0].close(42);
    await flush();
    await flush();

    assert.equal(driver.spawnCalls.length, 1);
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        projectFactActivity(msg) === "working" &&
        /cold-starting a new session/i.test(msg.detail),
      ),
      false,
    );
    assert.ok(findLastActivity(sent, "offline"));
  }, {
    driver: new FakeCodexDriver({ id: "gemini" }),
  });
});

test("scanAllWorkspaces uses the configured dataDir consistently", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const workspaceDir = path.join(dataDir, "agent-1");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "# test\n");

    const workspaces = await manager.scanAllWorkspaces();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.directoryName, "agent-1");
    assert.equal(workspaces[0]?.fileCount, 1);
  });
});

test("getFileTree hides dotfiles by default and includes safe hidden files on request", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const workspaceDir = path.join(dataDir, "agent-1");
    await mkdir(path.join(workspaceDir, ".git"), { recursive: true });
    await writeFile(path.join(workspaceDir, ".git", "config"), "[core]\n");
    await mkdir(path.join(workspaceDir, ".slock-runtime"), { recursive: true });
    await writeFile(path.join(workspaceDir, ".slock-runtime", "state.json"), "{}\n");
    await mkdir(path.join(workspaceDir, ".ssh"), { recursive: true });
    await writeFile(path.join(workspaceDir, ".ssh", "id_rsa.pub"), "ssh-rsa test\n");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "# test\n");
    await writeFile(path.join(workspaceDir, ".gitignore"), "node_modules\n");
    await writeFile(path.join(workspaceDir, ".env"), "TOKEN=secret\n");

    const defaultFiles = await manager.getFileTree("agent-1");
    assert.deepEqual(defaultFiles.map((file) => file.name), ["MEMORY.md"]);

    const withHidden = await manager.getFileTree("agent-1", undefined, true);
    assert.deepEqual(withHidden.map((file) => file.name), [".git", ".env", ".gitignore", "MEMORY.md"]);
    assert.equal(withHidden.find((file) => file.name === ".git")?.isHidden, true);
    assert.equal(withHidden.some((file) => file.name === ".slock-runtime"), false);
    assert.equal(withHidden.some((file) => file.name === ".ssh"), false);

    assert.deepEqual(await manager.getFileTree("agent-1", ".git"), []);
    const hiddenGitFiles = await manager.getFileTree("agent-1", ".git", true);
    assert.deepEqual(hiddenGitFiles.map((file) => file.name), ["config"]);
    assert.deepEqual(await manager.getFileTree("agent-1", ".ssh", true), []);
    assert.deepEqual(await manager.getFileTree("agent-1", ".slock-runtime", true), []);
  });
});

test("readFile enforces sensitive, image, and binary preview policy", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const workspaceDir = path.join(dataDir, "agent-1");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(workspaceDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(workspaceDir, "archive.zip"), Buffer.from([0x50, 0x4b]));

    await assert.rejects(
      () => manager.readFile("agent-1", ".env"),
      /Preview is disabled for sensitive workspace files/,
    );

    const image = await manager.readFile("agent-1", "image.png");

    assert.equal(image.binary, true);
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.encoding, "base64");
    assert.equal(image.size, 4);
    assert.equal(image.content, "iVBORw==");

    const archive = await manager.readFile("agent-1", "archive.zip");

    assert.equal(archive.binary, true);
    assert.equal(archive.content, null);
    assert.equal(archive.size, 2);
    assert.equal(archive.mimeType, undefined);
    assert.equal(archive.encoding, undefined);
  });
});

test("Wiki Agent workspace pack install replaces managed files, returns actual receipts, and permits launch", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const workspaceDir = path.join(dataDir, "wiki-agent");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "# Custom Wiki Agent Contract\n");
    const pack = makeTestWikiWorkspacePack();
    const receipt = await ensureWikiAgentWorkspace("wiki-agent", workspaceDir, pack);

    await manager.startAgent(
      "wiki-agent",
      makeConfig({
        name: "WikiAgent",
        displayName: "Wiki Agent",
        description: "Maintains server Wiki documents.",
        envVars: { [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED },
      }),
    );

    const agentsMd = await readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
    const claudeMd = await readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
    const ingestMd = await readFile(path.join(workspaceDir, ".agents", "skills", "ingest.md"), "utf8");

    assert.equal(agentsMd, "# Test Wiki Agent\n");
    assert.equal(claudeMd, "@AGENTS.md\n");
    assert.equal(ingestMd, "# Test Ingest\n");
    assert.equal(receipt.agentId, "wiki-agent");
    assert.equal(receipt.packId, pack.packId);
    assert.deepEqual(receipt.files.map((file) => file.relativePath), pack.files.map((file) => file.relativePath).sort());
    assert.ok(receipt.files.every((file) =>
      /^[0-9a-f]{64}$/.test(file.sha256)
      && file.size > 0
    ));

    assert.equal(existsSync(path.join(workspaceDir, ".claude", "skills")), true);
    assert.equal(existsSync(path.join(workspaceDir, "schema.md")), false);
    assert.equal(existsSync(path.join(workspaceDir, "purpose.md")), false);
    assert.equal(existsSync(path.join(workspaceDir, "wiki-purpose.md")), false);
    assert.equal(existsSync(path.join(workspaceDir, "wiki-agent.md")), false);
    assert.equal(existsSync(path.join(workspaceDir, "maintain.md")), false);
  });
});

test("configured Wiki Agent launch fails closed when no valid pack was installed", async () => {
  await withManager(async ({ manager, dataDir }) => {
    const workspaceDir = path.join(dataDir, "wiki-agent-existing-claude");
    await mkdir(path.join(workspaceDir, ".claude", "skills"), { recursive: true });

    await assert.rejects(
      manager.startAgent(
        "wiki-agent-existing-claude",
        makeConfig({
          name: "WikiAgent",
          displayName: "Wiki Agent",
          description: "Maintains server Wiki documents.",
          envVars: { [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED },
        }),
      ),
      /no valid installed workspace pack/,
    );
  });
});

test("visible delivery consume suppresses same-target pending inbox by exact id without advancing boundary", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);
    ap.inbox.push(makeMessage("pending dm", {
      channel_id: "dm-1",
      channel_name: "tygg",
      channel_type: "dm",
      message_id: "pending-42",
      seq: 42,
    }));

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "dm:@tygg",
      messages: [{ seq: 42, id: "pending-42", channel_type: "dm", channel_name: "tygg" }],
      source: "spawn_wake_message",
    });

    assert.equal(ap.inbox.length, 0);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "dm:@tygg"), undefined);
  });
});

test("visible delivery consume records id-only messages as model-seen without treating local presence as seen", async () => {
  await withManager(async ({ manager }) => {
    const coordinator = (manager as any).createAgentProxyInboxCoordinator("agent-1");

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#contracts:97dbd451",
      messages: [{
        id: "counterparty-40",
        message_id: "counterparty-40",
        channel_type: "thread",
        channel_name: "97dbd451",
        parent_channel_type: "channel",
        parent_channel_name: "contracts",
      }],
      source: "spawn_wake_message",
    });

    assert.equal((manager as any).getVisibleBoundary("agent-1", "#contracts:97dbd451"), undefined);
    assert.equal(coordinator.isMessageModelSeen?.({
      target: "#contracts:97dbd451",
      message: { message_id: "counterparty-40" },
    }), true);
    assert.equal(coordinator.isMessageModelSeen?.({
      target: "#contracts:97dbd451",
      message: { message_id: "counterparty-41" },
    }), false);
  });
});

test("Agent API pending projection retains seq-less stable-id inbox rows and excludes runtime controls", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);

    ap.inbox.push(
      makeMessage("ordinary mirror delivery without seq", {
        message_id: "mirror-message-41",
      }),
      makeMessage("ordinary delivery with seq", {
        message_id: "sequenced-message-42",
        seq: 42,
      }),
      makeMessage("daemon-owned runtime control", {
        message_id: "runtime-profile-daemon-release-control-1",
        sender_type: "system",
      }),
      makeMessage("identity-free synthetic control"),
    );
    (manager as any).startingInboxes.bufferMessagesDuringStart("agent-1", [
      makeMessage("starting mirror delivery without seq", {
        message_id: "starting-message-43",
      }),
    ]);

    assert.deepEqual(
      (manager as any).allPendingVisibleMessages("agent-1").map((message: AgentMessage) => message.message_id),
      ["mirror-message-41", "sequenced-message-42", "starting-message-43"],
      "the Agent API and runtime notice must project the same ordinary pending identities",
    );
  });
});

test("visible delivery consume suppresses only exact delivered rows, not a boundary prefix", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);
    for (let seq = 40; seq <= 44; seq += 1) {
      ap.inbox.push(makeMessage(`pending dm ${seq}`, {
        channel_id: "dm-1",
        channel_name: "tygg",
        channel_type: "dm",
        message_id: `pending-${seq}`,
        seq,
      }));
    }

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "dm:@tygg",
      messages: [
        { seq: 42, id: "pending-42", channel_type: "dm", channel_name: "tygg" },
        { seq: 43, id: "pending-43", channel_type: "dm", channel_name: "tygg" },
        { seq: 44, id: "pending-44", channel_type: "dm", channel_name: "tygg" },
      ],
      boundarySeq: 44,
      source: "spawn_wake_message",
    });

    assert.deepEqual(
      ap.inbox.map((message: any) => message.message_id),
      ["pending-40", "pending-41"],
      "attention delivery must suppress exact delivered rows only, not a seq prefix",
    );
    assert.equal((manager as any).getVisibleBoundary("agent-1", "dm:@tygg"), undefined);
  });
});

test("visible delivery consume does not suppress other targets or unshown messages", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);
    ap.inbox.push(makeMessage("other target", {
      channel_id: "channel-2",
      channel_name: "other",
      channel_type: "channel",
      message_id: "other-50",
      seq: 50,
    }));

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "dm:@tygg",
      messages: [{ seq: 42, id: "pending-42", channel_type: "dm", channel_name: "tygg" }],
      source: "spawn_wake_message",
    });

    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.inbox[0].message_id, "other-50");
    assert.equal((manager as any).getVisibleBoundary("agent-1", "dm:@tygg"), undefined);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#other"), undefined);
  });
});

test("visible delivery consume keeps parent channel and thread targets isolated", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);
    ap.inbox.push(makeMessage("thread pending", {
      channel_id: "thread-1",
      channel_name: "abcdef123456",
      channel_type: "thread",
      parent_channel_name: "general",
      parent_channel_type: "channel",
      message_id: "thread-70",
      seq: 70,
    }));

    (manager as any).consumeVisibleMessages("agent-1", {
      target: "#general",
      messages: [{ seq: 70, id: "thread-70", channel_type: "channel", channel_name: "general" }],
      source: "spawn_wake_message",
    });

    assert.equal(ap.inbox.length, 1);
    assert.equal(ap.inbox[0].message_id, "thread-70");
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general"), undefined);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general:abcdef12"), undefined);

    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [{
        seq: 70,
        id: "thread-70",
        channel_type: "thread",
        channel_name: "abcdef123456",
        parent_channel_name: "general",
        parent_channel_type: "channel",
      }],
      source: "spawn_wake_message",
    });

    assert.equal(ap.inbox.length, 0);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#general:abcdef12"), undefined);
  });
});

test("inbox purge drops revoked channel messages without marking them visible", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const ap = (manager as any).agents.get("agent-1");
    assert.ok(ap);
    ap.inbox.push(
      makeMessage("private pending", {
        channel_id: "private-channel",
        channel_name: "secret",
        channel_type: "private",
        message_id: "private-10",
        seq: 10,
      }),
      makeMessage("thread pending", {
        channel_id: "private-thread",
        channel_name: "abcdef1234567890",
        channel_type: "thread",
        parent_channel_id: "private-channel",
        parent_channel_name: "secret",
        parent_channel_type: "private",
        message_id: "thread-11",
        seq: 11,
      }),
      makeMessage("public pending", {
        channel_id: "public-channel",
        channel_name: "general",
        channel_type: "channel",
        message_id: "public-12",
        seq: 12,
      }),
    );
    ap.notifications.add(3);

    const result = (manager as any).purgeInboxMessagesForChannels(
      "agent-1",
      ["private-channel", "private-thread"],
      "membership_removed",
    );

    assert.deepEqual(result, { removedCount: 2 });
    assert.deepEqual(ap.inbox.map((message: AgentMessage) => message.message_id), ["public-12"]);
    assert.equal(ap.notifications.pendingCount, 1);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#secret"), undefined);
    assert.equal((manager as any).getVisibleBoundary("agent-1", "#secret:thread-p"), undefined);
  });
});

test("freshness forward decision does not create held activity log entry", async () => {
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const coordinator = (manager as any).createAgentProxyInboxCoordinator("agent-1");

    coordinator.recordFreshnessDecision({
      action: "send",
      decision: "forward",
      target: "dm:@tygg",
      inboxTrustState: "trusted",
      reason: "model_seen_boundary",
      pendingCount: 0,
      modelSeenSeq: 42,
    });

    const heldActivity = sent.find((msg) =>
      msg.type === "agent:activity" &&
      msg.entries?.some((entry) => entry.kind === "slock_action" && entry.title.includes("held by freshness check"))
    );
    assert.equal(heldActivity, undefined);
  });
});

test("freshness hold decision records a fact-typed action without message body", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const coordinator = (manager as any).createAgentProxyInboxCoordinator("agent-1");

    coordinator.recordFreshnessDecision({
      action: "send",
      decision: "local_hold",
      target: "dm:@tygg",
      inboxTrustState: "trusted",
      reason: "exact_target_pending",
      pendingCount: 1,
      pendingMaxSeq: 43,
      modelSeenSeq: 42,
      heldMessageCount: 1,
      omittedMessageCount: 0,
    });

    const freshnessSpan = sink.getAllSpans().find((span) => span.name === "daemon.agent.inbox.freshness_decision");
    assert.ok(freshnessSpan, "freshness hold must emit a trace row");
    assert.equal(freshnessSpan.attrs?.decision, "local_hold");
    assert.equal(freshnessSpan.attrs?.action, "send");
    assert.match(String(freshnessSpan.attrs?.producer_fact_id ?? ""), /^freshness_decision_fact:[0-9a-f]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(freshnessSpan.attrs),
      /pending body|message body|newer pending/i,
      "freshness producer trace must not contain held message body text",
    );

    const activity = sent.find((msg) =>
      msg.type === "agent:activity" &&
      msg.entries?.some((entry) => entry.kind === "slock_action" && entry.title === "Send held by freshness check")
    );
    assert.ok(activity && activity.type === "agent:activity");
    assert.equal(activity.activity, undefined);
    assert.equal(activity.detail, "Send held by freshness check");
    assert.deepEqual(activity.entries?.[0], {
      kind: "status",
      detail: "Send held by freshness check",
      detailKind: "freshness_hold",
      producerFactId: freshnessSpan.attrs?.producer_fact_id,
    });
    const entry = activity.entries?.find((candidate) => candidate.kind === "slock_action");
    assert.deepEqual(entry, {
      kind: "slock_action",
      producerFactId: freshnessSpan.attrs?.producer_fact_id,
      title: "Send held by freshness check",
      text: [
        "target: dm:@tygg",
        "new messages: 1 newer message",
        "decision: local hold; review the newer context before retrying",
      ].join("\n"),
    });
    assert.doesNotMatch(JSON.stringify(activity), /pending body|message body|newer pending/);
  }, { tracer });
});

test("syncing freshness hold activity reports synced target context instead of newer messages", async () => {
  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const coordinator = (manager as any).createAgentProxyInboxCoordinator("agent-1");

    coordinator.recordFreshnessDecision({
      action: "send",
      decision: "syncing_hold",
      target: "#proj-dx:d3914f83",
      inboxTrustState: "target_first_touch",
      reason: "sync target context before retrying",
      pendingCount: 0,
      modelSeenSeq: 42,
      heldMessageCount: 1,
      omittedMessageCount: 0,
    });

    const activity = sent.find((msg) =>
      msg.type === "agent:activity" &&
      msg.entries?.some((entry) => entry.kind === "slock_action" && entry.title === "Send held by freshness check")
    );
    assert.ok(activity && activity.type === "agent:activity");
    const entry = activity.entries?.find((candidate) => candidate.kind === "slock_action");
    assert.ok(entry);
    assert.match(entry.producerFactId ?? "", /^freshness_decision_fact:[0-9a-f]{64}$/);
    assert.equal(entry.title, "Send held by freshness check");
    assert.equal(entry.text, [
      "target: #proj-dx:d3914f83",
      "unreviewed synced context for this target: 1 message",
      "reason: this target's latest synced context was not yet in your reviewed context",
      "action: review the synced context before sending",
    ].join("\n"));
    assert.doesNotMatch(entry.text, /new messages|newer message/);
  });
});

import { classifySpawnFailure } from "./agentProcessManager.js";

test("classifySpawnFailure maps known and fallback failures without leaking raw detail", () => {
  const genericDetail = "bootstrap exploded: credential=credential-poison endpoint=https://private.example token=token-poison";
  const stringDetail = "plain string credential=credential-poison endpoint=https://private.example token=token-poison";
  const cases: Array<{ input: unknown; reason: string; userMessage: string; detail?: string }> = [
    {
      input: new Error("Agent Credential Proxy local proxy failed to bind 127.0.0.1 after 3 attempts: listen EACCES 0.0.0.0:53128"),
      reason: "agent_proxy_bind_failed",
      userMessage: "Local agent proxy could not start. Check if another daemon or service is using the required local port.",
    },
    {
      input: new Error("runner_credential_mint_failed: fetch failed"),
      reason: "runner_credential_mint_failed",
      userMessage: "Runner credential mint failed. Ensure the server is deployed and the daemon binary is compatible.",
    },
    {
      input: new Error("Provider connection materialization failed (HTTP 503): credential=credential-poison endpoint=https://private.example connectionId=connection-poison"),
      reason: "provider_connection_materialization_failed",
      userMessage: "Provider connection materialization failed (HTTP 503). Check Server Settings → AI Providers and retry.",
    },
    {
      input: new Error("spawn claude ENOENT"),
      reason: "runtime_not_found",
      userMessage: "Runtime executable not found. Ensure the required CLI is installed and available on PATH.",
    },
    {
      input: new Error(genericDetail),
      reason: "runtime_spawn_failed",
      userMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
      detail: genericDetail,
    },
    {
      input: stringDetail,
      reason: "runtime_spawn_failed",
      userMessage: "Runtime failed to start. Check the Computer logs for details and retry.",
      detail: stringDetail,
    },
  ];

  for (const specimen of cases) {
    const result = classifySpawnFailure(specimen.input);
    assert.equal(result.reason, specimen.reason);
    assert.equal(result.userMessage, specimen.userMessage);
    if (specimen.detail) assert.equal(result.detail, specimen.detail);
    assert.doesNotMatch(result.userMessage, /credential-poison|private\.example|connection-poison|token-poison/);
  }

  const poisonedDetails = [
    "Agent Credential Proxy local proxy failed to bind: credential=credential-poison endpoint=https://private.example token=token-poison",
    "runner_credential_mint_failed: credential=credential-poison endpoint=https://private.example token=token-poison",
    "spawn claude ENOENT credential=credential-poison endpoint=https://private.example token=token-poison",
    "Provider connection materialization failed (HTTP 503): credential=credential-poison endpoint=https://private.example token=token-poison",
  ];

  for (const rawDetail of poisonedDetails) {
    const result = classifySpawnFailure(new Error(rawDetail));
    assert.equal(result.detail, rawDetail, "raw detail must remain available to daemon logs");
    assert.doesNotMatch(result.userMessage, /credential-poison|private\.example|token-poison/);
  }
});

function getSpawnFailBackoffState(manager: any, agentId: string): any {
  return (manager as any).lifecycleRecords.activeSpawnFailBackoffs.get(agentId) ?? null;
}

test("spawn-fail backoff: runner credential network failure arms cooldown after one exhausted mint sequence", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    const seedCached = () => (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({ sessionId: "s1", agentCredentialKey: undefined, agentCredentialId: undefined }),
      sessionId: "s1",
      launchId: "launch-1",
    });

    await withRunnerCredentialMintNetworkFailure(async ({ getCredentialFetchCount }) => {
      seedCached();
      const firstAccepted = await manager.deliverMessage("agent-1", makeMessage("mint-network-fail"));
      assert.equal(firstAccepted, false);
      const fetchCountAfterFailure = getCredentialFetchCount();
      assert.ok(fetchCountAfterFailure >= 3, "credential mint should exhaust the inner retry loop before outer cooldown");
      const state = getSpawnFailBackoffState(manager, "agent-1");
      assert.ok(state.attempts >= 1);
      assert.ok(state.untilMs > 0, "credential mint failure arms cooldown immediately after inner retry exhaustion");
      assert.equal((manager as any).isSpawnFailBackoffActive("agent-1"), true);
      assert.equal(driver.spawnCalls.length, 0, "no actual spawn (credential mint failed before)");

      seedCached();
      const cooldownAccepted = await manager.deliverMessage("agent-1", makeMessage("during-credential-cooldown"));
      assert.equal(cooldownAccepted, true, "delivery during credential cooldown is queued, not dropped");
      assert.equal(getCredentialFetchCount(), fetchCountAfterFailure, "cooldown must suppress another credential mint sequence");
      assert.ok(sent.some((msg) =>
        msg.type === "agent:activity"
        && msg.agentId === "agent-1"
        && msg.detail.includes("runner_credential_mint_failed")
      ));
    });
  });
});

test("spawn-fail backoff: first generic failure gates subsequent deliveries (no startAgent re-attempt during cooldown)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    const seedCached = () => (manager as any).lifecycleRecords.idleRestartSnapshots.set("agent-1", {
      config: makeConfig({
        sessionId: "s1",
        agentCredentialKey: undefined,
        agentCredentialId: undefined,
        runtimeContext: {
          serverId: "server-1",
          machineId: "machine-1",
        },
      }),
      sessionId: "s1",
      launchId: "launch-1",
    });

    (manager as any).recordSpawnFailure("agent-1", "spawn_error");
    const state = getSpawnFailBackoffState(manager, "agent-1");
    assert.equal(state.attempts, 1);
    assert.ok(state.untilMs > 0, "generic backoff armed after the first failure");
    assert.equal((manager as any).isSpawnFailBackoffActive("agent-1"), true);

    // While cooldown is active, a new delivery must be QUEUED (not dropped, no startAgent).
    seedCached();
    const accepted = await manager.deliverMessage("agent-1", makeMessage("during-cooldown"));
    assert.equal(accepted, true, "deferred message must be accepted, not dropped");
    assert.equal(
      ((manager as any).startingInboxes.values("agent-1") ?? []).some((m: any) => m.body === "during-cooldown") ||
      ((manager as any).startingInboxes.values("agent-1") ?? []).length > 0,
      true,
      "deferred message must be queued in startingInboxes",
    );
    assert.equal(driver.spawnCalls.length, 0, "no spawn attempted during cooldown window");

    const rows = sink.getAllSpans()
      .filter((span) => span.name === "launch_residency_transition")
      .map((span) => span.attrs);
    const [cooldownEnter] = rows;
    assert.equal(rows.length, 1);
    assert.equal(cooldownEnter?.transition_kind, "enter");
    assert.equal(cooldownEnter?.state, "spawn_fail_cooldown");
    assert.equal(cooldownEnter?.agent_launch_id, "launch-1");
    assert.equal(cooldownEnter?.server_id, "server-1");
    assert.equal(cooldownEnter?.machine_id, "machine-1");
    assert.equal(cooldownEnter?.launch_source, "idle_auto_restart");
    assert.equal(cooldownEnter?.is_wait_state, true);
    assert.equal(cooldownEnter?.fence_kind, "spawn_fail_backoff");
    assert.equal(cooldownEnter?.deadline_unix_ms, state.untilMs);
    assert.equal(cooldownEnter?.failure_kind, "spawn_fail_cooldown_active");
    assert.equal(cooldownEnter?.negative_evidence_bucket, "spawn_fail_cooldown_active");
    assert.equal(cooldownEnter?.state_instance_id, cooldownEnter?.residency_state_instance_id);

    (manager as any).resetSpawnFailBackoff("agent-1", "suppressed");
    const closeRows = sink.getAllSpans()
      .filter((span) => span.name === "launch_residency_transition")
      .map((span) => span.attrs);
    const cooldownClose = closeRows[1];
    assert.equal(closeRows.length, 2);
    assert.equal(cooldownClose?.transition_kind, "close");
    assert.equal(cooldownClose?.close_result, "suppressed");
    assert.equal(cooldownClose?.state_instance_id, cooldownEnter?.state_instance_id);
    assert.equal(cooldownClose?.negative_evidence_bucket, "spawn_fail_cooldown_reset");
  }, { tracer });
});

test("spawn-fail backoff lifecycle: explicit stop CLEARS the backoff state (fresh launch resets counter)", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const state = (manager as any).getOrCreateSpawnFailBackoff("agent-1");
    state.attempts = 5;
    state.untilMs = Date.now() + 10_000;

    await manager.stopAgent("agent-1"); // explicit (silent defaults false)

    assert.equal(
      getSpawnFailBackoffState(manager, "agent-1"),
      null,
      "explicit stop must clear backoff state (user-driven restart shouldn't see stale cooldown)",
    );
  });
});

test("spawn-fail backoff lifecycle: silent stop KEEPS the backoff state (same-launch respawn cannot bypass the cap)", async () => {
  await withManager(async ({ manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "s1" }));
    const state = (manager as any).getOrCreateSpawnFailBackoff("agent-1");
    state.attempts = 5;
    state.untilMs = Date.now() + 10_000;

    await manager.stopAgent("agent-1", { silent: true });

    const kept = getSpawnFailBackoffState(manager, "agent-1");
    assert.ok(kept, "silent stop must keep backoff state (else stop/start churn bypasses the cap)");
    assert.equal(kept.attempts, 5);
  });
});

test("broadcastActivity emits daemon.agent.activity.produced trace with correlation attrs", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      sessionId: "session-1",
      runtimeContext: { serverId: "server-1", machineId: "machine-1" },
    }), undefined, undefined, undefined, "launch-1");

    // Emit session_init so sessionId is set on the agent process
    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "session-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();

    driver.parsedLines.set("tool-call", [{ kind: "tool_call", name: "Bash", input: { command: "echo ok" } }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-call\n"));
    await flush();

    // Filter for the tool-call produced span (entry_kinds includes tool_start), not the startup span
    const span = sink.getAllSpans().find((s) =>
      s.name === "daemon.agent.activity.produced"
      && typeof s.attrs?.entry_kinds === "string"
      && s.attrs.entry_kinds.includes("tool_start")
    );
    assert.ok(span, "expected daemon.agent.activity.produced span with tool_start entry");
    const producedActivity = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity"
      && msg.entries?.some((entry) => entry.kind === "tool_start") === true
    );
    assert.ok(producedActivity, "expected matching outbound agent:activity with tool_start entry");
    assert.equal(producedActivity.activityKind, undefined, "daemon producer must not write activityKind on wire");
    assert.equal(span.attrs?.agentId, "agent-1");
    assert.equal(span.attrs?.agent_id, "agent-1");
    assert.equal(span.attrs?.server_id, "server-1");
    assert.equal(span.attrs?.machine_id, "machine-1");
    assert.equal(span.attrs?.ap_present, true);
    assert.equal(span.attrs?.client_seq_present, true);
    assert.equal(span.attrs?.clientSeq, producedActivity.clientSeq);
    assert.equal(span.attrs?.client_seq, producedActivity.clientSeq);
    assert.equal(producedActivity.producerFactId, `daemon_activity:agent-1:launch-1:${producedActivity.clientSeq}`);
    assert.equal(span.attrs?.producerFactId, producedActivity.producerFactId);
    assert.equal(span.attrs?.producer_fact_id, producedActivity.producerFactId);
    assert.equal(span.attrs?.session_id_present, true);
    assert.equal(span.attrs?.runtime, "codex");
    assert.equal(span.attrs?.launch_id_present, true);
    assert.equal(span.attrs?.launchId, "launch-1");
    assert.equal(span.attrs?.launch_id, "launch-1");
    assert.equal(span.attrs?.correlation_id, `agent:agent-1:daemonActivity:launch-1:${producedActivity.clientSeq}`);
  }, { tracer });
});

test("broadcastActivity fails closed before send on unknown detailKind", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({ runtime: "codex" }));
    await flush();
    const before = sent.length;

    (manager as any).broadcastActivity("agent-1", "working", "Unknown activity", [], undefined, "unknown_detail_kind");
    await flush();

    assert.equal(sent.length, before, "unknown detailKind must not cross the wire");
    const dropped = sink.getAllSpans().find((span) =>
      span.name === "daemon.agent.activity.dropped"
      && span.attrs?.reason === "unknown_activity_detail_kind"
    );
    assert.ok(dropped, "unknown detailKind drop must be trace-visible");
  }, { tracer });
});

test("respondToActivityProbe emits daemon.agent.activity.produced trace with exact join attrs", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig({
      runtime: "codex",
      runtimeContext: { serverId: "server-1", machineId: "machine-1" },
    }), undefined, undefined, undefined, "launch-1");

    manager.respondToActivityProbe("agent-1", "probe-1");

    const probeActivity = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity"
      && msg.probeId === "probe-1"
    );
    assert.ok(probeActivity, "expected probe response activity");
    assert.equal(probeActivity.activity, undefined, "probe response must not echo a producer conclusion");
    assert.equal(probeActivity.activityKind, undefined, "probe response must remain fact-only");
    assert.notEqual(probeActivity.detailKind, "none");
    assert.notEqual(probeActivity.detailKind, "daemon_activity");
    assert.notEqual(probeActivity.detailKind, "other");

    const span = sink.getAllSpans().find((s) =>
      s.name === "daemon.agent.activity.produced"
      && s.attrs?.correlation_id === `agent:agent-1:daemonActivity:launch-1:${probeActivity.clientSeq}`
    );
    assert.ok(span, "expected probe response producer span");
    assert.equal(span.attrs?.agent_id, "agent-1");
    assert.equal(span.attrs?.server_id, "server-1");
    assert.equal(span.attrs?.machine_id, "machine-1");
    assert.equal(span.attrs?.launch_id, "launch-1");
    assert.equal(span.attrs?.client_seq, probeActivity.clientSeq);
    assert.equal(probeActivity.producerFactId, `daemon_activity:agent-1:launch-1:${probeActivity.clientSeq}`);
    assert.equal(span.attrs?.producer_fact_id, probeActivity.producerFactId);
    assert.equal(span.attrs?.entry_kinds, "");
  }, { tracer });
});

test("empty thinking liveness updates do not persist blank trajectory status rows", async () => {
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());
    sent.length = 0;

    driver.parsedLines.set("thinking-start", [{ kind: "thinking", text: "" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thinking-start\n"));
    await flush();

    const liveness = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity" && projectFactActivity(msg) === "thinking"
    );
    assert.ok(liveness, "empty thinking should still update live activity");
    assert.equal(liveness.detailKind, "thinking_started");
    assert.deepEqual(liveness.entries, [], "empty thinking must not create a visible blank trajectory row");

    driver.parsedLines.set("thinking-final", [{ kind: "thinking", text: "full plan" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thinking-final\n"));
    await flush();
    (manager as any).flushPendingTrajectory("agent-1");
    await flush();

    const persisted = sent.find((msg): msg is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
      msg.type === "agent:activity" && msg.entries?.some((entry) => entry.kind === "thinking") === true
    );
    assert.ok(persisted, "final thinking text should still persist as a trajectory entry");
    assert.deepEqual(persisted.entries, [{ kind: "thinking", text: "full plan" }]);

    driver.parsedLines.set("text-start", [{ kind: "text", text: "answer" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("text-start\n"));
    await flush();

    const detailKinds = activityDetailKinds(sent);
    assert.ok(detailKinds.includes("thinking_end"), "text output must end the thinking phase explicitly");
    assert.ok(detailKinds.includes("model_response_started"), "text output must start model response explicitly");
  });
});

test("queueTrajectoryText emits daemon.agent.activity.skipped when agent process is missing", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    // Remove the agent from the internal map to simulate ap=null
    (manager as any).agents.delete("agent-1");

    driver.parsedLines.set("thinking", [{ kind: "thinking", text: "secret thinking content" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("thinking\n"));
    await flush();

    const span = sink.getAllSpans().find((s) => s.name === "daemon.agent.activity.skipped");
    assert.ok(span, "expected daemon.agent.activity.skipped span");
    assert.equal(span.attrs?.agentId, "agent-1");
    assert.equal(span.attrs?.event_kind, "thinking");
    assert.equal(span.attrs?.reason, "agent_process_missing");
    assert.equal(typeof span.attrs?.text_length, "number");
    // Must not leak the actual text content into the trace
    for (const value of Object.values(span.attrs ?? {})) {
      if (typeof value === "string") {
        assert.ok(!value.includes("secret thinking content"), "trace must not leak text content");
      }
    }
  }, { tracer });
});

test("handleParsedEvent emits daemon.agent.event.received_without_process for non-internal events", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });

  await withManager(async ({ driver, manager }) => {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));

    // Remove the agent from the internal map to simulate ap=null
    (manager as any).agents.delete("agent-1");

    driver.parsedLines.set("tool-call", [{ kind: "tool_call", name: "Bash", input: { command: "echo ok" } }]);
    driver.processes[0].stdout.emit("data", Buffer.from("tool-call\n"));
    await flush();

    const span = sink.getAllSpans().find((s) => s.name === "daemon.agent.event.received_without_process");
    assert.ok(span, "expected daemon.agent.event.received_without_process span");
    assert.equal(span.attrs?.agentId, "agent-1");
    assert.equal(span.attrs?.event_kind, "tool_call");
    assert.equal(span.attrs?.runtime, "codex");
  }, { tracer });
});

// ─────────────────────────────────────────────────────────────────────────────
// RED-GREEN: orphan-child prevention on daemon shutdown.
// Evidence: feedback report 0034bff0-91f0-4faa-8883-83a3905d46d2 (my own agent)
// + service.log per-server runner-state-changed transitions + ScopeDB
// `slock-daemon` span absence for 16h after 2026-06-22T17:16:48Z daemon
// restart. Diagnosis chain at #proj-o11y:00e35cab msg=e211f860, refined
// at 058e8d05/8868e216.
//
// Proximate cause: `stopAgent({wait:true})`'s 5s timeout callback resolves
// the wait-promise without itself sending SIGKILL. The ONLY SIGKILL path
// is `ChildProcessRuntimeSession.stop({forceAfterMs:5000})`'s internal
// `setTimeout(...).unref?.()`. In production, `daemon.stop()` awaits
// `stopAll()` then `process.exit(0)` runs; the unref'd timer cannot keep
// the event loop alive past process.exit, so any racing SIGKILL never
// fires → orphan Claude Code subprocess.
//
// This test simulates that race deterministically by replacing `setTimeout`
// with a controllable seam that NEVER fires the `forceAfterMs` SIGKILL timer
// (mirroring "process.exit happened before unref'd timer ran"). The test
// then asserts: by the time `stopAll()` resolves, the child must have
// received SIGKILL via SOME path. The only correct path under this seam
// is for `stopAgent`'s wait-timeout callback to explicitly send SIGKILL
// before resolving. RED on staging head; GREEN once the wait-timeout
// callback issues its own SIGKILL.
//
// Independent of PR #3333's stopAgent-level coverage; this asserts the
// orphan-prevention contract at the `stopAll()` boundary that
// `packages/daemon/src/index.ts` shutdown handler actually awaits.
// ─────────────────────────────────────────────────────────────────────────────
test("stopAll guarantees no orphan when unref'd forceAfterMs SIGKILL cannot fire", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  type Pending = { id: number; cb: () => void; ms: number; isUnref: boolean };
  const pending: Pending[] = [];
  let nextId = 1;

  // setTimeout seam: 5000ms timers are intercepted. The first 5000ms timer
  // armed by `ChildProcessRuntimeSession.stop({forceAfterMs:5000})` is the
  // unref'd SIGKILL fallback — we mark it `isUnref` once `.unref()` is
  // called on the returned handle, then deliberately drop it from firing
  // (simulating `process.exit(0)` before unref'd timer would run).
  // Other 5000ms timers (stopAgent wait-timeout) and non-5000ms timers
  // still fire normally.
  const fakeSetTimeout = ((cb: () => void, ms?: number, ...args: any[]) => {
    if (ms === 5000) {
      const entry: Pending = { id: nextId++, cb, ms, isUnref: false };
      pending.push(entry);
      // Return a handle with `.unref()` that marks the timer as orphaned.
      return {
        unref: () => {
          entry.isUnref = true;
          return entry;
        },
        // Timer tooling may call `.ref()` / `.hasRef()` on returned handles.
        ref: () => entry,
        hasRef: () => !entry.isUnref,
        // Mark as a setTimeout-shape object so clearTimeout can detect.
        __forceAfter5sFake: true,
        __entry: entry,
      } as any;
    }
    return realSetTimeout(cb, ms, ...args);
  }) as typeof setTimeout;

  const fakeClearTimeout = ((timer: unknown) => {
    if ((timer as any)?.__forceAfter5sFake) {
      const idx = pending.findIndex((p) => p === (timer as any).__entry);
      if (idx >= 0) pending.splice(idx, 1);
      return;
    }
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  (globalThis as any).setTimeout = fakeSetTimeout;
  (globalThis as any).clearTimeout = fakeClearTimeout;

  try {
    await withManager(async ({ driver, manager }) => {
      await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }), undefined, undefined, undefined, "launch-1");

      const proc = driver.processes[0];
      assert.ok(proc, "agent process must exist after startAgent");

      // Simulate Claude Code mid-API-call: child does not exit on SIGTERM.
      proc.ignoredKillSignals.add("SIGTERM");

      const observedKillSignals: Array<NodeJS.Signals | number | undefined> = [];
      const originalKill = proc.kill.bind(proc);
      proc.kill = (signal?: NodeJS.Signals | number) => {
        observedKillSignals.push(signal);
        return originalKill(signal);
      };

      // Kick off stopAll() and immediately fire ONLY the non-unref'd 5000ms
      // timers (i.e. the wait-promise timeout). Leave unref'd timers
      // (forceAfterMs SIGKILL) un-fired — they represent the post-process.exit
      // dead unref'd handle in production.
      const stopAllPromise = manager.stopAll();
      // Yield once to let the wait-promise arm its 5000ms timer.
      await new Promise((r) => realSetTimeout(r, 0));
      // Fire only the non-unref 5s timer (the wait-promise timeout).
      // The unref'd SIGKILL timer stays pending forever, simulating
      // process.exit pre-empting it.
      for (const p of [...pending]) {
        if (!p.isUnref) {
          const idx = pending.indexOf(p);
          if (idx >= 0) pending.splice(idx, 1);
          p.cb();
        }
      }
      await stopAllPromise;

      // Orphan-prevention contract: by stopAll() resolution, the child must
      // have received SIGKILL (some active path must call it, NOT the unref'd
      // timer which we suppressed). On staging head, no such active path
      // exists → assertion fails RED.
      assert.ok(
        observedKillSignals.includes("SIGKILL"),
        `stopAll() resolved without SIGKILL while unref'd timer was suppressed. Child would be orphaned at process.exit. observed signals: ${JSON.stringify(observedKillSignals)}`,
      );
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

function readinessRows(sink: MemoryTraceSink): LaunchTransitionRow[] {
  return sink.getAllSpans()
    .filter((span) => span.name === LAUNCH_RUNTIME_READINESS_TRANSITION_SPAN)
    .map((span) => ({ name: span.name, attrs: span.attrs ?? {} }));
}

test("launch phase-5: spawn opens the readiness wait, first runtime event closes it advanced", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const readinessDriver = new FakeCodexDriver({
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    startupReadiness: "initial_turn",
  });
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      undefined,
      undefined,
      undefined,
      "launch-happy-1",
    );
    await flush();

    // Before any runtime event: exactly one open readiness enter, no close.
    const openRows = readinessRows(sink);
    assert.equal(openRows.filter((r) => r.attrs.transition_kind === "enter").length, 1);
    assert.equal(openRows.filter((r) => r.attrs.transition_kind === "close").length, 0);

    // session_init must NOT satisfy readiness (excluded event kind).
    driver.parsedLines.set("session-init", [{ kind: "session_init", sessionId: "codex-thread-1" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    assert.equal(readinessRows(sink).filter((r) => r.attrs.transition_kind === "close").length, 0,
      "session_init should not close the readiness wait");

    // First real runtime event (initial turn start) satisfies readiness.
    driver.parsedLines.set("turn-started", [{ kind: "thinking", text: "" }]);
    driver.processes[0].stdout.emit("data", Buffer.from("turn-started\n"));
    await flush();

    const rows = readinessRows(sink);
    assertLaunchReadinessPairing("phase5-advanced", rows);
    const enter = rows.find((r) => r.attrs.transition_kind === "enter")!;
    const close = rows.find((r) => r.attrs.transition_kind === "close")!;
    assert.ok(enter, "readiness enter emitted");
    assert.ok(close, "readiness close emitted");
    assert.equal(enter.attrs.is_wait_state, true);
    assert.equal(enter.attrs.fence_kind, "runtime_startup_timeout");
    assert.equal(typeof enter.attrs.deadline_unix_ms, "number");
    assert.equal(enter.attrs.state_instance_id, close.attrs.state_instance_id);
    assert.equal(enter.attrs.agent_id, "agent-1");
    assert.equal(enter.attrs.agent_launch_id, "launch-happy-1");
    assert.equal(enter.attrs.negative_evidence_bucket, undefined);
    assert.equal(close.attrs.close_result, "advanced");
  }, { driver: readinessDriver, tracer });
});

test("launch phase-5: startup timeout closes the readiness wait with close_result=timeout", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const originalTimeout = process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
  const { sink, tracer } = makeDeterministicTracer();
  let startupTimeoutCallback: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 2_500) {
      startupTimeoutCallback = callback;
      return { startupTimeout: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.startupTimeout) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = "2500";

  const driver = new FakeCodexDriver({
    id: "gemini",
    supportsStdinNotification: true,
    busyDeliveryMode: "notification",
  });

  try {
    await withManager(async ({ manager }) => {
      await manager.startAgent(
        "agent-1",
        makeConfig({ runtime: "gemini", model: "gemini-3.1-pro-preview", sessionId: "session-1" }),
        undefined,
        undefined,
        undefined,
        "launch-timeout-1",
      );

      assert.ok(startupTimeoutCallback, "starting should install the readiness fence");
      // Fence armed => exactly one open readiness enter with a deadline.
      const enter = readinessRows(sink).find((r) => r.attrs.transition_kind === "enter")!;
      assert.ok(enter, "readiness enter emitted on fence arm");
      assert.equal(enter.attrs.fence_kind, "runtime_startup_timeout");

      startupTimeoutCallback!();
      await flush();

      const rows = readinessRows(sink);
      assertLaunchReadinessPairing("phase5-timeout", rows);
      const close = rows.find((r) => r.attrs.transition_kind === "close")!;
      assert.ok(close, "readiness close emitted on timeout");
      assert.equal(close.attrs.close_result, "timeout");
      assert.equal(close.attrs.agent_launch_id, "launch-timeout-1");
      assert.equal(close.attrs.state_instance_id, enter.attrs.state_instance_id);
    }, { driver, tracer });
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS;
    } else {
      process.env.SLOCK_DAEMON_RUNTIME_START_TIMEOUT_MS = originalTimeout;
    }
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

function activationRows(sink: MemoryTraceSink): LaunchTransitionRow[] {
  return sink.getAllSpans()
    .filter((span) => span.name === LAUNCH_ACTIVATION_DELIVERY_TRANSITION_SPAN)
    .map((span) => ({ name: span.name, attrs: span.attrs ?? {} }));
}

test("launch phase-6: wake message activation opens at spawn and closes advanced when delivered", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      makeMessage("hello activation"),
      undefined,
      undefined,
      "launch-act-1",
    );
    await flush();
    // Drive readiness so any deferred (stdin) delivery can complete.
    driver.processes[0].stdout.emit("data", Buffer.from("session-init\n"));
    await flush();
    driver.processes[0].stdout.emit("data", Buffer.from("turn-end\n"));
    await flush();

    const rows = activationRows(sink);
    assertLaunchActivationPairing("phase6-advanced", rows);
    const enter = rows.find((r) => r.attrs.transition_kind === "enter")!;
    const close = rows.find((r) => r.attrs.transition_kind === "close")!;
    assert.ok(enter, "activation enter emitted for wake-carrying launch");
    assert.ok(close, "activation close emitted once delivered");
    assert.equal(enter.attrs.is_wait_state, true);
    assert.equal(enter.attrs.state, "awaiting_activation_delivery");
    assert.equal(enter.attrs.agent_launch_id, "launch-act-1");
    assert.equal(enter.attrs.state_instance_id, close.attrs.state_instance_id);
    assert.equal(close.attrs.close_result, "advanced");
    assert.ok(
      close.attrs.delivered_via === "spawn_prompt" || close.attrs.delivered_via === "stdin",
      `delivered_via should be a closed delivery path, got ${String(close.attrs.delivered_via)}`,
    );
  }, { tracer });
});

test("launch phase-6: transient-wake activation left open then closes terminal when the process dies undelivered", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager }) => {
    // Transient wake is not folded into the spawn prompt, so the activation
    // stays open (deferred to post-ready stdin) — the queryable stuck window.
    await manager.startAgent(
      "agent-1",
      makeConfig({ sessionId: "session-1" }),
      makeMessage("transient activation"),
      undefined,
      undefined,
      "launch-act-2",
      /* wakeMessageTransient */ true,
    );
    await flush();

    const openRows = activationRows(sink);
    assert.equal(openRows.filter((r) => r.attrs.transition_kind === "enter").length, 1, "activation enter opened");
    assert.equal(openRows.filter((r) => r.attrs.transition_kind === "close").length, 0, "activation stays open before delivery");

    // Process dies before the deferred activation is delivered.
    driver.processes[0].close(1, null);
    await flush();

    const rows = activationRows(sink);
    assertLaunchActivationPairing("phase6-terminal", rows);
    const close = rows.find((r) => r.attrs.transition_kind === "close")!;
    assert.ok(close, "activation close emitted on process death");
    assert.equal(close.attrs.close_result, "terminal");
    assert.equal(close.attrs.delivered_via, undefined);
    assert.equal(close.attrs.agent_launch_id, "launch-act-2");
  }, { tracer });
});


test("runtime rate-limit telemetry remains diagnostic without publishing account usage", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  await withManager(async ({ driver, manager, sent }) => {
    await manager.startAgent("agent-1", makeConfig());
    driver.parsedLines.set("rate-limit", [{
      kind: "telemetry",
      name: "rate_limits",
      source: "codex_account_rate_limits_updated",
      attrs: { usedPercent: 42, resetsAt: 1_786_080_000 },
    }]);
    driver.processes[0].stdout.emit("data", Buffer.from("rate-limit\n"));
    await flush();
    assert.ok(sink.getAllSpans().some((span) => span.name === "daemon.runtime.telemetry.rate_limits"));
    assert.deepEqual(sent.filter((message) => message.type === "machine:runtime_account_usage:snapshot"), []);
  }, { tracer });
});
