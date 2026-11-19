import assert from "node:assert/strict";
import {
  AGENT_SIDE_ASK_ANSWER_MAX_CHARS,
  AGENT_SIDE_ASK_MAX_TIMEOUT_MS,
  DAEMON_CAPABILITY_AGENT_SIDE_ASK,
  DAEMON_CAPABILITY_INTERRUPT_TURN,
} from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator";
import { RouteFailureError } from "../tracing/routeFailure";

// #wg-runtime-form:#22 (Raft voice): the server side of a status or side
// question, through the same carrier fact and relay as "stop this turn".

function harness(capabilities: string[] | null, reply: Record<string, unknown> | Error = { outcome: "answered", text: "ok" }) {
  const sent: unknown[] = [];
  const relayed: Array<{ request: Record<string, unknown>; timeoutMs: number }> = [];
  return {
    sent,
    relayed,
    readProbeCarrierFact: async () => (capabilities ? { capabilities } : null),
    sendRequiredToMachine: async (_machineId: string, message: unknown) => {
      sent.push(message);
    },
    recordMachineResponseRelay: () => {},
    getMachineResponseRelay: () => ({
      request: async (request: Record<string, unknown>, timeoutMs: number, send: () => Promise<unknown>) => {
        relayed.push({ request, timeoutMs });
        await send();
        if (reply instanceof Error) throw reply;
        return { type: "agent:side-ask:result", agentId: request.agentId, requestId: request.requestId, ...reply };
      },
    }),
  };
}

const asker = { displayName: "Ada", role: "member" as const, isAgentOwner: true };
const sideAsk = (h: ReturnType<typeof harness>, ask: Parameters<AgentOrchestrator["sideAskAgent"]>[2], machineId: string | null = "machine-1") =>
  AgentOrchestrator.prototype.sideAskAgent.call(h as never, "agent-1", machineId, ask);

test("a question goes to the Computer with the asker and the daemon's longest wait; the relay waits a little longer", async () => {
  const h = harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK], { outcome: "answered", text: "Green." });
  assert.deepEqual(await sideAsk(h, { kind: "question", question: "Deploy?", asker }), { outcome: "answered", text: "Green." });
  const relayed = h.relayed[0]!;
  assert.equal(relayed.request.type, "agent:side-ask:result");
  assert.equal(relayed.request.agentId, "agent-1");
  assert.ok(relayed.timeoutMs > AGENT_SIDE_ASK_MAX_TIMEOUT_MS);
  assert.deepEqual(h.sent, [{
    type: "agent:side-ask", agentId: "agent-1", requestId: relayed.request.requestId,
    timeoutMs: AGENT_SIDE_ASK_MAX_TIMEOUT_MS, kind: "question", question: "Deploy?", asker,
  }]);
});

test("a status asks for no model call and waits briefly; an over-long answer is cut to the contract's length", async () => {
  const h = harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK], { outcome: "answered", text: "x".repeat(AGENT_SIDE_ASK_ANSWER_MAX_CHARS + 50) });
  const result = await sideAsk(h, { kind: "status" });
  assert.equal(result.text?.length, AGENT_SIDE_ASK_ANSWER_MAX_CHARS);
  const sent = h.sent[0] as Record<string, unknown>;
  assert.equal(sent.kind, "status");
  assert.ok((sent.timeoutMs as number) < AGENT_SIDE_ASK_MAX_TIMEOUT_MS);
  assert.equal("question" in sent || "asker" in sent, false);
});

test("an older Computer, an offline one, or no Computer: no request", async () => {
  const old = harness([DAEMON_CAPABILITY_INTERRUPT_TURN]);
  assert.deepEqual(await sideAsk(old, { kind: "status" }), { outcome: "computer_upgrade_required" });
  const offline = harness(null);
  assert.deepEqual(await sideAsk(offline, { kind: "status" }), { outcome: "computer_offline" });
  const none = harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK]);
  assert.deepEqual(await sideAsk(none, { kind: "status" }, null), { outcome: "agent_not_running" });
  assert.equal(old.sent.length + offline.sent.length + none.sent.length, 0);
});

test("no answer in time, or the reply transport gone, is an outcome; anything else still fails", async () => {
  assert.deepEqual(await sideAsk(harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK], new RouteFailureError("daemon_timeout", "late")), { kind: "status" }), { outcome: "timed_out" });
  assert.deepEqual(await sideAsk(harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK], new RouteFailureError("daemon_offline", "gone")), { kind: "status" }), { outcome: "computer_offline" });
  await assert.rejects(sideAsk(harness([DAEMON_CAPABILITY_AGENT_SIDE_ASK], new Error("boom")), { kind: "status" }), /boom/);
});
