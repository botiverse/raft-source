import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentCredentials, agents, integrationAuditEvents, machines, serverMembers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { registerMachine } from "../services/machineService";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";

// #wg-rbac:#78. A legacy machine key (`sk_machine_*`, POST /api/servers/:id/machines,
// owners and admins only) acts for the person who registered it, as every agent
// bound to that machine. When that person's membership ends (removed, or left)
// the key is revoked with what the machine minted (serverService
// executeMemberRemoval, computerKeyRevocation.ts), and legacy-key sign-in refuses
// any key whose registrant is no longer a member, or is only a Guest
// (lib/legacyMachineKeyStanding.ts), which covers keys of people who left before.

const test = createApiTest();

async function call(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const serverId = /^\/api\/servers\/([^/]+)\//.exec(path)?.[1];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** What a legacy key can do as the agent on its machine: read the server, read #all, send to #all. */
async function asAgent(baseUrl: string, apiKey: string, agentId: string) {
  const read = await call(baseUrl, apiKey, "GET", `/internal/agent/${agentId}/server`);
  const history = await call(baseUrl, apiKey, "GET", `/internal/agent/${agentId}/history?channel=%23all`);
  const send = await call(baseUrl, apiKey, "POST", `/internal/agent/${agentId}/send`, { target: "#all", content: "still here" });
  return { read: read.status, history: history.status, send: send.status };
}

/** A legacy machine `userId` registered on `serverId`, an agent bound to it, and a runner credential the machine minted. */
async function legacyMachine(serverId: string, userId: string, name: string) {
  const { machine, apiKey } = await registerMachine(serverId, userId, name);
  const agent = await createAgent(serverId, `${name}-agent`, { runtime: "external", creatorType: "user", creatorId: userId });
  await getDb().update(agents).set({ machineId: machine.id, status: "active" }).where(eq(agents.id, agent.id));
  const runner = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: `${name}-runner`, issuedVia: "computer", createdByUserId: null });
  await getDb().update(agentCredentials).set({ issuedByMachineId: machine.id }).where(eq(agentCredentials.id, runner.credentialId));
  return { machineId: machine.id, apiKey, agentId: agent.id, runnerCredentialId: runner.credentialId, runnerApiKey: runner.apiKey };
}

async function credentialRevokedAt(credentialId: string) {
  return (await getDb().select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, credentialId)))[0]!.revokedAt;
}

const LIVE = { read: 200, history: 200, send: 200 };
const REFUSED = { read: 401, history: 401, send: 401 };

async function setup(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const admin = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner, members: [] });
  const other = await seed.server({ owner, members: [] });
  for (const [serverId, userId] of [[server.id, admin.id], [server.id, colleague.id], [other.id, admin.id]] as const) {
    await getDb().insert(serverMembers).values({ serverId, userId, role: "admin" });
  }
  const theirs = await legacyMachine(server.id, admin.id, "their-box");
  const colleagues = await legacyMachine(server.id, colleague.id, "colleague-box");
  const elsewhere = await legacyMachine(other.id, admin.id, "their-box-elsewhere");
  return { owner, admin, colleague, server, other, theirs, colleagues, elsewhere };
}

test("an owner removes an admin: the legacy machine key they registered stops acting as its agents, and what it minted is revoked", async ({ app, seed }) => {
  const { owner, admin, server, other, theirs, colleagues, elsewhere } = await setup(seed);
  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), LIVE);
  const { token } = await signInForTest(owner.id);

  const impact = await call(app.baseUrl, token, "GET", `/api/servers/${server.id}/members/${admin.id}/removal-impact`);
  assert.equal(impact.status, 200, JSON.stringify(impact.body));
  assert.equal((impact.body as { computers: number }).computers, 1, "the removal dialog counts the legacy machine");

  const removed = await call(app.baseUrl, token, "DELETE", `/api/servers/${server.id}/members/${admin.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), REFUSED, "the removed admin's legacy key is refused");
  assert.ok(await credentialRevokedAt(theirs.runnerCredentialId), "what the machine minted is revoked");
  const [bound] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, theirs.agentId));
  assert.equal(bound!.machineId, theirs.machineId, "the agent on it stays bound");

  assert.deepEqual(await asAgent(app.baseUrl, colleagues.apiKey, colleagues.agentId), LIVE, "another admin's legacy key is untouched");
  assert.equal(await credentialRevokedAt(colleagues.runnerCredentialId), null);
  assert.deepEqual(await asAgent(app.baseUrl, elsewhere.apiKey, elsewhere.agentId), LIVE, "their key on a server they are still in is untouched");

  const audits = await getDb().select({ eventType: integrationAuditEvents.eventType, actorId: integrationAuditEvents.actorId, targetId: integrationAuditEvents.targetId, targetType: integrationAuditEvents.targetType, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_revoked")));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.targetType, "machine");
  assert.equal(audits[0]!.actorId, owner.id);
  assert.equal(audits[0]!.targetId, theirs.machineId);
  assert.equal(audits[0]!.metadata.via, "member_removed");
  assert.equal(audits[0]!.metadata.departureReason, "removed");
  assert.equal(audits[0]!.metadata.computerName, "their-box");
  assert.equal(audits[0]!.metadata.revokedCount, 1);
  assert.equal((await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, other.id), eq(integrationAuditEvents.eventType, "computer.key_revoked")))).length, 0);
});

test("an admin leaves: the legacy machine key they registered is revoked, attributed to them", async ({ app, seed }) => {
  const { admin, server, theirs, colleagues } = await setup(seed);
  const { token } = await signInForTest(admin.id);

  const left = await call(app.baseUrl, token, "POST", `/api/servers/${server.id}/leave`);
  assert.equal(left.status, 200, JSON.stringify(left.body));

  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), REFUSED);
  assert.ok(await credentialRevokedAt(theirs.runnerCredentialId));
  assert.deepEqual(await asAgent(app.baseUrl, colleagues.apiKey, colleagues.agentId), LIVE);
  const [audit] = await getDb().select({ actorId: integrationAuditEvents.actorId, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_revoked")));
  assert.equal(audit!.actorId, admin.id);
  assert.equal(audit!.metadata.departureReason, "left");
});

test("a key whose registrant left before removals revoked it is refused at sign-in, and works again once they are a member again", async ({ app, seed }) => {
  const { admin, server, theirs } = await setup(seed);
  // The state the 6 keys in production are in: the member row is gone, the key was never revoked.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const [row] = await getDb().select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, theirs.machineId));
  assert.ok(!row!.apiKeyHash.startsWith("revoked:"));

  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), REFUSED);

  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "member" });
  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), LIVE, "a returning member's unrevoked key acts again");
});

test("a registrant who is now only a Guest of the server: their legacy key is refused", async ({ app, seed }) => {
  const { admin, server, theirs } = await setup(seed);
  const channel = await seed.channel({ server, members: [admin] });
  await getDb().update(serverMembers).set({ role: "guest", guestChannelId: channel.id })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));

  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), REFUSED);
});

const REPAIR = path.resolve(import.meta.dirname, "../../drizzle/0722_legacy_machine_keys_departed_registrant_revoke.sql");

async function runRepair() {
  const text = await readFile(REPAIR, "utf8");
  for (const statement of text.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await getDb().transaction(async (tx) => { await tx.execute(sql.raw(statement)); });
  }
}

async function agentApi(baseUrl: string, runnerApiKey: string): Promise<number> {
  const res = await fetch(`${baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${runnerApiKey}` } });
  await res.body?.cancel();
  return res.status;
}

test("0722: a runner credential a legacy machine minted before its registrant left stops working; members' machines are untouched", async ({ app, seed }) => {
  const { admin, server, theirs, colleagues, elsewhere } = await setup(seed);
  // How the 6 production keys got here: the membership ended before removals revoked
  // anything, so the key and what it minted were left live.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  assert.equal(await agentApi(app.baseUrl, theirs.runnerApiKey), 200, "before the repair the credential still acts as the agent");

  await runRepair();

  assert.equal(await agentApi(app.baseUrl, theirs.runnerApiKey), 401, "the orphaned machine's runner credential is revoked");
  assert.deepEqual(await asAgent(app.baseUrl, theirs.apiKey, theirs.agentId), REFUSED);
  const [machine] = await getDb().select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, theirs.machineId));
  assert.equal(machine!.apiKeyHash, "revoked:registrant_left_server");
  assert.equal(await agentApi(app.baseUrl, colleagues.runnerApiKey), 200, "a member's machine is untouched");
  assert.equal(await agentApi(app.baseUrl, elsewhere.runnerApiKey), 200, "their machine on a server they are still in is untouched");

  const audits = await getDb().select({ eventType: integrationAuditEvents.eventType, targetType: integrationAuditEvents.targetType, targetId: integrationAuditEvents.targetId, actorType: integrationAuditEvents.actorType, requesterId: integrationAuditEvents.requesterId, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents).where(eq(integrationAuditEvents.serverId, server.id));
  const keyRevoked = audits.filter((row) => row.eventType === "computer.key_revoked");
  assert.deepEqual(keyRevoked.map((row) => [row.targetType, row.targetId, row.actorType, row.requesterId, row.metadata.revokedCount, row.metadata.trigger]),
    [["machine", theirs.machineId, "system", admin.id, 1, "repair"]]);
  const credentialRevoked = audits.filter((row) => row.eventType === "agent_credential.revoked");
  assert.deepEqual(credentialRevoked.map((row) => row.targetId), [theirs.runnerCredentialId]);

  await runRepair();
  assert.equal((await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_revoked")))).length, 1, "a second run changes nothing");
});
