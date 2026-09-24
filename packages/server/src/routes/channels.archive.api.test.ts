import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { notificationEvents, users, serverMembers } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import {
  createChannel,
  addHuman,
  addAgent,
  archiveChannel,
  unarchiveChannel,
  getOrCreateThread,
  setLocalChannelArchivedByAgent,
} from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { registerMachine } from "../services/machineService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type Fixtures = {
  serverId: string;
  channelId: string;
  channelName: string;
  parentMessageId: string;
  ownerId: string;
  otherUserId: string;
  agentId: string;
  extraAgentId: string;
  ownerToken: string;
  apiKey: string;
};

async function seedArchiveFixture(baseUrl: string): Promise<Fixtures> {
  const db = getDb();

  const [owner] = await db.insert(users).values({
    email: "archive-owner@slock.test",
    name: "arch-owner",
    displayName: "Archive Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [otherUser] = await db.insert(users).values({
    email: "archive-other@slock.test",
    name: "arch-other",
    displayName: "Archive Other",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Archive Test Server", "archive-test", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: otherUser.id, role: "member" });

  const agent = await createAgent(server.id, "arch-agent", { runtime: "codex" });
  const extraAgent = await createAgent(server.id, "arch-agent-extra", { runtime: "codex" });

  const channel = await createChannel(server.id, "archive-room");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, otherUser.id);
  await addAgent(channel.id, agent.id);

  const parentMessage = await createMessage(channel.id, "user", owner.id, "seed message for thread");

  const { machine, apiKey } = await registerMachine(server.id, owner.id, "archive-test-daemon");
  await assignMachine(agent.id, machine.id);
  await assignMachine(extraAgent.id, machine.id);

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "archive-owner@slock.test", password: "password123" }),
  });
  assert.equal(loginRes.status, 200, "owner login must succeed");
  const loginBody = await loginRes.json() as { accessToken: string };

  return {
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    parentMessageId: parentMessage.id,
    ownerId: owner.id,
    otherUserId: otherUser.id,
    agentId: agent.id,
    extraAgentId: extraAgent.id,
    ownerToken: loginBody.accessToken,
    apiKey,
  };
}

function userHeaders(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

function agentHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

type ArchivedProbe = {
  label: string;
  method: "POST" | "DELETE" | "PATCH";
  path: (f: Fixtures) => string;
  body?: (f: Fixtures) => unknown;
  headers: (f: Fixtures) => Record<string, string>;
};

/**
 * Every write-path surface that must return 409 {code: "channel_archived"}
 * when the channel is archived. This is the pinned readonly contract.
 */
const archivedProbes: ArchivedProbe[] = [
  {
    label: "PATCH /channels/:id (rename/description)",
    method: "PATCH",
    path: (f) => `/api/channels/${f.channelId}`,
    body: () => ({ name: "should-not-rename" }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/members (add human)",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/members`,
    body: (f) => ({ userId: f.otherUserId }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/members (add agent)",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/members`,
    body: (f) => ({ agentId: f.extraAgentId }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/members/batch",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/members/batch`,
    body: (f) => ({ userIds: [f.otherUserId], agentIds: [f.extraAgentId] }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "DELETE /channels/:id/members/user/:memberId",
    method: "DELETE",
    path: (f) => `/api/channels/${f.channelId}/members/user/${f.otherUserId}`,
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "DELETE /channels/:id/members/agent/:memberId",
    method: "DELETE",
    path: (f) => `/api/channels/${f.channelId}/members/agent/${f.agentId}`,
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/join",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/join`,
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/leave",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/leave`,
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /channels/:id/threads (create thread)",
    method: "POST",
    path: (f) => `/api/channels/${f.channelId}/threads`,
    body: (f) => ({ parentMessageId: f.parentMessageId, content: "should not post" }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /messages (send to channel)",
    method: "POST",
    path: () => `/api/messages`,
    body: (f) => ({ channelId: f.channelId, content: "should not post" }),
    headers: (f) => userHeaders(f.ownerToken, f.serverId),
  },
  {
    label: "POST /internal/agent/:id/send",
    method: "POST",
    path: (f) => `/internal/agent/${f.agentId}/send`,
    body: (f) => ({ target: `#${f.channelName}`, content: "bot reply on archived" }),
    headers: (f) => agentHeaders(f.apiKey),
  },
  {
    label: "POST /internal/agent/:id/channels/:channelId/join",
    method: "POST",
    path: (f) => `/internal/agent/${f.agentId}/channels/${f.channelId}/join`,
    headers: (f) => agentHeaders(f.apiKey),
  },
  {
    label: "POST /internal/agent/:id/channels/:channelId/leave",
    method: "POST",
    path: (f) => `/internal/agent/${f.agentId}/channels/${f.channelId}/leave`,
    headers: (f) => agentHeaders(f.apiKey),
  },
];

async function callProbe(baseUrl: string, probe: ArchivedProbe, f: Fixtures) {
  const body = probe.body ? probe.body(f) : undefined;
  return fetch(`${baseUrl}${probe.path(f)}`, {
    method: probe.method,
    headers: probe.headers(f),
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("archived channel: every write-path endpoint returns 409 channel_archived", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  // Archive directly via the service so we test the freeze itself, not the
  // archive route (which is covered by its own test below).
  await archiveChannel(f.channelId, f.ownerId);

  for (const probe of archivedProbes) {
    const res = await callProbe(app.baseUrl, probe, f);
    assert.equal(res.status, 409, `${probe.label} must return 409 when archived (got ${res.status})`);
    const errBody = await res.json() as { code?: string; error?: string };
    assert.equal(
      errBody.code,
      "channel_archived",
      `${probe.label} must set code="channel_archived" (got: ${JSON.stringify(errBody)})`,
    );
  }
});

test("legacy channel-agent write routes are gone while member routes remain available", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  let res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/agents`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ agentId: f.extraAgentId }),
  });
  assert.equal(res.status, 404, "legacy add route must not be registered");

  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/agents/${f.agentId}`, {
    method: "DELETE",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 404, "legacy remove route must not be registered");

  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/members`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ agentId: f.extraAgentId }),
  });
  assert.equal(res.status, 200, "replacement member add route must remain available");

  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/members/agent/${f.extraAgentId}`, {
    method: "DELETE",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200, "replacement member remove route must remain available");
});

test("archived thread inherits freeze: sending to a thread under an archived parent is rejected", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  // Create a thread under the channel while it's still active.
  const thread = await getOrCreateThread(f.parentMessageId, f.ownerId, "user");

  // Archive the parent.
  await archiveChannel(f.channelId, f.ownerId);

  // Thread write via /api/messages — should be rejected because parent is archived.
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ channelId: thread.id, content: "reply to archived thread" }),
  });
  assert.equal(res.status, 409, "post to thread under archived parent must be rejected");
  const errBody = await res.json() as { code?: string };
  assert.equal(errBody.code, "channel_archived");
});

test("unarchive restores the full write surface", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  await archiveChannel(f.channelId, f.ownerId);
  await unarchiveChannel(f.channelId);

  // Representative success cases — one per category. Full matrix isn't
  // needed here; the archived-path test above proves the freeze is uniform,
  // and these prove the gate is on `archivedAt` and not something stickier.

  // 1. User message send.
  let res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ channelId: f.channelId, content: "post-unarchive" }),
  });
  assert.equal(res.status, 200, "user can send after unarchive");

  // 2. Agent internal send.
  res = await fetch(`${app.baseUrl}/internal/agent/${f.agentId}/send`, {
    method: "POST",
    headers: agentHeaders(f.apiKey),
    body: JSON.stringify({ target: `#${f.channelName}`, content: "agent post-unarchive" }),
  });
  assert.equal(res.status, 200, "agent can send after unarchive");

  // 3. PATCH rename.
  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}`, {
    method: "PATCH",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ description: "back in business" }),
  });
  assert.equal(res.status, 200, "PATCH works after unarchive");

  // 4. Member add (extra agent).
  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/members`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
    body: JSON.stringify({ agentId: f.extraAgentId }),
  });
  assert.equal(res.status, 200, "member add works after unarchive");
});

test("POST /channels/:id/archive is idempotent and returns 200 even if already archived", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  let res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/archive`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200, "first archive must succeed");
  const first = await res.json() as { archivedAt: string | null };
  assert.ok(first.archivedAt, "archivedAt must be set");

  const firstEvents = await getDb().select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, f.channelId));
  assert.deepEqual(
    firstEvents.map((event) => event.eventType).sort(),
    ["channel.archived", "server.public_channel_archived", "server.public_channel_created"],
  );
  assert.ok(firstEvents.every((event) => event.subjectType === "channel"));

  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/archive`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200, "re-archiving an already archived channel is idempotent");
  const secondEvents = await getDb().select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, f.channelId));
  assert.equal(secondEvents.length, firstEvents.length, "idempotent archive must not emit duplicate events");
});

test("agent archive emits public channel app notifications exactly once", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);
  const first = await setLocalChannelArchivedByAgent(f.channelId, f.agentId, true);
  assert.equal(first.changed, true);

  const firstEvents = await getDb().select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, f.channelId));
  assert.deepEqual(
    firstEvents.map((event) => event.eventType).sort(),
    ["channel.archived", "server.public_channel_archived", "server.public_channel_created"],
  );
  const archiveEvents = firstEvents.filter((event) => event.eventType.endsWith("archived"));
  assert.ok(archiveEvents.every((event) => event.provenance.actor_type === "agent"));

  const second = await setLocalChannelArchivedByAgent(f.channelId, f.agentId, true);
  assert.equal(second.changed, false);
  const secondEvents = await getDb().select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, f.channelId));
  assert.equal(secondEvents.length, firstEvents.length);
});

test("POST /channels/:id/unarchive works and is idempotent on a non-archived channel", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  await archiveChannel(f.channelId, f.ownerId);

  let res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/unarchive`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200, "first unarchive must succeed");
  const first = await res.json() as { archivedAt: string | null };
  assert.equal(first.archivedAt, null, "archivedAt must be cleared");

  res = await fetch(`${app.baseUrl}/api/channels/${f.channelId}/unarchive`, {
    method: "POST",
    headers: userHeaders(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200, "unarchiving a non-archived channel is idempotent");
});

test("search still returns messages from archived channels (with channelArchivedAt set)", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  // Seed a distinctive message so we can target it with a full-text search.
  const marker = "zephyrglint";
  await createMessage(f.channelId, "user", f.ownerId, `lorem ${marker} ipsum`);

  // Precondition: search finds it while the channel is active.
  let res = await fetch(
    `${app.baseUrl}/api/messages/search?q=${encodeURIComponent(marker)}`,
    { headers: userHeaders(f.ownerToken, f.serverId) },
  );
  assert.equal(res.status, 200, "search must succeed pre-archive");
  let body = await res.json() as {
    results: Array<{ id: string; channelId: string; channelArchivedAt: string | null; content: string }>;
  };
  assert.ok(
    body.results.some((r) => r.channelId === f.channelId),
    "pre-archive: search must find the seeded message",
  );

  // Archive the channel.
  await archiveChannel(f.channelId, f.ownerId);

  // The message must STILL appear in search, and the result row must carry
  // the archive timestamp so the UI can render an "(archived)" affordance.
  res = await fetch(
    `${app.baseUrl}/api/messages/search?q=${encodeURIComponent(marker)}`,
    { headers: userHeaders(f.ownerToken, f.serverId) },
  );
  assert.equal(res.status, 200, "search must still succeed after archive");
  body = await res.json() as typeof body;

  const hit = body.results.find((r) => r.channelId === f.channelId);
  assert.ok(hit, "archived channel's messages must remain searchable");
  assert.ok(hit!.channelArchivedAt, "search result must expose channelArchivedAt for the UI");

  const contextRes = await fetch(
    `${app.baseUrl}/api/messages/context/${hit!.id}?channelId=${f.channelId}`,
    { headers: userHeaders(f.ownerToken, f.serverId) },
  );
  assert.equal(
    contextRes.status,
    200,
    "clicking an archived-channel search hit must still hydrate its read-only message context",
  );
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    channelArchived: boolean;
    messages: Array<{ id: string; content: string }>;
  };
  assert.equal(context.channelId, f.channelId);
  assert.equal(context.targetMessageId, hit!.id);
  assert.equal(context.channelArchived, true);
  assert.ok(
    context.messages.some((message) => message.id === hit!.id && message.content.includes(marker)),
    "archived context response must include the clicked message",
  );
});

test("search can be scoped to an archived channel (channelId filter still works)", async ({ app }) => {
  const f = await seedArchiveFixture(app.baseUrl);

  const marker = "mothbolt";
  await createMessage(f.channelId, "user", f.ownerId, `lorem ${marker} ipsum`);

  await archiveChannel(f.channelId, f.ownerId);

  const res = await fetch(
    `${app.baseUrl}/api/messages/search?q=${encodeURIComponent(marker)}&channelId=${f.channelId}`,
    { headers: userHeaders(f.ownerToken, f.serverId) },
  );
  assert.equal(
    res.status,
    200,
    "scoping search to an archived channel must not be rejected",
  );
  const body = await res.json() as {
    results: Array<{ channelId: string; channelArchivedAt: string | null }>;
  };
  assert.equal(body.results.length, 1, "scoped search must return the archived channel's hit");
  assert.equal(body.results[0].channelId, f.channelId);
  assert.ok(body.results[0].channelArchivedAt);
});
