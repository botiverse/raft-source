import { dbTest as test } from "../../test/integration/dbTest.js";
import { closeTestDatabase } from "../../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import { getDb } from "../../db/index.js";
import { agents, servers, users } from "../../db/schema.js";
import {
  cancelAppReminder,
  createAppReminder,
  listAppReminderEvents,
  replaceAppReminder,
  snoozeAppReminder,
  updateAppReminder,
} from "./crud.js";


afterEach(async () => {
  await closeTestDatabase();
});

const FIXED_NOW = new Date("2026-08-07T02:00:00.000Z");
const FIXED_CLOCK = { now: () => FIXED_NOW };

async function seedServerAndAgents() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Acme",
    slug: "acme",
    ownerId: user.id,
  }).returning();
  const inserted = await db.insert(agents).values([
    {
      id: "33333333-3333-4333-8333-333333333333",
      serverId: server.id,
      name: "cody",
      status: "active",
      model: "codex",
      runtime: "codex",
      executionMode: "byoc",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      serverId: server.id,
      name: "haohao",
      status: "active",
      model: "codex",
      runtime: "codex",
      executionMode: "byoc",
    },
  ]).returning();
  return { user, server, first: inserted[0], second: inserted[1] };
}

test("App Reminder CRUD mutates only lifecycle rows and advances revisions", async ({ db }) => {

  const { user, server, first } = await seedServerAndAgents();
  const created = await createAppReminder({
    serverId: server.id,
    ownerAgentId: first.id,
    msgId: null,
    title: "original",
    fireAt: new Date("2026-08-07T03:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  assert.equal(created.version, 1);
  assert.equal(created.armState, "pending");

  const updated = await updateAppReminder(created.id, { kind: "title", title: "updated" }, {
    actor: { type: "human", id: user.id },
    clock: FIXED_CLOCK,
    expectedVersion: created.version,
  });
  assert.equal(updated?.version, 2);
  assert.equal(updated?.title, "updated");

  const snoozed = await snoozeAppReminder(created.id, 60, {
    actor: { type: "human", id: user.id },
    clock: FIXED_CLOCK,
    expectedVersion: updated!.version,
  });
  assert.equal(snoozed?.version, 3);

  const canceled = await cancelAppReminder(created.id, {
    actor: { type: "human", id: user.id },
    clock: FIXED_CLOCK,
    expectedVersion: snoozed!.version,
  });
  assert.equal(canceled?.version, 4);
  assert.equal(canceled?.status, "canceled");

  const events = await listAppReminderEvents(created.id);
  assert.deepEqual(
    events.map((event) => event.eventType).sort(),
    ["canceled", "scheduled", "snoozed", "updated"],
  );
});

test("stable-id replacement keeps a monotonic revision across owner rebind", async ({ db }) => {

  const { user, server, first, second } = await seedServerAndAgents();
  const created = await createAppReminder({
    id: "55555555-5555-4555-8555-555555555555",
    serverId: server.id,
    ownerAgentId: first.id,
    msgId: null,
    title: "old owner",
    fireAt: new Date("2026-08-07T03:00:00.000Z"),
    payload: { kind: "wiki.incremental_discovery", version: 1 },
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const replaced = await replaceAppReminder(created.id, {
    serverId: server.id,
    ownerAgentId: second.id,
    msgId: null,
    title: "new owner",
    fireAt: new Date("2026-08-08T03:00:00.000Z"),
    payload: { kind: "wiki.incremental_discovery", version: 1 },
    createdBy: { type: "human", id: user.id },
  }, {
    actor: { type: "human", id: user.id },
    allowSystemManaged: true,
    clock: FIXED_CLOCK,
    expectedVersion: created.version,
  });
  assert.equal(replaced?.ownerAgentId, second.id);
  assert.equal(replaced?.version, 2);
  assert.equal(replaced?.armState, "pending");
  assert.equal(await replaceAppReminder(created.id, {
    serverId: server.id,
    ownerAgentId: first.id,
    msgId: null,
    title: "stale",
    fireAt: new Date("2026-08-09T03:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, {
    actor: { type: "human", id: user.id },
    clock: FIXED_CLOCK,
    expectedVersion: created.version,
  }), null);
});
