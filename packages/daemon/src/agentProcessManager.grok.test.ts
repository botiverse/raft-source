import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  BasicTracer,
  MemoryTraceSink,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";
import { AgentProcessManager, resolveRuntimeSessionRef } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import { GrokDriver } from "./drivers/grok.js";
import type { SpawnContext, SpawnResult } from "./drivers/types.js";

class FakeGrokChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
  };

  kill(): boolean {
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }
}

class ApmTestGrokDriver extends GrokDriver {
  readonly processes: FakeGrokChildProcess[] = [];
  readonly encodedCalls: Array<{
    text: string;
    mode: "idle" | "busy";
    request: Record<string, unknown>;
  }> = [];

  override async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const proc = new FakeGrokChildProcess();
    this.processes.push(proc);
    assert.ok(this.encodeStdinMessage(ctx.prompt, "session-1", { mode: "idle" }));
    return { process: proc as unknown as ChildProcess };
  }

  override encodeStdinMessage(
    text: string,
    sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    const encoded = super.encodeStdinMessage(text, sessionId, opts);
    if (encoded) {
      this.encodedCalls.push({
        text,
        mode: opts?.mode ?? "busy",
        request: JSON.parse(encoded) as Record<string, unknown>,
      });
    }
    return encoded;
  }
}

function makeGrokConfig(): AgentConfig {
  return {
    name: "grok-agent",
    displayName: "Grok Agent",
    description: "test agent",
    model: "grok-4.5",
    runtime: "grok",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://daemon.example.com",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: "cred-test",
  };
}

function makeMessage(content: string): AgentMessage {
  return {
    message_id: `message-${content}`,
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    timestamp: "2026-07-19T16:00:00.000Z",
  };
}

function emitGrokLine(proc: FakeGrokChildProcess, message: Record<string, unknown>): void {
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await flush();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function clearManagerForTest(manager: AgentProcessManager): void {
  if ((manager as any).agentStartPumpTimer) clearTimeout((manager as any).agentStartPumpTimer);
  for (const ap of (manager as any).agents?.values?.() ?? []) {
    ap.notifications.clearTimer();
    if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
    if (ap.activityHeartbeat?.kind === "active") clearInterval(ap.activityHeartbeat.timer);
    if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
    if (ap.exit?.kind === "live" && ap.exit.stalledRecoverySigtermTimer) {
      clearTimeout(ap.exit.stalledRecoverySigtermTimer);
    }
    if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    if (ap.runtimeErrorDeliveryBackoff?.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
  }
  (manager as any).agents?.clear?.();
}

function installManagedRunnerMintFetch(): () => void {
  const originalFetch = globalThis.fetch;
  return installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return new Response(JSON.stringify({
        apiKey: "sk_agent_test_restart",
        credentialId: "cred-test-restart",
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

test("grok session reference resolves updates.jsonl below the default Grok home", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "grok-session-ref-"));
  try {
    const sessionId = "grok-session-1";
    const transcript = path.join(homeDir, ".grok", "sessions", "encoded-workdir", sessionId, "updates.jsonl");
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, "{}\n");

    assert.deepEqual(resolveRuntimeSessionRef("grok", sessionId, homeDir), {
      label: sessionId,
      path: transcript,
      runtime: "grok",
      reachable: true,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("grok session reference accepts an explicit GROK_HOME root and never aliases another session", () => {
  const grokHome = mkdtempSync(path.join(os.tmpdir(), "grok-explicit-home-"));
  try {
    const wrongTranscript = path.join(grokHome, "sessions", "encoded-workdir", "other-session", "updates.jsonl");
    const expectedTranscript = path.join(grokHome, "sessions", "encoded-workdir", "wanted-session", "events.jsonl");
    mkdirSync(path.dirname(wrongTranscript), { recursive: true });
    mkdirSync(path.dirname(expectedTranscript), { recursive: true });
    writeFileSync(wrongTranscript, "wrong\n");
    writeFileSync(expectedTranscript, "expected\n");

    assert.deepEqual(resolveRuntimeSessionRef("grok", "wanted-session", grokHome), {
      label: "wanted-session",
      path: expectedTranscript,
      runtime: "grok",
      reachable: true,
    });
  } finally {
    rmSync(grokHome, { recursive: true, force: true });
  }
});

test("grok session reference records bounded roots when the native transcript is missing", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "grok-session-miss-"));
  try {
    const ref = resolveRuntimeSessionRef("grok", "missing-session", homeDir);
    assert.equal(ref.reachable, false);
    assert.equal(ref.path, "missing-session");
    assert.match(ref.reason ?? "", /attempted_lookup=grok_session_jsonl/);
    assert.match(ref.reason ?? "", /\.grok[/\\]sessions/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("grok interaction lifecycle stays out of Activity and late completion cannot make APM idle", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-ordering-"));
  const sent: MachineToServerMessage[] = [];
  const sink = new MemoryTraceSink();
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    (message) => sent.push(message),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      tracer: new BasicTracer({ sink }),
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const proc = driver.processes[0];
    assert.ok(proc);
    assert.equal(driver.encodedCalls.length, 1, "spawn should start prompt 1");

    const activitiesBeforeInteraction = sent.filter((message) => message.type === "agent:activity").length;
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "pending_interaction",
          tool_call_id: "tool-1",
          kind: "permission",
        },
      },
    });
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "interaction_resolved",
          tool_call_id: "tool-1",
        },
      },
    });
    await flush();
    const interactionActivities = sent.filter(
      (message): message is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
        message.type === "agent:activity",
    ).slice(activitiesBeforeInteraction);
    assert.equal(
      interactionActivities.some((message) => message.entries?.some((entry) =>
        entry.kind === "system" && entry.title === "Grok Build warning"
      ) ?? false),
      false,
      "an automatically resolved Grok interaction must not create a warning Activity",
    );

    assert.equal(manager.deliverMessage("agent-1", makeMessage("queued prompt 2")), true);
    assert.equal(driver.encodedCalls.length, 1, "prompt 2 stays queued until prompt 1 completes");

    const firstRequestId = driver.encodedCalls[0]?.request.id;
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: firstRequestId,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    assert.equal(
      driver.encodedCalls.length,
      2,
      "prompt 1 terminal must deliver queued prompt 2 before the semantic event returns",
    );
    assert.equal(driver.encodedCalls[1]?.mode, "idle");
    assert.equal((manager as any).agents.get("agent-1").gatedSteering.isIdle, false);

    // A queued next turn is not idle. Even if a stale projection currently
    // shows online, runtime progress must still restore the live Working state.
    (manager as any).broadcastActivity("agent-1", "online", "Quiet projection", [], undefined, "idle");
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: { sessionId: "session-1", queue: [] },
    });
    await flush();
    assert.equal((manager as any).agents.get("agent-1").lastActivityKind, "working");
    assert.equal((manager as any).agents.get("agent-1").lastActivityDetail, "Working");

    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-1",
          stop_reason: "end_turn",
        },
      },
    });
    await flush();
    assert.equal(driver.encodedCalls.length, 2, "late prompt 1 terminal must not trigger another idle delivery");
    assert.equal(
      (manager as any).agents.get("agent-1").gatedSteering.isIdle,
      false,
      "APM must remain busy while prompt 2 is active",
    );

    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: driver.encodedCalls[1]?.request.id,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-2" } },
    });
    assert.equal(
      (manager as any).agents.get("agent-1").gatedSteering.isIdle,
      true,
      "prompt 2 real terminal must make APM idle before the semantic event returns",
    );
    assert.equal(driver.encodedCalls.length, 2);

    const ap = (manager as any).agents.get("agent-1");
    const activitiesAtIdle = sent.filter(
      (message): message is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
        message.type === "agent:activity",
    );
    const terminalIdle = activitiesAtIdle.at(-1);
    assert.ok(terminalIdle);
    assert.equal("activity" in terminalIdle, false);
    assert.equal("activityKind" in terminalIdle, false);
    assert.equal(terminalIdle?.detail, "Idle");
    assert.equal(terminalIdle?.detailKind, "idle");
    assert.equal(ap.activityHeartbeat.kind, "inactive");

    // Real Grok 0.2.103 emitted both shapes adjacent to terminal completion.
    // Once APM has committed Idle, neither may revive user-visible Working or
    // restart its heartbeat without a queued next turn.
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "available_commands_update", commands: [] },
      },
    });
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/queue/changed",
      params: { sessionId: "session-1", queue: [] },
    });
    await flush();

    const activitiesAfterTrailingProgress = sent.filter(
      (message): message is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
        message.type === "agent:activity",
    );
    assert.equal(activitiesAfterTrailingProgress.length, activitiesAtIdle.length);
    assert.equal(activitiesAfterTrailingProgress.at(-1)?.clientSeq, terminalIdle?.clientSeq);
    assert.equal(ap.lastActivityKind, "online");
    assert.equal(ap.lastActivityDetail, "Idle");
    assert.equal(ap.activityHeartbeat.kind, "inactive");

    assert.deepEqual(
      sink.getAllSpans()
        .filter((span) => span.name === "daemon.runtime.progress.activity.suppressed")
        .map((span) => ({
          outcome: span.attrs?.outcome,
          source: span.attrs?.source,
          itemType: span.attrs?.itemType,
        })),
      [
        {
          outcome: "apm_idle",
          source: "grok_acp_notification",
          itemType: "available_commands_update",
        },
        {
          outcome: "apm_idle",
          source: "grok_acp_notification",
          itemType: "_x.ai/queue/changed",
        },
      ],
    );
  } finally {
    clearManagerForTest(manager);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grok autonomous successor terminal restores Idle after background progress", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-autonomous-successor-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    (message) => sent.push(message),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const proc = driver.processes[0];
    assert.ok(proc);

    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: driver.encodedCalls[0]?.request.id,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    await flush();
    assert.equal((manager as any).agents.get("agent-1").lastActivityDetail, "Idle");

    const stale = (manager as any).agents.get("agent-1");
    stale.lastActivityKind = "working";
    stale.lastActivityDetail = "Working";
    stale.lastActivityDetailKind = "working";
    assert.equal(stale.lastActivityKind, "working");

    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "task-completed-call-1",
          stop_reason: "end_turn",
        },
      },
    });
    await flush();

    const ap = (manager as any).agents.get("agent-1");
    assert.equal(ap.gatedSteering.isIdle, true);
    assert.equal(ap.lastActivityKind, "online");
    assert.equal(ap.lastActivityDetail, "Idle");
    assert.equal(ap.activityHeartbeat.kind, "inactive");
  } finally {
    clearManagerForTest(manager);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grok response-first late concrete output cannot strand the next inbound behind a closed turn", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-response-first-"));
  const sink = new MemoryTraceSink();
  const sent: MachineToServerMessage[] = [];
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    (message) => sent.push(message),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      tracer: new BasicTracer({ sink }),
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const proc = driver.processes[0];
    assert.ok(proc);
    const firstRequestId = driver.encodedCalls[0]?.request.id;

    // Grok may complete the request response-first and only then emit the last
    // concrete assistant chunk for that same generation.
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: firstRequestId,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    await waitFor(
      () => (manager as any).agents.get("agent-1").gatedSteering.isIdle === true,
      "response-first turn end",
    );
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "late thought from prompt 1" },
        },
      },
    });
    await flush();
    (manager as any).flushPendingTrajectory("agent-1");

    const ap = (manager as any).agents.get("agent-1");
    const apmIdleAfterLateOutput = ap.gatedSteering.isIdle;
    const driverCanSteerAfterLateOutput =
      driver.encodeStdinMessage("steerability probe", "session-1", { mode: "busy" }) !== null;

    assert.equal(manager.deliverMessage("agent-1", makeMessage("next prompt")), true);
    // Exercise the same scheduled busy-notification attempt synchronously so
    // the regression receipt is deterministic and does not depend on timers.
    (manager as any).sendStdinNotification("agent-1");

    const routed = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.delivery.routed")
      .at(-1);
    const notification = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.stdin_notification")
      .at(-1);

    assert.deepEqual({
      apmIdleAfterLateOutput,
      driverCanSteerAfterLateOutput,
      lateOutputObservable: sent.some((message) =>
        message.type === "agent:activity"
        && (message.entries?.some((entry) => entry.kind === "thinking" && entry.text.includes("late thought")) ?? false)
      ),
      deliveryModes: driver.encodedCalls.map((call) => call.mode),
      routedOutcome: routed?.attrs?.outcome,
      notificationOutcome: notification?.attrs?.outcome,
      notificationFailureReason: notification?.attrs?.failure_reason,
      retryScheduled: notification?.attrs?.retry_scheduled,
      notificationTimerPresent: notification?.attrs?.notification_timer_present,
      pendingNotificationCount: ap.notifications.pendingCount,
      pendingInboxCount: ap.inbox.length,
    }, {
      apmIdleAfterLateOutput: true,
      driverCanSteerAfterLateOutput: false,
      lateOutputObservable: true,
      deliveryModes: ["idle", "idle"],
      routedOutcome: "stdin_idle_delivery",
      notificationOutcome: undefined,
      notificationFailureReason: undefined,
      retryScheduled: undefined,
      notificationTimerPresent: undefined,
      pendingNotificationCount: 0,
      pendingInboxCount: 1,
    });

    // Once the idle follow-up starts generation 2, ordinary concrete progress
    // remains busy and the next notification still takes Grok's direct steer.
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "active thought from prompt 2" },
        },
      },
    });
    await flush();
    assert.equal(ap.gatedSteering.isIdle, false);
    assert.equal(manager.deliverMessage("agent-1", makeMessage("steer active prompt 2")), true);
    assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    assert.equal(driver.encodedCalls.at(-1)?.mode, "busy");
    assert.equal((driver.encodedCalls.at(-1)?.request as any)?.method, "_x.ai/interject");
    assert.equal(
      sink.getAllSpans().some((span) => span.name === "daemon.agent.pending_delivery.flush_outcome"),
      false,
      "a successful active-turn interject must not enter the closed-turn fallback",
    );
  } finally {
    clearManagerForTest(manager);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grok closed native turn flushes ordered notification debt once through idle delivery", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-closed-turn-debt-"));
  const sink = new MemoryTraceSink();
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    () => {},
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      tracer: new BasicTracer({ sink }),
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const proc = driver.processes[0];
    assert.ok(proc);
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: driver.encodedCalls[0]?.request.id,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    await waitFor(
      () => (manager as any).agents.get("agent-1").gatedSteering.isIdle === true,
      "initial Grok idle",
    );

    const ap = (manager as any).agents.get("agent-1");
    const first = makeMessage("first ordered debt");
    const second = makeMessage("second ordered debt");
    (manager as any).clockNow = () => Date.parse(first.timestamp) + 10_000;
    ap.inbox.push(first, second);
    ap.notifications.add(2);
    // Model the defensive split-brain boundary directly: APM says busy while
    // the real Grok normalizer still owns no active generation.
    (manager as any).commitApmIdleState("agent-1", ap, false);

    assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    assert.deepEqual(ap.inbox.map((message: AgentMessage) => message.content), [
      "first ordered debt",
      "second ordered debt",
    ]);
    assert.equal(ap.notifications.pendingCount, 0);
    assert.deepEqual(driver.encodedCalls.map((call) => call.mode), ["idle", "idle"]);
    assert.equal((driver.encodedCalls[1]?.request as any)?.method, "session/prompt");
    assert.match(String(((driver.encodedCalls[1]?.request as any)?.params as any)?.prompt?.[0]?.text), /2 unread messages/);

    const reconciliation = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.busy_delivery.readiness_reconciled")
      .at(-1);
    assert.equal(reconciliation?.attrs?.closed_reason, "no_active_turn");
    assert.equal(reconciliation?.attrs?.source, "busy_notification_attempt");
    assert.equal(reconciliation?.attrs?.pending_age_ms_bucket, "10-60s");
    const flushOutcome = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.pending_delivery.flush_outcome")
      .at(-1);
    assert.equal(flushOutcome?.attrs?.closed_reason, "no_active_turn");
    assert.equal(flushOutcome?.attrs?.outcome, "written_idle");
    assert.equal(flushOutcome?.attrs?.pending_age_ms_bucket, "10-60s");
    const newTraceJson = JSON.stringify(sink.getAllSpans().filter((span) =>
      span.name === "daemon.agent.busy_delivery.readiness_reconciled"
      || span.name === "daemon.agent.pending_delivery.flush_outcome"
    ));
    assert.doesNotMatch(
      newTraceJson,
      /first ordered debt|second ordered debt|session-1|sk_agent_|sk_machine_/,
      "closed-turn observability must not contain message text, session ids, or credentials",
    );

    // Re-projecting the same two still-unconsumed rows must not inject them a
    // second time; the contribution identity memo settles the retry debt.
    ap.notifications.add(2);
    assert.equal((manager as any).sendStdinNotification("agent-1"), false);
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(driver.encodedCalls.length, 2);
  } finally {
    clearManagerForTest(manager);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grok notification timer debt that observes idle flushes as one idle prompt", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-idle-notification-debt-"));
  const sink = new MemoryTraceSink();
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    () => {},
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
      tracer: new BasicTracer({ sink }),
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const proc = driver.processes[0];
    assert.ok(proc);
    emitGrokLine(proc, {
      jsonrpc: "2.0",
      id: driver.encodedCalls[0]?.request.id,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    await waitFor(
      () => (manager as any).agents.get("agent-1").gatedSteering.isIdle === true,
      "initial Grok idle before notification debt flush",
    );

    const ap = (manager as any).agents.get("agent-1");
    ap.inbox.push(makeMessage("timer debt observed after turn end"));
    ap.notifications.add();

    assert.equal((manager as any).sendStdinNotification("agent-1"), true);
    assert.equal(ap.notifications.pendingCount, 0);
    assert.deepEqual(driver.encodedCalls.map((call) => call.mode), ["idle", "idle"]);
    assert.equal((driver.encodedCalls[1]?.request as any)?.method, "session/prompt");

    const flushOutcome = sink.getAllSpans()
      .filter((span) => span.name === "daemon.agent.pending_delivery.flush_outcome")
      .at(-1);
    assert.equal(flushOutcome?.attrs?.trigger, "notification_timer_observed_idle");
    assert.equal(flushOutcome?.attrs?.outcome, "written_idle");
    assert.equal(typeof flushOutcome?.attrs?.pending_age_ms_bucket, "string");
  } finally {
    clearManagerForTest(manager);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("grok pending inbox debt survives a clean Grok subprocess restart in original order", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "grok-apm-restart-debt-"));
  const restoreFetch = installManagedRunnerMintFetch();
  const driver = new ApmTestGrokDriver();
  const manager = new AgentProcessManager(
    () => {},
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      driverResolver: () => driver,
      runtimeSessionHomeDir: dataDir,
    },
  );

  try {
    await manager.startAgent("agent-1", makeGrokConfig());
    const firstProcess = driver.processes[0];
    assert.ok(firstProcess);
    emitGrokLine(firstProcess, {
      jsonrpc: "2.0",
      id: driver.encodedCalls[0]?.request.id,
      result: { stopReason: "end_turn", _meta: { promptId: "prompt-1" } },
    });
    await waitFor(
      () => (manager as any).agents.get("agent-1").gatedSteering.isIdle === true,
      "initial Grok idle before restart",
    );

    const apBeforeRestart = (manager as any).agents.get("agent-1");
    apBeforeRestart.inbox.push(
      makeMessage("first restart debt"),
      makeMessage("second restart debt"),
    );
    apBeforeRestart.notifications.add(2);

    firstProcess.emit("exit", 0, null);
    firstProcess.emit("close", 0, null);
    await waitFor(() => driver.processes.length === 2, "Grok restart with pending debt");

    const apAfterRestart = (manager as any).agents.get("agent-1");
    assert.deepEqual(apAfterRestart.inbox.map((message: AgentMessage) => message.content), [
      "first restart debt",
      "second restart debt",
    ]);
    assert.equal(driver.encodedCalls.length, 2);
    assert.equal(driver.encodedCalls[1]?.mode, "idle");
    assert.match(driver.encodedCalls[1]?.text ?? "", /2 unread messages/);
    assert.doesNotMatch(driver.encodedCalls[1]?.text ?? "", /first restart debt|second restart debt/);
  } finally {
    clearManagerForTest(manager);
    restoreFetch();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
