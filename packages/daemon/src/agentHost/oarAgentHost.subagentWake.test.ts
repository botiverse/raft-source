// #proj-runtime:#41 on the OAR host: Codex only queues its sub-agents'
// results for the next turn, so when the last one ends after the main turn
// ended the host starts that turn with the sub-agents-finished input, as the
// legacy host's wakeAfterSubagentsFinished does
// (`daemon.runtime.subagent.finished_wake`, same outcomes).
//
// RED proof: drop the `wakeAfterSubagentsFinished` call in `onSubagentEnded`
// and the first test times out waiting for the wake.

import assert from "node:assert/strict";
import { test } from "vitest";
import type { ScriptedTask } from "@botiverse/oar/testing";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { formatSubagentsFinishedRuntimeInput } from "../agentRuntimeInput";
import { codexShared, harness, message, request, sleep, until, type Harness } from "../testing/oarAgentHostHarness";

const WAKE = formatSubagentsFinishedRuntimeInput();
const agentId = "agent-1";

function wakeEvents(h: Harness): Array<Record<string, unknown>> {
  return h.events.filter((event) => event.name === "daemon.runtime.subagent.finished_wake").map((event) => event.attrs);
}

function wakes(h: Harness): number {
  return h.inputs.filter((input) => input.includes(WAKE)).length;
}

function ended(h: Harness): number {
  return h.events.filter((event) => event.name === "daemon.runtime.subagent.progress" && event.attrs.phase === "notification").length;
}

/** The first turn starts one background sub-agent (held until `holdFirst` resolves, if given); every later turn answers. */
async function subagentHarness(options: { runtime?: "codex" | "grok"; holdFirst?: Promise<void> } = {}) {
  let task!: ScriptedTask;
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) {
        task = turn.task({ taskType: "agent", description: "look around", background: true });
        await options.holdFirst;
      }
      turn.say("ok");
    },
  });
  const config = options.runtime === "grok" ? request().config : codexShared();
  await h.host.start(request({ config }));
  await until(() => h.events.some((event) => event.name === "daemon.runtime.subagent.progress" && event.attrs.phase === "started"), "the sub-agent started");
  return { h, task: () => task };
}

const idle = (h: Harness) => h.sessions[0]?.status().value.kind === "idle" && h.framesOf("agent:activity").at(-1)?.detailKind === "idle";

test("Codex: the last sub-agent ends after the turn ended: the agent is woken once with the sub-agents-finished input", async () => {
  const { h, task } = await subagentHarness();
  const sink = new MemoryTraceSink();
  h.host.setTracer(new BasicTracer({ sink }));
  try {
    await until(() => idle(h), "the turn ended");
    assert.equal(h.inputs.length, 1);
    task().end("completed");
    await until(() => wakes(h) === 1, "the wake");
    await until(() => wakeEvents(h).length === 1, "the wake's event");
    assert.equal(h.inputs.at(-1), WAKE, "the input alone, as written");
    const [event] = wakeEvents(h);
    assert.equal(event!.outcome, "written");
    assert.equal(event!.host, "oar");
    assert.equal(event!.runtime, "codex");
    assert.equal(event!.launchId, "launch-1");
    assert.equal(typeof event!.wake_delay_ms, "number");
    await until(() => idle(h), "the woken turn ended");
    await sleep(30);
    assert.equal(wakes(h), 1, "once");
    // The woken turn is a sub-agents-finished turn in the turn trace, not an idle task reminder (as on the legacy host).
    const reasons = sink.getAllSpans().filter((span) => span.name === "daemon.runtime.turn").map((span) => span.attrs?.reason);
    assert.ok(reasons.includes("subagents-finished"), `turn reasons: ${reasons.join(", ")}`);
    assert.ok(!reasons.includes("idle-task-reminder"));
  } finally {
    await h.cleanup();
  }
});

test("Codex: a sub-agent that ends while the turn still runs: no wake (the turn has its result)", async () => {
  let release!: () => void;
  const holdFirst = new Promise<void>((resolve) => { release = resolve; });
  const { h, task } = await subagentHarness({ holdFirst });
  try {
    assert.equal(h.sessions[0]!.status().value.kind, "running");
    task().end("completed");
    await until(() => ended(h) === 1, "its end");
    release();
    await until(() => idle(h), "the turn ended");
    await sleep(30);
    assert.equal(wakes(h), 0);
    assert.equal(h.inputs.length, 1);
    assert.deepEqual(wakeEvents(h), []);
  } finally {
    release();
    await h.cleanup();
  }
});

test("Codex: only a person-stopped sub-agent ended: no wake, stopped_by_user", async () => {
  const { h, task } = await subagentHarness();
  try {
    await until(() => idle(h), "the turn ended");
    const agent = (h.host as unknown as { agents: Map<string, { session: object }> }).agents.get(agentId)!;
    Object.defineProperty(agent.session, "stopTask", { value: async () => ({ kind: "accepted" }), configurable: true });
    assert.equal(await h.host.interruptSubagent(agentId, task().taskId), "interrupted");
    task().end("stopped");
    await until(() => wakeEvents(h).length === 1, "the event");
    assert.equal(wakeEvents(h)[0]!.outcome, "stopped_by_user");
    await sleep(30);
    assert.equal(wakes(h), 0);
    assert.equal(h.inputs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("Codex: a held inbox message carries the results: messages_pending, and no wake beside it", async () => {
  const { h, task } = await subagentHarness();
  try {
    await until(() => idle(h), "the turn ended");
    // Reconciler step 13: the drain holds the message in the idle session
    // (it holds until endDrain; the running sub-agent keeps it at its deadline).
    await h.host.beginDrain({ deadlineMs: 20 });
    assert.equal(await h.host.deliverMessage(agentId, message("m-held", { content: "held-body" })), true, "custody");
    task().end("completed");
    await until(() => wakeEvents(h).length === 1, "the event");
    assert.equal(wakeEvents(h)[0]!.outcome, "messages_pending");
    h.host.endDrain();
    await until(() => h.inputs.length === 2, "the held message");
    assert.ok(h.inputs[1]!.includes("held-body"));
    await until(() => idle(h), "its turn ended");
    await sleep(30);
    assert.equal(wakes(h), 0);
    assert.equal(h.inputs.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("Codex: an agent being stopped is not woken", async () => {
  const { h, task } = await subagentHarness();
  try {
    await until(() => idle(h), "the turn ended");
    const stopped = h.host.stopAgent(agentId, { wait: true });
    task().end("completed");
    await stopped;
    await sleep(30);
    assert.equal(wakes(h), 0);
    assert.equal(h.inputs.length, 1);
    assert.equal(wakeEvents(h).some((event) => event.outcome === "written"), false);
  } finally {
    await h.cleanup();
  }
});

test("a runtime that continues by itself (not needsWakeAfterSubagents) is never woken", async () => {
  const { h, task } = await subagentHarness({ runtime: "grok" });
  try {
    await until(() => idle(h), "the turn ended");
    task().end("completed");
    await until(() => ended(h) === 1, "its end");
    await sleep(30);
    assert.equal(wakes(h), 0);
    assert.deepEqual(wakeEvents(h), []);
  } finally {
    await h.cleanup();
  }
});

test("Codex: a person stopped the turn: finishing sub-agents don't undo that (turn_stopped)", async () => {
  let release!: () => void;
  const holdFirst = new Promise<void>((resolve) => { release = resolve; });
  const { h, task } = await subagentHarness({ holdFirst });
  try {
    assert.deepEqual(await h.host.interruptTurn(agentId), { outcome: "interrupted" });
    await until(() => h.sessions[0]?.status().value.kind === "idle", "the turn aborted");
    task().end("completed");
    await until(() => wakeEvents(h).length === 1, "the event");
    assert.equal(wakeEvents(h)[0]!.outcome, "turn_stopped");
    await sleep(30);
    assert.equal(wakes(h), 0);
  } finally {
    release();
    await h.cleanup();
  }
});
