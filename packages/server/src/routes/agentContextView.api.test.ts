import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// View Context, end to end on one replica: GET /api/agents/:id/messages/:messageId/context
// sends the request to the agent's Computer and waits; the test plays the
// daemon (captures the frame, POSTs the result with the Computer's own key).
// Also the result POST's refusals, the audit rows per view (the required
// attempt, the best-effort outcome) and the viewers list
// (GET /api/agents/:id/context-views).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { and, desc, eq } from "drizzle-orm";
import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  AGENT_CONTEXT_VIEW_MAX_BYTES,
  AGENT_CONTEXT_VIEW_RESULT_ROUTE,
  AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  type AgentContextViewRequestMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, channels, featureFlagRules, featureFlags, integrationAuditEvents, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { attachComputer } from "../services/computerCredentialService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgentContextViewRelay } from "../services/agentContextViewService";
import { redisAgentContextViewRequestStore } from "../services/replicaStateStore";
import type { AgentContextViewRelayDeps } from "../services/agentContextViewRelay";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest();

type AppHandle = { baseUrl: string; app: { get(key: string): unknown; set(key: string, value: unknown): unknown } };

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

/**
 * Owner, admin, a member who created the agent, another member; the agent on
 * a Computer the owner attached (with its own key), one message it sent, one
 * a person sent, one another agent sent.
 */
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
  const attach = async (name: string) => {
    const result = await attachComputer({ userId: owner.id, serverSlug: server.slug, name });
    assert.ok(result.ok, `attach ${name}`);
    return { apiKey: result.apiKey, machineId: result.machineId };
  };
  const computer = await attach("ctxv-mac");
  const otherComputer = await attach("ctxv-other");
  const newAgent = async (name: string) => {
    const [row] = await getDb().insert(agents).values({
      serverId: server.id,
      name: `${name}${randomUUID().slice(0, 6)}`,
      status: "inactive",
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      machineId: computer.machineId,
      creatorType: "user",
      creatorId: creator.id,
    }).returning();
    return row!;
  };
  const agent = await newAgent("ctxv");
  const otherAgent = await newAgent("ctxvother");
  const [channel] = await getDb().insert(channels).values({ serverId: server.id, name: `ctxv-${randomUUID().slice(0, 6)}`, type: "channel" }).returning();
  const [message, humanMessage, otherAgentMessage] = await getDb().insert(messages).values([
    { channelId: channel!.id, senderType: "agent", senderId: agent.id, content: "from the agent" },
    { channelId: channel!.id, senderType: "user", senderId: creator.id, content: "from a person" },
    { channelId: channel!.id, senderType: "agent", senderId: otherAgent.id, content: "from another agent" },
  ]).returning();
  if (options.flag !== false) await enableFlag(server.id);
  return { owner, admin, creator, member, server, computer, otherComputer, agent, message: message!, humanMessage: humanMessage!, otherAgentMessage: otherAgentMessage! };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** The orchestrator facts the view route reads, and the daemon's side of the request frame. */
function fakeComputers(app: AppHandle, facts: { online?: string[]; capable?: string[]; sendFails?: boolean } = {}) {
  const frames: AgentContextViewRequestMessage[] = [];
  const original = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...original,
    getMachineStatus: async (machineId: string) => (facts.online ?? []).includes(machineId) ? "online" : "offline",
    machineAdvertisesCapability: async (machineId: string, capability: string) =>
      capability === DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0 && (facts.capable ?? []).includes(machineId),
    sendAgentContextViewRequest: async (_machineId: string, frame: AgentContextViewRequestMessage) => {
      if (facts.sendFails) return false;
      frames.push(frame);
      return true;
    },
  });
  return {
    frames,
    async nextFrame(): Promise<AgentContextViewRequestMessage> {
      for (let i = 0; i < 200 && frames.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(frames[0], "the request frame was sent");
      return frames.shift()!;
    },
  };
}

function onlineCapable(app: AppHandle, f: Seeded, extra: { sendFails?: boolean } = {}) {
  return fakeComputers(app, { online: [f.computer.machineId], capable: [f.computer.machineId], ...extra });
}

function useRelay(app: AppHandle, overrides: Partial<AgentContextViewRelayDeps>) {
  app.app.set("agentContextViewRelay", createAgentContextViewRelay(overrides));
}

type ViewBody = { ok?: boolean; reason?: string; tooLargeCause?: string; error?: string; context?: unknown; computer?: unknown; computerOwner?: unknown };

async function view(app: AppHandle, agentId: string, messageId: string, email: string, serverId: string) {
  const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/messages/${messageId}/context`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
  const raw = await res.text();
  let body: ViewBody = {};
  try {
    body = raw ? JSON.parse(raw) as ViewBody : {};
  } catch {
    body = {};
  }
  return { status: res.status, raw, body, cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type") };
}

/** Status, body and the headers a client could tell refusals apart by. */
function refusalShape(res: { status: number; raw: string; cacheControl: string | null; contentType: string | null }) {
  return { status: res.status, raw: res.raw, cacheControl: res.cacheControl, contentType: res.contentType };
}

async function postResult(app: AppHandle, apiKey: string, requestId: string, body: Buffer | string, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.baseUrl}${AGENT_CONTEXT_VIEW_RESULT_ROUTE.replace(":requestId", encodeURIComponent(requestId))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as { ok?: boolean; code?: string } | null };
}

function contextFor(messageId: string, systemText = "You are a helpful agent.") {
  return {
    runtime: "claude",
    model: "claude-sonnet",
    sessionId: "session-1",
    requestAt: "2026-11-04T00:00:00.000Z",
    messageId,
    tokens: { input: 10, cacheRead: 0, total: 10 },
    system: [{ text: systemText }],
    tools: [],
    messages: [{ role: "assistant", parts: [{ kind: "tool_use", toolName: "raft", toolUseId: "t1", input: { cmd: "message send" } }] }],
    compaction: { happened: false },
    trigger: { messageIndex: 0, partIndex: 0, toolUseId: "t1" },
    redactions: {},
    source: { kind: "native", format: "claude-jsonl", version: null },
  };
}

/** The required attempt rows (`agent.context_view_requested`). */
async function attemptRows(agentId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "agent.context_view_requested"), eq(integrationAuditEvents.subjectId, agentId)))
    .orderBy(desc(integrationAuditEvents.createdAt));
}

/** The best-effort outcome rows (`agent.context_viewed`). */
async function auditRows(agentId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "agent.context_viewed"), eq(integrationAuditEvents.subjectId, agentId)))
    .orderBy(desc(integrationAuditEvents.createdAt));
}

async function waitForAudit(agentId: string, count: number) {
  for (let i = 0; i < 200; i++) {
    const rows = await auditRows(agentId);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`expected ${count} audit rows`);
}

/** Open a view, play the daemon with `post`, return the viewer's answer and the daemon's. */
async function roundTrip(app: AppHandle, f: Seeded, post: (frame: AgentContextViewRequestMessage) => Promise<{ status: number; body: { ok?: boolean; code?: string } | null }>) {
  const computers = onlineCapable(app, f);
  const viewing = view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  const frame = await computers.nextFrame();
  const daemon = await post(frame);
  return { viewer: await viewing, daemon, frame };
}

// --- Refusals: body for body the unknown-agent 404 ---------------------------

test("every refusal is the unknown-agent 404, body for body", async ({ app }) => {
  const f = await seed();
  const g = await seed();
  const off = await seed({ flag: false });
  onlineCapable(app, f);
  const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: "Agent not found" });

  // This agent's own message, but in a channel of another Server.
  const [foreignChannelMessage] = await getDb().insert(messages)
    .values({ channelId: g.message.channelId, senderType: "agent", senderId: f.agent.id, content: "elsewhere" })
    .returning();
  const cases: Array<[string, ReturnType<typeof view>]> = [
    ["flag off", view(app, off.agent.id, off.message.id, off.owner.email, off.server.id)],
    ["another Server's agent", view(app, g.agent.id, g.message.id, f.owner.email, f.server.id)],
    ["missing message", view(app, f.agent.id, randomUUID(), f.creator.email, f.server.id)],
    ["malformed message id", view(app, f.agent.id, "not-a-uuid", f.creator.email, f.server.id)],
    ["a message by another agent", view(app, f.agent.id, f.otherAgentMessage.id, f.creator.email, f.server.id)],
    ["a message by a person", view(app, f.agent.id, f.humanMessage.id, f.creator.email, f.server.id)],
    ["another Server's message", view(app, f.agent.id, g.message.id, f.creator.email, f.server.id)],
    ["this agent's message in another Server's channel", view(app, f.agent.id, foreignChannelMessage!.id, f.creator.email, f.server.id)],
    ["a member without access", view(app, f.agent.id, f.message.id, f.member.email, f.server.id)],
  ];
  for (const [label, pending] of cases) {
    const res = await pending;
    assert.equal(res.status, 404, label);
    assert.equal(res.raw, unknown.raw, label);
    // Headers too: no refusal differs in content type or caching.
    assert.deepEqual(refusalShape(res), refusalShape(unknown), label);
  }
  assert.equal((await attemptRows(f.agent.id)).length, 0, "a refusal records no attempt");
});

test("a personal assistant: 404 for an admin and the server owner; its owner may view", async ({ app }) => {
  const f = await seed();
  // An assistant is on no Computer (agents_assistant_not_on_machine).
  await getDb().update(agents).set({ assistantOwnerUserId: f.creator.id, machineId: null }).where(eq(agents.id, f.agent.id));
  fakeComputers(app, { capable: [f.computer.machineId] });
  const unknown = await view(app, randomUUID(), f.message.id, f.admin.email, f.server.id);
  for (const viewer of [f.admin, f.owner]) {
    const res = await view(app, f.agent.id, f.message.id, viewer.email, f.server.id);
    assert.equal(res.status, 404);
    assert.equal(res.raw, unknown.raw);
  }
  const own = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(own.status, 200);
  assert.equal(own.body.reason, "no_computer", "the owner passed; an assistant is on no Computer");
});

test("a deleted agent is the same 404", async ({ app }) => {
  const f = await seed();
  onlineCapable(app, f);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.agent.id));
  const res = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
  assert.equal(res.status, 404);
  assert.equal(res.raw, unknown.raw);
});

test("an agent credential is refused 401", async ({ app }) => {
  const f = await seed();
  const computers = onlineCapable(app, f);
  const minted = await mintAgentCredential({ agentId: f.agent.id, scopes: ["send", "read"], name: "ctxv-agent", issuedVia: "human", createdByUserId: f.creator.id });
  for (const path of [`/api/agents/${f.agent.id}/messages/${f.message.id}/context`, `/api/agents/${f.agent.id}/context-views`]) {
    const res = await fetch(`${app.baseUrl}${path}`, { headers: { Authorization: `Bearer ${minted.apiKey}`, "X-Server-Id": f.server.id } });
    assert.equal(res.status, 401, path);
  }
  assert.equal(computers.frames.length, 0);
});

test("a Guest gets the unknown-agent 404, even as the agent's recorded creator", async ({ app }) => {
  const f = await seed();
  const computers = onlineCapable(app, f);
  await seedBoundGuest({ serverId: f.server.id, userId: f.creator.id });
  const res = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
  assert.equal(res.status, 404);
  assert.equal(res.raw, unknown.raw);
  const views = await fetch(`${app.baseUrl}/api/agents/${f.agent.id}/context-views`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(f.creator.email)}`, "X-Server-Id": f.server.id },
  });
  assert.equal(views.status, 404);
  assert.equal(computers.frames.length, 0, "nothing reached the Computer");
});

test("the Guest exception stays narrow: other agent sub-paths and writes on View Context paths are still the router's 403", async ({ app }) => {
  const f = await seed();
  const computers = onlineCapable(app, f);
  await seedBoundGuest({ serverId: f.server.id, userId: f.creator.id });
  const headers = { Authorization: `Bearer ${await tokenForHuman(f.creator.email)}`, "X-Server-Id": f.server.id };
  const guestRefusal = { error: "Guests can't open the server's agent directory" };
  const requests: Array<[string, string]> = [
    ["GET", `/api/agents/${f.agent.id}/channels`],
    ["GET", `/api/agents/${f.agent.id}/activity-log`],
    ["POST", `/api/agents/${f.agent.id}/messages/${f.message.id}/context`],
    ["POST", `/api/agents/${f.agent.id}/context-views`],
    ["GET", `/api/agents/${f.agent.id}/messages/${f.message.id}/context/extra`],
  ];
  for (const [method, path] of requests) {
    const res = await fetch(`${app.baseUrl}${path}`, { method, headers });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), guestRefusal, `${method} ${path}`);
  }
  assert.equal(computers.frames.length, 0);
});

// --- Availability, after access --------------------------------------------

test("offline and old_daemon answer at once with the Computer and its owner, and are audited", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, { capable: [f.computer.machineId] });
  const offline = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(offline.status, 200);
  assert.equal(offline.cacheControl, "no-store");
  assert.deepEqual(offline.body, {
    ok: false,
    reason: "offline",
    computer: { id: f.computer.machineId, name: "ctxv-mac" },
    computerOwner: { id: f.owner.id, name: "ctxv-owner" },
  });

  const computers = fakeComputers(app, { online: [f.computer.machineId] });
  const old = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(old.body.reason, "old_daemon");
  assert.equal(computers.frames.length, 0, "no request to a daemon that did not advertise the capability");

  const failed = onlineCapable(app, f, { sendFails: true });
  const unsent = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(unsent.body.reason, "offline", "a request that could not be sent is offline");
  assert.equal(failed.frames.length, 0);

  const rows = await waitForAudit(f.agent.id, 3);
  assert.deepEqual(rows.map((row) => (row.metadata as { outcome: string }).outcome).sort(), ["offline", "offline", "old_daemon"]);
  const attempts = await attemptRows(f.agent.id);
  assert.equal(attempts.length, 3, "every attempt is recorded, offline and old_daemon too");
  assert.deepEqual(new Set(attempts.map((row) => row.requestId)), new Set(rows.map((row) => row.requestId)), "each outcome is linked to its attempt");
});

// --- The happy path, identity and gzip -------------------------------------

test("happy path: the frame, then the daemon's identity result reaches the viewer and is audited", async ({ app }) => {
  const f = await seed();
  const context = contextFor(f.message.id);
  const { viewer, daemon, frame } = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context })));
  assert.equal(frame.type, "agent:context_view_request");
  assert.match(frame.requestId, /^ctxv_/);
  assert.equal(frame.agentId, f.agent.id);
  assert.equal(frame.messageId, f.message.id);
  assert.equal(frame.maxBytes, AGENT_CONTEXT_VIEW_MAX_BYTES);
  assert.deepEqual(daemon, { status: 200, body: { ok: true, code: "delivered" } });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.cacheControl, "no-store");
  assert.deepEqual(viewer.body, { ok: true, context });

  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal(row!.actorType, "human");
  assert.equal(row!.actorId, f.creator.id);
  assert.equal(row!.serverId, f.server.id);
  assert.equal(row!.targetId, f.message.id);
  assert.equal(row!.outcome, "success");
  const metadata = row!.metadata as Record<string, unknown>;
  assert.equal(metadata.outcome, "ok");
  assert.equal(metadata.machineId, f.computer.machineId);
  assert.equal(metadata.runtime, "claude");
  assert.equal(metadata.bytes, Buffer.byteLength(viewer.raw));
  assert.equal(typeof metadata.durationMs, "number");
  assert.ok(!JSON.stringify(row).includes("helpful agent"), "nothing from the context in the audit row");
  assert.equal(row!.requestId, frame.requestId);

  const [attempt, ...more] = await attemptRows(f.agent.id);
  assert.equal(more.length, 0);
  assert.equal(attempt!.requestId, frame.requestId, "the attempt and its outcome share the request id");
  assert.equal(attempt!.actorId, f.creator.id);
  assert.equal(attempt!.serverId, f.server.id);
  assert.equal(attempt!.targetId, f.message.id);
  assert.deepEqual(attempt!.metadata, { agentId: f.agent.id, messageId: f.message.id, machineId: f.computer.machineId, viewerType: "user" });
  assert.ok(attempt!.createdAt.getTime() <= row!.createdAt.getTime(), "the attempt is written first");

  const listed = await listViews(app, f.agent.id, f.owner.email, f.server.id);
  assert.deepEqual(listed.body.views.map((v: { viewer: { id: string } | null; outcome: string }) => [v.viewer?.id, v.outcome]), [
    [f.creator.id, "ok"],
  ], "an attempt and its outcome are one entry");
});

test("the attempt record failing: the viewer gets read_failed, nothing is stored or sent", async ({ app }) => {
  const f = await seed();
  let stored = 0;
  useRelay(app, {
    recordAttempt: async () => {
      throw new Error("audit write failed");
    },
    store: { ...redisAgentContextViewRequestStore, create: async (record, ttlMs) => {
      stored += 1;
      await redisAgentContextViewRequestStore.create(record, ttlMs);
    } },
  });
  const computers = onlineCapable(app, f);
  const res = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: false,
    reason: "read_failed",
    computer: { id: f.computer.machineId, name: "ctxv-mac" },
    computerOwner: { id: f.owner.id, name: "ctxv-owner" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(computers.frames.length, 0, "no request frame to the Computer");
  assert.equal(stored, 0, "no request record stored");
  assert.equal((await auditRows(f.agent.id)).length, 0, "no outcome row without an attempt");
});

test("the viewer's replica stops mid-view (no outcome row): the attempt is listed cancelled", async ({ app }) => {
  const f = await seed();
  // The outcome is never written, as when the viewer's replica stops before the view ends.
  useRelay(app, { audit: async () => {} });
  const computers = onlineCapable(app, f);
  const viewing = view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  const frame = await computers.nextFrame();

  // While the request is with the Computer, the read is already on record.
  const [attempt] = await attemptRows(f.agent.id);
  assert.equal(attempt?.requestId, frame.requestId);
  const during = await listViews(app, f.agent.id, f.owner.email, f.server.id, f.message.id);
  assert.deepEqual(during.body.views.map((v: { viewer: { id: string } | null; outcome: string }) => [v.viewer?.id, v.outcome]), [
    [f.creator.id, "cancelled"],
  ]);

  const daemon = await postResult(app, f.computer.apiKey, frame.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  assert.equal(daemon.status, 200);
  assert.equal((await viewing).status, 200);
  assert.equal((await auditRows(f.agent.id)).length, 0);
  const after = await listViews(app, f.agent.id, f.owner.email, f.server.id);
  assert.deepEqual(after.body.views.map((v: { outcome: string }) => v.outcome), ["cancelled"], "listed once, cancelled");
});

test("a gzip result over the parsed size is streamed through whole", async ({ app }) => {
  const f = await seed();
  const context = contextFor(f.message.id, "x".repeat(300 * 1024));
  const raw = Buffer.from(JSON.stringify({ ok: true, context }));
  const { viewer, daemon } = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, gzipSync(raw), { "Content-Encoding": "gzip" }));
  assert.equal(daemon.status, 200);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.raw, raw.toString("utf8"), "the daemon's bytes, in order");
});

test("a daemon failure body passes through with the Computer added", async ({ app }) => {
  const f = await seed();
  const { viewer, daemon } = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: false, reason: "not_found" })));
  assert.equal(daemon.status, 200);
  assert.deepEqual(viewer.body, {
    ok: false,
    reason: "not_found",
    computer: { id: f.computer.machineId, name: "ctxv-mac" },
    computerOwner: { id: f.owner.id, name: "ctxv-owner" },
  });
});

test("a body that is not a result is read_failed; so is an unsupported encoding (415)", async ({ app }) => {
  const f = await seed();
  const bad = await roundTrip(app, f, (sent) => postResult(app, f.computer.apiKey, sent.requestId, "{\"ok\":true,\"context\":{}}"));
  assert.equal(bad.daemon.status, 400);
  assert.equal(bad.viewer.body.reason, "read_failed");

  const encoded = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, "{}", { "Content-Encoding": "br" }));
  assert.equal(encoded.daemon.status, 415);
  assert.equal(encoded.viewer.body.reason, "read_failed");
});

// --- The cap ----------------------------------------------------------------

test("too_large: from the uncompressed-bytes hint, without reading the body", async ({ app }) => {
  const f = await seed();
  const { viewer, daemon } = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }), {
      [AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER]: String(AGENT_CONTEXT_VIEW_MAX_BYTES + 1),
    }));
  assert.equal(daemon.status, 413);
  assert.equal(viewer.status, 200);
  assert.equal(viewer.body.reason, "too_large");
  assert.equal(viewer.body.tooLargeCause, "request");
});

test("too_large: the daemon's cause reaches the viewer; an older daemon's answer has none", async ({ app }) => {
  const f = await seed();
  const withCause = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: false, reason: "too_large", tooLargeCause: "session_file" })));
  assert.equal(withCause.viewer.body.reason, "too_large");
  assert.equal(withCause.viewer.body.tooLargeCause, "session_file");
  const older = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: false, reason: "too_large" })));
  assert.equal(older.viewer.body.reason, "too_large");
  assert.equal("tooLargeCause" in older.viewer.body, false);
});

test("too_large: counted after decompression before any byte reached the viewer", async ({ app }) => {
  const f = await seed();
  useRelay(app, { maxBytes: 4 * 1024 });
  const raw = Buffer.from(JSON.stringify({ ok: true, context: contextFor(f.message.id, "y".repeat(8 * 1024)) }));
  const { viewer, daemon, frame } = await roundTrip(app, f, (sent) =>
    postResult(app, f.computer.apiKey, sent.requestId, gzipSync(raw), { "Content-Encoding": "gzip" }));
  assert.equal(frame.maxBytes, 4 * 1024, "the request carries the cap");
  assert.equal(daemon.status, 413);
  assert.equal(viewer.body.reason, "too_large");
  assert.equal(viewer.body.tooLargeCause, "request");
  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal((row!.metadata as { outcome: string }).outcome, "too_large");
});

test("past the cap after bytes reached the viewer, the viewer's response is cut, never a valid partial JSON", async ({ app }) => {
  const f = await seed();
  useRelay(app, { maxBytes: 128 * 1024 });
  const raw = Buffer.from(JSON.stringify({ ok: true, context: contextFor(f.message.id, "z".repeat(512 * 1024)) }));
  const computers = onlineCapable(app, f);
  const viewing = fetch(`${app.baseUrl}/api/agents/${f.agent.id}/messages/${f.message.id}/context`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(f.creator.email)}`, "X-Server-Id": f.server.id },
  }).then(async (res) => {
    assert.equal(res.status, 200, "headers went out with the first bytes");
    return { text: await res.text() };
  }).catch((error: unknown) => ({ error }));
  const frame = await computers.nextFrame();
  const daemon = await postResult(app, f.computer.apiKey, frame.requestId, raw);
  assert.equal(daemon.status, 413);
  const answered = await viewing;
  // The connection is cut mid-body; a client that kept what it got holds no valid JSON either.
  if ("text" in answered) assert.throws(() => JSON.parse(answered.text), "the cut body does not parse");
  else assert.ok(!(answered.error instanceof assert.AssertionError), String(answered.error));
  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal((row!.metadata as { outcome: string }).outcome, "too_large");
});

// --- Claim, credential, TTL, timeout ----------------------------------------

test("the first POST wins; a second is 409 and changes nothing", async ({ app }) => {
  const f = await seed();
  const context = contextFor(f.message.id);
  let second: { status: number; body: { ok?: boolean; code?: string } | null } | null = null;
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    const first = await postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context }));
    second = await postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: false, reason: "read_failed" }));
    return first;
  });
  assert.equal(daemon.status, 200);
  assert.deepEqual(second, { status: 409, body: { ok: false, code: "already_claimed" } });
  assert.deepEqual(viewer.body, { ok: true, context });
});

test("another Computer's credential is 404 and does not consume the request", async ({ app }) => {
  const f = await seed();
  const context = contextFor(f.message.id);
  let wrong: { status: number } | null = null;
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    wrong = await postResult(app, f.otherComputer.apiKey, sent.requestId, JSON.stringify({ ok: false, reason: "not_found" }));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context }));
  });
  assert.equal(wrong!.status, 404);
  assert.equal(daemon.status, 200);
  assert.deepEqual(viewer.body, { ok: true, context });
});

test("a malformed or unknown request id: 404 and 410", async ({ app }) => {
  const f = await seed();
  assert.equal((await postResult(app, f.computer.apiKey, "nope", "{}")).status, 404);
  assert.equal((await postResult(app, f.computer.apiKey, `ctxv_${randomUUID().replace(/-/g, "")}`, "{}")).status, 410);
});

test("the viewer times out expired; a POST after the TTL is 410", async ({ app }) => {
  const f = await seed();
  useRelay(app, { waitMs: 150, ttlMs: 300 });
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  });
  assert.equal(viewer.body.reason, "expired");
  assert.deepEqual(daemon, { status: 410, body: { ok: false, code: "expired" } });
  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal((row!.metadata as { outcome: string }).outcome, "expired");
});

test("a POST after the viewer timed out (within the TTL) is 410: no viewer waits", async ({ app }) => {
  const f = await seed();
  useRelay(app, { waitMs: 100 });
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  });
  assert.equal(viewer.body.reason, "expired");
  assert.equal(daemon.status, 410);
});

// --- Re-checks when the result arrives --------------------------------------

test("the agent moved to another Computer before the POST: agent_moved, daemon 409", async ({ app }) => {
  const f = await seed();
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    await getDb().update(agents).set({ machineId: f.otherComputer.machineId }).where(eq(agents.id, f.agent.id));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  });
  assert.deepEqual(daemon, { status: 409, body: { ok: false, code: "agent_moved" } });
  assert.equal(viewer.body.reason, "agent_moved");
  assert.ok(!viewer.raw.includes("helpful agent"));
});

test("access revoked between the request and the POST: the viewer gets the unknown-agent 404, the daemon 403", async ({ app }) => {
  const f = await seed();
  const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    // The agent is recorded as another member's: its creator (a member) may no longer view it.
    await getDb().update(agents).set({ creatorId: f.member.id }).where(eq(agents.id, f.agent.id));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  });
  assert.deepEqual(daemon, { status: 403, body: { ok: false, code: "refused" } });
  assert.equal(viewer.status, 404);
  assert.equal(viewer.raw, unknown.raw);
  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal((row!.metadata as { outcome: string }).outcome, "refused");
});

test("the creator removed from the Server while the request waits is refused", async ({ app }) => {
  const f = await seed();
  const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
  const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
    await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.creator.id)));
    return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
  });
  assert.deepEqual(daemon, { status: 403, body: { ok: false, code: "refused" } });
  assert.equal(viewer.status, 404);
  assert.equal(viewer.raw, unknown.raw);
  const [row] = await waitForAudit(f.agent.id, 1);
  assert.equal((row!.metadata as { outcome: string }).outcome, "refused");
});

test("an agent on no Computer is no_computer, with no Computer named", async ({ app }) => {
  const f = await seed();
  fakeComputers(app, {});
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, f.agent.id));
  const res = await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, reason: "no_computer", computer: null, computerOwner: null });
});

test("the agent deleted or now another Server's when the result arrives: refused like any refusal, never agent_moved", async ({ app }) => {
  const g = await seed();
  for (const change of ["deleted", "another Server"] as const) {
    const f = await seed();
    const unknown = await view(app, randomUUID(), f.message.id, f.creator.email, f.server.id);
    const { viewer, daemon } = await roundTrip(app, f, async (sent) => {
      await getDb().update(agents)
        .set(change === "deleted" ? { deletedAt: new Date() } : { serverId: g.server.id })
        .where(eq(agents.id, f.agent.id));
      return postResult(app, f.computer.apiKey, sent.requestId, JSON.stringify({ ok: true, context: contextFor(f.message.id) }));
    });
    assert.deepEqual(daemon, { status: 403, body: { ok: false, code: "refused" } }, change);
    assert.deepEqual(refusalShape(viewer), refusalShape(unknown), change);
  }
});

// --- Viewers list -----------------------------------------------------------

async function listViews(app: AppHandle, agentId: string, email: string, serverId: string, messageId?: string) {
  const query = messageId ? `?messageId=${messageId}` : "";
  const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/context-views${query}`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null, cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type") };
}

test("viewers list: newest first, filtered by message, a former member as null; same refusals", async ({ app }) => {
  const f = await seed();
  const [secondMessage] = await getDb().insert(messages).values({ channelId: (await getDb().select().from(messages).where(eq(messages.id, f.message.id)))[0]!.channelId, senderType: "agent", senderId: f.agent.id, content: "again" }).returning();
  fakeComputers(app, { capable: [f.computer.machineId] });
  await view(app, f.agent.id, f.message.id, f.creator.email, f.server.id);
  await waitForAudit(f.agent.id, 1);
  await view(app, f.agent.id, secondMessage!.id, f.admin.email, f.server.id);
  await waitForAudit(f.agent.id, 2);

  const all = await listViews(app, f.agent.id, f.owner.email, f.server.id);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.views.map((v: { viewer: { id: string } | null; outcome: string }) => [v.viewer?.id, v.outcome]), [
    [f.admin.id, "offline"],
    [f.creator.id, "offline"],
  ]);
  assert.deepEqual(all.body.views[0].viewer, { id: f.admin.id, name: "ctxv-admin" });
  assert.ok(!Number.isNaN(Date.parse(all.body.views[0].at)));

  const one = await listViews(app, f.agent.id, f.owner.email, f.server.id, f.message.id);
  assert.deepEqual(one.body.views.map((v: { viewer: { id: string } }) => v.viewer.id), [f.creator.id]);

  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  const after = await listViews(app, f.agent.id, f.owner.email, f.server.id);
  assert.equal(after.body.views[0].viewer, null, "a former member is not named");
  await seedBoundGuest({ serverId: f.server.id, userId: f.creator.id });
  const demoted = await listViews(app, f.agent.id, f.owner.email, f.server.id, f.message.id);
  assert.deepEqual(demoted.body.views.map((v: { viewer: unknown }) => v.viewer), [null], "someone now a Guest is not named either");

  const unknown = await listViews(app, randomUUID(), f.member.email, f.server.id);
  const refused = await listViews(app, f.agent.id, f.member.email, f.server.id);
  assert.equal(refused.status, 404);
  assert.equal(refused.raw, unknown.raw);
});

test("viewers list: a malformed messageId is the same 404 as every refusal, whoever asks", async ({ app }) => {
  const f = await seed();
  const off = await seed({ flag: false });
  const unknown = await listViews(app, randomUUID(), f.member.email, f.server.id);
  const cases: Array<[string, ReturnType<typeof listViews>]> = [
    ["flag off", listViews(app, off.agent.id, off.owner.email, off.server.id, "not-a-uuid")],
    ["no access", listViews(app, f.agent.id, f.member.email, f.server.id, "not-a-uuid")],
    ["unknown agent", listViews(app, randomUUID(), f.creator.email, f.server.id, "not-a-uuid")],
    ["with access", listViews(app, f.agent.id, f.creator.email, f.server.id, "not-a-uuid")],
  ];
  for (const [label, pending] of cases) {
    const res = await pending;
    assert.deepEqual(refusalShape(res), refusalShape(unknown), label);
  }
});

test("viewers list of a personal assistant: its owner only", async ({ app }) => {
  const f = await seed();
  await getDb().update(agents).set({ assistantOwnerUserId: f.creator.id, machineId: null }).where(eq(agents.id, f.agent.id));
  const unknown = await listViews(app, randomUUID(), f.owner.email, f.server.id);
  for (const viewer of [f.owner, f.admin]) {
    const res = await listViews(app, f.agent.id, viewer.email, f.server.id);
    assert.equal(res.status, 404);
    assert.equal(res.raw, unknown.raw);
  }
  assert.equal((await listViews(app, f.agent.id, f.creator.email, f.server.id)).status, 200);
});
