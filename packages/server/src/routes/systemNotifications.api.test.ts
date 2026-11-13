import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  computers,
  featureFlags,
  machines,
  serverMembers,
  systemAttentionIncidents,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import {
  UsageLimitAttentionService,
  USAGE_LIMIT_STALE_AFTER_RESET_MS,
  USAGE_LIMIT_STALE_WITHOUT_RESET_MS,
} from "../services/usageLimitAttentionService";
import {
  parseRuntimeAccountUsageSnapshot,
  RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
  type RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function createVerifiedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    id: randomUUID(),
    email,
    name: email.split("@")[0],
    displayName: email.split("@")[0],
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



test("system-notification feed follows viewMachines and excludes managed Computers", async ({ app }) => {
  const owner = await createVerifiedUser("notification-owner@slock.test");
  const admin = await createVerifiedUser("notification-admin@slock.test");
  const member = await createVerifiedUser("notification-member@slock.test");
  const outsider = await createVerifiedUser("notification-outsider@slock.test");
  const server = await createServer("Notification authority", "notification-authority", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [offlineMachine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Offline Daemon",
    apiKeyHash: "unused-hash",
    daemonVersion: "0.60.0",
  }).returning();
  const [managedComputerMachine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Managed Computer",
    apiKeyHash: "unused-computer-machine-hash",
    daemonVersion: "0.1.0",
  }).returning();
  await getDb().insert(computers).values({
    serverId: server.id,
    machineId: managedComputerMachine.id,
    name: "Managed Computer",
    apiKeyHash: "unused-computer-key-hash",
    apiKeyPrefix: "sk_computer_notification",
    attachedByUserId: owner.id,
  });
  const [activeAgent] = await getDb().insert(agents).values([
    { serverId: server.id, name: "active-offline-agent", machineId: offlineMachine.id, status: "active" },
    { serverId: server.id, name: "inactive-offline-agent", machineId: offlineMachine.id, status: "inactive" },
    {
      serverId: server.id,
      name: "deleted-active-offline-agent",
      machineId: offlineMachine.id,
      status: "active",
      deletedAt: new Date(),
    },
  ]).returning();

  let machineStatusReads = 0;
  app.app.set("agentOrchestrator", {
    getMachineStatus: async () => {
      machineStatusReads += 1;
      return "offline" as const;
    },
    getMachineStatusVersion: async () => 3,
    getMachineDaemonVersion: () => null,
    getMachineComputerVersion: async () => null,
  });

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
  const outsiderToken = await tokenForHuman(outsider.email);
  const read = async (token: string) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return await response.json() as {
      contractVersion: string;
      snapshotMode: string;
      clientState: { read: string; dismiss: string };
      notifications: Array<{
        id: string;
        type: string;
        kind: string;
        action: { targetId: string };
        payload: { activeAgentCount: number };
      }>;
    };
  };

  const ownerFeed = await read(ownerToken);
  assert.equal(ownerFeed.contractVersion, "server-system-notifications-v1");
  assert.equal(ownerFeed.snapshotMode, "replace");
  assert.deepEqual(ownerFeed.clientState, {
    read: "none",
    dismiss: "local_by_notification_id",
  });
  assert.deepEqual(ownerFeed.notifications.map((notification) => ({
    id: notification.id,
    type: notification.type,
    kind: notification.kind,
    activeAgentCount: notification.payload.activeAgentCount,
    targetId: notification.action.targetId,
  })), [{
    id: `machine-offline:${offlineMachine.id}`,
    type: "machine.offline",
    kind: "error",
    activeAgentCount: 1,
    targetId: offlineMachine.id,
  }]);

  const adminFeed = await read(adminToken);
  assert.deepEqual(
    adminFeed.notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      targetId: notification.action.targetId,
    })),
    ownerFeed.notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      targetId: notification.action.targetId,
    })),
    "owner/admin share viewMachines authority",
  );

  const memberFeed = await read(memberToken);
  assert.deepEqual(
    memberFeed.notifications.map((notification) => notification.id),
    ownerFeed.notifications.map((notification) => notification.id),
    "current members receive the same raw-daemon feed through viewMachines",
  );
  assert.ok(
    memberFeed.notifications.every((notification) => !notification.id.includes(managedComputerMachine.id)),
    "managed Computer state stays on its separate aggregate attention surface",
  );
  const readsAfterMembers = machineStatusReads;

  const outsiderResponse = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications`, {
    headers: {
      Authorization: `Bearer ${outsiderToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(outsiderResponse.status, 403, "server-context middleware rejects non-members");
  assert.equal(
    machineStatusReads,
    readsAfterMembers,
    "non-member feed must fail closed before querying canonical machine read models",
  );

  await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, activeAgent.id));
  const idleFeed = await read(ownerToken);
  assert.equal(idleFeed.notifications[0]?.kind, "warning");
  assert.equal(idleFeed.notifications[0]?.payload.activeAgentCount, 0);

  await getDb().update(serverMembers)
    .set({ role: "member" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  assert.equal(
    (await read(adminToken)).notifications[0]?.type,
    "machine.offline",
    "admin-to-member keeps the feed because both roles currently have viewMachines",
  );

  await getDb().update(serverMembers)
    .set({ role: "admin" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  assert.equal((await read(memberToken)).notifications[0]?.type, "machine.offline", "promotion grants the canonical feed");
});

test("usage-limit attention syncs per-recipient seen/dismiss and resurfaces on a new activation", async ({ app }) => {
  const owner = await createVerifiedUser("attention-owner@slock.test");
  const admin = await createVerifiedUser("attention-admin@slock.test");
  const member = await createVerifiedUser("attention-member@slock.test");
  const server = await createServer("Usage attention", "usage-attention", owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Cindy MacBook",
    apiKeyHash: "unused-attention-machine-hash",
  }).returning();
  const activatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const [first] = await getDb().insert(systemAttentionIncidents).values({
    serverId: server.id,
    machineId: machine.id,
    kind: "usage_limit_reached",
    provider: "codex",
    accountKeyHash: "a".repeat(64),
    windowKey: "primary",
    activationGeneration: 1,
    affectedAgentIds: [randomUUID(), randomUUID()],
    activatedAt,
    lastObservedAt: activatedAt,
  }).returning();

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });
  const read = async (token: string) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications-v2`, {
      headers: headers(token),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return await response.json() as {
      contractVersion: string;
      unseenCount: number;
      notifications: Array<{ id: string; seenAt: string | null; machine: { id: string; name: string }; affectedAgentIds: string[] }>;
    };
  };
  const mutate = async (token: string, incidentId: string, action: "seen" | "dismiss") => {
    const response = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/system-notifications-v2/${incidentId}/${action}`,
      { method: "POST", headers: headers(token) },
    );
    assert.equal(response.status, 200);
  };

  const ownerInitial = await read(ownerToken);
  assert.equal(ownerInitial.contractVersion, "server-system-attention-v1");
  assert.equal(ownerInitial.unseenCount, 1);
  assert.deepEqual(ownerInitial.notifications.map((notification) => ({
    id: notification.id,
    seenAt: notification.seenAt,
    machine: notification.machine,
    affectedAgentCount: notification.affectedAgentIds.length,
  })), [{
    id: first.id,
    seenAt: null,
    machine: { id: machine.id, name: "Cindy MacBook" },
    affectedAgentCount: 2,
  }]);
  assert.equal((await read(adminToken)).unseenCount, 1, "another recipient owns an independent receipt");
  assert.deepEqual((await read(memberToken)).notifications, [], "ordinary members are not recipients");

  await mutate(ownerToken, first.id, "seen");
  assert.equal((await read(ownerToken)).unseenCount, 0, "a second device reads the server-backed seen receipt");
  assert.equal((await read(adminToken)).unseenCount, 1, "owner seen does not mark admin seen");
  await mutate(ownerToken, first.id, "dismiss");
  assert.deepEqual((await read(ownerToken)).notifications, []);
  assert.equal((await read(adminToken)).notifications.length, 1);

  const recoveredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await getDb().update(systemAttentionIncidents).set({
    state: "resolved",
    resolvedAt: recoveredAt,
    lastObservedAt: recoveredAt,
  }).where(eq(systemAttentionIncidents.id, first.id));
  const [second] = await getDb().insert(systemAttentionIncidents).values({
    serverId: server.id,
    machineId: machine.id,
    kind: "usage_limit_reached",
    provider: "codex",
    accountKeyHash: "a".repeat(64),
    windowKey: "primary",
    activationGeneration: 2,
    affectedAgentIds: [randomUUID()],
    activatedAt: new Date(Date.now() - 60 * 60 * 1000),
    lastObservedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const ownerReactivated = await read(ownerToken);
  assert.equal(ownerReactivated.unseenCount, 1);
  assert.deepEqual(ownerReactivated.notifications.map((notification) => notification.id), [second.id]);
});

test("usage-limit attention hides stale active incidents until a new limit_reached snapshot", async ({ db }) => {
  void db;
  const owner = await createVerifiedUser("stale-owner@slock.test");
  const admin = await createVerifiedUser("stale-admin@slock.test");
  const server = await createServer("Stale usage attention", "stale-usage-attention", owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  // GA: the retired rollout flag has no say; ingest and reads work with no flag row at all.
  await getDb().delete(featureFlags).where(eq(featureFlags.key, "usage_limit_attention_v0"));
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Quiet MacBook",
    apiKeyHash: "unused-stale-attention-machine-hash",
  }).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: "codex-agent",
    machineId: machine.id,
    runtime: "codex",
    status: "active",
  }).returning();

  const t0 = new Date("2026-10-14T08:00:00.000Z");
  const resetsAt = new Date("2026-10-14T13:00:00.000Z");
  let now = t0;
  const service = new UsageLimitAttentionService(() => now);
  const snapshot = (collectedAt: Date, reset: Date | null, status: "limit_reached" | "ok" = "limit_reached"): RuntimeAccountUsageSnapshot => parseRuntimeAccountUsageSnapshot({
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "codex",
    collectedAt: collectedAt.toISOString(),
    staleAfter: new Date(collectedAt.getTime() + 60_000).toISOString(),
    collectorVersion: "test",
    accounts: [{
      accountKey: "b".repeat(64),
      health: "ok",
      windows: [{
        id: "primary",
        label: "5h",
        status,
        usedRatio: status === "limit_reached" ? 1 : 0.2,
        ...(reset ? { resetsAt: reset.toISOString() } : {}),
      }],
    }],
  });
  const visibleIds = async (userId = owner.id) => (await service.listForReceiver(server.id, userId)).notifications.map((n) => n.id);

  await service.ingest(machine.id, snapshot(t0, resetsAt));
  const incidentRows = async () => await getDb().select().from(systemAttentionIncidents)
    .where(eq(systemAttentionIncidents.machineId, machine.id))
    .orderBy(systemAttentionIncidents.activationGeneration);
  const [incident] = await incidentRows();
  assert.ok(incident, "ingest activates an incident with no flag row");
  assert.deepEqual(incident.affectedAgentIds, [agent.id]);
  assert.deepEqual(await visibleIds(), [incident.id]);

  // While live, a new limit_reached snapshot updates the same incident in place.
  now = new Date(resetsAt.getTime() + USAGE_LIMIT_STALE_AFTER_RESET_MS - 2 * 60_000);
  await service.ingest(machine.id, snapshot(now, resetsAt));
  assert.equal((await incidentRows()).length, 1, "a live incident is updated, not re-activated");
  const lastLiveObservation = now;

  // The owner dismisses it; the admin never does.
  assert.equal(await service.dismiss(server.id, owner.id, incident.id), true);
  assert.deepEqual(await visibleIds(), []);

  // (a) resetsAt set: visible until an hour past the reset, hidden after.
  now = new Date(resetsAt.getTime() + USAGE_LIMIT_STALE_AFTER_RESET_MS - 60_000);
  const withinGrace = await service.listForReceiver(server.id, admin.id);
  assert.deepEqual(withinGrace.notifications.map((n) => n.id), [incident.id], "still live within an hour of the reset");
  assert.equal(withinGrace.unseenCount, 1);
  now = new Date(resetsAt.getTime() + USAGE_LIMIT_STALE_AFTER_RESET_MS + 60_000);
  const stale = await service.listForReceiver(server.id, admin.id);
  assert.deepEqual(stale.notifications, [], "stale an hour past the reset with no new snapshot");
  assert.equal(stale.unseenCount, 0, "unseenCount excludes stale incidents");

  // Receipts on a stale card behave like on a resolved one: refused, nothing written.
  assert.equal(await service.markSeen(server.id, admin.id, incident.id), false);
  assert.equal(await service.dismiss(server.id, admin.id, incident.id), false);

  // The limit is hit again: the stale incident is resolved and a new generation activated, so the
  // owner's dismissal of the old one does not hide it, and the admin sees it again too.
  const nextReset = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  await service.ingest(machine.id, snapshot(now, nextReset));
  const [old, next] = await incidentRows();
  assert.equal(old?.id, incident.id);
  assert.equal(old?.state, "resolved", "the stale incident is resolved");
  assert.equal(old?.resolvedAt?.toISOString(), lastLiveObservation.toISOString(), "resolved at its last observation");
  assert.ok(next && next.id !== incident.id, "a new incident id");
  assert.equal(next.state, "active");
  assert.equal(next.activationGeneration, incident.activationGeneration + 1);
  const ownerReshown = await service.listForReceiver(server.id, owner.id);
  assert.deepEqual(ownerReshown.notifications.map((n) => ({ id: n.id, seenAt: n.seenAt })), [{ id: next.id, seenAt: null }]);
  assert.equal(ownerReshown.unseenCount, 1, "visible and unseen to the owner who dismissed the old one");
  assert.deepEqual(await visibleIds(admin.id), [next.id], "re-shown to the admin who never dismissed");
  assert.equal(await service.markSeen(server.id, owner.id, next.id), true, "live: receipts write");
  assert.equal((await service.listForReceiver(server.id, owner.id)).unseenCount, 0);

  // (b) no resetsAt: live for 24h after the last observation, stale after.
  const observedNoReset = new Date(now.getTime() + 60_000);
  await service.ingest(machine.id, snapshot(observedNoReset, null));
  assert.equal((await incidentRows()).length, 2, "the live new incident is updated in place");
  now = new Date(observedNoReset.getTime() + USAGE_LIMIT_STALE_WITHOUT_RESET_MS - 60_000);
  assert.deepEqual(await visibleIds(), [next.id], "no reset: still live within 24h of the last observation");
  now = new Date(observedNoReset.getTime() + USAGE_LIMIT_STALE_WITHOUT_RESET_MS + 60_000);
  assert.deepEqual(await visibleIds(), [], "no reset: stale 24h after the last observation");
  assert.deepEqual(await visibleIds(admin.id), []);
  assert.equal((await service.listForReceiver(server.id, admin.id)).unseenCount, 0);
  assert.equal(await service.dismiss(server.id, admin.id, next.id), false);
  const [, row] = await incidentRows();
  assert.equal(row?.state, "active", "staleness is a read rule; the row is not rewritten until a new snapshot");
});

// A personal assistant is hosted, never on a Computer (agents_assistant_not_on_machine):
// a Computer's usage limit never names it, to its owner or anyone else.
test("usage-limit attention never names a hosted personal assistant, even to its owner", async ({ db }) => {
  void db;
  const owner = await createVerifiedUser(`ula-owner-${randomUUID().slice(0, 8)}@slock.test`);
  const admin = await createVerifiedUser(`ula-admin-${randomUUID().slice(0, 8)}@slock.test`);
  const server = await createServer("Usage attention assistants", `usage-attention-assistant-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Shared MacBook",
    apiKeyHash: `unused-assistant-attention-${randomUUID()}`,
  }).returning();
  const [ordinary, assistant] = await getDb().insert(agents).values([
    { serverId: server.id, name: "codex-ordinary", machineId: machine.id, runtime: "codex", status: "active" },
    { serverId: server.id, name: "codex-assistant", runtime: "codex", status: "active", assistantOwnerUserId: admin.id },
  ]).returning();
  const now = new Date("2026-10-14T08:00:00.000Z");
  const service = new UsageLimitAttentionService(() => now);
  await service.ingest(machine.id, parseRuntimeAccountUsageSnapshot({
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "codex",
    collectedAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + 60_000).toISOString(),
    collectorVersion: "test",
    accounts: [{
      accountKey: "c".repeat(64),
      health: "ok",
      windows: [{ id: "primary", label: "5h", status: "limit_reached", usedRatio: 1, resetsAt: new Date(now.getTime() + 60 * 60_000).toISOString() }],
    }],
  }));

  const affected = async (userId: string) => (await service.listForReceiver(server.id, userId)).notifications.map((n) => [...n.affectedAgentIds].sort());
  assert.ok(assistant);
  assert.deepEqual(await affected(owner.id), [[ordinary!.id]], "the server owner never finds another person's assistant");
  assert.deepEqual(await affected(admin.id), [[ordinary!.id]], "nor does its owner: it is not on the Computer");
});

// OAR 0.103: Antigravity's windows are per model group ("Gemini Models"); one
// group used up leaves the other groups' models running, so it is no
// "Antigravity used up" notice for every agent there.
test("usage-limit attention comes from model groups' windows only once the account is rate limited", async ({ db }) => {
  void db;
  const owner = await createVerifiedUser(`ula-group-${randomUUID().slice(0, 8)}@slock.test`);
  const server = await createServer("Usage attention groups", `usage-attention-group-${randomUUID().slice(0, 8)}`, owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "Antigravity box",
    apiKeyHash: `unused-group-attention-${randomUUID()}`,
  }).returning();
  await getDb().insert(agents).values({ serverId: server.id, name: "agy-agent", machineId: machine!.id, runtime: "antigravity", status: "active" });
  const now = new Date("2026-11-12T08:00:00.000Z");
  const service = new UsageLimitAttentionService(() => now);
  await service.ingest(machine!.id, parseRuntimeAccountUsageSnapshot({
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "antigravity",
    collectedAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + 60_000).toISOString(),
    collectorVersion: "test",
    accounts: [{
      accountKey: "d".repeat(64),
      health: "ok",
      windows: [
        { id: "gemini_weekly", label: "Gemini Models · Weekly", status: "limit_reached", usedRatio: 1, scope: { kind: "models", name: "Gemini Models" } },
        { id: "claude_weekly", label: "Claude and GPT models · Weekly", status: "ok", usedRatio: 0.3, scope: { kind: "models", name: "Claude and GPT models" } },
      ],
    }],
  }));
  assert.deepEqual((await service.listForReceiver(server.id, owner.id)).notifications, [], "one group used up: no notice");

  // Every group used up and OAR says rate limited: Antigravity is used up.
  const later = new Date(now.getTime() + 60_000);
  const laterService = new UsageLimitAttentionService(() => later);
  await laterService.ingest(machine!.id, parseRuntimeAccountUsageSnapshot({
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "antigravity",
    collectedAt: later.toISOString(),
    staleAfter: new Date(later.getTime() + 60_000).toISOString(),
    collectorVersion: "test",
    accounts: [{
      accountKey: "d".repeat(64),
      health: "rate_limited",
      windows: [
        { id: "gemini_weekly", label: "Gemini Models · Weekly", status: "limit_reached", usedRatio: 1, resetsAt: new Date(later.getTime() + 3_600_000).toISOString(), scope: { kind: "models", name: "Gemini Models" } },
        { id: "claude_weekly", label: "Claude and GPT models · Weekly", status: "limit_reached", usedRatio: 1, scope: { kind: "models", name: "Claude and GPT models" } },
      ],
    }],
  }));
  const used = (await laterService.listForReceiver(server.id, owner.id)).notifications;
  assert.deepEqual(used.map((notification) => notification.provider), ["antigravity", "antigravity"], "rate limited: the groups' windows notify");
});

// As above: an offline Computer takes no hosted assistant with it.
test("the offline-computer notice never counts a hosted personal assistant, even for its owner", async ({ app }) => {
  const owner = await createVerifiedUser(`offline-owner-${randomUUID().slice(0, 8)}@slock.test`);
  const admin = await createVerifiedUser(`offline-admin-${randomUUID().slice(0, 8)}@slock.test`);
  const server = await createServer("Offline assistant count", `offline-assistant-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: admin.id, name: "Admin Daemon", apiKeyHash: `unused-${randomUUID()}`, daemonVersion: "0.60.0",
  }).returning();
  await getDb().insert(agents).values([
    { serverId: server.id, name: "offline-ordinary", machineId: machine.id, status: "active" },
    { serverId: server.id, name: "offline-assistant", status: "active", assistantOwnerUserId: admin.id },
  ]);
  app.app.set("agentOrchestrator", {
    getMachineStatus: async () => "offline" as const,
    getMachineStatusVersion: async () => 1,
    getMachineDaemonVersion: () => null,
    getMachineComputerVersion: async () => null,
  });
  const activeCount = async (email: string) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/system-notifications`, {
      headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": server.id },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { notifications: Array<{ payload: { activeAgentCount: number } }> };
    return body.notifications.map((notification) => notification.payload.activeAgentCount);
  };
  assert.deepEqual(await activeCount(owner.email), [1], "the server owner never counts another person's assistant");
  assert.deepEqual(await activeCount(admin.email), [1], "nor does its owner: it is not on the Computer");
});
