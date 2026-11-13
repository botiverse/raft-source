import { handlerTraceEvents } from "../test/handlerTraceEvents";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  BasicTracer,
  MemoryTraceSink
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { dbQueryErrorsTotal } from "../metrics";
import { closeRisingWavePool, RisingWaveOverloadedError } from "../db/risingwave";
import { __setStaleReadStoreForTests } from "./rwStaleRead";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import {
  users, servers,
  agents, serverMembers,
  channels,
  channelHumans,
  channelAgents,
  messages, threadFollows, userChannelReadCursors, inboxNotificationFacts,
  inboxSuppressionStates, tasks, featureFlags, agentActivityEvents, messageMentions, notificationOutbox
} from "../db/schema";
import { addMember, removeMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { __testRisingWaveInbox, createChannel, getOrCreateThread, addHuman, addAgent, removeHuman, removeAgent, findOrCreateDM, canAgentReceiveChannelDelivery, deleteChannel, markReadLatest, retireDeletedThreadDoneResidue } from "../services/channelService";
import {
  createMessage
} from "../services/messageService";
import * as taskService from "../services/taskService";
import { registerMachine } from "../services/machineService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createServer, installFakeIo, recordTestInboxFact, seedThreadFixture, headers, channelDoneBody, threadDoneBody, legacyDoneFallbackCount, seedUser, fetchInboxAll } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * The v3 stats tests below mock the pool's query (the v3 read). The active list
 * reads rw_followed_threads_v5 first (through queryRisingWave's pool.connect);
 * stub that read with NO rows, so every followed thread is "missing in v4"
 * (CDC lag) and takes the legacy regular query plus the v3 stats read under test.
 */
// The v4 row read fails, so the request takes the whole legacy path, whose
// stats read is the RisingWave stats backend these tests exercise. (A thread
// merely missing from v4 is left out, not served by the legacy read.)
function stubFollowedThreadsV5Unavailable(): void {
  __testRisingWaveInbox.set({
    query: (async (_pool: unknown, queryText: string) => {
      assert.match(queryText, /FROM rw_followed_threads_v5 v/, "only the v5 read goes through queryRisingWave here");
      throw new Error('relation "rw_followed_threads_v5" does not exist');
    }) as never,
  });
}

function stubFollowedThreadsV5WithNoRows(): void {
  __testRisingWaveInbox.set({
    query: (async (_pool: unknown, queryText: string) => {
      assert.match(queryText, /FROM rw_followed_threads_v5 v/, "only the v5 read goes through queryRisingWave here");
      return { result: { rows: [] }, acquireWaitMs: 0, poolState: { rw_pool_total: 0, rw_pool_idle: 0, rw_pool_waiting: 0 } };
    }) as never,
  });
}


test("thread Agent follower management is authorized, Activity-recorded, reversible, and preserves personal attention", async ({ app }) => {
  const emittedEvents = installFakeIo(app.app);
  const db = getDb();
  const f = await seedThreadFixture(app.baseUrl);
  // Make an ordinary parent-channel member the thread author so this test
  // proves author authority independently from the server-manager path.
  await db.update(messages)
    .set({ senderId: f.memberBId })
    .where(eq(messages.id, f.parentMessageId));
  const rosterUrl = `${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${f.threadId}`;
  const removeUrl = `${app.baseUrl}/api/channels/threads/${f.threadId}/followers/agents/${f.agentBId}`;
  const restoreUrl = `${removeUrl}/restore`;

  let response = await fetch(rosterUrl, { headers: headers(f.followerToken, f.serverId) });
  assert.equal(response.status, 200);
  let roster = await response.json() as {
    threads: Array<{
      threadChannelId: string;
      canManage: boolean;
      agents: Array<{ id: string; name: string }>;
    }>;
  };
  assert.equal(roster.threads.length, 1);
  assert.equal(roster.threads[0]?.threadChannelId, f.threadId);
  assert.equal(roster.threads[0]?.canManage, false, "ordinary thread viewers get a read-only roster");
  assert.deepEqual(roster.threads[0]?.agents.map((agent) => agent.id), [f.agentBId]);

  response = await fetch(removeUrl, {
    method: "DELETE",
    headers: headers(f.followerToken, f.serverId),
  });
  assert.equal(response.status, 403, "ordinary members cannot remove an Agent follower");

  const activityBroadcasts: Array<{
    agentId: string;
    event: {
      title: string;
      text: string;
      producerFactId?: string;
      dedupeKey?: string;
    };
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    recordAgentRaftAction: (
      agentId: string,
      event: { title: string; text: string; producerFactId?: string; dedupeKey?: string },
    ) => Promise<void>;
  };
  agentOrchestrator.recordAgentRaftAction = async (agentId, event) => {
    activityBroadcasts.push({ agentId, event });
  };

  const listFollowerActivity = async () => (await db.select().from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, f.agentBId))
    .orderBy(agentActivityEvents.createdAt))
    .filter((event) => event.dedupeKey?.includes(f.threadId));

  response = await fetch(removeUrl, {
    method: "DELETE",
    headers: headers(f.memberBToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const firstRemoval = await response.json() as {
    removed: boolean;
    undoToken: string | null;
  };
  assert.equal(firstRemoval.removed, true);
  assert.ok(firstRemoval.undoToken);
  const firstRemovalFollowerUpdates = emittedEvents.filter((event) => event.event === "thread:followers-updated");
  assert.deepEqual(
    firstRemovalFollowerUpdates,
    [{
      room: `channel:${f.threadId}`,
      event: "thread:followers-updated",
      payload: { threadChannelId: f.threadId },
    }],
    "non-joint follower changes refresh only the current thread room",
  );

  let activity = await listFollowerActivity();
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.createdAt.toISOString(), firstRemoval.undoToken);
  assert.match(activity[0]?.dedupeKey ?? "", /thread_follower_management:removed:/);
  const removalEntry = activity[0]?.entries.find((entry) => entry.kind === "slock_action");
  assert.equal(removalEntry?.kind, "slock_action");
  if (removalEntry?.kind === "slock_action") {
    assert.equal(removalEntry.title, "Removed from thread followers");
    assert.match(removalEntry.text, new RegExp(`actor: @${f.memberBId === f.ownerId ? "owner" : "member-b"}`, "i"));
    assert.match(removalEntry.text, /ordinary thread updates stopped/i);
    assert.match(removalEntry.text, /personal mentions and task assignments can still notify you/i);
    assert.match(removalEntry.text, /follow the thread again/i);
    assert.equal(removalEntry.producerFactId, activity[0]?.id);
  }
  assert.equal(activityBroadcasts.length, 1, "the durable Activity event also projects live once");
  assert.equal(activityBroadcasts[0]?.agentId, f.agentBId);
  assert.equal(activityBroadcasts[0]?.event.dedupeKey, activity[0]?.dedupeKey);

  assert.equal(await canAgentReceiveChannelDelivery(f.threadId, f.agentBId), false);
  assert.equal(
    await canAgentReceiveChannelDelivery(f.threadId, f.agentBId, { personalMention: true }),
    true,
    "management removal must not suppress a later explicit personal mention",
  );

  response = await fetch(removeUrl, {
    method: "DELETE",
    headers: headers(f.memberBToken, f.serverId),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, removed: true, undoToken: firstRemoval.undoToken });
  assert.equal(activityBroadcasts.length, 1, "idempotent removal must not duplicate the live Activity projection");
  assert.equal((await listFollowerActivity()).length, 1, "idempotent removal must not duplicate durable Activity rows");
  assert.equal(
    emittedEvents.filter((event) => event.event === "thread:followers-updated").length,
    1,
    "idempotent removal must not duplicate roster-refresh events",
  );

  response = await fetch(rosterUrl, { headers: headers(f.ownerToken, f.serverId) });
  assert.equal(response.status, 200);
  roster = await response.json() as typeof roster;
  assert.equal(roster.threads[0]?.canManage, true);
  assert.deepEqual(roster.threads[0]?.agents, [], "removed Agents disappear from the current roster");

  response = await fetch(restoreUrl, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ undoToken: firstRemoval.undoToken }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, restored: true });
  assert.equal(await canAgentReceiveChannelDelivery(f.threadId, f.agentBId), true);

  response = await fetch(removeUrl, {
    method: "DELETE",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const secondRemoval = await response.json() as { removed: boolean; undoToken: string | null };
  assert.equal(secondRemoval.removed, true);
  assert.ok(secondRemoval.undoToken);
  assert.notEqual(secondRemoval.undoToken, firstRemoval.undoToken);

  response = await fetch(removeUrl, {
    method: "DELETE",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, removed: true, undoToken: secondRemoval.undoToken });
  assert.equal((await listFollowerActivity()).length, 3, "remove retry reuses the durable Activity identity");

  response = await fetch(restoreUrl, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ undoToken: firstRemoval.undoToken }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, restored: false });
  assert.equal(
    await canAgentReceiveChannelDelivery(f.threadId, f.agentBId),
    false,
    "a stale Undo must not override a newer removal",
  );

  response = await fetch(restoreUrl, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ undoToken: secondRemoval.undoToken }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, restored: true });

  activity = await listFollowerActivity();
  assert.deepEqual(
    activity.map((event) => event.dedupeKey?.includes(":removed:") ? "removed" : "restored"),
    ["removed", "restored", "removed", "restored"],
  );
});


test("GET /api/channels/unread excludes followed threads whose parent channel was deleted", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  await db
    .update(channels)
    .set({ deletedAt: new Date() })
    .where(eq(channels.id, f.parentChannelId));
  await createMessage(f.threadId, "user", f.memberBId, "reply after parent delete");

  const res = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(f.followerToken, f.serverId),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, number>;
  assert.equal(
    body[f.threadId],
    undefined,
    "followed threads must not produce unread counts after the parent channel is deleted",
  );
});


test("GET /api/channels/threads/followed records followed-thread phases and query shape", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "7".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const db = getDb();
  const owner = await seedUser("followed-trace-owner@slock.test", "followed-trace-owner");
  const claimant = await seedUser("followed-trace-claimant@slock.test", "followed-trace-claimant");
  const server = await createServer("Followed Trace Server", "followed-trace-server", owner.id);
  await addMember(server.id, claimant.id);
  const channel = await createChannel(server.id, "followed-trace-channel");
  await addHuman(channel.id, owner.id);
  const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const readReply = await createMessage(thread.id, "user", owner.id, "already read reply");
  await createMessage(thread.id, "user", claimant.id, "unread reply");
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  });
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: thread.id,
    lastReadSeq: readReply.seq,
    updatedAt: new Date(),
  });
  const [legacyTask] = await db.insert(tasks).values({
    channelId: channel.id,
    taskNumber: 1,
    title: "parent task",
    status: "in_progress",
    createdByType: "user",
    createdById: owner.id,
    claimedByType: "user",
    claimedById: claimant.id,
    messageId: parentMessage.id,
  }).returning({ id: tasks.id });
  assert.ok(legacyTask);

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { threads: Array<{
    threadChannelId: string;
    unreadCount: number;
    taskId: string | null;
    taskClaimedByType: string | null;
    taskClaimedById: string | null;
    taskClaimedByName: string | null;
  }> };
  assert.equal(body.threads.length, 1);
  assert.equal(body.threads[0]?.threadChannelId, thread.id);
  assert.equal(body.threads[0]?.unreadCount, 1);
  assert.equal(body.threads[0]?.taskId, legacyTask.id);
  assert.equal(body.threads[0]?.taskClaimedByType, "user");
  assert.equal(body.threads[0]?.taskClaimedById, claimant.id);
  assert.equal(body.threads[0]?.taskClaimedByName, "followed-trace-claimant");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
  );
  assert.ok(span, "expected GET /api/channels/threads/followed root span");

  const processEventNames = handlerTraceEvents(span.events)
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");
  assert.deepEqual(processEventNames, [
    "activity.list.fetch",
    "followed_threads.load.started",
    "history.policy.checked",
    // hasMention: the sidebar unread read (same source as threadUnread.hasMention).
    "inbox.backend.selected",
    "followed_threads.source_selected",
    "followed_threads.loaded",
    "response.ready",
    "http.response.finished",
  ]);
  const sourceSelected = span.events.find((event) => event.name === "followed_threads.source_selected");
  assert.equal(sourceSelected?.attrs?.followed_threads_source, "rw_v5");
  assert.equal(sourceSelected?.attrs?.rw_regular_threads, 1);
  assert.equal(sourceSelected?.attrs?.rw_missing_threads, 0);

  // Active follows of a member: the rw_followed_threads_v5 path. Its query set
  // is constant in the number of threads (primary-key / distinct-parent reads).
  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    dbEvents.map((event) => event.attrs?.query_name).sort(),
    [
      // Task v2: followed task conversations are one more query, whatever the
      // reader's flag (a v2 task keeps its conversation after a rollback).
      "channels.followed_task_conversations_by_user",
      "channels.followed_thread_ids_by_user",
      "channels.followed_threads.parent_channels",
      "channels.followed_threads.read_cursors",
      "channels.followed_threads.user_claimants",
      "channels.followed_threads_rw_rows",
      "channels.unread_counts_by_user",
    ],
  );
  assert.equal(dbEvents.length, 7, "followed threads query count should stay constant for task-claimant enrichment");

  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channels.followed_thread_ids_by_user")?.attrs?.phase, "followed_threads.loaded");
  assert.equal(dbEventByQuery.get("channels.followed_thread_ids_by_user")?.attrs?.followed_threads_count, 1);
  // No RisingWave in CI: the installed test reference serves the v5 rows from Postgres.
  assert.equal(dbEventByQuery.get("channels.followed_threads_rw_rows")?.attrs?.rows_count, 1);
  assert.equal(dbEventByQuery.get("channels.followed_threads.parent_channels")?.attrs?.parent_channels_count, 1);
  assert.equal(dbEventByQuery.get("channels.followed_threads.read_cursors")?.attrs?.read_cursor_rows_count, 1);
  assert.equal(dbEventByQuery.get("channels.followed_threads.user_claimants")?.attrs?.input_count, 1);
  assert.equal(dbEventByQuery.get("channels.followed_threads.user_claimants")?.attrs?.claimants_count, 1);

  const loadedEvent = span.events.find((event) => event.name === "followed_threads.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.followed_threads_count, 1);
  assert.equal(loadedEvent.attrs?.unread_threads_count, 1);
  assert.equal(loadedEvent.attrs?.history_cutoff_present, false);

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.followed_threads_count, 1);
  assert.equal(readyEvent.attrs?.unread_threads_count, 1);
  assert.equal(Object.values(span.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(readyEvent.attrs ?? {}).includes(thread.id), false);
});


test("GET /api/channels/threads/followed uses RW stats by default when configured and traces success", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "7".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_default_on_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    stubFollowedThreadsV5Unavailable();
    const rwQueries: unknown[][] = [];
    let rwRows: unknown[] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      rwQueries.push(args);
      return { rows: rwRows };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-default-owner@slock.test", "followed-rw-default-owner");
    const replier = await seedUser("followed-rw-default-replier@slock.test", "followed-rw-default-replier");
    const server = await createServer("Followed RW Default Server", "followed-rw-default-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-default-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const unreadReply = await createMessage(thread.id, "user", replier.id, "pg reply that RW replaces");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    rwRows = [{
      threadChannelId: thread.id,
      replyCount: 1,
      lastReplyAt: "2026-06-18 09:00:00.000000+00",
      lastReplyMessageId: unreadReply.id,
      lastReplyContent: "rw supplied latest reply",
      lastReplySenderType: "user",
      lastReplySenderId: replier.id,
      firstUnreadMessageId: unreadReply.id,
      unreadCount: 1,
    }];

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { threads: Array<{ threadChannelId: string; unreadCount: number; latestActivityPreview: string | null }> };
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0]?.threadChannelId, thread.id);
    assert.equal(body.threads[0]?.unreadCount, 1);
    assert.equal(body.threads[0]?.latestActivityPreview, "rw supplied latest reply");
    assert.equal(rwQueries.length, 1, "RW stats backend should be attempted by default when RW is configured");

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
    );
    assert.ok(span, "expected GET /api/channels/threads/followed root span");

    const statsEvents = span.events.filter((event) =>
      event.name === "db.query.finished"
      && event.attrs?.query_name === "channels.followed_threads_stats_by_threads"
    );
    assert.equal(statsEvents.length, 1, "expected only the RW stats query on complete RW results");
    assert.equal(statsEvents[0].attrs?.stats_source, "rw_mv");
    assert.equal(statsEvents[0].attrs?.fallback_reason, "none");
    assert.equal(statsEvents[0].attrs?.followed_threads_count, 1);
    assert.equal(statsEvents[0].attrs?.stats_rows_count, 1);

    const successEvent = span.events.find((event) => event.name === "followed_threads.stats_backend.succeeded");
    assert.ok(successEvent, "expected RW success trace event");
    assert.equal(successEvent.attrs?.stats_source, "rw_mv");
    assert.equal(successEvent.attrs?.fallback_reason, "none");
    assert.equal(successEvent.attrs?.backend, "risingwave");
    assert.equal(successEvent.attrs?.rw_followed_thread_stats_view, "rw_followed_threads_v5");
    assert.equal(successEvent.attrs?.followed_threads_count, 1);
    assert.equal(successEvent.attrs?.stats_rows_count, 1);

    const slowReplayEvent = span.events.find((event) => event.name === "followed_threads.stats_backend.slow_replay_query");
    assert.equal(slowReplayEvent, undefined, "fast RW stats queries must not include replay payloads");
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    await closeRisingWavePool();
    await app.close();
  }
});



test("GET /api/channels/threads/followed answers 503 + Retry-After when the RisingWave pool is saturated", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "7".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_default_on_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    stubFollowedThreadsV5Unavailable();
    const rwQueries: unknown[][] = [];
    let rwRows: unknown[] = [];
    const missingV5Queries: unknown[][] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      if (/JOIN rw_followed_threads_v5 s/.test(String(args[0]))) {
        missingV5Queries.push(args);
        // pg-pool's error when no RW connection frees up within connectionTimeoutMillis.
        throw new Error("timeout exceeded when trying to connect");
      }
      rwQueries.push(args);
      return { rows: rwRows };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-default-owner@slock.test", "followed-rw-default-owner");
    const replier = await seedUser("followed-rw-default-replier@slock.test", "followed-rw-default-replier");
    const server = await createServer("Followed RW Default Server", "followed-rw-default-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-default-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const unreadReply = await createMessage(thread.id, "user", replier.id, "pg reply that RW replaces");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    rwRows = [{
      threadChannelId: thread.id,
      replyCount: 1,
      lastReplyAt: "2026-06-18 09:00:00.000000+00",
      lastReplyMessageId: unreadReply.id,
      lastReplyContent: "rw supplied latest reply",
      lastReplySenderType: "user",
      lastReplySenderId: replier.id,
      firstUnreadMessageId: unreadReply.id,
      unreadCount: 1,
    }];

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();
    const rwAcquireTimeouts = async () => (await dbQueryErrorsTotal.get()).values
      .find((value) => value.labels.pool === "risingwave" && value.labels.sqlstate === "acquire_timeout")?.value ?? 0;
    const acquireTimeoutsBefore = await rwAcquireTimeouts();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 503, "a saturated RW pool is a retryable overload, not a 500");
    assert.equal(await rwAcquireTimeouts() - acquireTimeoutsBefore, 1, "the stats read's acquire timeout reaches pool=risingwave");
    assert.equal(res.headers.get("retry-after"), "2");
    assert.deepEqual(await res.json(), {
      error: "Temporarily overloaded, retry shortly",
      code: "rw_overloaded",
      retryable: true,
    });
    assert.equal(missingV5Queries.length, 1);
    assert.equal(rwQueries.length, 0, "an overload is not retried against v4");
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    await closeRisingWavePool();
    await app.close();
  }
});


test("GET /api/channels/threads/followed: a saturated RW pool on the row read answers 503 without running the Postgres legacy path", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "7".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_default_on_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    // The row read itself cannot get an RW connection.
    __testRisingWaveInbox.set({
      query: (async () => {
        throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
      }) as never,
    });
    const rwQueries: unknown[][] = [];
    let rwRows: unknown[] = [];
    const missingV5Queries: unknown[][] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      if (/JOIN rw_followed_threads_v5 s/.test(String(args[0]))) {
        missingV5Queries.push(args);
        // pg-pool's error when no RW connection frees up within connectionTimeoutMillis.
        throw new Error("timeout exceeded when trying to connect");
      }
      rwQueries.push(args);
      return { rows: rwRows };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-default-owner@slock.test", "followed-rw-default-owner");
    const replier = await seedUser("followed-rw-default-replier@slock.test", "followed-rw-default-replier");
    const server = await createServer("Followed RW Default Server", "followed-rw-default-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-default-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const unreadReply = await createMessage(thread.id, "user", replier.id, "pg reply that RW replaces");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    rwRows = [{
      threadChannelId: thread.id,
      replyCount: 1,
      lastReplyAt: "2026-06-18 09:00:00.000000+00",
      lastReplyMessageId: unreadReply.id,
      lastReplyContent: "rw supplied latest reply",
      lastReplySenderType: "user",
      lastReplySenderId: replier.id,
      firstUnreadMessageId: unreadReply.id,
      unreadCount: 1,
    }];

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 503, "an overloaded RW pool is a retryable overload");
    assert.equal(res.headers.get("retry-after"), "2");
    assert.equal((await res.json() as { code?: string }).code, "rw_overloaded");
    assert.equal(missingV5Queries.length + rwQueries.length, 0, "no RW stats read either");

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
    );
    assert.ok(span);
    const queryNames = span.events
      .filter((event) => event.name === "db.query.finished")
      .map((event) => event.attrs?.query_name);
    // Only the cheap follow-set read (it runs concurrently with the RW read).
    for (const legacyQuery of [
      "channels.followed_threads_by_user",
      "channels.followed_joint_threads_by_user",
      "channels.read_state_by_channels",
      "channels.followed_threads_stats_by_threads",
    ]) {
      assert.ok(!queryNames.includes(legacyQuery), `${legacyQuery} must not run while RW is overloaded`);
    }
    assert.equal(span.events.find((event) => event.name === "followed_threads.source_selected"), undefined, "no legacy source selected");
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    await closeRisingWavePool();
    await app.close();
  }
});

test("GET /api/channels/threads/followed records replay SQL only for slow RW stats queries", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const previousSlowReplayMs = process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  const previousReplayThreadCap = process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "a".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_slow_replay_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    stubFollowedThreadsV5Unavailable();
    process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = "1";
    process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = "100";
    const rwQueries: unknown[][] = [];
    let rwRows: unknown[] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      rwQueries.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rows: rwRows };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-slow-owner@slock.test", "followed-rw-slow-owner");
    const replier = await seedUser("followed-rw-slow-replier@slock.test", "followed-rw-slow-replier");
    const server = await createServer("Followed RW Slow Replay Server", "followed-rw-slow-replay-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-slow-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const unreadReply = await createMessage(thread.id, "user", replier.id, "pg reply that RW replaces");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    rwRows = [{
      threadChannelId: thread.id,
      replyCount: 1,
      lastReplyAt: "2026-06-18 09:00:00.000000+00",
      lastReplyMessageId: unreadReply.id,
      lastReplyContent: "rw supplied latest reply",
      lastReplySenderType: "user",
      lastReplySenderId: replier.id,
      firstUnreadMessageId: unreadReply.id,
      unreadCount: 1,
    }];

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 200);
    assert.equal(rwQueries.length, 1, "RW stats backend should be attempted once");

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
    );
    assert.ok(span, "expected GET /api/channels/threads/followed root span");

    const slowReplayEvent = span.events.find((event) => event.name === "followed_threads.stats_backend.slow_replay_query");
    assert.ok(slowReplayEvent, "expected slow RW replay trace event");
    assert.equal(slowReplayEvent.attrs?.stats_source, "rw_mv");
    assert.equal(slowReplayEvent.attrs?.fallback_reason, "none");
    assert.equal(slowReplayEvent.attrs?.backend, "risingwave");
    assert.equal(slowReplayEvent.attrs?.query_name, "channels.followed_threads_stats_by_threads");
    assert.equal(slowReplayEvent.attrs?.rw_followed_thread_stats_view, "rw_followed_threads_v5");
    assert.equal(slowReplayEvent.attrs?.followed_threads_count, 1);
    assert.equal(slowReplayEvent.attrs?.stats_rows_count, 1);
    assert.equal(slowReplayEvent.attrs?.slow_threshold_ms, 1);
    assert.equal(slowReplayEvent.attrs?.replay_sql_dialect, "risingwave_pgwire");
    assert.equal(slowReplayEvent.attrs?.replay_sql_parameterized, true);
    assert.equal(slowReplayEvent.attrs?.replay_param_count, 3);
    assert.equal(slowReplayEvent.attrs?.replay_thread_cap, 100);
    assert.equal(slowReplayEvent.attrs?.replay_payload_truncated, false);
    assert.equal(slowReplayEvent.attrs?.replay_contains_dsn, false);
    assert.equal(slowReplayEvent.attrs?.replay_contains_message_content, false);
    assert.equal(slowReplayEvent.attrs?.replay_connection_label, "risingwave");
    assert.match(String(slowReplayEvent.attrs?.query_hash), /^[a-f0-9]{64}$/);
    assert.equal(slowReplayEvent.attrs?.query_shape_hash, slowReplayEvent.attrs?.query_hash);
    assert.match(String(slowReplayEvent.attrs?.replay_hash), /^[a-f0-9]{64}$/);
    assert.notEqual(slowReplayEvent.attrs?.replay_hash, slowReplayEvent.attrs?.query_hash);

    const replaySql = String(slowReplayEvent.attrs?.replay_sql);
    const replayParamsJson = String(slowReplayEvent.attrs?.replay_params_json);
    assert.equal(replaySql, rwQueries[0]?.[0]);
    assert.deepEqual(JSON.parse(replayParamsJson), rwQueries[0]?.[1]);
    assert.deepEqual(JSON.parse(replayParamsJson), [server.id, owner.id, thread.id]);
    assert.match(replaySql, /WITH input_threads\(thread_channel_id\)/);
    assert.match(replaySql, /VALUES \(\$3::varchar\)/);
    assert.match(replaySql, /JOIN rw_followed_threads_v5 s/);
    assert.equal(replaySql.includes("postgres://127.0.0.1:4566"), false);
    assert.equal(replayParamsJson.includes("postgres://127.0.0.1:4566"), false);
    assert.equal(replaySql.includes("rw supplied latest reply"), false);
    assert.equal(replayParamsJson.includes("rw supplied latest reply"), false);
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    if (previousSlowReplayMs === undefined) {
      delete process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
    } else {
      process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = previousSlowReplayMs;
    }
    if (previousReplayThreadCap === undefined) {
      delete process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
    } else {
      process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = previousReplayThreadCap;
    }
    await closeRisingWavePool();
    await app.close();
  }
});


test("GET /api/channels/threads/followed truncates over-cap slow RW replay payloads", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const previousSlowReplayMs = process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
  const previousReplayThreadCap = process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "b".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_slow_replay_cap_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    stubFollowedThreadsV5Unavailable();
    process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = "1";
    process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = "0";
    const rwQueries: unknown[][] = [];
    let rwRows: unknown[] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      rwQueries.push(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rows: rwRows };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-cap-owner@slock.test", "followed-rw-cap-owner");
    const replier = await seedUser("followed-rw-cap-replier@slock.test", "followed-rw-cap-replier");
    const server = await createServer("Followed RW Slow Replay Cap Server", "followed-rw-slow-replay-cap-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-cap-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const unreadReply = await createMessage(thread.id, "user", replier.id, "pg reply that RW replaces");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    rwRows = [{
      threadChannelId: thread.id,
      replyCount: 1,
      lastReplyAt: "2026-06-18 09:00:00.000000+00",
      lastReplyMessageId: unreadReply.id,
      lastReplyContent: "rw supplied latest reply",
      lastReplySenderType: "user",
      lastReplySenderId: replier.id,
      firstUnreadMessageId: unreadReply.id,
      unreadCount: 1,
    }];

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 200);
    assert.equal(rwQueries.length, 1, "RW stats backend should be attempted once");

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
    );
    assert.ok(span, "expected GET /api/channels/threads/followed root span");

    const slowReplayEvent = span.events.find((event) => event.name === "followed_threads.stats_backend.slow_replay_query");
    assert.ok(slowReplayEvent, "expected slow RW replay trace event");
    assert.equal(slowReplayEvent.attrs?.followed_threads_count, 1);
    assert.equal(slowReplayEvent.attrs?.replay_param_count, 3);
    assert.equal(slowReplayEvent.attrs?.replay_thread_cap, 0);
    assert.equal(slowReplayEvent.attrs?.replay_payload_truncated, true);
    assert.equal(slowReplayEvent.attrs?.replay_sql, undefined);
    assert.equal(slowReplayEvent.attrs?.replay_params_json, undefined);
    assert.equal(slowReplayEvent.attrs?.replay_hash, undefined);
    assert.match(String(slowReplayEvent.attrs?.query_hash), /^[a-f0-9]{64}$/);
    assert.equal(slowReplayEvent.attrs?.query_shape_hash, slowReplayEvent.attrs?.query_hash);
    assert.equal(slowReplayEvent.attrs?.replay_contains_dsn, false);
    assert.equal(slowReplayEvent.attrs?.replay_contains_message_content, false);
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    if (previousSlowReplayMs === undefined) {
      delete process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS;
    } else {
      process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS = previousSlowReplayMs;
    }
    if (previousReplayThreadCap === undefined) {
      delete process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP;
    } else {
      process.env.RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP = previousReplayThreadCap;
    }
    await closeRisingWavePool();
    await app.close();
  }
});


test("GET /api/channels/threads/followed leaves out a thread RW has not caught up with (no error, no Postgres fill-in)", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const originalPoolQuery = pg.Pool.prototype.query;
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "8".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_missing_rows_test";
    // Exercise the RisingWave read itself: take the test reference away.
    uninstallRisingWaveReadReferences();
    stubFollowedThreadsV5WithNoRows();
    const rwQueries: unknown[][] = [];
    (pg.Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> }).query = async (...args: unknown[]) => {
      rwQueries.push(args);
      return { rows: [] };
    };

    const db = getDb();
    const owner = await seedUser("followed-rw-missing-owner@slock.test", "followed-rw-missing-owner");
    const replier = await seedUser("followed-rw-missing-replier@slock.test", "followed-rw-missing-replier");
    const server = await createServer("Followed RW Missing Server", "followed-rw-missing-server", owner.id);
    await addMember(server.id, replier.id);
    const channel = await createChannel(server.id, "followed-rw-missing-channel");
    await addHuman(channel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "parent task");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    const readReply = await createMessage(thread.id, "user", owner.id, "already read reply");
    await createMessage(thread.id, "user", replier.id, "unread reply");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });
    await db.insert(userChannelReadCursors).values({
      userId: owner.id,
      channelId: thread.id,
      lastReadSeq: readReply.seq,
      updatedAt: new Date(),
    });

    const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(res.status, 200, "a lagging RW read is served as-is, never an error or a Postgres reroute");
    assert.equal(rwQueries.length, 0, "nothing listed, so no stats read");
    const body = await res.json() as { threads: Array<Record<string, unknown>> };
    assert.equal(
      body.threads.find((candidate) => candidate.threadChannelId === thread.id),
      undefined,
      "a followed thread not in rw_followed_threads_v5 yet (CDC lag) is left out until RW catches up",
    );

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/threads/followed",
    );
    assert.ok(span, "expected GET /api/channels/threads/followed root span");

    // Counted in the trace, not filled in from Postgres.
    const sourceSelected = span.events.find((event) => event.name === "followed_threads.source_selected");
    assert.equal(sourceSelected?.attrs?.followed_threads_source, "rw_v5");
    assert.equal(sourceSelected?.attrs?.rw_missing_threads, 1);
    const queryNames = span.events
      .filter((event) => event.name === "db.query.finished")
      .map((event) => event.attrs?.query_name);
    assert.ok(!queryNames.includes("channels.followed_threads_by_user"), "no Postgres regular-thread list for the missing thread");
    assert.ok(!queryNames.includes("channels.followed_threads_stats_by_threads"), "no stats read for threads that are not listed");
  } finally {
    (pg.Pool.prototype as unknown as { query: typeof originalPoolQuery }).query = originalPoolQuery;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    installRisingWaveReadReferences();
    __testRisingWaveInbox.reset();
    await closeRisingWavePool();
    await app.close();
  }
});


test("GET /api/channels/:id/threads records thread-summary phases and constant query shape", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "9".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("thread-summary-trace-owner@slock.test", "thread-summary-trace-owner");
  const replier = await seedUser("thread-summary-trace-replier@slock.test", "thread-summary-trace-replier");
  const server = await createServer("Thread Summary Trace Server", "thread-summary-trace-server", owner.id);
  await addMember(server.id, replier.id);
  const channel = await createChannel(server.id, "thread-summary-trace-channel");
  await addHuman(channel.id, owner.id);

  const parentOne = await createMessage(channel.id, "user", owner.id, "parent one");
  const threadOne = await getOrCreateThread(parentOne.id, owner.id, "user");
  await createMessage(threadOne.id, "user", owner.id, "reply one");
  await createMessage(threadOne.id, "user", replier.id, "reply two");

  const parentTwo = await createMessage(channel.id, "user", replier.id, "parent two");
  const threadTwo = await getOrCreateThread(parentTwo.id, replier.id, "user");
  await createMessage(threadTwo.id, "user", replier.id, "reply three");

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { threadChannelId: string; replyCount: number; participantIds: string[] }>;
  assert.equal(Object.keys(body).length, 2);
  assert.equal(body[parentOne.id]?.threadChannelId, threadOne.id);
  assert.equal(body[parentOne.id]?.replyCount, 2);
  assert.equal(body[parentOne.id]?.participantIds.length, 2);
  assert.equal(body[parentTwo.id]?.threadChannelId, threadTwo.id);
  assert.equal(body[parentTwo.id]?.replyCount, 1);
  assert.equal(body[parentTwo.id]?.participantIds.length, 1);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/:id/threads",
  );
  assert.ok(span, "expected GET /api/channels/:id/threads root span");

  const processEventNames = handlerTraceEvents(span.events)
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");
  assert.deepEqual(processEventNames, [
    "channel_threads.load.started",
    "channel.loaded",
    "channel.access.checked",
    "channel_threads.loaded",
    "response.ready",
    "http.response.finished",
  ]);

  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    dbEvents.map((event) => event.attrs?.query_name).sort(),
    [
      "channel_threads.latest_replies_by_threads",
      "channel_threads.list_by_channel",
      "channel_threads.participants_by_threads",
      "channel_threads.unread_by_threads",
    ],
  );
  assert.equal(dbEvents.length, 4);

  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.phase, "channel_threads.loaded");
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.row_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_source, "compat_recent");
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.input_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.participant_rows_count, 3);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.input_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.unread_threads_count, 0);
  assert.equal(dbEventByQuery.get("channel_threads.latest_replies_by_threads")?.attrs?.input_count, 2);

  const loadedEvent = span.events.find((event) => event.name === "channel_threads.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.thread_summaries_count, 2);
  assert.equal(loadedEvent.attrs?.total_replies_count, 3);
  assert.equal(loadedEvent.attrs?.total_unread_replies_count, 0);
  assert.equal(loadedEvent.attrs?.participant_links_count, 3);
  assert.equal(loadedEvent.attrs?.parent_message_scope_count, 2);
  assert.equal(loadedEvent.attrs?.parent_message_scope_source, "compat_recent");

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.thread_summaries_count, 2);
  assert.equal(readyEvent.attrs?.parent_message_scope_count, 2);
  assert.equal(readyEvent.attrs?.parent_message_scope_source, "compat_recent");
  assert.equal(Object.values(span.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(readyEvent.attrs ?? {}).includes(threadOne.id), false);
  assert.equal(
    dbEvents.some((event) => Object.values(event.attrs ?? {}).includes(parentOne.id)),
    false,
  );
});


test("GET /api/channels/:id/threads keeps system history in the count but out of latest reply previews", async ({ app }) => {
  const owner = await seedUser("thread-summary-system-owner@slock.test", "thread-summary-system-owner");
  const server = await createServer("Thread Summary System Server", "thread-summary-system-server", owner.id);
  const channel = await createChannel(server.id, "thread-summary-system-channel");
  await addHuman(channel.id, owner.id);

  const parent = await createMessage(channel.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "human reply one");
  await createMessage(thread.id, "user", owner.id, "human reply two");
  await createMessage(thread.id, "user", owner.id, "human reply three");
  await createMessage(thread.id, "user", owner.id, "system receipt", "system");

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, {
    replyCount: number;
    latestReplies: Array<{ preview: string; senderType: string }>;
  }>;
  const summary = body[parent.id];
  assert.ok(summary);
  assert.equal(summary.replyCount, 4, "system events remain part of the truthful thread total");
  assert.deepEqual(
    summary.latestReplies.map((reply) => reply.preview),
    ["human reply one", "human reply two", "human reply three"],
    "the preview query backfills the three newest conversation replies instead of spending a slot on system history",
  );
  assert.equal(summary.latestReplies.some((reply) => reply.senderType === "system"), false);
});


test("GET /api/channels/:id/threads projects agent display names into latest reply previews", async ({ app }) => {
  const owner = await seedUser("thread-summary-agent-owner@slock.test", "thread-summary-agent-owner");
  const server = await createServer("Thread Summary Agent Server", "thread-summary-agent-server", owner.id);
  const channel = await createChannel(server.id, "thread-summary-agent-channel");
  await addHuman(channel.id, owner.id);

  const agent = await createAgent(server.id, "MingQi", { runtime: "codex" });
  await getDb().update(agents).set({ displayName: "明启" }).where(eq(agents.id, agent.id));

  const parent = await createMessage(channel.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "agent", agent.id, "agent reply");

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, {
    latestReplies: Array<{ senderName: string; senderDisplayName: string }>;
  }>;
  const summary = body[parent.id];
  assert.ok(summary);
  assert.equal(
    summary.latestReplies[0]?.senderName,
    "MingQi",
    "senderName remains the stable unique handle",
  );
  assert.equal(
    summary.latestReplies[0]?.senderDisplayName,
    "明启",
    "senderDisplayName is the explicit UI label",
  );
});


test("member reply previews in a non-joint channel resolve an agent exactly like its parent row (wg-rbac #56)", async ({ app }) => {
  const owner = await seedUser("thread-summary-foreign-agent-owner@slock.test", "thread-summary-foreign-agent-owner");
  const server = await createServer("Thread Summary Foreign Agent Server", "thread-summary-foreign-agent-server", owner.id);
  const otherServer = await createServer("Thread Summary Foreign Agent Other", "thread-summary-foreign-agent-other", owner.id);
  const channel = await createChannel(server.id, "thread-summary-foreign-agent-channel");
  await addHuman(channel.id, owner.id);
  const foreignAgent = await createAgent(otherServer.id, "ForeignAgent", { runtime: "codex" });
  await getDb().update(agents).set({ displayName: "Foreign Agent Label" }).where(eq(agents.id, foreignAgent.id));

  // Same agent as a parent row and as a reply: the preview must say what the
  // parent row says for that agent, whatever the member rule is.
  const parent = await createMessage(channel.id, "agent", foreignAgent.id, "foreign agent parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "agent", foreignAgent.id, "foreign agent reply");

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, { headers: headers(ownerToken, server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as {
    messages: Array<{ id: string; senderName: string }>;
    threadSummariesByParentMessageId: Record<string, { latestReplies: Array<{ preview: string; senderDisplayName: string }> }>;
  };
  const parentRow = body.messages.find((message) => message.id === parent.id);
  assert.ok(parentRow);
  const reply = body.threadSummariesByParentMessageId[parent.id]?.latestReplies.find((item) => item.preview === "foreign agent reply");
  assert.ok(reply);
  assert.equal(reply.senderDisplayName, parentRow.senderName, "the reply preview and the parent row resolve the agent by one rule");
});


test("GET /api/channels/:id/threads bounds missing parentMessageIds to recent parent scope", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "6".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("thread-summary-compat-owner@slock.test", "thread-summary-compat-owner");
  const server = await createServer("Thread Summary Compat Server", "thread-summary-compat-server", owner.id);
  const channel = await createChannel(server.id, "thread-summary-compat-channel");
  await addHuman(channel.id, owner.id);

  const parentMessages: Array<{ id: string }> = [];
  for (let i = 0; i < 102; i++) {
    const parent = await createMessage(channel.id, "user", owner.id, `parent ${i}`);
    await getOrCreateThread(parent.id, owner.id, "user");
    parentMessages.push(parent);
  }

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.equal(Object.keys(body).length, 100);
  assert.equal(body[parentMessages[0]!.id], undefined);
  assert.equal(body[parentMessages[1]!.id], undefined);
  assert.ok(body[parentMessages[2]!.id], "expected oldest retained parent to be included");
  assert.ok(body[parentMessages[101]!.id], "expected newest parent to be included");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/:id/threads",
  );
  assert.ok(span, "expected GET /api/channels/:id/threads root span");

  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.row_count, 100);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_count, 100);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_source, "compat_recent");
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.input_count, 100);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.input_count, 100);

  const loadedEvent = span.events.find((event) => event.name === "channel_threads.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.thread_summaries_count, 100);
  assert.equal(loadedEvent.attrs?.parent_message_scope_count, 100);
  assert.equal(loadedEvent.attrs?.parent_message_scope_source, "compat_recent");

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.thread_summaries_count, 100);
  assert.equal(readyEvent.attrs?.parent_message_scope_count, 100);
  assert.equal(readyEvent.attrs?.parent_message_scope_source, "compat_recent");
});


test("GET /api/channels/:id/threads scopes summaries to requested parent messages", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "8".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("thread-summary-scope-owner@slock.test", "thread-summary-scope-owner");
  const replier = await seedUser("thread-summary-scope-replier@slock.test", "thread-summary-scope-replier");
  const server = await createServer("Thread Summary Scope Server", "thread-summary-scope-server", owner.id);
  await addMember(server.id, replier.id);
  const channel = await createChannel(server.id, "thread-summary-scope-channel");
  await addHuman(channel.id, owner.id);

  const parentOne = await createMessage(channel.id, "user", owner.id, "parent one");
  const threadOne = await getOrCreateThread(parentOne.id, owner.id, "user");
  await createMessage(threadOne.id, "user", owner.id, "reply one");

  const parentTwo = await createMessage(channel.id, "user", replier.id, "parent two");
  const threadTwo = await getOrCreateThread(parentTwo.id, replier.id, "user");
  await createMessage(threadTwo.id, "user", replier.id, "reply two");

  const parentThree = await createMessage(channel.id, "user", owner.id, "parent three");
  const threadThree = await getOrCreateThread(parentThree.id, owner.id, "user");
  await createMessage(threadThree.id, "user", replier.id, "reply three");

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const scopedParentIds = `${parentOne.id},${parentThree.id}`;
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads?parentMessageIds=${scopedParentIds}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.deepEqual(Object.keys(body).sort(), [parentOne.id, parentThree.id].sort());
  assert.equal(body[parentOne.id]?.threadChannelId, threadOne.id);
  assert.equal(body[parentThree.id]?.threadChannelId, threadThree.id);
  assert.equal(body[parentTwo.id], undefined);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/:id/threads",
  );
  assert.ok(span, "expected GET /api/channels/:id/threads root span");

  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    dbEvents.map((event) => event.attrs?.query_name).sort(),
    [
      "channel_threads.latest_replies_by_threads",
      "channel_threads.list_by_channel",
      "channel_threads.participants_by_threads",
      "channel_threads.unread_by_threads",
    ],
  );
  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.row_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_source, "client");
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.input_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.participant_rows_count, 2);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.input_count, 2);

  const loadedEvent = span.events.find((event) => event.name === "channel_threads.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.thread_summaries_count, 2);
  assert.equal(loadedEvent.attrs?.parent_message_scope_count, 2);
  assert.equal(loadedEvent.attrs?.parent_message_scope_source, "client");

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.thread_summaries_count, 2);
  assert.equal(readyEvent.attrs?.parent_message_scope_count, 2);
  assert.equal(readyEvent.attrs?.parent_message_scope_source, "client");
});


test("GET /api/channels/:id/threads/:messageId cloaks parent messages outside the requested channel", async ({ app }) => {
  const owner = await seedUser("thread-info-owner@slock.test", "thread-info-owner");
  const outsider = await seedUser("thread-info-outsider@slock.test", "thread-info-outsider");
  const server = await createServer("Thread Info Scope", "thread-info-scope", owner.id);
  await addMember(server.id, outsider.id, "member");
  const publicChannel = await createChannel(server.id, "thread-info-public");
  const privateChannel = await createChannel(server.id, "thread-info-private", "private parent", "private");
  await addHuman(privateChannel.id, owner.id);

  const privateParent = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const privateThread = await getOrCreateThread(privateParent.id, owner.id, "user");
  await createMessage(privateThread.id, "user", owner.id, "private reply");

  const publicParent = await createMessage(publicChannel.id, "user", outsider.id, "public parent");
  const publicThread = await getOrCreateThread(publicParent.id, outsider.id, "user");
  await createMessage(publicThread.id, "user", outsider.id, "public reply");

  const ownerToken = await tokenForHuman(owner.email);
  const outsiderToken = await tokenForHuman(outsider.email);

  const outsiderViaPublic = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/threads/${privateParent.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(outsiderViaPublic.status, 404, "known private parent ids must not resolve via an accessible public channel");

  const ownerWrongChannel = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/threads/${publicParent.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerWrongChannel.status, 404, "thread info must be scoped to the requested channel");

  const ownerPrivate = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/threads/${privateParent.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerPrivate.status, 200);
  const ownerBody = await ownerPrivate.json() as { threadChannelId: string; replyCount: number };
  assert.equal(ownerBody.threadChannelId, privateThread.id);
  assert.equal(ownerBody.replyCount, 1);
});


test("GET /api/channels/:id/threads/:messageId records the reject reason on every 404 branch and history-limit facts on success", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "c".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("thread-reject-owner@slock.test", "thread-reject-owner");
  const outsider = await seedUser("thread-reject-outsider@slock.test", "thread-reject-outsider");
  const server = await createServer("Thread Reject Server", "thread-reject-server", owner.id);
  const otherServer = await createServer("Thread Reject Other", "thread-reject-other", owner.id);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  await addMember(server.id, outsider.id, "member");
  const channel = await createChannel(server.id, "thread-reject-public");
  await addHuman(channel.id, owner.id);
  const privateChannel = await createChannel(server.id, "thread-reject-private", "private", "private");
  await addHuman(privateChannel.id, owner.id);

  const threadedParent = await createMessage(channel.id, "user", owner.id, "threaded parent");
  const thread = await getOrCreateThread(threadedParent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "reply");
  const bareParent = await createMessage(channel.id, "user", owner.id, "no thread yet");
  const privateParent = await createMessage(privateChannel.id, "user", owner.id, "private parent");

  const ownerToken = await tokenForHuman(owner.email);
  const outsiderToken = await tokenForHuman(outsider.email);

  async function lookup(channelId: string, messageId: string, token: string, serverId: string) {
    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/channels/${channelId}/threads/${messageId}`, {
      headers: headers(token, serverId),
    });
    const body = await res.json() as Record<string, unknown>;
    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/:id/threads/:messageId",
    );
    assert.ok(span, "expected GET /api/channels/:id/threads/:messageId root span");
    const rejected = span.events.filter((event) => event.name === "threads.lookup.rejected");
    const history = span.events.filter((event) => event.name === "history.policy.checked" || event.name === "history.limit.checked");
    return { status: res.status, body, rejected, history };
  }

  const found = await lookup(channel.id, threadedParent.id, ownerToken, server.id);
  assert.equal(found.status, 200);
  assert.deepEqual(found.rejected, [], "a resolved lookup records no rejection");
  assert.deepEqual(found.history.map((event) => event.name), ["history.policy.checked", "history.limit.checked"]);
  assert.equal(found.history[0]?.attrs?.plan, "free");
  assert.equal(found.history[1]?.attrs?.history_cutoff_present, true);
  assert.equal(found.history[1]?.attrs?.history_limited, false, "a fresh reply is inside the plan history");

  const notFound = await lookup(channel.id, bareParent.id, ownerToken, server.id);
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, { code: "THREAD_NOT_FOUND", error: "No thread found for this message" }, "additive code; error text unchanged");
  assert.deepEqual(notFound.rejected.map((event) => event.attrs), [
    { "threads.lookup.reject_reason": "not_found" },
  ]);

  const mismatch = await lookup(channel.id, threadedParent.id, ownerToken, otherServer.id);
  assert.equal(mismatch.status, 404);
  assert.deepEqual(mismatch.body, { error: "Channel not found or not visible" }, "response body unchanged");
  assert.deepEqual(mismatch.rejected.map((event) => event.attrs), [{
    "threads.lookup.reject_reason": "server_mismatch",
    request_server_id: otherServer.id,
    channel_server_id: server.id,
  }]);

  const denied = await lookup(privateChannel.id, privateParent.id, outsiderToken, server.id);
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.body, { error: "Channel not found or not visible" }, "response body unchanged");
  assert.deepEqual(denied.rejected.map((event) => event.attrs), [
    { "threads.lookup.reject_reason": "access_denied" },
  ]);

  const missing = await lookup(randomUUID(), threadedParent.id, ownerToken, server.id);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.rejected.map((event) => event.attrs), [
    { "threads.lookup.reject_reason": "channel_not_found" },
  ]);

  // Task #14: a thread whose replies all sit behind the Free-plan cutoff is
  // found (200) but its reply fetch is empty — the span must say so.
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await getDb().update(messages).set({ createdAt: old }).where(eq(messages.channelId, thread.id));
  const cutOff = await lookup(channel.id, threadedParent.id, ownerToken, server.id);
  assert.equal(cutOff.status, 200);
  assert.equal(cutOff.history.find((event) => event.name === "history.limit.checked")?.attrs?.history_limited, true);
});


test("GET /api/messages/context/:id records plan history facts, including a target hidden by the cutoff", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("context-history-owner@slock.test", "context-history-owner");
  const server = await createServer("Context History Server", "context-history-server", owner.id);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "context-history-channel");
  await addHuman(channel.id, owner.id);
  const oldMessage = await createMessage(channel.id, "user", owner.id, "older than the cutoff");
  await getDb().update(messages)
    .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
    .where(eq(messages.id, oldMessage.id));
  const recent = await createMessage(channel.id, "user", owner.id, "recent");
  const token = await tokenForHuman(owner.email);

  async function context(messageId: string) {
    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/messages/context/${messageId}?channelId=${channel.id}`, {
      headers: headers(token, server.id),
    });
    await res.json();
    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/messages/context/:messageId",
    );
    assert.ok(span, "expected GET /api/messages/context/:messageId root span");
    return { status: res.status, events: span.events };
  }

  const visible = await context(recent.id);
  assert.equal(visible.status, 200);
  assert.equal(visible.events.find((event) => event.name === "history.policy.checked")?.attrs?.plan, "free");
  const limit = visible.events.find((event) => event.name === "history.limit.checked");
  assert.equal(limit?.attrs?.history_cutoff_present, true);
  assert.equal(limit?.attrs?.history_limited, true, "an older message exists behind the cutoff");

  const hidden = await context(oldMessage.id);
  assert.equal(hidden.status, 404);
  const notFound = hidden.events.find((event) => event.name === "message_context.not_found");
  assert.deepEqual(notFound?.attrs, { plan: "free", history_cutoff_present: true, history_limited: true });
});


test("GET /api/channels/:id/threads includes viewer-specific unread reply counts for followed threads", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("summary-unread-owner@slock.test", "summary-unread-owner");
  const replier = await seedUser("summary-unread-replier@slock.test", "summary-unread-replier");
  const server = await createServer("Summary Unread Server", "summary-unread-server", owner.id);
  await addMember(server.id, replier.id);
  const channel = await createChannel(server.id, "summary-unread-channel");
  await addHuman(channel.id, owner.id);

  const followedParent = await createMessage(channel.id, "user", owner.id, "followed parent");
  const followedThread = await getOrCreateThread(followedParent.id, owner.id, "user");
  const readReply = await createMessage(followedThread.id, "user", replier.id, "already read reply");
  const unreadReply = await createMessage(followedThread.id, "user", replier.id, "unread reply");
  await db.insert(threadFollows).values({
    threadChannelId: followedThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: followedParent.id,
    reason: "manual",
  });
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: followedThread.id,
    lastReadSeq: readReply.seq,
    updatedAt: new Date(),
  });

  const unfollowedParent = await createMessage(channel.id, "user", owner.id, "unfollowed parent");
  const unfollowedThread = await getOrCreateThread(unfollowedParent.id, owner.id, "user");
  await createMessage(unfollowedThread.id, "user", replier.id, "not a followed-thread unread");

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { threadChannelId: string; replyCount: number; unreadCount: number; firstUnreadMessageId: string | null }>;

  assert.equal(body[followedParent.id]?.threadChannelId, followedThread.id);
  assert.equal(body[followedParent.id]?.replyCount, 2);
  assert.equal(body[followedParent.id]?.unreadCount, 1);
  assert.equal(body[followedParent.id]?.firstUnreadMessageId, unreadReply.id);
  assert.equal(body[unfollowedParent.id]?.threadChannelId, unfollowedThread.id);
  assert.equal(body[unfollowedParent.id]?.replyCount, 1);
  assert.equal(body[unfollowedParent.id]?.unreadCount, 0);
  assert.equal(body[unfollowedParent.id]?.firstUnreadMessageId, null);
});


test("getOrCreateThread creates a single active thread channel under concurrent opens", async ({ app }) => {
  const owner = await seedUser("thread-race-owner@slock.test", "thread-race-owner");
  const server = await createServer("Thread Race Server", "thread-race-server", owner.id);
  const channel = await createChannel(server.id, "thread-race-parent");
  await addHuman(channel.id, owner.id);

  const parent = await createMessage(channel.id, "user", owner.id, "race parent");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => getOrCreateThread(parent.id, owner.id, "user")),
  );

  const uniqueThreadIds = new Set(results.map((result) => result.id));
  assert.equal(uniqueThreadIds.size, 1, "all concurrent callers should converge on one thread id");

  const activeThreads = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.parentMessageId, parent.id),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
    ));
  assert.equal(activeThreads.length, 1, "only one active thread channel should exist for the parent");

  const [parentRow] = await getDb()
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, parent.id))
    .limit(1);
  assert.equal(parentRow?.threadId, activeThreads[0]?.id, "parent message should point at the canonical thread");
});


test("thread read paths prefer the canonical thread when historical duplicates exist", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("thread-dedup-owner@slock.test", "thread-dedup-owner");
  const replier = await seedUser("thread-dedup-replier@slock.test", "thread-dedup-replier");
  const server = await createServer("Thread Dedup Server", "thread-dedup-server", owner.id);
  await addMember(server.id, replier.id);
  const channel = await createChannel(server.id, "thread-dedup-parent");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, replier.id);

  const parent = await createMessage(channel.id, "user", owner.id, "dedup parent");
  await db.execute(sql`DROP INDEX IF EXISTS "idx_channels_active_thread_parent"`);

  const [staleThread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-stale-parent",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await createMessage(staleThread.id, "user", owner.id, "stale reply");

  const [activeThread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-active-parent",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await createMessage(activeThread.id, "user", owner.id, "active reply one");
  await createMessage(activeThread.id, "user", replier.id, "active reply two");

  await db.update(messages)
    .set({ threadId: staleThread.id })
    .where(eq(messages.id, parent.id));

  const ownerToken = await tokenForHuman(owner.email);

  const summariesRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(summariesRes.status, 200);
  const summaries = await summariesRes.json() as Record<string, {
    threadChannelId: string;
    replyCount: number;
    participantIds: string[];
  }>;
  assert.equal(summaries[parent.id]?.threadChannelId, activeThread.id, "summary route should prefer the canonical thread");
  assert.equal(summaries[parent.id]?.replyCount, 2);
  assert.deepEqual(summaries[parent.id]?.participantIds.sort(), [owner.id, replier.id].sort());

  const infoRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads/${parent.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(infoRes.status, 200);
  const info = await infoRes.json() as {
    threadChannelId: string;
    replyCount: number;
    participantIds: string[];
  };
  assert.equal(info.threadChannelId, activeThread.id, "single-thread lookup should also prefer the canonical thread");
  assert.equal(info.replyCount, 2);
  assert.deepEqual(info.participantIds.sort(), [owner.id, replier.id].sort());
});


test("public -> private conversion also prunes task conversation follows outside the private snapshot", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("visibility-task-owner@slock.test", "visibility-task-owner");
  const outsider = await seedUser("visibility-task-follower@slock.test", "visibility-task-follower");
  const server = await createServer("Visibility Task Server", "visibility-task-server", owner.id);
  await addMember(server.id, outsider.id);
  const channel = await createChannel(server.id, "task-toggle-room", "convert me");
  await addHuman(channel.id, owner.id);
  const [task] = await db.insert(tasks).values({ channelId: channel.id, taskNumber: 1, title: "a task", createdByType: "user", createdById: owner.id }).returning();
  const [conversation] = await db.insert(channels).values({ serverId: server.id, name: "task-1", type: "task", taskId: task!.id, parentChannelId: channel.id }).returning();
  await db.insert(threadFollows).values([
    { threadChannelId: conversation!.id, followerType: "user", followerId: owner.id, parentTaskId: task!.id, reason: "authored" },
    { threadChannelId: conversation!.id, followerType: "user", followerId: outsider.id, parentTaskId: task!.id, reason: "manual" },
  ]).onConflictDoNothing();

  const toPrivate = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(await tokenForHuman(owner.email), server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(toPrivate.status, 200);

  const left = await db.select({ followerId: threadFollows.followerId }).from(threadFollows)
    .where(eq(threadFollows.threadChannelId, conversation!.id));
  assert.deepEqual(left, [{ followerId: owner.id }], "the outsider's task conversation follow is pruned, the member's kept");
});

test("private -> public restores thread permalink access for non-members (task #417)", async ({ app }) => {
  // Repro of #engineering task #417: opening a thread permalink in a channel
  // that was converted private -> public left the channel pane on
  // "Select a channel" and the thread pane stuck on "Loading...". The web
  // thread-permalink flow makes exactly three calls for a non-member:
  //   1. GET  /channels/:id                 (ChannelRoute -> ensureChannel)
  //   2. GET  /channels/:id/threads/:msgId  (threadStore.openThread)
  //   3. GET  /messages/channel/:threadId   (ThreadPanel reply load)
  // All three must succeed against the parent channel's *current* (public)
  // visibility, not its historical private state. This pins the backend half
  // of the invariant; the client recovery half is covered by the threadStore
  // unit test (openThreadError / retryOpenThread).

  const owner = await seedUser("perma-owner@slock.test", "perma-owner");
  const outsider = await seedUser("perma-outsider@slock.test", "perma-outsider");
  const server = await createServer("Perma Server", "perma-server", owner.id);
  await addMember(server.id, outsider.id);

  // Channel born private, with a parent message + a thread reply, mirroring
  // a thread that accumulated history while the channel was invite-only.
  const channel = await createChannel(server.id, "mcdonalds-club", "born private", "private");
  await addHuman(channel.id, owner.id);
  const parent = await createMessage(channel.id, "user", owner.id, "parent message");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "reply while private");

  const ownerToken = await tokenForHuman(owner.email);
  const outsiderToken = await tokenForHuman(outsider.email);

  // Sanity: while still private, the outsider's permalink resolution fails.
  const preDetails = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(preDetails.status, 404, "non-member cannot resolve channel while private");

  // Owner flips it public.
  const toPublic = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "public" }),
  });
  assert.equal(toPublic.status, 200);
  assert.equal((await toPublic.json() as { type: string }).type, "channel");

  // 1. ChannelRoute -> ensureChannel: GET /channels/:id must now resolve so
  //    the pane stops showing "Select a channel".
  const details = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(details.status, 200, "non-member resolves channel details after private -> public (no 'Select a channel')");
  assert.equal((await details.json() as { type: string }).type, "channel");

  // 2. threadStore.openThread: read-only GET must return a
  //    threadChannelId so ThreadPanel leaves the "Loading..." shell.
  const openThread = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads/${parent.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(openThread.status, 200, "non-member can open the thread after private -> public");
  const threadBody = await openThread.json() as { threadChannelId?: string };
  assert.equal(threadBody.threadChannelId, thread.id, "openThread returns the existing thread channel id");

  // 3. ThreadPanel reply load: history written while private must be readable.
  const threadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(threadMessages.status, 200, "non-member reads thread replies after private -> public");
  const replyBody = await threadMessages.json() as { messages: Array<{ content: string }> };
  assert.ok(
    replyBody.messages.some((m) => m.content === "reply while private"),
    "thread history from the private era is restored on private -> public",
  );
});


test("public -> private conversion prunes historical thread follows outside the private snapshot", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("visibility-thread-owner@slock.test", "visibility-thread-owner");
  const historicalFollower = await seedUser("visibility-thread-follower@slock.test", "visibility-thread-follower");
  const server = await createServer("Visibility Thread Server", "visibility-thread-server", owner.id);
  await addMember(server.id, historicalFollower.id);
  const historicalAgent = await createAgent(server.id, "visibility-thread-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "thread-toggle-room", "convert me");
  await addHuman(channel.id, owner.id);
  const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const publicReply = await createMessage(thread.id, "user", owner.id, "public reply");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: historicalFollower.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: historicalAgent.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]).onConflictDoNothing();

  const ownerToken = await tokenForHuman(owner.email);
  const followerToken = await tokenForHuman(historicalFollower.email);

  const followedBefore = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(followerToken, server.id),
  });
  assert.equal(followedBefore.status, 200);
  const followedBeforeBody = await followedBefore.json() as { threads: Array<{ threadChannelId: string }> };
  assert.ok(
    followedBeforeBody.threads.some((item) => item.threadChannelId === thread.id),
    "historical follower sees the followed thread while the parent is public",
  );

  const toPrivate = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(toPrivate.status, 200);

  const rowsAfterPrivate = await db
    .select({
      followerType: threadFollows.followerType,
      followerId: threadFollows.followerId,
    })
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, thread.id));
  assert.deepEqual(
    rowsAfterPrivate,
    [{ followerType: "user", followerId: owner.id }],
    "public -> private must automatically unfollow historical thread subscribers outside the private snapshot",
  );

  const ownerReply = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: thread.id, content: "private reply" }),
  });
  assert.equal(ownerReply.status, 200, "private-channel member can continue replying in the thread");
  const ownerReplyBody = await ownerReply.json() as { id: string };

  const hiddenThread = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}`, {
    headers: headers(followerToken, server.id),
  });
  // task #48: pruned follow + no residue => no prior relationship the server
  // can witness => non-disclosing 404. Denial itself is unchanged.
  assert.equal(hiddenThread.status, 404, "unfollowed non-member cannot read thread history after public -> private");

  const followedAfter = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(followerToken, server.id),
  });
  assert.equal(followedAfter.status, 200);
  const followedAfterBody = await followedAfter.json() as { threads: Array<{ threadChannelId: string }> };
  assert.ok(
    !followedAfterBody.threads.some((item) => item.threadChannelId === thread.id),
    "unfollowed non-member must not keep seeing the thread in followed threads",
  );

  const inboxAfter = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(followerToken, server.id),
  });
  assert.equal(inboxAfter.status, 200);
  const inboxAfterBody = await inboxAfter.json() as { items: Array<{ threadChannelId?: string | null; parentChannelId?: string | null }> };
  assert.ok(
    !inboxAfterBody.items.some((item) => item.threadChannelId === thread.id || item.parentChannelId === channel.id),
    "unfollowed non-member must not keep seeing the thread in Inbox",
  );

  const unreadAfter = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(followerToken, server.id),
  });
  assert.equal(unreadAfter.status, 200);
  const unreadAfterBody = await unreadAfter.json() as Record<string, number>;
  assert.equal(unreadAfterBody[thread.id], undefined, "unfollowed non-member must not get unread for the thread");

  const syncAfter = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=${publicReply.seq}`, {
    headers: headers(followerToken, server.id),
  });
  assert.equal(syncAfter.status, 200);
  const syncAfterBody = await syncAfter.json() as Array<{ id: string }>;
  assert.ok(
    !syncAfterBody.some((message) => message.id === ownerReplyBody.id),
    "gap sync must not leak new private-thread replies to historical followers",
  );
});


test("GET /channels/:threadId/members returns parent channel members, not thread_follows", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const res = await fetch(`${app.baseUrl}/api/channels/${f.threadId}/members`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { agents: Array<{ id: string }>; humans: Array<{ id: string }> };

  const humanIds = body.humans.map((h) => h.id).sort();
  const agentIds = body.agents.map((a) => a.id).sort();

  // Parent channel membership is the source of truth for /members
  assert.deepEqual(humanIds, [f.ownerId, f.memberBId].sort());
  assert.deepEqual(agentIds, [f.agentAId]);

  // follower and agentB are in thread_follows only — they MUST NOT leak
  // into the members endpoint, otherwise we've re-merged join/follow.
  assert.ok(!humanIds.includes(f.followerId), "follower (follows-only) must not appear in /members");
  assert.ok(!agentIds.includes(f.agentBId), "agentB (follows-only) must not appear in /members");
});


test("GET /internal/agent/:id/channel-members returns parent-channel members for both channel and thread targets", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const { machine, apiKey } = await registerMachine(f.serverId, f.ownerId, "members-daemon");

  await placeAgentOnMachine(f.agentAId, machine.id);
  await placeAgentOnMachine(f.agentBId, machine.id);

  const shortId = f.parentMessageId.slice(0, 8);
  const threadTarget = `#parent-room:${shortId}`;

  async function agentMembers(agentId: string, target: string) {
    const res = await fetch(
      `${app.baseUrl}/internal/agent/${agentId}/channel-members?channel=${encodeURIComponent(target)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    assert.equal(res.status, 200, `expected 200 for ${target}, got ${res.status}`);
    return await res.json() as {
      channel: { ref: string; type: string };
      agents: Array<{ id?: string; name: string }>;
      humans: Array<{ id?: string; name: string; role?: string }>;
    };
  }

  const channelBody = await agentMembers(f.agentAId, "#parent-room");
  const threadBody = await agentMembers(f.agentAId, threadTarget);

  assert.deepEqual(channelBody.channel, { ref: "#parent-room", type: "channel" });
  assert.deepEqual(threadBody.channel, { ref: threadTarget, type: "thread" });

  const expectedHumans = ["member-b", "owner"].sort();
  const expectedAgents = ["agent-a"];

  assert.deepEqual(channelBody.humans.map((h) => h.name).sort(), expectedHumans);
  assert.deepEqual(channelBody.agents.map((a) => a.name).sort(), expectedAgents);
  assert.equal(channelBody.humans.find((h) => h.name === "owner")?.role, "owner");
  assert.equal(channelBody.humans.find((h) => h.name === "member-b")?.role, "member");

  assert.deepEqual(threadBody.humans.map((h) => h.name).sort(), expectedHumans);
  assert.deepEqual(threadBody.agents.map((a) => a.name).sort(), expectedAgents);
  assert.equal(threadBody.humans.find((h) => h.name === "owner")?.role, "owner");
  assert.equal(threadBody.humans.find((h) => h.name === "member-b")?.role, "member");

  assert.ok(
    !threadBody.humans.some((h) => h.name === "follower"),
    "thread followers-only human must not leak into channel-members",
  );
  assert.ok(
    !threadBody.agents.some((a) => a.name === "agent-b"),
    "thread followers-only agent must not leak into channel-members",
  );
});


test("thread channels reject all member-mutation routes with 400", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.ownerToken, f.serverId);

  const mutations: Array<{ method: "POST" | "DELETE"; path: string; body?: unknown }> = [
    { method: "POST", path: `/api/channels/${f.threadId}/members`, body: { memberId: f.memberBId, memberType: "user" } },
    { method: "DELETE", path: `/api/channels/${f.threadId}/members/agent/${f.agentAId}` },
    { method: "DELETE", path: `/api/channels/${f.threadId}/members/user/${f.memberBId}` },
    { method: "POST", path: `/api/channels/${f.threadId}/join` },
    { method: "POST", path: `/api/channels/${f.threadId}/leave` },
  ];

  for (const m of mutations) {
    const res = await fetch(`${app.baseUrl}${m.path}`, {
      method: m.method,
      headers: h,
      body: m.body ? JSON.stringify(m.body) : undefined,
    });
    assert.equal(res.status, 400, `${m.method} ${m.path} should return 400 on thread`);
    const errBody = await res.json() as { error: string };
    assert.match(errBody.error, /follow\/unfollow/i,
      `${m.method} ${m.path} error should mention follow/unfollow (got: ${errBody.error})`);
  }

  // Sanity: runtime did not write any new thread rows to the legacy tables.
  const db = getDb();
  const [{ humanRows, agentRows }] = await Promise.all([
    Promise.resolve().then(async () => ({
      humanRows: await db.select().from(channelHumans).where(eq(channelHumans.channelId, f.threadId)),
      agentRows: await db.select().from(channelAgents).where(eq(channelAgents.channelId, f.threadId)),
    })),
  ]);
  assert.equal(humanRows.length, 0, "thread must not acquire channel_humans rows at runtime");
  assert.equal(agentRows.length, 0, "thread must not acquire channel_agents rows at runtime");
});


test("human/web unfollow suppresses ordinary replies and mentions for non-parent followers", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  let res = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.followerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "ordinary reply after non-author unfollow" }),
  });
  assert.equal(res.status, 200);

  async function getFollowerInbox(filter: "all" | "unread" | "mentions" = "all") {
    const url = new URL(`${app.baseUrl}/api/channels/inbox`);
    url.searchParams.set("filter", filter);
    const inboxRes = await fetch(url, { headers: headers(f.followerToken, f.serverId) });
    assert.equal(inboxRes.status, 200);
    return await inboxRes.json() as {
      items: Array<{
        kind: string;
        threadChannelId?: string;
        firstUnreadMessageId?: string | null;
        unreadCount?: number;
        hasMention?: boolean;
        isFollowing?: boolean;
      }>;
    };
  }

  const ordinaryInbox = await getFollowerInbox();
  const ordinaryRow = ordinaryInbox.items.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  );
  assert.ok(ordinaryRow, "unfollowed/not-done thread must remain in Activity All");
  assert.equal(ordinaryRow.isFollowing, false, "ordinary reply must not restore follow state");
  assert.equal(ordinaryRow.unreadCount, 0);
  assert.equal(ordinaryRow.hasMention, false);
  assert.equal(ordinaryRow.firstUnreadMessageId, null);

  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "ping @follower after unfollow" }),
  });
  assert.equal(res.status, 200);
  await res.json() as { id: string };

  const mentionInbox = await getFollowerInbox("mentions");
  const mentionThreadItem = mentionInbox.items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.equal(
    mentionThreadItem,
    undefined,
    "direct mention must not restore a follower-only target outside the parent channel",
  );
});


test("post authority = parent membership — following a thread does NOT grant permission to send", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  async function send(token: string, channelId: string, content: string) {
    return fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(token, f.serverId),
      body: JSON.stringify({ channelId, content }),
    });
  }

  // follower is in thread_follows but NOT in the parent channel.
  // Listening to the thread must NOT grant posting permission.
  let res = await send(f.followerToken, f.threadId, "hello from a follower-only user");
  assert.equal(res.status, 403, "follower-only user must not be able to post to thread");

  // Same user also cannot post to the parent channel directly — proves
  // that the 403 above is coming from parent-membership, not from some
  // thread-specific quirk.
  res = await send(f.followerToken, f.parentChannelId, "hello from a follower-only user");
  assert.equal(res.status, 403, "follower-only user must not be able to post to parent channel");

  // outsider is in neither parent nor follows — also rejected.
  res = await send(f.outsiderToken, f.threadId, "hello from an outsider");
  assert.equal(res.status, 403, "outsider must not be able to post to thread");

  // Positive control: owner is in parent channel → thread post succeeds.
  res = await send(f.ownerToken, f.threadId, "hello from the owner");
  assert.equal(res.status, 200, "parent-channel member should be able to post to thread");

  // memberB is a parent member but has not followed the thread.
  // Post authority must still allow them to send — listening ≠ posting
  // applies symmetrically in both directions.
  res = await send(f.memberBToken, f.threadId, "hello from memberB");
  assert.equal(res.status, 200, "parent-channel member can post to thread without following");
});


test("agent post authority: /internal/agent/:id/send to thread requires parent-channel membership", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const f = await seedThreadFixture(app.baseUrl);
  const { machine, apiKey } = await registerMachine(f.serverId, f.ownerId, "test-daemon");

  // Both agents must be assigned to this machine for /internal auth to accept them.
  // agentA is in the parent channel; agentB is in thread_follows only.
  await placeAgentOnMachine(f.agentAId, machine.id);
  await placeAgentOnMachine(f.agentBId, machine.id);

  // Thread target in the format the daemon uses: #<channel-name>:<8-hex short id>.
  const shortId = f.parentMessageId.slice(0, 8);
  const threadTarget = `#parent-room:${shortId}`;

  async function agentSend(agentId: string, target: string, content: string) {
    return fetch(`${app.baseUrl}/internal/agent/${agentId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ target, content }),
    });
  }

  // agentB is in thread_follows but NOT in the parent channel.
  // Following a thread must not grant post permission.
  let res = await agentSend(f.agentBId, threadTarget, "bot wants to reply");
  assert.equal(res.status, 403, "agent in follows-only must not post to thread");
  const errBody = await res.json() as { error: string; code?: string };
  // The shared writable-target refusal (agentRouteRefusals.unwritableTargetRefusal).
  assert.equal(errBody.code, "target_forbidden");
  assert.match(
    errBody.error,
    /aren't a member of its channel/,
    `403 error must say the thread's channel needs membership (got: ${errBody.error})`,
  );

  // Positive control: agentA is in the parent channel → thread post succeeds.
  sink.clear();
  res = await agentSend(f.agentAId, threadTarget, "agent in parent posts to thread");
  assert.equal(res.status, 200, "parent-channel agent can post to thread");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/internal/agent/:id/send",
  );
  assert.ok(span, "expected POST /internal/agent/:id/send root span");
  const processEvents = span.events.filter((event) => event.name !== "db.query.finished");
  const processEventNames = processEvents.map((event) => event.name);
  assert.deepEqual(processEventNames.filter((name) => name !== "inbox.serving_row.rebuild"), [
    "agent_send.request.started",
    "agent.ownership.checked",
    "target.resolved",
    "message_pipeline.channel.resolved",
    "message_pipeline.message.persisted",
    "message_pipeline.frontend_emitted",
    "message_pipeline.sender_read_scheduled",
    "message_pipeline.agent_delivery.scheduled",
    "message.sent",
    "response.ready",
    "http.response.finished",
  ]);

  const insertSpan = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.db.query"
    && candidate.context.parentSpanId === span.context.spanId
    && candidate.attrs?.query_name === "messages.insert",
  );
  assert.ok(insertSpan, "expected request-linked messages.insert child span");
  const transactionEvents = insertSpan.events.filter((event) => event.name !== "db.query.finished");
  const transactionEventNames = transactionEvents.map((event) => event.name);
  assert.deepEqual(transactionEventNames.filter((name) =>
    name !== "inbox.notification_fact.decision"
    && name !== "inbox.serving_row.rebuild",
  ), [
    "message_pipeline.db_phase.finished",
    "message_pipeline.db_phase.finished",
    "notification.enqueued",
    "send.facts_fanout.finished",
    "message_pipeline.inbox_notification_facts.recorded",
    "message_pipeline.db_phase.finished",
  ]);
  const transactionDbQueries = transactionEvents
    .filter((event) => event.name === "message_pipeline.db_phase.finished")
    .map((event) => event.attrs?.query_name);
  assert.deepEqual(transactionDbQueries, [
    "thread_follows.eligible_followers",
    "thread_follows.same_send_candidates",
    "messages.direct_send_transaction",
  ]);

  const mobilePushEnqueuedIndex = transactionEventNames.indexOf("notification.enqueued");
  const recordedIndex = transactionEventNames.indexOf("message_pipeline.inbox_notification_facts.recorded");
  const senderReadIndex = processEventNames.indexOf("message_pipeline.sender_read_scheduled");
  assert.ok(mobilePushEnqueuedIndex >= 0);
  assert.ok(recordedIndex > mobilePushEnqueuedIndex);
  assert.ok(senderReadIndex >= 0);
  const deliveryEvent = processEvents.find((event) => event.name === "message_pipeline.agent_delivery.scheduled");
  assert.ok(deliveryEvent, "expected agent delivery to remain scheduled");
  assert.equal(deliveryEvent.attrs?.thread_agent_audience_source, "inbox_facts_precomputed");

  // 2026-09-21 teardown: serving-row increment/rebuild projections are
  // retired; the notification fact decision events remain the recorded
  // write-time verdicts and keep their join-key contract.
  const decisionEvents = transactionEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.name === "inbox.notification_fact.decision");

  assert.ok(decisionEvents.length > 0, "thread send should record notification fact decisions");

  const decisionJoinKeys = decisionEvents.map(({ event }) => event.attrs?.["inbox.trace_join_key"]);
  const targetKeyFromAttrs = (attrs: Record<string, unknown> | undefined) =>
    `${attrs?.receiver_type}:${attrs?.receiver_id}:${attrs?.source_channel_id}`;
  assert.ok(decisionJoinKeys.every((key) => typeof key === "string"));
  assert.ok(decisionEvents.every(({ event }) =>
    event.attrs?.["inbox.trace_join_key"] === `${targetKeyFromAttrs(event.attrs)}:${event.attrs?.message_id}`,
  ));

  const targetEvent = span.events.find((event) => event.name === "target.resolved");
  assert.ok(targetEvent);
  assert.equal(targetEvent.attrs?.target_kind, "thread");
  assert.equal(targetEvent.attrs?.outcome, "resolved");
  assert.equal(targetEvent.attrs?.channel_type, "thread");

  const sentEvent = span.events.find((event) => event.name === "message.sent");
  assert.ok(sentEvent);
  assert.equal(sentEvent.attrs?.channel_type, "thread");
  assert.equal(sentEvent.attrs?.message_id_present, true);
  // The sent message and its conversation as keyed hashes, never raw ids.
  const sentBody = await res.json() as { messageId: string };
  assert.equal(sentEvent.attrs?.message_id_hash, traceIdentityHash("message_id_hash", sentBody.messageId));
  assert.equal(sentEvent.attrs?.conversation_id_hash, traceIdentityHash("conversation_id_hash", f.threadId));
  assert.equal(Object.values(sentEvent.attrs ?? {}).includes(sentBody.messageId), false);
  assert.equal(Object.values(sentEvent.attrs ?? {}).includes(f.threadId), false);
  assert.equal(sentEvent.attrs?.attachments_count, 0);

  assert.equal(Object.values(span.attrs ?? {}).includes(f.agentAId), false);
  assert.equal(Object.values(targetEvent.attrs ?? {}).includes(f.threadId), false);
  assert.equal(Object.values(sentEvent.attrs ?? {}).includes(f.parentMessageId), false);
});


test("mention in thread auto-follows the mentioned user and agent (reason='mentioned')", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  // Sanity: memberB (human) and agentA (agent) are parent-channel members
  // but NOT yet thread_follows entries.
  const beforeRows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));
  assert.ok(
    !beforeRows.some((r) => r.followerType === "user" && r.followerId === f.memberBId),
    "precondition: memberB should not yet follow the thread",
  );
  assert.ok(
    !beforeRows.some((r) => r.followerType === "agent" && r.followerId === f.agentAId),
    "precondition: agentA should not yet follow the thread",
  );

  // Owner (parent member + thread follower via creation) posts a reply
  // mentioning both memberB and agentA.
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({
      channelId: f.threadId,
      content: "pinging @member-b and @agent-a here",
    }),
  });
  assert.equal(res.status, 200, "mention-bearing message should send");

  const afterRows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));

  const memberBFollow = afterRows.find(
    (r) => r.followerType === "user" && r.followerId === f.memberBId,
  );
  assert.ok(memberBFollow, "mentioned human must be auto-added to thread_follows");
  assert.equal(
    memberBFollow!.reason,
    "mentioned",
    "mention-follow for user must record reason='mentioned'",
  );

  const agentAFollow = afterRows.find(
    (r) => r.followerType === "agent" && r.followerId === f.agentAId,
  );
  assert.ok(agentAFollow, "mentioned agent must be auto-added to thread_follows");
  assert.equal(
    agentAFollow!.reason,
    "mentioned",
    "mention-follow for agent must record reason='mentioned'",
  );

  // Outsider (not in the parent channel, not followed) was not mentioned.
  // Must NOT appear in thread_follows — mentions are the only trigger tested here.
  assert.ok(
    !afterRows.some((r) => r.followerType === "user" && r.followerId === f.outsiderId),
    "unmentioned outsider must not be auto-followed",
  );
});


test("creating a thread channel without a reply writes NO thread_follows rows", async ({ app }) => {
  // The web view path is now a read-only GET and does not call this service.
  // Keep the lower-level writer contract pinned too: a create-or-get without
  // a durable reply is not participation and must not auto-follow the caller.

  const db = getDb();

  const [author] = await db.insert(users).values({
    email: "author@slock.test",
    name: "author",
    displayName: "Author",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [viewer] = await db.insert(users).values({
    email: "viewer@slock.test",
    name: "viewer",
    displayName: "Viewer",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Lazy Open", "lazy-open", author.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: viewer.id, role: "member" });

  const parent = await createChannel(server.id, "room");
  await addHuman(parent.id, author.id);
  await addHuman(parent.id, viewer.id);

  const parentMessage = await createMessage(parent.id, "user", author.id, "original");

  // Exercise the explicit create-or-get writer without posting a reply.
  const thread = await getOrCreateThread(parentMessage.id, viewer.id, "user");

  const rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, thread.id));

  assert.equal(
    rows.length,
    0,
    "creating without a reply must not write thread_follows rows",
  );
});


test("POST /api/channels/:id/threads creates an empty thread without auto-following the viewer", async ({ app }) => {
  const db = getDb();

  const [author] = await db.insert(users).values({
    email: "author-open@slock.test",
    name: "author-open",
    displayName: "Author Open",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [viewer] = await db.insert(users).values({
    email: "viewer-open@slock.test",
    name: "viewer-open",
    displayName: "Viewer Open",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Open Thread Route", "open-thread-route", author.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: viewer.id, role: "member" });

  const parent = await createChannel(server.id, "room");
  await addHuman(parent.id, author.id);
  await addHuman(parent.id, viewer.id);

  const parentMessage = await createMessage(parent.id, "user", author.id, "original");

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "viewer-open@slock.test", password: "password123" }),
  });
  assert.equal(login.status, 200);
  const viewerToken = (await login.json() as { accessToken: string }).accessToken;

  const res = await fetch(`${app.baseUrl}/api/channels/${parent.id}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${viewerToken}`,
      "X-Server-Id": server.id,
    },
    body: JSON.stringify({ parentMessageId: parentMessage.id }),
  });
  assert.equal(res.status, 200);
  const data = await res.json() as {
    threadChannelId: string;
    replyCount: number;
    lastReplyAt: string | null;
    participantIds: string[];
  };

  assert.ok(data.threadChannelId, "route must return a threadChannelId for first-reply UX");
  assert.equal(data.replyCount, 0);
  assert.equal(data.lastReplyAt, null);
  assert.deepEqual(data.participantIds, []);

  const rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, data.threadChannelId));

  assert.equal(rows.length, 0, "open-only POST must not auto-follow the viewer");
});


test("POST /api/channels/:id/threads rejects a missing JSON body without a fast 500", async ({ app }) => {
  const owner = await seedUser("thread-open-missing-body@slock.test", "thread-open-missing-body");
  const server = await createServer("Thread Open Missing Body", "thread-open-missing-body", owner.id);
  const channel = await createChannel(server.id, "room");
  await addHuman(channel.id, owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "parentMessageId is required" });
});


test("POST /api/channels/:id/threads rejects parent messages outside the requested channel", async ({ app }) => {
  const owner = await seedUser("thread-open-parent-scope@slock.test", "thread-open-parent-scope");
  const server = await createServer("Thread Open Parent Scope", "thread-open-parent-scope", owner.id);
  const channel = await createChannel(server.id, "room");
  const otherChannel = await createChannel(server.id, "other-room");
  await addHuman(channel.id, owner.id);
  await addHuman(otherChannel.id, owner.id);
  const otherParent = await createMessage(otherChannel.id, "user", owner.id, "parent from another channel");
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ parentMessageId: otherParent.id }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Parent message not found" });
});


test("first reply in a thread writes sender='replied' and parent author='authored'", async ({ app }) => {
  const db = getDb();
  const events = installFakeIo(app.app);

  const [author] = await db.insert(users).values({
    email: "author@slock.test",
    name: "author",
    displayName: "Author",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [replier] = await db.insert(users).values({
    email: "replier@slock.test",
    name: "replier",
    displayName: "Replier",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Reply Follow", "reply-follow", author.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: replier.id, role: "member" });

  const parent = await createChannel(server.id, "room");
  await addHuman(parent.id, author.id);
  await addHuman(parent.id, replier.id);

  const parentMessage = await createMessage(parent.id, "user", author.id, "original");

  async function login(email: string): Promise<string> {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    assert.equal(res.status, 200);
    return (await res.json() as { accessToken: string }).accessToken;
  }
  const replierToken = await login("replier@slock.test");

  // Replier sends the first reply in one atomic call — creates the thread
  // and posts the first message via the reply-broadcast path.
  const res = await fetch(`${app.baseUrl}/api/channels/${parent.id}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${replierToken}`,
      "X-Server-Id": server.id,
    },
    body: JSON.stringify({ parentMessageId: parentMessage.id, content: "first reply" }),
  });
  assert.equal(res.status, 200, "first reply should succeed");
  const threadData = await res.json() as { threadChannelId: string };

  const rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, threadData.threadChannelId));

  const replierRow = rows.find((r) => r.followerType === "user" && r.followerId === replier.id);
  assert.ok(replierRow, "reply sender must be auto-followed");
  assert.equal(replierRow!.reason, "replied", "sender follow reason should be 'replied'");

  const authorRow = rows.find((r) => r.followerType === "user" && r.followerId === author.id);
  assert.ok(authorRow, "parent-message author must be auto-followed on first reply");
  assert.equal(authorRow!.reason, "authored", "parent-author follow reason should be 'authored'");

  const threadRoom = `channel:${threadData.threadChannelId}`;
  const authorJoinIndex = events.findIndex(
    (event) =>
      event.event === "socketsJoin" &&
      event.room === `user:${author.id}:server:${server.id}` &&
      (event.payload as { room?: string }).room === threadRoom,
  );
  const messageNewIndex = events.findIndex(
    (event) => event.event === "message:new" && event.room === threadRoom,
  );
  assert.ok(authorJoinIndex >= 0, "parent author must be joined to the thread room for the first reply broadcast");
  assert.ok(messageNewIndex >= 0, "first reply must be emitted to the public thread room");
  assert.ok(authorJoinIndex < messageNewIndex, "parent author follow must be established before message:new is emitted");
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `user:${author.id}`),
    "public thread replies should use the access-checked thread room instead of follower-only direct emits",
  );
});


test("POST /api/channels/:id/threads applies the message posting gate to the first reply", async ({ app }) => {
  const db = getDb();
  const events = installFakeIo(app.app);
  const f = await seedThreadFixture(app.baseUrl);
  // A parent message with no thread yet: a refused first reply must leave no
  // thread channel behind, not just no message.
  const parentMessage = await createMessage(f.parentChannelId, "user", f.ownerId, "gated parent");
  const url = `${app.baseUrl}/api/channels/${f.parentChannelId}/threads`;
  const threadRows = () => db.select({ id: channels.id }).from(channels).where(eq(channels.parentMessageId, parentMessage.id));

  // follower is a server member who has not joined the public parent channel:
  // reading is allowed, posting is refused exactly like POST /api/messages.
  let res = await fetch(url, {
    method: "POST",
    headers: headers(f.followerToken, f.serverId),
    body: JSON.stringify({ parentMessageId: parentMessage.id, content: "reply from a non-member" }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "You must join this channel to send messages" });
  assert.equal((await threadRows()).length, 0, "a refused first reply must not materialize the thread");
  assert.equal(events.some((event) => event.event === "message:new"), false, "a refused first reply must not broadcast");

  res = await fetch(url, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ parentMessageId: parentMessage.id, content: "x".repeat(32_001) }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Message content exceeds maximum length of 32000 characters" });
  assert.equal((await threadRows()).length, 0, "over-length content is refused before the thread exists");

  res = await fetch(url, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ parentMessageId: parentMessage.id, content: "reply from a joined member" }),
  });
  assert.equal(res.status, 200, "a joined member still posts the first reply");
  const created = await res.json() as { threadChannelId: string; replyCount: number };
  assert.equal(created.replyCount, 1);
  const replies = await db.select({ content: messages.content }).from(messages).where(eq(messages.channelId, created.threadChannelId));
  assert.deepEqual(replies.map((row) => row.content), ["reply from a joined member"]);
  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `channel:${created.threadChannelId}`),
    "the accepted first reply is still broadcast to the thread room",
  );

  // Without content the route only opens the thread, which stays available to
  // anyone who can read the channel.
  const openOnlyParent = await createMessage(f.parentChannelId, "user", f.ownerId, "open-only parent");
  res = await fetch(url, {
    method: "POST",
    headers: headers(f.followerToken, f.serverId),
    body: JSON.stringify({ parentMessageId: openOnlyParent.id }),
  });
  assert.equal(res.status, 200, "a non-member reader may still open a thread without posting");
  assert.equal((await res.json() as { replyCount: number }).replyCount, 0);
});


test("new thread message clears doneAt for existing followers (unread reactivation)", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  // Owner marks the thread done.
  let res = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(res.status, 200);

  const doneRow = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));
  const ownerDone = doneRow.find(
    (r) => r.followerType === "user" && r.followerId === f.ownerId,
  );
  assert.ok(ownerDone?.doneAt, "owner's thread follow should have doneAt set after /done");

  // memberB (parent member) sends a new message to the thread.
  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "new activity" }),
  });
  assert.equal(res.status, 200, "parent member should be able to post to thread");

  // doneAt must be cleared — the follower is unread again.
  const afterRow = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));
  const ownerAfter = afterRow.find(
    (r) => r.followerType === "user" && r.followerId === f.ownerId,
  );
  assert.equal(
    ownerAfter?.doneAt,
    null,
    "new activity must clear doneAt for existing followers",
  );
});


test("DM thread mention auto-follow is private-scoped: outsiders cannot be pulled in", async ({ app }) => {
  const db = getDb();

  // DM participants
  const [dmUser] = await db.insert(users).values({
    email: "dm-user@slock.test",
    name: "dm-user",
    displayName: "DM User",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  // Outsiders — on the server but NOT in the DM.
  const [outsiderUser] = await db.insert(users).values({
    email: "dm-outsider@slock.test",
    name: "dm-outsider",
    displayName: "DM Outsider",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("DM Mention Scope", "dm-mention", dmUser.id);
  await db.insert(serverMembers).values({
    serverId: server.id, userId: outsiderUser.id, role: "member",
  });

  const dmAgent = await createAgent(server.id, "dm-agent", { runtime: "codex" });
  const outsiderAgent = await createAgent(server.id, "dm-outsider-agent", { runtime: "codex" });

  const dm = await findOrCreateDM(server.id, dmUser.id, dmAgent.id);
  assert.ok(dm, "DM should be created");

  // Parent message in the DM, thread derived from it.
  const parentMessage = await createMessage(dm!.id, "user", dmUser.id, "private hi");
  const thread = await getOrCreateThread(parentMessage.id, dmUser.id, "user");



  const dmUserToken = await tokenForHuman("dm-user@slock.test");

  // DM participant mentions both an outsider human and an outsider agent
  // inside the DM thread. Neither is in the parent DM — private scope must
  // hold: they should NOT be auto-followed into thread_follows.
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${dmUserToken}`,
      "X-Server-Id": server.id,
    },
    body: JSON.stringify({
      channelId: thread.id,
      content: "trying to pull in @dm-outsider and @dm-outsider-agent",
    }),
  });
  assert.equal(res.status, 200, "DM participant should be able to post to their own DM thread");

  const rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, thread.id));

  assert.ok(
    !rows.some((r) => r.followerType === "user" && r.followerId === outsiderUser.id),
    "outsider human must not be auto-followed into a DM thread",
  );
  assert.ok(
    !rows.some((r) => r.followerType === "agent" && r.followerId === outsiderAgent.id),
    "outsider agent must not be auto-followed into a DM thread",
  );

  // Positive control: the DM agent (a parent DM participant) IS a valid
  // mention target — but we didn't mention them here, so they remain
  // followed only via the creation path (reason='authored' if applicable),
  // not via mention.
  const outsiderRows = rows.filter(
    (r) =>
      (r.followerType === "user" && r.followerId === outsiderUser.id) ||
      (r.followerType === "agent" && r.followerId === outsiderAgent.id),
  );
  assert.equal(
    outsiderRows.length,
    0,
    "no outsider rows at all — DM threads are a closed private scope for mention auto-follow",
  );
});


test("private channel thread mention auto-follow is bounded by parent private membership", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-thread-owner@slock.test", "private-thread-owner");
  const outsider = await seedUser("private-thread-outsider@slock.test", "private-thread-outsider");
  const server = await createServer("Private Thread Mention Scope", "private-thread-mention", owner.id);
  await addMember(server.id, outsider.id);
  const outsiderAgent = await createAgent(server.id, "private-thread-outsider-agent", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "private-thread-parent", "invite-only parent", "private");
  await addHuman(privateChannel.id, owner.id);

  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const ownerToken = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      channelId: thread.id,
      content: "trying to pull in @private-thread-outsider and @private-thread-outsider-agent",
    }),
  });
  assert.equal(res.status, 200, "private channel member should be able to post to its thread");

  const rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, thread.id));

  assert.ok(
    !rows.some((r) => r.followerType === "user" && r.followerId === outsider.id),
    "outsider human must not be auto-followed into a private-channel thread",
  );
  assert.ok(
    !rows.some((r) => r.followerType === "agent" && r.followerId === outsiderAgent.id),
    "outsider agent must not be auto-followed into a private-channel thread",
  );
});


test("manual thread follow cloaks private parent messages from non-members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("manual-private-thread-owner@slock.test", "manual-private-thread-owner");
  const outsider = await seedUser("manual-private-thread-outsider@slock.test", "manual-private-thread-outsider");
  const server = await createServer("Manual Private Thread Scope", "manual-private-thread-scope", owner.id);
  await addMember(server.id, outsider.id);
  const privateChannel = await createChannel(server.id, "manual-private-thread-parent", "invite-only parent", "private");
  await addHuman(privateChannel.id, owner.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");

  const outsiderToken = await (async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: outsider.email, password: "password123" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json() as { accessToken: string };
    return data.accessToken;
  })();

  let res = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
    body: JSON.stringify({ parentMessageId: parentMessage.id }),
  });
  assert.equal(res.status, 404, "private parent message must be cloaked from non-members");

  for (const path of ["unfollow", "done", "undone"]) {
    res = await fetch(`${app.baseUrl}/api/channels/threads/${path}`, {
      method: "POST",
      headers: headers(outsiderToken, server.id),
      body: JSON.stringify({ threadChannelId: thread.id }),
    });
    assert.equal(res.status, 404, `private thread ${path} must be cloaked from non-members`);
  }

  const rows = await db
    .select()
    .from(threadFollows)
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, outsider.id)));
  assert.equal(rows.length, 0, "manual follow must not create private-thread follow rows for non-members");
});


test("removing a private parent member preserves thread follows but blocks stale socket delivery", async ({ app }) => {
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
  const events = installFakeIo(app.app);
  const owner = await seedUser("private-thread-remove-owner@slock.test", "private-thread-remove-owner");
  const member = await seedUser("private-thread-remove-member@slock.test", "private-thread-remove-member");
  const server = await createServer("Private Thread Remove", "private-thread-remove", owner.id);
  await addMember(server.id, member.id);
  const privateChannel = await createChannel(server.id, "private-thread-remove-parent", "invite-only parent", "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, member.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: member.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);

  await removeHuman(privateChannel.id, member.id, { self: true });

  const memberFollowRows = await db
    .select()
    .from(threadFollows)
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.equal(memberFollowRows.length, 1, "removing a private parent member should preserve thread follow attention state");

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: thread.id, content: "private reply after removal" }),
  });
  assert.equal(res.status, 200);

  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `user:${owner.id}`),
    "remaining private parent member should still receive thread replies",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `user:${member.id}`),
    "removed private parent member must not receive thread replies through a stale follow or socket room",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `channel:${thread.id}`),
    "private thread replies must not broadcast to the thread room where stale sockets may remain",
  );

  // Notifications have one audience, the outbox (services/notifications/enqueue.ts):
  // the stale private-thread follower gets no row, the remaining member does.
  const { id: replyId } = await res.json() as { id: string };
  const outboxReceivers = (await db.select({ receiverId: notificationOutbox.receiverId }).from(notificationOutbox)
    .where(eq(notificationOutbox.messageId, replyId))).map((row) => row.receiverId);
  assert.ok(!outboxReceivers.includes(member.id), "stale private-thread follower must not be a notification target");
});


test("removing public parent members preserves their human and agent thread follows", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("public-thread-remove-owner@slock.test", "public-thread-remove-owner");
  const member = await seedUser("public-thread-remove-member@slock.test", "public-thread-remove-member");
  const server = await createServer("Public Thread Remove", "public-thread-remove", owner.id);
  await addMember(server.id, member.id);
  const agent = await createAgent(server.id, "public-thread-remove-agent", { runtime: "codex" });
  const publicChannel = await createChannel(server.id, "public-thread-remove-parent", "public parent");
  await addHuman(publicChannel.id, owner.id);
  await addHuman(publicChannel.id, member.id);
  await addAgent(publicChannel.id, agent.id);
  const peerAgent = await createAgent(server.id, "public-thread-remove-peer-agent", { runtime: "codex" });
  await addAgent(publicChannel.id, peerAgent.id);
  const parentMessage = await createMessage(publicChannel.id, "user", owner.id, "public parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: member.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: agent.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: peerAgent.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);

  await removeHuman(publicChannel.id, member.id, { self: true });
  await removeAgent(publicChannel.id, agent.id);

  const rows = await db
    .select({
      followerType: threadFollows.followerType,
      followerId: threadFollows.followerId,
    })
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, thread.id));

  assert.deepEqual(
    rows,
    [
      { followerType: "user", followerId: owner.id },
      { followerType: "user", followerId: member.id },
      { followerType: "agent", followerId: agent.id },
      { followerType: "agent", followerId: peerAgent.id },
    ],
    "leaving a public parent channel should preserve child-thread follows because public threads remain readable",
  );
});


test("public to private conversion traces stale thread-follow prune phase", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "3".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const db = getDb();
  const owner = await seedUser("remove-prune-trace-owner@slock.test", "remove-prune-trace-owner");
  const member = await seedUser("remove-prune-trace-member@slock.test", "remove-prune-trace-member");
  const server = await createServer("Remove Prune Trace", "remove-prune-trace", owner.id);
  await addMember(server.id, member.id);
  const traceAgent = await createAgent(server.id, "remove-prune-trace-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "remove-prune-trace-parent", "public parent");
  await addHuman(channel.id, owner.id);
  const parentMessage = await createMessage(channel.id, "user", owner.id, "public parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: member.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: traceAgent.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);
  const ownerToken = await tokenForHuman(owner.email);

  sink.clear();
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(res.status, 200);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.events.some((event) => event.name === "thread_follows.pruned_outside_parent_membership"),
  );
  assert.ok(span, "expected channel visibility conversion request span");
  const pruneEvent = span.events.find((event) => event.name === "thread_follows.pruned_outside_parent_membership");
  assert.ok(pruneEvent, "expected stale thread-follow prune trace event");
  assert.equal(pruneEvent.attrs?.phase, "channel_visibility.private_conversion");
  assert.equal(pruneEvent.attrs?.user_row_count, 1);
  assert.equal(pruneEvent.attrs?.agent_row_count, 1);
  assert.equal(pruneEvent.attrs?.row_count, 2);
  assert.equal(pruneEvent.attrs?.scope_count, 1, "one thread under the converted channel");
  assert.equal(typeof pruneEvent.attrs?.duration_ms, "number");
});


test("private task thread system messages do not leak through stale thread rooms", async ({ app }) => {
  const db = getDb();
  const events = installFakeIo(app.app);
  const owner = await seedUser("private-task-system-owner@slock.test", "private-task-system-owner");
  const member = await seedUser("private-task-system-member@slock.test", "private-task-system-member");
  const server = await createServer("Private Task System", "private-task-system", owner.id);
  await addMember(server.id, member.id);
  const privateChannel = await createChannel(server.id, "private-task-system-parent", "invite-only tasks", "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, member.id);
  const { tasks: [task] } = await taskService.createTasks(privateChannel.id, "user", owner.id, [{ title: "private task" }]);
  // v1.4: the thread anchors on the host message, which is no longer the task id.
  const thread = await getOrCreateThread(task.messageId, owner.id, "user");
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: task.messageId,
      reason: "authored",
    },
    {
      threadChannelId: thread.id,
      followerType: "user",
      followerId: member.id,
      parentMessageId: task.messageId,
      reason: "manual",
    },
  ]);

  const claimed = await taskService.claimTask(task.id, "user", owner.id);
  assert.notEqual(typeof claimed, "string");

  await removeHuman(privateChannel.id, member.id, { self: true });
  events.length = 0;

  const ownerToken = await tokenForHuman(owner.email);
  const statusRes = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ status: "in_review" }),
  });
  assert.equal(statusRes.status, 200);

  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `user:${owner.id}`),
    "remaining private parent member should receive task lifecycle system messages",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `user:${member.id}`),
    "removed private parent member must not receive task lifecycle system messages directly",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `channel:${thread.id}`),
    "thread system messages must not broadcast to the stale thread room",
  );
});


test("removing a server member prunes their private thread follows", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("server-remove-thread-owner@slock.test", "server-remove-thread-owner");
  const member = await seedUser("server-remove-thread-member@slock.test", "server-remove-thread-member");
  const server = await createServer("Server Remove Thread", "server-remove-thread", owner.id);
  await addMember(server.id, member.id);
  const privateChannel = await createChannel(server.id, "server-remove-thread-parent", "invite-only parent", "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, member.id);
  const parentMessage = await createMessage(privateChannel.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: member.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  });

  await removeMember(server.id, member.id);

  const rows = await db
    .select()
    .from(threadFollows)
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, member.id)));
  assert.equal(rows.length, 0, "server removal should prune private thread follows for that user");
});


test("Activity Done history lists and restores channel and thread rows", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const channelActivity = await createMessage(
    f.parentChannelId,
    "user",
    f.memberBId,
    "channel activity that can move between Active and Done",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: channelActivity,
  });
  const threadActivity = await createMessage(
    f.threadId,
    "user",
    f.memberBId,
    "thread activity that can move between Active and Done",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadActivity,
  });

  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await channelDoneBody(f.parentChannelId)),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=30`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const done = await response.json() as {
    items: Array<{ kind: string; channelId?: string; threadChannelId?: string; doneAt?: string }>;
    hasMore: boolean;
    totalCount: null;
  };
  assert.ok(done.items.some((item) => item.kind === "channel" && item.channelId === f.parentChannelId));
  assert.ok(done.items.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId));
  assert.ok(done.items.every((item) => typeof item.doneAt === "string"));
  assert.equal(done.hasMore, false);
  assert.equal(done.totalCount, null, "Done history does not pretend to expose an exact global count");

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=30&sort=asc`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const oldestDone = await response.json() as typeof done;
  const doneIdentity = (item: (typeof done.items)[number]) => item.kind === "thread" ? `thread:${item.threadChannelId}` : `${item.kind}:${item.channelId}`;
  assert.deepEqual(
    oldestDone.items.map(doneIdentity),
    done.items.map(doneIdentity).reverse(),
    "sort=asc must reverse the combined channel/thread Done order before pagination",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?q=thread%20activity`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const searchedDone = await response.json() as { items: Array<{ kind: string; channelId?: string; threadChannelId?: string }> };
  assert.deepEqual(
    searchedDone.items.map((item) => item.kind),
    ["thread"],
    "Done free-text search should filter rows before the combined page is sliced",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?channelId=${f.parentChannelId}&q=channel%20activity&limit=1`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const scopedDone = await response.json() as { items: Array<{ kind: string; channelId?: string }>; hasMore: boolean };
  assert.deepEqual(scopedDone.items.map((item) => item.channelId), [f.parentChannelId]);
  assert.equal(scopedDone.hasMore, false);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/undone`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ channelId: f.parentChannelId }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/channels/threads/undone`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const restoredDone = await response.json() as { items: Array<{ channelId?: string; threadChannelId?: string }> };
  assert.ok(!restoredDone.items.some((item) => item.channelId === f.parentChannelId));
  assert.ok(!restoredDone.items.some((item) => item.threadChannelId === f.threadId));

  const active = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.ok(active.some((item) => item.kind === "channel" && item.channelId === f.parentChannelId));
  assert.ok(active.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId));

  const suppressions = await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    inArray(inboxSuppressionStates.targetChannelId, [f.parentChannelId, f.threadId]),
  ));
  assert.equal(suppressions.length, 0, "restoring Active clears durable Done suppression for both row kinds");
});


test("Thread Done retires only caller-owned Activity residue after the thread source is deleted", async ({ app }) => {
  const db = getDb();
  const f = await seedThreadFixture(app.baseUrl);
  const requestHeaders = headers(f.ownerToken, f.serverId);
  const outsiderHeaders = headers(f.outsiderToken, f.serverId);
  const receiverMessage = await createMessage(
    f.threadId,
    "user",
    f.memberBId,
    "receiver-owned deleted thread Activity residue",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: receiverMessage,
    personalMention: true,
  });
  const laterSourceMessage = await createMessage(
    f.threadId,
    "user",
    f.memberBId,
    "must remain beyond the receiver-owned residue boundary",
  );
  assert.ok(laterSourceMessage.seq > receiverMessage.seq);
  assert.equal(
    (await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, f.ownerId),
      eq(inboxNotificationFacts.sourceChannelId, f.threadId),
    ))).length,
    1,
    "fixture must expose one receiver-owned notification fact as Activity residue",
  );

  await deleteChannel(f.threadId);

  const malformed = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: f.threadId,
      throughActivitySeq: null,
      frontierSpace: "storage",
    }),
  });
  assert.equal(malformed.status, 400, "deleted-target compatibility must preserve strict explicit-frontier validation");
  assert.equal(((await malformed.json()) as { code?: string }).code, "DONE_FRONTIER_REQUIRED");

  const legacyFallbackBefore = await legacyDoneFallbackCount("thread");
  const outsider = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: outsiderHeaders,
    body: JSON.stringify({ threadChannelId: f.threadId, frontierSpace: "storage" }),
  });
  assert.equal(outsider.status, 404, "a deleted thread stays opaque without caller-owned Activity evidence");
  assert.equal(
    (await db.select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, f.outsiderId),
      eq(userChannelReadCursors.channelId, f.threadId),
    ))).length,
    0,
    "an arbitrary caller must not gain a read cursor from the compatibility path",
  );

  const done = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ threadChannelId: f.threadId, frontierSpace: "storage" }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  // Task #67: activity-v1 declares this 200 as `{ ok: true }` and forbids extra
  // properties, so the response is asserted EXACTLY -- a regression that puts the
  // compatibility receipt back on the wire fails here. The retirement boundary it
  // used to carry is asserted below on the caller's cursor row, and against
  // channelService directly where the cursor cannot distinguish the cases.
  assert.deepEqual(await done.json(), { ok: true });
  assert.equal(
    await legacyDoneFallbackCount("thread"),
    legacyFallbackBefore + 2,
    "omitted-frontier compatibility is counted at admission, including denied residue attempts",
  );

  const [cursor] = await db.select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, f.ownerId),
    eq(userChannelReadCursors.channelId, f.threadId),
  ));
  assert.equal(
    cursor?.lastReadSeq,
    receiverMessage.seq,
    "deleted-thread Done must stop at caller-owned evidence rather than the deleted source max",
  );
  // Task #67: readStateVersion used to ride on the response body; it is persisted
  // here, so the durable surface keeps it under assertion.
  assert.equal(cursor?.readStateVersion, 1, "the retirement must bump the caller's read-state version exactly once");
  assert.equal(
    (await db.select().from(inboxSuppressionStates).where(and(
      eq(inboxSuppressionStates.receiverType, "user"),
      eq(inboxSuppressionStates.receiverId, f.ownerId),
      eq(inboxSuppressionStates.targetChannelId, f.threadId),
    ))).length,
    0,
    "a deleted source has no suppression target and must not gain a synthetic one",
  );

  const explicitReplay = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: f.threadId,
      throughActivitySeq: laterSourceMessage.seq.toString(),
      frontierSpace: "storage",
    }),
  });
  assert.equal(explicitReplay.status, 200, await explicitReplay.clone().text());
  assert.deepEqual(await explicitReplay.json(), { ok: true });
  // Task #67: the wire no longer carries the boundary, so the invariant it used to
  // guard is asserted where it still lives. This call is idempotent (changed:false),
  // so re-running it here observes without mutating.
  assert.deepEqual(
    await retireDeletedThreadDoneResidue(f.ownerId, f.threadId, laterSourceMessage.seq.toString()),
    {
      terminalReason: "legacy_done_target_unavailable",
      legacyNoop: true,
      retiredThroughActivitySeq: receiverMessage.seq,
      readStateVersion: 1,
      changed: false,
    },
    "the retirement boundary must stay at the caller's own evidence, not echo an untrusted frontier",
  );
  assert.equal(
    await legacyDoneFallbackCount("thread"),
    legacyFallbackBefore + 2,
    "an explicit frontier must not increment the omitted-frontier compatibility counter",
  );

  // A read cursor proves that this caller could once reach the thread, but
  // the current schema cannot durably distinguish "read before deletion"
  // from "already retired by a prior compatibility Done". Both converge on
  // an idempotent 200 rather than turning a successful retry into an error.
  const cursorOnlyParent = await createMessage(
    f.parentChannelId,
    "user",
    f.ownerId,
    "cursor-only deleted thread parent",
  );
  const cursorOnlyThread = await getOrCreateThread(cursorOnlyParent.id, f.ownerId, "user");
  const cursorOnlyMessage = await createMessage(
    cursorOnlyThread.id,
    "user",
    f.memberBId,
    "cursor-only deleted thread message",
  );
  const cursorOnlyRead = await markReadLatest(f.ownerId, cursorOnlyThread.id);
  assert.equal(cursorOnlyRead.maxReadSeq, cursorOnlyMessage.seq);
  assert.equal(cursorOnlyRead.changed, true);
  assert.equal(
    (await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, f.ownerId),
      eq(inboxNotificationFacts.sourceChannelId, cursorOnlyThread.id),
    ))).length,
    0,
    "cursor-only fixture must never have had an Activity fact to retire",
  );
  await deleteChannel(cursorOnlyThread.id);

  const cursorOnlyDone = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: cursorOnlyThread.id,
      throughActivitySeq: cursorOnlyMessage.seq.toString(),
      frontierSpace: "storage",
    }),
  });
  assert.equal(cursorOnlyDone.status, 200, await cursorOnlyDone.clone().text());
  // Task #64: a residue boundary never reads the caller's cursor, because the
  // pre-fix defect could have written a live frontier into it and the schema
  // cannot tell that apart from an honest read. With no notification rows or
  // facts, the receiver-owned boundary is 0, so the receipt reports 0 rather
  // than echoing the cursor. The retry stays an idempotent 200 with no change.
  assert.deepEqual(await cursorOnlyDone.json(), { ok: true });
  // Task #67: this is the one case the cursor row cannot witness -- the cursor
  // already sits at cursorOnlyMessage.seq, so "reported 0" and "echoed the cursor"
  // leave identical rows. Asserting it against the service keeps the #64 invariant
  // observable; deleting it would trade a contract breach for a coverage hole.
  assert.deepEqual(
    await retireDeletedThreadDoneResidue(f.ownerId, cursorOnlyThread.id, cursorOnlyMessage.seq.toString()),
    {
      terminalReason: "legacy_done_target_unavailable",
      legacyNoop: true,
      retiredThroughActivitySeq: 0,
      readStateVersion: 1,
      changed: false,
    },
    "a residue boundary must never read the caller's cursor",
  );

  const nonexistent = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ threadChannelId: randomUUID(), frontierSpace: "storage" }),
  });
  assert.equal(nonexistent.status, 404, "an arbitrary nonexistent id must not become unconditional success");
});


test("unread summary folds followed-thread unread onto parent channels, and followed threads carry hasMention", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("thread-unread-owner@slock.test", "thread-unread-owner");
  const replier = await seedUser("thread-unread-replier@slock.test", "thread-unread-replier");
  const server = await createServer("Thread Unread Server", "thread-unread-server", owner.id);
  await addMember(server.id, replier.id);
  const quiet = await createChannel(server.id, "thread-unread-quiet");
  const other = await createChannel(server.id, "thread-unread-other");
  for (const channel of [quiet, other]) {
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, replier.id);
  }

  async function followedThread(channelId: string, label: string, opts: { follow?: boolean; done?: boolean } = {}) {
    const parent = await createMessage(channelId, "user", owner.id, `${label} parent`);
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    if (opts.follow !== false) {
      await db.insert(threadFollows).values({
        threadChannelId: thread.id,
        followerType: "user",
        followerId: owner.id,
        parentMessageId: parent.id,
        reason: "manual",
        ...(opts.done ? { doneAt: new Date() } : {}),
      });
    }
    return thread;
  }

  // `quiet` has no unread of its own (the owner wrote every top-level message).
  const mentioned = await followedThread(quiet.id, "mentioned");
  const plain = await followedThread(quiet.id, "plain");
  const allRead = await followedThread(quiet.id, "all read");
  const done = await followedThread(quiet.id, "done", { done: true });
  const notFollowed = await followedThread(quiet.id, "not followed", { follow: false });
  const otherThread = await followedThread(other.id, "other");

  const mention = await createMessage(mentioned.id, "user", replier.id, "@thread-unread-owner look");
  await db.insert(messageMentions).values({
    messageId: mention.id,
    messageSeq: mention.seq,
    serverId: server.id,
    channelId: mentioned.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: "thread-unread-owner",
    notifiableAtSend: true,
  });
  await createMessage(plain.id, "user", replier.id, "plain reply");
  const readReply = await createMessage(allRead.id, "user", replier.id, "read reply");
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: allRead.id,
    lastReadSeq: readReply.seq,
    updatedAt: new Date(),
  });
  await createMessage(done.id, "user", replier.id, "reply in a done thread");
  await createMessage(notFollowed.id, "user", replier.id, "reply in an unfollowed thread");
  await createMessage(otherThread.id, "user", replier.id, "reply under the other channel");
  await createMessage(otherThread.id, "user", replier.id, "second reply, still one thread");

  const ownerToken = await tokenForHuman(owner.email);
  const summaryRes = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json() as {
    channels: Record<string, { unreadCount: number; hasMention: boolean; parentChannelId?: string }>;
    threadUnread: Record<string, { count: number; hasMention: boolean }>;
  };
  assert.deepEqual(summary.threadUnread, {
    [quiet.id]: { count: 2, hasMention: true },
    [other.id]: { count: 1, hasMention: false },
  });
  assert.equal(summary.channels[quiet.id], undefined, "the parent's own entry is not synthesized");
  assert.equal(summary.channels[mentioned.id]?.parentChannelId, quiet.id);
  assert.equal(summary.channels[otherThread.id]?.parentChannelId, other.id);
  assert.equal(summary.channels[otherThread.id]?.unreadCount, 2);
  for (const excluded of [done, notFollowed]) {
    assert.equal(summary.channels[excluded.id], undefined);
  }
  // Only threads with unread replies are resolved to a parent (the lookup
  // scales with them, not with every follow).
  assert.equal(summary.channels[allRead.id]?.parentChannelId, undefined);

  const followedRes = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(followedRes.status, 200);
  const followed = (await followedRes.json() as {
    threads: Array<{ threadChannelId: string; parentChannelId: string; hasMention: boolean; firstUnreadMessageId: string | null }>;
  }).threads;
  const byId = new Map(followed.map((thread) => [thread.threadChannelId, thread]));
  assert.equal(byId.get(mentioned.id)?.hasMention, true);
  assert.equal(byId.get(mentioned.id)?.firstUnreadMessageId, mention.id);
  assert.equal(byId.get(plain.id)?.hasMention, false);
  assert.equal(byId.get(allRead.id)?.hasMention, false);
  assert.equal(byId.get(otherThread.id)?.parentChannelId, other.id);
});


test("GET /api/channels/threads/followed: an overloaded RW serves the user's last good list, marked stale", async ({ app }) => {
  const entries = new Map<string, string>();
  __setStaleReadStoreForTests({
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => { entries.set(key, value); },
  });
  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  try {
    const owner = await seedUser("followed-stale-owner@slock.test", "followed-stale-owner");
    const other = await seedUser("followed-stale-other@slock.test", "followed-stale-other");
    const server = await createServer("Followed Stale Server", "followed-stale-server", owner.id);
    await addMember(server.id, other.id);
    const channel = await createChannel(server.id, "followed-stale-channel");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, other.id);
    const parent = await createMessage(channel.id, "user", owner.id, "stale parent");
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    await createMessage(thread.id, "user", other.id, "reply");
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id, followerType: "user", followerId: owner.id, parentMessageId: parent.id, reason: "manual",
    });
    const ownerToken = await tokenForHuman(owner.email);
    const otherToken = await tokenForHuman(other.email);

    const fresh = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: headers(ownerToken, server.id) });
    assert.equal(fresh.status, 200);
    const freshBody = await fresh.json() as { threads: Array<{ threadChannelId: string }> };
    assert.equal(freshBody.threads[0]?.threadChannelId, thread.id);
    await new Promise((resolve) => setImmediate(resolve));

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_stale_test";
    uninstallRisingWaveReadReferences();
    __testRisingWaveInbox.set({
      getPool: () => ({}) as never,
      query: (async () => {
        throw new RisingWaveOverloadedError(new Error("timeout exceeded when trying to connect"));
      }) as never,
    });
    const stale = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: headers(ownerToken, server.id) });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-raft-stale"), "rw_overloaded");
    assert.deepEqual(await stale.json(), { ...freshBody, stale: true });

    // Nothing remembered for another user: the overload still answers 503.
    const otherRes = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: headers(otherToken, server.id) });
    assert.equal(otherRes.status, 503);
  } finally {
    __setStaleReadStoreForTests(undefined);
    __testRisingWaveInbox.reset();
    installRisingWaveReadReferences();
    if (previousRisingWaveDatabaseUrl === undefined) delete process.env.RISINGWAVE_DATABASE_URL;
    else process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    await closeRisingWavePool();
  }
});

test("GET /api/channels/threads/followed pages newest-first with a cursor, filters unreadOnly, and keeps the no-limit shape", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("followed-page-owner@slock.test", "followed-page-owner");
  const replier = await seedUser("followed-page-replier@slock.test", "followed-page-replier");
  const server = await createServer("Followed Page Server", "followed-page-server", owner.id);
  await addMember(server.id, replier.id);
  const channel = await createChannel(server.id, "followed-page-channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, replier.id);

  // Five followed threads, created oldest first; the even ones have an unread reply.
  const threadIds: string[] = [];
  const parentCreatedAtByThreadId = new Map<string, string>();
  for (let i = 0; i < 5; i += 1) {
    const parent = await createMessage(channel.id, "user", owner.id, `page parent ${i}`);
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    await db.insert(threadFollows).values({
      threadChannelId: thread.id, followerType: "user", followerId: owner.id, parentMessageId: parent.id, reason: "manual",
    });
    const reply = await createMessage(thread.id, "user", replier.id, `page reply ${i}`);
    if (i % 2 === 1) {
      await db.insert(userChannelReadCursors).values({ userId: owner.id, channelId: thread.id, lastReadSeq: reply.seq, updatedAt: new Date() });
    }
    threadIds.push(thread.id);
    parentCreatedAtByThreadId.set(thread.id, new Date(parent.createdAt).toISOString());
  }
  const token = await tokenForHuman(owner.email);
  const get = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed${query}`, { headers: headers(token, server.id) });
    return { status: res.status, body: await res.json() as { threads?: Array<{ threadChannelId: string; unreadCount: number; parentMessageCreatedAt?: string }>; next?: string | null } };
  };

  // No limit: the old shape (all threads, no `next`).
  const full = await get("");
  assert.equal(full.status, 200);
  assert.equal(full.body.threads?.length, 5);
  assert.equal("next" in full.body, false);

  // Pages of 2, newest activity first, no repeats or gaps, last page has next: null.
  const seen: string[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 4; page += 1) {
    const res = await get(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(res.status, 200);
    seen.push(...(res.body.threads ?? []).map((thread) => thread.threadChannelId));
    cursor = res.body.next;
    if (!cursor) break;
  }
  assert.deepEqual(seen, [...threadIds].reverse());
  assert.equal(cursor, null);

  // unreadOnly: the three threads with an unread reply, all channels; pageable too.
  const unread = await get("?unreadOnly=1");
  assert.deepEqual(new Set(unread.body.threads?.map((thread) => thread.threadChannelId)), new Set([threadIds[0], threadIds[2], threadIds[4]]));
  assert.ok(unread.body.threads?.every((thread) => thread.unreadCount > 0));
  // Each thread carries its parent message's time (the web's jump pill orders by it).
  for (const thread of unread.body.threads ?? []) {
    assert.equal(thread.parentMessageCreatedAt, parentCreatedAtByThreadId.get(thread.threadChannelId));
  }
  const unreadPage = await get("?unreadOnly=1&limit=2");
  assert.deepEqual(unreadPage.body.threads?.map((thread) => thread.threadChannelId), [threadIds[4], threadIds[2]]);
  assert.equal(typeof unreadPage.body.next, "string");

  // Bad parameters are rejected rather than ignored.
  assert.equal((await get("?limit=0")).status, 400);
  assert.equal((await get("?limit=201")).status, 400);
  assert.equal((await get("?limit=2&cursor=not-a-cursor")).status, 400);
  assert.equal((await get(`?cursor=${encodeURIComponent(String(unreadPage.body.next))}`)).status, 400, "cursor needs limit");
});

test("GET /api/channels/:id/threads tells the viewer whether they follow each thread (done counts, unfollowed does not)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("summary-followed-owner@slock.test", "summary-followed-owner");
  const server = await createServer("Summary Followed Server", "summary-followed-server", owner.id);
  const channel = await createChannel(server.id, "summary-followed-channel");
  await addHuman(channel.id, owner.id);
  const make = async (label: string) => {
    const parent = await createMessage(channel.id, "user", owner.id, label);
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    await createMessage(thread.id, "user", owner.id, `${label} reply`);
    return { parent, thread };
  };
  const followed = await make("followed");
  const done = await make("done");
  const unfollowed = await make("unfollowed");
  const never = await make("never");
  await db.insert(threadFollows).values([
    { threadChannelId: followed.thread.id, followerType: "user", followerId: owner.id, parentMessageId: followed.parent.id, reason: "manual" },
    { threadChannelId: done.thread.id, followerType: "user", followerId: owner.id, parentMessageId: done.parent.id, reason: "manual", doneAt: new Date() },
    { threadChannelId: unfollowed.thread.id, followerType: "user", followerId: owner.id, parentMessageId: unfollowed.parent.id, reason: "manual", unfollowedAt: new Date() },
  ]).onConflictDoNothing();
  // getOrCreateThread may already have auto-followed the author: make the rows say exactly what the test means.
  await db.update(threadFollows).set({ unfollowedAt: new Date() }).where(and(eq(threadFollows.threadChannelId, unfollowed.thread.id), eq(threadFollows.followerId, owner.id)));
  await db.update(threadFollows).set({ doneAt: new Date(), unfollowedAt: null }).where(and(eq(threadFollows.threadChannelId, done.thread.id), eq(threadFollows.followerId, owner.id)));
  await db.update(threadFollows).set({ unfollowedAt: null, doneAt: null }).where(and(eq(threadFollows.threadChannelId, followed.thread.id), eq(threadFollows.followerId, owner.id)));
  await db.delete(threadFollows).where(and(eq(threadFollows.threadChannelId, never.thread.id), eq(threadFollows.followerId, owner.id)));

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/threads`, { headers: headers(token, server.id) });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, { followed: boolean }>;
  assert.equal(body[followed.parent.id]?.followed, true);
  assert.equal(body[done.parent.id]?.followed, true);
  assert.equal(body[unfollowed.parent.id]?.followed, false);
  assert.equal(body[never.parent.id]?.followed, false);
});
