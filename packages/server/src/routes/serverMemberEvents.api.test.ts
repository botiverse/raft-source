import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  accountDeletionRequests,
  agents,
  notificationDeliveries,
  notificationEvents,
  notificationRecipients,
  oauthAccessRequests,
  oauthAccessTokens,
  oauthUserConsents,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { addMember, createServer, updateAgentMemberRole } from "../services/serverService";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { retireDueAccounts, runAccountDeletionCleanup } from "../services/accountDeletion/cleanup";
import { __setAppMemberRefKeyForTests, deriveAppMemberRef, getAppServerProjection } from "../services/appOutboundProjectionService";
import { createAgent, deleteAgent, updateAgent, updateAgentStatus } from "../services/agentService";
import { createOAuthClient, exchangeAccessRequest } from "../services/oauthService";
import { __setAppWebhookEncryptionKeyForTests, configureAppWebhook } from "../services/appWebhookConfigService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(prefix: string, suffix: string) {
  const name = `${prefix}-${suffix.slice(0, 8)}`;
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** A Server with an owner, two members, an agent and an app subscribed to server.member_removed. */
async function seedSubscribedServer(events: string[] = ["server.member_removed"]) {
  const suffix = randomUUID();
  const owner = await seedUser("sme-owner", suffix);
  const signedIn = await seedUser("sme-signed-in", suffix);
  const leaver = await seedUser("sme-leaver", suffix);
  const server = await createServer("Server Member Events", `server-member-events-${suffix.slice(0, 8)}`, owner.id);
  await addMember(server.id, signedIn.id, "member");
  await addMember(server.id, leaver.id, "admin");
  const agent = await createAgent(server.id, `MemberEventBot${suffix.slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `sme-${suffix.slice(0, 8)}`,
    name: "Member Events App",
    returnUrl: "https://vault.example.test/callback",
  });
  await getDb().update(oauthClients).set({
    outboundCurrentGroups: ["server"],
    outboundCurrentEvents: events,
  }).where(eq(oauthClients.id, client.id));
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    approvedGroups: ["server"],
    subscribedEvents: events,
    grantRevision: 1,
    subscriptionRevision: 1,
  }).onConflictDoUpdate({
    target: [oauthClientInstalls.serverId, oauthClientInstalls.clientId],
    set: { approvedGroups: ["server"], subscribedEvents: events, status: "active" },
  });
  await configureAppWebhook({ clientId: client.id, actorUserId: owner.id, endpointUrl: "https://vault.example.test/raft" });

  // signedIn has a live Sign in with Raft token for this app on this Server.
  await getDb().insert(oauthAccessTokens).values({
    serverId: server.id,
    principalType: "human",
    userId: signedIn.id,
    clientId: client.id,
    tokenHash: `sme-${suffix}`,
    scopes: ["openid", "profile"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { owner, signedIn, leaver, server, agent, client };
}

async function memberRemovedEvents(serverId: string) {
  return memberEvents(serverId, "server.member_removed");
}

async function memberEvents(serverId: string, eventType: string) {
  const rows = await getDb().select({
    event: notificationEvents,
    deliveryStatus: notificationDeliveries.status,
  }).from(notificationEvents)
    .innerJoin(notificationRecipients, eq(notificationRecipients.eventId, notificationEvents.id))
    .innerJoin(notificationDeliveries, eq(notificationDeliveries.notificationId, notificationRecipients.id))
    .where(and(eq(notificationEvents.serverId, serverId), eq(notificationEvents.eventType, eventType)));
  return rows.map(({ event, deliveryStatus }) => ({
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    provenance: event.provenance,
    deliveryQueued: deliveryStatus === "pending" || deliveryStatus === "processing" || deliveryStatus === "suppressed" || deliveryStatus === "delivered",
  }));
}

function serverHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
}

test.beforeEach(() => {
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));
});

test.afterEach(() => {
  __setAppWebhookEncryptionKeyForTests(null);
});

test("an admin removal queues server.member_removed in the same commit and revokes the member's sign-in tokens", async ({ app }) => {
  const { owner, signedIn, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${signedIn.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  assert.deepEqual(await memberRemovedEvents(server.id), [{
    subjectType: "member",
    subjectId: signedIn.id,
    provenance: { actor_type: "human", principal_type: "human", reason: "removed", role: "member", source: "server_service" },
    deliveryQueued: true,
  }]);
  const tokens = await getDb().select({ revokedAt: oauthAccessTokens.revokedAt }).from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.serverId, server.id), eq(oauthAccessTokens.userId, signedIn.id)));
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0]!.revokedAt instanceof Date, "a removed member must sign in again after rejoining");
});

test("leaving a Server queues server.member_removed with reason left", async ({ app }) => {
  const { leaver, server } = await seedSubscribedServer();
  const leaverToken = await tokenForHuman(leaver.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, {
    method: "POST",
    headers: serverHeaders(leaverToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.subjectId, leaver.id);
  assert.deepEqual(events[0]!.provenance, {
    actor_type: "human", principal_type: "human", reason: "left", role: "admin", source: "server_service",
  });
});

test("deleting an agent queues server.member_removed for the agent", async ({ app }) => {
  const { owner, agent, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.subjectId, agent.id);
  assert.equal(events[0]!.provenance.principal_type, "agent");
  assert.equal(events[0]!.provenance.reason, "removed");
});

test("deleting a Server announces every member's removal before the tombstone", async ({ app }) => {
  const { owner, signedIn, leaver, agent, server } = await seedSubscribedServer();
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    method: "DELETE",
    headers: serverHeaders(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const events = await memberRemovedEvents(server.id);
  assert.deepEqual(
    events.map((event) => event.subjectId).sort(),
    [owner.id, signedIn.id, leaver.id, agent.id].sort(),
  );
  assert.ok(events.every((event) => event.provenance.reason === "server_deleted" && event.deliveryQueued));

  // A repeated delete of an already-deleted Server announces nothing new.
  await fetch(`${app.baseUrl}/api/servers/${server.id}`, { method: "DELETE", headers: serverHeaders(ownerToken, server.id) });
  const again = await getDb().select({ id: notificationEvents.id }).from(notificationEvents)
    .where(and(eq(notificationEvents.serverId, server.id), inArray(notificationEvents.eventType, ["server.member_removed"])));
  assert.equal(again.length, 4);
});

test("joining through a join link queues server.member_added; a role change queues server.member_role_changed", async ({ app }) => {
  const { owner, signedIn, server } = await seedSubscribedServer(["server.member_added", "server.member_role_changed"]);
  const ownerToken = await tokenForHuman(owner.email);
  const joiner = await seedUser("sme-joiner", randomUUID());

  const link = await fetch(`${app.baseUrl}/api/servers/${server.id}/join-links`, {
    method: "POST",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ maxUses: 1 }),
  });
  assert.equal(link.status, 200);
  const { token: joinToken } = await link.json() as { token: string };
  const accepted = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(joiner.email)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: joinToken }),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const added = await memberEvents(server.id, "server.member_added");
  assert.deepEqual(added.map((event) => [event.subjectId, event.provenance.principal_type, event.provenance.role]), [[joiner.id, "human", "member"]]);
  assert.ok(added[0]!.deliveryQueued);

  const promote = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${signedIn.id}`, {
    method: "PATCH",
    headers: serverHeaders(ownerToken, server.id),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200, await promote.clone().text());
  const changed = await memberEvents(server.id, "server.member_role_changed");
  assert.deepEqual(changed.map((event) => event.provenance), [{
    actor_type: "human", previous_role: "member", principal_type: "human", role: "admin", source: "server_service",
  }]);
  assert.equal(changed[0]!.subjectId, signedIn.id);
});

test("an agent joining and changing role queues the same member events", async ({ db }) => {
  void db;
  const { owner, server } = await seedSubscribedServer(["server.member_added", "server.member_role_changed"]);
  const agent = await createAgent(server.id, `JoinBot${randomUUID().slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });
  const added = await memberEvents(server.id, "server.member_added");
  assert.deepEqual(added.map((event) => [event.subjectId, event.provenance.principal_type, event.provenance.reason]), [[agent.id, "agent", "created"]]);

  await updateAgentMemberRole(server.id, agent.id, "admin");
  await updateAgentMemberRole(server.id, agent.id, "admin");
  const changed = await memberEvents(server.id, "server.member_role_changed");
  assert.equal(changed.length, 1, "setting the same role again is not a change");
  assert.deepEqual(changed[0]!.provenance, {
    actor_type: "human", previous_role: "member", principal_type: "agent", role: "admin", source: "server_service",
  });
});

test("a personal assistant is in no App event: not its creation, role change, status or profile change, removal, or its Server's deletion", async ({ app }) => {
  const events = [
    "server.member_added", "server.member_removed", "server.member_role_changed",
    "agent.status_changed", "agent.profile_updated",
  ];
  const { owner, signedIn, server, client, agent: ordinary } = await seedSubscribedServer(events);
  await getDb().update(oauthClients).set({ outboundCurrentGroups: ["server", "agent"] }).where(eq(oauthClients.id, client.id));
  await getDb().update(oauthClientInstalls).set({ approvedGroups: ["server", "agent"] })
    .where(and(eq(oauthClientInstalls.serverId, server.id), eq(oauthClientInstalls.clientId, client.id)));
  // As createMyAssistant makes one: the row is marked with its owner only after
  // createAgent has inserted it (afterInsert), so creation must not read the row.
  const createAssistant = (ownerId: string) => createAgent(server.id, `smeassist${randomUUID().slice(0, 6)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
    kind: "personal_assistant",
    afterInsert: async (tx, created) => {
      await tx.update(agents).set({ assistantOwnerUserId: ownerId }).where(eq(agents.id, created.id));
    },
  });
  const kept = await createAssistant(owner.id);
  const removed = await createAssistant(signedIn.id);
  const later = await createAgent(server.id, `smeordinary${randomUUID().slice(0, 4)}`, {
    runtime: "claude", model: "sonnet", creatorType: "user", creatorId: owner.id,
  });

  for (const agent of [kept, ordinary]) {
    await updateAgentMemberRole(server.id, agent.id, "admin");
    await updateAgentStatus(agent.id, "active");
    await updateAgent(agent.id, { displayName: `Renamed ${agent.id.slice(0, 4)}` });
  }
  await deleteAgent(removed.id);
  await deleteAgent(later.id);
  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    method: "DELETE",
    headers: serverHeaders(await tokenForHuman(owner.email), server.id),
  });
  assert.equal(res.status, 200);

  const assistantIds = new Set([kept.id, removed.id]);
  for (const eventType of events) {
    const subjects = (await memberEvents(server.id, eventType)).map((event) => event.subjectId);
    // The same changes to ordinary agents are announced, so the App is listening for each.
    const control = eventType === "server.member_added" ? later.id : ordinary.id;
    assert.ok(subjects.includes(control), `${eventType} is queued for an ordinary agent`);
    assert.deepEqual(subjects.filter((id) => assistantIds.has(id!)), [], `${eventType} names no personal assistant`);
  }
  const all = await getDb().select({ subjectId: notificationEvents.subjectId }).from(notificationEvents)
    .where(and(eq(notificationEvents.serverId, server.id), inArray(notificationEvents.subjectId, [...assistantIds])));
  assert.deepEqual(all, [], "no event row about an assistant is written at all");
});

test("an App reading the server's member list sees ordinary agents and people, never a personal assistant", async ({ db }) => {
  void db;
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  const { owner, signedIn, server, client, agent: ordinary } = await seedSubscribedServer();
  const assistant = await createAgent(server.id, `smeassist${randomUUID().slice(0, 6)}`, {
    runtime: "claude", model: "sonnet", creatorType: "user", creatorId: owner.id,
    kind: "personal_assistant",
    afterInsert: async (tx, created) => {
      await tx.update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, created.id));
    },
  });
  const [install] = await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
    .where(and(eq(oauthClientInstalls.serverId, server.id), eq(oauthClientInstalls.clientId, client.id)));
  const credential = {
    tokenId: randomUUID(), installationId: install!.id, clientId: client.id, serverId: server.id,
    grantRevision: 1, groups: ["server" as const], audience: "test", expiresAt: new Date(Date.now() + 60_000),
  };
  const refOf = (principalId: string) => deriveAppMemberRef({ clientId: client.id, installationId: install!.id, principalId }).member_ref;
  const members = (await getAppServerProjection(credential))!.members.map((member) => member.member_ref);
  assert.ok(members.includes(refOf(ordinary.id)), "an ordinary agent is listed");
  assert.ok(members.includes(refOf(owner.id)) && members.includes(refOf(signedIn.id)), "people are listed");
  assert.equal(members.includes(refOf(assistant.id)), false, "a personal assistant is not");
});

test("an account deletion queues server.member_removed with reason account_deleted for each server the person was in", async ({ app: _app }) => {
  const { leaver, server } = await seedSubscribedServer();
  const outcome = await requestAccountDeletion({ userId: leaver.id, source: "self", actorUserId: leaver.id });
  assert.equal(outcome.kind, "scheduled");
  await getDb().update(accountDeletionRequests).set({ scheduledFor: new Date(Date.now() - 60_000) })
    .where(and(eq(accountDeletionRequests.userId, leaver.id), eq(accountDeletionRequests.state, "pending")));
  await runAccountDeletionCleanup({ deps: { deleteResendContact: async () => {}, cancelScheduledEmail: async () => {}, cancelStripeSubscription: async () => {} } });

  const events = await memberRemovedEvents(server.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.subjectId, leaver.id);
  assert.deepEqual(events[0]!.provenance, {
    actor_type: "system", principal_type: "human", reason: "account_deleted", role: "admin", source: "account_deletion",
  });
  assert.equal(events[0]!.deliveryQueued, true);
});

test("after an account deletion the app's server projection no longer lists the person, and their Sign in with Raft token is revoked", async ({ app: _app }) => {
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  const { signedIn, owner, server, client } = await seedSubscribedServer();
  const [install] = await getDb().select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
    .where(and(eq(oauthClientInstalls.serverId, server.id), eq(oauthClientInstalls.clientId, client.id)));
  const credential = {
    tokenId: randomUUID(), installationId: install!.id, clientId: client.id, serverId: server.id,
    grantRevision: 1, groups: ["server" as const], audience: "test", expiresAt: new Date(Date.now() + 60_000),
  };
  const refOf = (principalId: string) => deriveAppMemberRef({ clientId: client.id, installationId: install!.id, principalId }).member_ref;
  const listed = async () => (await getAppServerProjection(credential))!.members.map((member) => member.member_ref);
  assert.ok((await listed()).includes(refOf(signedIn.id)));

  await getDb().insert(oauthUserConsents).values({ userId: signedIn.id, serverId: server.id, clientId: client.id, scopes: ["openid"] });
  const [pending] = await getDb().insert(oauthAccessRequests).values({
    serverId: server.id, principalType: "human", userId: signedIn.id, clientId: client.id, scopes: ["openid"],
  } as typeof oauthAccessRequests.$inferInsert).returning({ id: oauthAccessRequests.id });
  // The installation approves the scope, so only the denial can refuse the exchange below.
  await getDb().update(oauthClientInstalls).set({ approvedScopes: ["openid"] })
    .where(and(eq(oauthClientInstalls.serverId, server.id), eq(oauthClientInstalls.clientId, client.id)));
  // Approved in the grace period, its code not exchanged yet.
  const [approved] = await getDb().insert(oauthAccessRequests).values({
    serverId: server.id, principalType: "human", userId: signedIn.id, clientId: client.id, scopes: ["openid"],
    status: "approved", resolvedByUserId: signedIn.id, resolvedAt: new Date(),
  } as typeof oauthAccessRequests.$inferInsert).returning({ id: oauthAccessRequests.id });
  const outcome = await requestAccountDeletion({ userId: signedIn.id, source: "self", actorUserId: signedIn.id });
  assert.equal(outcome.kind, "scheduled");
  await getDb().update(accountDeletionRequests).set({ scheduledFor: new Date(Date.now() - 60_000) })
    .where(and(eq(accountDeletionRequests.userId, signedIn.id), eq(accountDeletionRequests.state, "pending")));
  // Phase A only (retirement): the rows phase B deletes are still there, so the revocation itself is what is checked.
  await retireDueAccounts({ deps: { deleteResendContact: async () => {}, cancelScheduledEmail: async () => {}, cancelStripeSubscription: async () => {} } });

  const members = await listed();
  assert.equal(members.includes(refOf(signedIn.id)), false, "a retired account is not a member to the app");
  assert.ok(members.includes(refOf(owner.id)));
  const tokens = await getDb().select({ revokedAt: oauthAccessTokens.revokedAt }).from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.userId, signedIn.id));
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0]!.revokedAt, "their app token is revoked at retirement");
  const consents = await getDb().select({ revokedAt: oauthUserConsents.revokedAt }).from(oauthUserConsents)
    .where(eq(oauthUserConsents.userId, signedIn.id));
  assert.equal(consents.length, 1);
  assert.ok(consents[0]!.revokedAt, "their consent too");
  const [request] = await getDb().select({ status: oauthAccessRequests.status }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, pending!.id));
  assert.equal(request!.status, "denied", "and their pending request");
  await assert.rejects(
    () => exchangeAccessRequest({ clientId: client.id, requestId: approved!.id }),
    /access_denied/,
    "an approved, unexchanged code no longer mints a token after retirement",
  );
});
