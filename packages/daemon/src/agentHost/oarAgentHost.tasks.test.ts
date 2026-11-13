import assert from "node:assert/strict";
import { test } from "vitest";
import type { ScriptedTask } from "@botiverse/oar/testing";
import { harness, request, sleep, until, type Harness } from "../testing/oarAgentHostHarness";

function rows(h: Harness): Array<Record<string, unknown>> {
  return h.framesOf("agent:activity").flatMap((frame) => (frame.entries ?? []).flatMap((entry) => {
    const row = entry as { kind: string; title?: string; subagent?: Record<string, unknown> };
    return row.kind === "system" && row.subagent ? [{ detail: row.title, ...row.subagent }] : [];
  }));
}

type TaskSpec = { taskType: "agent" | "shell" | "tool" | "workflow" | "other"; description?: string; background?: boolean };

function withTask(run: (task: (spec: TaskSpec) => ScriptedTask) => Promise<void> | void) {
  return harness({
    turn: async (turn) => {
      await run((spec) => turn.task(spec));
    },
  });
}

function stopTaskOn(h: Harness, stop: (taskId: string) => Promise<unknown>): void {
  const agent = (h.host as unknown as { agents: Map<string, { session: object }> }).agents.values().next().value!;
  Object.defineProperty(agent.session, "stopTask", { value: stop, configurable: true });
}

test("a sub-agent's life shows as rows; a shell task doesn't", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = await withTask(async (task) => {
    const shell = task({ taskType: "shell", description: "ls" });
    shell.end("completed");
    const agent = task({ taskType: "agent", description: "look around" });
    agent.update({ status: "running" });
    agent.end("completed");
    const failed = task({ taskType: "agent" });
    failed.end("failed");
    release();
  });
  try {
    await h.host.start(request());
    await held;
    await until(() => rows(h).length >= 5, "the rows");
    const shown = rows(h);
    assert.deepEqual(shown.map((row) => [row.phase, row.outcome]), [
      ["started", undefined],
      ["progress", undefined],
      ["notification", "done"],
      ["started", undefined],
      ["notification", "failed"],
    ]);
    assert.equal(typeof shown[0]!.taskId, "string");
    assert.equal(shown[0]!.taskId, shown[2]!.taskId);
    assert.equal(shown[0]!.detail, "Subagent started");
  } finally {
    await h.cleanup();
  }
});

test("a row's frame restates the agent's status: a sub-agent's end doesn't make an idle agent read as working", async () => {
  let task!: ScriptedTask;
  const h = await withTask((start) => {
    task = start({ taskType: "agent", background: true });
  });
  try {
    await h.host.start(request());
    await until(() => rows(h).length >= 1, "the sub-agent started");
    await until(() => h.framesOf("agent:activity").at(-1)?.detailKind === "idle", "the turn ended");
    task.end("completed");
    await until(() => rows(h).length >= 2, "its end");
    const frame = h.framesOf("agent:activity").at(-1)!;
    assert.equal(frame.detailKind, "idle");
    assert.equal(rows(h).at(-1)!.outcome, "done");
  } finally {
    await h.cleanup();
  }
});

test("a row's frame keeps a typed runtime error: the owner still sees what to do", async () => {
  let task!: ScriptedTask;
  const h = await withTask((start) => {
    task = start({ taskType: "agent", background: true });
    throw new Error("the turn failed");
  });
  try {
    await h.host.start(request());
    await until(() => rows(h).length >= 1, "the sub-agent started");
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_error"), "the failure");
    const failure = h.framesOf("agent:activity").filter((frame) => frame.detailKind === "runtime_error").at(-1)!;
    task.end("completed");
    await until(() => rows(h).length >= 2, "its end");
    const frame = h.framesOf("agent:activity").at(-1)!;
    assert.equal(frame.detailKind, failure.detailKind);
    assert.deepEqual((frame as { runtimeError?: unknown }).runtimeError, (failure as { runtimeError?: unknown }).runtimeError);
  } finally {
    await h.cleanup();
  }
});

test("Stop: what the runtime answers, and a task it isn't running", async () => {
  let task!: ScriptedTask;
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => { finish = resolve; });
  const h = await withTask(async (start) => {
    task = start({ taskType: "agent", background: true });
    await hold;
  });
  try {
    await h.host.start(request());
    await until(() => rows(h).length >= 1, "the sub-agent started");
    const agentId = request().agentId;

    assert.equal(await h.host.interruptSubagent(agentId, task.taskId), "unsupported", "a runtime with no stopTask: Grok, Qwen");

    const asked: string[] = [];
    stopTaskOn(h, async (taskId) => {
      asked.push(taskId);
      return { kind: "accepted" };
    });
    assert.equal(await h.host.interruptSubagent(agentId, "no-such-task"), "not_running", "not asked of the runtime: it may accept an unknown id");
    assert.deepEqual(asked, []);
    assert.equal(await h.host.interruptSubagent(agentId, task.taskId), "interrupted");
    assert.deepEqual(asked, [task.taskId]);
    assert.equal(rows(h).length, 1, "accepted ends nothing: the runtime's own end does");

    stopTaskOn(h, async () => ({ kind: "rejected", code: "no_active_turn" }));
    assert.equal(await h.host.interruptSubagent(agentId, task.taskId), "not_running");
    stopTaskOn(h, async () => ({ kind: "rejected", code: "unsupported" }));
    assert.equal(await h.host.interruptSubagent(agentId, task.taskId), "unsupported");
    stopTaskOn(h, async () => { throw new Error("timed out"); });
    await assert.rejects(h.host.interruptSubagent(agentId, task.taskId), /timed out/);

    task.end("stopped");
    await until(() => rows(h).length >= 2, "its end");
    assert.equal(rows(h).at(-1)!.outcome, "stopped");
    assert.equal(await h.host.interruptSubagent(agentId, task.taskId), "not_running", "already ended");
    finish();
    await sleep(5);
  } finally {
    finish();
    await h.cleanup();
  }
});

test("a sub-agent still running after the turn keeps the agent from idle until it ends", async () => {
  let endTask!: () => void;
  const h = await withTask((task) => {
    const sub = task({ taskType: "agent", description: "background look", background: true });
    endTask = () => sub.end("completed");
  });
  try {
    await h.host.start(request());
    await until(() => rows(h).length >= 1, "the started row");
    const agentId = request().agentId;
    await until(() => h.host.idleNoticeFacts(agentId)?.backgroundTasks === 1, "one background task after the turn");
    endTask();
    await until(() => h.host.idleNoticeFacts(agentId)?.backgroundTasks === 0, "none once it ends");
  } finally {
    await h.cleanup();
  }
});
