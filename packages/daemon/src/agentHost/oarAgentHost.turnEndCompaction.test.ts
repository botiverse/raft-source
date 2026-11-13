// #proj-runtime:#54 phase 3: native compaction at a turn end past the size
// threshold, on the OAR host (Codex, Grok: OAR `Session.compact()`). The
// scripted runtime reports a small context on a 200k window, so these tests
// lower the threshold and the window floor through the agent's env; the
// scripted session has no compact of its own, so `wrapSession` gives it one.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import type { AgentConfig } from "@botiverse/raft-shared";
import { harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";

type CompactResult = Awaited<ReturnType<NonNullable<Session["compact"]>>>;

const SMALL = { RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "50", RAFT_TURN_END_COMPACTION_MIN_WINDOW_TOKENS: "100000" };
const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => makeConfig({ envVars: SMALL, turnEndCompaction: true, ...overrides });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const completed = (): CompactResult => ({ kind: "completed", request: {} as never, frame: {} as never });
const refused = (): CompactResult => ({ kind: "rejected", request: {} as never, response: {} as never, code: "busy", reason: "a goal is active" });

/** A harness whose sessions compact through `compact`, recording every call. */
async function compactHarness(compact: () => Promise<CompactResult>, idleNotices: string[] = []) {
  const calls: number[] = [];
  const h = await harness({
    deps: { onAgentWorkingToIdle: (agentId: string) => idleNotices.push(agentId) },
    wrapSession: (session) => new Proxy(session, {
      get(target, prop) {
        if (prop === "compact") return async () => { calls.push(Date.now()); return compact(); };
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  return { h, calls };
}

const events = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.turn_end_compaction").map((event) => event.attrs);
const outcomes = (h: Harness) => events(h).map((attrs) => attrs.outcome);

async function firstTurn(h: Harness, overrides: Partial<AgentConfig> = {}): Promise<void> {
  assert.deepEqual(await h.host.start(request({ config: config(overrides), wakeMessage: message("m-1") })), { kind: "started" });
  await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
}

test("#54 phase 3: past the threshold at a turn end with nothing waiting, the OAR session compacts once; it doesn't fire again until it has re-armed", async () => {
  const { h, calls } = await compactHarness(async () => completed());
  try {
    await firstTurn(h);
    await until(() => outcomes(h).includes("completed"), "the turn-end compaction");
    assert.equal(calls.length, 1);
    const started = events(h).find((attrs) => attrs.outcome === "started")!;
    assert.equal(started.host, "oar");
    assert.equal(started.runtime, "grok");
    assert.equal(started.threshold_tokens, 50);
    assert.equal(started.context_window_tokens, 200_000);
    assert.ok(Number(started.context_tokens) > 50, "the context the runtime reported");
    const done = events(h).find((attrs) => attrs.outcome === "completed")!;
    assert.equal(done.deliveries_held, 0);
    assert.equal(typeof done.duration_ms, "number");

    // The next turn ends still past the threshold (the scripted session's context only grows): no second compaction.
    assert.equal(await h.host.deliverMessage("agent-1", message("m-2")), true);
    await until(() => h.inputs.length === 2, "the second turn");
    await until(() => outcomes(h).includes("skipped:not_rearmed"), "the second turn end's decision");
    assert.equal(calls.length, 1, "not re-armed: the context never dropped to the threshold");
  } finally {
    await h.cleanup();
  }
});

test("#54 phase 3: with the flag off nothing is compacted and nothing is recorded", async () => {
  const { h, calls } = await compactHarness(async () => completed());
  try {
    await firstTurn(h, { turnEndCompaction: undefined });
    await sleep(40);
    assert.equal(calls.length, 0);
    assert.deepEqual(events(h), []);
  } finally {
    await h.cleanup();
  }
});

test("#54 phase 3: a model window below the floor keeps the runtime's own compaction, and says why once", async () => {
  const { h, calls } = await compactHarness(async () => completed());
  try {
    await firstTurn(h, { envVars: { RAFT_TURN_END_COMPACTION_MIN_CONTEXT_TOKENS: "50" } });
    await until(() => events(h).length > 0, "the skip");
    assert.deepEqual(outcomes(h), ["skipped:window_too_small"]);
    assert.equal(events(h)[0]!.context_window_tokens, 200_000);
    assert.equal(events(h)[0]!.min_window_tokens, 400_000);
    assert.equal(calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("#54 phase 3: a refusal is a skip; the arm is kept and a later turn end compacts", async () => {
  const results = [refused(), completed()];
  const { h, calls } = await compactHarness(async () => results.shift() ?? completed());
  try {
    await firstTurn(h);
    await until(() => outcomes(h).includes("refused:busy"), "the refusal");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-2")), true);
    await until(() => outcomes(h).includes("completed"), "the compaction at the next turn end");
    assert.equal(calls.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("#54 phase 3: a delivery that arrives during the compaction waits and is handed over once after it", async () => {
  let release: () => void = () => {};
  const { h, calls } = await compactHarness(() => new Promise<CompactResult>((resolve) => { release = () => resolve(completed()); }));
  try {
    await firstTurn(h);
    await until(() => calls.length === 1, "the compaction under way");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-2")), true);
    await sleep(40);
    assert.equal(h.inputs.length, 1, "held behind the compaction");
    release();
    await until(() => h.inputs.length === 2, "handed over once it settled");
    await sleep(40);
    assert.equal(h.inputs.length, 2, "exactly once");
    const done = events(h).find((attrs) => attrs.outcome === "completed")!;
    assert.equal(done.deliveries_held, 1);
    assert.ok(Number(done.hold_ms) >= 0, "the hold time is recorded");
  } finally {
    await h.cleanup();
  }
});

test("#54 phase 3: the host-asked compaction shows as compacting, then idle, and runs no idle hooks of its own", async () => {
  let release: () => void = () => {};
  const idleNotices: string[] = [];
  const { h, calls } = await compactHarness(() => new Promise<CompactResult>((resolve) => { release = () => resolve(completed()); }), idleNotices);
  try {
    await firstTurn(h);
    await until(() => calls.length === 1, "the compaction under way");
    await until(() => idleNotices.length === 1, "the real turn's idle hooks");
    const detailKinds = () => h.framesOf("agent:activity").map((frame) => (frame as { detailKind?: string }).detailKind);
    assert.equal(detailKinds().at(-1), "compacting_context", "the agent shows as compacting while it runs");
    release();
    await until(() => outcomes(h).includes("completed"), "settled");
    await until(() => detailKinds().at(-1) === "idle", "back to idle once it settled");
    await sleep(40);
    assert.equal(idleNotices.length, 1, "a compaction ends no work: no second Cleaner hint or idle task reminder");
  } finally {
    await h.cleanup();
  }
});
