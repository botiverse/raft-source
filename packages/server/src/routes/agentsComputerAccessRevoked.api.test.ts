/**
 * Reconciler step 15 (B15, Tenny Q-7): an agent on a Computer whose key was
 * revoked stays bound. The agent list derives `blockedReason:
 * "computer_access_revoked"` from the data (no stored column), a manual start
 * says so, and Move places it on the target as an agent on no Computer is
 * (the revoked Computer can bring nothing over).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AGENT_MIGRATION_CAPABILITY } from "@botiverse/raft-shared";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentMigrations, agents, computers, integrationAuditEvents, machines, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent, getAgent } from "../services/agentService";

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

async function seedComputer(serverId: string, userId: string, label: string, key: "live" | "none") {
  const name = `${label}-${randomUUID().slice(0, 6)}`;
  const [machine] = await getDb().insert(machines).values({
    serverId,
    userId,
    name,
    apiKeyHash: `${name}-hash`,
    runtimes: ["codex"],
    daemonVersion: "0.72.7",
    lastHeartbeat: new Date(),
  }).returning();
  if (key !== "none") {
    await getDb().insert(computers).values({
      serverId,
      name,
      apiKeyHash: `${name}-computer-hash`,
      apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 4)}`,
      attachedByUserId: userId,
      machineId: machine!.id,
    });
  }
  return machine!;
}

async function seedFixture() {
  const owner = await seedUser("b15-owner");
  const server = await createServer("Computer Access Revoked", `b15-${randomUUID().slice(0, 8)}`, owner.id);
  const revoked = await seedComputer(server.id, owner.id, "revoked", "live");
  const live = await seedComputer(server.id, owner.id, "live", "live");
  const legacy = await seedComputer(server.id, owner.id, "legacy", "none");
  const onRevoked = await createAgent(server.id, `on-revoked-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: owner.id, machineId: revoked.id });
  const onLive = await createAgent(server.id, `on-live-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: owner.id, machineId: live.id });
  const onLegacy = await createAgent(server.id, `on-legacy-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: owner.id, machineId: legacy.id });
  await getDb().update(agents).set({ sessionId: "old-session" }).where(eq(agents.id, onRevoked.id));
  // Revoked after its agent was bound, as #13527's membership end leaves it: the agent stays bound.
  await getDb().update(computers).set({ revokedAt: new Date(), revokedReason: "computer_key_revoked" }).where(eq(computers.machineId, revoked.id));
  return { owner, server, revoked, live, legacy, onRevoked, onLive, onLegacy, token: await tokenForHuman(owner.email) };
}

const headers = (token: string, serverId: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });

test("GET /api/agents: an agent on a revoked Computer reads computer_access_revoked; live and legacy keys read as before", async ({ app }) => {
  const fx = await seedFixture();
  const res = await fetch(`${app.baseUrl}/api/agents`, { headers: headers(fx.token, fx.server.id) });
  assert.equal(res.status, 200);
  const list = await res.json() as Array<{ id: string; machineId: string | null; blockedReason?: string | null }>;
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(fx.onRevoked.id)?.blockedReason, "computer_access_revoked");
  assert.equal(byId.get(fx.onRevoked.id)?.machineId, fx.revoked.id, "it stays bound to the revoked Computer");
  assert.equal(byId.get(fx.onLive.id)?.blockedReason, null);
  assert.equal(byId.get(fx.onLegacy.id)?.blockedReason, null);
});

test("POST /agents/:id/start: an agent on a revoked Computer is refused with computer_access_revoked", async ({ app }) => {
  const fx = await seedFixture();
  const orchestrator = app.app.get("agentOrchestrator") as { startAgent: (agentId: string) => Promise<unknown> };
  const original = orchestrator.startAgent;
  const started: string[] = [];
  orchestrator.startAgent = async (agentId: string) => {
    started.push(agentId);
    return { outcome: "dispatched" };
  };
  try {
    const refused = await fetch(`${app.baseUrl}/api/agents/${fx.onRevoked.id}/start`, { method: "POST", headers: headers(fx.token, fx.server.id) });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json() as { code: string }).code, "computer_access_revoked");
    const ok = await fetch(`${app.baseUrl}/api/agents/${fx.onLive.id}/start`, { method: "POST", headers: headers(fx.token, fx.server.id) });
    assert.equal(ok.status, 200, await ok.text());
    assert.deepEqual(started, [fx.onLive.id], "only the live Computer's agent reached the orchestrator");
  } finally {
    orchestrator.startAgent = original;
  }
});

function withOnlineTargets(app: { app: { get(key: string): unknown; set(key: string, value: unknown): void } }) {
  const original = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...original,
    getMachineStatus: async () => "online",
    // A revoked Computer's last transport may still be mirrored: it must not make this a migration.
    getMachineMigrationTransport: async () => ({ capabilities: [AGENT_MIGRATION_CAPABILITY] }),
    getMachineRuntimeDetection: async () => null,
  });
}

test("POST /migrate: an agent on a revoked Computer is placed on the target (no Pro, no transfer), as one on no Computer", async ({ app }) => {
  const fx = await seedFixture();
  withOnlineTargets(app);
  const res = await fetch(`${app.baseUrl}/api/agents/${fx.onRevoked.id}/migrate`, {
    method: "POST",
    headers: headers(fx.token, fx.server.id),
    body: JSON.stringify({ targetComputer: fx.live.name }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.deepEqual(JSON.parse(text), {
    outcome: "placed_without_source",
    migrationRef: null,
    state: "completed",
    sourceMachineId: fx.revoked.id,
    targetMachineId: fx.live.id,
  });
  const moved = await getAgent(fx.onRevoked.id);
  assert.equal(moved?.machineId, fx.live.id);
  assert.equal(moved?.sessionId, null, "a fresh session on the target");
  assert.deepEqual(await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, fx.onRevoked.id)), [], "no migration record");
  const [audit] = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, fx.server.id),
    eq(integrationAuditEvents.eventType, "computer.agent_assigned"),
  ));
  assert.equal((audit?.metadata as Record<string, unknown>)?.previousMachineId, fx.revoked.id);
  assert.equal((audit?.metadata as Record<string, unknown>)?.via, "placed_without_source");
});

test("POST /migrate: an agent on a live Computer is still a migration (Pro-gated on a Free server)", async ({ app }) => {
  const fx = await seedFixture();
  withOnlineTargets(app);
  const res = await fetch(`${app.baseUrl}/api/agents/${fx.onLive.id}/migrate`, {
    method: "POST",
    headers: headers(fx.token, fx.server.id),
    body: JSON.stringify({ targetComputer: fx.legacy.name }),
  });
  assert.equal(res.status, 403, await res.text());
  assert.equal((await getAgent(fx.onLive.id))?.machineId, fx.live.id);
});

test("GET /agents/:id/workspace-files(/read): an agent on a revoked Computer is refused with computer_access_revoked, not routed", async ({ app }) => {
  const fx = await seedFixture();
  for (const url of [
    `${app.baseUrl}/api/agents/${fx.onRevoked.id}/workspace-files`,
    `${app.baseUrl}/api/agents/${fx.onRevoked.id}/workspace-files/read?path=MEMORY.md`,
  ]) {
    const res = await fetch(url, { headers: headers(fx.token, fx.server.id) });
    assert.equal(res.status, 409, url);
    assert.equal((await res.json() as { code: string }).code, "computer_access_revoked", url);
  }
  // A live Computer that is not connected still reads as before (offline), not revoked.
  const live = await fetch(`${app.baseUrl}/api/agents/${fx.onLive.id}/workspace-files`, { headers: headers(fx.token, fx.server.id) });
  assert.notEqual((await live.json() as { code?: string }).code, "computer_access_revoked");
});
