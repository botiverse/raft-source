// Real PostgreSQL teeth for POST /api/app-installation/agent-reminder-messages.
// PGlite serializes transactions, so only a multi-connection Postgres can show
// that concurrent first writes converge on one dm:@reminders surface (no orphan
// channel left by the loser) and that concurrent writes with one idempotency
// key produce one message.
//
// CI: `probe-concurrency-real-pg`, with APP_AGENT_REMINDER_REAL_PG_URL.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { and, eq, like } from "drizzle-orm";
import pg from "pg";
import type { AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentPrivateSurfaces, appAgentMessages, channelAgents, channels, inboxNotificationFacts, messages } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { agentApi, postReminder, seedReminderApp, seedReminderWorld } from "../test/appAgentReminderFixture";
import { __setAppAgentReminderRaceHooksForTests } from "../services/appAgentReminderMessageService";
import { withChannelDelivery } from "../test/orchestratorStub";

/** Releases every waiter once `parties` arrived (or after a bounded wait, so a bug fails instead of hanging). */
function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return {
    get arrived() { return arrived; },
    wait: async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await Promise.race([open, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
  };
}

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REAL_PG_URL = process.env.APP_AGENT_REMINDER_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.APP_AGENT_REMINDER_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;

async function withRealPgApp(run: (app: TestApp, deliveries: Array<{ agentId: string; message: AgentMessage }>) => Promise<void>) {
  assert.ok(REAL_PG_URL, "APP_AGENT_REMINDER_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, {
    humanActivityMuteFlagDefaultEnabled: true,
    skipAuthRateLimit: true,
  });
  const deliveries: Array<{ agentId: string; message: AgentMessage }> = [];
  app.app.set("agentOrchestrator", withChannelDelivery({
    deliverMessage: async (agentId: string, message: AgentMessage) => {
      deliveries.push({ agentId, message });
      return { status: "queued", reason: "local_inbox" };
    },
  }));
  try {
    await run(app, deliveries);
  } finally {
    await app.close();
  }
}

test("real PG: concurrent first writes converge on one surface; one key writes one message", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, deliveries) => {
    const world = await seedReminderWorld();
    const { client, token } = await seedReminderApp(app.baseUrl, world, { official: true, groups: ["agent_reminder_write"] });
    const agentId = world.agent.id;

    // Different keys, no surface yet: every writer creates a channel before
    // any inserts the surface; one wins, the rest drop theirs.
    const surfaceRace = barrier(6);
    __setAppAgentReminderRaceHooksForTests({ beforeSurfaceInsert: surfaceRace.wait });
    const firsts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      postReminder(app.baseUrl, token, { agentId, idempotencyKey: `first-${index}`, text: `first write ${index}` })));
    __setAppAgentReminderRaceHooksForTests({});
    assert.equal(surfaceRace.arrived, 6, "all six writers raced the surface insert");
    for (const res of firsts) {
      assert.equal(res.status, 200, res.raw);
      assert.equal(res.body.created, true);
    }
    const surfaces = await getDb().select().from(agentPrivateSurfaces).where(eq(agentPrivateSurfaces.agentId, agentId));
    assert.equal(surfaces.length, 1, "one surface");
    const channelId = surfaces[0].channelId;
    const reminderChannels = await getDb().select().from(channels).where(and(
      eq(channels.serverId, world.server.id),
      like(channels.name, `agent-reminders-${agentId}`),
    ));
    assert.deepEqual(reminderChannels.map((channel) => channel.id), [channelId], "the losers left no orphan channel");
    assert.deepEqual((await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, channelId))).map((row) => row.agentId), [agentId]);
    const surfaceMessages = await getDb().select().from(messages).where(eq(messages.channelId, channelId));
    assert.deepEqual(surfaceMessages.map((message) => message.id).sort(), firsts.map((res) => res.body.messageId).sort());
    const facts = await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.receiverId, agentId),
      eq(inboxNotificationFacts.sourceChannelId, channelId),
    ));
    assert.equal(facts.length, 6, "one unread inbox fact per reminder");
    assert.ok(facts.every((fact) => fact.unreadEligible));

    // One key, concurrently: every writer passes the replay pre-check and
    // writes a message; one ledger insert wins, the rest roll back and replay.
    const keyRace = barrier(6);
    __setAppAgentReminderRaceHooksForTests({ beforeLedgerInsert: keyRace.wait });
    const sameKey = await Promise.all(Array.from({ length: 6 }, () =>
      postReminder(app.baseUrl, token, { agentId, idempotencyKey: "same-key", text: "same key" })));
    __setAppAgentReminderRaceHooksForTests({});
    assert.equal(keyRace.arrived, 6, "all six writers raced the ledger insert");
    for (const res of sameKey) assert.equal(res.status, 200, res.raw);
    assert.equal(new Set(sameKey.map((res) => res.body.messageId)).size, 1);
    assert.equal(sameKey.filter((res) => res.body.created).length, 1);
    const ledger = await getDb().select().from(appAgentMessages).where(and(
      eq(appAgentMessages.clientId, client.id),
      eq(appAgentMessages.idempotencyKey, "same-key"),
    ));
    assert.deepEqual(ledger.map((row) => row.messageId), [sameKey[0].body.messageId]);
    assert.equal((await getDb().select().from(messages).where(eq(messages.channelId, channelId))).length, 7);
    assert.equal(deliveries.filter((delivery) => delivery.agentId === agentId).length, 7, "each created message is delivered once");
    assert.ok(deliveries.every((delivery) => delivery.message.channel_name === "reminders"));

    // The agent reads it as dm:@reminders and cannot send there.
    const history = await agentApi(app.baseUrl, world.agentKey, "GET", `/history?${new URLSearchParams({ channel: "dm:@reminders" })}`);
    assert.equal(history.status, 200, history.raw);
    assert.ok(history.raw.includes("same key"));
    const sent = await agentApi(app.baseUrl, world.agentKey, "POST", "/send", { target: "dm:@reminders", content: "done" });
    assert.equal(sent.status, 403, sent.raw);
    assert.equal(sent.body.code, "DM_TARGET_NOT_SENDABLE");
  });
});
