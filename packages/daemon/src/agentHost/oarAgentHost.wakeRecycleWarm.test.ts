// Warm wake recycle on the OAR host (#proj-runtime:#54, RFC 070 §6.5; the rule
// is wakeRecycleWarm.ts). With the Server's `wake_recycle_warm` on (and
// `wake_recycle_oar`, which supplies the next start's facts), a Codex or Grok
// session past the warm threshold at a clean turn end with nothing running,
// held or queued is marked, ended the cold-idle way after the quiet period
// (at once past the ceiling), and the next start gives it a fresh session
// with the notice. The scripted runtime reports a small context (about 140
// tokens) on a 200k window, so these tests lower the knobs through the
// agent's env; the quiet period runs on real time, shortened the same way.
// RED proofs: drop `maybeMarkWarmRecycle` from the turn end and nothing is
// marked; drop `cancelWarmRecycle` from `hold` and a delivery inside the
// window no longer keeps the session; drop `warmStop` from the start's
// `planWakeSessionRecycle` and the next start resumes; drop `takeYield` and
// a cancelled mark starves turn-end compaction; drop `dropPending` from
// `release` / `stopAgent` and the quiet timer fires a `not_idle` cancel for a
// session already gone.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import type { ScriptedTask, ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentConfig } from "@botiverse/raft-shared";
import { createAgentAppInboxStore } from "../agentAppInbox";
import { REMINDER_AGENT_INBOX_REGISTRY } from "../apps/reminder/inboxDefinition";
import { harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";
import type { WarmRecycleTimers } from "../wakeRecycleWarm";
import { buildWarmRecycleNotice } from "../wakeSessionRecycle";

const SESSION_ID = "sess-warm";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const env = (overrides: Record<string, string> = {}) => ({
  RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "50",
  RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: "100000",
  RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "150",
  ...overrides,
});
const config = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  makeConfig({ sessionId: SESSION_ID, envVars: env(), wakeRecycleWarm: true, wakeRecycleOar: true, ...overrides });

/**
 * The warm-recycle quiet timer, fired by hand (`deps.warmRecycleTimers`): no
 * test below waits on the wall clock for the quiet period (#13258).
 */
function manualTimers() {
  const armed = new Set<{ fn: () => void; ms: number }>();
  const timers: WarmRecycleTimers = {
    set: (fn, ms) => { const handle = { fn, ms }; armed.add(handle); return handle; },
    clear: (handle) => { armed.delete(handle as { fn: () => void; ms: number }); },
  };
  return {
    timers,
    armed: () => armed.size,
    /** The quiet period passes: every armed timer runs. */
    fire: () => { const due = [...armed]; armed.clear(); for (const handle of due) handle.fn(); },
  };
}

/** Whether the host has evaluated the turn end a cancelled mark yielded (the yield is taken there). */
const yieldPending = (h: Harness) => ((h.host as any).warmRecycle.yields as Map<string, string>).has("agent-1");

const named = (h: Harness, name: string) => h.events.filter((event) => event.name === name).map((event) => event.attrs);
const marks = (h: Harness) => named(h, "daemon.agent.wake_recycle.warm_marked");
const stops = (h: Harness) => named(h, "daemon.agent.wake_recycle.warm_stopped");
const cancels = (h: Harness) => named(h, "daemon.agent.wake_recycle.warm_cancelled");

async function firstTurn(h: Harness, overrides: Partial<AgentConfig> = {}): Promise<void> {
  assert.deepEqual(await h.host.start(request({ config: config(overrides), wakeMessage: message("m-1") })), { kind: "started" });
  await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
  await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
}

test("§6.5: past the threshold at a clean turn end the OAR session is marked, ended after the quiet period the cold-idle way, and the next start recycles it with the notice", async () => {
  const h = await harness();
  try {
    await firstTurn(h);
    await until(() => marks(h).length > 0, "the mark");
    const mark = marks(h)[0]!;
    assert.equal(mark.host, "oar");
    assert.equal(mark.runtime, "grok");
    assert.equal(mark.band, "quiet");
    assert.equal(mark.session_id, SESSION_ID);
    assert.ok(Number(mark.context_tokens) > 50, "the context the runtime reported");
    assert.equal(mark.window_tokens, 200_000);
    assert.equal(mark.quiet_ms, 150);
    assert.deepEqual(stops(h), [], "inside the quiet period");
    assert.equal(h.host.owns("agent-1"), true);

    await until(() => stops(h).length > 0, "the stop after the quiet period");
    const stop = stops(h)[0]!;
    assert.equal(stop.host, "oar");
    assert.equal(stop.band, "quiet");
    assert.equal(stop.context_tokens, mark.context_tokens);
    assert.ok(Number(stop.waited_ms) >= 140, "waited the quiet period");
    assert.equal(h.host.owns("agent-1"), false, "the agent left the host: the next delivery asks the Server for a start");
    await h.host.unwound("agent-1");
    assert.equal(h.framesOf("agent:process_exited").length, 1);
    assert.deepEqual(h.framesOf("agent:status").map((frame) => frame.status), ["active"], "a stop on purpose: never reported inactive");
    assert.deepEqual(cancels(h), []);

    // The Server's next start, moments later: nowhere near the cold gap, recycled all the same.
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: config(), wakeMessage: message("m-2") })), { kind: "started" });
    const recycle = named(h, "daemon.agent.wake_recycle");
    assert.equal(recycle.length, 1);
    assert.equal(recycle[0]!.host, "oar");
    assert.equal(recycle[0]!.reason, "warm_recycle");
    assert.equal(recycle[0]!.recycle_kind, "warm");
    assert.equal(recycle[0]!.band, "quiet");
    assert.equal(recycle[0]!.trigger_kind, "message");
    assert.equal(typeof recycle[0]!.gap_since_stop_ms, "number");
    assert.equal(h.opened[1]!.options.resume, undefined, "a fresh session, not a resume");
    await until(() => h.inputs.length >= 2, "the recycled session's first input");
    assert.ok(h.inputs[1]!.startsWith(String(buildWarmRecycleNotice())), "the first input opens with the warm notice");
    assert.match(h.inputs[1]!, /m-2/, "and carries the wake");
  } finally {
    await h.cleanup();
  }
});

test("§6.5: a delivery inside the quiet period lands in the same session and drops the stop; the next clean turn end decides again", async () => {
  const quiet = manualTimers();
  const h = await harness({ deps: { warmRecycleTimers: quiet.timers } });
  try {
    await firstTurn(h);
    await until(() => marks(h).length === 1, "the mark");
    assert.equal(quiet.armed(), 1);
    assert.equal(await h.host.deliverMessage("agent-1", message("m-2")), true);
    assert.deepEqual(cancels(h).map((attrs) => [attrs.reason, attrs.sender_kind, attrs.trigger_kind, attrs.host]), [["delivery", "human", "message", "oar"]]);
    assert.equal(typeof cancels(h)[0]!.waited_ms, "number");
    assert.equal(quiet.armed(), 0, "the quiet timer went with the mark");
    await until(() => h.inputs.length === 2, "the delivery's turn, in the same session");
    assert.equal(h.opened.length, 1);
    assert.deepEqual(stops(h), [], "the first turn end's stop was dropped");

    // The delivery's own turn end is compaction's: the cancelled mark already skipped one.
    // (`agent:turn:ended` is sent once per process, for its first turn end only,
    // so the turn end is observed by the host taking the yield there; the cancel
    // above set it synchronously.)
    await until(() => !yieldPending(h), "the delivery's turn end decided");
    assert.equal(marks(h).length, 1, "not marked at the turn end right after a cancelled mark");
    assert.equal(quiet.armed(), 0);
    assert.deepEqual(stops(h), []);
    assert.equal(h.host.owns("agent-1"), true);

    assert.equal(await h.host.deliverMessage("agent-1", message("m-3")), true);
    await until(() => marks(h).length === 2, "marked again at the turn end after that");
    assert.equal(quiet.armed(), 1);
    quiet.fire();
    await until(() => stops(h).length === 1, "and stopped once that one stayed quiet");
  } finally {
    await h.cleanup();
  }
});

test("§6.5: past the ceiling the session is ended at the first clean turn end, with no wait", async () => {
  const h = await harness();
  try {
    await firstTurn(h, { envVars: env({ RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "60", RAFT_WAKE_RECYCLE_WARM_QUIET_MS: "600000" }) });
    await until(() => stops(h).length > 0, "the stop");
    assert.deepEqual(marks(h).map((attrs) => attrs.band), ["ceiling"]);
    assert.equal(stops(h)[0]!.band, "ceiling");
    assert.ok(Number(stops(h)[0]!.waited_ms) < 1_000, "no quiet period");
    assert.equal(h.host.owns("agent-1"), false);
  } finally {
    await h.cleanup();
  }
});

test("§6.5: the flag off, wake_recycle_oar off (no facts for the next start) or the local RAFT_WAKE_RECYCLE=0: nothing is marked or ended", async () => {
  for (const [label, overrides] of [
    ["wake_recycle_warm absent", { wakeRecycleWarm: undefined }],
    ["wake_recycle_warm false", { wakeRecycleWarm: false }],
    ["wake_recycle_oar off", { wakeRecycleOar: undefined }],
    ["RAFT_WAKE_RECYCLE=0", { envVars: env({ RAFT_WAKE_RECYCLE: "0" }) }],
    ["a window below the floor", { envVars: env({ RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: "400000" }) }],
  ] as const) {
    const h = await harness();
    try {
      await firstTurn(h, overrides as Partial<AgentConfig>);
      await sleep(250);
      assert.deepEqual(marks(h), [], label);
      assert.deepEqual(stops(h), [], label);
      assert.equal(h.host.owns("agent-1"), true, label);
    } finally {
      await h.cleanup();
    }
  }
});

test("§6.5: a session with a sub-agent still running is not marked", async () => {
  let task: ScriptedTask | null = null;
  const h = await harness({
    turn: (turn: ScriptedTurn) => {
      if (!task) task = turn.task({ taskType: "agent", description: "long test run", background: true });
      turn.say("started a sub-agent");
    },
  });
  try {
    await firstTurn(h, { envVars: env({ RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "60" }) });
    await sleep(250);
    assert.deepEqual(marks(h), [], "a working sub-agent holds it");
    assert.deepEqual(stops(h), []);
    assert.equal(h.host.owns("agent-1"), true);
    task!.end("completed");
  } finally {
    await h.cleanup();
  }
});

test("§6.5: with turn_end_compaction also on, warm recycle goes first: the session is marked and not compacted", async () => {
  const compactCalls: number[] = [];
  const h = await harness({
    wrapSession: (session: Session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "compact") return async () => { compactCalls.push(Date.now()); return { kind: "completed", request: {} as never, frame: {} as never }; };
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    await firstTurn(h, {
      turnEndCompaction: true,
      envVars: env({ RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "50", RAFT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS: "100000" }),
    });
    await until(() => stops(h).length > 0, "the warm stop");
    assert.equal(marks(h).length, 1);
    assert.equal(compactCalls.length, 0, "no compaction of a session about to be replaced");
    assert.deepEqual(named(h, "daemon.agent.turn_end_compaction"), [], "the compaction gate was not even asked");
  } finally {
    await h.cleanup();
  }
});

/** A Session whose `compact` is counted and completes at once. */
const countingCompact = (compactCalls: number[]) => (session: Session) => new Proxy(session, {
  get(target, prop) {
    if (prop === "compact") return async () => { compactCalls.push(Date.now()); return { kind: "completed", request: {} as never, frame: {} as never }; };
    const value: unknown = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

const bothFlags = (quietMs: string): Partial<AgentConfig> => ({
  turnEndCompaction: true,
  envVars: env({ RAFT_WAKE_RECYCLE_WARM_QUIET_MS: quietMs, RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "50", RAFT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS: "100000" }),
});

test("§6.5: with both flags on, a mark a delivery cancelled leaves the next turn end to compaction (no starvation)", async () => {
  const compactCalls: number[] = [];
  const quiet = manualTimers();
  const h = await harness({ wrapSession: countingCompact(compactCalls), deps: { warmRecycleTimers: quiet.timers } });
  try {
    await firstTurn(h, bothFlags("400"));
    await until(() => marks(h).length === 1, "the mark");
    assert.equal(compactCalls.length, 0, "the marked turn end skipped compaction");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-2")), true);
    assert.deepEqual(cancels(h).map((attrs) => attrs.reason), ["delivery"]);
    await until(() => compactCalls.length === 1, "the delivery's turn end compacts, as with the warm flag off");
    assert.equal(marks(h).length, 1, "and is not marked");
    assert.equal(quiet.armed(), 0, "no quiet timer left to stop it");
    quiet.fire();
    assert.deepEqual(stops(h), []);
    assert.equal(h.host.owns("agent-1"), true);
  } finally {
    await h.cleanup();
  }
});

test("§6.5: the warm flag off leaves turn-end compaction as it was: compacted at the first turn end, no warm event", async () => {
  for (const overrides of [{ wakeRecycleWarm: undefined }, { wakeRecycleWarm: false }] as Partial<AgentConfig>[]) {
    const compactCalls: number[] = [];
    const quiet = manualTimers();
    const h = await harness({ wrapSession: countingCompact(compactCalls), deps: { warmRecycleTimers: quiet.timers } });
    try {
      await firstTurn(h, { ...bothFlags("150"), ...overrides });
      await until(() => compactCalls.length === 1, "compacted at the turn end");
      assert.equal(quiet.armed(), 0, "no quiet timer armed");
      assert.deepEqual(h.events.filter((event) => event.name.startsWith("daemon.agent.wake_recycle.warm_")), []);
      assert.equal(h.host.owns("agent-1"), true);
    } finally {
      await h.cleanup();
    }
  }
});

test("§6.5: an app Inbox notice inside the quiet period cancels the stop (sender app)", async () => {
  const store = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
  const quiet = manualTimers();
  const h = await harness({ deps: { appInboxForAgent: () => store, warmRecycleTimers: quiet.timers } });
  try {
    await firstTurn(h);
    await until(() => marks(h).length === 1, "the mark");
    const minted = store.mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: "1598ee1a-81c7-4aba-a76b-c75aab407097", revision: "1" },
      title: "check the board",
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) return;
    assert.equal(await h.host.notifyAgentAppInbox("agent-1", minted.item), true);
    const cancelled = cancels(h);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.reason, "delivery");
    assert.equal(cancelled[0]!.sender_kind, "app");
    assert.equal(typeof cancelled[0]!.trigger_kind, "string");
    assert.equal(quiet.armed(), 0, "the quiet timer went with the mark");
    quiet.fire();
    assert.deepEqual(stops(h), [], "the session was kept for the notice");
  } finally {
    await h.cleanup();
  }
});

test("§6.5: a wake hint (the idle task reminder) inside the quiet period cancels the stop (sender daemon)", async () => {
  const quiet = manualTimers();
  const h = await harness({ deps: { warmRecycleTimers: quiet.timers } });
  try {
    await firstTurn(h);
    await until(() => marks(h).length === 1, "the mark");
    assert.equal(await h.host.deliverIdleNotice("agent-1", "you have open tasks"), "written");
    assert.deepEqual(cancels(h).map((attrs) => [attrs.reason, attrs.sender_kind, attrs.trigger_kind]), [["delivery", "daemon", "wake_hint"]]);
    assert.equal(quiet.armed(), 0, "the quiet timer went with the mark");
    quiet.fire();
    assert.deepEqual(stops(h), []);
  } finally {
    await h.cleanup();
  }
});

test("§6.5: a stop inside the quiet period ends the mark and its timer, with no warm_cancelled", async () => {
  const quiet = manualTimers();
  const h = await harness({ deps: { warmRecycleTimers: quiet.timers } });
  try {
    await firstTurn(h);
    await until(() => marks(h).length === 1, "the mark");
    assert.equal(quiet.armed(), 1);
    await h.host.stopAgent("agent-1", { wait: true });
    assert.equal(quiet.armed(), 0, "the quiet timer went with the session");
    quiet.fire();
    assert.deepEqual(cancels(h), [], "no not_idle cancel from a timer that outlived the session");
    assert.deepEqual(stops(h), []);
  } finally {
    await h.cleanup();
  }
});
