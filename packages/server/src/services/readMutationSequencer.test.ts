import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { and, eq, inArray } from "drizzle-orm";

import { closeDatabase, getDb } from "../db/index.js";
import {
  readMutationWorkerDrainDuration,
  readMutationWorkerDrainsTotal,
} from "../metrics.js";
import {
  agentChannelReadCursors,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  readMutationAuthorities,
  readMutations,
  readMutationTombstones,
  serverMembers,
  servers,
  userChannelInboxStates,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { markChannelInboxDone } from "./channelService.js";
import {
  awaitPostPersistReadMutation,
  drainSenderReadReceiptsForTests,
  getSenderReadReceiptInFlightCountForTests,
  registerSenderReadReceiptForTests,
} from "./messageService.js";
import {
  admitReadMutation,
  claimNextFairReadMutation,
  claimNextReadMutation,
  compactTerminalReadMutations,
  CompatibilityReadMutationPendingError,
  drainReadMutationOutbox,
  executeCompatibilityReadMutation,
  executeReadMutationClaim,
  getReadMutationFrontier,
  ReadMutationError,
  ReadMutationFailpointError,
  resolveReadMutationUnreadBoundary,
  startReadMutationWorker,
  type ReadMutationAdmissionInput,
} from "./readMutationSequencer.js";


async function seedAuthority() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `read-sequencer-${randomUUID()}@test.invalid`,
    name: `ReadSequencer${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Read Sequencer",
    slug: `read-sequencer-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  return { owner, server };
}

async function seedScopes() {
  const db = getDb();
  const { owner, server } = await seedAuthority();
  const [sender] = await db.insert(users).values({
    email: `read-sender-${randomUUID()}@test.invalid`,
    name: `ReadSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const scopeRows = await db.insert(channels).values([
    { serverId: server.id, name: "read-scope-a", type: "channel" },
    { serverId: server.id, name: "read-scope-b", type: "channel" },
  ]).returning();
  const [scopeA, scopeB] = scopeRows;
  await db.insert(channelHumans).values([
    { channelId: scopeA.id, userId: owner.id },
    { channelId: scopeB.id, userId: owner.id },
  ]);
  await db.insert(messages).values([
    { channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "a1", seq: 1 },
    { channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "a2", seq: 2 },
    { channelId: scopeB.id, senderType: "user", senderId: sender.id, content: "b1", seq: 1 },
  ]);
  return { owner, sender, server, scopeA, scopeB };
}

async function claim(input: { serverId: string; principalId: string; leaseOwner?: string; now?: Date }) {
  const result = await claimNextReadMutation({
    ...input,
    leaseOwner: input.leaseOwner ?? "test-worker",
    leaseMs: 60_000,
  });
  assert.ok(result, "expected a claimable mutation");
  return result;
}

test("admission linearizes concurrent UUIDs and the worker cannot skip the minimum nonterminal sequence", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const makeInput = (): ReadMutationAdmissionInput => ({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });

  const [first, second] = await Promise.all([
    admitReadMutation(makeInput()),
    admitReadMutation(makeInput()),
  ]);
  const sequences = [first.authoritySeq, second.authoritySeq].sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2]);

  const rows = await getDb().select().from(readMutations);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.state === "admitted"));

  const claimN = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-a",
    leaseMs: 60_000,
  });
  assert.equal(claimN?.authoritySeq, 1);

  const blockedNPlusOne = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-b",
    leaseMs: 60_000,
  });
  assert.equal(blockedNPlusOne, null, "N+1 must remain unclaimable while N is nonterminal");

  await executeReadMutationClaim({ claim: claimN });
  const claimNPlusOne = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-b",
    leaseMs: 60_000,
  });
  assert.equal(claimNPlusOne?.authoritySeq, 2, "N+1 becomes claimable only after N terminalizes");
});

test("kinded agent authority writes only its agent cursor and requires agent channel membership", async ({ db }) => {
  const { owner, sender, server, scopeA } = await seedScopes();
  const agent = await createAgent(server.id, `read-agent-${randomUUID().slice(0, 8)}`, {
    runtime: "codex",
    creatorType: "user",
    creatorId: owner.id,
  });
  await db.insert(channelAgents).values({ channelId: scopeA.id, agentId: agent.id });
  const [unauthorizedScope] = await db.insert(channels).values({
    serverId: server.id,
    name: `agent-private-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  await db.insert(messages).values({
    channelId: unauthorizedScope.id,
    senderType: "user",
    senderId: sender.id,
    content: "private",
    seq: 1,
  });

  const ack = await executeCompatibilityReadMutation({
    serverId: server.id,
    principalKind: "agent",
    principalId: agent.id,
    mutation: { kind: "channel_read_all", scopeId: scopeA.id },
  });
  assert.equal(ack.scopes[0]?.maxReadSeq, 2);
  assert.equal(ack.scopes[0]?.readStateVersion, 1);

  const [agentCursor] = await db.select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agent.id),
    eq(agentChannelReadCursors.channelId, scopeA.id),
  ));
  assert.equal(agentCursor?.lastReadSeq, 2);
  assert.equal(agentCursor?.readStateVersion, 1);
  assert.equal(
    (await db.select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, owner.id),
      eq(userChannelReadCursors.channelId, scopeA.id),
    ))).length,
    0,
    "an agent receiver must never advance the human caller cursor",
  );

  await assert.rejects(
    executeCompatibilityReadMutation({
      serverId: server.id,
      principalKind: "agent",
      principalId: agent.id,
      mutation: { kind: "channel_read_all", scopeId: unauthorizedScope.id },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "SCOPE_NOT_FOUND",
  );
  assert.equal(
    (await db.select().from(agentChannelReadCursors).where(and(
      eq(agentChannelReadCursors.agentId, agent.id),
      eq(agentChannelReadCursors.channelId, unauthorizedScope.id),
    ))).length,
    0,
    "unauthorized agent receiver must write no agent cursor",
  );
  assert.equal(
    (await db.select().from(userChannelReadCursors).where(and(
      eq(userChannelReadCursors.userId, owner.id),
      eq(userChannelReadCursors.channelId, unauthorizedScope.id),
    ))).length,
    0,
    "unauthorized agent receiver must write no human cursor",
  );
  assert.ok(sender.id, "fixture sender remains distinct from the receiver authority");
});

test("same authority dedupes exact payload, rejects payload mismatch, and isolates another authority", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const [other] = await db.insert(users).values({
    email: `read-other-${randomUUID()}@test.invalid`,
    name: `ReadOther${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "member" });
  const mutationId = randomUUID();
  const original = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  const replay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  assert.equal(original.authoritySeq, 1);
  assert.equal(replay.outcome, "ALREADY_ADMITTED");
  assert.equal(replay.authoritySeq, original.authoritySeq);

  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "channel_read_all", scopeId: randomUUID() },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "MUTATION_ID_PAYLOAD_MISMATCH",
  );

  const isolated = await admitReadMutation({
    serverId: server.id,
    principalId: other.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  assert.equal(isolated.outcome, "ADMITTED");
  assert.equal(isolated.authoritySeq, 1, "another authority has an independent sequence and identity namespace");

  const trulyUnknown = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  assert.equal(trulyUnknown.outcome, "ADMITTED");
  assert.equal(trulyUnknown.authoritySeq, 2);
});

test("frontier pagination freezes an upper sequence and targeted lookup stays bounded", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const mutationIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const mutationId of mutationIds) {
    await admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "global_read_all" },
    });
  }
  const first = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    limit: 2,
  });
  assert.equal(first.snapshotUpperAuthoritySeq, 3);
  assert.deepEqual(first.items.map((item) => item.authoritySeq), [1, 2]);
  assert.equal(first.nextAfterAuthoritySeq, 2);
  assert.deepEqual(first.scopes, []);

  const laterMutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: laterMutationId,
    mutation: { kind: "global_read_all" },
  });
  const second = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    limit: 2,
    afterAuthoritySeq: first.nextAfterAuthoritySeq!,
    snapshotUpperAuthoritySeq: first.snapshotUpperAuthoritySeq,
  });
  assert.deepEqual(second.items.map((item) => item.authoritySeq), [3]);
  assert.equal(second.nextAfterAuthoritySeq, null);
  assert.ok(!second.items.some((item) => item.mutationId === laterMutationId));

  const targeted = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    mutationId: laterMutationId,
  });
  assert.deepEqual(targeted.items.map((item) => [item.mutationId, item.authoritySeq]), [[laterMutationId, 4]]);
});

test("expired lease steal increments generation and the stale worker commits zero effect", async ({ db }) => {
  const { owner, server, scopeA } = await seedScopes();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_read", scopeId: scopeA.id, throughSeq: 2 },
  });
  const startedAt = new Date("2026-07-21T00:00:00.000Z");
  const stale = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-stale",
    leaseMs: 1_000,
    now: startedAt,
  });
  assert.ok(stale);
  await assert.rejects(
    executeReadMutationClaim({ claim: stale, now: new Date(startedAt.getTime() + 100), failpoint: "before_effect" }),
    (error: unknown) => error instanceof ReadMutationFailpointError && error.failpoint === "before_effect",
  );
  assert.equal(await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-early",
    leaseMs: 1_000,
    now: new Date(startedAt.getTime() + 999),
  }), null);

  const winner = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "worker-winner",
    leaseMs: 1_000,
    now: new Date(startedAt.getTime() + 1_001),
  });
  assert.ok(winner);
  assert.equal(winner.leaseGeneration, stale.leaseGeneration + 1);
  await assert.rejects(
    executeReadMutationClaim({ claim: stale, now: new Date(startedAt.getTime() + 1_002) }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "CLAIM_LOST",
  );
  assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0, "stale CAS changes no cursor");

  const ack = await executeReadMutationClaim({ claim: winner, now: new Date(startedAt.getTime() + 1_002) });
  assert.equal(ack.terminalState, "applied");
  const [cursor] = await getDb().select().from(userChannelReadCursors);
  assert.equal(cursor.lastReadSeq, 2);
  assert.equal(cursor.lastAppliedAuthoritySeq, 1);
});

test("fair worker skips more than a batch of live poison leases and terminals the later healthy authority", async ({ db }) => {
  const { server } = await seedAuthority();
  const [scope] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `fair-scope-${randomUUID()}`,
    type: "channel",
  }).returning();
  const principals = await getDb().insert(users).values(Array.from({ length: 51 }, (_, index) => ({
    email: `fair-${index}-${randomUUID()}@test.invalid`,
    name: `Fair${index}${randomUUID().replaceAll("-", "").slice(0, 6)}`,
    passwordHash: "x",
    emailVerified: true,
  }))).returning();
  await getDb().insert(serverMembers).values(principals.map((principal) => ({
    serverId: server.id,
    userId: principal.id,
    role: "member" as const,
  })));
  for (const principal of principals) {
    await admitReadMutation({
      serverId: server.id,
      principalId: principal.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: scope.id },
    });
  }
  const liveLeaseNow = new Date("2099-01-01T00:00:00.000Z");
  for (const principal of principals.slice(0, 50)) {
    const poison = await claimNextReadMutation({
      serverId: server.id,
      principalId: principal.id,
      leaseOwner: `poison-${principal.id}`,
      leaseMs: 60_000,
      now: liveLeaseNow,
    });
    assert.ok(poison);
  }

  const result = await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "fair-worker" });
  assert.deepEqual(result, { processed: 1, failed: 0 });
  const [healthy] = await getDb().select().from(readMutations).where(eq(
    readMutations.principalId,
    principals[50]!.id,
  ));
  assert.ok(healthy.state === "applied" || healthy.state === "retired_no_effect");
  const poisonRows = await getDb().select().from(readMutations).where(inArray(
    readMutations.principalId,
    principals.slice(0, 50).map((principal) => principal.id),
  ));
  assert.equal(poisonRows.filter((row) => row.state === "executing").length, 50);
});

test("after-SQL and mid-global failpoints roll back every cursor and terminal receipt", async ({ db }) => {
  const { owner, server, scopeA, scopeB } = await seedScopes();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_read", scopeId: scopeA.id, throughSeq: 2 },
  });
  const first = await claim({ serverId: server.id, principalId: owner.id });
  await assert.rejects(
    executeReadMutationClaim({ claim: first, failpoint: "after_sql_before_commit" }),
    (error: unknown) => error instanceof ReadMutationFailpointError && error.failpoint === "after_sql_before_commit",
  );
  assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0);
  const [stillExecuting] = await getDb().select().from(readMutations);
  assert.equal(stillExecuting.state, "executing");
  assert.equal(stillExecuting.ack, null);

  const reclaimed = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "reclaimer",
    leaseMs: 60_000,
    now: new Date(first.leaseExpiresAt.getTime() + 1),
  });
  assert.ok(reclaimed);
  await executeReadMutationClaim({ claim: reclaimed, now: new Date(first.leaseExpiresAt.getTime() + 2) });

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const global = await claim({ serverId: server.id, principalId: owner.id, leaseOwner: "global-worker" });
  await assert.rejects(
    executeReadMutationClaim({ claim: global, failpoint: "mid_global" }),
    (error: unknown) => error instanceof ReadMutationFailpointError && error.failpoint === "mid_global",
  );
  const cursorsAfterRollback = await getDb().select().from(userChannelReadCursors);
  assert.equal(cursorsAfterRollback.length, 1, "the global transaction must not leave a partially created second scope");
  assert.equal(cursorsAfterRollback[0]?.channelId, scopeA.id);
  assert.equal(cursorsAfterRollback.some((row) => row.channelId === scopeB.id), false);
});

test("global capture is frozen, post-capture messages stay unread, and lost response is recovered from frontier", async ({ db }) => {
  const { owner, sender, server, scopeA, scopeB } = await seedScopes();
  const mutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  const global = await claim({ serverId: server.id, principalId: owner.id });
  await assert.rejects(
    executeReadMutationClaim({
      claim: global,
      failpoint: "after_commit_before_response",
      afterBoundaryCaptured: async ({ tx, boundary }) => {
        assert.deepEqual(boundary, [
          { scopeId: scopeA.id, throughSeq: 2 },
          { scopeId: scopeB.id, throughSeq: 1 },
        ].sort((left, right) => left.scopeId.localeCompare(right.scopeId)));
        await tx.insert(messages).values({
          channelId: scopeA.id,
          senderType: "user",
          senderId: sender.id,
          content: "arrived after frozen capture",
          seq: 3,
        });
      },
    }),
    (error: unknown) => error instanceof ReadMutationFailpointError && error.failpoint === "after_commit_before_response",
  );

  const [scopeACursor] = await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, scopeA.id),
  ));
  assert.equal(scopeACursor.lastReadSeq, 2, "the executor must not widen beyond the frozen capture");

  const replay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  assert.equal(replay.outcome, "ALREADY_TERMINAL");
  assert.ok(replay.terminalDigest);
  assert.equal((replay.ack as { capturedBoundary: unknown[] }).capturedBoundary.length, 2);

  const frontier = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    scopeIds: [scopeA.id, scopeB.id],
  });
  assert.equal(frontier.items.length, 1);
  assert.equal(frontier.items[0]?.state, "applied");
  assert.equal(frontier.lastTerminalAuthoritySeq, 1);
  assert.equal(frontier.scopes.find((scope) => scope.scopeId === scopeA.id)?.maxReadSeq, 2);
  assert.equal(frontier.scopes.find((scope) => scope.scopeId === scopeB.id)?.maxReadSeq, 1);
});

test("global read-all captures joined Inbox channels but never consumes unjoined public history", async ({ db }) => {
  const { owner, sender, server, scopeA, scopeB } = await seedScopes();
  const [unjoinedPublic] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `unjoined-public-${randomUUID()}`,
    type: "channel",
  }).returning();
  await getDb().insert(messages).values({
    channelId: unjoinedPublic.id,
    senderType: "user",
    senderId: sender.id,
    content: "discovery history must stay unread until join",
    seq: 1,
  });

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const ack = await executeReadMutationClaim({
    claim: await claim({ serverId: server.id, principalId: owner.id }),
  });

  assert.deepEqual(
    ack.capturedBoundary,
    [
      { scopeId: scopeA.id, throughSeq: 2 },
      { scopeId: scopeB.id, throughSeq: 1 },
    ].sort((left, right) => left.scopeId.localeCompare(right.scopeId)),
  );
  assert.equal(ack.capturedBoundary.some((scope) => scope.scopeId === unjoinedPublic.id), false);
  assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, unjoinedPublic.id),
  ))).length, 0, "global read-all must not write cursor/version/authority metadata for an unjoined public channel");
});

test("bounded row unread rewinds only to the requested boundary and advances the canonical scope frontier", async ({ db }) => {
  const { owner, server, scopeA } = await seedScopes();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_read", scopeId: scopeA.id, throughSeq: 2 },
  });
  await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_unread", scopeId: scopeA.id, throughSeq: 0 },
  });
  const ack = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(ack.scopes[0]?.maxReadSeq, 0);
  assert.equal(ack.scopes[0]?.readStateVersion, 2);
  assert.equal(ack.scopes[0]?.lastAppliedAuthoritySeq, 2);
});

test("identical global read-all is a zero-write terminal and partial change advances only the changed scope", async ({ db }) => {
  const { owner, server, scopeA, scopeB, sender } = await seedScopes();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const first = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(first.terminalState, "applied");

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const identical = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(identical.terminalState, "retired_no_effect");
  assert.equal(identical.terminalReason, "already_satisfied");
  assert.ok(identical.scopes.every((scope) => !scope.changed));
  const afterIdentical = await getDb().select().from(userChannelReadCursors).where(eq(
    userChannelReadCursors.userId,
    owner.id,
  ));
  assert.deepEqual(
    afterIdentical.map((row) => [row.channelId, row.readStateVersion, row.lastAppliedAuthoritySeq]).sort(),
    [[scopeA.id, 1, 1], [scopeB.id, 1, 1]].sort(),
  );

  await getDb().insert(messages).values({
    channelId: scopeA.id,
    senderType: "user",
    senderId: sender.id,
    content: "only scope A changed",
    seq: 3,
  });
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  const partial = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(partial.terminalState, "applied");
  assert.deepEqual(
    partial.scopes.map((scope) => [scope.scopeId, scope.changed]).sort(),
    [[scopeA.id, true], [scopeB.id, false]].sort(),
  );
  const afterPartial = await getDb().select().from(userChannelReadCursors).where(eq(
    userChannelReadCursors.userId,
    owner.id,
  ));
  assert.deepEqual(
    afterPartial.map((row) => [row.channelId, row.readStateVersion, row.lastAppliedAuthoritySeq]).sort(),
    [[scopeA.id, 2, 3], [scopeB.id, 1, 1]].sort(),
  );
});

test("absent cursor unread versions only a real target and concurrent admissions preserve effect count", async ({ db }) => {
  const { owner, server, scopeA, scopeB } = await seedScopes();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_unread", scopeId: scopeA.id, throughSeq: 1 },
  });
  const firstUnread = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.deepEqual(firstUnread.scopes[0], {
    scopeId: scopeA.id,
    maxReadSeq: 1,
    readStateVersion: 1,
    lastAppliedAuthoritySeq: 1,
    changed: true,
  });

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_unread", scopeId: scopeB.id, throughSeq: 0 },
  });
  const zeroTarget = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(zeroTarget.terminalState, "retired_no_effect");
  assert.deepEqual(zeroTarget.scopes[0], {
    scopeId: scopeB.id,
    maxReadSeq: 0,
    readStateVersion: 0,
    lastAppliedAuthoritySeq: 0,
    changed: false,
  });
  assert.equal((await getDb().select().from(userChannelReadCursors).where(eq(
    userChannelReadCursors.channelId,
    scopeB.id,
  ))).length, 0);

  await Promise.all([
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "row_read", scopeId: scopeB.id, throughSeq: 1 },
    }),
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "row_read", scopeId: scopeB.id, throughSeq: 2 },
    }),
  ]);
  await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  const [scopeBCursor] = await getDb().select().from(userChannelReadCursors).where(eq(
    userChannelReadCursors.channelId,
    scopeB.id,
  ));
  assert.equal(scopeBCursor.lastReadSeq, 2);
  assert.equal(scopeBCursor.readStateVersion, 2);
  assert.equal(scopeBCursor.lastAppliedAuthoritySeq, 4);
});

test("bounded capture keeps deleted non-DM scopes closed", async ({ db }) => {
  const { owner, server, scopeA } = await seedScopes();
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, scopeA.id));
  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: scopeA.id },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "SCOPE_NOT_FOUND",
  );
  assert.equal((await getDb().select().from(readMutations)).length, 0);
  assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0);
});

test("post-admission membership revoke terminals without effect while exact replay remains identity-first", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const [scope] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `private-revoke-${randomUUID()}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: scope.id, userId: owner.id });
  const mutationId = randomUUID();
  const admission = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "channel_read_all", scopeId: scope.id },
  });
  assert.equal(admission.authoritySeq, 1);
  await getDb().delete(channelHumans).where(and(
    eq(channelHumans.channelId, scope.id),
    eq(channelHumans.userId, owner.id),
  ));

  const ack = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(ack.terminalState, "retired_no_effect");
  assert.equal(ack.terminalReason, "authorization_revoked");
  assert.deepEqual(ack.capturedBoundary, []);
  assert.deepEqual(ack.scopes, []);
  assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0);

  const replay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "channel_read_all", scopeId: scope.id },
  });
  assert.equal(replay.outcome, "ALREADY_TERMINAL");
  assert.equal(replay.terminalReason, "authorization_revoked");
  assert.equal(replay.terminalDigest, ack.terminalDigest);
  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "row_read", scopeId: scope.id, throughSeq: 1 },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "MUTATION_ID_PAYLOAD_MISMATCH",
  );
  const frontier = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    scopeIds: [scope.id],
  });
  assert.equal(frontier.items[0]?.terminalReason, "authorization_revoked");
  assert.deepEqual(frontier.scopes, [], "revoked scope must not be enumerable from frontier");
});

test("joint channel and thread resolve only through active local projections and revoke fails closed", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const [canonicalParent, localParent] = await getDb().insert(channels).values([
    { serverId: server.id, name: `joint-storage-${randomUUID()}`, type: "joint" },
    { serverId: server.id, name: `joint-local-${randomUUID()}`, type: "joint" },
  ]).returning();
  await getDb().insert(channelHumans).values({ channelId: localParent.id, userId: owner.id });
  const [jointParent] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: jointParent.id,
    serverId: server.id,
    localChannelId: localParent.id,
    role: "host",
    status: "active",
  });
  const [parentMessage] = await getDb().insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint parent",
    seq: 10,
  }).returning();
  const [canonicalThread, localThread] = await getDb().insert(channels).values([
    {
      serverId: server.id,
      name: `joint-thread-storage-${randomUUID()}`,
      type: "thread",
      parentMessageId: parentMessage.id,
    },
    { serverId: server.id, name: `joint-thread-local-${randomUUID()}`, type: "thread" },
  ]).returning();
  const [jointThread] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: jointThread.id,
    serverId: server.id,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await getDb().insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint thread reply",
    seq: 11,
  });

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "channel_read_all", scopeId: localParent.id },
  });
  const parentAck = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.deepEqual(parentAck.capturedBoundary, [{ scopeId: localParent.id, throughSeq: 10 }]);

  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "channel_read_all", scopeId: localThread.id },
  });
  const threadAck = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.deepEqual(threadAck.capturedBoundary, [{ scopeId: localThread.id, throughSeq: 11 }]);

  const revokedMutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: revokedMutationId,
    mutation: { kind: "channel_read_all", scopeId: localParent.id },
  });
  await getDb().update(jointChannelServers).set({ status: "disconnected" }).where(and(
    eq(jointChannelServers.jointChannelId, jointParent.id),
    eq(jointChannelServers.serverId, server.id),
  ));
  const revoked = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(revoked.terminalReason, "authorization_revoked");
  assert.deepEqual(revoked.capturedBoundary, []);
  await assert.rejects(
    resolveReadMutationUnreadBoundary({
      serverId: server.id,
      principalId: owner.id,
      scopeId: localParent.id,
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "SCOPE_NOT_FOUND",
  );
  const replay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: revokedMutationId,
    mutation: { kind: "channel_read_all", scopeId: localParent.id },
  });
  assert.equal(replay.terminalReason, "authorization_revoked");
});

test("server membership revoke after admission retires without effects and does not poison later identity", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const mutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  await getDb().delete(serverMembers).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, owner.id),
  ));
  const ack = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  assert.equal(ack.terminalReason, "authorization_revoked");
  assert.deepEqual(ack.scopes, []);
  const replay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  assert.equal(replay.outcome, "ALREADY_TERMINAL");
  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "global_read_all" },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "SCOPE_NOT_FOUND",
  );
});

test("a real channelService auto-read callsite reads its terminal receipt without recursive admission", async ({ db }) => {
  const { owner, server, scopeA } = await seedScopes();
  await markChannelInboxDone(owner.id, scopeA.id, "2");

  const [inboxState] = await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, scopeA.id),
  ));
  assert.ok(inboxState.doneAt instanceof Date);
  const [cursor] = await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, scopeA.id),
  ));
  assert.equal(cursor.lastReadSeq, 2);
  assert.equal(cursor.lastAppliedAuthoritySeq, 1);

  const mutations = await getDb().select().from(readMutations).where(and(
    eq(readMutations.serverId, server.id),
    eq(readMutations.principalId, owner.id),
  ));
  assert.equal(mutations.length, 1, "private raw apply must not recurse through the compatibility wrapper");
  assert.equal(mutations[0]?.kind, "done");
  assert.equal(mutations[0]?.doneTargetKind, "channel");
  assert.equal(mutations[0]?.doneThroughSeq, 2n);
  assert.equal(mutations[0]?.state, "applied");
  assert.ok(mutations[0]?.ack);
});

test("a live predecessor lease keeps a durable compatibility admission recoverably pending", async ({ db }) => {

  const originalWarn = console.warn;
  const drainWarnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    if (args[0] === "[ReadMutationSequencer] compatibility drain attempt failed after durable admission") {
      drainWarnings.push(args);
      return;
    }
    originalWarn(...args);
  };
  try {
    const { owner, server, scopeA } = await seedScopes();
    await admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: scopeA.id },
    });
    const predecessor = await claimNextReadMutation({
      serverId: server.id,
      principalId: owner.id,
      leaseOwner: "live-predecessor",
      leaseMs: 60_000,
    });
    assert.ok(predecessor);

    let pendingReceiptCount = 0;
    await assert.rejects(
      executeCompatibilityReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutation: { kind: "channel_read_all", scopeId: scopeA.id },
        timeoutMs: 10_000,
      }),
      (error: unknown) => {
        if (error instanceof CompatibilityReadMutationPendingError && error.authoritySeq === 2) {
          pendingReceiptCount += 1;
          return true;
        }
        return false;
      },
    );
    assert.equal(pendingReceiptCount, 1);
    assert.equal(drainWarnings.length, 0, "a live predecessor is pending rather than an executor failure");

    const rows = await getDb().select().from(readMutations).where(and(
      eq(readMutations.serverId, server.id),
      eq(readMutations.principalId, owner.id),
    ));
    assert.deepEqual(rows.map((row) => [row.authoritySeq, row.state]), [
      [1, "executing"],
      [2, "admitted"],
    ]);
    assert.equal(rows[0]?.attemptCount, 1, "request-local draining must not steal a live predecessor lease");
    assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0);

    const leaseExpiresAt = rows[0]?.leaseExpiresAt;
    assert.ok(leaseExpiresAt);
    const recoveryNow = new Date(leaseExpiresAt.getTime() + 1);
    const recoveredPredecessor = await claimNextReadMutation({
      serverId: server.id,
      principalId: owner.id,
      leaseOwner: "recovered-predecessor",
      leaseMs: 60_000,
      now: recoveryNow,
    });
    assert.ok(recoveredPredecessor);
    await executeReadMutationClaim({ claim: recoveredPredecessor, now: new Date(recoveryNow.getTime() + 1) });
    const recoveredPending = await claimNextReadMutation({
      serverId: server.id,
      principalId: owner.id,
      leaseOwner: "recovered-pending",
      leaseMs: 60_000,
      now: new Date(recoveryNow.getTime() + 2),
    });
    assert.ok(recoveredPending);
    assert.equal(recoveredPending.authoritySeq, 2);
    await executeReadMutationClaim({ claim: recoveredPending, now: new Date(recoveryNow.getTime() + 3) });
    assert.deepEqual(
      (await getReadMutationFrontier({ serverId: server.id, principalId: owner.id })).items
        .filter((item) => item.state === "admitted" || item.state === "executing"),
      [],
    );
  } finally {
    console.warn = originalWarn;
    await closeTestDatabase();
  }
});

test("post-persist message reads swallow only typed pending receipts and preserve definite failures", async () => {
  const pending = new CompatibilityReadMutationPendingError(
    randomUUID(),
    randomUUID(),
    randomUUID(),
    7,
  );
  await awaitPostPersistReadMutation(Promise.reject(pending));

  const definite = new Error("definite read failure");
  await assert.rejects(
    awaitPostPersistReadMutation(Promise.reject(definite)),
    (error: unknown) => error === definite,
  );
});

test("sender read receipt lifecycle removes successful work and surfaces failures before fixture teardown", async () => {
  let releaseSuccess!: () => void;
  const successful = new Promise<void>((resolve) => {
    releaseSuccess = resolve;
  });
  registerSenderReadReceiptForTests(successful);
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 1);
  releaseSuccess();
  await drainSenderReadReceiptsForTests();
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);

  const pending = new CompatibilityReadMutationPendingError(
    randomUUID(),
    randomUUID(),
    randomUUID(),
    11,
  );
  const definite = new Error("definite sender read failure");
  registerSenderReadReceiptForTests(Promise.reject(pending));
  registerSenderReadReceiptForTests(Promise.reject(definite));
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 2);
  await assert.rejects(
    drainSenderReadReceiptsForTests(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "sender read receipt lifecycle rejected while draining");
      assert.ok(error.errors.includes(pending));
      assert.ok(error.errors.includes(definite));
      return true;
    },
  );
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
});

test("closeDatabase waits for sender read receipts before closing fixture database", async ({ db }) => {

  let releaseReadReceipt!: () => void;
  registerSenderReadReceiptForTests(new Promise<void>((resolve) => {
    releaseReadReceipt = resolve;
  }));

  let closeResolved = false;
  const closePromise = closeTestDatabase().then(() => {
    closeResolved = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closeResolved, false, "closeDatabase must wait for pending sender read receipts");
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 1);

  releaseReadReceipt();
  await closePromise;
  assert.equal(closeResolved, true);
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
});

test("closeDatabase surfaces sender read receipt failures before fixture teardown", async ({ db }) => {

  const failure = new Error("synthetic sender read failure");
  registerSenderReadReceiptForTests(Promise.reject(failure));
  await assert.rejects(
    closeDatabase(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "sender read receipt lifecycle rejected while draining");
      assert.ok(error.errors.includes(failure));
      return true;
    },
  );
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
});

test("atomic compaction preserves permanent exact replay after the 90-day horizon", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const mutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  const ack = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  await getDb().update(readMutations).set({
    terminalAt: new Date("2026-01-01T00:00:00.000Z"),
  }).where(eq(readMutations.mutationId, mutationId));

  const [compaction, concurrentReplay] = await Promise.all([
    compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") }),
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "global_read_all" },
    }),
  ]);
  assert.equal(compaction.compacted, 1);
  assert.equal(concurrentReplay.outcome, "ALREADY_TERMINAL");
  assert.equal(concurrentReplay.authoritySeq, 1);
  assert.equal(concurrentReplay.terminalDigest, ack.terminalDigest);
  assert.equal((await getDb().select().from(readMutations)).length, 0);
  assert.equal((await getDb().select().from(readMutationTombstones)).length, 1);

  const offlineReplay = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: { kind: "global_read_all" },
  });
  assert.equal(offlineReplay.outcome, "ALREADY_TERMINAL");
  assert.equal(offlineReplay.authoritySeq, 1);
  assert.equal(offlineReplay.terminalReason, ack.terminalReason);
  assert.equal(offlineReplay.terminalDigest, ack.terminalDigest);
  const compactedFrontier = await getReadMutationFrontier({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
  });
  assert.equal(compactedFrontier.items[0]?.compactedAt != null, true);
  assert.equal(compactedFrontier.items[0]?.terminalReason, ack.terminalReason);

  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "channel_read_all", scopeId: randomUUID() },
    }),
    (error: unknown) => error instanceof ReadMutationError && error.code === "MUTATION_ID_PAYLOAD_MISMATCH",
  );
  const unknown = await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });
  assert.equal(unknown.authoritySeq, 2);
  const secondAck = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  await getDb().update(readMutations).set({
    terminalAt: new Date("2026-01-02T00:00:00.000Z"),
  }).where(eq(readMutations.mutationId, unknown.mutationId));
  const concurrentMaintainers = await Promise.all([
    compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") }),
    compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") }),
  ]);
  assert.equal(concurrentMaintainers.reduce((sum, result) => sum + result.compacted, 0), 1);
  const tombstones = await getDb().select().from(readMutationTombstones);
  assert.equal(tombstones.length, 2);
  assert.equal(tombstones.find((row) => row.mutationId === unknown.mutationId)?.terminalReason, secondAck.terminalReason);
  const [authority] = await getDb().select().from(readMutationAuthorities);
  assert.equal(authority.nextAuthoritySeq, 3);
});

test("production worker owns independent stoppable drain and compaction timers", async ({ db }) => {
  readMutationWorkerDrainsTotal.reset();
  readMutationWorkerDrainDuration.reset();
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const worker = startReadMutationWorker({
    intervalMs: 25,
    compactionIntervalMs: 1_000,
    clock: {
      scheduleEvery(fn, ms) {
        const handle = { index: scheduled.length };
        scheduled.push({ fn, ms });
        return handle;
      },
      clearInterval(handle) {
        cleared.push(handle);
      },
    },
  });
  assert.deepEqual(scheduled.map((entry) => entry.ms), [25, 1_000]);
  const deadline = Date.now() + 5_000;
  let emptyDrainCount = 0;
  while (Date.now() < deadline) {
    const metric = await readMutationWorkerDrainsTotal.get();
    emptyDrainCount = metric.values.find((value) => value.labels.outcome === "empty")?.value ?? 0;
    if (emptyDrainCount > 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  worker.stop();
  assert.equal(cleared.length, 2);
  assert.equal(emptyDrainCount, 1, "the initial idle poll must be observable as an empty worker drain");
  const duration = await readMutationWorkerDrainDuration.get();
  assert.equal(
    duration.values.find((value) => (
      value.metricName === "slock_read_mutation_worker_drain_duration_seconds_count"
      && value.labels.outcome === "empty"
    ))?.value,
    1,
    "the initial idle poll must emit a duration observation",
  );
});

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));

test.skipIf(inSourceSnapshot)("required typecheck CI pins the real-PostgreSQL sequencer contract and cannot silently skip it", async () => {
  const workflow = await readFile(new URL("../../../../.github/workflows/test.yml", import.meta.url), "utf8");
  const typecheckJob = workflow.match(/\n  typecheck:\n(?<body>[\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/)?.groups?.body;
  assert.ok(typecheckJob, "typecheck job must remain present");
  assert.match(typecheckJob, /services:\s*\n\s+postgres:\s*\n\s+image: postgres:16-alpine/);
  assert.match(typecheckJob, /--health-cmd "pg_isready -U read_mutation_ci -d postgres"/);
  const focusedStep = typecheckJob.match(
    /- name: Read mutation sequencer real PostgreSQL contract(?<body>[\s\S]*?)(?=\n\s+- name:)/,
  )?.groups?.body;
  assert.ok(focusedStep, "required typecheck job must execute the focused real-PG contract");
  assert.match(focusedStep, /timeout-minutes: 3/);
  assert.match(focusedStep, /READ_MUTATION_REAL_PG_REQUIRED: "1"/);
  assert.match(focusedStep, /READ_MUTATION_REAL_PG_URL: postgresql:\/\/read_mutation_ci:/);
  assert.match(
    focusedStep,
    /pnpm exec vitest run src\/services\/readMutationSequencer\.realPg\.test\.ts/,
  );
  assert.doesNotMatch(focusedStep, /continue-on-error/);
});

test("a contended claim at batchSize=1 does not consume the only work slot", async ({ db }) => {
  // Review finding on PR #6110 (croxx): with the retry expressed as a bare
  // `continue` inside the counted for-loop, a collision at batchSize=1 -- the
  // exact shape of the fairness red in CI run 31096794334/attempt 1 -- spent
  // the loop's only iteration and returned processed=0, identical to the old
  // conflation. This is the deterministic pair for that behavior: a claim
  // source that collides once and then yields real work must still produce
  // processed=1 in a batchSize=1 round.

  const { owner, server } = await seedAuthority();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "global_read_all" },
  });

  let collisions = 0;
  const collideOnceThenReal: typeof claimNextFairReadMutation = async (input) => {
    if (collisions === 0) {
      collisions += 1;
      return "contended";
    }
    return claimNextFairReadMutation(input);
  };

  const result = await drainReadMutationOutbox({
    batchSize: 1,
    leaseOwner: "contended-then-real",
    claimNext: collideOnceThenReal,
  });
  // Old behavior: the collision consumed the only slot => { processed: 0 }.
  assert.deepEqual(result, { processed: 1, failed: 0 });
  assert.equal(collisions, 1, "the synthetic collision must actually have fired");

  // And the finite bound holds when EVERY claim collides: the round ends
  // instead of spinning, with nothing processed.
  const alwaysContended: typeof claimNextFairReadMutation = async () => "contended";
  const bounded = await drainReadMutationOutbox({
    batchSize: 3,
    leaseOwner: "always-contended",
    claimNext: alwaysContended,
  });
  assert.deepEqual(bounded, { processed: 0, failed: 0 });
});
