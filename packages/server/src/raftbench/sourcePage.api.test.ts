import { expect } from "vitest";
import { and, asc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { agents, channels, messages } from "../db/schema";
import { readSourcePage } from "./sourcePage";
const test = createApiTest();

test("source pages preserve the exact global prefix across sparse sources and sender kinds", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "PageBot", runtime: "external" }).returning();
  const sources = await db.insert(channels).values(Array.from({ length: 130 }, (_, i) => ({ serverId: server.id, name: `page-${i}`, type: "channel" as const }))).returning();
  const selected = sources.slice(0, -1).map(s => s.id);
  const from = new Date("2026-07-20T00:00:00Z"), to = new Date("2026-07-21T00:00:00Z");
  await db.insert(messages).values(Array.from({ length: 260 }, (_, i) => ({
    channelId: sources[i % 4 === 0 ? 129 : i % 3].id,
    senderId: i % 3 === 0 ? owner.id : i % 3 === 1 ? agent.id : "synthetic-system",
    senderType: i % 3 === 0 ? "user" as const : i % 3 === 1 ? "agent" as const : "user" as const,
    content: `Synthetic page ${i}`,
    createdAt: i % 17 === 0 ? to : from,
    deletedAt: i % 19 === 0 ? from : null,
  })));
  let after = 0;
  let count = 0;
  for (;;) {
    const expected = await db.select().from(messages).where(and(inArray(messages.channelId, selected), gt(messages.seq, after), gte(messages.createdAt, from), lt(messages.createdAt, to), isNull(messages.deletedAt))).orderBy(asc(messages.seq)).limit(101);
    const page = await readSourcePage(db, [...selected, selected[0]], after, from, to, 101);
    expect(page.map(r => r.message.id)).toEqual(expected.map(r => r.id));
    for (const row of page) {
      if (row.message.senderId === owner.id) expect(row.userName).toBe(owner.name);
      if (row.message.senderType === "agent") expect(row.agentName).toBe("PageBot");
      if (row.message.senderId === "synthetic-system") expect(row.userName).toBeNull();
    }
    count += page.length;
    if (page.length < 101) break;
    after = page.at(-1)!.message.seq;
  }
  expect(count).toBeGreaterThan(101);
  expect(await readSourcePage(db, [], 0, from, to, 101)).toEqual([]);
});
