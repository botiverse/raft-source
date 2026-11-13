// The `daemon.runtime.turn` span of an OAR-hosted agent's turns: one span per
// turn, ended once with the legacy host's outcome values and counters, so the
// observability report reads both hosts' turns with one query.
//
// RED proof (reverse-verified): drop the `trace.start(...)` calls in
// `traceTurnEvent` (oarAgentHost.ts) and every test here finds no turn span;
// let model work see a cut turn's waiting span as running (`trace.open` for
// `trace.turnRunning`) and the runtime's next turn is folded into it; drop
// the exit wait's timer and a cut turn with no exit never ends.
import assert from "node:assert/strict";
import { test } from "vitest";
import type { Cursor, Event, EventObserver, EventsOptions, RawEvent, RawEventObserver, Session } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { BasicTracer, MemoryTraceSink, type CompletedTraceSpan, type Tracer } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { harness, message, request, until, withFailure, type Harness } from "../testing/oarAgentHostHarness";
import type { OarAgentHostDeps } from "./oarAgentHost";

/** A tracer that keeps every span and counts each span's `end` calls (BasicTracer ignores a second one). */
function recordingTracer() {
  const sink = new MemoryTraceSink();
  const inner = new BasicTracer({ sink });
  const started: string[] = [];
  const ends = new Map<string, number>();
  const tracer: Tracer = {
    startSpan(name, options) {
      const span = inner.startSpan(name, options);
      if (name === "daemon.runtime.turn") started.push(span.context.spanId);
      return {
        context: span.context,
        addEvent: (eventName, attrs) => span.addEvent(eventName, attrs),
        end: (status, endOptions) => {
          ends.set(span.context.spanId, (ends.get(span.context.spanId) ?? 0) + 1);
          span.end(status, endOptions);
        },
      };
    },
    emitEvent: (name, options) => inner.emitEvent(name, options),
  };
  return {
    tracer,
    turns: (): CompletedTraceSpan[] => sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn"),
    /** Every turn span started was ended, each exactly once. */
    assertEachEndedOnce(): void {
      for (const spanId of started) assert.equal(ends.get(spanId), 1, `turn span ${spanId} ended once`);
    },
    startedCount: () => started.length,
  };
}

/** The harness's grok launch, keeping the proxy's send outcome hook the host passes (the agent's raft CLI goes through it). */
function launchKeepingSendOutcome(keep: (hook: SpawnContext["agentCredentialProxySendOutcome"]) => void): OarAgentHostDeps["prepareLaunch"] {
  return async (ctx) => {
    keep(ctx.agentCredentialProxySendOutcome);
    return {
      runtimeId: "grok",
      installation: { kind: "available", via: "bundled" },
      options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
      busyDelivery: "after_turn",
    };
  };
}

type Tokens = { input: number; output: number; cacheRead?: number };

/**
 * The session's root `usage` reports carry these running totals, one per
 * turn. The scripted runtime reports its usage as real runtimes may: in the
 * record that ends the turn, after the turn end.
 */
function withUsage(session: Session, totals: Tokens[]): Session {
  let turn = 0;
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "events") {
        return (observer: EventObserver, options?: EventsOptions) => target.events((event: Event) => {
          if (event.kind === "usage" && event.agentPath.length === 0 && turn < totals.length) {
            observer({ ...event, usage: { ...event.usage, tokens: totals[turn]! } });
            turn += 1;
            return;
          }
          observer(event);
        }, options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const waitForAbort = (turn: ScriptedTurn) => new Promise<void>((resolve) => {
  if (turn.signal.aborted) resolve();
  else turn.signal.addEventListener("abort", () => resolve(), { once: true });
});

async function started(h: Harness, trace: ReturnType<typeof recordingTracer>, count = 1): Promise<void> {
  await until(() => trace.startedCount() >= count, `turn span ${count} open`);
}

test("a completed OAR turn is one daemon.runtime.turn span: outcome, counters, Raft sends and tokens as on the legacy host", async () => {
  const trace = recordingTracer();
  let sendOutcome: SpawnContext["agentCredentialProxySendOutcome"];
  const h = await harness({
    turn: async (t) => {
      await t.tool("shell", "raft message send --target \"#a\" <<'RAFTMSG'\nOn it.\nRAFTMSG", () => {
        // What the agent's proxy hears from the Server for this send.
        sendOutcome?.({ state: "sent", messageId: "m-sent" });
        return "Message sent to #a.";
      });
      // An MCP send: the one tool call the legacy host counts as a send attempt (the shell send above is a command).
      await t.tool("send_message", JSON.stringify({ target: "#a", content: "Done." }), () => "sent");
      t.say("done");
    },
    wrapSession: (session) => withUsage(session, [{ input: 1_200, output: 300, cacheRead: 200 }, { input: 2_000, output: 500, cacheRead: 300 }]),
    deps: { prepareLaunch: launchKeepingSendOutcome((hook) => { sendOutcome = hook; }) },
  });
  h.host.setTracer(trace.tracer);
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-1") })), { kind: "started" });
    await until(() => trace.turns().length === 1, "first turn span ended");
    const [first] = trace.turns();
    assert.equal(first!.status, "ok");
    assert.equal(first!.attrs?.outcome, "turn-completed");
    assert.equal(first!.attrs?.reason, "spawn");
    assert.equal(first!.attrs?.agentId, "agent-1");
    assert.equal(first!.attrs?.runtime, "grok");
    assert.equal(first!.attrs?.model, "default");
    assert.equal(first!.attrs?.host, "oar");
    assert.equal(first!.attrs?.hasSession, true);
    assert.equal(first!.attrs?.messageId, "m-1");
    assert.equal(first!.attrs?.launch_id, "launch-1");
    assert.equal(first!.attrs?.runtime_tool_calls_count, 2);
    assert.equal(first!.attrs?.runtime_tool_outputs_count, 2);
    assert.equal(first!.attrs?.runtime_raft_message_send_attempts_count, 1);
    assert.equal(first!.attrs?.runtime_raft_messages_sent_count, 1);
    assert.equal(first!.attrs?.runtime_text_events_count, 1);
    assert.equal(first!.attrs?.runtime_span_events_dropped_count, 0);
    // OAR's input includes the cache read; the span's is uncached, as the legacy host's.
    assert.equal(first!.attrs?.input_tokens, 1_000);
    assert.equal(first!.attrs?.output_tokens, 300);
    assert.equal(first!.attrs?.cache_read_tokens, 200);
    assert.equal(first!.events[0]?.name, "daemon.turn.started");
    assert.ok(first!.events.some((event) => event.name === "runtime.event.received" && event.attrs?.kind === "tool_call_started"));

    // A delivery to the idle agent is the next turn: its own span, its message, and its share of the session's totals.
    await h.host.deliverMessage("agent-1", message("m-2"), { deliveryId: "d-2" });
    await until(() => trace.turns().length === 2, "second turn span ended");
    const second = trace.turns()[1]!;
    assert.equal(second.attrs?.outcome, "turn-completed");
    assert.equal(second.attrs?.reason, "stdin-idle-delivery");
    assert.equal(second.attrs?.messageId, "m-2");
    assert.equal(second.attrs?.deliveryId, "d-2");
    assert.equal(second.attrs?.messages_count, 1);
    assert.equal(typeof second.attrs?.local_wait_ms, "number");
    assert.equal(second.attrs?.runtime_raft_messages_sent_count, 1);
    assert.equal(second.attrs?.input_tokens, 700);
    assert.equal(second.attrs?.output_tokens, 200);
    assert.equal(second.attrs?.cache_read_tokens, 100);
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

/**
 * OAR's answer to an abort on a launch with `endTurnProcessesOnAbort` (OAR 0.99
 * for Grok, #733): a `cleanup` response on the abort request once the
 * aborted turn's processes were ended. The scripted runtime sends none, so it
 * is added after the abort request here.
 */
function withAbortCleanup(session: Session, signalled: number): Session {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "rawEvents") {
        return (observer: RawEventObserver, cursor?: Cursor) => target.rawEvents((record: RawEvent) => {
          observer(record);
          if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "abort") {
            observer({ ...record, kind: "response", requestId: record.id, body: { kind: "cleanup", result: { kind: "completed", signalled } } } as unknown as RawEvent);
          }
        }, cursor);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a Grok Stop with endTurnProcessesOnAbort is complete at OAR's cleanup response on the abort request, traced once", async () => {
  const h = await harness({
    turn: async (t) => { await waitForAbort(t); },
    wrapSession: (session) => withAbortCleanup(session, 2),
    deps: {
      prepareLaunch: async (ctx) => ({
        runtimeId: "grok",
        installation: { kind: "available", via: "bundled" },
        options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt, endTurnProcessesOnAbort: true },
        busyDelivery: "after_turn",
      }),
    },
  });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    assert.ok(!h.events.some((event) => event.name === "daemon.agent.turn_interrupt.cleanup"), "nothing before the Stop");
    assert.equal((await h.host.interruptTurn("agent-1")).outcome, "interrupted");
    await until(() => h.events.some((event) => event.name === "daemon.agent.turn_interrupt.cleanup"), "the cleanup traced");
    const cleanups = h.events.filter((event) => event.name === "daemon.agent.turn_interrupt.cleanup");
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0]!.attrs.runtime, "grok");
    assert.equal(cleanups[0]!.attrs.outcome, "completed");
    assert.equal(cleanups[0]!.attrs.signalled, 2);
  } finally {
    await h.cleanup();
  }
});

test("a launch without endTurnProcessesOnAbort traces no Stop cleanup", async () => {
  const h = await harness({ turn: async (t) => { await waitForAbort(t); }, wrapSession: (session) => withAbortCleanup(session, 1) });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    assert.equal((await h.host.interruptTurn("agent-1")).outcome, "interrupted");
    await until(() => h.sessions[0]?.status().value.kind === "idle", "turn ended");
    assert.ok(!h.events.some((event) => event.name === "daemon.agent.turn_interrupt.cleanup"));
  } finally {
    await h.cleanup();
  }
});

test("an interrupted OAR turn ends its span cancelled (turn-interrupted)", async () => {
  const trace = recordingTracer();
  const h = await harness({ turn: async (t) => { t.say("working"); await waitForAbort(t); } });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").some((frame) => frame.entries?.some((entry) => entry.kind === "text")), "the turn's text");
    await started(h, trace);
    assert.equal((await h.host.interruptTurn("agent-1")).outcome, "interrupted");
    await until(() => trace.turns().length === 1, "turn span ended");
    const [span] = trace.turns();
    assert.equal(span!.status, "cancelled");
    assert.equal(span!.attrs?.outcome, "turn-interrupted");
    assert.equal(span!.attrs?.runtime_text_events_count, 1);
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a Stop mid-turn ends the turn span once, cancelled, as the stop's process exit", async () => {
  const trace = recordingTracer();
  const h = await harness({ turn: async (t) => { await waitForAbort(t); } });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    await started(h, trace);
    await h.host.stopAgent("agent-1", { wait: true });
    const spans = trace.turns();
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.status, "cancelled");
    assert.equal(spans[0]!.attrs?.outcome, "process-exit");
    assert.equal(spans[0]!.attrs?.expectedTerminationReason, "explicit_stop");
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a runtime exit mid-turn ends the turn span once with the exit's outcome; the restart's turns get their own", async () => {
  const trace = recordingTracer();
  let turns = 0;
  const h = await harness({
    turn: async (t) => {
      turns += 1;
      if (turns === 1) await waitForAbort(t);
      else t.say("back");
    },
  });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    await started(h, trace);
    // The runtime ends on its own (the host asked for nothing): OAR ends the turn aborted, then reports the exit.
    await h.sessions[0]!.dispose();
    await until(() => trace.turns().length >= 1, "the cut turn's span ended");
    const cut = trace.turns()[0]!;
    // Exit code 0 before the turn boundary: the exit plan's crash, as the legacy host's close plans it.
    assert.equal(cut.attrs?.outcome, "process-crash");
    assert.equal(cut.status, "error");
    assert.equal(cut.attrs?.runtime_exit_before_turn_boundary, true);
    assert.equal(cut.attrs?.exitCode, 0);
    await h.host.stopAgent("agent-1", { wait: true });
    await h.host.stopAll();
    trace.assertEachEndedOnce();
    assert.equal(trace.turns().length, trace.startedCount(), "no turn span left open across the restart");
  } finally {
    await h.cleanup();
  }
});

test("the turn span keeps its events under the legacy host's cap: what does not fit is dropped and counted", async () => {
  const trace = recordingTracer();
  const h = await harness({
    turn: async (t) => {
      for (let index = 0; index < 12; index += 1) await t.tool("shell", `echo ${index}`, () => "ok");
      t.say("done");
    },
    deps: { turnSpanEventLimits: { budgetBytes: 600, maxEventBytes: 300 } },
  });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => trace.turns().length === 1, "turn span ended");
    const [span] = trace.turns();
    assert.equal(span!.attrs?.outcome, "turn-completed");
    assert.equal(span!.attrs?.runtime_tool_calls_count, 12, "counts are kept whatever the span drops");
    const dropped = span!.attrs?.runtime_span_events_dropped_count as number;
    assert.ok(dropped > 0, "events were dropped");
    assert.ok((span!.attrs?.runtime_span_event_bytes_dropped as number) > 0);
    const kept = span!.events.reduce((sum, event) => sum + Buffer.byteLength(event.name) + Buffer.byteLength(JSON.stringify(event.attrs ?? {})), 0);
    assert.ok(kept <= 600, `kept events fit the budget (${kept} bytes)`);
    // The same cap as the legacy host's: once full the span takes no more, so it keeps the turn's first part.
    assert.equal(span!.events[0]?.name, "daemon.turn.started");
    assert.ok(!span!.events.some((event) => event.name === "runtime.turn.completed"), "the turn's last events are the ones dropped");
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

/** Root events of `session` pass through `edit` (return null to drop one; extra events go before it). */
function withEvents(session: Session, edit: (event: Event, emit: (event: Event) => void) => Event | null): Session {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "events") {
        return (observer: EventObserver, options?: EventsOptions) => target.events((event: Event) => {
          const kept = event.agentPath.length === 0 ? edit(event, observer) : event;
          if (kept) observer(kept);
        }, options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

test("a failed OAR turn ends its span runtime-error with OAR's failure class", async () => {
  const trace = recordingTracer();
  const h = await harness({ turn: () => { throw new Error("provider said no"); } });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => trace.turns().length === 1, "turn span ended");
    const [span] = trace.turns();
    assert.equal(span!.status, "error");
    assert.equal(span!.attrs?.outcome, "runtime-error");
    assert.equal(span!.attrs?.oar_failure, "unknown");
    assert.equal(typeof span!.attrs?.runtime_error_class, "string");
    // The turn's own cause, as on the legacy host: its fingerprint is the
    // failure's, and the failure's record joins the turn's trace.
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.turn_failed");
    assert.match(String(span!.attrs?.runtime_error_fingerprint), /^[0-9a-f]{16}$/);
    assert.equal(failed?.attrs.runtime_error_fingerprint, span!.attrs?.runtime_error_fingerprint);
    assert.equal(failed?.parent?.traceId, span!.context.traceId, "turn_failed carries the turn's trace id");
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a sticky failure that ends the session while the turn's end is pending keeps the turn's runtime-error, ended once", async () => {
  const trace = recordingTracer();
  const h = await harness({
    turn: () => { throw new Error("prompt is too long"); },
    wrapSession: (session) => withFailure(session, "input_too_large"),
  });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    // The failure replaces the session (terminal_runtime_error release) in the same turn-end handling.
    await until(() => h.events.some((event) => event.name === "daemon.agent.session_replaced"), "session replaced");
    await until(() => trace.turns().length >= 1, "turn span ended");
    const first = trace.turns()[0]!;
    assert.equal(first.attrs?.outcome, "runtime-error");
    assert.equal(first.attrs?.oar_failure, "input_too_large", "the turn's own end, not the release's");
    assert.equal(first.attrs?.exit_reason, undefined);
    await h.host.stopAll();
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a prompt the runtime rejects ends the span its turn_started opened as runtime-start-failed", async () => {
  const trace = recordingTracer();
  let turns = 0;
  const h = await harness({
    turn: (t) => { t.say("ok"); },
    wrapSession: (session) => withEvents(session, (event, emit) => {
      if (event.kind === "turn_started") {
        turns += 1;
        // The second prompt is refused after its request was recorded (no turn runs for it).
        if (turns === 2) {
          emit(event);
          return { ...event, kind: "control_rejected", requestId: event.requestId, action: "prompt", code: "busy", reason: "a turn is running" } as Event;
        }
      }
      return event;
    }),
  });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => trace.turns().length === 1, "first turn span ended");
    await h.host.deliverMessage("agent-1", message("m-2"));
    await until(() => trace.turns().some((span) => span.attrs?.outcome === "runtime-start-failed"), "rejected prompt's span ended");
    const rejected = trace.turns().find((span) => span.attrs?.outcome === "runtime-start-failed")!;
    assert.equal(rejected.status, "error");
    assert.equal(rejected.attrs?.reason, "stdin-idle-delivery");
    assert.equal(rejected.attrs?.rejection_code, "busy");
    // The runtime's reason as its class and fingerprint, never its text.
    assert.equal(typeof rejected.attrs?.refusal_fingerprint, "string");
    assert.ok(!Object.values(rejected.attrs ?? {}).includes("a turn is running"), "the reason's text is not on the span");
    await h.host.stopAll();
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a turn cut short with no exit is interrupted when the runtime starts its next turn, never folded into it", async () => {
  const trace = recordingTracer();
  let turnStarts = 0;
  const h = await harness({
    turn: async (t) => {
      if (t.input.includes("m-2")) t.say("my own turn");
      else await waitForAbort(t);
    },
    // The second turn reaches the host as model work only (a runtime-started turn: no turn_started).
    wrapSession: (session) => withEvents(session, (event) => {
      if (event.kind === "turn_started") turnStarts += 1;
      return event.kind === "turn_started" && turnStarts === 2 ? null : event;
    }),
    deps: { turnExitWaitMs: 60_000 },
  });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    await started(h, trace);
    // Aborted with no interrupt asked of the host and no exit after it: the span waits for an exit.
    await h.sessions[0]!.abort();
    await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
    assert.equal(trace.turns().length, 0, "the cut turn waits for its exit");
    await h.host.deliverMessage("agent-1", message("m-2"));
    await until(() => trace.turns().length === 2, "both spans ended");
    const [cut, next] = trace.turns();
    assert.equal(cut!.attrs?.outcome, "turn-interrupted");
    assert.equal(cut!.attrs?.exit_wait_ended_by, "next_turn");
    assert.equal(cut!.attrs?.runtime_text_events_count, 0, "the next turn's text is not the cut turn's");
    assert.equal(next!.attrs?.reason, "runtime-progress");
    assert.equal(next!.attrs?.outcome, "turn-completed");
    assert.equal(next!.attrs?.runtime_text_events_count, 1);
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});

test("a turn cut short whose exit never comes is interrupted after the bounded wait, not at the next prompt", async () => {
  const trace = recordingTracer();
  const h = await harness({ turn: async (t) => { await waitForAbort(t); }, deps: { turnExitWaitMs: 50 } });
  h.host.setTracer(trace.tracer);
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "turn running");
    await started(h, trace);
    await h.sessions[0]!.abort();
    await until(() => trace.turns().length === 1, "the cut turn's span ended by the wait");
    const [cut] = trace.turns();
    assert.equal(cut!.status, "cancelled");
    assert.equal(cut!.attrs?.outcome, "turn-interrupted");
    assert.equal(cut!.attrs?.exit_wait_ended_by, "exit_wait_elapsed");
    assert.ok(cut!.durationMs < 2_000, `no idle time on the span (${cut!.durationMs} ms)`);
    trace.assertEachEndedOnce();
  } finally {
    await h.cleanup();
  }
});
