import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AGENT_MIGRATION_CAPABILITY } from "@botiverse/raft-shared";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { beginTestAgentMigration } from "../test/agentMigrationFixture";
import { getDb } from "../db/index";
import { agentCredentials, agentMigrations, agents, integrationAuditEvents, machines, serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, getAgent } from "../services/agentService";
import { placeAgentWithoutSource } from "../services/agentMigrationService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seedMachine(serverId: string, userId: string, name: string, overrides: Partial<typeof machines.$inferInsert> = {}) {
  const [machine] = await getDb().insert(machines).values({
    id: randomUUID(),
    serverId,
    userId,
    name,
    apiKeyHash: `${name}-hash-${randomUUID()}`,
    runtimes: ["codex"],
    daemonVersion: "0.72.7",
    lastHeartbeat: new Date(),
    ...overrides,
  }).returning();
  return machine!;
}

async function seedRunnerCredential(agentId: string, machineId: string) {
  const [credential] = await getDb().insert(agentCredentials).values({
    agentId,
    apiKeyHash: `runner-${randomUUID()}`,
    apiKeyPrefix: "sk_agent_test",
    scopes: ["read", "send"],
    issuedVia: "computer",
    issuedByMachineId: machineId,
  }).returning();
  return credential!;
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/**
 * A Free server (no Pro plan) with an owner, a member, the Computer the agent
 * was forced off (`formerMachine`), an online target and an offline one.
 */
async function seedFixture(app: { app: { get(key: string): unknown; set(key: string, value: unknown): void } }) {
  const owner = await seedUser("place-owner");
  const member = await seedUser("place-member");
  const server = await createServer("Place Without Source", `place-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const formerMachine = await seedMachine(server.id, owner.id, `former-${randomUUID().slice(0, 6)}`);
  const target = await seedMachine(server.id, owner.id, `target-${randomUUID().slice(0, 6)}`);
  const offlineTarget = await seedMachine(server.id, owner.id, `offline-${randomUUID().slice(0, 6)}`, {
    lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000),
  });
  const claudeOnlyTarget = await seedMachine(server.id, owner.id, `claude-only-${randomUUID().slice(0, 6)}`, { runtimes: ["claude"] });
  const detachedTarget = await seedMachine(server.id, owner.id, `detached-${randomUUID().slice(0, 6)}`, { apiKeyHash: `revoked:${randomUUID()}` });

  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  const resumable = { capabilities: [AGENT_MIGRATION_CAPABILITY] };
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    getMachineStatus: async (machineId: string) => machineId === offlineTarget.id ? "offline" : "online",
    getMachineMigrationTransport: async () => resumable,
    getMachineRuntimeDetection: async () => null,
    sendAgentMigrationTransportLease: async () => undefined,
  });
  app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
    provider: "object_store" as const,
    sessionId: `place-session-${randomUUID()}`,
    leaseMs: 60 * 60 * 1000,
    maxBytes: 123_456,
  }));

  // As unbindAndStopAgents leaves it when its Computer's owner forces it off.
  const agent = await createAgent(server.id, `place-agent-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: formerMachine.id });
  const releasedAt = new Date();
  await getDb().update(agents).set({
    machineId: null,
    status: "stopped",
    sessionId: "old-session",
    machineReleaseReason: "forced_by_computer_owner",
    machineReleasedAt: releasedAt,
  }).where(eq(agents.id, agent.id));

  return {
    owner,
    member,
    server,
    formerMachine,
    target,
    offlineTarget,
    claudeOnlyTarget,
    detachedTarget,
    agent,
    ownerToken: await tokenForHuman(owner.email),
    memberToken: await tokenForHuman(member.email),
  };
}

function postMigrate(baseUrl: string, fx: Fixture, agentId: string, targetComputer: string, token = fx.ownerToken) {
  return fetch(`${baseUrl}/api/agents/${agentId}/migrate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": fx.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ targetComputer }),
  });
}

test("POST /migrate places an agent on no Computer straight on the target, with a fresh session", async ({ app }) => {
  const fx = await seedFixture(app);
  const offTargetKey = await seedRunnerCredential(fx.agent.id, fx.formerMachine.id);
  const onTargetKey = await seedRunnerCredential(fx.agent.id, fx.target.id);

  // The server is on Free: placing is not a migration and is not paywalled.
  const res = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.target.name);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.deepEqual(JSON.parse(text), {
    outcome: "placed_without_source",
    migrationRef: null,
    state: "completed",
    sourceMachineId: null,
    targetMachineId: fx.target.id,
  });

  const [placed] = await getDb().select().from(agents).where(eq(agents.id, fx.agent.id));
  assert.equal(placed!.machineId, fx.target.id);
  assert.equal(placed!.sessionId, null, "a fresh session on the target");
  assert.equal(placed!.status, "inactive", "wakeable again: the next message starts it there");
  assert.equal(placed!.machineReleaseReason, null, "auto-assign and the rest treat it as bound on purpose");
  assert.equal(placed!.machineReleasedAt, null);

  const [offTarget] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, offTargetKey.id));
  const [onTarget] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, onTargetKey.id));
  assert.ok(offTarget!.revokedAt, "a runner key minted by another Computer is revoked");
  assert.equal(onTarget!.revokedAt, null, "the target's own runner keys stay");

  const auditRows = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, fx.server.id),
    eq(integrationAuditEvents.eventType, "computer.agent_assigned"),
  ));
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]!.actorId, fx.owner.id);
  assert.equal(auditRows[0]!.outcome, "success");
  assert.deepEqual(auditRows[0]!.metadata, {
    agentId: fx.agent.id,
    machineId: fx.target.id,
    previousMachineId: null,
    machineOwnerIsActor: true,
    via: "placed_without_source",
    actorRole: "owner",
  });
  assert.equal(
    (await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, fx.agent.id))).length,
    0,
    "no migration record: there is no source to record",
  );

  // Now it has a source: the same request is an ordinary migration again.
  const again = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.target.id);
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code?: string }).code, "TARGET_COMPUTER_MATCHES_SOURCE");
});

test("POST /migrate placement runs the migration's target checks and refusals", async ({ app }) => {
  const fx = await seedFixture(app);
  const unchanged = async (label: string) => {
    const agent = await getAgent(fx.agent.id);
    assert.equal(agent?.machineId, null, `${label}: still on no Computer`);
    assert.equal(agent?.sessionId, "old-session", `${label}: session untouched`);
  };

  // Permission: refused exactly as a migration of an agent with a source is.
  const withSource = await createAgent(fx.server.id, `with-source-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: fx.formerMachine.id });
  const memberDenied = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.target.id, fx.memberToken);
  const memberDeniedWithSource = await postMigrate(app.baseUrl, fx, withSource.id, fx.target.id, fx.memberToken);
  assert.equal(memberDenied.status, 403);
  assert.equal(memberDeniedWithSource.status, 403);
  assert.deepEqual(await memberDenied.json(), await memberDeniedWithSource.json());
  await unchanged("member");

  const offline = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.offlineTarget.id);
  assert.equal(offline.status, 409);
  assert.equal((await offline.json() as { code?: string }).code, "TARGET_COMPUTER_OFFLINE");

  const runtimeMissing = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.claudeOnlyTarget.id);
  assert.equal(runtimeMissing.status, 422);
  assert.deepEqual(await runtimeMissing.json(), {
    error: "The target computer must support the agent's runtime",
    code: "COMPUTER_CAPABILITY_INSUFFICIENT",
    details: {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "target", reason: "runtime_missing", runtime: "codex" }],
    },
  });

  const notInServer = await postMigrate(app.baseUrl, fx, fx.agent.id, randomUUID());
  assert.equal(notInServer.status, 422);
  assert.equal((await notInServer.json() as { code?: string }).code, "TARGET_COMPUTER_NOT_IN_SERVER");

  // A detached Computer (key revoked) takes no agents: checked under its row lock.
  const detached = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.detachedTarget.id);
  assert.equal(detached.status, 409);
  assert.equal((await detached.json() as { code?: string }).code, "MIGRATION_TARGET_COMPUTER_DETACHED");
  await unchanged("refused targets");

  // External agents never run on a Computer: still refused as before.
  const external = await createAgent(fx.server.id, `external-${randomUUID().slice(0, 6)}`, { runtime: "external" });
  const externalRes = await postMigrate(app.baseUrl, fx, external.id, fx.target.id);
  assert.equal(externalRes.status, 409);
  assert.equal((await externalRes.json() as { code?: string }).code, "AGENT_HAS_NO_SOURCE_MACHINE");

  // A deleted agent is not found.
  const deleted = await createAgent(fx.server.id, `deleted-${randomUUID().slice(0, 6)}`, { runtime: "codex" });
  await getDb().update(agents).set({ machineId: null, deletedAt: new Date() }).where(eq(agents.id, deleted.id));
  const deletedRes = await postMigrate(app.baseUrl, fx, deleted.id, fx.target.id);
  assert.equal(deletedRes.status, 404);
  assert.equal((await deletedRes.json() as { code?: string }).code, "AGENT_NOT_FOUND");
  assert.equal((await getDb().select().from(agents).where(eq(agents.id, deleted.id)))[0]!.machineId, null);
});

test("POST /migrate placement refuses while a migration is active, in the route and under the agent row lock", async ({ app }) => {
  const fx = await seedFixture(app);
  const other = await seedMachine(fx.server.id, fx.owner.id, `other-${randomUUID().slice(0, 6)}`);
  // A migration started while the agent was on its former Computer, then the agent was unbound.
  await getDb().update(agents).set({ machineId: fx.formerMachine.id }).where(eq(agents.id, fx.agent.id));
  await beginTestAgentMigration({ agentId: fx.agent.id, targetMachineId: other.id, initiatedByUserId: fx.owner.id });
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, fx.agent.id));

  const res = await postMigrate(app.baseUrl, fx, fx.agent.id, fx.target.id);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code?: string }).code, "MIGRATION_ALREADY_IN_PROGRESS");

  const direct = await placeAgentWithoutSource({
    agentId: fx.agent.id,
    targetMachineId: fx.target.id,
    actorFence: { serverId: fx.server.id, userId: fx.owner.id, capability: "migrateAgents" },
  });
  assert.deepEqual(direct, { placed: false, code: "MIGRATION_ALREADY_IN_PROGRESS" });
  assert.equal((await getAgent(fx.agent.id))?.machineId, null);
});

test("POST /migrate for an agent with a source still starts a normal migration", async ({ app }) => {
  const fx = await seedFixture(app);
  const agent = await createAgent(fx.server.id, `with-source-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: fx.formerMachine.id });

  const free = await postMigrate(app.baseUrl, fx, agent.id, fx.target.id);
  assert.equal(free.status, 403, "a real migration keeps its Pro gate");
  assert.equal((await free.json() as { code?: string }).code, "MIGRATION_PRO_PLAN_REQUIRED");

  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, fx.server.id));
  const res = await postMigrate(app.baseUrl, fx, agent.id, fx.target.id);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { migrationRef: string; state: string; sourceMachineId: string; targetMachineId: string; outcome?: string };
  assert.equal(body.outcome, undefined);
  assert.equal(body.state, "provisioning");
  assert.match(body.migrationRef, /^mig_/);
  assert.equal(body.sourceMachineId, fx.formerMachine.id);
  assert.equal(body.targetMachineId, fx.target.id);
  assert.equal((await getAgent(agent.id))?.machineId, fx.formerMachine.id, "the agent stays on its source until the flip");
});
