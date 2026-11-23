// #wg-rbac:#27 on the legacy host: a launch's runner credential minted with an
// expiry is stored with it and renewed; the launch's end revokes the
// credential it was renewed into, not only the one its config names.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentProcessManager } from "./agentProcessManager";
import { installDaemonFetchMockForTests } from "./daemonFetch";
import {
  __resetRunnerCredentialRenewalForTest,
  currentRunnerCredentialKey,
  expiringRunnerCredentialCount,
  heldRunnerCredentialIdsWithRenewals,
  installRunnerCredentialRenewer,
  renewExpiredRunnerCredential,
} from "./runnerCredentialRenewal";
import { promptConfig } from "./testing/promptFixture";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

const SERVER = "https://renew-legacy.example.com";
const AGENT = "agent-legacy";

// Teeth: drop trackRunnerCredential from ensureManagedRunnerCredential -> the
// renewal finds no credential -> RED.
test("legacy host: a minted expiring credential is tracked, renewed, and its launch end revokes the renewed one", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-apm-renew-"));
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === SERVER && init?.method === "POST" && url.pathname === `/internal/computer/runners/${AGENT}/credentials`) {
      return new Response(JSON.stringify({ apiKey: "sk_agent_legacy_first", credentialId: "cred-first", expiresAt }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch);
  const deletes: string[] = [];
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir,
    serverUrl: SERVER,
    fetchImpl: async (url, init) => {
      deletes.push(`${init?.method} ${new URL(url).pathname}`);
      return new Response(null, { status: 204 });
    },
  });
  const uninstall = installRunnerCredentialRenewer({
    serverUrl: SERVER,
    computerKey: () => "sk_machine_test",
    fetch: async () => new Response(JSON.stringify({
      credentialId: "cred-renewed",
      apiKey: "sk_agent_legacy_renewed",
      expiresAt,
      scopes: ["read"],
      agentId: AGENT,
      replacedCredentialId: "cred-first",
      replacedExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    }), { status: 201, headers: { "content-type": "application/json" } }),
    freshMint: async () => { throw new Error("not expected"); },
    revoke: () => { throw new Error("not expected: nothing to revoke"); },
    isHeld: () => true,
    recordEvent: () => {},
  });
  try {
    const spawnConfig = await manager.buildSpawnConfig(AGENT, promptConfig({ serverUrl: SERVER, agentCredentialKey: null, agentCredentialId: null }));
    assert.equal(spawnConfig.agentCredentialKey, "sk_agent_legacy_first");
    assert.equal(spawnConfig.agentCredentialId, "cred-first");
    assert.equal(spawnConfig.agentCredentialExpiresAt, expiresAt, "the expiry is stored with the credential");
    assert.equal(expiringRunnerCredentialCount(), 1);

    assert.equal(await renewExpiredRunnerCredential("sk_agent_legacy_first"), "sk_agent_legacy_renewed");
    assert.equal(currentRunnerCredentialKey(spawnConfig.agentCredentialKey!), "sk_agent_legacy_renewed");
    assert.deepEqual(heldRunnerCredentialIdsWithRenewals(["cred-first"]).sort(), ["cred-first", "cred-renewed"]);

    // The start ended with no process holding it: the host revokes its credential.
    manager.releaseUnheldRunnerCredential(AGENT, spawnConfig, null);
    assert.deepEqual(deletes, [
      `DELETE /internal/computer/runners/${AGENT}/credentials/cred-renewed`,
      `DELETE /internal/computer/runners/${AGENT}/credentials/cred-first`,
    ]);
    assert.equal(expiringRunnerCredentialCount(), 0);
  } finally {
    uninstall();
    __resetRunnerCredentialRenewalForTest();
    await drainAgentManagerForTests(manager);
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
});
