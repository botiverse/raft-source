import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { integrationAuditEvents, providerConnectionCredentials, providerConnections, users } from "../db/schema.js";
import { createAgent, updateAgent } from "./agentService.js";
import { createServer } from "./serverService.js";
import {
  __setProviderConnectionFetchFactoryForTests,
  createProviderConnection,
  assertProviderConnectionModelCompatible,
  listProviderConnectionModels,
  listProviderConnections,
  ProviderConnectionError,
  rotateProviderConnectionCredential,
  resolveProviderConnectionLaunch,
  resolveProviderConnectionLaunchEnv,
  resolveProviderConnectionSelection,
  testProviderConnection,
  updateProviderConnection,
} from "./providerConnectionService.js";


const ORIGINAL_KEY = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  __setProviderConnectionFetchFactoryForTests(null);
  await closeTestDatabase();
  if (ORIGINAL_KEY === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = ORIGINAL_KEY;
});

async function seed() {
  const [user] = await getDb().insert(users).values({
    email: `provider-${randomUUID()}@raft.test`,
    name: `provider-${randomUUID().slice(0, 8)}`,
    displayName: "Provider Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Provider Test", `provider-${randomUUID()}`, user.id);
  return { user, server };
}

async function markReady(connectionId: string) {
  await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, connectionId));
}

test("provider catalog is secret-free and launch resolves the exact assignment", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Team DeepSeek",
    providerId: "deepseek",
    apiKey: "deepseek-private-value",
  });
  assert.equal(created.hasCredential, true);
  assert.equal(created.status, "unchecked");
  assert.equal(JSON.stringify(created).includes("deepseek-private-value"), false);

  const [stored] = await getDb().select().from(providerConnectionCredentials).where(eq(
    providerConnectionCredentials.connectionId,
    created.id,
  ));
  assert.equal(stored.encryptedApiKey.includes("deepseek-private-value"), false);
  const [createdAudit] = await getDb().select({
    eventType: integrationAuditEvents.eventType,
    actorId: integrationAuditEvents.actorId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, created.id));
  assert.deepEqual(createdAudit, {
    eventType: "provider_connection.created",
    actorId: user.id,
    metadata: {
      providerId: "deepseek",
      configVersion: 1,
      credentialVersion: 1,
      status: "unchecked",
    },
  });
  assert.equal(JSON.stringify(createdAudit).includes("deepseek-private-value"), false);

  await assert.rejects(
    () => resolveProviderConnectionSelection(server.id, created.id),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );
  await markReady(created.id);
  const selected = await resolveProviderConnectionSelection(server.id, created.id);
  assertProviderConnectionModelCompatible(selected.providerId, { kind: "preset", id: "deepseek/deepseek-v4-pro" });
  assert.throws(
    () => assertProviderConnectionModelCompatible(selected.providerId, { kind: "custom", name: "wrong-shape" }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, {
    creatorType: "user",
    creatorId: user.id,
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: created.id },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: { ...selected, updatedByUserId: user.id },
  });
  assert.deepEqual(await resolveProviderConnectionLaunchEnv({
    serverId: server.id,
    agentId: agent.id,
    connectionId: created.id,
  }), { DEEPSEEK_API_KEY: "deepseek-private-value" });
  assert.deepEqual(await resolveProviderConnectionLaunch({
    serverId: server.id,
    agentId: agent.id,
    connectionId: created.id,
  }), {
    envVars: { DEEPSEEK_API_KEY: "deepseek-private-value" },
    providerConnection: {
      providerId: "deepseek",
      endpointUrl: null,
      supportsImageInput: false,
    },
  });

  const catalog = await listProviderConnections(server.id);
  assert.equal(catalog[0]?.assignedAgentCount, 1);
  assert.equal(JSON.stringify(catalog).includes("deepseek-private-value"), false);
});

test("credential rotation advances assignment versions and disabled connections fail closed", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Gateway",
    providerId: "openai-compatible",
    endpointUrl: "https://gateway.example.test/v1",
    apiKey: "old-private-value",
  });
  await markReady(created.id);
  const selected = await resolveProviderConnectionSelection(server.id, created.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, {
    creatorType: "user",
    creatorId: user.id,
    runtime: "builtin",
    model: "custom-model",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: created.id },
      model: { kind: "custom", name: "custom-model" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: { ...selected, updatedByUserId: user.id },
  });

  const rotated = await rotateProviderConnectionCredential({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
    apiKey: "new-private-value",
  });
  assert.equal(rotated.status, "unchecked");
  assert.equal(rotated.credentialVersion, 2);
  await assert.rejects(
    () => resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: created.id }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );
  await markReady(created.id);
  assert.deepEqual(await resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: created.id }), {
    OPENAI_API_KEY: "new-private-value",
    OPENAI_BASE_URL: "https://gateway.example.test/v1",
  });

  await updateProviderConnection({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
    enabled: false,
  });
  await assert.rejects(
    () => resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: created.id }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );
});

test("editing an Agent replaces or removes its provider assignment atomically", async () => {
  const { user, server } = await seed();
  const first = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "First DeepSeek",
    providerId: "deepseek",
    apiKey: "first-private-value",
  });
  const second = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Second DeepSeek",
    providerId: "deepseek",
    apiKey: "second-private-value",
  });
  await markReady(first.id);
  await markReady(second.id);
  const firstSelection = await resolveProviderConnectionSelection(server.id, first.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, {
    runtime: "builtin",
    model: "deepseek/deepseek-v4-pro",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: first.id },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: { ...firstSelection, updatedByUserId: user.id },
  });

  const secondSelection = await resolveProviderConnectionSelection(server.id, second.id);
  await updateAgent(agent.id, {
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: second.id },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: { ...secondSelection, updatedByUserId: user.id },
  });
  await assert.rejects(
    () => resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: first.id }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );
  assert.deepEqual(
    await resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: second.id }),
    { DEEPSEEK_API_KEY: "second-private-value" },
  );

  await updateAgent(agent.id, {
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "deepseek", apiKey: "inline-private-value" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: null,
  });
  await assert.rejects(
    () => resolveProviderConnectionLaunchEnv({ serverId: server.id, agentId: agent.id, connectionId: second.id }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );
});

test("a successful connection check is the only transition from unchecked to ready", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Checked DeepSeek",
    providerId: "deepseek",
    apiKey: "checked-private-value",
  });
  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async (input, init) => {
      assert.equal(String(input), "https://api.deepseek.com/chat/completions");
      assert.equal(init?.method, "POST");
      assert.deepEqual(init?.headers, {
        "content-type": "application/json",
        Authorization: "Bearer checked-private-value",
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "deepseek-v4-pro",
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
    close: async () => undefined,
  }));
  const checked = await testProviderConnection({ serverId: server.id, userId: user.id, connectionId: created.id });
  assert.equal(checked.status, "ready");
  assert.ok(checked.lastCheckedAt);
  assert.equal(JSON.stringify(checked).includes("checked-private-value"), false);

  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async () => new Response("provider detail must not pass through", { status: 401 })) as typeof globalThis.fetch,
    close: async () => undefined,
  }));
  await assert.rejects(
    () => testProviderConnection({ serverId: server.id, userId: user.id, connectionId: created.id }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_test_failed",
  );
  const failed = (await listProviderConnections(server.id)).find((connection) => connection.id === created.id);
  assert.equal(failed?.status, "error");
  assert.equal(JSON.stringify(failed).includes("provider detail"), false);
  const testAudits = await getDb().select({
    outcome: integrationAuditEvents.outcome,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.targetId, created.id),
    eq(integrationAuditEvents.eventType, "provider_connection.tested"),
  ));
  assert.deepEqual(testAudits.map((audit) => audit.outcome).sort(), ["failure", "success"]);
  assert.equal(JSON.stringify(testAudits).includes("checked-private-value"), false);
  assert.equal(JSON.stringify(testAudits).includes("provider detail"), false);
});

test("a stale connection check cannot mark a rotated credential ready", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Rotating DeepSeek",
    providerId: "deepseek",
    apiKey: "old-private-value",
  });
  let finishFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    __setProviderConnectionFetchFactoryForTests(() => ({
      fetch: (async () => {
        resolve();
        await new Promise<void>((finish) => { finishFetch = finish; });
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch,
      close: async () => undefined,
    }));
  });

  const staleTest = testProviderConnection({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
  });
  await fetchStarted;
  await rotateProviderConnectionCredential({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
    apiKey: "new-private-value",
  });
  finishFetch();
  await assert.rejects(
    () => staleTest,
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_unavailable",
  );

  const [connection] = await listProviderConnections(server.id);
  assert.equal(connection.status, "unchecked");
  assert.equal(connection.credentialVersion, 2);
  const testAudits = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.targetId, created.id),
    eq(integrationAuditEvents.eventType, "provider_connection.tested"),
  ));
  assert.equal(testAudits.length, 0);
});

test("Anthropic-compatible checks use the Anthropic credential contract", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Anthropic Gateway",
    providerId: "anthropic-compatible",
    endpointUrl: "https://anthropic-gateway.example.test/v1",
    apiKey: "anthropic-private-value",
  });
  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async (input, init) => {
      assert.equal(String(input), "https://anthropic-gateway.example.test/v1/models");
      assert.deepEqual(init?.headers, {
        "x-api-key": "anthropic-private-value",
        "anthropic-version": "2023-06-01",
      });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
    close: async () => undefined,
  }));

  const checked = await testProviderConnection({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
  });
  assert.equal(checked.status, "ready");
  assert.equal(JSON.stringify(checked).includes("anthropic-private-value"), false);
});

test("OpenAI-compatible checks use the requested model and message instead of an empty catalog probe", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "OpenAI Gateway",
    providerId: "openai-compatible",
    endpointUrl: "https://gateway.example.test/v1",
    apiKey: "gateway-private-value",
  });
  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async (input, init) => {
      assert.equal(String(input), "https://gateway.example.test/v1/chat/completions");
      assert.equal(init?.method, "POST");
      assert.deepEqual(init?.headers, {
        "content-type": "application/json",
        Authorization: "Bearer gateway-private-value",
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "custom-model-v2",
        max_tokens: 1,
        messages: [{ role: "user", content: "Return compatible-ok." }],
      });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
    close: async () => undefined,
  }));

  const checked = await testProviderConnection({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
    model: "custom-model-v2",
    message: "Return compatible-ok.",
  });
  assert.equal(checked.status, "ready");
  assert.equal(JSON.stringify(checked).includes("gateway-private-value"), false);
});

test("preset providers use generated Pi launch metadata for storage, models, and connection checks", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Google",
    providerId: "google",
    apiKey: "google-private-value",
  });
  assert.equal(created.endpointUrl, null);
  assert.equal(created.supportsImageInput, false);
  assertProviderConnectionModelCompatible("google", { kind: "preset", id: "google/gemini-3.1-pro-preview" });
  assert.throws(
    () => assertProviderConnectionModelCompatible("google", { kind: "custom", name: "gemini-custom" }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "Google with endpoint",
      providerId: "google",
      endpointUrl: "https://gateway.example.test/v1",
      apiKey: "google-private-value",
    }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );

  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async (input, init) => {
      assert.equal(
        String(input),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
      );
      assert.equal(init?.method, "POST");
      assert.deepEqual(init?.headers, {
        "content-type": "application/json",
        "x-goog-api-key": "google-private-value",
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        generationConfig: { maxOutputTokens: 1 },
      });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
    close: async () => undefined,
  }));
  const checked = await testProviderConnection({
    serverId: server.id,
    userId: user.id,
    connectionId: created.id,
  });
  assert.equal(checked.status, "ready");
  assert.equal(JSON.stringify(checked).includes("google-private-value"), false);
  const selected = await resolveProviderConnectionSelection(server.id, created.id);
  const agent = await createAgent(server.id, `agent-${randomUUID().slice(0, 8)}`, {
    creatorType: "user",
    creatorId: user.id,
    runtime: "builtin",
    model: "google/gemini-3.1-pro-preview",
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: created.id },
      model: { kind: "preset", id: "google/gemini-3.1-pro-preview" },
      mode: { kind: "default" },
      hostUserState: "forbidden",
    },
    providerConnection: { ...selected, updatedByUserId: user.id },
  });
  assert.deepEqual(await resolveProviderConnectionLaunchEnv({
    serverId: server.id,
    agentId: agent.id,
    connectionId: created.id,
  }), { GEMINI_API_KEY: "google-private-value" });
});

test("preset connection checks honor Anthropic and OpenAI Responses protocols from Pi", async () => {
  const { user, server } = await seed();
  const cases = [
    {
      providerId: "anthropic" as const,
      model: "claude-3-5-haiku-latest",
      message: "Return test-ok.",
      url: "https://api.anthropic.com/v1/messages",
      apiKey: "anthropic-private-value",
      assertRequest(init: RequestInit) {
        assert.deepEqual(init.headers, {
          "content-type": "application/json",
          "x-api-key": "anthropic-private-value",
          "anthropic-version": "2023-06-01",
        });
        assert.deepEqual(JSON.parse(String(init.body)), {
          model: "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "Return test-ok." }],
        });
      },
    },
    {
      providerId: "openai" as const,
      model: "gpt-4.1-mini",
      message: "Return test-ok.",
      url: "https://api.openai.com/v1/responses",
      apiKey: "openai-private-value",
      assertRequest(init: RequestInit) {
        assert.deepEqual(init.headers, {
          "content-type": "application/json",
          Authorization: "Bearer openai-private-value",
        });
        assert.deepEqual(JSON.parse(String(init.body)), {
          model: "gpt-4.1-mini",
          input: "Return test-ok.",
          max_output_tokens: 1,
        });
      },
    },
  ];

  for (const probeCase of cases) {
    const created = await createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: probeCase.providerId,
      providerId: probeCase.providerId,
      apiKey: probeCase.apiKey,
    });
    __setProviderConnectionFetchFactoryForTests(() => ({
      fetch: (async (input, init) => {
        assert.equal(String(input), probeCase.url);
        assert.equal(init?.method, "POST");
        probeCase.assertRequest(init ?? {});
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch,
      close: async () => undefined,
    }));
    const checked = await testProviderConnection({
      serverId: server.id,
      userId: user.id,
      connectionId: created.id,
      model: probeCase.model,
      message: probeCase.message,
    });
    assert.equal(checked.status, "ready");
  }
});

test("model discovery uses the stored credential without exposing it and keeps manual testing available", async () => {
  const { user, server } = await seed();
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "OpenAI models",
    providerId: "openai",
    apiKey: "model-list-private-value",
  });
  __setProviderConnectionFetchFactoryForTests(() => ({
    fetch: (async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/models");
      assert.deepEqual(init?.headers, { Authorization: "Bearer model-list-private-value" });
      return Response.json({
        data: [
          { id: "gpt-4.1-mini" },
          { id: "gpt-4.1" },
          { id: "gpt-4.1-mini" },
          { id: "x".repeat(201) },
          { unexpected: "ignored" },
        ],
      });
    }) as typeof globalThis.fetch,
    close: async () => undefined,
  }));

  const result = await listProviderConnectionModels({ serverId: server.id, connectionId: created.id });
  assert.deepEqual(result, { models: ["gpt-4.1", "gpt-4.1-mini"] });
  assert.equal(JSON.stringify(result).includes("model-list-private-value"), false);
  assert.equal((await listProviderConnections(server.id))[0]?.status, "unchecked");
});

test("provider credential writes fail closed without a key and reject unsafe gateway URLs", async () => {
  const { user, server } = await seed();
  delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "No key",
      providerId: "deepseek",
      apiKey: "secret",
    }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_key_missing",
  );
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "Unsafe",
      providerId: "openai-compatible",
      endpointUrl: "https://user:password@gateway.example.test/v1",
      apiKey: "secret",
    }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "Private host",
      providerId: "openai-compatible",
      endpointUrl: "https://127.0.0.1/v1",
      apiKey: "secret",
    }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "Query credential",
      providerId: "openai-compatible",
      endpointUrl: "https://gateway.example.test/v1?api_key=must-not-project",
      apiKey: "secret",
    }),
    (error: unknown) => error instanceof ProviderConnectionError && error.code === "provider_connection_invalid",
  );
});

test("provider API key containing a non-Latin-1 character is rejected at save time", async () => {
  const { user, server } = await seed();
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
  await assert.rejects(
    () => createProviderConnection({
      serverId: server.id,
      userId: user.id,
      name: "Non-Latin-1 key",
      providerId: "openai-compatible",
      endpointUrl: "https://gateway.example.test/v1",
      apiKey: "sk-abcdefghi实xyz",
    }),
    (error: unknown) =>
      error instanceof ProviderConnectionError &&
      error.code === "provider_connection_invalid" &&
      error.message.includes("character 13 (1-based)"),
  );
});

test("provider API key containing a non-Latin-1 character is rejected on the decrypt path", async () => {
  const { user, server } = await seed();
  const credentialKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY!;
  const created = await createProviderConnection({
    serverId: server.id,
    userId: user.id,
    name: "Valid at save",
    providerId: "deepseek",
    apiKey: "valid-key-at-save",
  });

  // Manually encrypt a bad key as if it had been stored before the Latin-1 guard existed.
  const scope = `${server.id}:${created.id}`;
  const badKey = "sk-abcdefghi实xyz";
  const key = Buffer.from(credentialKey.trim(), "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const encrypted = Buffer.concat([cipher.update(badKey, "utf8"), cipher.final()]);
  const payload = [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");

  const [credential] = await getDb().select().from(providerConnectionCredentials).where(eq(
    providerConnectionCredentials.connectionId,
    created.id,
  ));
  await getDb().update(providerConnectionCredentials).set({ encryptedApiKey: payload }).where(eq(
    providerConnectionCredentials.id,
    credential.id,
  ));

  await assert.rejects(
    () => listProviderConnectionModels({ serverId: server.id, connectionId: created.id }),
    (error: unknown) =>
      error instanceof ProviderConnectionError &&
      error.code === "provider_connection_invalid" &&
      error.message.includes("character 13 (1-based)"),
  );
});

test("all apiKey usages that build HTTP headers are confined to the two known functions", async () => {
  const sourcePath = fileURLToPath(new URL("./providerConnectionService.ts", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const lines = source.split("\n");
  const allowedFunctions = new Set(["connectionTestRequest", "connectionModelCatalogRequest"]);
  const functionStack: { name: string; entryDepth: number }[] = [];
  let pendingFunction: string | null = null;
  let braceDepth = 0;
  const violations: number[] = [];
  const headerKeywordPattern = /Bearer|x-api-key|x-goog-api-key|Authorization/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const declaration = line.match(/function\s+(\w+)\s*\(/);
    if (declaration) {
      pendingFunction = declaration[1] ?? null;
    }
    if (pendingFunction && line.includes("{")) {
      functionStack.push({ name: pendingFunction, entryDepth: braceDepth });
      pendingFunction = null;
    }
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;
    const currentFunction = functionStack.length > 0 ? functionStack[functionStack.length - 1].name : null;
    if (line.includes("apiKey") && headerKeywordPattern.test(line) && !allowedFunctions.has(currentFunction ?? "")) {
      violations.push(i + 1);
    }
    while (functionStack.length > 0 && braceDepth <= functionStack[functionStack.length - 1].entryDepth) {
      functionStack.pop();
    }
  }
  assert.deepEqual(violations, []);
});
