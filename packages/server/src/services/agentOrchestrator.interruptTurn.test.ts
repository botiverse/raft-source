import assert from "node:assert/strict";
import { DAEMON_CAPABILITY_INTERRUPT_TURN } from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator";

// task #25 step 2: the server side of "stop this turn". The capability comes
// from the cross-replica carrier fact; the answer through the response relay.

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
        return { type: "agent:interrupt-turn:result", agentId: request.agentId, requestId: request.requestId, ...reply };
      },
    }),
  };
}

const interrupt = (h: ReturnType<typeof harness>, machineId: string | null = "machine-1") =>
  AgentOrchestrator.prototype.interruptAgentTurn.call(h as never, "agent-1", machineId);

test("task #25 step 2: the request goes to the daemon and its answer comes back through the relay", async () => {
  const h = harness([DAEMON_CAPABILITY_INTERRUPT_TURN], { outcome: "restarted", toolName: "bash", stuckForMs: 660_000 });

  assert.deepEqual(await interrupt(h), { outcome: "restarted", toolName: "bash", stuckForMs: 660_000 });
  const relayed = h.relayed[0]!;
  assert.equal(relayed.request.type, "agent:interrupt-turn:result");
  assert.equal(relayed.request.agentId, "agent-1", "the relay matches the answer to this agent");
  assert.ok(relayed.timeoutMs > 10_000, "room for the daemon's 10 s native wait before its restart");
  assert.deepEqual(h.sent, [{ type: "agent:interrupt-turn", agentId: "agent-1", requestId: relayed.request.requestId }]);
});

test("task #25 step 2: an older computer, an offline one and an agent without a computer are told apart without a request", async () => {
  const old = harness(["agent:start", "agent:stop"]);
  assert.deepEqual(await interrupt(old), { outcome: "computer_upgrade_required" });
  const offline = harness(null);
  assert.deepEqual(await interrupt(offline), { outcome: "computer_offline" });
  const none = harness([DAEMON_CAPABILITY_INTERRUPT_TURN]);
  assert.deepEqual(await interrupt(none, null), { outcome: "not_running" });
  assert.equal(old.sent.length + offline.sent.length + none.sent.length, 0);
});
