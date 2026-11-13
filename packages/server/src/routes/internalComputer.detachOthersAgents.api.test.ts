import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, messages } from "../db/schema";
import { findOthersAgentsOnComputers } from "../services/accountDeletion/requests";
import { createAgent } from "../services/agentService";
import { MachineKeyRevokedError } from "../services/computerAgents";
import { attachComputer } from "../services/computerCredentialService";
import { issueComputerRevokeToken, revokeComputerByLink } from "../services/computerKeyRevocation";
import * as channelService from "../services/channelService";
import type { createSeed } from "../test/integration/seed";

// `raft-computer detach <server>` (POST /internal/computer/detach, the Computer's own key) is gated like the web
// revoke (routes/servers.ts revoke-computer-key) and the account deletion request: someone else's live agent on
// the machine refuses it, 409 `others_agents_on_computer`, until it is moved or `forceAgentIds` names every one
// (Tenny, #triage:d10ace06 msg=670f6e97). Otherwise the command line got around both gates. The revoke link and
// the security cascades stay ungated.

const test = createApiTest();

type Json = Record<string, any>;

async function detach(baseUrl: string, apiKey: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${baseUrl}/internal/computer/detach`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json };
}

/** The person's attached laptop (a real Computer key) in a shared server, with a colleague's agent, an agent an agent made, and their own. */
async function seedLaptop(seed: ReturnType<typeof createSeed>) {
  const human = await seed.human({ name: "Laptop Owner" });
  const colleague = await seed.human({ name: "Colleague" });
  const server = await seed.server({ owner: human, members: [colleague], name: "Home" });
  const attached = await attachComputer({ userId: human.id, serverSlug: server.slug, name: "laptop" });
  assert.ok(attached.ok, "attach");
  const laptop = { apiKey: attached.apiKey, computerId: attached.serverMachineId, machineId: attached.machineId };
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const byAgent = await createAgent(server.id, "by-agent", { runtime: "external", creatorType: "agent", creatorId: alpha.id });
  const mine = await createAgent(server.id, "mine", { runtime: "external", creatorType: "user", creatorId: human.id });
  await getDb().update(agents).set({ machineId: laptop.machineId, status: "active" }).where(inArray(agents.id, [alpha.id, byAgent.id, mine.id]));
  return { human, colleague, server, laptop, alpha, byAgent, mine };
}

async function keyRevokedAt(computerId: string) {
  return (await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.id, computerId)))[0]!.revokedAt;
}

async function placement(ids: string[]) {
  const rows = await getDb().select({ id: agents.id, machineId: agents.machineId, status: agents.status, reason: agents.machineReleaseReason, deletedAt: agents.deletedAt })
    .from(agents).where(inArray(agents.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function systemNotices(serverId: string, ownerId: string, agentId: string): Promise<string[]> {
  const dm = await channelService.findOrCreateDM(serverId, ownerId, agentId);
  const rows = await getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
  return rows.map((row) => row.content);
}

test("detach with someone else's agents on the machine: a 409 listing them, nothing changed, and the account deletion gate still holds", async ({ app, seed }) => {
  const { human, colleague, server, laptop, alpha, byAgent, mine } = await seedLaptop(seed);

  const conflict = await detach(app.baseUrl, laptop.apiKey);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "others_agents_on_computer");
  assert.deepEqual(conflict.body.agents, [
    { id: alpha.id, name: "alpha", owner: { id: colleague.id, name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
    { id: byAgent.id, name: "by-agent", owner: null, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
  ]);

  assert.equal(await keyRevokedAt(laptop.computerId), null, "the key stays live: the Computer keeps its local credential");
  const rows = await placement([alpha.id, byAgent.id, mine.id]);
  for (const row of rows.values()) assert.deepEqual([row.machineId, row.status, row.reason], [laptop.machineId, "active", null]);
  const audits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), inArray(integrationAuditEvents.eventType, ["computer.key_revoked", "computer.revoke_unbound_others_agents"])));
  assert.deepEqual(audits, []);
  assert.deepEqual(await systemNotices(server.id, colleague.id, alpha.id), []);
  // Still attached, so the account deletion request still sees the colleague's agent.
  assert.deepEqual((await findOthersAgentsOnComputers(getDb(), human.id)).map((agent) => agent.id), [alpha.id, byAgent.id]);

  // Once they are moved, the detach goes ahead; the person's own agent does not block and stays bound.
  await getDb().update(agents).set({ machineId: null }).where(inArray(agents.id, [alpha.id, byAgent.id]));
  const detached = await detach(app.baseUrl, laptop.apiKey);
  assert.deepEqual(detached, { status: 200, body: { ok: true, computerId: laptop.computerId, machineId: laptop.machineId, unboundAgentIds: [] } });
  assert.ok(await keyRevokedAt(laptop.computerId));
  assert.equal((await placement([mine.id])).get(mine.id)?.machineId, laptop.machineId);
});

test("detach forceAgentIds: a bad list is a 400; missing one is the 409; naming all unbinds and stops them with the release marker, audits, tells their owners", async ({ app, seed }) => {
  const { colleague, server, laptop, alpha, byAgent, mine } = await seedLaptop(seed);
  for (const forceAgentIds of ["x", [1], [""], Array.from({ length: 201 }, () => randomUUID())]) {
    const refused = await detach(app.baseUrl, laptop.apiKey, { forceAgentIds });
    assert.deepEqual([refused.status, refused.body.code], [400, "invalid_force_agent_ids"], JSON.stringify(forceAgentIds).slice(0, 60));
  }
  const missing = await detach(app.baseUrl, laptop.apiKey, { forceAgentIds: [alpha.id] });
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.body.agents.map((agent: { id: string }) => agent.id), [alpha.id, byAgent.id], "the fresh full list");
  assert.equal(await keyRevokedAt(laptop.computerId), null);

  const forced = await detach(app.baseUrl, laptop.apiKey, { forceAgentIds: [byAgent.id, alpha.id, randomUUID()] });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual([...forced.body.unboundAgentIds].sort(), [alpha.id, byAgent.id].sort());
  assert.ok(await keyRevokedAt(laptop.computerId));
  const rows = await placement([alpha.id, byAgent.id, mine.id]);
  for (const id of [alpha.id, byAgent.id]) {
    assert.deepEqual(rows.get(id), { id, machineId: null, status: "stopped", reason: "forced_by_computer_owner", deletedAt: null }, "unbound, stopped, released; not deleted");
  }
  assert.deepEqual([rows.get(mine.id)?.machineId, rows.get(mine.id)?.status], [laptop.machineId, "active"], "their own agent stays");

  const [audit, ...more] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.revoke_unbound_others_agents")));
  assert.equal(more.length, 0);
  assert.deepEqual([audit!.actorType, audit!.actorId, audit!.source, audit!.requesterId, audit!.targetId], ["system", laptop.computerId, "cli", null, laptop.machineId], "the Computer's key is the actor, no person");
  assert.deepEqual([...(audit!.metadata.agentIds as string[])].sort(), [alpha.id, byAgent.id].sort());
  assert.deepEqual([audit!.metadata.via, audit!.metadata.computerId], ["detach", laptop.computerId]);
  // The key revoke shares the operation.
  const [keyAudit] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, laptop.computerId)));
  assert.equal(keyAudit!.metadata.operationId, audit!.metadata.operationId);

  const told = await systemNotices(server.id, colleague.id, alpha.id);
  assert.equal(told.length, 1);
  assert.match(told[0]!, /@alpha is offline: the computer "laptop" it runs on was detached/);
});

test("a machine whose Computer detached takes no agent; the revoke link (a security path) is not gated", async ({ app, seed }) => {
  const { human, laptop, alpha, byAgent, server } = await seedLaptop(seed);
  await getDb().update(agents).set({ machineId: null }).where(inArray(agents.id, [alpha.id, byAgent.id]));
  assert.equal((await detach(app.baseUrl, laptop.apiKey)).status, 200);
  await getDb().update(agents).set({ runtime: "claude" }).where(eq(agents.id, alpha.id));
  await assert.rejects(createAgent(server.id, "after-detach", { runtime: "claude", machineId: laptop.machineId }), MachineKeyRevokedError);

  // A second Computer with a colleague's agent on it: the mailed revoke link revokes it anyway, nothing unbound.
  const second = await attachComputer({ userId: human.id, serverSlug: server.slug, name: "desktop" });
  assert.ok(second.ok);
  await getDb().update(agents).set({ machineId: second.machineId, status: "active", runtime: "external" }).where(eq(agents.id, alpha.id));
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "detach-gate-test-pepper-0123456789abcdef";
  let viaLink: Awaited<ReturnType<typeof revokeComputerByLink>>;
  try {
    viaLink = await revokeComputerByLink(await issueComputerRevokeToken({ computerId: second.serverMachineId, grantId: null }));
  } finally {
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
  }
  assert.equal(viaLink.ok, true);
  assert.ok(await keyRevokedAt(second.serverMachineId));
  const row = (await placement([alpha.id])).get(alpha.id)!;
  assert.deepEqual([row.machineId, row.reason], [second.machineId, null], "still bound: offline, not unbound");
});

test("an adopted legacy machine (registered by someone else): other people's agents are judged as the machine's person (machines.user_id) sees them, as on the web", async ({ app, seed }) => {
  const { human: adopter, colleague: registrant, server, laptop, mine } = await seedLaptop(seed);
  // The colleague registered the machine; the person adopted it, so its Computer's attacher differs from the machine's person.
  await getDb().update(machines).set({ userId: registrant.id }).where(eq(machines.id, laptop.machineId));
  const [computer] = await getDb().select({ attachedByUserId: computers.attachedByUserId }).from(computers).where(eq(computers.id, laptop.computerId));
  assert.equal(computer!.attachedByUserId, adopter.id);
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.machineId, laptop.machineId));
  const registrantsAgent = await createAgent(server.id, "registrants", { runtime: "external", creatorType: "user", creatorId: registrant.id });
  await getDb().update(agents).set({ machineId: laptop.machineId, status: "active" }).where(inArray(agents.id, [registrantsAgent.id, mine.id]));

  const conflict = await detach(app.baseUrl, laptop.apiKey);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.deepEqual(conflict.body.agents.map((agent: { id: string }) => agent.id), [mine.id], "the adopter's agent blocks; the machine's person's does not");
  assert.equal(await keyRevokedAt(laptop.computerId), null);

  const forced = await detach(app.baseUrl, laptop.apiKey, { forceAgentIds: [mine.id] });
  assert.deepEqual([forced.status, forced.body.unboundAgentIds], [200, [mine.id]]);
  const rows = await placement([registrantsAgent.id, mine.id]);
  assert.deepEqual([rows.get(mine.id)?.machineId, rows.get(mine.id)?.reason], [null, "forced_by_computer_owner"]);
  assert.deepEqual([rows.get(registrantsAgent.id)?.machineId, rows.get(registrantsAgent.id)?.reason], [laptop.machineId, null], "the machine's person's agent stays bound");
});
