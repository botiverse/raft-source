import assert from "node:assert/strict";
import { residentCoreIdentity } from "./residentCoreIdentity";
import { BUNDLED_DAEMON_VERSION, COMPUTER_BUILD_SHA, COMPUTER_VERSION } from "./version";

test("residentCoreIdentity returns the exact managed DaemonCore identity", () => {
  assert.deepEqual(
    residentCoreIdentity({
      serverId: "server-a",
      serverMachineId: "machine-a",
      apiKey: "test-api-key",
      serverUrl: "https://example.invalid",
    }),
    {
      serverUrl: "https://example.invalid",
      apiKey: "test-api-key",
      machineOwnerProvenance: {
        kind: "managed_computer_runner",
        serverId: "server-a",
        serverMachineId: "machine-a",
      },
      daemonVersion: BUNDLED_DAEMON_VERSION,
      computerVersion: COMPUTER_VERSION,
      computerBuildSha: COMPUTER_BUILD_SHA,
    },
  );
});
