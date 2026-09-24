import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { onTestFinished, vi } from "vitest";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  BasicTracer,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  type AgentMessage,
  type FailpointRegistry,
} from "@botiverse/raft-shared";
import { executeSearchSql as executeSearchSqlFromDb, getDb, SearchQueryAbortedError } from "../db/index.js";
import { agentActivityEvents, attachmentObjectCharges, attachmentObjects, attachments, channelAgents, channelHumans, channels, featureFlagRules, featureFlags, inboxNotificationFacts, inboxServingRows, jointChannels, jointChannelServers, messageMentions, messageReactions, messages, serverMembers, servers as serversTable, tasks, threadFollows, users } from "../db/schema.js";
import { assignMachine, createAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { addAgent, addHuman, archiveChannel, createChannel, findOrCreateDM, findOrCreateUserDM, getActiveJointThreadProjectionsByCanonicalThread, getOrCreateThread, getOrCreateThreadForChannel, removeHuman } from "../services/channelService.js";
import { registerMachine } from "../services/machineService.js";
import {
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
  createMessage,
  listMessages,
} from "../services/messageService.js";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setSlackBridgeReconciliationMarkerMinterForTests,
  mintSlackBridgeReconciliationMarker,
} from "../services/externalDeliveryOutboxService.js";
import { createServer } from "../services/serverService.js";
import {
  __resetSearchServiceDepsForTests,
  __setSearchServiceDepsForTests,
  MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
} from "../services/searchService.js";
import { openTestApp } from "../test/integration/app.js";
import { setMessageForwardingEnabledForApp } from "../config/messageForwarding.js";
import { COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY, MESSAGE_FORWARDING_FEATURE_FLAG_KEY } from "../services/featureFlagService.js";
import { signAccessToken } from "../middleware/auth.js";
import {
  __setWebHttpClientTraceSinkForTest,
  startWebHttpClientSpan,
} from "../../../web/src/utils/webHttpClientTrace.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
    "X-Server-Id": serverId,
  };
}

async function enableComposerResourceReferences(serverId: string): Promise<void> {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

type EmittedEvent = { room: string; event: string; payload: any };

function installFakeIo(app: { app: { set(key: string, value: unknown): void } }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  app.app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      return {
        in() {
          return {
            socketsJoin(joinRoom: string) {
              events.push({ room, event: "socketsJoin", payload: { room: joinRoom } });
            },
          };
        },
        socketsJoin(joinRoom: string) {
          events.push({ room, event: "socketsJoin", payload: { room: joinRoom } });
        },
      };
    },
  });
  return events;
}

async function readHumanMessageMutationCounts() {
  const db = getDb();
  const [messageCount] = await db.select({ count: sql<number>`count(*)::int` }).from(messages);
  const [taskCount] = await db.select({ count: sql<number>`count(*)::int` }).from(tasks);
  const [freshnessFactCount] = await db.select({ count: sql<number>`count(*)::int` }).from(inboxNotificationFacts);
  const [freshnessServingCount] = await db.select({ count: sql<number>`count(*)::int` }).from(inboxServingRows);
  const [activityCount] = await db.select({ count: sql<number>`count(*)::int` }).from(agentActivityEvents);

  return {
    messages: messageCount?.count ?? 0,
    tasks: taskCount?.count ?? 0,
    inboxNotificationFacts: freshnessFactCount?.count ?? 0,
    inboxServingRows: freshnessServingCount?.count ?? 0,
    agentActivityEvents: activityCount?.count ?? 0,
  };
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function createFailpointBarrier() {
  const waiters: Array<{ ms: number; release: () => void; released: boolean }> = [];
  const countListeners: Array<() => void> = [];

  function notifyCountListeners() {
    for (const listener of countListeners.splice(0)) {
      listener();
    }
  }

  return {
    async sleep(ms: number) {
      await new Promise<void>((resolve) => {
        waiters.push({ ms, release: resolve, released: false });
        notifyCountListeners();
      });
    },
    async waitForCount(count: number) {
      while (waiters.length < count) {
        await new Promise<void>((resolve) => {
          countListeners.push(resolve);
        });
      }
    },
    async waitForPayload(ms: number, count: number) {
      while (waiters.filter((waiter) => waiter.ms === ms).length < count) {
        await new Promise<void>((resolve) => {
          countListeners.push(resolve);
        });
      }
    },
    release(index: number) {
      const waiter = waiters[index];
      assert.ok(waiter, `expected failpoint waiter at index ${index}`);
      waiter.released = true;
      waiter.release();
    },
    releasePayload(ms: number, ordinal: number) {
      const waiter = waiters.filter((candidate) => candidate.ms === ms)[ordinal];
      assert.ok(waiter, `expected failpoint waiter payload ${ms} ordinal ${ordinal}`);
      waiter.released = true;
      waiter.release();
    },
  };
}

function createBlockingThrowFailpoint(key: string, error: Error) {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let triggered = false;
  const registry = {
    enabled: true,
    isEnabled(candidate?: string) {
      return candidate == null || candidate === key;
    },
    configure() {},
    clear() {},
    getTrace() {
      return [];
    },
    async hit<T>(candidate: string, _context?: unknown, fallback?: () => T | Promise<T>) {
      if (candidate === key && !triggered) {
        triggered = true;
        enteredResolve();
        await released;
        throw error;
      }
      return fallback ? await fallback() : undefined;
    },
  } satisfies FailpointRegistry;
  return {
    registry,
    waitUntilEntered: () => entered,
    release: releaseResolve,
  };
}

function findForwardAttemptSpan(sink: MemoryTraceSink, traceId: string) {
  return sink.getAllSpans().find((candidate) => (
    candidate.name === "server.message.forward" && candidate.context.traceId === traceId
  ));
}

async function waitForForwardAttemptSpan(sink: MemoryTraceSink, traceId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const span = findForwardAttemptSpan(sink, traceId);
    if (span) return span;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for Forward attempt span ${traceId}`);
}

function startDisconnectingJsonRequest(url: string, headers: Record<string, string>, body: unknown) {
  const serializedBody = JSON.stringify(body);
  let request!: ReturnType<typeof httpRequest>;
  const closed = new Promise<void>((resolve) => {
    request = httpRequest(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serializedBody),
      },
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.once("error", () => resolve());
    request.end(serializedBody);
  });
  return {
    closed,
    disconnect() {
      request.destroy(new Error("intentional test disconnect"));
    },
  };
}

test("GET /messages/channel/:channelId records page-load phases and constant query shape", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "2".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const db = getDb();
  const owner = await seedUser("messages-trace-owner@slock.test", "messages-trace-owner");
  const server = await createServer("Messages Trace Server", "messages-trace-server", owner.id);
  // Pin to an unlimited-history plan so the traced page-load phases / query
  // shape don't depend on the ambient free-trial wall-clock: a free server's
  // message-history limit is unlimited only while the trial is active
  // (isTrialActive vs TRIAL_END_DATE) and gains a 30-day cutoff afterward,
  // which changes the history-filter query shape this test pins.
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-trace-channel");
  const agent = await createAgent(server.id, "messages-trace-agent", { runtime: "codex" });

  const userMessage = await createMessage(channel.id, "user", owner.id, "user message");
  await createMessage(channel.id, "agent", agent.id, "agent message");
  await createMessage(channel.id, "user", "system", "system message", "system");
  await db.insert(attachments).values({
    messageId: userMessage.id,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "trace.png",
    mimeType: "image/png",
    sizeBytes: 128,
    storageKey: "trace/trace.png",
  });

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}?limit=50`, {
    headers: {
      ...authHeaders(ownerToken, server.id),
      "X-Agent-Id": agent.id,
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    messages: Array<{ id: string; seq: number; attachments: unknown[] }>;
    historyLimited: boolean;
    messageWindow: {
      schemaVersion: number;
      domain: string;
      serverId: string;
      receiverKind: string;
      receiverId: string;
      scopeId: string;
      coveredAfterSeq: number;
      coveredFromSeq: number;
      coveredThroughSeq: number;
      remoteHighWaterSeq: number;
      hasGap: boolean;
      hasNewer: boolean;
      completeThroughLatest: boolean;
    };
  };
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages.some((message) => message.attachments.length === 1), true);
  const messageSeqs = body.messages.map((message) => message.seq);
  assert.deepEqual(body.messageWindow, {
    schemaVersion: 1,
    domain: "receiver_visible_messages_v1",
    serverId: server.id,
    receiverKind: "user",
    receiverId: owner.id,
    scopeId: channel.id,
    coveredAfterSeq: 0,
    coveredFromSeq: Math.min(...messageSeqs),
    coveredThroughSeq: Math.max(...messageSeqs),
    remoteHighWaterSeq: Math.max(...messageSeqs),
    hasGap: false,
    hasNewer: false,
    completeThroughLatest: true,
  });

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/messages/channel/:channelId",
  );
  assert.ok(span, "expected GET /api/messages/channel/:channelId root span");
  assert.equal(span.attrs?.caller_kind, "agent");
  assert.equal(span.attrs?.agent_id_present, true);
  assert.equal(Object.values(span.attrs ?? {}).includes(agent.id), false);

  const processEventNames = span.events
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");

  const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
  const dbQueryNames = dbEvents.map((event) => event.attrs?.query_name).sort();
  assert.deepEqual(
    {
      phases: processEventNames,
      dbQueryNames,
      dbQueryCount: dbEvents.length,
    },
    {
      phases: [
        "messages.page.started",
        "channel.loaded",
        "channel.access.checked",
        "history.policy.checked",
        "messages.paged",
        "history.limit.skipped",
        "messages.thread_summaries.loaded",
        "response.ready",
        "http.response.finished",
      ],
      dbQueryNames: [
        "channel_threads.list_by_channel",
        "messages.attachment_comment_counts",
        "messages.attachment_comment_gate",
        "messages.attachment_comment_refs",
        "messages.attachments_by_messages",
        "messages.channel.coverage_bound",
        "messages.channel.loaded_page",
        "messages.external_reactions_by_messages",
        "messages.mentions_by_messages",
        "messages.reactions_by_messages",
        "messages.senders.agent_profiles",
        "messages.senders.channels_by_messages",
        "messages.senders.joint_channel_members",
        "messages.senders.server_members",
        "messages.senders.server_membership_departures",
        "messages.senders.user_profiles",
      ],
      dbQueryCount: 16,
    },
  );
  // +2: page-scoped thread summary and provider-neutral external reactions — still constant.
  assert.ok(dbEvents.length <= 16, "message page query count should stay constant for mixed senders/attachments/reactions");

  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("messages.channel.loaded_page")?.attrs?.phase, "messages.paged");
  assert.equal(dbEventByQuery.get("messages.channel.loaded_page")?.attrs?.row_count, 3);
  assert.equal(dbEventByQuery.get("messages.channel.loaded_page")?.attrs?.limit, 50);
  assert.equal(dbEventByQuery.get("messages.channel.coverage_bound")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("messages.senders.user_profiles")?.attrs?.input_count, 1);
  assert.equal(dbEventByQuery.get("messages.senders.agent_profiles")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("messages.attachments_by_messages")?.attrs?.input_count, 3);
  assert.equal(dbEventByQuery.get("messages.attachments_by_messages")?.attrs?.attachments_count, 1);

  const skippedEvent = span.events.find((event) => event.name === "history.limit.skipped");
  assert.ok(skippedEvent);
  assert.equal(skippedEvent.attrs?.reason, "unlimited_history");

  const accessEvent = span.events.find((event) => event.name === "channel.access.checked");
  assert.ok(accessEvent);
  assert.equal(accessEvent.attrs?.allowed, true);
  assert.equal(accessEvent.attrs?.channel_type, "channel");

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.messages_count, 3);
  assert.equal(readyEvent.attrs?.history_limited, false);
});

test("message window coverage binds empty, sparse-tail, and non-latest pages fail-closed", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("message-window-owner@slock.test", "message-window-owner");
  const server = await createServer("Message Window Server", "message-window-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const populated = await createChannel(server.id, "message-window-populated");
  const empty = await createChannel(server.id, "message-window-empty");
  const sparseNoise = await createChannel(server.id, "message-window-sparse-noise");
  const cutoffMixed = await createChannel(server.id, "message-window-cutoff-mixed");
  const cutoffEmpty = await createChannel(server.id, "message-window-cutoff-empty");
  const first = await createMessage(populated.id, "user", owner.id, "first");
  await createMessage(sparseNoise.id, "user", owner.id, "global sequence gap one");
  const second = await createMessage(populated.id, "user", owner.id, "second");
  await createMessage(sparseNoise.id, "user", owner.id, "global sequence gap two");
  const third = await createMessage(populated.id, "user", owner.id, "third");
  const cutoffMixedOld = await createMessage(cutoffMixed.id, "user", owner.id, "hidden old predecessor");
  const cutoffMixedLatest = await createMessage(cutoffMixed.id, "user", owner.id, "visible latest");
  const cutoffOnlyOld = await createMessage(cutoffEmpty.id, "user", owner.id, "hidden only row");
  await db.update(messages)
    .set({ createdAt: new Date("2020-01-01T00:00:00.000Z") })
    .where(inArray(messages.id, [cutoffMixedOld.id, cutoffOnlyOld.id]));
  await db.update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, server.id));
  const token = await tokenForHuman(owner.email);

  const tailRes = await fetch(`${app.baseUrl}/api/messages/channel/${populated.id}?limit=2`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(tailRes.status, 200);
  const tail = await tailRes.json() as {
    messages: Array<{ id: string }>;
    messageWindow: {
      coveredFromSeq: number;
      coveredAfterSeq: number;
      coveredThroughSeq: number;
      remoteHighWaterSeq: number;
      hasGap: boolean;
      hasNewer: boolean;
      completeThroughLatest: boolean;
    };
  };
  assert.deepEqual(tail.messages.map((message) => message.id), [second.id, third.id]);
  assert.equal(tail.messageWindow.coveredAfterSeq, first.seq);
  assert.equal(tail.messageWindow.coveredFromSeq, second.seq);
  assert.equal(tail.messageWindow.coveredThroughSeq, third.seq);
  assert.equal(tail.messageWindow.remoteHighWaterSeq, third.seq);
  assert.equal(tail.messageWindow.hasGap, false);
  assert.equal(tail.messageWindow.hasNewer, false);
  assert.equal(tail.messageWindow.completeThroughLatest, true);
  assert.notEqual(second.seq - 1, first.seq, "fixture must contain a server-global sequence hole");
  assert.deepEqual((await listMessages(populated.id, 2, undefined, 0)).map((message) => message.id), [first.id, second.id]);
  assert.deepEqual(await listMessages(populated.id, 2, 0), []);

  const olderRes = await fetch(`${app.baseUrl}/api/messages/channel/${populated.id}?limit=2&before=${third.seq}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(olderRes.status, 200);
  const older = await olderRes.json() as { messageWindow: { remoteHighWaterSeq: number; hasGap: boolean; hasNewer: boolean; completeThroughLatest: boolean } };
  assert.deepEqual(older.messageWindow, {
    ...older.messageWindow,
    remoteHighWaterSeq: third.seq,
    hasGap: true,
    hasNewer: true,
    completeThroughLatest: false,
  });

  for (const query of ["after=0", "before=0"]) {
    const zeroCursorRes = await fetch(`${app.baseUrl}/api/messages/channel/${populated.id}?${query}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(zeroCursorRes.status, 200, query);
    const zeroCursor = await zeroCursorRes.json() as { messageWindow: { hasGap: boolean; hasNewer: boolean; completeThroughLatest: boolean } };
    assert.deepEqual(zeroCursor.messageWindow, {
      ...zeroCursor.messageWindow,
      hasGap: true,
      hasNewer: true,
      completeThroughLatest: false,
    }, query);
  }

  for (const query of ["after=abc", "after=1.5", "after=-1", "before=1&after=1"]) {
    const invalidRes = await fetch(`${app.baseUrl}/api/messages/channel/${populated.id}?${query}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(invalidRes.status, 400, query);
    assert.equal((await invalidRes.json() as { code: string }).code, "invalid_message_page_cursor", query);
  }

  const cutoffMixedRes = await fetch(`${app.baseUrl}/api/messages/channel/${cutoffMixed.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(cutoffMixedRes.status, 200);
  const cutoffMixedBody = await cutoffMixedRes.json() as {
    historyLimited: boolean;
    messages: Array<{ id: string }>;
    messageWindow: { coveredAfterSeq: number; coveredFromSeq: number; coveredThroughSeq: number; remoteHighWaterSeq: number; completeThroughLatest: boolean };
  };
  assert.deepEqual(cutoffMixedBody.messages.map((message) => message.id), [cutoffMixedLatest.id]);
  assert.equal(cutoffMixedBody.historyLimited, true);
  assert.deepEqual(cutoffMixedBody.messageWindow, {
    ...cutoffMixedBody.messageWindow,
    coveredAfterSeq: cutoffMixedOld.seq,
    coveredFromSeq: cutoffMixedLatest.seq,
    coveredThroughSeq: cutoffMixedLatest.seq,
    remoteHighWaterSeq: cutoffMixedLatest.seq,
    completeThroughLatest: true,
  });

  const cutoffEmptyRes = await fetch(`${app.baseUrl}/api/messages/channel/${cutoffEmpty.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(cutoffEmptyRes.status, 200);
  const cutoffEmptyBody = await cutoffEmptyRes.json() as {
    historyLimited: boolean;
    messages: unknown[];
    messageWindow: { coveredAfterSeq: number; coveredFromSeq: number; coveredThroughSeq: number; remoteHighWaterSeq: number; completeThroughLatest: boolean };
  };
  assert.deepEqual(cutoffEmptyBody.messages, []);
  assert.equal(cutoffEmptyBody.historyLimited, true);
  assert.deepEqual(cutoffEmptyBody.messageWindow, {
    ...cutoffEmptyBody.messageWindow,
    coveredAfterSeq: cutoffOnlyOld.seq,
    coveredFromSeq: cutoffOnlyOld.seq + 1,
    coveredThroughSeq: cutoffOnlyOld.seq,
    remoteHighWaterSeq: cutoffOnlyOld.seq,
    completeThroughLatest: true,
  });

  const emptyRes = await fetch(`${app.baseUrl}/api/messages/channel/${empty.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(emptyRes.status, 200);
  const emptyBody = await emptyRes.json() as { messages: unknown[]; messageWindow: Record<string, unknown> };
  assert.deepEqual(emptyBody.messages, []);
  assert.deepEqual(emptyBody.messageWindow, {
    schemaVersion: 1,
    domain: "receiver_visible_messages_v1",
    serverId: server.id,
    receiverKind: "user",
    receiverId: owner.id,
    scopeId: empty.id,
    coveredAfterSeq: 0,
    coveredFromSeq: 1,
    coveredThroughSeq: 0,
    remoteHighWaterSeq: 0,
    hasGap: false,
    hasNewer: false,
    completeThroughLatest: true,
  });
  assert.ok(first.seq < second.seq && second.seq < third.seq);
});

test("public channel permalink preview resolves short message ids for non-joined users", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("public-link-owner@slock.test", "public-link-owner");
  const sender = await seedUser("public-link-sender@slock.test", "public-link-sender");
  const recipient = await seedUser("public-link-recipient@slock.test", "public-link-recipient");
  const server = await createServer("Public Link Server", "public-link-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: sender.id, role: "member" },
    { serverId: server.id, userId: recipient.id, role: "member" },
  ]).onConflictDoNothing();

  const targetChannel = await createChannel(server.id, "public-link-target");
  const shareChannel = await createChannel(server.id, "public-link-share");
  await db.insert(channelHumans).values([
    { channelId: shareChannel.id, userId: sender.id },
    { channelId: shareChannel.id, userId: recipient.id },
  ]).onConflictDoNothing();

  const targetMessage = await createMessage(
    targetChannel.id,
    "user",
    owner.id,
    "public channel permalink target",
  );
  const targetShortId = targetMessage.id.slice(0, 8);
  const permalink = `https://app.slock.ai/s/${server.slug}/channel/${targetChannel.id}?msg=${targetShortId}`;

  const senderToken = await tokenForHuman(sender.email);
  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(senderToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: shareChannel.id,
      content: `please read ${permalink}`,
    }),
  });
  assert.equal(sendRes.status, 200);
  const sentMessage = await sendRes.json() as { content: string; channelId: string };
  assert.equal(sentMessage.channelId, shareChannel.id);
  assert.match(sentMessage.content, /please read https:\/\/app\.slock\.ai/);

  const recipientToken = await tokenForHuman(recipient.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${targetShortId}`);
  contextUrl.searchParams.set("channelId", targetChannel.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(recipientToken, server.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    messages: Array<{ id: string; content: string }>;
  };
  assert.equal(context.channelId, targetChannel.id);
  assert.equal(context.targetMessageId, targetMessage.id);
  assert.ok(
    context.messages.some((message) =>
      message.id === targetMessage.id
      && message.content === "public channel permalink target"
    ),
    "recipient should resolve the target message without joining the public channel",
  );
});

test("human message v2 returns sender-only mention warnings while v1 and consumer payloads stay unchanged", async ({ app }) => {
  const emitted = installFakeIo(app);
  const db = getDb();
  const owner = await seedUser("message-v2-owner@slock.test", "message-v2-owner");
  const sameHandleHuman = await seedUser("message-v2-human@slock.test", "same_handle");
  const server = await createServer("Message V2 Server", "message-v2-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: sameHandleHuman.id, role: "member" },
  ]).onConflictDoNothing();
  const sameHandleAgent = await createAgent(server.id, "same_handle", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "message-v2-room");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, sameHandleHuman.id);
  await addAgent(channel.id, sameHandleAgent.id);
  const token = await tokenForHuman(owner.email);
  const headers = {
    ...authHeaders(token, server.id),
    "Content-Type": "application/json",
  };

  const v1Res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ channelId: channel.id, content: "v1 @same_handle" }),
  });
  assert.equal(v1Res.status, 200);
  const v1 = await v1Res.json() as Record<string, any>;
  assert.equal(typeof v1.id, "string");
  assert.equal(Object.hasOwn(v1, "message"), false, "v1 acknowledgement must remain an unwrapped message");
  assert.equal(Object.hasOwn(v1, "unresolvedMentionHandles"), false);
  assert.deepEqual(
    (await db.select().from(messageMentions).where(eq(messageMentions.messageId, v1.id)))
      .map(({ targetType, targetId }) => ({ targetType, targetId }))
      .sort((left, right) => left.targetType.localeCompare(right.targetType)),
    [
      { targetType: "agent", targetId: sameHandleAgent.id },
      { targetType: "user", targetId: sameHandleHuman.id },
    ],
  );

  const v2AmbiguousRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ channelId: channel.id, content: "v2 raw @same_handle" }),
  });
  assert.equal(v2AmbiguousRes.status, 200);
  const v2Ambiguous = await v2AmbiguousRes.json() as {
    message: Record<string, any>;
    unresolvedMentionHandles?: string[];
  };
  assert.equal(typeof v2Ambiguous.message.id, "string");
  assert.deepEqual(v2Ambiguous.unresolvedMentionHandles, ["@same_handle"]);
  assert.equal(
    (await db.select().from(messageMentions).where(eq(messageMentions.messageId, v2Ambiguous.message.id))).length,
    0,
  );

  const livePayload = emitted.find((event) => (
    event.event === "message:new"
    && event.room === `channel:${channel.id}`
    && event.payload?.id === v2Ambiguous.message.id
  ))?.payload as Record<string, unknown> | undefined;
  assert.ok(livePayload);
  assert.equal(Object.hasOwn(livePayload, "unresolvedMentionHandles"), false, "socket payload is recipient-facing");

  const listRes = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as { messages: Array<Record<string, unknown>> };
  const coldRead = listed.messages.find((message) => message.id === v2Ambiguous.message.id);
  assert.ok(coldRead);
  assert.equal(Object.hasOwn(coldRead, "unresolvedMentionHandles"), false, "history payload is recipient-facing");

  const v2TypedRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: channel.id,
      content: "v2 typed @same_handle",
      mentions: [{ type: "agent", id: sameHandleAgent.id, name: "same_handle" }],
    }),
  });
  assert.equal(v2TypedRes.status, 200);
  const v2Typed = await v2TypedRes.json() as {
    message: { id: string };
    unresolvedMentionHandles?: string[];
  };
  assert.equal(Object.hasOwn(v2Typed, "message"), true, "v2 acknowledgement always uses the stable envelope");
  assert.equal(Object.hasOwn(v2Typed, "unresolvedMentionHandles"), false);
  assert.deepEqual(
    (await db.select().from(messageMentions).where(eq(messageMentions.messageId, v2Typed.message.id)))
      .map(({ targetType, targetId }) => ({ targetType, targetId })),
    [{ targetType: "agent", targetId: sameHandleAgent.id }],
  );

  const beforeConflict = await readHumanMessageMutationCounts();
  const conflictRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: channel.id,
      content: "v2 conflict @same_handle",
      mentions: [
        { type: "user", id: sameHandleHuman.id, name: "same_handle" },
        { type: "agent", id: sameHandleAgent.id, name: "same_handle" },
      ],
    }),
  });
  assert.equal(conflictRes.status, 400);
  assert.equal(((await conflictRes.json()) as { code?: string }).code, "mention_binding_conflict");
  assert.deepEqual(await readHumanMessageMutationCounts(), beforeConflict, "binding conflict must fail before persistence");
});

test("human message mentions cannot enumerate a hidden human directory", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("hidden-mention-owner@slock.test", "hidden_mention_owner");
  const sender = await seedUser("hidden-mention-sender@slock.test", "hidden_mention_sender");
  const visiblePeer = await seedUser("hidden-mention-visible@slock.test", "hidden_mention_visible");
  const hiddenHuman = await seedUser("hidden-mention-target@slock.test", "hidden_mention_target");
  const server = await createServer("Hidden Mention Directory", "community", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: sender.id, role: "member" },
    { serverId: server.id, userId: visiblePeer.id, role: "member" },
    { serverId: server.id, userId: hiddenHuman.id, role: "member" },
  ]).onConflictDoNothing();
  const sharedChannel = await createChannel(server.id, "hidden-mention-shared");
  await addHuman(sharedChannel.id, sender.id);
  await addHuman(sharedChannel.id, visiblePeer.id);
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel);
  const outsiderAgent = await createAgent(server.id, "hidden_mention_agent", { runtime: "claude", model: "sonnet" });
  const senderToken = await tokenForHuman(sender.email);
  const headers = {
    ...authHeaders(senderToken, server.id),
    "Content-Type": "application/json",
  };

  const v2HiddenRawRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: allChannel.id,
      content: `hidden raw @${hiddenHuman.name}`,
    }),
  });
  assert.equal(v2HiddenRawRes.status, 200);
  const v2HiddenRaw = await v2HiddenRawRes.json() as {
    message: { id: string };
    unresolvedMentionHandles?: string[];
    pendingMentionActions?: unknown[];
  };
  assert.deepEqual(v2HiddenRaw.unresolvedMentionHandles, [`@${hiddenHuman.name}`]);
  assert.equal(v2HiddenRaw.pendingMentionActions, undefined, "#all must not grant hidden-directory visibility");
  assert.deepEqual(
    await db.select().from(messageMentions).where(eq(messageMentions.messageId, v2HiddenRaw.message.id)),
    [],
  );

  const v2HiddenTypedRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: sharedChannel.id,
      content: `hidden typed @${hiddenHuman.name}`,
      mentions: [{ type: "user", id: hiddenHuman.id, name: hiddenHuman.name }],
    }),
  });
  assert.equal(v2HiddenTypedRes.status, 200);
  const v2HiddenTyped = await v2HiddenTypedRes.json() as {
    message: { id: string };
    unresolvedMentionHandles?: string[];
    pendingMentionActions?: unknown[];
  };
  assert.equal(v2HiddenTyped.unresolvedMentionHandles, undefined);
  assert.equal(v2HiddenTyped.pendingMentionActions, undefined, "typed ids must not become a hidden-human oracle");
  assert.deepEqual(
    await db.select().from(messageMentions).where(eq(messageMentions.messageId, v2HiddenTyped.message.id)),
    [],
  );

  const v1HiddenRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: sharedChannel.id,
      content: `legacy hidden @${hiddenHuman.name}`,
    }),
  });
  assert.equal(v1HiddenRes.status, 200);
  const v1Hidden = await v1HiddenRes.json() as { id: string };
  assert.deepEqual(
    await db.select().from(messageMentions).where(eq(messageMentions.messageId, v1Hidden.id)),
    [],
    "legacy authoring must honor the same directory boundary",
  );

  const peerOwner = await seedUser("hidden-mention-peer-owner@slock.test", "hidden_mention_peer_owner");
  const peerServer = await createServer("Hidden Mention Peer", "hidden-mention-peer", peerOwner.id);
  await db.insert(serverMembers).values({
    serverId: peerServer.id,
    userId: hiddenHuman.id,
    role: "member",
  }).onConflictDoNothing();
  const canonicalJointChannel = await createChannel(server.id, "hidden-mention-joint-canonical");
  const localJointProjection = await createChannel(server.id, "hidden-mention-joint", undefined, "joint");
  const peerJointProjection = await createChannel(peerServer.id, "hidden-mention-joint", undefined, "joint");
  await addHuman(localJointProjection.id, sender.id);
  await addHuman(peerJointProjection.id, hiddenHuman.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalJointChannel.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: server.id,
      localChannelId: localJointProjection.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: peerServer.id,
      localChannelId: peerJointProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);

  const visibleRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: sharedChannel.id,
      content: `visible @${sender.name} @${visiblePeer.name} @${hiddenHuman.name} @${owner.name} @${outsiderAgent.name}`,
      mentions: [
        { type: "user", id: sender.id, name: sender.name },
        { type: "user", id: visiblePeer.id, name: visiblePeer.name },
        { type: "user", id: hiddenHuman.id, name: hiddenHuman.name },
        { type: "user", id: owner.id, name: owner.name },
        { type: "agent", id: outsiderAgent.id, name: outsiderAgent.name },
      ],
    }),
  });
  assert.equal(visibleRes.status, 200);
  const visible = await visibleRes.json() as {
    message: { id: string };
    pendingMentionActions?: Array<{ targetType: string; targetHandle: string }>;
  };
  assert.deepEqual(
    (await db.select({ targetType: messageMentions.targetType, targetId: messageMentions.targetId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, visible.message.id)))
      .map((row) => `${row.targetType}:${row.targetId}`).sort(),
    [
      `agent:${outsiderAgent.id}`,
      `user:${hiddenHuman.id}`,
      `user:${owner.id}`,
      `user:${sender.id}`,
      `user:${visiblePeer.id}`,
    ].sort(),
    "self, a non-#all channel peer, a community owner, and agents remain visible",
  );
  assert.deepEqual(
    (visible.pendingMentionActions ?? []).map((action) => `${action.targetType}:${action.targetHandle}`).sort(),
    [`agent:${outsiderAgent.name}`, `user:${hiddenHuman.name}`, `user:${owner.name}`].sort(),
    "visible Joint peers and other visible non-members keep the existing sender-only action contract",
  );

  await db.update(serversTable).set({ hideHumansFromMembers: false }).where(eq(serversTable.id, server.id));
  const nonHiddenRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: sharedChannel.id,
      content: `non-hidden @${hiddenHuman.name}`,
      mentions: [{ type: "user", id: hiddenHuman.id, name: hiddenHuman.name }],
    }),
  });
  assert.equal(nonHiddenRes.status, 200);
  const nonHidden = await nonHiddenRes.json() as {
    message: { id: string };
    pendingMentionActions?: Array<{ targetType: string; targetHandle: string }>;
  };
  assert.deepEqual(
    nonHidden.pendingMentionActions?.map((action) => `${action.targetType}:${action.targetHandle}`),
    [`user:${hiddenHuman.name}`],
    "non-hidden mode remains server-wide",
  );
  assert.equal(
    (await db.select().from(messageMentions).where(eq(messageMentions.messageId, nonHidden.message.id))).length,
    1,
  );

  // Human send is mounted behind requireServer, which checks the exact
  // server_members row on every request. Keep the JWT and channel_humans row
  // live while removing only server membership: unlike Agent credential
  // send, this orphan shape must stop before mention resolution.
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.delete(serverMembers).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, sender.id),
  ));
  assert.equal(
    (await db.select().from(channelHumans).where(and(
      eq(channelHumans.channelId, sharedChannel.id),
      eq(channelHumans.userId, sender.id),
    ))).length,
    1,
    "control: channel membership and the authenticated session remain live",
  );
  const orphanContent = `orphan human @${hiddenHuman.name}`;
  const orphanRes = await fetch(`${app.baseUrl}/api/v2/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId: sharedChannel.id,
      content: orphanContent,
    }),
  });
  assert.equal(orphanRes.status, 403);
  assert.deepEqual(await orphanRes.json(), { error: "Not a member of this server" });
  assert.deepEqual(
    await db.select().from(messages).where(eq(messages.content, orphanContent)),
    [],
    "missing human server membership must be rejected before message or mention persistence",
  );
});

test("POST /messages replays a human send with the same randomId", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const db = getDb();
  const owner = await seedUser("messages-random-id-owner@slock.test", "messages-random-id-owner");
  const server = await createServer("Messages Random ID", "messages-random-id", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-random-id-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const randomId = "msg-retry-001";

  const send = (content: string) => fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content,
      randomId,
    }),
  });

  const firstRes = await send("same payload after lost response");
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json() as { id: string; channelId: string; content: string; randomId?: string | null };
  assert.equal(first.randomId, randomId);

  const secondRes = await send("retry body should not overwrite original");
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json() as { id: string; channelId: string; content: string; randomId?: string | null };
  assert.deepEqual(second, first);

  const persisted = await db
    .select({ id: messages.id, content: messages.content, randomId: messages.randomId })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.randomId, randomId)));
  assert.deepEqual(persisted, [{ id: first.id, content: first.content, randomId }]);
  const insertSpans = sink.getAllSpans().filter((candidate) =>
    candidate.name === "server.db.query"
    && candidate.attrs?.query_name === "messages.insert"
    && candidate.attrs?.phase === "message_persist"
  );
  assert.equal(insertSpans.length, 2);
  assert.equal(insertSpans[0]?.attrs?.replayed, false);
  assert.equal(insertSpans[1]?.attrs?.replayed, true);
  assert.equal(insertSpans.every((span) => span.context.parentSpanId != null), true);
  assert.equal(JSON.stringify(insertSpans).includes("same payload after lost response"), false);
  assert.equal(JSON.stringify(insertSpans).includes("retry body should not overwrite original"), false);
});

test("POST /messages returns the durable replay when its frontend Socket emit degrades", async ({ app }) => {

  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("messages-outbound-response-owner@slock.test", "messages-outbound-response-owner");
    const server = await createServer("Messages Outbound Response", "messages-outbound-response", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const channel = await createChannel(server.id, "messages-outbound-response-channel");
    await addHuman(channel.id, owner.id);
    const token = await tokenForHuman(owner.email);
    const randomId = "outbound-response-replay-001";
    await db.insert(messages).values({
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      randomId,
      content: "persisted before response failure",
      messageType: "chat",
      searchText: "persisted before response failure",
    });
    __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => {
      throw new Error("replay must not resolve a second outbound delivery");
    });
    __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) =>
      mintSlackBridgeReconciliationMarker("route-response-diagnostic-key", deliveryId)
    );
    app.app.set("io", {
      to() {
        return { emit() { throw new Error("private frontend failure"); } };
      },
      in() {
        return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
      },
    });

    const response = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: channel.id,
        content: "persisted before response failure",
        randomId,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { id: string; randomId?: string | null };
    assert.equal(body.randomId, randomId);
    assert.equal((await db.select({ id: messages.id }).from(messages)).length, 1);
    const degraded = sink.getAllSpans().flatMap((span) => span.events).find((event) =>
      event.name === "message_pipeline.frontend_socket_emit.degraded"
    );
    assert.ok(degraded);
    assert.deepEqual(degraded.attrs, {
      phase: "frontend_socket_emit",
      topology: "ordinary_channel",
      persistence_state: "durable",
      failure_policy: "continue_from_persisted_state",
      sender_type: "user",
      target_type: "channel",
      replayed: true,
    });
    assert.equal(JSON.stringify(sink.getAllSpans()).includes("private frontend failure"), false);
  } finally {
    __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
    __resetMessageServiceDepsForTests();
    await app.close();
  }
});

test("POST /messages keeps randomId thread sends inside the transaction executor", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-thread-random-id-owner@slock.test", "messages-thread-random-id-owner");
  const server = await createServer("Messages Thread Random ID", "messages-thread-random-id", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-thread-random-id-channel");
  await addHuman(channel.id, owner.id);
  const parent = await createMessage(channel.id, "user", owner.id, "thread randomId parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const token = await tokenForHuman(owner.email);

  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: thread.id,
      content: "thread randomId reply",
      randomId: "thread-random-id-001",
    }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(sendRes.status, 200);
  const sent = await sendRes.json() as { channelId: string; randomId?: string | null };
  assert.equal(sent.channelId, thread.id);
  assert.equal(sent.randomId, "thread-random-id-001");

  // Verify the transaction released the shared pglite connection instead of
  // leaving every subsequent request queued behind the thread send.
  const healthRes = await fetch(`${app.baseUrl}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(healthRes.status, 200);
});

test("POST /messages does not report a transaction-pending row as durable when a thread read degrades", async ({ app }) => {

  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("messages-thread-pending-owner@slock.test", "messages-thread-pending-owner");
    const server = await createServer("Messages Thread Pending", "messages-thread-pending", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const channel = await createChannel(server.id, "messages-thread-pending-channel");
    await addHuman(channel.id, owner.id);
    const parent = await createMessage(channel.id, "user", owner.id, "thread pending parent");
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    const token = await tokenForHuman(owner.email);
    __setMessageServiceDepsForTests({
      listExplicitThreadUnfollows: async () => {
        throw Object.assign(new Error("failed query: select from thread_follows"), { code: "XX000" });
      },
    });

    const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: thread.id,
        content: "thread pending reply",
        randomId: "thread-pending-001",
      }),
    });
    assert.equal(sendRes.status, 200);
    const persisted = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.channelId, thread.id),
        eq(messages.randomId, "thread-pending-001"),
      ));
    assert.equal(persisted.length, 1);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.events.some((event) => event.name === "message_pipeline.post_persist_side_effect.degraded")
    );
    assert.ok(span);
    const degradedIndex = span.events.findIndex((event) =>
      event.name === "message_pipeline.post_persist_side_effect.degraded"
      && event.attrs?.query_name === "thread_follows.same_send_candidates"
    );
    assert.ok(degradedIndex >= 0);
    const degraded = span.events[degradedIndex]!;
    assert.equal(degraded.attrs?.persistence_state, "transaction_pending");
    assert.equal(degraded.attrs?.durable_message_present, false);
    assert.equal(degraded.attrs?.failure_policy, "continue_within_transaction");
    assert.equal(JSON.stringify(degraded.attrs).includes("select from"), false);
  } finally {
    __resetMessageServiceDepsForTests();
    await app.close();
  }
});

test("POST /messages rejects invalid human create body fields before writes", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-body-boundary-owner@slock.test", "messages-body-boundary-owner");
  const server = await createServer("Messages Body Boundary", "messages-body-boundary", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-body-boundary-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);

  const before = await readHumanMessageMutationCounts();
  const cases = [
    {
      name: "object channelId",
      body: {
        channelId: { id: channel.id },
        content: "object channelId must not reach resolve",
      },
    },
    {
      name: "bad attachmentIds element",
      body: {
        channelId: channel.id,
        content: "bad attachment element must not create message",
        attachmentIds: ["not-a-uuid"],
      },
    },
    {
      name: "string false asTask",
      body: {
        channelId: channel.id,
        content: "string false must not silently create task",
        asTask: "false",
      },
    },
  ];

  for (const testCase of cases) {
    const res = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testCase.body),
    });

    assert.equal(res.status, 400, testCase.name);
    const body = await res.json() as { error?: unknown };
    assert.equal(typeof body.error, "string", testCase.name);
    assert.deepEqual(await readHumanMessageMutationCounts(), before, testCase.name);
  }
});

test("POST /messages rejects an App reference that is not installed in the active server", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-app-ref-owner@slock.test", "messages-app-ref-owner");
  const server = await createServer("Messages App Reference", "messages-app-reference", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-app-reference-channel");
  await addHuman(channel.id, owner.id);
  await enableComposerResourceReferences(server.id);
  const token = await tokenForHuman(owner.email);
  const content = "run [@Missing](<app:custom.missing>)";

  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channelId: channel.id, content }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "App reference is not installed in this server",
  });
  const persisted = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.content, content)));
  assert.equal(persisted.length, 0, "a forged resource reference must fail before persistence");
});

test("POST /messages rejects Computer and App references while the server gate is disabled", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-resource-gate-owner@slock.test", "messages-resource-gate-owner");
  const server = await createServer("Messages Resource Gate", "messages-resource-gate", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-resource-gate-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const content = "see [@Reminder](<app:system.reminder>)";

  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channelId: channel.id, content }),
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "Computer and App references are not enabled in this server",
  });
  const persisted = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.content, content)));
  assert.equal(persisted.length, 0);
});

test("POST /messages randomId replay is scoped to the original storage channel", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-random-id-scope-owner@slock.test", "messages-random-id-scope-owner");
  const server = await createServer("Messages Random ID Scope", "messages-random-id-scope", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const privateChannel = await createChannel(server.id, "messages-random-id-private", "private");
  const publicChannel = await createChannel(server.id, "messages-random-id-public");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(publicChannel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const randomId = "msg-scope-retry-001";

  const firstRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: privateChannel.id,
      content: "private retry payload must stay private",
      randomId,
    }),
  });
  assert.equal(firstRes.status, 200);

  await removeHuman(privateChannel.id, owner.id);

  const replayRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: publicChannel.id,
      content: "public request must not receive private replay",
      randomId,
    }),
  });
  assert.equal(replayRes.status, 409);
  const conflict = await replayRes.json() as { error: string; code: string };
  assert.equal(conflict.code, "random_id_conflict");
  assert.doesNotMatch(conflict.error, /private retry payload/);

  const publicRows = await db
    .select({ id: messages.id, content: messages.content, randomId: messages.randomId })
    .from(messages)
    .where(and(eq(messages.channelId, publicChannel.id), eq(messages.randomId, randomId)));
  assert.deepEqual(publicRows, []);
});

test("POST /messages preserves requested attachment order in ack, realtime, and cold read", async ({ app }) => {
  const events = installFakeIo(app);
  const db = getDb();
  const owner = await seedUser("messages-attachment-order@slock.test", "messages-attachment-order");
  const server = await createServer("Messages Attachment Order", "messages-attachment-order", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-attachment-order-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const uploaded = await db.insert(attachments).values([
    {
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "uploaded-first-b.png",
      mimeType: "image/png",
      sizeBytes: 200,
      storageKey: "attachment-order/b.png",
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
    },
    {
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "uploaded-second-a.png",
      mimeType: "image/png",
      sizeBytes: 100,
      storageKey: "attachment-order/a.png",
      createdAt: new Date("2026-07-24T00:00:01.000Z"),
    },
  ]).returning({ id: attachments.id, filename: attachments.filename });
  const attachmentB = uploaded.find((row) => row.filename === "uploaded-first-b.png")!;
  const attachmentA = uploaded.find((row) => row.filename === "uploaded-second-a.png")!;
  const requestedOrder = [attachmentA.id, attachmentB.id];

  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content: "attachment selection order",
      attachmentIds: requestedOrder,
    }),
  });
  assert.equal(sendRes.status, 200);
  const sent = await sendRes.json() as {
    id: string;
    attachments: Array<{ id: string }>;
  };
  assert.deepEqual(sent.attachments.map((attachment) => attachment.id), requestedOrder, "send ack");

  const realtime = events.find((event) =>
    event.room === `channel:${channel.id}`
    && event.event === "message:new"
    && event.payload?.id === sent.id
  );
  assert.ok(realtime, "message:new must be emitted");
  assert.deepEqual(
    realtime.payload.attachments.map((attachment: { id: string }) => attachment.id),
    requestedOrder,
    "realtime payload",
  );

  const listRes = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as {
    messages: Array<{ id: string; attachments: Array<{ id: string }> }>;
  };
  const coldRead = listed.messages.find((message) => message.id === sent.id);
  assert.ok(coldRead, "sent message must be present in cold history");
  assert.deepEqual(coldRead.attachments.map((attachment) => attachment.id), requestedOrder, "cold read");

  const persisted = await db
    .select({ id: attachments.id, messagePosition: attachments.messagePosition })
    .from(attachments)
    .where(inArray(attachments.id, requestedOrder));
  assert.deepEqual(
    persisted
      .sort((left, right) => (left.messagePosition ?? -1) - (right.messagePosition ?? -1))
      .map((row) => ({ id: row.id, messagePosition: row.messagePosition })),
    requestedOrder.map((id, messagePosition) => ({ id, messagePosition })),
  );
});

test("POST /messages randomId replay accepts only the identical ordered attachment set", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-attachment-replay@slock.test", "messages-attachment-replay");
  const server = await createServer("Messages Attachment Replay", "messages-attachment-replay", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-attachment-replay-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const uploaded = await db.insert(attachments).values([
    {
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "first.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: "attachment-replay/first.png",
    },
    {
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "second.png",
      mimeType: "image/png",
      sizeBytes: 2,
      storageKey: "attachment-replay/second.png",
    },
  ]).returning({ id: attachments.id });
  const orderedIds = uploaded.map((row) => row.id);
  const randomId = "ordered-attachment-replay";
  const send = (attachmentIds: string[], requestRandomId = randomId) => fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content: "ordered attachment replay",
      randomId: requestRandomId,
      attachmentIds,
    }),
  });

  const first = await send(orderedIds);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { id: string; attachments: Array<{ id: string }> };
  assert.deepEqual(firstBody.attachments.map((row) => row.id), orderedIds);

  const identicalReplay = await send(orderedIds);
  assert.equal(identicalReplay.status, 200);
  const replayBody = await identicalReplay.json() as typeof firstBody;
  assert.equal(replayBody.id, firstBody.id);
  assert.deepEqual(replayBody.attachments.map((row) => row.id), orderedIds);

  const reorderedReplay = await send([...orderedIds].reverse());
  assert.equal(reorderedReplay.status, 400);
  assert.equal(
    ((await reorderedReplay.json()) as { code: string }).code,
    "attachment_replay_conflict",
  );

  const crossMessageReuse = await send(orderedIds, "ordered-attachment-replay-other");
  assert.equal(crossMessageReuse.status, 400);
  assert.equal(
    ((await crossMessageReuse.json()) as { code: string }).code,
    "attachment_already_linked",
  );

  const persistedMessages = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.channelId, channel.id));
  assert.deepEqual(persistedMessages, [{ id: firstBody.id }]);
  const persistedAttachments = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      messagePosition: attachments.messagePosition,
    })
    .from(attachments)
    .where(inArray(attachments.id, orderedIds));
  assert.deepEqual(
    persistedAttachments.sort((left, right) => (left.messagePosition ?? -1) - (right.messagePosition ?? -1)),
    orderedIds.map((id, messagePosition) => ({ id, messageId: firstBody.id, messagePosition })),
  );
});

test("POST /messages rolls back the message for duplicate, missing, or foreign attachment sets", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-attachment-rollback@slock.test", "messages-attachment-rollback");
  const other = await seedUser("messages-attachment-rollback-other@slock.test", "messages-attachment-rollback-other");
  const server = await createServer("Messages Attachment Rollback", "messages-attachment-rollback", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-attachment-rollback-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);
  const uploaded = await db.insert(attachments).values([
    {
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "valid.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: "attachment-rollback/valid.png",
    },
    {
      channelId: channel.id,
      uploaderId: other.id,
      uploaderType: "user",
      filename: "foreign.png",
      mimeType: "image/png",
      sizeBytes: 2,
      storageKey: "attachment-rollback/foreign.png",
    },
  ]).returning({ id: attachments.id, uploaderId: attachments.uploaderId });
  const validId = uploaded.find((row) => row.uploaderId === owner.id)!.id;
  const foreignId = uploaded.find((row) => row.uploaderId === other.id)!.id;
  const missingId = "99999999-9999-4999-8999-999999999999";
  const cases = [
    { ids: [validId, validId], code: "attachment_duplicate" },
    { ids: [validId, missingId], code: "attachment_not_found" },
    { ids: [validId, foreignId], code: "attachment_not_found" },
  ];

  for (const [index, testCase] of cases.entries()) {
    const response = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: channel.id,
        content: `attachment rollback ${index}`,
        attachmentIds: testCase.ids,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, testCase.code);
    assert.equal(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, channel.id)).then((rows) => rows.length),
      0,
      "message insert and inbox reset must roll back with attachment failure",
    );
  }

  const stillUnlinked = await db
    .select({ id: attachments.id, messageId: attachments.messageId, messagePosition: attachments.messagePosition })
    .from(attachments)
    .where(inArray(attachments.id, [validId, foreignId]));
  assert.deepEqual(
    stillUnlinked.map((row) => ({ messageId: row.messageId, messagePosition: row.messagePosition })),
    [{ messageId: null, messagePosition: null }, { messageId: null, messagePosition: null }],
  );
});

test("POST /messages accepts randomId values that match internal sentinel text", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-random-id-sentinel@slock.test", "messages-random-id-sentinel");
  const server = await createServer("Messages Random ID Sentinel", "messages-random-id-sentinel", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-random-id-sentinel-channel");
  await addHuman(channel.id, owner.id);
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content: "literal sentinel random id",
      randomId: "invalid",
    }),
  });

  assert.equal(res.status, 200);
  const message = await res.json() as { randomId?: string | null };
  assert.equal(message.randomId, "invalid");
});

for (const winner of ["first", "second"] as const) {
  test(`POST /messages concurrent randomId replay returns the ${winner} finalized row`, async ({ app }) => {

    const barrier = createFailpointBarrier();
    const registry = new InMemoryFailpointRegistry({ sleep: barrier.sleep });
    registry.configure("server.message.userRandomSend.afterInsert", {
      mode: "once",
      effect: "delay",
      payload: 2,
    });
    __setFailpointsForTests(registry);

    try {
      const db = getDb();
      const owner = await seedUser(`messages-random-id-race-${winner}@slock.test`, `messages-random-id-race-${winner}`);
      const target = await seedUser(`messages-random-id-race-target-${winner}@slock.test`, `race-target-${winner}`);
      const server = await createServer(`Messages Random ID Race ${winner}`, `messages-random-id-race-${winner}`, owner.id);
      await db.insert(serverMembers).values([
        { serverId: server.id, userId: owner.id, role: "owner" },
        { serverId: server.id, userId: target.id, role: "member" },
      ]).onConflictDoNothing();
      const channel = await createChannel(server.id, `messages-random-id-race-${winner}-channel`);
      await addHuman(channel.id, owner.id);
      await addHuman(channel.id, target.id);
      const token = await tokenForHuman(owner.email);
      const randomId = `msg-race-${winner}`;
      const [attachment] = await db.insert(attachments).values({
        channelId: channel.id,
        uploaderId: owner.id,
        uploaderType: "user",
        filename: `race-${winner}.png`,
        mimeType: "image/png",
        sizeBytes: 123,
        storageKey: `race/${winner}.png`,
      }).returning({ id: attachments.id });

      const send = (content: string) => fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: {
          ...authHeaders(token, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channelId: channel.id,
          content,
          randomId,
          attachmentIds: [attachment.id],
        }),
      });

      const firstContent = `first controlled winner candidate @${target.name}`;
      const secondContent = `second controlled winner candidate @${target.name}`;
      const winnerRequest = winner === "first" ? send(firstContent) : send(secondContent);
      await barrier.waitForPayload(2, 1);
      const loserRequest = winner === "first" ? send(secondContent) : send(firstContent);

      const loserEarly = await Promise.race([
        loserRequest.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);
      assert.equal(loserEarly, "pending", "loser must not replay before winner finalization commits");

      barrier.releasePayload(2, 0);

      const [winnerRes, loserRes] = await Promise.all([winnerRequest, loserRequest]);
      assert.equal(winnerRes.status, 200);
      assert.equal(loserRes.status, 200);
      const winnerMessage = await winnerRes.json() as {
        id: string;
        content: string;
        randomId?: string | null;
        attachments?: Array<{ id: string }>;
        mentions?: Array<{ type: string; id: string; name: string }>;
      };
      const loserMessage = await loserRes.json() as typeof winnerMessage;

      assert.deepEqual(loserMessage, winnerMessage);
      assert.equal(winnerMessage.content, winner === "first" ? firstContent : secondContent);
      assert.equal(winnerMessage.randomId, randomId);
      assert.deepEqual(winnerMessage.attachments?.map((item) => item.id), [attachment.id]);
      assert.deepEqual(winnerMessage.mentions, [{ type: "user", id: target.id, name: target.name }]);

      const persistedMessages = await db
        .select({ id: messages.id, content: messages.content, randomId: messages.randomId })
        .from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.randomId, randomId)));
      assert.deepEqual(persistedMessages, [{
        id: winnerMessage.id,
        content: winner === "first" ? firstContent : secondContent,
        randomId,
      }]);
      const linkedAttachments = await db
        .select({ id: attachments.id, messageId: attachments.messageId })
        .from(attachments)
        .where(eq(attachments.id, attachment.id));
      assert.deepEqual(linkedAttachments, [{ id: attachment.id, messageId: winnerMessage.id }]);
      const mentionRows = await db
        .select({ messageId: messageMentions.messageId, targetType: messageMentions.targetType, targetId: messageMentions.targetId })
        .from(messageMentions)
        .where(eq(messageMentions.messageId, winnerMessage.id));
      assert.deepEqual(mentionRows, [{ messageId: winnerMessage.id, targetType: "user", targetId: target.id }]);
      const inboxFacts = await db
        .select({
          messageId: inboxNotificationFacts.messageId,
          receiverType: inboxNotificationFacts.receiverType,
          receiverId: inboxNotificationFacts.receiverId,
          sourceChannelId: inboxNotificationFacts.sourceChannelId,
          personalMention: inboxNotificationFacts.personalMention,
        })
        .from(inboxNotificationFacts)
        .where(and(
          eq(inboxNotificationFacts.messageId, winnerMessage.id),
          eq(inboxNotificationFacts.receiverType, "user"),
          eq(inboxNotificationFacts.receiverId, target.id),
        ));
      assert.deepEqual(inboxFacts, [{
        messageId: winnerMessage.id,
        receiverType: "user",
        receiverId: target.id,
        sourceChannelId: channel.id,
        personalMention: true,
      }]);
    } finally {
      __resetFailpointsForTests();
      await app.close();
    }
  });
}

test("POST /messages randomId retry recovers after insert-before-finalization failure", async ({ app }) => {

  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.userRandomSend.afterInsert", {
    mode: "once",
    effect: "throw",
    payload: "fail after insert before finalization",
  });
  __setFailpointsForTests(registry);

  try {
    const db = getDb();
    const owner = await seedUser("messages-random-id-recover@slock.test", "messages-random-id-recover");
    const target = await seedUser("messages-random-id-recover-target@slock.test", "recover-target");
    const server = await createServer("Messages Random ID Recover", "messages-random-id-recover", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: target.id, role: "member" },
    ]).onConflictDoNothing();
    const channel = await createChannel(server.id, "messages-random-id-recover-channel");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, target.id);
    const token = await tokenForHuman(owner.email);
    const randomId = "msg-recover-001";
    const [attachment] = await db.insert(attachments).values({
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "recover.png",
      mimeType: "image/png",
      sizeBytes: 456,
      storageKey: "recover/recover.png",
    }).returning({ id: attachments.id });

    const send = () => fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: channel.id,
        content: `recoverable send @${target.name}`,
        randomId,
        attachmentIds: [attachment.id],
      }),
    });

    const failed = await send();
    assert.equal(failed.status, 500);

    const retried = await send();
    assert.equal(retried.status, 200);
    const message = await retried.json() as {
      id: string;
      content: string;
      randomId?: string | null;
      attachments?: Array<{ id: string }>;
      mentions?: Array<{ type: string; id: string; name: string }>;
    };
    assert.equal(message.randomId, randomId);
    assert.deepEqual(message.attachments?.map((item) => item.id), [attachment.id]);
    assert.deepEqual(message.mentions, [{ type: "user", id: target.id, name: target.name }]);

    const persistedMessages = await db
      .select({ id: messages.id, randomId: messages.randomId })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.randomId, randomId)));
    assert.deepEqual(persistedMessages, [{ id: message.id, randomId }]);
    const linkedAttachments = await db
      .select({ id: attachments.id, messageId: attachments.messageId })
      .from(attachments)
      .where(eq(attachments.id, attachment.id));
    assert.deepEqual(linkedAttachments, [{ id: attachment.id, messageId: message.id }]);
    const mentionRows = await db
      .select({ messageId: messageMentions.messageId, targetType: messageMentions.targetType, targetId: messageMentions.targetId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, message.id));
    assert.deepEqual(mentionRows, [{ messageId: message.id, targetType: "user", targetId: target.id }]);
    const inboxFacts = await db
      .select({ messageId: inboxNotificationFacts.messageId, receiverId: inboxNotificationFacts.receiverId, personalMention: inboxNotificationFacts.personalMention })
      .from(inboxNotificationFacts)
      .where(and(
        eq(inboxNotificationFacts.messageId, message.id),
        eq(inboxNotificationFacts.receiverType, "user"),
        eq(inboxNotificationFacts.receiverId, target.id),
      ));
    assert.deepEqual(inboxFacts, [{ messageId: message.id, receiverId: target.id, personalMention: true }]);
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("POST /messages rolls back a keyless source, attachments, mentions, and inbox facts together", async ({ app }) => {

  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.newChatTransaction.afterFacts", {
    mode: "once",
    effect: "throw",
    payload: "fail after all derived facts before commit",
  });
  __setFailpointsForTests(registry);

  try {
    const db = getDb();
    const owner = await seedUser("messages-keyless-atomic-owner@slock.test", "messages-keyless-atomic-owner");
    const target = await seedUser("messages-keyless-atomic-target@slock.test", "messages-keyless-atomic-target");
    const server = await createServer("Messages Keyless Atomic", "messages-keyless-atomic", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: target.id, role: "member" },
    ]).onConflictDoNothing();
    const channel = await createChannel(server.id, "messages-keyless-atomic-channel");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, target.id);
    const token = await tokenForHuman(owner.email);
    const [attachment] = await db.insert(attachments).values({
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "keyless-atomic.png",
      mimeType: "image/png",
      sizeBytes: 789,
      storageKey: "keyless/atomic.png",
    }).returning({ id: attachments.id });
    const content = `keyless atomic send @${target.name}`;
    const send = () => fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelId: channel.id,
        content,
        attachmentIds: [attachment.id],
      }),
    });

    const failed = await send();
    assert.equal(failed.status, 500);
    assert.deepEqual(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.content, content))),
      [],
    );
    assert.deepEqual(
      await db
        .select({ messageId: attachments.messageId })
        .from(attachments)
        .where(eq(attachments.id, attachment.id)),
      [{ messageId: null }],
    );
    assert.deepEqual(await db.select({ id: messageMentions.id }).from(messageMentions), []);
    assert.deepEqual(await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts), []);

    const retried = await send();
    assert.equal(retried.status, 200);
    const message = await retried.json() as { id: string };
    assert.deepEqual(
      await db
        .select({ messageId: attachments.messageId })
        .from(attachments)
        .where(eq(attachments.id, attachment.id)),
      [{ messageId: message.id }],
    );
    assert.deepEqual(
      await db
        .select({ messageId: messageMentions.messageId, targetId: messageMentions.targetId })
        .from(messageMentions)
        .where(eq(messageMentions.messageId, message.id)),
      [{ messageId: message.id, targetId: target.id }],
    );
    const facts = await db
      .select({ messageId: inboxNotificationFacts.messageId })
      .from(inboxNotificationFacts)
      .where(eq(inboxNotificationFacts.messageId, message.id));
    assert.ok(facts.length >= 2);
    assert.ok(facts.every((fact) => fact.messageId === message.id));
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("joint channel permalink preview resolves through the caller's local projection", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-link-host@slock.test", "joint-link-host");
  const guestOwner = await seedUser("joint-link-guest@slock.test", "joint-link-guest");
  const guestOutsider = await seedUser("joint-link-outsider@slock.test", "joint-link-outsider");
  const hostServer = await createServer("Joint Link Host", "joint-link-host", hostOwner.id);
  const guestServer = await createServer("Joint Link Guest", "joint-link-guest", guestOwner.id);
  await db.insert(serverMembers).values([
    { serverId: hostServer.id, userId: hostOwner.id, role: "owner" },
    { serverId: guestServer.id, userId: guestOwner.id, role: "owner" },
    { serverId: guestServer.id, userId: guestOutsider.id, role: "member" },
  ]).onConflictDoNothing();

  const hostProjection = await createChannel(hostServer.id, "joint-link-room", undefined, "joint");
  const guestProjection = await createChannel(guestServer.id, "joint-link-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(guestProjection.id, guestOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: hostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: guestServer.id,
      localChannelId: guestProjection.id,
      role: "participant",
      joinedByUserId: guestOwner.id,
    },
  ]);

  const targetMessage = await createMessage(
    hostProjection.id,
    "user",
    hostOwner.id,
    "joint permalink target",
  );
  const targetShortId = targetMessage.id.slice(0, 8);

  const guestToken = await tokenForHuman(guestOwner.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${targetShortId}`);
  contextUrl.searchParams.set("channelId", guestProjection.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(guestToken, guestServer.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    messages: Array<{ id: string; channelId: string; content: string }>;
  };
  assert.equal(context.channelId, guestProjection.id);
  assert.equal(context.targetMessageId, targetMessage.id);
  assert.ok(
    context.messages.some((message) =>
      message.id === targetMessage.id
      && message.channelId === guestProjection.id
      && message.content === "joint permalink target"
    ),
    "joint participant should resolve a target stored in the canonical host projection",
  );

  const outsiderToken = await tokenForHuman(guestOutsider.email);
  const outsiderRes = await fetch(contextUrl, {
    headers: authHeaders(outsiderToken, guestServer.id),
  });
  assert.equal(outsiderRes.status, 404, "non-members of the local joint projection must not resolve previews");
});

test("joint channel thread permalink preview resolves replies through the caller's local projection", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-thread-link-host@slock.test", "joint-thread-link-host");
  const guestOwner = await seedUser("joint-thread-link-guest@slock.test", "joint-thread-link-guest");
  const hostServer = await createServer("Joint Thread Link Host", "joint-thread-link-host", hostOwner.id);
  const guestServer = await createServer("Joint Thread Link Guest", "joint-thread-link-guest", guestOwner.id);
  await db.insert(serverMembers).values([
    { serverId: hostServer.id, userId: hostOwner.id, role: "owner" },
    { serverId: guestServer.id, userId: guestOwner.id, role: "owner" },
  ]).onConflictDoNothing();

  const hostProjection = await createChannel(hostServer.id, "joint-thread-link-room", undefined, "joint");
  const guestProjection = await createChannel(guestServer.id, "joint-thread-link-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(guestProjection.id, guestOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: hostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: guestServer.id,
      localChannelId: guestProjection.id,
      role: "participant",
      joinedByUserId: guestOwner.id,
    },
  ]);

  const parentMessage = await createMessage(
    hostProjection.id,
    "user",
    hostOwner.id,
    "joint thread parent",
  );
  const thread = await getOrCreateThreadForChannel(hostProjection.id, parentMessage.id, hostOwner.id, "user");
  const threadReply = await createMessage(
    thread.canonicalThreadChannelId,
    "user",
    hostOwner.id,
    "joint thread reply target",
  );
  const [guestThreadProjection] = (await getActiveJointThreadProjectionsByCanonicalThread(thread.canonicalThreadChannelId))
    .filter((projection) => projection.localServerId === guestServer.id);
  assert.ok(guestThreadProjection, "joint thread should have a guest-local projection");
  const replyShortId = threadReply.id.slice(0, 8);

  const guestToken = await tokenForHuman(guestOwner.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${replyShortId}`);
  contextUrl.searchParams.set("channelId", guestProjection.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(guestToken, guestServer.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    canonicalTarget: { kind: string; channelId: string; messageId: string; threadParentMessageId: string; threadChannelId: string };
    messages: Array<{ id: string; channelId: string; content: string }>;
  };
  assert.equal(context.channelId, guestThreadProjection.localThreadChannelId);
  assert.equal(context.targetMessageId, threadReply.id);
  assert.equal(context.canonicalTarget.kind, "thread");
  assert.equal(context.canonicalTarget.channelId, guestProjection.id);
  assert.equal(context.canonicalTarget.threadChannelId, guestThreadProjection.localThreadChannelId);
  assert.equal(context.canonicalTarget.messageId, threadReply.id);
  assert.equal(context.canonicalTarget.threadParentMessageId, parentMessage.id);
  assert.ok(
    context.messages.some((message) =>
      message.id === threadReply.id
      && message.channelId === guestThreadProjection.localThreadChannelId
      && message.content === "joint thread reply target"
    ),
    "joint participant should resolve a thread reply stored under the canonical host projection",
  );

  const localThreadContextUrl = new URL(`${app.baseUrl}/api/messages/context/${replyShortId}`);
  localThreadContextUrl.searchParams.set("channelId", guestThreadProjection.localThreadChannelId);
  const localThreadContextRes = await fetch(localThreadContextUrl, {
    headers: authHeaders(guestToken, guestServer.id),
  });
  assert.equal(localThreadContextRes.status, 200);
  const localThreadContext = await localThreadContextRes.json() as {
    channelId: string;
    targetMessageId: string;
    messages: Array<{ id: string; channelId: string; content: string }>;
  };
  assert.equal(localThreadContext.channelId, guestThreadProjection.localThreadChannelId);
  assert.equal(localThreadContext.targetMessageId, threadReply.id);
  assert.ok(
    localThreadContext.messages.some((message) =>
      message.id === threadReply.id
      && message.channelId === guestThreadProjection.localThreadChannelId
      && message.content === "joint thread reply target"
    ),
    "joint participant should resolve a focused reply when the client scopes context to the local thread projection",
  );
});

test("message reactions add idempotently, enrich messages, and remove cleanly", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reaction-owner@slock.test", "reaction-owner");
  const server = await createServer("Reaction Server", "reaction-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "reaction-channel");
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();
  const message = await createMessage(channel.id, "user", owner.id, "reactable message");
  const token = await tokenForHuman(owner.email);

  const add = async () => fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });

  const first = await add();
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { reactions: Array<{ emoji: string; count: number; reactorIds: string[]; reactorNames: string[] }> };
  assert.deepEqual(firstBody.reactions, [{
    emoji: "👍",
    count: 1,
    reactorIds: [owner.id],
    reactorNames: [owner.displayName],
  }]);

  const second = await add();
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { reactions: Array<{ emoji: string; count: number; reactorIds: string[] }> };
  assert.equal(secondBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);

  const list = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(list.status, 200);
  const listBody = await list.json() as { messages: Array<{ id: string; reactions: Array<{ emoji: string; count: number }> }> };
  assert.equal(listBody.messages.find((row) => row.id === message.id)?.reactions[0]?.count, 1);

  const remove = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
    method: "DELETE",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(remove.status, 200);
  const removeBody = await remove.json() as { reactions: Array<{ emoji: string }> };
  assert.deepEqual(removeBody.reactions, []);

  const persisted = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, message.id));
  assert.deepEqual(persisted, []);
});

test("POST /messages rejects channel ids outside the active server context", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-cross-owner@slock.test", "messages-cross-owner");
  const serverA = await createServer("Messages Cross Server A", "messages-cross-server-a", owner.id);
  const serverB = await createServer("Messages Cross Server B", "messages-cross-server-b", owner.id);
  const channelB = await createChannel(serverB.id, "messages-cross-channel-b", undefined, "private");
  await addHuman(channelB.id, owner.id);

  const ownerToken = await tokenForHuman(owner.email);
  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, serverA.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channelB.id,
      content: "cross-server send should not land",
    }),
  });
  assert.equal(sendRes.status, 404, `expected cross-server send 404, got ${sendRes.status}`);

  const leakedRows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channelB.id), eq(messages.content, "cross-server send should not land")));
  assert.equal(leakedRows.length, 0, "message must not be written to a channel outside the active server");
});

test("POST /messages returns sender-only pending mention actions for human sends", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-mention-actions-owner@slock.test", "messages-mention-actions-owner");
  const server = await createServer("Messages Mention Actions", "messages-mention-actions", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-mention-actions-channel");
  await addHuman(channel.id, owner.id);
  const outsider = await createAgent(server.id, "UserRouteMentionOutsider", {
    runtime: "claude",
    model: "sonnet",
    avatarUrl: "pixel:random:UserRouteMentionOutsider",
  });
  const outsiderHuman = await seedUser("messages-mention-actions-human@slock.test", "messagesMentionHuman");
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsiderHuman.id, role: "member" }).onConflictDoNothing();
  const ownerToken = await tokenForHuman(owner.email);

  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content: `please coordinate with @${outsider.name} and @${outsiderHuman.name}`,
      mentions: [
        { type: "agent", id: outsider.id, name: outsider.name },
        { type: "user", id: outsiderHuman.id, name: outsiderHuman.name },
      ],
    }),
  });
  assert.equal(sendRes.status, 200);
  const body = await sendRes.json() as {
    message: { id: string; channelId: string; pendingMentionActions?: unknown };
    pendingMentionActions: Array<{
      resolutionId: string;
      messageId: string;
      targetType: string;
      targetHandle: string;
      targetAvatarUrl: string | null;
      reason: string;
      availableActions: string[];
      expiresAt: string;
    }>;
  };
  assert.equal(body.message.channelId, channel.id);
  assert.equal(body.message.pendingMentionActions, undefined);
  assert.equal(JSON.stringify(body.message).includes("pendingMentionActions"), false);
  assert.equal(body.pendingMentionActions.length, 2);
  const pendingByType = new Map(body.pendingMentionActions.map((action) => [action.targetType, action]));
  const agentPending = pendingByType.get("agent");
  const humanPending = pendingByType.get("user");
  assert.ok(agentPending, "outsider agent mention should produce a sender-only pending action");
  assert.ok(humanPending, "outsider human mention should produce a sender-only pending action");
  assert.deepEqual(agentPending, {
    resolutionId: agentPending.resolutionId,
    messageId: body.message.id,
    targetType: "agent",
    targetHandle: outsider.name,
    targetAvatarUrl: outsider.avatarUrl,
    reason: "not_member",
    availableActions: ["notify", "add"],
    expiresAt: agentPending.expiresAt,
  });
  assert.deepEqual(humanPending, {
    resolutionId: humanPending.resolutionId,
    messageId: body.message.id,
    targetType: "user",
    targetHandle: outsiderHuman.name,
    targetAvatarUrl: outsiderHuman.avatarUrl,
    reason: "not_member",
    availableActions: ["notify", "add"],
    expiresAt: humanPending.expiresAt,
  });
  for (const action of body.pendingMentionActions) {
    assert.match(action.resolutionId, /^[0-9a-f-]{36}$/i);
    assert.match(action.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  }

  const listRes = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json() as { messages: Array<{ id: string; pendingMentionActions?: unknown }> };
  assert.equal(listBody.messages.find((message) => message.id === body.message.id)?.pendingMentionActions, undefined);
});

test("POST /messages keeps public-channel non-member mentions out of send-time delivery", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-mention-delivery-owner@slock.test", "messages-mention-delivery-owner");
  const server = await createServer("Messages Mention Delivery", "messages-mention-delivery", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-mention-delivery-channel");
  await addHuman(channel.id, owner.id);
  const outsider = await createAgent(server.id, "UserRouteMentionDeliveryOutsider", {
    runtime: "claude",
    model: "sonnet",
    avatarUrl: "pixel:random:UserRouteMentionDeliveryOutsider",
  });
  const outsiderCredential = await mintAgentCredential({
    agentId: outsider.id,
    scopes: ["mentions"],
    name: "messages-mention-delivery-outsider-mentions",
    createdByUserId: null,
  });
  const outsiderHuman = await seedUser("messages-mention-delivery-human@slock.test", "messagesMentionDeliveryHuman");
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsiderHuman.id, role: "member" }).onConflictDoNothing();
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{
    agentId: string;
    message: { message_id?: string };
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { message_id?: string },
    ) => Promise<{
      status: "queued";
      reason: "replayable_inbox";
    }>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
    return { status: "queued", reason: "replayable_inbox" };
  };

  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: channel.id,
      content: `please coordinate with @${outsider.name} and @${outsiderHuman.name}`,
      mentions: [
        { type: "agent", id: outsider.id, name: outsider.name },
        { type: "user", id: outsiderHuman.id, name: outsiderHuman.name },
      ],
    }),
  });
  assert.equal(sendRes.status, 200);
  const body = await sendRes.json() as { id?: string; message?: { id: string } };
  const messageId = body.message?.id ?? body.id;
  assert.ok(messageId, "send must return a durable message id");

  const outsiderMentionRows = await db
    .select({
      targetType: messageMentions.targetType,
      targetId: messageMentions.targetId,
      notifiableAtSend: messageMentions.notifiableAtSend,
      notifiedAt: messageMentions.notifiedAt,
    })
    .from(messageMentions)
    .where(eq(messageMentions.messageId, messageId));
  const outsiderInboxFacts = await db
    .select({
      receiverType: inboxNotificationFacts.receiverType,
      receiverId: inboxNotificationFacts.receiverId,
    })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.messageId, messageId),
      inArray(inboxNotificationFacts.receiverId, [outsider.id, outsiderHuman.id]),
    ));
  const targetMentionsRes = await fetch(`${app.baseUrl}/internal/agent-api/mentions`, {
    headers: {
      Authorization: `Bearer ${outsiderCredential.apiKey}`,
    },
  });
  assert.equal(targetMentionsRes.status, 200);
  const targetMentions = await targetMentionsRes.json() as { mentions: Array<{ messageId: string }> };

  assert.deepEqual(
    {
      mentionRows: outsiderMentionRows
        .map((row) => ({
          targetType: row.targetType,
          targetId: row.targetId,
          notifiableAtSend: row.notifiableAtSend,
          notified: row.notifiedAt !== null,
        }))
        .sort((a, b) => a.targetType.localeCompare(b.targetType)),
      inboxFacts: outsiderInboxFacts,
      agentDeliveries: deliveries.filter((delivery) => delivery.agentId === outsider.id),
      targetVisibleMentionIds: targetMentions.mentions.map((mention) => mention.messageId),
    },
    {
      mentionRows: [
        { targetType: "agent", targetId: outsider.id, notifiableAtSend: false, notified: false },
        { targetType: "user", targetId: outsiderHuman.id, notifiableAtSend: false, notified: false },
      ],
      inboxFacts: [],
      agentDeliveries: [],
      targetVisibleMentionIds: [],
    },
    "public-channel non-member mentions must stay pending-only until explicit notify/add",
  );
});

test("POST /messages allows inert outsider mentions in DMs without notify or inbox delivery", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-dm-mention-owner@slock.test", "messages-dm-mention-owner");
  const peer = await seedUser("messages-dm-mention-peer@slock.test", "messages-dm-mention-peer");
  const outsiderHuman = await seedUser("messages-dm-mention-outsider@slock.test", "messagesDmMentionOutsider");
  const server = await createServer("Messages DM Mention", "messages-dm-mention", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: peer.id, role: "member" },
    { serverId: server.id, userId: outsiderHuman.id, role: "member" },
  ]).onConflictDoNothing();
  const outsiderAgent = await createAgent(server.id, "MessagesDmMentionAgent", { runtime: "claude", model: "sonnet" });
  const outsiderCredential = await mintAgentCredential({
    agentId: outsiderAgent.id,
    scopes: ["mentions"],
    name: "messages-dm-mention-agent-mentions",
    createdByUserId: null,
  });
  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm, "expected owner/peer DM");

  const ownerToken = await tokenForHuman(owner.email);
  const outsiderHumanToken = await tokenForHuman(outsiderHuman.email);

  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channelId: dm.id,
      content: `quiet reference @${outsiderHuman.name} and @${outsiderAgent.name}`,
      mentions: [
        { type: "user", id: outsiderHuman.id, name: outsiderHuman.name },
        { type: "agent", id: outsiderAgent.id, name: outsiderAgent.name },
      ],
    }),
  });
  assert.equal(sendRes.status, 200);
  const sent = await sendRes.json() as {
    id: string;
    mentions?: Array<{ type: string; id: string; name: string }>;
    pendingMentionActions?: unknown[];
    message?: unknown;
  };
  assert.equal(sent.message, undefined);
  assert.deepEqual(sent.pendingMentionActions ?? [], []);
  assert.deepEqual(sent.mentions ?? [], []);

  const mentionRows = await db
    .select({
      targetType: messageMentions.targetType,
      targetId: messageMentions.targetId,
      notifiableAtSend: messageMentions.notifiableAtSend,
      notifiedAt: messageMentions.notifiedAt,
    })
    .from(messageMentions)
    .where(eq(messageMentions.messageId, sent.id));
  assert.deepEqual(
    mentionRows
      .map((row) => ({
        targetType: row.targetType,
        targetId: row.targetId,
        notifiableAtSend: row.notifiableAtSend,
        notified: row.notifiedAt !== null,
      }))
      .sort((a, b) => a.targetType.localeCompare(b.targetType)),
    [
      { targetType: "agent", targetId: outsiderAgent.id, notifiableAtSend: false, notified: false },
      { targetType: "user", targetId: outsiderHuman.id, notifiableAtSend: false, notified: false },
    ],
  );

  const humanMentionsRes = await fetch(`${app.baseUrl}/api/channels/inbox?filter=mentions`, {
    headers: authHeaders(outsiderHumanToken, server.id),
  });
  assert.equal(humanMentionsRes.status, 200);
  const humanMentions = await humanMentionsRes.json() as { items: Array<{ channelId?: string; lastMessageId?: string }> };
  assert.equal(
    humanMentions.items.some((item) => item.channelId === dm.id || item.lastMessageId === sent.id),
    false,
    "DM outsider human mention must not enter Activity/Mentions",
  );

  const agentMentionsRes = await fetch(`${app.baseUrl}/internal/agent-api/mentions`, {
    headers: {
      Authorization: `Bearer ${outsiderCredential.apiKey}`,
    },
  });
  assert.equal(agentMentionsRes.status, 200);
  const agentMentions = await agentMentionsRes.json() as { mentions: Array<{ messageId: string }> };
  assert.deepEqual(agentMentions.mentions.map((mention) => mention.messageId), []);
});

test("user mention-actions execute mirrors notify and add semantics", async ({ app }) => {

  const queueOwner = new AgentOrchestrator();
  try {
    const db = getDb();
    const owner = await seedUser("messages-actions-execute-owner@slock.test", "messages-actions-execute-owner");
    const other = await seedUser("messages-actions-execute-other@slock.test", "messages-actions-execute-other");
    const outsiderHuman = await seedUser("messages-actions-execute-human@slock.test", "messagesActionsHuman");
    const ordinaryTargetHuman = await seedUser("messages-actions-execute-member-target@slock.test", "messagesActionsMemberTarget");
    const server = await createServer("Messages Actions Execute", "messages-actions-execute", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: other.id, role: "member" },
      { serverId: server.id, userId: outsiderHuman.id, role: "member" },
      { serverId: server.id, userId: ordinaryTargetHuman.id, role: "member" },
    ]).onConflictDoNothing();
    const channel = await createChannel(server.id, "messages-actions-execute-channel");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, other.id);
    const outsider = await createAgent(server.id, "UserRouteExecuteOutsider", { runtime: "claude", model: "sonnet" });
    const memberTargetAgent = await createAgent(server.id, "UserRouteExecuteMemberTarget", { runtime: "claude", model: "sonnet" });
    const outsiderCredential = await mintAgentCredential({
      agentId: outsider.id,
      scopes: ["mentions"],
      name: "messages-actions-execute-outsider-mentions",
      createdByUserId: null,
    });
    const ownerToken = await tokenForHuman(owner.email);
    const otherToken = await tokenForHuman(other.email);
    const outsiderHumanToken = await tokenForHuman(outsiderHuman.email);
    const deliveries: Array<{
      agentId: string;
      message: { message_id?: string; content: string; non_member_mention?: boolean; seq?: number };
      options: {
        adminAuthority?: boolean;
        requireQueueReceipt?: boolean;
        reconcileNonMemberMention?: boolean;
        mentionDeliveryOccurrenceId?: string;
      };
    }> = [];
    const deliveryContractRows: Array<{
      surface: "channel" | "thread";
      action: "ordinary_mention" | "notify" | "add";
      recipientMemberAtDelivery: boolean;
      delivered: boolean;
      nonMemberMention?: boolean;
    }> = [];
    const agentOrchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (
        agentId: string,
        message: { message_id?: string; content: string; non_member_mention?: boolean; seq?: number },
        options?: {
          adminAuthority?: boolean;
          requireQueueReceipt?: boolean;
          reconcileNonMemberMention?: boolean;
          mentionDeliveryOccurrenceId?: string;
        },
      ) => Promise<{
        status: "queued";
        reason: "replayable_inbox";
      }>;
    };
    agentOrchestrator.deliverMessage = async (agentId, message, options = {}) => {
      deliveries.push({ agentId, message, options });
      queueOwner.deliverToLocalInbox(agentId, message as AgentMessage, {
        reconcileNonMemberMention: options.reconcileNonMemberMention,
      });
      return { status: "queued", reason: "replayable_inbox" };
    };

    async function createPendingMentionMessage(input: {
      channelId: string;
      senderId: string;
      content: string;
      targets: Array<{
        type: "agent" | "user";
        id: string;
        handle: string;
        availableActions: string[];
      }>;
    }) {
      const message = await createMessage(input.channelId, "user", input.senderId, input.content);
      const rows = await db.insert(messageMentions).values(input.targets.map((target) => ({
        messageId: message.id,
        messageSeq: message.seq,
        serverId: server.id,
        channelId: input.channelId,
        targetType: target.type,
        targetId: target.id,
        handleAtSendTime: target.handle,
        source: "send_path" as const,
        notifiableAtSend: false,
      }))).returning({
        id: messageMentions.id,
        messageId: messageMentions.messageId,
        targetType: messageMentions.targetType,
      });
      assert.equal(rows.length, input.targets.length);
      return {
        message: { id: message.id },
        pendingMentionActions: rows.map((row, index) => ({
          resolutionId: row.id,
          messageId: row.messageId,
          targetType: row.targetType,
          availableActions: input.targets[index]!.availableActions,
        })),
      };
    }

    const sent = await createPendingMentionMessage({
      channelId: channel.id,
      senderId: owner.id,
      content: `loop in @${outsider.name}`,
      targets: [{ type: "agent", id: outsider.id, handle: outsider.name, availableActions: ["notify", "add"] }],
    });
    const resolutionId = sent.pendingMentionActions[0]!.resolutionId;
    const ordinaryDelivery = deliveries.find((delivery) => (
      delivery.agentId === outsider.id
      && delivery.message.message_id === sent.pendingMentionActions[0]!.messageId
    ));
    deliveryContractRows.push({
      surface: "channel",
      action: "ordinary_mention",
      recipientMemberAtDelivery: false,
      delivered: ordinaryDelivery !== undefined,
      nonMemberMention: ordinaryDelivery?.message.non_member_mention,
    });

    const otherExecute = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(otherToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "notify", resolutionIds: [resolutionId] }),
    });
    assert.equal(otherExecute.status, 200);
    const otherExecuteBody = await otherExecute.json() as { results: Array<{ status: string }> };
    assert.equal(otherExecuteBody.results[0]?.status, "not_found", "resolution ids stay sender-owned");

    const notify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "notify", resolutionIds: [resolutionId] }),
    });
    assert.equal(notify.status, 200);
    const notifyBody = await notify.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
    assert.equal(notifyBody.results[0]?.status, "queued");
    assert.deepEqual(notifyBody.results[0]?.dedupedResolutionIds, [resolutionId]);
    const notifyDelivery = deliveries.find((delivery) => (
      delivery.agentId === outsider.id
      && delivery.message.message_id === sent.pendingMentionActions[0]!.messageId
    ));
    assert.equal(
      notifyDelivery?.message.non_member_mention,
      true,
      "notify-only delivery must disclose that the non-member cannot reply in the target",
    );
    deliveryContractRows.push({
      surface: "channel",
      action: "notify",
      recipientMemberAtDelivery: false,
      delivered: notifyDelivery !== undefined,
      nonMemberMention: notifyDelivery?.message.non_member_mention,
    });

    let [row] = await db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.id, resolutionId));
    assert.ok(row?.notifiedAt);
    assert.equal(row.notifiedByType, "user");
    assert.equal(row.notifiedById, owner.id);
    assert.equal(row.notifiedAction, "notify_only");
    let targetMembership = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, outsider.id)));
    assert.equal(targetMembership.length, 0, "notify-only must not add channel membership");

    const memberSent = await createPendingMentionMessage({
      channelId: channel.id,
      senderId: other.id,
      content: `member adds @${memberTargetAgent.name} and @${ordinaryTargetHuman.name}`,
      targets: [
        { type: "agent", id: memberTargetAgent.id, handle: memberTargetAgent.name, availableActions: ["notify", "add"] },
        { type: "user", id: ordinaryTargetHuman.id, handle: ordinaryTargetHuman.name, availableActions: ["notify", "add"] },
      ],
    });
    assert.equal(memberSent.pendingMentionActions.length, 2);
    assert.deepEqual(memberSent.pendingMentionActions.map((action) => action.availableActions), [
      ["notify", "add"],
      ["notify", "add"],
    ]);
    const memberAdd = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(otherToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: memberSent.pendingMentionActions.map((action) => action.resolutionId) }),
    });
    assert.equal(memberAdd.status, 200);
    const memberAddBody = await memberAdd.json() as { results: Array<{ status: string; reason?: string; dedupedResolutionIds?: string[] }> };
    assert.deepEqual(memberAddBody.results.map((result) => result.status), ["delivered", "delivered"]);
    assert.deepEqual(memberAddBody.results.map((result) => result.reason), [undefined, undefined]);
    assert.deepEqual(
      memberAddBody.results.map((result) => result.dedupedResolutionIds),
      memberSent.pendingMentionActions.map((action) => [action.resolutionId]),
    );
    const memberMentionRows = await db
      .select()
      .from(messageMentions)
      .where(inArray(messageMentions.id, memberSent.pendingMentionActions.map((action) => action.resolutionId)));
    assert.equal(memberMentionRows.length, 2);
    assert.ok(memberMentionRows.every((row) => row.notifiedAt !== null));
    assert.deepEqual(memberMentionRows.map((row) => row.notifiedAction), ["add", "add"]);
    assert.deepEqual(memberMentionRows.map((row) => row.notifiedByType), ["user", "user"]);
    assert.deepEqual(memberMentionRows.map((row) => row.notifiedById), [other.id, other.id]);
    targetMembership = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, memberTargetAgent.id)));
    assert.equal(targetMembership.length, 1, "members may add agents through mention actions");
    const ordinaryTargetMembership = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, ordinaryTargetHuman.id)));
    assert.equal(ordinaryTargetMembership.length, 1, "members may add users through mention actions");

    const add = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: [resolutionId] }),
    });
    assert.equal(add.status, 200);
    const addBody = await add.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
    assert.equal(addBody.results[0]?.status, "delivered");
    assert.deepEqual(addBody.results[0]?.dedupedResolutionIds, [resolutionId]);
    [row] = await db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.id, resolutionId));
    assert.equal(row?.notifiedAction, "add");
    assert.equal(row?.notifiedByType, "user");
    assert.equal(row?.notifiedById, owner.id);
    targetMembership = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, outsider.id)));
    assert.equal(targetMembership.length, 1);

    const targetMentions = await fetch(`${app.baseUrl}/internal/agent-api/mentions`, {
      headers: {
        Authorization: `Bearer ${outsiderCredential.apiKey}`,
      },
    });
    assert.equal(targetMentions.status, 200);
    const targetMentionBody = await targetMentions.json() as { mentions: Array<{ messageId: string }> };
    assert.deepEqual(
      targetMentionBody.mentions.map((mention) => mention.messageId),
      [sent.pendingMentionActions[0]!.messageId],
      "user add must notify the target with the original mentioned message, not only add membership",
    );
    const originalMessageDelivery = deliveries.find((delivery) =>
      delivery.agentId === outsider.id && delivery.message.message_id === sent.pendingMentionActions[0]!.messageId
    );
    assert.ok(
      originalMessageDelivery,
      "user add must immediately deliver the original mentioned message to the target agent",
    );
    const addDelivery = deliveries.filter((delivery) => (
      delivery.agentId === outsider.id
      && delivery.message.message_id === sent.pendingMentionActions[0]!.messageId
    )).at(-1);
    assert.equal(
      addDelivery?.message.non_member_mention,
      undefined,
      "membership delivery must not claim the newly added recipient is unable to reply",
    );
    const {
      mentionDeliveryOccurrenceId: addDeliveryOccurrenceId,
      ...addDeliveryQueueOptions
    } = addDelivery?.options ?? {};
    assert.deepEqual(
      addDeliveryQueueOptions,
      { adminAuthority: true, requireQueueReceipt: true, reconcileNonMemberMention: true },
      "membership delivery must carry its authoritative queue-reconciliation contract",
    );
    assert.equal(
      typeof addDeliveryOccurrenceId,
      "string",
      "membership delivery must bind the mention delivery occurrence it is recovering",
    );
    const reconciledInbox = await queueOwner.receiveMessages(outsider.id, false, 0);
    assert.deepEqual(
      reconciledInbox.map((message) => ({
        messageId: message.message_id,
        nonMemberMention: message.non_member_mention,
      })),
      [{
        messageId: sent.pendingMentionActions[0]!.messageId,
        nonMemberMention: undefined,
      }],
      "notify then add must leave one same-seq queue fact with current reply capability",
    );
    deliveryContractRows.push({
      surface: "channel",
      action: "add",
      recipientMemberAtDelivery: true,
      delivered: addDelivery !== undefined,
      nonMemberMention: addDelivery?.message.non_member_mention,
    });
    const deliveriesAfterFirstAdd = deliveries.length;
    const addReplay = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: [resolutionId] }),
    });
    assert.equal(addReplay.status, 200);
    const addReplayBody = await addReplay.json() as { results: Array<{ status: string; reason?: string }> };
    assert.equal(addReplayBody.results[0]?.status, "delivered");
    assert.equal(addReplayBody.results[0]?.reason, "already_delivered");
    assert.equal(
      deliveries.length,
      deliveriesAfterFirstAdd,
      "idempotent add replay must not live-deliver the original message again",
    );

    const humanSent = await createPendingMentionMessage({
      channelId: channel.id,
      senderId: owner.id,
      content: `loop in @${outsiderHuman.name}`,
      targets: [{ type: "user", id: outsiderHuman.id, handle: outsiderHuman.name, availableActions: ["notify", "add"] }],
    });
    assert.equal(humanSent.pendingMentionActions.length, 1);
    assert.equal(humanSent.pendingMentionActions[0]?.targetType, "user");
    assert.equal(humanSent.pendingMentionActions[0]?.messageId, humanSent.message.id);
    assert.deepEqual(humanSent.pendingMentionActions[0]?.availableActions, ["notify", "add"]);

    const humanNotify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "notify", resolutionIds: [humanSent.pendingMentionActions[0]!.resolutionId] }),
    });
    assert.equal(humanNotify.status, 200);
    const humanNotifyBody = await humanNotify.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
    assert.equal(humanNotifyBody.results[0]?.status, "queued");
    assert.deepEqual(humanNotifyBody.results[0]?.dedupedResolutionIds, [humanSent.pendingMentionActions[0]!.resolutionId]);

    const [humanMentionRow] = await db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.id, humanSent.pendingMentionActions[0]!.resolutionId));
    assert.ok(humanMentionRow?.notifiedAt);
    assert.equal(humanMentionRow.notifiedAction, "notify_only");
    assert.equal(humanMentionRow.notifiedByType, "user");
    assert.equal(humanMentionRow.notifiedById, owner.id);

    const targetListRes = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
      headers: authHeaders(outsiderHumanToken, server.id),
    });
    assert.equal(targetListRes.status, 200);
    const targetListBody = await targetListRes.json() as {
      messages: Array<{ id: string; mentions?: Array<{ type: string; id: string; name: string }> }>;
    };
    const targetVisibleMessage = targetListBody.messages.find((message) => message.id === humanSent.message.id);
    assert.ok(targetVisibleMessage, "notified public-channel human target should be able to load the original message");
    assert.deepEqual(
      targetVisibleMessage.mentions,
      [{ type: "user", id: outsiderHuman.id, name: outsiderHuman.name }],
      "human notify must expose the original mention through target-side message hydration",
    );

    const humanAdd = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: [humanSent.pendingMentionActions[0]!.resolutionId] }),
    });
    assert.equal(humanAdd.status, 200);
    const humanAddBody = await humanAdd.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
    assert.equal(humanAddBody.results[0]?.status, "delivered");
    assert.deepEqual(humanAddBody.results[0]?.dedupedResolutionIds, [humanSent.pendingMentionActions[0]!.resolutionId]);
    const [humanMember] = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, outsiderHuman.id)));
    assert.ok(humanMember, "human Add should add user targets through the same member-management path");

    const parent = await createMessage(channel.id, "user", owner.id, "thread parent for mention actions");
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    const threadOutsider = await createAgent(server.id, "UserRouteExecuteThreadOutsider", { runtime: "claude", model: "sonnet" });
    const threadOutsiderHuman = await seedUser("messages-actions-execute-thread-human@slock.test", "messagesActionsThreadHuman");
    await db.insert(serverMembers).values({ serverId: server.id, userId: threadOutsiderHuman.id, role: "member" }).onConflictDoNothing();
    const threadSent = await createPendingMentionMessage({
      channelId: thread.id,
      senderId: owner.id,
      content: `thread ping @${threadOutsider.name} and @${threadOutsiderHuman.name}`,
      targets: [
        { type: "agent", id: threadOutsider.id, handle: threadOutsider.name, availableActions: ["notify", "add"] },
        { type: "user", id: threadOutsiderHuman.id, handle: threadOutsiderHuman.name, availableActions: ["notify", "add"] },
      ],
    });
    const threadAgentPending = threadSent.pendingMentionActions.find((action) => action.targetType === "agent");
    const threadHumanPending = threadSent.pendingMentionActions.find((action) => action.targetType === "user");
    assert.deepEqual(threadAgentPending?.availableActions, ["notify", "add"]);
    assert.deepEqual(threadHumanPending?.availableActions, ["notify", "add"]);

    const threadAgentNotify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "notify", resolutionIds: [threadAgentPending!.resolutionId] }),
    });
    assert.equal(threadAgentNotify.status, 200);
    const threadAgentNotifyBody = await threadAgentNotify.json() as { results: Array<{ status: string }> };
    assert.equal(threadAgentNotifyBody.results[0]?.status, "queued");
    const threadNotifyDelivery = deliveries.filter((delivery) => (
      delivery.agentId === threadOutsider.id
      && delivery.message.message_id === threadSent.message.id
    )).at(-1);
    deliveryContractRows.push({
      surface: "thread",
      action: "notify",
      recipientMemberAtDelivery: false,
      delivered: threadNotifyDelivery !== undefined,
      nonMemberMention: threadNotifyDelivery?.message.non_member_mention,
    });

    const threadHumanNotify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "notify", resolutionIds: [threadHumanPending!.resolutionId] }),
    });
    assert.equal(threadHumanNotify.status, 200);
    const threadHumanNotifyBody = await threadHumanNotify.json() as { results: Array<{ status: string }> };
    assert.equal(threadHumanNotifyBody.results[0]?.status, "queued");
    const humanFollowRows = await db.select()
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, thread.id),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, threadOutsiderHuman.id),
      ));
    assert.equal(humanFollowRows.length, 0, "thread notify-only must not create a human follow");

    const threadHumanAdd = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: [threadHumanPending!.resolutionId] }),
    });
    assert.equal(threadHumanAdd.status, 200);
    const threadHumanAddBody = await threadHumanAdd.json() as { results: Array<{ status: string }> };
    assert.equal(threadHumanAddBody.results[0]?.status, "delivered");
    const [parentHumanMember] = await db
      .select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, threadOutsiderHuman.id)));
    assert.ok(parentHumanMember, "thread Add should add user targets to the parent channel");
    const [humanFollow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, thread.id),
        eq(threadFollows.followerType, "user"),
        eq(threadFollows.followerId, threadOutsiderHuman.id),
      ));
    assert.ok(humanFollow, "thread Add should follow the mentioned thread for the added user");

    const threadAgentAdd = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "add", resolutionIds: [threadAgentPending!.resolutionId] }),
    });
    assert.equal(threadAgentAdd.status, 200);
    const threadAgentAddBody = await threadAgentAdd.json() as { results: Array<{ status: string }> };
    assert.equal(threadAgentAddBody.results[0]?.status, "delivered");
    const threadAddDelivery = deliveries.filter((delivery) => (
      delivery.agentId === threadOutsider.id
      && delivery.message.message_id === threadSent.message.id
    )).at(-1);
    deliveryContractRows.push({
      surface: "thread",
      action: "add",
      recipientMemberAtDelivery: true,
      delivered: threadAddDelivery !== undefined,
      nonMemberMention: threadAddDelivery?.message.non_member_mention,
    });
    const [parentAgentMember] = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, threadOutsider.id)));
    assert.ok(parentAgentMember, "thread Add should add the agent to the parent channel");
    const [agentFollow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, thread.id),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, threadOutsider.id),
      ));
    assert.ok(agentFollow, "thread Add should follow the mentioned thread for the added agent");
    assert.deepEqual(deliveryContractRows, [
      {
        surface: "channel",
        action: "ordinary_mention",
        recipientMemberAtDelivery: false,
        delivered: false,
        nonMemberMention: undefined,
      },
      {
        surface: "channel",
        action: "notify",
        recipientMemberAtDelivery: false,
        delivered: true,
        nonMemberMention: true,
      },
      {
        surface: "channel",
        action: "add",
        recipientMemberAtDelivery: true,
        delivered: true,
        nonMemberMention: undefined,
      },
      {
        surface: "thread",
        action: "notify",
        recipientMemberAtDelivery: false,
        delivered: true,
        nonMemberMention: true,
      },
      {
        surface: "thread",
        action: "add",
        recipientMemberAtDelivery: true,
        delivered: true,
        nonMemberMention: undefined,
      },
    ], "only explicit notify may pierce a non-member mention, and only that delivery carries reply guidance");
  } finally {
    queueOwner.shutdown();
    await app.close();
  }
});

test("user mention-actions execute fails closed for private surfaces and removed senders", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("messages-actions-closed-owner@slock.test", "messages-actions-closed-owner");
  const server = await createServer("Messages Actions Closed", "messages-actions-closed", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "messages-actions-closed-channel");
  const privateChannel = await createChannel(server.id, "messages-actions-closed-private", undefined, "private");
  await addHuman(channel.id, owner.id);
  await addHuman(privateChannel.id, owner.id);
  const outsider = await createAgent(server.id, "UserRouteClosedOutsider", { runtime: "claude", model: "sonnet" });
  const ownerToken = await tokenForHuman(owner.email);

  const privateMessage = await createMessage(privateChannel.id, "user", owner.id, "private mention");
  const [privateMention] = await db.insert(messageMentions).values({
    messageId: privateMessage.id,
    messageSeq: privateMessage.seq,
    serverId: server.id,
    channelId: privateChannel.id,
    targetType: "agent",
    targetId: outsider.id,
    handleAtSendTime: outsider.name,
    source: "send_path",
    notifiableAtSend: false,
  }).returning();
  const privateNotify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "notify", resolutionIds: [privateMention.id] }),
  });
  assert.equal(privateNotify.status, 200);
  const privateNotifyBody = await privateNotify.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(privateNotifyBody.results[0]?.status, "no_permission");
  assert.equal(privateNotifyBody.results[0]?.reason, "target_lacks_read_access");

  const privateParent = await createMessage(privateChannel.id, "user", owner.id, "private thread parent");
  const privateThread = await getOrCreateThread(privateParent.id, owner.id, "user");
  const privateThreadReply = await createMessage(privateThread.id, "user", owner.id, "private thread mention");
  const [privateThreadMention] = await db.insert(messageMentions).values({
    messageId: privateThreadReply.id,
    messageSeq: privateThreadReply.seq,
    serverId: server.id,
    channelId: privateThread.id,
    targetType: "agent",
    targetId: outsider.id,
    handleAtSendTime: outsider.name,
    source: "send_path",
    notifiableAtSend: false,
  }).returning();
  const privateThreadNotify = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "notify", resolutionIds: [privateThreadMention.id] }),
  });
  assert.equal(privateThreadNotify.status, 200);
  const privateThreadNotifyBody = await privateThreadNotify.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(privateThreadNotifyBody.results[0]?.status, "no_permission");
  assert.equal(privateThreadNotifyBody.results[0]?.reason, "target_lacks_read_access");

  const publicMessage = await createMessage(channel.id, "user", owner.id, "public mention");
  const [publicMention] = await db.insert(messageMentions).values({
    messageId: publicMessage.id,
    messageSeq: publicMessage.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: outsider.id,
    handleAtSendTime: outsider.name,
    source: "send_path",
    notifiableAtSend: false,
  }).returning();
  await db
    .delete(channelHumans)
    .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, owner.id)));
  const removedSenderAdd = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "add", resolutionIds: [publicMention.id] }),
  });
  assert.equal(removedSenderAdd.status, 200);
  const removedSenderBody = await removedSenderAdd.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(removedSenderBody.results[0]?.status, "no_permission");
  assert.equal(removedSenderBody.results[0]?.reason, "sender_lacks_channel_access");

  const targetMembership = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, outsider.id)));
  assert.equal(targetMembership.length, 0);
});

test("message reaction update socket payload omits storage-only message columns", async ({ app }) => {
  const events = installFakeIo(app);
  const db = getDb();
  const owner = await seedUser("reaction-socket-owner@slock.test", "reaction-socket-owner");
  const server = await createServer("Reaction Socket Server", "reaction-socket-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "reaction-socket-channel");
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();
  const message = await createMessage(channel.id, "user", owner.id, "reactable socket message", "chat", undefined, {
    actionMetadata: {
      kind: "forwarded-bundle",
      forwardedItems: [{
        sourceServerId: server.id,
        sourceTargetId: channel.id,
        sourceMessageId: "source-message",
        sourceTargetSnapshot: {
          id: channel.id,
          type: "channel",
          label: "#reaction-socket-channel",
          labelVisibility: "public",
        },
        provenanceState: "available",
      }],
    },
  });
  await db.update(messages)
    .set({
      agentSendKey: "must-not-leak",
      searchText: "must-not-leak",
    })
    .where(eq(messages.id, message.id));
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(res.status, 200);

  const update = events.find((event) => event.event === "message:updated" && event.room === `channel:${channel.id}`)?.payload;
  assert.ok(update, "expected realtime message:updated payload");
  assert.equal("agentSendKey" in update, false);
  assert.equal("searchText" in update, false);
  assert.equal("searchVector" in update, false);
  assert.equal(update.id, message.id);
  assert.equal(update.channelId, channel.id);
  assert.equal(update.content, "reactable socket message");
  assert.equal(update.senderName, owner.displayName);
  assert.equal(update.commentRef, null);
  assert.equal(update.reactions[0]?.emoji, "👍");
  assert.equal(update.actionMetadata.forwardedItems[0]?.sourceServerId, null);
  assert.equal(update.actionMetadata.forwardedItems[0]?.sourceTargetId, null);
  assert.equal(update.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "");
  assert.equal(update.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.labelVisibility, "restricted");
  const response = await res.json() as { actionMetadata: { forwardedItems: Array<{ sourceTargetSnapshot: { label: string } }> } };
  assert.equal(response.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "#reaction-socket-channel");
});

test("agent reactions aggregate with human reactions without delivery side effects", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("agent-reaction-owner@slock.test", "agent-reaction-owner");
  const server = await createServer("Agent Reaction Server", "agent-reaction-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "agent-reaction-channel");
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();

  const agent = await createAgent(server.id, "reaction-agent", { runtime: "codex" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "reaction-machine");
  await assignMachine(agent.id, machine.id);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();

  const message = await createMessage(channel.id, "user", owner.id, "agent reactable message");
  const ownerToken = await tokenForHuman(owner.email);

  const addAgent = async () => fetch(`${app.baseUrl}/internal/agent/${agent.id}/messages/${message.id}/reactions`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });

  const first = await addAgent();
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { reactions: Array<{ emoji: string; count: number; reactorIds: string[]; reactorNames: string[] }> };
  assert.deepEqual(firstBody.reactions, [{
    emoji: "👀",
    count: 1,
    reactorIds: [agent.id],
    reactorNames: [agent.displayName],
  }]);

  const second = await addAgent();
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { reactions: Array<{ emoji: string; count: number }> };
  assert.equal(secondBody.reactions.find((reaction) => reaction.emoji === "👀")?.count, 1);

  const humanAdd = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(humanAdd.status, 200);
  const humanBody = await humanAdd.json() as { reactions: Array<{ emoji: string; count: number; reactorIds: string[] }> };
  const combined = humanBody.reactions.find((reaction) => reaction.emoji === "👀");
  assert.equal(combined?.count, 2);
  assert.deepEqual(new Set(combined?.reactorIds), new Set([agent.id, owner.id]));

  const persisted = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, message.id));
  assert.equal(persisted.some((row) => row.reactorType === "agent" && row.reactorId === agent.id), true);
  assert.equal(persisted.some((row) => row.reactorType === "user" && row.reactorId === owner.id), true);

  const removeAgent = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/messages/${message.id}/reactions`, {
    method: "DELETE",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(removeAgent.status, 200);
  const removeBody = await removeAgent.json() as { reactions: Array<{ emoji: string; count: number; reactorIds: string[] }> };
  const afterRemove = removeBody.reactions.find((reaction) => reaction.emoji === "👀");
  assert.equal(afterRemove?.count, 1);
  assert.deepEqual(afterRemove?.reactorIds, [owner.id]);
});

test("message reactions reject system messages and archived channels", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reaction-guard-owner@slock.test", "reaction-guard-owner");
  const nonMember = await seedUser("reaction-guard-non-member@slock.test", "reaction-guard-non-member");
  const server = await createServer("Reaction Guard Server", "reaction-guard-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  await db.insert(serverMembers).values({ serverId: server.id, userId: nonMember.id, role: "member" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "reaction-guard-channel");
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();
  const systemMessage = await createMessage(channel.id, "user", "system", "system event", "system");
  const chatMessage = await createMessage(channel.id, "user", owner.id, "archived message");
  const token = await tokenForHuman(owner.email);
  const nonMemberToken = await tokenForHuman(nonMember.email);

  const systemRes = await fetch(`${app.baseUrl}/api/messages/${systemMessage.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(systemRes.status, 400);
  assert.match((await systemRes.json() as { error: string }).error, /System messages/);

  const nonMemberRes = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(nonMemberToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(nonMemberRes.status, 403);
  const nonMemberRemove = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
    method: "DELETE",
    headers: {
      ...authHeaders(nonMemberToken, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(nonMemberRemove.status, 403);

  await addHuman(channel.id, nonMember.id);
  const formerMemberMessage = await createMessage(channel.id, "user", nonMember.id, "former member's own message");
  await removeHuman(channel.id, nonMember.id);
  for (const method of ["POST", "DELETE"] as const) {
    const ownMessageReaction = await fetch(`${app.baseUrl}/api/messages/${formerMemberMessage.id}/reactions`, {
      method,
      headers: {
        ...authHeaders(nonMemberToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(ownMessageReaction.status, 403, `former members must not ${method} reactions on their own old messages`);
  }
  const nonMemberRows = await db.select({ reactorId: messageReactions.reactorId })
    .from(messageReactions)
    .where(and(
      inArray(messageReactions.messageId, [chatMessage.id, formerMemberMessage.id]),
      eq(messageReactions.reactorType, "user"),
      eq(messageReactions.reactorId, nonMember.id),
    ));
  assert.equal(nonMemberRows.length, 0, "readable public channels must not grant add/remove reaction writes without membership");

  await archiveChannel(channel.id, owner.id);
  const archivedRes = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(archivedRes.status, 409);
  const archivedBody = await archivedRes.json() as { code: string };
  assert.equal(archivedBody.code, "channel_archived");

  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, channel.id));
  for (const method of ["POST", "DELETE"] as const) {
    const deletedReaction = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
      method,
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(deletedReaction.status, 404, `deleted channels must cloak ${method} reaction targets`);
  }
});

test("message reactions cloak private message existence from non-members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-reaction-owner@slock.test", "private-reaction-owner");
  const outsider = await seedUser("private-reaction-outsider@slock.test", "private-reaction-outsider");
  const server = await createServer("Private Reaction Server", "private-reaction-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "private-reaction-channel", undefined, "private");
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id }).onConflictDoNothing();
  const chatMessage = await createMessage(channel.id, "user", owner.id, "private reactable message");
  const systemMessage = await createMessage(channel.id, "user", "system", "private system event", "system");
  const outsiderToken = await tokenForHuman(outsider.email);
  const headers = {
    ...authHeaders(outsiderToken, server.id),
    "Content-Type": "application/json",
  };

  const addChat = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(addChat.status, 404, `expected private add 404, got ${addChat.status}`);

  const removeChat = await fetch(`${app.baseUrl}/api/messages/${chatMessage.id}/reactions`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(removeChat.status, 404, `expected private remove 404, got ${removeChat.status}`);

  const addSystem = await fetch(`${app.baseUrl}/api/messages/${systemMessage.id}/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(addSystem.status, 404, `expected private system add 404, got ${addSystem.status}`);

  await db.insert(messages).values([
    {
      id: "dddddddd-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "private user reaction collision one",
    },
    {
      id: "dddddddd-2222-4222-8222-222222222222",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "private user reaction collision two",
    },
  ]);
  const privateCollision = await fetch(`${app.baseUrl}/api/messages/dddddddd/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(privateCollision.status, 404, `expected private collision add 404, got ${privateCollision.status}`);

  const publicChannel = await createChannel(server.id, "public-reaction-collision");
  await addHuman(publicChannel.id, outsider.id);
  const [visibleCollision] = await db.insert(messages).values({
    id: "dddddddd-3333-4333-8333-333333333333",
    channelId: publicChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "public user reaction collision",
  }).returning();
  const visibleCollisionAdd = await fetch(`${app.baseUrl}/api/messages/dddddddd/reactions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(visibleCollisionAdd.status, 200, `expected visible collision add 200, got ${visibleCollisionAdd.status}`);
  const persistedCollision = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, visibleCollision.id));
  assert.equal(persistedCollision.length, 1);
  assert.equal(persistedCollision[0]?.reactorId, outsider.id);
});

test("reaction viewer GET, mutation ACK, and user-room event share one complete versioned snapshot without channel-room viewer keys", async ({ app }) => {
  const events = installFakeIo(app);
  const db = getDb();
  const owner = await seedUser("reaction-viewer-owner@slock.test", "reaction-viewer-owner");
  const server = await createServer("Reaction Viewer Server", "reaction-viewer-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "reaction-viewer-channel");
  await addHuman(channel.id, owner.id);
  const message = await createMessage(channel.id, "user", owner.id, "reaction viewer snapshot");
  const token = await tokenForHuman(owner.email);

  const mutate = async (method: "POST" | "DELETE", emoji: string) => {
    const response = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
      method,
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ emoji }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      reactionViewer: {
        serverId: string;
        messageId: string;
        viewerVersion: number;
        reactedEmojis: string[];
      };
    }>;
  };

  const first = await mutate("POST", "👍");
  assert.deepEqual(first.reactionViewer, {
    serverId: server.id,
    messageId: message.id,
    viewerVersion: 1,
    reactedEmojis: ["👍"],
  });
  const firstEvent = events.filter((event) =>
    event.room === `user:${owner.id}` && event.event === "reaction_viewer:updated"
  ).at(-1);
  assert.deepEqual(firstEvent?.payload, first.reactionViewer, "mutation ACK and user-room event must be byte-equivalent snapshots");

  const idempotentAdd = await mutate("POST", "👍");
  assert.deepEqual(idempotentAdd.reactionViewer, first.reactionViewer, "idempotent add must not advance the viewer version");

  const secondEmoji = await mutate("POST", "👀");
  assert.equal(secondEmoji.reactionViewer.viewerVersion, 2);
  assert.deepEqual(secondEmoji.reactionViewer.reactedEmojis, ["👀", "👍"]);

  const canonicalOrder = await mutate("POST", "❤️");
  assert.deepEqual(canonicalOrder.reactionViewer, {
    serverId: server.id,
    messageId: message.id,
    viewerVersion: 3,
    reactedEmojis: ["❤️", "👀", "👍"],
  });
  const canonicalOrderEvent = events.filter((event) =>
    event.room === `user:${owner.id}` && event.event === "reaction_viewer:updated"
  ).at(-1);
  assert.deepEqual(canonicalOrderEvent?.payload, canonicalOrder.reactionViewer);

  const hydrate = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/viewer`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(hydrate.status, 200);
  assert.deepEqual(await hydrate.json(), canonicalOrder.reactionViewer, "cold hydrate and mutation ACK must share exact canonical bytes");

  const removed = await mutate("DELETE", "👍");
  assert.deepEqual(removed.reactionViewer, {
    serverId: server.id,
    messageId: message.id,
    viewerVersion: 4,
    reactedEmojis: ["❤️", "👀"],
  });
  const idempotentRemove = await mutate("DELETE", "👍");
  assert.deepEqual(idempotentRemove.reactionViewer, removed.reactionViewer, "idempotent remove must not advance the viewer version");

  for (const event of events.filter((candidate) => candidate.room === `channel:${channel.id}` && candidate.event === "message:updated")) {
    assert.equal("reactionViewer" in event.payload, false);
    assert.equal("viewerVersion" in event.payload, false);
    assert.equal("reactedEmojis" in event.payload, false);
  }
});

test("reaction actor pages bind typed cursors and stale after human, legacy-agent, and Agent API mutations", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reaction-page-owner@slock.test", "reaction-page-owner");
  const member = await seedUser("reaction-page-member@slock.test", "reaction-page-member");
  const server = await createServer("Reaction Page Server", "reaction-page-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]).onConflictDoNothing();
  const channel = await createChannel(server.id, "reaction-page-channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, "reaction-page-agent", { runtime: "codex" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "reaction-page-machine");
  await assignMachine(agent.id, machine.id);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();
  const message = await createMessage(channel.id, "user", owner.id, "reaction page target");
  const otherMessage = await createMessage(channel.id, "user", owner.id, "reaction page other target");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  for (const token of [ownerToken, memberToken]) {
    const response = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
      method: "POST",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀" }),
    });
    assert.equal(response.status, 200);
  }

  const firstPage = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&limit=1`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(firstPage.status, 200);
  const firstBody = await firstPage.json() as {
    discussionVersion: number;
    actors: Array<{ actorRef: { kind: "user" | "agent"; id: string } }>;
    nextCursor: string;
  };
  assert.equal(firstBody.discussionVersion, 2);
  assert.equal(firstBody.actors.length, 1);
  assert.equal(firstBody.actors[0]?.actorRef.kind, "user");
  assert.ok(firstBody.nextCursor);

  const principalReplay = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
    headers: authHeaders(memberToken, server.id),
  });
  assert.equal(principalReplay.status, 400);
  assert.equal((await principalReplay.json() as { code: string }).code, "invalid_reaction_actors_cursor");

  const wrongMessage = await fetch(`${app.baseUrl}/api/messages/${otherMessage.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(wrongMessage.status, 400);
  const wrongEmoji = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👍")}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(wrongEmoji.status, 400);

  const agentAdd = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/messages/${message.id}/reactions`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(agentAdd.status, 200);

  const stale = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "Reaction discussion changed while reading this page",
    code: "reaction_discussion_version_changed",
    currentDiscussionVersion: 3,
    rebaselineRequired: true,
  });

  const postLegacyPage = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&limit=1`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(postLegacyPage.status, 200);
  const postLegacyBody = await postLegacyPage.json() as { nextCursor: string };
  assert.ok(postLegacyBody.nextCursor);

  const agentApiCredential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["reactions"],
    name: "reaction-page-agent-api",
    createdByUserId: owner.id,
  });
  const agentApiRemove = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/reactions`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${agentApiCredential.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(agentApiRemove.status, 200);

  const agentApiStale = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(postLegacyBody.nextCursor)}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(agentApiStale.status, 409);
  assert.deepEqual(await agentApiStale.json(), {
    error: "Reaction discussion changed while reading this page",
    code: "reaction_discussion_version_changed",
    currentDiscussionVersion: 4,
    rebaselineRequired: true,
  });

  const agentApiRestore = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/reactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentApiCredential.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(agentApiRestore.status, 200);

  const fresh = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&limit=100`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(fresh.status, 200);
  const freshBody = await fresh.json() as {
    discussionVersion: number;
    actors: Array<{ actorRef: { kind: string; id: string } }>;
  };
  assert.equal(freshBody.discussionVersion, 5);
  assert.deepEqual(
    new Set(freshBody.actors.map((actor) => `${actor.actorRef.kind}:${actor.actorRef.id}`)),
    new Set([`user:${owner.id}`, `user:${member.id}`, `agent:${agent.id}`]),
  );
});

test("reaction actor pagination applies #all hidden-human directory authorization before sorting and keeps agents visible", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reaction-directory-owner@slock.test", "reaction-directory-owner");
  const member = await seedUser("reaction-directory-member@slock.test", "reaction-directory-member");
  const other = await seedUser("reaction-directory-other@slock.test", "reaction-directory-other");
  const server = await createServer("Reaction Directory Server", "reaction-directory-server", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]).onConflictDoNothing();
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel);
  const agent = await createAgent(server.id, "reaction-directory-agent", { runtime: "codex" });
  const message = await createMessage(allChannel.id, "user", owner.id, "hidden directory reaction target");
  await db.insert(messageReactions).values([
    { messageId: message.id, reactorType: "user", reactorId: owner.id, emoji: "👀" },
    { messageId: message.id, reactorType: "user", reactorId: member.id, emoji: "👀" },
    { messageId: message.id, reactorType: "user", reactorId: other.id, emoji: "👀" },
    { messageId: message.id, reactorType: "agent", reactorId: agent.id, emoji: "👀" },
  ]);
  const memberToken = await tokenForHuman(member.email);
  const ownerToken = await tokenForHuman(owner.email);

  const visibleRefs: string[] = [];
  let cursor: string | null = null;
  let firstCursor: string | null = null;
  do {
    const url = new URL(`${app.baseUrl}/api/messages/${message.id}/reactions/actors`);
    url.searchParams.set("emoji", "👀");
    url.searchParams.set("limit", "1");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: authHeaders(memberToken, server.id) });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      actors: Array<{ actorRef: { kind: string; id: string } }>;
      nextCursor: string | null;
    };
    visibleRefs.push(...body.actors.map((actor) => `${actor.actorRef.kind}:${actor.actorRef.id}`));
    firstCursor ??= body.nextCursor;
    cursor = body.nextCursor;
  } while (cursor);
  assert.deepEqual(visibleRefs, [`agent:${agent.id}`, `user:${member.id}`], "hidden actors must not consume page boundaries");

  assert.ok(firstCursor);
  await db.update(serversTable).set({ hideHumansFromMembers: false }).where(eq(serversTable.id, server.id));
  const changedDirectoryReplay = await fetch(
    `${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(firstCursor)}`,
    { headers: authHeaders(memberToken, server.id) },
  );
  assert.equal(changedDirectoryReplay.status, 409, "a changed authorized directory requires explicit rebaseline");
  assert.deepEqual(
    await changedDirectoryReplay.json(),
    {
      error: "Reaction actor visibility changed while reading this page",
      code: "reaction_actor_visibility_changed",
      rebaselineRequired: true,
    },
  );

  const ownerResponse = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&limit=100`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(ownerResponse.status, 200);
  const ownerBody = await ownerResponse.json() as { actors: Array<{ actorRef: { kind: string; id: string } }> };
  assert.deepEqual(
    new Set(ownerBody.actors.map((actor) => `${actor.actorRef.kind}:${actor.actorRef.id}`)),
    new Set([`user:${owner.id}`, `user:${member.id}`, `user:${other.id}`, `agent:${agent.id}`]),
  );
});

test("reaction actor read names private, archived, short-id collision, wrong-server, emoji, and cursor negatives", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("reaction-read-guard-owner@slock.test", "reaction-read-guard-owner");
  const outsider = await seedUser("reaction-read-guard-outsider@slock.test", "reaction-read-guard-outsider");
  const server = await createServer("Reaction Read Guard", "reaction-read-guard", owner.id);
  const otherServer = await createServer("Reaction Read Other", "reaction-read-other", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: outsider.id, role: "member" },
    { serverId: otherServer.id, userId: owner.id, role: "owner" },
  ]).onConflictDoNothing();
  const privateChannel = await createChannel(server.id, "reaction-read-private", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  const privateMessage = await createMessage(privateChannel.id, "user", owner.id, "private actor read");
  await db.insert(messageReactions).values({
    messageId: privateMessage.id,
    reactorType: "user",
    reactorId: owner.id,
    emoji: "👍",
  });
  const ownerToken = await tokenForHuman(owner.email);
  const outsiderToken = await tokenForHuman(outsider.email);

  const privateRead = await fetch(`${app.baseUrl}/api/messages/${privateMessage.id}/reactions/actors?emoji=${encodeURIComponent("👍")}`, {
    headers: authHeaders(outsiderToken, server.id),
  });
  assert.equal(privateRead.status, 404);

  await archiveChannel(privateChannel.id, owner.id);
  const archivedRead = await fetch(`${app.baseUrl}/api/messages/${privateMessage.id}/reactions/actors?emoji=${encodeURIComponent("👍")}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(archivedRead.status, 409);
  assert.equal((await archivedRead.json() as { code: string }).code, "channel_archived");

  const publicChannel = await createChannel(server.id, "reaction-read-public");
  await addHuman(publicChannel.id, owner.id);
  await db.insert(messages).values([
    {
      id: "eeeeeeee-1111-4111-8111-111111111111",
      channelId: publicChannel.id,
      senderType: "user",
      senderId: owner.id,
      content: "reaction collision one",
    },
    {
      id: "eeeeeeee-2222-4222-8222-222222222222",
      channelId: publicChannel.id,
      senderType: "user",
      senderId: owner.id,
      content: "reaction collision two",
    },
  ]);
  const collision = await fetch(`${app.baseUrl}/api/messages/eeeeeeee/reactions/actors?emoji=${encodeURIComponent("👍")}`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(collision.status, 400);

  const wrongServer = await fetch(`${app.baseUrl}/api/messages/eeeeeeee-1111-4111-8111-111111111111/reactions/actors?emoji=${encodeURIComponent("👍")}`, {
    headers: authHeaders(ownerToken, otherServer.id),
  });
  assert.equal(wrongServer.status, 404);

  const invalidEmoji = await fetch(`${app.baseUrl}/api/messages/eeeeeeee-1111-4111-8111-111111111111/reactions/actors?emoji=not%20emoji`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(invalidEmoji.status, 400);
  assert.equal((await invalidEmoji.json() as { code: string }).code, "invalid_reaction_emoji");

  const invalidCursor = await fetch(`${app.baseUrl}/api/messages/eeeeeeee-1111-4111-8111-111111111111/reactions/actors?emoji=${encodeURIComponent("👍")}&cursor=tampered`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(invalidCursor.status, 400);
  assert.equal((await invalidCursor.json() as { code: string }).code, "invalid_reaction_actors_cursor");
});

test("joint reaction actor discussion uses the requester-local scope and rejects a cursor replayed on the peer server", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("reaction-joint-host@slock.test", "reaction-joint-host");
  const guestOwner = await seedUser("reaction-joint-guest@slock.test", "reaction-joint-guest");
  const hostServer = await createServer("Reaction Joint Host", "reaction-joint-host", hostOwner.id);
  const guestServer = await createServer("Reaction Joint Guest", "reaction-joint-guest", guestOwner.id);
  await db.update(serversTable).set({ plan: "founder" }).where(inArray(serversTable.id, [hostServer.id, guestServer.id]));
  await db.insert(serverMembers).values([
    { serverId: hostServer.id, userId: hostOwner.id, role: "owner" },
    { serverId: guestServer.id, userId: guestOwner.id, role: "owner" },
  ]).onConflictDoNothing();
  const hostProjection = await createChannel(hostServer.id, "reaction-joint-room", undefined, "joint");
  const guestProjection = await createChannel(guestServer.id, "reaction-joint-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(guestProjection.id, guestOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: hostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: guestServer.id,
      localChannelId: guestProjection.id,
      role: "participant",
      joinedByUserId: guestOwner.id,
    },
  ]);
  const message = await createMessage(hostProjection.id, "user", hostOwner.id, "joint actor page");
  const hostToken = await tokenForHuman(hostOwner.email);
  const guestToken = await tokenForHuman(guestOwner.email);
  for (const [token, serverId] of [[hostToken, hostServer.id], [guestToken, guestServer.id]] as const) {
    const response = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions`, {
      method: "POST",
      headers: { ...authHeaders(token, serverId), "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "👀" }),
    });
    assert.equal(response.status, 200);
  }

  const guestPage = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&limit=1`, {
    headers: authHeaders(guestToken, guestServer.id),
  });
  assert.equal(guestPage.status, 200);
  const guestBody = await guestPage.json() as {
    discussion: {
      root: { serverId: string; id: string };
      parentScope: { serverId: string; scopeKind: string; scopeId: string };
    };
    nextCursor: string;
  };
  assert.deepEqual(guestBody.discussion.root, { kind: "message", serverId: guestServer.id, id: message.id });
  assert.deepEqual(guestBody.discussion.parentScope, {
    serverId: guestServer.id,
    scopeKind: "channel",
    scopeId: guestProjection.id,
  });
  assert.ok(guestBody.nextCursor);

  const peerReplay = await fetch(`${app.baseUrl}/api/messages/${message.id}/reactions/actors?emoji=${encodeURIComponent("👀")}&cursor=${encodeURIComponent(guestBody.nextCursor)}`, {
    headers: authHeaders(hostToken, hostServer.id),
  });
  assert.equal(peerReplay.status, 400);
  assert.equal((await peerReplay.json() as { code: string }).code, "invalid_reaction_actors_cursor");
});

test("DM message context resolves short message ids for a DM participant", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("dm-link-owner@slock.test", "dm-link-owner");
  const recipient = await seedUser("dm-link-recipient@slock.test", "dm-link-recipient");
  const server = await createServer("DM Link Server", "dm-link-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: recipient.id, role: "member" },
  ]).onConflictDoNothing();

  const dm = await findOrCreateUserDM(server.id, owner.id, recipient.id);
  assert.ok(dm);
  const targetMessage = await createMessage(
    dm.id,
    "user",
    owner.id,
    "dm short id context target",
  );
  const targetShortId = targetMessage.id.slice(0, 8);

  const recipientToken = await tokenForHuman(recipient.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${targetShortId}`);
  contextUrl.searchParams.set("channelId", dm.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(recipientToken, server.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    messages: Array<{ id: string; content: string }>;
  };
  assert.equal(context.channelId, dm.id);
  assert.equal(context.targetMessageId, targetMessage.id);
  assert.ok(
    context.messages.some((message) =>
      message.id === targetMessage.id
      && message.content === "dm short id context target"
    ),
    "DM participant should resolve the parent message by short id",
  );
});

test("message context canonicalizes parent-channel links that point at thread replies", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("thread-context-owner@slock.test", "thread-context-owner");
  const server = await createServer("Thread Context Server", "thread-context-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const parentChannel = await createChannel(server.id, "thread-context-parent");
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id }).onConflictDoNothing();
  const parentMessage = await createMessage(
    parentChannel.id,
    "user",
    owner.id,
    "thread parent",
  );
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(channelHumans).values({ channelId: thread.id, userId: owner.id }).onConflictDoNothing();
  const threadReply = await createMessage(
    thread.id,
    "user",
    owner.id,
    "thread reply",
  );

  const ownerToken = await tokenForHuman(owner.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${threadReply.id.slice(0, 8)}`);
  contextUrl.searchParams.set("channelId", parentChannel.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    canonicalTarget?: {
      kind: string;
      channelId: string;
      messageId: string;
      threadParentMessageId?: string;
      threadChannelId?: string;
    };
    messages: Array<{ id: string; channelId: string; content: string }>;
  };
  assert.equal(context.channelId, thread.id);
  assert.equal(context.targetMessageId, threadReply.id);
  assert.deepEqual(context.canonicalTarget, {
    kind: "thread",
    channelId: parentChannel.id,
    messageId: threadReply.id,
    threadParentMessageId: parentMessage.id,
    threadChannelId: thread.id,
  });
  assert.ok(
    context.messages.every((message) => message.channelId === thread.id),
    "context should return thread messages, not splice thread replies into the parent channel timeline",
  );
});

test("message context accepts thread channel short ids scoped to the parent channel", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("thread-channel-ref-owner@slock.test", "thread-channel-ref-owner");
  const server = await createServer("Thread Channel Ref Server", "thread-channel-ref-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const parentChannel = await createChannel(server.id, "thread-channel-ref-parent");
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id }).onConflictDoNothing();
  const parentMessage = await createMessage(
    parentChannel.id,
    "user",
    owner.id,
    "thread-channel-id parent",
  );
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(channelHumans).values({ channelId: thread.id, userId: owner.id }).onConflictDoNothing();
  await createMessage(
    thread.id,
    "user",
    owner.id,
    "thread-channel-id reply",
  );

  const ownerToken = await tokenForHuman(owner.email);
  const contextUrl = new URL(`${app.baseUrl}/api/messages/context/${thread.id.slice(0, 8)}`);
  contextUrl.searchParams.set("channelId", parentChannel.id);
  const contextRes = await fetch(contextUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(contextRes.status, 200);
  const context = await contextRes.json() as {
    channelId: string;
    targetMessageId: string;
    messages: Array<{ id: string; channelId: string; content: string }>;
  };
  assert.equal(context.channelId, parentChannel.id);
  assert.equal(context.targetMessageId, parentMessage.id);
  assert.ok(
    context.messages.some((message) =>
      message.id === parentMessage.id
      && message.content === "thread-channel-id parent"
    ),
    "thread channel short-id refs should resolve to the parent message context",
  );
});

test("GET /messages/search supports explicit recent sort without changing relevance default", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-sort-owner@slock.test", "search-sort-owner");
  const server = await createServer("Search Sort Server", "search-sort-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "search-sort-channel");

  const oldHighRelevance = await createMessage(
    channel.id,
    "user",
    owner.id,
    "chronos chronos chronos chronos chronos older high relevance",
  );
  const newLowRelevance = await createMessage(
    channel.id,
    "user",
    owner.id,
    "chronos newer low relevance",
  );

  await db.update(messages)
    .set({ createdAt: new Date("2026-05-01T00:00:00.000Z") })
    .where(eq(messages.id, oldHighRelevance.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-02T00:00:00.000Z") })
    .where(eq(messages.id, newLowRelevance.id));

  const ownerToken = await tokenForHuman(owner.email);
  const relevanceRes = await fetch(
    `${app.baseUrl}/api/messages/search?q=chronos&limit=2`,
    { headers: authHeaders(ownerToken, server.id) },
  );
  assert.equal(relevanceRes.status, 200);
  const relevanceBody = await relevanceRes.json() as { results: Array<{ id: string }> };
  assert.equal(relevanceBody.results[0]?.id, oldHighRelevance.id, "default relevance sort should still rank the stronger text match first");

  const recentRes = await fetch(
    `${app.baseUrl}/api/messages/search?q=chronos&sort=recent&limit=2`,
    { headers: authHeaders(ownerToken, server.id) },
  );
  assert.equal(recentRes.status, 200);
  const recentBody = await recentRes.json() as { results: Array<{ id: string }> };
  assert.equal(recentBody.results[0]?.id, newLowRelevance.id, "recent sort should order by created_at first");

  const invalidRes = await fetch(
    `${app.baseUrl}/api/messages/search?q=chronos&sort=fancy`,
    { headers: authHeaders(ownerToken, server.id) },
  );
  assert.equal(invalidRes.status, 400);
});

test("GET /messages/search falls back to relaxed CJK token matching when strict all-token search is empty", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-cjk-fallback-owner@slock.test", "search-cjk-fallback-owner");
  const server = await createServer("Search CJK Fallback Server", "search-cjk-fallback-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const channel = await createChannel(server.id, "search-cjk-fallback-channel");

  const target = await createMessage(
    channel.id,
    "user",
    owner.id,
    "今晚真收工 Eric 的八发全中账我背书，各位辛苦。",
  );
  await createMessage(
    channel.id,
    "user",
    owner.id,
    "明天开讨论会。",
  );
  for (let index = 0; index < 24; index += 1) {
    await createMessage(
      channel.id,
      "user",
      owner.id,
      `今晚 fallback decoy ${index.toString().padStart(2, "0")}`,
    );
  }

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(
    `${app.baseUrl}/api/messages/search?q=${encodeURIComponent("今晚八发刚收工，明天开")}&limit=20`,
    { headers: authHeaders(ownerToken, server.id) },
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ id: string; content: string }>; hasMore: boolean };
  assert.equal(body.results[0]?.id, target.id, "relaxed fallback should rank the best partial token match first");
  assert.match(body.results[0]?.content ?? "", /今晚真收工/);
  assert.equal(body.results.length, 20, "relaxed fallback still caps the rescue page to the requested limit");
  assert.equal(body.hasMore, false, "relaxed fallback is a one-page rescue and must not promise empty strict pages");
});

test("GET /messages/search records success and failure diagnostics", async ({  }) => {
  const t = {  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errorLog.mockRestore());
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "5".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const owner = await seedUser("search-trace-owner@slock.test", "search-trace-owner");
    const server = await createServer("Search Trace Server", "search-trace-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const channel = await createChannel(server.id, "search-trace-channel");
    await createMessage(channel.id, "user", owner.id, "traceable needle message");

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const successRes = await fetch(
      `${app.baseUrl}/api/messages/search?q=needle&sort=recent&limit=5`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(successRes.status, 200);

    const successSpan = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/messages/search"
    );
    assert.ok(successSpan, "expected search request root span");
    const acceptedEvent = successSpan.events.find((event) => event.name === "message_search.request.accepted");
    assert.ok(acceptedEvent);
    assert.equal(acceptedEvent.attrs?.query_present, true);
    assert.equal(acceptedEvent.attrs?.query_length_bucket, "short");
    assert.equal(acceptedEvent.attrs?.sort, "recent");
    assert.equal(Object.values(acceptedEvent.attrs ?? {}).includes("needle"), false);

    const queryFinishedEvent = successSpan.events.find((event) => event.name === "message_search.query.finished");
    assert.ok(queryFinishedEvent);
    assert.equal(queryFinishedEvent.attrs?.outcome, "success");
    assert.equal(queryFinishedEvent.attrs?.reason, "query_completed");
    assert.equal(queryFinishedEvent.attrs?.visible_row_count, 1);

    const responseReadyEvent = successSpan.events.find((event) => event.name === "message_search.response.ready");
    assert.ok(responseReadyEvent);
    assert.equal(responseReadyEvent.attrs?.results_count, 1);
    assert.equal(responseReadyEvent.attrs?.has_more, false);
    const successQuerySpan = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.db.query"
      && candidate.context.parentSpanId === successSpan.context.spanId
      && candidate.attrs?.query_name === "messages.search"
    );
    assert.ok(successQuerySpan, "expected request-linked search query child span");
    assert.equal(successQuerySpan.attrs?.phase, "visibility_candidates_enrich");
    assert.equal(successQuerySpan.attrs?.query_plan_shape, "fts_recent_page_first");
    assert.equal(successQuerySpan.attrs?.query_length_bucket, "short");
    assert.equal(Object.values(successQuerySpan.attrs ?? {}).includes("needle"), false);

    await db.insert(messages).values({
      channelId: channel.id,
      senderType: "user",
      senderId: "not-a-uuid",
      content: "broken-search-sender",
      searchText: "broken-search-sender",
    });
    sink.clear();

    const failureRes = await fetch(
      `${app.baseUrl}/api/messages/search?q=broken-search-sender`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(failureRes.status, 500);

    const failureSpan = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/messages/search"
    );
    assert.ok(failureSpan, "expected failed search request root span");
    const queryFailedEvent = failureSpan.events.find((event) => event.name === "message_search.query.failed");
    assert.ok(queryFailedEvent);
    assert.equal(queryFailedEvent.attrs?.outcome, "error");
    assert.equal(queryFailedEvent.attrs?.reason, "query_failed");
    assert.ok(queryFailedEvent.attrs?.error_class);
    assert.equal(queryFailedEvent.attrs?.sqlstate, "22P02");
    assert.equal(typeof queryFailedEvent.attrs?.error_message, "string");
    assert.match(String(queryFailedEvent.attrs?.error_message), /invalid input syntax/);
    assert.equal(String(queryFailedEvent.attrs?.error_message).includes("broken-search-sender"), false);
    assert.equal(String(queryFailedEvent.attrs?.error_message).includes("broken search sender"), false);

    const routeFailedEvent = failureSpan.events.find((event) => event.name === "message_search.route.failed");
    assert.ok(routeFailedEvent);
    assert.equal(routeFailedEvent.attrs?.http_status, 500);
    assert.equal(routeFailedEvent.attrs?.outcome, "error");
    assert.equal(routeFailedEvent.attrs?.reason, "route_failed");
    assert.equal(routeFailedEvent.attrs?.sqlstate, "22P02");
    assert.equal(typeof routeFailedEvent.attrs?.error_message, "string");
    assert.equal(String(routeFailedEvent.attrs?.error_message).includes("broken-search-sender"), false);
    assert.equal(String(routeFailedEvent.attrs?.error_message).includes("broken search sender"), false);
    const failedQuerySpan = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.db.query"
      && candidate.context.parentSpanId === failureSpan.context.spanId
      && candidate.attrs?.query_name === "messages.search"
    );
    assert.ok(failedQuerySpan, "expected failed search query child span");
    assert.equal(failedQuerySpan.status, "error");
    assert.equal(failedQuerySpan.attrs?.reason, "database_error");
    assert.equal(failedQuerySpan.attrs?.sqlstate, "22P02");
    assert.equal(failedQuerySpan.attrs?.error_message, "Database statement failed");
    assert.equal(JSON.stringify(failedQuerySpan.attrs).includes("broken-search-sender"), false);
  } finally {
    await app.close();
  }
});

test("message search returns typed QUERY_TOO_BROAD above the documented boundary without forging an empty set", async ({ app }) => {

  try {
    const owner = await seedUser("search-breadth-owner@slock.test", "search-breadth-owner");
    const server = await createServer("Search Breadth Server", "search-breadth-server", owner.id);
    const channel = await createChannel(server.id, "search-breadth-channel");
    const agent = await createAgent(server.id, "search-breadth-agent", { runtime: "codex" });
    const agentCredential = await mintAgentCredential({
      agentId: agent.id,
      scopes: ["read"],
      name: "search-breadth-agent-api",
      createdByUserId: owner.id,
    });
    await createMessage(channel.id, "user", owner.id, "breadthboundary searchable row");

    let injectedEstimate = MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT;
    const dialect = new PgDialect();
    __setSearchServiceDepsForTests({
      executeSearchSql: (async (statement: SQL, options?: { signal?: AbortSignal }) => {
        const rendered = dialect.sqlToQuery(statement).sql.trimStart();
        if (rendered.startsWith("EXPLAIN (FORMAT JSON)")) {
          return {
            rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Nested Loop", "Plan Rows": injectedEstimate } }] }],
          };
        }
        return executeSearchSqlFromDb(statement, options);
      }) as typeof executeSearchSqlFromDb,
    });

    const ownerToken = await tokenForHuman(owner.email);
    const userHeaders = authHeaders(ownerToken, server.id);
    const atLimit = await fetch(`${app.baseUrl}/api/messages/search?q=breadthboundary&limit=1`, {
      headers: userHeaders,
    });
    assert.equal(atLimit.status, 200, "the exact documented threshold remains searchable");
    const atLimitBody = await atLimit.json() as { results: unknown[]; hasMore: boolean };
    assert.equal(atLimitBody.results.length, 1);

    injectedEstimate = MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT + 1;

    const userBroad = await fetch(`${app.baseUrl}/api/messages/search?q=breadthboundary&limit=1`, {
      headers: userHeaders,
    });
    assert.equal(userBroad.status, 422);
    assert.deepEqual(await userBroad.json(), {
      error: "Search query is too broad. Add a channel, sender, or time filter, or use --sort recent.",
      code: "QUERY_TOO_BROAD",
    });

    const agentBroad = await fetch(`${app.baseUrl}/internal/agent-api/search?q=breadthboundary&limit=1`, {
      headers: { Authorization: `Bearer ${agentCredential.apiKey}` },
    });
    assert.equal(agentBroad.status, 422);
    assert.deepEqual(await agentBroad.json(), {
      error: "Search query is too broad. Add a channel, sender, or time filter, or use --sort recent.",
      errorCode: "QUERY_TOO_BROAD",
    });

    const recent = await fetch(`${app.baseUrl}/api/messages/search?q=breadthboundary&sort=recent&limit=1`, {
      headers: userHeaders,
    });
    assert.equal(recent.status, 200, "explicit recent sort is the exact bounded outlet for a broad query");
    const recentBody = await recent.json() as { results: unknown[]; hasMore: boolean };
    assert.equal(recentBody.results.length, 1);
  } finally {
    __resetSearchServiceDepsForTests();
    await app.close();
  }
});

test("message search maps admitted PostgreSQL statement timeout to typed SEARCH_TIMEOUT instead of an empty set", async ({ app }) => {

  try {
    const owner = await seedUser("search-timeout-owner@slock.test", "search-timeout-owner");
    const server = await createServer("Search Timeout Server", "search-timeout-server", owner.id);
    const channel = await createChannel(server.id, "search-timeout-channel");
    await createMessage(channel.id, "user", owner.id, "underestimated searchable row");

    const dialect = new PgDialect();
    __setSearchServiceDepsForTests({
      executeSearchSql: (async (statement: SQL) => {
        const rendered = dialect.sqlToQuery(statement).sql.trimStart();
        if (rendered.startsWith("EXPLAIN (FORMAT JSON)")) {
          return {
            rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Nested Loop", "Plan Rows": 1 } }] }],
          };
        }
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }) as typeof executeSearchSqlFromDb,
    });

    const ownerToken = await tokenForHuman(owner.email);
    const response = await fetch(`${app.baseUrl}/api/messages/search?q=underestimated&limit=1`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Search timed out. Add a channel, sender, or time filter, use --sort recent, or retry.",
      code: "SEARCH_TIMEOUT",
    });
  } finally {
    __resetSearchServiceDepsForTests();
    await app.close();
  }
});

test("message search planner timeout and malformed estimate fail closed with typed errors", async ({ app }) => {

  try {
    const owner = await seedUser("search-planner-owner@slock.test", "search-planner-owner");
    const server = await createServer("Search Planner Server", "search-planner-server", owner.id);
    const channel = await createChannel(server.id, "search-planner-channel");
    await createMessage(channel.id, "user", owner.id, "planner searchable row");
    const ownerToken = await tokenForHuman(owner.email);
    const headers = authHeaders(ownerToken, server.id);

    __setSearchServiceDepsForTests({
      executeSearchSql: (async (_statement: SQL, options?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new SearchQueryAbortedError()), { once: true });
        });
      }) as typeof executeSearchSqlFromDb,
    });
    const timedOut = await fetch(`${app.baseUrl}/api/messages/search?q=planner&limit=1`, { headers });
    assert.equal(timedOut.status, 503);
    assert.deepEqual(await timedOut.json(), {
      error: "Search timed out. Add a channel, sender, or time filter, use --sort recent, or retry.",
      code: "SEARCH_TIMEOUT",
    });

    __setSearchServiceDepsForTests({
      executeSearchSql: (async () => ({ rows: [{ "QUERY PLAN": [{ Plan: { "Plan Rows": null } }] }] })) as typeof executeSearchSqlFromDb,
    });
    const malformed = await fetch(`${app.baseUrl}/api/messages/search?q=planner&limit=1`, { headers });
    assert.equal(malformed.status, 503);
    assert.deepEqual(await malformed.json(), {
      error: "Search planning is temporarily unavailable. Retry the search.",
      code: "SEARCH_UNAVAILABLE",
    });
  } finally {
    __resetSearchServiceDepsForTests();
    await app.close();
  }
});

test("GET /messages/search supports filter-only browse without keyword query", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-filter-only-owner@slock.test", "search-filter-only-owner");
  const other = await seedUser("search-filter-only-other@slock.test", "search-filter-only-other");
  const server = await createServer("Search Filter Only Server", "search-filter-only-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]).onConflictDoNothing();
  const channel = await createChannel(server.id, "search-filter-only-channel");
  const otherChannel = await createChannel(server.id, "search-filter-only-other-channel");

  const oldOwnerMessage = await createMessage(channel.id, "user", owner.id, "old owner filter-only message");
  const newOwnerMessage = await createMessage(channel.id, "user", owner.id, "new owner filter-only message");
  const otherUserMessage = await createMessage(channel.id, "user", other.id, "other user filter-only message");
  const ownerOtherChannelMessage = await createMessage(otherChannel.id, "user", owner.id, "owner in another channel");
  const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent filter-only message");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(channelHumans).values({ channelId: thread.id, userId: owner.id }).onConflictDoNothing();
  const threadReply = await createMessage(thread.id, "user", owner.id, "thread reply filter-only message");

  await db.update(messages)
    .set({ createdAt: new Date("2026-05-01T00:00:00.000Z") })
    .where(eq(messages.id, oldOwnerMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-02T00:00:00.000Z") })
    .where(eq(messages.id, newOwnerMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-03T00:00:00.000Z") })
    .where(eq(messages.id, otherUserMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-04T00:00:00.000Z") })
    .where(eq(messages.id, ownerOtherChannelMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-04-30T00:00:00.000Z") })
    .where(eq(messages.id, parentMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-05T00:00:00.000Z") })
    .where(eq(messages.id, threadReply.id));

  const ownerToken = await tokenForHuman(owner.email);
  const emptyRes = await fetch(
    `${app.baseUrl}/api/messages/search?limit=3`,
    { headers: authHeaders(ownerToken, server.id) },
  );
  assert.equal(emptyRes.status, 200);
  const emptyBody = await emptyRes.json() as { results: unknown[]; hasMore: boolean };
  assert.deepEqual(emptyBody, { results: [], hasMore: false });

  const filterOnlyUrl = new URL(`${app.baseUrl}/api/messages/search`);
  filterOnlyUrl.searchParams.set("senderId", owner.id);
  filterOnlyUrl.searchParams.set("channelId", channel.id);
  filterOnlyUrl.searchParams.set("limit", "3");
  const filterOnlyRes = await fetch(filterOnlyUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(filterOnlyRes.status, 200);
  const filterOnlyBody = await filterOnlyRes.json() as {
    results: Array<{
      id: string;
      senderId: string;
      channelId: string;
      parentChannelId: string | null;
      content: string;
      snippet: string;
    }>;
    hasMore: boolean;
  };
  assert.deepEqual(filterOnlyBody.results.map((result) => result.id), [
    threadReply.id,
    newOwnerMessage.id,
    oldOwnerMessage.id,
  ]);
  assert.equal(filterOnlyBody.hasMore, true);
  assert.ok(filterOnlyBody.results.every((result) => result.senderId === owner.id));
  assert.equal(filterOnlyBody.results[0]?.channelId, thread.id);
  assert.equal(filterOnlyBody.results[0]?.parentChannelId, channel.id);
  assert.ok(filterOnlyBody.results.slice(1).every((result) => result.channelId === channel.id));
  assert.equal(filterOnlyBody.results[0]?.snippet, "thread reply filter-only message");

  const senderOnlyUrl = new URL(`${app.baseUrl}/api/messages/search`);
  senderOnlyUrl.searchParams.set("senderId", owner.id);
  senderOnlyUrl.searchParams.set("limit", "2");
  const senderOnlyRes = await fetch(senderOnlyUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(senderOnlyRes.status, 200);
  const senderOnlyBody = await senderOnlyRes.json() as {
    results: Array<{ id: string; senderId: string; channelId: string; parentChannelId: string | null }>;
    hasMore: boolean;
  };
  assert.deepEqual(senderOnlyBody.results.map((result) => result.id), [
    threadReply.id,
    ownerOtherChannelMessage.id,
  ]);
  assert.equal(senderOnlyBody.hasMore, true);
  assert.ok(senderOnlyBody.results.every((result) => result.senderId === owner.id));
});

test("GET /messages/search supports sender type and self-mention scopes", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-scope-owner@slock.test", "search-scope-owner");
  const other = await seedUser("search-scope-other@slock.test", "search-scope-other");
  const server = await createServer("Search Scope Server", "search-scope-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]).onConflictDoNothing();
  const channel = await createChannel(server.id, "search-scope-channel");
  const agent = await createAgent(server.id, "SearchScopeAgent", { runtime: "codex", model: "gpt-5" });
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id }).onConflictDoNothing();

  const humanMessage = await createMessage(channel.id, "user", other.id, "human scoped message");
  const agentMessage = await createMessage(channel.id, "agent", agent.id, "agent scoped message");
  const mentionMessage = await createMessage(channel.id, "user", other.id, "mentioned scoped message");
  await db.insert(messageMentions).values({
    messageId: mentionMessage.id,
    messageSeq: mentionMessage.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: owner.name,
    source: "send_path",
    notifiableAtSend: true,
  });
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-01T00:00:00.000Z") })
    .where(eq(messages.id, humanMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-02T00:00:00.000Z") })
    .where(eq(messages.id, agentMessage.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-05-03T00:00:00.000Z") })
    .where(eq(messages.id, mentionMessage.id));

  const ownerToken = await tokenForHuman(owner.email);

  const humanScopeUrl = new URL(`${app.baseUrl}/api/messages/search`);
  humanScopeUrl.searchParams.set("senderType", "user");
  humanScopeUrl.searchParams.set("limit", "10");
  const humanScopeRes = await fetch(humanScopeUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(humanScopeRes.status, 200);
  const humanScopeBody = await humanScopeRes.json() as { results: Array<{ id: string; senderType: string }> };
  assert.deepEqual(humanScopeBody.results.map((result) => result.id), [mentionMessage.id, humanMessage.id]);
  assert.ok(humanScopeBody.results.every((result) => result.senderType === "user"));

  const agentScopeUrl = new URL(`${app.baseUrl}/api/messages/search`);
  agentScopeUrl.searchParams.set("senderType", "agent");
  agentScopeUrl.searchParams.set("limit", "10");
  const agentScopeRes = await fetch(agentScopeUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(agentScopeRes.status, 200);
  const agentScopeBody = await agentScopeRes.json() as { results: Array<{ id: string; senderType: string }> };
  assert.deepEqual(agentScopeBody.results.map((result) => result.id), [agentMessage.id]);
  assert.ok(agentScopeBody.results.every((result) => result.senderType === "agent"));

  const mentionScopeUrl = new URL(`${app.baseUrl}/api/messages/search`);
  mentionScopeUrl.searchParams.set("mentionTarget", "self");
  mentionScopeUrl.searchParams.set("limit", "10");
  const mentionScopeRes = await fetch(mentionScopeUrl, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(mentionScopeRes.status, 200);
  const mentionScopeBody = await mentionScopeRes.json() as { results: Array<{ id: string }> };
  assert.deepEqual(mentionScopeBody.results.map((result) => result.id), [mentionMessage.id]);

  const invalidSenderTypeRes = await fetch(`${app.baseUrl}/api/messages/search?senderType=robot`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(invalidSenderTypeRes.status, 400);

  const invalidMentionTargetRes = await fetch(`${app.baseUrl}/api/messages/search?mentionTarget=all`, {
    headers: authHeaders(ownerToken, server.id),
  });
  assert.equal(invalidMentionTargetRes.status, 400);
});

test("GET /messages/search cloaks explicit private channel filter from non-members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("search-private-owner@slock.test", "search-private-owner");
  const nonMember = await seedUser("search-private-nonmember@slock.test", "search-private-nonmember");
  const server = await createServer("Search Private Server", "search-private-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: nonMember.id, role: "member" },
  ]).onConflictDoNothing();
  const privateChannel = await createChannel(server.id, "search-private-channel", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await createMessage(privateChannel.id, "user", owner.id, "private search payload");

  const nonMemberToken = await tokenForHuman(nonMember.email);
  const privateFilterUrl = new URL(`${app.baseUrl}/api/messages/search`);
  privateFilterUrl.searchParams.set("channelId", privateChannel.id);
  privateFilterUrl.searchParams.set("limit", "2");

  const res = await fetch(privateFilterUrl, {
    headers: authHeaders(nonMemberToken, server.id),
  });

  assert.equal(res.status, 404);
  const body = await res.json() as { error?: string };
  assert.equal(body.error, "Channel not found");
});

test("POST /messages/forward is fail-closed until the forwarding flag is enabled", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const db = getDb();
  const owner = await seedUser("forward-disabled-owner@slock.test", "forward-disabled-owner");
  const server = await createServer("Forward Disabled Server", "forward-disabled-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  const source = await createChannel(server.id, "forward-disabled-source");
  const destination = await createChannel(server.id, "forward-disabled-destination");
  await db.insert(channelHumans).values([
    { channelId: source.id, userId: owner.id },
    { channelId: destination.id, userId: owner.id },
  ]).onConflictDoNothing();
  const sourceMessage = await createMessage(source.id, "user", owner.id, "hidden forward source");
  const token = await tokenForHuman(owner.email);

  const enabled = await fetch(`${app.baseUrl}/api/messages/forward/enabled`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: false });

  sink.clear();
  const traceId = "7".repeat(32);
  const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
      traceparent: `00-${traceId}-${"f".repeat(16)}-01`,
    },
    body: JSON.stringify({
      destinationChannelId: destination.id,
      sourceMessageIds: [sourceMessage.id],
      note: "",
    }),
  });

  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Forwarding is not available" });
  const span = findForwardAttemptSpan(sink, traceId);
  const terminal = span?.events.find((event) => event.name === "messages.forward.terminal");
  assert.equal(terminal?.attrs?.phase, "gate");
  assert.equal(terminal?.attrs?.stable_code, "feature_disabled");
  assert.equal(terminal?.attrs?.error_class, "FeatureGateDenied");
});

test("POST /messages/forward uses message_forwarding_v0 server allowlist and kill switch", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("forward-flag-owner@slock.test", "forward-flag-owner");
  const allowlistedServer = await createServer("Forward Flag Allowed", "botiverse", owner.id);
  const blockedServer = await createServer("Forward Flag Blocked", "forward-flag-blocked", owner.id);
  await db.insert(serverMembers).values([
    { serverId: allowlistedServer.id, userId: owner.id, role: "owner" },
    { serverId: blockedServer.id, userId: owner.id, role: "owner" },
  ]).onConflictDoNothing();

  const seedForwardablePair = async (serverId: string, prefix: string) => {
    const source = await createChannel(serverId, `${prefix}-source`);
    const destination = await createChannel(serverId, `${prefix}-destination`);
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();
    const sourceMessage = await createMessage(source.id, "user", owner.id, `${prefix} source`);
    return { source, destination, sourceMessage };
  };

  const allowlisted = await seedForwardablePair(allowlistedServer.id, "forward-flag-allowlisted");
  const blocked = await seedForwardablePair(blockedServer.id, "forward-flag-blocked");
  const token = await tokenForHuman(owner.email);

  await db.insert(featureFlagRules).values({
    flagKey: MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
    stage: "server",
    decision: "allow",
    values: [allowlistedServer.id],
  });

  const allowlistedEnabled = await fetch(`${app.baseUrl}/api/messages/forward/enabled`, {
    headers: authHeaders(token, allowlistedServer.id),
  });
  assert.equal(allowlistedEnabled.status, 200);
  assert.deepEqual(await allowlistedEnabled.json(), { enabled: true });

  const blockedEnabled = await fetch(`${app.baseUrl}/api/messages/forward/enabled`, {
    headers: authHeaders(token, blockedServer.id),
  });
  assert.equal(blockedEnabled.status, 200);
  assert.deepEqual(await blockedEnabled.json(), { enabled: false });

  const blockedForward = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: {
      ...authHeaders(token, blockedServer.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      destinationChannelId: blocked.destination.id,
      sourceMessageIds: [blocked.sourceMessage.id],
      note: "",
    }),
  });
  assert.equal(blockedForward.status, 404);
  assert.deepEqual(await blockedForward.json(), { error: "Forwarding is not available" });

  const allowlistedForward = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: {
      ...authHeaders(token, allowlistedServer.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      destinationChannelId: allowlisted.destination.id,
      sourceMessageIds: [allowlisted.sourceMessage.id],
      note: "",
    }),
  });
  assert.equal(allowlistedForward.status, 200, await allowlistedForward.clone().text());

  await db
    .update(featureFlags)
    .set({ killSwitch: true })
    .where(eq(featureFlags.key, MESSAGE_FORWARDING_FEATURE_FLAG_KEY));

  const killedEnabled = await fetch(`${app.baseUrl}/api/messages/forward/enabled`, {
    headers: authHeaders(token, allowlistedServer.id),
  });
  assert.equal(killedEnabled.status, 200);
  assert.deepEqual(await killedEnabled.json(), { enabled: false });

  const killedForward = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: {
      ...authHeaders(token, allowlistedServer.id),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      destinationChannelId: allowlisted.destination.id,
      sourceMessageIds: [allowlisted.sourceMessage.id],
      note: "",
    }),
  });
  assert.equal(killedForward.status, 404);
  assert.deepEqual(await killedForward.json(), { error: "Forwarding is not available" });
});

test("POST /messages/forward records pre-router auth, account, and server admission terminals", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const db = getDb();
  const traceIds = ["1".repeat(32), "2".repeat(32), "3".repeat(32), "4".repeat(32)];
  const post = (traceId: string, headers: Record<string, string> = {}) => fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      traceparent: `00-${traceId}-${"a".repeat(16)}-01`,
      ...headers,
    },
    body: JSON.stringify({}),
  });

  sink.clear();
  const missingAuth = await post(traceIds[0]!);
  assert.equal(missingAuth.status, 401);

  const user = await seedUser("forward-admission@slock.test", "forward-admission");
  const token = signAccessToken(user.id);
  await db.update(users).set({ emailVerified: false }).where(eq(users.id, user.id));
  const unverified = await post(traceIds[1]!, { Authorization: `Bearer ${token}` });
  assert.equal(unverified.status, 403);

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
  const missingServer = await post(traceIds[2]!, { Authorization: `Bearer ${token}` });
  assert.equal(missingServer.status, 400);

  const otherOwner = await seedUser("forward-other-owner@slock.test", "forward-other-owner");
  const otherServer = await createServer("Forward Other Server", "forward-other-server", otherOwner.id);
  const nonMember = await post(traceIds[3]!, {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": otherServer.id,
  });
  assert.equal(nonMember.status, 403);

  const expected = [
    ["auth_required", "AuthDenied"],
    ["account_not_ready", "AccountAdmissionDenied"],
    ["server_context_required", "ServerContextDenied"],
    ["server_membership_required", "ServerMembershipDenied"],
  ];
  for (const [index, traceId] of traceIds.entries()) {
    const span = findForwardAttemptSpan(sink, traceId);
    assert.ok(span);
    const terminal = span.events.find((event) => event.name === "messages.forward.terminal");
    assert.equal(terminal?.attrs?.route_family, "message_forward");
    assert.equal(terminal?.attrs?.phase, "gate");
    assert.equal(terminal?.attrs?.stable_code, expected[index]?.[0]);
    assert.equal(terminal?.attrs?.error_class, expected[index]?.[1]);
    assert.equal(terminal?.attrs?.commit_state, "pre_commit");
  }
});

test("POST /messages/forward records a pre-router rate-limit terminal", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, enforceMessageRateLimit: true, messageRateLimitMax: 1 });
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-rate-owner@slock.test", "forward-rate-owner");
    const server = await createServer("Forward Rate Server", "forward-rate-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const token = signAccessToken(owner.id);
    const headers = {
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({});
    const first = await fetch(`${app.baseUrl}/api/messages/forward`, { method: "POST", headers, body });
    assert.equal(first.status, 404);

    sink.clear();
    const traceId = "5".repeat(32);
    const limited = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: { ...headers, traceparent: `00-${traceId}-${"b".repeat(16)}-01` },
      body,
    });
    assert.equal(limited.status, 429);
    const span = findForwardAttemptSpan(sink, traceId);
    assert.ok(span);
    const terminal = span.events.find((event) => event.name === "messages.forward.terminal");
    assert.deepEqual(terminal?.attrs, {
      route_family: "message_forward",
      phase: "gate",
      outcome: "rejected",
      http_status: 429,
      status_bucket: "4xx",
      stable_code: "rate_limited",
      error_class: "RateLimitDenied",
      commit_state: "pre_commit",
    });
  } finally {
    await app.close();
  }
});

test("POST /messages/forward records validation rejection on the propagated trace", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-validation-owner@slock.test", "forward-validation-owner");
    const server = await createServer("Forward Validation Server", "forward-validation-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const token = signAccessToken(owner.id);
    const traceId = "6".repeat(32);

    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
        traceparent: `00-${traceId}-${"c".repeat(16)}-01`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Destination channel and full source message ids are required" });
    const span = findForwardAttemptSpan(sink, traceId);
    const terminal = span?.events.find((event) => event.name === "messages.forward.terminal");
    assert.deepEqual(terminal?.attrs, {
      route_family: "message_forward",
      phase: "validate",
      outcome: "rejected",
      http_status: 400,
      status_bucket: "4xx",
      stable_code: "invalid_request",
      error_class: "ValidationError",
      commit_state: "pre_commit",
    });
  } finally {
    await app.close();
  }
});

test("POST /messages/forward stores an ordered immutable forwarded bundle snapshot", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-owner@slock.test", "forward-owner");
    const server = await createServer("Forward Server", "forward-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();

    const source = await createChannel(server.id, "forward-source");
    const destination = await createChannel(server.id, "forward-destination");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();

    const first = await createMessage(source.id, "user", owner.id, "first source snapshot");
    const second = await createMessage(source.id, "user", owner.id, "second source snapshot");
    // Visible timeline order is createdAt, not insertion/seq order. Seed/import
    // paths may backdate rows, so deliberately invert the two here.
    await db.update(messages).set({ createdAt: new Date("2026-07-17T00:20:00.000Z") }).where(eq(messages.id, first.id));
    await db.update(messages).set({ createdAt: new Date("2026-07-16T23:50:00.000Z") }).where(eq(messages.id, second.id));
    const [sourceObject] = await db.insert(attachmentObjects).values({
      originServerId: server.id,
      uploaderId: owner.id,
      uploaderType: "user",
      mimeType: "application/pdf",
      sizeBytes: 256,
      storageKey: "forward/forward-source.pdf",
    }).returning();
    await db.insert(attachmentObjectCharges).values({
      objectId: sourceObject.id,
      originServerId: server.id,
      chargeMonth: "2026-07-01",
      sizeBytes: 256,
    });
    const [sourceAttachment] = await db.insert(attachments).values({
      objectId: sourceObject.id,
      messageId: first.id,
      channelId: source.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "forward source.pdf",
      mimeType: "application/pdf",
      sizeBytes: 256,
      storageKey: "forward/forward-source.pdf",
    }).returning();
    const token = await tokenForHuman(owner.email);
    sink.clear();
    const forwardTraceId = "7".repeat(32);
    let forwardAttempt = 0;
    const tracedHeaders = () => ({
      ...authHeaders(token, server.id),
      "Content-Type": "application/json",
      traceparent: `00-${forwardTraceId}-${String(++forwardAttempt).padStart(16, "0")}-01`,
    });

    const enabled = await fetch(`${app.baseUrl}/api/messages/forward/enabled`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { enabled: true });

    const forwardRequest = {
      destinationChannelId: destination.id,
      sourceMessageIds: [second.id, first.id],
      note: "forwarding context",
      randomId: `forward-test-${randomUUID()}`,
    };
    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: tracedHeaders(),
      body: JSON.stringify(forwardRequest),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-raft-forward-outcome"), "success");
    const body = await res.json() as {
      id: string;
      channelId: string;
      content: string;
      actionMetadata: {
        kind: string;
        forwardedItems: Array<{
          sourceMessageId: string;
          sourceIsThreadParent: boolean;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
          attachmentSnapshots: Array<Record<string, unknown>>;
          attachmentPolicy: string;
        }>;
      };
    };
    assert.equal(body.channelId, destination.id);
    assert.equal(body.content, "forwarding context");
    assert.equal(body.actionMetadata.kind, "forwarded-bundle");
    assert.equal("forwardRequestFingerprint" in body.actionMetadata, false);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [second.id, first.id]);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.contentSnapshot), [
      "second source snapshot",
      "first source snapshot",
    ]);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.sourceIsThreadParent), [false, false]);
    assert.equal(body.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "#forward-source");
    assert.equal(body.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.labelVisibility, "public");
    assert.deepEqual(body.actionMetadata.forwardedItems[0]?.attachmentSnapshots, []);
    const [destinationSnapshot] = body.actionMetadata.forwardedItems[1]?.attachmentSnapshots ?? [];
    assert.equal(typeof destinationSnapshot?.id, "string");
    assert.notEqual(destinationSnapshot?.id, sourceAttachment.id);
    assert.deepEqual(destinationSnapshot, {
      id: destinationSnapshot?.id,
      filename: "forward source.pdf",
      mimeType: "application/pdf",
      sizeBytes: 256,
      width: null,
      height: null,
    });
    assert.equal("sourceProjectionId" in body.actionMetadata.forwardedItems[1]!.attachmentSnapshots[0]!, false);
    assert.equal("url" in body.actionMetadata.forwardedItems[1]!.attachmentSnapshots[0]!, false);
    assert.equal(body.actionMetadata.forwardedItems[0]?.attachmentPolicy, "excluded");
    assert.equal(body.actionMetadata.forwardedItems[1]?.attachmentPolicy, "projected");

    const [destinationProjection] = await db.select().from(attachments)
      .where(eq(attachments.id, destinationSnapshot!.id as string));
    assert.equal(destinationProjection.messageId, body.id);
    assert.equal(destinationProjection.channelId, destination.id);
    assert.equal(destinationProjection.objectId, sourceObject.id);
    const charges = await db.select().from(attachmentObjectCharges)
      .where(eq(attachmentObjectCharges.objectId, sourceObject.id));
    assert.equal(charges.length, 1, "forward projection must not create another object charge");

    const replayRes = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: tracedHeaders(),
      body: JSON.stringify(forwardRequest),
    });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.headers.get("x-raft-forward-outcome"), "idempotent_replay");
    const replayBody = await replayRes.json() as typeof body;
    assert.equal(replayBody.id, body.id);
    assert.deepEqual(
      replayBody.actionMetadata.forwardedItems[1]?.attachmentSnapshots,
      body.actionMetadata.forwardedItems[1]?.attachmentSnapshots,
      "response-loss retry must return the originally committed destination projection ids",
    );

    const conflictRes = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: tracedHeaders(),
      body: JSON.stringify({ ...forwardRequest, note: "different payload" }),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal((await conflictRes.json() as { code: string }).code, "idempotency_conflict");

    const forwardSpans = sink.getAllSpans().filter((candidate) => (
      candidate.name === "server.message.forward"
    ));
    assert.equal(forwardSpans.length, 3);
    assert.deepEqual(forwardSpans.map((span) => span.context.traceId), [forwardTraceId, forwardTraceId, forwardTraceId]);
    const terminals = forwardSpans.map((span) => span.events.find((event) => event.name === "messages.forward.terminal"));
    assert.deepEqual(terminals.map((event) => event?.attrs?.outcome), ["success", "idempotent_replay", "rejected"]);
    assert.deepEqual(terminals.map((event) => event?.attrs?.stable_code), ["ok", "idempotent_replay", "idempotency_conflict"]);
    assert.deepEqual(terminals.map((event) => event?.attrs?.phase), ["response", "response", "persist_broadcast"]);
    for (const terminal of terminals) {
      assert.equal(terminal?.attrs?.route_family, "message_forward");
      assert.equal("request_id" in (terminal?.attrs ?? {}), false);
      assert.equal("channel_id" in (terminal?.attrs ?? {}), false);
      assert.equal("message_id" in (terminal?.attrs ?? {}), false);
    }
    assert.equal(JSON.stringify(terminals).includes(forwardRequest.randomId), false);

    await db.update(messages).set({ content: "first source edited later" }).where(eq(messages.id, first.id));
    const [stored] = await db.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, body.id));
    const storedMetadata = stored.actionMetadata as typeof body.actionMetadata;
    assert.deepEqual(storedMetadata.forwardedItems.map((item) => item.contentSnapshot), [
      "second source snapshot",
      "first source snapshot",
    ]);
    assert.deepEqual(storedMetadata.forwardedItems[1]?.attachmentSnapshots, [destinationSnapshot]);
  } finally {
    await app.close();
  }
});

test("POST /messages/forward records an unexpected terminal phase without identifiers", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.forward.beforeSourceSnapshot", {
    mode: "once",
    effect: "throw",
    payload: new TypeError("private type failure"),
  });
  __setFailpointsForTests(registry);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-unexpected@slock.test", "forward-unexpected");
    const server = await createServer("Forward Unexpected", "forward-unexpected", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const source = await createChannel(server.id, "forward-unexpected-source");
    const destination = await createChannel(server.id, "forward-unexpected-destination");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();
    const sourceMessage = await createMessage(source.id, "user", owner.id, "private source content");
    const token = await tokenForHuman(owner.email);
    sink.clear();
    __setWebHttpClientTraceSinkForTest(sink);
    const clientSpan = startWebHttpClientSpan("POST");
    const clientTraceparent = clientSpan.traceparent;
    const traceId = clientTraceparent.split("-")[1]!;

    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
        traceparent: clientTraceparent,
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
        randomId: "unexpected-forward-test",
      }),
    });
    assert.equal(res.status, 500);
    const responseBody = await res.json() as { error: string };
    clientSpan.end({
      requestUrl: "/messages/forward",
      statusCode: res.status,
      responseData: responseBody,
      responseHeaders: res.headers,
    });
    assert.deepEqual(responseBody, { error: "Failed to forward message" });

    const spans = sink.getAllSpans();
    const webSpan = spans.find((candidate) => candidate.name === "web.http.client");
    const span = spans.find((candidate) => candidate.name === "server.message.forward");
    assert.ok(webSpan);
    assert.ok(span);
    assert.equal(webSpan.context.traceId, traceId);
    assert.equal(span.context.traceId, traceId);
    assert.deepEqual(webSpan.attrs, {
      method: "POST",
      outcome: "error",
      status_bucket: "5xx",
      status_code: 500,
      route_family: "message_forward",
      response_state: "received",
      stable_code: "server_error",
      forward_outcome: "error",
      forward_status_bucket: "5xx",
    });
    const terminal = span.events.find((event) => event.name === "messages.forward.terminal");
    assert.deepEqual(terminal?.attrs, {
      route_family: "message_forward",
      phase: "source_snapshot",
      outcome: "error",
      http_status: 500,
      status_bucket: "5xx",
      stable_code: "unexpected_type_error",
      error_class: "TypeError",
      commit_state: "pre_commit",
    });
    const serialized = JSON.stringify(terminal);
    assert.equal(serialized.includes(owner.id), false);
    assert.equal(serialized.includes(server.id), false);
    assert.equal(serialized.includes(source.id), false);
    assert.equal(serialized.includes(destination.id), false);
    assert.equal(serialized.includes(sourceMessage.id), false);
    assert.equal(serialized.includes("private source content"), false);
    assert.equal(serialized.includes("private type failure"), false);

    registry.configure("server.message.forward.beforeSourceSnapshot", {
      mode: "once",
      effect: "throw",
      payload: new RangeError("private range failure"),
    });
    const rangeClientSpan = startWebHttpClientSpan("POST");
    const rangeTraceId = rangeClientSpan.traceparent.split("-")[1]!;
    const rangeRes = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
        traceparent: rangeClientSpan.traceparent,
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
        randomId: "unexpected-forward-range-test",
      }),
    });
    const rangeBody = await rangeRes.json() as { error: string };
    rangeClientSpan.end({
      requestUrl: "/messages/forward",
      statusCode: rangeRes.status,
      responseData: rangeBody,
      responseHeaders: rangeRes.headers,
    });
    assert.equal(rangeRes.status, 500);
    const rangeServerSpan = findForwardAttemptSpan(sink, rangeTraceId);
    const rangeTerminal = rangeServerSpan?.events.find((event) => event.name === "messages.forward.terminal");
    assert.equal(rangeTerminal?.attrs?.stable_code, "unexpected_range_error");
    assert.equal(rangeTerminal?.attrs?.error_class, "RangeError");
    assert.equal(JSON.stringify(rangeTerminal).includes("private range failure"), false);
  } finally {
    __setWebHttpClientTraceSinkForTest(null);
    __resetFailpointsForTests();
    await app.close();
  }
});

test("POST /messages/forward keeps a pre-persist disconnect marker separate from the final error terminal", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  installFakeIo(app);
  const blocker = createBlockingThrowFailpoint(
    "server.message.forward.beforeSourceSnapshot",
    new TypeError("private disconnect precommit failure"),
  );
  __setFailpointsForTests(blocker.registry);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-disconnect-pre@slock.test", "forward-disconnect-pre");
    const server = await createServer("Forward Disconnect Pre", "forward-disconnect-pre", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const source = await createChannel(server.id, "forward-disconnect-pre-source");
    const destination = await createChannel(server.id, "forward-disconnect-pre-destination");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();
    const sourceMessage = await createMessage(source.id, "user", owner.id, "private disconnect source");
    const token = await tokenForHuman(owner.email);
    sink.clear();

    const traceId = "8".repeat(32);
    const pending = startDisconnectingJsonRequest(
      `${app.baseUrl}/api/messages/forward`,
      {
        ...authHeaders(token, server.id),
        traceparent: `00-${traceId}-${"d".repeat(16)}-01`,
      },
      {
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
        randomId: "disconnect-precommit-test",
      },
    );
    await blocker.waitUntilEntered();
    pending.disconnect();
    await pending.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    blocker.release();

    const span = await waitForForwardAttemptSpan(sink, traceId);
    const disconnectIndex = span.events.findIndex((event) => event.name === "messages.forward.client_disconnected");
    const terminalIndex = span.events.findIndex((event) => event.name === "messages.forward.terminal");
    assert.ok(disconnectIndex >= 0, "disconnect must be retained as a non-terminal marker");
    assert.ok(terminalIndex > disconnectIndex, "the handler terminal must follow and survive the disconnect marker");
    assert.deepEqual(span.events[terminalIndex]?.attrs, {
      route_family: "message_forward",
      phase: "source_snapshot",
      outcome: "error",
      http_status: 500,
      status_bucket: "5xx",
      stable_code: "unexpected_type_error",
      error_class: "TypeError",
      commit_state: "pre_commit",
    });
    const stored = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, destination.id));
    assert.equal(stored.length, 0);
    assert.equal(JSON.stringify(span.events).includes("private disconnect precommit failure"), false);
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("POST /messages/forward keeps a post-persist disconnect marker separate from the final committed terminal", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  installFakeIo(app);
  const barrier = createFailpointBarrier();
  const registry = new InMemoryFailpointRegistry({ sleep: barrier.sleep });
  registry.configure("server.message.forward.beforeResponse", {
    mode: "once",
    effect: "delay",
    payload: 91,
  });
  __setFailpointsForTests(registry);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-disconnect-post@slock.test", "forward-disconnect-post");
    const server = await createServer("Forward Disconnect Post", "forward-disconnect-post", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const source = await createChannel(server.id, "forward-disconnect-post-source");
    const destination = await createChannel(server.id, "forward-disconnect-post-destination");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();
    const sourceMessage = await createMessage(source.id, "user", owner.id, "private committed source");
    const token = await tokenForHuman(owner.email);
    sink.clear();

    const traceId = "9".repeat(32);
    const pending = startDisconnectingJsonRequest(
      `${app.baseUrl}/api/messages/forward`,
      {
        ...authHeaders(token, server.id),
        traceparent: `00-${traceId}-${"e".repeat(16)}-01`,
      },
      {
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
        randomId: "disconnect-postcommit-test",
      },
    );
    await barrier.waitForPayload(91, 1);
    pending.disconnect();
    await pending.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    barrier.releasePayload(91, 0);

    const span = await waitForForwardAttemptSpan(sink, traceId);
    const disconnectIndex = span.events.findIndex((event) => event.name === "messages.forward.client_disconnected");
    const terminalIndex = span.events.findIndex((event) => event.name === "messages.forward.terminal");
    assert.ok(disconnectIndex >= 0, "disconnect must be retained as a non-terminal marker");
    assert.ok(terminalIndex > disconnectIndex, "the committed terminal must follow and survive the disconnect marker");
    assert.deepEqual(span.events[terminalIndex]?.attrs, {
      route_family: "message_forward",
      phase: "response",
      outcome: "success",
      http_status: 200,
      status_bucket: "2xx",
      stable_code: "ok",
      error_class: "none",
      commit_state: "committed",
    });
    const stored = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, destination.id));
    assert.equal(stored.length, 1, "the final terminal must match the already committed destination write");
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("POST /messages/forward batches canonical destinations with truthful partial and idempotent retry results", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  const emitted = installFakeIo(app);
  try {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const db = getDb();
    const owner = await seedUser("forward-batch-owner@slock.test", "forward-batch-owner");
    const server = await createServer("Forward Batch Server", "forward-batch-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();

    const source = await createChannel(server.id, "forward-batch-source");
    const destinationA = await createChannel(server.id, "forward-batch-a");
    const destinationB = await createChannel(server.id, "forward-batch-b");
    const deniedDestination = await createChannel(server.id, "forward-batch-denied", undefined, "private");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: destinationA.id, userId: owner.id },
      { channelId: destinationB.id, userId: owner.id },
    ]).onConflictDoNothing();

    const sourceMessage = await createMessage(source.id, "user", owner.id, "batch source snapshot");
    const token = await tokenForHuman(owner.email);
    sink.clear();
    const requestId = "11111111-2222-4333-8444-555555555555";
    const payload = {
      destinationChannelIds: [destinationA.id, destinationB.id, destinationA.id, deniedDestination.id],
      sourceMessageIds: [sourceMessage.id],
      requestId,
      note: "batch note",
    };

    async function send(body: typeof payload) {
      return fetch(`${app.baseUrl}/api/messages/forward`, {
        method: "POST",
        headers: {
          ...authHeaders(token, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    type BatchBody = {
      results: Array<{
        destinationChannelId: string;
        status: "success" | "failed";
        message?: { id: string; channelId: string; actionMetadata: Record<string, unknown> };
        code?: string;
        error?: string;
      }>;
    };
    const first = await send(payload);
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json() as BatchBody;
    assert.deepEqual(firstBody.results.map((result) => result.destinationChannelId), [
      destinationA.id,
      destinationB.id,
      deniedDestination.id,
    ]);
    assert.deepEqual(firstBody.results.map((result) => result.status), ["success", "success", "failed"]);
    assert.equal(firstBody.results[2]?.code, "destination_unavailable");
    assert.equal(firstBody.results[2]?.error, "Could not forward to this target");
    const firstForwardSpan = sink.getAllSpans().find((candidate) => (
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/messages/forward"
    ));
    assert.ok(firstForwardSpan);
    const deniedEvent = firstForwardSpan.events.find((event) => (
      event.name === "messages.forward.destination.failed"
      && event.attrs?.stable_code === "destination_membership_required"
    ));
    assert.ok(deniedEvent, "permission denial must retain a diagnostic-only stable cause");
    assert.equal(deniedEvent.attrs?.phase, "resolve_authorize");
    assert.equal("destinationChannelId" in (deniedEvent.attrs ?? {}), false);
    const firstForwardAttemptSpan = sink.getAllSpans().find((candidate) => (
      candidate.name === "server.message.forward"
      && candidate.context.traceId === firstForwardSpan.context.traceId
    ));
    assert.ok(firstForwardAttemptSpan);
    const partialTerminal = firstForwardAttemptSpan.events.find((event) => event.name === "messages.forward.terminal");
    assert.equal(partialTerminal?.attrs?.outcome, "partial_failure");
    assert.equal(partialTerminal?.attrs?.stable_code, "partial_failure");
    assert.equal(first.headers.get("x-raft-forward-outcome"), "partial_failure");
    assert.equal("_forwardRequestDigest" in (firstBody.results[0]?.message?.actionMetadata ?? {}), false);
    const firstMessageId = firstBody.results[0]?.message?.id;
    assert.ok(firstMessageId);
    const livePayload = emitted.find((event) => (
      event.room === `channel:${destinationA.id}`
      && event.event === "message:new"
      && event.payload?.id === firstMessageId
    ))?.payload as { actionMetadata?: Record<string, unknown> } | undefined;
    assert.ok(livePayload);
    assert.equal("_forwardRequestDigest" in (livePayload.actionMetadata ?? {}), false);

    const history = await fetch(`${app.baseUrl}/api/messages/channel/${destinationA.id}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(history.status, 200);
    const historyMessage = ((await history.json()) as {
      messages: Array<{ id: string; actionMetadata?: Record<string, unknown> }>;
    }).messages.find((message) => message.id === firstMessageId);
    assert.ok(historyMessage);
    assert.equal("_forwardRequestDigest" in (historyMessage.actionMetadata ?? {}), false);

    const [storedForward] = await db
      .select({ actionMetadata: messages.actionMetadata })
      .from(messages)
      .where(eq(messages.id, firstMessageId));
    assert.equal(
      typeof (storedForward?.actionMetadata as Record<string, unknown> | null)?._forwardRequestDigest,
      "string",
      "the replay fingerprint is storage-only",
    );

    await db.insert(channelHumans).values({ channelId: deniedDestination.id, userId: owner.id }).onConflictDoNothing();
    const subsetRetry = await send({
      ...payload,
      destinationChannelIds: [deniedDestination.id],
    });
    assert.equal(subsetRetry.status, 200, await subsetRetry.clone().text());
    const subsetRetryBody = await subsetRetry.json() as BatchBody;
    assert.deepEqual(subsetRetryBody.results.map((result) => result.status), ["success"]);

    const retry = await send(payload);
    assert.equal(retry.status, 200, await retry.clone().text());
    const retryBody = await retry.json() as BatchBody;
    assert.deepEqual(
      retryBody.results.map((result) => result.message?.id),
      [
        ...firstBody.results.slice(0, 2).map((result) => result.message?.id),
        subsetRetryBody.results[0]?.message?.id,
      ],
    );

    const conflicting = await send({ ...payload, note: "different payload" });
    assert.equal(conflicting.status, 200, await conflicting.clone().text());
    const conflictingBody = await conflicting.json() as BatchBody;
    assert.deepEqual(conflictingBody.results.map((result) => result.status), ["failed", "failed", "failed"]);
    assert.deepEqual(conflictingBody.results.map((result) => result.code), [
      "request_conflict",
      "request_conflict",
      "request_conflict",
    ]);

    const missingRequestId = await send({ ...payload, requestId: undefined as unknown as string });
    assert.equal(missingRequestId.status, 400);
    const tooManyDestinations = await send({
      ...payload,
      destinationChannelIds: Array.from(
        { length: 11 },
        (_, index) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`,
      ),
    });
    assert.equal(tooManyDestinations.status, 400);

    const stored = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(and(
        eq(messages.senderId, owner.id),
        inArray(messages.channelId, [destinationA.id, destinationB.id, deniedDestination.id]),
      ));
    assert.equal(stored.length, 3);
  } finally {
    await app.close();
  }
});

test("POST /messages/forward supports thread sources through parent-source-read authority", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("forward-thread-owner@slock.test", "forward-thread-owner");
    const viewer = await seedUser("forward-thread-viewer@slock.test", "forward-thread-viewer");
    const server = await createServer("Forward Thread Server", "forward-thread-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: viewer.id, role: "member" },
    ]).onConflictDoNothing();

    const parentChannel = await createChannel(server.id, "forward-thread-parent");
    const destination = await createChannel(server.id, "forward-thread-destination");
    await db.insert(channelHumans).values([
      { channelId: destination.id, userId: owner.id },
      { channelId: destination.id, userId: viewer.id },
    ]).onConflictDoNothing();

    const parentMessage = await createMessage(parentChannel.id, "user", owner.id, "thread source parent");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const firstReply = await createMessage(thread.id, "user", owner.id, "first thread snapshot");
    const secondReply = await createMessage(thread.id, "user", owner.id, "second thread snapshot");
    // Keep parent first by structure, but prove replies follow their visible
    // timestamps even when insertion/seq order is reversed.
    await db.update(messages).set({ createdAt: new Date("2026-07-17T01:30:00.000Z") }).where(eq(messages.id, parentMessage.id));
    await db.update(messages).set({ createdAt: new Date("2026-07-17T01:20:00.000Z") }).where(eq(messages.id, firstReply.id));
    await db.update(messages).set({ createdAt: new Date("2026-07-17T01:10:00.000Z") }).where(eq(messages.id, secondReply.id));
    const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [secondReply.id, firstReply.id],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      id: string;
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceMessageId: string | null;
          sourceIsThreadParent: boolean;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; type?: string; label: string; labelVisibility: string };
          provenanceState: string;
        }>;
      };
    };
    const [firstItem] = body.actionMetadata.forwardedItems;
    assert.equal(firstItem?.sourceTargetId, thread.id);
    assert.equal(firstItem?.sourceThreadId, thread.id);
    assert.equal(firstItem?.parentChannelId, parentChannel.id);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [secondReply.id, firstReply.id]);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.contentSnapshot), [
      "second thread snapshot",
      "first thread snapshot",
    ]);
    assert.deepEqual(body.actionMetadata.forwardedItems.map((item) => item.sourceIsThreadParent), [false, false]);
    assert.equal(firstItem?.sourceTargetSnapshot.type, "thread");
    assert.equal(firstItem?.sourceTargetSnapshot.label, "#forward-thread-parent");
    assert.equal(firstItem?.sourceTargetSnapshot.labelVisibility, "public");
    assert.equal(firstItem?.provenanceState, "available");

    const parentAndReply = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [firstReply.id, parentMessage.id],
      }),
    });
    assert.equal(parentAndReply.status, 200);
    const parentAndReplyBody = await parentAndReply.json() as {
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceMessageId: string | null;
          sourceIsThreadParent: boolean;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; type?: string; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.deepEqual(parentAndReplyBody.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [
      parentMessage.id,
      firstReply.id,
    ]);
    assert.deepEqual(parentAndReplyBody.actionMetadata.forwardedItems.map((item) => item.contentSnapshot), [
      "thread source parent",
      "first thread snapshot",
    ]);
    assert.deepEqual(parentAndReplyBody.actionMetadata.forwardedItems.map((item) => item.sourceIsThreadParent), [true, false]);
    for (const item of parentAndReplyBody.actionMetadata.forwardedItems) {
      assert.equal(item.sourceTargetId, thread.id);
      assert.equal(item.sourceThreadId, thread.id);
      assert.equal(item.parentChannelId, parentChannel.id);
      assert.equal(item.sourceTargetSnapshot.type, "thread");
      assert.equal(item.sourceTargetSnapshot.label, "#forward-thread-parent");
      assert.equal(item.sourceTargetSnapshot.labelVisibility, "public");
    }

    const viewerToken = await tokenForHuman(viewer.email);
    const visibleToParentReader = await fetch(`${app.baseUrl}/api/messages/channel/${destination.id}`, {
      headers: authHeaders(viewerToken, server.id),
    });
    assert.equal(visibleToParentReader.status, 200);
    const listed = ((await visibleToParentReader.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          forwardedItems?: Array<{
            sourceTargetId: string | null;
            sourceThreadId?: string | null;
            parentChannelId?: string | null;
            sourceMessageId?: string | null;
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === body.id);
    assert.equal(listed?.actionMetadata?.forwardedItems?.[0]?.sourceTargetId, thread.id);
    assert.equal(listed?.actionMetadata?.forwardedItems?.[0]?.sourceThreadId, thread.id);
    assert.equal(listed?.actionMetadata?.forwardedItems?.[0]?.parentChannelId, parentChannel.id);
    assert.equal(listed?.actionMetadata?.forwardedItems?.[0]?.sourceMessageId, secondReply.id);
    assert.equal(listed?.actionMetadata?.forwardedItems?.[0]?.provenanceState, "available");

    const parentAndReplies = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [secondReply.id, parentMessage.id, firstReply.id],
      }),
    });
    assert.equal(parentAndReplies.status, 200);
    const parentAndRepliesBody = await parentAndReplies.json() as {
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceMessageId: string | null;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; type?: string; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.deepEqual(parentAndRepliesBody.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [
      parentMessage.id,
      secondReply.id,
      firstReply.id,
    ]);
    assert.deepEqual(parentAndRepliesBody.actionMetadata.forwardedItems.map((item) => item.contentSnapshot), [
      "thread source parent",
      "second thread snapshot",
      "first thread snapshot",
    ]);
    assert.ok(parentAndRepliesBody.actionMetadata.forwardedItems.every((item) => item.sourceTargetId === thread.id));
    assert.ok(parentAndRepliesBody.actionMetadata.forwardedItems.every((item) => item.sourceThreadId === thread.id));
    assert.ok(parentAndRepliesBody.actionMetadata.forwardedItems.every((item) => item.parentChannelId === parentChannel.id));
    assert.equal(parentAndRepliesBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.type, "thread");
    assert.equal(parentAndRepliesBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "#forward-thread-parent");
    assert.equal(parentAndRepliesBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.labelVisibility, "public");

    const parentOnly = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [parentMessage.id],
      }),
    });
    assert.equal(parentOnly.status, 200);
    const parentOnlyBody = await parentOnly.json() as {
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceMessageId: string | null;
          contentSnapshot: string;
          sourceTargetSnapshot: { type?: string; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems.length, 1);
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.sourceMessageId, parentMessage.id);
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.contentSnapshot, "thread source parent");
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.sourceTargetId, parentChannel.id);
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.sourceThreadId, undefined);
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.parentChannelId, undefined);
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.type, "channel");
    assert.equal(parentOnlyBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "#forward-thread-parent");

    const unrelatedParentChannelMessage = await createMessage(parentChannel.id, "user", owner.id, "unrelated parent-channel body");
    const parentAndSibling = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [unrelatedParentChannelMessage.id, parentMessage.id],
      }),
    });
    assert.equal(parentAndSibling.status, 200);
    const parentAndSiblingBody = await parentAndSibling.json() as {
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceMessageId: string | null;
          sourceTargetSnapshot: { type?: string; label: string };
        }>;
      };
    };
    assert.deepEqual(parentAndSiblingBody.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [
      parentMessage.id,
      unrelatedParentChannelMessage.id,
    ]);
    for (const item of parentAndSiblingBody.actionMetadata.forwardedItems) {
      assert.equal(item.sourceTargetId, parentChannel.id);
      assert.equal(item.sourceThreadId, undefined);
      assert.equal(item.parentChannelId, undefined);
      assert.equal(item.sourceTargetSnapshot.type, "channel");
      assert.equal(item.sourceTargetSnapshot.label, "#forward-thread-parent");
    }

    const mixedUnrelated = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [unrelatedParentChannelMessage.id, firstReply.id],
      }),
    });
    assert.equal(mixedUnrelated.status, 400);
    assert.deepEqual(await mixedUnrelated.json(), {
      error: "Forwarded bundles must come from a single source",
      code: "cross_source_bundle",
    });
  } finally {
    await app.close();
  }
});

test("POST /messages/forward scrubs private thread provenance for parent-denied viewers", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("forward-private-thread-owner@slock.test", "forward-private-thread-owner");
    const viewer = await seedUser("forward-private-thread-viewer@slock.test", "forward-private-thread-viewer");
    const server = await createServer("Forward Private Thread Server", "forward-private-thread-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: viewer.id, role: "member" },
    ]).onConflictDoNothing();

    const privateParent = await createChannel(server.id, "forward-private-thread-parent", undefined, "private");
    const destination = await createChannel(server.id, "forward-private-thread-destination");
    await db.insert(channelHumans).values([
      { channelId: privateParent.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
      { channelId: destination.id, userId: viewer.id },
    ]).onConflictDoNothing();

    const parentMessage = await createMessage(privateParent.id, "user", owner.id, "private thread parent");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const threadReply = await createMessage(thread.id, "user", owner.id, "private thread body");
    const ownerToken = await tokenForHuman(owner.email);

    const created = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [threadReply.id],
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json() as {
      id: string;
      actionMetadata: {
        forwardedItems: Array<{
          sourceTargetId: string | null;
          sourceThreadId?: string | null;
          parentChannelId?: string | null;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
        }>;
      };
    };
    const ownerItem = createdBody.actionMetadata.forwardedItems[0]!;
    assert.equal(ownerItem.sourceTargetId, null);
    assert.equal(ownerItem.sourceThreadId, undefined);
    assert.equal(ownerItem.parentChannelId, undefined);
    assert.equal(ownerItem.sourceTargetSnapshot.label, "");

    const viewerToken = await tokenForHuman(viewer.email);
    const viewerList = await fetch(`${app.baseUrl}/api/messages/channel/${destination.id}`, {
      headers: authHeaders(viewerToken, server.id),
    });
    assert.equal(viewerList.status, 200);
    const viewerForward = ((await viewerList.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          forwardedItems?: Array<{
            sourceServerId: string | null;
            sourceTargetId: string | null;
            sourceThreadId?: string | null;
            parentChannelId?: string | null;
            sourceMessageId: string | null;
            sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === createdBody.id);
    const viewerItem = viewerForward?.actionMetadata?.forwardedItems?.[0];
    assert.equal(viewerItem?.sourceServerId, null);
    assert.equal(viewerItem?.sourceTargetId, null);
    assert.equal(viewerItem?.sourceThreadId, null);
    assert.equal(viewerItem?.parentChannelId, null);
    assert.equal(viewerItem?.sourceMessageId, null);
    assert.equal(viewerItem?.sourceTargetSnapshot.id, null);
    assert.equal(viewerItem?.sourceTargetSnapshot.label, "");
    assert.equal(viewerItem?.sourceTargetSnapshot.labelVisibility, "restricted");
    assert.equal(viewerItem?.provenanceState, "original_unavailable");
  } finally {
    await app.close();
  }
});

test("POST /messages/forward requires source read authority and degrades private provenance", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("forward-private-owner@slock.test", "forward-private-owner");
    const viewer = await seedUser("forward-private-viewer@slock.test", "forward-private-viewer");
    const server = await createServer("Forward Private Server", "forward-private-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: viewer.id, role: "member" },
    ]).onConflictDoNothing();

    const privateSource = await createChannel(server.id, "private-forward-source", undefined, "private");
    const destination = await createChannel(server.id, "private-forward-destination");
    await db.insert(channelHumans).values([
      { channelId: privateSource.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
      { channelId: destination.id, userId: viewer.id },
    ]).onConflictDoNothing();
    const sourceMessage = await createMessage(privateSource.id, "user", owner.id, "private source body");
    const [privateObject] = await db.insert(attachmentObjects).values({
      originServerId: server.id,
      uploaderId: owner.id,
      uploaderType: "user",
      storageKey: `private-forward/${randomUUID()}.txt`,
      mimeType: "text/plain",
      sizeBytes: 24,
    }).returning();
    const [privateSourceProjection] = await db.insert(attachments).values({
      objectId: privateObject.id,
      messageId: sourceMessage.id,
      channelId: privateSource.id,
      createdById: owner.id,
      createdByType: "user",
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "private-source.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      storageKey: privateObject.storageKey,
    }).returning();

    const viewerToken = await tokenForHuman(viewer.email);
    const forged = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(viewerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
      }),
    });
    assert.equal(forged.status, 404);

    const ownerToken = await tokenForHuman(owner.email);
    const created = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: [sourceMessage.id],
      }),
    });
    assert.equal(created.status, 200);
    const forward = await created.json() as {
      actionMetadata: {
        forwardedItems: Array<{
          contentSnapshot: string;
          sourceAuthorSnapshot: { uniqueName: string };
          sourceMessageId: string | null;
          sourceMessageSeq: number | null;
          sourceServerId: string | null;
          sourceTargetId: string | null;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
          attachmentSnapshots: Array<{ id: string; filename: string }>;
        }>;
      };
    };
    const item = forward.actionMetadata.forwardedItems[0]!;
    assert.equal(item.contentSnapshot, "private source body");
    assert.equal(item.sourceAuthorSnapshot.uniqueName, owner.name);
    assert.equal(item.sourceMessageId, null);
    assert.equal(item.sourceMessageSeq, null);
    assert.equal(item.sourceServerId, null);
    assert.equal(item.sourceTargetId, null);
    assert.equal(item.sourceTargetSnapshot.label, "");
    assert.equal(item.sourceTargetSnapshot.id, null);
    assert.equal(item.sourceTargetSnapshot.labelVisibility, "restricted");
    const destinationProjectionId = item.attachmentSnapshots[0]?.id;
    assert.ok(destinationProjectionId);
    assert.notEqual(destinationProjectionId, privateSourceProjection.id);

    const destinationAttachmentAsViewer = await fetch(
      `${app.baseUrl}/api/attachments/${destinationProjectionId}/url`,
      { headers: authHeaders(viewerToken, server.id) },
    );
    assert.equal(destinationAttachmentAsViewer.status, 200, "destination authority must not depend on private source membership");
    const sourceAttachmentAsViewer = await fetch(
      `${app.baseUrl}/api/attachments/${privateSourceProjection.id}/url`,
      { headers: authHeaders(viewerToken, server.id) },
    );
    assert.equal(sourceAttachmentAsViewer.status, 404, "source attachment URL read cloaks private projection existence");

    const originalUrl = new URL(`${app.baseUrl}/api/messages/context/${sourceMessage.id}`);
    originalUrl.searchParams.set("channelId", privateSource.id);
    const originalAsViewer = await fetch(originalUrl, {
      headers: authHeaders(viewerToken, server.id),
    });
    assert.equal(originalAsViewer.status, 404);
  } finally {
    await app.close();
  }
});

test("POST /messages/forward rejects short source ids before server-wide message resolution", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("forward-short-owner@slock.test", "forward-short-owner");
    const viewer = await seedUser("forward-short-viewer@slock.test", "forward-short-viewer");
    const server = await createServer("Forward Short Server", "forward-short-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: viewer.id, role: "member" },
    ]).onConflictDoNothing();

    const privateSource = await createChannel(server.id, "forward-short-private", undefined, "private");
    const destination = await createChannel(server.id, "forward-short-destination");
    await db.insert(channelHumans).values([
      { channelId: privateSource.id, userId: owner.id },
      { channelId: destination.id, userId: viewer.id },
    ]).onConflictDoNothing();
    await db.insert(messages).values([
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        channelId: privateSource.id,
        senderType: "user",
        senderId: owner.id,
        content: "hidden ambiguous private one",
      },
      {
        id: "aaaaaaaa-2222-4222-8222-222222222222",
        channelId: privateSource.id,
        senderType: "user",
        senderId: owner.id,
        content: "hidden ambiguous private two",
      },
    ]);

    const viewerToken = await tokenForHuman(viewer.email);
    const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(viewerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: destination.id,
        sourceMessageIds: ["aaaaaaaa"],
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string; code?: string };
    assert.equal(body.error, "Destination channel and full source message ids are required");
    assert.notEqual(body.error, "Message short id is ambiguous");
    assert.notEqual(body.code, "source_not_found");
  } finally {
    await app.close();
  }
});

test("POST /messages/forward supports joint destinations and restricted joint sources", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("forward-joint-owner@slock.test", "forward-joint-owner");
    const dmPeer = await seedUser("forward-joint-dm-peer@slock.test", "forward-joint-dm-peer");
    const guestOwner = await seedUser("forward-joint-guest@slock.test", "forward-joint-guest");
    const server = await createServer("Forward Joint Host", "forward-joint-host", owner.id);
    const guestServer = await createServer("Forward Joint Guest", "forward-joint-guest", guestOwner.id);
    const storageServer = await createServer("Forward Joint Storage", "forward-joint-storage", owner.id);
    await db.update(serversTable).set({ plan: "founder" }).where(inArray(serversTable.id, [server.id, guestServer.id]));
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: dmPeer.id, role: "member" },
      { serverId: guestServer.id, userId: guestOwner.id, role: "owner" },
      { serverId: guestServer.id, userId: owner.id, role: "member" },
    ]).onConflictDoNothing();

    const source = await createChannel(server.id, "forward-joint-source");
    const privateSource = await createChannel(server.id, "forward-joint-private-source", undefined, "private");
    const regularDestination = await createChannel(server.id, "forward-joint-regular-destination");
    const privateDestination = await createChannel(server.id, "forward-joint-private-destination", undefined, "private");
    const dmDestination = await findOrCreateUserDM(server.id, owner.id, dmPeer.id);
    assert.ok(dmDestination);
    const guestRegularDestination = await createChannel(guestServer.id, "forward-joint-guest-regular-destination");
    const canonicalJointChannel = await createChannel(storageServer.id, "forward-joint-storage");
    const hostProjection = await createChannel(server.id, "forward-joint-room", undefined, "joint");
    const guestProjection = await createChannel(guestServer.id, "forward-joint-room", undefined, "joint");
    await db.insert(channelHumans).values([
      { channelId: source.id, userId: owner.id },
      { channelId: privateSource.id, userId: owner.id },
      { channelId: regularDestination.id, userId: owner.id },
      { channelId: privateDestination.id, userId: owner.id },
      { channelId: guestRegularDestination.id, userId: guestOwner.id },
      { channelId: hostProjection.id, userId: owner.id },
      { channelId: guestProjection.id, userId: guestOwner.id },
      { channelId: guestProjection.id, userId: owner.id },
    ]).onConflictDoNothing();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalJointChannel.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: joint.id,
        serverId: server.id,
        localChannelId: hostProjection.id,
        role: "host",
        joinedByUserId: owner.id,
      },
      {
        jointChannelId: joint.id,
        serverId: guestServer.id,
        localChannelId: guestProjection.id,
        role: "participant",
        joinedByUserId: guestOwner.id,
      },
    ]);

    const sourceMessage = await createMessage(source.id, "user", owner.id, "public source into joint");
    const privateSourceMessage = await createMessage(privateSource.id, "user", owner.id, "private source into joint");
    const dmSourceMessage = await createMessage(dmDestination.id, "user", owner.id, "dm source stays restricted");
    const jointSourceMessage = await createMessage(canonicalJointChannel.id, "user", owner.id, "joint source stays restricted");
    const token = await tokenForHuman(owner.email);
    const guestToken = await tokenForHuman(guestOwner.email);

    const toJoint = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: hostProjection.id,
        sourceMessageIds: [sourceMessage.id],
      }),
    });
    assert.equal(toJoint.status, 200);
    const toJointBody = await toJoint.json() as {
      id: string;
      channelId: string;
      actionMetadata: {
        destinationTargetId: string;
        forwardedItems: Array<{
          sourceMessageId: string | null;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.equal(toJointBody.channelId, hostProjection.id);
    assert.equal(toJointBody.actionMetadata.destinationTargetId, hostProjection.id);
    assert.deepEqual(toJointBody.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [sourceMessage.id]);
    assert.equal(toJointBody.actionMetadata.forwardedItems[0]?.contentSnapshot, "public source into joint");
    assert.equal(toJointBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "#forward-joint-source");
    assert.equal(toJointBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.labelVisibility, "public");

    const privateToJoint = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: hostProjection.id,
        sourceMessageIds: [privateSourceMessage.id],
      }),
    });
    assert.equal(privateToJoint.status, 200);
    const privateToJointBody = await privateToJoint.json() as {
      id: string;
      actionMetadata: {
        forwardedItems: Array<{
          sourceMessageId: string;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.deepEqual(privateToJointBody.actionMetadata.forwardedItems.map((item) => item.sourceMessageId), [null]);
    assert.equal(privateToJointBody.actionMetadata.forwardedItems[0]?.contentSnapshot, "private source into joint");
    assert.equal(privateToJointBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.label, "");
    assert.equal(privateToJointBody.actionMetadata.forwardedItems[0]?.sourceTargetSnapshot.id, null);

    const hostList = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(hostList.status, 200);
    const hostListedForward = ((await hostList.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          kind?: string;
          forwardedItems?: Array<{
            sourceTargetId: string | null;
            sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === toJointBody.id);
    assert.equal(hostListedForward?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.label, "#forward-joint-source");
    assert.equal(hostListedForward?.actionMetadata?.forwardedItems?.[0]?.sourceTargetId, source.id);
    assert.equal(hostListedForward?.actionMetadata?.forwardedItems?.[0]?.provenanceState, "available");

    const guestList = await fetch(`${app.baseUrl}/api/messages/channel/${guestProjection.id}`, {
      headers: authHeaders(guestToken, guestServer.id),
    });
    assert.equal(guestList.status, 200);
    const guestMessages = ((await guestList.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          kind?: string;
          forwardedItems?: Array<{
            contentSnapshot: string;
            sourceTargetId: string | null;
            sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages;
    const guestListedForward = guestMessages.find((message) => message.id === toJointBody.id);
    const guestListedPrivateForward = guestMessages.find((message) => message.id === privateToJointBody.id);
    const guestPublicItem = guestListedForward?.actionMetadata?.forwardedItems?.[0];
    const guestPrivateItem = guestListedPrivateForward?.actionMetadata?.forwardedItems?.[0];
    assert.equal(guestPublicItem?.contentSnapshot, "public source into joint");
    assert.equal(guestPublicItem?.sourceTargetId, null);
    assert.equal(guestPublicItem?.sourceTargetSnapshot.id, null);
    assert.equal(guestPublicItem?.sourceTargetSnapshot.label, "");
    assert.equal(guestPublicItem?.sourceTargetSnapshot.labelVisibility, "restricted");
    assert.equal(guestPublicItem?.provenanceState, "original_unavailable");
    assert.equal(guestPrivateItem?.contentSnapshot, "private source into joint");
    assert.equal(guestPrivateItem?.sourceTargetId, null);
    assert.equal(guestPrivateItem?.sourceTargetSnapshot.label, "");
    assert.equal(guestPrivateItem?.provenanceState, "original_unavailable");

    const sameUserGuestList = await fetch(`${app.baseUrl}/api/messages/channel/${guestProjection.id}`, {
      headers: authHeaders(token, guestServer.id),
    });
    assert.equal(sameUserGuestList.status, 200);
    const sameUserGuestMessage = ((await sameUserGuestList.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          forwardedItems?: Array<{
            sourceServerId: string | null;
            sourceTargetId: string | null;
            sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === toJointBody.id);
    const sameUserGuestItem = sameUserGuestMessage?.actionMetadata?.forwardedItems?.[0];
    assert.equal(sameUserGuestItem?.sourceServerId, null);
    assert.equal(sameUserGuestItem?.sourceTargetId, null);
    assert.equal(sameUserGuestItem?.sourceTargetSnapshot.id, null);
    assert.equal(sameUserGuestItem?.sourceTargetSnapshot.label, "");
    assert.equal(sameUserGuestItem?.sourceTargetSnapshot.labelVisibility, "restricted");
    assert.equal(sameUserGuestItem?.provenanceState, "original_unavailable");

    const guestContext = await fetch(`${app.baseUrl}/api/messages/context/${toJointBody.id}?channelId=${guestProjection.id}`, {
      headers: authHeaders(guestToken, guestServer.id),
    });
    assert.equal(guestContext.status, 200);
    const guestContextTarget = ((await guestContext.json()) as {
      targetMessageId: string;
      messages: Array<{
        id: string;
        actionMetadata?: {
          forwardedItems?: Array<{
            sourceTargetId: string | null;
            sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
            provenanceState: string;
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === toJointBody.id);
    assert.equal(guestContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetId, null);
    assert.equal(guestContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.label, "");
    assert.equal(guestContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.labelVisibility, "restricted");
    assert.equal(guestContextTarget?.actionMetadata?.forwardedItems?.[0]?.provenanceState, "original_unavailable");

    const sameUserGuestContext = await fetch(
      `${app.baseUrl}/api/messages/context/${toJointBody.id}?channelId=${guestProjection.id}`,
      { headers: authHeaders(token, guestServer.id) },
    );
    assert.equal(sameUserGuestContext.status, 200);
    const sameUserContextTarget = ((await sameUserGuestContext.json()) as {
      messages: Array<{
        id: string;
        actionMetadata?: {
          forwardedItems?: Array<{
            sourceServerId: string | null;
            sourceTargetSnapshot: { label: string; labelVisibility: string };
          }>;
        } | null;
      }>;
    }).messages.find((message) => message.id === toJointBody.id);
    assert.equal(sameUserContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceServerId, null);
    assert.equal(sameUserContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.label, "");
    assert.equal(sameUserContextTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.labelVisibility, "restricted");

    const sameUserGuestSync = await fetch(
      `${app.baseUrl}/api/messages/sync?since_seq=0&channel_id=${guestProjection.id}`,
      { headers: authHeaders(token, guestServer.id) },
    );
    assert.equal(sameUserGuestSync.status, 200);
    const sameUserSyncTarget = ((await sameUserGuestSync.json()) as Array<{
      id: string;
      actionMetadata?: {
        forwardedItems?: Array<{
          sourceServerId: string | null;
          sourceTargetSnapshot: { label: string; labelVisibility: string };
        }>;
      } | null;
    }>).find((message) => message.id === toJointBody.id);
    assert.equal(sameUserSyncTarget?.actionMetadata?.forwardedItems?.[0]?.sourceServerId, null);
    assert.equal(sameUserSyncTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.label, "");
    assert.equal(sameUserSyncTarget?.actionMetadata?.forwardedItems?.[0]?.sourceTargetSnapshot.labelVisibility, "restricted");

    const fromJoint = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: regularDestination.id,
        sourceMessageIds: [jointSourceMessage.id],
      }),
    });
    assert.equal(fromJoint.status, 200);
    const fromJointBody = await fromJoint.json() as {
      channelId: string;
      actionMetadata: {
        forwardedItems: Array<{
          sourceServerId: string | null;
          sourceTargetId: string | null;
          sourceMessageId: string | null;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; type?: string; label: string; labelVisibility: string };
          provenanceState: string;
        }>;
      };
    };
    assert.equal(fromJointBody.channelId, regularDestination.id);
    const fromJointItem = fromJointBody.actionMetadata.forwardedItems[0];
    assert.equal(fromJointItem?.contentSnapshot, "joint source stays restricted");
    assert.equal(fromJointItem?.sourceServerId, null);
    assert.equal(fromJointItem?.sourceTargetId, null);
    assert.equal(fromJointItem?.sourceMessageId, null);
    assert.equal(fromJointItem?.sourceTargetSnapshot.type, "joint");
    assert.equal(fromJointItem?.sourceTargetSnapshot.id, null);
    assert.equal(fromJointItem?.sourceTargetSnapshot.label, "");
    assert.equal(fromJointItem?.sourceTargetSnapshot.labelVisibility, "restricted");
    assert.equal(fromJointItem?.provenanceState, "available");

    const guestFromJoint = await fetch(`${app.baseUrl}/api/messages/forward`, {
      method: "POST",
      headers: {
        ...authHeaders(guestToken, guestServer.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationChannelId: guestRegularDestination.id,
        sourceMessageIds: [jointSourceMessage.id],
      }),
    });
    assert.equal(guestFromJoint.status, 200);
    const guestFromJointBody = await guestFromJoint.json() as {
      channelId: string;
      actionMetadata: {
        forwardedItems: Array<{
          sourceServerId: string | null;
          sourceTargetId: string | null;
          sourceMessageId: string | null;
          contentSnapshot: string;
          sourceTargetSnapshot: { id: string | null; type?: string; label: string; labelVisibility: string };
        }>;
      };
    };
    assert.equal(guestFromJointBody.channelId, guestRegularDestination.id);
    const guestFromJointItem = guestFromJointBody.actionMetadata.forwardedItems[0];
    assert.equal(guestFromJointItem?.contentSnapshot, "joint source stays restricted");
    assert.equal(guestFromJointItem?.sourceServerId, null);
    assert.equal(guestFromJointItem?.sourceTargetId, null);
    assert.equal(guestFromJointItem?.sourceMessageId, null);
    assert.equal(guestFromJointItem?.sourceTargetSnapshot.type, "joint");
    assert.equal(guestFromJointItem?.sourceTargetSnapshot.id, null);
    assert.equal(guestFromJointItem?.sourceTargetSnapshot.label, "");
    assert.equal(guestFromJointItem?.sourceTargetSnapshot.labelVisibility, "restricted");

    const matrixSources = [
      { type: "channel", message: sourceMessage, content: "public source into joint", visibility: "public" },
      { type: "private", message: privateSourceMessage, content: "private source into joint", visibility: "restricted" },
      { type: "dm", message: dmSourceMessage, content: "dm source stays restricted", visibility: "restricted" },
      { type: "joint", message: jointSourceMessage, content: "joint source stays restricted", visibility: "restricted" },
    ] as const;
    const matrixDestinations = [
      { type: "channel", channel: regularDestination },
      { type: "private", channel: privateDestination },
      { type: "dm", channel: dmDestination },
      { type: "joint", channel: hostProjection },
    ] as const;
    const acceptedCells: string[] = [];
    for (const matrixSource of matrixSources) {
      for (const matrixDestination of matrixDestinations) {
        const matrixForward = await fetch(`${app.baseUrl}/api/messages/forward`, {
          method: "POST",
          headers: {
            ...authHeaders(token, server.id),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            destinationChannelId: matrixDestination.channel.id,
            sourceMessageIds: [matrixSource.message.id],
          }),
        });
        assert.equal(
          matrixForward.status,
          200,
          `${matrixSource.type} -> ${matrixDestination.type}: ${await matrixForward.clone().text()}`,
        );
        const matrixBody = await matrixForward.json() as {
          channelId: string;
          actionMetadata: {
            destinationTargetId: string;
            forwardedItems: Array<{
              contentSnapshot: string;
              sourceTargetSnapshot: { type: string; label: string; labelVisibility: string };
            }>;
          };
        };
        const matrixItem = matrixBody.actionMetadata.forwardedItems[0];
        assert.equal(matrixBody.channelId, matrixDestination.channel.id);
        assert.equal(matrixBody.actionMetadata.destinationTargetId, matrixDestination.channel.id);
        assert.equal(matrixItem?.contentSnapshot, matrixSource.content);
        assert.equal(matrixItem?.sourceTargetSnapshot.type, matrixSource.type);
        assert.equal(matrixItem?.sourceTargetSnapshot.labelVisibility, matrixSource.visibility);
        assert.equal(
          matrixItem?.sourceTargetSnapshot.label,
          matrixSource.visibility === "public" ? "#forward-joint-source" : "",
        );
        acceptedCells.push(`${matrixSource.type}->${matrixDestination.type}`);
      }
    }
    assert.deepEqual(acceptedCells, [
      "channel->channel", "channel->private", "channel->dm", "channel->joint",
      "private->channel", "private->private", "private->dm", "private->joint",
      "dm->channel", "dm->private", "dm->dm", "dm->joint",
      "joint->channel", "joint->private", "joint->dm", "joint->joint",
    ]);
  } finally {
    await app.close();
  }
});

test("POST /messages/forward rejects cross-source and non-ordinary source messages", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  const emitted = installFakeIo(app);
  try {
    const db = getDb();
    const owner = await seedUser("forward-reject-owner@slock.test", "forward-reject-owner");
    const server = await createServer("Forward Reject Server", "forward-reject-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();

    const sourceA = await createChannel(server.id, "forward-reject-source-a");
    const sourceB = await createChannel(server.id, "forward-reject-source-b");
    const destination = await createChannel(server.id, "forward-reject-destination");
    await db.insert(channelHumans).values([
      { channelId: sourceA.id, userId: owner.id },
      { channelId: sourceB.id, userId: owner.id },
      { channelId: destination.id, userId: owner.id },
    ]).onConflictDoNothing();
    const recipientAgent = await createAgent(server.id, "forward-task-recipient");
    await db.insert(channelAgents).values({ channelId: destination.id, agentId: recipientAgent.id }).onConflictDoNothing();
    const agentDeliveries: Array<{ agentId: string; message: Record<string, unknown> & { content: string; message_id?: string } }> = [];
    const agentOrchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (
        agentId: string,
        message: Record<string, unknown> & { content: string; message_id?: string },
      ) => Promise<{ status: "queued"; reason: "replayable_inbox" }>;
    };
    agentOrchestrator.deliverMessage = async (agentId, message) => {
      agentDeliveries.push({ agentId, message });
      return { status: "queued", reason: "replayable_inbox" };
    };

    const a = await createMessage(sourceA.id, "user", owner.id, "source a");
    const b = await createMessage(sourceB.id, "user", owner.id, "source b");
    const system = await createMessage(sourceA.id, "user", "system", "system source", "system");
    const task = await createMessage(sourceA.id, "user", owner.id, "task source", "chat", { taskStatus: "todo", taskNumber: 1 });
    const taskClaimedAt = new Date("2026-07-16T01:00:00.000Z");
    const taskCompletedAt = new Date("2026-07-16T02:00:00.000Z");
    await db.update(messages).set({
      taskStatus: "done",
      taskAssigneeType: "agent",
      taskAssigneeId: recipientAgent.id,
      taskClaimedAt,
      taskCompletedAt,
    }).where(eq(messages.id, task.id));
    const action = await createMessage(sourceA.id, "user", owner.id, "action source", "chat", undefined, { actionMetadata: { kind: "action-card" } });
    const forwarded = await createMessage(sourceA.id, "user", owner.id, "forwarded source", "chat", undefined, { actionMetadata: { kind: "forwarded-bundle", forwardedItems: [] } });
    const token = await tokenForHuman(owner.email);

    async function forward(sourceMessageIds: string[]) {
      return fetch(`${app.baseUrl}/api/messages/forward`, {
        method: "POST",
        headers: {
          ...authHeaders(token, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ destinationChannelId: destination.id, sourceMessageIds }),
      });
    }

    const crossSource = await forward([a.id, b.id]);
    assert.equal(crossSource.status, 400);
    assert.equal((await crossSource.json() as { code: string }).code, "cross_source_bundle");

    const taskForward = await forward([task.id]);
    assert.equal(taskForward.status, 200, await taskForward.clone().text());
    const taskForwardBody = await taskForward.json() as Record<string, unknown> & {
      id: string;
      messageType: string;
      actionMetadata: { forwardedItems: Array<{ contentSnapshot: string }> };
    };
    assert.equal(taskForwardBody.messageType, "chat");
    assert.equal(taskForwardBody.actionMetadata.forwardedItems[0]?.contentSnapshot, "task source");
    const taskProjectionFields = ["taskStatus", "taskNumber", "taskAssigneeType", "taskAssigneeId", "taskClaimedAt", "taskCompletedAt"];
    for (const field of taskProjectionFields) {
      assert.equal(field in taskForwardBody, false, `forward destination exposed ${field}`);
    }
    const [storedTaskForward] = await db
      .select({
        messageType: messages.messageType,
        taskStatus: messages.taskStatus,
        taskNumber: messages.taskNumber,
        taskAssigneeType: messages.taskAssigneeType,
        taskAssigneeId: messages.taskAssigneeId,
        taskClaimedAt: messages.taskClaimedAt,
        taskCompletedAt: messages.taskCompletedAt,
      })
      .from(messages)
      .where(eq(messages.id, taskForwardBody.id));
    assert.deepEqual(storedTaskForward, {
      messageType: "chat",
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
    });

    const socketPayload = emitted.find((event) => (
      event.room === `channel:${destination.id}`
      && event.event === "message:new"
      && event.payload?.id === taskForwardBody.id
    ))?.payload as Record<string, unknown> | undefined;
    assert.ok(socketPayload, "forward destination must emit a live message payload");
    for (const field of taskProjectionFields) {
      assert.equal(field in socketPayload, false, `forward live payload exposed ${field}`);
    }

    const history = await fetch(`${app.baseUrl}/api/messages/channel/${destination.id}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(history.status, 200);
    const historyMessage = ((await history.json()) as { messages: Array<Record<string, unknown> & { id: string }> })
      .messages.find((message) => message.id === taskForwardBody.id);
    assert.ok(historyMessage);
    for (const field of taskProjectionFields) {
      assert.equal(field in historyMessage, false, `forward history payload exposed ${field}`);
    }

    const context = await fetch(`${app.baseUrl}/api/messages/context/${taskForwardBody.id}?channelId=${destination.id}`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(context.status, 200);
    const contextMessage = ((await context.json()) as { messages: Array<Record<string, unknown> & { id: string }> })
      .messages.find((message) => message.id === taskForwardBody.id);
    assert.ok(contextMessage);
    for (const field of taskProjectionFields) {
      assert.equal(field in contextMessage, false, `forward context payload exposed ${field}`);
    }

    const agentDelivery = agentDeliveries.find((delivery) => delivery.message.message_id === taskForwardBody.id);
    assert.ok(agentDelivery, "forward destination must deliver to joined agents");
    assert.match(agentDelivery.message.content, /task source/);
    for (const field of ["task_status", "task_number", "task_assignee_type", "task_assignee_id"]) {
      assert.equal(field in agentDelivery.message, false, `forward agent delivery exposed ${field}`);
    }

    for (const sourceMessage of [system, action]) {
      const rejected = await forward([sourceMessage.id]);
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { code: string }).code, "unsupported_source_message");
    }

    const nested = await forward([forwarded.id]);
    assert.equal(nested.status, 400);
    assert.deepEqual(await nested.json(), {
      error: "Forwarded messages can't be forwarded. Select the original message instead.",
      code: "forwarded_source_not_supported",
    });
  } finally {
    await app.close();
  }
});

test("GET /messages/forward/targets/search returns channels, DMs, agents, and humans", async ({ app }) => {

  setMessageForwardingEnabledForApp(app.app, true);
  try {
    const db = getDb();
    const owner = await seedUser("fwd-search-owner@slock.test", "fwd-search-owner");
    const otherHuman = await seedUser("fwd-search-other@slock.test", "fwd-search-other");
    const server = await createServer("Fwd Search Server", "fwd-search-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: owner.id, role: "owner" },
      { serverId: server.id, userId: otherHuman.id, role: "member" },
    ]).onConflictDoNothing();

    const publicChannel = await createChannel(server.id, "search-public");
    const joinedChannel = await createChannel(server.id, "search-joined");
    const joinedPrivate = await createChannel(server.id, "search-private-visible", undefined, "private");
    await createChannel(server.id, "search-private-hidden", undefined, "private");
    await addHuman(joinedChannel.id, owner.id);
    await addHuman(joinedPrivate.id, owner.id);

    const agent = await createAgent(server.id, "search-agent");
    await findOrCreateDM(server.id, owner.id, agent.id);

    const token = await tokenForHuman(owner.email);

    const noQuery = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(noQuery.status, 200);
    const noQueryBody = await noQuery.json() as { targets: Array<{ type: string }> };
    assert.equal(noQueryBody.targets.length, 0);

    const searchPublic = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=search-public`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(searchPublic.status, 200);
    const publicBody = await searchPublic.json() as { targets: Array<{ type: string; channelType: string | null; title: string; canForwardNow: boolean; requiredAction: string | null; joined: boolean | null }> };
    const pubResult = publicBody.targets.find((t) => t.title === "#search-public");
    assert.ok(pubResult);
    assert.equal(pubResult.type, "channel");
    assert.equal(pubResult.channelType, "channel");
    assert.equal(pubResult.canForwardNow, false);
    assert.equal(pubResult.requiredAction, "join_channel");
    assert.equal(pubResult.joined, false);

    const searchJoined = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=search-joined`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(searchJoined.status, 200);
    const joinedBody = await searchJoined.json() as { targets: Array<{ type: string; title: string; canForwardNow: boolean; joined: boolean | null }> };
    const joinResult = joinedBody.targets.find((t) => t.title === "#search-joined");
    assert.ok(joinResult);
    assert.equal(joinResult.canForwardNow, true);
    assert.equal(joinResult.joined, true);

    const searchPrivate = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=search-private`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(searchPrivate.status, 200);
    const privateBody = await searchPrivate.json() as { targets: Array<{ channelType: string | null; title: string; canForwardNow: boolean; requiredAction: string | null }> };
    assert.deepEqual(privateBody.targets.map((target) => target.title), ["#search-private-visible"]);
    assert.equal(privateBody.targets[0]?.channelType, "private");
    assert.equal(privateBody.targets[0]?.canForwardNow, true);
    assert.equal(privateBody.targets[0]?.requiredAction, null);

    const searchOther = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=fwd-search-other`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(searchOther.status, 200);
    const otherBody = await searchOther.json() as { targets: Array<{ type: string; title: string; requiredAction: string | null; dmExists: boolean | null }> };
    const humanResult = otherBody.targets.find((t) => t.type === "human");
    assert.ok(humanResult);
    assert.equal(humanResult.requiredAction, "create_dm");
    assert.equal(humanResult.dmExists, false);

    const searchAgent = await fetch(`${app.baseUrl}/api/messages/forward/targets/search?q=search-agent`, {
      headers: authHeaders(token, server.id),
    });
    assert.equal(searchAgent.status, 200);
    const agentBody = await searchAgent.json() as { targets: Array<{ type: string; title: string; dmExists: boolean | null }> };
    const dmResult = agentBody.targets.find((t) => t.type === "dm");
    assert.ok(dmResult);
    assert.equal(dmResult.dmExists, true);
  } finally {
    await app.close();
  }
});
