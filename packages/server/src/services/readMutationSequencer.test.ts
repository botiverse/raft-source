import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { and, eq, inArray, sql } from "drizzle-orm";

import { closeDatabase, getDb } from "../db/index";
import {
  readMutationWorkerDrainDuration,
  readMutationWorkerDrainsTotal,
} from "../metrics";
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
  threadFollows,
  servers,
  userChannelInboxStates,
  userChannelReadCursors,
  users,
} from "../db/schema";
import { createAgent } from "./agentService";
import { markChannelInboxDone } from "./channelService";
import { seedBoundGuest } from "../test/guestFixture";
import {
  awaitPostPersistReadMutation,
  drainSenderReadReceiptsForTests,
  getSenderReadReceiptInFlightCountForTests,
  registerSenderReadReceiptForTests,
} from "./messageService";
import {
  admitReadMutation,
  claimNextFairReadMutation,
  claimNextReadMutation,
  compactTerminalReadMutations,
  setBeforeCompactionDeleteForTests,
  CompatibilityReadMutationPendingError,
  drainReadMutationOutbox,
  executeCompatibilityReadMutation,
  executeReadMutationClaim,
  getReadMutationFrontier,
  isReadMutationFenceRefusal,
  ReadMutationError,
  ReadMutationFailpointError,
  resolveReadMutationUnreadBoundary,
  startReadMutationWorker,
  type ReadMutationAdmissionInput,
} from "./readMutationSequencer";


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

test("row_unread decides its count and outcome from the state it wrote: a countable message arriving after the boundary read is counted", async ({ db }) => {
  const { owner, sender, server } = await seedScopes();
  const [scope] = await db.insert(channels).values({ serverId: server.id, name: "read-scope-race", type: "channel" }).returning();
  await db.insert(channelHumans).values({ channelId: scope.id, userId: owner.id });
  await db.insert(messages).values({ channelId: scope.id, senderType: "user", senderId: owner.id, content: "mine", seq: 1 });
  // The boundary read before the write found nothing countable (throughSeq 0)...
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: { kind: "row_unread", scopeId: scope.id, throughSeq: 0 },
  });
  // ...and the peer's message lands before the write's transaction.
  await db.insert(messages).values({ channelId: scope.id, senderType: "user", senderId: sender.id, content: "news", seq: 2 });

  const ack = await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  const [written] = ack.scopes;
  assert.equal(written?.unreadOutcome, "counted");
  // Counted implies a count, from the same read: the seq distance from the
  // written cursor (0) to the latest countable message (2), the /unread measure.
  assert.equal(written?.maxReadSeq, 0);
  assert.equal(written?.unreadCount, 2);
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
    unreadCount: 1,
    unreadOutcome: "counted",
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
    // No cursor: the peer's messages already count.
    unreadCount: 1,
    unreadOutcome: "counted",
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
  await fillJointMembersFromChannelHumans();
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
  await fillJointMembersFromChannelHumans();
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
  // Task #93 line B, declared behaviour delta: admission fences on the Server membership row before it looks up an
  // existing receipt. Before line B this replay of the same mutation id answered ALREADY_TERMINAL — the terminal result
  // of work that had already completed; a member removed after admission is now refused instead. The fresh admission
  // below was refused too, but with SCOPE_NOT_FOUND from the scope read; the fence reason is the stricter one. Neither
  // path writes or undoes anything, and the mutation stays terminal (asserted above).
  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId,
      mutation: { kind: "global_read_all" },
    }),
    (error: unknown) => isReadMutationFenceRefusal(error),
  );
  await assert.rejects(
    admitReadMutation({
      serverId: server.id,
      principalId: owner.id,
      mutationId: randomUUID(),
      mutation: { kind: "global_read_all" },
    }),
    (error: unknown) => isReadMutationFenceRefusal(error),
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

test("compaction takes the oldest expired rows across both terminal states, up to the limit", async ({ db }) => {
  void db;
  const { owner, server } = await seedAuthority();
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const mutationId = randomUUID();
    ids.push(mutationId);
    await admitReadMutation({ serverId: server.id, principalId: owner.id, mutationId, mutation: { kind: "global_read_all" } });
    await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  }
  // Interleave the two terminal states by age: applied 01-01, retired 01-02,
  // applied 01-03, retired 01-04. A limit of 3 must take the three oldest,
  // whichever state each one is in.
  for (const [index, mutationId] of ids.entries()) {
    await getDb().update(readMutations).set({
      state: index % 2 === 0 ? "applied" : "retired_no_effect",
      terminalAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
    }).where(eq(readMutations.mutationId, mutationId));
  }

  const result = await compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z"), limit: 3 });
  assert.equal(result.compacted, 3);
  const left = await getDb().select({ mutationId: readMutations.mutationId }).from(readMutations)
    .where(inArray(readMutations.mutationId, ids));
  assert.deepEqual(left.map((row) => row.mutationId), [ids[3]], "only the newest expired row is left");
});

test("one principal's expired rows move together, and a chunk that changes mid-move rolls back whole", async ({ db }) => {
  void db;
  const { owner, server } = await seedAuthority();
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const mutationId = randomUUID();
    ids.push(mutationId);
    await admitReadMutation({ serverId: server.id, principalId: owner.id, mutationId, mutation: { kind: "global_read_all" } });
    await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  }
  await getDb().update(readMutations).set({ terminalAt: new Date("2026-01-01T00:00:00.000Z") })
    .where(inArray(readMutations.mutationId, ids));

  // A row that cannot be deleted mid-move (as if the drain had changed it):
  // the whole chunk must stay, tombstones included.
  await getDb().execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_keep_one_read_mutation() RETURNS trigger AS $$
    BEGIN
      IF OLD.mutation_id = '${ids[1]}'::uuid THEN RETURN NULL; END IF;
      RETURN OLD;
    END $$ LANGUAGE plpgsql
  `));
  await getDb().execute(sql.raw(`
    CREATE TRIGGER test_keep_one_read_mutation BEFORE DELETE ON read_mutations
      FOR EACH ROW EXECUTE FUNCTION test_keep_one_read_mutation()
  `));
  const blocked = await compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") });
  assert.equal(blocked.compacted, 0, "a chunk with a row that changed mid-move moves nothing");
  assert.equal((await getDb().select().from(readMutations).where(inArray(readMutations.mutationId, ids))).length, 3);
  assert.equal((await getDb().select().from(readMutationTombstones).where(inArray(readMutationTombstones.mutationId, ids))).length, 0,
    "no tombstone without its delete");

  await getDb().execute(sql.raw("DROP TRIGGER test_keep_one_read_mutation ON read_mutations"));
  await getDb().execute(sql.raw("DROP FUNCTION test_keep_one_read_mutation()"));
  const moved = await compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") });
  assert.equal(moved.compacted, 3, "all three of the principal's rows move in one go");
  assert.equal((await getDb().select().from(readMutations).where(inArray(readMutations.mutationId, ids))).length, 0);
  assert.equal((await getDb().select().from(readMutationTombstones).where(inArray(readMutationTombstones.mutationId, ids))).length, 3);
});

test("a row whose digest changes between the identity check and the delete rolls the chunk back", async ({ db }) => {
  void db;
  const { owner, server } = await seedAuthority();
  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const mutationId = randomUUID();
    ids.push(mutationId);
    await admitReadMutation({ serverId: server.id, principalId: owner.id, mutationId, mutation: { kind: "global_read_all" } });
    await executeReadMutationClaim({ claim: await claim({ serverId: server.id, principalId: owner.id }) });
  }
  await getDb().update(readMutations).set({ terminalAt: new Date("2026-01-01T00:00:00.000Z") })
    .where(inArray(readMutations.mutationId, ids));
  setBeforeCompactionDeleteForTests(async (tx) => {
    await tx.execute(sql`UPDATE read_mutations SET terminal_digest = terminal_digest || '-changed' WHERE mutation_id = ${ids[0]}::uuid`);
  });
  try {
    const result = await compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") });
    assert.equal(result.compacted, 0, "a row that no longer matches its tombstone moves nothing in its chunk");
  } finally {
    setBeforeCompactionDeleteForTests(null);
  }
  const rows = await getDb().select().from(readMutations).where(inArray(readMutations.mutationId, ids));
  assert.equal(rows.length, 2, "both rows stay");
  assert.ok(!rows.some((row) => row.terminalDigest?.endsWith("-changed")), "the in-chunk change rolled back too");
  assert.equal((await getDb().select().from(readMutationTombstones).where(inArray(readMutationTombstones.mutationId, ids))).length, 0, "no tombstone stays");
  assert.equal((await compactTerminalReadMutations({ before: new Date("2026-07-21T00:00:00.000Z") })).compacted, 2, "the next pass moves both");
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

test.skipIf(inSourceSnapshot)("staging integration CI pins the real-PostgreSQL sequencer contract and cannot silently skip it", async () => {
  const workflow = await readFile(new URL("../../../../.github/workflows/test.yml", import.meta.url), "utf8");
  const integrationJob = workflow.match(/\n  integration-contracts:\n(?<body>[\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/)?.groups?.body;
  assert.ok(integrationJob, "integration job must remain present");
  assert.match(integrationJob, /services:\s*\n\s+postgres:\s*\n\s+image: postgres:17-alpine/);
  assert.match(integrationJob, /--health-cmd "pg_isready -U read_mutation_ci -d postgres"/);
  const focusedStep = integrationJob.match(
    /- name: Read mutation sequencer real PostgreSQL contract(?<body>[\s\S]*?)(?=\n\s+- name:)/,
  )?.groups?.body;
  assert.ok(focusedStep, "required integration job must execute the focused real-PG contract");
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


test("conversation read-all covers its active follows only and replay keeps the captured frontier", async ({ db }) => {
  const { owner, sender, server, scopeA, scopeB } = await seedScopes();
  await db.insert(messages).values([3, 4, 5].map((seq) => ({
    channelId: scopeA.id, senderType: "user" as const, senderId: sender.id, content: `parent ${seq}`, seq,
  })));
  const parentsA = await db.select().from(messages).where(eq(messages.channelId, scopeA.id)).orderBy(messages.seq);
  const [parentB] = await db.select().from(messages).where(eq(messages.channelId, scopeB.id)).limit(1);
  const threads = await db.insert(channels).values([
    { serverId: server.id, name: "active-a", type: "thread", parentMessageId: parentsA[0].id },
    { serverId: server.id, name: "active-b", type: "thread", parentMessageId: parentsA[1].id },
    { serverId: server.id, name: "unfollowed", type: "thread", parentMessageId: parentsA[2].id },
    { serverId: server.id, name: "done", type: "thread", parentMessageId: parentsA[3].id },
    { serverId: server.id, name: "not-followed", type: "thread", parentMessageId: parentsA[4].id },
    { serverId: server.id, name: "other-parent", type: "thread", parentMessageId: parentB.id },
  ]).returning();
  for (const [index, thread] of threads.entries()) {
    await db.insert(messages).values({ channelId: thread.id, senderType: "user", senderId: sender.id, content: "reply", seq: 3 });
    if (index === 4) continue;
    await db.insert(threadFollows).values({
      followerType: "user", followerId: owner.id, threadChannelId: thread.id,
      parentMessageId: index === 5 ? parentB.id : parentsA[index].id, reason: "manual",
      ...(index === 2 ? { unfollowedAt: new Date() } : {}),
      ...(index === 3 ? { doneAt: new Date() } : {}),
    });
  }
  const mutationId = randomUUID();
  const input = { serverId: server.id, principalId: owner.id, mutationId, mutation: { kind: "conversation_read_all" as const, scopeId: scopeA.id } };
  await admitReadMutation(input);
  const ack = await executeReadMutationClaim({
    claim: await claim(input),
    afterBoundaryCaptured: async ({ tx }) => {
      await tx.insert(messages).values([
        { channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "new parent arrival", seq: 6 },
        { channelId: threads[0].id, senderType: "user", senderId: sender.id, content: "new reply arrival", seq: 4 },
      ]);
    },
  });
  assert.deepEqual(ack.scopes.map((scope) => scope.scopeId).sort(), [scopeA.id, threads[0].id, threads[1].id].sort());
  const cursors = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, owner.id));
  assert.deepEqual(new Map(cursors.map((row) => [row.channelId, row.lastReadSeq])),
    new Map([[scopeA.id, 5], [threads[0].id, 3], [threads[1].id, 3]]));
  const replay = await admitReadMutation(input);
  assert.deepEqual(replay.ack, ack, "same mutation UUID never sweeps arrivals beyond its captured boundary");
  const follows = await db.select().from(threadFollows).where(eq(threadFollows.followerId, owner.id));
  assert.equal(follows.filter((row) => row.doneAt != null).length, 1);
  assert.equal(follows.filter((row) => row.unfollowedAt != null).length, 1);
});

test("conversation read-all rejects thread roots and retires without writes after parent access is revoked", async ({ db }) => {
  const { owner, sender, server, scopeA } = await seedScopes();
  await db.update(channels).set({ type: "private" }).where(eq(channels.id, scopeA.id));
  const [parent] = await db.select().from(messages).where(eq(messages.channelId, scopeA.id)).limit(1);
  const [thread] = await db.insert(channels).values({ serverId: server.id, name: "private-follow", type: "thread", parentMessageId: parent.id }).returning();
  await db.insert(messages).values({ channelId: thread.id, senderType: "user", senderId: sender.id, content: "private reply", seq: 3 });
  await db.insert(threadFollows).values({ followerType: "user", followerId: owner.id, threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual" });
  await assert.rejects(admitReadMutation({
    serverId: server.id, principalId: owner.id, mutationId: randomUUID(),
    mutation: { kind: "conversation_read_all", scopeId: thread.id },
  }), /conversation read scope/);
  const input = { serverId: server.id, principalId: owner.id, mutationId: randomUUID(), mutation: { kind: "conversation_read_all" as const, scopeId: scopeA.id } };
  await admitReadMutation(input);
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, scopeA.id), eq(channelHumans.userId, owner.id)));
  const ack = await executeReadMutationClaim({ claim: await claim(input) });
  assert.deepEqual(ack.scopes, []);
  assert.equal((await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, owner.id))).length, 0);
});

test("conversation read-all uses local joint cursors with canonical message frontiers", async ({ db }) => {
  const { owner, server } = await seedAuthority();
  const [storageParent, localParent] = await db.insert(channels).values([
    { serverId: server.id, name: "conversation-storage", type: "joint" },
    { serverId: server.id, name: "conversation-local", type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: localParent.id, userId: owner.id });
  const [jointParent] = await db.insert(jointChannels).values({
    canonicalChannelId: storageParent.id, createdByServerId: server.id, createdByUserId: owner.id, status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointParent.id, serverId: server.id, localChannelId: localParent.id, role: "host", status: "active",
  });
  await fillJointMembersFromChannelHumans();
  const [parent] = await db.insert(messages).values({
    channelId: storageParent.id, senderType: "user", senderId: owner.id, content: "canonical parent", seq: 10,
  }).returning();
  const [storageThread, localThread] = await db.insert(channels).values([
    { serverId: server.id, name: "conversation-thread-storage", type: "thread", parentMessageId: parent.id },
    { serverId: server.id, name: "conversation-thread-local", type: "thread" },
  ]).returning();
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: storageThread.id, createdByServerId: server.id, createdByUserId: owner.id, status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointThread.id, serverId: server.id, localChannelId: localThread.id, role: "host", status: "active",
  });
  await fillJointMembersFromChannelHumans();
  await db.insert(threadFollows).values({
    followerType: "user", followerId: owner.id, threadChannelId: localThread.id, parentMessageId: parent.id, reason: "manual",
  });
  await db.insert(messages).values({
    channelId: storageThread.id, senderType: "user", senderId: owner.id, content: "canonical reply", seq: 11,
  });
  const ack = await executeCompatibilityReadMutation({
    serverId: server.id, principalId: owner.id,
    mutation: { kind: "conversation_read_all", scopeId: localParent.id },
  });
  assert.deepEqual(new Map(ack.scopes.map((scope) => [scope.scopeId, scope.maxReadSeq])),
    new Map([[localParent.id, 10], [localThread.id, 11]]));
  const cursors = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, owner.id));
  assert.deepEqual(cursors.map((row) => row.channelId).sort(), [localParent.id, localThread.id].sort(),
    "canonical storage IDs must never become this user's cursor keys");
});


test("conversation read-all rechecks the Guest's one channel and hidden all policy at execution", async ({ db }) => {
  const { owner, sender, server, scopeA, scopeB } = await seedScopes();
  // A Guest bound to another channel reads nothing here (#wg-rbac:#15).
  await seedBoundGuest({ serverId: server.id, userId: owner.id }, db);
  const execute = (scopeId = scopeA.id) => executeCompatibilityReadMutation({
    serverId: server.id, principalId: owner.id,
    mutation: { kind: "conversation_read_all", scopeId },
  });
  assert.deepEqual((await execute()).scopes, [], "a Guest of another channel cannot advance this one's cursors");
  await seedBoundGuest({ serverId: server.id, userId: owner.id, channelId: scopeA.id }, db);
  assert.equal((await execute()).scopes.find((scope) => scope.scopeId === scopeA.id)?.maxReadSeq, 2,
    "the Guest's joined channel remains readable");
  assert.deepEqual((await execute(scopeB.id)).scopes, [], "another channel it is a member of is not its channel");
  await db.update(channels).set({ name: "all", type: "private" }).where(eq(channels.id, scopeA.id));
  await db.insert(messages).values({ channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "hidden activity", seq: 3 });
  assert.deepEqual((await execute()).scopes, [], "stale membership never exposes hidden #all activity");
  const [cursor] = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, owner.id), eq(userChannelReadCursors.channelId, scopeA.id)));
  assert.equal(cursor.lastReadSeq, 2);
});


test("manual unread skips own messages, self-caused system events and noise", async ({ db }) => {
  const { owner, sender, server, scopeA, scopeB } = await seedScopes();
  await db.insert(messages).values([
    { channelId: scopeA.id, senderType: "user", senderId: owner.id, content: "own chat", seq: 3 },
    { channelId: scopeA.id, senderType: "user", senderId: "system", content: "own action", seq: 4,
      messageType: "system", causalActorType: "user", causalActorId: owner.id, systemSubtype: "channel.member_joined" },
    { channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "noise", seq: 5,
      messageType: "system", systemSubtype: "channel.self_unfollow_thread" },
    { channelId: scopeA.id, senderType: "user", senderId: sender.id, content: "deleted task", seq: 6,
      messageType: "system", systemSubtype: "task.deleted_summary" },
  ]);
  assert.deepEqual(await resolveReadMutationUnreadBoundary({ serverId: server.id, principalId: owner.id, scopeId: scopeA.id }),
    { latestUnreadEligibleSeq: 2, throughSeq: 1 });
  await db.delete(messages).where(eq(messages.channelId, scopeB.id));
  await db.insert(messages).values([
    { channelId: scopeB.id, senderType: "user", senderId: owner.id, content: "only own", seq: 10 },
    { channelId: scopeB.id, senderType: "user", senderId: "system", content: "own action", seq: 11,
      messageType: "system", causalActorType: "user", causalActorId: owner.id, systemSubtype: "channel.member_joined" },
  ]);
  assert.deepEqual(await resolveReadMutationUnreadBoundary({ serverId: server.id, principalId: owner.id, scopeId: scopeB.id }),
    { latestUnreadEligibleSeq: 0, throughSeq: 0 });
});
