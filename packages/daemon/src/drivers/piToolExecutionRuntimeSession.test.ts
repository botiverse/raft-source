import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { PiSdkRuntimeSession } from "./pi";
import { createPiCommandTool } from "./piCommandTool";
import type { PiToolExecutionObserver } from "./piToolExecutionObservability";
import type { SpawnContext } from "./types";
import { traceRows } from "../testing/traceRows";

class FakeChildProcess extends EventEmitter {
  readonly pid = process.pid;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(_signal?: number | NodeJS.Signals): boolean {
    return true;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Pi SDK runtime wires accepted turn, SDK update, and manual diagnosis through one observer", async () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(
    new BasicTracer({ sink }),
    DAEMON_CORE_TRACE_ATTR_CONTRACTS,
  );
  const ctx: SpawnContext = {
    agentId: "33333333-3333-4333-8333-333333333333",
    standingPrompt: "standing",
    prompt: "wake",
    workingDirectory: process.cwd(),
    slockCliPath: "/tmp/raft",
    daemonApiKey: "not-exported",
    launchId: "44444444-4444-4444-8444-444444444444",
    tracer,
    config: {
      name: "pi-observer-test",
      displayName: null,
      description: null,
      model: "default",
      runtime: "pi",
      reasoningEffort: null,
      envVars: null,
      sessionId: null,
      serverUrl: "https://example.invalid",
      authToken: "not-exported",
      runtimeContext: {
        serverId: "11111111-1111-4111-8111-111111111111",
        machineId: "22222222-2222-4222-8222-222222222222",
      },
    },
  };
  const sessionEvents = new EventEmitter();
  let observer: PiToolExecutionObserver | undefined;
  const fakeSession = {
    sessionId: "pi-session-runtime-observer",
    isStreaming: false,
    subscribe(cb: (event: AgentSessionEvent) => void) {
      sessionEvents.on("event", cb);
      return () => {
        sessionEvents.off("event", cb);
      };
    },
    async prompt() {},
    async steer() {},
    async abort() {},
    dispose() {},
  };
  const runtime = new PiSdkRuntimeSession(
    ctx,
    () => undefined,
    async (_sessionCtx, _sessionId, toolObserver) => {
      observer = toolObserver;
      return fakeSession as unknown as AgentSession;
    },
  );

  assert.deepEqual(
    await runtime.start({ text: "run a tool" }),
    { ok: true, acceptedAs: "prompt" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(observer, "the exact Pi session factory must receive the runtime-owned observer");

  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer!.runToolExecution("upstream-id-private", undefined, async () => {
    observer!.observeProcessSpawned(child as never, {
      processTreeTracking: "process_group",
      stdioMode: "pipe",
    });
    await hold.promise;
  });
  sessionEvents.emit("event", {
    type: "tool_execution_update",
    toolCallId: "upstream-id-private",
    toolName: "bash",
    args: { command: "must-not-export" },
    partialResult: { content: [{ type: "text", text: "must-not-export" }] },
  } as AgentSessionEvent);

  const snapshots = runtime.emitToolDiagnosticSnapshots({
    trigger: "manual_probe",
    runtimeInactivityAgeMs: 5_000,
    observationIntervalMs: 60_000,
  });
  assert.equal(snapshots[0]?.classification, "running_with_recent_progress");
  const snapshot = [...traceRows(sink)]
    .reverse()
    .find((span) => span.name === "daemon.runtime.tool.diagnostic.snapshot");
  // #424: the raw runtime session id is no longer on the stuck-tool contract, so
  // it never reaches the span — previously it arrived and was dropped later by
  // the sink, which cost a dropped-attribute count on every one of these spans.
  // The fact it carried is unchanged and still asserted, on the flag below
  // (#422 class B: the flag is that fact's only carrier).
  assert.equal(
    snapshot?.attrs?.runtime_session_id,
    undefined,
    "the raw id must not reach the span at all",
  );
  assert.equal(snapshot?.attrs?.runtime_session_id_present, true);
  assert.equal(snapshot?.attrs?.runtime_tool_call_id_present, true);
  assert.equal(snapshot?.attrs?.process_liveness, "alive");
  assert.doesNotMatch(JSON.stringify(traceRows(sink)), /must-not-export|upstream-id-private/);

  hold.resolve();
  await running;
  await runtime.dispose();
});

// Task #1302: built-in runs this same session and command tool, and stalled
// recovery for queued messages depends on these tool facts.
test("built-in runtime session gets the tool observer and labels its facts builtin", async () => {
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS);
  const ctx: SpawnContext = {
    agentId: "33333333-3333-4333-8333-333333333334",
    standingPrompt: "standing",
    prompt: "wake",
    workingDirectory: process.cwd(),
    slockCliPath: "/tmp/raft",
    daemonApiKey: "not-exported",
    launchId: "44444444-4444-4444-8444-444444444445",
    tracer,
    config: {
      name: "builtin-observer-test",
      displayName: null,
      description: null,
      model: "default",
      runtime: "builtin",
      reasoningEffort: null,
      envVars: null,
      sessionId: null,
      serverUrl: "https://example.invalid",
      authToken: "not-exported",
      runtimeContext: {
        serverId: "11111111-1111-4111-8111-111111111111",
        machineId: "22222222-2222-4222-8222-222222222222",
      },
    },
  };
  let observer: PiToolExecutionObserver | undefined;
  const fakeSession = {
    sessionId: "builtin-session-runtime-observer",
    isStreaming: false,
    subscribe() { return () => undefined; },
    async prompt() {},
    async steer() {},
    async abort() {},
    dispose() {},
  };
  const runtime = new PiSdkRuntimeSession(ctx, () => undefined, async (_sessionCtx, _sessionId, toolObserver) => {
    observer = toolObserver;
    return fakeSession as unknown as AgentSession;
  });
  await runtime.start({ text: "run a tool" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(observer, "built-in must get the runtime-owned tool observer");

  const hold = deferred();
  const child = new FakeChildProcess();
  const running = observer!.runToolExecution("builtin-call", undefined, async () => {
    observer!.observeProcessSpawned(child as never, { processTreeTracking: "process_group", stdioMode: "pipe" });
    // The child exits but the tool call never completes (completion loss).
    child.exitCode = 0;
    observer!.observeProcessExit({ code: 0, signal: null });
    await hold.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshots = runtime.emitToolDiagnosticSnapshots({ trigger: "queued_message_recovery", runtimeInactivityAgeMs: 16 * 60_000 });
  assert.equal(snapshots[0]?.classification, "completion_loss");
  const snapshot = [...traceRows(sink)].reverse().find((span) => span.name === "daemon.runtime.tool.diagnostic.snapshot");
  assert.equal(snapshot?.attrs?.runtime, "builtin");
  assert.equal(snapshot?.attrs?.diagnostic_trigger, "queued_message_recovery");

  hold.resolve();
  await running;
  await runtime.dispose();
});

// Pi's session.abort() takes no reason, so the driver records who aborted on
// the observer before it calls it; the real command tool's finished fact then
// says whether a stop or an interrupt ended the command.
for (const variant of [
  { how: "interruptTurn", expected: "aborted_by_interrupt" },
  { how: "stop", expected: "aborted_by_stop" },
  { how: "dispose", expected: "aborted_by_stop" },
  // The interrupt fallback restarts the runtime; the interrupt stays the cause.
  { how: "interruptTurn then stop", expected: "aborted_by_interrupt" },
] as const) {
  test(
    `a command aborted by ${variant.how} finishes with failure_reason ${variant.expected}`,
    { skip: process.platform === "win32" },
    async () => {
      // The driver writes lifecycle diagnostics under the working directory.
      const workingDirectory = await mkdtemp(join(tmpdir(), "pi-abort-cause-"));
      const sink = new MemoryTraceSink();
      const tracer = createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS);
      const ctx: SpawnContext = {
        agentId: "33333333-3333-4333-8333-333333333335",
        standingPrompt: "standing",
        prompt: "wake",
        workingDirectory,
        slockCliPath: "/tmp/raft",
        daemonApiKey: "not-exported",
        launchId: "44444444-4444-4444-8444-444444444446",
        tracer,
        config: {
          name: "abort-cause-test",
          displayName: null,
          description: null,
          model: "default",
          runtime: "pi",
          reasoningEffort: null,
          envVars: null,
          sessionId: null,
          serverUrl: "https://example.invalid",
          authToken: "not-exported",
          runtimeContext: {
            serverId: "11111111-1111-4111-8111-111111111111",
            machineId: "22222222-2222-4222-8222-222222222222",
          },
        },
      };
      const runAbort = new AbortController();
      let observer: PiToolExecutionObserver | undefined;
      const fakeSession = {
        sessionId: "pi-session-abort-cause",
        isStreaming: false,
        subscribe() { return () => undefined; },
        async prompt() {},
        async steer() {},
        async abort() { runAbort.abort(); },
        // Pi's dispose() aborts the running agent too.
        dispose() { runAbort.abort(); },
      };
      const runtime = new PiSdkRuntimeSession(ctx, () => undefined, async (_sessionCtx, _sessionId, toolObserver) => {
        observer = toolObserver;
        return fakeSession as unknown as AgentSession;
      });
      await runtime.start({ text: "run a tool" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(observer);
      const tool = createPiCommandTool(workingDirectory, process.env, { platform: process.platform, observer });

      fakeSession.isStreaming = true;
      const run = tool.execute("call-abort-cause", { command: "sleep 30", timeout: 60 }, runAbort.signal)
        .catch((error: Error) => error.message);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (variant.how.startsWith("interruptTurn")) assert.equal(runtime.interruptTurn(), "sent");
      if (variant.how.endsWith("stop")) await runtime.stop();
      if (variant.how === "dispose") await runtime.dispose();
      assert.match(String(await run), /Command aborted/);

      const finished = traceRows(sink).find((row) => row.name === "daemon.runtime.tool.execution.finished");
      assert.equal(finished?.attrs?.execution_state, "aborted");
      assert.equal(finished?.attrs?.failure_reason, variant.expected);
      fakeSession.isStreaming = false;
      await runtime.dispose();
      await rm(workingDirectory, { recursive: true, force: true });
    },
  );
}
