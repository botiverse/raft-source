// Reconciler step 12 (#proj-raft-computer:#48, rows C8 and C9 on OAR, the
// legacy host's agentProcessManager.stickyFailure.test.ts): a failed turn
// whose class says the session no longer fits replaces the session once; one
// that says the model cannot be used gives the agent back to the server at
// once. Neither leaves a terminal record. Every round is start, the runtime's
// readiness (`agent:runtime:ready`, which ends the server's own failed-start
// count), then the failure.
//
// RED proof (reverse-verified): start the new session without the anti-loop
// record (`onFailedTurn` never reads `sessionReset`) and "C8 twice" opens a
// third session; report `runtime_spawn_failed` from the OAR
// `handStickyFailureToServer` whatever the server says and "C9 to a server
// that counts it" finds no `model_unsupported`.
import assert from "node:assert/strict";
import type { FailureClass } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { ExitStreaks } from "../planExit";
import { harness, makeConfig, message, request, sleep, until, withFailure, type Harness } from "../testing/oarAgentHostHarness";

async function stickyHarness(failure: FailureClass, turn: (turn: ScriptedTurn, index: number) => void | Promise<void>, capable: boolean): Promise<{ h: Harness; streaks: ExitStreaks }> {
  const streaks = new ExitStreaks();
  let index = 0;
  const h = await harness({
    turn: async (scripted) => {
      index += 1;
      await turn(scripted, index);
    },
    wrapSession: (session) => withFailure(session, failure),
    deps: { exitStreaks: streaks },
  });
  h.host.setServerStickyFailureReasonsCapable(capable);
  return { h, streaks };
}

type Activity = Extract<MachineToServerMessage, { type: "agent:activity" }>;
const startFailures = (h: Harness) => h.framesOf("agent:activity")
  .filter((frame): frame is Activity & { spawnFailure: NonNullable<Activity["spawnFailure"]> } => Boolean(frame.spawnFailure))
  .map((frame) => frame.spawnFailure.reason);
const readyBefore = (h: Harness, type: string) => {
  const ready = h.frames.findIndex((frame) => frame.type === "agent:runtime:ready");
  const other = h.frames.findIndex((frame) => frame.type === type && (type !== "agent:activity" || Boolean((frame as Activity).spawnFailure)));
  return ready >= 0 && other > ready;
};

test("C8 on OAR: a session that no longer fits is replaced once with the held delivery; again in the new one: session_needs_reset, no third session", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { h, streaks } = await stickyHarness("input_too_large", async (_turn, index) => {
    await (index === 1 ? gate : secondGate);
    throw new Error("maximum context length exceeded");
  }, true);
  try {
    await h.host.start(request({ config: makeConfig({ sessionId: "s-old" }) }));
    await until(() => h.inputs.length === 1, "the first turn runs");
    await h.host.deliverMessage("agent-1", message("m-held", { content: "the held delivery 7f3a" }), {});
    release();
    await until(() => h.opened.length === 2, "a new session opens");
    assert.equal(h.opened[1]!.options.resume, undefined, "on a new session");
    assert.deepEqual(h.framesOf("agent:session:invalidate").map((frame) => frame.reason), ["input_too_large"]);
    await until(() => h.inputs.length === 2, "the new session's first turn");
    assert.match(h.inputs[1]!, /the held delivery 7f3a/, "the held delivery reaches the new session");
    assert.equal(startFailures(h).length, 0, "no start failure: it recovered by itself");
    releaseSecond();

    await until(() => startFailures(h).length === 1, "the second overflow is handed to the server");
    assert.deepEqual(startFailures(h), ["session_needs_reset"]);
    assert.ok(readyBefore(h, "agent:activity"), "the start was ready before it failed");
    await sleep(200);
    assert.equal(h.opened.length, 2, "no third session");
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(streaks.sticky.sessionReset("agent-1"), "input_too_large");
    assert.equal(h.framesOf("agent:session:invalidate").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("C9 on OAR: to a server that counts it, model_unsupported at the first report; recorded until the model changes", async () => {
  const { h, streaks } = await stickyHarness("model_unavailable", () => { throw new Error("model gpt-x is not supported"); }, true);
  try {
    await h.host.start(request());
    await until(() => startFailures(h).length === 1, "handed to the server");
    assert.deepEqual(startFailures(h), ["model_unsupported"]);
    assert.ok(readyBefore(h, "agent:activity"), "the start was ready before it failed");
    assert.equal(h.framesOf("agent:runtime:outcome").filter((frame) => frame.outcome.kind === "terminal_failure").length, 1, "E1 still sent");
    await sleep(200);
    assert.equal(h.opened.length, 1, "nothing restarts it");
    assert.equal(h.host.owns("agent-1"), false);
    assert.equal(streaks.sticky.isUnusableModel("agent-1", "grok", "default"), true);

    await h.host.start(request({ launchId: "launch-2", config: makeConfig({ model: "other" }) }));
    assert.equal(streaks.sticky.isUnusableModel("agent-1", "grok", "default"), false, "a model change clears it");
  } finally {
    await h.cleanup();
  }
});

test("C9 on OAR: to a server without the capability, runtime_spawn_failed instead", async () => {
  const { h } = await stickyHarness("model_unavailable", () => { throw new Error("model gpt-x is not supported"); }, false);
  try {
    await h.host.start(request());
    await until(() => startFailures(h).length === 1, "handed to the server");
    assert.deepEqual(startFailures(h), ["runtime_spawn_failed"]);
  } finally {
    await h.cleanup();
  }
});
