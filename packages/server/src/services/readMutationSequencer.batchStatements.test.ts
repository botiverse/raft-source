import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  threadFollows,
  users,
  userChannelReadCursors,
} from "../db/schema";
import {
  admitReadMutation,
  processNextReadMutation,
} from "./readMutationSequencer";

/**
 * Statement-count sweeps for the batched global_read_all claim
 * (Tenny/Ray spec, #proj-data thread 2026-09-24).
 *
 * What is pinned here, and what to do when a pin fires:
 * - X (sweep A pin): the fixed statement count of ONE batched
 *   global_read_all claim on the all-channel sweep. It is the sum of fixed
 *   per-claim statements (claim preamble + authority lock, candidate
 *   listing, local resolution, frontier, apply lock + upsert, terminal +
 *   authority updates). If you intentionally add a FIXED-per-claim
 *   statement, update the pin and explain in the PR. If the equality
 *   assertions fire with counts growing by N, that is an N+1 regression:
 *   fix the code, do not raise the pins.
 * - PIN_THREAD_DELTA (sweep B): the fixed extra cost of the
 *   thread-resolution statement (Y − X). Per-thread growth is a regression;
 *   an intentional fixed extra statement gets a documented pin change.
 * - The thread ceiling is X + PIN_THREAD_DELTA, so it agrees with both pins.
 */

// 2026-11-05: ordinary-channel CI sweeps remain flat at X=21. The prior 19
// includes the authorization lock and two SET LOCAL lock_timeout statements.
// #13114 adds one computed-entry discovery query to the global candidate
// resolver; #13132 adds one frozen-recipient discovery query before locks.
// With no joint projections both queries return empty without per-scope work.
const PIN_SWEEP_A_COUNT = 21;
const PIN_THREAD_DELTA = 1; // The one batched thread-resolution statement: Y=22.

type PgliteLike = {
  query: (...args: unknown[]) => Promise<unknown>;
  transaction: <T>(fn: (tx: PgliteLike) => Promise<T>, ...rest: unknown[]) => Promise<T>;
};

function statementCounter() {
  const client = (getDb() as unknown as { $client: PgliteLike }).$client;
  // Drizzle runs every measured statement inside getDb().transaction(...), and
  // PGlite hands transactions a tx-scoped client — patching the top-level
  // query method would observe nothing. Wrap client.transaction and patch the
  // tx-scoped client's query instead.
  const originalTransaction = client.transaction.bind(client);
  const counter = { count: 0 };
  client.transaction = (async <T,>(fn: (tx: PgliteLike) => Promise<T>, ...rest: unknown[]) => {
    return originalTransaction(async (tx: PgliteLike) => {
      const originalQuery = tx.query.bind(tx);
      tx.query = ((...args: unknown[]) => {
        counter.count += 1;
        return originalQuery(...args);
      }) as PgliteLike["query"];
      return fn(tx);
    }, ...rest);
  }) as PgliteLike["transaction"];
  return {
    counter,
    restore: () => {
      client.transaction = originalTransaction;
    },
  };
}

async function seedGlobalFixture(input: { channelCount: number; threadEvery: number }) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `batch-stmt-owner-${randomUUID()}@test.invalid`,
    name: `BatchStmt${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Batch Statement Server",
    slug: `batch-stmt-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [sender] = await db.insert(users).values({
    email: `batch-stmt-sender-${randomUUID()}@test.invalid`,
    name: `BatchSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();

  const scopeIds: string[] = [];
  for (let i = 0; i < input.channelCount; i += 1) {
    const isThread = input.threadEvery > 0 && (i + 1) % input.threadEvery === 0;
    let scopeId: string;
    if (isThread) {
      const [parent] = await db.insert(channels).values({
        serverId: server.id,
        name: `batch-parent-${i}-${randomUUID().slice(0, 8)}`,
        type: "channel",
      }).returning();
      // No channel_humans on the parent: keeps the parent out of the
      // candidates listing (only the thread itself is a scope here).
      const [parentMessage] = await db.insert(messages).values({
        channelId: parent.id,
        senderType: "user",
        senderId: sender.id,
        content: "parent",
        seq: 1,
      }).returning();
      const [thread] = await db.insert(channels).values({
        serverId: server.id,
        name: `batch-thread-${i}-${randomUUID().slice(0, 8)}`,
        type: "thread",
        parentMessageId: parentMessage.id,
      }).returning();
      await db.insert(threadFollows).values({
        threadChannelId: thread.id,
        followerType: "user",
        followerId: owner.id,
        parentMessageId: parentMessage.id,
        reason: "manual",
      });
      await db.insert(messages).values({
        channelId: thread.id,
        senderType: "user",
        senderId: sender.id,
        content: "thread",
        seq: 1,
      });
      scopeId = thread.id;
    } else {
      const [channel] = await db.insert(channels).values({
        serverId: server.id,
        name: `batch-channel-${i}-${randomUUID().slice(0, 8)}`,
        type: "channel",
      }).returning();
      await db.insert(messages).values({
        channelId: channel.id,
        senderType: "user",
        senderId: sender.id,
        content: "msg",
        seq: 1,
      });
      scopeId = channel.id;
    }
    await db.insert(channelHumans).values({ channelId: scopeId, userId: owner.id });
    // Cursor behind the frontier (lastReadSeq 0 < seq 1): every scope
    // advances, so the apply's supplementary read never fires and the count
    // stays at its fixed value. A scope that does not advance would add one
    // supplementary statement — keep the fixture advancing.
    await db.insert(userChannelReadCursors).values({
      userId: owner.id,
      channelId: scopeId,
      lastReadSeq: 0,
      readStateVersion: 0,
      lastAppliedAuthoritySeq: 0,
    });
    scopeIds.push(scopeId);
  }
  return { owner, server, scopeIds };
}

async function countClaimStatements(input: { channelCount: number; threadEvery: number }): Promise<number> {
  const { owner, server } = await seedGlobalFixture(input);
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const { counter, restore } = statementCounter();
  try {
    const ack = await processNextReadMutation({
      serverId: server.id,
      principalId: owner.id,
      leaseOwner: `stmt-counter-${randomUUID()}`,
      leaseMs: 60_000,
    });
    assert.ok(ack, "expected the admitted global_read_all to be claimed");
    assert.equal(ack.kind, "global_read_all");
    return counter.count;
  } finally {
    restore();
  }
}

test("global_read_all statement count is O(1): all-channel sweep N=[1,50,200] equal, pinned at X", async ({ db }) => {
  const counts: number[] = [];
  for (const size of [1, 50, 200]) {
    counts.push(await countClaimStatements({ channelCount: size, threadEvery: 0 }));
  }
  const [x1, x50, x200] = counts;
  assert.equal(x50, x1, `statement count must not grow with N (N=50 gave ${x50}, N=1 gave ${x1}); a growing count is an N+1 regression — fix the code, do not raise the pins`);
  assert.equal(x200, x1, `statement count must not grow with N (N=200 gave ${x200}, N=1 gave ${x1}); a growing count is an N+1 regression — fix the code, do not raise the pins`);
  if (PIN_SWEEP_A_COUNT > 0) {
    assert.equal(x1, PIN_SWEEP_A_COUNT, "X is the fixed per-claim statement count of the batched global_read_all claim (claim preamble + authority lock + candidate listing + local resolution + frontier + apply lock/upsert + terminal updates); if you intentionally added a fixed statement, update this pin and explain in the PR");
  }
  assert.ok(x1 > 0, "the statement counter must actually observe the claim's statements; a zero here means the counting seam is broken, not that the claim is free");
});

test("global_read_all statement count is O(1): thread sweep N=[4,52,200] equal, thread delta pinned", async ({ db }) => {
  const baseline = await countClaimStatements({ channelCount: 4, threadEvery: 0 });
  const counts: number[] = [];
  for (const size of [4, 52, 200]) {
    counts.push(await countClaimStatements({ channelCount: size, threadEvery: 4 }));
  }
  const [y4, y52, y200] = counts;
  assert.equal(y52, y4, `statement count must not grow with N on the thread sweep (N=52 gave ${y52}, N=4 gave ${y4}); per-thread growth is an N+1 regression — fix the code, do not raise the pins`);
  assert.equal(y200, y4, `statement count must not grow with N on the thread sweep (N=200 gave ${y200}, N=4 gave ${y4}); per-thread growth is an N+1 regression — fix the code, do not raise the pins`);
  const threadCeiling = PIN_SWEEP_A_COUNT + PIN_THREAD_DELTA;
  assert.ok(y4 <= threadCeiling, `Y=${y4} exceeds the pinned ceiling of ${threadCeiling} statements per batched claim (X=${PIN_SWEEP_A_COUNT} + ${PIN_THREAD_DELTA} fixed thread-resolution statement); per-scope growth is a regression, and an intentional fixed addition needs a documented pin change`);
  if (PIN_THREAD_DELTA > 0) {
    assert.equal(y4 - baseline, PIN_THREAD_DELTA, "Y − X is the fixed statement cost of the thread-resolution branch; per-thread growth is a regression — fix the code; an intentional fixed extra statement gets a documented pin change");
  }
});

test("batched global_read_all preserves candidate ordering in boundary and ack (digest input)", async ({ db }) => {
  const { owner, server, scopeIds } = await seedGlobalFixture({ channelCount: 12, threadEvery: 4 });
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const ack = await processNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: `order-check-${randomUUID()}`,
    leaseMs: 60_000,
  });
  assert.ok(ack);
  // The candidates query returns ids ordered by scopeId; resolution preserves
  // that order, and every seeded scope has frontier 1 > 0, so the boundary
  // must be exactly the sorted candidate set. If the batch path ever reorders
  // its output, the terminal digest changes without any error — this is the
  // assertion that makes that visible.
  const expected = [...scopeIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(
    ack.capturedBoundary.map((entry) => entry.scopeId),
    expected,
    "boundary scope order must equal the candidate order produced by the per-scope path; reordering changes the terminal digest without any error surfacing",
  );
  assert.deepEqual(
    ack.scopes.map((scope) => scope.scopeId),
    expected,
    "ack scope order must equal boundary order (both feed the terminal digest)",
  );
});

test("global_read_all with principal membership revoked before claim resolves to empty (no throw, no partial resolution)", async ({ db }) => {
  const { owner, server } = await seedGlobalFixture({ channelCount: 6, threadEvery: 0 });
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  // Removal between admission and execution: the hoisted principal lock fails
  // and the mutation must resolve exactly as the per-scope loop resolved it
  // (every scope dropped, zero scopes) — never a new exception, never a
  // partially resolved boundary.
  await getDb().delete(serverMembers).where(eq(serverMembers.userId, owner.id));
  const ack = await processNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: `lock-fail-${randomUUID()}`,
    leaseMs: 60_000,
  });
  assert.ok(ack);
  assert.equal(ack.terminalState, "retired_no_effect", "no scopes resolve (authorization revoked), so the mutation retires with no effect");
  assert.equal(ack.terminalReason, "authorization_revoked");
  assert.deepEqual(ack.capturedBoundary, []);
  assert.deepEqual(ack.scopes, []);
});

test("global resolution admits only live authority: lost-access and deleted scopes are dropped without residue", async ({ db }) => {
  const { owner, server, scopeIds } = await seedGlobalFixture({ channelCount: 8, threadEvery: 0 });
  // Revoke membership on one scope and soft-delete another; the global path
  // has no residue branches, so both must simply vanish from the boundary
  // (pinned contract: the batched resolver never mints residue).
  const lostAccess = scopeIds[2];
  const deleted = scopeIds[5];
  await db.delete(channelHumans).where(eq(channelHumans.channelId, lostAccess));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted));
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const ack = await processNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: `live-only-${randomUUID()}`,
    leaseMs: 60_000,
  });
  assert.ok(ack);
  const boundaryIds = ack.capturedBoundary.map((entry) => entry.scopeId);
  const expected = scopeIds
    .filter((id) => id !== lostAccess && id !== deleted)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(boundaryIds, expected, "lost-access and deleted scopes must be dropped from the global boundary (global resolves live authority only — no residue)");
  assert.ok(ack.scopes.every((scope) => scope.changed), "every surviving scope advances (fixture cursors sit behind the frontier)");
});
