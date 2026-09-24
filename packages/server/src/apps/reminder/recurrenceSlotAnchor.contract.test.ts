import { dbTest as test } from "../../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database.js";
/**
 * Recurring reminder slot-anchor correctness (task #806).
 *
 * The defect these exist to catch, from Vix's pre-deploy specimen: a fire that
 * arrives EARLY but inside `FIRE_DUE_TOLERANCE_MS` is accepted, and then the
 * recurrence is advanced from `now` -- which is still BEFORE the slot that was
 * just consumed. For `daily`/`weekly`, `nextHM` picks the first candidate
 * strictly after `from`, so that candidate is the SAME slot again: the row is
 * rearmed onto the instant it just fired, fires a second time seconds later,
 * and the ledger shows two FIRED with the first `next` unchanged.
 *
 * Frozen semantics (#806): advance from `max(current due slot, server now)`.
 * Never from an earlier request time that can reselect the same slot; a late
 * catch-up must still advance from `now` so historical slots are skipped.
 *
 * These fixtures fire the row EARLY-BUT-IN-TOLERANCE, because that is the only
 * window where the bug is reachable -- a test that fires exactly on time or
 * late passes against the broken source.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/index.js";
import { agents, reminderEvents, reminders, servers, users } from "../../db/schema.js";
import type { Recurrence } from "../../services/recurrence.js";
import { createReminder, fireReminder, FIRE_DUE_TOLERANCE_MS, type TimeProvider } from "./service.js";


afterEach(async () => {
  await closeTestDatabase();
});

/**
 * Valid stored shapes only. A hand-invented recurrence (e.g. a bare
 * `{kind, everySeconds}`) is accepted by the JSON column and silently makes
 * these tests green against broken source -- `isSupportedRecurrence` rejects
 * it, so the fire takes the forward-compat skip branch instead of the
 * recurring branch under test. Typecheck is the gate that catches that, not
 * the runner.
 */
const DAILY_0230_UTC: Recurrence = {
  version: 1,
  rule: { kind: "daily", hour: 2, minute: 30, tz: "UTC" },
};
const EVERY_15_MIN: Recurrence = {
  version: 1,
  rule: { kind: "interval", seconds: 900 },
};
const WEEKLY_MON_0230_UTC: Recurrence = {
  version: 1,
  rule: { kind: "weekly", days: ["mon"], hour: 2, minute: 30, tz: "UTC" },
};

/** 2026-04-20 is a Monday, so it is a valid slot for the weekly rule too. */
const SLOT = new Date("2026-04-20T02:30:00.000Z");

/** A fire request that lands inside the early-acceptance window. */
const EARLY_IN_TOLERANCE: TimeProvider = {
  now: () => new Date(SLOT.getTime() - (FIRE_DUE_TOLERANCE_MS - 100)),
};

function clockAt(instant: Date): TimeProvider {
  return { now: () => instant };
}

async function seed() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    email: `anchor-${suffix}@slock.test`,
    name: `anchor-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Anchor ${suffix.slice(0, 6)}`,
    slug: `anchor-${suffix}`,
    ownerId: user!.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: `agent-${suffix.slice(0, 6)}`,
    runtime: "codex",
  }).returning();
  return { db, user: user!, server: server!, agent: agent! };
}

async function seedRecurring(
  recurrence: Recurrence,
  fireAt: Date,
  clock: TimeProvider,
) {
  const ctx = await seed();
  const reminder = await createReminder({
    serverId: ctx.server.id,
    ownerAgentId: ctx.agent.id,
    msgId: null,
    title: "slot anchor fixture",
    fireAt,
    payload: null,
    recurrence,
    createdBy: { type: "human", id: ctx.user.id },
  }, { clock });
  return { ...ctx, reminder };
}

/**
 * The column is `eventType`. An earlier draft of this helper filtered on a
 * `kind` field that does not exist, so it returned 0 forever and the
 * duplicate-fire teeth below asserted nothing -- they failed for the wrong
 * reason and would have "passed" by weakening the expectation. No cast here:
 * the bare property access is what lets typecheck reject a wrong field name.
 */
async function firedEventCount(reminderId: string) {
  const db = getDb();
  const rows = await db.select().from(reminderEvents).where(eq(reminderEvents.reminderId, reminderId));
  return rows.filter((row) => row.eventType === "fired").length;
}

test("instrument check: the fired-event counter can actually see a fire", async () => {
  // Positive control for the two duplicate-fire teeth below. Without it, a
  // counter that is silently always-zero makes "exactly one fire" and "no
  // second fire" both look satisfiable by a broken query.
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, EARLY_IN_TOLERANCE);
  assert.equal(await firedEventCount(reminder.id), 0, "no fire has happened yet");

  const result = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(result.ok);
  assert.equal(await firedEventCount(reminder.id), 1, "the counter must observe a real fire");
});

test("an early-but-accepted daily fire does not rearm onto the slot it just consumed", async () => {
  // Vix's specimen: accepted at slot-0.9s, next set back to the same instant.
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, EARLY_IN_TOLERANCE);

  const result = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(result.ok, `expected the early-in-tolerance fire to be accepted, got ${(result as { reason?: string }).reason}`);
  const next = result.nextFireAt;
  assert.ok(next, "a recurring fire must schedule a next slot");

  assert.notEqual(
    next.getTime(),
    SLOT.getTime(),
    "rearmed onto the SAME slot it just fired -- this is the double-FIRED defect",
  );
  assert.equal(
    next.toISOString(),
    "2026-04-21T02:30:00.000Z",
    "a daily rule must advance exactly one day past the consumed slot",
  );
});

test("an early-but-accepted weekly fire does not rearm onto the slot it just consumed", async () => {
  // Same defect as daily, and the weekday filter structurally cannot block it:
  // `nextHM` walks offset=0 first, and that candidate IS the consumed slot --
  // which by construction falls on an allowed weekday, since it is the slot
  // that was scheduled. So the filter passes it and the strict-greater check
  // passes it too (fireAt > now on an early fire). Costlier than daily as well:
  // a reselect here means the next correct advance is a week out.
  const { reminder } = await seedRecurring(WEEKLY_MON_0230_UTC, SLOT, EARLY_IN_TOLERANCE);

  const result = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(result.ok, `expected acceptance, got ${(result as { reason?: string }).reason}`);
  const next = result.nextFireAt!;

  assert.notEqual(next.getTime(), SLOT.getTime(), "weekly rearmed onto the slot it just fired");
  assert.equal(
    next.toISOString(),
    "2026-04-27T02:30:00.000Z",
    "a weekly rule must advance to the next allowed weekday past the consumed slot",
  );
});

test("next is strictly in the future of the consumed slot, not merely of the request time", async () => {
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, EARLY_IN_TOLERANCE);

  const result = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(result.ok);
  const next = result.nextFireAt!;

  // The broken source satisfies "next > now" while still being <= the consumed
  // slot. Anchoring on the slot is what this pins.
  assert.ok(
    next.getTime() > SLOT.getTime(),
    `next (${next.toISOString()}) must be past the consumed slot (${SLOT.toISOString()})`,
  );
});

test("one accepted slot produces exactly one fired event", async () => {
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, EARLY_IN_TOLERANCE);

  const first = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(first.ok);
  assert.equal(await firedEventCount(reminder.id), 1, "the accepted slot must log exactly one fire");

  // Walk the clock to just past the consumed slot -- the moment the row would
  // fire again if it had been rearmed onto that same instant.
  const justAfterSlot = clockAt(new Date(SLOT.getTime() + 50));
  const row = first.row as { version: number };
  const second = await fireReminder(reminder.id, row.version, { clock: justAfterSlot });

  assert.equal(second.ok, false, "the row must not be due again moments after its own slot");
  assert.equal(
    await firedEventCount(reminder.id),
    1,
    "a second fire in the same slot is the user-visible duplicate this task exists to stop",
  );
});

test("duplicate replay of the same version is idempotent", async () => {
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, EARLY_IN_TOLERANCE);

  const first = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(first.ok);
  const nextAfterFirst = first.nextFireAt!.toISOString();

  // Same (id, version) again: a retried request, not a new slot.
  const replay = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.equal(replay.ok, false, "replaying a consumed version must not fire again");

  const db = getDb();
  const [row] = await db.select().from(reminders).where(eq(reminders.id, reminder.id));
  assert.equal(
    (row as { fireAt: Date }).fireAt.toISOString(),
    nextAfterFirst,
    "a refused replay must not move the schedule",
  );
  assert.equal(await firedEventCount(reminder.id), 1);
});

test("exactly on time (now == slot) advances one period, not zero", async () => {
  // The max() boundary: both operands equal. Picking either must still leave
  // the consumed slot behind -- `nextHM` requires strictly-after, so an
  // off-by-one here would be invisible in the early and late cases above.
  const onTime = clockAt(SLOT);
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, onTime);

  const result = await fireReminder(reminder.id, reminder.version, { clock: onTime });
  assert.ok(result.ok, "a fire exactly at the slot must be accepted");
  assert.equal(result.nextFireAt!.toISOString(), "2026-04-21T02:30:00.000Z");
});

test("the advance reuses the gate's clock reading, not a second one", async () => {
  // The reachable window is exactly [fireAt - TOLERANCE, fireAt), and it is
  // that crisp only because the due gate and the advance share ONE `now`
  // captured at function entry. Re-reading the clock before advancing looks
  // harmless and keeps most cases working, but it decouples the two conditions
  // -- the defect stops being deterministic and becomes a race whose window
  // drifts with the gap between the two reads. A race reproduces rarely enough
  // to be called fixed.
  //
  // This clock moves forward on every call, so a second read is observable:
  // interval anchors on a later instant and lands past SLOT + 900s.
  let reads = 0;
  const movingClock: TimeProvider = {
    now: () => {
      reads += 1;
      return reads === 1
        ? new Date(SLOT.getTime() - 900)
        : new Date(SLOT.getTime() + 5_000);
    },
  };

  const ctx = await seed();
  const reminder = await createReminder({
    serverId: ctx.server.id,
    ownerAgentId: ctx.agent.id,
    msgId: null,
    title: "single-clock-read fixture",
    fireAt: SLOT,
    payload: null,
    recurrence: EVERY_15_MIN,
    createdBy: { type: "human", id: ctx.user.id },
  }, { clock: clockAt(new Date(SLOT.getTime() - 900)) });

  const result = await fireReminder(reminder.id, reminder.version, { clock: movingClock });
  assert.ok(result.ok);
  assert.equal(
    result.nextFireAt!.toISOString(),
    new Date(SLOT.getTime() + 900_000).toISOString(),
    "the advance read the clock a second time; gate and advance must share one instant",
  );
});

test("a late catch-up still advances from now, skipping historical slots", async () => {
  // This is the semantic that max(slot, now) must NOT break: three days late,
  // the next slot is tomorrow -- not a backlog of missed days.
  const { reminder } = await seedRecurring(DAILY_0230_UTC, SLOT, clockAt(new Date(SLOT.getTime() - 60_000)));

  const threeDaysLate = clockAt(new Date("2026-04-23T09:00:00.000Z"));
  const result = await fireReminder(reminder.id, reminder.version, { clock: threeDaysLate, catchup: true });
  assert.ok(result.ok, "a late fire must still be accepted");

  assert.equal(
    result.nextFireAt!.toISOString(),
    "2026-04-24T02:30:00.000Z",
    "a late catch-up must advance from now, not replay each missed day",
  );
});

test("an interval rule anchors on the slot, so early acceptance does not drift the schedule earlier", async () => {
  const { reminder } = await seedRecurring(EVERY_15_MIN, SLOT, EARLY_IN_TOLERANCE);

  const result = await fireReminder(reminder.id, reminder.version, { clock: EARLY_IN_TOLERANCE });
  assert.ok(result.ok);

  assert.equal(
    result.nextFireAt!.toISOString(),
    new Date(SLOT.getTime() + 900_000).toISOString(),
    "anchoring on `now` walks every interval schedule earlier by the earliness, cycle after cycle",
  );
});
