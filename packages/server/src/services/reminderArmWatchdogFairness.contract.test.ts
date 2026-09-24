import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { createReminder, type ReminderRow, type TimeProvider } from "../apps/reminder/service.js";
import { startReminderArmWatchdog, type ReminderArmWatchdogClock } from "./reminderArmWatchdog.js";


/**
 * Task #801 — bounded reach / fairness for the arm watchdog.
 *
 * The production incident of 2026-08-09: `getReminderArmGaps` selects
 * `ORDER BY fireAt ASC LIMIT batchSize` over a predicate that a row does NOT
 * leave by being attempted — `markReminderNotArmed` sets `armState='not_armed'`,
 * which still satisfies `armState != 'armed'`. So when the head of that ordering
 * keeps failing to arm, the same head rows are re-selected every tick forever and
 * every row behind position `batchSize` is never pushed at all. With ~800 gaps
 * ahead of it, a real reminder sat `pending` for hours and fired nothing, silently.
 *
 * The guarantee this pins is the one @庄天翼 froze, WITH ITS PREMISE STATED:
 * over a FROZEN eligible set — N rows eligible at the start, none arriving during
 * the run — and a persistently failing head, ANY eligible row must be selected
 * within a COMPUTABLE number of ticks: ceil(N / batchSize). Not "eventually".
 *
 * ⚠️ The frozen set is a premise of the bound, not an incidental property of this
 * fixture. Under a DYNAMIC set no absolute bound holds, and this file does not
 * claim one: `NULLS FIRST` deliberately orders never-attempted rows ahead of
 * retries, so continuous arrivals can postpone an attempted row indefinitely.
 * There, reach is bounded only while arrival rate < effective service capacity and
 * every selection actually stamps `armUpdatedAt`. Those are production readback
 * obligations (see the ordering comment in apps/reminder/service.ts) — a green run
 * here is evidence for the frozen case only, and must not be cited as evidence
 * that a live backlog drains.
 *
 * ⚠️ Nothing here asserts that arming SUCCEEDS. The head is deliberately allowed
 * to keep failing for the whole test; a fix that reached the tail only by first
 * repairing the head would pass while leaving the starvation intact.
 */

afterEach(async () => {
  await closeTestDatabase();
});

const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };
const BATCH = 100;
const TOTAL = 120;

async function seedServerAndAgent() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "fairness-owner@example.com",
    name: "Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Acme",
    slug: "acme-fairness",
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
  return { now: () => now, setInterval: () => Symbol("interval"), clearInterval: () => {} };
}

test("a persistently failing head must not starve rows behind it", async ({ db }) => {

  const { server, agent, user } = await seedServerAndAgent();

  // All TOTAL rows are due inside the horizon and none will ever arm: the
  // orchestrator accepts the push, but no armed receipt ever comes back, so
  // every row stays eligible. This is the incident's shape, not a contrivance.
  const ids: string[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const row = await createReminder({
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: null,
      title: `gap ${i}`,
      // Strictly increasing fireAt: row i sorts at position i under the
      // pre-fix `ORDER BY fireAt ASC`, so the tail rows are exactly the ones
      // that can never be reached while the head keeps failing.
      fireAt: new Date(FIXED_NOW.getTime() + 1_000 + i),
      payload: null,
      // Both recurrence kinds, interleaved, so the tail contains each. Testing
      // only one kind would leave the other's reachability unproven, and the
      // backlog is ~10% one-time. (@庄天翼, acceptance point 3.)
      recurrence: i % 2 === 0 ? null : { version: 1 as const, rule: { kind: "interval" as const, seconds: 900 } },
      createdBy: { type: "human", id: user.id },
    }, { clock: FIXED_CLOCK });
    ids.push(row.id);
  }
  const tailId = ids[TOTAL - 1];
  const tailOneTimeId = ids[TOTAL - 2];

  const pushedIds = new Set<string>();
  const watchdog = startReminderArmWatchdog({
    clock: createFakeClock(FIXED_NOW),
    horizonMs: 15_000,
    batchSize: BATCH,
    orchestrator: {
      pushReminderUpsert: async (_agentId: string, row: ReminderRow) => {
        pushedIds.add(row.id);
        // The push "succeeds" but the Computer never returns armed(revision) --
        // exactly the production case. The row therefore remains eligible and
        // will be re-selected forever under an ordering that does not rotate.
        return true;
      },
    },
  });

  // The bound, over the frozen eligible set seeded above (nothing arrives during
  // the loop): ceil(N / batchSize) ticks must suffice for EVERY eligible row.
  const boundedTicks = Math.ceil(TOTAL / BATCH);
  for (let i = 0; i < boundedTicks; i += 1) await watchdog.tick();
  watchdog.stop();

  assert.ok(
    pushedIds.has(tailId),
    `the last row was never pushed within ${boundedTicks} ticks: a persistently failing `
    + `head monopolised every batch, so ${TOTAL - BATCH} rows behind position ${BATCH} `
    + `were never reached at all (pushed ${pushedIds.size}/${TOTAL} distinct rows)`,
  );
  assert.ok(
    pushedIds.has(tailOneTimeId),
    "the tail one-time row was never reached: reachability must not depend on recurrence kind",
  );
  assert.equal(
    pushedIds.size,
    TOTAL,
    `over a frozen eligible set, every row must be reached within ceil(N/batch) `
    + `ticks; reached ${pushedIds.size}/${TOTAL}`,
  );
});
