import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1,
  readyRunnerCredentialIds,
  type MachineToServerMessage,
} from "./index";

// #wg-rbac:#27: the `ready` frame's runner credential list. A server revokes
// this machine's credentials that are not listed, so anything short of a
// well-formed list under the capability must read as "no claim" (null),
// never as "holds none" ([]).
describe("readyRunnerCredentialIds", () => {
  const capabilities = ["agent:start", DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1];

  it("is a stable wire value", () => {
    assert.equal(DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1, "runner-credential-reconcile:v1");
  });

  it("the ready frame type carries the field", () => {
    const ready: MachineToServerMessage = { type: "ready", capabilities, runningAgents: [], runnerCredentialIds: ["cred-1"] };
    assert.deepEqual(ready.type === "ready" ? readyRunnerCredentialIds(ready) : null, ["cred-1"]);
  });

  it("reads the ids under the capability, deduplicated; an empty list means none held", () => {
    assert.deepEqual(readyRunnerCredentialIds({ capabilities, runnerCredentialIds: ["cred-1", "cred-2", "cred-1"] }), ["cred-1", "cred-2"]);
    assert.deepEqual(readyRunnerCredentialIds({ capabilities, runnerCredentialIds: [] }), []);
  });

  it("is no claim without the capability (older daemons), even with a list", () => {
    assert.equal(readyRunnerCredentialIds({ runnerCredentialIds: [] }), null);
    assert.equal(readyRunnerCredentialIds({ capabilities: ["agent:start"], runnerCredentialIds: ["cred-1"] }), null);
  });

  it("is no claim when the list is absent or malformed", () => {
    const malformed: unknown[] = [undefined, null, "cred-1", { 0: "cred-1" }, ["cred-1", 2], ["cred-1", ""], [null]];
    assert.equal(readyRunnerCredentialIds({ capabilities }), null);
    for (const runnerCredentialIds of malformed) {
      // The frame is JSON from the wire: its declared type is not a guarantee.
      const ready = { capabilities, runnerCredentialIds } as unknown as Parameters<typeof readyRunnerCredentialIds>[0];
      assert.equal(readyRunnerCredentialIds(ready), null, JSON.stringify(runnerCredentialIds));
    }
  });
});
