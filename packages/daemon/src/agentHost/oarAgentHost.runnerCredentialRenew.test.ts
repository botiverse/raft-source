// #wg-rbac:#27 on the OAR host: a launch whose runner credential was renewed
// is reported by its current id and, when it ends, revokes the credential it
// was renewed into, not only the one its config names.
import assert from "node:assert/strict";
import type { AgentConfig } from "@botiverse/raft-shared";
import {
  __resetRunnerCredentialRenewalForTest,
  heldRunnerCredentialIdsWithRenewals,
  installRunnerCredentialRenewer,
  renewExpiredRunnerCredential,
  trackRunnerCredential,
} from "../runnerCredentialRenewal";
import { harness, makeConfig, request, until } from "../testing/oarAgentHostHarness";

const expiresAt = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

// As the legacy host's buildSpawnConfig, which the OAR host launches with: mint, and track an expiring key.
const mintExpiring = async (agentId: string, config: AgentConfig): Promise<AgentConfig> => {
  const credential = { apiKey: "sk_agent_oar_first", credentialId: "cred-first", expiresAt: expiresAt() };
  trackRunnerCredential({ agentId, runtime: config.runtime, credential });
  return { ...config, agentCredentialKey: credential.apiKey, agentCredentialId: credential.credentialId, agentCredentialExpiresAt: credential.expiresAt };
};

afterEach(() => {
  __resetRunnerCredentialRenewalForTest();
});

// Teeth: revoke only config.agentCredentialId in revokeManagedRunnerCredential -> RED.
test("OAR host: a renewed launch is held by its current id, and its stop revokes the renewed credential", async () => {
  const uninstall = installRunnerCredentialRenewer({
    serverUrl: "http://localhost:3001",
    computerKey: () => "sk_machine_test",
    fetch: async () => new Response(JSON.stringify({
      credentialId: "cred-renewed",
      apiKey: "sk_agent_oar_renewed",
      expiresAt: expiresAt(),
      scopes: ["read"],
      agentId: "agent-1",
      replacedCredentialId: "cred-first",
      replacedExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    }), { status: 201, headers: { "content-type": "application/json" } }),
    freshMint: async () => { throw new Error("not expected"); },
    revoke: () => { throw new Error("not expected: nothing to revoke"); },
    isHeld: () => true,
    recordEvent: () => {},
  });
  const h = await harness({ deps: { buildSpawnConfig: mintExpiring } });
  try {
    assert.deepEqual(await h.host.start(request({ config: makeConfig() })), { kind: "started" });
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.deepEqual(h.host.getHeldRunnerCredentialIds(), ["cred-first"]);

    assert.equal(await renewExpiredRunnerCredential("sk_agent_oar_first"), "sk_agent_oar_renewed");
    assert.deepEqual(heldRunnerCredentialIdsWithRenewals(h.host.getHeldRunnerCredentialIds()).sort(), ["cred-first", "cred-renewed"]);

    await h.host.stopAgent("agent-1");
    await until(() => h.revokes.length >= 2, "credentials revoked at release");
    assert.deepEqual(h.revokes.map((url) => new URL(url).pathname.split("/").at(-1)), ["cred-renewed", "cred-first"]);
  } finally {
    await h.cleanup();
    uninstall();
  }
});
