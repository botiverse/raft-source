// Migrating a Computer agent to Raft hosted (task #16): the route's preflight
// and source-only lease, against a stubbed provider transport.
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY, ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentMigrationHostedTargets, agentMigrations, agentRuntimeProvisions, featureFlagRules, featureFlags, machines, servers, users } from "../db/schema";
import { createFeatureFlag } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { __setAgentRuntimeProviderTransportForTests } from "../services/agentRuntimeProviderService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const limits = { maxTotalBytes: 10485760, maxFiles: 2000, maxFileBytes: 2097152 };
const ENV = {
  SLOCK_PROVIDER_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  SERVER_URL: "https://raft.example.test/",
  ANTIPROTON_PROVISIONING_TOKEN: "pt-fake-provider-token-0123456789abcdef",
};

async function withEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ENV);
  const providerCalls: string[] = [];
  __setAgentRuntimeProviderTransportForTests({
    baseUrl: "http://provider.test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      providerCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/provision/import-limits") return Response.json(limits);
      return Response.json({ error: { code: "not_found", message: "" } }, { status: 404 });
    }) as typeof globalThis.fetch,
  });
  try {
    return await run();
  } finally {
    __setAgentRuntimeProviderTransportForTests(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function allow(flagKey: string, serverId: string) {
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey, stage: "server", priority: -100, decision: "allow", values: [serverId] });
}

async function setup(baseUrl: string, slug: string, options: { hostedFlag?: boolean } = {}) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@raft.test`, name: slug, displayName: slug,
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`Hosted ${slug}`, slug, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await allow(ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, server.id);
  if (options.hostedFlag !== false) {
    // No migration seeds this flag: absent means off. Turning it on is an admin creating it with a rule.
    const [existing] = await db.select({ key: featureFlags.key }).from(featureFlags).where(eq(featureFlags.key, AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY));
    if (!existing) await createFeatureFlag({ key: AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
    await allow(AGENT_MIGRATION_HOSTED_FEATURE_FLAG_KEY, server.id);
  }
  const [source] = await db.insert(machines).values({
    id: randomUUID(), serverId: server.id, userId: owner.id, name: `${slug}-mac`,
    apiKeyHash: `${slug}-hash`, runtimes: ["codex"], lastHeartbeat: new Date(),
  }).returning();
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex", model: "gpt-5.3-codex", machineId: source.id });
  const token = await tokenForHuman(owner.email);
  const migrate = (body: unknown) => fetch(`${baseUrl}/api/agents/${agent.id}/migrate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const confirm = (body: unknown) => fetch(`${baseUrl}/api/agents/${agent.id}/migration/confirm-hosted`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { server, source, agent, migrate, confirm };
}

function stubOrchestrator(app: { app: { get(k: string): unknown; set(k: string, v: unknown): void } }) {
  const leases: Array<{ machineId: string; role: string; targetMachineId: string }> = [];
  const original = app.app.get("agentOrchestrator") as object;
  app.app.set("agentOrchestrator", {
    ...original,
    getMachineStatus: async () => "online",
    getMachineMigrationTransport: async () => ({ capabilities: [AGENT_MIGRATION_CAPABILITY] }),
    sendAgentMigrationTransportLease: async (machineId: string, message: { role: string; targetMachineId: string }) => {
      leases.push({ machineId, role: message.role, targetMachineId: message.targetMachineId });
    },
  });
  app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
    provider: "object_store" as const, sessionId: `hosted-${randomUUID()}`, leaseMs: 60 * 60 * 1000, maxBytes: 10 * 1024 ** 3,
  }));
  return leases;
}

test("a hosted migration starts with only a source lease and the provider's limits", async ({ app }) => {
  await withEnv(async () => {
    const leases = stubOrchestrator(app);
    const { agent, source, migrate } = await setup(app.baseUrl, "hosted-start");
    const res = await migrate({ target: { kind: "hosted" } });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { targetKind: string; targetMachineId: string | null };
    assert.equal(body.targetKind, "hosted");
    assert.equal(body.targetMachineId, null);
    assert.deepEqual(leases, [{ machineId: source.id, role: "source", targetMachineId: "raft-hosted" }]);
    const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
    assert.equal(migration.targetKind, "hosted");
    assert.equal(migration.transportMaxBytes, 256 * 1024 * 1024);
    const [hosted] = await getDb().select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, migration.id));
    assert.deepEqual(hosted.importLimits, limits);

    const again = await migrate({ target: { kind: "hosted" } });
    assert.equal(again.status, 409);
    assert.equal((await again.json() as { code: string }).code, "MIGRATION_ALREADY_IN_PROGRESS");
  });
});

test("an agent that already had a hosted runtime record cannot move to hosted", async ({ app }) => {
  await withEnv(async () => {
    stubOrchestrator(app);
    const { agent, server, migrate } = await setup(app.baseUrl, "hosted-used");
    await getDb().insert(agentRuntimeProvisions).values({
      agentId: agent.id, serverId: server.id, provider: "antiproton", state: "deleted",
      provisionedName: "x", provisionedInstructions: "", nextAttemptAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await migrate({ target: { kind: "hosted" } });
    assert.equal(res.status, 409, await res.clone().text());
    assert.equal((await res.json() as { code: string }).code, "HOSTED_TARGET_ALREADY_USED");
  });
});

test("hosted is refused where the provider is not enabled, and a bad model is refused", async ({ app }) => {
  await withEnv(async () => {
    stubOrchestrator(app);
    const { server, migrate } = await setup(app.baseUrl, "hosted-off");
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY));
    const off = await migrate({ target: { kind: "hosted" } });
    assert.equal(off.status, 409, await off.clone().text());
    assert.equal((await off.json() as { code: string }).code, "HOSTED_TARGET_UNAVAILABLE");
    await allow(ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, server.id);
    const badModel = await migrate({ target: { kind: "hosted", hostedModel: 42 } });
    assert.equal(badModel.status, 400);
    assert.equal((await badModel.json() as { code: string }).code, "HOSTED_TARGET_MODEL_INVALID");
  });
});

test("hosted migration has its own default-off gate, even where Pro and the hosted runtime are both on", async ({ app }) => {
  await withEnv(async () => {
    const leases = stubOrchestrator(app);
    const { agent, migrate, confirm } = await setup(app.baseUrl, "hosted-gate", { hostedFlag: false });
    const res = await migrate({ target: { kind: "hosted" } });
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal((await res.json() as { code: string }).code, "HOSTED_TARGET_UNAVAILABLE");
    assert.deepEqual(leases, []);
    assert.deepEqual(await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id)), []);
    const confirmed = await confirm({ migrationRef: "mig_abcdefghijklmnopqrstuv", expectedRevision: 1 });
    assert.equal(confirmed.status, 403);
    assert.equal((await confirmed.json() as { code: string }).code, "HOSTED_TARGET_UNAVAILABLE");
  });
});

test("hosted migration still needs Pro: a free server with the hosted flags on is refused before any lease", async ({ app }) => {
  await withEnv(async () => {
    const leases = stubOrchestrator(app);
    const { agent, server, migrate } = await setup(app.baseUrl, "hosted-free");
    await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    const res = await migrate({ target: { kind: "hosted" } });
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal((await res.json() as { code: string }).code, "MIGRATION_PRO_PLAN_REQUIRED");
    assert.deepEqual(leases, []);
    assert.deepEqual(await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id)), []);
  });
});
