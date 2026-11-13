import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentCredentials,
  computers,
  users,
  agents,
  featureFlagRules,
  providerConnections,
  providerProbeIntents,
  providerProbeReceipts,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, updateAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { deleteMachine, registerMachine } from "../services/machineService";
import { mintAgentCredential, RUNNER_MACHINE_CHANGED_REVOKE_REASON, type AgentCredentialIssuance } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import {
  createProviderConnection,
  resolveProviderConnectionSelection,
} from "../services/providerConnectionService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #30 PR-C regression guard — GET /internal/computer/runners.
//
// The locked, sign-reviewed contract item is the §12 control-plane
// whitelist enforced SERVER-SIDE (defense-in-depth, NOT a client
// filter). The decisive test: seed an agent whose raw row carries
// recognizable SECRETS (sessionId, envVars), then prove that NO request
// to this endpoint — with a perfectly valid Computer credential — can
// ever surface them. A client-output-only check would false-green a
// future server dump bug; this asserts the server query itself.

const SECRET_SESSION = "session-RESUME-SECRET-do-not-leak-zzz";
const SECRET_ENV_VALUE = "ENVVAR-SECRET-do-not-leak-qqq";
const WHITELIST = ["agentId", "name", "status", "model", "runtime"];

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function seedComputerWithAgent(): Promise<{
  computerApiKey: string;
  agentApiKey: string;
  agentId: string;
  serverId: string;
  sameServerOtherMachineAgentId: string;
  otherServerAgentId: string;
  machineId: string;
  userId: string;
}> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db
    .insert(users)
    .values({
      email: `runners-${suffix}@slock.test`,
      name: `runners-${suffix}`,
      displayName: "Runners Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  const server = await createServer("Runners Test", `runners-${suffix}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "runners-machine");
  const { machine: otherMachine } = await registerMachine(server.id, owner.id, "other-machine");
  const agent = await createAgent(server.id, "RunnerBot", {
    runtime: "claude",
    model: "sonnet",
    machineId: machine.id,
  });
  const sameServerOtherMachineAgent = await createAgent(server.id, "OtherMachineBot", {
    runtime: "claude",
    model: "sonnet",
    machineId: otherMachine.id,
  });

  // Inject recognizable secrets into the raw agents row. They must NEVER
  // appear in the §12 whitelisted response.
  await db
    .update(agents)
    .set({ sessionId: SECRET_SESSION, envVars: { OPENAI_API_KEY: SECRET_ENV_VALUE } })
    .where(eq(agents.id, agent.id));

  // A DIFFERENT server's agent — must not appear (cross-server isolation).
  const otherServer = await createServer("Other Co", `other-${suffix}`, owner.id);
  const otherAgent = await createAgent(otherServer.id, "OtherBot", { runtime: "claude", model: "sonnet" });

  const computerMaterial = await generateComputerApiKeyMaterial();
  await db.insert(computers).values({
    serverId: server.id,
    name: "runners-computer",
    apiKeyHash: computerMaterial.apiKeyHash,
    apiKeyPrefix: computerMaterial.apiKeyPrefix,
    attachedByUserId: owner.id,
    machineId: machine.id,
  });
  const agentMinted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "runners-agent",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return {
    computerApiKey: computerMaterial.apiKey,
    agentApiKey: agentMinted.apiKey,
    agentId: agent.id,
    serverId: server.id,
    sameServerOtherMachineAgentId: sameServerOtherMachineAgent.id,
    otherServerAgentId: otherAgent.id,
    machineId: machine.id,
    userId: owner.id,
  };
}

test("provider materialization is Computer/Agent-bound and the ordinary launch config stays reference-only", async ({ app }) => {

  const previousKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const f = await seedComputerWithAgent();
    const connection = await createProviderConnection({
      serverId: f.serverId,
      userId: f.userId,
      name: "Runner DeepSeek",
      providerId: "deepseek",
      apiKey: "provider-materialization-secret",
    });
    await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, connection.id));
    const selection = await resolveProviderConnectionSelection(f.serverId, connection.id);
    await updateAgent(f.agentId, {
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: { kind: "connection", connectionId: connection.id },
        model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
        mode: { kind: "default" },
        hostUserState: "forbidden",
      },
      providerConnection: { ...selection, updatedByUserId: f.userId },
    });

    const gatedResponse = await fetch(
      `${app.baseUrl}/internal/computer/runners/${f.agentId}/provider-connection`,
      {
        method: "POST",
        headers: authHeaders(f.computerApiKey),
        body: JSON.stringify({ connectionId: connection.id }),
      },
    );
    assert.equal(gatedResponse.status, 404);
    assert.equal((await gatedResponse.json() as { code?: string }).code, "provider_connections_disabled");

    await getDb().insert(featureFlagRules).values({
      flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
      stage: "server",
      priority: -100,
      decision: "allow",
      values: [f.serverId],
    });

    // Launch materialization does not require a fresh Computer verification receipt;
    // an enabled connection with valid credentials materializes directly.
    const initialLaunch = await fetch(
      `${app.baseUrl}/internal/computer/runners/${f.agentId}/provider-connection`,
      {
        method: "POST",
        headers: authHeaders(f.computerApiKey),
        body: JSON.stringify({ connectionId: connection.id }),
      },
    );
    assert.equal(initialLaunch.status, 200);
    assert.deepEqual(await initialLaunch.json(), {
      envVars: { DEEPSEEK_API_KEY: "provider-materialization-secret" },
      providerConnection: {
        providerId: "deepseek",
        endpointUrl: null,
        supportsImageInput: false,
      },
    });

    const probeId = randomUUID();
    await getDb().insert(providerProbeIntents).values({
      id: probeId,
      serverId: f.serverId,
      connectionId: connection.id,
      configVersion: selection.configVersion,
      credentialVersion: selection.credentialVersion,
      computerId: f.machineId,
      runtime: "claude",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      probeRequestId: `probe-req-${probeId}`,
      requestDigest: `digest-${probeId}`,
      intentDigest: `intent-${probeId}`,
      expiresAt: new Date(Date.now() + 60_000),
      dispatchedAt: new Date(),
      closeReason: "receipt",
      closedAt: new Date(),
    });
    await getDb().insert(providerProbeReceipts).values({
      probeId,
      serverId: f.serverId,
      outcome: "success",
      latencyMs: 12,
      responseSha256: "a".repeat(64),
      responseBytes: 42,
      resultDigest: `result-${probeId}`,
      intentDigest: `intent-${probeId}`,
      authorityIdentity: "runners-test-authority",
    });

    const response = await fetch(
      `${app.baseUrl}/internal/computer/runners/${f.agentId}/provider-connection`,
      {
        method: "POST",
        headers: authHeaders(f.computerApiKey),
        body: JSON.stringify({ connectionId: connection.id }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      envVars: { DEEPSEEK_API_KEY: "provider-materialization-secret" },
      providerConnection: {
        providerId: "deepseek",
        endpointUrl: null,
        supportsImageInput: false,
      },
    });

    const otherMachine = await fetch(
      `${app.baseUrl}/internal/computer/runners/${f.sameServerOtherMachineAgentId}/provider-connection`,
      {
        method: "POST",
        headers: authHeaders(f.computerApiKey),
        body: JSON.stringify({ connectionId: connection.id }),
      },
    );
    assert.equal(otherMachine.status, 404);
    assert.equal((await otherMachine.json() as { code?: string }).code, "agent_missing");

    const alias = await fetch(
      `${app.baseUrl}/internal/computer/runners/${f.agentId}/provider-connection`,
      {
        method: "POST",
        headers: authHeaders(f.computerApiKey),
        body: JSON.stringify({ connectionId: connection.id, apiKey: "alias-must-fail" }),
      },
    );
    assert.equal(alias.status, 400);
  } finally {
    if (previousKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = previousKey;
    await app.close();
  }
});

test("runners list: default scope is this machine and §12 whitelist enforced server-side", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners`, {
    method: "GET",
    headers: authHeaders(f.computerApiKey),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  // Hard redline: the injected secrets cannot appear ANYWHERE in the
  // serialized payload, regardless of structure.
  assert.ok(!raw.includes(SECRET_SESSION), "response leaked sessionId");
  assert.ok(!raw.includes(SECRET_ENV_VALUE), "response leaked an envVars secret");

  const body = JSON.parse(raw) as {
    whitelist: string[];
    runners: Array<Record<string, unknown>>;
  };
  assert.deepEqual(body.whitelist, WHITELIST);

  const mine = body.runners.find((r) => r.agentId === f.agentId);
  assert.ok(mine, "the Computer's own server agent should be listed");
  // The runner object's keys are EXACTLY the whitelist — no extras.
  assert.deepEqual(Object.keys(mine).sort(), [...WHITELIST].sort());
  assert.equal(mine.name, "RunnerBot");

  // Default list is the precise Computer/machine view, not the old
  // server-wide projection.
  assert.ok(
    !body.runners.some((r) => r.agentId === f.sameServerOtherMachineAgentId),
    "same-server agent on another machine must not be listed by default",
  );

  // Cross-server isolation: another server's agent is not listed.
  assert.ok(
    !body.runners.some((r) => r.agentId === f.otherServerAgentId),
    "cross-server agent must not be listed",
  );
});

test("runners list: scope=server no longer widens past this machine", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners?scope=server`, {
    method: "GET",
    headers: authHeaders(f.computerApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    whitelist: string[];
    runners: Array<Record<string, unknown>>;
  };
  assert.deepEqual(body.whitelist, WHITELIST);
  assert.ok(body.runners.some((r) => r.agentId === f.agentId), "this machine's agent should remain listed");
  // A Computer key used to list every agent on the server with scope=server
  // (#proj-raft-computer:8e6a4629); `raft-computer runners list --all` still sends it.
  assert.ok(
    !body.runners.some((r) => r.agentId === f.sameServerOtherMachineAgentId),
    "scope=server must not list same-server runners on other machines",
  );
  assert.ok(
    !body.runners.some((r) => r.agentId === f.otherServerAgentId),
    "cross-server agent must not be listed",
  );
});

test("runners stop: same-server runner → 200; cross-server → uniform 404 agent_missing", async ({ app }) => {
  const f = await seedComputerWithAgent();

  const ok = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/stop`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: "{}",
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { agentId?: string }).agentId, f.agentId);

  // Another server's agent must NOT be stoppable by this Computer —
  // same 404 shape as a genuinely missing agent (no existence leak).
  const cross = await fetch(`${app.baseUrl}/internal/computer/runners/${f.otherServerAgentId}/stop`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: "{}",
  });
  assert.equal(cross.status, 404);
  assert.equal((await cross.json() as { code?: string }).code, "agent_missing");
});

test("runners stop: wrong principal (sk_agent_*) fail-closes upstream", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/stop`, {
    method: "POST",
    headers: authHeaders(f.agentApiKey),
    body: "{}",
  });
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 401 || res.status === 403);
});

test("runners list: wrong principal (sk_agent_*) fail-closes upstream (registry-enforced)", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners`, {
    method: "GET",
    headers: authHeaders(f.agentApiKey),
  });
  // The authFromRegistry dispatcher rejects a non-Computer principal
  // before the handler runs — same invariant the preflight test pins.
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 401 || res.status === 403);
});

test("runner credential mint records the Computer origin and the minting Machine, no person", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: JSON.stringify({ scopes: ["read"], name: `runner:claude:${f.agentId.slice(0, 8)}` }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { credentialId } = await res.json() as { credentialId: string };
  const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
  assert.equal(row?.issuedVia, "computer");
  assert.equal(row?.issuedByMachineId, f.machineId);
  assert.equal(row?.createdByUserId, null);
});

for (const operation of ["mint", "stop", "revoke"] as const) {
  test(`Computer cannot ${operation} another machine's runner`, async ({ app }) => {
    const f = await seedComputerWithAgent();
    const credential = await mintAgentCredential({ agentId: f.sameServerOtherMachineAgentId, scopes: ["read"], name: "audit-target", issuedVia: "computer", createdByUserId: null });
    const suffix = operation === "stop" ? "stop" : operation === "mint" ? "credentials" : `credentials/${credential.credentialId}`;
    const response = await fetch(`${app.baseUrl}/internal/computer/runners/${f.sameServerOtherMachineAgentId}/${suffix}`, {
      method: operation === "revoke" ? "DELETE" : "POST", headers: authHeaders(f.computerApiKey),
      ...(operation === "mint" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 404, await response.text());
  });
}

test("runner credential revoke: the Computer's own credential → 204 and revoked", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const own = await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "runner:own", issuedVia: "computer", issuedByMachineId: f.machineId, createdByUserId: null });
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials/${own.credentialId}`, {
    method: "DELETE", headers: authHeaders(f.computerApiKey),
  });
  assert.equal(res.status, 204, await res.text());
  const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, own.credentialId));
  assert.ok(row?.revokedAt);
  assert.equal(row?.revokedReason, "managed_runner_launch_ended");
});

// A Computer revokes only what it issued (#proj-raft-computer:8e6a4629); the
// agent's other credentials stay valid and the refusal has its own code.
for (const origin of ["human", "other_machine", "unattributed_computer", "provision"] as const) {
  test(`runner credential revoke: a ${origin} credential of its own agent → 403 credential_not_issued_by_this_computer`, async ({ app }) => {
    const f = await seedComputerWithAgent();
    const [other] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.sameServerOtherMachineAgentId));
    const issuer = origin === "human"
      ? { issuedVia: "human" as const, createdByUserId: f.userId }
      : origin === "provision"
        ? { issuedVia: "provision" as const, createdByUserId: null }
        : { issuedVia: "computer" as const, createdByUserId: null, issuedByMachineId: origin === "other_machine" ? other!.machineId : null };
    const target = await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "not-mine", ...issuer });
    const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials/${target.credentialId}`, {
      method: "DELETE", headers: authHeaders(f.computerApiKey),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { code?: string }).code, "credential_not_issued_by_this_computer");
    const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, target.credentialId));
    assert.equal(row?.revokedAt, null, "credential stays valid");
  });
}

// Deleting a Machine revokes the runner credentials it minted before
// ON DELETE SET NULL clears issued_by_machine_id (#proj-raft-computer:8e6a4629).
for (const agentState of ["deleted", "moved"] as const) {
  test(`deleting a Machine revokes its runner credentials (agent ${agentState})`, async ({ app }) => {
    const f = await seedComputerWithAgent();
    const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
      method: "POST",
      headers: authHeaders(f.computerApiKey),
      body: JSON.stringify({ scopes: ["read"], name: `runner:claude:${f.agentId.slice(0, 8)}` }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    const { credentialId, apiKey } = await res.json() as { credentialId: string; apiKey: string };
    const { machine: replacement } = await registerMachine(f.serverId, f.userId, "replacement-machine");
    const kept = await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "runner:replacement", issuedVia: "computer", issuedByMachineId: replacement.id, createdByUserId: null });
    await getDb().update(agents)
      .set(agentState === "deleted" ? { deletedAt: new Date(), machineId: null } : { machineId: replacement.id })
      .where(eq(agents.id, f.agentId));

    const { revokedCredentialAgentIds } = await deleteMachine(f.machineId);

    assert.deepEqual(revokedCredentialAgentIds, [f.agentId]);
    const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
    assert.ok(row?.revokedAt, "the deleted Machine's credential is revoked");
    assert.equal(row?.revokedReason, "machine_deleted");
    assert.equal(row?.issuedByMachineId, null);
    const probe = await fetch(`${app.baseUrl}/internal/agent-api/server`, { headers: authHeaders(apiKey) });
    assert.equal(probe.status, 401);
    const [other] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, kept.credentialId));
    assert.equal(other?.revokedAt, null, "another Machine's credential stays valid");
  });
}

// A runner credential is bound to the Machine that minted it: once its agent is
// elsewhere it is refused like an unknown key, whatever revoked it or not.
test("a runner credential authenticates only while its agent is on the Machine that minted it", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const minted = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: JSON.stringify({ scopes: ["read"], name: `runner:claude:${f.agentId.slice(0, 8)}` }),
  });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { apiKey: machineAKey } = await minted.json() as { apiKey: string };
  const { machine: machineB } = await registerMachine(f.serverId, f.userId, "machine-b");
  const machineBKey = (await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "runner:b", issuedVia: "computer", issuedByMachineId: machineB.id, createdByUserId: null })).apiKey;
  const unattributedKey = (await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "runner:legacy", issuedVia: "computer", createdByUserId: null })).apiKey;
  const probe = async (apiKey: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: authHeaders(apiKey) });
    return { status: res.status, body: await res.text() };
  };
  const invalid = await probe(`sk_agent_${"0".repeat(64)}`);
  assert.equal(invalid.status, 401);

  assert.equal((await probe(machineAKey)).status, 200, "on its minting Machine");

  // Moved without the move's revoke (a row a move left behind): auth alone refuses it.
  await getDb().update(agents).set({ machineId: machineB.id }).where(eq(agents.id, f.agentId));
  assert.deepEqual(await probe(machineAKey), invalid, "refused exactly like an invalid key");
  assert.equal((await probe(machineBKey)).status, 200, "the new Machine's key works");
  assert.equal((await probe(unattributedKey)).status, 200, "a computer key with no recorded Machine is not bound");

  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, f.agentId));
  assert.deepEqual(await probe(machineBKey), invalid, "on no Machine, no Machine's key works");
  assert.equal((await probe(unattributedKey)).status, 200);
});

test("a hosted agent's provision credential is not bound to any Machine", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const hosted = await createAgent(f.serverId, "HostedBot", { runtime: "external", model: "external" });
  const [row] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, hosted.id));
  assert.equal(row?.machineId, null, "a hosted agent is on no Machine");
  const { apiKey } = await mintAgentCredential({ agentId: hosted.id, scopes: ["read"], name: "Cloud runtime", issuedVia: "provision", createdByUserId: null, requireExternalRuntime: true });
  const res = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: authHeaders(apiKey) });
  assert.equal(res.status, 200, await res.text());
});

test("moving an agent revokes only the runner credentials other Machines minted", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const { machine: machineB } = await registerMachine(f.serverId, f.userId, "machine-b");
  const mint = (name: string, issuer: AgentCredentialIssuance) => mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name, ...issuer });
  const machineA = await mint("runner:a", { issuedVia: "computer", issuedByMachineId: f.machineId, createdByUserId: null });
  const machineBCred = await mint("runner:b", { issuedVia: "computer", issuedByMachineId: machineB.id, createdByUserId: null });
  const untouched = {
    human: await mint("human", { issuedVia: "human", createdByUserId: f.userId }),
    provision: await mint("provision", { issuedVia: "provision", createdByUserId: null }),
    app: await mint("app", { issuedVia: "app", createdByUserId: null }),
    unattributedComputer: await mint("runner:legacy", { issuedVia: "computer", createdByUserId: null }),
  };
  const revocation = async (credentialId: string) => {
    const [row] = await getDb().select({ revokedAt: agentCredentials.revokedAt, revokedReason: agentCredentials.revokedReason })
      .from(agentCredentials).where(eq(agentCredentials.id, credentialId));
    return row?.revokedAt ? row.revokedReason : null;
  };

  await placeAgentOnMachine(f.agentId, machineB.id);
  assert.equal(await revocation(machineA.credentialId), RUNNER_MACHINE_CHANGED_REVOKE_REASON);
  assert.equal(await revocation(machineBCred.credentialId), null, "the new Machine's key stays");
  const probe = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: authHeaders(machineBCred.apiKey) });
  assert.equal(probe.status, 200, await probe.text());

  await placeAgentOnMachine(f.agentId, null);
  assert.equal(await revocation(machineBCred.credentialId), RUNNER_MACHINE_CHANGED_REVOKE_REASON, "unbound: every Machine's key goes");
  for (const [origin, credential] of Object.entries(untouched)) {
    assert.equal(await revocation(credential.credentialId), null, `${origin} credential stays`);
  }
});

// Without the delete's revoke, ON DELETE SET NULL would turn the Machine's key
// into an unattributed computer key, which machine binding no longer refuses.
test("a deleted Machine's runner key is refused like an invalid key once SET NULL clears its issuer", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const minted = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: JSON.stringify({ scopes: ["read"], name: `runner:claude:${f.agentId.slice(0, 8)}` }),
  });
  assert.equal(minted.status, 201, await minted.clone().text());
  const { credentialId, apiKey } = await minted.json() as { credentialId: string; apiKey: string };
  const probe = async (key: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: authHeaders(key) });
    return { status: res.status, body: await res.text() };
  };
  const invalid = await probe(`sk_agent_${"0".repeat(64)}`);
  assert.equal(invalid.status, 401);

  // Off the Machine (delete refuses one with agents) without the move's own revoke.
  const { machine: replacement } = await registerMachine(f.serverId, f.userId, "replacement-machine");
  await getDb().update(agents).set({ machineId: replacement.id }).where(eq(agents.id, f.agentId));
  await deleteMachine(f.machineId);

  const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, credentialId));
  assert.equal(row?.issuedByMachineId, null, "SET NULL cleared the issuer");
  assert.deepEqual(await probe(apiKey), invalid, "refused exactly like an invalid key");
  assert.equal(row?.revokedReason, "machine_deleted");
});

// A Computer issues at most what the daemon asks for (#proj-raft-computer:8e6a4629).
const COMPUTER_MINTABLE = ["channels", "knowledge", "mcp", "mentions", "reactions", "read", "send", "server", "tasks"];

test("runner credential mint without scopes carries the Computer ceiling, never everything", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: "{}",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { scopes } = await res.json() as { scopes: string[] };
  assert.deepEqual([...scopes].sort(), COMPUTER_MINTABLE);
});

test("runner credential mint beyond the Computer ceiling → 403 scope_not_allowed_for_computer", async ({ app }) => {
  const f = await seedComputerWithAgent();
  const before = await getDb().select().from(agentCredentials).where(eq(agentCredentials.agentId, f.agentId));
  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${f.agentId}/credentials`, {
    method: "POST",
    headers: authHeaders(f.computerApiKey),
    body: JSON.stringify({ scopes: ["read", "raftbench"] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { code?: string }).code, "scope_not_allowed_for_computer");
  const after = await getDb().select().from(agentCredentials).where(eq(agentCredentials.agentId, f.agentId));
  assert.equal(after.length, before.length, "nothing was minted");
});
