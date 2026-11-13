import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, computerLifecycleOperations, computers, integrationAuditEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { attachComputer, findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";
import { setMachineConnectionDropHandler, type MachineConnectionDropReason } from "../replicaRouter";

// Device-auth PR 3c: what `raft-computer` used a person's session for, done
// with the machine's own key. Every route acts on the presenting key's own
// Computer and machine only, and a key never reaches another machine.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Attached = { apiKey: string; computerId: string; machineId: string };

async function seed() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `self-ops-${suffix}@slock.test`,
    name: `self-ops-${suffix}`,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Self Ops", `self-ops-${suffix}`, owner!.id);
  const attach = async (name: string): Promise<Attached> => {
    const result = await attachComputer({ userId: owner!.id, serverSlug: server.slug, name });
    assert.ok(result.ok, `attach ${name}`);
    return { apiKey: result.apiKey, computerId: result.serverMachineId, machineId: result.machineId };
  };
  const laptop = await attach("laptop");
  const desktop = await attach("desktop");
  const runnerOn = async (computer: Attached, name: string) => {
    // The person's own agent: someone else's would block the detach (internalComputer.detachOthersAgents.api.test.ts).
    const agent = await createAgent(server.id, name, { runtime: "claude", model: "sonnet", machineId: computer.machineId, creatorType: "user", creatorId: owner!.id });
    const minted = await mintAgentCredential({
      agentId: agent.id,
      scopes: ["read"],
      name: `${name}-runner`,
      issuedVia: "computer",
      issuedByMachineId: computer.machineId,
      createdByUserId: null,
    });
    return { agentId: agent.id, apiKey: minted.apiKey, credentialId: minted.credentialId };
  };
  return { owner: owner!, server, laptop, desktop, runnerOn };
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function call(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: bearer(apiKey),
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

test("lifecycle-operations records this machine's own start/stop/restart as machine_local, never another machine's", async ({ app }) => {
  const { server, laptop, desktop, owner } = await seed();
  let laptopLocal = false;
  let epoch: string | null = null;
  app.app.set("agentOrchestrator", {
    getCurrentTimeMs: () => Date.now(),
    hasMachineLocally: (machineId: string) => machineId === laptop.machineId && laptopLocal,
    getMachineConnectionEpoch: (machineId: string) => machineId === laptop.machineId ? epoch : null,
  });
  const record = (apiKey: string, body: Record<string, unknown>) =>
    call(app.baseUrl, "POST", "/internal/computer/lifecycle-operations", apiKey, body);

  // Offline: a start is recorded for the key's own machine.
  const parentOperationId = randomUUID();
  const startId = randomUUID();
  let res = await record(laptop.apiKey, { action: "start", operationId: startId, parentOperationId });
  assert.deepEqual(res, { status: 201, body: { operationId: startId, action: "start" } });
  // Replaying the same identity is idempotent.
  res = await record(laptop.apiKey, { action: "start", operationId: startId, parentOperationId });
  assert.equal(res.status, 201);

  // Another machine named in the body is refused, and nothing is written for it.
  res = await record(laptop.apiKey, { action: "start", operationId: randomUUID(), parentOperationId, machineId: desktop.machineId });
  assert.deepEqual([res.status, res.body?.code], [403, "computer_machine_mismatch"]);
  res = await record(laptop.apiKey, { action: "start", operationId: randomUUID(), parentOperationId, serverId: randomUUID() });
  assert.deepEqual([res.status, res.body?.code], [403, "computer_machine_mismatch"]);

  // Upgrade stays on the person's route; unknown actions and bad ids are refused.
  res = await record(laptop.apiKey, { action: "upgrade", operationId: randomUUID(), parentOperationId });
  assert.deepEqual([res.status, res.body?.code], [400, "unknown_action"]);
  res = await record(laptop.apiKey, { action: "restart", operationId: randomUUID(), parentOperationId, targetVersion: "1.0.0" });
  assert.equal(res.status, 400);
  res = await record(laptop.apiKey, { action: "stop", operationId: "not-a-uuid", parentOperationId });
  assert.deepEqual([res.status, res.body?.code], [400, "invalid_operation_id"]);

  // Stop needs the machine online; once it is, the record carries its epoch.
  res = await record(laptop.apiKey, { action: "stop", operationId: randomUUID(), parentOperationId });
  assert.deepEqual([res.status, res.body?.code], [409, "computer_offline"]);
  laptopLocal = true;
  epoch = "laptop-epoch-1";
  const stopId = randomUUID();
  res = await record(laptop.apiKey, { action: "stop", operationId: stopId, parentOperationId });
  assert.equal(res.status, 201);
  res = await record(laptop.apiKey, { action: "start", operationId: randomUUID(), parentOperationId });
  assert.deepEqual([res.status, res.body?.code], [409, "computer_already_online"]);

  const rows = await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.serverId, server.id));
  assert.deepEqual(rows.map((row) => row.id).sort(), [startId, stopId].sort());
  for (const row of rows) {
    assert.equal(row.machineId, laptop.machineId);
    assert.equal(row.computerId, laptop.computerId);
    assert.equal(row.cause, "machine_local");
    assert.equal(row.actorUserId, null, "no person is named for a machine-local record");
    assert.equal(row.dispatchMode, "local");
  }
  assert.equal(rows.find((row) => row.id === stopId)?.connectionEpochBefore, "laptop-epoch-1");

  // The person's route (older Computers) still records, as that person, and
  // cannot adopt the machine's record by replaying its id.
  const ownerToken = await tokenForHuman(owner.email);
  const personal = (body: Record<string, unknown>) => fetch(
    `${app.baseUrl}/api/servers/${server.id}/machines/${laptop.machineId}/computer-lifecycle-operations`,
    { method: "POST", headers: { ...bearer(ownerToken), "X-Server-Id": server.id }, body: JSON.stringify(body) },
  );
  assert.equal((await personal({ action: "stop", operationId: stopId, parentOperationId })).status, 409);
  const restartId = randomUUID();
  assert.equal((await personal({ action: "restart", operationId: restartId, parentOperationId })).status, 201);
  const [personRow] = await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.id, restartId));
  assert.deepEqual([personRow?.cause, personRow?.actorUserId], ["user_action", owner.id]);
  // ...and the machine cannot adopt the person's record either.
  res = await record(laptop.apiKey, { action: "restart", operationId: restartId, parentOperationId });
  assert.deepEqual([res.status, res.body?.code], [409, "computer_lifecycle_operation_conflict"]);
});

test("the machine-key routes refuse other principals, legacy machine keys and revoked keys", async ({ app }) => {
  const { server, owner, laptop, runnerOn } = await seed();
  const legacy = await registerMachine(server.id, owner.id, "legacy-daemon");
  const runner = await runnerOn(laptop, "principal-agent");
  const ownerToken = await tokenForHuman(owner.email);
  const routes: Array<[string, string]> = [
    ["POST", "/internal/computer/lifecycle-operations"],
    ["GET", "/internal/computer/self"],
    ["POST", "/internal/computer/detach"],
  ];
  const body = { action: "start", operationId: randomUUID(), parentOperationId: randomUUID() };
  for (const [method, path] of routes) {
    assert.equal((await call(app.baseUrl, method, path, runner.apiKey, body)).body?.code, "invalid_principal", `${path} agent key`);
    assert.equal((await call(app.baseUrl, method, path, ownerToken, body)).status, 401, `${path} person's session`);
    const alias = await call(app.baseUrl, method, path, legacy.apiKey, body);
    assert.deepEqual([alias.status, alias.body?.code], [403, "computer_key_required"], `${path} legacy machine key`);
  }
  // The legacy key revoked nothing.
  assert.equal((await findComputerByApiKeyWithReason(laptop.apiKey)).ok, true);

  await getDb().update(computers).set({ revokedAt: new Date() }).where(eq(computers.id, laptop.computerId));
  for (const [method, path] of routes) {
    assert.equal((await call(app.baseUrl, method, path, laptop.apiKey, body)).status, 401, `${path} revoked key`);
  }
  const rows = await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.serverId, server.id));
  assert.equal(rows.length, 0);
});

test("self returns this Computer's own row and its own machine's agent count only", async ({ app }) => {
  const { server, laptop, desktop, runnerOn } = await seed();
  await runnerOn(laptop, "laptop-agent-1");
  await runnerOn(laptop, "laptop-agent-2");
  await runnerOn(desktop, "desktop-agent");
  const res = await call(app.baseUrl, "GET", "/internal/computer/self", laptop.apiKey);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    computer: {
      computerId: laptop.computerId,
      computerName: "laptop",
      serverId: server.id,
      machineId: laptop.machineId,
      machineName: res.body?.computer?.machineName,
      agentCount: 2,
    },
  });
  assert.equal(typeof res.body?.computer?.machineName, "string");
  assert.deepEqual(Object.keys(res.body?.computer ?? {}).sort(), ["agentCount", "computerId", "computerName", "machineId", "machineName", "serverId"]);
});

test("detach revokes this Computer's key and its machine's runner keys, closes their connections, audits it, and touches nothing else", async ({ app }) => {
  const { server, laptop, desktop, runnerOn } = await seed();
  const laptopRunner = await runnerOn(laptop, "laptop-agent");
  const desktopRunner = await runnerOn(desktop, "desktop-agent");
  const drops: Array<[string, MachineConnectionDropReason]> = [];
  const signals: string[] = [];
  setMachineConnectionDropHandler((machineId, reason) => { drops.push([machineId, reason]); });
  const offs = [laptopRunner, desktopRunner].map((runner) =>
    subscribeAgentCredentialRevocation(runner.agentId, () => signals.push(runner.agentId)));
  try {
    const res = await call(app.baseUrl, "POST", "/internal/computer/detach", laptop.apiKey, {});
    assert.deepEqual(res, { status: 200, body: { ok: true, computerId: laptop.computerId, machineId: laptop.machineId, unboundAgentIds: [] } });
    assert.deepEqual(drops, [[laptop.machineId, "credential_revoked"]]);
    assert.deepEqual(signals, [laptopRunner.agentId]);
  } finally {
    for (const off of offs) off();
    setMachineConnectionDropHandler(null);
  }

  const laptopAuth = await findComputerByApiKeyWithReason(laptop.apiKey);
  assert.deepEqual(laptopAuth, { ok: false, reason: "computer_revoked" });
  assert.equal((await findComputerByApiKeyWithReason(desktop.apiKey)).ok, true, "the person's other Computer is untouched");
  const creds = await getDb().select({ id: agentCredentials.id, revokedAt: agentCredentials.revokedAt, revokedReason: agentCredentials.revokedReason })
    .from(agentCredentials)
    .where(inArray(agentCredentials.id, [laptopRunner.credentialId, desktopRunner.credentialId]));
  assert.equal(creds.find((c) => c.id === laptopRunner.credentialId)?.revokedReason, "computer_key_revoked");
  assert.equal(creds.find((c) => c.id === desktopRunner.credentialId)?.revokedAt, null);

  const [audit] = await getDb()
    .select({
      actorType: integrationAuditEvents.actorType,
      actorId: integrationAuditEvents.actorId,
      source: integrationAuditEvents.source,
      requesterId: integrationAuditEvents.requesterId,
      serverId: integrationAuditEvents.serverId,
      metadata: integrationAuditEvents.metadata,
    })
    .from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, laptop.computerId)));
  assert.deepEqual(
    { actorType: audit?.actorType, actorId: audit?.actorId, source: audit?.source, requesterId: audit?.requesterId, serverId: audit?.serverId, via: audit?.metadata.via, revokedCount: audit?.metadata.revokedCount },
    { actorType: "system", actorId: null, source: "cli", requesterId: null, serverId: server.id, via: "detach", revokedCount: 1 },
  );
  const credentialAudits = await getDb().select({ targetId: integrationAuditEvents.targetId })
    .from(integrationAuditEvents)
    .where(and(
      eq(integrationAuditEvents.eventType, "agent_credential.revoked"),
      inArray(integrationAuditEvents.targetId, [laptopRunner.credentialId, desktopRunner.credentialId]),
    ));
  assert.deepEqual(credentialAudits.map((row) => row.targetId), [laptopRunner.credentialId]);

  // Its key is dead now: a second detach is refused and revokes nothing more.
  const again = await call(app.baseUrl, "POST", "/internal/computer/detach", laptop.apiKey, {});
  assert.equal(again.status, 401);
  assert.equal((await findComputerByApiKeyWithReason(desktop.apiKey)).ok, true);
});
