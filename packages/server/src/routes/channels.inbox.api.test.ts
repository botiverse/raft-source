import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  BasicTracer,
  MemoryTraceSink, traceEventRowsForSpan
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { untracedDbQuery } from "../tracing/dbQueryTrace.js";
import { createTraceDbQueryTracer, runWithTraceSpan } from "../tracing/semanticTrace.js";
import { closeRisingWavePool } from "../db/risingwave.js";
import {
  servers as serversTable,
  serverMembers,
  channels,
  channelHumans, messages, messageMentions, threadFollows, userChannelReadCursors,
  agentChannelReadCursors,
  inboxServingRows, inboxNotificationFacts,
  inboxSuppressionStates,
  userChannelInboxStates, jointChannels,
  jointChannelServers, featureFlags
} from "../db/schema.js";
import { addMember, createServer as createServerService } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { RESIDUE_ONLY_READ_ALL_RECEIPT_FIELDS, __testReadStateAuthority, createChannel, getOrCreateThread, addHuman, addAgent, removeHuman, removeAgent, findOrCreateDM, findOrCreateUserDM, isChannelHuman, deleteChannel, markRead, markReadLatest, getInboxItems } from "../services/channelService.js";
import {
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
  createMessage,
} from "../services/messageService.js";
import {
  recordInboxNotificationFacts
} from "../services/inboxNotificationService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY } from "../services/featureFlagService.js";
import { READ_RECEIPT_PEER_STATE_LIMIT } from "../services/readReceiptService.js";
import {
  resolveThreadSuppressionTarget
} from "../services/inboxSuppressionWriters.js";
import { InboxRouteBackpressure } from "../services/inboxRouteBackpressure.js";
import { signAccessToken } from "../middleware/auth.js";
import { createServer, installFakeIo, enableReadReceiptsForServer, recordTestInboxFact, seedThreadFixture, headers, channelDoneBody, threadDoneBody, seedUser, fetchInboxAll, oracleProbes } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });


test("historyCutoff inbox with v3 flag enabled selects RW v2 before PG serving-row fallback", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  const originalPoolConnect = pg.Pool.prototype.connect;
  try {
    const db = getDb();
    await db.insert(featureFlags).values({
      key: INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY,
      description: "test inbox visibility v3",
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: true,
      salt: "history-cutoff-selector-test",
    }).onConflictDoUpdate({
      target: featureFlags.key,
      set: {
        enabled: true,
        killSwitch: false,
        randomizationUnit: "server",
        defaultEnabled: true,
        salt: "history-cutoff-selector-test",
      },
    });

    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:4566/slock_rw_cutoff_selector_test";
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    await closeRisingWavePool();

    const rwQueries: Array<{ query: string; params: unknown[] }> = [];
    (pg.Pool.prototype as unknown as { connect: () => Promise<{
      query: (...args: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }> }).connect = async () => {
      return {
        query: async (...args: unknown[]) => {
          rwQueries.push({
            query: String(args[0]),
            params: Array.isArray(args[1]) ? args[1] : [],
          });
          return {
            rows: [{
              kind: null,
              totalCount: 0,
              totalUnreadCount: 0,
              activeUnreadCount: 0,
              readAuthorityPresent: false,
              readAuthoritySeq: 0,
            }],
          };
        },
        release: () => {},
      };
    };

    const cutoff = new Date("2100-01-01T00:00:00Z");
    const tracedQueries: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    await getInboxItems(randomUUID(), randomUUID(), {
      filter: "all",
      limit: 30,
      offset: 0,
      historyCutoff: cutoff,
      humanActivityMuteEnabled: true,
      traceQuery: async (queryName, work, onComplete) => {
        const result = await work();
        tracedQueries.push({
          queryName,
          attrs: (onComplete?.(result) ?? {}) as Record<string, unknown>,
        });
        return result;
      },
    });

    assert.deepEqual(
      tracedQueries.map((event) => event.queryName),
      ["channels.inbox_items_by_user", "channels.inbox_read_authority_by_user"],
      "flag-on historyCutoff traffic must stay on RW after the primary authority fence and not call PG serving rows",
    );
    assert.equal(rwQueries.length, 1);
    assert.match(rwQueries[0].query, /rw_inbox_items_v2_suppressed_v3_4/);
    assert.doesNotMatch(rwQueries[0].query, /FROM rw_inbox_items_v2\b/);
    assert.doesNotMatch(rwQueries[0].query, /rw_inbox_items_v3_2/);
    assert.deepEqual(rwQueries[0].params.slice(2), ["all", cutoff, null, null]);

    const rwTrace = tracedQueries[0];
    assert.equal(rwTrace.attrs["inbox.backend"], "rw_mv");
    assert.equal(rwTrace.attrs["inbox.fallback_reason"], "none");
    assert.equal(rwTrace.attrs.contract_version, 2);
    assert.equal(rwTrace.attrs.rw_inbox_items_version, 2);
    assert.equal(rwTrace.attrs.rw_inbox_items_requested_version, 3);
    assert.equal(rwTrace.attrs.rw_inbox_items_version_forced, true);
    assert.equal(rwTrace.attrs.rw_inbox_items_version_force_reason, "history_cutoff");
    assert.equal(rwTrace.attrs.rw_inbox_visibility_v3_flag_enabled, true);
    assert.equal(rwTrace.attrs.history_cutoff_present, true);
    assert.equal(rwTrace.attrs.channel_id_present, false);
  } finally {
    (pg.Pool.prototype as unknown as { connect: typeof originalPoolConnect }).connect = originalPoolConnect;
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    if (previousRfc056ServingMode === undefined) {
      delete process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
    } else {
      process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    }
    await closeRisingWavePool();
    await app.close();
  }
});


test("adding a human rolls membership and message back when inbox fact persistence fails", async ({ app }) => {

  try {
    const db = getDb();
    const owner = await seedUser("human-add-fact-repair-owner@slock.test", "human-add-fact-repair-owner");
    const member = await seedUser("human-add-fact-repair-member@slock.test", "human-add-fact-repair-member");
    const server = await createServer("Human Add Fact Repair Server", "human-add-fact-repair-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const channel = await createChannel(server.id, "human-add-fact-repair");
    await addHuman(channel.id, owner.id);
    const ownerToken = await tokenForHuman(owner.email);
    const addMemberRequest = () => fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ userId: member.id }),
    });

    let failNextFacts = true;
    __setMessageServiceDepsForTests({
      createMessage,
      recordInboxNotificationFacts: async (...args) => {
        if (failNextFacts) {
          failNextFacts = false;
          throw new Error("injected membership inbox fact persistence failure");
        }
        return recordInboxNotificationFacts(...args);
      },
    });
    try {
      const first = await addMemberRequest();
      assert.equal(first.status, 500);
      assert.equal(await isChannelHuman(channel.id, member.id), false);
      assert.equal(
        (await db.select({ id: messages.id }).from(messages).where(and(
          eq(messages.channelId, channel.id),
          eq(messages.messageType, "system"),
        ))).length,
        0,
        "fact failure must roll the message back with membership",
      );

      const retry = await addMemberRequest();
      assert.equal(retry.status, 200);
      assert.equal(await isChannelHuman(channel.id, member.id), true);
      const [message] = await db.select().from(messages).where(and(
        eq(messages.channelId, channel.id),
        eq(messages.messageType, "system"),
      ));
      assert.ok(message);
      const facts = await db.select().from(inboxNotificationFacts).where(
        eq(inboxNotificationFacts.messageId, message.id),
      );
      assert.equal(facts.length, 2, "retry must commit both member facts with the repaired notice");
    } finally {
      __resetMessageServiceDepsForTests();
    }
  } finally {
    __resetMessageServiceDepsForTests();
    await app.close();
  }
});


test("follow/done/unfollow only read thread_follows — parent membership does not leak into followed list", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  // memberB is in the parent channel but NOT in thread_follows yet.
  // followed list must be empty for them — parent membership alone must
  // not make them appear as following.
  let res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  assert.equal(res.status, 200);
  let body = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(body.threads.length, 0, "parent member without follow must see empty followed list");

  // Manually follow — now the thread should appear.
  res = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ parentMessageId: f.parentMessageId }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  body = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(body.threads.length, 1, "followed thread must appear after follow");
  assert.equal(body.threads[0].threadChannelId, f.threadId);

  // Done hides from the active list; undone restores.
  res = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  body = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(body.threads.length, 0, "done thread must not appear in followed list");

  res = await fetch(`${app.baseUrl}/api/channels/threads/undone`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId, frontierSpace: "storage" }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  body = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(body.threads.length, 1, "undone thread must reappear in followed list");

  // Unfollow removes from the follows list without touching membership.
  res = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  body = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(body.threads.length, 0, "unfollowed thread must not appear in followed list");

  // Unfollow must not touch parent-channel membership (post authority).
  const db = getDb();
  const parentHumans = await db.select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, f.parentChannelId));
  assert.ok(
    parentHumans.some((row) => row.userId === f.memberBId),
    "unfollow must not remove memberB from parent channel membership",
  );
});


test("GET /api/channels/inbox/unfollowed retains frozen Activity history across later ordinary replies", async ({ app }) => {
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
    body: JSON.stringify({ channelId: f.threadId, content: "before-bound-search-token" }),
  });
  assert.equal(res.status, 200);
  const replyBeforeUnfollow = await res.json() as { id: string };

  res = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "after-bound-search-token" }),
  });
  assert.equal(res.status, 200);
  const replyAfterUnfollow = await res.json() as { id: string };

  res = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?limit=10`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const history = await res.json() as {
    items: Array<{
      kind: string;
      threadChannelId?: string;
      latestActivityMessageId?: string;
      replyCount?: number;
      unreadCount?: number;
      hasMention?: boolean;
      isFollowing?: boolean;
      unfollowedAt?: string | null;
    }>;
    hasMore: boolean;
    totalCount: null;
  };
  const retained = history.items.find((item) =>
    item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(retained, "explicitly unfollowed thread must remain in durable Activity history");
  assert.equal(retained.isFollowing, false);
  assert.ok(retained.unfollowedAt);
  assert.equal(retained.unreadCount, 0);
  assert.equal(retained.hasMention, false);
  assert.equal(retained.replyCount, 1, "history must freeze at the suppression sequence");
  assert.equal(retained.latestActivityMessageId, replyBeforeUnfollow.id);
  assert.notEqual(retained.latestActivityMessageId, replyAfterUnfollow.id);
  assert.equal(history.hasMore, false);
  assert.equal(history.totalCount, null);

  res = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=before-bound-search-token`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const preBoundSearch = await res.json() as { items: Array<{ threadChannelId?: string }> };
  assert.ok(
    preBoundSearch.items.some((item) => item.threadChannelId === f.threadId),
    "unfollowed search must include replies at or before the durable boundary",
  );

  res = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=after-bound-search-token`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const postBoundSearch = await res.json() as { items: Array<{ threadChannelId?: string }> };
  assert.equal(
    postBoundSearch.items.some((item) => item.threadChannelId === f.threadId),
    false,
    "later ordinary replies must not change frozen unfollowed-search membership",
  );

  res = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?limit=10`, {
    headers: headers(f.followerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const zeroReplyBoundary = await res.json() as {
    items: Array<{
      kind: string;
      threadChannelId?: string;
      latestActivityMessageId?: string;
      replyCount?: number;
    }>;
  };
  const retainedBeforeAnyReply = zeroReplyBoundary.items.find((item) =>
    item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(retainedBeforeAnyReply);
  assert.equal(retainedBeforeAnyReply.replyCount, 0, "a null latest-seq at unfollow is a real zero-reply boundary");
  assert.equal(retainedBeforeAnyReply.latestActivityMessageId, f.parentMessageId);

  res = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const active = await res.json() as { items: Array<{
    kind: string;
    threadChannelId?: string;
    latestActivityMessageId?: string;
    unreadCount?: number;
    hasMention?: boolean;
    isFollowing?: boolean;
  }> };
  const activeUnfollowed = active.items.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  );
  assert.ok(activeUnfollowed, "unfollowed/not-done history must remain in Activity All");
  assert.equal(activeUnfollowed.latestActivityMessageId, replyAfterUnfollow.id);
  assert.equal(activeUnfollowed.isFollowing, false);
  assert.equal(activeUnfollowed.unreadCount, 0);
  assert.equal(activeUnfollowed.hasMention, false);

  res = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ parentMessageId: f.parentMessageId }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?limit=10`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const afterRefollow = await res.json() as { items: Array<{ threadChannelId?: string }> };
  assert.equal(
    afterRefollow.items.some((item) => item.threadChannelId === f.threadId),
    false,
    "manual refollow must remove the terminal unfollowed-history state",
  );
});


test("GET /api/channels/inbox records inbox phases and query shape", async ({ app }) => {

  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
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

    const f = await seedThreadFixture(app.baseUrl);
    const dm = await findOrCreateUserDM(f.serverId, f.ownerId, f.memberBId);
    assert.ok(dm);
    const channelMessage = await createMessage(f.parentChannelId, "user", f.memberBId, "inbox channel latest");
    const threadMessage = await createMessage(f.threadId, "user", f.followerId, "inbox thread latest");
    const dmMessage = await createMessage(dm.id, "user", f.memberBId, "inbox dm latest");
    await recordTestInboxFact({
      serverId: f.serverId,
      receiverId: f.ownerId,
      kind: "channel",
      sourceChannelId: f.parentChannelId,
      message: channelMessage,
    });
    await recordTestInboxFact({
      serverId: f.serverId,
      receiverId: f.ownerId,
      kind: "thread",
      sourceChannelId: f.threadId,
      message: threadMessage,
    });
    await recordTestInboxFact({
      serverId: f.serverId,
      receiverId: f.ownerId,
      kind: "dm",
      sourceChannelId: dm.id,
      message: dmMessage,
    });

    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/channels/inbox?filter=all&limit=10`, {
      headers: headers(f.ownerToken, f.serverId),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      items: Array<{ kind: "channel" | "dm" | "thread" }>;
      totalCount: number;
      totalUnreadCount: number;
      activeUnreadCount: number;
      hasMore: boolean;
    };
    assert.ok(body.items.some((item) => item.kind === "channel"));
    assert.ok(body.items.some((item) => item.kind === "dm"));
    assert.ok(body.items.some((item) => item.kind === "thread"));
    assert.equal(body.hasMore, false);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/inbox",
    );
    assert.ok(span, "expected GET /api/channels/inbox root span");

    const processEventNames = span.events
      .map((event) => event.name)
      .filter((name) => name !== "db.query.finished");
    assert.deepEqual(processEventNames.filter((name) =>
      name !== "inbox.serving_row.read.page"
      && name !== "inbox.serving_row.read",
    ), [
      "inbox.backpressure.admitted",
      "inbox.load.started",
      "history.policy.checked",
      "inbox.rw.rfc056_serving_guard.decision",
      "inbox.backend.selected",
      "inbox.loaded",
      "response.ready",
      "inbox.backpressure.released",
      "http.response.finished",
    ]);

    const admittedEvent = span.events.find((event) => event.name === "inbox.backpressure.admitted");
    assert.ok(admittedEvent);
    assert.equal(admittedEvent.attrs?.queued, false);
    assert.equal(admittedEvent.attrs?.active, 1);
    assert.equal(admittedEvent.attrs?.queue_depth, 0);

    const backendSelectedIndex = processEventNames.indexOf("inbox.backend.selected");
    const loadedIndex = processEventNames.indexOf("inbox.loaded");
    const readPageIndexes = processEventNames
      .map((name, index) => ({ name, index }))
      .filter(({ name }) => name === "inbox.serving_row.read.page")
      .map(({ index }) => index);
    const readEvents = span.events.filter((event) => event.name === "inbox.serving_row.read");
    assert.equal(readPageIndexes.length, 1);
    assert.ok(readPageIndexes[0] > backendSelectedIndex);
    assert.ok(readPageIndexes[0] < loadedIndex);
    assert.equal(readEvents.length, body.items.length, "serving-row reads should trace one row per returned inbox item");
    const readJoinKeys = readEvents.map((event) => event.attrs?.["inbox.trace_join_key"]);
    assert.ok(readJoinKeys.every((key) => typeof key === "string"));
    assert.equal(new Set(readJoinKeys).size, readJoinKeys.length, "serving-row read trace keys should be unique for this inbox page");
    assert.ok(readEvents.every((event) => event.attrs?.receiver_type === "user"));
    assert.ok(readEvents.every((event) => event.attrs?.target_kind === "channel" || event.attrs?.target_kind === "dm" || event.attrs?.target_kind === "thread"));

    const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
    assert.deepEqual(dbEvents.map((event) => event.attrs?.query_name), [
      "channels.inbox_items_serving_rows_by_user",
      "channels.inbox_profile_names.users",
      "channels.inbox_read_state_authority",
      "channels.followed_threads_by_user",
      "channels.followed_joint_threads_by_user",
    ]);
    const inboxDbEvent = dbEvents.find((event) => event.attrs?.query_name === "channels.inbox_items_serving_rows_by_user");
    assert.ok(inboxDbEvent);
    assert.equal(inboxDbEvent.attrs?.phase, "inbox.loaded");
    assert.equal(inboxDbEvent.attrs?.filter, "all");
    assert.equal(inboxDbEvent.attrs?.limit, 11, "mixed All compositor reads one lookahead row for hasMore");
    assert.equal(inboxDbEvent.attrs?.history_cutoff_present, false);
    assert.equal(inboxDbEvent.attrs?.row_count, body.items.length);
    assert.equal(inboxDbEvent.attrs?.["inbox.backend"], "pg_serving_rows");
    assert.equal(inboxDbEvent.attrs?.["inbox.route"], "all");
    assert.equal(inboxDbEvent.attrs?.["inbox.fallback_reason"], "none");
    assert.equal(inboxDbEvent.attrs?.["inbox.contract_version"], 2);
    assert.equal(inboxDbEvent.attrs?.["inbox.postgres_selection_reason"], "human_activity_mute_uses_serving_rows");
    assert.equal(inboxDbEvent.attrs?.["inbox.legacy_retire_gate"], undefined);

    const backendEvent = span.events.find((event) => event.name === "inbox.backend.selected");
    assert.ok(backendEvent);
    assert.equal(backendEvent.attrs?.["inbox.backend"], "pg_serving_rows");
    assert.equal(backendEvent.attrs?.["inbox.route"], "all");
    assert.equal(backendEvent.attrs?.["inbox.fallback_reason"], "none");
    assert.equal(backendEvent.attrs?.["inbox.contract_version"], 2);
    assert.equal(backendEvent.attrs?.["inbox.postgres_selection_reason"], "human_activity_mute_uses_serving_rows");
    assert.equal(backendEvent.attrs?.["inbox.legacy_retire_gate"], undefined);

    const loadedEvent = span.events.find((event) => event.name === "inbox.loaded");
    assert.ok(loadedEvent);
    assert.equal(loadedEvent.attrs?.filter, "all");
    assert.equal(loadedEvent.attrs?.inbox_items_count, body.items.length);
    assert.equal(loadedEvent.attrs?.total_count, body.totalCount);
    assert.equal(loadedEvent.attrs?.total_unread_count, body.totalUnreadCount);
    assert.equal(loadedEvent.attrs?.active_unread_count, body.activeUnreadCount);
    assert.equal(loadedEvent.attrs?.channel_items_count, body.items.filter((item) => item.kind === "channel").length);
    assert.equal(loadedEvent.attrs?.dm_items_count, body.items.filter((item) => item.kind === "dm").length);
    assert.equal(loadedEvent.attrs?.thread_items_count, body.items.filter((item) => item.kind === "thread").length);

    const readyEvent = span.events.find((event) => event.name === "response.ready");
    assert.ok(readyEvent);
    assert.equal(readyEvent.attrs?.inbox_items_count, body.items.length);
    assert.equal(Object.values(span.attrs ?? {}).includes(f.ownerId), false);
    assert.equal(Object.values(readyEvent.attrs ?? {}).includes(dm.id), false);
  } finally {
    if (previousRfc056ServingMode === undefined) {
      delete process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
    } else {
      process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    }
    await app.close();
  }
});


test("GET /api/channels/inbox rejects overload before any inbox DB work", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 1,
    maxQueue: 0,
    queueTimeoutMs: 1_000,
  });
  app.app.set("inboxRouteBackpressure", gate);
  const blocker = await gate.acquire();

  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({
    sink,
    traceIdGenerator: () => "9".repeat(32),
    spanIdGenerator: () => "1".repeat(16),
  }));
  const response = await fetch(`${app.baseUrl}/api/channels/inbox?filter=all&limit=10`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(await response.json(), {
    code: "INBOX_BACKPRESSURE",
    error: "Inbox is busy; retry later",
    reason: "queue_full",
  });
  blocker.release();

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/inbox",
  );
  assert.ok(span);
  assert.ok(span.events.some((event) =>
    event.name === "inbox.backpressure.rejected"
    && event.attrs?.reason === "queue_full",
  ));
  assert.equal(
    span.events.some((event) => event.name === "db.query.finished"),
    false,
    "an overloaded request must not multiply Postgres work",
  );
});


test("GET /api/channels/inbox admission precedes verified-profile and server DB middleware", async ({ app }) => {
  const gate = new InboxRouteBackpressure({
    maxConcurrency: 1,
    maxQueue: 0,
    queueTimeoutMs: 1_000,
  });
  app.app.set("inboxRouteBackpressure", gate);
  const blocker = await gate.acquire();
  const request = () => fetch(`${app.baseUrl}/api/channels/inbox?limit=1`, {
    headers: {
      Authorization: `Bearer ${signAccessToken(randomUUID())}`,
      "X-Server-Id": randomUUID(),
    },
  });

  const overloaded = await request();
  assert.equal(overloaded.status, 429);
  assert.equal((await overloaded.json() as { code?: string }).code, "INBOX_BACKPRESSURE");

  blocker.release();
  const admitted = await request();
  assert.equal(
    admitted.status,
    401,
    "after admission, requireVerified must reach the DB and reject the missing user",
  );
  await admitted.text();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    { active: gate.snapshot().active, queued: gate.snapshot().queued },
    { active: 0, queued: 0 },
    "a pre-route auth rejection must return its admission lease",
  );

  const repeated = await request();
  assert.equal(
    repeated.status,
    401,
    "a repeated missing-user request must be admitted instead of inheriting a leaked 429",
  );
  await repeated.text();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    { active: gate.snapshot().active, queued: gate.snapshot().queued },
    { active: 0, queued: 0 },
  );
});


test("legacy PG inbox policy query keeps SQL-side paging bounded", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");
  const legacyQueries = [
    ...source.matchAll(
      /traceQuery\(\s*"channels\.inbox_items_by_user",\s*\(\)\s*=>\s*db\.execute\(sql`([\s\S]*?)`\),\s*\(queryResult\)\s*=>\s*\(\{/g,
    ),
  ].map((match) => match[1]!);
  assert.equal(legacyQueries.length, 2, "expected canonical and legacy PG inbox query blocks");
  const [canonicalPgQuery, legacyPgQuery] = legacyQueries;

  assert.doesNotMatch(source, /const messageCutoff = historyCutoff/);
  assert.doesNotMatch(canonicalPgQuery, /\$\{messageCutoff\}/);
  assert.doesNotMatch(legacyPgQuery, /\$\{messageCutoff\}/);
  assert.match(legacyPgQuery, /filtered AS \(/);
  assert.match(legacyPgQuery, /totals AS \(/);
  assert.match(legacyPgQuery, /page AS \(/);
  assert.match(legacyPgQuery, /LIMIT \$\{limit \+ 1\}/);
  assert.match(legacyPgQuery, /OFFSET \$\{offset\}/);
  assert.match(
    legacyPgQuery,
    /SELECT\s+page\.\*,\s+totals\."totalCount",\s+totals\."totalUnreadCount",\s+active_totals\."activeUnreadCount"/,
  );
  assert.match(legacyPgQuery, /active_totals AS \(/);
  assert.doesNotMatch(legacyPgQuery, /has_any_mention ON true/);
  assert.doesNotMatch(legacyPgQuery, /SELECT \*\s+FROM combined\s+ORDER BY "activityAt" DESC NULLS LAST/);
  assert.doesNotMatch(source, /applyInboxPolicyFilterPageRows\(rawRows/);
});


test("legacy Activity Inbox path emits explicit retire gate when serving rows are bypassed", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    const tracedQueries: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    await getInboxItems(randomUUID(), randomUUID(), {
      filter: "all",
      limit: 5,
      offset: 0,
      humanActivityMuteEnabled: false,
      traceQuery: async (queryName, work, onComplete) => {
        const result = await work();
        tracedQueries.push({
          queryName,
          attrs: (onComplete?.(result) ?? {}) as Record<string, unknown>,
        });
        return result;
      },
    });

    const legacyQuery = tracedQueries.find((event) => event.queryName === "channels.inbox_items_by_user");
    assert.ok(legacyQuery, "expected direct no-mute/no-cutoff PG fallback to use the inline legacy query");
    assert.equal(legacyQuery.attrs["inbox.backend"], "pg_legacy");
    assert.equal(legacyQuery.attrs["inbox.fallback_reason"], "pglite_dev");
    assert.equal(
      legacyQuery.attrs["inbox.postgres_selection_reason"],
      "legacy_inline_policy_pending_serving_rows_migration",
    );
    assert.equal(legacyQuery.attrs["inbox.legacy_retire_gate"], "pending_serving_rows_parity");
  } finally {
    if (previousRfc056ServingMode === undefined) {
      delete process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
    } else {
      process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    }
    await app.close();
  }
});


test("historyCutoff inbox uses serving-row activity filter instead of legacy PG cutoff joins", async ({ app }) => {

  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    const db = getDb();
    const readSessionStatementTimeout = async () => {
      const current = await db.execute(sql`
        SELECT current_setting('statement_timeout')::text AS "statementTimeout"
      `);
      return String(current.rows[0]?.statementTimeout);
    };
    await db.execute(sql`SELECT set_config('statement_timeout', '15s', false)`);
    const sessionStatementTimeoutBefore = await readSessionStatementTimeout();
    const f = await seedThreadFixture(app.baseUrl);
    const cutoff = new Date("2026-06-01T00:00:00Z");
    const oldDate = new Date("2026-05-01T00:00:00Z");
    const newDate = new Date("2026-06-02T00:00:00Z");

    const oldOnlyChannel = await createChannel(f.serverId, "old-only-cutoff-room");
    await addHuman(oldOnlyChannel.id, f.ownerId);
    const mixedChannel = await createChannel(f.serverId, "mixed-cutoff-room");
    await addHuman(mixedChannel.id, f.ownerId);

    const oldOnlyMessage = await createMessage(oldOnlyChannel.id, "user", f.memberBId, "old only");
    const mixedOldMessage = await createMessage(mixedChannel.id, "user", f.memberBId, "mixed old");
    const mixedNewMessage = await createMessage(mixedChannel.id, "user", f.memberBId, "mixed new");
    await db.update(messages).set({ createdAt: oldDate }).where(eq(messages.id, oldOnlyMessage.id));
    await db.update(messages).set({ createdAt: oldDate }).where(eq(messages.id, mixedOldMessage.id));
    await db.update(messages).set({ createdAt: newDate }).where(eq(messages.id, mixedNewMessage.id));

    await recordInboxNotificationFacts([
      {
        receiverType: "user",
        receiverId: f.ownerId,
        serverId: f.serverId,
        kind: "channel",
        sourceChannelId: oldOnlyChannel.id,
        messageId: oldOnlyMessage.id,
        messageSeq: oldOnlyMessage.seq,
        activityAt: oldDate,
        personalMention: false,
        unreadEligible: true,
      },
      {
        receiverType: "user",
        receiverId: f.ownerId,
        serverId: f.serverId,
        kind: "channel",
        sourceChannelId: mixedChannel.id,
        messageId: mixedOldMessage.id,
        messageSeq: mixedOldMessage.seq,
        activityAt: oldDate,
        personalMention: false,
        unreadEligible: true,
      },
      {
        receiverType: "user",
        receiverId: f.ownerId,
        serverId: f.serverId,
        kind: "channel",
        sourceChannelId: mixedChannel.id,
        messageId: mixedNewMessage.id,
        messageSeq: mixedNewMessage.seq,
        activityAt: newDate,
        personalMention: false,
        unreadEligible: true,
      },
    ]);
    await db
      .update(inboxServingRows)
      .set({
        latestNotifiedAt: oldDate,
        lastActivityAt: newDate,
      })
      .where(eq(inboxServingRows.sourceChannelId, mixedChannel.id));

    const queryEvents: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    const inbox = await getInboxItems(f.serverId, f.ownerId, {
      filter: "all",
      limit: 30,
      offset: 0,
      historyCutoff: cutoff,
      humanActivityMuteEnabled: false,
      traceQuery: async (queryName, work, onComplete) => {
        const result = await work();
        queryEvents.push({
          queryName,
          attrs: (onComplete?.(result) ?? {}) as Record<string, unknown>,
        });
        return result;
      },
    });

    assert.equal(
      queryEvents.some((event) => event.queryName === "channels.inbox_items_by_user"),
      false,
      "cutoff traffic must not use the legacy PG message-join cutoff query",
    );
    const servingQuery = queryEvents.find((event) => event.queryName === "channels.inbox_items_serving_rows_by_user");
    assert.ok(servingQuery, "expected cutoff traffic to use PG serving rows when RW is unavailable");
    assert.equal(servingQuery.attrs.history_cutoff_present, true);
    assert.equal(servingQuery.attrs["inbox.backend"], "pg_serving_rows");
    assert.equal(servingQuery.attrs["inbox.fallback_reason"], "history_cutoff");
    assert.equal(servingQuery.attrs["inbox.postgres_selection_reason"], "history_cutoff_uses_serving_rows");
    assert.equal(servingQuery.attrs["inbox.legacy_retire_gate"], undefined);
    assert.equal(servingQuery.attrs["pg.fallback.query_name"], "channels.inbox_items_serving_rows_by_user");
    assert.equal(servingQuery.attrs["pg.fallback.query_identity"], "inbox_items_serving_rows_v13");
    assert.equal(
      servingQuery.attrs["pg.fallback.query_hash"],
      "6f4da8f02685590c",
      "the timeout contract must hash the complete normalized v13 serving-key SQL, not only its displayed prefix",
    );
    assert.equal(
      servingQuery.attrs["pg.fallback.legacy_query_hash"],
      "ff11a9e16bc68872",
      "the exact v2 identity retains a direct link to the historical 41s plan's truncated hash",
    );
    assert.equal(servingQuery.attrs["pg.fallback.timeout_scope"], "transaction_local");
    assert.equal(servingQuery.attrs["pg.fallback.statement_timeout_cap_ms"], 3_000);
    assert.equal(servingQuery.attrs["pg.fallback.inherited_statement_timeout_ms"], 15_000);
    assert.equal(servingQuery.attrs["pg.fallback.effective_statement_timeout_ms"], 3_000);
    assert.equal(servingQuery.attrs["pg.fallback.outcome"], "query_completed");
    assert.equal(servingQuery.attrs.receiver_scope_row_count, 2);
    assert.equal(
      await readSessionStatementTimeout(),
      sessionStatementTimeoutBefore,
      "the fallback query's transaction-local timeout must not alter the shared session used by unrelated queries",
    );

    assert.equal(
      inbox.items.some((item) => item.kind === "channel" && item.channelId === oldOnlyChannel.id),
      false,
      "rows whose serving activity is before the cutoff are filtered out",
    );
    const mixedItem = inbox.items.find((item) => item.kind === "channel" && item.channelId === mixedChannel.id);
    assert.ok(mixedItem?.kind === "channel");
    assert.equal(mixedItem.lastMessageId, mixedNewMessage.id);
    assert.equal(
      mixedItem.unreadCount,
      2,
      "accepted #6 approximation: cutoff filters the row set, while full serving-row unread count can include older unread",
    );
    assert.equal(inbox.totalUnreadCount, 2);

    queryEvents.length = 0;
    await db.execute(sql`SELECT set_config('statement_timeout', '2s', false)`);
    const strictSessionTimeoutBefore = await readSessionStatementTimeout();
    await getInboxItems(f.serverId, f.ownerId, {
      filter: "all",
      limit: 30,
      offset: 0,
      historyCutoff: cutoff,
      humanActivityMuteEnabled: false,
      traceQuery: async (queryName, work, onComplete) => {
        const result = await work();
        queryEvents.push({
          queryName,
          attrs: (onComplete?.(result) ?? {}) as Record<string, unknown>,
        });
        return result;
      },
    });
    const strictServingQuery = queryEvents.find((event) => event.queryName === "channels.inbox_items_serving_rows_by_user");
    assert.ok(strictServingQuery);
    assert.equal(strictServingQuery.attrs["pg.fallback.statement_timeout_cap_ms"], 3_000);
    assert.equal(strictServingQuery.attrs["pg.fallback.inherited_statement_timeout_ms"], 2_000);
    assert.equal(
      strictServingQuery.attrs["pg.fallback.effective_statement_timeout_ms"],
      2_000,
      "the fallback cap must not widen a stricter inherited role/session timeout",
    );
    assert.equal(
      await readSessionStatementTimeout(),
      strictSessionTimeoutBefore,
      "the stricter inherited timeout remains active after the fallback transaction",
    );
    await db.execute(sql`SELECT set_config('statement_timeout', '0', false)`);
  } finally {
    if (previousRfc056ServingMode === undefined) {
      delete process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
    } else {
      process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    }
    await app.close();
  }
});


test("bounded inbox serving prefix filters inaccessible newest rows before LIMIT", async ({ app }) => {
  const db = getDb();
  const f = await seedThreadFixture(app.baseUrl);
  const validChannels = await Promise.all([
    createChannel(f.serverId, `bounded-valid-a-${randomUUID()}`),
    createChannel(f.serverId, `bounded-valid-b-${randomUUID()}`),
  ]);
  const inaccessibleChannels = await Promise.all([
    createChannel(f.serverId, `bounded-hidden-a-${randomUUID()}`),
    createChannel(f.serverId, `bounded-hidden-b-${randomUUID()}`),
    createChannel(f.serverId, `bounded-hidden-c-${randomUUID()}`),
  ]);
  for (const channel of validChannels) await addHuman(channel.id, f.ownerId);

  const allChannels = [...validChannels, ...inaccessibleChannels];
  for (const channel of allChannels) {
    const message = await createMessage(channel.id, "user", f.memberBId, `activity-${channel.id}`);
    await recordTestInboxFact({
      serverId: f.serverId,
      receiverId: f.ownerId,
      kind: "channel",
      sourceChannelId: channel.id,
      message,
    });
  }
  const validActivity = new Date("2026-08-25T10:00:00Z");
  const inaccessibleActivity = new Date("2026-08-25T11:00:00Z");
  await db.update(inboxServingRows)
    .set({ lastActivityAt: validActivity })
    .where(inArray(inboxServingRows.sourceChannelId, validChannels.map((channel) => channel.id)));
  await db.update(inboxServingRows)
    .set({ lastActivityAt: inaccessibleActivity })
    .where(inArray(inboxServingRows.sourceChannelId, inaccessibleChannels.map((channel) => channel.id)));

  const inbox = await getInboxItems(f.serverId, f.ownerId, {
    filter: "all",
    limit: 2,
    offset: 0,
    humanActivityMuteEnabled: false,
    traceQuery: untracedDbQuery,
  });
  assert.deepEqual(
    new Set(inbox.items.map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId)),
    new Set(validChannels.map((channel) => channel.id)),
    "three newer inaccessible rows must not consume the limit+1 prefix and hide later visible rows",
  );
});


test("RisingWave inbox serving query applies historyCutoff to suppressed v2 activity_at", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");

  assert.match(source, /AND \(\$4::timestamptz IS NULL OR i\.activity_at > \$4::timestamptz\)/);
  assert.match(source, /historyCutoff: Boolean\(opts\.historyCutoff\)/);
  assert.match(source, /if \(opts\.historyCutoff && requestedVersion === 3\) return 2/);
  assert.match(source, /if \(opts\.historyCutoff && inboxItemsVersion !== 2\) return null/);
  assert.match(source, /RW_INBOX_ITEMS_V2_SERVING_VIEW = "rw_inbox_items_v2_suppressed_v3_4"/);
  assert.doesNotMatch(source, /if \(!client \|\| opts\.historyCutoff\) return null/);
});


test("RisingWave inbox serving emits payload-free null thread reply_count contract signal", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");
  const eventStart = source.indexOf("function recordRisingWaveInboxThreadReplyCountNullContractViolation");
  const eventEnd = source.indexOf("function inboxTargetTraceJoinKey", eventStart);
  const eventSource = source.slice(eventStart, eventEnd);

  assert.match(source, /recordRisingWaveInboxThreadReplyCountNullContractViolation\(read\.result\.rows/);
  assert.match(eventSource, /row\.kind === "thread" && row\.replyCount == null/);
  assert.match(eventSource, /inbox\.rw\.thread_reply_count_null_contract_violation/);
  assert.match(eventSource, /contract: "thread_reply_count_non_null"/);
  assert.match(eventSource, /null_thread_reply_count_rows: nullThreadReplyCountRows/);
  assert.doesNotMatch(eventSource, /parentMessagePreview|latestActivityPreview|lastMessagePreview|content/);
});


test("RisingWave inbox v3 serving is behind the Feature Flag v0 fail-closed gate", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");

  assert.match(source, /INBOX_VISIBILITY_V3_FEATURE_FLAG_KEY/);
  assert.match(source, /evaluateFeatureFlag\(\{/);
  assert.match(source, /return evaluation\.enabled \? 3 : getRisingWaveInboxItemsServingVersion\(\)/);
  assert.match(source, /selectRisingWaveInboxItemsServingVersionForRequest\(requestedInboxItemsVersion, opts\)/);
  assert.match(source, /RW_INBOX_ITEMS_V3_SERVING_VIEW = "rw_inbox_items_v3_2"/);
  assert.match(source, /RW_INBOX_ITEMS_V2_SERVING_VIEW = "rw_inbox_items_v2_suppressed_v3_4"/);
  assert.match(source, /i\.visibility_contract_version = 3/);
  assert.match(source, /rw_inbox_visibility_v3_flag_enabled: requestedInboxItemsVersion === 3/);
  assert.match(source, /rw_inbox_items_version_force_reason: forcedV2ForHistoryCutoff \? "history_cutoff" : "none"/);
  assert.match(source, /if \(opts\.historyCutoff && inboxItemsVersion !== 2\) return null/);
});


test("RisingWave inbox all filter keeps private member rows", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");

  assert.match(source, /i\.channel_type IN \('channel', 'private', 'joint', 'dm'\)/);
  assert.doesNotMatch(source, /i\.channel_type IN \('channel', 'joint', 'dm'\)/);
});


test("GET /channels/inbox legacy all filter includes private channels and private parent threads", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-inbox-owner@slock.test", "private-inbox-owner");
  const peer = await seedUser("private-inbox-peer@slock.test", "private-inbox-peer");
  const server = await createServer("Private Inbox Server", "private-inbox-server", owner.id);
  await addMember(server.id, peer.id);

  const privateChannel = await createChannel(server.id, "private-inbox-room", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await addHuman(privateChannel.id, peer.id);
  const ordinaryPrivateMessage = await createMessage(privateChannel.id, "user", peer.id, "ordinary private activity");
  const mentionPrivateMessage = await createMessage(privateChannel.id, "user", peer.id, "private mention for owner");
  await db.insert(messageMentions).values({
    messageId: mentionPrivateMessage.id,
    messageSeq: mentionPrivateMessage.seq,
    serverId: server.id,
    channelId: privateChannel.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: owner.name,
  });

  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm, "expected DM creation for private inbox comparison");
  const dmMessage = await createMessage(dm.id, "user", peer.id, "dm activity still appears");

  const parentMessage = await createMessage(privateChannel.id, "user", peer.id, "private parent with thread");
  const privateThread = await getOrCreateThread(parentMessage.id, peer.id, "user");
  const privateThreadReply = await createMessage(privateThread.id, "user", peer.id, "private thread reply");
  await db.insert(threadFollows).values({
    threadChannelId: privateThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  });

  const inbox = await getInboxItems(server.id, owner.id, {
    filter: "all",
    limit: 30,
    offset: 0,
    humanActivityMuteEnabled: false,
  });
  const privateItem = inbox.items.find((item) => item.kind === "channel" && item.channelId === privateChannel.id);
  assert.ok(privateItem?.kind === "channel", "private channel membership must surface top-level Activity");
  assert.equal(privateItem.channelType, "private");
  assert.equal(privateItem.lastMessageId, parentMessage.id);
  assert.equal(privateItem.firstUnreadMessageId, ordinaryPrivateMessage.id);
  assert.equal(privateItem.firstMentionMessageId, mentionPrivateMessage.id);
  assert.equal(privateItem.hasMention, true);

  const dmItem = inbox.items.find((item) => item.kind === "dm" && item.channelId === dm.id);
  assert.ok(dmItem?.kind === "dm", "DM rows remain included in all Activity");
  assert.equal(dmItem.lastMessageId, dmMessage.id);

  const threadItem = inbox.items.find((item) => item.kind === "thread" && item.threadChannelId === privateThread.id);
  assert.ok(threadItem?.kind === "thread", "followed thread under a private parent must surface in Activity");
  assert.equal(threadItem.parentChannelType, "private");
  assert.equal(threadItem.latestActivityMessageId, privateThreadReply.id);

  const mentions = await getInboxItems(server.id, owner.id, {
    filter: "mentions",
    limit: 30,
    offset: 0,
    humanActivityMuteEnabled: false,
  });
  assert.ok(
    mentions.items.some((item) => item.kind === "channel" && item.channelId === privateChannel.id),
    "private channel @mentions must remain visible in the mentions filter",
  );
});


test("GET /channels/inbox mixes channels and followed threads with unread as a filter", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const channelLatestMessage = await createMessage(
    f.parentChannelId,
    "user",
    f.memberBId,
    "channel latest message",
  );
  const threadReplyMessage = await createMessage(
    f.threadId,
    "user",
    f.followerId,
    "thread reply message",
  );
  const emptyChannel = await createChannel(f.serverId, "empty-inbox-room");
  await addHuman(emptyChannel.id, f.ownerId);
  const systemOnlyChannel = await createChannel(
    f.serverId,
    "system-inbox-room",
  );
  await addHuman(systemOnlyChannel.id, f.ownerId);
  const systemOnlyMessage = await createMessage(
    systemOnlyChannel.id,
    "user",
    "system",
    "system-only inbox activity",
    "system",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: channelLatestMessage,
    personalMention: true,
  });
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadReplyMessage,
  });
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.followerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadReplyMessage,
  });
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: systemOnlyChannel.id,
    message: systemOnlyMessage,
  });

  // Insert a mention on the latest channel message so we can exercise the
  // mentions filter (source-of-truth = message_mentions table; the inbox
  // filter only looks at this table, never re-scans bodies).
  await getDb().insert(messageMentions).values({
    messageId: channelLatestMessage.id,
    messageSeq: channelLatestMessage.seq,
    serverId: f.serverId,
    channelId: f.parentChannelId,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
  });

  async function getInbox(
    filter: "all" | "unread" | "mentions" | "unread_mentions" = "all",
    limit?: number,
    channelId?: string,
    q?: string,
    sort?: "asc" | "desc",
    offset?: number,
    extraQuery?: readonly [key: string, value: string],
  ) {
    const url = new URL(`${app.baseUrl}/api/channels/inbox`);
    url.searchParams.set("filter", filter);
    if (limit != null) url.searchParams.set("limit", String(limit));
    if (channelId != null) url.searchParams.set("channelId", channelId);
    if (q != null) url.searchParams.set("q", q);
    if (sort != null) url.searchParams.set("sort", sort);
    if (offset != null) url.searchParams.set("offset", String(offset));
    if (extraQuery != null) url.searchParams.set(extraQuery[0], extraQuery[1]);
    const res = await fetch(url, {
      headers: headers(f.ownerToken, f.serverId),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      items: Array<
        | {
            kind: "channel";
            channelId: string;
            lastMessageId: string;
            firstUnreadMessageId: string | null;
            firstMentionMessageId: string | null;
            unreadCount: number;
            hasMention: boolean;
          }
        | {
            kind: "thread";
            threadChannelId: string;
            parentChannelId: string;
            latestActivityMessageId: string;
            firstUnreadMessageId: string | null;
            firstMentionMessageId: string | null;
            unreadCount: number;
            hasMention: boolean;
          }
      >;
      hasMore: boolean;
      totalCount: number;
      totalUnreadCount: number;
      activeUnreadCount: number;
      groups: Array<{
        channelId: string;
        channelName: string;
        channelType: string;
        count: number;
        lastActivityAt: string;
      }>;
    };
    assert.deepEqual(
      Object.keys(body).sort(),
      ["activeUnreadCount", "groups", "hasMore", "items", "totalCount", "totalUnreadCount"],
      "GET /channels/inbox must expose the deployed V1 page body, not an ingress envelope",
    );
    return body;
  }
  async function getUnreadCounts() {
    const res = await fetch(`${app.baseUrl}/api/channels/unread`, {
      headers: headers(f.ownerToken, f.serverId),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, number>;
  }

  const initial = await getInbox();
  assert.ok(initial.groups.length > 0);
  assert.ok(
    initial.groups.every((group) => Number.isFinite(Date.parse(group.lastActivityAt))),
    "every DM/channel facet exposes its server-owned most-recent visible activity timestamp",
  );
  const expectedRecentGroupOrder = [...initial.groups].sort((left, right) => {
    const typeDelta = Number(left.channelType !== "dm") - Number(right.channelType !== "dm");
    if (typeDelta !== 0) return typeDelta;
    const activityDelta = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
    if (activityDelta !== 0) return activityDelta;
    const nameDelta = left.channelName.localeCompare(right.channelName);
    return nameDelta !== 0 ? nameDelta : left.channelId.localeCompare(right.channelId);
  });
  assert.deepEqual(
    initial.groups.map((group) => group.channelId),
    expectedRecentGroupOrder.map((group) => group.channelId),
    "DM and Channel sections are each ordered by recent activity rather than display name",
  );
  const oldestFirst = await getInbox(
    "all",
    undefined,
    undefined,
    undefined,
    "asc",
  );
  const itemIdentity = (item: (typeof initial.items)[number]) =>
    item.kind === "thread"
      ? `thread:${item.threadChannelId}`
      : `${item.kind}:${item.channelId}`;
  assert.deepEqual(
    oldestFirst.items.map(itemIdentity),
    initial.items.map(itemIdentity).reverse(),
    "sort=asc must reverse the server-owned Activity order before pagination",
  );
  const limitedInitial = await getInbox("all", 1);
  assert.equal(limitedInitial.items.length, 1);
  assert.equal(limitedInitial.hasMore, true);
  assert.equal(limitedInitial.totalCount, initial.totalCount, "Inbox total count should not depend on the loaded page size");
  assert.equal(limitedInitial.totalUnreadCount, initial.totalUnreadCount, "Inbox unread total should not depend on the loaded page size");
  assert.equal(limitedInitial.activeUnreadCount, initial.activeUnreadCount, "active unread total should not depend on the loaded page size");
  const secondPage = await getInbox("all", 1, undefined, undefined, "desc", 1);
  assert.deepEqual(
    secondPage.items.map(itemIdentity),
    initial.items.slice(1, 2).map(itemIdentity),
    "offset must page the server-owned Activity order after filtering and sorting",
  );
  assert.equal(secondPage.totalCount, initial.totalCount);
  const unknownQuery = await getInbox(
    "all",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ["futureTransportField", "ignored"],
  );
  assert.deepEqual(
    unknownQuery,
    initial,
    "undeclared query parameters must be ignored instead of changing the V1 page",
  );
  assert.deepEqual(
    limitedInitial.groups,
    initial.groups,
    "DM/channel group counts should not depend on the loaded page size",
  );
  assert.equal(
    initial.groups.find((group) => group.channelId === f.parentChannelId)
      ?.count,
    2,
    "a channel row and its followed thread should aggregate into one parent-channel group",
  );
  assert.equal(
    initial.groups.find((group) => group.channelId === systemOnlyChannel.id)
      ?.count,
    1,
  );
  const parentChannelFiltered = await getInbox(
    "all",
    undefined,
    f.parentChannelId,
  );
  assert.deepEqual(
    parentChannelFiltered.items
      .map((item) =>
        item.kind === "thread" ? item.parentChannelId : item.channelId,
      )
      .sort(),
    [f.parentChannelId, f.parentChannelId],
    "channelId filter should group a followed thread under its parent channel",
  );
  assert.equal(
    parentChannelFiltered.totalCount,
    2,
    "channelId-filtered totals should count rows before pagination",
  );
  assert.deepEqual(
    parentChannelFiltered.groups,
    initial.groups,
    "the facet list should remain global while one channel group is selected",
  );
  assert.equal(
    parentChannelFiltered.totalUnreadCount,
    parentChannelFiltered.items.reduce(
      (sum, item) => sum + item.unreadCount,
      0,
    ),
    "channelId filter should scope unread totals to the selected channel",
  );
  const limitedParentChannelFiltered = await getInbox(
    "all",
    1,
    f.parentChannelId,
  );
  assert.equal(limitedParentChannelFiltered.items.length, 1);
  assert.equal(
    limitedParentChannelFiltered.totalCount,
    parentChannelFiltered.totalCount,
    "channelId-filtered total count should not depend on loaded page size",
  );
  assert.equal(
    limitedParentChannelFiltered.totalUnreadCount,
    parentChannelFiltered.totalUnreadCount,
    "channelId-filtered unread total should not depend on loaded page size",
  );
  const systemChannelFiltered = await getInbox(
    "all",
    undefined,
    systemOnlyChannel.id,
  );
  assert.deepEqual(
    systemChannelFiltered.items.map((item) =>
      item.kind === "thread" ? item.parentChannelId : item.channelId,
    ),
    [systemOnlyChannel.id],
    "channelId filter should exclude unrelated channel/thread rows",
  );
  const emptyChannelFiltered = await getInbox(
    "all",
    undefined,
    emptyChannel.id,
  );
  assert.equal(
    emptyChannelFiltered.items.length,
    0,
    "channelId filter should not fabricate rows for channels with no activity",
  );
  assert.equal(emptyChannelFiltered.totalCount, 0);
  assert.equal(emptyChannelFiltered.totalUnreadCount, 0);
  const contentSearch = await getInbox(
    "all",
    undefined,
    undefined,
    "thread reply message",
  );
  assert.deepEqual(
    contentSearch.items.map((item) => item.kind),
    ["thread"],
    "free-text search should match the thread activity preview before pagination",
  );
  assert.equal(contentSearch.totalCount, 1);
  assert.deepEqual(
    contentSearch.groups.map((group) => [group.channelId, group.count]),
    [[f.parentChannelId, 1]],
    "group counts should compose with search",
  );
  const senderSearch = await getInbox(
    "all",
    undefined,
    undefined,
    "Member B",
  );
  assert.deepEqual(
    senderSearch.items.map((item) =>
      item.kind === "thread" ? item.threadChannelId : item.channelId,
    ),
    [f.parentChannelId],
    "free-text search should match the visible sender name",
  );
  const channelAndQueryFiltered = await getInbox(
    "all",
    1,
    f.parentChannelId,
    "thread reply message",
  );
  assert.equal(channelAndQueryFiltered.items.length, 1);
  assert.equal(
    channelAndQueryFiltered.totalCount,
    1,
    "q + channelId should scope totals before pagination",
  );
  assert.equal(
    initial.totalCount,
    initial.items.length,
    "unpaginated fixture should report exact active Inbox row count",
  );
  assert.equal(
    initial.totalUnreadCount,
    initial.items.reduce((sum, item) => sum + item.unreadCount, 0),
  );
  assert.equal(
    initial.activeUnreadCount,
    initial.totalUnreadCount,
    "All exposes the global active unread total",
  );
  assert.ok(
    initial.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "joined regular channel should be an Inbox item",
  );
  const parentInboxItem = initial.items.find(
    (item) => item.kind === "channel" && item.channelId === f.parentChannelId,
  );
  assert.ok(parentInboxItem?.kind === "channel");
  assert.equal(
    parentInboxItem.lastMessageId,
    channelLatestMessage.id,
    "channel Inbox item should carry the latest message id for permalink navigation",
  );
  assert.equal(
    parentInboxItem.firstUnreadMessageId,
    channelLatestMessage.id,
    "channel Inbox item should carry the earliest unread non-self message id as the click target",
  );
  assert.equal(
    parentInboxItem.firstMentionMessageId,
    channelLatestMessage.id,
    "channel Inbox item should carry the first unread @mention message id",
  );
  assert.ok(
    !initial.items.some(
      (item) => item.kind === "channel" && item.channelId === emptyChannel.id,
    ),
    "joined regular channel with no messages should not be an Inbox item",
  );
  assert.ok(
    initial.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === systemOnlyChannel.id,
    ),
    "system messages count as channel activity for Inbox eligibility",
  );
  assert.ok(
    initial.items.some(
      (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
    ),
    "followed non-done thread should be an Inbox item",
  );
  const threadInboxItem = initial.items.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  );
  assert.ok(threadInboxItem?.kind === "thread");
  assert.equal(
    threadInboxItem.latestActivityMessageId,
    threadReplyMessage.id,
    "thread Inbox item should carry the latest reply id for permalink navigation",
  );
  assert.equal(
    threadInboxItem.firstUnreadMessageId,
    threadReplyMessage.id,
    "thread Inbox item should carry the earliest unread reply id as the click target",
  );
  assert.equal(
    threadInboxItem.firstMentionMessageId,
    null,
    "thread Inbox item with no @mention in the unread range must have a null firstMentionMessageId even though it has unread replies",
  );
  const followerRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.followerToken, f.serverId),
  });
  assert.equal(followerRes.status, 200);
  const followerBody = (await followerRes.json()) as {
    items: Array<{ kind: string; threadChannelId?: string }>;
  };
  assert.ok(
    followerBody.items.some(
      (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
    ),
    "existing thread participant should see the followed thread in Inbox",
  );
  const memberBRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.memberBToken, f.serverId),
  });
  assert.equal(memberBRes.status, 200);
  const memberBBody = (await memberBRes.json()) as {
    items: Array<{ kind: string; threadChannelId?: string }>;
  };
  assert.ok(
    !memberBBody.items.some(
      (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
    ),
    "parent channel membership without thread participation must not surface the thread in Inbox",
  );

  const unread = await getInbox("unread");
  assert.ok(
    unread.items.length > 0,
    "unread filter should be separate from active Inbox state",
  );
  assert.ok(unread.items.every((item) => item.unreadCount > 0));

  // Plan A semantics: mentions filter = "every channel/thread where I've
  // been @mentioned, read or unread". Aggregation stays per channel/thread.
  const mentionsBeforeRead = await getInbox("mentions");
  assert.ok(
    mentionsBeforeRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "mentions filter should include the channel that contains an @mention of the user",
  );
  assert.ok(
    !mentionsBeforeRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === systemOnlyChannel.id,
    ),
    "mentions filter should exclude channels with no @mention",
  );
  assert.equal(
    mentionsBeforeRead.totalCount,
    mentionsBeforeRead.items.length,
    "mentions total should count filtered rows",
  );
  assert.equal(
    mentionsBeforeRead.activeUnreadCount,
    initial.activeUnreadCount,
    "Mentions keeps the global active unread total used by Activity entry indicators",
  );
  assert.ok(
    mentionsBeforeRead.totalUnreadCount <
      mentionsBeforeRead.activeUnreadCount,
    "fixture must distinguish filtered unread from global active unread",
  );
  const unreadMentionsBeforeRead = await getInbox("unread_mentions");
  assert.ok(
    unreadMentionsBeforeRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "Unread + Mentions should include a row whose unread range contains an @mention",
  );
  assert.ok(
    unreadMentionsBeforeRead.items.every(
      (item) => item.unreadCount > 0 && item.hasMention,
    ),
    "Unread + Mentions is the intersection of unread rows and unread mention rows",
  );
  const servingUnreadMentionsBeforeRead = await getInboxItems(
    f.serverId,
    f.ownerId,
    {
      filter: "unread_mentions",
      humanActivityMuteEnabled: true,
    },
  );
  assert.ok(
    servingUnreadMentionsBeforeRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "the serving-row backend preserves the composed Unread + Mentions result",
  );
  assert.ok(
    servingUnreadMentionsBeforeRead.items.every(
      (item) => item.unreadCount > 0 && item.hasMention,
    ),
    "the serving-row backend applies both composed predicates",
  );
  assert.deepEqual(
    servingUnreadMentionsBeforeRead.groups.map((group) => [
      group.channelId,
      group.count,
    ]),
    [[f.parentChannelId, 1]],
    "the serving-row backend groups the composed result by the parent channel",
  );

  // Read the mentioning channel — Plan A: row stays in mentions filter.
  const readRes = await fetch(
    `${app.baseUrl}/api/channels/${f.parentChannelId}/read-all`,
    {
      method: "POST",
      headers: headers(f.ownerToken, f.serverId),
    },
  );
  assert.equal(readRes.status, 200);

  const mentionsAfterRead = await getInbox("mentions");
  assert.ok(
    mentionsAfterRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "Plan A: a row stays in the mentions filter even after the @mention is read",
  );
  assert.equal(
    mentionsAfterRead.totalUnreadCount,
    0,
    "read mention has no unread inside the Mentions result",
  );
  assert.ok(
    mentionsAfterRead.activeUnreadCount > 0,
    "other active unread still drives the global Activity indicator",
  );
  const unreadMentionsAfterRead = await getInbox("unread_mentions");
  assert.ok(
    !unreadMentionsAfterRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "reading the mention removes it from the composed Unread + Mentions result",
  );
  const servingUnreadMentionsAfterRead = await getInboxItems(
    f.serverId,
    f.ownerId,
    {
      filter: "unread_mentions",
      humanActivityMuteEnabled: true,
    },
  );
  assert.ok(
    !servingUnreadMentionsAfterRead.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "the serving-row composed result also drops a read mention",
  );

  const doneRes = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await channelDoneBody(f.parentChannelId)),
  });
  assert.equal(doneRes.status, 200);

  const afterDone = await getInbox();
  assert.ok(
    !afterDone.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "done channel should be hidden from Inbox",
  );
  assert.ok(
    afterDone.items.some(
      (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
    ),
    "marking a channel done must not hide a followed thread item",
  );
  const afterChannelDoneUnread = await getUnreadCounts();
  assert.equal(
    afterChannelDoneUnread[f.parentChannelId],
    undefined,
    "marking a channel done should also mark it read",
  );

  const threadDoneRes = await fetch(
    `${app.baseUrl}/api/channels/threads/done`,
    {
      method: "POST",
      headers: headers(f.ownerToken, f.serverId),
      body: JSON.stringify(await threadDoneBody(f.threadId)),
    },
  );
  assert.equal(threadDoneRes.status, 200);
  const afterThreadDoneUnread = await getUnreadCounts();
  assert.equal(
    afterThreadDoneUnread[f.threadId],
    undefined,
    "marking a thread done should also mark it read",
  );

  const newActivityMessage = await createMessage(
    f.parentChannelId,
    "user",
    f.memberBId,
    "new activity reopens channel",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: newActivityMessage,
  });
  const afterNewActivity = await getInbox();
  assert.ok(
    afterNewActivity.items.some(
      (item) =>
        item.kind === "channel" && item.channelId === f.parentChannelId,
    ),
    "new channel activity should clear the channel done marker",
  );
});


test("GET /channels/inbox firstMentionMessageId points at the first unread @mention, not the first unread message", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  // Channel: three unread non-self messages. The FIRST unread message is NOT a
  // mention; a LATER unread message IS the @mention. firstUnreadMessageId and
  // firstMentionMessageId must diverge so the new field's semantics (first
  // unread MENTION, ordered by seq ASC) are actually exercised.
  const channelEarlyUnread = await createMessage(f.parentChannelId, "user", f.memberBId, "earlier unread, no mention");
  const channelMentionMessage = await createMessage(f.parentChannelId, "user", f.memberBId, "later message that mentions @Owner");
  const channelLaterNonMention = await createMessage(f.parentChannelId, "user", f.memberBId, "even later, still no mention");
  await getDb().insert(messageMentions).values({
    messageId: channelMentionMessage.id,
    messageSeq: channelMentionMessage.seq,
    serverId: f.serverId,
    channelId: f.parentChannelId,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
  });
  // Seed the serving row off the EARLIEST unread message so the visible base
  // row's first_unread_message_id is the non-mention message.
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: channelEarlyUnread,
  });

  // Thread: unread replies but NO @mention of the owner anywhere. NEGATIVE
  // case — firstMentionMessageId must be null even with unread messages.
  const threadFirstReply = await createMessage(f.threadId, "user", f.followerId, "thread reply with no mention");
  await createMessage(f.threadId, "user", f.followerId, "another thread reply, still no mention");
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadFirstReply,
  });

  const items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);

  const channelItem = items.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(channelItem?.kind === "channel", "channel row must be present");
  assert.equal(channelItem.hasMention, true, "channel row must flag the unread mention");
  assert.equal(
    channelItem.firstUnreadMessageId,
    channelEarlyUnread.id,
    "firstUnreadMessageId must be the earliest unread message (the non-mention one)",
  );
  assert.equal(
    channelItem.firstMentionMessageId,
    channelMentionMessage.id,
    "firstMentionMessageId must be the FIRST unread message that @mentions the user, not the first unread message",
  );
  assert.notEqual(
    channelItem.firstMentionMessageId,
    channelItem.firstUnreadMessageId,
    "the positive case must actually diverge from firstUnreadMessageId",
  );
  assert.notEqual(
    channelItem.firstMentionMessageId,
    channelLaterNonMention.id,
    "firstMentionMessageId must not pick a later non-mention message",
  );

  const threadItem = items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(threadItem?.kind === "thread", "thread row must be present");
  assert.ok(threadItem.unreadCount > 0, "thread row must have unread replies for the negative case to be meaningful");
  assert.equal(threadItem.hasMention, false, "thread row has no @mention so hasMention must be false");
  assert.ok(
    threadItem.firstUnreadMessageId != null,
    "thread row carries an unread reply as firstUnreadMessageId",
  );
  assert.equal(
    threadItem.firstMentionMessageId,
    null,
    "NEGATIVE: thread with unread non-mention replies must have a null firstMentionMessageId",
  );
});


test("GET /channels/inbox firstMentionMessageId is the MIN-seq unread mention when there are multiple", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const baseline = await createMessage(f.parentChannelId, "user", f.memberBId, "unread baseline, no mention");
  const firstMention = await createMessage(f.parentChannelId, "user", f.memberBId, "first @Owner mention");
  const secondMention = await createMessage(f.parentChannelId, "user", f.memberBId, "second @Owner mention");
  const thirdMention = await createMessage(f.parentChannelId, "user", f.memberBId, "third @Owner mention");
  for (const m of [firstMention, secondMention, thirdMention]) {
    await getDb().insert(messageMentions).values({
      messageId: m.id,
      messageSeq: m.seq,
      serverId: f.serverId,
      channelId: f.parentChannelId,
      targetType: "user",
      targetId: f.ownerId,
      handleAtSendTime: "Owner",
    });
  }
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: baseline,
  });

  const items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const channelItem = items.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(channelItem?.kind === "channel", "channel row must be present");
  assert.equal(
    channelItem.firstMentionMessageId,
    firstMention.id,
    "firstMentionMessageId must be the MIN-seq (first) unread mention, not the latest/max",
  );
  assert.notEqual(channelItem.firstMentionMessageId, secondMention.id);
  assert.notEqual(channelItem.firstMentionMessageId, thirdMention.id);
});


test("GET /channels/inbox firstMentionMessageId ignores non-notifiable mentions until notified_at is set", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const baseline = await createMessage(f.parentChannelId, "user", f.memberBId, "unread baseline, no mention");
  const quietMention = await createMessage(f.parentChannelId, "user", f.memberBId, "@Owner but not notifiable");
  // notifiable_at_send=false AND notified_at IS NULL → must NOT count.
  await getDb().insert(messageMentions).values({
    messageId: quietMention.id,
    messageSeq: quietMention.seq,
    serverId: f.serverId,
    channelId: f.parentChannelId,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
    notifiableAtSend: false,
  });
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: baseline,
  });

  const before = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const beforeItem = before.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(beforeItem?.kind === "channel", "channel row must be present");
  assert.equal(
    beforeItem.firstMentionMessageId,
    null,
    "a mention with notifiable_at_send=false AND notified_at IS NULL must NOT count as a first unread mention",
  );

  // Once notified_at is set, the same mention counts.
  await getDb()
    .update(messageMentions)
    .set({ notifiedAt: new Date() })
    .where(eq(messageMentions.messageId, quietMention.id));

  const after = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const afterItem = after.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(afterItem?.kind === "channel", "channel row must be present");
  assert.equal(
    afterItem.firstMentionMessageId,
    quietMention.id,
    "once notified_at IS NOT NULL the mention counts as the first unread mention",
  );
});


test("GET /channels/inbox firstMentionMessageId advances past the read cursor", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const baseline = await createMessage(f.parentChannelId, "user", f.memberBId, "unread baseline, no mention");
  const firstMention = await createMessage(f.parentChannelId, "user", f.memberBId, "first @Owner mention");
  const secondMention = await createMessage(f.parentChannelId, "user", f.memberBId, "second @Owner mention");
  for (const m of [firstMention, secondMention]) {
    await getDb().insert(messageMentions).values({
      messageId: m.id,
      messageSeq: m.seq,
      serverId: f.serverId,
      channelId: f.parentChannelId,
      targetType: "user",
      targetId: f.ownerId,
      handleAtSendTime: "Owner",
    });
  }
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: baseline,
  });

  const initial = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const initialItem = initial.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(initialItem?.kind === "channel");
  assert.equal(initialItem.firstMentionMessageId, firstMention.id, "starts at the first unread mention");

  // Advance the read cursor past the first mention; the field moves to the next.
  await markRead(f.ownerId, f.parentChannelId, firstMention.seq);
  const afterFirst = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const afterFirstItem = afterFirst.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  assert.ok(afterFirstItem?.kind === "channel");
  assert.equal(
    afterFirstItem.firstMentionMessageId,
    secondMention.id,
    "after reading past the first mention the field moves to the next unread mention",
  );

  // Advance past every mention; the field becomes null.
  await markRead(f.ownerId, f.parentChannelId, secondMention.seq);
  const afterAll = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const afterAllItem = afterAll.find((item) => item.kind === "channel" && item.channelId === f.parentChannelId);
  if (afterAllItem) {
    assert.ok(afterAllItem.kind === "channel");
    assert.equal(
      afterAllItem.firstMentionMessageId,
      null,
      "after reading past all mentions the field becomes null",
    );
  }
});


test("GET /channels/inbox mention-only fallback rows anchor firstMentionMessageId to the mention even when read", async ({ app }) => {
  // Canonical rule (ApplePI A): a mention-only row exists ONLY because of the @
  // (unreadCount=0), so firstMentionMessageId is the mention ANCHOR — independent
  // of the read cursor — so clicking it always jumps to the @ (vs falling through
  // to last activity). This is the documented exception to the member-row
  // "first UNREAD personal mention" rule.

  const f = await seedThreadFixture(app.baseUrl);

  // A channel the owner is NOT a chat member of, surfaced ONLY via a public
  // (notified) @mention → it comes through mention_channel_rows (mention_only).
  const mentionOnlyChannel = await createChannel(f.serverId, "mention-only-room");
  await addHuman(mentionOnlyChannel.id, f.memberBId);
  const mentionMsg = await createMessage(mentionOnlyChannel.id, "user", f.memberBId, "public @Owner mention in a room I'm not in");
  await getDb().insert(messageMentions).values({
    messageId: mentionMsg.id,
    messageSeq: mentionMsg.seq,
    serverId: f.serverId,
    channelId: mentionOnlyChannel.id,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
    notifiedAt: new Date(),
  });

  // Read the mention. The mention-only row must STILL anchor to it (not null),
  // so the row continues to open the @ rather than last activity.
  await markRead(f.ownerId, mentionOnlyChannel.id, mentionMsg.seq);

  const items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const item = items.find((row) => row.kind === "channel" && row.channelId === mentionOnlyChannel.id);
  if (item) {
    assert.ok(item.kind === "channel");
    assert.equal(item.unreadCount, 0, "mention-only row does not count the channel as unread");
    assert.equal(
      item.firstMentionMessageId,
      mentionMsg.id,
      "a mention-only row anchors firstMentionMessageId to the mention even when read, so it always opens the @",
    );
  }
});


test("POST /channels/inbox/done dismisses accessible canonical-server items without weakening scope guards", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const publicMentionChannel = await createChannel(f.serverId, "public-outsider-done-room");
  await addHuman(publicMentionChannel.id, f.memberBId);

  const createNotifiedOutsiderMention = async (content: string) => {
    const message = await createMessage(publicMentionChannel.id, "user", f.memberBId, content);
    await db.insert(messageMentions).values({
      messageId: message.id,
      messageSeq: message.seq,
      serverId: f.serverId,
      channelId: publicMentionChannel.id,
      targetType: "user",
      targetId: f.ownerId,
      handleAtSendTime: "Owner",
      notifiedAt: new Date(),
    });
    return message;
  };

  const firstMention = await createNotifiedOutsiderMention("first notified outsider @Owner mention");
  let items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const mentionOnlyItem = items.find((item) => item.kind === "channel" && item.channelId === publicMentionChannel.id);
  assert.ok(mentionOnlyItem?.kind === "channel", "notified public outsider mention must surface in Inbox/All");
  assert.equal(mentionOnlyItem.firstMentionMessageId, firstMention.id);
  assert.equal(mentionOnlyItem.unreadCount, 0, "outsider mention row must stay mention-only");

  const laterNonMention = await createMessage(publicMentionChannel.id, "user", f.memberBId, "later public activity without mention");
  assert.ok(
    laterNonMention.seq > firstMention.seq,
    "test must keep the channel latest above the rendered mention frontier so broad channel Done is not applied",
  );

  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({
      channelId: publicMentionChannel.id,
      throughActivitySeq: String(firstMention.seq),
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, "a public channel row visible through a notified outsider mention must be dismissible");

  const [mentionSuppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetKind, "public_channel_mention"),
    eq(inboxSuppressionStates.targetChannelId, publicMentionChannel.id),
  ));
  assert.equal(String(mentionSuppression?.doneThroughSeq), String(firstMention.seq));
  const [broadInboxState] = await db.select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, f.ownerId),
    eq(userChannelInboxStates.channelId, publicMentionChannel.id),
  ));
  assert.equal(
    broadInboxState?.doneAt ?? null,
    null,
    "bounded mention-only Done must not rely on the broad channel done marker when newer non-mention activity exists",
  );

  items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.ok(
    !items.some((item) => item.kind === "channel" && item.channelId === publicMentionChannel.id),
    "dismissed outsider mention row must stay gone after a fresh Inbox read",
  );

  const secondMention = await createNotifiedOutsiderMention("later notified outsider @Owner mention");
  items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const reopenedItem = items.find((item) => item.kind === "channel" && item.channelId === publicMentionChannel.id);
  assert.ok(reopenedItem?.kind === "channel", "new activity after done must reopen the public outsider mention row");
  assert.equal(reopenedItem.firstMentionMessageId, secondMention.id, "reopened row must anchor to the new notified mention");

  const canonicalServer = await createServer("Canonical Done Scope", "canonical-done-scope", f.ownerId);
  await db.insert(serverMembers).values({
    serverId: canonicalServer.id,
    userId: f.memberBId,
    role: "member",
  }).onConflictDoNothing();
  const crossServerPublic = await createChannel(canonicalServer.id, "cross-server-public-done-room");
  const crossServerMessage = await createMessage(
    crossServerPublic.id,
    "user",
    f.memberBId,
    "activity from the item's canonical server",
  );
  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await channelDoneBody(crossServerPublic.id)),
  });
  assert.equal(
    response.status,
    200,
    "an accessible server-B item must be dismissible while server A is the active request context",
  );

  const crossServerDm = await findOrCreateUserDM(canonicalServer.id, f.ownerId, f.memberBId);
  assert.ok(crossServerDm);
  const crossServerDmMessage = await createMessage(
    crossServerDm.id,
    "user",
    f.memberBId,
    "cross-server DM activity",
  );
  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await channelDoneBody(crossServerDm.id)),
  });
  assert.equal(response.status, 200, "canonical-server resolution must preserve participant-scoped DM access");

  const [crossServerInboxStates, crossServerReadCursors, crossServerSuppressions] = await Promise.all([
    db.select().from(userChannelInboxStates).where(and(
      eq(userChannelInboxStates.userId, f.ownerId),
      inArray(userChannelInboxStates.channelId, [crossServerPublic.id, crossServerDm.id]),
    )),
    db.select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, f.ownerId),
      inArray(userChannelReadCursors.channelId, [crossServerPublic.id, crossServerDm.id]),
    )),
    db.select().from(inboxSuppressionStates).where(and(
      eq(inboxSuppressionStates.receiverId, f.ownerId),
      inArray(inboxSuppressionStates.targetChannelId, [crossServerPublic.id, crossServerDm.id]),
    )),
  ]);
  assert.deepEqual(
    crossServerInboxStates.map((row) => row.channelId).sort(),
    [crossServerPublic.id, crossServerDm.id].sort(),
    "cross-server done writes only the requested canonical targets",
  );
  assert.deepEqual(
    crossServerReadCursors.map((row) => [row.channelId, row.lastReadSeq]).sort(),
    [[crossServerPublic.id, crossServerMessage.seq], [crossServerDm.id, crossServerDmMessage.seq]].sort(),
    "cross-server done advances each canonical target through its own latest sequence",
  );
  assert.deepEqual(
    [...new Set(crossServerSuppressions.map((row) => row.targetChannelId))].sort(),
    [crossServerPublic.id, crossServerDm.id].sort(),
    "durable suppression target kinds must stay scoped to the two requested canonical targets",
  );
  assert.ok(
    crossServerSuppressions.every((row) => row.serverId === canonicalServer.id),
    "durable suppressions must be stamped with the target's canonical server, not the active server",
  );

  const privateChannel = await createChannel(f.serverId, "private-outsider-done-room", undefined, "private");
  await addHuman(privateChannel.id, f.memberBId);
  const outsiderDm = await findOrCreateUserDM(f.serverId, f.memberBId, f.followerId);
  assert.ok(outsiderDm);
  const [jointStorageServer] = await db.insert(serversTable).values({
    name: "Joint Done Storage",
    slug: "__joint_done_storage__",
    kind: "joint_storage",
    ownerId: f.memberBId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const jointCanonical = await createChannel(jointStorageServer.id, "joint-done-canonical");
  const inaccessibleJoint = await createChannel(f.serverId, "joint-outsider-done-room", undefined, "joint");
  await addHuman(inaccessibleJoint.id, f.memberBId);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointCanonical.id,
    createdByServerId: f.serverId,
    createdByUserId: f.memberBId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: f.serverId,
    localChannelId: inaccessibleJoint.id,
    role: "host",
    joinedByUserId: f.memberBId,
  });
  const crossServerPrivate = await createChannel(canonicalServer.id, "cross-server-private-done-room", undefined, "private");
  const unauthorizedServer = await createServer("Unauthorized Done Scope", "unauthorized-done-scope", f.memberBId);
  const unauthorizedCrossServerPublic = await createChannel(unauthorizedServer.id, "unauthorized-cross-server-done-room");
  const missingChannelId = randomUUID();
  const unauthorizedChannelIds = [
    privateChannel.id,
    outsiderDm.id,
    inaccessibleJoint.id,
    f.threadId,
    crossServerPrivate.id,
    unauthorizedCrossServerPublic.id,
    missingChannelId,
  ];

  for (const channelId of unauthorizedChannelIds) {
    response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
      method: "POST",
      headers: headers(f.ownerToken, f.serverId),
      body: JSON.stringify({
        channelId,
        throughActivitySeq: "1",
        frontierSpace: "storage",
      }),
    });
    assert.equal(response.status, 404, `unauthorized done target ${channelId} must remain fail-closed`);
  }

  const [unauthorizedInboxStates, unauthorizedReadCursors, unauthorizedSuppressions] = await Promise.all([
    db.select().from(userChannelInboxStates).where(and(
      eq(userChannelInboxStates.userId, f.ownerId),
      inArray(userChannelInboxStates.channelId, unauthorizedChannelIds),
    )),
    db.select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, f.ownerId),
      inArray(userChannelReadCursors.channelId, unauthorizedChannelIds),
    )),
    db.select().from(inboxSuppressionStates).where(and(
      eq(inboxSuppressionStates.receiverId, f.ownerId),
      inArray(inboxSuppressionStates.targetChannelId, unauthorizedChannelIds),
    )),
  ]);
  assert.equal(unauthorizedInboxStates.length, 0, "rejected done targets must not write legacy inbox state");
  assert.equal(unauthorizedReadCursors.length, 0, "rejected done targets must not advance read cursors");
  assert.equal(unauthorizedSuppressions.length, 0, "rejected done targets must not write durable suppression state");

  const memberDm = await findOrCreateUserDM(f.serverId, f.ownerId, f.memberBId);
  assert.ok(memberDm);
  await createMessage(memberDm.id, "user", f.memberBId, "member DM Done frontier");
  for (const channelId of [f.parentChannelId, memberDm.id]) {
    response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
      method: "POST",
      headers: headers(f.ownerToken, f.serverId),
      body: JSON.stringify(await channelDoneBody(channelId)),
    });
    assert.equal(response.status, 200, `existing member channel/DM done target ${channelId} must not regress`);
  }
});


test("POST /channels/threads/done dismisses public mention-only thread rows until a newer mention", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  const createNotifiedOutsiderThreadMention = async (content: string) => {
    const message = await createMessage(f.threadId, "user", f.memberBId, content);
    await db.insert(messageMentions).values({
      messageId: message.id,
      messageSeq: message.seq,
      serverId: f.serverId,
      channelId: f.threadId,
      targetType: "user",
      targetId: f.outsiderId,
      handleAtSendTime: "Outsider",
      notifiedAt: new Date(),
    });
    return message;
  };

  const firstMention = await createNotifiedOutsiderThreadMention("first public thread @Outsider mention");
  let items = await fetchInboxAll(app.baseUrl, f.outsiderToken, f.serverId);
  const mentionOnlyThread = items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(mentionOnlyThread?.kind === "thread", "notified public thread mention must surface in Inbox/All");
  assert.equal(mentionOnlyThread.firstMentionMessageId, firstMention.id);
  assert.equal(mentionOnlyThread.firstUnreadMessageId, firstMention.id);
  assert.equal(mentionOnlyThread.unreadCount, 0, "public thread mention row must stay mention-only");

  const response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.outsiderToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(response.status, 200, "a public thread row visible only through a notified mention must be dismissible");

  const [suppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.outsiderId),
    eq(inboxSuppressionStates.targetKind, "public_thread_mention"),
    eq(inboxSuppressionStates.targetChannelId, f.threadId),
  ));
  assert.equal(String(suppression?.doneThroughSeq), String(firstMention.seq));

  items = await fetchInboxAll(app.baseUrl, f.outsiderToken, f.serverId);
  assert.ok(
    !items.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId),
    "dismissed public thread mention row must stay gone after a fresh Inbox read",
  );

  const secondMention = await createNotifiedOutsiderThreadMention("later public thread @Outsider mention");
  items = await fetchInboxAll(app.baseUrl, f.outsiderToken, f.serverId);
  const reopenedThread = items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(reopenedThread?.kind === "thread", "new mention after done must reopen the public thread mention row");
  assert.equal(reopenedThread.firstMentionMessageId, secondMention.id);
  assert.equal(reopenedThread.firstUnreadMessageId, secondMention.id);
});


test("read_receipts_v0 exposes ONLY agent watermarks (never human) and emits only advancing agent frames", async ({ app }) => {
  const events = installFakeIo(app.app);
  const owner = await seedUser("receipt-owner@slock.test", "receipt-owner");
  const member = await seedUser("receipt-member@slock.test", "receipt-member");
  const server = await createServer("Receipt Server", "receipt-server", owner.id);
  await addMember(server.id, member.id);
  const channel = await createChannel(server.id, "receipt-channel", undefined, "private");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, "receipt-agent");
  await addAgent(channel.id, agent.id);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const first = await createMessage(channel.id, "user", owner.id, "receipt first");
  const second = await createMessage(channel.id, "user", owner.id, "receipt second");
  await markRead(member.id, channel.id, first.seq);
  await getDb().insert(agentChannelReadCursors).values({
    agentId: agent.id,
    channelId: channel.id,
    lastReadSeq: second.seq,
  });

  const flagOffDetail = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(flagOffDetail.status, 200);
  const flagOffBody = await flagOffDetail.json() as Record<string, unknown>;
  assert.equal("peerReadStates" in flagOffBody, false);
  assert.equal("peerReadSummary" in flagOffBody, false);

  const flagOffRead = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ seq: second.seq }),
  });
  assert.equal(flagOffRead.status, 200);
  assert.equal(events.some((event) => event.event === "scope_read:updated"), false);

  await enableReadReceiptsForServer(server.id);
  const detail = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    peerReadStates?: Array<{ peerKind: string; peerId: string; maxReadSeq: number }>;
    peerReadSummary?: unknown;
  };
  assert.equal(detailBody.peerReadSummary, undefined);
  // #693 (artin): a human's read state must NEVER leave the server. Only
  // agent peers are exposed — hiding it in the UI is not enough, because the
  // payload is trivially observable in devtools.
  assert.deepEqual(detailBody.peerReadStates, [
    { peerKind: "agent", peerId: agent.id, maxReadSeq: second.seq },
  ]);
  assert.equal(
    detailBody.peerReadStates?.some((peer) => peer.peerKind === "human"),
    false,
    "human read state must not be exposed over the API",
  );

  const eventCountBeforeOwnerSend = events.length;
  const ownerSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: channel.id, content: "receipt third" }),
  });
  assert.equal(ownerSend.status, 200);
  const third = await ownerSend.json() as { seq: number };
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A human's own read (auto-read on send) must not be broadcast to the
  // channel room at all — that push path is the other half of the leak.
  assert.deepEqual(
    events.slice(eventCountBeforeOwnerSend).filter((event) => event.event === "scope_read:updated"),
    [],
    "a human read must not emit scope_read:updated",
  );
  const eventCountBeforeAdvance = events.length;
  const read = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ seq: third.seq }),
  });
  assert.equal(read.status, 200);
  assert.deepEqual(
    events.slice(eventCountBeforeAdvance).filter((event) => event.event === "scope_read:updated"),
    [],
    "an explicit human /read must not emit scope_read:updated",
  );

  const agentCredential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "read-receipts-agent-history",
    createdByUserId: null,
  });
  const eventCountBeforeAgentRead = events.length;
  const agentHistory = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#receipt-channel")}&limit=10`,
    { headers: { Authorization: `Bearer ${agentCredential.apiKey}` } },
  );
  assert.equal(agentHistory.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events.slice(eventCountBeforeAgentRead).filter((event) => event.event === "scope_read:updated"), [{
    room: `channel:${channel.id}`,
    event: "scope_read:updated",
    payload: {
      scopeId: channel.id,
      peerKind: "agent",
      peerId: agent.id,
      maxReadSeq: third.seq,
    },
  }]);
  const eventCountBeforeAgentNoop = events.length;
  const repeatedAgentHistory = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#receipt-channel")}&limit=10`,
    { headers: { Authorization: `Bearer ${agentCredential.apiKey}` } },
  );
  assert.equal(repeatedAgentHistory.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, eventCountBeforeAgentNoop, "non-advancing agent reads must not emit peer frames");

  const eventCountBeforeNoop = events.length;
  const repeated = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ seq: second.seq }),
  });
  assert.equal(repeated.status, 200);
  assert.equal(events.length, eventCountBeforeNoop, "non-advancing reads must not emit peer frames");

  const eventCountBeforeUnread = events.length;
  const unread = await fetch(`${app.baseUrl}/api/channels/${channel.id}/unread`, {
    method: "POST",
    headers: headers(memberToken, server.id),
  });
  assert.equal(unread.status, 200);
  assert.equal(
    events.slice(eventCountBeforeUnread).some((event) => event.event === "scope_read:updated"),
    false,
    "mark-unread must remain self-only",
  );

  await removeHuman(channel.id, member.id);
  await removeAgent(channel.id, agent.id);
  const afterRemoval = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(afterRemoval.status, 200);
  const afterRemovalBody = await afterRemoval.json() as { peerReadStates?: unknown[] };
  assert.deepEqual(afterRemovalBody.peerReadStates, [], "removed peers must disappear even when cursor rows remain");
  const eventCountBeforeRemovedRead = events.length;
  const removedRead = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ seq: third.seq }),
  });
  assert.equal(removedRead.status, 404);
  assert.equal(events.length, eventCountBeforeRemovedRead, "removed peers must receive and emit no future receipt exposure");
});


test("read_receipts_v0 hydrates a DM peer watermark", async ({ app }) => {
  const owner = await seedUser("receipt-dm-owner@slock.test", "receipt-dm-owner");
  const server = await createServer("Receipt DM Server", "receipt-dm-server", owner.id);
  const agent = await createAgent(server.id, "receipt-dm-agent");
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const message = await createMessage(dm.id, "user", owner.id, "receipt dm message");
  await getDb().insert(agentChannelReadCursors).values({
    agentId: agent.id,
    channelId: dm.id,
    lastReadSeq: message.seq,
  });
  await enableReadReceiptsForServer(server.id);
  const token = await tokenForHuman(owner.email);

  const detail = await fetch(`${app.baseUrl}/api/channels/${dm.id}`, {
    headers: headers(token, server.id),
  });
  assert.equal(detail.status, 200);
  const body = await detail.json() as { peerReadStates?: unknown[] };
  assert.deepEqual(body.peerReadStates, [{
    peerKind: "agent",
    peerId: agent.id,
    maxReadSeq: message.seq,
  }]);
});


test("read_receipts_v0 does not bypass the hidden human directory through #all", async ({ app }) => {
  const events = installFakeIo(app.app);
  const db = getDb();
  const owner = await seedUser("receipt-all-owner@slock.test", "receipt-all-owner");
  const member = await seedUser("receipt-all-member@slock.test", "receipt-all-member");
  const other = await seedUser("receipt-all-other@slock.test", "receipt-all-other");
  const server = await createServer("Receipt All Server", "receipt-all-server", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel);
  const message = await createMessage(allChannel.id, "user", owner.id, "hidden receipt all message");
  await enableReadReceiptsForServer(server.id);
  const memberToken = await tokenForHuman(member.email);

  const detail = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(detail.status, 200);
  const body = await detail.json() as Record<string, unknown>;
  assert.equal("peerReadStates" in body, false);
  assert.equal("peerReadSummary" in body, false);

  const beforeRead = events.length;
  const read = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/read`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ seq: message.seq }),
  });
  assert.equal(read.status, 200);
  assert.equal(
    events.slice(beforeRead).some((event) => event.event === "scope_read:updated"),
    false,
    "#all read progress must not leak hidden human peer IDs through room fanout",
  );
});


test("read_receipts_v0 degrades large scopes to anonymous summary hydrate and realtime", async ({ app }) => {
  const events = installFakeIo(app.app);
  const owner = await seedUser("receipt-large-owner@slock.test", "receipt-large-owner");
  const server = await createServer("Receipt Large Server", "receipt-large-server", owner.id);
  const channel = await createChannel(server.id, "receipt-large-channel", undefined, "private");
  await addHuman(channel.id, owner.id);
  const first = await createMessage(channel.id, "user", owner.id, "receipt large first");
  // #693: only AGENTS are exposed as read peers, so the summary-degradation
  // threshold is now reached by agent count. Seeding humans here would leave
  // the exposed peer set empty and silently stop exercising this path.
  const peers: Array<{ id: string }> = [];
  for (let index = 0; index <= READ_RECEIPT_PEER_STATE_LIMIT + 1; index += 1) {
    const peer = await createAgent(server.id, `receipt-large-agent-${index}`, { runtime: "codex" });
    peers.push(peer);
    await addAgent(channel.id, peer.id);
  }
  await getDb().insert(agentChannelReadCursors).values({
    channelId: channel.id,
    agentId: peers[0]!.id,
    lastReadSeq: first.seq,
  });
  await enableReadReceiptsForServer(server.id);
  const ownerToken = await tokenForHuman(owner.email);

  const detail = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(detail.status, 200);
  const body = await detail.json() as {
    peerReadStates?: unknown;
    peerReadSummary?: { peerCount: number; readCountAtSeq: Array<{ seq: number; count: number }> };
  };
  assert.equal(body.peerReadStates, undefined);
  assert.deepEqual(body.peerReadSummary, {
    peerCount: READ_RECEIPT_PEER_STATE_LIMIT + 2,
    readCountAtSeq: [
      { seq: 0, count: READ_RECEIPT_PEER_STATE_LIMIT + 2 },
      { seq: first.seq, count: 1 },
    ],
  });

  // Advance an AGENT peer (agents are the only exposed peers now).
  const advancingPeer = peers[1]!;
  const advancingCredential = await mintAgentCredential({
    agentId: advancingPeer.id,
    scopes: ["read"],
    name: "receipt-large-advancing",
    createdByUserId: null,
  });
  const beforeRead = events.length;
  const read = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#receipt-large-channel")}&limit=10`,
    { headers: { Authorization: `Bearer ${advancingCredential.apiKey}` } },
  );
  assert.equal(read.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const receiptEvents = events.slice(beforeRead).filter((event) => event.event === "scope_read:updated");
  assert.deepEqual(receiptEvents, [{
    room: `channel:${channel.id}`,
    event: "scope_read:updated",
    payload: { scopeId: channel.id, summaryChanged: true },
  }]);
  assert.equal(JSON.stringify(receiptEvents).includes(advancingPeer.id), false, "large-scope emit must not leak peerId");
  const refreshed = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = await refreshed.json() as {
    peerReadSummary?: { readCountAtSeq: Array<{ seq: number; count: number }> };
  };
  assert.deepEqual(refreshedBody.peerReadSummary?.readCountAtSeq, [
    { seq: 0, count: READ_RECEIPT_PEER_STATE_LIMIT + 2 },
    { seq: first.seq, count: 2 },
  ]);
  // 52 agents → removing one still leaves 51 (> limit). Remove two to fall
  // back under the threshold and prove the per-peer path returns.
  await removeAgent(channel.id, peers.at(-1)!.id);
  await removeAgent(channel.id, peers.at(-2)!.id);
  const bounded = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(bounded.status, 200);
  const boundedBody = await bounded.json() as { peerReadStates?: unknown[]; peerReadSummary?: unknown };
  assert.equal(boundedBody.peerReadSummary, undefined);
  assert.equal(boundedBody.peerReadStates?.length, READ_RECEIPT_PEER_STATE_LIMIT);
});


test("read_receipts_v0 at exactly LIMIT+1 agents keeps hydrate and realtime on the same summary side", async ({ app }) => {
  const events = installFakeIo(app.app);
  const owner = await seedUser("receipt-edge-owner@slock.test", "receipt-edge-owner");
  const server = await createServer("Receipt Edge Server", "receipt-edge-server", owner.id);
  const channel = await createChannel(server.id, "receipt-edge-channel", undefined, "private");
  await addHuman(channel.id, owner.id);
  const first = await createMessage(channel.id, "user", owner.id, "receipt edge first");

  // EXACTLY LIMIT+1 exposed agents. This is the boundary the LIMIT+2 test
  // jumps over: the emitter used to compute `members.length - 1`, a leftover
  // from when `members` still held humans and the actor was always inside it.
  // With agents-only exposure a human viewer's hydrate is a summary here
  // (states.length > LIMIT) while the emitter saw LIMIT and sent a detailed
  // frame — which a summary scope ignores, freezing the count forever.
  const agents: Array<{ id: string }> = [];
  for (let index = 0; index <= READ_RECEIPT_PEER_STATE_LIMIT; index += 1) {
    const agent = await createAgent(server.id, `receipt-edge-agent-${index}`, { runtime: "codex" });
    agents.push(agent);
    await addAgent(channel.id, agent.id);
  }
  assert.equal(agents.length, READ_RECEIPT_PEER_STATE_LIMIT + 1);
  await enableReadReceiptsForServer(server.id);
  const ownerToken = await tokenForHuman(owner.email);

  const detail = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(detail.status, 200);
  const body = await detail.json() as {
    peerReadStates?: unknown;
    peerReadSummary?: { peerCount: number; readCountAtSeq: Array<{ seq: number; count: number }> };
  };
  assert.equal(body.peerReadStates, undefined, "human hydrate must be summary at LIMIT+1 agents");
  assert.equal(body.peerReadSummary?.peerCount, READ_RECEIPT_PEER_STATE_LIMIT + 1);

  // An agent advancing must emit summaryChanged, NOT a detailed frame, or the
  // human's summary can never refresh.
  const advancing = agents[0]!;
  const credential = await mintAgentCredential({
    agentId: advancing.id,
    scopes: ["read"],
    name: "receipt-edge-advancing",
    createdByUserId: null,
  });
  const beforeAdvance = events.length;
  const advanced = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent("#receipt-edge-channel")}&limit=10`,
    { headers: { Authorization: `Bearer ${credential.apiKey}` } },
  );
  assert.equal(advanced.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    events.slice(beforeAdvance).filter((event) => event.event === "scope_read:updated"),
    [{
      room: `channel:${channel.id}`,
      event: "scope_read:updated",
      payload: { scopeId: channel.id, summaryChanged: true },
    }],
    "at LIMIT+1 the realtime frame must stay on the summary side",
  );

  // And the summary actually moves once rehydrated.
  const refreshed = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = await refreshed.json() as {
    peerReadSummary?: { readCountAtSeq: Array<{ seq: number; count: number }> };
  };
  assert.deepEqual(refreshedBody.peerReadSummary?.readCountAtSeq, [
    { seq: 0, count: READ_RECEIPT_PEER_STATE_LIMIT + 1 },
    { seq: first.seq, count: 1 },
  ]);

  // Dropping to exactly LIMIT returns to per-peer detail.
  await removeAgent(channel.id, agents.at(-1)!.id);
  const bounded = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(bounded.status, 200);
  const boundedBody = await bounded.json() as { peerReadStates?: unknown[]; peerReadSummary?: unknown };
  assert.equal(boundedBody.peerReadSummary, undefined);
  assert.equal(boundedBody.peerReadStates?.length, READ_RECEIPT_PEER_STATE_LIMIT);
});


test("POST /channels/inbox/read-all marks every active Inbox row read", async ({ app }) => {
  const events = installFakeIo(app.app);
  const f = await seedThreadFixture(app.baseUrl);

  const channelMessage = await createMessage(f.parentChannelId, "user", f.memberBId, "channel unread for mark all");
  const threadMessage = await createMessage(f.threadId, "user", f.followerId, "thread unread for mark all");
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: f.parentChannelId,
    message: channelMessage,
  });
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadMessage,
  });
  const db = getDb();
  const [storageNamespace] = await db.insert(serversTable).values({
    name: "Joint Storage Namespace",
    slug: "__joint_storage__",
    kind: "joint_storage",
    ownerId: f.ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const canonical = await createChannel(storageNamespace.id, "joint-storage-mark-all");
  const projection = await createChannel(f.serverId, "joint-mark-all-hidden", undefined, "joint");
  await addHuman(projection.id, f.ownerId);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: f.serverId,
    localChannelId: projection.id,
    role: "host",
    joinedByUserId: f.ownerId,
  });
  const jointLatest = await createMessage(canonical.id, "user", f.memberBId, "joint unread for mark all");
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: projection.id,
    message: jointLatest,
  });

  const beforeUnread = await fetch(`${app.baseUrl}/api/channels/inbox?filter=unread`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(beforeUnread.status, 200);
  const beforeBody = await beforeUnread.json() as {
    items: Array<
      | { kind: "channel"; channelId: string; unreadCount: number }
      | { kind: "thread"; threadChannelId: string; unreadCount: number }
    >;
    totalUnreadCount: number;
  };
  assert.ok(
    beforeBody.items.some((item) => item.kind === "channel" && item.channelId === f.parentChannelId && item.unreadCount > 0),
    "channel row should start unread",
  );
  assert.ok(
    beforeBody.items.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId && item.unreadCount > 0),
    "thread row should start unread",
  );
  assert.ok(
    beforeBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.unreadCount > 0),
    "top-level joint channel should start unread in Activity",
  );
  assert.ok(beforeBody.totalUnreadCount > 0);

  const readAll = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(readAll.status, 200);
  const readAllBody = await readAll.json() as {
    markedCount: number;
    scopes: Array<{ scopeId: string; maxReadSeq: number; readStateVersion: number }>;
  };
  assert.ok(readAllBody.markedCount >= 3, "should update channel, thread, and joint projection read cursors");
  assert.ok(readAllBody.scopes.some((scope) =>
    scope.scopeId === f.parentChannelId
    && scope.maxReadSeq >= channelMessage.seq
    && scope.readStateVersion === 1
  ));
  assert.deepEqual(events.at(-1), {
    room: `user:${f.ownerId}`,
    event: "read_state:updated_bulk",
    payload: {
      serverId: f.serverId,
      scopes: readAllBody.scopes,
    },
  });
  const afterReadAllEventCount = events.length;
  const repeatedReadAll = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(repeatedReadAll.status, 200);
  assert.deepEqual(await repeatedReadAll.json(), {
    ok: true,
    markedCount: 0,
    scopes: [],
  });
  assert.equal(events.length, afterReadAllEventCount, "inbox read-all no-op must not emit bulk frame");

  const afterUnread = await fetch(`${app.baseUrl}/api/channels/inbox?filter=unread`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(afterUnread.status, 200);
  const afterUnreadBody = await afterUnread.json() as { items: unknown[]; totalUnreadCount: number };
  assert.deepEqual(afterUnreadBody.items, []);
  assert.equal(afterUnreadBody.totalUnreadCount, 0);

  const afterAll = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(afterAll.status, 200);
  const afterAllBody = await afterAll.json() as {
    items: Array<
      | { kind: "channel"; channelId: string; unreadCount: number }
      | { kind: "thread"; threadChannelId: string; unreadCount: number }
    >;
  };
  assert.ok(
    afterAllBody.items.some((item) => item.kind === "channel" && item.channelId === f.parentChannelId && item.unreadCount === 0),
    "mark all read should not mark channel done",
  );
  assert.ok(
    afterAllBody.items.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId && item.unreadCount === 0),
    "mark all read should not mark thread done",
  );
  assert.ok(
    afterAllBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.unreadCount === 0),
    "mark all read should keep top-level joint Activity visible but read",
  );
  const jointCursorRows = await db
    .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, f.ownerId),
      eq(userChannelReadCursors.channelId, projection.id),
    ));
  assert.equal(jointCursorRows.length, 1, "Activity mark-all should advance top-level joint local projection cursors");
  assert.ok(jointCursorRows[0].lastReadSeq >= jointLatest.seq);
  const unreadCounts = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(unreadCounts.status, 200);
  const unreadCountsBody = await unreadCounts.json() as Record<string, number>;
  assert.equal(unreadCountsBody[projection.id], undefined, "/channels/unread should clear top-level joint unread after Activity mark-all");
});


// ---------------------------------------------------------------------------
// task #34 (修法三): /threads/done's five-way 404 is split with ACCESS as the
// gate, never with CAUSE as the gate.
//
// Which distinction may be exposed is gated on whether the caller could reach
// the row at all. "Never existed", "lives in another server" and "you cannot
// see it" MUST stay byte-identical: distinguishing them turns this endpoint
// into an existence oracle over thread ids, which is a strictly worse defect
// than the poor error message it would fix.
//
// The teeth below assert byte-identical BODIES, not merely "also 404". A shared
// status with a differing `code` or `error` string is still an oracle.
// ---------------------------------------------------------------------------

test("threads/done keeps every access-denied cause byte-identical (no existence oracle)", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerHeaders = headers(f.ownerToken, f.serverId);

  // A private room the owner is NOT a member of, plus a thread inside it.
  const privateChannel = await createChannel(f.serverId, "private-room", undefined, "private");
  await addHuman(privateChannel.id, f.memberBId);
  const hiddenParent = await createMessage(privateChannel.id, "user", f.memberBId, "hidden");
  const hiddenThread = await getOrCreateThread(hiddenParent.id, f.memberBId, "user");

  const done = (threadChannelId: string) => fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      threadChannelId,
      throughActivitySeq: "1",
      frontierSpace: "storage",
    }),
  });

  // (a) never existed
  const absent = await done(randomUUID());
  // (b) a real thread the caller cannot see
  const noAccessThread = await done(hiddenThread.id);
  // (c) a real channel (wrong type) the caller cannot see
  const noAccessWrongType = await done(privateChannel.id);

  const bodies = await Promise.all([absent, noAccessThread, noAccessWrongType].map(r => r.text()));
  assert.equal(absent.status, 404);
  assert.equal(noAccessThread.status, 404, "an unreachable thread must not be distinguishable from a missing one");
  assert.equal(noAccessWrongType.status, 404, "wrong type must not leak to a caller without access");
  assert.equal(
    bodies[1],
    bodies[0],
    "no-access and never-existed must be BYTE-IDENTICAL -- a differing code/message is still an oracle",
  );
  assert.equal(
    bodies[2],
    bodies[0],
    "wrong-type-without-access must be BYTE-IDENTICAL to never-existed",
  );
});


test("threads/done differentiates causes only once access is established", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerHeaders = headers(f.ownerToken, f.serverId);
  const done = (threadChannelId: string, throughActivitySeq: string) =>
    fetch(`${app.baseUrl}/api/channels/threads/done`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        threadChannelId,
        throughActivitySeq,
        frontierSpace: "storage",
      }),
    });

  // Wrong type, but the caller CAN see this channel -> a caller bug worth reporting.
  const wrongType = await done(f.parentChannelId, "1");
  assert.equal(wrongType.status, 400);
  assert.equal(((await wrongType.json()) as { code?: string }).code, "NOT_A_THREAD");

  // Healthy thread: Done still applies, and is actually recorded.
  const target = await resolveThreadSuppressionTarget(f.threadId);
  assert.ok(target?.latestSeqExact);
  const healthy = await done(f.threadId, target.latestSeqExact);
  assert.equal(healthy.status, 200, await healthy.clone().text());
  const [suppression] = await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetChannelId, f.threadId),
    eq(inboxSuppressionStates.targetKind, "followed_thread"),
  ));
  assert.ok(suppression, "a healthy Done must actually persist suppression, not merely return 200");

  // NO soft-deleted assertion lives here, deliberately.
  //
  // An earlier revision asserted that a soft-deleted thread the caller can
  // reach must not collapse into the merged 404. @Cody showed that is WIDER
  // than the adjudicated contract: it treats reachable parent membership as
  // grounds for disclosure, while the disclosure gate is the service layer's
  // receiver-owned evidence (serving row / fact / cursor). A deleted thread
  // with no such evidence returns the same opaque 404 even to a caller who
  // can see the parent -- so that assertion would go RED on a correct
  // integration.
  //
  // Resolving with `includeDeleted` only lets this route hand the request to
  // the service; it is not permission to tell the caller the thread exists.
  // Its observable consequence therefore cannot be seen from the route alone,
  // and is pinned in the integrated exact against a caller-owned-residue
  // fixture instead of being approximated here.
  //
  // KNOWN GAP while isolated: nothing in this PR turns RED if `includeDeleted`
  // is dropped. Stated rather than papered over.
});


// task #34 successor: the two promises the first pass asserted in prose but
// never exercised. @Jianwei proved the gap by mutation — returning a distinct
// code for a cross-server row, and returning one from the resolve/authorize
// catch, both left the original two tests passing 2/2.
//
// A cross-server id and a pre-access helper failure must produce a body that is
// byte-identical to a missing id, for the same reason as the other merged
// causes: any difference is an oracle, and a 500 from the catch is just an
// oracle through a different exit.
test("threads/done keeps cross-server and resolve-failure byte-identical to a missing id", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerHeaders = headers(f.ownerToken, f.serverId);

  // A real thread that lives in a DIFFERENT server. The row resolves, so this
  // is not the "missing" path -- the caller must still not be able to tell.
  const otherServer = await createServerService("other-server", "other-server", f.ownerId);
  const otherChannel = await createChannel(otherServer.id, "other-room");
  await addHuman(otherChannel.id, f.ownerId);
  const otherParent = await createMessage(otherChannel.id, "user", f.ownerId, "elsewhere");
  const otherThread = await getOrCreateThread(otherParent.id, f.ownerId, "user");

  const done = (threadChannelId: string) => fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      threadChannelId,
      throughActivitySeq: "1",
      frontierSpace: "storage",
    }),
  });

  const missing = await done(randomUUID());
  const crossServer = await done(otherThread.id);
  // A malformed id makes the uuid cast throw inside resolve/authorize, which
  // is the only way to reach the fail-closed catch from the outside.
  const resolveFailure = await done("not-a-uuid");

  const [missingBody, crossBody, throwBody] = await Promise.all(
    [missing, crossServer, resolveFailure].map(r => r.text()),
  );

  assert.equal(missing.status, 404);
  assert.equal(crossServer.status, 404, "a thread in another server must not be distinguishable");
  assert.equal(
    crossBody,
    missingBody,
    "cross-server must be BYTE-IDENTICAL to missing -- otherwise it leaks that the id is real elsewhere",
  );

  assert.equal(
    resolveFailure.status,
    404,
    "a throw before access is established must fail closed to 404, never surface as 500",
  );
  assert.equal(
    throwBody,
    missingBody,
    "the fail-closed catch must return the SAME body -- a distinct one is an oracle through another exit",
  );
});


// The `includeDeleted` resolution fallback is what lets a deleted thread reach
// #6052's residue adjudication at all. In the isolated route PR this could not
// be pinned -- the route alone cannot observe it, and asserting non-collapse
// from parent membership was WIDER than the contract (@Cody). With caller-owned
// evidence present it becomes observable, so it is pinned here for the first
// time. NEWLY PINNED, not reused from either isolated head.
test("threads/done resolves deleted threads so caller-owned residue can still be adjudicated", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const ownerHeaders = headers(f.ownerToken, f.serverId);

  // Give the caller genuine receiver-owned evidence, then delete the source.
  const reply = await createMessage(f.threadId, "user", f.memberBId, "thread reply");
  const read = await markReadLatest(f.ownerId, f.threadId);
  assert.equal(read.maxReadSeq, reply.seq, "precondition: the caller owns a read cursor on this thread");
  assert.equal(read.changed, true);
  await deleteChannel(f.threadId);

  const done = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ threadChannelId: f.threadId, frontierSpace: "storage" }),
  });
  assert.equal(
    done.status,
    200,
    "a deleted thread with caller-owned evidence must still reach residue adjudication; "
      + "dropping the includeDeleted fallback collapses it into the merged 404 instead",
  );
});


test("threads/done retires caller-owned residue for active threads below a deleted DM parent", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const receiverHeaders = headers(f.outsiderToken, f.serverId);
  const dm = await findOrCreateUserDM(f.serverId, f.ownerId, f.outsiderId);
  assert.ok(dm);

  const parentMessage = await createMessage(dm.id, "user", f.ownerId, "deleted dm thread parent");
  const thread = await getOrCreateThread(parentMessage.id, f.ownerId, "user");
  const residueMessage = await createMessage(
    thread.id,
    "user",
    f.ownerId,
    "receiver-owned deleted dm thread residue",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.outsiderId,
    kind: "thread",
    sourceChannelId: thread.id,
    message: residueMessage,
    personalMention: true,
  });
  const laterSourceMessage = await createMessage(thread.id, "user", f.ownerId, "must not leak source max");
  assert.ok(laterSourceMessage.seq > residueMessage.seq);

  await deleteChannel(dm.id);
  const [activeThread] = await db.select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, thread.id));
  assert.equal(activeThread?.deletedAt, null, "fixture: deleting the DM parent leaves the child thread active");

  const done = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: receiverHeaders,
    body: JSON.stringify({
      threadChannelId: thread.id,
      throughActivitySeq: String(residueMessage.seq),
      frontierSpace: "storage",
    }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const body = await done.json() as {
    ok: boolean;
    terminalReason: string;
    legacyNoop: boolean;
    retiredThroughActivitySeq: number;
    changed: boolean;
  };
  assert.deepEqual({
    ok: body.ok,
    terminalReason: body.terminalReason,
    legacyNoop: body.legacyNoop,
    retiredThroughActivitySeq: body.retiredThroughActivitySeq,
    changed: body.changed,
  }, {
    ok: true,
    terminalReason: "legacy_done_target_unavailable",
    legacyNoop: true,
    retiredThroughActivitySeq: residueMessage.seq,
    changed: true,
  });

  const [cursor] = await db.select()
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, f.outsiderId),
      eq(userChannelReadCursors.channelId, thread.id),
    ));
  assert.equal(
    cursor?.lastReadSeq,
    residueMessage.seq,
    "residue retirement must stop at receiver-owned evidence, not the thread source max",
  );
  const unreadAfterDone = await getInboxItems(f.serverId, f.outsiderId, {
    filter: "unread",
    limit: 30,
    offset: 0,
    humanActivityMuteEnabled: false,
  });
  assert.ok(
    !unreadAfterDone.items.some((item) => item.kind === "thread" && item.threadChannelId === thread.id),
    "retired residue must leave the caller's unread Activity surface",
  );

  const noResidue = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      threadChannelId: thread.id,
      throughActivitySeq: String(residueMessage.seq),
      frontierSpace: "storage",
    }),
  });
  assert.equal(noResidue.status, 404, "deleted-DM-parent retirement still requires caller-owned residue");

  const noResidueMalformed = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      threadChannelId: thread.id,
      throughActivitySeq: "not-a-seq",
      frontierSpace: "storage",
    }),
  });
  assert.equal(
    noResidueMalformed.status,
    404,
    "a caller without residue must not get a frontier-validation oracle for a deleted-DM-parent thread",
  );
});


// BOUNDARY test, not a product-path test. Every real caller already excludes
// soft-deleted channels before reaching this query, so no product route can
// exercise the filter -- which is exactly why it is tested here, at the unit's
// own edge.
//
// What this asserts is the FUNCTION's contract ("whatever the caller passes, a
// soft-deleted channel is not returned"), not a user-reachable behaviour. That
// distinction is what separates it from testing an unreachable state and then
// claiming a product property: this claims only what it actually measures, and
// it is the evidence that turns caller-side discipline into a local guarantee.
test("fetchReadStateAuthorityRows excludes soft-deleted channels regardless of what the caller passes", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  const live = await __testReadStateAuthority.fetchReadStateAuthorityRows(
    [f.parentChannelId],
    f.ownerId,
    untracedDbQuery,
    "test.read_state_authority",
  );
  assert.equal(live.length, 1, "precondition: a live channel is returned");

  await deleteChannel(f.parentChannelId);

  const afterDelete = await __testReadStateAuthority.fetchReadStateAuthorityRows(
    [f.parentChannelId],
    f.ownerId,
    untracedDbQuery,
    "test.read_state_authority",
  );
  assert.deepEqual(
    afterDelete,
    [],
    "a soft-deleted channel must not be returned even when a caller passes its id directly -- "
      + "removing `AND c.deleted_at IS NULL` makes this red",
  );
});


test("task #48: a stranger cannot tell a real private channel from a nonexistent one", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const strangerHeaders = headers(f.outsiderToken, f.serverId);

  // Real, and the stranger is not a member.
  const secret = await createChannel(f.serverId, "secret-room", undefined, "private");
  await addHuman(secret.id, f.ownerId);
  const missingId = randomUUID();

  for (const probe of oracleProbes(app.baseUrl, strangerHeaders, secret.id)) {
    const [real] = oracleProbes(app.baseUrl, strangerHeaders, secret.id).filter(p => p.name === probe.name);
    const [absent] = oracleProbes(app.baseUrl, strangerHeaders, missingId).filter(p => p.name === probe.name);
    const realRes = await real.run();
    const absentRes = await absent.run();
    const [realBody, absentBody] = await Promise.all([realRes.text(), absentRes.text()]);

    assert.equal(
      realRes.status,
      absentRes.status,
      `${probe.name}: status differs for a real vs missing channel -- that IS the oracle`,
    );
    assert.equal(
      realBody,
      absentBody,
      `${probe.name}: bodies differ -- a shared status with a differing code/error is still an oracle`,
    );
    // Pin the direction too. Byte-identical 403s would satisfy the equalities
    // above while telling every stranger the id is real.
    assert.equal(realRes.status, 404, `${probe.name}: must answer a stranger with the non-disclosing 404`);
  }
});


test("task #48: an ex-member with residue but no read cursor keeps the 403", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  const room = await createChannel(f.serverId, "left-room", undefined, "private");
  await addHuman(room.id, f.ownerId);
  await addHuman(room.id, f.outsiderId);
  await removeHuman(room.id, f.outsiderId);

  // The gap @Tenny caught: this user never read anything, so there is NO
  // user_channel_read_cursors row. A predicate that only consults the read
  // cursor judges them a stranger and 404s -- which silently leaves them
  // unable to clear the Activity entry this residue row represents.
  const cursorRows = await db
    .select({ userId: userChannelReadCursors.userId })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, f.outsiderId),
      eq(userChannelReadCursors.channelId, room.id),
    ));
  assert.equal(cursorRows.length, 0, "fixture must have NO read cursor, or this test proves nothing");

  await db.insert(userChannelInboxStates).values({
    userId: f.outsiderId,
    channelId: room.id,
    doneAt: null,
  });

  const exMemberHeaders = headers(f.outsiderToken, f.serverId);
  for (const probe of oracleProbes(app.baseUrl, exMemberHeaders, room.id)) {
    const res = await probe.run();
    assert.equal(
      res.status,
      403,
      `${probe.name}: an ex-member with residue already knows this channel exists -- `
      + "404 discloses nothing new to them and takes away the answer they need to clear Activity",
    );
  }
});


// ---------------------------------------------------------------------------
// task #48, usability half. @Tenny ruled mechanism B (#proj-activity:b3ffd225,
// `4cfb516d`): a caller who lost access may retire their OWN residue, but the
// answer must be built only from values they already own.
//
// The reason is a capability, not a field: one call tells a former member what
// they roughly knew already; polling `maxReadSeq` is an activity monitor for a
// private channel they can no longer see. An existence leak is one bit; an
// activity feed is a continuous stream.
// ---------------------------------------------------------------------------

test("task #48 U1: a caller with residue but no access can retire it -- both populations", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);

  // Population 1: removed from a private channel.
  const room = await createChannel(f.serverId, "u1-room", undefined, "private");
  await addHuman(room.id, f.ownerId);
  await addHuman(room.id, f.outsiderId);
  await createMessage(room.id, "user", f.ownerId, "hi");
  const joined = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(joined.status, 200, "precondition: a member can clear, so residue exists");
  await removeHuman(room.id, f.outsiderId);

  // The channel moves on after they lose access, so there IS unread residue.
  await createMessage(room.id, "user", f.ownerId, "after removal");
  const db = getDb();
  const cursorBefore = await db
    .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, f.outsiderId),
      eq(userChannelReadCursors.channelId, room.id),
    ));

  const removed = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(removed.status, 200, "an ex-member holding residue must be able to retire it");

  // ⚠️ Status 200 is NOT the outcome. A handler that admits the caller and
  // retires nothing returns exactly this, and every other tooth here passes
  // vacuously behind it -- which is what happened: the receipt came back
  // {changed:false, readStateVersion:0} while U1/U3/U6 were all green.
  // Assert the receiver-owned state actually moved.
  const cursorAfter = await db
    .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, f.outsiderId),
      eq(userChannelReadCursors.channelId, room.id),
    ));
  assert.ok(cursorAfter.length === 1, "the caller must still own a read-state row");
  assert.ok(
    cursorAfter[0].lastReadSeq > (cursorBefore[0]?.lastReadSeq ?? -1),
    `residue was not actually retired: cursor stayed at ${cursorAfter[0].lastReadSeq}`,
  );

  // Population 2: soft-deleted DM. @Tenny: an instance, not a new branch --
  // and a U1 built only from removeHuman would never touch this family.
  const dm = await findOrCreateUserDM(f.serverId, f.ownerId, f.outsiderId);
  assert.ok(dm, "fixture: DM must exist");
  await createMessage(dm.id, "user", f.ownerId, "hello");
  await deleteChannel(dm.id);
  const deletedDm = await fetch(`${app.baseUrl}/api/channels/${dm.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(deletedDm.status, 200, "residue in a soft-deleted DM must still be retirable");
});


test("task #48 U2: a caller with no residue still gets the non-disclosing 404", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);
  const secret = await createChannel(f.serverId, "u2-secret", undefined, "private");
  await addHuman(secret.id, f.ownerId);
  await createMessage(secret.id, "user", f.ownerId, "hi");

  const real = await fetch(`${app.baseUrl}/api/channels/${secret.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  const missing = await fetch(`${app.baseUrl}/api/channels/${randomUUID()}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  const [realBody, missingBody] = await Promise.all([real.text(), missing.text()]);

  assert.equal(real.status, 404, "a stranger must not be let through by the residue branch");
  assert.equal(missing.status, 404);
  assert.equal(
    realBody,
    missingBody,
    "byte-identical, or the usability fix reopens the oracle the privacy half closed",
  );
});


test("task #48 U3: the residue-only receipt carries only receiver-owned fields", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);
  const room = await createChannel(f.serverId, "u3-room", undefined, "private");
  await addHuman(room.id, f.ownerId);
  await addHuman(room.id, f.outsiderId);
  await createMessage(room.id, "user", f.ownerId, "one");
  await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  await removeHuman(room.id, f.outsiderId);
  // The channel keeps moving after they lose access. If any channel-derived
  // value reaches them, this is what it would expose.
  await createMessage(room.id, "user", f.ownerId, "two");
  await createMessage(room.id, "user", f.ownerId, "three");

  const res = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;

  // Subset of a CLOSED set, not "does not contain maxReadSeq". A new
  // channel-derived field added upstream fails here without anyone
  // remembering to forbid it by name.
  const allowed = new Set<string>(RESIDUE_ONLY_READ_ALL_RECEIPT_FIELDS);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  assert.deepEqual(
    extra,
    [],
    `residue-only receipt leaked non-receiver-owned field(s): ${extra.join(", ")}`,
  );
  assert.equal(body.ok, true);
});


test("task #48 U4: retiring residue is idempotent, not an error on replay", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);
  const room = await createChannel(f.serverId, "u4-room", undefined, "private");
  await addHuman(room.id, f.ownerId);
  await addHuman(room.id, f.outsiderId);
  await createMessage(room.id, "user", f.ownerId, "hi");
  await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  await removeHuman(room.id, f.outsiderId);

  const first = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  const second = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, "a successful operation's replay must never become an error code");
});


test("task #48 U5: moving authorization to the sequencer changed no rejection byte", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);
  const secret = await createChannel(f.serverId, "u5-secret", undefined, "private");
  await addHuman(secret.id, f.ownerId);
  const otherServer = await createServerService("u5-other", "u5-other", f.ownerId);
  const elsewhere = await createChannel(otherServer.id, "u5-elsewhere", undefined, "private");

  const readAll = (id: string) => fetch(`${app.baseUrl}/api/channels/${id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });

  // Every pre-existing rejection case. The route used to answer these itself;
  // the sequencer answers some of them now. @Tenny: "byte-identical" is an
  // intention until something asserts it -- an authorization change is exactly
  // where an output gets altered "while I was in there".
  const cases: Array<[string, Response]> = [
    ["missing id", await readAll(randomUUID())],
    ["real private channel, no relationship", await readAll(secret.id)],
    ["channel in another server", await readAll(elsewhere.id)],
  ];

  for (const [name, res] of cases) {
    const body = await res.text();
    assert.equal(res.status, 404, `${name}: status must be the pinned 404`);
    assert.equal(
      body,
      '{"error":"Channel not found"}',
      `${name}: body must be byte-identical to what this endpoint returned before `
      + "authorization moved to the sequencer",
    );
    assert.equal(
      res.headers.get("content-type"),
      "application/json; charset=utf-8",
      `${name}: content-type must not have drifted either`,
    );
  }
});


test("task #48 U6: the residue path emits no socket event carrying the live frontier", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const h = headers(f.outsiderToken, f.serverId);
  const room = await createChannel(f.serverId, "u6-room", undefined, "private");
  await addHuman(room.id, f.ownerId);
  await addHuman(room.id, f.outsiderId);
  await createMessage(room.id, "user", f.ownerId, "one");
  await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  await removeHuman(room.id, f.outsiderId);
  await createMessage(room.id, "user", f.ownerId, "two");
  await createMessage(room.id, "user", f.ownerId, "three");

  // Restricting the HTTP body alone would be COSMETIC: emitReadStateUpdated
  // pushes maxReadSeq to room `user:<id>`, so the caller would receive the
  // channel's live frontier over the socket instead. Without this tooth the
  // protection is only the early return, and re-adding the emit fails the
  // other teeth merely by throwing -- red for the wrong reason, which is the
  // shape this whole card is about.
  const events = installFakeIo(app.app);
  const res = await fetch(`${app.baseUrl}/api/channels/${room.id}/read-all`, {
    method: "POST", headers: h, body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);

  const leaked = events.filter((e) => {
    const payload = e.payload as Record<string, unknown> | null;
    return payload !== null && typeof payload === "object" && "maxReadSeq" in payload;
  });
  assert.deepEqual(
    leaked.map((e) => `${e.room}/${e.event}`),
    [],
    "a caller without access must not be handed the channel's live frontier over a socket either",
  );
});


// task #62: the receiver-scope count is produced BY the serving-rows statement, so a
// failed statement leaves it unmeasured. It used to stay at its `0` initial value and
// the error path reported that `0` as though it were a measurement, which inverts any
// "do timeouts correlate with receiver scope size?" analysis: every failed request
// looks like scope 0. The numeric field must be ABSENT and the absence stated.
//
// This first tooth drives the error path through an injected failing executor so it
// runs on PGlite too (CI has no real PG). The second tooth below proves the same
// contract under a REAL statement_timeout, which PGlite does not enforce.
test("inbox PG serving-rows query failure reports receiver scope as unavailable, never as a measured 0", async ({ app }) => {
  // Deliberately PGlite even when DATABASE_URL is set: the harness does not isolate
  // fixtures between tests on a shared real database, so exactly one test in this file
  // may seed real PG (the REAL statement_timeout tooth below). This one is engine
  // agnostic anyway — it injects the failure rather than provoking a real timeout.

  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    const f = await seedThreadFixture(app.baseUrl);
    const cutoff = new Date("2026-06-01T00:00:00Z");
    const errorEvents: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    const statementTimeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const failingExecutor = {
      select: getDb().select.bind(getDb()),
      execute: async () => {
        throw statementTimeout;
      },
    } as never;
    await assert.rejects(async () => {
      await getInboxItems(f.serverId, f.ownerId, {
        filter: "all",
        limit: 30,
        offset: 0,
        historyCutoff: cutoff,
        humanActivityMuteEnabled: false,
        executor: failingExecutor,
        traceQuery: async (queryName, work, onComplete, onError) => {
          try {
            const result = await work();
            onComplete?.(result);
            return result;
          } catch (error) {
            errorEvents.push({
              queryName,
              attrs: (onError?.(error) ?? {}) as Record<string, unknown>,
            });
            throw error;
          }
        },
      });
    });
    const servingError = errorEvents.find(
      (event) => event.queryName === "channels.inbox_items_serving_rows_by_user",
    );
    assert.ok(
      servingError,
      `expected the serving-rows query to fail; saw ${JSON.stringify(errorEvents.map((e) => e.queryName))}`,
    );
    assert.equal(
      "receiver_scope_row_count" in servingError.attrs,
      false,
      "a failed statement never produced a receiver-scope count, so the numeric field must be absent rather than a plausible 0",
    );
    assert.equal(
      servingError.attrs.receiver_scope_row_count_state,
      "unavailable_query_failed",
      "absence must be stated, so a reader can tell 'not measured' from 'measured zero'",
    );
  } finally {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    // Every test in this file closes its app; omitting this leaked a live app and the
    // shard died with PROCESS_DID_NOT_EXIT / exit 124 even though both teeth passed.
    await app.close();
  }
});


// task #135: PG-vs-RW discrimination control. A 57014 on the PG path must be
// labeled db_system="postgresql" with sqlstate + retryable, so it is
// distinguishable from the same shape served by RisingWave (RW failures carry
// db_system="risingwave" via risingWaveInboxTrace; that counterpart is covered
// by channelService.risingwaveFailsoft.test.ts and risingWaveInboxTrace.test.ts).
test("inbox PG serving-rows failure event carries db_system=postgresql, sqlstate and retryable", async ({ app }) => {
  // Deliberately PGlite like the task #62 tooth above: the failure is injected,
  // so the engine does not matter.

  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const f = await seedThreadFixture(app.baseUrl);
    const cutoff = new Date("2026-06-01T00:00:00Z");
    const statementTimeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const failingExecutor = {
      select: getDb().select.bind(getDb()),
      execute: async () => {
        throw statementTimeout;
      },
    } as never;
    const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
    await assert.rejects(
      runWithTraceSpan(span, () => getInboxItems(f.serverId, f.ownerId, {
        filter: "all",
        limit: 30,
        offset: 0,
        historyCutoff: cutoff,
        humanActivityMuteEnabled: false,
        executor: failingExecutor,
        traceQuery: createTraceDbQueryTracer("inbox.loaded"),
      }), tracer),
      statementTimeout,
    );
    span.end("error");

    const rows = sink.getAllSpans().flatMap((recorded) => traceEventRowsForSpan(recorded, {
      serviceName: "slock-server",
      deploymentEnvironment: "test",
    }));
    const servingRow = rows.find(
      (row) => row.event_name === "db.query.failed"
        && row.query_name === "channels.inbox_items_serving_rows_by_user",
    );
    assert.ok(
      servingRow,
      `expected the serving-rows query failure event; saw ${JSON.stringify(rows.map((row) => [row.event_name, row.query_name]))}`,
    );
    assert.equal(servingRow.db_system, "postgresql");
    assert.notEqual(
      servingRow.db_system,
      "risingwave",
      "the same 57014 shape on a PG path must be distinguishable from an RW failure",
    );
    assert.equal(servingRow.sqlstate, "57014");
    assert.equal(servingRow.retryable, "true");
    assert.match(servingRow.timeout_bucket ?? "", /^(<1s|1-5s|5-15s|>15s)$/);
    assert.equal(
      JSON.stringify(servingRow).includes("canceling statement"),
      false,
      "raw database error text must never land in the row",
    );
  } finally {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    // Every test in this file closes its app; omitting this leaked a live app and the
    // shard died with PROCESS_DID_NOT_EXIT / exit 124 even though both teeth passed.
    await app.close();
  }
});


// Real statement_timeout semantics: PGlite does not enforce statement_timeout, so this
// tooth is skipped unless DATABASE_URL points at a real PostgreSQL. It is NOT redundant
// with the injected-failure tooth above: that one proves the attribute contract, this
// one proves a real timeout actually reaches that contract.
// Set DATABASE_URL to a disposable PostgreSQL 16 test database before running.
// For a local database, start an isolated env with ./raftdev start pg-test and
// read its Postgres connection URL from ./raftdev status.
test("inbox PG serving-rows REAL statement_timeout reports receiver scope as unavailable", { skip: !process.env.DATABASE_URL }, async () => {
  // task #62: the receiver-scope count is produced BY the serving-rows statement, so a
  // statement_timeout leaves it unmeasured. It used to be reported as its `0` initial
  // value on the error path, which would invert any "do timeouts correlate with receiver
  // scope size?" analysis. The numeric field must be ABSENT and the state explicit.
  // statement_timeout semantics differ between PGlite (WASM) and real PG, so this
  // tooth must be runnable against real PG16 (also provided by raftdev).
  const app = await openTestApp(process.env.DATABASE_URL ?? "pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const previousRfc056ServingMode = process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE;
  try {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = "on";
    const db = getDb();
    const f = await seedThreadFixture(app.baseUrl);
    const cutoff = new Date("2026-06-01T00:00:00Z");
    const errorEvents: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    // Tighten the inherited policy so the fallback's own cap resolves to it
    // (min(inherited, 3000)) and the serving-rows statement really times out.
    await db.execute(sql`SET statement_timeout = '1ms'`);
    await assert.rejects(async () => {
      await getInboxItems(f.serverId, f.ownerId, {
        filter: "all",
        limit: 30,
        offset: 0,
        historyCutoff: cutoff,
        humanActivityMuteEnabled: false,
        traceQuery: async (queryName, work, onComplete, onError) => {
          try {
            const result = await work();
            onComplete?.(result);
            return result;
          } catch (error) {
            errorEvents.push({
              queryName,
              attrs: (onError?.(error) ?? {}) as Record<string, unknown>,
            });
            throw error;
          }
        },
      });
    });
    const servingError = errorEvents.find(
      (event) => event.queryName === "channels.inbox_items_serving_rows_by_user",
    );
    assert.ok(servingError, `expected the serving-rows query to fail; saw ${JSON.stringify(errorEvents.map((e) => e.queryName))}`);
    assert.equal(
      "receiver_scope_row_count" in servingError.attrs,
      false,
      "a timed-out statement never produced a receiver-scope count, so the numeric field must be absent rather than a plausible 0",
    );
    assert.equal(
      servingError.attrs.receiver_scope_row_count_state,
      "unavailable_query_failed",
      "absence must be stated, so a reader can tell 'not measured' from 'measured zero'",
    );
  } finally {
    process.env.RISINGWAVE_INBOX_RFC056_SERVING_MODE = previousRfc056ServingMode;
    // Every test in this file closes its app; omitting this leaked a live app and the
    // shard died with PROCESS_DID_NOT_EXIT / exit 124 even though both teeth passed.
    await app.close();
  }
});
