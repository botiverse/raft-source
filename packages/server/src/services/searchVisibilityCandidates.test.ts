import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { asServerId } from "@botiverse/raft-shared";
import {
  buildMessageSearchStatement,
  buildVisibleConversationChannelsSql,
  buildVisibleConversationRowCheckSql,
  searchMessagesForAgent,
  searchMessagesForUser,
} from "./searchService";
import { intersectVisibleRoots, visibleRootChannelIds, type VisibleRoots } from "./visibilityService";

// Search resolves a thread's parent channel from channels.parent_channel_id
// (0297, trigger-derived) instead of looking up every thread's parent message,
// and takes its visible roots from the visibility entry (visibilityService).
// These tests run the frozen pre-0297 visibility SQL (parent-message join,
// below) and the current builders over the same data for every visibility
// shape, and require identical results except for the intended changes: a
// thread whose parent message lives in another server's channel is no longer
// visible (0 such threads on prod when this shipped), and an explicit root
// list (the guest prefilter) now narrows the visible set instead of replacing
// it, so it cannot reveal a private channel the viewer is not in.
//
// Note for reviewers of search changes: the breadth probe only runs EXPLAIN,
// so it cannot see the cost of building visible_channels; only EXPLAIN ANALYZE
// on realistic data does.

type Principal =
  | { kind: "agent"; serverId: string; agentId: string }
  | { kind: "user"; serverId: string; userId: string; allowedRootChannelIds?: readonly string[] };

async function rootsOf(principal: Principal): Promise<VisibleRoots> {
  const roots = await visibleRootChannelIds(principal.kind === "agent"
    ? { type: "agent", id: principal.agentId, serverId: asServerId(principal.serverId) }
    : { type: "user", id: principal.userId, serverId: asServerId(principal.serverId) });
  return principal.kind === "user" && principal.allowedRootChannelIds
    ? intersectVisibleRoots(roots, principal.allowedRootChannelIds)
    : roots;
}

function legacyVisibleSql(principal: Principal): SQL {
  return principal.kind === "agent"
    ? legacyAgentVisibleChannelsSql({ serverId: principal.serverId, agentId: principal.agentId })
    : legacyUserVisibleChannelsSql({ serverId: principal.serverId, userId: principal.userId, allowedRootChannelIds: principal.allowedRootChannelIds });
}

// Frozen copies of the visibility builders before parent_channel_id (as of
// 221aa3d24^): the reference the current builders must match.
function legacyUserVisibleChannelsSql(params: {
  serverId: string;
  userId: string;
  allowedRootChannelIds?: readonly string[];
}): SQL {
  const explicitRootFilter = params.allowedRootChannelIds
    ? params.allowedRootChannelIds.length === 0
      ? sql`FALSE`
      : sql`COALESCE(parent_channels.id, visible_channels.id) IN (${sql.join(params.allowedRootChannelIds.map((id) => sql`${id}`), sql`, `)})`
    : null;
  return sql`
    SELECT
      visible_channels.id AS id,
      COALESCE(parent_channels.id, visible_channels.id) AS parent_channel_id
    FROM channels visible_channels
    LEFT JOIN messages pm
      ON visible_channels.type = 'thread'
     AND pm.id = visible_channels.parent_message_id
    LEFT JOIN channels parent_channels
      ON parent_channels.id = pm.channel_id
    JOIN server_members sm
      ON sm.server_id = visible_channels.server_id
     AND sm.user_id = ${params.userId}
    LEFT JOIN channel_humans ch
      ON ch.channel_id = visible_channels.id
     AND ch.user_id = ${params.userId}
    LEFT JOIN channel_humans pch
      ON pch.channel_id = parent_channels.id
     AND pch.user_id = ${params.userId}
    WHERE visible_channels.server_id = ${params.serverId}
      AND visible_channels.deleted_at IS NULL
      AND parent_channels.deleted_at IS NULL
      AND ${explicitRootFilter ?? sql`(
        visible_channels.type = 'channel'
        OR (visible_channels.type IN ('private', 'dm') AND ch.user_id IS NOT NULL)
        OR (
          visible_channels.type = 'thread'
          AND (
            parent_channels.type = 'channel'
            OR (parent_channels.type IN ('private', 'dm') AND pch.user_id IS NOT NULL)
          )
        )
      )`}
  `;
}

function legacyAgentVisibleChannelsSql(params: {
  serverId: string;
  agentId: string;
}): SQL {
  return sql`
    SELECT
      public_channels.id AS id,
      public_channels.id AS parent_channel_id
    FROM channels public_channels
    WHERE public_channels.server_id = ${params.serverId}
      AND public_channels.type = 'channel'
      AND public_channels.deleted_at IS NULL

    UNION ALL

    SELECT
      member_channels.id AS id,
      member_channels.id AS parent_channel_id
    FROM channel_agents ca
    JOIN channels member_channels
      ON member_channels.id = ca.channel_id
    WHERE ca.agent_id = ${params.agentId}
      AND member_channels.server_id = ${params.serverId}
      AND member_channels.type IN ('private', 'dm')
      AND member_channels.deleted_at IS NULL

    UNION ALL

    SELECT
      tc.id AS id,
      pc.id AS parent_channel_id
    FROM channels tc
    JOIN messages pm
      ON pm.id = tc.parent_message_id
    JOIN channels pc
      ON pc.id = pm.channel_id
    WHERE tc.server_id = ${params.serverId}
      AND tc.type = 'thread'
      AND pc.type = 'channel'
      AND tc.deleted_at IS NULL
      AND pc.deleted_at IS NULL

    UNION ALL

    SELECT
      tc.id AS id,
      pc.id AS parent_channel_id
    FROM channels tc
    JOIN messages pm
      ON pm.id = tc.parent_message_id
    JOIN channels pc
      ON pc.id = pm.channel_id
    JOIN channel_agents pca
      ON pca.channel_id = pc.id
     AND pca.agent_id = ${params.agentId}
    WHERE tc.server_id = ${params.serverId}
      AND tc.type = 'thread'
      AND pc.type IN ('private', 'dm')
      AND tc.deleted_at IS NULL
      AND pc.deleted_at IS NULL
  `;
}

test("parent_channel_id visibility equals the parent-message join, minus cross-server parents", async ({ db }) => {
  const [owner, outsider] = await db.insert(users).values([
    { email: "svc-owner@test.com", name: "svcOwner", passwordHash: "x", emailVerified: true },
    { email: "svc-outsider@test.com", name: "svcOutsider", passwordHash: "x", emailVerified: true },
  ]).returning();
  const [server, otherServer] = await db.insert(servers).values([
    { name: "Visibility", slug: "svc-visibility", ownerId: owner.id },
    { name: "Other Tenant", slug: "svc-other-tenant", ownerId: outsider.id },
  ]).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: otherServer.id, userId: outsider.id, role: "owner" },
    { serverId: otherServer.id, userId: owner.id, role: "member" },
  ]);
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "svc-agent", status: "active" }).returning();

  const [pub, pubDeleted, privMember, privOther, dmMember, joint, otherPub] = await db.insert(channels).values([
    { serverId: server.id, name: "svc-pub", type: "channel" },
    { serverId: server.id, name: "svc-pub-deleted", type: "channel", deletedAt: new Date() },
    { serverId: server.id, name: "svc-priv-member", type: "private" },
    { serverId: server.id, name: "svc-priv-other", type: "private" },
    { serverId: server.id, name: "svc-dm", type: "dm" },
    { serverId: server.id, name: "svc-joint", type: "joint" },
    { serverId: otherServer.id, name: "svc-other-pub", type: "channel" },
  ]).returning();
  await db.insert(channelAgents).values([
    { channelId: privMember.id, agentId: agent.id },
    { channelId: dmMember.id, agentId: agent.id },
  ]);
  await db.insert(channelHumans).values([
    { channelId: privMember.id, userId: owner.id },
    { channelId: dmMember.id, userId: owner.id },
  ]);

  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const post = async (channelId: string, text: string, sender: { type: "user" | "agent"; id: string } = { type: "user", id: owner.id }) => {
    clock += 60_000;
    const [row] = await db.insert(messages).values({
      channelId, senderType: sender.type, senderId: sender.id, content: text, searchText: text, createdAt: new Date(clock),
    }).returning();
    return row;
  };
  const thread = async (name: string, parentChannelId: string, opts: { deleted?: boolean; serverId?: string } = {}) => {
    const parent = await post(parentChannelId, `${name} parent needle`);
    const [t] = await db.insert(channels).values({
      serverId: opts.serverId ?? server.id, name, type: "thread", parentMessageId: parent.id,
      deletedAt: opts.deleted ? new Date() : null,
    }).returning();
    // The write path keeps "a thread's parent carries its thread_id".
    await db.update(messages).set({ threadId: t.id }).where(eq(messages.id, parent.id));
    return t;
  };

  const threads = {
    pub: await thread("svc-t-pub", pub.id),
    pubDeletedThread: await thread("svc-t-pub-deleted", pub.id, { deleted: true }),
    underDeletedParent: await thread("svc-t-under-deleted", pubDeleted.id),
    privMember: await thread("svc-t-priv-member", privMember.id),
    privOther: await thread("svc-t-priv-other", privOther.id),
    dm: await thread("svc-t-dm", dmMember.id),
    joint: await thread("svc-t-joint", joint.id),
    // A thread row in this server whose parent message lives in another tenant.
    crossParent: await thread("svc-t-cross-parent", otherPub.id),
    other: await thread("svc-t-other", otherPub.id, { serverId: otherServer.id }),
    noMatch: await thread("svc-t-no-match", pub.id),
  };
  // Emulate pre-CHECK orphan history; current writes must satisfy the cache invariant.
  await db.execute(sql`ALTER TABLE channels DROP CONSTRAINT channels_parent_message_requires_channel`);
  const [orphan] = await db.insert(channels).values({
    serverId: server.id, name: "svc-t-orphan", type: "thread", parentMessageId: "00000000-0000-4000-8000-00000000dead",
  }).returning();

  for (const channel of [pub, pubDeleted, privMember, privOther, dmMember, joint, otherPub, orphan]) {
    await post(channel.id, `needle haystack in ${channel.name}`);
  }
  for (const [label, t] of Object.entries(threads)) {
    if (label === "noMatch") await post(t.id, "unrelated reply");
    else await post(t.id, `needle haystack reply in ${t.name}`);
  }

  // A second sender, only in some threads and with a time gap, so sender and
  // date bounds each leave some threads without a qualifying message.
  const agentSender = { type: "agent" as const, id: agent.id };
  await post(threads.pub.id, "needle agent early", agentSender);
  await post(threads.dm.id, "needle agent early dm", agentSender);
  const midpoint = new Date(clock + 30_000);
  await post(threads.privMember.id, "needle agent late", agentSender);
  await post(threads.crossParent.id, "needle agent late cross", agentSender);
  await post(pub.id, "needle agent late root", agentSender);

  // A deleted private channel the principals still belong to: its thread stays hidden.
  const [privDeleted] = await db.insert(channels).values({ serverId: server.id, name: "svc-priv-deleted", type: "private", deletedAt: new Date() }).returning();
  await db.insert(channelAgents).values({ channelId: privDeleted.id, agentId: agent.id });
  await db.insert(channelHumans).values({ channelId: privDeleted.id, userId: owner.id });
  const underDeletedPrivate = await thread("svc-t-under-deleted-private", privDeleted.id);
  await post(underDeletedPrivate.id, "needle haystack reply under deleted private");

  // A parent moved to another channel (conversion) carries its thread along.
  const moved = await thread("svc-t-moved", pub.id);
  await post(moved.id, "needle haystack reply in moved");
  const [movedThread] = await db.select({ parentMessageId: channels.parentMessageId }).from(channels).where(eq(channels.id, moved.id));
  await db.update(messages).set({ channelId: privMember.id }).where(eq(messages.id, movedThread!.parentMessageId!));

  const principals: Array<{ label: string; principal: Principal }> = [
    { label: "agent", principal: { kind: "agent", serverId: server.id, agentId: agent.id } },
    { label: "user", principal: { kind: "user", serverId: server.id, userId: owner.id } },
    { label: "user-roots", principal: { kind: "user", serverId: server.id, userId: owner.id, allowedRootChannelIds: [pub.id, privOther.id, pubDeleted.id] } },
    { label: "user-no-roots", principal: { kind: "user", serverId: server.id, userId: owner.id, allowedRootChannelIds: [] } },
    { label: "non-member-user", principal: { kind: "user", serverId: server.id, userId: outsider.id } },
  ];
  const queries: Array<string | null> = [null, "needle", "needle haystack", "unrelated", "absent-term"];
  const channelFilters = [undefined, pub.id, privMember.id, dmMember.id, otherPub.id, threads.pub.id, threads.privOther.id, moved.id];
  const filterSets: Array<{ senderId?: string; after?: Date; before?: Date }> = [{}, { senderId: agent.id }, { senderId: owner.id, after: midpoint }, { before: midpoint }];
  const otherTenantChannelIds = new Set([otherPub.id, threads.other.id]);
  const intendedDrop = (label: string) => new Set([
    threads.crossParent.id,
    // The root list narrows: the owner is not in privOther, so listing it does not reveal it.
    ...(label === "user-roots" ? [privOther.id, threads.privOther.id] : []),
  ]);

  let comparisons = 0;
  let droppedRows = 0;
  let relevanceRows = 0;
  let recentTextRows = 0;
  let timelineWalkRows = 0;
  for (const { label, principal } of principals) {
    const roots = await rootsOf(principal);
    const visibleSql = () => buildVisibleConversationChannelsSql(roots);
    const rowCheckSql = () => buildVisibleConversationRowCheckSql(roots);
    const drop = intendedDrop(label);
    for (const text of queries) {
      const tsQuery = text ? sql`plainto_tsquery('simple', ${text})` : null;
      for (const sort of (text ? ["relevance", "recent"] : ["recent"]) as Array<"relevance" | "recent">) {
        for (const channelId of channelFilters) {
          for (const filters of filterSets) {
            const params = { serverId: server.id, channelId, ...filters, sort, limit: 100, offset: 0 };
            const run = async (vis: SQL) =>
              (await db.execute(buildMessageSearchStatement(vis, params, tsQuery))).rows as Array<{ id: string; channelId: string; parentChannelId: string }>;
            const legacy = await run(legacyVisibleSql(principal));
            const current = await run(visibleSql());
            const expected = legacy.filter((row) => !drop.has(row.channelId));
            droppedRows += legacy.length - expected.length;
            assert.deepEqual(
              current.map((row) => row.id),
              expected.map((row) => row.id),
              `${label} / "${text ?? ""}" / ${sort} / channel=${channelId ?? "none"} / ${JSON.stringify(filters)}: must equal the parent-message join`,
            );
            for (const row of current) {
              assert.ok(!otherTenantChannelIds.has(row.channelId), `${label}: another tenant's channel ${row.channelId} leaked`);
            }
            if (channelId) {
              // The channel filter narrows messages to the channel and its
              // threads before visibility; it must keep exactly the unfiltered
              // rows in that channel or under it.
              const unfiltered = (await db.execute(buildMessageSearchStatement(visibleSql(), { ...params, channelId: undefined }, tsQuery))).rows as Array<{ id: string; channelId: string; parentChannelId: string }>;
              assert.ok(unfiltered.length < params.limit, "fixture: the unfiltered result fits in one page");
              assert.deepEqual(
                current.map((row) => row.id).sort(),
                unfiltered.filter((row) => row.channelId === channelId || row.parentChannelId === channelId).map((row) => row.id).sort(),
                `${label} / "${text ?? ""}" / ${sort} / channel=${channelId} / ${JSON.stringify(filters)}: channel filter must equal filtering the unfiltered rows`,
              );
            }
            if (sort === "recent" && tsQuery) {
              // Recent sort takes text matches first for a bounded term and
              // walks newest first otherwise (the agent walk through the
              // row-check visible set): the same page either way.
              const textFirst = (await db.execute(buildMessageSearchStatement(visibleSql(), { ...params, recentPlan: "text_matches_first" }, tsQuery))).rows as Array<{ id: string }>;
              assert.deepEqual(
                textFirst.map((row) => row.id),
                current.map((row) => row.id),
                `${label} / "${text}" / channel=${channelId ?? "none"} / ${JSON.stringify(filters)}: text-first recent must equal the walk, in order`,
              );
              const rowCheckWalk = (await db.execute(buildMessageSearchStatement(rowCheckSql(), { ...params, recentPlan: "walk" }, tsQuery))).rows as Array<{ id: string }>;
              assert.deepEqual(
                rowCheckWalk.map((row) => row.id),
                current.map((row) => row.id),
                `${label} / "${text}" / channel=${channelId ?? "none"} / ${JSON.stringify(filters)}: the row-check walk must equal the walk, in order`,
              );
              if (!channelId) {
                // A dense term without a channel filter walks this server's
                // timeline (0310, trigger-maintained in this fixture): same page, in order.
                const timelineWalk = (await db.execute(buildMessageSearchStatement(rowCheckSql(), { ...params, recentPlan: "server_timeline_walk" }, tsQuery))).rows as Array<{ id: string }>;
                assert.deepEqual(
                  timelineWalk.map((row) => row.id),
                  current.map((row) => row.id),
                  `${label} / "${text}" / ${JSON.stringify(filters)}: the server timeline walk must equal the walk, in order`,
                );
                timelineWalkRows += timelineWalk.length;
              }
              recentTextRows += current.length;
            }
            if (sort === "relevance") {
              // Relevance collects text matches across servers before joining
              // visibility (and narrows them by the channel filter on its own);
              // it must keep exactly the rows the visibility-first shape finds.
              const visibilityFirst = (await db.execute(buildMessageSearchStatement(visibleSql(), { ...params, sort: "recent" }, tsQuery))).rows as Array<{ id: string }>;
              assert.deepEqual(
                current.map((row) => row.id).sort(),
                visibilityFirst.map((row) => row.id).sort(),
                `${label} / "${text}" / channel=${channelId ?? "none"} / ${JSON.stringify(filters)}: text-first relevance must match the visibility-first rows`,
              );
              relevanceRows += current.length;
            }
            comparisons += 1;
          }
        }
      }
    }
  }
  assert.equal(comparisons, principals.length * (1 + 4 * 2) * channelFilters.length * filterSets.length);
  assert.ok(droppedRows > 0, "fixture: the cross-server parent thread was visible to the parent-message join");
  assert.ok(relevanceRows > 0, "fixture: relevance search found rows to compare");
  assert.ok(recentTextRows > 0, "fixture: recent text search found rows to compare");
  assert.ok(timelineWalkRows > 0, "fixture: the server timeline walk found rows to compare");

  // The visible set itself, row for row: identical except the intended drops,
  // and the row-check form (recent walks) is the same set as the UNION form.
  const visibleRows = async (vis: SQL) =>
    ((await db.execute(sql`SELECT id::text AS id, parent_channel_id::text AS parent FROM (${vis}) v`)).rows as Array<{ id: string; parent: string }>)
      .map((row) => `${row.id}:${row.parent}`).sort();
  for (const { label, principal } of principals) {
    const roots = await rootsOf(principal);
    const legacy = await visibleRows(legacyVisibleSql(principal));
    const current = await visibleRows(buildVisibleConversationChannelsSql(roots));
    const drop = intendedDrop(label);
    assert.deepEqual(current, legacy.filter((row) => !drop.has(row.slice(0, row.indexOf(":")))), `${label}: visible set`);
    assert.deepEqual(await visibleRows(buildVisibleConversationRowCheckSql(roots)), current, `${label}: row-check visible set`);
  }
  {
    const agentVisible = ((await db.execute(sql`SELECT id::text AS id, parent_channel_id::text AS parent FROM (${buildVisibleConversationChannelsSql(await rootsOf(principals[0]!.principal))}) v`)).rows as Array<{ id: string; parent: string }>);
    assert.ok(agentVisible.some((row) => row.id === moved.id && row.parent === privMember.id), "a moved parent's thread is visible under its new channel");
  }

  // The public entry points still find the expected threads and nothing from the other tenant.
  const agentResult = await searchMessagesForAgent({ serverId: server.id, agentId: agent.id, query: "needle haystack reply", historyCutoff: undefined, sort: "recent", limit: 50 });
  const agentChannels = new Set(agentResult.results.map((row) => row.channelId));
  assert.ok(agentChannels.has(threads.pub.id) && agentChannels.has(threads.privMember.id) && agentChannels.has(threads.dm.id));
  assert.ok(!agentChannels.has(threads.privOther.id) && !agentChannels.has(threads.other.id) && !agentChannels.has(threads.pubDeletedThread.id));
  assert.ok(!agentChannels.has(threads.crossParent.id), "a thread under another server's channel is not visible");
  const userResult = await searchMessagesForUser({ serverId: server.id, userId: owner.id, query: "needle haystack reply", historyCutoff: undefined, sort: "recent", limit: 50 });
  const userChannels = new Set(userResult.results.map((row) => row.channelId));
  assert.ok(userChannels.has(threads.pub.id) && userChannels.has(threads.privMember.id));
  assert.ok(!userChannels.has(threads.other.id) && !userChannels.has(threads.underDeletedParent.id) && !userChannels.has(threads.crossParent.id));
});
