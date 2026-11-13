import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, messages, serverMembers } from "../db/schema";
import { findOthersAgentsOnComputers } from "../services/accountDeletion/requests";
import { AGENT_OWNER_NOTICE_INTERVAL_MS } from "../services/accountDeletion/ownerNotices";
import { autoAssignMachine, createAgent, getAgent } from "../services/agentService";
import { MachineKeyRevokedError } from "../services/computerAgents";
import * as channelService from "../services/channelService";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";

// Revoking one Computer's key from the web (POST /servers/:id/machines/:machineId/revoke-computer-key) is refused
// while other people's agents are on it, like asking to delete one's account (artin/Tenny, #triage:d10ace06):
// 409 `others_agents_on_computer`, its notify-agent-owners, forceAgentIds. And no agent is bound to a machine
// whose Computer key was revoked (create, auto-assign).

const test = createApiTest();

type Json = Record<string, any>;

/** `serverId` defaults to the one in a /api/servers/:id path (requireServerMatchesParam wants it in X-Server-Id). */
async function call(baseUrl: string, token: string, method: string, path: string, body?: unknown, serverIdHeader?: string): Promise<{ status: number; body: Json }> {
  const serverId = serverIdHeader ?? /^\/api\/servers\/([^/]+)\//.exec(path)?.[1];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json };
}

/** A machine row for `userId`, optionally with a linked Computer row (`revoked` soft-revokes it). */
async function seedMachine(serverId: string, userId: string, name: string, computer?: "live" | "revoked") {
  const [machine] = await getDb().insert(machines).values({ serverId, userId, name, apiKeyHash: `hash-${randomUUID()}`, runtimes: ["claude"] }).returning();
  if (computer) {
    await getDb().insert(computers).values({
      serverId, name, machineId: machine!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
      attachedByUserId: userId, revokedAt: computer === "revoked" ? new Date() : null,
    });
  }
  return machine!;
}

/**
 * The person's live laptop in a shared server with a colleague's agent, an agent an agent made (nobody to ask),
 * and their own agent on it; the colleague's own box. No personal assistant: one is never on a machine
 * (agents_assistant_not_on_machine).
 */
async function seedLaptop(seed: ReturnType<typeof createSeed>) {
  const human = await seed.human({ name: "Laptop Owner" });
  const colleague = await seed.human({ name: "Colleague" });
  const server = await seed.server({ owner: human, members: [colleague], name: "Home" });
  const laptop = await seedMachine(server.id, human.id, "laptop", "live");
  const theirBox = await seedMachine(server.id, colleague.id, "their-box", "live");
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const byAgent = await createAgent(server.id, "by-agent", { runtime: "external", creatorType: "agent", creatorId: alpha.id });
  const mine = await createAgent(server.id, "mine", { runtime: "external", creatorType: "user", creatorId: human.id });
  await getDb().update(agents).set({ machineId: laptop.id, status: "active" }).where(inArray(agents.id, [alpha.id, byAgent.id, mine.id]));
  const session = await signInForTest(human.id);
  return { human, colleague, server, laptop, theirBox, alpha, byAgent, mine, token: session.token };
}

const revokePath = (serverId: string, machineId: string) => `/api/servers/${serverId}/machines/${machineId}/revoke-computer-key`;
const notifyPath = (serverId: string, machineId: string) => `/api/servers/${serverId}/machines/${machineId}/notify-agent-owners`;

async function laptopKeyRevokedAt(machineId: string) {
  return (await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, machineId)))[0]!.revokedAt;
}

async function systemNotices(serverId: string, ownerId: string, agentId: string): Promise<string[]> {
  const dm = await channelService.findOrCreateDM(serverId, ownerId, agentId);
  const rows = await getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
  return rows.map((row) => row.content);
}

test("someone else's agents on the Computer: the revoke is a 409 listing them and changes nothing (nor gets around the account deletion gate)", async ({ app, seed }) => {
  const { human, colleague, server, laptop, alpha, byAgent, mine, token } = await seedLaptop(seed);

  const conflict = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), {});
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "others_agents_on_computer");
  // Not their own agent.
  assert.deepEqual(conflict.body.agents, [
    { id: alpha.id, name: "alpha", owner: { id: colleague.id, name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
    { id: byAgent.id, name: "by-agent", owner: null, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
  ]);

  // Nothing changed: the key live, every agent still bound and running, no audit, nobody told.
  assert.equal(await laptopKeyRevokedAt(laptop.id), null);
  const rows = await getDb().select({ machineId: agents.machineId, status: agents.status }).from(agents)
    .where(inArray(agents.id, [alpha.id, byAgent.id, mine.id]));
  assert.deepEqual(rows, Array(3).fill({ machineId: laptop.id, status: "active" }));
  const audits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), inArray(integrationAuditEvents.eventType, ["computer.key_revoked", "computer.revoke_unbound_others_agents"])));
  assert.deepEqual(audits, []);
  assert.deepEqual(await systemNotices(server.id, colleague.id, alpha.id), []);

  // F4: detaching the Computer first does not get around the account deletion's gate: it is still attached,
  // and the colleague's agent still blocks the deletion request.
  assert.deepEqual((await findOthersAgentsOnComputers(getDb(), human.id)).map((agent) => agent.id), [alpha.id, byAgent.id]);

  // Once they are moved, the revoke goes ahead as before; the person's own agent does not block.
  await getDb().update(agents).set({ machineId: null }).where(inArray(agents.id, [alpha.id, byAgent.id]));
  const revoked = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), {});
  assert.deepEqual(revoked, { status: 200, body: { ok: true, revokedComputers: 1, unboundAgentIds: [] } });
  assert.ok(await laptopKeyRevokedAt(laptop.id));
  assert.equal((await getAgent(mine.id))?.machineId, laptop.id, "the person's own agent stays on it");
});

test("an admin who did not attach it is not gated: the Computer goes offline with every agent still bound, their owners told", async ({ app, seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner, members: [admin, colleague] });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const box = await seedMachine(server.id, owner.id, "owners-box", "live");
  const ownersAgent = await createAgent(server.id, "owners-agent", { runtime: "external", creatorType: "user", creatorId: owner.id });
  const colleaguesAgent = await createAgent(server.id, "colleagues-agent", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: box.id, status: "active" }).where(inArray(agents.id, [ownersAgent.id, colleaguesAgent.id]));
  const { token } = await signInForTest(admin.id);

  const revoked = await call(app.baseUrl, token, "POST", revokePath(server.id, box.id), {});
  assert.deepEqual(revoked, { status: 200, body: { ok: true, revokedComputers: 1, unboundAgentIds: [] } });
  assert.ok(await laptopKeyRevokedAt(box.id), "the key is revoked: the Computer is offline");
  const rows = await getDb().select({ machineId: agents.machineId, status: agents.status }).from(agents)
    .where(inArray(agents.id, [ownersAgent.id, colleaguesAgent.id]));
  assert.deepEqual(rows, Array(2).fill({ machineId: box.id, status: "active" }), "nothing unbound");
  const unboundAudits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.revoke_unbound_others_agents")));
  assert.deepEqual(unboundAudits, []);
  for (const [ownerId, agentId, name] of [[owner.id, ownersAgent.id, "owners-agent"], [colleague.id, colleaguesAgent.id, "colleagues-agent"]] as const) {
    const told = await systemNotices(server.id, ownerId, agentId);
    assert.equal(told.length, 1, name);
    assert.match(told[0]!, new RegExp(`@${name} is offline: the computer "owners-box" it runs on was detached`));
  }
});

test("forceAgentIds: a bad list is a 400; missing a blocker is the 409 with nothing changed; naming all unbinds and stops them, audits, tells their owners", async ({ app, seed }) => {
  const { colleague, server, laptop, theirBox, alpha, byAgent, mine, token, human } = await seedLaptop(seed);
  const elsewhere = await createAgent(server.id, "elsewhere", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: theirBox.id, status: "active" }).where(eq(agents.id, elsewhere.id));
  for (const forceAgentIds of ["x", [1], [""], Array.from({ length: 201 }, () => randomUUID())]) {
    const refused = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), { forceAgentIds });
    assert.equal(refused.status, 400, JSON.stringify(forceAgentIds).slice(0, 60));
    assert.equal(refused.body.code, "invalid_force_agent_ids");
  }

  const missing = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), { forceAgentIds: [alpha.id] });
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.body.agents.map((agent: { id: string }) => agent.id), [alpha.id, byAgent.id], "the fresh full list");
  assert.equal(await laptopKeyRevokedAt(laptop.id), null);
  assert.equal((await getAgent(alpha.id))?.machineId, laptop.id);

  // Renamed on the Computers page (the machine's name; its Computer row keeps the old one): the notices use it.
  await getDb().update(machines).set({ name: "Laptop Pro" }).where(eq(machines.id, laptop.id));
  // Every blocker named, plus a stale id (an agent elsewhere) and an unknown one: ignored.
  const forced = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), { forceAgentIds: [alpha.id, byAgent.id, elsewhere.id, randomUUID()] });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual([...forced.body.unboundAgentIds].sort(), [alpha.id, byAgent.id].sort());
  assert.ok(await laptopKeyRevokedAt(laptop.id));
  const rows = await getDb().select({ id: agents.id, machineId: agents.machineId, status: agents.status, deletedAt: agents.deletedAt }).from(agents)
    .where(inArray(agents.id, [alpha.id, byAgent.id, mine.id, elsewhere.id]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of [alpha.id, byAgent.id]) assert.deepEqual(byId.get(id), { id, machineId: null, status: "stopped", deletedAt: null }, "unbound and stopped, not deleted");
  assert.deepEqual(byId.get(mine.id), { id: mine.id, machineId: laptop.id, status: "active", deletedAt: null }, "their own agent stays");
  assert.deepEqual(byId.get(elsewhere.id), { id: elsewhere.id, machineId: theirBox.id, status: "active", deletedAt: null }, "not on it: untouched");

  // One audit record on this server's audit page.
  const [audit, ...more] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.revoke_unbound_others_agents")));
  assert.equal(more.length, 0);
  assert.equal(audit!.actorId, human.id);
  assert.equal(audit!.eventCategory, "computer");
  assert.equal(audit!.targetId, laptop.id);
  assert.deepEqual({ ...audit!.metadata, agentIds: [...(audit!.metadata.agentIds as string[])].sort(), operationId: undefined }, {
    agentIds: [alpha.id, byAgent.id].sort(), machineId: laptop.id, actorRole: "owner", operationId: undefined,
  });

  // Each owner is told, as when a Computer is detached.
  const told = await systemNotices(server.id, colleague.id, alpha.id);
  assert.equal(told.length, 1);
  assert.match(told[0]!, /@alpha is offline: the computer "Laptop Pro" it runs on was detached/);

  // Unbound by force, it stays off every Computer (Tenny, PR #12858):
  // the next Computer that comes online does not take it (a Computer runtime: auto-assign skips external
  // agents anyway, so alpha is made one here).
  await getDb().update(agents).set({ runtime: "claude" }).where(eq(agents.id, alpha.id));
  const release = async (id: string) => (await getDb().select({ reason: agents.machineReleaseReason, at: agents.machineReleasedAt }).from(agents).where(eq(agents.id, id)))[0]!;
  const released = await release(alpha.id);
  assert.equal(released.reason, "forced_by_computer_owner");
  assert.ok(released.at, "marked in the force's transaction");
  assert.deepEqual(await release(mine.id), { reason: null, at: null }, "not their own agent");
  await autoAssignMachine(server.id, theirBox.id);
  assert.equal((await getAgent(alpha.id))?.machineId, null, "not auto-assigned after a force");
});

test("notify-agent-owners: whoever may revoke asks each blocker's owner by a system notice, once per 24 hours; the 409 carries when", async ({ app, seed }) => {
  const { human, colleague, server, laptop, alpha, byAgent, mine, token } = await seedLaptop(seed);
  const member = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const memberToken = (await signInForTest(member.id)).token;
  const NOTIFY = notifyPath(server.id, laptop.id);

  assert.equal((await call(app.baseUrl, memberToken, "POST", NOTIFY, { agentIds: [alpha.id] })).status, 403, "a member who did not attach it");
  assert.equal((await call(app.baseUrl, token, "POST", notifyPath(server.id, randomUUID()), { agentIds: [alpha.id] })).status, 404);
  for (const body of [{}, { agentIds: [] }, { agentIds: [1] }]) {
    const refused = await call(app.baseUrl, token, "POST", NOTIFY, body);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_agent_ids");
  }

  const first = await call(app.baseUrl, token, "POST", NOTIFY, { agentIds: [alpha.id, mine.id, byAgent.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const notifiedAt = first.body.notified[0]?.notifiedAt as string;
  assert.deepEqual(first.body, {
    notified: [{ agentId: alpha.id, notifiedAt }],
    skipped: [{ agentId: mine.id, reason: "not_on_your_computer" }, { agentId: byAgent.id, reason: "no_owner" }],
  });
  const notices = await systemNotices(server.id, colleague.id, alpha.id);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Please move @alpha to another computer\. The computer "laptop" it runs on is about to be detached/);
  for (const secret of [human.email, human.name]) assert.ok(!notices[0]!.includes(secret), "nothing about the person");

  const nextAllowedAt = new Date(Date.parse(notifiedAt) + AGENT_OWNER_NOTICE_INTERVAL_MS).toISOString();
  assert.deepEqual((await call(app.baseUrl, token, "POST", NOTIFY, { agentIds: [alpha.id] })).body, {
    notified: [],
    skipped: [{ agentId: alpha.id, reason: "rate_limited", nextAllowedAt }],
  });
  assert.equal((await systemNotices(server.id, colleague.id, alpha.id)).length, 1);

  const conflict = await call(app.baseUrl, token, "POST", revokePath(server.id, laptop.id), {});
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.agents[0], { id: alpha.id, name: "alpha", owner: { id: colleague.id, name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: notifiedAt, ownerNextNotifyAt: nextAllowedAt });
});

test("no agent is bound to a machine whose Computer key was revoked: create and auto-assign refuse it; offline or legacy machines still take agents", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const revoked = await seedMachine(server.id, owner.id, "revoked-box", "revoked");
  const live = await seedMachine(server.id, owner.id, "live-box", "live");
  const legacy = await seedMachine(server.id, owner.id, "legacy-box");
  const { token } = await signInForTest(owner.id);

  // A machine that is merely offline (a live key, nobody connected) or a legacy machine still takes agents.
  for (const machine of [live, legacy]) {
    const placed = await createAgent(server.id, `on-${machine.name}`, { runtime: "claude", machineId: machine.id });
    assert.equal(placed.machineId, machine.id);
  }

  const created = await call(app.baseUrl, token, "POST", "/api/agents", { name: "on-revoked", runtime: "claude", machineId: revoked.id }, server.id);
  assert.equal(created.status, 409, JSON.stringify(created.body));
  assert.equal(created.body.code, "computer_key_revoked");
  await assert.rejects(createAgent(server.id, "on-revoked-direct", { runtime: "claude", machineId: revoked.id }), MachineKeyRevokedError);

  // Auto-assignment skips it: create picks a machine that still takes agents, the machine-online sweep binds nothing to it.
  await getDb().update(computers).set({ revokedAt: new Date() }).where(eq(computers.machineId, live.id));
  await getDb().update(machines).set({ apiKeyHash: "revoked:account_deletion_requested" }).where(eq(machines.id, legacy.id));
  const auto = await createAgent(server.id, "auto", { runtime: "claude" });
  assert.equal(auto.machineId, null, "every machine revoked: none");
  await autoAssignMachine(server.id, revoked.id);
  assert.equal((await getAgent(auto.id))?.machineId, null);
  const fresh = await seedMachine(server.id, owner.id, "fresh-box", "live");
  await autoAssignMachine(server.id, fresh.id);
  assert.equal((await getAgent(auto.id))?.machineId, fresh.id);
});
