import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { residentCoreIdentity } from "./residentCoreIdentity.js";
import { BUNDLED_DAEMON_VERSION, COMPUTER_VERSION } from "./version.js";

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
    },
  );
});

test("defaultCoreFactory passes residentCoreIdentity into DaemonCore", () => {
  const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  const start = source.indexOf("const defaultCoreFactory");
  assert.ok(start >= 0, "defaultCoreFactory source must exist");
  const end = source.indexOf("export async function runResident", start);
  const body = source.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /new coreMod\.DaemonCore\(\{\s*\.\.\.residentCoreIdentity\(creds\),/s);
});
