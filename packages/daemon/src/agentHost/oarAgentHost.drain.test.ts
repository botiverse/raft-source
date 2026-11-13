// Reconciler step 13 (PR 2) on the OAR host: `beginDrain` holds deliveries,
// reminders and spawns, and resolves once every committed session is quiet
// (agentIdle.ts with `ignoreUntoldInbox`) or at the deadline; it stops
// nothing. A Stop and a turn interrupt pass through. `endDrain` hands the
// held deliveries over and lets the held starts spawn.
//
// RED proof: drop the drain gate in `handOff` and the held delivery is
// prompted at once; drop `this.drain.check()` in `reconcile` and the busy
// session is not quiet at its turn end (only at the next poll); drop the hold
// in `launch` and the new agent opens a session during the drain; count the
// untold inbox and the held delivery keeps the drain until its deadline.

import assert from "node:assert/strict";
import { ProviderLimitLedger } from "../providerLimitLedger";
import { harness, message, request, sleep, until } from "../testing/oarAgentHostHarness";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settledSoon<T>(promise: Promise<T>, ms = 30): Promise<T | "pending"> {
  return Promise.race([promise, sleep(ms).then(() => "pending" as const)]);
}

test("OAR drain: an idle session is quiet at once; nothing is stopped", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    const summary = await h.host.beginDrain({ deadlineMs: 60_000 });
    assert.equal(summary.finished, "quiet");
    assert.equal(summary.live, 1);
    assert.equal(h.host.owns("agent-1"), true, "a drain stops nothing");
    h.host.endDrain();
  } finally {
    await h.cleanup();
  }
});

test("OAR drain: a busy session is waited for until its turn end; a held delivery does not keep it busy and goes in at endDrain", async () => {
  const release = deferred();
  let turns = 0;
  const h = await harness({ turn: async (t) => { turns += 1; if (turns === 1) await release.promise; t.say("done"); } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "the first turn running");
    const waiting = h.host.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await settledSoon(waiting), "pending");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held", { content: "held-body" })), true, "custody");
    release.resolve();
    // Well under the 1 s poll: the turn end's reconcile decides it.
    const summary = await settledSoon(waiting, 300);
    assert.notEqual(summary, "pending");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.waitedFor, ["agent-1"]);
    await sleep(30);
    assert.equal(h.inputs.length, 1, "held: no turn for it during the drain");

    h.host.endDrain();
    await until(() => h.inputs.length === 2, "the held delivery after endDrain");
    assert.equal(h.inputs[1]!.split("held-body").length - 1, 1, "delivered once");
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("OAR drain: the deadline returns with the sessions still busy", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "busy");
    const summary = await h.host.beginDrain({ deadlineMs: 40 });
    assert.equal(summary.finished, "deadline");
    assert.deepEqual(summary.notQuiet, [{ agentId: "agent-1", reason: "agent_busy" }]);
    h.host.endDrain();
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("OAR drain: an idle reminder starts no turn", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    await h.host.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await h.host.deliverIdleNotice("agent-1", "Reminder"), "busy");
    await sleep(20);
    assert.equal(h.inputs.length, 1);
    h.host.endDrain();
  } finally {
    await h.cleanup();
  }
});

// Tenny f8ae3b79 condition 3, as on the legacy host. RED proof: drop the
// re-ask in releaseDrainHeld (it flushes only agents with deliveries held)
// and no edge follows endDrain.
test("OAR drain: an idle session whose reminder the drain refused gets one more idle edge at endDrain", async () => {
  const edges: string[] = [];
  const h = await harness({ deps: { onAgentWorkingToIdle: (agentId: string) => edges.push(agentId) } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    await h.host.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await h.host.deliverIdleNotice("agent-1", "Reminder"), "busy");
    edges.length = 0;
    h.host.endDrain();
    assert.deepEqual(edges, ["agent-1"], "asked again at once");
    h.host.endDrain();
    assert.deepEqual(edges, ["agent-1"], "once");
  } finally {
    await h.cleanup();
  }
});

test("OAR drain: no new agent spawns while it holds; endDrain lets the start go on", async () => {
  const h = await harness();
  try {
    await h.host.beginDrain({ deadlineMs: 60_000 });
    const started = h.host.start(request());
    assert.equal(h.host.owns("agent-1"), true, "registered: a delivery is held for it");
    await sleep(30);
    assert.equal(h.opened.length, 0, "no session opened during the drain");
    h.host.endDrain();
    assert.deepEqual(await started, { kind: "started" });
    assert.equal(h.opened.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("OAR drain (acceptance 1): a Stop of a held start and of a session, and a turn interrupt, pass through at once", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "busy");
    const waiting = h.host.beginDrain({ deadlineMs: 60_000 });

    const interrupted = await h.host.interruptTurn("agent-1");
    assert.equal(interrupted.outcome, "interrupted", "the abort reaches the runtime during the drain");

    h.waiting.set("agent-2", ["launch-2"]);
    const held = h.host.start(request({ agentId: "agent-2", launchId: "launch-2" }));
    await sleep(10);
    await h.host.stopAgent("agent-2");
    assert.deepEqual(await held, { kind: "stopped" }, "the held start is cancelled at once");

    await h.host.stopAgent("agent-1");
    assert.equal(h.host.owns("agent-1"), false, "stopped during the drain");
    assert.equal((await waiting).finished, "quiet");
    assert.equal(h.opened.length, 1, "agent-2 never spawned");
    h.host.endDrain();
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

// Reconciler step 14 (Q-H): a /migrate source drains one agent (AgentDrains).
// RED proof: make `holds(agentId)` hold every agent and agent-2's delivery
// waits; drop the `only` filter in computeDrainProgress and agent-2's
// session joins the wait.
test("OAR agent drain: only the migrating agent is held and waited for; stopped with the hold on, its end hands nothing over", async () => {
  const release = deferred();
  let turns = 0;
  const h = await harness({ turn: async (t) => { turns += 1; if (turns === 1) await release.promise; t.say("done"); } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running", "agent-1's first turn running");
    const waiting = h.host.beginDrain({ deadlineMs: 60_000, agentId: "agent-1" });
    assert.equal(await settledSoon(waiting), "pending");

    h.waiting.set("agent-2", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ agentId: "agent-2", launchId: "launch-2" })), { kind: "started" }, "no start is held");
    await until(() => h.sessions[1]?.status().value.kind === "idle", "agent-2 idle");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held", { content: "held-body" })), true, "custody");
    assert.equal(await h.host.deliverMessage("agent-2", message("m-other", { content: "other-body" })), true);
    await until(() => h.inputs.some((input) => input.includes("other-body")), "another agent's delivery goes in");

    release.resolve();
    const summary = await settledSoon(waiting, 300);
    assert.notEqual(summary, "pending");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.waitedFor, ["agent-1"]);
    assert.equal(summary !== "pending" && summary.live, 1);

    // The migration's stop, then the end of the drain (core order).
    await h.host.stopAgent("agent-1", { wait: true, silent: true });
    h.host.endDrain("agent-1");
    await sleep(30);
    assert.equal(h.inputs.some((input) => input.includes("held-body")), false, "nothing held is delivered here");
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(h.opened.length, 2, "not started again here");
    assert.equal(h.host.drainProgress("agent-1"), null);
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("OAR agent drain: ended without a stop (the migration cancelled), the held delivery goes in and the session keeps running", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    assert.equal((await h.host.beginDrain({ deadlineMs: 60_000, agentId: "agent-1" })).finished, "quiet", "already idle: at once");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held", { content: "held-body" })), true);
    await sleep(20);
    assert.equal(h.inputs.length, 1, "held");
    h.host.endDrain("agent-1");
    await until(() => h.inputs.length === 2, "the held delivery after endDrain");
    assert.equal(h.inputs[1]!.includes("held-body"), true);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

// tygg: an agent that cannot run (an invalid record on its credential) with
// no turn in flight is not waited for on a handover only a turn would take
// (`flushing`, unconsumed stdin on this host). RED proof: drop
// agentStopWaitReason from computeDrainProgress and the first case waits
// `delivery_in_flight` until its deadline.
test("OAR agent drain (not runnable): an idle session with a handover in flight is waited for, unless its credential is invalid", async () => {
  const ledger = new ProviderLimitLedger();
  const h = await harness({ deps: { providerLimits: ledger } });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    const agent = (h.host as any).agents.get("agent-1");
    agent.flushing = true;
    const runnable = await h.host.beginDrain({ deadlineMs: 40, agentId: "agent-1" });
    assert.equal(runnable.finished, "deadline", "runnable: the handover is waited for");
    assert.deepEqual(runnable.notQuiet, [{ agentId: "agent-1", reason: "delivery_in_flight" }]);
    h.host.endDrain("agent-1");

    ledger.recordInvalid((h.host as any).credentialKey(agent), { invalidReason: "user_reauth", recordedAtMs: Date.now(), code: "verification_required" }, { host: "legacy" });
    const summary = await settledSoon(h.host.beginDrain({ deadlineMs: 60_000, agentId: "agent-1" }));
    assert.notEqual(summary, "pending", "not waited for");
    assert.equal(summary !== "pending" && summary.finished, "quiet");
    assert.deepEqual(summary !== "pending" && summary.notRunnable, [{ agentId: "agent-1", reason: "credential_invalid", settled: "delivery_in_flight" }]);
    agent.flushing = false;
    h.host.endDrain("agent-1");
  } finally {
    await h.cleanup();
  }
});
