import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";

import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core.js";
import { PiSdkRuntimeSession } from "./pi.js";
import type { PiToolExecutionObserver } from "./piToolExecutionObservability.js";
import type { SpawnContext } from "./types.js";

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
  const snapshot = [...sink.getAllSpans()]
    .reverse()
    .find((span) => span.name === "daemon.runtime.tool.diagnostic.snapshot");
  assert.equal(snapshot?.attrs?.runtime_session_id, "pi-session-runtime-observer");
  assert.equal(snapshot?.attrs?.runtime_session_id_present, true);
  assert.equal(snapshot?.attrs?.runtime_tool_call_id_present, true);
  assert.equal(snapshot?.attrs?.process_liveness, "alive");
  assert.doesNotMatch(JSON.stringify(sink.getAllSpans()), /must-not-export|upstream-id-private/);

  hold.resolve();
  await running;
  await runtime.dispose();
});
