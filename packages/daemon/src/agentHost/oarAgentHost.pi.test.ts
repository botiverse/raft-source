import assert from "node:assert/strict";
import type { Event, EventObserver, EventsOptions, Session } from "@botiverse/oar";
import { SESSION_NEEDS_RESET_THRESHOLD, SessionCompactionFailureLedger } from "../sessionCompactionFailureLedger";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import type { OarAgentHostDeps } from "./oarAgentHost";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const piConfig = (overrides: Parameters<typeof makeConfig>[0] = {}) => makeConfig({
  runtime: "pi",
  model: "anthropic/claude-sonnet-4-6",
  ...overrides,
});

const piLaunchDeps: Partial<OarAgentHostDeps> = {
  platform: "linux",
  piRpcAvailable: () => true,
  prepareLaunch: async (ctx) => ({
    runtimeId: "pi",
    installation: { kind: "available", via: "bundled" },
    options: {
      cwd: ctx.workingDirectory,
      env: {},
      systemPrompt: ctx.standingPrompt,
      ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
      ...(ctx.config.model ? { model: ctx.config.model } : {}),
    },
    busyDelivery: "now",
  }),
};

function withEventTap(taps: EventObserver[]) {
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "events"
      ? (observer: EventObserver, options?: EventsOptions) => { taps.push(observer); return target.events(observer, options); }
      : Reflect.get(target, prop, receiver),
  });
}

function reported(session: Session, body: Record<string, unknown>): Event {
  return { sessionId: session.id, agentPath: [], seq: 1_000_000, receivedAt: Date.now(), ...body } as unknown as Event;
}

test("OarAgentHost.supports gates Pi on platform and piRpcAvailable", async () => {
  const linuxOk = await harness({ deps: { platform: "linux", piRpcAvailable: () => true } });
  const darwinOk = await harness({ deps: { platform: "darwin", piRpcAvailable: () => true } });
  const win32 = await harness({ deps: { platform: "win32", piRpcAvailable: () => true } });
  const noRpc = await harness({ deps: { platform: "linux", piRpcAvailable: () => false } });
  try {
    assert.deepEqual(linuxOk.host.supports(request({ config: piConfig() })), { ok: true });
    assert.deepEqual(darwinOk.host.supports(request({ config: piConfig() })), { ok: true });
    assert.deepEqual(win32.host.supports(request({ config: piConfig() })), { ok: false, reason: "platform_unsupported" });
    assert.deepEqual(noRpc.host.supports(request({ config: piConfig() })), { ok: false, reason: "pi_rpc_unavailable" });
    // Built-in is never hosted on OAR.
    assert.deepEqual(linuxOk.host.supports(request({ config: makeConfig({ runtime: "builtin" }) })), { ok: false, reason: "runtime_not_hosted:builtin" });
  } finally {
    await Promise.all([linuxOk.cleanup(), darwinOk.cleanup(), win32.cleanup(), noRpc.cleanup()]);
  }
});

test("OarAgentHost records Pi compaction failures and refuses resume as session_needs_reset at threshold without falling back", async () => {
  const taps: EventObserver[] = [];
  let gate = deferred();
  const h = await harness({
    turn: async (turn) => {
      await gate.promise;
      turn.say("done");
    },
    wrapSession: withEventTap(taps),
    deps: piLaunchDeps,
  });
  try {
    for (let i = 0; i < SESSION_NEEDS_RESET_THRESHOLD; i += 1) {
      taps.length = 0;
      gate = deferred();
      const outcome = await h.host.start(request({
        agentId: "agent-pi-1",
        launchId: `launch-${i + 1}`,
        config: piConfig({ sessionId: "pi-sess-stuck" }),
        wakeMessage: message(`m-${i + 1}`),
      }));
      assert.deepEqual(outcome, { kind: "started" });
      await until(() => h.inputs.length === i + 1, `turn #${i + 1} started`);
      const session = h.sessions[h.sessions.length - 1]!;
      for (const tap of taps) {
        tap(reported(session, { kind: "compaction_started", trigger: "auto" }));
        tap(reported(session, { kind: "compaction_ended", outcome: "failed", trigger: "auto", reason: "context overflow" }));
      }
      await until(
        () => h.events.filter((e) => e.name === "daemon.agent.compaction.terminal_failure_counted").length === i + 1,
        `compaction failure #${i + 1} counted`,
      );
      gate.resolve();
      await h.host.stopAgent("agent-pi-1", { wait: true });
    }

    const countedEvents = h.events.filter((e) => e.name === "daemon.agent.compaction.terminal_failure_counted");
    assert.equal(countedEvents[countedEvents.length - 1]?.attrs.model, "anthropic/claude-sonnet-4-6");
    assert.equal(countedEvents[countedEvents.length - 1]?.attrs.needs_reset, true);

    const openedBeforeRefusal = h.sessions.length;
    assert.equal(openedBeforeRefusal, SESSION_NEEDS_RESET_THRESHOLD);

    // Next start resuming the same session + model is refused in-place (failHereReason: session_needs_reset).
    const refused = await h.host.start(request({
      agentId: "agent-pi-1",
      launchId: "launch-refused",
      config: piConfig({ sessionId: "pi-sess-stuck" }),
      wakeMessage: message("m-refused"),
    }));
    assert.equal(refused.kind, "fallback");
    if (refused.kind === "fallback") {
      assert.equal(refused.reason, "session_needs_reset");
      assert.equal(refused.failHereReason, "session_needs_reset");
      assert.match(refused.failHere ?? "", /failed context compaction 3 times in a row/u);
      assert.match(refused.failHere ?? "", /Reset Session/u);
    }
    assert.equal(h.sessions.length, openedBeforeRefusal, "refused before opening session");

    // Different model is allowed.
    gate = deferred();
    const diffModel = await h.host.start(request({
      agentId: "agent-pi-1",
      launchId: "launch-diff-model",
      config: piConfig({ sessionId: "pi-sess-stuck", model: "openai/gpt-5.4" }),
      wakeMessage: message("m-diff-model"),
    }));
    assert.deepEqual(diffModel, { kind: "started" });
    gate.resolve();
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OarAgentHost clears Pi compaction failure ledger on completed compaction and ignores aborted", async () => {
  const taps: EventObserver[] = [];
  let gate = deferred();
  const h = await harness({
    turn: async (turn) => {
      await gate.promise;
      turn.say("ok");
    },
    wrapSession: withEventTap(taps),
    deps: piLaunchDeps,
  });
  try {
    // Pre-seed 2 consecutive failures (one below threshold).
    const ledger = new SessionCompactionFailureLedger(h.dataDir);
    ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6");
    ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6");

    // Aborted compaction leaves ledger count intact (still 2, neither incremented nor cleared).
    const start1 = await h.host.start(request({
      agentId: "agent-pi-2",
      launchId: "launch-aborted",
      config: piConfig({ sessionId: "pi-sess-clear" }),
      wakeMessage: message("m-1"),
    }));
    assert.deepEqual(start1, { kind: "started" });
    await until(() => h.inputs.length === 1, "turn 1 started");
    for (const tap of taps) {
      tap(reported(h.sessions[0]!, { kind: "compaction_started", trigger: "auto" }));
      tap(reported(h.sessions[0]!, { kind: "compaction_ended", outcome: "aborted", trigger: "auto" }));
    }
    gate.resolve();
    await h.host.stopAgent("agent-pi-2", { wait: true });
    assert.equal(ledger.needsReset("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6"), null);
    assert.equal(ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6"), 3, "aborted did not clear or increment");

    // Reset to 2 and run a completed compaction -> clears ledger.
    ledger.clear("agent-pi-2");
    ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6");
    ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6");
    taps.length = 0;
    gate = deferred();
    const start2 = await h.host.start(request({
      agentId: "agent-pi-2",
      launchId: "launch-completed",
      config: piConfig({ sessionId: "pi-sess-clear" }),
      wakeMessage: message("m-2"),
    }));
    assert.deepEqual(start2, { kind: "started" });
    await until(() => h.inputs.length === 2, "turn 2 started");
    for (const tap of taps) {
      tap(reported(h.sessions[1]!, { kind: "compaction_started", trigger: "auto" }));
      tap(reported(h.sessions[1]!, { kind: "compaction_ended", outcome: "completed", trigger: "auto" }));
    }
    gate.resolve();
    await h.host.stopAgent("agent-pi-2", { wait: true });
    assert.equal(ledger.recordFailure("agent-pi-2", "pi-sess-clear", "anthropic/claude-sonnet-4-6"), 1, "completed compaction cleared prior streak");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OarAgentHost attributes compaction failures to the live session's runtimeConfig model even after a model-changing config push", async () => {
  const taps: EventObserver[] = [];
  const gate = deferred();
  const h = await harness({
    turn: async (turn) => {
      await gate.promise;
      turn.say("done");
    },
    wrapSession: withEventTap(taps),
    deps: piLaunchDeps,
  });
  try {
    const start = await h.host.start(request({
      agentId: "agent-pi-rebind",
      launchId: "launch-m1",
      config: piConfig({ sessionId: "pi-sess-rebind", model: "anthropic/claude-sonnet-4-6" }),
      wakeMessage: message("m-1"),
    }));
    assert.deepEqual(start, { kind: "started" });
    await until(() => h.inputs.length === 1, "turn running on M1");

    // Push a config update changing model to M2 while the M1 turn is still running.
    h.host.applyConfig("agent-pi-rebind", piConfig({ sessionId: "pi-sess-rebind", model: "openai/gpt-5.4" }), 2);

    // Emit compaction failure on the live M1 session.
    const session = h.sessions[0]!;
    for (const tap of taps) {
      tap(reported(session, { kind: "compaction_started", trigger: "auto" }));
      tap(reported(session, { kind: "compaction_ended", outcome: "failed", trigger: "auto", reason: "overflow" }));
    }
    await until(() => h.events.some((e) => e.name === "daemon.agent.compaction.terminal_failure_counted"), "failure counted");
    const counted = h.events.find((e) => e.name === "daemon.agent.compaction.terminal_failure_counted");
    assert.equal(counted?.attrs.model, "anthropic/claude-sonnet-4-6", "attributed to the running session's model, not the pushed M2 config");
    const ledger = new SessionCompactionFailureLedger(h.dataDir);
    assert.equal(ledger.recordFailure("agent-pi-rebind", session.id, "anthropic/claude-sonnet-4-6"), 2, "M1 had count 1");
    assert.equal(ledger.recordFailure("agent-pi-rebind", session.id, "openai/gpt-5.4"), 1, "M2 was not poisoned");
    gate.resolve();
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});
