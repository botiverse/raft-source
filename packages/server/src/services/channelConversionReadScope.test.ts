import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { dbTest } from "../test/integration/dbTest";
import { channelConversionJobs, channels, jointChannels, jointChannelServers, messages } from "../db/schema";
import {
  conversionReadChannelIdsQuery,
  conversionReadChannelPredicate,
  resolveConversionReadChannelIds,
  resolvedConversionReadChannelPredicate,
} from "./channelConversionReadScope";
import { getMessageContext, listMessages, listMessagesWithCoverage } from "./messageService";

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderedQuerySql(query: unknown): string | null {
  if (!query || typeof query !== "object" || !("toSQL" in query) || typeof query.toSQL !== "function") {
    return null;
  }
  return normalizeSql(String(query.toSQL().sql));
}

test("dynamic conversion read scope remains statement-local", () => {
  const rendered = normalizeSql(new PgDialect().sqlToQuery(sql`
    SELECT *
    FROM ${messages}
    WHERE ${conversionReadChannelPredicate(messages.channelId, "11111111-1111-4111-8111-111111111111")}
    ORDER BY ${messages.seq} DESC
    LIMIT 1
  `).sql);

  assert.match(rendered, /"messages"\."channel_id" IN \( SELECT \$1::uuid AS id UNION/);
  assert.match(rendered, /ORDER BY "messages"\."seq" DESC LIMIT 1/);
});

test("conversion scope resolver consumes the named id column", async () => {
  let rendered = "";
  const executor = {
    execute: async (query: ReturnType<typeof conversionReadChannelIdsQuery>) => {
      rendered = normalizeSql(new PgDialect().sqlToQuery(query).sql);
      return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
    },
  };

  const ids = await resolveConversionReadChannelIds(
    executor as Parameters<typeof resolveConversionReadChannelIds>[0],
    "11111111-1111-4111-8111-111111111111",
  );

  assert.deepEqual(ids, ["11111111-1111-4111-8111-111111111111"]);
  assert.match(rendered, /^SELECT \$1::uuid AS id UNION/);
});

dbTest("message history consumes resolved ids as an indexable predicate", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: "quiet channel message" });
  let loadedPageSql = "";

  const rows = await listMessages(channel.id, 1, undefined, undefined, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (queryName === "messages.channel.loaded_page" && rendered) loadedPageSql = rendered;
      return query;
    },
  });

  assert.deepEqual(rows.map((row) => row.id), [message.id]);
  assert.match(loadedPageSql, /where "messages"\."channel_id" = \$1 order by "messages"\."seq" desc limit \$2/);
  assert.doesNotMatch(loadedPageSql, /channel_id" IN \( SELECT/);

  const coverageSql: string[] = [];
  const page = await listMessagesWithCoverage(channel.id, 1, undefined, undefined, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (
        rendered
        && (queryName === "messages.channel.loaded_page" || queryName === "messages.channel.coverage_bound")
      ) {
        coverageSql.push(rendered);
      }
      return query;
    },
  });

  assert.deepEqual(page.messages.map((row) => row.id), [message.id]);
  // The page and its coverage bounds are one statement; the page and each
  // bound read the channel through the equality predicate.
  assert.equal(coverageSql.length, 1);
  assert.equal(coverageSql[0]!.match(/where "messages"\."channel_id" = \$\d+/g)?.length, 3);
  // Each bound is a plain max() subquery (one backward index probe); a max()
  // with a FILTER clause would read the channel's whole index.
  assert.equal(coverageSql[0]!.match(/\(select max\("seq"\) from "messages" where/g)?.length, 2);
  assert.doesNotMatch(coverageSql[0]!, /filter \(where/i);
  assert.doesNotMatch(coverageSql[0]!, /channel_id" IN \( SELECT/);
});

test("resolved single-channel history scope compiles to an equality index condition", () => {
  const rendered = normalizeSql(new PgDialect().sqlToQuery(sql`
    SELECT *
    FROM ${messages}
    WHERE ${resolvedConversionReadChannelPredicate(messages.channelId, ["11111111-1111-4111-8111-111111111111"])}
    ORDER BY ${messages.seq} DESC
    LIMIT 1
  `).sql);

  assert.match(rendered, /WHERE "messages"\."channel_id" = \$1 ORDER BY "messages"\."seq" DESC LIMIT 1/);
  assert.doesNotMatch(rendered, /channel_id" IN \( SELECT/);
});

dbTest("message context previous/next consume resolved ids as an indexable predicate", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const older = await seed.message({ channel, author: owner, content: "older" });
  const target = await seed.message({ channel, author: owner, content: "target" });
  const newer = await seed.message({ channel, author: owner, content: "newer" });
  let previousSql = "";
  let nextSql = "";

  const aroundLimit1 = await getMessageContext(target.id, 0, 0, undefined, {
    traceQuery: async (queryName, work) => {
      const query = work();
      const rendered = renderedQuerySql(query);
      if (queryName === "messages.context.previous" && rendered) previousSql = rendered;
      if (queryName === "messages.context.next" && rendered) nextSql = rendered;
      return query;
    },
  });

  assert.equal(aroundLimit1?.targetMessageId, target.id);
  assert.deepEqual(aroundLimit1?.messages.map((row) => row.id), [target.id]);
  assert.match(
    previousSql,
    /where \("messages"\."channel_id" = \$1 and "messages"\."seq" < \$2\) order by "messages"\."seq" desc limit \$3/,
  );
  assert.doesNotMatch(previousSql, /channel_id" IN \( SELECT/);
  assert.match(
    nextSql,
    /where \("messages"\."channel_id" = \$1 and "messages"\."seq" > \$2\) order by "messages"\."seq" limit \$3/,
  );
  assert.doesNotMatch(nextSql, /channel_id" IN \( SELECT/);

  const aroundWindow = await getMessageContext(target.id, 1, 1);
  assert.deepEqual(aroundWindow?.messages.map((row) => row.id), [older.id, target.id, newer.id]);
});

dbTest("joint thread projections of a converted channel resolve to their canonical thread", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const source = await seed.channel({ server, members: [owner] });
  const canonical = await seed.channel({ server, members: [owner] });
  const plain = await seed.channel({ server, members: [owner] });
  await db.insert(channelConversionJobs).values({
    serverId: server.id,
    sourceChannelId: source.id,
    sourceChannelType: "channel",
    status: "done",
    phase: "done",
    state: "succeeded",
    canonicalChannelId: canonical.id,
    createdByUserId: owner.id,
  });

  async function jointThread(role: "host" | "participant", status: "active" | "disconnected") {
    const canonicalParent = await seed.message({ channel: canonical, author: owner, content: `canonical ${role}` });
    const localParent = await seed.message({ channel: source, author: owner, content: `local ${role}` });
    const [canonicalThread, localThread] = await db.insert(channels).values([
      { serverId: server.id, name: `thread-${canonicalParent.id}`, type: "thread", parentMessageId: canonicalParent.id },
      { serverId: server.id, name: `thread-${localParent.id}`, type: "thread", parentMessageId: localParent.id },
    ]).returning();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalThread!.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
    }).returning();
    await db.insert(jointChannelServers).values({
      jointChannelId: joint!.id,
      serverId: server.id,
      localChannelId: localThread!.id,
      role,
      status,
      joinedByUserId: owner.id,
    });
    return { canonicalThread: canonicalThread!, localThread: localThread! };
  }

  const resolveSorted = async (channelId: string) => (await resolveConversionReadChannelIds(db, channelId)).sort();

  const hosted = await jointThread("host", "active");
  const pair = [hosted.localThread.id, hosted.canonicalThread.id].sort();
  assert.deepEqual(await resolveSorted(hosted.localThread.id), pair);
  assert.deepEqual(await resolveSorted(hosted.canonicalThread.id), pair);

  // A peer's projection of the same joint must not inherit the host pair.
  const peerServer = await seed.server({ owner });
  const peerChannel = await seed.channel({ server: peerServer, members: [owner] });
  const peerParent = await seed.message({ channel: peerChannel, author: owner, content: "peer parent" });
  const [peerThread] = await db.insert(channels).values({
    serverId: peerServer.id, name: `thread-${peerParent.id}`, type: "thread", parentMessageId: peerParent.id,
  }).returning();
  const [hostedJoint] = await db.select({ id: jointChannels.id }).from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, hosted.canonicalThread.id));
  await db.insert(jointChannelServers).values({
    jointChannelId: hostedJoint!.id,
    serverId: peerServer.id,
    localChannelId: peerThread!.id,
    role: "participant",
    status: "active",
    joinedByUserId: owner.id,
  });
  assert.deepEqual(await resolveSorted(peerThread!.id), [peerThread!.id]);
  assert.deepEqual(await resolveSorted(hosted.canonicalThread.id), pair);

  const participant = await jointThread("participant", "active");
  assert.deepEqual(await resolveSorted(participant.localThread.id), [participant.localThread.id]);
  assert.deepEqual(await resolveSorted(participant.canonicalThread.id), [participant.canonicalThread.id]);

  const disconnected = await jointThread("host", "disconnected");
  assert.deepEqual(await resolveSorted(disconnected.localThread.id), [disconnected.localThread.id]);
  assert.deepEqual(await resolveSorted(disconnected.canonicalThread.id), [disconnected.canonicalThread.id]);

  assert.deepEqual(await resolveSorted(plain.id), [plain.id]);
});
