import assert from "node:assert/strict";

import type { MachineToServerMessage } from "@botiverse/raft-shared";

import { AgentProcessManager } from "./agentProcessManager";

// Idle task reminder (#wg-task-v2:#9): the legacy host never asks about, or
// writes to, an agent it does not run: a stopped agent is not woken for it,
// locally or through the Server.
test("an agent with no process has no idle notice facts and is never woken for a notice", async () => {
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (message) => { sent.push(message); },
    "sk_machine_test",
    { serverUrl: "https://daemon.invalid" },
  );
  assert.equal(manager.idleNoticeFacts("agent-1"), null);
  assert.equal(await manager.deliverIdleNotice("agent-1", "[Raft task notice: 1 task is waiting on you.]"), "not_running");
  assert.deepEqual(sent, [], "no server wake, no frame of any kind");
  assert.deepEqual(manager.getRunningAgentIds(), [], "nothing was started");
});
