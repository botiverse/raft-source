import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// `GET /api/agents/:id/context-view/status`: whether a context view can be
// opened for the agent now (its Computer online, the daemon capable, a report
// from that Computer). Behind agent_context_view_v0; only the agent's creator
// and owners/admins (a personal assistant: its owner) see it, everyone else
// gets the unknown-agent 404.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  type AgentContextViewStatus,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, machines, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { canViewAgentContext } from "../lib/actorPermissions";
import type { AgentContextViewAvailabilityRecord } from "../services/replicaStateStore";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest();

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function enableFlag(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

/** Owner, admin, a member who created the agent, another member; the agent on the creator's Computer. */
async function seed(options: { flag?: boolean } = {}) {
  const owner = await seedUser("ctxv-owner");
  const admin = await seedUser("ctxv-admin");
  const creator = await seedUser("ctxv-creator");
  const member = await seedUser("ctxv-member");
  const server = await createServer("Context View", `ctxv-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [machine, otherMachine] = await getDb().insert(machines).values([
    { serverId: server.id, userId: creator.id, name: "creator-mac", apiKeyHash: `hash-${randomUUID()}` },
    { serverId: server.id, userId: creator.id, name: "creator-other", apiKeyHash: `hash-${randomUUID()}` },
  ]).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: `ctxv${randomUUID().slice(0, 6)}`,
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: creator.id,
  }).returning();
  if (options.flag !== false) await enableFlag(server.id);
  return { owner, admin, creator, member, server, machine: machine!, otherMachine: otherMachine!, agent: agent! };
}

type FakeComputers = {
  online?: string[];
  capable?: string[];
  records?: Record<string, AgentContextViewAvailabilityRecord>;
};

/** The orchestrator facts the route reads, as a replica would see them. */
function fakeComputers(app: { app: { get(key: string): unknown; set(key: string, value: unknown): unknown } }, facts: FakeComputers) {
  const original = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...original,
    getMachineStatus: async (machineId: string) => (facts.online ?? []).includes(machineId) ? "online" : "offline",
    machineAdvertisesCapability: async (machineId: string, capability: string) =>
      capability === DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0 && (facts.capable ?? []).includes(machineId),
    getAgentContextViewAvailability: async (agentId: string) => facts.records?.[agentId] ?? null,
  });
}

function record(machineId: string, agentId: string, report: Partial<AgentContextViewAvailabilityRecord["report"]> = {}): AgentContextViewAvailabilityRecord {
  return {
    machineId,
    report: { agentId, runtime: "claude", supported: true, retainedSince: "2026-10-01T00:00:00.000Z", ...report },
    receivedAt: "2026-11-04T00:00:00.000Z",
  };
}

async function getStatus(baseUrl: string, agentId: string, email: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/context-view/status`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
  const raw = await res.text();
  return { status: res.status, raw, cacheControl: res.headers.get("cache-control"), body: raw ? JSON.parse(raw) : null };
}

async function expectStatus(baseUrl: string, agentId: string, email: string, serverId: string): Promise<AgentContextViewStatus> {
  const res = await getStatus(baseUrl, agentId, email, serverId);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.cacheControl, "no-store");
  return res.body as AgentContextViewStatus;
}

test("flag off: the same 404 as an unknown agent, even for the owner", async ({ app }) => {
  const f = await seed({ flag: false });
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const off = await getStatus(app.baseUrl, f.agent.id, f.owner.email, f.server.id);
  const unknown = await getStatus(app.baseUrl, randomUUID(), f.owner.email, f.server.id);
  assert.equal(off.status, 404);
  assert.equal(off.raw, unknown.raw);
  assert.deepEqual(off.body, { error: "Agent not found" });
});

test("a member who is not the creator gets the unknown-agent 404, body for body", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const refused = await getStatus(app.baseUrl, f.agent.id, f.member.email, f.server.id);
  const unknown = await getStatus(app.baseUrl, randomUUID(), f.member.email, f.server.id);
  assert.equal(refused.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(refused.raw, unknown.raw);
});

test("another Server's agent is the same 404", async ({ app }) => {
  const f = await seed();
  const g = await seed();
  fakeComputers(app, { online: [g.machine.id], capable: [g.machine.id] });
  const res = await getStatus(app.baseUrl, g.agent.id, f.owner.email, f.server.id);
  const unknown = await getStatus(app.baseUrl, randomUUID(), f.owner.email, f.server.id);
  assert.equal(res.status, 404);
  assert.equal(res.raw, unknown.raw);
});

test("a personal assistant: 404 for an admin and the server owner, visible to its owner", async ({ app }) => {
  const f = await seed();
  // An assistant is on no Computer (agents_assistant_not_on_machine).
  await getDb().update(agents).set({ assistantOwnerUserId: f.creator.id, machineId: null }).where(eq(agents.id, f.agent.id));
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  for (const viewer of [f.admin, f.owner]) {
    const res = await getStatus(app.baseUrl, f.agent.id, viewer.email, f.server.id);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Agent not found" });
  }
  // Its owner passes the gate; an assistant is on no Computer.
  assert.equal((await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id)).state, "unavailable");
});

test("an agent with no Computer is no_computer", async ({ app }) => {
  const f = await seed();
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, f.agent.id));
  fakeComputers(app, {});
  assert.deepEqual(await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id), {
    state: "unavailable",
    reason: "no_computer",
    runtime: "claude",
    computer: null,
    computerOwner: null,
    retainedSince: null,
    retentionDays: AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  });
});

test("an offline Computer is offline, with the Computer and its owner", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  assert.deepEqual(await expectStatus(app.baseUrl, f.agent.id, f.admin.email, f.server.id), {
    state: "unavailable",
    reason: "offline",
    runtime: "claude",
    computer: { id: f.machine.id, name: "creator-mac" },
    computerOwner: { id: f.creator.id, name: "ctxv-creator" },
    retainedSince: null,
    retentionDays: AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  });
});

test("an online Computer that did not advertise the capability is old_daemon", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const status = await expectStatus(app.baseUrl, f.agent.id, f.owner.email, f.server.id);
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "old_daemon");
});

test("a capable Computer with no report, or a report from another Computer, is no_session", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id] });
  const none = await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  assert.equal(none.state, "unavailable");
  assert.equal(none.reason, "no_session");

  fakeComputers(app, {
    online: [f.machine.id],
    capable: [f.machine.id],
    records: { [f.agent.id]: record(f.otherMachine.id, f.agent.id, { runtime: "codex", retentionDays: 7 }) },
  });
  const moved = await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  assert.equal(moved.state, "unavailable");
  assert.equal(moved.reason, "no_session");
  assert.equal(moved.runtime, "claude", "the other Computer's report is not read");
  assert.equal(moved.retainedSince, null);
  assert.equal(moved.retentionDays, AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS);
});

test("a supported report is available, with its runtime, retainedSince and retentionDays (or the default)", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, {
    online: [f.machine.id],
    capable: [f.machine.id],
    records: { [f.agent.id]: record(f.machine.id, f.agent.id, { runtime: "claude-sdk", retentionDays: 7 }) },
  });
  assert.deepEqual(await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id), {
    state: "available",
    runtime: "claude-sdk",
    computer: { id: f.machine.id, name: "creator-mac" },
    computerOwner: { id: f.creator.id, name: "ctxv-creator" },
    retainedSince: "2026-10-01T00:00:00.000Z",
    retentionDays: 7,
  });

  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const fallback = await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  assert.equal(fallback.state, "available");
  assert.equal("reason" in fallback, false);
  assert.equal(fallback.retentionDays, AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS);
});

test("an unsupported report gives its reason, unsupported_runtime when it gave none", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, {
    online: [f.machine.id],
    capable: [f.machine.id],
    records: { [f.agent.id]: record(f.machine.id, f.agent.id, { supported: false, unsupportedReason: "no_session", retainedSince: null }) },
  });
  const noSession = await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  assert.equal(noSession.state, "unavailable");
  assert.equal(noSession.reason, "no_session");

  fakeComputers(app, {
    online: [f.machine.id],
    capable: [f.machine.id],
    records: { [f.agent.id]: record(f.machine.id, f.agent.id, { runtime: "kimi", supported: false, retainedSince: null }) },
  });
  const unsupported = await expectStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  assert.equal(unsupported.state, "unavailable");
  assert.equal(unsupported.reason, "unsupported_runtime");
  assert.equal(unsupported.runtime, "kimi");
});

test("computerOwner: present for a member; null once they left the Server or were retired", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const present = await expectStatus(app.baseUrl, f.agent.id, f.owner.email, f.server.id);
  assert.deepEqual(present.computerOwner, { id: f.creator.id, name: "ctxv-creator" });

  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.creator.id)));
  const left = await expectStatus(app.baseUrl, f.agent.id, f.owner.email, f.server.id);
  assert.equal(left.computerOwner, null);
  assert.deepEqual(left.computer, { id: f.machine.id, name: "creator-mac" });

  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: f.creator.id, role: "member" });
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, f.creator.id));
  const retired = await expectStatus(app.baseUrl, f.agent.id, f.owner.email, f.server.id);
  assert.equal(retired.computerOwner, null);
});

test("a deleted agent is the same 404", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.agent.id));
  const res = await getStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  const unknown = await getStatus(app.baseUrl, randomUUID(), f.creator.email, f.server.id);
  assert.equal(res.status, 404);
  assert.equal(res.raw, unknown.raw);
});

test("an agent credential is refused 401", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const minted = await mintAgentCredential({ agentId: f.agent.id, scopes: ["send", "read"], name: "ctxv-agent", issuedVia: "human", createdByUserId: f.creator.id });
  const res = await fetch(`${app.baseUrl}/api/agents/${f.agent.id}/context-view/status`, {
    headers: { Authorization: `Bearer ${minted.apiKey}`, "X-Server-Id": f.server.id },
  });
  assert.equal(res.status, 401);
});

test("a Guest never views an agent's context, even as its recorded creator", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { online: [f.machine.id], capable: [f.machine.id], records: { [f.agent.id]: record(f.machine.id, f.agent.id) } });
  const agent = { creatorType: "user", creatorId: f.creator.id, assistantOwnerUserId: null };
  assert.equal(await canViewAgentContext(f.server.id, f.creator.id, agent), true);
  await seedBoundGuest({ serverId: f.server.id, userId: f.creator.id });
  assert.equal(await canViewAgentContext(f.server.id, f.creator.id, agent), false);
  // The agent router lets a Guest reach View Context's reads, which answer the unknown-agent 404.
  const res = await getStatus(app.baseUrl, f.agent.id, f.creator.email, f.server.id);
  const unknown = await getStatus(app.baseUrl, randomUUID(), f.creator.email, f.server.id);
  assert.equal(res.status, 404);
  assert.equal(res.raw, unknown.raw);
  assert.ok(!res.raw.includes(f.machine.name), "nothing about the Computer");
});
