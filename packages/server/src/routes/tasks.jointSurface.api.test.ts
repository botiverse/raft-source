import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  channels,
  channelAgents,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  taskEvents,
  tasks,
  users,
} from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import * as channelService from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type EmittedEvent = { rooms: string[]; event: string; payload: unknown };

type FakeAudience = {
  to(room: string): FakeAudience;
  in(room: string): FakeAudience;
  emit(event: string, payload: unknown): void;
  socketsJoin(room: string): void;
};

function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const makeAudience = (rooms: string[]): FakeAudience => ({
    to(room: string) {
      return makeAudience([...rooms, room]);
    },
    in(room: string) {
      return makeAudience([...rooms, room]);
    },
    emit(event: string, payload: unknown) {
      events.push({ rooms, event, payload });
    },
    socketsJoin() {},
  });
  app.set("io", { to: (room: string) => makeAudience([room]), in: (room: string) => makeAudience([room]) });
  return events;
}

type Delivery = { agentId: string; payload: Record<string, unknown> };

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === "deliverMessage") {
        return async (agentId: string, payload: Record<string, unknown>) => {
          deliveries.push({ agentId, payload });
        };
      }
      if (prop === "receiveMessages" || prop === "peekPendingMessages") return async () => [];
      if (prop === "shutdown" || prop === "setIO" || prop === "evictCache") return () => {};
      return async () => {};
    },
  });
  app.set("agentOrchestrator", stub);
  return deliveries;
}

async function waitFor(check: () => Promise<void> | void, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await check();
      return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError;
}

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function createJointFixture(opts: {
  slug: string;
  channelName: string;
  hostOwnerId: string;
  peerOwnerId: string;
}) {
  const db = getDb();
  const hostServer = await createServer("Joint Host", `${opts.slug}-host`, opts.hostOwnerId);
  const peerServer = await createServer("Joint Peer", `${opts.slug}-peer`, opts.peerOwnerId);
  const canonical = await channelService.createChannel(hostServer.id, `${opts.channelName}-storage`, undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, opts.channelName, undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, opts.channelName, undefined, "joint");
  await channelService.addHuman(hostProjection.id, opts.hostOwnerId);
  await channelService.addHuman(peerProjection.id, opts.peerOwnerId);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: opts.hostOwnerId,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: opts.hostOwnerId,
    },
    {
      jointChannelId: joint.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: opts.peerOwnerId,
    },
  ]);
  return { hostServer, peerServer, canonical, hostProjection, peerProjection, joint };
}

async function findSystemMessages(contentFragment: string) {
  const db = getDb();
  const rows = await db.select().from(messages).where(eq(messages.messageType, "system"));
  return rows.filter((row) => row.content.includes(contentFragment));
}

function assertMessageNewProjectedToLocalRooms(
  events: EmittedEvent[],
  messageId: string,
  localChannels: readonly { id: string }[],
  label: string,
) {
  const hits = events.filter((event) => (
    event.event === "message:new"
    && (event.payload as { id?: string }).id === messageId
  ));
  for (const local of localChannels) {
    const roomHits = hits.filter((event) => event.rooms.includes(`channel:${local.id}`));
    assert.equal(roomHits.length, 1, `${label} projects exactly once to local room channel:${local.id}`);
    assert.equal((roomHits[0]!.payload as { channelId?: string }).channelId, local.id);
  }
}

test("GET /api/tasks/server hides membership-gated joint tasks from non-members", async ({ app }) => {
    const db = getDb();
    const hostOwner = await seedUser("joint-snap-host@slock.test", "joint-snap-host");
    const hostOutsider = await seedUser("joint-snap-outsider@slock.test", "joint-snap-outsider");
    const peerOwner = await seedUser("joint-snap-peer@slock.test", "joint-snap-peer");
    const fixture = await createJointFixture({
      slug: "joint-snapshot",
      channelName: "joint-snapshot-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    await db.insert(serverMembers).values({
      serverId: fixture.hostServer.id,
      userId: hostOutsider.id,
      role: "member",
    }).onConflictDoNothing();

    const { tasks: [jointTask] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [{ title: "membership gated joint task" }]);
    const publicChannel = await channelService.createChannel(fixture.hostServer.id, "joint-snapshot-public");
    const { tasks: [publicTask] } = await taskService.createTasks(publicChannel.id, "user", hostOwner.id, [{ title: "public server task" }]);

    const assertSnapshot = async (email: string, serverId: string) => {
    const token = await tokenForHuman(email);
      const res = await fetch(`${app.baseUrl}/api/tasks/server`, { headers: authHeaders(token, serverId) });
      assert.equal(res.status, 200, `expected server snapshot 200, got ${res.status}`);
      return (await res.json()) as { tasks: Array<{ id: string; channelId: string }> };
    };

    // Host projection member sees the joint task projected to the host local id.
    const hostSnapshot = await assertSnapshot(hostOwner.email, fixture.hostServer.id);
    const hostJointRow = hostSnapshot.tasks.find((task) => task.id === jointTask.id);
    assert.ok(hostJointRow, "host member should see the joint task");
    assert.equal(hostJointRow.channelId, fixture.hostProjection.id);

    // The raw canonical storage id is never an HTTP authority surface, even in
    // this fixture where it happens to share the host server id.
  const hostToken = await tokenForHuman(hostOwner.email);
    const rawCanonicalRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fixture.canonical.id}`, {
      headers: authHeaders(hostToken, fixture.hostServer.id),
    });
    assert.equal(rawCanonicalRes.status, 404, "canonical storage id must not bypass local joint membership");

    // Peer projection member sees the same canonical task projected to the peer local id.
    const peerSnapshot = await assertSnapshot(peerOwner.email, fixture.peerServer.id);
    const peerJointRow = peerSnapshot.tasks.find((task) => task.id === jointTask.id);
    assert.ok(peerJointRow, "peer member should see the joint task");
    assert.equal(peerJointRow.channelId, fixture.peerProjection.id);

    // A server member outside the joint projection must NOT see the joint task,
    // while still seeing ordinary public-channel tasks.
    const outsiderSnapshot = await assertSnapshot(hostOutsider.email, fixture.hostServer.id);
    assert.equal(
      outsiderSnapshot.tasks.some((task) => task.id === jointTask.id),
      false,
      "non-member must not see membership-gated joint tasks in the server snapshot",
    );
    assert.ok(outsiderSnapshot.tasks.some((task) => task.id === publicTask.id), "public task stays visible server-wide");

  const outsiderToken = await tokenForHuman(hostOutsider.email);
    const outsiderClaim = await fetch(`${app.baseUrl}/api/tasks/${jointTask.id}/claim`, {
      method: "PATCH",
      headers: authHeaders(outsiderToken, fixture.hostServer.id),
    });
    assert.equal(outsiderClaim.status, 404, "server membership alone must not authorize a joint task mutation");

    // Assignment eligibility is the union of active projections: the host
    // member may assign the canonical task to a user present only on the peer
    // projection, while the request itself remains authorized by the host row.
    const assignPeer = await fetch(`${app.baseUrl}/api/tasks/${jointTask.id}/assignee`, {
      method: "PATCH",
      headers: authHeaders(hostToken, fixture.hostServer.id),
      body: JSON.stringify({
        assignee: { type: "user", id: peerOwner.id },
        expectedRevision: jointTask.revision,
      }),
    });
    assert.equal(assignPeer.status, 200, `peer-only joint assignee should be eligible, got ${assignPeer.status}`);

    // Closing a joint withdraws every request-time projection, but its
    // canonical row still exists for storage/history. It must never fall back
    // to looking like an ordinary host-server channel.
    await db.update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, fixture.joint.id));
    const closedLocalRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fixture.hostProjection.id}`, {
      headers: authHeaders(hostToken, fixture.hostServer.id),
    });
    assert.equal(closedLocalRes.status, 404, "closed joint projection must stop authorizing task reads");
    const closedCanonicalRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fixture.canonical.id}`, {
      headers: authHeaders(hostToken, fixture.hostServer.id),
    });
    assert.equal(closedCanonicalRes.status, 404, "closed joint storage must remain non-authoritative");
    const closedSnapshot = await assertSnapshot(hostOwner.email, fixture.hostServer.id);
    assert.equal(closedSnapshot.tasks.some((task) => task.id === jointTask.id), false);
    assert.ok(closedSnapshot.tasks.some((task) => task.id === publicTask.id));
});

test("human joint task create/convert/delete summaries persist canonically and fan out to every local surface", async ({ app }) => {
    const hostOwner = await seedUser("joint-sys-host@slock.test", "joint-sys-host");
    const peerOwner = await seedUser("joint-sys-peer@slock.test", "joint-sys-peer");
    const fixture = await createJointFixture({
      slug: "joint-sys",
      channelName: "joint-sys-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const hostAgent = await createAgent(fixture.hostServer.id, "joint-sys-host-agent", { runtime: "claude" });
    const peerAgent = await createAgent(fixture.peerServer.id, "joint-sys-peer-agent", { runtime: "claude" });
    await channelService.addAgent(fixture.hostProjection.id, hostAgent.id);
    await channelService.addAgent(fixture.peerProjection.id, peerAgent.id);

    const events = installFakeIo(app.app);
    const deliveries = installRecordingOrchestrator(app.app);
  const token = await tokenForHuman(hostOwner.email);
    const headers = authHeaders(token, fixture.hostServer.id);

    // --- create ---
    const createRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fixture.hostProjection.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tasks: [{ title: "joint summary task" }] }),
    });
    assert.equal(createRes.status, 200, `expected joint create 200, got ${createRes.status}`);
    const createBody = await createRes.json() as { tasks: Array<{ id: string; messageId: string | null }> };
    const createdTaskId = createBody.tasks[0]!.id;
    const createdTaskBodyMessageId = createBody.tasks[0]!.messageId;
    assert.ok(createdTaskBodyMessageId, "created task must expose its canonical body message id");

    // Agent delivery for the actual task body is a distinct, load-bearing path
    // from the later system summary. Both local projections must receive the
    // same canonical body message id/content, rewritten only at channel_id.
    await waitFor(() => {
      for (const [agentId, localChannelId] of [
        [hostAgent.id, fixture.hostProjection.id],
        [peerAgent.id, fixture.peerProjection.id],
      ] as const) {
        const hits: Delivery[] = deliveries.filter((delivery) => (
          delivery.agentId === agentId
          && delivery.payload.message_id === createdTaskBodyMessageId
        ));
        assert.equal(hits.length, 1, `agent ${agentId} should receive exactly one projected task body`);
        assert.equal(hits[0]!.payload.content, "joint summary task");
        assert.equal(hits[0]!.payload.channel_id, localChannelId);
      }
    });

    let createdSummaryId = "";
    await waitFor(async () => {
      const summaries = await findSystemMessages("new task");
      assert.equal(summaries.length, 1, "exactly one durable create summary row");
      assert.equal(summaries[0]!.channelId, fixture.canonical.id, "create summary must persist canonically");
      createdSummaryId = summaries[0]!.id;
    });

    // Realtime projection: every local surface room gets the summary with its own local channelId.
    await waitFor(() => {
      for (const local of [fixture.hostProjection, fixture.peerProjection]) {
        const hit = events.find((event) =>
          event.event === "message:new"
          && event.rooms.includes(`channel:${local.id}`)
          && (event.payload as { id?: string }).id === createdSummaryId);
        assert.ok(hit, `expected message:new in room channel:${local.id}`);
        assert.equal((hit.payload as { channelId?: string }).channelId, local.id);
      }
    });

    // Inbox facts: per-surface rows, with the causal actor born-read.
    await waitFor(async () => {
      const db = getDb();
      const facts = await db.select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, createdSummaryId));
      const peerFact = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === peerOwner.id);
      assert.ok(peerFact, "peer owner should have an inbox fact");
      assert.equal(peerFact.sourceChannelId, fixture.peerProjection.id);
      assert.equal(peerFact.unreadEligible, true);
      const hostFact = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === hostOwner.id);
      assert.ok(hostFact, "host owner should have an inbox fact");
      assert.equal(hostFact.sourceChannelId, fixture.hostProjection.id);
      assert.equal(hostFact.unreadEligible, false, "causal actor's own row is born-read");
    });

    // Agent delivery: the peer agent is notified on its own local surface.
    await waitFor(() => {
      const hit = deliveries.find((delivery) =>
        delivery.agentId === peerAgent.id
        && delivery.payload.message_id === createdSummaryId);
      assert.ok(hit, "peer agent should receive the create summary");
      assert.equal(hit.payload.channel_id, fixture.peerProjection.id);
      assert.equal(hit.payload.sender_type, "system");
    });

    // --- convert ---
    const convertTarget = await createMessage(fixture.canonical.id, "user", hostOwner.id, "convert me into a joint task");
    const convertRes = await fetch(`${app.baseUrl}/api/tasks/convert-message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messageId: convertTarget.id }),
    });
    assert.equal(convertRes.status, 200, `expected joint convert 200, got ${convertRes.status}`);
    await waitFor(async () => {
      const summaries = await findSystemMessages("converted a message to task");
      assert.equal(summaries.length, 1, "exactly one durable convert summary row");
      assert.equal(summaries[0]!.channelId, fixture.canonical.id, "convert summary must persist canonically");
    });

    // --- delete ---
    const deleteRes = await fetch(`${app.baseUrl}/api/tasks/${createdTaskId}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(deleteRes.status, 200, `expected joint delete 200, got ${deleteRes.status}`);
    await waitFor(async () => {
      const summaries = await findSystemMessages("deleted #");
      assert.equal(summaries.length, 1, "exactly one durable delete summary row");
      assert.equal(summaries[0]!.channelId, fixture.canonical.id, "delete summary must persist canonically");
    });

    // No summary may ever be persisted into a local projection id.
    const db = getDb();
    const allSystem = await db.select().from(messages).where(eq(messages.messageType, "system"));
    for (const row of allSystem) {
      assert.notEqual(row.channelId, fixture.hostProjection.id, "system row leaked into host local projection");
      assert.notEqual(row.channelId, fixture.peerProjection.id, "system row leaked into peer local projection");
    }
});

test("agent joint task create summaries (legacy internal + Agent API) persist canonically and reach peer agents", async ({ app }) => {
    const hostOwner = await seedUser("joint-agent-host@slock.test", "joint-agent-host");
    const peerOwner = await seedUser("joint-agent-peer@slock.test", "joint-agent-peer");
    const fixture = await createJointFixture({
      slug: "joint-agent-sys",
      channelName: "joint-agent-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const hostAgent = await createAgent(fixture.hostServer.id, "joint-agent-host-agent", { runtime: "claude" });
    await channelService.addAgent(fixture.hostProjection.id, hostAgent.id);
    const peerAgent = await createAgent(fixture.peerServer.id, "joint-agent-peer-agent", { runtime: "claude" });
    await channelService.addAgent(fixture.peerProjection.id, peerAgent.id);
    const { machine, apiKey } = await registerMachine(fixture.peerServer.id, peerOwner.id, "joint-agent-machine");
    await assignMachine(peerAgent.id, machine.id);
    const { apiKey: agentApiKey } = await mintAgentCredential({
      agentId: peerAgent.id,
      scopes: ["tasks"],
      name: "joint-agent-task-create",
      createdByUserId: peerOwner.id,
    });
    const { apiKey: hostAgentApiKey } = await mintAgentCredential({
      agentId: hostAgent.id,
      scopes: ["tasks"],
      name: "joint-agent-task-assign",
      createdByUserId: hostOwner.id,
    });

    const deliveries = installRecordingOrchestrator(app.app);
    const realtimeEvents = installFakeIo(app.app);

    // --- legacy Agent route (internal.ts) ---
    const legacyRes = await fetch(`${app.baseUrl}/internal/agent/${peerAgent.id}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: `#${fixture.peerProjection.name}`, tasks: [{ title: "legacy agent joint task" }] }),
    });
    assert.equal(legacyRes.status, 200, `expected legacy joint create 200, got ${legacyRes.status}`);

    let legacySummaryId = "";
    await waitFor(async () => {
      const summaries = await findSystemMessages("legacy agent joint task");
      assert.equal(summaries.length, 1, "exactly one durable legacy-agent create summary");
      assert.equal(summaries[0]!.channelId, fixture.canonical.id, "legacy agent summary must persist canonically");
      legacySummaryId = summaries[0]!.id;
    });
    await waitFor(() => {
      const hit = deliveries.find((delivery) =>
        delivery.agentId === hostAgent.id
        && delivery.payload.message_id === legacySummaryId);
      assert.ok(hit, "host agent should receive the legacy-agent create summary");
      assert.equal(hit.payload.channel_id, fixture.hostProjection.id);
    });
    const [legacyBody] = await getDb().select().from(messages).where(and(
      eq(messages.channelId, fixture.canonical.id),
      eq(messages.content, "legacy agent joint task"),
      eq(messages.messageType, "chat"),
    ));
    assert.ok(legacyBody);
    await waitFor(() => {
      const hit = deliveries.find((delivery) =>
        delivery.agentId === hostAgent.id
        && delivery.payload.message_id === legacyBody.id);
      assert.ok(hit, "host agent should receive the projected legacy task body");
      assert.equal(hit.payload.channel_id, fixture.hostProjection.id);
    });

    // --- Agent API route (internalAgentApi.ts) ---
    const agentApiRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: `#${fixture.peerProjection.name}`, tasks: [{ title: "agent api joint task" }] }),
    });
    assert.equal(agentApiRes.status, 200, `expected Agent API joint create 200, got ${agentApiRes.status}: ${await agentApiRes.clone().text().catch(() => "")}`);
    const agentApiBody = await agentApiRes.json() as { tasks: Array<{ taskNumber: number; title: string }> };
    assert.equal(agentApiBody.tasks.length, 1);

    // Handle resolution and assignment eligibility both use the union of
    // active projections: a host-side agent can assign to a peer-only human
    // visible through the joint channel, without that human joining hostServer.
    const assignPeerHumanRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks/assign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostAgentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: `#${fixture.hostProjection.name}`,
        task_number: agentApiBody.tasks[0]!.taskNumber,
        assignee: `@${peerOwner.name}`,
      }),
    });
    assert.equal(
      assignPeerHumanRes.status,
      200,
      `peer-only joint member should resolve through the aggregated directory: ${await assignPeerHumanRes.clone().text()}`,
    );
    const [assignedRow] = await getDb().select().from(tasks).where(and(
      eq(tasks.channelId, fixture.canonical.id),
      eq(tasks.taskNumber, agentApiBody.tasks[0]!.taskNumber),
    ));
    assert.equal(assignedRow.claimedByType, "user");
    assert.equal(assignedRow.claimedById, peerOwner.id);

    const listRes = await fetch(
      `${app.baseUrl}/internal/agent-api/tasks?channel=${encodeURIComponent(`#${fixture.peerProjection.name}`)}`,
      { headers: { Authorization: `Bearer ${agentApiKey}` } },
    );
    assert.equal(listRes.status, 200, `expected Agent API joint list 200, got ${listRes.status}`);
    const listBody = await listRes.json() as { tasks: Array<{ channelId: string; title: string }> };
    assert.equal(listBody.tasks.filter((task) => task.title.includes("joint task")).length, 2);
    assert.ok(
      listBody.tasks.filter((task) => task.title.includes("joint task")).every((task) => task.channelId === fixture.peerProjection.id),
      "Agent API list must project every canonical row to the caller's local joint id",
    );

    const [legacyTask] = await getDb().select().from(tasks).where(and(
      eq(tasks.channelId, fixture.canonical.id),
      eq(tasks.title, "legacy agent joint task"),
    ));
    assert.ok(legacyTask);
    await getDb().update(tasks).set({
      claimedByType: "agent",
      claimedById: peerAgent.id,
      claimedAt: new Date(),
    }).where(eq(tasks.id, legacyTask.id));
    const mineRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks?mine=true&status=all`, {
      headers: { Authorization: `Bearer ${agentApiKey}` },
    });
    assert.equal(mineRes.status, 200, `expected Agent API mine list 200, got ${mineRes.status}`);
    const mineBody = await mineRes.json() as {
      tasks: Array<{ channelId: string; channelRef?: string; title: string }>;
    };
    const mineJointTask = mineBody.tasks.find((task) => task.title === "legacy agent joint task");
    assert.ok(mineJointTask, "canonical joint assignment must appear in the cross-channel mine view");
    assert.equal(mineJointTask.channelId, fixture.peerProjection.id);
    assert.equal(mineJointTask.channelRef, `#${fixture.peerProjection.name}`);
    assert.equal(
      mineBody.tasks.some((task) => task.channelId === fixture.canonical.id),
      false,
      "canonical joint storage must never appear as an agent-facing mine target",
    );

    await getDb().update(tasks).set({
      claimedByType: "agent",
      claimedById: hostAgent.id,
      claimedAt: new Date(),
    }).where(and(
      eq(tasks.channelId, fixture.canonical.id),
      eq(tasks.taskNumber, agentApiBody.tasks[0]!.taskNumber),
    ));
    const hostMineRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks?mine=true&status=all`, {
      headers: { Authorization: `Bearer ${hostAgentApiKey}` },
    });
    assert.equal(hostMineRes.status, 200, `expected host Agent API mine list 200, got ${hostMineRes.status}`);
    const hostMineBody = await hostMineRes.json() as {
      tasks: Array<{ channelId: string; channelRef?: string; title: string }>;
    };
    const hostMineJointTask = hostMineBody.tasks.find((task) => task.title === "agent api joint task");
    assert.ok(hostMineJointTask, "host assignment must resolve through the host local projection");
    assert.equal(hostMineJointTask.channelId, fixture.hostProjection.id);
    assert.equal(hostMineJointTask.channelRef, `#${fixture.hostProjection.name}`);
    assert.equal(
      hostMineBody.tasks.some((task) => task.title === "legacy agent joint task"),
      false,
      "a peer-server agent assignment must not leak into the host agent's mine view",
    );

    // An unresolved/hidden assignee must fail before either the task body or
    // canonical task row is written. Joint support must not weaken atomic
    // assigned-create merely because resolution spans two local projections.
    const rejectedTitle = "joint assigned create must remain atomic";
    const rejectedCreateRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: `#${fixture.peerProjection.name}`,
        tasks: [{ title: rejectedTitle }],
        assignee: "@joint-missing-assignee",
      }),
    });
    assert.equal(rejectedCreateRes.status, 404);
    const rejectedCreateBody = await rejectedCreateRes.json() as { code: string };
    assert.equal(rejectedCreateBody.code, "assignee_not_assignable");
    assert.equal(
      (await getDb().select().from(tasks).where(eq(tasks.title, rejectedTitle))).length,
      0,
      "failed assigned-create must not leave a canonical task row",
    );
    assert.equal(
      (await getDb().select().from(messages).where(eq(messages.content, rejectedTitle))).length,
      0,
      "failed assigned-create must not leave a task body message",
    );

    // A corrupted cross-server membership row can appear in old/imported data:
    // the channel-visible directory resolves the handle, but an agent is only
    // reachable through a projection owned by its own server. This must reach
    // the transaction and fail closed before either durable row is inserted.
    const misboundAgent = await createAgent(
      fixture.hostServer.id,
      "joint-cross-server-misbound",
      { runtime: "claude" },
    );
    await getDb().insert(channelAgents).values({
      channelId: fixture.peerProjection.id,
      agentId: misboundAgent.id,
      role: "member",
    });
    const misboundTitle = "joint assigned create rejects cross-server membership";
    const misboundCreateRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: `#${fixture.peerProjection.name}`,
        tasks: [{ title: misboundTitle }],
        assignee: `@${misboundAgent.name}`,
      }),
    });
    assert.equal(misboundCreateRes.status, 403);
    const misboundCreateBody = await misboundCreateRes.json() as { code: string };
    assert.equal(misboundCreateBody.code, "assignee_cannot_claim");
    assert.equal(
      (await getDb().select().from(tasks).where(eq(tasks.title, misboundTitle))).length,
      0,
      "cross-server assigned-create must not leave a canonical task row",
    );
    assert.equal(
      (await getDb().select().from(messages).where(eq(messages.content, misboundTitle))).length,
      0,
      "cross-server assigned-create must not leave a task body message",
    );

    // Atomic assigned-create now matches an ordinary channel: assigning self
    // starts work immediately, persists one canonical directed receipt, and
    // projects that receipt once to each local room. Only the resolved agent
    // gets directed `mentioned:true` delivery on its reachable local surface.
    const assignedCreateRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: `#${fixture.peerProjection.name}`,
        tasks: [{ title: "direct assigned joint task" }],
        assignee: `@${peerAgent.name}`,
      }),
    });
    assert.equal(
      assignedCreateRes.status,
      200,
      `expected assigned joint create 200, got ${assignedCreateRes.status}: ${await assignedCreateRes.clone().text().catch(() => "")}`,
    );
    const assignedCreateBody = await assignedCreateRes.json() as {
      tasks: Array<{
        taskNumber: number;
        status: string;
        claimedByType: string | null;
        claimedById: string | null;
        claimedAt: string | null;
      }>;
      assignmentReceipt?: { messageId: string; state: string; assignee: string };
    };
    assert.equal(assignedCreateBody.tasks.length, 1);
    assert.equal(assignedCreateBody.tasks[0]!.status, "in_progress", "self assigned create starts work");
    assert.equal(assignedCreateBody.tasks[0]!.claimedByType, "agent");
    assert.equal(assignedCreateBody.tasks[0]!.claimedById, peerAgent.id);
    assert.ok(assignedCreateBody.tasks[0]!.claimedAt, "self assigned create stamps claimedAt");
    assert.equal(assignedCreateBody.assignmentReceipt?.state, "started");
    assert.equal(assignedCreateBody.assignmentReceipt?.assignee, `@${peerAgent.name}`);

    await waitFor(async () => {
      const receiptId = assignedCreateBody.assignmentReceipt?.messageId;
      assert.ok(receiptId, "assigned create returns receipt id");
      const [receipt] = await getDb().select().from(messages).where(eq(messages.id, receiptId));
      assert.ok(receipt, "assigned create receipt row should exist");
      assert.equal(receipt.channelId, fixture.canonical.id, "assigned create receipt persists canonically");

      const mentionRows = await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, receipt.id));
      assert.equal(mentionRows.length, 1, "assigned create receipt has one logical mention");
      assert.equal(mentionRows[0]!.targetType, "agent");
      assert.equal(mentionRows[0]!.targetId, peerAgent.id);
      assert.equal(mentionRows[0]!.channelId, fixture.peerProjection.id, "mention binds to the assignee's reachable projection");

      const facts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, receipt.id));
      const personalFacts = facts.filter((fact) => fact.receiverType === "agent" && fact.receiverId === peerAgent.id);
      assert.equal(personalFacts.length, 1, "assigned create receipt has one assignee personal fact");
      assert.equal(personalFacts[0]!.sourceChannelId, fixture.peerProjection.id);

      const receiptDeliveries = deliveries.filter((delivery) => delivery.payload.message_id === receipt.id);
      const assigneeDeliveries = receiptDeliveries.filter((delivery) => delivery.agentId === peerAgent.id);
      assert.equal(assigneeDeliveries.length, 1, "resolved assignee gets one directed receipt delivery");
      assert.equal(assigneeDeliveries[0]!.payload.channel_id, fixture.peerProjection.id);
      assert.equal(assigneeDeliveries[0]!.payload.mentioned, true);
      assertMessageNewProjectedToLocalRooms(
        realtimeEvents,
        receipt.id,
        [fixture.hostProjection, fixture.peerProjection],
        "assigned create assignment receipt",
      );
    });

    const assignedOtherRes = await fetch(`${app.baseUrl}/internal/agent-api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hostAgentApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: `#${fixture.hostProjection.name}`,
        tasks: [{ title: "joint task assigned to peer human" }],
        assignee: `@${peerOwner.name}`,
      }),
    });
    assert.equal(
      assignedOtherRes.status,
      200,
      `expected peer-human assigned create 200, got ${assignedOtherRes.status}: ${await assignedOtherRes.clone().text().catch(() => "")}`,
    );
    const assignedOtherBody = await assignedOtherRes.json() as {
      tasks: Array<{ status: string; claimedByType: string | null; claimedById: string | null; claimedAt: string | null }>;
      assignmentReceipt?: { messageId: string; state: string; assignee: string };
    };
    assert.equal(assignedOtherBody.tasks[0]!.status, "todo", "assigning another actor must not claim progress for them");
    assert.equal(assignedOtherBody.tasks[0]!.claimedByType, "user");
    assert.equal(assignedOtherBody.tasks[0]!.claimedById, peerOwner.id);
    assert.equal(assignedOtherBody.tasks[0]!.claimedAt, null);
    assert.equal(assignedOtherBody.assignmentReceipt?.state, "assigned");
    assert.equal(assignedOtherBody.assignmentReceipt?.assignee, `@${peerOwner.name}`);
    const [assignedOtherMention] = await getDb().select().from(messageMentions).where(
      eq(messageMentions.messageId, assignedOtherBody.assignmentReceipt!.messageId),
    );
    assert.equal(
      assignedOtherMention.channelId,
      fixture.peerProjection.id,
      "peer-only human receipt binds to the projection where the assignee is reachable",
    );
    assert.ok(
      assignedOtherMention.notifiedAt,
      "peer-only human receipt must stamp delivery despite canonical-message/local-projection channel ids",
    );

    let agentApiSummaryId = "";
    await waitFor(async () => {
      const summaries = (await findSystemMessages("agent api joint task"))
        .filter((message) => message.content.startsWith("📋 "));
      assert.equal(summaries.length, 1, "exactly one durable Agent API create summary");
      assert.equal(summaries[0]!.channelId, fixture.canonical.id, "Agent API summary must persist canonically");
      agentApiSummaryId = summaries[0]!.id;
    });
    await waitFor(() => {
      const hit = deliveries.find((delivery) =>
        delivery.agentId === hostAgent.id
        && delivery.payload.message_id === agentApiSummaryId);
      assert.ok(hit, "host agent should receive the Agent API create summary");
      assert.equal(hit.payload.channel_id, fixture.hostProjection.id);
    });
    const [agentApiBodyMessage] = await getDb().select().from(messages).where(and(
      eq(messages.channelId, fixture.canonical.id),
      eq(messages.content, "agent api joint task"),
      eq(messages.messageType, "chat"),
    ));
    assert.ok(agentApiBodyMessage);
    await waitFor(() => {
      const hit = deliveries.find((delivery) =>
        delivery.agentId === hostAgent.id
        && delivery.payload.message_id === agentApiBodyMessage.id);
      assert.ok(hit, "host agent should receive the projected Agent API task body");
      assert.equal(hit.payload.channel_id, fixture.hostProjection.id);
    });

    // Inbox facts land on both local surfaces for the Agent API summary too.
    await waitFor(async () => {
      const db = getDb();
      const facts = await db.select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, agentApiSummaryId));
      assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === hostOwner.id && fact.sourceChannelId === fixture.hostProjection.id));
      assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === peerOwner.id && fact.sourceChannelId === fixture.peerProjection.id));
    });
});

test("claiming a joint task lazy-creates the thread through joint projections (canonical authority + local thread ids)", async ({ app }) => {
    const db = getDb();
    const hostOwner = await seedUser("joint-thread-host@slock.test", "joint-thread-host");
    const peerOwner = await seedUser("joint-thread-peer@slock.test", "joint-thread-peer");
    const fixture = await createJointFixture({
      slug: "joint-thread",
      channelName: "joint-thread-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const { tasks: [task] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [{ title: "joint lifecycle thread task" }]);

    installFakeIo(app.app);
    installRecordingOrchestrator(app.app);
  const token = await tokenForHuman(hostOwner.email);

    // Claim before anyone ever opened the task thread.
    const claimRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
      method: "PATCH",
      headers: authHeaders(token, fixture.hostServer.id),
    });
    assert.equal(claimRes.status, 200, `expected joint claim 200, got ${claimRes.status}`);

    await waitFor(async () => {
      const summaries = await findSystemMessages("claimed #");
      assert.equal(summaries.length, 1, "exactly one durable lifecycle row (no per-surface duplicates)");
      const summary = summaries[0]!;

      // Canonical one-row authority: the thread holding the lifecycle message is
      // the single canonical thread for this task message.
      const [jointThread] = await db.select().from(jointChannels).where(eq(jointChannels.canonicalChannelId, summary.channelId));
      assert.ok(jointThread, "canonical thread must be registered as a joint thread");
      const [canonicalThread] = await db.select().from(channels).where(and(
        eq(channels.id, jointThread.canonicalChannelId),
        eq(channels.type, "thread"),
        eq(channels.parentMessageId, task.messageId),
      ));
      assert.ok(canonicalThread, "lifecycle message must live in the canonical thread");
      const allCanonicalThreads = await db.select().from(channels).where(and(
        eq(channels.type, "thread"),
        eq(channels.parentMessageId, task.messageId),
      ));
      assert.equal(allCanonicalThreads.length, 1, "exactly one canonical thread row (local projections carry parentMessageId=null)");

      // Local thread projections exist on BOTH servers with distinct local ids.
      const bindings = await db.select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, jointThread.id));
      assert.equal(bindings.length, 2, "expected host + peer local thread projections");
      const bindingServerIds = bindings.map((binding) => binding.serverId).sort();
      assert.deepEqual(bindingServerIds, [fixture.hostServer.id, fixture.peerServer.id].sort());
      const localThreadIds = bindings.map((binding) => binding.localChannelId);
      assert.notEqual(localThreadIds[0], localThreadIds[1]);
      assert.equal(localThreadIds.includes(jointThread.canonicalChannelId), false, "local thread ids must differ from canonical");
      for (const localThreadId of localThreadIds) {
        const localThread = await channelService.getChannel(localThreadId);
        assert.ok(localThread, `local thread ${localThreadId} should exist`);
        assert.equal(localThread.type, "thread");
      }
    });
});

test("one logical user in both joint servers has one canonical assignee and two local authorization surfaces", async ({ app }) => {
    const db = getDb();
    const user = await seedUser("joint-dual-server-user@slock.test", "joint-dual-server-user");
    const fixture = await createJointFixture({
      slug: "joint-dual-server-user",
      channelName: "joint-dual-server-room",
      hostOwnerId: user.id,
      peerOwnerId: user.id,
    });
    const realtimeEvents = installFakeIo(app.app);
    installRecordingOrchestrator(app.app);

  const token = await tokenForHuman(user.email);
    const hostHeaders = authHeaders(token, fixture.hostServer.id);
    const peerHeaders = authHeaders(token, fixture.peerServer.id);

    const createRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fixture.hostProjection.id}`, {
      method: "POST",
      headers: hostHeaders,
      body: JSON.stringify({ tasks: [{ title: "one person, two server memberships" }] }),
    });
    assert.equal(createRes.status, 200, `expected host-surface create 200, got ${createRes.status}`);
    const createBody = await createRes.json() as {
      tasks: Array<{ id: string; messageId: string; channelId: string; taskNumber: number; revision: number }>;
    };
    assert.equal(createBody.tasks.length, 1);
    const created = createBody.tasks[0]!;
    assert.equal(created.channelId, fixture.hostProjection.id);

    const [stored] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    assert.ok(stored, "one canonical task row should exist");
    assert.equal(stored.channelId, fixture.canonical.id);
    assert.equal(stored.createdById, user.id);
    assert.equal(stored.claimedById, null);

    await waitFor(async () => {
      const summaries = await findSystemMessages("one person, two server memberships");
      assert.equal(summaries.length, 1, "one canonical create summary should exist");
      for (const messageId of [created.messageId, summaries[0]!.id]) {
        const facts = await db.select().from(inboxNotificationFacts).where(eq(
          inboxNotificationFacts.messageId,
          messageId,
        ));
        const personalFacts = facts.filter((fact) => fact.receiverType === "user" && fact.receiverId === user.id);
        assert.equal(
          personalFacts.length,
          1,
          "one global user present on both projections must get one receipt per canonical message",
        );
        assert.equal(personalFacts[0]!.unreadEligible, false, "the sender/causal actor's one receipt remains born-read");
      }
      for (const localChannelId of [fixture.hostProjection.id, fixture.peerProjection.id]) {
        for (const messageId of [created.messageId, summaries[0]!.id]) {
          assert.ok(
            realtimeEvents.some((event) =>
              event.event === "message:new"
              && event.rooms.includes(`channel:${localChannelId}`)
              && (event.payload as { id?: string }).id === messageId),
            `realtime is connection/surface fanout, so local room ${localChannelId} must receive ${messageId}`,
          );
        }
      }
    });

    // Assignment is requested through the host-local surface, but the logical
    // assignee is the global user exactly once even though that user is present
    // in both active local projections.
    const assignRes = await fetch(`${app.baseUrl}/api/tasks/${created.id}/assignee`, {
      method: "PATCH",
      headers: hostHeaders,
      body: JSON.stringify({ assignee: { type: "user", id: user.id }, expectedRevision: stored.revision }),
    });
    assert.equal(assignRes.status, 200, `expected cross-projection eligible assignment 200, got ${assignRes.status}`);
    const assignedBody = await assignRes.json() as {
      task: { id: string; channelId: string; claimedByType: string | null; claimedById: string | null; status: string; revision: number };
    };
    assert.equal(assignedBody.task.channelId, fixture.hostProjection.id);
    assert.equal(assignedBody.task.claimedByType, "user");
    assert.equal(assignedBody.task.claimedById, user.id);
    assert.equal(assignedBody.task.status, "todo");

    // The same logical assignee may start the same canonical task through the
    // other server's local projection; this must advance one revision rather
    // than minting a second owner or task.
    const claimRes = await fetch(`${app.baseUrl}/api/tasks/${created.id}/claim`, {
      method: "PATCH",
      headers: peerHeaders,
    });
    assert.equal(claimRes.status, 200, `expected peer-surface claim 200, got ${claimRes.status}`);
    const claimBody = await claimRes.json() as {
      task: { id: string; channelId: string; claimedById: string | null; status: string; revision: number };
    };
    assert.equal(claimBody.task.id, created.id);
    assert.equal(claimBody.task.channelId, fixture.peerProjection.id);
    assert.equal(claimBody.task.claimedById, user.id);
    assert.equal(claimBody.task.status, "in_progress");
    assert.equal(claimBody.task.revision, assignedBody.task.revision + 1);

    for (const [surfaceId, headers] of [
      [fixture.hostProjection.id, hostHeaders],
      [fixture.peerProjection.id, peerHeaders],
    ] as const) {
      const listRes = await fetch(`${app.baseUrl}/api/tasks/channel/${surfaceId}`, { headers });
      assert.equal(listRes.status, 200, `expected task list 200 for local surface ${surfaceId}`);
      const listBody = await listRes.json() as { tasks: Array<{ id: string; channelId: string; claimedById: string | null }> };
      assert.deepEqual(listBody.tasks.map((task) => task.id), [created.id]);
      assert.equal(listBody.tasks[0]!.channelId, surfaceId);
      assert.equal(listBody.tasks[0]!.claimedById, user.id);

      const numberRes = await fetch(
        `${app.baseUrl}/api/tasks/channel/${surfaceId}/number/${created.taskNumber}`,
        { headers },
      );
      assert.equal(numberRes.status, 200, `expected task-number resolution 200 for local surface ${surfaceId}`);
      const numberBody = await numberRes.json() as { task: { id: string; channelId: string; revision: number } };
      assert.equal(numberBody.task.id, created.id);
      assert.equal(numberBody.task.channelId, surfaceId);
      assert.equal(numberBody.task.revision, claimBody.task.revision);
    }

    const canonicalRows = await db.select().from(tasks).where(eq(tasks.id, created.id));
    assert.equal(canonicalRows.length, 1, "dual membership must not duplicate the canonical task");
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, created.id));
    assert.equal(events.filter((event) => event.eventType === "assignee_changed").length, 2);
    assert.ok(
      events.filter((event) => event.eventType === "assignee_changed").every((event) => event.actorId === user.id),
      "assignment/start events keep one logical user id across both server-local requests",
    );
});

// ---------------------------------------------------------------------------
// task #40 — disconnecting a projection must settle assignees it made
// unreachable. Before this, disconnectJointChannel touched only the projection
// row and the local channel, so a card on the REMAINING side kept reading
// "assigned to X" after X lost every projection that could reach it.
// ---------------------------------------------------------------------------

test("disconnect clears an assignee no active projection can still reach, and says the system did it", async ({ app }) => {
    const hostOwner = await seedUser("jd-clear-host@slock.test", "jd-clear-host");
    const peerOwner = await seedUser("jd-clear-peer@slock.test", "jd-clear-peer");
    const fixture = await createJointFixture({
      slug: "jd-clear",
      channelName: "jd-clear-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const db = getDb();

    const { tasks: [task] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [
      { title: "assigned to someone only the peer projection can reach" },
    ]);
    await taskService.assignTask(task.id, { type: "user", id: peerOwner.id }, "user", hostOwner.id);

    const [beforeRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(beforeRow.claimedById, peerOwner.id, "precondition: the peer owner holds the card");

    await channelService.disconnectJointChannel(fixture.peerProjection.id, peerOwner.id);

    const [afterRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(afterRow.claimedById, null, "assignee must be cleared once nothing can reach them");
    assert.equal(afterRow.claimedByType, null);
    assert.equal(afterRow.claimedAt, null);
    assert.ok(afterRow.revision > beforeRow.revision, "clearing the assignee must bump the CAS revision");

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    const disconnectEvent = events
      .filter((event) => event.eventType === "assignee_changed")
      .find((event) => (event.payload as { reason?: string }).reason === channelService.TASK_UNASSIGN_REASON_JOINT_DISCONNECTED);
    assert.ok(disconnectEvent, "the clear must leave an assignee_changed event carrying its reason");
    const payload = disconnectEvent.payload as Record<string, unknown>;
    assert.equal(payload.assigneeId, null);
    assert.equal(payload.previousAssigneeId, peerOwner.id, "history must still answer who held it");
    assert.equal(payload.previousAssigneeType, "user");
    assert.equal(disconnectEvent.actorId, peerOwner.id, "the disconnecting user is the actor");
    assert.equal(disconnectEvent.actorType, "user");
});

test("disconnect keeps an assignee who is still reachable through a surviving projection", async ({ app }) => {
    // The same human is a member of BOTH projections. Humans are global logical
    // identities, so losing one projection does not make them unreachable — a
    // naive "unassign everyone from the departing server" would wrongly strip
    // this card.
    const hostOwner = await seedUser("jd-keep-host@slock.test", "jd-keep-host");
    const peerOwner = await seedUser("jd-keep-peer@slock.test", "jd-keep-peer");
    const fixture = await createJointFixture({
      slug: "jd-keep",
      channelName: "jd-keep-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const db = getDb();
    await db.insert(serverMembers).values({ serverId: fixture.peerServer.id, userId: hostOwner.id, role: "member" });
    await channelService.addHuman(fixture.peerProjection.id, hostOwner.id);

    const { tasks: [task] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [
      { title: "held by a human present in both projections" },
    ]);
    await taskService.assignTask(task.id, { type: "user", id: hostOwner.id }, "user", hostOwner.id);

    await channelService.disconnectJointChannel(fixture.peerProjection.id, peerOwner.id);

    const [afterRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(
      afterRow.claimedById,
      hostOwner.id,
      "a human still reachable via the host projection must keep the card",
    );
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    assert.equal(
      events.filter((e) => (e.payload as { reason?: string }).reason === channelService.TASK_UNASSIGN_REASON_JOINT_DISCONNECTED).length,
      0,
      "no disconnect-unassign event may be written for a still-reachable assignee",
    );
});

test("disconnect does not rewrite the frozen assignee of a done task", async ({ app }) => {
    const hostOwner = await seedUser("jd-done-host@slock.test", "jd-done-host");
    const peerOwner = await seedUser("jd-done-peer@slock.test", "jd-done-peer");
    const fixture = await createJointFixture({
      slug: "jd-done",
      channelName: "jd-done-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const db = getDb();

    const { tasks: [task] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [
      { title: "finished by the departing side" },
    ]);
    await taskService.assignTask(task.id, { type: "user", id: peerOwner.id }, "user", hostOwner.id);
    await db.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.id, task.id));

    await channelService.disconnectJointChannel(fixture.peerProjection.id, peerOwner.id);

    const [afterRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(
      afterRow.claimedById,
      peerOwner.id,
      "a done task's assignee is frozen — clearing it would rewrite history",
    );
});

test("disconnect clears an agent assignee that lived on the disconnected projection", async ({ app }) => {
    // The other side of the reachability branch. Agents are server-owned, so an
    // agent whose only membership rode the departing projection genuinely
    // becomes unreachable — unlike a human, who may still be reachable
    // elsewhere. Without this case the agent branch carries no teeth: making it
    // always-reachable leaves the rest of the suite green.
    const hostOwner = await seedUser("jd-agent-host@slock.test", "jd-agent-host");
    const peerOwner = await seedUser("jd-agent-peer@slock.test", "jd-agent-peer");
    const fixture = await createJointFixture({
      slug: "jd-agent",
      channelName: "jd-agent-room",
      hostOwnerId: hostOwner.id,
      peerOwnerId: peerOwner.id,
    });
    const db = getDb();
    const peerAgent = await createAgent(fixture.peerServer.id, "jd-agent-peer-agent", { runtime: "claude" });
    await channelService.addAgent(fixture.peerProjection.id, peerAgent.id);

    const { tasks: [task] } = await taskService.createTasks(fixture.canonical.id, "user", hostOwner.id, [
      { title: "held by an agent that only the peer projection carries" },
    ]);
    const assigned = await taskService.assignTask(task.id, { type: "agent", id: peerAgent.id }, "user", hostOwner.id);
    assert.ok(typeof assigned !== "string", `assign precondition failed: ${assigned}`);

    const [beforeRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(beforeRow.claimedById, peerAgent.id, "precondition: the peer agent holds the card");
    assert.equal(beforeRow.claimedByType, "agent");

    await channelService.disconnectJointChannel(fixture.peerProjection.id, peerOwner.id);

    const [afterRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(afterRow.claimedById, null, "an agent on the departing server must be cleared");
    assert.equal(afterRow.claimedByType, null);

    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    const disconnectEvent = events
      .filter((event) => event.eventType === "assignee_changed")
      .find((event) => (event.payload as { reason?: string }).reason === channelService.TASK_UNASSIGN_REASON_JOINT_DISCONNECTED);
    assert.ok(disconnectEvent, "clearing an agent assignee must also leave a reasoned event");
    const payload = disconnectEvent.payload as Record<string, unknown>;
    assert.equal(payload.previousAssigneeType, "agent");
    assert.equal(payload.previousAssigneeId, peerAgent.id);
});
