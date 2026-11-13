// #wg-ax:#15: an agent's search or read is stored as a request record and read
// back when the Computer's result arrives. Kept as what it is, or its result is
// rechecked as a person's view and refused.
import assert from "node:assert/strict";
import { asAgentContextViewRequestId, asMachineId } from "@botiverse/raft-shared";
import { createAgentContextViewRequest, getAgentContextViewRequest, type AgentContextViewRequestRecord } from "./replicaRouter";

function record(id: string, extra: Partial<AgentContextViewRequestRecord> = {}): AgentContextViewRequestRecord {
  return {
    requestId: asAgentContextViewRequestId(id)!,
    viewerUserId: "agent-1",
    agentId: "agent-1",
    serverId: "server-1",
    messageId: "message-1",
    machineId: asMachineId("machine-1"),
    viewerReplicaId: "replica-a",
    viewerEndpoint: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    ...extra,
  };
}

test("an agent's query record reads back as an agent's query", async () => {
  const stored = record("ctxv_aaaaaaaaaaaaaaaa1", { viewerKind: "agent", mode: "query" });
  await createAgentContextViewRequest(stored, 60_000);
  const read = await getAgentContextViewRequest(stored.requestId);
  assert.deepEqual(read?.record, stored);
});

test("a person's view record reads back without the agent fields", async () => {
  const stored = record("ctxv_aaaaaaaaaaaaaaaa2", { viewerUserId: "user-1" });
  await createAgentContextViewRequest(stored, 60_000);
  const read = await getAgentContextViewRequest(stored.requestId);
  assert.deepEqual(read?.record, stored);
  assert.equal("viewerKind" in (read?.record ?? {}), false);
});

test("a viewer kind or mode this replica doesn't know makes the record unknown", async () => {
  const odd = { ...record("ctxv_aaaaaaaaaaaaaaaa3"), viewerKind: "worker" } as unknown as AgentContextViewRequestRecord;
  await createAgentContextViewRequest(odd, 60_000);
  assert.equal(await getAgentContextViewRequest(odd.requestId), null);
  const oddMode = { ...record("ctxv_aaaaaaaaaaaaaaaa4"), mode: "dump" } as unknown as AgentContextViewRequestRecord;
  await createAgentContextViewRequest(oddMode, 60_000);
  assert.equal(await getAgentContextViewRequest(oddMode.requestId), null);
});

test("a record with only one of the agent fields is unknown", async () => {
  const kindOnly = record("ctxv_aaaaaaaaaaaaaaaa6", { viewerKind: "agent" });
  await createAgentContextViewRequest(kindOnly, 60_000);
  assert.equal(await getAgentContextViewRequest(kindOnly.requestId), null);
  const modeOnly = record("ctxv_aaaaaaaaaaaaaaaa7", { mode: "query" });
  await createAgentContextViewRequest(modeOnly, 60_000);
  assert.equal(await getAgentContextViewRequest(modeOnly.requestId), null);
});
