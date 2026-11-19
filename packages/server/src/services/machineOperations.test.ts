import assert from "node:assert/strict";
import { test } from "vitest";
import { asServerId } from "@botiverse/raft-shared";
import { readMachineOperation, resetMachineOperationsForTests, startMachineOperation } from "./machineOperations";

// Tenny on #14843: an operation is read only by the person who started it,
// on its original Server and through the surface that started it.
test("an operation is read by its person on its Server through its own surface only", async () => {
  resetMachineOperationsForTests();
  const serverId = asServerId("00000000-0000-4000-8000-00000000000a");
  const web = { userId: "u1", serverId, surface: "web" };
  const voice = { userId: "u1", serverId, surface: "voice:app-1" };
  const id = await startMachineOperation(voice, async () => ({ status: 200, body: { outcome: "answered" } }), { status: 500, body: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await readMachineOperation(voice, id), { state: "done", status: 200, body: { outcome: "answered" } });
  assert.deepEqual(await readMachineOperation({ ...voice, serverId: asServerId(serverId.toUpperCase()) }, id), { state: "done", status: 200, body: { outcome: "answered" } }, "UUID spelling does not change the Server");
  assert.equal(await readMachineOperation(web, id), null, "the same person on the web");
  assert.equal(await readMachineOperation({ ...voice, surface: "voice:app-2" }, id), null, "another App of the same person");
  assert.equal(await readMachineOperation({ ...voice, userId: "u2" }, id), null, "another person through the same App");
  assert.equal(await readMachineOperation({ ...voice, serverId: asServerId("00000000-0000-4000-8000-000000000002") }, id), null, "the same person and App through another Server");
});
