// RFC 081 D1 / D13 end to end (Tenny, #wg-ax:#19): the daemon's credential
// proxy forwards `raft inbox read` to the REAL `POST /internal/agent-api/inbox/read`
// route (#13787) of an in-process server, and books what that page printed
// against the daemon-local queue (#13788). The daemon's own tests
// (agentCredentialProxy.test.ts) cover the same rules against a stubbed
// upstream; here the page, its ids, seqs and channel metadata are the Server's.
//
// The test lives in the server package because the daemon package does not
// import the server; server tests already import daemon sources directly
// (managedMcpOrigin.daemon.e2e.test.ts, internal.scopeAttestation.bodyLimit.api.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import { RAFT_CLIENT_CAPABILITIES_HEADER, REMINDER_SERVER_ACK_CAPABILITY } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { reminderEvents, reminders, thirdPartyAgentEvents, users } from "../db/schema";
import { reminderSourceAcknowledgements } from "../apps/reminder/sourceAckSchema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getAgentLegacyReadCursor } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { buildThirdPartyAgentMessage, createOAuthClient } from "../services/oauthService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { INBOX_ITEMS_LAUNCH_AT_ENV } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests } from "../services/inboxItemsLaunch";
import {
  __resetAgentCredentialProxyForTest,
  INBOX_READ_PATH,
  registerAgentCredentialProxy,
  type AgentProxyVisibleMessage,
} from "../../../daemon/src/agentCredentialProxy";
import { AgentVisibleDeliveryLedger } from "../../../daemon/src/agentVisibleDeliveryLedger";
import { setDaemonFetchImplForTests } from "../../../daemon/src/daemonFetch";

const test = createApiTest();

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});

afterEach(async () => {
  setDaemonFetchImplForTests(undefined);
  await __resetAgentCredentialProxyForTest();
  vi.unstubAllEnvs();
});

async function seed() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `inbox-read-e2e-${suffix}@slock.test`,
    name: `inbox-read-e2e-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Inbox Read E2E", `inbox-read-e2e-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `ReadBot${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  const general = await createChannel(server.id, `general-${suffix}`);
  await addHuman(general.id, owner!.id);
  await addAgent(general.id, agent.id);
  // RFC 081 inbox items on for this server (with the launch time stubbed above).
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "inbox-read-e2e", issuedVia: "computer", createdByUserId: null });
  return { owner: owner!, server, agent, general, apiKey };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

/**
 * The daemon side: the credential proxy pointed at the real server, with a
 * coordinator that keeps a local queue and filters it through the visible
 * delivery ledger as AgentProcessManager.consumeVisibleMessages does.
 * Every upstream request the proxy makes is recorded.
 */
async function daemonProxy(f: Fixture, baseUrl: string, queued: AgentProxyVisibleMessage[]) {
  const ledger = new AgentVisibleDeliveryLedger();
  const state = { queue: [...queued], sources: [] as string[], upstream: [] as Array<{ method: string; path: string }> };
  setDaemonFetchImplForTests((async (input: unknown, init?: Record<string, unknown>) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    state.upstream.push({ method: String(init?.method ?? "GET"), path: url.pathname });
    // Same request, Node's own fetch (the daemon's undici dispatcher is not for it).
    const { dispatcher: _dispatcher, ...rest } = init ?? {};
    return fetch(url, rest as RequestInit);
  }) as never);
  const handle = await registerAgentCredentialProxy({
    agentId: f.agent.id,
    launchId: `launch-inbox-read-e2e-${randomUUID().slice(0, 8)}`,
    serverUrl: baseUrl,
    apiKey: f.apiKey,
    activeCapabilities: "read",
    inboxCoordinator: {
      getBoundary: (target) => ledger.getBoundary(f.agent.id, target),
      getPendingMessages: () => [],
      consumeVisibleMessages: (input) => {
        state.sources.push(input.source);
        const consumed = ledger.recordConsumed(f.agent.id, input);
        if (consumed) state.queue = state.queue.filter((message) => !consumed.shouldSuppress(message as never));
      },
    },
  });
  const inboxRead = async (body: Record<string, unknown>) => {
    const res = await fetch(`${handle.proxyUrl}${INBOX_READ_PATH}`, {
      method: "POST",
      // The token a daemon that acks reminders through the Server declares
      // (RFC 081 D17), without which a reminder is no inbox item. The proxy
      // passes a caller's capabilities through; this stands in for the proxy
      // appending it itself (the daemon half of D17).
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json", [RAFT_CLIENT_CAPABILITIES_HEADER]: REMINDER_SERVER_ACK_CAPABILITY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as any };
  };
  return { state, ledger, inboxRead };
}

/** A message as the daemon holds it in its local queue after the Server delivered it. */
function queuedMessage(f: Fixture, message: { id: string; seq: number; content: string }): AgentProxyVisibleMessage {
  return {
    id: message.id,
    message_id: message.id,
    seq: message.seq,
    channel_id: f.general.id,
    channel_type: "channel",
    channel_name: f.general.name,
    sender_type: "human",
    sender_name: f.owner.name,
    content: message.content,
  };
}

test("[D1] a real inbox read page of 2 drops exactly those 2 from the daemon-local queue, the 3rd stays, the Server read position moves through the page, one upstream call", async ({ app }) => {
  const f = await seed();
  const sent = [];
  for (const content of ["first", "second", "third"]) sent.push(await createMessage(f.general.id, "user", f.owner.id, content));
  const [m1, m2, m3] = sent.map((message) => ({ id: message.id, seq: Number(message.seq), content: message.content ?? "" }));
  assert.equal(await getAgentLegacyReadCursor(f.agent.id, f.general.id), 0, "fixture: nothing read yet");

  const daemon = await daemonProxy(f, app.baseUrl, [m1!, m2!, m3!].map((message) => queuedMessage(f, message)));
  const page = await daemon.inboxRead({ target: `#${f.general.name}`, limit: 2 });

  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.kind, "conversation");
  assert.deepEqual(page.body.entries.map((entry: any) => entry.id), [m1!.id, m2!.id], "the Server's page, oldest first, reaches the agent unchanged");
  assert.deepEqual([page.body.unreadBefore, page.body.remaining, page.body.consumed], [3, 1, false]);

  assert.deepEqual(daemon.state.upstream, [{ method: "POST", path: INBOX_READ_PATH }], "a destructive read is forwarded once, never retried");
  assert.deepEqual(daemon.state.sources, ["agent_api_inbox_read"]);
  assert.deepEqual(daemon.state.queue.map((message) => message.id), [m3!.id], "the 2 printed leave the local queue; the 3rd stays");
  assert.equal(daemon.ledger.isModelSeen(f.agent.id, `#${f.general.name}`, { seq: m2!.seq, message_id: m2!.id }), true, "a re-push of a printed message is suppressed");
  assert.equal(daemon.ledger.isModelSeen(f.agent.id, `#${f.general.name}`, { seq: m3!.seq, message_id: m3!.id }), false);
  assert.equal(daemon.ledger.getBoundary(f.agent.id, `#${f.general.name}`), undefined, "exact ids and seqs only: no boundary moves");

  assert.equal(await getAgentLegacyReadCursor(f.agent.id, f.general.id), m2!.seq, "the Server read position moved through exactly the page");
});

test("[D13] a real inbox read of a reminder leaves the daemon-local queue as it was and the reminder unacked", async ({ app }) => {
  const f = await seed();
  const db = getDb();
  const [reminder] = await db.insert(reminders).values({
    serverId: f.server.id,
    ownerAgentId: f.agent.id,
    title: "Check the deploy",
    fireAt: new Date(),
    status: "fired",
    createdByType: "agent",
    createdById: f.agent.id,
  }).returning();
  const [fired] = await db.insert(reminderEvents).values({
    reminderId: reminder!.id,
    serverId: f.server.id,
    ownerAgentId: f.agent.id,
    actorType: "system",
    eventType: "fired",
    occurredAt: new Date(Date.now() - 60_000),
    metadata: { fired: true, sourceVersion: 1 },
  }).returning();
  // The queued reminder notice carries the firing event's id, as the read's entry does:
  // booking the read would drop it by that id.
  const notice: AgentProxyVisibleMessage = {
    id: fired!.id,
    message_id: fired!.id,
    seq: 70,
    channel_id: f.general.id,
    channel_type: "channel",
    channel_name: f.general.name,
    sender_type: "system",
    content: "Reminder fired: Check the deploy",
  };
  const daemon = await daemonProxy(f, app.baseUrl, [notice]);

  const page = await daemon.inboxRead({ target: `reminder:${reminder!.id.slice(0, 8)}` });

  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.kind, "reminder");
  assert.equal(page.body.consumed, false);
  assert.deepEqual(page.body.entries.map((entry: any) => entry.id), [fired!.id], "fixture: the Server's entry carries the firing event's id");
  assert.deepEqual(daemon.state.upstream, [{ method: "POST", path: INBOX_READ_PATH }], "forwarded once");
  assert.deepEqual(daemon.state.sources, [], "a reminder read books nothing locally");
  assert.deepEqual(daemon.state.queue.map((message) => message.id), [fired!.id], "the queued notice stays until the reminder is acked");
  const acks = await db.select().from(reminderSourceAcknowledgements).where(eq(reminderSourceAcknowledgements.reminderId, reminder!.id));
  assert.equal(acks.length, 0, "reading did not ack the reminder");
});

/** A third-party app's event for the agent, as internalAgentApi.inboxItems.api.test.ts inserts them. */
async function seedApp(f: Fixture) {
  const { client } = await createOAuthClient({
    serverId: f.server.id,
    createdByUserId: f.owner.id,
    clientId: `stamp-${randomUUID().slice(0, 8)}`,
    name: "Stamp",
    allowedScopes: ["openid", "agent:notification:write"],
  });
  const insertEvent = async (objectRef: string | null, summary: string, createdAt: Date) => {
    const [row] = await getDb().insert(thirdPartyAgentEvents).values({
      serverId: f.server.id,
      agentId: f.agent.id,
      clientId: client.id,
      kind: "notification",
      summary,
      payload: {},
      payloadHash: "0".repeat(64),
      resource: `urn:raft:server:${f.server.id}:agent-inbound`,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      objectRef,
    }).returning();
    return row!;
  };
  // The daemon-local message for an event, as the Server pushes it.
  const pushed = (event: typeof thirdPartyAgentEvents.$inferSelect) =>
    buildThirdPartyAgentMessage({ event, clientKey: client.clientId, clientName: client.name }) as unknown as AgentProxyVisibleMessage;
  return { appKey: client.clientId, insertEvent, pushed };
}

test("[D1] a real inbox read of an app item drops its printed events from the daemon-local queue; another object's event stays queued; one upstream call", async ({ app }) => {
  const f = await seed();
  const stamp = await seedApp(f);
  const now = Date.now();
  const e1 = await stamp.insertEvent("pr-1", "checks failed", new Date(now - 3000));
  const e2 = await stamp.insertEvent("pr-1", "checks passed", new Date(now - 2000));
  const other = await stamp.insertEvent("pr-2", "review requested", new Date(now - 1000));
  const daemon = await daemonProxy(f, app.baseUrl, [e1, e2, other].map(stamp.pushed));
  assert.deepEqual(daemon.state.queue.map((message) => message.id ?? message.message_id), [e1.id, e2.id, other.id], "fixture: the pushed messages carry the event ids");

  const page = await daemon.inboxRead({ target: `app:${stamp.appKey}/pr-1` });

  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.kind, "app");
  assert.equal(page.body.target, `app:${stamp.appKey}/pr-1`);
  assert.deepEqual(page.body.entries.map((entry: any) => entry.third_party_event?.id), [e1.id, e2.id], "the Server's page: this object's events, oldest first");
  assert.deepEqual([page.body.remaining, page.body.consumed], [0, true]);

  assert.deepEqual(daemon.state.upstream, [{ method: "POST", path: INBOX_READ_PATH }], "a destructive read is forwarded once, never retried");
  assert.deepEqual(daemon.state.sources, ["agent_api_inbox_read"]);
  assert.deepEqual(daemon.state.queue.map((message) => message.message_id), [other.id], "the printed events leave the local queue; pr-2's stays");
});
