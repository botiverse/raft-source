// Glimpse G2-2: task writes tell the Server what the model's context has seen
// of the conversation their result lands in (the task's own, `#board:#7`;
// shared agentWriteLanding.ts), as a send does, and a held write is an
// interrupt the frontier books.
import assert from "node:assert/strict";
import { createRaft } from "./index";

const credential = "sk_agent_task_holds_sentinel";

type Call = { url: string; body: Record<string, unknown> | undefined };
function server(replies: unknown[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const next = replies.shift();
    if (next === undefined) throw new Error(`no reply for ${String(input)}`);
    return Response.json(next);
  };
  return { calls, fetch };
}

const held = (seenUpToSeq: number) => ({
  ok: true,
  state: "held",
  outcome: "held",
  subtype: "freshness",
  reason: "newer_messages_available",
  decision: "syncing_hold",
  producerFactId: "f",
  available_actions: ["check_messages", "retry_action"],
  heldMessages: [{ id: "00000042-0000-0000-0000-000000000000", seq: 42, sender_name: "sample-human", sender_type: "human", timestamp: "2026-10-17T09:00:00.000Z", content: "hold on, scope changed" }],
  newMessageCount: 1,
  shownMessageCount: 1,
  omittedMessageCount: 0,
  seenUpToSeq,
});
const claimed = { results: [{ taskNumber: 7, success: true }] };

test("a claim attests what the context has seen of the task's conversation", async () => {
  const { calls, fetch } = server([claimed]);
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  raft.frontier.setContext("ctx-1");
  raft.frontier.recordUpTo("#board:#7", 40);
  await raft.tasks.claim({ target: "#board", taskNumbers: [7] });
  assert.equal(calls[0]!.body!.seenUpToSeq, 40);
  assert.equal(calls[0]!.body!.seenFor, "task_conversation");
});

test("nothing seen of the conversation attests nothing, so the Server does not hold the write", async () => {
  const { calls, fetch } = server([claimed, { ok: true }, { ok: true, task: { taskNumber: 7 }, event: { seq: 1 } }]);
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  await raft.tasks.claim({ target: "#board", taskNumbers: [7] });
  await raft.tasks.updateStatus({ target: "#board", taskNumber: 7, status: "in_review" });
  for (const call of calls.slice(0, 2)) {
    assert.equal(Object.hasOwn(call.body!, "seenUpToSeq"), false, call.url);
    assert.equal(Object.hasOwn(call.body!, "seenExactSeqs"), false, call.url);
  }
});

test("a held claim is an interrupt: booked by recordHeld, and the identical rerun attests the shown messages", async () => {
  const { calls, fetch } = server([held(42), claimed]);
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  raft.frontier.setContext("ctx-1");
  raft.frontier.recordUpTo("#board:#7", 40);
  const outcome = await raft.tasks.claim({ target: "#board", taskNumbers: [7] });
  if (!outcome.ok || outcome.state !== "interrupted") return assert.fail("expected an interrupt");
  assert.equal(outcome.interrupt.reason, "unread_messages");
  assert.equal(outcome.interrupt.contextId, "ctx-1");
  assert.match(outcome.text, /hold on, scope changed/);
  assert.equal(raft.frontier.recordHeld(outcome.interrupt), true);
  await raft.tasks.claim({ target: "#board", taskNumbers: [7] });
  assert.equal(calls[1]!.body!.seenUpToSeq, 42);
});

test("updateStatus and amend attest too, and a hold applies nothing", async () => {
  const { calls, fetch } = server([held(42), held(42)]);
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  raft.frontier.recordUpTo("#board:#7", 40);
  const update = await raft.tasks.updateStatus({ target: "#board", taskNumber: 7, status: "in_review" });
  const amend = await raft.tasks.amend({ target: "#board", taskNumber: 7, title: "new title" });
  assert.equal(update.ok && update.state, "interrupted");
  assert.equal(amend.ok && amend.state, "interrupted");
  assert.equal(calls[0]!.body!.seenUpToSeq, 40);
  assert.equal(calls[1]!.body!.seenUpToSeq, 40);
});

test("invoke with a per-call context attests that context's view only, and recordHeld on the root books under it", async () => {
  const { calls, fetch } = server([held(42), claimed, claimed]);
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  raft.frontier.inContext("ctx-A").recordUpTo("#board:#7", 40);
  const outcome = await raft.invoke("tasks.claim", { target: "#board", taskNumbers: [7] }, { contextId: "ctx-A" });
  if (!outcome.ok || outcome.state !== "interrupted") return assert.fail("expected an interrupt");
  assert.equal(calls[0]!.body!.seenUpToSeq, 40);
  assert.equal(outcome.interrupt.contextId, "ctx-A");
  raft.frontier.recordHeld(outcome.interrupt);
  await raft.invoke("tasks.claim", { target: "#board", taskNumbers: [7] }, { contextId: "ctx-A" });
  assert.equal(calls[1]!.body!.seenUpToSeq, 42);
  await raft.invoke("tasks.claim", { target: "#board", taskNumbers: [7] }, { contextId: "ctx-B" });
  assert.equal(Object.hasOwn(calls[2]!.body!, "seenUpToSeq"), false, "another context has seen nothing");
});

test("a fresh client loads the saved state before a task write, so it attests what an earlier process saw", async () => {
  const saved = {
    schema: "raft-sdk-state.v1",
    version: 3,
    cursor: null,
    pendingCursor: null,
    frontier: { version: 1, targets: { "#ops:#7": { upTo: 41 } }, aliases: {} },
    continuations: [],
  };
  const state = { load: async () => saved as never, save: async () => {} };
  for (const write of ["claim", "updateStatus", "amend"] as const) {
    for (const via of ["method", "invoke"] as const) {
      const { calls, fetch } = server([write === "claim" ? claimed : { ok: true }]);
      const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch, state });
      const args = write === "claim"
        ? { target: "#ops", taskNumbers: [7] }
        : write === "updateStatus"
          ? { target: "#ops", taskNumber: 7, status: "in_progress" as const }
          : { target: "#ops", taskNumber: 7, title: "renamed" };
      if (via === "method") await (raft.tasks[write] as (a: unknown) => Promise<unknown>)(args);
      else await raft.invoke(`tasks.${write}`, args, { origin: "model" });
      assert.equal(calls[0]?.body?.seenUpToSeq, 41, `${write} via ${via} attests the saved frontier`);
    }
  }
});
