import assert from "node:assert/strict";
import { test } from "vitest";

import { sendAuthenticatedMachineContext } from "./machineContext.js";

test("authenticated machine context serializes the exact accepted owner identities", () => {
  const sent: string[] = [];
  sendAuthenticatedMachineContext({ send: (data) => sent.push(data) }, {
    machineId: "machine-1",
    serverId: "server-1",
  });
  assert.deepEqual(sent.map((data) => JSON.parse(data)), [{
    type: "machine:context",
    machineId: "machine-1",
    serverId: "server-1",
  }]);
});

test("machine context send failure is synchronous so the route can fail closed", () => {
  assert.throws(() => sendAuthenticatedMachineContext({
    send: () => { throw new Error("socket closed"); },
  }, {
    machineId: "machine-1",
    serverId: "server-1",
  }), /socket closed/);
});
