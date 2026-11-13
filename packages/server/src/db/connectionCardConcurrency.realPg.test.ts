/**
 * Real-PostgreSQL concurrency probe for the connection-card dedupe invariant (task #21).
 *
 * Required by @Huarong, and his reason for requiring it is the point: he ran an 8-call PGlite probe
 * and got one card, but PGlite (and a serialising test connection) cannot demonstrate PostgreSQL
 * concurrency safety. A green run there says "these calls did not overlap", not "overlapping calls
 * are safe". Only real PostgreSQL with genuinely parallel connections can answer the question.
 *
 * What is under test: `ensureMcpConnectionCard()` reads for an open card and then inserts in a
 * SEPARATE transaction. Two concurrent refusals for the same (Agent, MCP server) could both see
 * nothing and both post, giving the operator two Connect prompts for one pending thing. The fix is
 * a partial unique index on `action_cards(dedupe_key) WHERE dedupe_key IS NOT NULL AND state =
 * 'prepared'`, so the loser of the race gets 23505 and resolves to the winner's card.
 *
 * ⭐ The negative control is the part that makes this worth having: with the index dropped, the same
 * concurrent calls must produce MORE than one card. Without that half, a green result could just
 * mean the calls never actually overlapped.
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pgcards -e POSTGRES_PASSWORD=probe -p 55438:5432 postgres:16-alpine
 *   CONNECTION_CARD_CONCURRENCY_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55438/postgres \
 *     pnpm --filter @botiverse/raft-server test:connection-card-concurrency
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, test } from "vitest";

import { closeDatabase, getDb, initDatabase } from "./index";
import { actionCards, agents, channelAgents, channels, managedMcpServers, messages, servers, users } from "./schema";
import { ensureMcpConnectionCard } from "../services/managedMcpConnectionCardService";

const REAL_PG_URL_ENV = "CONNECTION_CARD_CONCURRENCY_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CONNECTION_CARD_CONCURRENCY_REAL_PG_REQUIRED === "1";

const CONCURRENCY = Number(process.env.CONNECTION_CARD_CONCURRENCY ?? 8);

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string }>;
};

let createdDb: string | null = null;

afterAll(async () => {
  await closeDatabase().catch(() => {});
  if (createdDb && REAL_PG_URL) {
    const cleanup = new pg.Client({ connectionString: REAL_PG_URL });
    cleanup.on("error", () => {});
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${createdDb}" WITH (FORCE)`);
    await cleanup.end();
  }
});

async function freshDatabaseUrl(): Promise<string> {
  const name = `cards_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL! });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  createdDb = name;
  const url = REAL_PG_URL!.replace(/\/[^/]*$/, `/${name}`);

  // Apply the real journal, so the partial unique index under test is the one that ships.
  const migrator = new pg.Client({ connectionString: url });
  migrator.on("error", () => {});
  await migrator.connect();
  for (const entry of journal.entries) {
    await migrator.query("BEGIN");
    await migrator.query(readFileSync(`${drizzleDir}/${entry.tag}.sql`, "utf8"));
    await migrator.query("COMMIT");
  }
  await migrator.end();
  return url;
}

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `cards-${randomUUID()}@example.test`,
    name: `cards-${randomUUID().slice(0, 8)}`,
    passwordHash: "fixture-value-not-a-credential",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Cards", slug: `cards-${randomUUID().slice(0, 8)}`, ownerId: user.id,
  }).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `c-${randomUUID().slice(0, 8)}` }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [msg] = await db.insert(messages).values({
    channelId: channel.id, senderType: "agent", senderId: agent.id, content: "turn",
  }).returning();
  const [mcp] = await db.insert(managedMcpServers).values({
    serverId: server.id,
    name: `mcp-${randomUUID().slice(0, 8)}`,
    endpointUrl: "https://cards.example.test/mcp",
    enabled: true,
    sourceKind: "url",
  }).returning();
  return { serverId: server.id, agentId: agent.id, mcpServerId: mcp.id, msgId: msg.id };
}

test(
  "concurrent refusals raise exactly ONE connection card, and dropping the index proves the race is real",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 300_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    await initDatabase(await freshDatabaseUrl());
    const db = getDb();

    // --- positive control: the shipping schema -------------------------------------------------
    const f = await seed();
    const fire = () => ensureMcpConnectionCard({
      serverId: f.serverId,
      agentId: f.agentId,
      mcpServerId: f.mcpServerId,
      revision: 1,
      origin: { sourceMessageId: f.msgId },
    });

    const results = await Promise.all(Array.from({ length: CONCURRENCY }, fire));
    const cards = await db.select().from(actionCards).where(eq(actionCards.requesterAgentId, f.agentId));
    assert.equal(
      cards.length, 1,
      `⭐ ${CONCURRENCY} concurrent refusals must leave exactly ONE open card, got ${cards.length}`,
    );
    // Every caller must be told about the SAME card -- a loser that reports "no card" would leave
    // its own refusal without a prompt even though one exists.
    const ids = new Set(results.map((r) => r.cardMessageId));
    assert.equal(ids.size, 1, "every concurrent caller must resolve to the same card");
    assert.ok(!ids.has(null), "no caller may come away believing no card exists");
    assert.equal(results.filter((r) => !r.reused).length, 1, "exactly one caller created it; the rest reused");

    // --- ⭐ negative control: without the index, the same calls really do double up ---------------
    await db.execute("DROP INDEX idx_action_cards_open_dedupe");
    const g = await seed();
    const fireG = () => ensureMcpConnectionCard({
      serverId: g.serverId,
      agentId: g.agentId,
      mcpServerId: g.mcpServerId,
      revision: 1,
      origin: { sourceMessageId: g.msgId },
    });
    await Promise.all(Array.from({ length: CONCURRENCY }, fireG));
    const unguarded = await db.select().from(actionCards).where(eq(actionCards.requesterAgentId, g.agentId));
    assert.ok(
      unguarded.length > 1,
      "⭐ with the index dropped these calls MUST double up — otherwise the positive control above "
      + `proves nothing about concurrency (got ${unguarded.length})`,
    );

    // eslint-disable-next-line no-console -- the numbers are the deliverable
    console.log(
      `[connection-card concurrency] concurrency=${CONCURRENCY} withIndex=${cards.length} withoutIndex=${unguarded.length}`,
    );
  },
);
