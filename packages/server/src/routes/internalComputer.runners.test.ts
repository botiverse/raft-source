import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { computers, users, agents, featureFlagRules, providerConnections } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, updateAgent } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService.js";
import {
  createProviderConnection,
  resolveProviderConnectionSelection,
} from "../services/providerConnectionService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

test("runners list: scope=server preserves legacy server-wide view", async ({ app }) => {
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
  assert.ok(
    body.runners.some((r) => r.agentId === f.sameServerOtherMachineAgentId),
    "server-wide scope should include same-server runners on other machines",
  );
  assert.ok(
    !body.runners.some((r) => r.agentId === f.otherServerAgentId),
    "server-wide scope must still be isolated to the Computer's bound server",
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

for (const operation of ["mint", "stop", "revoke"] as const) {
  test(`Computer cannot ${operation} another machine's runner`, async ({ app }) => {
    const f = await seedComputerWithAgent();
    const credential = await mintAgentCredential({ agentId: f.sameServerOtherMachineAgentId, scopes: ["read"], name: "audit-target", createdByUserId: null });
    const suffix = operation === "stop" ? "stop" : operation === "mint" ? "credentials" : `credentials/${credential.credentialId}`;
    const response = await fetch(`${app.baseUrl}/internal/computer/runners/${f.sameServerOtherMachineAgentId}/${suffix}`, {
      method: operation === "revoke" ? "DELETE" : "POST", headers: authHeaders(f.computerApiKey),
      ...(operation === "mint" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, 404, await response.text());
  });
}
