import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  BasicTracer,
  MemoryTraceSink
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import {
  servers as serversTable,
  serverMembers,
  channels,
  channelHumans, messages,
  messageReactions,
  messageMentions,
  attachments,
  threadFollows, userChannelReadCursors, inboxServingRows, inboxNotificationFacts,
  inboxSuppressionStates, jointChannels,
  jointChannelServers,
  jointChannelInvites
} from "../db/schema.js";
import { addMember } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET, createChannel, getOrCreateThread, addHuman, addAgent, removeHuman, isChannelHuman, resolveChannelAccess, getChannel, markRead, listJointActivityProjectionChannelIdsForAgent, recordThreadFollow } from "../services/channelService.js";
import {
  createMessage
} from "../services/messageService.js";
import {
  rebuildInboxServingRowsForReceiverTargets
} from "../services/inboxNotificationService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createServer, installFakeIo, enableThreadAgentFollowerManagementForServer, recordTestInboxFact, seedThreadFixture, headers, seedUser, fetchInboxAll } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });


test("GET /api/channels/:id/threads scopes joint summaries before local projection", async ({ app }) => {
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

  const hostOwner = await seedUser("joint-summary-scope-host@slock.test", "joint-summary-scope-host");
  const targetOwner = await seedUser("joint-summary-scope-target@slock.test", "joint-summary-scope-target");
  const hostServer = await createServer("Joint Summary Scope Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Summary Scope Target", "joint-summary-scope-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "joint-summary-scope-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const parentOneRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint scoped parent one" }),
  });
  assert.equal(parentOneRes.status, 200);
  const parentOne = await parentOneRes.json() as { id: string };
  const threadOneRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parentOne.id, content: "joint scoped reply one" }),
    // Executor drift used to deadlock PGlite's single connection until
    // Undici's five-minute headers timeout. Keep this regression fail-fast.
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(threadOneRes.status, 200);
  const threadOne = await threadOneRes.json() as { threadChannelId: string };

  const parentTwoRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint scoped parent two" }),
  });
  assert.equal(parentTwoRes.status, 200);
  const parentTwo = await parentTwoRes.json() as { id: string };
  const threadTwoRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parentTwo.id, content: "joint scoped reply two" }),
  });
  assert.equal(threadTwoRes.status, 200);

  sink.clear();
  const scopedRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads?parentMessageIds=${parentOne.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(scopedRes.status, 200);
  const scopedBody = await scopedRes.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.deepEqual(Object.keys(scopedBody), [parentOne.id]);
  assert.equal(scopedBody[parentOne.id]?.replyCount, 1);
  assert.notEqual(
    scopedBody[parentOne.id]?.threadChannelId,
    threadOne.threadChannelId,
    "peer summaries should still expose the peer local thread projection id",
  );
  assert.equal(scopedBody[parentTwo.id], undefined);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/:id/threads",
  );
  assert.ok(span, "expected GET /api/channels/:id/threads root span");
  const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_source, "client");
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.input_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.input_count, 1);
});


test("ordinary add-member API lands a joint add on the addressed projection with one canonical notice", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("joint-human-add-owner@slock.test", "joint-human-add-owner");
  const member = await seedUser("joint-human-add-member@slock.test", "joint-human-add-member");
  const peerOwner = await seedUser("joint-human-add-peer@slock.test", "joint-human-add-peer");
  const server = await createServer("Joint Human Add Host", "joint-human-add-host", owner.id);
  const peerServer = await createServer("Joint Human Add Peer", "joint-human-add-peer", peerOwner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const canonical = await createChannel(server.id, "joint-human-add-storage");
  const hostProjection = await createChannel(server.id, "joint-human-add-host", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "joint-human-add-peer", undefined, "joint");
  await addHuman(hostProjection.id, owner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint!.id,
      serverId: server.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: joint!.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);
  const ownerToken = await tokenForHuman(owner.email);

  const response = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/members`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: member.id }),
  });
  // task #1150: joint channels are addable again. Membership is local to the
  // addressed projection while the notice is stored canonically, so both
  // servers read the same event exactly once.
  assert.equal(response.status, 200, await response.text());
  assert.equal(await isChannelHuman(hostProjection.id, member.id), true);
  assert.equal(
    await isChannelHuman(peerProjection.id, member.id),
    false,
    "membership stays on the projection that was addressed",
  );

  const peerToken = await tokenForHuman(peerOwner.email);
  const peerRoster = await fetch(`${app.baseUrl}/api/channels/${peerProjection.id}/members`, {
    headers: headers(peerToken, peerServer.id),
  });
  assert.equal(peerRoster.status, 200);
  const peerRosterBody = await peerRoster.json() as { humans?: Array<{ id: string }> };
  assert.equal(
    (peerRosterBody.humans ?? []).some((human) => human.id === member.id),
    true,
    "the peer server must still see the person: rosters read the joint union",
  );

  const noticeContent = "@joint-human-add-member was added to this channel.";
  const canonicalSystemMessages = await db.select().from(messages).where(and(
    eq(messages.channelId, canonical.id),
    eq(messages.messageType, "system"),
    eq(messages.content, noticeContent),
  ));
  assert.equal(canonicalSystemMessages.length, 1, "the notice is stored once, canonically");
  for (const projectionId of [hostProjection.id, peerProjection.id]) {
    assert.equal(
      (await db.select({ id: messages.id }).from(messages).where(and(
        eq(messages.channelId, projectionId),
        eq(messages.messageType, "system"),
        eq(messages.content, noticeContent),
      ))).length,
      0,
      `the notice lives in canonical storage, not on projection ${projectionId}`,
    );
  }
});


test("inbox mention hot-path rewrite preserves rows and derived values across joint projection changes", async ({ app }) => {
  const db = getDb();
  const f = await seedThreadFixture(app.baseUrl);
  const serverB = await createServer("Mention Scope B", `mention-scope-b-${randomUUID()}`, f.ownerId);
  const serverC = await createServer("Mention Scope C", `mention-scope-c-${randomUUID()}`, f.ownerId);
  const channelA = await createChannel(f.serverId, `mention-scope-a-${randomUUID()}`, undefined, "joint");
  const channelB = await createChannel(serverB.id, `mention-scope-b-${randomUUID()}`, undefined, "joint");
  const channelC = await createChannel(serverC.id, `mention-scope-c-${randomUUID()}`, undefined, "joint");
  await addHuman(channelA.id, f.ownerId);

  const baseline = await createMessage(channelA.id, "user", f.memberBId, "A serving-row baseline");
  await recordTestInboxFact({
    serverId: f.serverId,
    receiverId: f.ownerId,
    kind: "channel",
    sourceChannelId: channelA.id,
    message: baseline,
  });

  const a1 = await createMessage(channelA.id, "user", f.ownerId, "A first mention");
  const b1 = await createMessage(channelB.id, "user", f.ownerId, "B first mention");
  const a2 = await createMessage(channelA.id, "user", f.ownerId, "A second mention");
  const c1 = await createMessage(channelC.id, "user", f.ownerId, "C mention");
  const b2 = await createMessage(channelB.id, "user", f.ownerId, "B second mention");
  const quiet = await createMessage(channelB.id, "user", f.ownerId, "B non-notifiable mention");
  const mentionValue = (
    message: typeof messages.$inferSelect,
    channelId: string,
    serverId: string,
  ): typeof messageMentions.$inferInsert => ({
    messageId: message.id,
    messageSeq: message.seq,
    serverId,
    channelId,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
  });
  await db.insert(messageMentions).values([
    mentionValue(a1, channelA.id, f.serverId),
    mentionValue(b1, channelB.id, serverB.id),
    mentionValue(a2, channelA.id, f.serverId),
    mentionValue(c1, channelC.id, serverC.id),
    mentionValue(b2, channelB.id, serverB.id),
  ]);
  await db.insert(messageMentions).values({
    messageId: quiet.id,
    messageSeq: quiet.seq,
    serverId: serverB.id,
    channelId: channelB.id,
    targetType: "user",
    targetId: f.ownerId,
    handleAtSendTime: "Owner",
    notifiableAtSend: false,
  });
  await db.insert(userChannelReadCursors).values([
    { userId: f.ownerId, channelId: channelA.id, lastReadSeq: b1.seq },
    { userId: f.ownerId, channelId: channelB.id, lastReadSeq: a1.seq },
    { userId: f.ownerId, channelId: channelC.id, lastReadSeq: a2.seq },
  ]);

  type MentionProjectionRow = {
    channel_id: string;
    latest_message_id: string | null;
    latest_message_seq: number | null;
    unread_mention_count: number;
    first_unread_message_id: string | null;
  };
  const oldProjection = async (): Promise<MentionProjectionRow[]> => {
    const result = await db.execute(sql`
      SELECT
        c.id AS channel_id,
        live_mention.message_id AS latest_message_id,
        live_mention.message_seq AS latest_message_seq,
        live_unread_mention.unread_mention_count,
        live_first_unread_mention.message_id AS first_unread_message_id
      FROM channels c
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${f.ownerId}
      LEFT JOIN LATERAL (
        SELECT mm.message_id, mm.message_seq
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${f.ownerId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = c.id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = c.id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
        ORDER BY mm.message_seq DESC
        LIMIT 1
      ) live_mention ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS unread_mention_count
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${f.ownerId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = c.id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = c.id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > COALESCE(rc.last_read_seq, 0)
      ) live_unread_mention ON true
      LEFT JOIN LATERAL (
        SELECT mm.message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${f.ownerId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND (
            mm.channel_id = c.id
            OR EXISTS (
              SELECT 1
              FROM joint_channel_servers base_projection
              INNER JOIN joint_channel_servers sibling_projection
                ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
               AND sibling_projection.status = 'active'
              WHERE base_projection.local_channel_id = c.id
                AND base_projection.status = 'active'
                AND sibling_projection.local_channel_id = mm.channel_id
            )
          )
          AND mm.message_seq > COALESCE(rc.last_read_seq, 0)
        ORDER BY mm.message_seq ASC
        LIMIT 1
      ) live_first_unread_mention ON true
      WHERE c.id IN (${channelA.id}::uuid, ${channelB.id}::uuid, ${channelC.id}::uuid)
      ORDER BY c.id
    `);
    return result.rows as MentionProjectionRow[];
  };
  const newProjection = async (): Promise<MentionProjectionRow[]> => {
    const result = await db.execute(sql`
      SELECT
        c.id AS channel_id,
        live_mentions.latest_message_id,
        live_mentions.latest_message_seq,
        live_mentions.unread_mention_count,
        live_mentions.first_unread_message_id
      FROM channels c
      LEFT JOIN user_channel_read_cursors rc
        ON rc.channel_id = c.id
       AND rc.user_id = ${f.ownerId}
      CROSS JOIN LATERAL (
        SELECT array_agg(DISTINCT scoped_channel.local_channel_id)::uuid[] AS channel_ids
        FROM (
          SELECT c.id AS local_channel_id
          UNION ALL
          SELECT sibling_projection.local_channel_id
          FROM joint_channel_servers base_projection
          INNER JOIN joint_channel_servers sibling_projection
            ON sibling_projection.joint_channel_id = base_projection.joint_channel_id
           AND sibling_projection.status = 'active'
          WHERE base_projection.local_channel_id = c.id
            AND base_projection.status = 'active'
        ) scoped_channel
      ) mention_scope
      LEFT JOIN LATERAL (
        SELECT
          (array_agg(mm.message_id ORDER BY mm.message_seq DESC, mm.message_id DESC))[1] AS latest_message_id,
          max(mm.message_seq) AS latest_message_seq,
          (count(*) FILTER (
            WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
          ))::int AS unread_mention_count,
          (array_agg(mm.message_id ORDER BY mm.message_seq ASC, mm.message_id ASC) FILTER (
            WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
          ))[1] AS first_unread_message_id
        FROM message_mentions mm
        WHERE mm.target_type = 'user'
          AND mm.target_id = ${f.ownerId}::uuid
          AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
          AND mm.channel_id = ANY(mention_scope.channel_ids)
      ) live_mentions ON true
      WHERE c.id IN (${channelA.id}::uuid, ${channelB.id}::uuid, ${channelC.id}::uuid)
      ORDER BY c.id
    `);
    return result.rows as MentionProjectionRow[];
  };
  const assertEquivalent = async (phase: string) => {
    const oldRows = await oldProjection();
    const newRows = await newProjection();
    assert.equal(oldRows.length, 3, `${phase}: old projection must retain every input channel`);
    assert.equal(newRows.length, 3, `${phase}: new projection must retain every input channel`);
    assert.deepEqual(newRows, oldRows, `${phase}: row set and all mention-derived values must match`);
  };
  const assertCurrentQueryFirstMention = async (expectedMessageId: string | null, phase: string) => {
    const items = await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId);
    const item = items.find((candidate) => candidate.kind === "channel" && candidate.channelId === channelA.id);
    assert.ok(item?.kind === "channel", `${phase}: current pg_serving query must retain the local joint row`);
    assert.equal(
      item.firstMentionMessageId,
      expectedMessageId,
      `${phase}: current receiver_rows -> mention_scope -> live_mentions query must honor active siblings and the local read cursor`,
    );
  };

  await assertEquivalent("local/no-mapping");
  await assertCurrentQueryFirstMention(a2.id, "local/no-mapping");

  const [jointAB] = await db.insert(jointChannels).values({
    canonicalChannelId: channelA.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: jointAB.id,
      serverId: f.serverId,
      localChannelId: channelA.id,
      role: "host",
      joinedByUserId: f.ownerId,
    },
    {
      jointChannelId: jointAB.id,
      serverId: serverB.id,
      localChannelId: channelB.id,
      role: "participant",
      joinedByUserId: f.ownerId,
    },
  ]);
  await assertEquivalent("joint-add-A-B");
  await markRead(f.ownerId, channelA.id, a2.seq);
  await assertCurrentQueryFirstMention(b2.id, "joint-add-A-B after local cursor advances");
  await db.delete(messageMentions).where(eq(messageMentions.channelId, channelA.id));
  await db.update(inboxServingRows)
    .set({ hasAnyMention: false })
    .where(and(
      eq(inboxServingRows.receiverId, f.ownerId),
      eq(inboxServingRows.sourceChannelId, channelA.id),
    ));
  await removeHuman(channelA.id, f.ownerId);
  await assertCurrentQueryFirstMention(
    b2.id,
    "joint-add-A-B mention-only sibling without local membership",
  );
  await addHuman(channelA.id, f.ownerId);

  await db.update(jointChannelServers)
    .set({ status: "disconnected", disconnectedAt: new Date() })
    .where(eq(jointChannelServers.localChannelId, channelB.id));
  await assertEquivalent("joint-remove-B");
  await assertCurrentQueryFirstMention(null, "joint-remove-B");

  const [jointAC] = await db.insert(jointChannels).values({
    canonicalChannelId: channelC.id,
    createdByServerId: serverC.id,
    createdByUserId: f.ownerId,
  }).returning();
  await db.update(jointChannelServers)
    .set({ jointChannelId: jointAC.id })
    .where(eq(jointChannelServers.localChannelId, channelA.id));
  await db.insert(jointChannelServers).values({
    jointChannelId: jointAC.id,
    serverId: serverC.id,
    localChannelId: channelC.id,
    role: "participant",
    joinedByUserId: f.ownerId,
  });
  await assertEquivalent("joint-switch-A-B-to-A-C");
  await assertCurrentQueryFirstMention(c1.id, "joint-switch-A-B-to-A-C");
});


test("inbox serving-row high-cardinality path scopes mention work to receiver joints and the current server", () => {
  const source = readFileSync(new URL("../services/channelService.ts", import.meta.url), "utf8");
  const receiverRowsStart = source.indexOf("receiver_scope_ids AS MATERIALIZED (");
  const baseRowsEnd = source.indexOf("visible_rows AS (", receiverRowsStart);
  const servingQueryEnd = source.indexOf("const allPagePrefixLimit", receiverRowsStart);
  assert.ok(receiverRowsStart >= 0 && baseRowsEnd > receiverRowsStart, "expected serving-row v3 scoped SQL");
  assert.ok(servingQueryEnd > baseRowsEnd, "expected serving-row v3 query end");
  const scopedSql = source.slice(receiverRowsStart, baseRowsEnd);
  const servingSql = source.slice(receiverRowsStart, servingQueryEnd);
  const fallbackFunctionSql = source.slice(
    source.indexOf("async function getInboxItemsFromServingRows("),
    source.indexOf("export interface ActivityUnreadTotalsBatchInput"),
  );

  assert.match(
    scopedSql,
    /receiver_scope_ids AS MATERIALIZED \([\s\S]*?FROM inbox_serving_rows source_row[\s\S]*?source_row\.receiver_id = \$\{userId\}::uuid[\s\S]*?source_row\.server_id = \$\{serverId\}::uuid/,
  );
  assert.match(scopedSql, /FROM receiver_scope_ids scope[\s\S]*?INNER JOIN inbox_serving_rows r[\s\S]*?r\.source_channel_id = scope\.source_channel_id/);
  assert.doesNotMatch(
    scopedSql,
    /sourceChannelIdArray|unnest\(|source_channel_id = ANY\(/,
    "the heavy main statement must materialize its receiver scope from PostgreSQL without an embedded UUID array",
  );
  assert.doesNotMatch(source, /buildServingRowsQuery\(sourceChannelIds\)/);
  assert.match(source, /const splitAllPageEnrichment = opts\.filter === "all";/);
  assert.match(
    fallbackFunctionSql,
    /const splitAllMetadata = splitAllPageEnrichment && opts\.channelId == null;/,
    "the unfaceted all route must split page selection from totals and group metadata",
  );
  assert.match(
    fallbackFunctionSql,
    /const buildAllPageServingKeysQuery[\s\S]*?WITH serving_prefix AS MATERIALIZED[\s\S]*?FROM inbox_serving_rows r[\s\S]*?r\.receiver_id = \$\{userId\}::uuid[\s\S]*?OR r\.has_any_mention[\s\S]*?ORDER BY r\.last_activity_at[\s\S]*?\$\{boundedKeyPrefixLimit\}[\s\S]*?serving_page_rows AS MATERIALIZED[\s\S]*?FROM serving_prefix prefix[\s\S]*?LEFT JOIN joint_channel_servers[\s\S]*?\$\{allPageKeyProjection\}/,
    "the serving producer must stop at an authority-filtered ordered receiver prefix before Joint/read-cursor hydration",
  );
  assert.match(
    source,
    /const buildAllPageMentionKeysQuery[\s\S]*?receiver_mention_source_ids AS MATERIALIZED[\s\S]*?FROM server_target_mentions mention[\s\S]*?FROM message_mentions sibling_mention[\s\S]*?receiver_projection\.local_channel_id[\s\S]*?receiver_mention_prefix AS MATERIALIZED[\s\S]*?ORDER BY r\.last_activity_at[\s\S]*?\$\{boundedKeyPrefixLimit\}[\s\S]*?receiver_mention_rows AS[\s\S]*?FROM receiver_mention_prefix prefix[\s\S]*?mention_channel_rows AS[\s\S]*?grouped_mention[\s\S]*?ORDER BY prefix_message\.created_at[\s\S]*?\$\{boundedKeyPrefixLimit\}[\s\S]*?mention_thread_rows AS[\s\S]*?grouped_mention[\s\S]*?ORDER BY prefix_message\.created_at[\s\S]*?\$\{boundedKeyPrefixLimit\}[\s\S]*?\$\{allPageKeyProjection\}/,
    "the mention producer must bound receiver, channel, and thread candidates before their projection hydration",
  );
  assert.match(
    source,
    /function mergeInboxAllPageKeyRows[\s\S]*?rowsByIdentity[\s\S]*?if \(!rowsByIdentity\.has\(identity\)\)[\s\S]*?activityTime\(left\._lastActivityAt\)[\s\S]*?\.slice\(offset, offset \+ limit \+ 1\)[\s\S]*?_pageOrdinal: pageOrdinal[\s\S]*?const mergeAllPageKeyRows[\s\S]*?mergeInboxAllPageKeyRows/,
    "the two ordered prefixes must dedupe with serving-row precedence, stable-sort, then page in service memory",
  );
  assert.match(
    source,
    /const buildAllPageHydrationQuery[\s\S]*?FROM jsonb_to_recordset\(\$\{JSON\.stringify\(pageInput\)\}::jsonb\)[\s\S]*?page_mention_scope AS MATERIALIZED[\s\S]*?INNER JOIN message_mentions server_mention[\s\S]*?server_mention\.channel_id = scope\.mention_channel_id[\s\S]*?FROM page_effective p/,
    "page row and exact-mention hydration must use only the selected page JSON recordset",
  );
  assert.match(
    source,
    /const servingPageResult = splitAllMetadata[\s\S]*?buildAllPageServingKeysQuery[\s\S]*?const mentionPageResult = splitAllMetadata[\s\S]*?buildAllPageMentionKeysQuery[\s\S]*?mergeAllPageKeyRows\([\s\S]*?servingPageResult\.rows,[\s\S]*?mentionPageResult\.rows[\s\S]*?buildServingRowsQuery\("metadata"\)[\s\S]*?buildAllPageHydrationQuery\(mainResult\.rows\)/,
    "serving keys, mention keys, metadata, and hydration must execute as separately capped statements before merging",
  );
  assert.match(
    source,
    /const pageEnrichmentJoins = splitAllPageEnrichment[\s\S]*?\? sql``[\s\S]*?: sql`[\s\S]*?LEFT JOIN messages latest_message/,
    "all must keep page enrichment joins out of the high-complexity main statement",
  );
  assert.match(
    source,
    /const mainResult =[\s\S]*?servingPageResult && mentionPageResult[\s\S]*?: await executor\.execute\(buildServingRowsQuery\(\)\);[\s\S]*?if \(!splitAllPageEnrichment\) return mainResult;[\s\S]*?buildAllPageEnrichmentQuery\(pageRows\)/,
    "all must execute page enrichment as a separately capped statement",
  );
  assert.match(source, /FROM jsonb_to_recordset\(\$\{JSON\.stringify\(pageInput\)\}::jsonb\)/);
  assert.match(scopedSql, /mention_scope AS MATERIALIZED \(/);
  assert.match(scopedSql, /server_target_mentions AS MATERIALIZED \(/);
  assert.match(scopedSql, /scoped_mentions AS MATERIALIZED \(/);
  assert.match(scopedSql, /\$\{mentionAggregationCtes\}/);
  assert.match(source, /const mentionAggregationCtes = isAllFilter/);
  assert.match(scopedSql, /FROM message_mentions server_mention[\s\S]*?server_mention\.server_id = \$\{serverId\}::uuid/);
  assert.match(scopedSql, /INNER JOIN message_mentions sibling_mention[\s\S]*?sibling_mention\.channel_id = scope\.mention_channel_id[\s\S]*?sibling_mention\.server_id <> \$\{serverId\}::uuid/);
  assert.match(source, /FROM scoped_mentions mention/);
  assert.doesNotMatch(scopedSql, /\n    target_mentions AS MATERIALIZED/);
  assert.doesNotMatch(scopedSql, /JOIN LATERAL/);
  assert.equal(
    scopedSql.match(/FROM message_mentions server_mention/g)?.length,
    1,
    "current-server mentions must be materialized once for member and fallback rows",
  );
  assert.equal(
    servingSql.match(/FROM server_target_mentions mm/g)?.length,
    2,
    "channel and thread mention-only fallbacks must reuse the single server-scoped target materialization",
  );
  assert.equal(servingSql.match(/WHERE mention_channel\.server_id = \$\{serverId\}/g)?.length, 1);
  assert.equal(servingSql.match(/WHERE thread_channel\.server_id = \$\{serverId\}/g)?.length, 1);
  assert.equal(
    servingSql.match(/server_mention\.server_id = \$\{serverId\}::uuid/g)?.length,
    1,
    "all current-server mention consumers must share one denormalized target/server index prefix",
  );
  const nonThreadFacetsStart = servingSql.indexOf("non_thread_facets AS (");
  const threadFacetsStart = servingSql.indexOf("\n    thread_facets AS (", nonThreadFacetsStart);
  const facetedStart = servingSql.indexOf("\n    faceted AS (", threadFacetsStart);
  assert.ok(
    nonThreadFacetsStart >= 0 && threadFacetsStart > nonThreadFacetsStart && facetedStart > threadFacetsStart,
    "expected separate non-thread and thread facet paths before their UNION ALL",
  );
  const nonThreadFacetsSql = servingSql.slice(nonThreadFacetsStart, threadFacetsStart);
  const threadFacetsSql = servingSql.slice(threadFacetsStart, facetedStart);
  assert.match(nonThreadFacetsSql, /WHERE filtered\.kind <> 'thread'/);
  assert.doesNotMatch(
    nonThreadFacetsSql,
    /JOIN (?:channels|messages|joint_channel_servers|joint_channels)/,
    "non-thread facet rows must not traverse the thread/Joint parent lookup chain",
  );
  assert.match(threadFacetsSql, /INNER JOIN channels thread_channel/);
  assert.match(threadFacetsSql, /WHERE filtered\.kind = 'thread'/);
  assert.match(servingSql.slice(facetedStart), /SELECT \* FROM non_thread_facets[\s\S]*?UNION ALL[\s\S]*?SELECT \* FROM thread_facets/);
  assert.doesNotMatch(
    fallbackFunctionSql,
    /const receiverScopeQuery = sql`/,
    "the fix must not add a full receiver pre-count ahead of the bounded key producers",
  );
  assert.match(
    fallbackFunctionSql,
    /receiver_scope_stats\.receiver_scope_row_count AS "__receiverScopeRowCount"[\s\S]*?const receiverScopeRowCountTraceAttrs[\s\S]*?unavailable_query_failed[\s\S]*?const metadataResult[\s\S]*?metadataRow\?\.__receiverScopeRowCount/,
    "receiver scope must be measured by the metadata statement and remain explicitly unavailable if an earlier statement fails",
  );
  assert.match(source, /page AS MATERIALIZED \([\s\S]*?LIMIT \$\{opts\.limit \+ 1\}[\s\S]*?page_enriched AS \(/);
});


test("POST /channels/inbox/done requires storage identity and fixes the incident-shaped joint split", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const [canonical, local] = await db.insert(channels).values([
    { serverId: f.serverId, name: "api-done-space-canonical", type: "joint" },
    { serverId: f.serverId, name: "api-done-space-local", type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: local.id, userId: f.ownerId });
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: f.serverId,
    localChannelId: local.id,
    role: "host",
    status: "active",
  });
  await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API canonical Done frontier",
    seq: 11_426_997,
  });
  const [localMessage] = await db.insert(messages).values({
    channelId: local.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API legacy display frontier",
    seq: 11_429_659,
  }).returning();
  await db.insert(inboxNotificationFacts).values({
    receiverType: "user",
    receiverId: f.ownerId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: local.id,
    messageId: localMessage.id,
    messageSeq: localMessage.seq,
    activityAt: localMessage.createdAt,
  });
  await rebuildInboxServingRowsForReceiverTargets([{
    receiverType: "user",
    receiverId: f.ownerId,
    sourceChannelId: local.id,
  }]);

  const activeItem = (await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId))
    .find((item) => item.kind === "channel" && item.channelId === local.id) as
    | { latestActivitySeq?: string; doneFrontierSeq?: string }
    | undefined;
  assert.equal(activeItem?.latestActivitySeq, "11429659");
  assert.equal(
    activeItem?.doneFrontierSeq,
    "11426997",
    "the active API must carry display and guard frontiers in their own spaces",
  );

  const requestHeaders = headers(f.ownerToken, f.serverId);
  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    // A pre-upgrade tab has no space identity. It must refresh rather than
    // send its display value through the storage guard.
    body: JSON.stringify({ channelId: local.id, throughActivitySeq: "11429659" }),
  });
  assert.equal(response.status, 412);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_SPACE_REQUIRED",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const [suppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetChannelId, local.id),
  ));
  assert.equal(String(suppression?.doneThroughSeq), "11426997");
  assert.equal(suppression?.sourceChannelId, canonical.id);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426998",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_BEYOND_LATEST");

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426997",
      frontierSpace: "display",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_UNMAPPABLE");
});


test("POST /channels/threads/done requires storage identity before the strict joint guard", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const [canonicalParent, localParent] = await db.insert(channels).values([
    { serverId: f.serverId, name: "api-thread-space-parent-canonical", type: "joint" },
    { serverId: f.serverId, name: "api-thread-space-parent-local", type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: localParent.id, userId: f.ownerId });
  const [parentJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: parentJoint.id,
    serverId: f.serverId,
    localChannelId: localParent.id,
    role: "host",
    status: "active",
  });
  const [parentMessage] = await db.insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API joint-thread parent",
    seq: 11_426_000,
  }).returning();
  const [canonicalThread, localThread] = await db.insert(channels).values([
    {
      serverId: f.serverId,
      name: "api-thread-space-canonical",
      type: "thread",
      parentMessageId: parentMessage.id,
    },
    { serverId: f.serverId, name: "api-thread-space-local", type: "thread" },
  ]).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: threadJoint.id,
    serverId: f.serverId,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await db.insert(threadFollows).values({
    threadChannelId: localThread.id,
    followerType: "user",
    followerId: f.ownerId,
    parentMessageId: parentMessage.id,
    reason: "authored",
  });
  await db.insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API canonical joint-thread frontier",
    seq: 11_426_997,
  });
  const [localReply] = await db.insert(messages).values({
    channelId: localThread.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API legacy joint-thread display frontier",
    seq: 11_429_659,
  }).returning();
  await db.insert(inboxNotificationFacts).values({
    receiverType: "user",
    receiverId: f.ownerId,
    serverId: f.serverId,
    kind: "thread",
    sourceChannelId: localThread.id,
    messageId: localReply.id,
    messageSeq: localReply.seq,
    activityAt: localReply.createdAt,
  });

  const requestHeaders = headers(f.ownerToken, f.serverId);
  let response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    // A pre-upgrade tab must refresh; the server does not guess whether this
    // local fact or a storage reply supplied the value.
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11429659",
    }),
  });
  assert.equal(response.status, 412);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_SPACE_REQUIRED",
  );

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const [suppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetChannelId, localThread.id),
  ));
  assert.equal(String(suppression?.doneThroughSeq), "11426997");
  assert.equal(suppression?.sourceChannelId, canonicalThread.id);

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11426998",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_BEYOND_LATEST",
    "a value above canonical storage must not weaken the strict guard",
  );
});


test("GET /channels/inbox includes top-level joint channel activity through local projection", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  const [storageNamespace] = await db.insert(serversTable).values({
    name: "Joint Storage Namespace",
    slug: "__joint_storage__",
    kind: "joint_storage",
    ownerId: f.ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const canonical = await createChannel(storageNamespace.id, "joint-storage-inbox-activity");
  const projection = await createChannel(f.serverId, "joint-inbox-activity", undefined, "joint");
  await addHuman(projection.id, f.ownerId);
  await addHuman(projection.id, f.memberBId);
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
  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      channelId: projection.id,
      content: "joint inbox mention @owner",
      mentions: [{ type: "user", id: f.ownerId, name: "owner" }],
    }),
  });
  assert.equal(sendRes.status, 200);
  const latest = await sendRes.json() as { id: string; seq: number; channelId: string };
  assert.equal(latest.channelId, projection.id, "message response should expose the local joint projection id");

  const inboxRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(inboxRes.status, 200);
  const inboxBody = await inboxRes.json() as {
    items: Array<{ kind: string; channelId?: string; channelType?: string; lastMessageId?: string; firstUnreadMessageId?: string | null; unreadCount?: number }>;
  };
  const jointItem = inboxBody.items.find((item) => item.kind === "channel" && item.channelId === projection.id);
  assert.ok(jointItem, "top-level joint channel messages should appear in Activity through the local projection");
  assert.equal(jointItem.channelType, "joint");
  assert.equal(jointItem.lastMessageId, latest.id);
  assert.equal(jointItem.firstUnreadMessageId, latest.id);
  assert.equal(jointItem.unreadCount, 1);

  const unreadUrl = new URL(`${app.baseUrl}/api/channels/inbox`);
  unreadUrl.searchParams.set("filter", "unread");
  const unreadRes = await fetch(unreadUrl, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(unreadRes.status, 200);
  const unreadBody = await unreadRes.json() as {
    items: Array<{ kind: string; channelId?: string; unreadCount?: number }>;
  };
  assert.ok(
    unreadBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.unreadCount === 1),
    "unread Activity filter should include top-level joint channel messages",
  );

  const mentionsUrl = new URL(`${app.baseUrl}/api/channels/inbox`);
  mentionsUrl.searchParams.set("filter", "mentions");
  const mentionsRes = await fetch(mentionsUrl, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(mentionsRes.status, 200);
  const mentionsBody = await mentionsRes.json() as {
    items: Array<{ kind: string; channelId?: string; hasMention?: boolean }>;
  };
  assert.ok(
    mentionsBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.hasMention),
    "mention Activity filter should include top-level joint channel mentions",
  );

  const readRes = await fetch(`${app.baseUrl}/api/channels/${projection.id}/read-all`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(readRes.status, 200);
  const readBody = await readRes.json() as { seq: number };
  assert.equal(readBody.seq, latest.seq, "mark-read for a joint projection should advance to canonical storage seq");

  const unreadSummaryAfterReadRes = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(unreadSummaryAfterReadRes.status, 200);
  const unreadSummaryAfterRead = await unreadSummaryAfterReadRes.json() as {
    channels: Record<string, { unreadCount: number; hasMention: boolean; hasAnyMention: boolean }>;
  };
  assert.equal(
    unreadSummaryAfterRead.channels[projection.id]?.unreadCount,
    0,
    "sidebar unread summary must compare participant joint reads in the canonical seq domain",
  );
  assert.equal(
    unreadSummaryAfterRead.channels[projection.id]?.hasMention,
    false,
    "sidebar @mention summary must not re-light a read joint local projection",
  );

  const afterReadRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(afterReadRes.status, 200);
  const afterReadBody = await afterReadRes.json() as {
    items: Array<{ kind: string; channelId?: string; firstUnreadMessageId?: string | null; unreadCount?: number }>;
  };
  const afterReadJointItem = afterReadBody.items.find((item) => item.kind === "channel" && item.channelId === projection.id);
  assert.ok(afterReadJointItem, "read top-level joint projection should stay visible in Activity");
  assert.equal(afterReadJointItem.firstUnreadMessageId, null);
  assert.equal(afterReadJointItem.unreadCount, 0);
});


test("joint channel resolver requires an active local projection in the caller server", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-host-owner@slock.test", "joint-host-owner");
  const guestOwner = await seedUser("joint-guest-owner@slock.test", "joint-guest-owner");
  const hostServer = await createServer("Joint Host", "joint-host", hostOwner.id);
  const guestServer = await createServer("Joint Guest", "joint-guest", guestOwner.id);

  const hostProjection = await createChannel(hostServer.id, "partner-room", undefined, "joint");
  const guestProjection = await createChannel(guestServer.id, "partner-room", undefined, "joint");
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

  const hostResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostResolved?.kind, "joint");
  assert.equal(hostResolved?.canonicalChannelId, hostProjection.id);
  assert.equal(hostResolved?.role, "host");

  const guestResolved = await resolveChannelAccess({ serverId: guestServer.id, channelId: guestProjection.id });
  assert.equal(guestResolved?.kind, "joint");
  assert.equal(guestResolved?.canonicalChannelId, hostProjection.id);
  assert.equal(guestResolved?.role, "participant");

  assert.equal(
    await resolveChannelAccess({ serverId: hostServer.id, channelId: guestProjection.id }),
    null,
    "a projection id from another server must not grant access",
  );

  await db.update(jointChannelServers)
    .set({ status: "disconnected" })
    .where(and(eq(jointChannelServers.jointChannelId, joint.id), eq(jointChannelServers.serverId, guestServer.id)));
  assert.equal(
    await resolveChannelAccess({ serverId: guestServer.id, channelId: guestProjection.id }),
    null,
    "a disconnected projection must not resolve",
  );
});


test("joint channels are listed and fetched only for explicit members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("joint-list-owner@slock.test", "joint-list-owner");
  const joined = await seedUser("joint-list-joined@slock.test", "joint-list-joined");
  const nonMember = await seedUser("joint-list-nonmember@slock.test", "joint-list-nonmember");
  const server = await createServer("Joint List", "joint-list", owner.id);
  await addMember(server.id, joined.id);
  await addMember(server.id, nonMember.id);
  const jointProjection = await createChannel(server.id, "shared-room", undefined, "joint");
  await addHuman(jointProjection.id, owner.id);
  await addHuman(jointProjection.id, joined.id);
  await createMessage(jointProjection.id, "user", owner.id, "joint secret");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointProjection.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: server.id,
    localChannelId: jointProjection.id,
    role: "host",
    joinedByUserId: owner.id,
  });

  const joinedToken = await tokenForHuman(joined.email);
  const nonMemberToken = await tokenForHuman(nonMember.email);

  const joinedList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(joinedToken, server.id),
  });
  assert.equal(joinedList.status, 200);
  const joinedBody = await joinedList.json() as Array<{ id: string; type: string; joined?: boolean }>;
  assert.ok(
    joinedBody.some((channel) => channel.id === jointProjection.id && channel.type === "joint" && channel.joined === true),
    "joined members should see the joint channel projection",
  );

  const nonMemberList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberList.status, 200);
  const nonMemberBody = await nonMemberList.json() as Array<{ id: string }>;
  assert.ok(!nonMemberBody.some((channel) => channel.id === jointProjection.id), "non-members should not see joint channels");

  const nonMemberUnread = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberUnread.status, 200);
  const nonMemberUnreadBody = await nonMemberUnread.json() as Record<string, number>;
  assert.equal(
    nonMemberUnreadBody[jointProjection.id],
    undefined,
    "non-members must not receive joint projection unread counts",
  );

  const joinedDetail = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}`, {
    headers: headers(joinedToken, server.id),
  });
  assert.equal(joinedDetail.status, 200);
  const detailBody = await joinedDetail.json() as { id: string; type: string; joined?: boolean };
  assert.equal(detailBody.id, jointProjection.id);
  assert.equal(detailBody.type, "joint");
  assert.equal(detailBody.joined, true);

  const nonMemberDetail = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberDetail.status, 404);

  const nonMemberRead = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}/read`, {
    method: "POST",
    headers: headers(nonMemberToken, server.id),
    body: JSON.stringify({ seq: 1 }),
  });
  assert.equal(nonMemberRead.status, 404, "non-members must not mark known joint channels read");

  const nonMemberReadAll = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}/read-all`, {
    method: "POST",
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberReadAll.status, 404, "non-members must not learn latest seq via joint read-all");

  const [nonMemberCursor] = await db
    .select()
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, nonMember.id),
      eq(userChannelReadCursors.channelId, jointProjection.id),
    ));
  assert.equal(nonMemberCursor, undefined, "non-member read attempts must not create read cursor side effects");
});


test("joint channel create uses directed person invites and target invitee accept creates a local projection", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-create-host@slock.test", "joint-create-host");
  const targetOwner = await seedUser("joint-create-target-owner@slock.test", "joint-create-target-owner");
  const targetAdmin = await seedUser("joint-create-target-admin@slock.test", "joint-create-target-admin");
  const targetSecondAdmin = await seedUser("joint-create-target-second-admin@slock.test", "joint-create-target-second-admin");
  const targetMember = await seedUser("joint-create-target-member@slock.test", "joint-create-target-member");
  const hostServer = await createServer("Joint Create Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Target", "joint-create-target", targetOwner.id);
  await addMember(targetServer.id, hostOwner.id);
  await addMember(targetServer.id, targetAdmin.id, "admin");
  await addMember(targetServer.id, targetSecondAdmin.id, "admin");
  await addMember(targetServer.id, targetMember.id);

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetOwnerToken = await tokenForHuman(targetOwner.email);
  const targetSecondAdminToken = await tokenForHuman(targetSecondAdmin.email);
  const targetMemberToken = await tokenForHuman(targetMember.email);

  const emailLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    emailLogs.push(args.map(String).join(" "));
  };
  let createRes: Response;
  try {
    createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "partner-room",
        description: "shared partner work",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email, `@${targetSecondAdmin.name}`],
      }),
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(createRes.status, 200);
  assert.ok(emailLogs.some((log) => log.includes(`To: ${targetOwner.email}`)), "directly invited target user should receive the joint-channel invite email");
  assert.ok(emailLogs.some((log) => log.includes(`To: ${targetSecondAdmin.email}`)), "second directly invited admin should receive the joint-channel invite email");
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${targetAdmin.email}`)), "uninvited target admins should not receive a person-scoped invite email");
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${targetMember.email}`)), "uninvited target members should not receive a person-scoped invite email");
  const hostProjection = await createRes.json() as {
    id: string;
    type: string;
    joined: boolean;
    jointPeerServerSlug?: string;
    jointPeerStatus?: string;
    jointServers?: Array<{ serverId: string; serverSlug: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
    jointPendingInvites?: Array<{ id: string; fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
    jointInvite?: { id: string; toServerId: string };
    jointInvites?: Array<{ id: string; toServerId: string; invitedUserId: string }>;
  };
  assert.equal(hostProjection.type, "joint");
  assert.equal(hostProjection.joined, true);
  assert.equal(hostProjection.jointPeerServerSlug, targetServer.slug);
  assert.equal(hostProjection.jointPeerStatus, "pending");
  assert.ok(hostProjection.jointServers?.some((server) => server.serverId === hostServer.id && server.status === "active" && server.isCurrentServer));
  assert.ok(hostProjection.jointServers?.some((server) => server.serverId === targetServer.id && server.status === "pending"));
  assert.deepEqual(hostProjection.jointPendingInvites?.map((invite) => invite.invitedUserId).sort(), [targetOwner.id, targetSecondAdmin.id].sort());
  assert.equal(hostProjection.jointInvite?.toServerId, targetServer.id);
  assert.deepEqual(hostProjection.jointInvites?.map((invite) => invite.invitedUserId), [targetOwner.id, targetSecondAdmin.id]);
  const secondInvite = hostProjection.jointInvites?.find((invite) => invite.invitedUserId === targetSecondAdmin.id);
  assert.ok(secondInvite, "second invited admin should get a separate pending invite");

  const [hostProjectionRow] = await db.select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, hostProjection.id));
  assert.ok(hostProjectionRow, "host projection should be registered separately from canonical storage");
  const [joint] = await db.select().from(jointChannels).where(eq(jointChannels.id, hostProjectionRow.jointChannelId));
  assert.ok(joint, "joint channel authority row should be created");
  assert.notEqual(joint.canonicalChannelId, hostProjection.id, "canonical storage must not be the host-side local projection");
  const [canonicalStorageChannel] = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
    .from(channels)
    .where(eq(channels.id, joint.canonicalChannelId));
  assert.equal(canonicalStorageChannel.type, "channel", "joint storage should reuse ordinary channel storage rows");
  assert.match(canonicalStorageChannel.name, /^joint-storage-/, "joint storage channel should stay storage-named");
  assert.notEqual(canonicalStorageChannel.serverId, hostServer.id, "canonical storage must not belong to the host product server");
  assert.notEqual(canonicalStorageChannel.serverId, targetServer.id, "canonical storage must not belong to the target product server");
  const [storageNamespace] = await db
    .select({ id: serversTable.id, slug: serversTable.slug, kind: serversTable.kind })
    .from(serversTable)
    .where(eq(serversTable.id, canonicalStorageChannel.serverId));
  assert.equal(storageNamespace.kind, "joint_storage", "canonical storage should live under the reserved joint storage namespace");
  assert.equal(storageNamespace.slug, "__joint_storage__");
  const hostResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostResolved?.kind, "joint");
  assert.equal(hostResolved?.canonicalChannelId, joint.canonicalChannelId);
  const canonicalResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: joint.canonicalChannelId });
  assert.equal(canonicalResolved, null, "canonical storage channel must not be directly routable");
  const canonicalFetch = await fetch(`${app.baseUrl}/api/channels/${joint.canonicalChannelId}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(canonicalFetch.status, 404, "canonical storage channel must not be fetchable as a local channel");
  await db.insert(serverMembers).values({ serverId: storageNamespace.id, userId: hostOwner.id }).onConflictDoNothing();
  const serverListRes = await fetch(`${app.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  assert.equal(serverListRes.status, 200);
  const serverListBody = await serverListRes.json() as Array<{ id: string; slug: string }>;
  assert.ok(
    !serverListBody.some((server) => server.id === storageNamespace.id || server.slug === "__joint_storage__"),
    "joint storage namespace must not appear in ordinary server lists even if a stale member row exists",
  );
  const [inviteRow] = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, hostProjection.jointInvite!.id));
  assert.equal(inviteRow.status, "pending");
  assert.equal(inviteRow.fromServerId, hostServer.id);
  assert.equal(inviteRow.toServerId, targetServer.id);
  assert.equal(inviteRow.invitedUserId, targetOwner.id);

  const resendEmailLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    resendEmailLogs.push(args.map(String).join(" "));
  };
  let resendRes: Response;
  try {
    resendRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invite/resend`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(resendRes.status, 200);
  assert.deepEqual(await resendRes.json(), { ok: true, resentCount: 2 });
  assert.ok(resendEmailLogs.some((log) => log.includes(`To: ${targetOwner.email}`)), "resend should email the first pending invitee");
  assert.ok(resendEmailLogs.some((log) => log.includes(`To: ${targetSecondAdmin.email}`)), "resend should email every pending directed invitee");

  const targetMemberInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberInvites.status, 200);
  const targetMemberInvitesBody = await targetMemberInvites.json() as { invites: unknown[] };
  assert.deepEqual(targetMemberInvitesBody.invites, [], "uninvited target members should not see someone else's joint-channel invite");

  const targetInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetInvites.status, 200);
  const targetInvitesBody = await targetInvites.json() as { invites: Array<{ id: string; fromServerSlug: string; channelName: string }> };
  assert.deepEqual(targetInvitesBody.invites.map((invite) => invite.id), [hostProjection.jointInvite!.id]);
  assert.equal(targetInvitesBody.invites[0].fromServerSlug, hostServer.slug);
  assert.equal(targetInvitesBody.invites[0].channelName, "partner-room");

  const targetAdminToken = await tokenForHuman(targetAdmin.email);
  const targetAdminInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetAdminToken, targetServer.id),
  });
  assert.equal(targetAdminInvites.status, 200);
  const targetAdminInvitesBody = await targetAdminInvites.json() as { invites: unknown[] };
  assert.deepEqual(targetAdminInvitesBody.invites, [], "target admins do not see directed invites unless they are explicitly invited");

  const malformedInviteAccept = await fetch(`${app.baseUrl}/api/channels/joint-invites/${"x".repeat(12000)}/accept`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(malformedInviteAccept.status, 404, "malformed joint-channel invite IDs should cloak without hitting UUID DB casts");

  const targetAdminAccept = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite!.id}/accept`, {
    method: "POST",
    headers: headers(targetAdminToken, targetServer.id),
  });
  assert.equal(targetAdminAccept.status, 404, "uninvited target admins cannot accept someone else's joint-channel invite");

  const events = installFakeIo(app.app);
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite!.id}/accept`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as {
    id: string;
    type: string;
    joined: boolean;
    name: string;
    description: string | null;
    jointPeerServerSlug?: string;
    jointPeerStatus?: string;
    jointServers?: Array<{ serverId: string; serverSlug: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
    jointPendingInvites?: Array<{ id: string; fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
  };
  assert.equal(targetProjection.type, "joint");
  assert.equal(targetProjection.name, "partner-room");
  assert.equal(targetProjection.description, "shared partner work");
  assert.equal(targetProjection.joined, true);
  assert.equal(targetProjection.jointPeerServerSlug, hostServer.slug);
  assert.equal(targetProjection.jointPeerStatus, "active");
  assert.ok(targetProjection.jointServers?.some((server) => server.serverId === hostServer.id && server.status === "active"));
  assert.ok(targetProjection.jointServers?.some((server) => server.serverId === targetServer.id && server.status === "active" && server.isCurrentServer));
  assert.ok(targetProjection.jointPendingInvites?.some((invite) => invite.toServerId === targetServer.id && invite.invitedUserId === targetSecondAdmin.id));
  assert.notEqual(targetProjection.id, hostProjection.id);
  assert.ok(
    !events.some((event) => event.room === `server:${targetServer.id}` && typeof event.payload === "object" && event.payload !== null && "channel" in event.payload),
    "accepting a joint invite must not broadcast full joint channel metadata to every target-server member",
  );
  assert.ok(
    events.some((event) => event.room === `user:${targetOwner.id}` && event.event === "channel:updated"),
    "accepting invitee should receive the new joint channel metadata directly",
  );

  const secondAcceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${secondInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetSecondAdminToken, targetServer.id),
  });
  assert.equal(secondAcceptRes.status, 200);
  const secondAcceptBody = await secondAcceptRes.json() as { id: string; joined?: boolean };
  assert.equal(secondAcceptBody.id, targetProjection.id, "second invitee should join the existing target projection");
  assert.equal(secondAcceptBody.joined, true);
  const secondAdminList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(targetSecondAdminToken, targetServer.id),
  });
  assert.equal(secondAdminList.status, 200);
  const secondAdminListBody = await secondAdminList.json() as Array<{ id: string; joined?: boolean }>;
  assert.ok(
    secondAdminListBody.some((channel) => channel.id === targetProjection.id && channel.joined),
    "second invitee must get real channel membership when accepting an existing projection",
  );

  const acceptedInvite = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, hostProjection.jointInvite!.id));
  assert.equal(acceptedInvite[0]?.status, "accepted");
  const targetResolved = await resolveChannelAccess({ serverId: targetServer.id, channelId: targetProjection.id });
  assert.equal(targetResolved?.kind, "joint");
  assert.equal(targetResolved?.canonicalChannelId, joint.canonicalChannelId);
  assert.equal(targetResolved?.role, "participant");
  await addHuman(targetProjection.id, hostOwner.id);

  const targetMemberList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberList.status, 200);
  const targetMemberListBody = await targetMemberList.json() as Array<{ id: string }>;
  assert.ok(!targetMemberListBody.some((channel) => channel.id === targetProjection.id), "accepting a server invite does not auto-add all target server members");
  const targetMemberJoin = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/join`, {
    method: "POST",
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberJoin.status, 403, "ordinary target server members cannot self-join a joint channel by id");

  const targetAgent = await createAgent(targetServer.id, "joint-target-agent", {
    runtime: "codex",
    creatorType: "user",
    creatorId: targetOwner.id,
  });
  const hostJointAgent = await createAgent(hostServer.id, "joint-host-agent", { runtime: "codex" });
  const hostWideAgent = await createAgent(hostServer.id, "joint-host-wide-agent", { runtime: "codex" });
  await addAgent(targetProjection.id, targetAgent.id);
  await addAgent(hostProjection.id, hostJointAgent.id);

  const hostMembers = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/members`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMembers.status, 200);
  const hostMembersBody = await hostMembers.json() as {
    agents: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string; status?: string }>;
    humans: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string }>;
  };
  assert.deepEqual(
    hostMembersBody.humans.map((human) => human.id).sort(),
    [hostOwner.id, targetOwner.id, targetSecondAdmin.id].sort(),
    "host-side joint member list should aggregate human members from all active projections",
  );
  assert.deepEqual(
    hostMembersBody.agents.map((agent) => agent.id).sort(),
    [hostJointAgent.id, targetAgent.id].sort(),
    "host-side joint member list should aggregate agent members from all active projections",
  );
  assert.ok(!hostMembersBody.agents.some((agent) => agent.id === hostWideAgent.id), "host-side joint member list must exclude same-server agents outside the joint projection");
  assert.ok(
    hostMembersBody.humans.some((human) => (
      human.id === hostOwner.id
      && human.serverId === hostServer.id
      && human.serverName === hostServer.name
      && human.serverSlug === hostServer.slug
    )),
    "host-side joint member list should prefer the current projection when the same human belongs to both servers",
  );
  assert.ok(
    hostMembersBody.humans.some((human) => (
      human.id === targetOwner.id
      && human.serverId === targetServer.id
      && human.serverName === targetServer.name
      && human.serverSlug === targetServer.slug
    )),
    "host-side joint member list should include the target admin with peer server metadata",
  );
  assert.ok(
    hostMembersBody.agents.some((agent) => (
      agent.id === targetAgent.id
      && agent.serverId === targetServer.id
      && agent.serverName === targetServer.name
      && agent.serverSlug === targetServer.slug
      && typeof agent.status === "string"
    )),
    "host-side joint member list should include agents added from the target server projection with profile/status metadata",
  );

  const targetMembers = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/members`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetMembers.status, 200);
  const targetMembersBody = await targetMembers.json() as {
    agents: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string; status?: string }>;
    humans: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string }>;
  };
  assert.deepEqual(
    targetMembersBody.humans.map((human) => human.id).sort(),
    [hostOwner.id, targetOwner.id, targetSecondAdmin.id].sort(),
    "target-side joint member list should aggregate human members from all active projections",
  );
  assert.deepEqual(
    targetMembersBody.agents.map((agent) => agent.id).sort(),
    [hostJointAgent.id, targetAgent.id].sort(),
    "target-side joint member list should aggregate agent members from all active projections",
  );
  assert.ok(!targetMembersBody.humans.some((human) => human.id === targetMember.id), "target-side joint member list must exclude same-server humans outside the joint projection");
  assert.ok(
    targetMembersBody.humans.some((human) => (
      human.id === hostOwner.id
      && human.serverId === targetServer.id
      && human.serverName === targetServer.name
      && human.serverSlug === targetServer.slug
    )),
    "target-side joint member list should prefer the current projection when the same human belongs to both servers",
  );
  assert.ok(
    targetMembersBody.agents.some((agent) => (
      agent.id === hostJointAgent.id
      && agent.serverId === hostServer.id
      && agent.serverName === hostServer.name
      && agent.serverSlug === hostServer.slug
      && typeof agent.status === "string"
    )),
    "target-side joint member list should include agents added from the host server projection with profile/status metadata",
  );

  const peerAgentProfile = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentProfile.status, 200, "joint channel members can open peer-server agent profiles");
  const peerAgentProfileBody = await peerAgentProfile.json() as Record<string, unknown>;
  assert.equal(peerAgentProfileBody.id, targetAgent.id);
  assert.equal(peerAgentProfileBody.serverId, targetServer.id);
  assert.equal(peerAgentProfileBody.serverName, targetServer.name);
  assert.equal(peerAgentProfileBody.serverSlug, targetServer.slug);
  assert.equal(peerAgentProfileBody.name, "joint-target-agent");
  assert.equal(typeof peerAgentProfileBody.status, "string");
  assert.equal(peerAgentProfileBody.activityDetail, "", "remote joint profile must not expose private activity detail");
  assert.equal("machineId" in peerAgentProfileBody, false, "remote joint profile must not expose machine binding");
  assert.equal("runtimeProfile" in peerAgentProfileBody, false, "remote joint profile must not expose runtime profile");
  assert.equal("envVars" in peerAgentProfileBody, false, "remote joint profile must not expose env vars");
  assert.equal("createdAgents" in peerAgentProfileBody, false, "remote joint profile must not expose created-agent graph");
  assert.equal("model" in peerAgentProfileBody, false, "remote joint profile must not expose model config");
  assert.equal("runtime" in peerAgentProfileBody, false, "remote joint profile must not expose runtime config");

  const peerAgentScopes = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/scopes`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentScopes.status, 404, "joint visibility must not expose peer-server agent permissions");

  const peerAgentActivityLog = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/activity-log`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentActivityLog.status, 404, "joint visibility must not expose peer-server agent activity logs");

  const peerAgentWorkspace = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/workspace-files`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentWorkspace.status, 404, "joint visibility must not expose peer-server agent workspace");

  const peerAgentReminders = await fetch(`${app.baseUrl}/api/reminders?ownerAgentId=${targetAgent.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentReminders.status, 404, "joint visibility must not expose peer-server agent reminders");

  const peerHumanProfile = await fetch(`${app.baseUrl}/api/servers/${hostServer.id}/members/${targetOwner.id}/profile`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerHumanProfile.status, 200, "joint channel members can open peer-server human profiles");
  const peerHumanProfileBody = await peerHumanProfile.json() as {
    serverId: string;
    serverName: string;
    serverSlug: string;
    email: string | null;
    joinedAt: string | null;
    gravatarHash: string;
    role: string | null;
    membershipStatus: string;
    createdAgents: unknown[];
  };
  assert.equal(peerHumanProfileBody.serverId, targetServer.id);
  assert.equal(peerHumanProfileBody.serverName, targetServer.name);
  assert.equal(peerHumanProfileBody.serverSlug, targetServer.slug);
  assert.equal(peerHumanProfileBody.email, null, "remote joint human profile must not expose peer-server email");
  assert.equal(peerHumanProfileBody.gravatarHash, "", "remote joint human profile must not expose email-derived gravatar hash");
  assert.equal(peerHumanProfileBody.role, null, "remote joint human profile must not expose peer-server role");
  assert.equal(peerHumanProfileBody.joinedAt, null, "remote joint human profile must not expose peer-server join date");
  assert.equal(peerHumanProfileBody.membershipStatus, "active", "remote joint human profile only reports active visibility on the shared channel");
  assert.deepEqual(peerHumanProfileBody.createdAgents, [], "remote joint human profile must not expose peer-server created-agent graph");

  const peerHumanDm = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ userId: targetOwner.id }),
  });
  assert.equal(peerHumanDm.status, 400, "joint visibility alone must not allow cross-server human DMs");
  const peerHumanDmBody = await peerHumanDm.json() as { error?: string };
  assert.equal(peerHumanDmBody.error, "User is not a member of this server");

  const targetMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ channelId: targetProjection.id, content: "hello from target server @joint-target-agent @joint-host-wide-agent" }),
  });
  assert.equal(targetMessage.status, 200);
  const targetMessageBody = await targetMessage.json() as { id: string; channelId: string; content: string };
  assert.equal(targetMessageBody.channelId, targetProjection.id, "sender receives their local projection id");
  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `channel:${hostProjection.id}`),
    "joint message socket fanout should use the host local projection room",
  );
  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `channel:${targetProjection.id}`),
    "joint message socket fanout should use the target local projection room",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `channel:${joint.canonicalChannelId}`),
    "joint message socket fanout must not expose the canonical storage room",
  );

  const saveTargetJointMessage = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ messageId: targetMessageBody.id }),
  });
  assert.equal(saveTargetJointMessage.status, 200, "joint participants should be able to save canonical-storage messages");

  const targetSavedList = await fetch(`${app.baseUrl}/api/channels/saved`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetSavedList.status, 200);
  const targetSavedListBody = await targetSavedList.json() as {
    total: number;
    saved: Array<{ messageId: string; channelId: string; channelType: string; content: string }>;
  };
  assert.equal(targetSavedListBody.total, 1);
  assert.ok(
    targetSavedListBody.saved.some((entry) => (
      entry.messageId === targetMessageBody.id
      && entry.channelId === targetProjection.id
      && entry.channelType === "joint"
      && entry.content === targetMessageBody.content
    )),
    "saved joint messages should list through the caller's local projection, not canonical storage",
  );

  const targetSavedCheck = await fetch(`${app.baseUrl}/api/channels/saved/check`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ messageIds: [targetMessageBody.id] }),
  });
  assert.equal(targetSavedCheck.status, 200);
  assert.deepEqual(await targetSavedCheck.json(), { savedIds: [targetMessageBody.id] });

  const nonMemberSave = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST",
    headers: headers(targetMemberToken, targetServer.id),
    body: JSON.stringify({ messageId: targetMessageBody.id }),
  });
  assert.equal(nonMemberSave.status, 404, "server members outside the joint projection must not save by message id");

  const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, targetMessageBody.id));
  assert.ok(
    mentionRows.some((row) => row.targetType === "agent" && row.targetId === targetAgent.id),
    "joint mentions should resolve active peer projection agents",
  );
  assert.ok(
    !mentionRows.some((row) => row.targetType === "agent" && row.targetId === hostWideAgent.id),
    "joint mentions must not resolve host server-wide agents outside the joint channel",
  );

  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200);
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string; content: string; senderMembershipStatus: "active" | "removed" | null }> };
  assert.ok(
    hostMessagesBody.messages.some((message) => message.channelId === hostProjection.id && message.content === targetMessageBody.content),
    "host-side projection should read messages sent from the target-side projection",
  );
  const projectedTargetMessage = hostMessagesBody.messages.find((message) => message.id === targetMessageBody.id);
  assert.equal(
    projectedTargetMessage?.senderMembershipStatus,
    "active",
    "peer-server joint human senders must not be marked removed just because they are not members of the canonical host server",
  );
  const peerHumanProfileAfterMessage = await fetch(`${app.baseUrl}/api/servers/${hostServer.id}/members/${targetOwner.id}/profile`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerHumanProfileAfterMessage.status, 200);
  const peerHumanProfileAfterMessageBody = await peerHumanProfileAfterMessage.json() as {
    serverId: string;
    email: string | null;
    joinedAt: string | null;
    role: string | null;
    membershipStatus: string;
    createdAgents: unknown[];
  };
  assert.equal(peerHumanProfileAfterMessageBody.serverId, targetServer.id);
  assert.equal(peerHumanProfileAfterMessageBody.email, null, "remote joint human profile must stay identity-only after they have sent a shared message");
  assert.equal(peerHumanProfileAfterMessageBody.role, null, "remote joint human profile must not fall back to current-server removed-member details");
  assert.equal(peerHumanProfileAfterMessageBody.joinedAt, null);
  assert.equal(peerHumanProfileAfterMessageBody.membershipStatus, "active");
  assert.deepEqual(peerHumanProfileAfterMessageBody.createdAgents, []);

  const hostMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "hello from host server" }),
  });
  assert.equal(hostMessage.status, 200);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200);
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(
    targetMessagesBody.messages.some((message) => message.channelId === targetProjection.id && message.content === "hello from host server"),
    "target-side projection should read messages sent from the host-side projection",
  );

  const renameRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, {
    method: "PATCH",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ name: "renamed-partner-room", description: "shared updated description" }),
  });
  assert.equal(renameRes.status, 200);

  const hostAfterRename = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostAfterRename.status, 200);
  const hostAfterRenameBody = await hostAfterRename.json() as { name: string; description: string | null };
  assert.equal(hostAfterRenameBody.name, "renamed-partner-room");
  assert.equal(hostAfterRenameBody.description, "shared updated description");

  const rejectVisibility = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, {
    method: "PATCH",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(rejectVisibility.status, 403, "joint channels cannot be converted to private/public visibility");

  const archiveRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/archive`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(archiveRes.status, 200, "joint channel archive should be a shared operation");
  const hostArchived = await getChannel(hostProjection.id);
  const targetArchived = await getChannel(targetProjection.id);
  assert.ok(hostArchived?.archivedAt, "host projection should be archived when target side archives the joint channel");
  assert.ok(targetArchived?.archivedAt, "target projection should be archived when target side archives the joint channel");

  const unarchiveRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/unarchive`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(unarchiveRes.status, 200, "joint channel unarchive should be a shared operation");
  const hostUnarchived = await getChannel(hostProjection.id);
  const targetUnarchived = await getChannel(targetProjection.id);
  assert.equal(hostUnarchived?.archivedAt, null, "host projection should be unarchived");
  assert.equal(targetUnarchived?.archivedAt, null, "target projection should be unarchived");

  const deleteJoint = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, {
    method: "DELETE",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(deleteJoint.status, 400, "joint channels do not support ordinary delete");

  const disconnectRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/disconnect`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(disconnectRes.status, 200, "target server admin can disconnect its local joint projection");
  assert.equal(
    await resolveChannelAccess({ serverId: targetServer.id, channelId: targetProjection.id }),
    null,
    "disconnected projection should no longer resolve",
  );
  const disconnectedTargetProjection = await getChannel(targetProjection.id);
  assert.equal(disconnectedTargetProjection, null, "disconnected projection should be removed from ordinary channel fetches");
  const hostStillResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostStillResolved?.kind, "joint", "disconnecting one server should not delete the other projection");
});


test("joint channel create can invite multiple target servers in the initial request", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-multi-host@slock.test", "joint-create-multi-host");
  const targetOwner = await seedUser("joint-create-multi-target@slock.test", "joint-create-multi-target");
  const thirdOwner = await seedUser("joint-create-multi-third@slock.test", "joint-create-multi-third");
  const hostServer = await createServer("Joint Create Multi Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Multi Target", "joint-create-multi-target", targetOwner.id);
  const thirdServer = await createServer("Joint Create Multi Third", "joint-create-multi-third", thirdOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "multi-initial-room",
      visibility: "joint",
      jointInvites: [
        { targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] },
        { targetServerSlug: thirdServer.slug, invitedPeople: [thirdOwner.email] },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as {
    id: string;
    jointInvites: Array<{ id: string; toServerId: string; invitedUserId: string }>;
    jointPendingInvites: Array<{ toServerId: string; invitedUserId: string; status: "pending" }>;
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
  };
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === hostServer.id && server.status === "active" && server.isCurrentServer));
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === targetServer.id && server.status === "pending"));
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "pending"));
  assert.deepEqual(
    hostProjection.jointInvites.map((invite) => [invite.toServerId, invite.invitedUserId]).sort(),
    [[targetServer.id, targetOwner.id], [thirdServer.id, thirdOwner.id]].sort(),
  );
  assert.deepEqual(
    hostProjection.jointPendingInvites.map((invite) => [invite.toServerId, invite.invitedUserId, invite.status]).sort(),
    [[targetServer.id, targetOwner.id, "pending"], [thirdServer.id, thirdOwner.id, "pending"]].sort(),
  );
});


test("joint channel create rejects more than three total servers", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-limit-host@slock.test", "joint-create-limit-host");
  const targetOwner = await seedUser("joint-create-limit-target@slock.test", "joint-create-limit-target");
  const thirdOwner = await seedUser("joint-create-limit-third@slock.test", "joint-create-limit-third");
  const fourthOwner = await seedUser("joint-create-limit-fourth@slock.test", "joint-create-limit-fourth");
  const hostServer = await createServer("Joint Create Limit Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Limit Target", "joint-create-limit-target", targetOwner.id);
  const thirdServer = await createServer("Joint Create Limit Third", "joint-create-limit-third", thirdOwner.id);
  const fourthServer = await createServer("Joint Create Limit Fourth", "joint-create-limit-fourth", fourthOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "too-many-initial-servers",
      visibility: "joint",
      jointInvites: [
        { targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] },
        { targetServerSlug: thirdServer.slug, invitedPeople: [`@${thirdOwner.name}`] },
        { targetServerSlug: fourthServer.slug, invitedPeople: [`@${fourthOwner.name}`] },
      ],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.match(body.error, /maximum of 3 servers/);
});


test("joint channel create rejects oversized directed invitee arrays", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-invitee-cap-host@slock.test", "joint-create-invitee-cap-host");
  const targetOwner = await seedUser("joint-create-invitee-cap-target@slock.test", "joint-create-invitee-cap-target");
  const hostServer = await createServer("Joint Create Invitee Cap Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Invitee Cap Target", "joint-create-invitee-cap-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "oversized-invitees",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: Array.from({ length: MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET + 1 }, (_, index) => `person-${index}@slock.test`),
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.match(body.error, /maximum of 20 invited people/);
});


test("joint storage migration preserves active legacy projections and moves storage-only state", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-migration-host@slock.test", "joint-migration-host");
  const targetOwner = await seedUser("joint-migration-target@slock.test", "joint-migration-target");
  const hostServer = await createServer("Joint Migration Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Migration Target", "joint-migration-target", targetOwner.id);

  const legacyHostProjection = await createChannel(hostServer.id, "legacy-joint", undefined, "joint");
  const legacyTargetProjection = await createChannel(targetServer.id, "legacy-joint", undefined, "joint");
  await addHuman(legacyHostProjection.id, hostOwner.id);
  await addHuman(legacyTargetProjection.id, targetOwner.id);
  const [legacyJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyHostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);
  const legacyMessage = await createMessage(
    legacyHostProjection.id,
    "user",
    hostOwner.id,
    "legacy production message survives migration",
  );
  await db.insert(messageReactions).values({
    messageId: legacyMessage.id,
    reactorType: "user",
    reactorId: hostOwner.id,
    emoji: "👀",
  });
  const [legacyAttachment] = await db.insert(attachments).values({
    messageId: legacyMessage.id,
    channelId: legacyHostProjection.id,
    uploaderId: hostOwner.id,
    uploaderType: "user",
    filename: "legacy.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    storageKey: "test/legacy.pdf",
  }).returning();
  await db.insert(userChannelReadCursors).values([
    {
      userId: hostOwner.id,
      channelId: legacyHostProjection.id,
      lastReadSeq: legacyMessage.seq,
    },
    {
      userId: targetOwner.id,
      channelId: legacyTargetProjection.id,
      lastReadSeq: legacyMessage.seq - 1,
    },
  ]);

  const archivedHostProjection = await createChannel(hostServer.id, "archived-legacy-joint", undefined, "joint");
  const archivedTargetProjection = await createChannel(targetServer.id, "archived-legacy-joint", undefined, "joint");
  const [archivedJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: archivedHostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
    status: "closed",
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: archivedJoint.id,
      serverId: hostServer.id,
      localChannelId: archivedHostProjection.id,
      role: "host",
      status: "disconnected",
      joinedByUserId: hostOwner.id,
      disconnectedAt: new Date(),
    },
    {
      jointChannelId: archivedJoint.id,
      serverId: targetServer.id,
      localChannelId: archivedTargetProjection.id,
      role: "participant",
      status: "disconnected",
      joinedByUserId: targetOwner.id,
      disconnectedAt: new Date(),
    },
  ]);
  await db.update(channels)
    .set({ archivedAt: new Date(), deletedAt: new Date() })
    .where(eq(channels.id, archivedHostProjection.id));
  await db.update(channels)
    .set({ archivedAt: new Date(), deletedAt: new Date() })
    .where(eq(channels.id, archivedTargetProjection.id));

  const [storageNamespace] = await db.insert(serversTable).values({
    name: "Joint Storage Namespace",
    slug: "__joint_storage__",
    kind: "joint_storage",
    ownerId: hostOwner.id,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const storageChannel = await createChannel(storageNamespace.id, "joint-storage-test");
  const newHostProjection = await createChannel(hostServer.id, "new-shape-joint", undefined, "joint");
  await addHuman(newHostProjection.id, hostOwner.id);
  const [newShapeJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: storageChannel.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: newShapeJoint.id,
    serverId: hostServer.id,
    localChannelId: newHostProjection.id,
    role: "host",
    joinedByUserId: hostOwner.id,
  });

  const migrationSql = readFileSync(new URL("../../drizzle/0100_joint_storage_legacy_convert.sql", import.meta.url), "utf8");
  for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }

  const [migratedLegacyJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyJoint.id));
  assert.equal(migratedLegacyJoint.status, "active", "active legacy joint authority row should remain active");
  assert.notEqual(
    migratedLegacyJoint.canonicalChannelId,
    legacyHostProjection.id,
    "active legacy joint canonical storage should move away from the host local projection",
  );
  const legacyServerRows = await db.select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, legacyJoint.id));
  assert.ok(legacyServerRows.every((row) => row.status === "active"), "active local projections should remain connected");
  const [hostProjectionAfter] = await db.select().from(channels).where(eq(channels.id, legacyHostProjection.id));
  const [targetProjectionAfter] = await db.select().from(channels).where(eq(channels.id, legacyTargetProjection.id));
  assert.equal(hostProjectionAfter.deletedAt, null, "host local projection must not be soft-deleted");
  assert.equal(hostProjectionAfter.archivedAt, null, "host local projection must not be archived");
  assert.equal(targetProjectionAfter.deletedAt, null, "peer local projection must not be soft-deleted");
  assert.equal(targetProjectionAfter.archivedAt, null, "peer local projection must not be archived");

  const [migratedStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
      deletedAt: channels.deletedAt,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedLegacyJoint.canonicalChannelId));
  assert.equal(migratedStorage.serverKind, "joint_storage", "new canonical channel should live in the storage namespace");
  assert.equal(migratedStorage.type, "channel", "new canonical storage channel should be an ordinary storage channel");
  assert.equal(migratedStorage.deletedAt, null);

  const [migratedMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedMessage.channelId, migratedLegacyJoint.canonicalChannelId, "existing messages should move to canonical storage");
  const [migratedAttachment] = await db.select().from(attachments).where(eq(attachments.id, legacyAttachment.id));
  assert.equal(migratedAttachment.channelId, migratedLegacyJoint.canonicalChannelId, "linked attachments should move with their canonical message");
  const persistedReactions = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, legacyMessage.id));
  assert.equal(persistedReactions.length, 1, "message-child reactions should stay attached by message id");
  const readCursors = await db
    .select()
    .from(userChannelReadCursors)
    .where(eq(userChannelReadCursors.userId, targetOwner.id));
  assert.equal(readCursors.find((cursor) => cursor.channelId === legacyTargetProjection.id)?.lastReadSeq, legacyMessage.seq - 1);

  const [stillArchivedJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, archivedJoint.id));
  const [stillArchivedHostProjection] = await db.select().from(channels).where(eq(channels.id, archivedHostProjection.id));
  assert.equal(stillArchivedJoint.status, "closed", "previously archived legacy joint rows must stay closed");
  assert.equal(
    stillArchivedJoint.canonicalChannelId,
    archivedHostProjection.id,
    "previously archived legacy rows must not be reopened or remapped",
  );
  assert.ok(stillArchivedHostProjection.deletedAt, "previously archived local projection should remain deleted");

  const [untouchedNewJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, newShapeJoint.id));
  const [untouchedStorage] = await db.select().from(channels).where(eq(channels.id, storageChannel.id));
  const [untouchedProjection] = await db.select().from(channels).where(eq(channels.id, newHostProjection.id));
  assert.equal(untouchedNewJoint.status, "active", "storage-only canonical rows should remain active");
  assert.equal(untouchedStorage.deletedAt, null, "new-shape storage channel must not be drained");
  assert.equal(untouchedProjection.deletedAt, null, "new-shape local projections must not be drained");

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200, "host side should still read the migrated joint timeline");
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string; content: string }> };
  assert.equal(hostMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyHostProjection.id);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyTargetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200, "peer side should still read the migrated joint timeline");
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ id: string; channelId: string; content: string }> };
  assert.equal(targetMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyTargetProjection.id);

  const targetReaction = await fetch(`${app.baseUrl}/api/messages/${legacyMessage.id}/reactions`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(targetReaction.status, 200, "peer side should be able to react to a migrated legacy message");
  const targetReactionBody = await targetReaction.json() as { channelId: string; reactions: Array<{ emoji: string; count: number }> };
  assert.equal(targetReactionBody.channelId, legacyTargetProjection.id);
  assert.equal(targetReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);

  const attachmentUrl = await fetch(`${app.baseUrl}/api/attachments/${legacyAttachment.id}/url`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.ok(
    [200, 503].includes(attachmentUrl.status),
    `peer-side attachment URL should pass joint access before storage handling, got ${attachmentUrl.status}`,
  );
});


test("joint storage migration converts host-server canonical storage rows", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-host-storage-host@slock.test", "joint-host-storage-host");
  const targetOwner = await seedUser("joint-host-storage-target@slock.test", "joint-host-storage-target");
  const hostServer = await createServer("Joint Host Storage Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Host Storage Target", "joint-host-storage-target", targetOwner.id);

  const legacyStorage = await createChannel(hostServer.id, "legacy-host-storage", undefined, "joint");
  const legacyHostProjection = await createChannel(hostServer.id, "legacy-host-projection", undefined, "joint");
  const legacyTargetProjection = await createChannel(targetServer.id, "legacy-target-projection", undefined, "joint");
  await addHuman(legacyHostProjection.id, hostOwner.id);
  await addHuman(legacyTargetProjection.id, targetOwner.id);
  const [legacyJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyStorage.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);
  const legacyMessage = await createMessage(
    legacyStorage.id,
    "user",
    hostOwner.id,
    "legacy host-server storage message survives migration",
  );
  await db.insert(messageReactions).values({
    messageId: legacyMessage.id,
    reactorType: "user",
    reactorId: hostOwner.id,
    emoji: "👀",
  });
  const [legacyAttachment] = await db.insert(attachments).values({
    messageId: legacyMessage.id,
    channelId: legacyStorage.id,
    uploaderId: hostOwner.id,
    uploaderType: "user",
    filename: "legacy-host-storage.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2345,
    storageKey: "test/legacy-host-storage.pdf",
  }).returning();

  const legacyThread = await getOrCreateThread(legacyMessage.id, hostOwner.id, "user");
  const legacyThreadReply = await createMessage(
    legacyThread.id,
    "user",
    targetOwner.id,
    "legacy host-server storage thread reply survives migration",
  );
  const [legacyThreadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyThread.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  const [legacyHostThreadProjection] = await db.insert(channels).values({
    serverId: hostServer.id,
    name: `thread-${legacyMessage.id.slice(0, 8)}-host-projection`,
    type: "thread",
    parentMessageId: null,
  }).returning();
  const [legacyTargetThreadProjection] = await db.insert(channels).values({
    serverId: targetServer.id,
    name: `thread-${legacyMessage.id.slice(0, 8)}-target-projection`,
    type: "thread",
    parentMessageId: null,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyThreadJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostThreadProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyThreadJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetThreadProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);

  const migrationSql = readFileSync(new URL("../../drizzle/0102_joint_storage_host_namespace_convert.sql", import.meta.url), "utf8");
  for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }

  const [migratedLegacyJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyJoint.id));
  assert.equal(
    migratedLegacyJoint.canonicalChannelId,
    legacyStorage.id,
    "host-server canonical storage should keep its stable channel id",
  );
  const [migratedTopLevelStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedLegacyJoint.canonicalChannelId));
  assert.equal(migratedTopLevelStorage.serverKind, "joint_storage");
  assert.equal(migratedTopLevelStorage.type, "channel");

  const [migratedMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedMessage.channelId, legacyStorage.id, "legacy messages should keep their canonical storage id");
  const [migratedAttachment] = await db.select().from(attachments).where(eq(attachments.id, legacyAttachment.id));
  assert.equal(migratedAttachment.channelId, legacyStorage.id, "linked attachments should keep their canonical storage id");
  const existingReactions = await db.select().from(messageReactions).where(eq(messageReactions.messageId, legacyMessage.id));
  assert.equal(existingReactions.length, 1, "message reactions should stay attached by message id");

  const [migratedThreadJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyThreadJoint.id));
  assert.equal(migratedThreadJoint.canonicalChannelId, legacyThread.id, "canonical joint thread should keep its stable channel id");
  const [migratedThreadStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedThreadJoint.canonicalChannelId));
  assert.equal(migratedThreadStorage.serverKind, "joint_storage");
  assert.equal(migratedThreadStorage.type, "thread");
  assert.equal(migratedThreadStorage.parentMessageId, legacyMessage.id);
  const [migratedParentMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedParentMessage.threadId, legacyThread.id);
  const [migratedThreadReply] = await db.select().from(messages).where(eq(messages.id, legacyThreadReply.id));
  assert.equal(migratedThreadReply.channelId, legacyThread.id, "legacy replies should keep their canonical thread id");

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200, "host side should read migrated host-server storage messages via projection");
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(hostMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyHostProjection.id);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyTargetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200, "peer side should read migrated host-server storage messages via projection");
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(targetMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyTargetProjection.id);

  const hostReaction = await fetch(`${app.baseUrl}/api/messages/${legacyMessage.id}/reactions`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(hostReaction.status, 200, "host side should be able to react to migrated legacy storage messages");
  const hostReactionBody = await hostReaction.json() as { channelId: string; reactions: Array<{ emoji: string; count: number }> };
  assert.equal(hostReactionBody.channelId, legacyHostProjection.id);
  assert.equal(hostReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);

  const targetAttachmentUrl = await fetch(`${app.baseUrl}/api/attachments/${legacyAttachment.id}/url`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.ok(
    [200, 503].includes(targetAttachmentUrl.status),
    `peer-side attachment URL should pass joint access after host-storage migration, got ${targetAttachmentUrl.status}`,
  );

  const hostThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostThreadProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostThreadMessages.status, 200, "host local thread projection should read migrated canonical replies");
  const hostThreadMessagesBody = await hostThreadMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(
    hostThreadMessagesBody.messages.find((message) => message.id === legacyThreadReply.id)?.channelId,
    legacyHostThreadProjection.id,
  );
});


test("joint channel threads use per-server local thread projections over canonical storage", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  try {
    const db = getDb();
    const hostOwner = await seedUser("joint-thread-host@slock.test", "joint-thread-host");
    const targetOwner = await seedUser("joint-thread-target@slock.test", "joint-thread-target");
    const targetMember = await seedUser("joint-thread-target-member@slock.test", "joint-thread-target-member");
    const hostServer = await createServer("Joint Thread Host", "botiverse", hostOwner.id);
    const targetServer = await createServer("Joint Thread Target", "joint-thread-target", targetOwner.id);
    await addMember(targetServer.id, targetMember.id, "member");
    const hostAgent = await createAgent(hostServer.id, "joint-thread-host-agent", { runtime: "codex" });
    const targetAgent = await createAgent(targetServer.id, "joint-thread-target-agent", { runtime: "codex" });
    const hostToken = await tokenForHuman(hostOwner.email);
    const targetToken = await tokenForHuman(targetOwner.email);
    const targetMemberToken = await tokenForHuman(targetMember.email);

    const createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "threaded-partner-room",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [`@${targetOwner.name}`],
      }),
    });
    assert.equal(createRes.status, 200);
    const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(acceptRes.status, 200);
    const targetProjection = await acceptRes.json() as { id: string };
    await addAgent(hostProjection.id, hostAgent.id);
    await addAgent(targetProjection.id, targetAgent.id);
    const agentOrchestratorForMembers = app.app.get("agentOrchestrator") as {
      getActivity: (agentId: string, opts?: unknown) => Promise<{ activity: string; activityDetail: string }>;
    };
    const originalGetActivity = agentOrchestratorForMembers.getActivity.bind(agentOrchestratorForMembers);
    agentOrchestratorForMembers.getActivity = async (agentId, opts) => {
      if (agentId === hostAgent.id) {
        return { activity: "working", activityDetail: "Responding from host" };
      }
      return originalGetActivity(agentId, opts);
    };

    const targetMembers = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/members`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetMembers.status, 200);
    const targetMembersBody = await targetMembers.json() as { agents: Array<{ id: string; activity?: string; activityDetail?: string }> };
    const visibleHostAgent = targetMembersBody.agents.find((agent) => agent.id === hostAgent.id);
    assert.equal(
      visibleHostAgent?.activity,
      "working",
      "peer-side joint member list should include live activity for remote origin agents",
    );
    assert.equal(visibleHostAgent?.activityDetail, "Responding from host");
    const [parentJointProjection] = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .where(eq(jointChannelServers.localChannelId, hostProjection.id));
    assert.ok(parentJointProjection, "host parent projection should resolve to the parent joint channel");

    const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: hostProjection.id, content: "parent visible on both sides" }),
    });
    assert.equal(parentRes.status, 200);
    const parent = await parentRes.json() as { id: string };

    const deniedPermalink = await fetch(`${app.baseUrl}/api/messages/context/${parent.id}?channelId=${targetProjection.id}`, {
      headers: headers(targetMemberToken, targetServer.id),
    });
    assert.equal(deniedPermalink.status, 404, "joint permalink access for non-members should degrade to neutral not found");
    assert.deepEqual(await deniedPermalink.json(), { error: "Message not found" });

    const events = installFakeIo(app.app);
    const targetReaction = await fetch(`${app.baseUrl}/api/messages/${parent.id}/reactions`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(targetReaction.status, 200);
    const targetReactionBody = await targetReaction.json() as {
      channelId: string;
      reactions: Array<{ emoji: string; count: number; reactorIds: string[] }>;
    };
    assert.equal(
      targetReactionBody.channelId,
      targetProjection.id,
      "joint reaction response should expose the actor's local parent projection id",
    );
    assert.equal(targetReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);
    assert.ok(
      events.some((event) => (
        event.room === `channel:${hostProjection.id}`
        && event.event === "message:updated"
        && (event.payload as any).channelId === hostProjection.id
        && (event.payload as any).reactions?.some((reaction: { emoji: string; count: number }) => reaction.emoji === "👍" && reaction.count === 1)
      )),
      "joint reaction update should fan out to the host projection room with the host local channel id",
    );
    assert.ok(
      events.some((event) => (
        event.room === `channel:${targetProjection.id}`
        && event.event === "message:updated"
        && (event.payload as any).channelId === targetProjection.id
        && (event.payload as any).reactions?.some((reaction: { emoji: string; count: number }) => reaction.emoji === "👍" && reaction.count === 1)
      )),
      "joint reaction update should fan out to the target projection room with the target local channel id",
    );

    const targetReactionRemove = await fetch(`${app.baseUrl}/api/messages/${parent.id}/reactions`, {
      method: "DELETE",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(targetReactionRemove.status, 200);
    const targetReactionRemoveBody = await targetReactionRemove.json() as { channelId: string; reactions: Array<{ emoji: string }> };
    assert.equal(targetReactionRemoveBody.channelId, targetProjection.id);
    assert.deepEqual(targetReactionRemoveBody.reactions, []);
    const persistedReactions = await db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, parent.id));
    assert.deepEqual(persistedReactions, []);
    events.length = 0;

    const createThreadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ parentMessageId: parent.id, content: "host thread reply" }),
    });
    assert.equal(createThreadRes.status, 200);
    const createdThread = await createThreadRes.json() as { threadChannelId: string; replyCount: number };
    assert.equal(createdThread.replyCount, 1);

    const [hostThreadProjection] = await db
      .select({
        jointThreadId: jointChannelServers.jointChannelId,
        canonicalThreadChannelId: jointChannels.canonicalChannelId,
      })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(eq(jointChannelServers.localChannelId, createdThread.threadChannelId));
    assert.ok(hostThreadProjection, "creating a joint thread should register a host local projection");
    assert.notEqual(
      hostThreadProjection.canonicalThreadChannelId,
      createdThread.threadChannelId,
      "thread API should return the local thread projection, not canonical storage",
    );

    const [targetThreadProjection] = await db
      .select({ localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, hostThreadProjection.jointThreadId),
        eq(jointChannelServers.serverId, targetServer.id),
      ));
    assert.ok(targetThreadProjection, "creating a joint thread should create the peer local thread projection");

    const hostThreadUpdate = events.find((event) => (
        event.room === `channel:${hostProjection.id}`
        && event.event === "thread:updated"
        && (event.payload as any).threadChannelId === createdThread.threadChannelId
      ));
    assert.ok(
      hostThreadUpdate,
      "host parent room should receive thread updates with the host local thread id",
    );
    assert.equal((hostThreadUpdate.payload as any).latestReply.content, "host thread reply");
    assert.equal((hostThreadUpdate.payload as any).latestReply.channelId, createdThread.threadChannelId);

    const targetThreadUpdate = events.find((event) => (
        event.room === `channel:${targetProjection.id}`
        && event.event === "thread:updated"
        && (event.payload as any).threadChannelId === targetThreadProjection.localChannelId
      ));
    assert.ok(
      targetThreadUpdate,
      "target parent room should receive thread updates with the target local thread id",
    );
    assert.equal((targetThreadUpdate.payload as any).latestReply.content, "host thread reply");
    assert.equal((targetThreadUpdate.payload as any).latestReply.channelId, targetThreadProjection.localChannelId);
    assert.ok(
      !events.some((event) => event.room === `channel:${hostThreadProjection.canonicalThreadChannelId}`),
      "canonical joint thread storage room must not be used for frontend socket delivery",
    );

    const hostParentMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostParentMessages.status, 200);
    const hostParentMessagesBody = await hostParentMessages.json() as { messages: Array<{ id: string; threadId: string | null }> };
    assert.equal(
      hostParentMessagesBody.messages.find((message) => message.id === parent.id)?.threadId,
      createdThread.threadChannelId,
      "host parent timeline should expose the host local thread projection id",
    );

    const targetParentMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetParentMessages.status, 200);
    const targetParentMessagesBody = await targetParentMessages.json() as {
      messages: Array<{ id: string; threadId: string | null }>;
      messageWindow: { serverId: string; receiverId: string; scopeId: string; completeThroughLatest: boolean };
    };
    assert.equal(
      targetParentMessagesBody.messages.find((message) => message.id === parent.id)?.threadId,
      targetThreadProjection.localChannelId,
      "target parent timeline should expose the target local thread projection id",
    );
    assert.deepEqual(targetParentMessagesBody.messageWindow, {
      ...targetParentMessagesBody.messageWindow,
      serverId: targetServer.id,
      receiverId: targetOwner.id,
      scopeId: targetProjection.id,
      completeThroughLatest: true,
    });

    const targetSummaries = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetSummaries.status, 200);
    const targetSummariesBody = await targetSummaries.json() as Record<string, { threadChannelId: string; replyCount: number }>;
    assert.equal(
      targetSummariesBody[parent.id]?.threadChannelId,
      targetThreadProjection.localChannelId,
      "peer summaries should expose the peer local thread projection id",
    );

    const targetThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetThreadProjection.localChannelId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetThreadMessages.status, 200);
    const targetThreadMessagesBody = await targetThreadMessages.json() as {
      messages: Array<{ channelId: string; content: string }>;
      messageWindow: { serverId: string; receiverId: string; scopeId: string; completeThroughLatest: boolean };
    };
    assert.ok(
      targetThreadMessagesBody.messages.some((message) => message.channelId === targetThreadProjection.localChannelId && message.content === "host thread reply"),
      "peer local thread projection should read canonical replies projected to its local id",
    );
    assert.deepEqual(targetThreadMessagesBody.messageWindow, {
      ...targetThreadMessagesBody.messageWindow,
      serverId: targetServer.id,
      receiverId: targetOwner.id,
      scopeId: targetThreadProjection.localChannelId,
      completeThroughLatest: true,
    });

    const deliveries: Array<{
      agentId: string;
      message: { channel_id?: string; parent_channel_id?: string; parent_channel_type?: string; content: string; thread_join_context?: unknown };
      options?: { adminAuthority?: boolean };
    }> = [];
    const agentOrchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (
        agentId: string,
        message: { channel_id?: string; parent_channel_id?: string; parent_channel_type?: string; content: string; thread_join_context?: unknown },
        options?: { adminAuthority?: boolean },
      ) => Promise<void>;
    };
    agentOrchestrator.deliverMessage = async (agentId, message, options) => {
      deliveries.push({ agentId, message, options });
    };

    const mentionReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        channelId: createdThread.threadChannelId,
        content: `hello @${targetAgent.name} @${targetOwner.name}`,
        mentions: [
          { type: "agent", id: targetAgent.id, name: targetAgent.name },
          { type: "user", id: targetOwner.id, name: targetOwner.name },
        ],
      }),
    });
    assert.equal(mentionReply.status, 200);
    await mentionReply.json();
    const targetAgentMentionDelivery = deliveries.find((delivery) => (
      delivery.agentId === targetAgent.id
      && delivery.message.content === `hello @${targetAgent.name} @${targetOwner.name}`
    ));
    assert.ok(targetAgentMentionDelivery, "mentioning a peer projection agent in a joint thread should deliver to that agent");
    assert.equal(
      targetAgentMentionDelivery.message.channel_id,
      targetThreadProjection.localChannelId,
      "peer agent delivery should target the peer local thread projection id",
    );
    assert.equal(
      targetAgentMentionDelivery.message.parent_channel_id,
      targetProjection.id,
      "peer agent delivery should identify the peer local parent projection id",
    );
    assert.equal(targetAgentMentionDelivery.message.parent_channel_type, "joint");
    assert.ok(targetAgentMentionDelivery.message.thread_join_context, "first mention delivery should include thread join context");
    const [targetAgentFollow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, targetThreadProjection.localChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, targetAgent.id),
        isNull(threadFollows.unfollowedAt),
      ))
      .limit(1);
    assert.ok(targetAgentFollow, "peer agent follow should be recorded against the peer local thread projection");
    assert.ok(
      events.some((event) => (
        event.room === `user:${targetOwner.id}`
        && event.event === "message:new"
        && (event.payload as any).channelId === targetThreadProjection.localChannelId
        && (event.payload as any).content === `hello @${targetAgent.name} @${targetOwner.name}`
      )),
      "first joint thread mention should live-deliver to the peer mentioned human through their local thread projection",
    );

    await recordThreadFollow("agent", hostAgent.id, createdThread.threadChannelId, parent.id, "manual");
    await enableThreadAgentFollowerManagementForServer(hostServer.id);
    const hostManagedRoster = await fetch(
      `${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${createdThread.threadChannelId}`,
      { headers: headers(hostToken, hostServer.id) },
    );
    assert.equal(hostManagedRoster.status, 200);
    const hostManagedRosterBody = await hostManagedRoster.json() as {
      threads: Array<{
        threadChannelId: string;
        agents: Array<{
          id: string;
          name: string;
          serverId: string;
          serverName: string;
          serverSlug: string;
          isCurrentServer: boolean;
          canRemove: boolean;
        }>;
      }>;
    };
    const managedHostAgent = hostManagedRosterBody.threads[0]?.agents.find((agent) => agent.id === hostAgent.id);
    const managedTargetAgent = hostManagedRosterBody.threads[0]?.agents.find((agent) => agent.id === targetAgent.id);
    assert.equal(hostManagedRosterBody.threads[0]?.threadChannelId, createdThread.threadChannelId);
    assert.equal(managedHostAgent?.serverId, hostServer.id);
    assert.equal(managedHostAgent?.serverName, hostServer.name);
    assert.equal(managedHostAgent?.serverSlug, hostServer.slug);
    assert.equal(managedHostAgent?.isCurrentServer, true);
    assert.equal(managedHostAgent?.canRemove, true);
    assert.equal(managedTargetAgent?.serverId, targetServer.id);
    assert.equal(managedTargetAgent?.serverName, targetServer.name);
    assert.equal(managedTargetAgent?.serverSlug, targetServer.slug);
    assert.equal(managedTargetAgent?.isCurrentServer, false);
    assert.equal(
      managedTargetAgent?.canRemove,
      false,
      "peer-server Agent followers should be visible but read-only from the host projection",
    );

    const peerFollowerRemove = await fetch(
      `${app.baseUrl}/api/channels/threads/${createdThread.threadChannelId}/followers/agents/${targetAgent.id}`,
      { method: "DELETE", headers: headers(hostToken, hostServer.id) },
    );
    assert.equal(peerFollowerRemove.status, 404, "host projection must not remove a peer-server Agent follower");
    assert.equal(
      events.some((event) => event.event === "thread:followers-updated"),
      false,
      "rejected peer follower removal must not emit a roster-refresh event",
    );

    events.length = 0;
    const localFollowerRemove = await fetch(
      `${app.baseUrl}/api/channels/threads/${createdThread.threadChannelId}/followers/agents/${hostAgent.id}`,
      { method: "DELETE", headers: headers(hostToken, hostServer.id) },
    );
    assert.equal(localFollowerRemove.status, 200);
    const localFollowerRemoveBody = await localFollowerRemove.json() as { removed: boolean; undoToken: string | null };
    assert.equal(localFollowerRemoveBody.removed, true);
    assert.ok(localFollowerRemoveBody.undoToken);
    const localRemoveFollowerUpdates = events.filter((event) => event.event === "thread:followers-updated");
    assert.deepEqual(
      localRemoveFollowerUpdates.map((event) => event.room).sort(),
      [`channel:${createdThread.threadChannelId}`, `channel:${targetThreadProjection.localChannelId}`].sort(),
      "local follower changes in a joint thread must refresh every local projection room",
    );
    for (const event of localRemoveFollowerUpdates) {
      assert.deepEqual(
        Object.keys(event.payload as Record<string, unknown>).sort(),
        ["threadChannelId"],
        "follower-refresh payload must not expose agent, user, or server details",
      );
      assert.equal(
        (event.payload as { threadChannelId?: string }).threadChannelId,
        event.room === `channel:${createdThread.threadChannelId}`
          ? createdThread.threadChannelId
          : targetThreadProjection.localChannelId,
        "each room receives its own local thread projection id",
      );
    }
    assert.ok(
      !events.some((event) => event.room === `channel:${hostThreadProjection.canonicalThreadChannelId}`),
      "canonical joint thread storage room must not receive follower-refresh events",
    );
    const [removedHostAgentFollow] = await db
      .select({ unfollowedAt: threadFollows.unfollowedAt })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, createdThread.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, hostAgent.id),
      ))
      .limit(1);
    assert.ok(removedHostAgentFollow?.unfollowedAt, "host-local Agent follower should still be removable");
    const [retainedTargetAgentFollow] = await db
      .select({ unfollowedAt: threadFollows.unfollowedAt })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, targetThreadProjection.localChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, targetAgent.id),
      ))
      .limit(1);
    assert.equal(
      retainedTargetAgentFollow?.unfollowedAt ?? null,
      null,
      "failed peer removal must leave the peer local projection follow active",
    );

    const targetMentionInbox = await fetch(`${app.baseUrl}/api/channels/inbox?filter=mentions`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetMentionInbox.status, 200);
    const targetMentionInboxBody = await targetMentionInbox.json() as {
      items: Array<{ kind: string; threadChannelId?: string; parentChannelId?: string; unreadCount?: number; hasMention?: boolean }>;
    };
    const targetMentionThreadItem = targetMentionInboxBody.items.find((item) => item.threadChannelId === targetThreadProjection.localChannelId);
    assert.ok(targetMentionThreadItem, "joint local thread mentions should appear in Activity/Mentions through the local projection");
    assert.equal(targetMentionThreadItem.kind, "thread");
    assert.equal(targetMentionThreadItem.parentChannelId, targetProjection.id);
    assert.equal(targetMentionThreadItem.hasMention, true);
    assert.ok((targetMentionThreadItem.unreadCount ?? 0) > 0);

    deliveries.length = 0;
    events.length = 0;
    const followupReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: createdThread.threadChannelId, content: "ordinary joint thread follow-up" }),
    });
    assert.equal(followupReply.status, 200);
    const followupReplyBody = await followupReply.json() as { id: string; seq: number };
    const targetAgentFollowupDelivery = deliveries.find((delivery) => (
      delivery.agentId === targetAgent.id
      && delivery.message.content === "ordinary joint thread follow-up"
    ));
    assert.ok(targetAgentFollowupDelivery, "a peer agent that follows a joint thread should receive later ordinary replies");
    assert.equal(targetAgentFollowupDelivery.message.channel_id, targetThreadProjection.localChannelId);
    assert.equal(targetAgentFollowupDelivery.message.parent_channel_id, targetProjection.id);

    const targetAgentReadCredential = await mintAgentCredential({
      agentId: targetAgent.id,
      scopes: ["read"],
      name: "joint-thread-history-read",
      createdByUserId: null,
    });
    const targetThreadRef = encodeURIComponent(`#threaded-partner-room:${parent.id.slice(0, 8)}`);
    const targetAgentHistory = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${targetThreadRef}&limit=10`, {
      headers: { Authorization: `Bearer ${targetAgentReadCredential.apiKey}` },
    });
    assert.equal(targetAgentHistory.status, 200, "peer agent should read joint thread history via its local thread projection");
    const targetAgentHistoryBody = await targetAgentHistory.json() as {
      messages: Array<{ id: string; channelId: string; content: string }>;
    };
    assert.ok(
      targetAgentHistoryBody.messages.some((message) => (
        message.channelId === targetThreadProjection.localChannelId
        && message.content === "host thread reply"
      )),
      "peer agent history should include earlier canonical replies projected to the peer local thread id",
    );
    assert.ok(
      targetAgentHistoryBody.messages.some((message) => (
        message.channelId === targetThreadProjection.localChannelId
        && message.content === "ordinary joint thread follow-up"
      )),
      "peer agent history should include follow-up replies projected to the peer local thread id",
    );

    const targetAgentAroundHistory = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${targetThreadRef}&around=${followupReplyBody.id.slice(0, 8)}&limit=3`, {
      headers: { Authorization: `Bearer ${targetAgentReadCredential.apiKey}` },
    });
    assert.equal(targetAgentAroundHistory.status, 200, "peer agent history anchors should resolve against canonical joint thread storage");
    const targetAgentAroundHistoryBody = await targetAgentAroundHistory.json() as {
      messages: Array<{ id: string; channelId: string; content: string }>;
    };
    assert.ok(
      targetAgentAroundHistoryBody.messages.some((message) => (
        message.id === followupReplyBody.id
        && message.channelId === targetThreadProjection.localChannelId
        && message.content === "ordinary joint thread follow-up"
      )),
      "around=<short-id> should return the canonical reply projected to the peer local thread id",
    );
    assert.ok(
      events.some((event) => (
        event.room === `user:${targetOwner.id}`
        && event.event === "message:new"
        && (event.payload as any).channelId === targetThreadProjection.localChannelId
        && (event.payload as any).content === "ordinary joint thread follow-up"
      )),
      "peer human followers should receive live joint thread replies through their local thread projection",
    );

    const targetAllInbox = await fetch(`${app.baseUrl}/api/channels/inbox`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetAllInbox.status, 200);
    const targetAllInboxBody = await targetAllInbox.json() as {
      items: Array<{ kind: string; threadChannelId?: string; parentChannelId?: string }>;
    };
    const targetAllThreadItem = targetAllInboxBody.items.find((item) => item.threadChannelId === targetThreadProjection.localChannelId);
    assert.ok(targetAllThreadItem, "joint local threads should appear in all Activity through the local thread projection");
    assert.equal(targetAllThreadItem.kind, "thread");
    assert.equal(targetAllThreadItem.parentChannelId, targetProjection.id);

    // The RisingWave v1 unread/sidebar MVs do not yet understand joint
    // local-projection -> canonical-storage split. A configured RW env must
    // therefore fail closed to the inline Postgres path for those surfaces.
    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:9/slock_rw_guard_should_not_connect";

    const targetUnread = await fetch(`${app.baseUrl}/api/channels/unread`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetUnread.status, 200);
    const targetUnreadBody = await targetUnread.json() as Record<string, number>;
    assert.ok(
      (targetUnreadBody[targetProjection.id] ?? 0) > 0,
      "peer reload unread counts should read top-level joint messages from canonical storage but return the peer parent projection id",
    );
    assert.ok(
      (targetUnreadBody[targetThreadProjection.localChannelId] ?? 0) > 0,
      "peer reload unread counts should read joint thread replies from canonical storage but return the peer local thread id",
    );

    const targetUnreadSummary = await fetch(`${app.baseUrl}/api/servers/unread-summary`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    assert.equal(targetUnreadSummary.status, 200);
    const targetUnreadSummaryBody = await targetUnreadSummary.json() as Array<{ serverId: string; unreadCount: number }>;
    assert.ok(
      (targetUnreadSummaryBody.find((item) => item.serverId === targetServer.id)?.unreadCount ?? 0) > 0,
      "sidebar unread summary should count top-level joint projection unread from canonical storage",
    );

    const targetSummariesAfterUnread = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetSummariesAfterUnread.status, 200);
    const targetSummariesAfterUnreadBody = await targetSummariesAfterUnread.json() as Record<string, { threadChannelId: string; unreadCount: number; firstUnreadMessageId: string | null; participantIds: string[] }>;
    assert.equal(targetSummariesAfterUnreadBody[parent.id]?.threadChannelId, targetThreadProjection.localChannelId);
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.unreadCount > 0,
      "peer parent thread summary unread count should read canonical thread storage",
    );
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.firstUnreadMessageId,
      "peer parent thread summary first unread id should come from canonical thread storage",
    );
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.participantIds.includes(hostOwner.id),
      "peer parent thread summary participants should read canonical thread storage",
    );

    const targetReadAll = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetReadAll.status, 200);
    const targetThreadCursorRows = await db
      .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, targetOwner.id),
        eq(userChannelReadCursors.channelId, targetThreadProjection.localChannelId),
      ));
    assert.equal(targetThreadCursorRows.length, 1, "Activity mark-all should advance joint local thread cursors");
    assert.ok(targetThreadCursorRows[0].lastReadSeq >= followupReplyBody.seq);

    const targetUnreadAfterReadAll = await fetch(`${app.baseUrl}/api/channels/unread`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetUnreadAfterReadAll.status, 200);
    const targetUnreadAfterReadAllBody = await targetUnreadAfterReadAll.json() as Record<string, number>;
    assert.equal(targetUnreadAfterReadAllBody[targetProjection.id], undefined);
    assert.equal(targetUnreadAfterReadAllBody[targetThreadProjection.localChannelId], undefined);

    const targetReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ channelId: targetThreadProjection.localChannelId, content: "target thread reply" }),
    });
    assert.equal(targetReply.status, 200);
    const targetReplyBody = await targetReply.json() as { channelId: string };
    assert.equal(targetReplyBody.channelId, targetThreadProjection.localChannelId);

    const hostThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${createdThread.threadChannelId}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostThreadMessages.status, 200);
    const hostThreadMessagesBody = await hostThreadMessages.json() as { messages: Array<{ channelId: string; content: string; senderId: string; senderMembershipStatus?: string | null }> };
    assert.ok(
      hostThreadMessagesBody.messages.some((message) => message.channelId === createdThread.threadChannelId && message.content === "target thread reply"),
      "host local thread projection should read peer replies projected to its local id",
    );
    assert.ok(
      hostThreadMessagesBody.messages.some((message) => (
        message.content === "target thread reply"
        && message.senderId === targetOwner.id
        && message.senderMembershipStatus === "active"
      )),
      "peer human senders in joint thread replies should stay active through parent projection membership",
    );

    const targetCanonicalFetch = await fetch(`${app.baseUrl}/api/messages/channel/${hostThreadProjection.canonicalThreadChannelId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetCanonicalFetch.status, 404, "peer server must not access canonical thread storage by id");
    const hostCanonicalFetch = await fetch(`${app.baseUrl}/api/messages/channel/${hostThreadProjection.canonicalThreadChannelId}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostCanonicalFetch.status, 404, "host server must not use canonical thread storage as a routable thread surface");

    events.length = 0;
    const targetUnfollow = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ threadChannelId: targetThreadProjection.localChannelId }),
    });
    assert.equal(targetUnfollow.status, 200);
    const targetUnfollowFollowerUpdates = events.filter((event) => event.event === "thread:followers-updated");
    assert.deepEqual(
      targetUnfollowFollowerUpdates.map((event) => event.room).sort(),
      [`channel:${createdThread.threadChannelId}`, `channel:${targetThreadProjection.localChannelId}`].sort(),
      "peer-side unfollow must refresh already-open rosters without waiting for another thread message",
    );
    assert.ok(
      targetUnfollowFollowerUpdates.every((event) => (
        Object.keys(event.payload as Record<string, unknown>).length === 1
        && typeof (event.payload as { threadChannelId?: unknown }).threadChannelId === "string"
      )),
      "peer-side unfollow refresh payload stays scoped to local thread ids only",
    );
    const targetSuppression = await db.select().from(inboxSuppressionStates)
      .where(and(
        eq(inboxSuppressionStates.receiverId, targetOwner.id),
        eq(inboxSuppressionStates.targetKind, "public_thread_mention"),
        eq(inboxSuppressionStates.targetChannelId, targetThreadProjection.localChannelId),
      ));
    assert.equal(targetSuppression.length, 1, "joint unfollow must persist the local projection boundary");
    assert.ok((targetSuppression[0]?.doneThroughSeq ?? 0) > 0);

    const targetPreBoundSearch = await fetch(
      `${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=host%20thread%20reply`,
      { headers: headers(targetToken, targetServer.id) },
    );
    assert.equal(targetPreBoundSearch.status, 200);
    const targetPreBoundSearchBody = await targetPreBoundSearch.json() as {
      items: Array<{ threadChannelId?: string }>;
    };
    assert.ok(
      targetPreBoundSearchBody.items.some((item) => item.threadChannelId === targetThreadProjection.localChannelId),
      "joint unfollowed search must include canonical replies at or before the durable boundary",
    );

    const jointPostBoundReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: createdThread.threadChannelId, content: "joint-post-bound-search-token" }),
    });
    assert.equal(jointPostBoundReply.status, 200);

    const targetPostBoundSearch = await fetch(
      `${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=joint-post-bound-search-token`,
      { headers: headers(targetToken, targetServer.id) },
    );
    assert.equal(targetPostBoundSearch.status, 200);
    const targetPostBoundSearchBody = await targetPostBoundSearch.json() as {
      items: Array<{ threadChannelId?: string }>;
    };
    assert.equal(
      targetPostBoundSearchBody.items.some((item) => item.threadChannelId === targetThreadProjection.localChannelId),
      false,
      "post-bound canonical replies must not change joint unfollowed-search membership",
    );
  } finally {
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    await app.close();
  }
});


test("joint channel peer-side top-level sends use the sender projection authority for agent delivery", async ({ app }) => {
  const hostOwner = await seedUser("joint-peer-delivery-host@slock.test", "joint-peer-delivery-host");
  const targetOwner = await seedUser("joint-peer-delivery-target@slock.test", "joint-peer-delivery-target");
  const hostServer = await createServer("Joint Peer Delivery Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Peer Delivery Target", "joint-peer-delivery-target", targetOwner.id);
  const hostAgent = await createAgent(hostServer.id, "joint-peer-delivery-host-agent", { runtime: "codex" });
  const targetAgent = await createAgent(targetServer.id, "joint-peer-delivery-target-agent", { runtime: "codex" });
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "peer-delivery-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(targetProjection.id, targetAgent.id);

  const deliveries: Array<{
    agentId: string;
    message: { channel_id?: string; content: string };
    options?: { adminAuthority?: boolean };
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { channel_id?: string; content: string },
      options?: { adminAuthority?: boolean },
    ) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message, options) => {
    deliveries.push({ agentId, message, options });
  };

  const peerTopLevelMention = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({
      channelId: targetProjection.id,
      content: `peer top-level hello @${hostAgent.name}`,
      mentions: [
        { type: "agent", id: hostAgent.id, name: hostAgent.name },
      ],
    }),
  });
  assert.equal(peerTopLevelMention.status, 200);
  await peerTopLevelMention.json();

  const hostAgentDelivery = deliveries.find((delivery) => (
    delivery.agentId === hostAgent.id
    && delivery.message.content === `peer top-level hello @${hostAgent.name}`
  ));
  assert.ok(hostAgentDelivery, "peer-side joint top-level mention should deliver to host-side agents");
  assert.equal(
    hostAgentDelivery.message.channel_id,
    hostProjection.id,
    "host agent delivery should target the host local joint projection id",
  );
  assert.deepEqual(
    hostAgentDelivery.options,
    { adminAuthority: true },
    "peer-side owner/admin sends should use the sender's local projection authority instead of canonical storage server authority",
  );

  deliveries.length = 0;
  const hostTopLevelMention = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      channelId: hostProjection.id,
      content: `host top-level hello @${targetAgent.name}`,
      mentions: [
        { type: "agent", id: targetAgent.id, name: targetAgent.name },
      ],
    }),
  });
  assert.equal(hostTopLevelMention.status, 200);
  await hostTopLevelMention.json();

  const targetAgentDelivery = deliveries.find((delivery) => (
    delivery.agentId === targetAgent.id
    && delivery.message.content === `host top-level hello @${targetAgent.name}`
  ));
  assert.ok(targetAgentDelivery, "host-side joint top-level mention should deliver to peer-side agents");
  assert.equal(
    targetAgentDelivery.message.channel_id,
    targetProjection.id,
    "peer agent delivery should target the peer local joint projection id",
  );
  assert.deepEqual(
    targetAgentDelivery.options,
    { adminAuthority: true },
    "host-side owner/admin sends should use the sender's local projection authority instead of canonical storage server authority",
  );
});


test("late joint invite accept backfills existing local thread projections for the second server", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-thread-backfill-host@slock.test", "joint-thread-backfill-host");
  const targetOwner = await seedUser("joint-thread-backfill-target@slock.test", "joint-thread-backfill-target");
  const hostServer = await createServer("Joint Thread Backfill Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Thread Backfill Target", "joint-thread-backfill-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "thread-backfill-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const [parentJointProjection] = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, hostProjection.id));
  assert.ok(parentJointProjection, "host parent projection should resolve to the parent joint channel");

  const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "parent before second server accepts" }),
  });
  assert.equal(parentRes.status, 200);
  const parent = await parentRes.json() as { id: string };

  const createThreadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parent.id, content: "thread before second server accepts" }),
  });
  assert.equal(createThreadRes.status, 200);
  const createdThread = await createThreadRes.json() as { threadChannelId: string };
  const [hostThreadProjection] = await db
    .select({ jointThreadId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, createdThread.threadChannelId));
  assert.ok(hostThreadProjection, "host thread projection should exist before peer accept");

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const [targetThreadProjection] = await db
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, hostThreadProjection.jointThreadId),
      eq(jointChannelServers.serverId, targetServer.id),
    ));
  assert.ok(targetThreadProjection, "second server accept should backfill local projections for existing joint threads");

  const targetSummaries = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetSummaries.status, 200);
  const targetSummariesBody = await targetSummaries.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.equal(
    targetSummariesBody[parent.id]?.threadChannelId,
    targetThreadProjection.localChannelId,
    "second server summaries should expose the backfilled local thread projection id",
  );
  const targetThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetThreadProjection.localChannelId}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetThreadMessages.status, 200);
  const targetThreadMessagesBody = await targetThreadMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(
    targetThreadMessagesBody.messages.some((message) => (
      message.channelId === targetThreadProjection.localChannelId
      && message.content === "thread before second server accepts"
    )),
    "second server should read existing canonical thread replies through its local projection",
  );
});


test("joint channel invites can add a third active server to the shared canonical stream", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-three-host@slock.test", "joint-three-host");
  const targetOwner = await seedUser("joint-three-target@slock.test", "joint-three-target");
  const thirdOwner = await seedUser("joint-three-third@slock.test", "joint-three-third");
  const fourthOwner = await seedUser("joint-three-fourth@slock.test", "joint-three-fourth");
  const hostServer = await createServer("Joint Three Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Three Target", "joint-three-target", targetOwner.id);
  const thirdServer = await createServer("Joint Three Third", "joint-three-third", thirdOwner.id);
  const fourthServer = await createServer("Joint Three Fourth", "joint-three-fourth", fourthOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const thirdToken = await tokenForHuman(thirdOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "three-server-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptTargetRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptTargetRes.status, 200);
  const targetProjection = await acceptTargetRes.json() as { id: string };

  const oversizedInviteesRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({
      targetServerSlug: thirdServer.slug,
      invitedPeople: Array.from({ length: MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET + 1 }, (_, index) => `person-${index}@slock.test`),
    }),
  });
  assert.equal(oversizedInviteesRes.status, 400);
  const oversizedInviteesBody = await oversizedInviteesRes.json() as { error: string };
  assert.match(oversizedInviteesBody.error, /maximum of 20 invited people/);

  const inviteThirdRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({
      targetServerSlug: thirdServer.slug,
      invitedPeople: [`@${thirdOwner.name}`],
    }),
  });
  assert.equal(inviteThirdRes.status, 200);
  const targetAfterInvite = await inviteThirdRes.json() as {
    id: string;
    jointInvite: { id: string; toServerId: string; invitedUserId: string };
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
    jointPendingInvites: Array<{ fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
  };
  assert.equal(targetAfterInvite.id, targetProjection.id);
  assert.equal(targetAfterInvite.jointInvite.toServerId, thirdServer.id);
  assert.equal(targetAfterInvite.jointInvite.invitedUserId, thirdOwner.id);
  assert.ok(targetAfterInvite.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "pending"));
  assert.ok(targetAfterInvite.jointPendingInvites.some((invite) => invite.fromServerId === targetServer.id && invite.toServerId === thirdServer.id && invite.invitedUserId === thirdOwner.id));

  const acceptThirdRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${targetAfterInvite.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(thirdToken, thirdServer.id),
  });
  assert.equal(acceptThirdRes.status, 200);
  const thirdProjection = await acceptThirdRes.json() as {
    id: string;
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
  };
  assert.ok(thirdProjection.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "active" && server.isCurrentServer));

  const projectionRows = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId, localChannelId: jointChannelServers.localChannelId, serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.status, "active"));
  const parentJointIds = projectionRows
    .filter((row) => [hostProjection.id, targetProjection.id, thirdProjection.id].includes(row.localChannelId))
    .map((row) => row.jointChannelId);
  assert.equal(new Set(parentJointIds).size, 1, "all three local projections should point at the same joint channel");

  for (const [token, server, channelId, currentServerId] of [
    [hostToken, hostServer, hostProjection.id, hostServer.id],
    [targetToken, targetServer, targetProjection.id, targetServer.id],
    [thirdToken, thirdServer, thirdProjection.id, thirdServer.id],
  ] as const) {
    const listRes = await fetch(`${app.baseUrl}/api/channels/${channelId}`, {
      headers: headers(token, server.id),
    });
    assert.equal(listRes.status, 200);
    const channel = await listRes.json() as {
      jointServers: Array<{ serverId: string; status: "active"; isCurrentServer?: boolean }>;
      jointPendingInvites: unknown[];
    };
    assert.deepEqual(
      channel.jointServers.map((jointServer) => jointServer.serverId).sort(),
      [hostServer.id, targetServer.id, thirdServer.id].sort(),
    );
    assert.ok(channel.jointServers.every((jointServer) => jointServer.status === "active"));
    assert.ok(channel.jointServers.some((jointServer) => jointServer.serverId === currentServerId && jointServer.isCurrentServer));
    assert.deepEqual(channel.jointPendingInvites, []);
  }

  const hostAgent = await createAgent(hostServer.id, "joint-three-host-agent", { runtime: "codex" });
  const targetAgent = await createAgent(targetServer.id, "joint-three-target-agent", { runtime: "codex" });
  const thirdAgent = await createAgent(thirdServer.id, "joint-three-third-agent", { runtime: "codex" });
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(targetProjection.id, targetAgent.id);
  await addAgent(thirdProjection.id, thirdAgent.id);

  assert.deepEqual(
    (await listJointActivityProjectionChannelIdsForAgent(thirdAgent.id, thirdServer.id)).sort(),
    [hostProjection.id, targetProjection.id].sort(),
    "third-server agent activity should fan out to the first two local projection channel rooms",
  );

  for (const [token, server, channelId] of [
    [hostToken, hostServer, hostProjection.id],
    [targetToken, targetServer, targetProjection.id],
    [thirdToken, thirdServer, thirdProjection.id],
  ] as const) {
    const membersRes = await fetch(`${app.baseUrl}/api/channels/${channelId}/members`, {
      headers: headers(token, server.id),
    });
    assert.equal(membersRes.status, 200);
    const membersBody = await membersRes.json() as { agents: Array<{ id: string }> };
    assert.deepEqual(
      membersBody.agents.map((agent) => agent.id).sort(),
      [hostAgent.id, targetAgent.id, thirdAgent.id].sort(),
      "three-server joint member lists should include agents from every active projection",
    );
  }

  const inviteFourthRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      targetServerSlug: fourthServer.slug,
      invitedPeople: [`@${fourthOwner.name}`],
    }),
  });
  assert.equal(inviteFourthRes.status, 400);
  const inviteFourthBody = await inviteFourthRes.json() as { error: string };
  assert.match(inviteFourthBody.error, /maximum of 3 servers/);

  const thirdMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(thirdToken, thirdServer.id),
    body: JSON.stringify({ channelId: thirdProjection.id, content: "hello from third server" }),
  });
  assert.equal(thirdMessage.status, 200);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200);
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(hostMessagesBody.messages.some((message) => message.channelId === hostProjection.id && message.content === "hello from third server"));
  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200);
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(targetMessagesBody.messages.some((message) => message.channelId === targetProjection.id && message.content === "hello from third server"));
});


test("joint channel create requires an invite server slug", async ({ app }) => {
  const owner = await seedUser("joint-required-host@slock.test", "joint-required-host");
  const server = await createServer("Joint Required Host", "joint-required-host", owner.id);
  const token = await tokenForHuman(owner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({
      name: "missing-server",
      visibility: "joint",
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.equal(body.error, "Invite server slug is required");
});


test("joint channel create requires at least one invited person", async ({ app }) => {
  const hostOwner = await seedUser("joint-required-person-host@slock.test", "joint-required-person-host");
  const targetOwner = await seedUser("joint-required-person-target@slock.test", "joint-required-person-target");
  const hostServer = await createServer("Joint Required Person Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Required Person Target", "joint-required-person-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "missing-person",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.equal(body.error, "At least one invited person is required");
});


test("joint channel create only allows target server admins as invited people", async ({ app }) => {
  const hostOwner = await seedUser("joint-admin-only-host@slock.test", "joint-admin-only-host");
  const targetOwner = await seedUser("joint-admin-only-target-owner@slock.test", "joint-admin-only-target-owner");
  const targetMember = await seedUser("joint-admin-only-target-member@slock.test", "joint-admin-only-target-member");
  const hostServer = await createServer("Joint Admin Only Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Admin Only Target", "joint-admin-only-target", targetOwner.id);
  await addMember(targetServer.id, targetMember.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "member-invite-blocked",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [targetMember.email],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.match(body.error, /target server admin/);
});


test("joint channel create permanently allows one Free channel and Pro channels after upgrade", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-pro-host@slock.test", "joint-pro-host");
    const targetOwner = await seedUser("joint-pro-target@slock.test", "joint-pro-target");
    const hostServer = await createServer("Joint Pro Host", "joint-pro-host", hostOwner.id);
    const targetServer = await createServer("Joint Pro Target", "joint-pro-target", targetOwner.id);
    // Exercise the permanent Free allowance: createServer defaults to founder.
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, hostServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);

    const trialAllowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "free-allowed-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(trialAllowedRes.status, 200);

    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, hostServer.id));

    const allowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "allowed-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(allowedRes.status, 200);
  } finally {
    await app.close();
  }
});


test("concurrent Joint Channel creates permanently allow one Free success and one localized limit code", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-free-host@slock.test", "joint-free-host");
    const targetOwner = await seedUser("joint-free-target@slock.test", "joint-free-target");
    const hostServer = await createServer("Joint Free Host", "joint-free-host", hostOwner.id);
    const targetServer = await createServer("Joint Free Target", "joint-free-target", targetOwner.id);
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, hostServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);
    const create = (name: string) => fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name,
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });

    const responses = await Promise.all([
      create("free-joint-a"),
      create("free-joint-b"),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
    const second = responses.find((response) => response.status === 403);
    assert.ok(second);
    assert.deepEqual(await second.json(), {
      error: "Creating a second Joint Channel requires the Pro plan.",
      code: "joint_channel_free_limit_reached",
    });
  } finally {
    await app.close();
  }
});


test("accepting a Pro-hosted Joint Channel does not consume a Free target's permanent host allowance", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-pro-inviter@slock.test", "joint-pro-inviter");
    const targetOwner = await seedUser("joint-free-invitee@slock.test", "joint-free-invitee");
    const nextTargetOwner = await seedUser("joint-permanent-target@slock.test", "joint-permanent-target");
    const hostServer = await createServer("Joint Pro Inviter", "joint-pro-inviter", hostOwner.id);
    const targetServer = await createServer("Joint Free Invitee", "joint-free-invitee", targetOwner.id);
    const nextTargetServer = await createServer("Joint Permanent Target", "joint-permanent-target", nextTargetOwner.id);
    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, hostServer.id));
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, targetServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);
    const targetToken = await tokenForHuman(targetOwner.email);

    const allowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "pro-hosted-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = await allowedRes.json() as { jointInvite: { id: string } };

    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${allowedBody.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(acceptRes.status, 200);

    const targetCreateRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({
        name: "free-target-own-joint",
        visibility: "joint",
        targetServerSlug: nextTargetServer.slug,
        invitedPeople: [nextTargetOwner.email],
      }),
    });
    assert.equal(targetCreateRes.status, 200);
  } finally {
    await app.close();
  }
});

test("joint projection delivers the addChannelMembers capability to its members", async ({ app }) => {
  // The web client never inspects the channel type: it renders the add-member
  // entry from channelCapabilities.addChannelMembers alone. #7415 fixed the
  // shared predicate, so this pins the delivered payload the UI actually reads.
  const db = getDb();
  const owner = await seedUser("joint-cap-owner@slock.test", "joint-cap-owner");
  const peerOwner = await seedUser("joint-cap-peer@slock.test", "joint-cap-peer");
  const server = await createServer("Joint Cap Host", "joint-cap-host", owner.id);
  const peerServer = await createServer("Joint Cap Peer", "joint-cap-peer", peerOwner.id);

  const canonical = await createChannel(server.id, "joint-cap-storage");
  const hostProjection = await createChannel(server.id, "joint-cap-host-proj", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "joint-cap-peer-proj", undefined, "joint");
  const ordinary = await createChannel(server.id, "joint-cap-ordinary");
  await addHuman(hostProjection.id, owner.id);
  await addHuman(ordinary.id, owner.id);
  await addHuman(peerProjection.id, peerOwner.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint!.id,
      serverId: server.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: joint!.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);

  const token = await tokenForHuman(owner.email);
  const response = await fetch(`${app.baseUrl}/api/channels`, { headers: headers(token, server.id) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const list = JSON.parse(raw) as Array<Record<string, any>>;

  const jointRow = list.find((channel) => channel.id === hostProjection.id);
  const ordinaryRow = list.find((channel) => channel.id === ordinary.id);
  assert.ok(jointRow, "joint projection must appear in the channel list");
  assert.ok(ordinaryRow, "ordinary channel must appear in the channel list");
  // Without this the test would still pass if the fixture stopped producing a
  // joint projection, which is exactly how a probe rots into a vacuous assert.
  assert.equal(jointRow!.type, "joint");

  assert.equal(jointRow!.channelCapabilities?.addChannelMembers, true);
  assert.equal(ordinaryRow!.channelCapabilities?.addChannelMembers, true);
});
