import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channels, featureFlagRules, featureFlags, messages, serverMembers, servers, tasks, users } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { openTestApp as startTestApp } from "../test/integration/app";
import {
  CHANNEL_CONVERSION_MAX_MESSAGES, CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS, CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS,
  measureConversionScope, startChannelToJointConversion,
} from "./channelConversionService";
import { setOnlineMoveStepObserverForTest } from "./channelConversionPreparation";
import { addHuman, createChannel } from "./channelService";
import { CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY } from "./featureFlagService";
import { createServer as createServerService } from "./serverService";
import { createTaskConversationsInTransaction } from "./taskConversationService";

// A measurement, not a check CI runs: how long the online start
// (channel_conversion_online_move_v1) holds its transaction for a source at
// the size limits (CHANNEL_CONVERSION_MAX_MESSAGES messages,
// CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS threads and task conversations).
// Runs only with ONLINE_MOVE_TIMING_REAL_PG_URL set (an admin URL of a
// throwaway Postgres; a database is created and dropped), and is in no CI
// list. Prints the median of RUNS starts (each on a freshly seeded channel)
// and each step's time.

const URL_ENV = "ONLINE_MOVE_TIMING_REAL_PG_URL";
const ADMIN_URL = process.env[URL_ENV];
const RUNS = 5;
const THREADS = 80;
const TASK_CONVERSATIONS = CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS - THREADS;
const ROOT_MESSAGES = 100;
const THREAD_REPLIES = 30;
const TASK_REPLIES = CHANNEL_CONVERSION_MAX_MESSAGES - ROOT_MESSAGES - THREAD_REPLIES;
const LEGACY_MESSAGE_TASKS = 2;
const MEMBERS = 5;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function seedAtLimit(serverId: string, ownerId: string, memberIds: string[], name: string) {
  const db = getDb();
  const channel = await createChannel(serverId, name, "timing", "channel");
  for (const id of [ownerId, ...memberIds]) await addHuman(channel.id, id);
  const roots = await db.insert(messages).values(Array.from({ length: ROOT_MESSAGES }, (_, index) => ({
    channelId: channel.id, senderType: "user" as const, senderId: ownerId, content: `root ${index}`,
    ...(index < LEGACY_MESSAGE_TASKS ? { taskStatus: "todo" as const, taskNumber: index + 1 } : {}),
  }))).returning({ id: messages.id });
  const threads = await db.insert(channels).values(roots.slice(0, THREADS).map((root) => ({
    serverId, name: `thread-${root.id.slice(0, 8)}`, type: "thread" as const, parentMessageId: root.id,
  }))).returning({ id: channels.id, parentMessageId: channels.parentMessageId });
  for (const thread of threads) await db.update(messages).set({ threadId: thread.id }).where(eq(messages.id, thread.parentMessageId!));
  await db.insert(messages).values(threads.slice(0, THREAD_REPLIES).map((thread, index) => ({
    channelId: thread.id, senderType: "user" as const, senderId: ownerId, content: `thread reply ${index}`,
  })));
  const taskRows = await db.insert(tasks).values(Array.from({ length: TASK_CONVERSATIONS }, (_, index) => ({
    channelId: channel.id, taskNumber: LEGACY_MESSAGE_TASKS + index + 1, title: `task ${index}`,
    createdByType: "user" as const, createdById: ownerId, ownConversation: true,
  }))).returning({ id: tasks.id });
  await db.update(channels).set({ taskNumberHighWater: LEGACY_MESSAGE_TASKS + TASK_CONVERSATIONS }).where(eq(channels.id, channel.id));
  const conversations = await createTaskConversationsInTransaction(db, {
    tasks: taskRows.map((task) => ({ id: task.id, channelId: channel.id })),
    storageChannel: { id: channel.id, serverId, type: "channel" },
    initiatingServerId: serverId,
    createdByUserId: ownerId,
  });
  await db.insert(messages).values([...conversations.values()].slice(0, TASK_REPLIES).map((conversation, index) => ({
    channelId: conversation.canonicalChannelId, senderType: "user" as const, senderId: ownerId, content: `task reply ${index}`,
  })));
  return channel;
}

test.skipIf(!ADMIN_URL)("timing: the online start at the size limit (measurement only)", { timeout: 600_000 }, async () => {
  assert.ok(ADMIN_URL);
  const databaseName = `slock_online_timing_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = databaseUrlFor(ADMIN_URL, databaseName);
    const setupPool = new pg.Pool({ connectionString: testUrl, max: 2 });
    await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    await setupPool.end();
    app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
    const db = getDb();
    const prefix = `timing-${randomUUID().slice(0, 8)}`;
    const people = await db.insert(users).values(Array.from({ length: MEMBERS }, (_, index) => ({
      email: `${prefix}-${index}@slock.test`, name: `${prefix}-${index}`, displayName: `${prefix}-${index}`,
      passwordHash: "not-used", emailVerified: true, profileSetupCompletedAt: new Date(),
    }))).returning({ id: users.id });
    const [owner, ...members] = people;
    const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner!.id);
    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
    await db.insert(serverMembers).values(members.map((member) => ({ serverId: server.id, userId: member.id, role: "member" as const })));
    await db.insert(featureFlags).values({ key: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: false, randomizationUnit: "server", salt: "timing" }).onConflictDoNothing();
    await db.insert(featureFlagRules).values({ flagKey: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });

    const totals: number[] = [];
    const steps = new Map<string, number[]>();
    const note = (step: string, ms: number) => steps.set(step, [...steps.get(step) ?? [], ms]);
    setOnlineMoveStepObserverForTest((step, ms) => note(step, ms));
    try {
      for (let run = 0; run < RUNS; run += 1) {
        const channel = await seedAtLimit(server.id, owner!.id, members.map((member) => member.id), `${prefix}-run-${run}`);
        const size = await measureConversionScope(db, channel.id);
        assert.deepEqual(size, { subconversations: CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS, messages: CHANNEL_CONVERSION_MAX_MESSAGES }, "seeded at the limits");
        const started = new Map<string, number>();
        const runStartedAt = performance.now();
        const job = await startChannelToJointConversion({
          serverId: server.id, sourceChannelId: channel.id, createdByUserId: owner!.id,
          tracePreJobPhase: (event) => {
            if (event.eligibilitySubcheck) return;
            if (event.outcome === "started") started.set(event.phase, performance.now());
            else note(`pre_job:${event.phase}`, performance.now() - (started.get(event.phase) ?? performance.now()));
          },
        });
        totals.push(performance.now() - runStartedAt);
        assert.equal(job.phase, "online_move");
        assert.equal(job.progress.preparedThreads, THREADS);
        assert.equal(job.progress.preparedTaskConversations, TASK_CONVERSATIONS);
        assert.equal(job.progress.taskRowsAffected, LEGACY_MESSAGE_TASKS, "the legacy message tasks were promoted");
        const promoted = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, (job.progress.promotedTaskIds as string[] | undefined) ?? []));
        assert.equal(promoted.length, LEGACY_MESSAGE_TASKS);
      }
    } finally {
      setOnlineMoveStepObserverForTest(null);
    }
    const lines = [
      `online start at the limit (${CHANNEL_CONVERSION_MAX_MESSAGES} messages; ${THREADS} threads + ${TASK_CONVERSATIONS} task conversations; ${LEGACY_MESSAGE_TASKS} legacy message tasks; ${MEMBERS} members), ${RUNS} runs:`,
      `  total: median ${median(totals).toFixed(1)} ms, runs ${totals.map((ms) => ms.toFixed(0)).join(", ")} ms`,
      ...[...steps].map(([step, values]) => `  ${step}: median ${median(values).toFixed(1)} ms`),
    ];
    console.log(lines.join("\n"));
    assert.ok(median(totals) < CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS / 5, "the whole start stays far under its budget");
  } finally {
    if (app) await app.close();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
});
