import { dbTest as test } from "../../test/integration/dbTest.js";
import { closeTestDatabase } from "../../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { agents, channelAgents, channels, messages, reminderEvents, reminders, servers, users } from "../../db/schema.js";
import { reminderSourceAcknowledgements } from "./sourceAckSchema.js";
import {
  ackAuthorizedReminderFire,
  cancelReminder,
  createReminder,
  fireReminder,
  getReminderById,
  listReminders,
  toReminderSummaries,
  type TimeProvider,
} from "./service.js";
import { ackBuiltInAppSource } from "../../registry.manifest.js";
import type { Recurrence } from "../../services/recurrence.js";


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
// Server now independently re-checks that a reminder is actually due.
//
// These were 13:00/13:05/13:10/13:15 -- an hour AFTER FIXED_NOW -- since long
// before the #202 move; that is the original value, not a regression. They were
// simply never required to be due, because no due check existed on this path.
// Moved back two hours, relative ordering preserved exactly.
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };
const EVERY_15_MIN: Recurrence = {
  version: 1,
  rule: { kind: "interval", seconds: 900 },
};

function clockAt(instant: Date): TimeProvider {
  return { now: () => instant };
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

async function seedAnchor(serverId: string, senderId: string, agentId?: string) {
  const db = getDb();
  const [channel] = await db
    .insert(channels)
    .values({
      id: "44444444-4444-4444-4444-444444444444",
      serverId,
      name: "general",
      type: "channel",
    })
    .returning();

  if (agentId) {
    await db.insert(channelAgents).values({ channelId: channel.id, agentId: agentId }).onConflictDoNothing();
  }

  const [message] = await db
    .insert(messages)
    .values({
      id: "55555555-5555-4555-8555-555555555555",
      channelId: channel.id,
      senderType: "user",
      senderId,
      content: "anchor message",
    })
    .returning();

  return { channel, message };
}

async function seedFiredRecurringReminder() {
  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "ack authority recurring",
    fireAt: new Date("2026-04-20T11:45:00.000Z"),
    payload: null,
    recurrence: EVERY_15_MIN,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const firstFire = firedOk(await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }));
  return { server, agent, user, reminder, firstFire };
}

test("built-in app-source ACK registry dispatches Reminder authority and rejects unknown apps", async ({ db }) => {

  const { server, agent, reminder } = await seedFiredRecurringReminder();
  const input = {
    itemId: `reminder:${reminder.id}:${reminder.version}`,
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: {
      kind: "reminder",
      id: reminder.id,
      revision: String(reminder.version),
    },
    ackAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    serverId: server.id,
    actingAgentId: agent.id,
  } as const;

  const accepted = await ackBuiltInAppSource(input);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.response.itemId, input.itemId);
  assert.equal(accepted.ok && accepted.response.sourceRef.id, reminder.id);

  const unknown = await ackBuiltInAppSource({ ...input, appId: "system.unknown" });
  assert.deepEqual(unknown, {
    ok: false,
    status: 404,
    body: {
      error: "No authority handler is registered for this app source",
      code: "app_source_authority_not_registered",
    },
  });
});

test("R1: fire transition is atomic and exactly-once for the same reminder/version pair", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "wake up",
    // Genuinely due (one minute before FIXED_NOW). This was 13:00 -- an hour in
    // the future -- which passed only because the Server had no due check on
    // this path (task #674).
    fireAt: new Date("2026-04-20T11:59:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const [first, second] = await Promise.all([
    fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }),
    fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }),
  ]);

  const winners = [first, second].filter((r) => r.ok);
  const losers = [first, second].filter((r) => !r.ok);

  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  // The loser is refused, and -- the part that matters -- never for being early.
  //
  // Deliberately NOT asserting a single reason: which one is genuinely
  // timing-dependent. The loser can miss the guarded SELECT (the winner already
  // committed => not_scheduled) or pass the SELECT and lose the UPDATE
  // (=> version_mismatch). Both are true accounts of the same race, so pinning
  // one makes this test flaky rather than strict.
  const loser = losers[0];
  assert.equal(loser.ok, false);
  assert.notEqual(
    loser.ok === false && loser.reason,
    "premature_fire",
    "a lost race must never be reported as an early fire",
  );
  assert.equal(winners[0].fired, true);
  assert.equal(winners[0].catchup, false);
  assert.equal(winners[0].nextFireAt, null);
  assert.equal(winners[0].row.status, "fired");
  assert.equal(winners[0].row.version, 2);
  assert.equal(winners[0].row.firedAt?.toISOString(), FIXED_NOW.toISOString());

  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "fired");
  assert.equal(persisted.version, 2);
  assert.equal(persisted.firedAt?.toISOString(), FIXED_NOW.toISOString());

  const events = await getDb()
    .select({ eventType: reminderEvents.eventType })
    .from(reminderEvents)
    .where(eq(reminderEvents.reminderId, reminder.id));
  assert.equal(events.filter((event) => event.eventType === "scheduled").length, 1);
  assert.equal(events.filter((event) => event.eventType === "fired").length, 1);
});

test("R3: an early fire request is rejected without terminal mutation", async ({ db }) => {
  // NEW (task #674). The Server has never had its own due check on this path:
  // the guard and this tooth were written on PR #5978, which never merged, and
  // #202 refactored from a base that branched before it. So this is not a
  // restoration -- there was no deletion. A reviewed fix was silently bypassed
  // by a refactor, which is worse than a deletion: no census goes red, because
  // nothing was removed.
  //
  // Why the server checks at all when the daemon already gates: #674 was
  // reported as far-future reminders firing early in bulk and then being marked
  // fired, so they stayed silent at their real time. That incident IS the
  // evidence that "something asks early" happens. Two independent gates, and
  // this is the second one.

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "not due yet",
    fireAt: new Date("2026-04-20T13:00:00.000Z"), // one hour after FIXED_NOW
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  // NOT firedOk() -- this call is expected to be refused; unwrapping would
  // throw before any assertion ran.
  const result = await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK });

  // State first, shape second -- deliberately. Asserting `result.ok` first makes
  // this tooth go red on the return TYPE (undefined on the pre-fix tree), which
  // would also "pass" for a refusal that still mutated the row. The behaviour is
  // what must fail first: refusing has to leave no trace. Firing early is only
  // half the reported bug -- being marked `fired` is what silences it forever.
  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "scheduled", "must still be scheduled");
  assert.equal(persisted.version, 1, "version must not be bumped by a refusal");
  assert.equal(persisted.firedAt, null, "must not be marked fired");
  assert.equal(
    persisted.fireAt.toISOString(),
    "2026-04-20T13:00:00.000Z",
    "fireAt must be untouched, so it still rings at its real time",
  );

  const events = await getDb()
    .select({ eventType: reminderEvents.eventType })
    .from(reminderEvents)
    .where(eq(reminderEvents.reminderId, reminder.id));
  assert.equal(events.filter((e) => e.eventType === "fired").length, 0, "no fired event");

  // Only now the refusal's shape, and that it names the right reason.
  assert.equal(result.ok, false, "an undue fire must be refused");
  assert.equal(result.ok === false && result.reason, "premature_fire");
});

test("a row that stops being due between SELECT and UPDATE is still refused", async ({ db }) => {
  // Covers the UPDATE-side due guards, which the R3 tooth above cannot reach:
  // there the read guard refuses first, so removing all three UPDATE guards
  // leaves that test green. (Verified by mutation, task #674.)
  //
  // The window is real: the row is read as due, then moves before we write.
  // fireAt is pushed forward WITHOUT bumping version on purpose -- a snooze
  // would bump it and the UPDATE would fail the version guard instead, which
  // would prove nothing about dueness.

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "moves under us",
    fireAt: new Date("2026-04-20T11:00:00.000Z"), // due at FIXED_NOW
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  let moved = false;
  const result = await fireReminder(reminder.id, reminder.version, {
    clock: FIXED_CLOCK,
    beforeFireUpdateForTesting: async (db) => {
      if (moved) return;
      moved = true;
      // Same executor as the fire: a separate connection would deadlock on this
      // transaction's locks instead of moving the row.
      await db
        .update(reminders)
        .set({ fireAt: new Date("2026-04-20T18:00:00.000Z") })
        .where(eq(reminders.id, reminder.id));
    },
  });

  assert.ok(moved, "the seam must have run, or this test proves nothing");
  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "scheduled", "must not fire a row that moved out of due");
  assert.equal(persisted.version, 1, "no version bump");
  assert.equal(persisted.firedAt, null);
  assert.equal(result.ok, false);
});

test("fire row transition and source-log event roll back together before retry", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "transactional fire",
    fireAt: new Date("2026-04-20T11:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  await assert.rejects(
    fireReminder(reminder.id, reminder.version, {
      clock: FIXED_CLOCK,
      afterFireTransitionForTesting: () => { throw new Error("FAIL_BETWEEN_ROW_AND_EVENT"); },
    }),
    /FAIL_BETWEEN_ROW_AND_EVENT/,
  );
  const afterFailure = await getReminderById(reminder.id);
  assert.equal(afterFailure?.version, reminder.version);
  assert.equal(afterFailure?.status, "scheduled");
  assert.equal(
    (await getDb().select().from(reminderEvents).where(eq(reminderEvents.reminderId, reminder.id)))
      .filter((event) => event.eventType === "fired").length,
    0,
  );

  const retried = firedOk(await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }));
  assert.ok(retried);
  assert.equal(retried.row.version, reminder.version + 1);
  const events = await getDb().select().from(reminderEvents).where(eq(reminderEvents.reminderId, reminder.id));
  assert.equal(events.filter((event) => event.eventType === "fired").length, 1);
});

test("reminder exact ACK requires a fired event for the requested source revision", async ({ db }) => {

  const { server, agent } = await seedFiredRecurringReminder();

  const rejected = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: "77777777-7777-4777-8777-777777777777",
    sourceVersion: 1,
    ackAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.deepEqual(rejected, { ok: false, reason: "reminder_not_found" });
});

test("reminder exact ACK writes one source-event-bound tombstone and repeats while latest is unchanged", async ({ db }) => {

  const { server, agent, reminder } = await seedFiredRecurringReminder();

  const first = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.replayed, false);

  const second = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.replayed, true);

  const acknowledgements = await getDb()
    .select()
    .from(reminderSourceAcknowledgements)
    .where(eq(reminderSourceAcknowledgements.reminderId, reminder.id));
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0]?.sourceVersion, reminder.version);
  assert.ok(acknowledgements[0]?.sourceEventId, "Server tombstone must bind the fired event row");
  assert.equal(acknowledgements[0]?.ackAttemptId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

test("reminder exact ACK treats newer fired source as stale before old tombstone idempotency", async ({ db }) => {

  const { server, agent, reminder, firstFire } = await seedFiredRecurringReminder();
  const firstAck = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(firstAck.ok, true);

  const secondFire = firedOk(await fireReminder(
    reminder.id,
    firstFire.row.version,
    { clock: clockAt(firstFire.row.fireAt) },
  ));
  assert.equal(secondFire.row.version, firstFire.row.version + 1);

  const stale = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.deepEqual(stale, {
    ok: false,
    reason: "stale_source_revision",
    latestFiredSourceVersion: firstFire.row.version,
  });
});

test("same reminder ACK attempt can complete locally after Server accepted before a newer fire", async ({ db }) => {

  const { server, agent, reminder, firstFire } = await seedFiredRecurringReminder();
  const ackAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstAck = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId,
  });
  assert.equal(firstAck.ok, true);

  firedOk(await fireReminder(
    reminder.id,
    firstFire.row.version,
    { clock: clockAt(firstFire.row.fireAt) },
  ));

  const replay = await ackAuthorizedReminderFire({
    serverId: server.id,
    actingAgentId: agent.id,
    reminderId: reminder.id,
    sourceVersion: reminder.version,
    ackAttemptId,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.replayed, true);
});

test("createReminder is idempotent for a caller-owned stable id under concurrency", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const stableId = "88888888-8888-4888-8888-888888888888";
  const input = {
    id: stableId,
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "one durable side effect",
    fireAt: new Date("2026-04-20T11:00:00.000Z"),
    payload: { kind: "idempotency-test" },
    createdBy: { type: "human" as const, id: user.id },
  };

  const [first, second] = await Promise.all([
    createReminder(input, { clock: FIXED_CLOCK }),
    createReminder(input, { clock: FIXED_CLOCK }),
  ]);

  assert.equal(first.id, stableId);
  assert.equal(second.id, stableId);
  const rows = await getDb().select().from(reminders).where(eq(reminders.id, stableId));
  assert.equal(rows.length, 1);
  const events = await getDb().select().from(reminderEvents).where(eq(reminderEvents.reminderId, stableId));
  assert.equal(events.filter((event) => event.eventType === "scheduled").length, 1);
});

test("R1: fire transition rejects stale expectedVersion after the first winner bumps the row", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "wake up later",
    fireAt: new Date("2026-04-20T11:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const fired = firedOk(await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK }));
  assert.ok(fired);
  assert.equal(fired.row.version, 2);

  // NOT firedOk() -- a stale-version retry must be refused.
  const staleRetry = await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK });
  assert.equal(staleRetry.ok, false);
  // NOT version_mismatch, and that is correct rather than a rounding of it: a
  // SEQUENTIAL retry reads after the winner committed, so the status guard
  // (checked before the version compare) refuses first -- the row genuinely is
  // no longer scheduled. The concurrent loser in the race test above can see
  // version_mismatch instead. What matters is that neither is premature_fire.
  assert.equal(staleRetry.ok === false && staleRetry.reason, "not_scheduled");
  assert.notEqual(staleRetry.ok === false && staleRetry.reason, "premature_fire");

  const persisted = await getReminderById(reminder.id);
  assert.ok(persisted);
  assert.equal(persisted.status, "fired");
  assert.equal(persisted.version, 2);
});

test("listReminders accepts multi-status filters and returns only matching rows", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  const scheduled = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "scheduled reminder",
    fireAt: new Date("2026-04-20T11:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const firedBase = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "fired reminder",
    fireAt: new Date("2026-04-20T11:05:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const fired = firedOk(await fireReminder(firedBase.id, firedBase.version, { clock: FIXED_CLOCK }));
  assert.ok(fired);

  const canceledBase = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "canceled reminder",
    fireAt: new Date("2026-04-20T11:10:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const canceled = await cancelReminder(canceledBase.id, {
    clock: FIXED_CLOCK,
    expectedVersion: canceledBase.version,
  });
  assert.ok(canceled);

  const allRows = await listReminders({
    serverId: server.id,
    ownerAgentId: agent.id,
    status: ["scheduled", "fired", "canceled"],
  });
  assert.deepEqual(allRows.map((r) => r.id), [scheduled.id, fired.row.id, canceled.id]);

  const firedAndCanceled = await listReminders({
    serverId: server.id,
    ownerAgentId: agent.id,
    status: ["fired", "canceled"],
  });
  assert.deepEqual(firedAndCanceled.map((r) => r.id), [fired.row.id, canceled.id]);
});

test("toReminderSummaries returns anchored summaries without crashing on anchor resolution", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const { message } = await seedAnchor(server.id, user.id, agent.id);

  const anchored = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: message.id,
    title: "anchored reminder",
    fireAt: new Date("2026-04-20T11:15:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const [summary] = await toReminderSummaries([anchored], server.id);
  assert.ok(summary);
  assert.equal(summary.reminderId, anchored.id);
  assert.equal(summary.msgRef, "#general:55555555");
});

test("listReminders multi-status + anchored row can be summarized without malformed array binding", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();
  const { message } = await seedAnchor(server.id, user.id);

  const scheduled = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "scheduled reminder",
    fireAt: new Date("2026-04-20T11:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });

  const anchoredBase = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: message.id,
    title: "anchored fired reminder",
    fireAt: new Date("2026-04-20T11:05:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const anchoredFiredResult = firedOk(await fireReminder(anchoredBase.id, anchoredBase.version, { clock: FIXED_CLOCK }));
  assert.ok(anchoredFiredResult);
  const anchoredFired = anchoredFiredResult.row;

  const canceledBase = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "canceled reminder",
    fireAt: new Date("2026-04-20T11:10:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  }, { clock: FIXED_CLOCK });
  const canceled = await cancelReminder(canceledBase.id, {
    clock: FIXED_CLOCK,
    expectedVersion: canceledBase.version,
  });
  assert.ok(canceled);

  const rows = await listReminders({
    serverId: server.id,
    ownerAgentId: agent.id,
    status: ["scheduled", "fired", "canceled"],
  });
  const summaries = await toReminderSummaries(rows, server.id);
  assert.deepEqual(summaries.map((s) => s.reminderId), [scheduled.id, anchoredFired.id, canceled.id]);
  assert.equal(
    summaries.find((s) => s.reminderId === anchoredFired.id)?.msgRef,
    "#general:55555555",
  );
});
