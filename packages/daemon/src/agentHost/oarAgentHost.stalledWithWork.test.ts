// Reconciler step 9 on the OAR host (rule 3 / E2, rows C14, C15 and D6): a
// session stalled with deliveries held for it is broken, decided by the legacy
// host's own rule (stalledWithWork.ts) from OAR's facts, and ended at once;
// the host starts the agent again on the same session with those deliveries.
// Shortened thresholds, real time: OAR's scripted runtime runs on real timers.
//
// RED proof (reverse-verified): with `outstandingToolUses: 0` in
// stalledWithWorkFacts the open-tool test fails (the session is replaced at
// the alive threshold); with `deliveryHold: null` the provider-limit test
// fails (replaced although the limit holds the delivery).
import assert from "node:assert/strict";
import type { RawEvent, Session } from "@botiverse/oar";
import { createSessionKernel, sealSession } from "@botiverse/oar/kernel";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentDeliveryContext } from "./agentLifecycleHost";
import { OarTurnAbortTracker, outsideTurnContent, type OarAgentHostDeps } from "./oarAgentHost";
import { harness, makeConfig, message, request, sleep, until, type Harness } from "../testing/oarAgentHostHarness";
import { ProviderLimitLedger, providerLimitCredentialKey } from "../providerLimitLedger";
import { loadOarObserve } from "../oarLoader";

/** The harness's own launch holds busy deliveries for the next turn (`after_turn`): the alive non-stdin threshold applies. */
const STALL = { stallMs: 100, nonStdinAliveStallMs: 250 };

const recoveries = (h: Harness) => h.events.filter((event) => event.name === "daemon.runtime.stall.recovery_action").map((event) => event.attrs);
const gaveUp = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.stalled_recovery.gave_up").map((event) => event.attrs);

/** A turn that says nothing until the host aborts it or ends its session. */
function hang(turn: ScriptedTurn): Promise<void> {
  return new Promise<void>((resolve) => {
    if (turn.signal.aborted) resolve();
    else turn.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Turn scripts in order; the last one repeats. */
async function stallHarness(turns: Array<(turn: ScriptedTurn) => Promise<void> | void>, deps: Partial<OarAgentHostDeps> = {}): Promise<Harness> {
  let index = 0;
  return harness({
    turn: async (turn) => {
      const script = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      await script(turn);
    },
    deps: { stalledWithWorkThresholds: STALL, ...deps },
  });
}

const firstTurnRunning = (h: Harness) => until(() => h.sessions[0]?.status().value.kind === "running" && h.inputs.length === 1, "the first turn running");

function stallDeadlineOf(h: Harness): unknown {
  return (h.host as unknown as { agents: Map<string, { stallDeadline: unknown }> }).agents.get("agent-1")?.stallDeadline ?? null;
}

test("stalled past the threshold with held deliveries and no open tool: the session is ended at once and the next session on it takes them once", async () => {
  const h = await stallHarness([hang, (turn) => { turn.say("ok"); }]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    const seen: string[] = [];
    let acks = 0;
    let rejected = 0;
    const mention: AgentDeliveryContext = {
      deliveryId: "occ-1",
      mentionDelivery: { occurrenceId: "occ-1", messageId: "m-mention", machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never,
      onMentionTransition: (stage, outcome) => { seen.push(`${stage}:${outcome}`); },
      onMentionAck: () => { acks += 1; },
      onRejectedNoProcess: () => { rejected += 1; },
    };
    assert.equal(await h.host.deliverMessage("agent-1", message("m-plain"), { onRejectedNoProcess: () => { rejected += 1; } }), true, "acked on custody");
    await h.host.deliverMessage("agent-1", message("m-mention"), mention);

    await until(() => recoveries(h).length > 0, "the stall replacement");
    assert.deepEqual(recoveries(h), [{
      agent_id: "agent-1",
      server_id: undefined,
      machine_id: undefined,
      launch_id: "launch-1",
      process_instance_id: h.framesOf("agent:process_spawned")[0]!.processInstanceId,
      session_id: h.sessions[0]!.id,
      session_id_present: true,
      runtime: "grok",
      host: "oar",
      action: "terminate_for_restart",
      outcome: "initiated",
      delay_ms_bucket: recoveries(h)[0]!.delay_ms_bucket,
      queued_messages_count: 2,
      trigger: "stall_deadline",
      streak: 1,
    }]);
    assert.ok(h.framesOf("agent:activity").some((frame) => frame.detailKind === "stalled_recovery"));

    await until(() => h.inputs.length === 2, "the next session's first input");
    await until(() => acks === 1, "the mention taken");
    // The same session, resumed after the ended one was undone.
    assert.equal(h.opened[1]!.options.resume, h.sessions[0]!.id);
    const types = h.frames.map((frame) => frame.type);
    assert.ok(types.indexOf("agent:process_exited") < types.lastIndexOf("agent:process_spawned"), types.join(","));
    const spawned = h.framesOf("agent:process_spawned");
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1]!.launchId, "launch-1");
    assert.equal(spawned[1]!.respawn, true);
    assert.notEqual(spawned[1]!.processInstanceId, spawned[0]!.processInstanceId);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active", "active"], "never shown stopped");
    // Both deliveries in the next session's first input; nothing dropped, nothing handed back.
    const firstInputs = h.events.filter((event) => event.name === "daemon.agent.oar.first_input");
    assert.equal(firstInputs[1]!.attrs.carried_deliveries, 2);
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.held_dropped"), false);
    assert.equal(rejected, 0);
    assert.deepEqual(seen, ["daemon_received:accepted", "daemon_pending:accepted", "daemon_drained:accepted"]);
    // Taken once: no second turn for them.
    await sleep(STALL.nonStdinAliveStallMs);
    assert.equal(h.inputs.length, 2);
    assert.equal(recoveries(h).length, 1);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("an open tool call with no end is never proven idle: past the threshold with held deliveries, the session is kept", async () => {
  const h = await stallHarness([async (turn) => { await turn.tool("shell", "sleep 3600", () => hang(turn)); }]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await sleep(STALL.nonStdinAliveStallMs * 3);
    assert.deepEqual(recoveries(h), []);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.host.owns("agent-1"), true);
    assert.equal(h.sessions[0]!.status().value.kind, "running");
  } finally {
    await h.cleanup();
  }
});

test("stalled without held deliveries is only a fact (C15): the No runtime output report, no replacement", async () => {
  // A record once OAR's stall observer is subscribed (it reads live records only), then silence.
  const h = await stallHarness([async (turn) => { await sleep(50); turn.think("…"); await hang(turn); }]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), "the stall report");
    await sleep(STALL.nonStdinAliveStallMs * 2);
    assert.deepEqual(recoveries(h), []);
    assert.equal(h.host.owns("agent-1"), true);
    assert.equal(stallDeadlineOf(h), null, "nothing held: no deadline");
  } finally {
    await h.cleanup();
  }
});

test("a silent open tool call is not a stall: a long foreground command gets no No runtime output error (#oar-raft:#22)", async () => {
  // A record once OAR's stall observer is subscribed, then a tool that runs on silently (a foreground `sleep 7200`).
  const h = await stallHarness([async (turn) => { await sleep(50); await turn.tool("shell", "sleep 7200", () => hang(turn)); }]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await sleep(STALL.nonStdinAliveStallMs * 3);
    assert.equal(h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), false, "an open tool is not reported as stalled");
    // The observer did fire and took the open-tool branch (not merely never subscribed).
    assert.ok(h.events.some((event) => event.name === "daemon.runtime.stall.silent_tool"), "the silent tool is recorded");
    assert.deepEqual(recoveries(h), []);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("the stall report does not depend on how fast OAR's observe entry loads: a turn that speaks at once and then goes silent is reported (C15)", async () => {
  // The observer reads live records only. Loaded late (slow disk, a loaded
  // CI host), one subscribed after the turn's first record never saw the turn
  // running and never reported the silence. The host now loads it before the
  // session opens. RED proof: subscribing after the load resolves (the old
  // `void loadOarObserve().then(...)`) fails this test.
  const slowObserve = async () => {
    const observe = await loadOarObserve();
    await sleep(150);
    return observe;
  };
  const h = await stallHarness([async (turn) => { turn.think("…"); await hang(turn); }], { loadObserve: slowObserve });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), "the stall report");
    assert.deepEqual(recoveries(h), []);
  } finally {
    await h.cleanup();
  }
});

test("a stall timer that fires before the wall clock has moved the full threshold still reports the silence (C15)", async () => {
  // A Node timer may fire up to a millisecond before `Date.now()` has moved
  // its full delay (seen at 99.2 ms of a 100 ms timer); the silence is then
  // not stalled yet by the clock the judgment reads. OAR's observer before
  // 0.92 judged once and never again, so the report was lost (staging CI,
  // three times in one day). Here the wall clock lags the timers by 20 ms once
  // the turn has spoken: every first firing is early by it. RED proof: OAR
  // 0.91's `observeStalls` fails this test.
  const realNow = Date.now;
  const h = await stallHarness([async (turn) => {
    turn.think("…");
    Date.now = () => realNow.call(Date) - 20;
    await hang(turn);
  }]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), "the stall report");
    assert.deepEqual(recoveries(h), []);
  } finally {
    Date.now = realNow;
    await h.cleanup();
  }
});

test("the first input's turn starting before its prompt returns is still watched: a silence in it is reported (C15)", async () => {
  // The observer reads live records only, and the host commits (where the
  // replaying readers subscribe) only after `prompt` returns. Here the turn
  // speaks and goes silent while `prompt` has not returned yet. RED proof:
  // subscribing the observer at the commit (after `prompt`) fails this test.
  const h = await harness({
    turn: async (turn) => { turn.think("…"); await hang(turn); },
    deps: { stalledWithWorkThresholds: STALL },
    wrapSession: (session) => new Proxy(session, {
      get(target, property, receiver) {
        if (property !== "prompt") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<Session["prompt"]>) => {
          const outcome = await target.prompt(...args);
          await sleep(STALL.stallMs * 3);
          return outcome;
        };
      },
    }),
  });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), "the stall report");
    assert.deepEqual(recoveries(h), []);
  } finally {
    await h.cleanup();
  }
});

test("deliveries held for the credential's provider limit are not stalled, however long the turn is silent", async () => {
  const ledger = new ProviderLimitLedger();
  const h = await stallHarness([hang], { providerLimits: ledger });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    const now = Date.now();
    ledger.record(providerLimitCredentialKey("agent-1", makeConfig()), { attempts: 1, reason: "rate_limited", untilMs: now + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: now }, { host: "legacy" });
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await sleep(STALL.nonStdinAliveStallMs * 3);
    assert.deepEqual(recoveries(h), []);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("two replacements in a row with no model output: the third stall gives up (traced, shown once); model output in between resets the streak", async () => {
  const h = await stallHarness([
    hang,
    async (turn) => { turn.say("working on it"); await hang(turn); },
    hang,
  ]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    const stallWith = async (id: string, sessions: number) => {
      await until(() => h.inputs.length === sessions, `session ${sessions}'s turn`, 5_000);
      await h.host.deliverMessage("agent-1", message(id), {});
    };
    await stallWith("m-1", 1);
    await until(() => recoveries(h).length === 1, "replacement 1");
    // The next session says something (text reaches the host coalesced), then stalls: the streak started again.
    await until(() => h.framesOf("agent:activity").some((frame) => frame.entries?.some((entry) => entry.kind === "text" && entry.text === "working on it")), "the model's text");
    await stallWith("m-2", 2);
    await until(() => recoveries(h).length === 2, "replacement 2");
    await stallWith("m-3", 3);
    await until(() => recoveries(h).length === 3, "replacement 3");
    assert.deepEqual(recoveries(h).map((attrs) => attrs.streak), [1, 1, 2]);

    await stallWith("m-4", 4);
    await until(() => gaveUp(h).length > 0, "gave up");
    assert.deepEqual(gaveUp(h).map((attrs) => ({ streak: attrs.streak, trigger: attrs.trigger, host: attrs.host })), [{ streak: 2, trigger: "stall_deadline", host: "oar" }]);
    assert.ok(h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_error" && frame.detail === "Grok Build stalled repeatedly with queued messages; restart it to retry"));
    // Left as it is: no third replacement, and shown once.
    await h.host.deliverMessage("agent-1", message("m-5"), {});
    await sleep(STALL.nonStdinAliveStallMs * 2);
    assert.equal(recoveries(h).length, 3);
    assert.equal(gaveUp(h).length, 1);
    assert.equal(h.sessions.length, 4);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("the stall deadline: one timer, armed by the held delivery, fires at the threshold (no polling, no sweep)", async () => {
  const h = await stallHarness([hang]);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    const status = h.sessions[0]!.status().value;
    assert.equal(status.kind, "running");
    const silentSince = status.kind === "running" ? status.lastEventAt : 0;
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    assert.notEqual(stallDeadlineOf(h), null, "the delivery armed the deadline");
    await sleep(Math.max(0, silentSince + STALL.nonStdinAliveStallMs - 100 - Date.now()));
    assert.deepEqual(recoveries(h), [], "not before the threshold");
    await until(() => recoveries(h).length > 0, "the replacement");
    const elapsed = Date.now() - silentSince;
    assert.equal(recoveries(h)[0]!.trigger, "stall_deadline");
    assert.ok(elapsed >= STALL.nonStdinAliveStallMs, `replaced after ${elapsed}ms`);
    assert.ok(elapsed < STALL.nonStdinAliveStallMs + 200, `replaced after ${elapsed}ms`);
  } finally {
    await h.cleanup();
  }
});

test("a start after a stall replacement that cannot run on OAR shows the agent stopped and hands a held mention back for the server's wake", async () => {
  const runtime = scriptedRuntime({ turn: hang });
  const sessions: Session[] = [];
  const h = await harness({
    openSession: async (launch) => {
      if (sessions.length > 0) {
        const error = new Error("session not found");
        error.name = "SessionNotFoundError";
        throw error;
      }
      const session = await runtime.session({ kind: "available", via: "bundled" }, launch.options);
      sessions.push(session);
      return session;
    },
    deps: { stalledWithWorkThresholds: STALL },
  });
  try {
    await h.host.start(request());
    await until(() => sessions[0]?.status().value.kind === "running", "the first turn running");
    const seen: string[] = [];
    await h.host.deliverMessage("agent-1", message("m-mention"), {
      deliveryId: "occ-1",
      mentionDelivery: { occurrenceId: "occ-1", messageId: "m-mention", machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never,
      onMentionTransition: (stage, outcome) => { seen.push(`${stage}:${outcome}`); },
      onRejectedNoProcess: () => { seen.push("rejected_no_process"); },
    });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.stall_restart_failed"), "the failed restart");
    const failed = h.events.find((event) => event.name === "daemon.agent.oar.stall_restart_failed")!;
    assert.equal(failed.attrs.reason, "resume_failed:SessionNotFoundError");
    assert.equal(failed.attrs.held, 1);
    assert.equal(h.host.owns("agent-1"), false);
    assert.deepEqual(seen, ["daemon_received:accepted", "daemon_pending:accepted", "rejected_no_process"]);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active", "inactive"]);
    assert.ok(h.framesOf("agent:activity").at(-1)!.detail.startsWith("Grok Build stalled with queued messages and could not be started again"));
  } finally {
    await h.cleanup();
  }
});

// Task #triage:#496: a launch that steers (`busyDelivery: "now"`: antigravity,
// grok, codex, qoder) took a delivery into a turn already silent past the
// threshold; nothing stayed held, so step 9 read an empty inbox and the hung
// turn was never replaced. RED proof: without `held_while_silent` in
// `steerHeldReason` the first test fails (the delivery is steered, no
// replacement); the open-tool test pins that a long command still takes it.
const STEERING: Partial<OarAgentHostDeps> = {
  prepareLaunch: async (ctx) => ({
    runtimeId: "grok",
    installation: { kind: "available", via: "bundled" },
    options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt, ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}) },
    busyDelivery: "now",
  }),
};

const deliveryOutcomes = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.oar.delivery").map((event) => event.attrs.outcome);

test("steering launch: a delivery into a turn silent past the threshold with no open tool is held, and the stalled session is replaced and resumed with it (#triage:#496)", async () => {
  const h = await stallHarness([async (turn) => { await sleep(50); turn.think("…"); await hang(turn); }, (turn) => { turn.say("ok"); }], STEERING);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_stalled"), "the stall report");
    await h.host.deliverMessage("agent-1", message("m-silent"), {});
    await until(() => recoveries(h).length > 0, "the stall replacement");
    assert.ok(deliveryOutcomes(h).includes("held_while_silent"), deliveryOutcomes(h).join(","));
    assert.equal(deliveryOutcomes(h).includes("steered"), false, "never steered into the silent turn");
    assert.equal(recoveries(h)[0]!.queued_messages_count, 1);
    await until(() => h.inputs.length === 2, "the next session's first input");
    assert.match(h.inputs[1]!, /m-silent/);
    assert.equal(h.opened[1]!.options.resume, h.sessions[0]!.id);
  } finally {
    await h.cleanup();
  }
});

test("steering launch: a delivery into a turn that is quiet but not yet past the threshold is steered into it", async () => {
  const gate = deferredVoid();
  const h = await stallHarness([async (turn) => { await gate.promise; turn.say("done"); }], {
    ...STEERING,
    stalledWithWorkThresholds: { stallMs: 60_000, nonStdinAliveStallMs: 120_000 },
  });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await h.host.deliverMessage("agent-1", message("m-live"), {});
    await until(() => deliveryOutcomes(h).length > 0, "the delivery");
    assert.deepEqual(deliveryOutcomes(h), ["steered"]);
    gate.resolve();
    await until(() => h.steered().length === 1, "the turn took the steer");
    assert.equal(h.inputs.length, 1, "no turn of its own");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("steering launch: a turn silent past the threshold with a tool open (a long command) still takes the delivery as a steer, and is not replaced (#triage:#496)", async () => {
  const h = await stallHarness([async (turn) => { await sleep(50); await turn.tool("shell", "sleep 7200", () => hang(turn)); }], STEERING);
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => h.events.some((event) => event.name === "daemon.runtime.stall.silent_tool"), "the silent tool recorded");
    await h.host.deliverMessage("agent-1", message("m-into-tool"), {});
    await until(() => deliveryOutcomes(h).length > 0, "the delivery");
    assert.deepEqual(deliveryOutcomes(h), ["steered"]);
    await sleep(STALL.nonStdinAliveStallMs * 2);
    assert.deepEqual(recoveries(h), []);
    assert.equal(h.sessions.length, 1);
    assert.equal(h.sessions[0]!.status().value.kind, "running");
  } finally {
    await h.cleanup();
  }
});

// A `now` launch whose session has no `steer` (DSH without an advertised
// steer, OpenCode 2.x before 2.2.7): its busy deliveries wait for the turn end,
// so it is a non-stdin runtime here (`launchSteers`). RED proof: with
// `busyDelivery === "now"` alone in stalledWithWorkFacts the first test is
// replaced at the direct threshold (100 ms), and with it alone in the
// tool-start flush the second traces a second `held_until_turn_end`.
const withoutSteer = (session: Session): Session => new Proxy(session, {
  get(target, prop) {
    if (prop === "steer") return undefined;
    const value: unknown = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Session;

test("a `now` launch without steer: a delivery into a silent turn is held for the turn end, and the session is not replaced at the direct threshold", async () => {
  const h = await harness({
    turn: hang,
    deps: { ...STEERING, stalledWithWorkThresholds: { stallMs: 100, nonStdinAliveStallMs: 60_000 } },
    wrapSession: withoutSteer,
  });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await until(() => deliveryOutcomes(h).length > 0, "the delivery");
    assert.deepEqual(deliveryOutcomes(h), ["held_until_turn_end"]);
    await sleep(400);
    assert.deepEqual(recoveries(h), [], "the non-stdin alive threshold applies, not the direct one");
    assert.equal(h.sessions.length, 1);
    assert.equal(h.steered().length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a `now` launch without steer: a tool start does not hand a held delivery over again", async () => {
  const gate = deferredVoid();
  const h = await harness({
    turn: async (turn) => { await gate.promise; await turn.tool("shell", "sleep 3600", () => hang(turn)); },
    deps: { ...STEERING, stalledWithWorkThresholds: { stallMs: 60_000, nonStdinAliveStallMs: 120_000 } },
    wrapSession: withoutSteer,
  });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await until(() => deliveryOutcomes(h).length > 0, "the delivery");
    gate.resolve();
    await sleep(150);
    assert.deepEqual(deliveryOutcomes(h), ["held_until_turn_end"], "held once, not flushed again at the tool start");
    assert.equal(h.inputs.length, 1);
    assert.equal(h.steered().length, 0);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Task #triage:#496 Decision 2: a turn silent past `silentTurnEndMs` with
// nothing waiting is ended where the Server's `silent_turn_end` is on, and
// only recorded (`would_end`) where it is off. RED proof: without the second
// stall observer in `observeStalls` the first two tests fail (no event); the
// last two pin what it must leave alone.
const SILENT_END_MS = 300;
const silentTurnEnds = (h: Harness) => h.events.filter((event) => event.name === "daemon.runtime.stall.silent_turn_ended").map((event) => event.attrs);
const speakThenHang = async (turn: ScriptedTurn) => { await sleep(50); turn.think("…"); await hang(turn); };

test("silent_turn_end on: a turn silent past the limit with nothing waiting is ended, the session kept, and the person told why (#triage:#496)", async () => {
  const h = await stallHarness([speakThenHang, (turn) => { turn.say("ok"); }], { silentTurnEndMs: SILENT_END_MS });
  try {
    await h.host.start(request({ config: makeConfig({ silentTurnEnd: true }) }));
    await firstTurnRunning(h);
    await until(() => silentTurnEnds(h).length > 0, "the silent turn ended");
    assert.equal(silentTurnEnds(h)[0]!.mode, "end");
    assert.equal(silentTurnEnds(h)[0]!.outcome, "ended");
    await until(() => h.sessions[0]!.status().value.kind === "idle", "the turn over");
    await until(() => h.framesOf("agent:activity").at(-1)?.detail === "The turn produced no output for 1 minute and was ended", "the reason shown");
    assert.equal(h.framesOf("agent:activity").at(-1)!.detailKind, "runtime_stalled");
    assert.deepEqual(recoveries(h), [], "no replacement: nothing was waiting");
    assert.equal(h.sessions.length, 1, "the session stays");
    assert.equal(h.host.owns("agent-1"), true);
    // The next message starts a fresh turn on the same session.
    await h.host.deliverMessage("agent-1", message("m-after"), {});
    await until(() => h.inputs.length === 2, "the next turn");
    assert.equal(h.sessions.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("silent_turn_end off: the same silence is only recorded as would_end; the turn keeps running", async () => {
  const h = await stallHarness([speakThenHang], { silentTurnEndMs: SILENT_END_MS });
  try {
    await h.host.start(request());
    await firstTurnRunning(h);
    await until(() => silentTurnEnds(h).length > 0, "the would-end record");
    assert.deepEqual(silentTurnEnds(h).map((attrs) => [attrs.mode, attrs.outcome]), [["would_end", "would_end"]]);
    await sleep(SILENT_END_MS);
    assert.equal(h.sessions[0]!.status().value.kind, "running");
    assert.equal(silentTurnEnds(h).length, 1, "once per silence");
  } finally {
    await h.cleanup();
  }
});

test("silent_turn_end on: a tool open past the limit (a long command) is never ended or counted", async () => {
  const h = await stallHarness([async (turn) => { await sleep(50); await turn.tool("shell", "sleep 7200", () => hang(turn)); }], { silentTurnEndMs: SILENT_END_MS });
  try {
    await h.host.start(request({ config: makeConfig({ silentTurnEnd: true }) }));
    await firstTurnRunning(h);
    await until(() => h.events.some((event) => event.name === "daemon.runtime.stall.silent_tool"), "the silent tool recorded");
    await sleep(SILENT_END_MS * 2);
    assert.deepEqual(silentTurnEnds(h), []);
    assert.equal(h.sessions[0]!.status().value.kind, "running");
  } finally {
    await h.cleanup();
  }
});

test("silent_turn_end on: a delivery waiting for the silent turn is left to the stall replacement, not ended", async () => {
  const h = await stallHarness([speakThenHang, (turn) => { turn.say("ok"); }], { silentTurnEndMs: SILENT_END_MS });
  try {
    await h.host.start(request({ config: makeConfig({ silentTurnEnd: true }) }));
    await firstTurnRunning(h);
    await h.host.deliverMessage("agent-1", message("m-held"), {});
    await until(() => recoveries(h).length > 0, "the stall replacement");
    await sleep(SILENT_END_MS * 2);
    assert.deepEqual(silentTurnEnds(h), []);
  } finally {
    await h.cleanup();
  }
});

// Task #triage:#496: Antigravity starts a run on its own after a background
// command finishes past `end_turn` (OpenCode 2.x replies on its own after a
// background sub-agent reports). Since OAR 0.121 that output is no turn: the
// status stays idle with `activity`, so the silent-turn limit never applies
// to it, the agent shows idle (outsideTurnContent) and a delivery opens a
// turn the runtime folds into its run (#oar-raft:bf7c6b31).
test("OAR's status keeps output that arrives with no turn open idle, as activity (OAR 0.121)", async () => {
  const observe = await loadOarObserve();
  const sessionId = "s-unprompted";
  const frame = (seq: number, events: unknown[]) => ({ kind: "frame", sessionId, agentPath: [], seq, receivedAt: 1_000 + seq, body: { events } }) as never;
  let status = observe.reduceStatus(observe.initialStatus as never, frame(1, [{ kind: "text_delta", text: "the task finished, so…" }]), sessionId);
  assert.equal(status.kind, "idle");
  status = observe.reduceStatus(status, frame(2, [{ kind: "reasoning", text: "…" }]), sessionId);
  assert.equal(status.kind, "idle");
  assert.deepEqual((status as { activity?: unknown }).activity, { since: 1_001, lastEventAt: 1_002 });
});

test("outsideTurnContent: root output outside any run the host knows of, nothing else", () => {
  for (const kind of ["text_delta", "reasoning", "tool_call_started", "tool_call_ended", "tool_call_progress", "tool_call_input_delta", "tool_call_input", "retry", "compaction_started", "compaction_ended"] as const) {
    assert.equal(outsideTurnContent({ kind }, false), true, kind);
    assert.equal(outsideTurnContent({ kind }, true), false, `${kind} in a run`);
  }
  for (const kind of ["turn_started", "turn_active", "turn_ended", "usage", "exited", "user_message"] as const) {
    assert.equal(outsideTurnContent({ kind } as never, false), false, kind);
  }
});

/** What the activity projector publishes for output (thinking, a reply, a command). */
const WORK_DETAIL_KINDS = new Set(["thinking_started", "model_response_started", "running_command", "tool_started", "compacting_context"]);

/**
 * A session whose `events()` subscribers can be handed extra root events, as
 * a runtime reports them outside the scripted turns (the scripted runtime
 * cannot start a run on its own).
 */
function injectable(): { wrap: (session: Session) => Session; emit: (events: Array<Record<string, unknown>>) => void } {
  const subscribers: Array<{ session: Session; observer: (event: never) => void }> = [];
  let seq = 1_000_000;
  return {
    wrap: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "events"
        ? (observer: (event: never) => void, options: unknown) => {
          subscribers.push({ session: target, observer });
          return (target.events as (o: unknown, p: unknown) => unknown)(observer, options);
        }
        : Reflect.get(target, prop, receiver),
    }),
    emit: (events) => {
      for (const { session, observer } of subscribers) {
        for (const body of events) observer({ ...body, sessionId: session.id, agentPath: [], seq: seq++, receivedAt: Date.now() } as never);
      }
    },
  };
}

test("output a runtime produces after its turn ended (no turn open) does not show the agent working; a delivery then is prompted at once", async () => {
  const inject = injectable();
  const h = await harness({ turn: (turn) => { turn.say("ok"); }, wrapSession: inject.wrap });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the first turn ended");
    const before = h.framesOf("agent:activity").length;
    inject.emit([{ kind: "reasoning", content: { kind: "text", text: "the background build finished…" } }, { kind: "tool_call_started", tool: "Bash", callId: "c-bg", input: {} }, { kind: "text_delta", text: "done" }, { kind: "compaction_started" }]);
    await sleep(50);
    const after = h.framesOf("agent:activity").slice(before);
    assert.deepEqual(after.filter((frame) => WORK_DETAIL_KINDS.has(frame.detailKind ?? "")).map((frame) => frame.detailKind), [], "nothing shown as work");

    const inputs = h.inputs.length;
    await h.host.deliverMessage("agent-1", message("m-after"), {});
    await until(() => h.inputs.length > inputs, "the delivery prompted");
  } finally {
    await h.cleanup();
  }
});

test("a turn the runtime opened itself (turn_active) keeps its output as the turn's, even once OAR's status has moved past it", async () => {
  const inject = injectable();
  const h = await harness({ turn: (turn) => { turn.say("ok"); }, wrapSession: inject.wrap });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the first turn ended");
    const before = h.framesOf("agent:activity").length;
    // OAR's real status stays idle for these injected events: only the host's own event order says a run is open.
    inject.emit([{ kind: "turn_active" }, { kind: "tool_call_started", tool: "Bash", callId: "c-native", input: {} }]);
    await sleep(50);
    const during = h.framesOf("agent:activity").slice(before);
    assert.ok(during.some((frame) => frame.detailKind === "running_command"), JSON.stringify(during.map((frame) => frame.detailKind)));
    inject.emit([{ kind: "turn_ended", outcome: { kind: "completed" } }, { kind: "text_delta", text: "afterwards" }]);
    await sleep(50);
    assert.equal(h.framesOf("agent:activity").at(-1)!.detailKind, "idle", "after its end, output is outside a turn again");
  } finally {
    await h.cleanup();
  }
});

// Task #oar-raft:#45: OpenCode 1.x answers ACP session/cancel with `end_turn`,
// which OAR records as `turn_ended { outcome: { kind: "completed" } }` after
// `request(abort)` + `response(accepted)`. The host reads that accepted abort
// from OAR's record stream so silent-turn-end keeps `runtime_stalled` (not
// `Idle` / `turn_completed`) and user interrupts do not report `turn_completed`.
function openCompletedOnAbortSession(hangTurns: number): { session: Session; prompts: string[] } {
  const kernel = createSessionKernel("s-completed-on-abort");
  kernel.opened({ requested: "isolated", placement: "in_process" });
  const prompts: string[] = [];
  let running = false;
  let turnIndex = 0;
  const session = sealSession({
    id: kernel.sessionId,
    capabilities: { queue: { durable: false }, attribution: "none", images: false },
    prompt: async (input, inputOptions) => kernel.control({ kind: "prompt", input, ...inputOptions }, () => {
      if (running) return { kind: "rejected", code: "busy", reason: "busy" };
      running = true;
      turnIndex += 1;
      prompts.push(input);
      const current = turnIndex;
      queueMicrotask(() => {
        if (!running) return;
        kernel.frame({ type: "test/text", native: null, events: [{ kind: "text_delta", text: `turn-${current}` }] });
        if (current > hangTurns) {
          running = false;
          kernel.frame({ type: "test/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
        }
      });
      return { kind: "accepted" };
    }),
    queue: async (input, inputOptions) => kernel.control({ kind: "queue", input, ...inputOptions }, () => ({ kind: "rejected", code: "unsupported", reason: "unsupported" })),
    abort: async () => {
      const result = await kernel.control({ kind: "abort" }, () => {
        if (!running) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        running = false;
        return { kind: "accepted" };
      });
      // Record `response(accepted)` first (inside `control`), then emit
      // `turn_ended { kind: "completed" }` — OpenCode 1.x's ACP order.
      if (result.response.body.kind === "accepted") {
        queueMicrotask(() => {
          kernel.frame({ type: "test/end", native: { stopReason: "end_turn" }, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
        });
      }
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      await kernel.dispose(async () => {
        running = false;
        kernel.processExited(0);
      });
    },
  });
  return { session, prompts };
}

test("silent_turn_end on: a runtime that answers abort with completed (OpenCode 1.x end_turn) still surfaces runtime_stalled and does not report turn_completed (#oar-raft:#45)", async () => {
  const { session, prompts } = openCompletedOnAbortSession(1);
  const h = await harness({
    openSession: async () => session,
    deps: { stalledWithWorkThresholds: STALL, silentTurnEndMs: SILENT_END_MS },
  });
  try {
    await h.host.start(request({ config: makeConfig({ silentTurnEnd: true }) }));
    await until(() => prompts.length === 1 && session.status().value.kind === "running", "first turn running");
    await until(() => silentTurnEnds(h).length > 0, "the silent turn ended");
    assert.equal(silentTurnEnds(h)[0]!.outcome, "ended");
    await until(() => session.status().value.kind === "idle", "turn ended after abort");
    await until(() => h.framesOf("agent:activity").at(-1)?.detail === "The turn produced no output for 1 minute and was ended", "stalled reason kept instead of Idle");
    assert.equal(h.framesOf("agent:activity").at(-1)!.detailKind, "runtime_stalled");
    assert.deepEqual(
      h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "turn_completed"),
      [],
      "an aborted silent turn must not send turn_completed recovery evidence",
    );
    // Next message runs normally on the same session and clears back to Idle.
    await h.host.deliverMessage("agent-1", message("m-after"), {});
    await until(() => prompts.length === 2, "second turn prompted");
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "second turn completes cleanly");
    assert.equal(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "turn_completed").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("interruptTurn: a runtime that answers abort with completed is treated as interrupted, not turn_completed (#oar-raft:#45)", async () => {
  const { session, prompts } = openCompletedOnAbortSession(1);
  const h = await harness({
    openSession: async () => session,
    deps: { stalledWithWorkThresholds: { stallMs: 60_000, nonStdinAliveStallMs: 120_000 } },
  });
  try {
    await h.host.start(request());
    await until(() => prompts.length === 1 && session.status().value.kind === "running", "first turn running");
    const report = await h.host.interruptTurn("agent-1");
    assert.equal(report.outcome, "interrupted");
    await until(() => session.status().value.kind === "idle", "turn ended");
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "user interrupt returns to Idle, not runtime_stalled");
    assert.deepEqual(
      h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "turn_completed"),
      [],
      "a user-interrupted turn must not report turn_completed",
    );
  } finally {
    await h.cleanup();
  }
});

test("OarTurnAbortTracker folds root abort/accepted before turn_ended across live and multi-turn replay (#oar-raft:#45)", () => {
  const sid = "s-root";
  const tracker = new OarTurnAbortTracker(sid);
  const env = (seq: number, extra: Partial<Pick<RawEvent, "sessionId" | "agentPath">> = {}) => ({
    sessionId: extra.sessionId ?? sid,
    agentPath: extra.agentPath ?? [],
    seq,
    receivedAt: 1_000 + seq,
  });
  const feed = (record: RawEvent) => { tracker.observe(record); };

  // Turn 1: accepted abort, a child turn_ended in between, a second rejected abort, then root turn_ended at seq 6.
  feed({ ...env(1), kind: "request", id: "ab-1", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(2), kind: "response", requestId: "ab-1", body: { kind: "accepted" } });
  feed({ ...env(3, { agentPath: ["sub-1"] }), kind: "frame", body: { type: "sub/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });
  feed({ ...env(4), kind: "request", id: "ab-2", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(5), kind: "response", requestId: "ab-2", body: { kind: "rejected", code: "no_active_turn", reason: "already aborting" } });
  feed({ ...env(6), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Turn 2 (in the same batch replay before events are consumed): rejected abort, then natural root turn_ended at seq 9.
  feed({ ...env(7), kind: "request", id: "ab-3", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(8), kind: "response", requestId: "ab-3", body: { kind: "rejected", code: "no_active_turn", reason: "late" } });
  feed({ ...env(9), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Foreign child session (agentPath: [], different sessionId) must be ignored.
  feed({ ...env(10, { sessionId: "s-child" }), kind: "request", id: "ab-child", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(11, { sessionId: "s-child" }), kind: "response", requestId: "ab-child", body: { kind: "accepted" } });
  feed({ ...env(12, { sessionId: "s-child" }), kind: "frame", body: { type: "child/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Turn 3: aborted non-turn op (e.g. manual compaction ending without turn_ended),
  // followed by a new accepted prompt and clean completion -> must NOT leak into Turn 3.
  feed({ ...env(13), kind: "request", id: "ab-compact", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(14), kind: "response", requestId: "ab-compact", body: { kind: "accepted" } });
  feed({ ...env(15), kind: "request", id: "p-3", direction: "toRuntime", body: { kind: "prompt", input: "fresh" } });
  feed({ ...env(16), kind: "response", requestId: "p-3", body: { kind: "accepted" } });
  feed({ ...env(17), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Turn 4: replay where turn_ended arrives at seq 19 before response(accepted) at seq 20,
  // then a clean Turn 5 at seq 23 (the late accepted response must match 19, not leak into 23).
  feed({ ...env(18), kind: "request", id: "ab-race", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(19), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });
  feed({ ...env(20), kind: "response", requestId: "ab-race", body: { kind: "accepted" } });
  feed({ ...env(21), kind: "request", id: "p-5", direction: "toRuntime", body: { kind: "prompt", input: "after-race" } });
  feed({ ...env(22), kind: "response", requestId: "p-5", body: { kind: "accepted" } });
  feed({ ...env(23), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Released / exited clears any in-flight accepted abort.
  feed({ ...env(24), kind: "request", id: "ab-rel", direction: "toRuntime", body: { kind: "abort" } });
  feed({ ...env(25), kind: "response", requestId: "ab-rel", body: { kind: "accepted" } });
  feed({ ...env(26), kind: "response", requestId: "ab-rel", body: { kind: "released", reason: "abort_fallback", nativeTurnMayContinue: true, workStartedAfterCleanupMayContinue: true } });
  feed({ ...env(27), kind: "frame", body: { type: "root/end", native: null, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });

  // Consumed after full replay (mirrors session.rawEvents followed by session.events).
  assert.equal(tracker.consumeAbortedTurnEnd(6), true, "turn 1 had an accepted abort before seq 6");
  assert.equal(tracker.consumeAbortedTurnEnd(6), false, "consumed once");
  assert.equal(tracker.consumeAbortedTurnEnd(3), false, "child turn_ended ignored");
  assert.equal(tracker.consumeAbortedTurnEnd(9), false, "turn 2 only had a rejected abort");
  assert.equal(tracker.consumeAbortedTurnEnd(12), false, "foreign sessionId ignored");
  assert.equal(tracker.consumeAbortedTurnEnd(17), false, "aborted pre-prompt op does not leak into turn 3");
  assert.equal(tracker.consumeAbortedTurnEnd(19), true, "raced request(abort) -> turn_ended -> response(accepted) matches seq 19 on replay");
  assert.equal(tracker.consumeAbortedTurnEnd(23), false, "raced abort does not leak into turn 5");
  assert.equal(tracker.consumeAbortedTurnEnd(27), false, "released clears accepted abort state");
});
