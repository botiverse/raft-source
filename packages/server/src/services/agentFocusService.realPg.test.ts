/**
 * Focus under real concurrency. PGlite runs one transaction at a time, so
 * only a real multi-connection Postgres shows that:
 * - focus() calls racing for one agent queue on its advisory lock and leave
 *   at most the limit, with a pool smaller than the number of callers (the
 *   readability check reads through the transaction it is handed);
 * - an auto-focus never waits for that lock: while another transaction holds
 *   it the delivery leaves at once, untagged, and the next message tries again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_FOCUS_FEATURE_FLAG_KEY, asChannelId, type AgentMessage } from "@botiverse/raft-shared";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase, type DatabaseExecutor } from "../db/index";
import { agentFocusTargets, featureFlagRules, users } from "../db/schema";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { __clearAutoFocusTriesForTests, focusOnDelivery } from "./agentFocusAuto";
import { __clearFocusSetCacheForTests } from "./agentFocusDelivery";
import { AGENT_FOCUS_LIMIT, autoFocus, focus } from "./agentFocusService";
import { createAgent } from "./agentService";
import { addAgent, createChannel, getOrCreateThreadForChannel } from "./channelService";
import { createMessage } from "./messageService";
import { createServer } from "./serverService";

const url = process.env.AGENT_FOCUS_REAL_PG_URL;
const required = process.env.AGENT_FOCUS_REAL_PG_REQUIRED === "1";
const POOL_SIZE = 4;
const CALLERS = 12;

async function withDatabase(run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  if (!url) throw new Error("AGENT_FOCUS_REAL_PG_REQUIRED=1 requires AGENT_FOCUS_REAL_PG_URL");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const previousMax = process.env.PG_MAX_CONNECTIONS;
  process.env.PG_MAX_CONNECTIONS = String(POOL_SIZE);
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(url);
  try {
    await run(pool);
  } finally {
    if (previousMax === undefined) delete process.env.PG_MAX_CONNECTIONS; else process.env.PG_MAX_CONNECTIONS = previousMax;
    __clearFocusSetCacheForTests();
    __clearAutoFocusTriesForTests();
    await closeDatabase();
    await pool.end();
  }
}

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({ name: `focus-${suffix}`, email: `focus-${suffix}@raft.test`, passwordHash: "fixture", emailVerified: true }).returning();
  const server = await createServer("Focus limit test", `focus-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `focus-${suffix.slice(0, 8)}`, { runtime: "claude" });
  return { owner: owner!, server, agent };
}

test.skipIf(!url && !required)("concurrent focus() calls for one agent leave at most the limit, with fewer connections than callers", async () => {
  await withDatabase(async () => {
    const { server, agent } = await seed();
    const conversations: string[] = [];
    for (let index = 0; index < CALLERS; index += 1) conversations.push((await createChannel(server.id, `focus-${index}-${randomUUID().slice(0, 8)}`)).id);
    let checks = 0;
    // The check reads through the executor it is handed, as the real one does (visibilityService.canView).
    const stillReadable = async (channelIds: readonly string[], executor: DatabaseExecutor) => {
      checks += 1;
      await executor.execute(sql`SELECT pg_sleep(0.02)`);
      return channelIds.map(() => true);
    };
    const count = async () => (await getDb().select({ id: agentFocusTargets.id }).from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id))).length;

    for (const round of [1, 2, 3]) {
      const results = await Promise.all(conversations.map((id, index) =>
        focus(agent.id, asChannelId(id), index % 2 === 0 ? "auto" : "manual", { stillReadable })));
      assert.equal(await count(), AGENT_FOCUS_LIMIT, `round ${round}: exactly the limit is left`);
      for (const result of results) {
        assert.ok(result.entries.length <= AGENT_FOCUS_LIMIT, `round ${round}: no call saw more than the limit after it`);
      }
    }
    assert.ok(checks > 0, "the readability check ran under the lock");

    // The same conversation focused by every caller at once: one row, no unique violation.
    await getDb().delete(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id));
    const same = await Promise.all(Array.from({ length: CALLERS }, () => focus(agent.id, asChannelId(conversations[0]!), "auto", { stillReadable })));
    assert.equal(same.filter((result) => !result.alreadyFocused).length, 1);
    assert.equal(await count(), 1);

    // Auto-focuses racing each other never wait: some find the lock taken, and the limit still holds.
    await getDb().delete(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id));
    const raced = await Promise.all(conversations.map((id) => autoFocus(agent.id, asChannelId(id), { stillReadable })));
    assert.ok(raced.some((result) => typeof result === "object"), "at least one got the lock");
    assert.ok(await count() <= AGENT_FOCUS_LIMIT);
  });
}, 120_000);

test.skipIf(!url && !required)("an auto-focus does not wait for the agent's lock: the delivery leaves untagged, and the next message focuses", async () => {
  await withDatabase(async (pool) => {
    const { owner, server, agent } = await seed();
    await getDb().insert(featureFlagRules).values({ flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
    const channel = await createChannel(server.id, `focus-busy-${randomUUID().slice(0, 8)}`);
    await addAgent(channel.id, agent.id);
    const root = await createMessage(channel.id, "user", owner.id, "a root");
    const thread = await getOrCreateThreadForChannel(channel.id, root.id, owner.id, "user");
    const mention = (): AgentMessage => ({
      channel_id: thread.id, channel_name: channel.name, channel_type: "thread", sender_id: owner.id, sender_name: owner.name, sender_type: "human",
      content: "hello", timestamp: new Date().toISOString(), seq: 1, message_id: randomUUID(), mentioned: true,
    });
    const deliver = () => focusOnDelivery({ agentId: agent.id, serverId: server.id, message: mention(), machineCapable: () => true });
    const rows = () => getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agent.id));

    // Another transaction (a manual focus that is still running, say) holds the agent's focus lock.
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`agent-focus:${agent.id}`]);

      const startedAt = Date.now();
      const held = await deliver();
      assert.ok(Date.now() - startedAt < 3_000, "the delivery did not wait for the lock");
      assert.equal(held.focused, undefined);
      assert.equal(held.focus_change, undefined);
      assert.deepEqual(await rows(), []);
      // Still held: the next message tries again at once (contention is not remembered as a try), and again leaves untagged.
      assert.equal((await deliver()).focused, undefined);

      await blocker.query("COMMIT");
      const next = await deliver();
      assert.equal(next.focused, true, "the next message after the lock is free focuses the thread");
      assert.deepEqual(next.focus_change, { reason: "mentioned", focused: [`#${channel.name}:${root.id.slice(0, 8)}`], unfocused: [] });
      assert.deepEqual((await rows()).map((row) => [row.channelId, row.source]), [[thread.id, "auto"]]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
  });
}, 120_000);
