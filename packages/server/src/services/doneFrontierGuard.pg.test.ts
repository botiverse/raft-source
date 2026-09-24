import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  inboxNotificationFacts,
  inboxSuppressionStates,
  jointChannelServers,
  jointChannels,
  messages,
  readMutations,
  serverMembers,
  servers,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import {
  getInboxItems,
  markChannelInboxActive,
  markChannelInboxDone,
  markThreadDone,
} from "./channelService.js";
import {
  DoneFrontierAboveInt4AuthorityError,
  DoneFrontierBeyondLatestError,
  DoneFrontierRequiredError,
} from "./inboxSuppressionWriters.js";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
} from "./readMutationSequencer.js";


async function seedFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `done-frontier-${randomUUID()}@test.invalid`,
    name: `DoneFrontier${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Done Frontier",
    slug: `done-frontier-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [withMessages, empty, high] = await db.insert(channels).values([
    { serverId: server.id, name: "with-messages", type: "channel" },
    { serverId: server.id, name: "empty", type: "channel" },
    { serverId: server.id, name: "high", type: "channel" },
  ]).returning();
  await db.insert(channelHumans).values([
    { channelId: withMessages.id, userId: owner.id },
    { channelId: empty.id, userId: owner.id },
    { channelId: high.id, userId: owner.id },
  ]);
  const [sender] = await db.insert(users).values({
    email: `done-sender-${randomUUID()}@test.invalid`,
    name: `DoneSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  await db.insert(messages).values([
    { channelId: withMessages.id, senderType: "user", senderId: sender.id, content: "m1", seq: 1 },
    { channelId: withMessages.id, senderType: "user", senderId: sender.id, content: "m2", seq: 2 },
    { channelId: withMessages.id, senderType: "user", senderId: sender.id, content: "m3", seq: 3 },
    {
      channelId: high.id,
      senderType: "user",
      senderId: sender.id,
      content: "first value outside int4",
      seq: 2_147_483_648,
    },
  ]);
  return { owner, server, withMessages, empty, high };
}

async function readDoneThroughExact(channelId: string, userId: string): Promise<string | null> {
  const result = await getDb().execute(sql`
    SELECT done_through_seq::text AS "doneThroughSeq"
    FROM inbox_suppression_states
    WHERE receiver_id = ${userId}::uuid
      AND target_channel_id = ${channelId}::uuid
    LIMIT 1
  `);
  return (result.rows[0] as { doneThroughSeq?: string } | undefined)?.doneThroughSeq ?? null;
}

test("0216 keeps the superset shape check unvalidated while enforcing every new row", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  const constraint = await getDb().execute(sql`
    SELECT convalidated
    FROM pg_constraint
    WHERE conrelid = 'read_mutations'::regclass
      AND conname = 'read_mutations_scope_shape'
  `);
  assert.deepEqual(
    constraint.rows,
    [{ convalidated: false }],
    "0216 deliberately avoids a historical-table validation scan in the deploy transaction",
  );

  await assert.rejects(
    getDb().execute(sql`
      INSERT INTO read_mutations (
        server_id,
        principal_type,
        principal_id,
        mutation_id,
        payload_hash,
        authority_seq,
        kind,
        scope_id
      ) VALUES (
        ${server.id}::uuid,
        'human',
        ${owner.id}::uuid,
        ${randomUUID()}::uuid,
        'invalid-new-done-shape',
        1,
        'done',
        ${withMessages.id}::uuid
      )
    `),
    (error: unknown) => {
      let current: unknown = error;
      const seen = new Set<unknown>();
      while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const candidate = current as { cause?: unknown; constraint?: unknown; message?: unknown };
        if (
          candidate.constraint === "read_mutations_scope_shape"
          || /read_mutations_scope_shape/i.test(String(candidate.message ?? ""))
        ) return true;
        current = candidate.cause;
      }
      return false;
    },
    "NOT VALID must still reject a malformed newly inserted Done row",
  );
});

test("Done frontier rejects invalid/empty/beyond with zero admission and persists an exact monotonic composite", async ({ db }) => {
  const { owner, withMessages, empty } = await seedFixture();

  for (const invalid of [null, 3, "0", "03"]) {
    await assert.rejects(
      () => markChannelInboxDone(owner.id, withMessages.id, invalid),
      (error: unknown) => error instanceof DoneFrontierRequiredError,
    );
  }
  await assert.rejects(
    () => markChannelInboxDone(owner.id, empty.id, "1"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
  );
  await assert.rejects(
    () => markChannelInboxDone(owner.id, withMessages.id, "4"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
  );
  assert.equal((await getDb().select().from(readMutations)).length, 0, "rejected commands admit no mutation");
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), null);

  const first = await markChannelInboxDone(owner.id, withMessages.id, "3");
  assert.equal(first.terminalReason, "effect_applied");
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), "3");

  const lower = await markChannelInboxDone(owner.id, withMessages.id, "1");
  assert.equal(
    lower.terminalReason,
    "effect_applied",
    "a valid Done is applied even when its bounded cursor was already satisfied",
  );
  assert.equal(lower.scopes[0]?.changed, false);
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), "3", "GREATEST never regresses");

  await markChannelInboxActive(owner.id, withMessages.id);
  const freshDoneWithSatisfiedCursor = await markChannelInboxDone(owner.id, withMessages.id, "1");
  assert.equal(freshDoneWithSatisfiedCursor.terminalReason, "effect_applied");
  assert.equal(freshDoneWithSatisfiedCursor.scopes[0]?.changed, false);
  assert.equal(
    await readDoneThroughExact(withMessages.id, owner.id),
    "1",
    "a newly active row can become Done even when its cursor already covers S",
  );

  await assert.rejects(
    () => markThreadDone(owner.id, withMessages.id, null),
    (error: unknown) => error instanceof DoneFrontierRequiredError,
  );
});

test("writer-first Done keeps post-frontier channel activity visible while bounding cursor and suppression at S", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: withMessages.id,
      throughSeq: "3",
    },
  });
  const claim = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "writer-first-visibility",
    leaseMs: 60_000,
  });
  assert.ok(claim);

  const [postFrontier] = await getDb().insert(messages).values({
    channelId: withMessages.id,
    senderType: "user",
    senderId: owner.id,
    content: "post-frontier activity must survive Done(S)",
    seq: 4,
  }).returning();

  const ack = await executeReadMutationClaim({ claim });
  assert.equal(ack.terminalReason, "effect_applied");
  assert.deepEqual(ack.capturedBoundary, [{ scopeId: withMessages.id, throughSeq: "3" }]);

  const [inboxState] = await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, withMessages.id),
  ));
  assert.ok(inboxState, "Done capture must lock or create the broad state row");
  assert.equal(inboxState.doneAt, null, "latest>S must not set the whole-row Done marker");

  const [cursor] = await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, withMessages.id),
  ));
  assert.equal(cursor?.lastReadSeq, 3, "cursor must remain bounded at S");
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), "3", "suppression must remain bounded at S");

  const inbox = await getInboxItems(server.id, owner.id, {
    forceCanonicalPostgres: true,
    humanActivityMuteEnabled: false,
  });
  const active = inbox.items.find((item) => item.kind !== "thread" && item.channelId === withMessages.id);
  assert.ok(active, "canonical Inbox must retain the row containing post-S activity");
  if (active.kind === "thread") throw new Error("channel visibility tooth resolved a thread row");
  assert.equal(active.lastMessageId, postFrontier.id);
  assert.equal(active.latestActivitySeq, String(postFrontier.seq));
});

test("2147483648 is rejected by the distinct phase fence before every composite leg", async ({ db }) => {
  const { owner, server, high } = await seedFixture();
  await assert.rejects(
    () => markChannelInboxDone(owner.id, high.id, "2147483648"),
    (error: unknown) => (
      error instanceof DoneFrontierAboveInt4AuthorityError
      && error.code === "DONE_FRONTIER_ABOVE_INT4_AUTHORITY"
      && error.phase === "shadow_widen"
    ),
  );

  assert.equal((await getDb().select().from(readMutations).where(eq(readMutations.serverId, server.id))).length, 0);
  assert.equal((await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, high.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, high.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, owner.id),
    eq(inboxSuppressionStates.targetChannelId, high.id),
  ))).length, 0);
});

test("reactivation clears a previously committed bounded Done suppression", async ({ db }) => {
  const { owner, withMessages } = await seedFixture();
  await markChannelInboxDone(owner.id, withMessages.id, undefined);
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), "3");
  await markChannelInboxActive(owner.id, withMessages.id);
  assert.equal(await readDoneThroughExact(withMessages.id, owner.id), null);
});

test("local zero-reply thread Done uses its parent frontier and commits all three legs", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  const [parent] = await getDb().insert(messages).values({
    channelId: withMessages.id,
    senderType: "user",
    senderId: owner.id,
    content: "zero-reply thread parent",
    seq: 10,
  }).returning();
  const [thread] = await getDb().insert(channels).values({
    serverId: server.id,
    name: "zero-reply-thread",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "authored",
  });

  const ack = await markThreadDone(owner.id, thread.id, undefined);
  assert.equal(ack.terminalReason, "effect_applied");
  assert.deepEqual(ack.capturedBoundary, [{ scopeId: thread.id, throughSeq: "10" }]);
  const [follow] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, thread.id),
    eq(threadFollows.followerId, owner.id),
  ));
  assert.ok(follow?.doneAt);
  const [cursor] = await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, thread.id),
  ));
  assert.equal(cursor?.lastReadSeq, 10);
  assert.equal(await readDoneThroughExact(thread.id, owner.id), "10");
});

test("joint channel and joint thread Done keep local state while locking canonical content", async ({ db }) => {
  const { owner, server } = await seedFixture();
  const [canonicalParent, localParent] = await getDb().insert(channels).values([
    { serverId: server.id, name: "joint-done-canonical", type: "joint" },
    { serverId: server.id, name: "joint-done-local", type: "joint" },
  ]).returning();
  await getDb().insert(channelHumans).values({ channelId: localParent.id, userId: owner.id });
  const [parentJoint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: parentJoint.id,
    serverId: server.id,
    localChannelId: localParent.id,
    role: "host",
    status: "active",
  });
  const [parent] = await getDb().insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint parent frontier",
    seq: 20,
  }).returning();
  const [canonicalThread, localThread] = await getDb().insert(channels).values([
    {
      serverId: server.id,
      name: "joint-done-thread-canonical",
      type: "thread",
      parentMessageId: parent.id,
    },
    { serverId: server.id, name: "joint-done-thread-local", type: "thread" },
  ]).returning();
  const [threadJoint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: threadJoint.id,
    serverId: server.id,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await getDb().insert(threadFollows).values({
    threadChannelId: localThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "authored",
  });
  await getDb().insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint reply frontier",
    seq: 21,
  });

  const channelAck = await markChannelInboxDone(owner.id, localParent.id, "20");
  const threadAck = await markThreadDone(owner.id, localThread.id, "21");
  assert.equal(channelAck.terminalReason, "effect_applied");
  assert.equal(threadAck.terminalReason, "effect_applied");

  const cursors = await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    inArray(userChannelReadCursors.channelId, [localParent.id, localThread.id]),
  ));
  assert.deepEqual(
    cursors.map((row) => [row.channelId, row.lastReadSeq]).sort(),
    [[localParent.id, 20], [localThread.id, 21]].sort(),
  );
  const suppressions = await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, owner.id),
    inArray(inboxSuppressionStates.targetChannelId, [localParent.id, localThread.id]),
  ));
  assert.ok(suppressions.some((row) => (
    row.targetChannelId === localParent.id
    && row.sourceChannelId === canonicalParent.id
    && String(row.doneThroughSeq) === "20"
  )));
  assert.ok(suppressions.some((row) => (
    row.targetChannelId === localThread.id
    && row.sourceChannelId === canonicalThread.id
    && String(row.doneThroughSeq) === "21"
  )));
  const [localFollow] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, localThread.id),
    eq(threadFollows.followerId, owner.id),
  ));
  assert.ok(localFollow?.doneAt);
});

test("joint-thread Done guard never translates a receiver-local display fact", async ({ db }) => {
  const { owner, server } = await seedFixture();
  const [parentChannel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: "legacy-thread-parent",
    type: "channel",
  }).returning();
  const [parent] = await getDb().insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "legacy thread parent",
    seq: 11_426_000,
  }).returning();
  const [canonicalThread, localThread] = await getDb().insert(channels).values([
    {
      serverId: server.id,
      name: "legacy-thread-canonical",
      type: "thread",
      parentMessageId: parent.id,
    },
    { serverId: server.id, name: "legacy-thread-local", type: "thread" },
  ]).returning();
  const [joint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: server.id,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await getDb().insert(threadFollows).values({
    threadChannelId: localThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "authored",
  });
  await getDb().insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: owner.id,
    content: "canonical thread frontier",
    seq: 11_426_997,
  });
  const [incidentLocalMessage, laterLocalMessage] = await getDb().insert(messages).values([
    {
      channelId: localThread.id,
      senderType: "user",
      senderId: owner.id,
      content: "legacy thread display frontier",
      seq: 11_429_659,
    },
    {
      channelId: localThread.id,
      senderType: "user",
      senderId: owner.id,
      content: "legacy thread later display frontier",
      seq: 11_430_000,
    },
  ]).returning();
  await getDb().insert(inboxNotificationFacts).values([
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: localThread.id,
      messageId: incidentLocalMessage.id,
      messageSeq: incidentLocalMessage.seq,
      activityAt: incidentLocalMessage.createdAt,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: localThread.id,
      messageId: laterLocalMessage.id,
      messageSeq: laterLocalMessage.seq,
      activityAt: laterLocalMessage.createdAt,
    },
  ]);

  await assert.rejects(
    () => markThreadDone(owner.id, localThread.id, "11429659"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
    "a durable local fact must not be translated inside the storage guard",
  );

  const storageAck = await markThreadDone(owner.id, localThread.id, "11426997");
  assert.equal(storageAck.terminalReason, "effect_applied");

  await assert.rejects(
    () => markThreadDone(owner.id, localThread.id, "11430001"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
    "a value above both proven spaces retains the strict 409 class",
  );
  await assert.rejects(
    () => markThreadDone(owner.id, localThread.id, "11429660"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
    "the guard applies only the canonical storage latest",
  );
});

test("joint-channel Done guard accepts only the incident's canonical storage frontier", async ({ db }) => {
  const { owner, server } = await seedFixture();
  const [canonical, local] = await getDb().insert(channels).values([
    { serverId: server.id, name: "incident-canonical", type: "joint" },
    { serverId: server.id, name: "incident-local", type: "joint" },
  ]).returning();
  await getDb().insert(channelHumans).values({ channelId: local.id, userId: owner.id });
  const [joint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: server.id,
    localChannelId: local.id,
    role: "host",
    status: "active",
  });

  const [canonicalMessage] = await getDb().insert(messages).values({
    channelId: canonical.id,
    senderType: "user",
    senderId: owner.id,
    content: "canonical guard frontier",
    seq: 11_426_997,
  }).returning();
  const [incidentLocalMessage, laterLocalMessage] = await getDb().insert(messages).values([
    {
      channelId: local.id,
      senderType: "user",
      senderId: owner.id,
      content: "incident display frontier",
      seq: 11_429_659,
    },
    {
      channelId: local.id,
      senderType: "user",
      senderId: owner.id,
      content: "benign race after panel render",
      seq: 11_430_000,
    },
  ]).returning();
  assert.ok(canonicalMessage && incidentLocalMessage && laterLocalMessage);
  await getDb().insert(inboxNotificationFacts).values([
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: local.id,
      messageId: incidentLocalMessage.id,
      messageSeq: incidentLocalMessage.seq,
      activityAt: incidentLocalMessage.createdAt,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: local.id,
      messageId: laterLocalMessage.id,
      messageSeq: laterLocalMessage.seq,
      activityAt: laterLocalMessage.createdAt,
    },
  ]);

  await assert.rejects(
    () => markChannelInboxDone(owner.id, local.id, "11429659"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
    "the exact receiver-local fact must not be translated inside the guard",
  );
  const ack = await markChannelInboxDone(owner.id, local.id, "11426997");
  assert.equal(ack.terminalReason, "effect_applied");
  assert.equal(
    await readDoneThroughExact(local.id, owner.id),
    "11426997",
    "the accepted frontier is already in canonical storage space",
  );

  await assert.rejects(
    () => markChannelInboxDone(owner.id, local.id, "11430001"),
    (error: unknown) => (
      error instanceof DoneFrontierBeyondLatestError
      && error.code === "DONE_FRONTIER_BEYOND_LATEST"
    ),
    "a value truly beyond canonical storage remains the strict 409 class",
  );
  await assert.rejects(
    () => markChannelInboxDone(owner.id, local.id, "11429660"),
    (error: unknown) => error instanceof DoneFrontierBeyondLatestError,
    "the guard has no display-space gap state",
  );
});

test("a post-SQL failure rolls back Done marker, cursor, and suppression together", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: withMessages.id,
      throughSeq: "3",
    },
  });
  const claim = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "done-rollback-worker",
    leaseMs: 60_000,
  });
  assert.ok(claim);
  await assert.rejects(
    executeReadMutationClaim({ claim, failpoint: "after_sql_before_commit" }),
    /failpoint/i,
  );

  assert.equal((await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, withMessages.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, withMessages.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, owner.id),
    eq(inboxSuppressionStates.targetChannelId, withMessages.id),
  ))).length, 0);
});

test("a cursor-phase failure rolls back the marker and leaves suppression unwritten", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId: randomUUID(),
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: withMessages.id,
      throughSeq: "3",
    },
  });
  const claim = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "done-cursor-failure-worker",
    leaseMs: 60_000,
  });
  assert.ok(claim);
  await assert.rejects(
    executeReadMutationClaim({
      claim,
      afterScopeCursorLocked: async () => {
        throw new Error("injected cursor-phase failure");
      },
    }),
    /cursor-phase failure/,
  );

  assert.equal((await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, withMessages.id),
  ))).length, 0, "the earlier Done marker must roll back");
  assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, withMessages.id),
  ))).length, 0, "the failing cursor phase must commit no cursor");
  assert.equal((await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, owner.id),
    eq(inboxSuppressionStates.targetChannelId, withMessages.id),
  ))).length, 0, "suppression is ordered after the cursor and must remain absent");
});

test("a worker-side latest regression terminalizes with zero composite effect", async ({ db }) => {
  const { owner, server, withMessages } = await seedFixture();
  const mutationId = randomUUID();
  await admitReadMutation({
    serverId: server.id,
    principalId: owner.id,
    mutationId,
    mutation: {
      kind: "done",
      targetKind: "channel",
      scopeId: withMessages.id,
      throughSeq: "3",
    },
  });
  await getDb().delete(messages).where(and(
    eq(messages.channelId, withMessages.id),
    eq(messages.seq, 3),
  ));
  const claim = await claimNextReadMutation({
    serverId: server.id,
    principalId: owner.id,
    leaseOwner: "done-latest-regression-worker",
    leaseMs: 60_000,
  });
  assert.ok(claim);

  const ack = await executeReadMutationClaim({ claim });
  assert.equal(ack.terminalState, "retired_no_effect");
  assert.equal(ack.terminalReason, "done_frontier_beyond_latest");
  assert.deepEqual(ack.capturedBoundary, []);
  assert.deepEqual(ack.scopes, []);

  const [terminal] = await getDb().select().from(readMutations).where(and(
    eq(readMutations.serverId, server.id),
    eq(readMutations.principalId, owner.id),
    eq(readMutations.mutationId, mutationId),
  ));
  assert.equal(terminal?.state, "retired_no_effect");
  assert.equal(terminal?.terminalReason, "done_frontier_beyond_latest");
  assert.equal((await getDb().select().from(userChannelInboxStates).where(and(
    eq(userChannelInboxStates.userId, owner.id),
    eq(userChannelInboxStates.channelId, withMessages.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(userChannelReadCursors).where(and(
    eq(userChannelReadCursors.userId, owner.id),
    eq(userChannelReadCursors.channelId, withMessages.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, owner.id),
    eq(inboxSuppressionStates.targetChannelId, withMessages.id),
  ))).length, 0);
});
