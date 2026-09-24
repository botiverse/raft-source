import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agents, reminders, servers, users } from "../db/schema.js";
import {
  createReminder,
  getReminderById,
  recordReminderArmed,
  type ReminderRow,
  type TimeProvider,
} from "../apps/reminder/service.js";
import {
  startReminderArmWatchdog,
  type ReminderArmWatchdogClock,
} from "./reminderArmWatchdog.js";


afterEach(async () => {
  await closeTestDatabase();
});

const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };

async function seedServerAndAgent() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Acme",
    slug: "acme",
    ownerId: user.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: "33333333-3333-3333-3333-333333333333",
    serverId: server.id,
    name: "applepi",
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  return { user, server, agent };
}

function createFakeClock(now: Date): ReminderArmWatchdogClock {
  return {
    now: () => now,
    setInterval: () => Symbol("interval"),
    clearInterval: () => {},
  };
}

test("arm watchdog marks missing receipt not_armed and only re-pushes the schedule", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "must arm on Computer",
    fireAt: new Date("2026-04-20T12:00:10.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const pushed: ReminderRow[] = [];
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    orchestrator: {
      pushReminderUpsert: async (_agentId, row) => {
        pushed.push(row);
        return true;
      },
    },
  });
  await watchdog.tick();
  watchdog.stop();

  assert.deepEqual(pushed.map((row) => [row.id, row.version]), [[reminder.id, reminder.version]]);
  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.armState, "not_armed");
  assert.equal(persisted.armedVersion, null);
  assert.equal(persisted.status, "scheduled", "watchdog must never fire the reminder");
  assert.equal(persisted.firedAt, null, "watchdog must never create a Server-side due effect");
});

test("armed exact revision is healthy and watchdog performs no fallback action", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "already armed",
    fireAt: new Date("2026-04-20T12:00:10.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  assert.ok(await recordReminderArmed(reminder.id, agent.id, reminder.version, { clock: FIXED_CLOCK }));

  let pushes = 0;
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    orchestrator: {
      pushReminderUpsert: async () => {
        pushes += 1;
        return true;
      },
    },
  });
  await watchdog.tick();
  watchdog.stop();

  assert.equal(pushes, 0);
  const persisted = await getReminderById(reminder.id);
  assert.equal(persisted?.armState, "armed");
  assert.equal(persisted?.armedVersion, reminder.version);
  assert.equal(persisted?.status, "scheduled");
});

test("armed state without an exact armed revision is not healthy", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "corrupt arm receipt",
    fireAt: new Date("2026-04-20T12:00:10.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  await getDb()
    .update(reminders)
    .set({ armState: "armed", armedVersion: null })
    .where(eq(reminders.id, reminder.id));

  let pushes = 0;
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    orchestrator: {
      pushReminderUpsert: async () => {
        pushes += 1;
        return true;
      },
    },
  });
  await watchdog.tick();
  watchdog.stop();

  assert.equal(pushes, 1);
  const persisted = await getReminderById(reminder.id);
  assert.equal(persisted?.armState, "not_armed");
  assert.equal(persisted?.armedVersion, null);
  assert.equal(persisted?.status, "scheduled");
});
