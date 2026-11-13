// Wake recycle on the OAR host (#proj-runtime:#54, RFC 070 step 8b): while
// the Server's `wake_recycle_oar` is on, a Codex or Grok session that turned
// cold idle (idle past the gap, context past the threshold, nothing open) is
// ended keeping its session, and the next start's recycle decision, from the
// same session summary, starts it fresh with a briefing. Off, nothing changes.
// RED proof: drop `reconcileColdIdle` from `reconcile` (or the sweep's
// `coldIdleCandidate`) and no cold session is ended; drop its `agentNotIdle`
// check and a session with a running background task is ended; drop
// `summaryFactsRuntimesFor` and the next start resumes.
import assert from "node:assert/strict";
import type { ScriptedTask, ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentConfig } from "@botiverse/raft-shared";
import { harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";

const HOUR_MS = 60 * 60_000;
const SESSION_ID = "sess-cold";

const coldStops = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.cold_idle_stop").map((event) => event.attrs);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host whose clock runs `offset.ms` ahead of real time (OAR's own record times stay real), sweeping every 10 ms. */
async function coldIdleHarness(options: { turn?: (turn: ScriptedTurn) => void | Promise<void> } = {}) {
  const offset = { ms: 0 };
  const h = await harness({
    ...(options.turn ? { turn: options.turn } : {}),
    deps: { now: () => Date.now() + offset.ms, featuresSweepMs: 10 },
  });
  return { h, offset };
}

/** The scripted runtime reports a small context (about 140 tokens); the agent's own threshold makes it "large". */
const SMALL_THRESHOLD = { RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "50" };

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => makeConfig({ sessionId: SESSION_ID, envVars: SMALL_THRESHOLD, ...overrides });

async function startIdle(h: Harness, overrides: Partial<AgentConfig> = {}): Promise<void> {
  assert.deepEqual(await h.host.start(request({ config: config(overrides), wakeMessage: message("m-1") })), { kind: "started" });
  await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
  await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
  assert.equal(h.sessions[0]!.id, SESSION_ID, "the start resumed the session");
}

test("#54: wake_recycle_oar on: a cold idle OAR session is ended keeping its session, and the next start recycles it", async () => {
  const { h, offset } = await coldIdleHarness();
  try {
    await startIdle(h, { wakeRecycleOar: true });
    assert.deepEqual(coldStops(h), [], "just ran: not cold");

    offset.ms = 2 * HOUR_MS;
    await until(() => coldStops(h).length > 0, "the cold-idle stop from the sweep");
    const stop = coldStops(h)[0]!;
    assert.equal(stop.host, "oar");
    assert.equal(stop.session_id, SESSION_ID);
    assert.ok(Number(stop.prior_context_tokens) > 50, "the context the runtime reported");
    assert.equal(stop.trigger, "sweep");
    assert.ok(Number(stop.idle_ms) > HOUR_MS);
    assert.equal(h.host.owns("agent-1"), false, "the agent left the host: the next delivery asks the Server for a start");
    await h.host.unwound("agent-1");
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active"], "a stop on purpose: never reported inactive");

    // The Server's next start, on the same session: the summary's facts say cold, so it starts fresh.
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: config({ wakeRecycleOar: true }), wakeMessage: message("m-2") })), { kind: "started" });
    const recycle = h.events.find((event) => event.name === "daemon.agent.wake_recycle");
    assert.ok(recycle, "recycled at the start");
    assert.equal(recycle.attrs.host, "oar");
    assert.equal(recycle.attrs.reason, "cold_gap_large_context");
    assert.equal(h.opened[1]!.options.resume, undefined, "a fresh session, not a resume");
    await until(() => h.inputs.length >= 2, "the recycled session's first input");
    assert.match(h.inputs[1]!, /m-2|<recent-|MEMORY|briefing/i, "the fresh session's first input carries the wake");
  } finally {
    await h.cleanup();
  }
});

test("#54: wake_recycle_oar off (absent or false): nothing is ended, and the next start resumes", async () => {
  for (const flag of [undefined, false] as const) {
    const { h, offset } = await coldIdleHarness();
    try {
        await startIdle(h, flag === undefined ? {} : { wakeRecycleOar: flag });
      offset.ms = 2 * HOUR_MS;
      await sleep(60);
      assert.deepEqual(coldStops(h), [], `flag ${String(flag)}: no cold-idle stop`);
      assert.equal(h.host.owns("agent-1"), true);
    } finally {
      await h.cleanup();
    }
  }
});

test("#54: a session with a sub-agent still working is not cold until it ends", async () => {
  let task: ScriptedTask | null = null;
  const { h, offset } = await coldIdleHarness({
    turn: (turn) => {
      if (!task) task = turn.task({ taskType: "agent", description: "long test run", background: true });
      turn.say("started a sub-agent");
    },
  });
  try {
    await startIdle(h, { wakeRecycleOar: true });
    offset.ms = 2 * HOUR_MS;
    // Still working: it reports progress.
    task!.update({ description: "still running the tests" });
    await sleep(60);
    assert.deepEqual(coldStops(h), [], "a working sub-agent holds it");
    assert.equal(h.host.owns("agent-1"), true);

    task!.end("completed");
    await until(() => coldStops(h).length > 0, "the stop once the sub-agent ended");
  } finally {
    await h.cleanup();
  }
});

test("#54: a sub-agent silent for more than an hour but never ended still holds the session (ending would kill it)", async () => {
  let task: ScriptedTask | null = null;
  const { h, offset } = await coldIdleHarness({
    turn: (turn) => {
      if (!task) task = turn.task({ taskType: "agent", description: "a 90-minute test run that prints nothing", background: true });
      turn.say("started a sub-agent");
    },
  });
  try {
    await startIdle(h, { wakeRecycleOar: true });
    // No event from it since it started: two hours of silence, not ended.
    offset.ms = 2 * HOUR_MS;
    await sleep(60);
    assert.deepEqual(coldStops(h), [], "a silent sub-agent with no end is never presumed finished here");
    assert.equal(h.host.owns("agent-1"), true);

    task!.end("completed");
    await until(() => coldStops(h).length > 0, "the stop once it really ended");
  } finally {
    await h.cleanup();
  }
});

test("#54: a recent session, or one below the context threshold, is not cold", async () => {
  {
    const { h, offset } = await coldIdleHarness();
    try {
        await startIdle(h, { wakeRecycleOar: true });
      offset.ms = 30 * 60_000;
      await sleep(60);
      assert.deepEqual(coldStops(h), [], "30 minutes: still warm");
    } finally {
      await h.cleanup();
    }
  }
  {
    const { h, offset } = await coldIdleHarness();
    try {
      await startIdle(h, { wakeRecycleOar: true, envVars: { RAFT_WAKE_RECYCLE_MIN_CONTEXT_TOKENS: "128000" } });
      offset.ms = 2 * HOUR_MS;
      await sleep(60);
      assert.deepEqual(coldStops(h), [], "below the threshold: cheap to resume");
      assert.equal(h.host.owns("agent-1"), true);
    } finally {
      await h.cleanup();
    }
  }
});

test("#54: the local RAFT_WAKE_RECYCLE=0 still turns the stop off with the flag on", async () => {
  const { h, offset } = await coldIdleHarness();
  try {
    await startIdle(h, { wakeRecycleOar: true, envVars: { ...SMALL_THRESHOLD, RAFT_WAKE_RECYCLE: "0" } });
    offset.ms = 2 * HOUR_MS;
    await sleep(60);
    assert.deepEqual(coldStops(h), []);
  } finally {
    await h.cleanup();
  }
});
