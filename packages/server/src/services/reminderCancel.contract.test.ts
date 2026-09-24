import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import {
  cancelReminder,
  createReminder,
  fireReminder,
  getReminderById,
  listReminderEvents,
  snoozeReminder,
  updateReminder,
  type TimeProvider,
} from "../apps/reminder/service.js";


/**
 * Unwrap a fire that must have succeeded. Fails loudly, naming the refusal
 * reason, instead of surfacing as `undefined is not an object` three lines
 * later. (task #674)
 */
function firedOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const reason = (result as { reason?: string }).reason ?? "unknown";
    throw new Error(`expected a fire, got refusal: ${reason}`);
  }
  return result as Extract<T, { ok: true }>;
}

afterEach(async () => {
  await closeTestDatabase();
});

// NOTE (task #674): fire-path fixtures below sit BEFORE FIXED_NOW because the
// server independently re-checks that a reminder is actually due. The #202
// module move had shifted them an hour into the future, which is only green
// while that due check is missing. Relative ordering is preserved exactly
// (13:00/13:05/13:10/13:15 -> 11:00/11:05/11:10/11:15).
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };

// Compile-time retirement tooth: mutation entry points must not regain the
// pre-cutover no-version compatibility shape. If `expectedVersion` becomes
// optional, these directives become unused and Server typecheck fails.
if (false) {
  // @ts-expect-error expectedVersion is required for cancel CAS
  void cancelReminder("compile-only", { clock: FIXED_CLOCK });
  // @ts-expect-error expectedVersion is required for snooze CAS
  void snoozeReminder("compile-only", 60, { clock: FIXED_CLOCK });
  // @ts-expect-error expectedVersion is required for update CAS
  void updateReminder("compile-only", { kind: "title", title: "x" }, { clock: FIXED_CLOCK });
}

async function seedServerAndAgent() {
  const db = getDb();

  const [user] = await db
    .insert(users)
    .values({
      id: "11111111-1111-1111-1111-111111111111",
      email: "owner@example.com",
      name: "Owner",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();

  const [server] = await db
    .insert(servers)
    .values({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Acme",
      slug: "acme",
      ownerId: user.id,
    })
    .returning();

  const [agent] = await db
    .insert(agents)
    .values({
      id: "33333333-3333-3333-3333-333333333333",
      serverId: server.id,
      name: "applepi",
      status: "active",
      model: "sonnet",
      runtime: "claude",
      executionMode: "byoc",
    })
    .returning();

  return { user, server, agent };
}

test("R3: cancel wins cleanly and a later fire attempt becomes no-op", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder(
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: null,
      title: "cancel me first",
      fireAt: new Date("2026-04-20T11:00:00.000Z"),
      payload: null,
      createdBy: { type: "human", id: user.id },
    },
    { clock: FIXED_CLOCK },
  );

  const canceled = await cancelReminder(reminder.id, {
    clock: FIXED_CLOCK,
    expectedVersion: reminder.version,
  });
  assert.ok(canceled);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.version, 2);
  assert.equal(canceled.canceledAt?.toISOString(), FIXED_NOW.toISOString());

  // NOT firedOk() -- the row was cancelled, so this must be refused.
  const lateFire = await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK });
  assert.equal(lateFire.ok, false);
  // Typed refusal: the row was cancelled, so this is not_scheduled -- not a
  // version race and not an early fire. The old bare null could not say which.
  assert.equal(lateFire.ok === false && lateFire.reason, "not_scheduled");

  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "canceled");
  assert.equal(persisted.version, 2);
  assert.equal(persisted.canceledAt?.toISOString(), FIXED_NOW.toISOString());
  assert.equal(persisted.firedAt, null);
});

test("R3: fired one-time reminder can still be canceled", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder(
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: null,
      title: "fire me first",
      fireAt: new Date("2026-04-20T11:00:00.000Z"),
      payload: null,
      createdBy: { type: "human", id: user.id },
    },
    { clock: FIXED_CLOCK },
  );

  const fired = firedOk(await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }));
  assert.ok(fired);
  assert.equal(fired.row.status, "fired");
  assert.equal(fired.row.version, 2);
  assert.equal(fired.row.firedAt?.toISOString(), FIXED_NOW.toISOString());

  const lateCancel = await cancelReminder(reminder.id, {
    clock: FIXED_CLOCK,
    expectedVersion: fired.row.version,
  });
  assert.ok(lateCancel);
  assert.equal(lateCancel.status, "canceled");
  assert.equal(lateCancel.version, 3);

  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "canceled");
  assert.equal(persisted.version, 3);
  assert.equal(persisted.firedAt?.toISOString(), FIXED_NOW.toISOString());
  assert.equal(persisted.canceledAt?.toISOString(), FIXED_NOW.toISOString());
});

test("B-minimal: fired one-time can snooze back to scheduled but cannot update", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const snoozeClock: TimeProvider = {
    now: () => new Date("2026-04-20T12:05:00.000Z"),
  };

  const reminder = await createReminder(
    {
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: null,
      title: "one-time alarm",
      fireAt: new Date("2026-04-20T11:00:00.000Z"),
      payload: null,
      createdBy: { type: "human", id: user.id },
    },
    { clock: FIXED_CLOCK },
  );

  const fired = firedOk(await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }));
  assert.ok(fired);
  assert.equal(fired.row.status, "fired");

  const rejectedUpdate = await updateReminder(
    reminder.id,
    { kind: "title", title: "new title" },
    { clock: snoozeClock, expectedVersion: fired.row.version },
  );
  assert.equal(rejectedUpdate, null);

  const snoozed = await snoozeReminder(reminder.id, 30 * 60, {
    clock: snoozeClock,
    expectedVersion: fired.row.version,
  });
  assert.ok(snoozed);
  assert.equal(snoozed.status, "scheduled");
  assert.equal(snoozed.fireAt.toISOString(), "2026-04-20T12:35:00.000Z");

  const events = await listReminderEvents(reminder.id);
  assert.deepEqual(events.map((e) => e.eventType), ["snoozed", "scheduled", "fired"]);
  assert.equal(events[0].nextFireAt?.toISOString(), "2026-04-20T12:35:00.000Z");
  assert.equal(events[2].nextFireAt, null);
});

test("canonical Wiki ingest and lint reminders reject generic mutation APIs", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  for (const kind of ["wiki.incremental_discovery", "wiki.lint"] as const) {
    const reminder = await createReminder(
      {
        serverId: server.id,
        ownerAgentId: agent.id,
        msgId: null,
        title: kind,
        fireAt: new Date("2026-04-20T11:00:00.000Z"),
        payload: {
          kind,
          version: 1,
          wikiSpaceId: "55555555-5555-4555-8555-555555555555",
          serverId: server.id,
        },
        createdBy: { type: "human", id: user.id },
      },
      { clock: FIXED_CLOCK },
    );

    assert.equal(await cancelReminder(reminder.id, {
      clock: FIXED_CLOCK,
      expectedVersion: reminder.version,
    }), null);
    assert.equal(await snoozeReminder(reminder.id, 60, {
      clock: FIXED_CLOCK,
      expectedVersion: reminder.version,
    }), null);
    assert.equal(
      await updateReminder(
        reminder.id,
        { kind: "title", title: "mutated" },
        { clock: FIXED_CLOCK, expectedVersion: reminder.version },
      ),
      null,
    );
    const persisted = await getReminderById(reminder.id);
    assert.equal(persisted?.status, "scheduled");
    assert.equal(persisted?.version, 1);
    assert.equal(persisted?.title, kind);
  }
});
