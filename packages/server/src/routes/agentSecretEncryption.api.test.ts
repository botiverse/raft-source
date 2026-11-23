import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentConfig } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { getAgent, getAgentsByIds, getAgentsForMachine, listAgents } from "../services/agentService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  AGENT_SECRET_KEY_ENV,
  AgentSecretDecryptionError,
  hasPlaintextAgentSecrets,
  isEncryptedAgentSecret,
  providerApiKeyField,
  sealAgentRuntimeConfig,
  sealAgentSecret,
} from "../services/agentSecretCrypto";
import {
  __resetReplicaAgentConfigSealModeCacheForTests,
  getReplicaAgentConfigSealModeSync,
  refreshReplicaAgentConfigSealMode,
} from "../services/agentSecretFlags";
import {
  AGENT_SECRET_ENCRYPTION_WRITE_FEATURE_FLAG_KEY,
  REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY,
  createFeatureFlag,
  updateFeatureFlag,
} from "../services/featureFlagService";

const test = createApiTest();
const TEST_KEY = Buffer.alloc(32, 0x5a).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 0x7b).toString("base64");

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[AGENT_SECRET_KEY_ENV];
  process.env[AGENT_SECRET_KEY_ENV] = TEST_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[AGENT_SECRET_KEY_ENV];
  else process.env[AGENT_SECRET_KEY_ENV] = savedKey;
});

class ConfigInspectOrchestrator extends AgentOrchestrator {
  async inspectBuildAgentConfig(agentId: string): Promise<AgentConfig> {
    const row = await getAgent(agentId);
    assert.ok(row, "agent row must exist");
    return this.buildAgentConfig(row);
  }
}

async function seedOwnerAndServer(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.test`,
    name: slug.replace(/-/g, "_"),
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer(`Server ${slug}`, slug, owner!.id);
  const token = await tokenForHuman(owner!.email);
  return {
    owner: owner!,
    server,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
  };
}

test("write encryption defaults OFF (rollback-safe) and seals at rest once agent_secret_encryption_write_v1 is enabled (#proj-runtime:#79)", async ({ app }) => {
  const db = getDb();
  const { headers } = await seedOwnerAndServer("enc-e2e");
  const apiKey = "sk-ant-customer-secret-xyz987654321";
  const envToken = "custom-db-token-abc123456";

  // 0. Flag OFF (PR 1 default): writes stay plaintext so older replicas / rollbacks can still read them,
  // while HTTP reads still redact provider.apiKey and mirrored env vars.
  const preFlagRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "pre-flag-claude",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey },
        model: { kind: "custom", name: "claude-opus-4-6" },
        envVars: { TEAM_SECRET: envToken },
      },
    }),
  });
  assert.equal(preFlagRes.status, 200, await preFlagRes.clone().text());
  const preFlag = await preFlagRes.json() as { id: string; runtimeConfig: { provider: { apiKey: string } }; envVars: Record<string, string> };
  assert.equal(preFlag.runtimeConfig.provider.apiKey, "", "provider.apiKey is redacted even before write flag flips on");
  assert.equal("ANTHROPIC_API_KEY" in preFlag.envVars, false);
  const [preFlagRow] = await db.select().from(agents).where(eq(agents.id, preFlag.id));
  assert.equal(hasPlaintextAgentSecrets(preFlagRow!), true, "flag OFF writes plaintext for rolling-deploy / rollback safety");

  // Enable global write-encryption flag in FFA
  await createFeatureFlag({
    key: AGENT_SECRET_ENCRYPTION_WRITE_FEATURE_FLAG_KEY,
    randomizationUnit: "server",
    enabled: true,
    defaultEnabled: true,
  });

  // 1. Create Claude custom agent with provider key + custom env var (now sealed on write)
  const createRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "encrypted-claude",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey },
        model: { kind: "custom", name: "claude-opus-4-6" },
        envVars: { TEAM_SECRET: envToken },
      },
    }),
  });
  assert.equal(createRes.status, 200, await createRes.clone().text());
  const createdText = await createRes.text();
  assert.equal(createdText.includes(apiKey), false, "POST response must not contain plaintext provider.apiKey");
  assert.equal(createdText.includes("env-aes-256-gcm"), false, "POST response must never contain ciphertext");
  const created = JSON.parse(createdText) as {
    id: string;
    runtimeConfig: { provider: { apiKey: string }; envVars: Record<string, string> };
    envVars: Record<string, string>;
  };
  assert.equal(created.runtimeConfig.provider.apiKey, "");
  assert.equal("ANTHROPIC_API_KEY" in created.envVars, false, "mirrored ANTHROPIC_API_KEY is redacted on read");
  assert.equal(created.runtimeConfig.envVars.TEAM_SECRET, envToken);

  // 2. Raw Postgres row stores ONLY ciphertext (0 plaintext)
  const [rawRow] = await db.select().from(agents).where(eq(agents.id, created.id));
  assert.ok(rawRow);
  assert.equal(hasPlaintextAgentSecrets(rawRow), false, "no plaintext secret in Postgres row");
  const rawJson = JSON.stringify({ runtimeConfig: rawRow.runtimeConfig, envVars: rawRow.envVars });
  assert.equal(rawJson.includes(apiKey), false, "plaintext apiKey must not appear in Postgres");
  assert.equal(rawJson.includes(envToken), false, "plaintext env var must not appear in Postgres");
  assert.equal(isEncryptedAgentSecret((rawRow.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey), true);
  assert.equal(isEncryptedAgentSecret(rawRow.envVars!.ANTHROPIC_API_KEY), true);
  assert.equal(isEncryptedAgentSecret(rawRow.envVars!.TEAM_SECRET), true);

  // 3. GET /api/agents and GET /api/agents/:id redact provider key and never leak ciphertext
  for (const url of [`${app.baseUrl}/api/agents`, `${app.baseUrl}/api/agents/${created.id}`]) {
    const res = await fetch(url, { headers });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.equal(bodyText.includes(apiKey), false, `${url} must not leak provider.apiKey`);
    assert.equal(bodyText.includes("env-aes-256-gcm"), false, `${url} must not leak ciphertext`);
  }

  // 4. buildAgentConfig decrypts plaintext for Computer dispatch
  const orchestrator = new ConfigInspectOrchestrator();
  try {
    const config = await orchestrator.inspectBuildAgentConfig(created.id);
    assert.equal((config.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, apiKey);
    assert.equal(config.envVars?.ANTHROPIC_API_KEY, apiKey);
    assert.equal(config.envVars?.TEAM_SECRET, envToken);
    assert.equal(JSON.stringify(config).includes("env-aes-256-gcm"), false);
  } finally {
    orchestrator.shutdown();
  }

  // 5. Legacy v1 PATCH with blank apiKey on the same URL preserves stored key
  const legacyBlankSameUrl = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey: "" },
        model: { kind: "custom", name: "claude-opus-4-6" },
        envVars: { TEAM_SECRET: envToken },
      },
    }),
  });
  assert.equal(legacyBlankSameUrl.status, 200, await legacyBlankSameUrl.clone().text());
  const storedAfterBlank = await getAgent(created.id);
  assert.equal((storedAfterBlank?.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, apiKey);

  // 6. Legacy v1 PATCH with blank apiKey on a DIFFERENT URL refuses (never leaks key to attacker endpoint)
  const legacyBlankMovedUrl = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://attacker.example.test/v1", apiKey: "" },
        model: { kind: "custom", name: "claude-opus-4-6" },
      },
    }),
  });
  assert.equal(legacyBlankMovedUrl.status, 400);

  // 7. Reserved encryption prefix in POST or PATCH input is rejected with 400
  const forged = sealAgentSecret("other-agent", providerApiKeyField(), "sk-stolen");
  const injectCreate = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "forged-prefix-agent",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey: forged },
        model: { kind: "custom", name: "claude-opus-4-6" },
      },
    }),
  });
  assert.equal(injectCreate.status, 400);

  const injectEnvPatch = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      envVars: { INJECTED: forged },
    }),
  });
  assert.equal(injectEnvPatch.status, 400);
});

test("one undecryptable agent row does not break listAgents, getAgentsByIds, getAgentsForMachine, or GET /api/agents; buildAgentConfig rejects only that agent (#proj-runtime:#79)", async ({ app }) => {
  const db = getDb();
  const { server, headers } = await seedOwnerAndServer("enc-isolate");
  await createFeatureFlag({
    key: AGENT_SECRET_ENCRYPTION_WRITE_FEATURE_FLAG_KEY,
    randomizationUnit: "server",
    enabled: true,
    defaultEnabled: true,
  });

  const createOne = async (name: string, apiKey: string) => {
    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey },
          model: { kind: "custom", name: "claude-opus-4-6" },
          envVars: { TEAM_SECRET: `tok-${name}` },
        },
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as { id: string };
  };

  const healthy = await createOne("healthy-agent", "sk-ant-healthy-key-111");
  const broken = await createOne("broken-agent", "sk-ant-broken-key-222");

  // Re-seal the broken agent's DB row under an unconfigured key (simulating a missing _PREVIOUS key during rotation)
  const otherEnv: NodeJS.ProcessEnv = { DEPLOYMENT_ENV: "production", [AGENT_SECRET_KEY_ENV]: OTHER_KEY };
  const brokenRc = sealAgentRuntimeConfig(broken.id, {
    version: 1 as const,
    runtime: "claude" as const,
    provider: { kind: "custom" as const, apiUrl: "https://gw.example.test/v1", apiKey: "sk-ant-unreadable-key" },
    model: { kind: "custom" as const, name: "claude-opus-4-6" },
    mode: { kind: "default" as const },
    reasoningEffort: null,
    envVars: { TEAM_SECRET: "tok-unreadable" },
  }, otherEnv);
  await db.update(agents).set({ runtimeConfig: brokenRc }).where(eq(agents.id, broken.id));

  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const orchestrator = new ConfigInspectOrchestrator();
  try {
    // 1. GET /api/agents succeeds (200) and returns both agents without leaking ciphertext or secret values
    const listRes = await fetch(`${app.baseUrl}/api/agents`, { headers });
    assert.equal(listRes.status, 200);
    const listText = await listRes.text();
    assert.equal(listText.includes("env-aes-256-gcm"), false, "list response must never leak ciphertext");
    assert.equal(listText.includes("sk-ant-unreadable-key"), false);
    const listJson = JSON.parse(listText) as Array<{ id: string; name: string }>;
    assert.deepEqual(listJson.map((a) => a.id).sort(), [broken.id, healthy.id].sort());

    // 2. Service batch readers return both rows without throwing
    const listed = await listAgents(server.id);
    assert.equal(listed.length, 2);
    const byIds = await getAgentsByIds([healthy.id, broken.id]);
    assert.equal(byIds.length, 2);
    const forMachine = await getAgentsForMachine("00000000-0000-0000-0000-000000000099");
    assert.equal(forMachine.length, 0);

    // 3. Error logs contain the broken agentId and field names, never any secret/ciphertext
    assert.ok(errSpy.mock.calls.length > 0);
    for (const call of errSpy.mock.calls) {
      const text = call.map(String).join(" ");
      assert.equal(text.includes("env-aes-256-gcm"), false);
      assert.equal(text.includes("sk-ant-unreadable-key"), false);
    }

    // 4. buildAgentConfig succeeds for the healthy agent and rejects ONLY the broken agent
    const healthyCfg = await orchestrator.inspectBuildAgentConfig(healthy.id);
    assert.equal((healthyCfg.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, "sk-ant-healthy-key-111");
    await assert.rejects(
      () => orchestrator.inspectBuildAgentConfig(broken.id),
      AgentSecretDecryptionError,
    );
  } finally {
    orchestrator.shutdown();
    errSpy.mockRestore();
  }
});

test("replica_seal_agent_config_v1 FFA flag controls receive_only -> seal -> strict transitions (#proj-runtime:#79)", async ({ app: _app }) => {
  __resetReplicaAgentConfigSealModeCacheForTests();
  try {
    // Sync read before first refresh is always receive_only
    assert.equal(getReplicaAgentConfigSealModeSync(), "receive_only");
    assert.equal(await refreshReplicaAgentConfigSealMode(), "receive_only");
    assert.equal(getReplicaAgentConfigSealModeSync(), "receive_only");

    await createFeatureFlag({
      key: REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY,
      randomizationUnit: "server",
      enabled: true,
      defaultEnabled: true,
    });
    assert.equal(await refreshReplicaAgentConfigSealMode(), "seal");
    assert.equal(getReplicaAgentConfigSealModeSync(), "seal");

    await updateFeatureFlag(REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY, { defaultVariant: "strict" });
    assert.equal(await refreshReplicaAgentConfigSealMode(), "strict");
    assert.equal(getReplicaAgentConfigSealModeSync(), "strict");

    await updateFeatureFlag(REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY, { killSwitch: true });
    assert.equal(await refreshReplicaAgentConfigSealMode(), "receive_only");
    assert.equal(getReplicaAgentConfigSealModeSync(), "receive_only");
  } finally {
    __resetReplicaAgentConfigSealModeCacheForTests();
  }
});
