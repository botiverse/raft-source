import { handlerTraceEvents } from "../test/handlerTraceEvents";
import { tokenForHuman } from "../test/integration/credentials";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  BasicTracer,
  MemoryTraceSink
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { closeRisingWavePool } from "../db/risingwave";
import {
  users, servers as serversTable, channels, channelAgents,
  messages, messageMentions, threadFollows,
  readMutations,
  userChannelReadCursors,
  agentChannelReadCursors,
  inboxTargetMuteStates,
  inboxNotificationFacts,
  inboxSuppressionStates,
  userChannelInboxStates,
  userChannelDisplayPrefs, featureFlags,
  channelHumans, serverAgentMembers, notificationOutbox
} from "../db/schema";
import { addMember, updateServerOnboardingAgent } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createChannel, getOrCreateThread, addHuman, addAgent, removeHuman, findOrCreateUserDM, canUserPostToChannel, archiveChannel, deleteChannel, listThreadChannelIdsForParentChannel, markRead, getInboxItems, type InboxItem } from "../services/channelService";
import {
  createMessage
} from "../services/messageService";
import {
} from "../services/inboxNotificationService";
import {
  __resetOnboardingServiceDepsForTests,
  __setOnboardingServiceDepsForTests,
  triggerAllChannelUnlockOnboarding,
} from "../services/onboardingService";
import {
  resolveChannelSuppressionTarget,
  resolveThreadSuppressionTarget,
} from "../services/inboxSuppressionWriters";
import { listHumanChannelItems } from "../services/channelListItems";
import { createServer, installFakeIo, recordTestInboxFact, seedThreadFixture, headers, channelDoneBody, threadDoneBody, legacyDoneFallbackCount, seedUser, type InboxMentionItem, fetchInboxAll } from "./channels.api.fixtures";
import { shapeEstablishedServerForTest, revealAllChannelForTest } from "../test/allChannelFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const testMuteFlagOff = createApiTest({ humanActivityMuteFlagDefaultEnabled: false });


test("GET /api/channels records restore-list phases and constant query shape", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "4".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);
  const emittedEvents = installFakeIo(app.app);

  const db = getDb();
  const owner = await seedUser("channels-trace-owner@slock.test", "channels-trace-owner");
  const member = await seedUser("channels-trace-member@slock.test", "channels-trace-member");
  const server = await createServer("Channels Trace Server", "channels-trace-server", owner.id);
  await shapeEstablishedServerForTest(server.id);
  await addMember(server.id, member.id);
  const joinedChannel = await createChannel(server.id, "joined-channel");
  await addHuman(joinedChannel.id, owner.id);
  const joinedMessage = await createMessage(joinedChannel.id, "user", owner.id, "joined latest message");
  const notJoinedChannel = await createChannel(server.id, "not-joined-channel");
  const notJoinedMessage = await createMessage(notJoinedChannel.id, "user", owner.id, "not joined latest message");

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string; name: string; joined: boolean; lastMessageAt: string | null }>;
  assert.equal(body.length, 3);
  assert.equal(body.find((channel) => channel.name === "all")?.joined, true);
  assert.equal(body.find((channel) => channel.name === "joined-channel")?.joined, true);
  assert.equal(body.find((channel) => channel.name === "not-joined-channel")?.joined, false);
  assert.equal(body.find((channel) => channel.id === joinedChannel.id)?.lastMessageAt, joinedMessage.createdAt.toISOString());
  assert.equal(body.find((channel) => channel.id === notJoinedChannel.id)?.lastMessageAt, notJoinedMessage.createdAt.toISOString());

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/",
  );
  assert.ok(span, "expected GET /api/channels root span");

  const processEventNames = handlerTraceEvents(span.events)
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");
  assert.deepEqual(processEventNames, [
    "channels.list.started",
    "channels.loaded",
    "response.ready",
    "http.response.finished",
  ]);

  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    dbEvents.map((event) => event.attrs?.query_name).sort(),
    [
      "channels.external_bridges_by_channels",
      "channels.last_messages_by_channels",
      "channels.list_by_server",
      "channels.memberships_by_user",
    ],
  );
  assert.equal(dbEvents.length, 4);
  assert.ok(dbEvents.length <= 4, "channel list query count should stay constant for common restore path");

  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channels.list_by_server")?.attrs?.phase, "channels.loaded");
  assert.equal(dbEventByQuery.get("channels.list_by_server")?.attrs?.archived_filter, "exclude");
  assert.equal(dbEventByQuery.get("channels.list_by_server")?.attrs?.row_count, 3);
  assert.equal(dbEventByQuery.get("channels.memberships_by_user")?.attrs?.phase, "channels.loaded");
  // The joined channel plus the enabled #all row every member now holds (#triage:64b44a12).
  assert.equal(dbEventByQuery.get("channels.memberships_by_user")?.attrs?.memberships_count, 2);
  assert.equal(dbEventByQuery.get("channels.last_messages_by_channels")?.attrs?.phase, "channels.loaded");
  assert.equal(dbEventByQuery.get("channels.last_messages_by_channels")?.attrs?.channels_count, 3);
  assert.equal(dbEventByQuery.get("channels.last_messages_by_channels")?.attrs?.channels_with_messages_count, 2);
  assert.equal(dbEventByQuery.get("channels.external_bridges_by_channels")?.attrs?.phase, "channels.loaded");
  assert.equal(dbEventByQuery.get("channels.external_bridges_by_channels")?.attrs?.channels_count, 3);
  assert.equal(dbEventByQuery.get("channels.external_bridges_by_channels")?.attrs?.bridged_channels_count, 0);

  const loadedEvent = span.events.find((event) => event.name === "channels.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.archived_filter, "exclude");
  assert.equal(loadedEvent.attrs?.channels_count, 3);
  assert.equal(loadedEvent.attrs?.joined_channels_count, 2);

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.channels_count, 3);
  assert.equal(readyEvent.attrs?.joined_channels_count, 2);
  assert.equal(Object.values(span.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(readyEvent.attrs ?? {}).includes(joinedChannel.id), false);
});


test("GET /api/channels resolves channel authorization in a constant number of queries", async ({ seed, http }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const client = http.as(owner, server);
  const countList = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let count = 0;
    pg.query = ((...args: unknown[]) => {
      count += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const res = await client.get("/api/channels");
      assert.equal(res.status, 200);
      return { count, body: await res.json() as Array<{ id: string; channelRole: string | null; channelCapabilities: Record<string, boolean>; channelAuthorityRevision: number | null }> };
    } finally {
      pg.query = originalQuery;
    }
  };

  await seed.channel({ server, members: [owner] });
  await countList();
  const few = await countList();
  for (let i = 0; i < 12; i += 1) await seed.channel({ server, members: [owner] });
  await countList();
  const many = await countList();

  assert.ok(few.count > 0, "the counter must observe queries");
  assert.ok(many.body.length >= few.body.length + 12);
  // Per-channel authorization used to cost three queries per channel.
  assert.equal(many.count, few.count, `${few.body.length} channels: ${few.count} queries, ${many.body.length} channels: ${many.count}`);
  for (const channel of many.body) {
    assert.ok(channel.channelCapabilities && typeof channel.channelCapabilities === "object", channel.id);
  }
});

test("GET /api/channels/:id/members reads agent activity as one batch, not per agent", async ({ app, seed, http }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const orchestrator = app.app.get("agentOrchestrator") as {
    getActivity: (agentId: string) => Promise<{ activity: string; activityDetail: string }>;
    getActivities: (rows: ReadonlyArray<{ id: string }>) => Promise<Array<{ activity: string; activityDetail: string }>>;
  };
  let singleReads = 0;
  orchestrator.getActivity = async () => {
    singleReads += 1;
    return { activity: "offline", activityDetail: "" };
  };
  orchestrator.getActivities = async (rows) => rows.map(() => ({ activity: "online", activityDetail: "batched" }));
  const addAgents = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const agent = await createAgent(server.id, `members-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      await addAgent(channel.id, agent.id);
    }
  };
  const countMembers = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let count = 0;
    pg.query = ((...args: unknown[]) => {
      count += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const res = await client.get(`/api/channels/${channel.id}/members`);
      assert.equal(res.status, 200);
      return { count, body: await res.json() as { agents: Array<{ id: string; activity?: string; activityDetail?: string }> } };
    } finally {
      pg.query = originalQuery;
    }
  };

  await addAgents(1);
  await countMembers();
  const few = await countMembers();
  await addAgents(10);
  await countMembers();
  const many = await countMembers();

  assert.ok(few.count > 0, "the counter must observe queries");
  assert.equal(many.body.agents.length, few.body.agents.length + 10);
  assert.equal(many.count, few.count, `${few.body.agents.length} agents: ${few.count} queries, ${many.body.agents.length} agents: ${many.count}`);
  assert.equal(singleReads, 0, "activity is not read agent by agent");
  for (const agent of many.body.agents) {
    assert.equal(agent.activity, "online", agent.id);
    assert.equal(agent.activityDetail, "batched", agent.id);
  }
});

test("GET /api/channels default restore list excludes archived channels", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const activeChannel = await seed.channel({ server, members: [owner] });
  const archivedChannel = await seed.channel({ server, members: [owner] });
  await archiveChannel(archivedChannel.id, owner.id);
  const client = http.as(owner, server);

  const defaultRes = await client.get("/api/channels");
  assert.equal(defaultRes.status, 200);
  const defaultBody = await defaultRes.json() as Array<{ id: string; name: string; archivedAt: string | null }>;
  assert.ok(defaultBody.some((channel) => channel.id === activeChannel.id));
  assert.ok(!defaultBody.some((channel) => channel.id === archivedChannel.id), "normal channel list must not expose archived channels");

  const includeRes = await client.get("/api/channels?archived=include");
  assert.equal(includeRes.status, 200);
  const includeBody = await includeRes.json() as Array<{ id: string; name: string; archivedAt: string | null }>;
  assert.ok(includeBody.some((channel) => channel.id === archivedChannel.id && channel.archivedAt), "explicit archived include remains available for dedicated archived-channel surfaces");
});


test("GET /api/channels?archived=include skips latest-message reads for archived channels; a lookup by id keeps them", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const activeChannel = await seed.channel({ server, members: [owner] });
  const archivedChannel = await seed.channel({ server, members: [owner] });
  const activeMessage = await createMessage(activeChannel.id, "user", owner.id, "active latest");
  const archivedMessage = await createMessage(archivedChannel.id, "user", owner.id, "archived latest");
  await archiveChannel(archivedChannel.id, owner.id);
  const client = http.as(owner, server);

  const res = await client.get("/api/channels?archived=include");
  assert.equal(res.status, 200);
  type Row = { id: string; archivedAt: string | null; lastMessageAt: string | null; maxReadSeq: number; readState?: { kind: string } };
  const body = await res.json() as Row[];
  const active = body.find((channel) => channel.id === activeChannel.id);
  const archived = body.find((channel) => channel.id === archivedChannel.id);
  assert.equal(active?.lastMessageAt, activeMessage.createdAt.toISOString());
  assert.ok(active?.readState, "a live channel keeps its read state");
  assert.ok(archived?.archivedAt, "the archived channel is still listed");
  assert.equal(archived?.lastMessageAt, null, "no latest-message read for an archived channel in the whole list");
  assert.equal(archived?.readState, undefined, "no read state, so the web leaves its ledger entry alone");
  assert.equal(archived?.maxReadSeq, 0);

  const [byId] = await listHumanChannelItems(server.id, owner.id, { archived: "include", channelIds: [archivedChannel.id] });
  assert.equal(byId?.lastMessageAt?.toISOString(), archivedMessage.createdAt.toISOString(), "a lookup by id still reads the archived channel's latest message");
  assert.ok((byId as { readState?: unknown } | undefined)?.readState, "a lookup by id still reads its read state");
});

test("POST /api/channels returns creator notification capability state for the new channel", async ({ app }) => {
  const owner = await seedUser("create-channel-mute-owner@slock.test", "create-channel-mute-owner");
  const server = await createServer("Create Channel Mute Server", "create-channel-mute-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      name: "new-channel-mute",
      description: "new channels should expose the header mute control immediately",
    }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json() as {
    id: string;
    name: string;
    joined?: boolean;
    activityMuteSupported?: boolean;
    activityMuted?: boolean;
    muteFromSeq?: number | null;
    prefsVersion?: number;
    maxReadSeq?: number;
    readStateVersion?: number;
  };
  assert.equal(created.name, "new-channel-mute");
  assert.equal(created.joined, true);
  assert.equal(created.activityMuteSupported, true);
  assert.equal(created.activityMuted, false);
  assert.equal(created.muteFromSeq, null);
  assert.equal(created.prefsVersion, 0);
  assert.equal(created.maxReadSeq, 0);
  assert.equal(created.readStateVersion, 0);
});


testMuteFlagOff("GET/PATCH /api/channels/:id/notification-settings stores per-user activity mute without moving read cursors", async ({ app }) => {
  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  delete process.env.RISINGWAVE_DATABASE_URL;
  await closeRisingWavePool();
  try {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "e".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);
    const emittedEvents = installFakeIo(app.app);

    const db = getDb();
    const owner = await seedUser("channel-mute-owner@slock.test", "channel-mute-owner");
    const member = await seedUser("channel-mute-member@slock.test", "channel-mute-member");
    const server = await createServer("Channel Mute Settings", "channel-mute-settings", owner.id);
    await addMember(server.id, member.id);
    await db.update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, server.id));
    const channel = await createChannel(server.id, "mute-target", "activity mute target");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
    await db.insert(userChannelReadCursors).values({
      userId: member.id,
      channelId: channel.id,
      lastReadSeq: parentMessage.seq,
    });

    const ownerToken = await tokenForHuman(owner.email);
    const memberToken = await tokenForHuman(member.email);
    const getSettings = (token: string, channelId = channel.id) => fetch(`${app.baseUrl}/api/channels/${channelId}/notification-settings`, {
      headers: headers(token, server.id),
    });
    const patchSettings = (token: string, body: unknown, channelId = channel.id) => fetch(`${app.baseUrl}/api/channels/${channelId}/notification-settings`, {
      method: "PATCH",
      headers: headers(token, server.id),
      body: JSON.stringify(body),
    });
    const sendMessage = async (content: string) => {
      const res = await fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: headers(ownerToken, server.id),
        body: JSON.stringify({ channelId: channel.id, content }),
      });
      assert.equal(res.status, 200);
      return await res.json() as { id: string; seq: number };
    };
    const getInbox = async (filter: "all" | "mentions" | "unread" = "all") => {
      const url = new URL(`${app.baseUrl}/api/channels/inbox`);
      url.searchParams.set("filter", filter);
      const res = await fetch(url, { headers: headers(memberToken, server.id) });
      assert.equal(res.status, 200);
      return await res.json() as {
        items: Array<{
          kind: string;
          channelId?: string;
          lastMessageId?: string;
          firstUnreadMessageId?: string | null;
          unreadCount?: number;
          hasMention?: boolean;
          isFollowing?: boolean;
        }>;
        totalUnreadCount: number;
      };
    };
    const getChannelUnreadCounts = async () => {
      const res = await fetch(`${app.baseUrl}/api/channels/unread`, {
        headers: headers(memberToken, server.id),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      return await res.json() as Record<string, number>;
    };
    // Every transport's audience is the notification outbox (services/notifications/enqueue.ts).
    const outboxReceiverIds = async (messageId: string) => (await db
      .select({ receiverId: notificationOutbox.receiverId })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.messageId, messageId))).map((row) => row.receiverId);
    const lastTraceEvent = (name: string) => {
      const events = sink.getAllSpans().flatMap((span) => span.events);
      const event = [...events].reverse().find((candidate) => candidate.name === name);
      assert.ok(event, `expected ${name} trace event`);
      return event;
    };
    const traceEvent = (name: string, predicate: (attrs: Record<string, unknown>) => boolean) => {
      const events = sink.getAllSpans().flatMap((span) => span.events);
      const event = [...events].reverse().find((candidate) =>
        candidate.name === name && predicate((candidate.attrs ?? {}) as Record<string, unknown>),
      );
      assert.ok(event, `expected ${name} trace event matching predicate`);
      return event;
    };

    const preMuteMessage = await sendMessage("pre-mute activity baseline");
    await markRead(member.id, channel.id, preMuteMessage.seq);

    sink.clear();
    // Always-on regression nail: even though the app fixture was created with
    // humanActivityMuteFlagDefaultEnabled:false, the feature is unconditionally
    // enabled by default, so a no-cutoff
    // pglite inbox routes through the serving-rows backend, not pg_legacy.
    const alwaysOnInbox = await getInbox();
    const alwaysOnInboxSpan = [...sink.getAllSpans()].reverse().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/inbox"
    );
    assert.ok(alwaysOnInboxSpan, "expected GET /api/channels/inbox trace span");
    const alwaysOnBackendEvent = alwaysOnInboxSpan.events.find((event) => event.name === "inbox.backend.selected");
    assert.ok(alwaysOnBackendEvent, "expected inbox backend selection trace");
    assert.equal(alwaysOnBackendEvent.attrs?.["inbox.backend"], "pg_legacy");
    assert.equal(alwaysOnBackendEvent.attrs?.["inbox.fallback_reason"], "none");
    const alwaysOnInboxItem = alwaysOnInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
    assert.ok(alwaysOnInboxItem, "always-on inbox should retain existing channel activity");
    assert.equal(alwaysOnInboxItem.lastMessageId, preMuteMessage.id);

    const initialRes = await getSettings(memberToken);
    assert.equal(initialRes.status, 200);
    assert.deepEqual(await initialRes.json(), {
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 0,
      activityMuteSupported: true,
    });

    const initialListRes = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(initialListRes.status, 200);
    const initialList = await initialListRes.json() as Array<{
      id: string;
      activityMuted?: boolean;
      muteFromSeq?: number | null;
      prefsVersion?: number;
      activityMuteSupported?: boolean;
    }>;
    const initialListChannel = initialList.find((candidate) => candidate.id === channel.id);
    assert.ok(initialListChannel, "channel should remain visible");
    assert.equal(initialListChannel.activityMuted, false);
    assert.equal(initialListChannel.muteFromSeq, null);
    assert.equal(initialListChannel.prefsVersion, 0);
    assert.equal(initialListChannel.activityMuteSupported, true);

    const invalidRes = await patchSettings(memberToken, { activityMuted: "yes" });
    assert.equal(invalidRes.status, 400);

    const mutedRes = await patchSettings(memberToken, { activityMuted: true });
    assert.equal(mutedRes.status, 200);
    assert.deepEqual(await mutedRes.json(), {
      activityMuted: true,
      muteFromSeq: preMuteMessage.seq + 1,
      prefsVersion: 1,
      activityMuteSupported: true,
    });
    assert.deepEqual(emittedEvents.at(-1), {
      room: `user:${member.id}`,
      event: "notification_prefs:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        prefs: {
          activityMuted: true,
          muteFromSeq: preMuteMessage.seq + 1,
        },
        prefsVersion: 1,
      },
    });
    const afterMutedEventCount = emittedEvents.length;
    const repeatedMutedRes = await patchSettings(memberToken, { activityMuted: true });
    assert.equal(repeatedMutedRes.status, 200);
    assert.deepEqual(await repeatedMutedRes.json(), {
      activityMuted: true,
      muteFromSeq: preMuteMessage.seq + 1,
      prefsVersion: 1,
      activityMuteSupported: true,
    });
    assert.equal(emittedEvents.length, afterMutedEventCount, "same-value activity mute PATCH must not emit");
    const muteUpdateTrace = lastTraceEvent("activity_mute.api.updated");
    assert.equal(muteUpdateTrace.attrs?.activity_mute_state, "muted");
    assert.equal(muteUpdateTrace.attrs?.negative_evidence_bucket, "does_not_prove_future_message_suppression");
    assert.equal(muteUpdateTrace.attrs?.source_channel_id, channel.id);
    assert.equal(muteUpdateTrace.attrs?.mute_from_seq, preMuteMessage.seq + 1);

    const listAfterMuteRes = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(listAfterMuteRes.status, 200);
    const listAfterMute = await listAfterMuteRes.json() as Array<{
      id: string;
      activityMuted?: boolean;
      muteFromSeq?: number | null;
      prefsVersion?: number;
      activityMuteSupported?: boolean;
    }>;
    const mutedListChannel = listAfterMute.find((candidate) => candidate.id === channel.id);
    assert.ok(mutedListChannel, "muted channel should remain in the channel list");
    assert.equal(mutedListChannel.activityMuted, true);
    assert.equal(mutedListChannel.muteFromSeq, preMuteMessage.seq + 1);
    assert.equal(mutedListChannel.prefsVersion, 1);
    assert.equal(mutedListChannel.activityMuteSupported, true);

    const [cursorAfterMute] = await db
      .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, member.id),
        eq(userChannelReadCursors.channelId, channel.id),
      ));
    assert.equal(cursorAfterMute.lastReadSeq, preMuteMessage.seq);

    const ownerRes = await getSettings(ownerToken);
    assert.equal(ownerRes.status, 200);
    assert.deepEqual(await ownerRes.json(), {
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 0,
      activityMuteSupported: true,
    });

    const threadRes = await patchSettings(memberToken, { activityMuted: true }, thread.id);
    assert.equal(threadRes.status, 400);
    const threadBody = await threadRes.json() as { error: string };
    assert.match(threadBody.error, /follow\/unfollow/);

    sink.clear();
    const ordinaryMutedMessage = await sendMessage("ordinary muted-window message");
    assert.deepEqual(await outboxReceiverIds(ordinaryMutedMessage.id), [], "muted ordinary channel traffic must not create notification targets");
    const mutedFactTrace = traceEvent("inbox.notification_fact.decision", (attrs) =>
      attrs.message_id === ordinaryMutedMessage.id && attrs.receiver_id === member.id,
    );
    assert.equal(mutedFactTrace.attrs?.state, "activity_not_promoted");
    assert.equal(mutedFactTrace.attrs?.reason, "muted");
    assert.equal(mutedFactTrace.attrs?.negative_evidence_bucket, "muted_not_unfollowed_or_not_eligible");
    assert.equal(mutedFactTrace.attrs?.source_channel_id, channel.id);
    assert.equal(mutedFactTrace.attrs?.message_id, ordinaryMutedMessage.id);
    assert.equal(mutedFactTrace.attrs?.message_seq, ordinaryMutedMessage.seq);
    assert.equal(mutedFactTrace.attrs?.mute_from_seq, preMuteMessage.seq + 1);
    assert.equal(
      (await db
        .select()
        .from(inboxNotificationFacts)
        .where(and(
          eq(inboxNotificationFacts.messageId, ordinaryMutedMessage.id),
          eq(inboxNotificationFacts.receiverType, "user"),
          eq(inboxNotificationFacts.receiverId, member.id),
        ))).length,
      0,
      "muted ordinary channel traffic must not create notification facts for the muted receiver",
    );

    sink.clear();
    const mutedInbox = await getInbox();
    const mutedInboxSpan = [...sink.getAllSpans()].reverse().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/channels/inbox"
    );
    assert.ok(mutedInboxSpan, "expected GET /api/channels/inbox trace span");
    const backendEvent = mutedInboxSpan.events.find((event) => event.name === "inbox.backend.selected");
    assert.ok(backendEvent, "expected explicit inbox backend selection trace");
    assert.equal(backendEvent.attrs?.["inbox.backend"], "pg_legacy");
    assert.equal(backendEvent.attrs?.["inbox.fallback_reason"], "none");

    const mutedItem = mutedInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
    assert.ok(mutedItem, "pre-mute channel activity should keep the channel in Activity");
    assert.equal(mutedItem.lastMessageId, preMuteMessage.id, "muted ordinary traffic must not promote latest Activity");
    assert.equal(mutedItem.unreadCount, 0, "muted ordinary traffic must not add Inbox unread count");
    assert.equal(mutedItem.firstUnreadMessageId, null);
    const mutedUnreadInbox = await getInbox("unread");
    assert.deepEqual(mutedUnreadInbox.items, [], "muted ordinary traffic must not enter Inbox Unread");
    assert.equal(mutedUnreadInbox.totalUnreadCount, 0);
    const flagOnCutoffQueries: Array<{ queryName: string; attrs: Record<string, unknown> }> = [];
    await getInboxItems(server.id, member.id, {
      filter: "all",
      limit: 30,
      offset: 0,
      historyCutoff: new Date("2100-01-01T00:00:00Z"),
      humanActivityMuteEnabled: true,
      traceQuery: async (queryName, work, onComplete) => {
        const result = await work();
        flagOnCutoffQueries.push({
          queryName,
          attrs: (onComplete?.(result) ?? {}) as Record<string, unknown>,
        });
        return result;
      },
    });
    // 2026-09-21 teardown: the serving-rows branch is gone; historyCutoff is a
    // predicate carried by the canonical inline SQL (and by the RW view via
    // plan). The far-future cutoff empties everything.
    const flagOnCanonicalQuery = flagOnCutoffQueries.find((event) => event.queryName === "channels.inbox_items_by_user");
    assert.ok(flagOnCanonicalQuery, "expected historyCutoff inbox to run the canonical query");
    assert.equal(flagOnCanonicalQuery.attrs["inbox.backend"], "pg_legacy");
    const mutedChannelUnread = await getChannelUnreadCounts();
    assert.equal(mutedChannelUnread[channel.id], 1, "muted ordinary traffic must remain catch-up visible through the channel read cursor");

    const unmutedRes = await patchSettings(memberToken, { activityMuted: false });
    assert.equal(unmutedRes.status, 200);
    assert.deepEqual(await unmutedRes.json(), {
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 2,
      activityMuteSupported: true,
    });
    assert.deepEqual(emittedEvents.at(-1), {
      room: `user:${member.id}`,
      event: "notification_prefs:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        prefs: {
          activityMuted: false,
          muteFromSeq: null,
        },
        prefsVersion: 2,
      },
    });
    const afterUnmutedEventCount = emittedEvents.length;
    const repeatedUnmutedRes = await patchSettings(memberToken, { activityMuted: false });
    assert.equal(repeatedUnmutedRes.status, 200);
    assert.deepEqual(await repeatedUnmutedRes.json(), {
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 2,
      activityMuteSupported: true,
    });
    assert.equal(emittedEvents.length, afterUnmutedEventCount, "same-value activity unmute PATCH must not emit");
    const muteRows = await db
      .select()
      .from(inboxTargetMuteStates)
      .where(and(
        eq(inboxTargetMuteStates.receiverType, "user"),
        eq(inboxTargetMuteStates.receiverId, member.id),
        eq(inboxTargetMuteStates.sourceChannelId, channel.id),
      ));
    assert.equal(muteRows.length, 1);
    assert.equal(muteRows[0].activityMuted, false);
    assert.equal(muteRows[0].muteFromSeq, null);
    assert.equal(muteRows[0].prefsVersion, 2);

    // 2026-09-21 teardown: Activity derives live from canonical tables (both
    // the inline SQL and the RW chain — rw_subs_v1 drops the subscription
    // while muted and revives it whole on unmute). Mute suppresses
    // notification-time delivery (push, facts), not history: unmuting
    // re-admits muted-window traffic to Activity. The old "no retroactive
    // promotion" property was a recorded-verdict artifact of the retired
    // serving-rows pipeline.
    const unmutedInbox = await getInbox();
    const unmutedItem = unmutedInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
    assert.equal(unmutedItem?.lastMessageId, ordinaryMutedMessage.id, "unmute re-admits muted-window traffic to Activity (live derivation)");
    assert.equal(unmutedItem?.unreadCount, 1, "muted-window ordinary traffic counts as unread once unmuted");
    assert.equal((await getChannelUnreadCounts())[channel.id], 1, "unmute must not mark muted-window traffic read in the channel");

    const remutedRes = await patchSettings(memberToken, { activityMuted: true });
    assert.equal(remutedRes.status, 200);
    assert.deepEqual(await remutedRes.json(), {
      activityMuted: true,
      muteFromSeq: ordinaryMutedMessage.seq + 1,
      prefsVersion: 3,
      activityMuteSupported: true,
    });

    sink.clear();
    const mentionMessage = await sendMessage("personal pierce for @channel-mute-member");
    assert.deepEqual(await outboxReceiverIds(mentionMessage.id), [member.id], "direct @mention should pierce channel activity mute for notifications");
    const mentionFactTrace = traceEvent("inbox.notification_fact.decision", (attrs) =>
      attrs.message_id === mentionMessage.id && attrs.receiver_id === member.id,
    );
    assert.equal(mentionFactTrace.attrs?.state, "activity_promoted");
    assert.equal(mentionFactTrace.attrs?.reason, "personal_mention_pierced");
    assert.equal(mentionFactTrace.attrs?.negative_evidence_bucket, "does_not_prove_read_state_or_ui_rendered");
    assert.equal(mentionFactTrace.attrs?.source_channel_id, channel.id);
    assert.equal(mentionFactTrace.attrs?.message_id, mentionMessage.id);
    assert.equal(mentionFactTrace.attrs?.message_seq, mentionMessage.seq);
    assert.equal(mentionFactTrace.attrs?.mute_from_seq, ordinaryMutedMessage.seq + 1);

    const mentionInbox = await getInbox("mentions");
    const mentionItem = mentionInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
    assert.ok(mentionItem, "direct @mention should pierce channel activity mute for Mentions");
    assert.equal(mentionItem.lastMessageId, mentionMessage.id);
    assert.equal(mentionItem.hasMention, true);
    // Re-mute anchored mute_from_seq after the formerly-muted message, so
    // under live derivation that message is ordinary unread (it predates the
    // current mute window) and the personal mention pierces the window.
    const mentionUnreadInbox = await getInbox("unread");
    const mentionUnreadItem = mentionUnreadInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
    assert.ok(mentionUnreadItem, "direct @mention should pierce channel activity mute for Inbox Unread");
    assert.equal(mentionUnreadItem.firstUnreadMessageId, ordinaryMutedMessage.id);
    assert.equal(mentionUnreadItem.unreadCount, 2);
    assert.equal(mentionUnreadInbox.totalUnreadCount, 2);
  } finally {
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    await closeRisingWavePool();
  }
});


testMuteFlagOff("GET/PATCH /api/channels/:id/message-display-settings stores per-user collapse preference", async ({ app }) => {
  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  delete process.env.RISINGWAVE_DATABASE_URL;
  await closeRisingWavePool();
  try {
    const emittedEvents = installFakeIo(app.app);

    const db = getDb();
    const owner = await seedUser("channel-display-owner@slock.test", "channel-display-owner");
    const member = await seedUser("channel-display-member@slock.test", "channel-display-member");
    const outsider = await seedUser("channel-display-outsider@slock.test", "channel-display-outsider");
    const server = await createServer("Channel Display Settings", "channel-display-settings", owner.id);
    await addMember(server.id, member.id);
    await addMember(server.id, outsider.id);
    const channel = await createChannel(server.id, "display-target", "message display prefs target");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
    const privateChannel = await createChannel(server.id, "display-private", "private display prefs target", "private");
    await addHuman(privateChannel.id, owner.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent");
    const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");

    const ownerToken = await tokenForHuman(owner.email);
    const memberToken = await tokenForHuman(member.email);
    const getSettings = (token: string, channelId = channel.id) => fetch(`${app.baseUrl}/api/channels/${channelId}/message-display-settings`, {
      headers: headers(token, server.id),
    });
    const patchSettings = (token: string, body: unknown, channelId = channel.id) => fetch(`${app.baseUrl}/api/channels/${channelId}/message-display-settings`, {
      method: "PATCH",
      headers: headers(token, server.id),
      body: JSON.stringify(body),
    });

    // Retired configuration may be absent. Display preferences remain usable;
    // membership and input validation below still protect the endpoint.
    await db.delete(featureFlags).where(eq(featureFlags.key, "topbar_overflow_v0"));

    const initialRes = await getSettings(memberToken);
    assert.equal(initialRes.status, 200);
    assert.deepEqual(await initialRes.json(), {
      collapseLongMessages: false,
      prefsVersion: 0,
    });

    const invalidRes = await patchSettings(memberToken, { collapseLongMessages: "no" });
    assert.equal(invalidRes.status, 400);

    // Server member without private-channel membership gets the same 404 the
    // activity-mute guard produces.
    const nonMemberGetRes = await getSettings(memberToken, privateChannel.id);
    assert.equal(nonMemberGetRes.status, 404);
    const nonMemberPatchRes = await patchSettings(memberToken, { collapseLongMessages: false }, privateChannel.id);
    assert.equal(nonMemberPatchRes.status, 404);

    // A server member who never joined this public channel must not read or
    // persist per-user display prefs for it: prefs are a "my channel" setting,
    // so the gate is channel membership, not public-channel readability.
    const outsiderToken = await tokenForHuman(outsider.email);
    const outsiderGetRes = await getSettings(outsiderToken);
    assert.equal(outsiderGetRes.status, 404);
    const outsiderPatchRes = await patchSettings(outsiderToken, { collapseLongMessages: false });
    assert.equal(outsiderPatchRes.status, 404);
    const outsiderRows = await db
      .select()
      .from(userChannelDisplayPrefs)
      .where(and(
        eq(userChannelDisplayPrefs.userId, outsider.id),
        eq(userChannelDisplayPrefs.channelId, channel.id),
      ));
    assert.equal(outsiderRows.length, 0, "unjoined public-channel PATCH must not persist a prefs row");

    // ...but the enabled system #all channel has implicit membership for every
    // server human (no channel_humans rows are ever persisted for it), so the
    // same outsider can read and persist prefs there.
    const [allChannel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    assert.ok(allChannel, "expected system #all channel");
    const allGetRes = await getSettings(outsiderToken, allChannel.id);
    assert.equal(allGetRes.status, 200);
    const allPatchRes = await patchSettings(outsiderToken, { collapseLongMessages: true }, allChannel.id);
    assert.equal(allPatchRes.status, 200);
    assert.deepEqual(await allPatchRes.json(), {
      collapseLongMessages: true,
      prefsVersion: 1,
    });

    const enabledRes = await patchSettings(memberToken, { collapseLongMessages: true });
    assert.equal(enabledRes.status, 200);
    assert.deepEqual(await enabledRes.json(), {
      collapseLongMessages: true,
      prefsVersion: 1,
    });
    assert.deepEqual(emittedEvents.at(-1), {
      room: `user:${member.id}`,
      event: "message_display_prefs:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        prefs: {
          collapseLongMessages: true,
        },
        prefsVersion: 1,
      },
    });
    const afterEnableEventCount = emittedEvents.length;
    const repeatedEnabledRes = await patchSettings(memberToken, { collapseLongMessages: true });
    assert.equal(repeatedEnabledRes.status, 200);
    assert.deepEqual(await repeatedEnabledRes.json(), {
      collapseLongMessages: true,
      prefsVersion: 1,
    });
    assert.equal(emittedEvents.length, afterEnableEventCount, "same-value display prefs PATCH must not emit");

    const listRes = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as Array<{
      id: string;
      collapseLongMessages?: boolean;
      displayPrefsVersion?: number;
    }>;
    const listChannel = list.find((candidate) => candidate.id === channel.id);
    assert.ok(listChannel, "channel should remain visible");
    assert.equal(listChannel.collapseLongMessages, true);
    assert.equal(listChannel.displayPrefsVersion, 1);

    const detailRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json() as { collapseLongMessages?: boolean; displayPrefsVersion?: number };
    assert.equal(detail.collapseLongMessages, true);
    assert.equal(detail.displayPrefsVersion, 1);

    const ownerRes = await getSettings(ownerToken);
    assert.equal(ownerRes.status, 200);
    assert.deepEqual(await ownerRes.json(), {
      collapseLongMessages: false,
      prefsVersion: 0,
    });

    const redisabledRes = await patchSettings(memberToken, { collapseLongMessages: false });
    assert.equal(redisabledRes.status, 200);
    assert.deepEqual(await redisabledRes.json(), {
      collapseLongMessages: false,
      prefsVersion: 2,
    });
    assert.deepEqual(emittedEvents.at(-1), {
      room: `user:${member.id}`,
      event: "message_display_prefs:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        prefs: {
          collapseLongMessages: false,
        },
        prefsVersion: 2,
      },
    });

    const prefRows = await db
      .select()
      .from(userChannelDisplayPrefs)
      .where(and(
        eq(userChannelDisplayPrefs.userId, member.id),
        eq(userChannelDisplayPrefs.channelId, channel.id),
      ));
    assert.equal(prefRows.length, 1);
    assert.equal(prefRows[0].collapseLongMessages, false);
    assert.equal(prefRows[0].prefsVersion, 2);

    const threadRes = await patchSettings(memberToken, { collapseLongMessages: false }, thread.id);
    assert.equal(threadRes.status, 400);
    const threadBody = await threadRes.json() as { error: string };
    assert.match(threadBody.error, /parent channel/);
  } finally {
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    await closeRisingWavePool();
  }
});


// task #473: staging DM API answered `activityMuteSupported: true` while no
// user-reachable DM mute surface exists (#proj-qa:8aad2993, Web f5cf0470 x
// Server ef98efe4 — DM DOM had zero `activity-mute-toggle` nodes in en and zh).
// Only a DM with an App bot can be muted (channels.appBotDmMute.api.test.ts);
// a DM with a person must not announce it. A regular channel must keep
// announcing it, otherwise "stop claiming" would silently retire the real feature.
test("activityMuteSupported is announced for channels and withheld for a DM with a person on every surface", async ({ app }) => {
  const owner = await seedUser("dm-mute-claim-owner@slock.test", "dm-mute-claim-owner");
  const peer = await seedUser("dm-mute-claim-peer@slock.test", "dm-mute-claim-peer");
  const server = await createServer("DM Mute Claim", "dm-mute-claim", owner.id);
  await addMember(server.id, peer.id);
  const ownerToken = await tokenForHuman(owner.email);

  const channel = await createChannel(server.id, "mute-claim-channel", "regular channel");
  await addHuman(channel.id, owner.id);

  const dmRes = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: peer.id }),
  });
  assert.equal(dmRes.status, 200);
  const dm = await dmRes.json() as { id: string; activityMuteSupported?: boolean };

  type MuteClaim = { activityMuteSupported?: boolean };
  const readClaim = async (res: Response) => {
    assert.equal(res.status, 200);
    return await res.json() as MuteClaim;
  };
  const getSettings = (channelId: string) => fetch(`${app.baseUrl}/api/channels/${channelId}/notification-settings`, {
    headers: headers(ownerToken, server.id),
  });
  const patchSettings = (channelId: string, activityMuted: boolean) => fetch(`${app.baseUrl}/api/channels/${channelId}/notification-settings`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ activityMuted }),
  });
  const getChannel = (channelId: string) => fetch(`${app.baseUrl}/api/channels/${channelId}`, {
    headers: headers(ownerToken, server.id),
  });

  // The DM must not claim the capability on any surface that reports it. PATCH
  // refuses to mute it (channels.appBotDmMute.api.test.ts), so read the claim
  // from an unmute, which is always accepted.
  assert.equal((await readClaim(await getSettings(dm.id))).activityMuteSupported, false);
  assert.equal((await readClaim(await patchSettings(dm.id, false))).activityMuteSupported, false);
  assert.equal((await readClaim(await getChannel(dm.id))).activityMuteSupported, false);

  const dmListRes = await fetch(`${app.baseUrl}/api/channels/dm`, { headers: headers(ownerToken, server.id) });
  assert.equal(dmListRes.status, 200);
  const dmList = await dmListRes.json() as MuteClaim[];
  const listedDm = dmList.find((row) => (row as { id?: string }).id === dm.id);
  assert.ok(listedDm, "expected the created DM in the DM list");
  assert.equal(listedDm.activityMuteSupported, false);

  // The regular channel must still announce it on the same surfaces.
  assert.equal((await readClaim(await getSettings(channel.id))).activityMuteSupported, true);
  assert.equal((await readClaim(await patchSettings(channel.id, true))).activityMuteSupported, true);
  assert.equal((await readClaim(await getChannel(channel.id))).activityMuteSupported, true);
});


test("saved message search and channel filters scope totals before pagination", async ({ app }) => {
  const owner = await seedUser("saved-filter-owner@slock.test", "Saved Filter Owner");
  const server = await createServer("Saved Filter Server", "saved-filter-server", owner.id);
  const channelA = await createChannel(server.id, "saved-alpha-room");
  const channelB = await createChannel(server.id, "saved-beta-room");
  await addHuman(channelA.id, owner.id);
  await addHuman(channelB.id, owner.id);
  const alphaOne = await createMessage(channelA.id, "user", owner.id, "alpha first result");
  const alphaTwo = await createMessage(channelA.id, "user", owner.id, "alpha second result");
  const beta = await createMessage(channelB.id, "user", owner.id, "beta only result");
  const savedThread = await getOrCreateThread(alphaOne.id, owner.id, "user");
  const threadReply = await createMessage(savedThread.id, "user", owner.id, "thread bookmark match");
  const ownerToken = await tokenForHuman(owner.email);
  const requestHeaders = headers(ownerToken, server.id);

  for (const messageId of [alphaOne.id, alphaTwo.id, beta.id, threadReply.id]) {
    const response = await fetch(`${app.baseUrl}/api/channels/saved`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ messageId }),
    });
    assert.equal(response.status, 200);
  }

  let response = await fetch(`${app.baseUrl}/api/channels/saved`, { headers: requestHeaders });
  assert.equal(response.status, 200);
  const newestSaved = await response.json() as { saved: Array<{ messageId: string }> };
  response = await fetch(`${app.baseUrl}/api/channels/saved?sort=asc`, { headers: requestHeaders });
  assert.equal(response.status, 200);
  const oldestSaved = await response.json() as { saved: Array<{ messageId: string }> };
  assert.deepEqual(
    oldestSaved.saved.map((entry) => entry.messageId),
    newestSaved.saved.map((entry) => entry.messageId).reverse(),
    "sort=asc must reverse the saved-at order before pagination",
  );

  response = await fetch(`${app.baseUrl}/api/channels/saved?q=alpha&limit=1`, {
    headers: requestHeaders,
  });
  assert.equal(response.status, 200);
  let body = await response.json() as { saved: Array<{ messageId: string }>; total: number; hasMore: boolean };
  assert.equal(body.saved.length, 1);
  assert.equal(
    body.total,
    3,
    "filtered Saved total should include a thread whose parent preview matches before the page limit",
  );
  assert.equal(body.hasMore, true);

  response = await fetch(`${app.baseUrl}/api/channels/saved?channelId=${channelB.id}&q=beta&limit=1`, {
    headers: requestHeaders,
  });
  assert.equal(response.status, 200);
  body = await response.json() as { saved: Array<{ messageId: string }>; total: number; hasMore: boolean };
  assert.deepEqual(body.saved.map((entry) => entry.messageId), [beta.id]);
  assert.equal(body.total, 1);
  assert.equal(body.hasMore, false);

  response = await fetch(`${app.baseUrl}/api/channels/saved?channelId=${channelA.id}&q=thread%20bookmark`, {
    headers: requestHeaders,
  });
  assert.equal(response.status, 200);
  const threadBody = await response.json() as {
    saved: Array<{
      messageId: string;
      channelType: string;
      parentChannelId: string | null;
      parentMessageId: string | null;
      parentMessagePreview: string | null;
      replyCount: number;
    }>;
    total: number;
  };
  assert.equal(threadBody.total, 1);
  assert.deepEqual({
    messageId: threadBody.saved[0]?.messageId,
    channelType: threadBody.saved[0]?.channelType,
    parentChannelId: threadBody.saved[0]?.parentChannelId,
    parentMessageId: threadBody.saved[0]?.parentMessageId,
    parentMessagePreview: threadBody.saved[0]?.parentMessagePreview,
    replyCount: threadBody.saved[0]?.replyCount,
  }, {
    messageId: threadReply.id,
    channelType: "thread",
    parentChannelId: channelA.id,
    parentMessageId: alphaOne.id,
    parentMessagePreview: "alpha first result",
    replyCount: 1,
  });
});


test("GET /api/channels/unread records unread-count phases and query shape", async ({ app }) => {
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

  const db = getDb();
  const owner = await seedUser("unread-trace-owner@slock.test", "unread-trace-owner");
  const peer = await seedUser("unread-trace-peer@slock.test", "unread-trace-peer");
  const server = await createServer("Unread Trace Server", "unread-trace-server", owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, "unread-channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, peer.id);
  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const channelReadMessage = await createMessage(channel.id, "user", owner.id, "already read");
  const unreadChannelMessage = await createMessage(channel.id, "user", peer.id, "unread channel message");
  await createMessage(dm.id, "user", peer.id, "unread dm message");
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: channel.id,
    lastReadSeq: channelReadMessage.seq,
    updatedAt: new Date(),
  });

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, number>;
  assert.equal(body[channel.id], 1);
  assert.equal(body[dm.id], 1);

  // 2026-09-21 teardown: the summary's mention half derives from
  // message_mentions in the canonical seq domain (inbox_serving_rows is dead).
  await db.insert(messageMentions).values({
    messageId: unreadChannelMessage.id,
    messageSeq: unreadChannelMessage.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: "unread-trace-owner",
    notifiableAtSend: true,
  });

  const summaryRes = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(summaryRes.status, 200);
  const summaryBody = await summaryRes.json() as {
    channels: Record<string, {
      unreadCount: number;
      hasMention: boolean;
      hasAnyMention: boolean;
      readState: { kind: string; readStateVersion?: number; maxReadSeq?: string; latestActivity?: { messageId: string; seq: string } | null };
    }>;
  };
  // #632 SSOT: the summary exit now carries the authoritative per-scope
  // read state. The channel got marked read once (version bumps, cursor at
  // the read seq) and then received one more message (frontier ahead).
  const channelEntry = summaryBody.channels[channel.id];
  assert.deepEqual(
    { unreadCount: channelEntry.unreadCount, hasMention: channelEntry.hasMention, hasAnyMention: channelEntry.hasAnyMention },
    { unreadCount: 1, hasMention: true, hasAnyMention: true },
  );
  assert.equal(channelEntry.readState.kind, "present");
  assert.equal(typeof channelEntry.readState.maxReadSeq, "string", "seq travels as canonical string");
  assert.ok(channelEntry.readState.latestActivity, "channel with messages carries a same-source frontier");
  const dmEntry = summaryBody.channels[dm.id];
  assert.deepEqual(
    { unreadCount: dmEntry.unreadCount, hasMention: dmEntry.hasMention, hasAnyMention: dmEntry.hasAnyMention },
    { unreadCount: 1, hasMention: false, hasAnyMention: false },
  );
  assert.ok(dmEntry.readState, "dm entry carries readState too");

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/unread",
  );
  assert.ok(span, "expected GET /api/channels/unread root span");

  const processEventNames = handlerTraceEvents(span.events)
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");
  assert.deepEqual(processEventNames, [
    "unread_counts.load.started",
    "inbox.backend.selected",
    "unread_counts.loaded",
    "response.ready",
    "http.response.finished",
  ]);

  // Unread is ONE read of rw_conversation_unread_v4 (answered by its Postgres
  // reference in tests); the summary adds its public hasNew arm to the same read.
  const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
  assert.deepEqual(dbEvents.map((event) => event.attrs?.query_name), ["channels.unread_counts_by_user"]);
  assert.equal(dbEvents.length, 1);
  assert.equal(dbEvents[0]?.attrs?.phase, "unread_counts.loaded");
  assert.equal(dbEvents[0]?.attrs?.unread_channels_count, 2);
  assert.equal(dbEvents[0]?.attrs?.rw_conversation_unread_view, "rw_conversation_unread_v4");
  assert.equal(dbEvents[0]?.attrs?.["inbox.backend"], "rw_mv");
  assert.equal(dbEvents[0]?.attrs?.["inbox.route"], "channel_unread");
  assert.equal(dbEvents[0]?.attrs?.["inbox.fallback_reason"], "none");
  assert.equal(dbEvents[0]?.attrs?.["inbox.contract_version"], 3);

  const backendEvent = span.events.find((event) => event.name === "inbox.backend.selected");
  assert.ok(backendEvent);
  assert.equal(backendEvent.attrs?.["inbox.backend"], "rw_mv");
  assert.equal(backendEvent.attrs?.["inbox.route"], "channel_unread");
  assert.equal(backendEvent.attrs?.["inbox.fallback_reason"], "none");
  assert.equal(backendEvent.attrs?.["inbox.contract_version"], 3);

  const loadedEvent = span.events.find((event) => event.name === "unread_counts.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.unread_channels_count, 2);

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.unread_channels_count, 2);
  assert.equal(Object.values(span.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(readyEvent.attrs ?? {}).includes(channel.id), false);
});


test("GET /api/channels/unread excludes current user's own messages", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("self-unread-owner@slock.test", "self-unread-owner");
  const peer = await seedUser("self-unread-peer@slock.test", "self-unread-peer");
  const server = await createServer("Self Unread Server", "self-unread-server", owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, "self-unread-channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, peer.id);
  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);

  const readMessage = await createMessage(channel.id, "user", peer.id, "read baseline");
  await createMessage(channel.id, "user", owner.id, "own channel message");
  await createMessage(dm.id, "user", owner.id, "own dm message");
  await db.insert(userChannelReadCursors).values([
    {
      userId: owner.id,
      channelId: channel.id,
      lastReadSeq: readMessage.seq,
      updatedAt: new Date(),
    },
    {
      userId: owner.id,
      channelId: dm.id,
      lastReadSeq: 0,
      updatedAt: new Date(),
    },
  ]);

  const ownerToken = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(ownerToken, server.id),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, number>;
  assert.equal(body[channel.id], undefined);
  assert.equal(body[dm.id], undefined);
});


test("POST /api/channels/:id/unread persists when latest message is self-authored", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("mark-unread-self-owner@slock.test", "mark-unread-self-owner");
  const peer = await seedUser("mark-unread-self-peer@slock.test", "mark-unread-self-peer");
  const server = await createServer("Mark Unread Self Server", "mark-unread-self-server", owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, "mark-unread-self-channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, peer.id);
  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);

  await createMessage(channel.id, "user", peer.id, "message to revisit");
  const ownLatestChannelMessage = await createMessage(channel.id, "user", owner.id, "own latest channel message");
  await createMessage(dm.id, "user", peer.id, "dm message to revisit");
  const ownLatestDmMessage = await createMessage(dm.id, "user", owner.id, "own latest dm message");
  await db.insert(userChannelReadCursors).values([
    {
      userId: owner.id,
      channelId: channel.id,
      lastReadSeq: ownLatestChannelMessage.seq,
      updatedAt: new Date(),
    },
    {
      userId: owner.id,
      channelId: dm.id,
      lastReadSeq: ownLatestDmMessage.seq,
      updatedAt: new Date(),
    },
  ]);

  const ownerToken = await tokenForHuman(owner.email);
  for (const target of [channel, dm]) {
    const markUnreadRes = await fetch(`${app.baseUrl}/api/channels/${target.id}/unread`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(markUnreadRes.status, 200);
    const markUnreadBody = await markUnreadRes.json() as { unreadCount: number };
    assert.equal(markUnreadBody.unreadCount, 1);
  }

  const unreadRes = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(unreadRes.status, 200);
  const unreadBody = await unreadRes.json() as Record<string, number>;
  assert.equal(unreadBody[channel.id], 1);
  assert.equal(unreadBody[dm.id], 1);
});


test("POST /api/channels broadcasts channel:updated for newly created channels", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "channel-create-owner@slock.test",
    name: "channel-create-owner",
    displayName: "Channel Create Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Channel Create Socket", "channel-create-socket", owner.id);
  const events = installFakeIo(app.app);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: "password123" }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json() as { accessToken: string };

  const res = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(accessToken, server.id),
    body: JSON.stringify({ name: "new-live-channel", description: "created during realtime test" }),
  });
  assert.equal(res.status, 200);
  const channel = await res.json() as { id: string; name: string; description: string | null; joined: boolean };
  assert.equal(channel.name, "new-live-channel");
  assert.equal(channel.joined, true);

  assert.equal(events.length, 1);
  assert.equal(events[0].room, `user:${owner.id}`);
  assert.equal(events[0].event, "channel:updated");
  const payload = events[0].payload as { channel: { id: string; name: string; description: string | null; joined: boolean } };
  assert.equal(payload.channel.id, channel.id);
  assert.equal(payload.channel.name, "new-live-channel");
  assert.equal(payload.channel.description, "created during realtime test");
  assert.equal(payload.channel.joined, true);
});


test("renaming a channel writes a persistent system message and delivers old/new names to agents", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("rename-notice-owner@slock.test", "rename-notice-owner");
  const server = await createServer("Rename Notice Server", "rename-notice-server", owner.id);
  const channel = await createChannel(server.id, "rename-before");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, "rename-notice-bot", { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{ agentId: string; message: { channel_name: string; content: string; sender_type: string; seq?: number } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { channel_name: string; content: string; sender_type: string; seq?: number }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ name: "rename-after" }),
  });
  assert.equal(res.status, 200);

  const [systemMessage] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "expected a persistent rename system message");
  assert.equal(systemMessage.content, "@rename-notice-owner renamed this channel from #rename-before to #rename-after.");
  assert.equal(systemMessage.senderId, "system");

  const delivery = deliveries.find((item) => item.agentId === agent.id);
  assert.ok(delivery, "agent in the channel should receive the rename system message");
  assert.equal(delivery.message.sender_type, "system");
  assert.equal(delivery.message.content, "@rename-notice-owner renamed this channel from #rename-before to #rename-after.");
  assert.equal(delivery.message.channel_name, "rename-after");
  assert.ok(delivery.message.seq, "delivery should carry the persisted message seq");
});


test("updating channel description does not write a rename system message", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("description-update-owner@slock.test", "description-update-owner");
  const server = await createServer("Description Update Server", "description-update-server", owner.id);
  const channel = await createChannel(server.id, "description-only");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, "description-update-bot", { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{ agentId: string; message: { content: string } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ description: "updated description" }),
  });
  assert.equal(res.status, 200);

  const systemMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.equal(systemMessages.length, 0, "description-only update should not write a system message");
  assert.equal(deliveries.length, 0, "description-only update should not deliver an agent system notice");
});


test("manually hidden #all does not auto-reveal when a second agent joins", async ({ app }) => {
  const owner = await seedUser("manual-hidden-all-agent-owner@slock.test", "manual-hidden-all-agent-owner");
  const server = await createServer("Manual Hidden Agent All", "manual-hidden-agent-all", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const [allChannel] = await getDb()
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "opener-world server should have an #all row");
  assert.equal(allChannel.type, "private", "opener-world #all starts born-hidden");

  const restore = await fetch(`${app.baseUrl}/api/channels/system/all/restore`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(restore.status, 200, "admin can make #all visible before team-growth unlock");

  // Repointed from PATCH /channels/:id to the dedicated hide endpoint (task #67).
  // The generic visibility field now refuses #all, so leaving this on PATCH would
  // have made the test drive a route nothing uses -- and it would have stayed
  // green while the unlock-instruction claim it depends on silently went missing.
  const hide = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(hide.status, 200, "admin manual hide should succeed");

  const oaAgent = await createAgent(server.id, "manual-hidden-agent-all-oa", { runtime: "codex" });
  await updateServerOnboardingAgent(server.id, oaAgent.id);
  await createAgent(server.id, "manual-hidden-agent-all-second", { runtime: "codex" });

  const [allAfterSecondAgent] = await getDb()
    .select({ type: channels.type })
    .from(channels)
    .where(eq(channels.id, allChannel.id));
  assert.equal(allAfterSecondAgent.type, "private", "manual hidden #all must stay hidden when agent growth reaches unlock threshold");
});


// Found in independent review of PR #7468. The hide endpoint skipped the
// unlock-instruction claim whenever #all was ALREADY hidden -- and that is the
// birth state of every new server, with the instruction unclaimed. So an owner who hides an #all that is already hidden
// expressed the same intent as one who hides a visible #all, and got a
// different durable outcome: team growth later re-revealed it. The claim is
// idempotent (it only writes when the column is null), so it must be
// unconditional -- the action means "keep this hidden", not "flip a bit".
test("hiding an already-hidden #all still claims the unlock instruction", async ({ app }) => {
  const owner = await seedUser("already-hidden-all-owner@slock.test", "already-hidden-all-owner");
  const server = await createServer("Already Hidden All", "already-hidden-all", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const [allChannel] = await getDb()
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "opener-world server should have an #all row");
  assert.equal(allChannel.type, "private", "opener-world #all starts born-hidden");

  // Deliberately NO restore first: hide an #all that is already hidden.
  const hide = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(hide.status, 200, await hide.clone().text());

  const oaAgent = await createAgent(server.id, "already-hidden-all-oa", { runtime: "codex" });
  await updateServerOnboardingAgent(server.id, oaAgent.id);
  await createAgent(server.id, "already-hidden-all-second", { runtime: "codex" });

  const [allAfterGrowth] = await getDb()
    .select({ type: channels.type })
    .from(channels)
    .where(eq(channels.id, allChannel.id));
  assert.equal(
    allAfterGrowth.type,
    "private",
    "an explicit hide of an already-hidden #all must survive the team-growth unlock",
  );
});


// Provenance: #proj-release:75e8ddc7 (scope A, 2026-07-08). Every new server's
// #all is born hidden (private) and must not list for the owner before unlock.
test("a new server's #all is born hidden and not listed before unlock", async ({ app }) => {
  const owner = await seedUser("opener-retro-owner@slock.test", "opener-retro-owner");
  const ownerToken = await tokenForHuman(owner.email);
  const serverNew = await createServer("Opener New World Server", "opener-new-world-server", owner.id);
  const [allNew] = await getDb()
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(eq(channels.serverId, serverNew.id), eq(channels.name, "all")));
  assert.ok(allNew, "new-world server should still create an #all row");
  assert.equal(allNew.type, "private", "new server #all is born hidden");
  const listNewRes = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, serverNew.id),
  });
  assert.equal(listNewRes.status, 200);
  const listNew = await listNewRes.json() as Array<{ id: string }>;
  assert.ok(!listNew.some((item) => item.id === allNew.id), "born-hidden #all must not list before unlock");
});


// Provenance: #proj-release:75e8ddc7 (scope A, 2026-07-08). The unlock half of the
// born-hidden design (John's T2 flow): the 2nd agent on an opener-world server flips
// hidden #all back to a live channel. Without this pin, only the hiding half of the
// design has coverage.
test("opener-world hidden #all auto-reveals when the 2nd agent arrives", async ({ app }) => {
  // onboardingService and messageService form a production-safe ESM cycle,
  // but Vitest's transformed module graph cannot eagerly capture this one
  // function. The persisted-message behavior is covered in focused service
  // tests; this route fixture only needs to observe the unlock transition.
  __setOnboardingServiceDepsForTests({ broadcastSystemMessage: async () => undefined as never });
  try {
    const owner = await seedUser("opener-unlock-owner@slock.test", "opener-unlock-owner");
    const server = await createServer("Opener Unlock Server", "opener-unlock-server", owner.id);
    const [allChannel] = await getDb()
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    assert.ok(allChannel, "opener-world server should have an #all row");
    assert.equal(allChannel.type, "private", "opener-world #all is born hidden");

    const firstAgent = await createAgent(server.id, "opener-first-agent", { runtime: "codex" });
    // Mirrors the real flow: the first (onboarding) agent is registered on the
    // server so pickOnboardingAgent can address the unlock message to it.
    await updateServerOnboardingAgent(server.id, firstAgent.id);
    const agentOrchestrator = app.app.get("agentOrchestrator");
    const unlockedEarly = await triggerAllChannelUnlockOnboarding(app.io, agentOrchestrator, server.id);
    assert.equal(unlockedEarly, false, "one agent must not unlock #all");
    const [allStillHidden] = await getDb()
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, allChannel.id));
    assert.equal(allStillHidden.type, "private", "#all stays hidden with a single agent");

    await createAgent(server.id, "opener-second-agent", { runtime: "codex" });
    const unlocked = await triggerAllChannelUnlockOnboarding(app.io, agentOrchestrator, server.id);
    assert.equal(unlocked, true, "2nd agent must trigger the #all unlock");

    const [allRevealed] = await getDb()
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, allChannel.id));
    assert.equal(allRevealed.type, "channel", "unlocked #all must flip back to an enabled channel");

    const ownerToken = await tokenForHuman(owner.email);
    const listRes = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as Array<{ id: string }>;
    assert.ok(list.some((item) => item.id === allChannel.id), "revealed #all must list again");
    assert.equal(await canUserPostToChannel(allChannel.id, owner.id), true, "revealed #all must be postable");
  } finally {
    __resetOnboardingServiceDepsForTests();
  }
});


test("removing an agent from a private channel does not deliver the removal notice to the removed agent", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-agent-remove-notice-owner@slock.test", "private-agent-remove-notice-owner");
  const server = await createServer("Private Agent Remove Notice Server", "private-agent-remove-notice-server", owner.id);
  const channel = await createChannel(server.id, "private-agent-remove-notice", undefined, "private");
  await addHuman(channel.id, owner.id);
  const removedAgent = await createAgent(server.id, "private-remove-target-bot", { runtime: "codex" });
  const remainingAgent = await createAgent(server.id, "private-remove-remaining-bot", { runtime: "codex" });
  await addAgent(channel.id, removedAgent.id);
  await addAgent(channel.id, remainingAgent.id);
  const parentMessage = await createMessage(channel.id, "user", owner.id, "private thread parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{
    agentId: string;
    message: { content: string; sender_type: string; seq?: number; channel_name?: string };
  }> = [];
  const purges: Array<{ agentId: string; channelIds: string[]; reason?: string }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string; sender_type: string; seq?: number; channel_name?: string }) => Promise<void>;
    purgeAgentInboxForChannelTree: (agentId: string, parentChannelId: string, reason?: string) => Promise<unknown>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };
  agentOrchestrator.purgeAgentInboxForChannelTree = async (agentId, parentChannelId, reason) => {
    const threadChannelIds = await listThreadChannelIdsForParentChannel(parentChannelId);
    purges.push({ agentId, channelIds: [parentChannelId, ...threadChannelIds], reason });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/agent/${removedAgent.id}`, {
    method: "DELETE",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const [systemMessage] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "expected a persistent channel system message for remaining private members");
  assert.equal(systemMessage.content, "@private-remove-target-bot was removed from this channel.");

  assert.equal(
    deliveries.some((item) => item.agentId === removedAgent.id),
    false,
    "removed private-channel agent must not receive an inbox notice naming a channel it can no longer read",
  );
  const remainingDelivery = deliveries.find((item) => item.agentId === remainingAgent.id);
  assert.ok(remainingDelivery, "remaining private-channel agents should still receive the channel system message");
  assert.equal(remainingDelivery.message.sender_type, "system");
  assert.equal(remainingDelivery.message.content, "@private-remove-target-bot was removed from this channel.");
  assert.equal(remainingDelivery.message.channel_name, channel.name);
  assert.deepEqual(purges, [{
    agentId: removedAgent.id,
    channelIds: [channel.id, thread.id],
    reason: "channel_membership_removed",
  }]);

  const [membership] = await db
    .select()
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, removedAgent.id)));
  assert.equal(membership, undefined, "agent membership row should be removed");
});


test("human/web unfollow blocks ordinary replies until a direct mention reactivates the follow", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  // Owner currently follows the thread as the parent-message author.
  // Unfollow is an explicit attention opt-out, not just a transient delete.
  let res = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(res.status, 200);

  let rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));
  const ownerSuppressed = rows.find((r) => r.followerType === "user" && r.followerId === f.ownerId);
  assert.ok(ownerSuppressed?.unfollowedAt, "unfollow should persist a suppressed follow row");

  // A later reply would previously re-insert/re-activate the parent author
  // with reason='authored', which made the thread re-enter Inbox.
  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "reply after owner unfollow" }),
  });
  assert.equal(res.status, 200);

  async function getOwnerInbox(filter: "all" | "unread" | "mentions" = "all") {
    const url = new URL(`${app.baseUrl}/api/channels/inbox`);
    url.searchParams.set("filter", filter);
    const inboxRes = await fetch(url, { headers: headers(f.ownerToken, f.serverId) });
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

  const afterOrdinaryReplyInbox = await getOwnerInbox();
  const attentionlessRow = afterOrdinaryReplyInbox.items.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  );
  assert.ok(attentionlessRow, "unfollowed/not-done thread must remain in Activity All");
  assert.equal(attentionlessRow.isFollowing, false);
  assert.equal(attentionlessRow.unreadCount, 0);
  assert.equal(attentionlessRow.hasMention, false);
  assert.equal(attentionlessRow.firstUnreadMessageId, null);
  assert.equal(
    (await getOwnerInbox("unread")).items.some((item) => item.threadChannelId === f.threadId),
    false,
    "unfollowed Activity rows must not enter Unread",
  );
  assert.equal(
    (await getOwnerInbox("mentions")).items.some((item) => item.threadChannelId === f.threadId),
    false,
    "unfollowed Activity rows must not enter Mentions",
  );

  // A direct @mention is a new attention signal: it restores the follow so
  // this message and later ordinary replies resume normal thread delivery.
  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "ping @owner after unfollow" }),
  });
  assert.equal(res.status, 200);
  const mentionMessage = await res.json() as { id: string };

  const [mentionRow] = await db
    .select()
    .from(messageMentions)
    .where(and(eq(messageMentions.messageId, mentionMessage.id), eq(messageMentions.targetId, f.ownerId)));
  assert.ok(
    mentionRow?.notifiedAt,
    "real direct mention through the send pipeline must stamp notified_at for an unfollowed-thread parent-channel member",
  );

  rows = await db
    .select()
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, f.threadId));
  const ownerAfter = rows.find((r) => r.followerType === "user" && r.followerId === f.ownerId);
  assert.equal(ownerAfter?.unfollowedAt, null, "direct mention must clear unfollowedAt");

  res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(res.status, 200);
  const followedAfterMention = await res.json() as { threads: Array<{ threadChannelId: string }> };
  assert.equal(
    followedAfterMention.threads.some((thread) => thread.threadChannelId === f.threadId),
    true,
    "direct mention must restore the thread to followed list",
  );

  const allInbox = await getOwnerInbox();
  const allThreadItem = allInbox.items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(allThreadItem, "direct mention should pierce into Inbox All");
  assert.equal(allThreadItem.hasMention, true, "All must preserve the direct mention marker");
  assert.ok((allThreadItem.unreadCount ?? 0) > 0, "reactivated follow must resume unread thread activity");

  const unreadInbox = await getOwnerInbox("unread");
  const unreadThreadItem = unreadInbox.items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(unreadThreadItem, "reactivated thread must return to Inbox Unread");

  const mentionsInbox = await getOwnerInbox("mentions");
  const mentionThreadItem = mentionsInbox.items.find((item) => item.kind === "thread" && item.threadChannelId === f.threadId);
  assert.ok(mentionThreadItem, "direct mention should pierce into Mentions filter");
  assert.equal(mentionThreadItem.hasMention, true, "Mentions filter must preserve the direct mention marker");
  assert.ok((mentionThreadItem.unreadCount ?? 0) > 0, "reactivated mention must use normal followed-thread unread semantics");

  res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({ channelId: f.threadId, content: "ordinary reply after mention reactivation" }),
  });
  assert.equal(res.status, 200);
  const refollowedInbox = await getOwnerInbox("unread");
  assert.ok(
    refollowedInbox.items.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId),
    "ordinary replies after mention reactivation must continue to deliver",
  );
});


test("Activity All, Done, and Restore keep unfollow and completion as independent states", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  let response = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      channelId: f.threadId,
      content: "ordinary activity advances an unfollowed All row",
    }),
  });
  assert.equal(response.status, 200);

  let all = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const unfollowed = all.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  ) as (InboxMentionItem & { isFollowing?: boolean }) | undefined;
  assert.ok(unfollowed);
  assert.equal(unfollowed.isFollowing, false);
  assert.equal(unfollowed.unreadCount, 0);
  assert.equal(unfollowed.hasMention, false);

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(response.status, 200, "unfollowed rows retain the same Done control");
  const [doneFollowState] = await getDb().select({
    doneAt: threadFollows.doneAt,
    unfollowedAt: threadFollows.unfollowedAt,
  }).from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, f.threadId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, f.ownerId),
  ));
  assert.ok(doneFollowState?.doneAt, "Done must persist independently of unfollow");
  assert.ok(doneFollowState?.unfollowedAt, "Done must preserve unfollow");

  all = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.equal(
    all.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId),
    false,
    "done+unfollowed must leave Activity All",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=30`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  const done = await response.json() as { items: Array<{
    kind: string;
    threadChannelId?: string;
    isFollowing?: boolean;
  }> };
  const doneUnfollowed = done.items.find((item) => item.threadChannelId === f.threadId);
  assert.ok(doneUnfollowed, "done+unfollowed remains recoverable in Done history");
  assert.equal(doneUnfollowed.isFollowing, false);

  response = await fetch(`${app.baseUrl}/api/channels/threads/undone`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  all = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const restored = all.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  ) as (InboxMentionItem & { isFollowing?: boolean }) | undefined;
  assert.ok(restored, "Restore returns an unfollowed row to All");
  assert.equal(restored.isFollowing, false, "Restore must not silently re-follow");
  assert.equal(restored.unreadCount, 0);
});


test("Activity All Done removes an unfollowed row through the legacy omitted-frontier route", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  let response = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      channelId: f.threadId,
      content: "reply after unfollow",
    }),
  });
  assert.equal(response.status, 200);

  const beforeDone = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.ok(beforeDone.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId));

  // This is the exact pre-frontier client payload used for an unfollowed
  // history row: it has no authoritative Done frontier, so the server must
  // snapshot its canonical latest and still persist Done.
  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200, await response.clone().text());

  const afterDone = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.equal(
    afterDone.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId),
    false,
    "an unfollowed row must stay absent after Done and a fresh Activity read",
  );
  const [follow] = await getDb().select({ doneAt: threadFollows.doneAt, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, f.threadId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, f.ownerId),
    ));
  assert.ok(follow?.doneAt);
  assert.ok(follow?.unfollowedAt);
});


test("Done, Unfollow, and Restore preserve completion independently of follow state", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);

  let response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  const [state] = await getDb().select({
    doneAt: threadFollows.doneAt,
    unfollowedAt: threadFollows.unfollowedAt,
  }).from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, f.threadId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, f.ownerId),
  ));
  assert.ok(state?.doneAt, "Unfollow must preserve an existing Done marker");
  assert.ok(state?.unfollowedAt);

  let all = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  assert.equal(
    all.some((item) => item.kind === "thread" && item.threadChannelId === f.threadId),
    false,
    "done+unfollowed must remain outside All",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=30`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  let done = await response.json() as { items: Array<{
    kind: string;
    threadChannelId?: string;
    isFollowing?: boolean;
  }> };
  const unfollowedDone = done.items.find((item) => item.threadChannelId === f.threadId);
  assert.ok(unfollowedDone, "Done history must retain the row after Unfollow");
  assert.equal(unfollowedDone.isFollowing, false);

  response = await fetch(`${app.baseUrl}/api/channels/threads/undone`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.equal(response.status, 200);

  all = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
  const restored = all.find(
    (item) => item.kind === "thread" && item.threadChannelId === f.threadId,
  ) as (InboxMentionItem & { isFollowing?: boolean }) | undefined;
  assert.ok(restored, "Restore returns the row to All");
  assert.equal(restored.isFollowing, false, "Restore must not silently re-follow");
  assert.equal(restored.unreadCount, 0);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=30`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(response.status, 200);
  done = await response.json() as typeof done;
  assert.equal(
    done.items.some((item) => item.threadChannelId === f.threadId),
    false,
    "Restore alone removes the row from Done history",
  );
});


test("Activity All paginates more than 100 unfollowed rows with mixed follow states and stable ties", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const rowCount = 115;
  const isUnfollowedIndex = (index: number) => index % 11 !== 10;
  const parentAt = new Date("2026-08-09T00:00:00.000Z");
  const parentRows = await db.insert(messages).values(Array.from({ length: rowCount }, (_, index) => ({
    channelId: f.parentChannelId,
    senderType: "user" as const,
    senderId: f.ownerId,
    content: `pagination parent ${index.toString().padStart(3, "0")}`,
    createdAt: parentAt,
    updatedAt: parentAt,
  }))).returning({ id: messages.id });
  assert.equal(parentRows.length, rowCount);

  const threadRows = await db.insert(channels).values(parentRows.map((parent, index) => ({
    serverId: f.serverId,
    name: `pagination-thread-${index.toString().padStart(3, "0")}`,
    type: "thread" as const,
    parentMessageId: parent.id,
    createdAt: parentAt,
  }))).returning({ id: channels.id, parentMessageId: channels.parentMessageId });
  assert.equal(threadRows.length, rowCount);

  const activityAtByThread = new Map<string, Date>();
  await db.insert(threadFollows).values(threadRows.map((thread, index) => {
    const activityAt = new Date(Date.parse("2026-08-10T00:00:00.000Z") + Math.floor(index / 2) * 1_000);
    activityAtByThread.set(thread.id, activityAt);
    return {
      threadChannelId: thread.id,
      followerType: "user" as const,
      followerId: f.ownerId,
      parentMessageId: thread.parentMessageId!,
      reason: "manual" as const,
      unfollowedAt: isUnfollowedIndex(index) ? new Date("2026-08-11T00:00:00.000Z") : null,
    };
  }));
  await db.insert(messages).values(threadRows.map((thread, index) => ({
    channelId: thread.id,
    senderType: "user" as const,
    senderId: f.memberBId,
    content: `pagination reply ${index.toString().padStart(3, "0")}`,
    createdAt: activityAtByThread.get(thread.id)!,
    updatedAt: activityAtByThread.get(thread.id)!,
  })));

  const first = await getInboxItems(f.serverId, f.ownerId, {
    filter: "all",
    sort: "desc",
    limit: 100,
    offset: 0,
    includeUnfollowedThreads: true,
    forcePostgres: true,
    forceCanonicalPostgres: true,
  });
  const second = await getInboxItems(f.serverId, f.ownerId, {
    filter: "all",
    sort: "desc",
    limit: 100,
    offset: 100,
    includeUnfollowedThreads: true,
    forcePostgres: true,
    forceCanonicalPostgres: true,
  });
  assert.equal(first.items.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);

  const whitespaceSearch = await getInboxItems(f.serverId, f.ownerId, {
    filter: "all",
    sort: "desc",
    q: "   ",
    limit: 100,
    offset: 0,
    includeUnfollowedThreads: true,
    forcePostgres: true,
    forceCanonicalPostgres: true,
  });
  assert.deepEqual(
    whitespaceSearch.items.map((item) => (item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId),
    first.items.map((item) => (item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId),
    "blank search must normalize once for both active and unfollowed sources",
  );
  assert.equal(whitespaceSearch.totalCount, first.totalCount);

  const generatedIds = new Set(threadRows.map((thread) => thread.id));
  const pagedGenerated = [...first.items, ...second.items].filter(
    (item): item is Extract<InboxItem, { kind: "thread" }> =>
      item.kind === "thread" && generatedIds.has(item.threadChannelId),
  );
  assert.equal(pagedGenerated.length, rowCount, "all generated rows must cross the page boundary once");
  assert.equal(new Set(pagedGenerated.map((item) => item.threadChannelId)).size, rowCount);

  const expectedIds = [...threadRows].sort((left, right) => {
    const activityDelta = activityAtByThread.get(right.id)!.getTime()
      - activityAtByThread.get(left.id)!.getTime();
    return activityDelta || right.id.localeCompare(left.id);
  }).map((thread) => thread.id);
  assert.deepEqual(
    pagedGenerated.map((item) => item.threadChannelId),
    expectedIds,
    "timestamp ties must use the stable kind/identity ordering across pages",
  );

  for (const [index, thread] of threadRows.entries()) {
    const item = pagedGenerated.find((candidate) => candidate.threadChannelId === thread.id);
    assert.ok(item);
    assert.equal(item.isFollowing, !isUnfollowedIndex(index));
    if (isUnfollowedIndex(index)) {
      assert.equal(item.unreadCount, 0);
      assert.equal(item.hasMention, false);
      assert.equal(item.firstUnreadMessageId, null);
    }
  }
  assert.ok(
    threadRows.filter((_, index) => isUnfollowedIndex(index)).length > 100,
    "fixture must cross the retired 100-row unfollowed overlay cap",
  );
});


test("Activity V1 writes expose their deployed response shapes and converge through canonical refetch", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const channelActivity = await createMessage(
    f.parentChannelId,
    "user",
    f.memberBId,
    "activity-v1 channel fact",
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
    "activity-v1 thread fact",
  );
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "thread",
    sourceChannelId: f.threadId,
    message: threadActivity,
  });

  const requestHeaders = headers(f.ownerToken, f.serverId);
  const inboxReadAll = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
    method: "POST",
    headers: requestHeaders,
    body: "{}",
  });
  assert.equal(inboxReadAll.status, 200, await inboxReadAll.clone().text());
  const inboxReadAllBody = await inboxReadAll.json() as {
    ok: boolean;
    markedCount: number;
    scopes: Array<{ scopeId: string; maxReadSeq: number; readStateVersion: number }>;
  };
  assert.deepEqual(
    Object.keys(inboxReadAllBody).sort(),
    ["markedCount", "ok", "scopes"],
    "V1 global read-all must keep the deployed response instead of claiming a V2 receipt",
  );
  assert.equal(inboxReadAllBody.ok, true);
  assert.ok(inboxReadAllBody.markedCount >= 2);
  assert.ok(inboxReadAllBody.scopes.some((scope) => scope.scopeId === f.parentChannelId));
  assert.ok(inboxReadAllBody.scopes.some((scope) => scope.scopeId === f.threadId));
  assert.ok(inboxReadAllBody.scopes.every((scope) =>
    Object.keys(scope).sort().join(",") === "maxReadSeq,readStateVersion,scopeId"
  ));

  const channelReadAll = await fetch(`${app.baseUrl}/api/channels/${f.parentChannelId}/read-all`, {
    method: "POST",
    headers: requestHeaders,
    body: "{}",
  });
  assert.equal(channelReadAll.status, 200, await channelReadAll.clone().text());
  const channelReadAllBody = await channelReadAll.json() as {
    ok: boolean;
    seq: number;
    readStateVersion: number;
  };
  assert.deepEqual(
    Object.keys(channelReadAllBody).sort(),
    ["ok", "readStateVersion", "seq"],
    "V1 channel read-all must keep the deployed response instead of claiming a V2 receipt",
  );
  assert.equal(channelReadAllBody.ok, true);
  assert.equal(channelReadAllBody.seq, channelActivity.seq);

  const beforeDone = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: requestHeaders,
  });
  assert.equal(beforeDone.status, 200, await beforeDone.clone().text());
  const beforeDoneBody = await beforeDone.json() as {
    items: Array<{ kind: string; channelId?: string; threadChannelId?: string }>;
  };
  assert.ok(beforeDoneBody.items.some((item) =>
    item.kind === "channel" && item.channelId === f.parentChannelId
  ));
  assert.ok(beforeDoneBody.items.some((item) =>
    item.kind === "thread" && item.threadChannelId === f.threadId
  ));

  const inboxDone = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(await channelDoneBody(f.parentChannelId)),
  });
  assert.equal(inboxDone.status, 200, await inboxDone.clone().text());
  assert.deepEqual(
    await inboxDone.json(),
    { ok: true },
    "V1 inbox done must not fabricate a V2 command receipt",
  );

  const threadDone = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(await threadDoneBody(f.threadId)),
  });
  assert.equal(threadDone.status, 200, await threadDone.clone().text());
  assert.deepEqual(
    await threadDone.json(),
    { ok: true },
    "V1 thread done must not fabricate a V2 command receipt",
  );

  const afterDone = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: requestHeaders,
  });
  assert.equal(afterDone.status, 200, await afterDone.clone().text());
  const afterDoneBody = await afterDone.json() as {
    items: Array<{ kind: string; channelId?: string; threadChannelId?: string }>;
  };
  assert.ok(!afterDoneBody.items.some((item) =>
    item.kind === "channel" && item.channelId === f.parentChannelId
  ));
  assert.ok(!afterDoneBody.items.some((item) =>
    item.kind === "thread" && item.threadChannelId === f.threadId
  ));

  const followedAfterDone = await fetch(`${app.baseUrl}/api/channels/threads/followed`, {
    headers: requestHeaders,
  });
  assert.equal(followedAfterDone.status, 200, await followedAfterDone.clone().text());
  const followedAfterDoneBody = await followedAfterDone.json() as {
    threads: Array<{ threadChannelId: string }>;
  };
  assert.ok(!followedAfterDoneBody.threads.some((thread) =>
    thread.threadChannelId === f.threadId
  ));

  const wrongInboxScope = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: f.threadId,
      throughActivitySeq: "1",
      frontierSpace: "storage",
    }),
  });
  assert.equal(wrongInboxScope.status, 404, "inbox done must reject a thread scope");
  const wrongThreadScopeChannel = await createChannel(
    f.serverId,
    "activity-v1-wrong-thread-scope",
  );
  await addHuman(wrongThreadScopeChannel.id, f.ownerId);
  await createMessage(
    wrongThreadScopeChannel.id,
    "user",
    f.memberBId,
    "must not gain a thread suppression",
  );
  const wrongThreadScope = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: wrongThreadScopeChannel.id,
      throughActivitySeq: "1",
      frontierSpace: "storage",
    }),
  });
  // task #34: a non-thread scope the caller CAN access is now reported as the
  // caller bug it is (400 NOT_A_THREAD) instead of being merged into the
  // access-denied 404. The invariant this case protects is unchanged and still
  // asserted below: Done is REJECTED and no suppression row is written. This
  // still goes red if the endpoint ever accepts a non-thread scope.
  assert.equal(wrongThreadScope.status, 400, "thread done must reject a non-thread scope");
  assert.equal(
    ((await wrongThreadScope.clone().json()) as { code?: string }).code,
    "NOT_A_THREAD",
    "rejection must name the cause, not reuse the access-denied 404",
  );
  const wrongScopeSuppressions = await getDb().select()
    .from(inboxSuppressionStates)
    .where(and(
      eq(inboxSuppressionStates.receiverId, f.ownerId),
      eq(inboxSuppressionStates.sourceChannelId, wrongThreadScopeChannel.id),
    ));
  assert.equal(
    wrongScopeSuppressions.length,
    0,
    "a rejected non-thread scope must not write a thread suppression",
  );
});


test("Done routes preserve omitted-frontier canonical snapshots with implicit or explicit storage identity", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const requestHeaders = headers(f.ownerToken, f.serverId);
  const channelTarget = await resolveChannelSuppressionTarget(f.parentChannelId);
  const threadTarget = await resolveThreadSuppressionTarget(f.threadId);
  assert.ok(channelTarget?.latestSeqExact);
  assert.ok(threadTarget?.latestSeqExact);

  const channelFallbackBefore = await legacyDoneFallbackCount("channel");
  const threadFallbackBefore = await legacyDoneFallbackCount("thread");

  const legacyChannelResponse = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ channelId: f.parentChannelId }),
  });
  const legacyThreadResponse = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ threadChannelId: f.threadId }),
  });
  assert.deepEqual(
    [legacyChannelResponse.status, legacyThreadResponse.status],
    [200, 200],
    `channel=${await legacyChannelResponse.clone().text()} thread=${await legacyThreadResponse.clone().text()}`,
  );

  assert.equal(await legacyDoneFallbackCount("channel"), channelFallbackBefore + 1);
  assert.equal(await legacyDoneFallbackCount("thread"), threadFallbackBefore + 1);

  const doneRows = await getDb().select().from(readMutations).where(and(
    eq(readMutations.principalId, f.ownerId),
    inArray(readMutations.scopeId, [f.parentChannelId, f.threadId]),
    eq(readMutations.kind, "done"),
  ));
  assert.equal(doneRows.length, 2);
  assert.equal(
    doneRows.find((row) => row.scopeId === f.parentChannelId)?.doneThroughSeq?.toString(),
    channelTarget.latestSeqExact,
    "channel worker recheck must use the exact frontier S captured at admission",
  );
  assert.equal(
    doneRows.find((row) => row.scopeId === f.threadId)?.doneThroughSeq?.toString(),
    threadTarget.latestSeqExact,
    "thread worker recheck must use the exact frontier S captured at admission",
  );

  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ channelId: f.parentChannelId, frontierSpace: "storage" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ threadChannelId: f.threadId, frontierSpace: "storage" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await legacyDoneFallbackCount("channel"), channelFallbackBefore + 2);
  assert.equal(await legacyDoneFallbackCount("thread"), threadFallbackBefore + 2);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: f.parentChannelId,
      throughActivitySeq: channelTarget.latestSeqExact,
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(
    await legacyDoneFallbackCount("channel"),
    channelFallbackBefore + 2,
    "an explicit frontier must never increment the legacy fallback counter",
  );
});


test("Done routes reject malformed, empty, beyond-latest, and pre-retired high frontiers before every write", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const requestHeaders = headers(f.ownerToken, f.serverId);
  const invalidSpecs = [
    {
      path: "/api/channels/inbox/done",
      baseBody: { channelId: f.parentChannelId, frontierSpace: "storage" },
    },
    {
      path: "/api/channels/threads/done",
      baseBody: { threadChannelId: f.threadId, frontierSpace: "storage" },
    },
  ];
  for (const spec of invalidSpecs) {
    for (const invalid of [null, 1, "0", "01"]) {
      const body = { ...spec.baseBody, throughActivitySeq: invalid };
      const response = await fetch(`${app.baseUrl}${spec.path}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `${spec.path} invalid=${String(invalid)}`);
      assert.equal(
        ((await response.json()) as { code?: string }).code,
        "DONE_FRONTIER_REQUIRED",
      );
    }
  }

  const unsupportedThreadSpace = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: f.threadId,
      throughActivitySeq: "1",
      frontierSpace: "display",
    }),
  });
  assert.equal(unsupportedThreadSpace.status, 400);
  assert.equal(
    ((await unsupportedThreadSpace.json()) as { code?: string }).code,
    "DONE_FRONTIER_UNMAPPABLE",
  );

  const empty = await createChannel(f.serverId, "done-empty-target");
  await addHuman(empty.id, f.ownerId);
  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: empty.id,
      throughActivitySeq: "1",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_BEYOND_LATEST");

  const current = await resolveChannelSuppressionTarget(f.parentChannelId);
  assert.ok(current?.latestSeqExact);
  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: f.parentChannelId,
      throughActivitySeq: (BigInt(current.latestSeqExact) + 1n).toString(),
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_BEYOND_LATEST");

  const high = await createChannel(f.serverId, "done-int4-cap-target");
  await addHuman(high.id, f.ownerId);
  await getDb().insert(messages).values({
    channelId: high.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "first actual value above int4 authority",
    seq: 2_147_483_648,
  });
  const highFallbackBefore = await legacyDoneFallbackCount("channel");
  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ channelId: high.id, frontierSpace: "storage" }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_ABOVE_INT4_AUTHORITY",
    "the cap tooth uses an actual latest >= S, so it cannot pass via beyond-latest",
  );
  assert.equal(
    await legacyDoneFallbackCount("channel"),
    highFallbackBefore + 1,
    "an omitted frontier increments at admission even when the strict cap later rejects it",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: high.id,
      throughActivitySeq: "2147483648",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_ABOVE_INT4_AUTHORITY",
  );
  assert.equal(
    await legacyDoneFallbackCount("channel"),
    highFallbackBefore + 1,
    "an explicit frontier must not increment the legacy fallback counter even when rejected",
  );

  const rejectedScopeIds = [f.parentChannelId, f.threadId, empty.id, high.id];
  const [mutations, cursors, inboxStates, suppressions, follows] = await Promise.all([
    getDb().select().from(readMutations).where(inArray(readMutations.scopeId, rejectedScopeIds)),
    getDb().select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, f.ownerId),
      inArray(userChannelReadCursors.channelId, rejectedScopeIds),
    )),
    getDb().select().from(userChannelInboxStates).where(and(
      eq(userChannelInboxStates.userId, f.ownerId),
      inArray(userChannelInboxStates.channelId, rejectedScopeIds),
    )),
    getDb().select().from(inboxSuppressionStates).where(and(
      eq(inboxSuppressionStates.receiverId, f.ownerId),
      inArray(inboxSuppressionStates.targetChannelId, rejectedScopeIds),
    )),
    getDb().select().from(threadFollows).where(and(
      eq(threadFollows.threadChannelId, f.threadId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, f.ownerId),
    )),
  ]);
  assert.equal(mutations.length, 0, "rejected Done commands admit no mutation");
  assert.equal(cursors.length, 0, "rejected Done commands advance no cursor");
  assert.equal(inboxStates.length, 0, "rejected channel Done commands write no marker");
  assert.equal(suppressions.length, 0, "rejected Done commands write no suppression");
  assert.equal(follows.length, 1);
  assert.equal(follows[0]!.doneAt, null, "rejected thread Done leaves its follow active");
});


test("POST /channels/:id/read-all delegates to a kinded agent receiver without touching human state", async ({ app }) => {
  const db = getDb();
  const events = installFakeIo(app.app);
  const owner = await seedUser("agent-read-owner@slock.test", "agent-read-owner");
  const member = await seedUser("agent-read-member@slock.test", "agent-read-member");
  const sender = await seedUser("agent-read-sender@slock.test", "agent-read-sender");
  const server = await createServer("Agent Read Receiver", "agent-read-receiver", owner.id);
  await addMember(server.id, member.id);
  await addMember(server.id, sender.id);
  const agent = await createAgent(server.id, "agent-read-target", {
    runtime: "codex",
    creatorType: "user",
    creatorId: owner.id,
  });
  const privateChannel = await createChannel(server.id, "agent-read-private", undefined, "private");
  await addAgent(privateChannel.id, agent.id);
  const message = await createMessage(privateChannel.id, "user", sender.id, "delegated read");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  const delegated = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/read-all`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ receiver: { kind: "agent", id: agent.id } }),
  });
  assert.equal(delegated.status, 200);
  assert.deepEqual(await delegated.json(), {
    ok: true,
    seq: message.seq,
    readStateVersion: 1,
  });
  assert.equal(
    (await db.select().from(userChannelReadCursors).where(eq(
      userChannelReadCursors.channelId,
      privateChannel.id,
    ))).length,
    0,
    "human caller frontier must remain untouched",
  );
  const [agentCursor] = await db.select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agent.id),
    eq(agentChannelReadCursors.channelId, privateChannel.id),
  ));
  assert.equal(agentCursor?.lastReadSeq, message.seq);
  assert.equal(agentCursor?.readStateVersion, 1);
  assert.ok(events.some((event) => (
    event.room === `channel:${privateChannel.id}`
    && event.event === "scope_read:updated"
    && (event.payload as { peerKind?: string }).peerKind === "agent"
    && (event.payload as { peerId?: string }).peerId === agent.id
  )));

  const beforeDeniedCursor = { ...agentCursor };
  const denied = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/read-all`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ receiver: { kind: "agent", id: agent.id } }),
  });
  assert.equal(denied.status, 403);
  const [afterDeniedCursor] = await db.select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agent.id),
    eq(agentChannelReadCursors.channelId, privateChannel.id),
  ));
  assert.deepEqual(afterDeniedCursor, beforeDeniedCursor, "unauthorized delegation must be a zero-write");

  const mismatchedHuman = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/read-all`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ receiver: { kind: "human", id: member.id } }),
  });
  assert.equal(mismatchedHuman.status, 403);
  assert.equal(
    (await db.select().from(userChannelReadCursors).where(eq(
      userChannelReadCursors.channelId,
      privateChannel.id,
    ))).length,
    0,
    "mismatched human receiver must not fall back to caller or target",
  );
});


test("read-state mutations emit versioned user-room events", async ({ app }) => {
  const previousInfo = console.info;
  const infoLogs: unknown[][] = [];
  console.info = (...args: unknown[]) => {
    infoLogs.push(args);
  };
  try {
    const events = installFakeIo(app.app);
    const owner = await seedUser("read-state-owner@slock.test", "read-state-owner");
    const member = await seedUser("read-state-member@slock.test", "read-state-member");
    const server = await createServer("Read State Events", "read-state-events", owner.id);
    await addMember(server.id, member.id);
    const channel = await createChannel(server.id, "read-state-target");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
    const memberToken = await tokenForHuman(member.email);

    const first = await createMessage(channel.id, "user", owner.id, "first read-state message");
    const second = await createMessage(channel.id, "user", owner.id, "second read-state message");

    const readRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ seq: first.seq }),
    });
    assert.equal(readRes.status, 200);
    assert.deepEqual(await readRes.json(), {
      ok: true,
      maxReadSeq: first.seq,
      readStateVersion: 1,
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "read_state:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        maxReadSeq: first.seq,
        readStateVersion: 1,
        unreadCount: 1,
      },
    });
    assert.ok(
      infoLogs.some((entry) => {
        const payload = entry[1] as Record<string, unknown> | undefined;
        return entry[0] === "[ReceiverStatePush] read_state_emit"
          && payload?.outcome === "emitted"
          && payload?.event === "read_state:updated"
          && payload?.changed === true
          && payload?.enabled === true
          && payload?.io_present === true
          && payload?.serverId === server.id
          && payload?.room === `user:${member.id}`
          && payload?.scopeId === channel.id
          && payload?.maxReadSeq === first.seq
          && payload?.readStateVersion === 1
          && typeof payload?.host === "string"
          && payload.host !== "";
      }),
      "read-state emit path should produce a low-sensitive diagnostic trace",
    );

    const readAllRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read-all`, {
      method: "POST",
      headers: headers(memberToken, server.id),
    });
    assert.equal(readAllRes.status, 200);
    assert.deepEqual(await readAllRes.json(), {
      ok: true,
      seq: second.seq,
      readStateVersion: 2,
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "read_state:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        maxReadSeq: second.seq,
        readStateVersion: 2,
        unreadCount: 0,
      },
    });
    const afterReadAllEventCount = events.length;
    const repeatedReadRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ seq: first.seq }),
    });
    assert.equal(repeatedReadRes.status, 200);
    assert.deepEqual(await repeatedReadRes.json(), {
      ok: true,
      maxReadSeq: second.seq,
      readStateVersion: 2,
    });
    assert.equal(events.length, afterReadAllEventCount, "read-state no-op must not emit");
    assert.ok(
      infoLogs.some((entry) => {
        const payload = entry[1] as Record<string, unknown> | undefined;
        return entry[0] === "[ReceiverStatePush] read_state_emit"
          && payload?.outcome === "no_change"
          && payload?.changed === false
          && payload?.enabled === true
          && payload?.io_present === true
          && payload?.serverId === server.id
          && payload?.room === `user:${member.id}`
          && payload?.scopeId === channel.id
          && payload?.maxReadSeq === second.seq
          && payload?.readStateVersion === 2;
      }),
      "read-state no-op should be visible in the diagnostic trace",
    );

    const unreadRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/unread`, {
      method: "POST",
      headers: headers(memberToken, server.id),
    });
    assert.equal(unreadRes.status, 200);
    assert.deepEqual(await unreadRes.json(), {
      ok: true,
      unreadCount: 1,
      maxReadSeq: second.seq - 1,
      readStateVersion: 3,
      markedUnread: false,
      outcome: "counted",
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "read_state:updated",
      payload: {
        serverId: server.id,
        scopeId: channel.id,
        maxReadSeq: second.seq - 1,
        readStateVersion: 3,
        unreadCount: 1,
      },
    });
    const afterUnreadEventCount = events.length;
    const repeatedUnreadRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/unread`, {
      method: "POST",
      headers: headers(memberToken, server.id),
    });
    assert.equal(repeatedUnreadRes.status, 200);
    assert.deepEqual(await repeatedUnreadRes.json(), {
      ok: true,
      unreadCount: 1,
      maxReadSeq: second.seq - 1,
      readStateVersion: 3,
      markedUnread: false,
      outcome: "counted",
    });
    assert.equal(events.length, afterUnreadEventCount, "unread no-op must not emit");
  } finally {
    console.info = previousInfo;
  }
});


test("receiver-state push kill-switch suppresses emits but leaves read-state facts visible", async ({ app }) => {
  const previousFlag = process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = "false";
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const events = installFakeIo(app.app);
    const owner = await seedUser("receiver-state-flag-owner@slock.test", "receiver-state-flag-owner");
    const member = await seedUser("receiver-state-flag-member@slock.test", "receiver-state-flag-member");
    const server = await createServer("Receiver State Flag", "receiver-state-flag", owner.id);
    await addMember(server.id, member.id);
    const channel = await createChannel(server.id, "receiver-state-flag-target");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
    const memberToken = await tokenForHuman(member.email);
    const message = await createMessage(channel.id, "user", owner.id, "flag-off read-state message");

    const readRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ seq: message.seq }),
    });
    assert.equal(readRes.status, 200);
    assert.deepEqual(await readRes.json(), {
      ok: true,
      maxReadSeq: message.seq,
      readStateVersion: 1,
    });
    assert.deepEqual(events, [], "receiver-state push kill-switch should suppress socket emits");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], "[ReceiverStatePush] socket_emit_suppressed");
    const warning = warnings[0]?.[1] as Record<string, unknown>;
    assert.equal(warning.reason, "disabled");
    assert.equal(warning.event, "read_state:updated");
    assert.equal(warning.serverId, server.id);
    assert.equal(warning.room, `user:${member.id}`);
    assert.equal(warning.scopeId, channel.id);
    assert.equal(warning.maxReadSeq, message.seq);
    assert.equal(warning.readStateVersion, 1);
    assert.equal(warning.changed, true);
    assert.equal(warning.enabled, false);
    assert.equal(warning.io_present, true);
    assert.equal(typeof warning.host, "string");
    assert.notEqual(warning.host, "");

    const detailRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json() as { maxReadSeq?: number; readStateVersion?: number };
    assert.equal(detailBody.maxReadSeq, message.seq);
    assert.equal(detailBody.readStateVersion, 1);
  } finally {
    if (previousFlag === undefined) delete process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
    else process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = previousFlag;
    console.warn = previousWarn;
  }
});


test("receiver-state push logs missing io mount without rolling back read-state facts", async ({ app }) => {
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    app.app.set("io", undefined);
    const owner = await seedUser("receiver-state-missing-io-owner@slock.test", "receiver-state-missing-io-owner");
    const member = await seedUser("receiver-state-missing-io-member@slock.test", "receiver-state-missing-io-member");
    const server = await createServer("Receiver State Missing IO", "receiver-state-missing-io", owner.id);
    await addMember(server.id, member.id);
    const channel = await createChannel(server.id, "receiver-state-missing-io-target");
    await addHuman(channel.id, owner.id);
    await addHuman(channel.id, member.id);
    const memberToken = await tokenForHuman(member.email);
    const message = await createMessage(channel.id, "user", owner.id, "missing-io read-state message");

    const readRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ seq: message.seq }),
    });
    assert.equal(readRes.status, 200);
    assert.deepEqual(await readRes.json(), {
      ok: true,
      maxReadSeq: message.seq,
      readStateVersion: 1,
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], "[ReceiverStatePush] socket_emit_suppressed");
    const warning = warnings[0]?.[1] as Record<string, unknown>;
    assert.equal(warning.reason, "missing_io");
    assert.equal(warning.event, "read_state:updated");
    assert.equal(warning.serverId, server.id);
    assert.equal(warning.room, `user:${member.id}`);
    assert.equal(warning.scopeId, channel.id);
    assert.equal(warning.maxReadSeq, message.seq);
    assert.equal(warning.readStateVersion, 1);
    assert.equal(warning.changed, true);
    assert.equal(warning.enabled, true);
    assert.equal(warning.io_present, false);
    assert.equal(typeof warning.host, "string");
    assert.notEqual(warning.host, "");

    const detailRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json() as { maxReadSeq?: number; readStateVersion?: number };
    assert.equal(detailBody.maxReadSeq, message.seq);
    assert.equal(detailBody.readStateVersion, 1);
  } finally {
    console.warn = previousWarn;
  }
});

// Provenance: task #67 (@cindyz, #wg-rbac). An admin AGENT ran
// `raft channel update --target "#all" --private`, the write succeeded, and every
// later agent call -- including the attempt to undo it -- returned "Channel not
// found", because #all's audience is derived rather than stored: hiding it drops
// everyone at once, the actor included.
//
// @cindyz's ruling (msg=c1a72093): membership is required to change visibility,
// #all is never reachable that way, and only humans manage #all, from channel
// settings or server settings.
test("#all visibility is refused on the generic field, for humans and agents alike", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("all-guard-owner@slock.test", "all-guard-owner");
  const server = await createServer("All Guard", "all-guard", owner.id);
  await revealAllChannelForTest(server.id);
  const ownerToken = await tokenForHuman(owner.email);

  const [allChannel] = await db.select().from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));

  // The owner holds changeChannelVisibility and is refused anyway: this is a
  // property of the channel, not of the actor's authority.
  const humanAttempt = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(humanAttempt.status, 403, await humanAttempt.clone().text());
  const humanBody = await humanAttempt.json() as { error: string; code?: string };
  assert.equal(humanBody.code, "all_channel_visibility_managed_separately");
  // AX guidance, not a bare refusal (@cindyz msg=66de07f5): an agent told only
  // "forbidden" retries or reports the product as broken.
  assert.match(humanBody.error, /Only a human can do it, from channel settings or server settings/);

  const agent = await createAgent(server.id, "all-guard-agent", { runtime: "codex" });
  await db.update(serverAgentMembers).set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
  const cred = await mintAgentCredential({
    agentId: agent.id, scopes: ["send", "read", "channels", "server"],
    name: "all-guard", issuedVia: "computer", createdByUserId: null,
  });
  const agentAttempt = await fetch(`${app.baseUrl}/internal/agent-api/channels/${allChannel.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.apiKey}` },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(agentAttempt.status, 403, await agentAttempt.clone().text());
  const agentBody = await agentAttempt.json() as { error: string; code?: string };
  assert.equal(agentBody.code, "all_channel_visibility_managed_separately");

  // Suggested in independent review of PR #7468. "Only a human can hide #all"
  // currently holds because channelRouter is not mounted anywhere an agent can
  // reach -- a STRUCTURAL property, guaranteed by route mounting rather than by
  // a test. Nothing would redden if someone later mounted it on an
  // agent-reachable path. This pins the property itself, cheaply, with an
  // agent credential that is deliberately server-admin and holds every scope.
  //
  // LABEL, so nobody misreads it later (@Huarong): this is a STRUCTURAL CANARY,
  // not a behavioural test. It passes today with 404 because the route does not
  // exist on the agent surface at all -- its negative arm cannot fire under the
  // current structure. It proves "this path is not reachable today", NOT "an
  // agent tried and an authorization check refused it". Do not cite it as
  // evidence that an authorization check exists.
  const agentHide = await fetch(`${app.baseUrl}/internal/agent-api/channels/system/all/hide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.apiKey}` },
  });
  assert.ok(
    agentHide.status === 401 || agentHide.status === 403 || agentHide.status === 404,
    `an agent must not reach the human-only hide endpoint; got ${agentHide.status}`,
  );
  const [afterAgentHide] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, allChannel.id));
  assert.equal(afterAgentHide.type, "channel", "#all must be untouched by the agent hide attempt");
  assert.match(agentBody.error, /Only a human can do it, from channel settings or server settings/);

  const [after] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, allChannel.id));
  assert.equal(after.type, "channel", "#all must be untouched by either refusal");

  // The human surface still works, and hide/restore is a round trip.
  const hidden = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
    method: "POST", headers: headers(ownerToken, server.id),
  });
  assert.equal(hidden.status, 200, await hidden.clone().text());
  const [afterHide] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, allChannel.id));
  assert.equal(afterHide.type, "private");

  const restored = await fetch(`${app.baseUrl}/api/channels/system/all/restore`, {
    method: "POST", headers: headers(ownerToken, server.id),
  });
  assert.equal(restored.status, 200, await restored.clone().text());
  const [afterRestore] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, allChannel.id));
  assert.equal(afterRestore.type, "channel", "hide must be reversible from the human surface");
});

// The other half of the report: an actor that is NOT a member of an ordinary
// public channel could turn it private and then be refused by the rule it had
// just created, because a public channel needs no membership row to be reached.
// Requiring membership up front is what makes that door two-way.
test("changing channel visibility requires membership, for humans and agents alike", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("vis-member-owner@slock.test", "vis-member-owner");
  const insider = await seedUser("vis-member-insider@slock.test", "vis-member-insider");
  const server = await createServer("Vis Member", "vis-member", owner.id);
  await addMember(server.id, insider.id);
  const ownerToken = await tokenForHuman(owner.email);

  // Created by the insider, so the owner is deliberately not a member.
  const target = await createChannel(server.id, "not-mine", undefined, "channel", {
    type: "user", id: insider.id,
  });
  const rows = await db.select({ userId: channelHumans.userId }).from(channelHumans)
    .where(eq(channelHumans.channelId, target.id));
  assert.deepEqual(rows.map((r) => r.userId), [insider.id], "the owner must not be a member for this test to mean anything");

  const humanAttempt = await fetch(`${app.baseUrl}/api/channels/${target.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(humanAttempt.status, 403, await humanAttempt.clone().text());
  assert.equal((await humanAttempt.json() as { code?: string }).code, "channel_membership_required");

  const agent = await createAgent(server.id, "vis-member-agent", { runtime: "codex" });
  await db.update(serverAgentMembers).set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
  const cred = await mintAgentCredential({
    agentId: agent.id, scopes: ["send", "read", "channels", "server"],
    name: "vis-member", issuedVia: "computer", createdByUserId: null,
  });
  const agentAttempt = await fetch(`${app.baseUrl}/internal/agent-api/channels/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.apiKey}` },
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(agentAttempt.status, 403, await agentAttempt.clone().text());
  assert.equal((await agentAttempt.json() as { code?: string }).code, "channel_membership_required");

  const [after] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, target.id));
  assert.equal(after.type, "channel", "neither refusal may have changed the channel");

  // Membership is an ADDITIONAL requirement, not a replacement: the capability
  // still comes from the server role (owner/admin), so the insider -- an
  // ordinary member who IS in the channel -- is still refused.
  const insiderToken = await tokenForHuman(insider.email);
  const insiderAttempt = await fetch(`${app.baseUrl}/api/channels/${target.id}`, {
    method: "PATCH",
    headers: headers(insiderToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(insiderAttempt.status, 403, "channel membership alone must not confer changeChannelVisibility");

  // The owner joins, and can now round-trip it. This is the point of requiring
  // membership rather than dropping the access check: the actor holds a row,
  // ordinary channels preserve rows across the transition, so the door is
  // two-way for whoever went through it.
  await addHuman(target.id, owner.id);
  for (const visibility of ["private", "public"] as const) {
    const res = await fetch(`${app.baseUrl}/api/channels/${target.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ visibility }),
    });
    assert.equal(res.status, 200, `member-owner must be able to set ${visibility}: ${await res.clone().text()}`);
  }
  const [roundTripped] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, target.id));
  assert.equal(roundTripped.type, "channel", "a member's visibility change must be reversible by that member");
});

test("POST /api/channels/:id/resume-all-agents reports an agent whose start was skipped instead of counting it resumed", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const started = await createAgent(server.id, `resume-ok-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const starting = await createAgent(server.id, `resume-busy-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  await addAgent(channel.id, started.id);
  await addAgent(channel.id, starting.id);
  const orchestrator = app.app.get("agentOrchestrator") as {
    startAgent: (agentId: string, options: { resumePrompt?: string }) => Promise<unknown>;
  };
  const prompts: Array<[string, string | undefined]> = [];
  orchestrator.startAgent = async (agentId, options) => {
    prompts.push([agentId, options.resumePrompt]);
    return agentId === starting.id
      ? { outcome: "skipped", reason: "wake_lock_held" }
      : { outcome: "dispatched" };
  };

  const res = await http.as(owner, server).request(`/api/channels/${channel.id}/resume-all-agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "new guidance" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; started: number; total: number; results: Array<{ agentId: string; ok: boolean; reason?: string }> };
  assert.equal(body.ok, false, "a skipped start means the prompt did not reach that agent");
  assert.equal(body.started, 1);
  assert.equal(body.total, 2);
  assert.deepEqual(
    body.results.find((result) => result.agentId === starting.id),
    { agentId: starting.id, ok: false, reason: "start_in_flight" },
  );
  assert.equal(body.results.find((result) => result.agentId === started.id)?.ok, true);
  assert.equal(prompts.length, 2);

  // The retry names only the agent that missed the guidance (plus an id from
  // outside this channel, which is ignored): the resumed one is not started again.
  prompts.length = 0;
  const retry = await http.as(owner, server).request(`/api/channels/${channel.id}/resume-all-agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "new guidance", agentIds: [starting.id, randomUUID()] }),
  });
  assert.equal(retry.status, 200);
  const retryBody = await retry.json() as { total: number };
  assert.deepEqual(prompts, [[starting.id, "new guidance"]]);
  assert.equal(retryBody.total, 1);

  const invalid = await http.as(owner, server).request(`/api/channels/${channel.id}/resume-all-agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "new guidance", agentIds: "everyone" }),
  });
  assert.equal(invalid.status, 400);
});
