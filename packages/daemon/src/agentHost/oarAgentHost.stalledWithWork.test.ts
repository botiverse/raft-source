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
import type { Session } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentDeliveryContext } from "./agentLifecycleHost";
import type { OarAgentHostDeps } from "./oarAgentHost";
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
