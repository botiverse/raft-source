import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agents, machines, reminders, servers, users } from "../db/schema";
import {
  createReminder,
  fireReminder,
  getReminderById,
  listReminderEvents,
  markReminderMigrated,
  recordReminderArmed,
  type ReminderRow,
  type TimeProvider,
} from "../apps/reminder/service";
import {
  startReminderArmWatchdog,
  type ReminderArmWatchdogClock,
} from "./reminderArmWatchdog";


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
      pushReminderCancel: async () => true,
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
      pushReminderCancel: async () => true,
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
      pushReminderCancel: async () => true,
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

async function seedAgentOnMachine(
  server: { id: string },
  user: { id: string },
  suffix: string,
  lastHeartbeat: Date | null,
) {
  const db = getDb();
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: user.id,
    name: `machine-${suffix}`,
    apiKeyHash: `hash-${suffix}`,
    lastHeartbeat,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    machineId: machine.id,
    name: `agent-${suffix}`,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  return agent;
}

test("task #441: a reminder on an offline machine is not re-pushed or stamped, and cannot starve an online one", async ({ db }) => {
  const { server, user } = await seedServerAndAgent();
  // 90 s and older is offline; the outbound projection uses the same cutoff.
  const offlineAgent = await seedAgentOnMachine(server, user, "offline", new Date(FIXED_NOW.getTime() - 90_001));
  const onlineAgent = await seedAgentOnMachine(server, user, "online", new Date(FIXED_NOW.getTime() - 30_000));
  const create = (ownerAgentId: string, title: string, fireAt: string) => createReminder({
    serverId: server.id,
    ownerAgentId,
    msgId: null,
    title,
    fireAt: new Date(fireAt),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  // The offline row is the more urgent one: under fireAt order it would lead.
  const offline = await create(offlineAgent.id, "offline machine", "2026-04-20T12:00:01.000Z");
  const online = await create(onlineAgent.id, "online machine", "2026-04-20T12:00:10.000Z");

  const pushed: string[] = [];
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    batchSize: 1,
    orchestrator: {
      pushReminderCancel: async () => true,
      pushReminderUpsert: async (_agentId, row) => {
        pushed.push(row.id);
        return true;
      },
    },
  });
  await watchdog.tick();
  await watchdog.tick();
  watchdog.stop();

  assert.deepEqual(pushed, [online.id, online.id]);
  const offlineRow = await getReminderById(offline.id);
  assert.equal(offlineRow?.armUpdatedAt, null, "an offline row is never stamped");
  assert.equal(offlineRow?.status, "scheduled");
});

test("task #441: a machine that comes back online rejoins the arm watchdog", async ({ db }) => {
  const { server, user } = await seedServerAndAgent();
  const agent = await seedAgentOnMachine(server, user, "returning", null);
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "returning machine",
    fireAt: new Date("2026-04-20T12:00:10.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const pushed: string[] = [];
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    orchestrator: {
      pushReminderCancel: async () => true,
      pushReminderUpsert: async (_agentId, row) => {
        pushed.push(row.id);
        return true;
      },
    },
  });
  await watchdog.tick();
  assert.deepEqual(pushed, [], "never-heartbeated machine is offline");

  await getDb().update(machines).set({ lastHeartbeat: FIXED_NOW }).where(eq(machines.id, agent.machineId!));
  await watchdog.tick();
  watchdog.stop();
  assert.deepEqual(pushed, [reminder.id]);
});

test("a migrated reminder never fires, and the watchdog tells its Computer to drop the copy once", async ({ db }) => {
  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "moved to the Reminder App",
    fireAt: new Date("2026-04-20T13:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  assert.ok(await recordReminderArmed(reminder.id, agent.id, reminder.version, { clock: FIXED_CLOCK }));

  const migrated = await markReminderMigrated(reminder.id, { appReminderId: "app-rem-1", batchId: "b1" }, {
    expectedVersion: reminder.version,
    clock: FIXED_CLOCK,
  });
  assert.ok(migrated);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.version, reminder.version + 1);
  assert.equal(migrated.armState, "pending");
  // CAS: a stale version or a second mark does nothing.
  assert.equal(await markReminderMigrated(reminder.id, { appReminderId: "x" }, { expectedVersion: reminder.version, clock: FIXED_CLOCK }), null);
  // The Computer's armed copy is at the old version: its fire is refused.
  const late = new Date("2026-04-20T13:00:01.000Z");
  const fire = await fireReminder(reminder.id, reminder.version, { clock: { now: () => late } });
  assert.equal(fire.ok, false, JSON.stringify(fire));
  assert.equal(fire.ok ? null : fire.reason, "not_scheduled");
  const events = await listReminderEvents(reminder.id);
  assert.deepEqual(events.filter((e) => e.eventType === "migrated").map((e) => e.metadata), [{ appReminderId: "app-rem-1", batchId: "b1" }]);

  const cancels: Array<[string, string, number]> = [];
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    orchestrator: {
      pushReminderUpsert: async () => {
        throw new Error("a migrated reminder must never be re-armed");
      },
      pushReminderCancel: async (agentId, reminderId, version) => {
        cancels.push([agentId, reminderId, version]);
        return false; // owner offline: still marked, the reconnect snapshot drops it
      },
    },
  });
  await watchdog.tick();
  await watchdog.tick();
  watchdog.stop();

  assert.deepEqual(cancels, [[agent.id, reminder.id, migrated.version]], "one cancel at the migrated revision");
  const persisted = await getReminderById(reminder.id);
  assert.equal(persisted?.status, "migrated");
  assert.equal(persisted?.armState, "not_armed");
  assert.equal(persisted?.firedAt, null);
});
