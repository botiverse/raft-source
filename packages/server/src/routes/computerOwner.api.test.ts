import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents, computers, integrationAuditEvents, machines, notificationOutbox, serverMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { adoptLegacyMachine } from "../services/computerAdoptionService";
import { attachComputer } from "../services/computerCredentialService";
import { registerMachine } from "../services/machineService";
import { addMember, removeMember } from "../services/serverService";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";

// Computer owner v1 (#wg-rbac:#32): PUT /api/servers/:id/machines/:machineId/owner. Public (no owner) by
// default; owner/admin assign, transfer and clear; the current owner transfers or clears; the connector may
// only claim a Public Computer they connected; the new owner is a non-Guest person in the server. Audited,
// the new owner notified; leaving the server makes their Computers Public; a re-adoption keeps the owner.

const test = createApiTest();

type Json = Record<string, any>;
type Seed = ReturnType<typeof createSeed>;

async function call(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const serverId = /^\/api\/servers\/([^/]+)\//.exec(path)?.[1];
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json };
}

const ownerPath = (serverId: string, machineId: string) => `/api/servers/${serverId}/machines/${machineId}/owner`;

/** A machine row registered by `connectorId`, with a live Computer row they attached. */
async function seedComputer(serverId: string, connectorId: string, name = `box-${randomUUID().slice(0, 6)}`) {
  const [machine] = await getDb().insert(machines).values({ serverId, userId: connectorId, name, apiKeyHash: `hash-${randomUUID()}`, runtimes: ["claude"] }).returning();
  await getDb().insert(computers).values({
    serverId, name, machineId: machine!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`, attachedByUserId: connectorId,
  });
  return machine!;
}

async function setRole(serverId: string, userId: string, role: "admin" | "guest", guestChannelId?: string) {
  await getDb().update(serverMembers).set({ role, ...(guestChannelId ? { guestChannelId } : {}) })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

async function ownerOf(machineId: string) {
  return (await getDb().select({ ownerUserId: machines.ownerUserId }).from(machines).where(eq(machines.id, machineId)))[0]!.ownerUserId;
}

async function ownerAudits(serverId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "computer.owner_changed")))
    .orderBy(integrationAuditEvents.createdAt);
}

async function ownerNotices(receiverId: string) {
  return getDb().select({ eventKey: notificationOutbox.eventKey, category: notificationOutbox.category, payload: notificationOutbox.payload })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.receiverId, receiverId), like(notificationOutbox.eventKey, "computer_owner:%")));
}

/** A server: its owner, an admin, two members (one the connector), and a Computer the connector attached. */
async function seedServer(seed: Seed) {
  const owner = await seed.human({ name: "Server Owner" });
  const admin = await seed.human({ name: "Admin" });
  const connector = await seed.human({ name: "Connector" });
  const member = await seed.human({ name: "Member" });
  const server = await seed.server({ owner, members: [admin, connector, member] });
  await setRole(server.id, admin.id, "admin");
  const box = await seedComputer(server.id, connector.id, "connector-box");
  const token = async (userId: string) => (await signInForTest(userId)).token;
  return { owner, admin, connector, member, server, box, token };
}

test("a Computer is Public by default; an admin assigns it, the list shows the owner, the change is audited and the new owner told", async ({ app, seed }) => {
  const { admin, member, server, box, token } = await seedServer(seed);
  assert.equal(await ownerOf(box.id), null, "connecting never makes anyone the owner");
  const adminToken = await token(admin.id);

  const before = await call(app.baseUrl, adminToken, "GET", `/api/servers/${server.id}/machines`);
  assert.equal(before.status, 200);
  const listed = before.body.machines.find((m: Json) => m.id === box.id);
  assert.equal(listed.ownerUserId, null);
  assert.equal(listed.owner, null);

  const assigned = await call(app.baseUrl, adminToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: member.id });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.machine.id, box.id);
  assert.equal(assigned.body.machine.ownerUserId, member.id);
  assert.equal(assigned.body.machine.owner.id, member.id);
  assert.equal(assigned.body.machine.owner.displayName, "Member");
  assert.equal(assigned.body.machine.userId, box.userId, "the connector is unchanged");
  assert.equal(await ownerOf(box.id), member.id);

  const audits = await ownerAudits(server.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actorId, admin.id);
  assert.equal(audits[0]!.subjectId, member.id);
  assert.equal(audits[0]!.targetType, "machine");
  assert.equal(audits[0]!.targetId, box.id);
  assert.deepEqual(audits[0]!.metadata, {
    machineId: box.id, machineName: "connector-box", previousOwnerUserId: null, ownerUserId: member.id, reason: "transfer", actorRole: "admin",
  });

  const notices = await ownerNotices(member.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.category, "system_notice");
  assert.match(String((notices[0]!.payload as Json).body), /connector-box/);

  // The same owner again changes nothing: no audit, no notice.
  const again = await call(app.baseUrl, adminToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: member.id });
  assert.equal(again.status, 200);
  assert.equal((await ownerAudits(server.id)).length, 1);
  assert.equal((await ownerNotices(member.id)).length, 1);
});

test("the owner transfers to another member and the new owner makes it Public; admins clear too", async ({ app, seed }) => {
  const { owner, admin, connector, member, server, box, token } = await seedServer(seed);
  await getDb().update(machines).set({ ownerUserId: member.id }).where(eq(machines.id, box.id));

  const transferred = await call(app.baseUrl, await token(member.id), "PUT", ownerPath(server.id, box.id), { ownerUserId: connector.id });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  assert.equal(await ownerOf(box.id), connector.id);
  assert.equal((await ownerNotices(connector.id)).length, 1);

  // The previous owner no longer can.
  const stale = await call(app.baseUrl, await token(member.id), "PUT", ownerPath(server.id, box.id), { ownerUserId: null });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, "computer_owner_forbidden");

  const cleared = await call(app.baseUrl, await token(connector.id), "PUT", ownerPath(server.id, box.id), { ownerUserId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.machine.ownerUserId, null);
  assert.equal(cleared.body.machine.owner, null);

  // An admin assigns, transfers and clears; the server owner too.
  for (const [actor, next] of [[admin, owner.id], [admin, member.id], [owner, null]] as const) {
    const res = await call(app.baseUrl, await token(actor.id), "PUT", ownerPath(server.id, box.id), { ownerUserId: next });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await ownerOf(box.id), next);
  }
  const reasons = (await ownerAudits(server.id)).map((row) => (row.metadata as Json).reason);
  assert.deepEqual(reasons, ["transfer", "made_public", "transfer", "transfer", "made_public"]);
  assert.equal((await ownerNotices(owner.id)).length, 1);
});

test("the connector may only claim a Public Computer they connected; a plain member may do nothing", async ({ app, seed }) => {
  const { admin, connector, member, server, box, token } = await seedServer(seed);
  const connectorToken = await token(connector.id);
  const memberToken = await token(member.id);

  // A member who neither owns nor connected it.
  for (const next of [member.id, connector.id, null]) {
    const res = await call(app.baseUrl, memberToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: next });
    assert.equal(res.status, 403, `member -> ${next}`);
    assert.equal(res.body.code, "computer_owner_forbidden");
  }
  // The connector cannot hand a Public Computer to someone else.
  const handOff = await call(app.baseUrl, connectorToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: member.id });
  assert.equal(handOff.status, 403);

  const claimed = await call(app.baseUrl, connectorToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: connector.id });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(await ownerOf(box.id), connector.id);
  assert.equal(((await ownerAudits(server.id)).at(-1)!.metadata as Json).reason, "claim");
  assert.deepEqual(await ownerNotices(connector.id), [], "nobody is told about their own claim");

  // Owned by someone else: the connector cannot take it back.
  await getDb().update(machines).set({ ownerUserId: admin.id }).where(eq(machines.id, box.id));
  const retake = await call(app.baseUrl, connectorToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: connector.id });
  assert.equal(retake.status, 403);
  assert.equal(await ownerOf(box.id), admin.id);

  // A member who connected another Computer cannot claim this one.
  await getDb().update(machines).set({ ownerUserId: null }).where(eq(machines.id, box.id));
  await seedComputer(server.id, member.id, "member-box");
  const notTheirs = await call(app.baseUrl, memberToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: member.id });
  assert.equal(notTheirs.status, 403);
});

test("the new owner is a non-Guest person in this server: agents, assistants, Guests, outsiders and retired accounts are refused", async ({ app, seed }) => {
  const { admin, member, server, box, token } = await seedServer(seed);
  const adminToken = await token(admin.id);
  const guest = await seed.human({ name: "Guest" });
  const channel = await seed.channel({ server, members: [member] });
  await addMember(server.id, guest.id);
  await setRole(server.id, guest.id, "guest", channel.id);
  const outsider = await seed.human({ name: "Outsider" });
  const retired = await seed.human({ name: "Retired" });
  await addMember(server.id, retired.id);
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));
  const agent = await createAgent(server.id, "helper", { runtime: "external", creatorType: "user", creatorId: member.id });
  const assistant = await createAgent(server.id, "assistant", { runtime: "external", creatorType: "user", creatorId: member.id });
  await getDb().update(agents).set({ assistantOwnerUserId: member.id }).where(eq(agents.id, assistant.id));

  for (const [label, id] of [["agent", agent.id], ["assistant", assistant.id], ["guest", guest.id], ["outsider", outsider.id], ["retired", retired.id]] as const) {
    const res = await call(app.baseUrl, adminToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: id });
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "computer_owner_ineligible", label);
  }
  assert.equal(await ownerOf(box.id), null);
  assert.deepEqual(await ownerAudits(server.id), []);

  // A malformed body; a Computer of another server; a Guest actor.
  const malformed = await call(app.baseUrl, adminToken, "PUT", ownerPath(server.id, box.id), { ownerUserId: "nope" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "computer_owner_invalid");
  const other = await seed.server({ owner: admin });
  const elsewhere = await seedComputer(other.id, admin.id);
  const wrongServer = await call(app.baseUrl, adminToken, "PUT", ownerPath(server.id, elsewhere.id), { ownerUserId: member.id });
  assert.equal(wrongServer.status, 404);
  const guestCall = await call(app.baseUrl, await token(guest.id), "PUT", ownerPath(server.id, box.id), { ownerUserId: guest.id });
  assert.equal(guestCall.status, 403);
});

test("an owner who leaves the server leaves their Computers Public there only; deleting the users row sets it null", async ({ app, seed }) => {
  const { admin, member, server, box, token } = await seedServer(seed);
  const other = await seed.server({ owner: admin, members: [member] });
  const otherBox = await seedComputer(other.id, admin.id);
  await getDb().update(machines).set({ ownerUserId: member.id }).where(eq(machines.id, box.id));
  await getDb().update(machines).set({ ownerUserId: member.id }).where(eq(machines.id, otherBox.id));

  await removeMember(server.id, member.id, { reason: "removed", actorUserId: admin.id, actorRole: "admin" });
  assert.equal(await ownerOf(box.id), null);
  assert.equal(await ownerOf(otherBox.id), member.id, "their Computer on another server stays theirs");
  const audit = (await ownerAudits(server.id)).at(-1)!;
  assert.equal(audit.actorId, admin.id);
  assert.deepEqual(audit.metadata, {
    machineId: box.id, machineName: "connector-box", previousOwnerUserId: member.id, ownerUserId: null, reason: "owner_left_server", actorRole: "admin",
    // The removal's other audit rows share it.
    operationId: (audit.metadata as Json).operationId,
  });
  assert.match(String((audit.metadata as Json).operationId), /^[0-9a-f-]{36}$/);
  const listed = await call(app.baseUrl, await token(admin.id), "GET", `/api/servers/${server.id}/machines`);
  assert.equal(listed.body.machines.find((m: Json) => m.id === box.id).owner, null);

  // ON DELETE SET NULL: a users row that goes leaves the Computer Public (users are normally retired, not deleted).
  const gone = await seed.human();
  await addMember(other.id, gone.id);
  const goneBox = await seedComputer(other.id, admin.id);
  await getDb().update(machines).set({ ownerUserId: gone.id }).where(eq(machines.id, goneBox.id));
  await getDb().delete(serverMembers).where(eq(serverMembers.userId, gone.id));
  await getDb().delete(users).where(eq(users.id, gone.id));
  assert.equal(await ownerOf(goneBox.id), null);
});

test("transferring the owner leaves the connector's name-collision check as it was", async ({ seed }) => {
  const owner = await seed.human();
  const connector = await seed.human();
  const otherAdmin = await seed.human();
  const server = await seed.server({ owner, members: [connector, otherAdmin] });
  await setRole(server.id, connector.id, "admin");
  await setRole(server.id, otherAdmin.id, "admin");
  const first = await attachComputer({ userId: connector.id, serverSlug: server.slug, name: "laptop" });
  assert.ok(first.ok);
  await getDb().update(machines).set({ ownerUserId: otherAdmin.id }).where(eq(machines.id, first.machineId));

  // Still the connector's name: a second "laptop" from them collides; the new owner's does not.
  assert.deepEqual(await attachComputer({ userId: connector.id, serverSlug: server.slug, name: "laptop" }), { ok: false, error: "computer_name_collision" });
  const owners = await attachComputer({ userId: otherAdmin.id, serverSlug: server.slug, name: "laptop" });
  assert.ok(owners.ok, JSON.stringify(owners));
  // A freshly attached Computer is Public.
  assert.equal(await ownerOf(owners.machineId), null);
});

test("a re-adoption keeps the owner: an owned machine stays owned, a Public one stays Public", async ({ seed }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [admin, member] });
  await setRole(server.id, admin.id, "admin");

  const owned = await registerMachine(server.id, owner.id, "owned-legacy");
  await getDb().update(machines).set({ ownerUserId: member.id }).where(eq(machines.id, owned.machine.id));
  const publicOne = await registerMachine(server.id, owner.id, "public-legacy");

  for (const [legacy, expected] of [[owned, member.id], [publicOne, null]] as const) {
    const adopted = await adoptLegacyMachine({ userId: admin.id, legacyApiKey: legacy.apiKey });
    assert.ok(adopted.ok, JSON.stringify(adopted));
    assert.equal(adopted.machineId, legacy.machine.id);
    const [computer] = await getDb().select({ attachedByUserId: computers.attachedByUserId }).from(computers).where(eq(computers.machineId, legacy.machine.id));
    assert.equal(computer!.attachedByUserId, admin.id, "the adopter is the new connector");
    assert.equal(await ownerOf(legacy.machine.id), expected, "whoever re-adopts does not become the owner");
  }
});
