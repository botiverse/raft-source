import assert from "node:assert/strict";
import { DAEMON_CAPABILITY_INTERRUPT_SUBAGENT, DAEMON_CAPABILITY_INTERRUPT_TURN } from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator";

// #proj-runtime:#41: the server side of "stop this sub-agent", as for "stop this turn".

function harness(capabilities: string[] | null, reply?: Record<string, unknown>) {
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
        return { type: "agent:interrupt-subagent:result", agentId: request.agentId, requestId: request.requestId, ...reply };
      },
    }),
  };
}

const interrupt = (h: ReturnType<typeof harness>, machineId: string | null = "machine-1") =>
  AgentOrchestrator.prototype.interruptAgentSubagent.call(h as never, "agent-1", machineId, "thread-child");

test("#proj-runtime:#41: the request names the sub-agent; the daemon's answer comes back through the relay", async () => {
  const h = harness([DAEMON_CAPABILITY_INTERRUPT_SUBAGENT], { outcome: "interrupted" });
  assert.deepEqual(await interrupt(h), { outcome: "interrupted" });
  const relayed = h.relayed[0]!;
  assert.equal(relayed.request.type, "agent:interrupt-subagent:result");
  assert.equal(relayed.request.agentId, "agent-1");
  assert.deepEqual(h.sent, [{ type: "agent:interrupt-subagent", agentId: "agent-1", requestId: relayed.request.requestId, subagentTaskId: "thread-child" }]);
});

test("#proj-runtime:#41: a computer that can stop a turn but not a sub-agent, an offline one, and no computer: no request", async () => {
  const old = harness([DAEMON_CAPABILITY_INTERRUPT_TURN]);
  assert.deepEqual(await interrupt(old), { outcome: "computer_upgrade_required" });
  const offline = harness(null);
  assert.deepEqual(await interrupt(offline), { outcome: "computer_offline" });
  const none = harness([DAEMON_CAPABILITY_INTERRUPT_SUBAGENT]);
  assert.deepEqual(await interrupt(none, null), { outcome: "not_running" });
  assert.equal(old.sent.length + offline.sent.length + none.sent.length, 0);
});
