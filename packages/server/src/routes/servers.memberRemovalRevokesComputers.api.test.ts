import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentCredentials, agents, computers, dmChannelIdentities, integrationAuditEvents, messages, serverMembers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { registerMachine } from "../services/machineService";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";

// When someone's membership of a server ends (an owner or admin removes them, or
// they leave), every live Computer they attached to that server is revoked as
// its "Revoke Computer key" does (serverService.ts removeMemberInTransaction,
// computerKeyRevocation.ts): the key is refused, what its machine minted is
// revoked, the agents on it stay bound, and it is audited under the removal.
// A demotion revokes nothing; their Computers on other servers are untouched.

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

/** A Computer `userId` attached to `serverId`, with a real key, an agent bound to it and a runner credential its machine minted. */
async function attachComputer(serverId: string, userId: string, name: string) {
  const { machine } = await registerMachine(serverId, userId, name);
  const material = await generateComputerApiKeyMaterial();
  const [computer] = await getDb().insert(computers).values({
    serverId, name, apiKeyHash: material.apiKeyHash, apiKeyPrefix: material.apiKeyPrefix, apiKeyHmac: material.apiKeyHmac,
    attachedByUserId: userId, machineId: machine.id,
  }).returning();
  const agent = await createAgent(serverId, `${name}-agent`, { runtime: "external", creatorType: "user", creatorId: userId });
  await getDb().update(agents).set({ machineId: machine.id, status: "active" }).where(eq(agents.id, agent.id));
  const runner = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: `${name}-runner`, issuedVia: "computer", createdByUserId: null });
  await getDb().update(agentCredentials).set({ issuedByMachineId: machine.id }).where(eq(agentCredentials.id, runner.credentialId));
  return { computerId: computer!.id, machineId: machine.id, apiKey: material.apiKey, agentId: agent.id, runnerCredentialId: runner.credentialId };
}

async function preflight(baseUrl: string, apiKey: string): Promise<number> {
  const res = await fetch(`${baseUrl}/internal/computer/preflight`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  await res.body?.cancel();
  return res.status;
}

async function keyRevocationAudits(serverId: string) {
  return getDb().select({
    eventType: integrationAuditEvents.eventType,
    actorId: integrationAuditEvents.actorId,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, serverId),
    inArray(integrationAuditEvents.eventType, ["computer.key_revoked", "membership.removed"]),
  ));
}

async function credentialRevokedAt(credentialId: string) {
  return (await getDb().select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, credentialId)))[0]!.revokedAt;
}

async function setup(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const person = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner, members: [person, colleague] });
  const other = await seed.server({ owner, members: [person] });
  const theirs = await attachComputer(server.id, person.id, "their-laptop");
  const colleagues = await attachComputer(server.id, colleague.id, "colleague-box");
  const elsewhere = await attachComputer(other.id, person.id, "their-laptop-elsewhere");
  return { owner, person, colleague, server, other, theirs, colleagues, elsewhere };
}

test("an admin removes a member: the Computers they attached here are revoked and audited; others' and their other server's are not", async ({ app, seed }) => {
  const { person, server, other, theirs, colleagues, elsewhere } = await setup(seed);
  const admin = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 200);
  const { token } = await signInForTest(admin.id);

  const removed = await call(app.baseUrl, token, "DELETE", `/api/servers/${server.id}/members/${person.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 401, "the removed member's Computer key is refused");
  assert.ok(await credentialRevokedAt(theirs.runnerCredentialId), "what its machine minted is revoked");
  const [revoked] = await getDb().select().from(computers).where(eq(computers.id, theirs.computerId));
  assert.equal(revoked!.revokedByUserId, admin.id);
  const [bound] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, theirs.agentId));
  assert.equal(bound!.machineId, theirs.machineId, "the agent on it stays bound");

  assert.equal(await preflight(app.baseUrl, colleagues.apiKey), 200, "another member's Computer is untouched");
  assert.equal(await credentialRevokedAt(colleagues.runnerCredentialId), null);
  assert.equal(await preflight(app.baseUrl, elsewhere.apiKey), 200, "their Computer on a server they are still in is untouched");
  assert.equal(await credentialRevokedAt(elsewhere.runnerCredentialId), null);

  const audits = await keyRevocationAudits(server.id);
  const keyRevoked = audits.filter((row) => row.eventType === "computer.key_revoked");
  assert.equal(keyRevoked.length, 1);
  assert.equal(keyRevoked[0]!.actorId, admin.id);
  assert.equal(keyRevoked[0]!.targetId, theirs.computerId);
  const membership = audits.find((row) => row.eventType === "membership.removed")!;
  assert.deepEqual(
    { via: keyRevoked[0]!.metadata.via, departureReason: keyRevoked[0]!.metadata.departureReason, actorRole: keyRevoked[0]!.metadata.actorRole, revokedCount: keyRevoked[0]!.metadata.revokedCount, operationId: keyRevoked[0]!.metadata.operationId },
    { via: "member_removed", departureReason: "removed", actorRole: "admin", revokedCount: 1, operationId: membership.metadata.operationId },
  );
  const credentialAudit = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "agent_credential.revoked"), eq(integrationAuditEvents.targetId, theirs.runnerCredentialId)));
  assert.equal(credentialAudit.length, 1);
  assert.equal(credentialAudit[0]!.metadata.departureReason, "removed");
  assert.deepEqual(await keyRevocationAudits(other.id), []);
});

test("a member leaves: the Computers they attached here are revoked, attributed to them", async ({ app, seed }) => {
  const { person, server, other, theirs, colleagues, elsewhere } = await setup(seed);
  const { token } = await signInForTest(person.id);

  const left = await call(app.baseUrl, token, "POST", `/api/servers/${server.id}/leave`);
  assert.equal(left.status, 200, JSON.stringify(left.body));

  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 401);
  assert.ok(await credentialRevokedAt(theirs.runnerCredentialId));
  assert.equal(await preflight(app.baseUrl, colleagues.apiKey), 200);
  assert.equal(await preflight(app.baseUrl, elsewhere.apiKey), 200);
  const keyRevoked = (await keyRevocationAudits(server.id)).filter((row) => row.eventType === "computer.key_revoked");
  assert.equal(keyRevoked.length, 1);
  assert.equal(keyRevoked[0]!.actorId, person.id);
  assert.equal(keyRevoked[0]!.metadata.via, "member_removed");
  assert.equal(keyRevoked[0]!.metadata.departureReason, "left");
  assert.equal(keyRevoked[0]!.metadata.actorRole, "member");
  assert.deepEqual(await keyRevocationAudits(other.id), []);
});

test("a demotion revokes nothing: the Computer's key still works", async ({ app, seed }) => {
  const { owner, person, server, theirs } = await setup(seed);
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, person.id)));
  const { token } = await signInForTest(owner.id);

  const demoted = await call(app.baseUrl, token, "PATCH", `/api/servers/${server.id}/members/${person.id}`, { role: "member" });
  assert.equal(demoted.status, 200, JSON.stringify(demoted.body));

  assert.equal(await preflight(app.baseUrl, theirs.apiKey), 200);
  assert.equal(await credentialRevokedAt(theirs.runnerCredentialId), null);
  assert.deepEqual((await keyRevocationAudits(server.id)).filter((row) => row.eventType === "computer.key_revoked"), []);
});

// Who hears that the Computers revoked with a membership are offline (reason
// member_left): an agent's creator who is still here and is not the person
// who left, else every owner, once per Computer naming its agents. Read after
// the leave, so an owner made just before is found (Tenny, Warden, 2026-11-09).

/** The system notices naming `computerName`, each with its DM's participant key (the human's and the agent's ids). */
async function noticesNaming(computerName: string) {
  const rows = await getDb().select({ channelId: messages.channelId, content: messages.content }).from(messages)
    .where(and(eq(messages.messageType, "system"), like(messages.content, `%"${computerName}"%`)));
  return Promise.all(rows.map(async (row) => {
    const [dm] = await getDb().select({ peerKey: dmChannelIdentities.peerKey }).from(dmChannelIdentities).where(eq(dmChannelIdentities.channelId, row.channelId));
    return { content: row.content, peerKey: dm?.peerKey ?? "" };
  }));
}

test("the owner sets up, attaches a Computer, makes someone else owner and leaves: only the new owner is told, once, naming the Computer and its agents", async ({ app, seed }) => {
  const founder = await seed.human();
  const successor = await seed.human();
  const server = await seed.server({ owner: founder, members: [successor] });
  const box = await attachComputer(server.id, founder.id, "founders-box");
  const second = await createAgent(server.id, "founders-box-helper", { runtime: "external", creatorType: "user", creatorId: founder.id });
  await getDb().update(agents).set({ machineId: box.machineId, status: "active" }).where(eq(agents.id, second.id));
  const { token } = await signInForTest(founder.id);

  const transferred = await call(app.baseUrl, token, "PATCH", `/api/servers/${server.id}/members/${successor.id}`, { role: "owner" });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  const left = await call(app.baseUrl, token, "POST", `/api/servers/${server.id}/leave`);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(await preflight(app.baseUrl, box.apiKey), 401, "the Computer went with the founder's membership");

  const told = await noticesNaming("founders-box");
  assert.equal(told.length, 1, JSON.stringify(told));
  assert.ok(told[0]!.peerKey.includes(successor.id), "the new owner is told");
  assert.ok(!told.some((notice) => notice.peerKey.includes(founder.id)), "the person who left is not told");
  assert.equal(
    told[0]!.content,
    "@founders-box-agent and @founders-box-helper are offline: the computer \"founders-box\" they run on was disconnected because the person who set it up is no longer in this server. "
      + "Someone in this server can set up that machine again (the agents come back as they were), or move the agents to another computer.",
  );
});

test("a member leaves: an agent whose creator stays tells its creator; the leaver's own agent tells the owners", async ({ app, seed }) => {
  const owner = await seed.human();
  const person = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner, members: [person, colleague] });
  const laptop = await attachComputer(server.id, person.id, "shared-laptop");
  const colleagues = await createAgent(server.id, "colleagues-agent", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop.machineId, status: "active" }).where(eq(agents.id, colleagues.id));
  const { token } = await signInForTest(person.id);

  const left = await call(app.baseUrl, token, "POST", `/api/servers/${server.id}/leave`);
  assert.equal(left.status, 200, JSON.stringify(left.body));

  const told = await noticesNaming("shared-laptop");
  assert.equal(told.length, 2, JSON.stringify(told));
  const toColleague = told.find((notice) => notice.peerKey.includes(colleague.id))!;
  assert.match(
    toColleague.content,
    /^@colleagues-agent is offline: the computer "shared-laptop" it runs on was disconnected because the person who set it up is no longer in this server\. Someone in this server can set up that machine again \(the agent comes back as it was\), or move the agent to another computer\.\nAgent page: /,
  );
  const toOwner = told.find((notice) => notice.peerKey.includes(owner.id))!;
  assert.match(toOwner.content, /^@shared-laptop-agent is offline: the computer "shared-laptop" it runs on was disconnected because/);
  assert.ok(!toOwner.content.includes("colleagues-agent"), "the colleague's agent is the colleague's to hear about");
  assert.ok(!told.some((notice) => notice.peerKey.includes(person.id)), "the person who left is not told");
});

test("the owner removes a member who attached a Computer and made its agent: the owner is told once, the removed member not at all", async ({ app, seed }) => {
  const owner = await seed.human();
  const person = await seed.human();
  const server = await seed.server({ owner, members: [person] });
  await attachComputer(server.id, person.id, "removed-box");
  const { token } = await signInForTest(owner.id);

  const removed = await call(app.baseUrl, token, "DELETE", `/api/servers/${server.id}/members/${person.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  // The departed person is the removed member, not the remover: the owner who
  // removed them is the one left to tell about the agent.
  const told = await noticesNaming("removed-box");
  assert.equal(told.length, 1, JSON.stringify(told));
  assert.ok(told[0]!.peerKey.includes(owner.id), "the owner is told");
  assert.match(told[0]!.content, /^@removed-box-agent is offline: the computer "removed-box" it runs on was disconnected because the person who set it up is no longer in this server\./);
  assert.ok(!told.some((notice) => notice.peerKey.includes(person.id)), "the removed member is not told");
});
