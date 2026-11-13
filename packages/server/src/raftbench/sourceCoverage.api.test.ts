import { expect, vi } from "vitest";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { channels, messages } from "../db/schema";
import { sourceCoverage } from "./sourceCoverage";
const test = createApiTest();

test("coverage counts each selected source once across bounded chunks", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  // More sources than one chunk holds, plus one unselected source.
  const sources = await db.insert(channels).values(Array.from({ length: 1_051 }, (_, i) => ({ serverId: server.id, name: `coverage-${i}`, type: "channel" as const }))).returning();
  const selected = sources.slice(0, -1).map(s => s.id);
  const from = new Date("2026-07-20T00:00:00Z"), to = new Date("2026-07-21T00:00:00Z");
  await db.insert(messages).values(Array.from({ length: 2_400 }, (_, i) => ({
    channelId: sources[i % 7 === 0 ? 1_050 : (i * 13) % 1_050].id,
    senderId: owner.id, senderType: "user" as const, content: `Synthetic coverage ${i}`,
    createdAt: new Date(from.getTime() + ((i % 5) - 1) * 12 * 3_600_000 + i * 1_000),
    deletedAt: i % 11 === 0 ? from : null,
  })));
  const [expected] = await db.select({
    totalMessages: sql<number>`count(*)`.mapWith(Number),
    windowMessages: sql<number>`count(*) FILTER (WHERE ${messages.createdAt} >= ${from.toISOString()}::timestamptz AND ${messages.createdAt} < ${to.toISOString()}::timestamptz)`.mapWith(Number),
    earliestAt: sql<string>`min(${messages.createdAt})::text`,
    latestAt: sql<string>`max(${messages.createdAt})::text`,
  }).from(messages).where(and(inArray(messages.channelId, selected), isNull(messages.deletedAt)));
  expect(expected.windowMessages).toBeGreaterThan(0);
  expect(expected.windowMessages).toBeLessThan(expected.totalMessages);
  // Duplicate ids land in different chunks and still count once.
  const coverage = await sourceCoverage(server.id, 1, [...selected, selected[0], selected[700]], from, to);
  expect(coverage).toMatchObject({ totalMessages: expected.totalMessages, windowMessages: expected.windowMessages,
    earliestAt: new Date(expected.earliestAt).toISOString(), latestAt: new Date(expected.latestAt).toISOString(),
    from: from.toISOString(), to: to.toISOString() });
  expect(await sourceCoverage(server.id, 1, [], from, to)).toMatchObject({ totalMessages: 0, windowMessages: 0, earliestAt: null, latestAt: null });
});

test("one coverage count per scope runs at a time; later views get the last finished count while it refreshes", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [source] = await db.insert(channels).values({ serverId: server.id, name: "coverage-flight", type: "channel" }).returning();
  const from = new Date("2026-07-20T00:00:00Z"), to = new Date("2026-07-21T00:00:00Z");
  const later = new Date(to.getTime() + 60 * 60_000), sameBucket = new Date(to.getTime() + 1_000);
  // A view whose window end moved on still joins the unfinished count instead of starting another.
  const first = sourceCoverage(server.id, 1, [source.id], from, to);
  const joined = sourceCoverage(server.id, 1, [source.id], from, later);
  await Promise.allSettled([first, joined]);
  expect(joined).toBe(first);
  const counted = await first;
  expect(await sourceCoverage(server.id, 1, [source.id], from, sameBucket)).toBe(counted);
  // A later window is served the finished count at once; the refresh replaces it afterwards.
  await db.insert(messages).values({ channelId: source.id, senderId: owner.id, senderType: "user", content: "Synthetic later", createdAt: new Date(to.getTime() + 30 * 60_000) });
  expect(await sourceCoverage(server.id, 1, [source.id], from, later)).toBe(counted);
  await vi.waitFor(async () => expect(await sourceCoverage(server.id, 1, [source.id], from, later)).toMatchObject({ to: later.toISOString(), totalMessages: 1, windowMessages: 1 }));
  // Another revision is another scope and starts from its own count.
  expect(await sourceCoverage(server.id, 2, [source.id], from, later)).toMatchObject({ to: later.toISOString(), totalMessages: 1 });
});
