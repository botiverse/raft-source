// Task #64: the boundary of every admitted residue scope is derived only from
// receiver-owned data and never from the channel's live state (@Tenny's ruling,
// #wg-rbac task #102). Each cell loses access, posts newer activity, then checks
// every surface the boundary reaches: the sequenced ack, its replay, the stored
// cursor, and the compatibility bridge that HTTP read-all uses.
//
// Every cell asserts the resolved authority branch BEFORE any boundary value, so
// a passing cell proves the intended branch ran rather than a neighbouring one
// that happens to be bounded.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agentChannelReadCursors,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messages,
  readMutations,
  serverMembers,
  servers,
  userChannelReadCursors,
  users,
} from "../db/schema";
import { createAgent } from "./agentService";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeCompatibilityReadMutation,
  executeReadMutationClaim,
  inspectChannelReadAllScopeAuthorityForTests,
  READ_SCOPE_RESIDUE_REASONS,
  type ReadMutationPrincipalKind,
} from "./readMutationSequencer";

type ScopeShape =
  | "private"
  | "dm"
  | "joint"
  | "thread_under_private"
  | "thread_only_residue"
  | "thread_never_member"
  | "deleted_private"
  | "thread_parent_deleted";
type ReceiverData = "cursor" | "facts" | "both";
type ExpectedAuthority = "lost_access" | "deleted_inbox" | "unavailable_thread_parent";

const EXPECTED_AUTHORITY: Record<ScopeShape, ExpectedAuthority> = {
  private: "lost_access",
  dm: "lost_access",
  joint: "lost_access",
  thread_under_private: "lost_access",
  // Task #66. Two populations reach a thread scope on the receiver's OWN rows,
  // with no residue on the parent at all. Both are named here rather than left
  // implicit under the same `lost_access` value, so that tightening admission
  // later shows exactly which group it costs (Tenny's requirement on #66).
  //   thread_only_residue  -- was a parent participant, removed, residue only on the thread
  //   thread_never_member  -- NEVER had parent access; owns thread rows because it was
  //                           @-mentioned there. `lost_access` is a slight misnomer for it;
  //                           the reason value is deliberately reused (see the sequencer).
  thread_only_residue: "lost_access",
  thread_never_member: "lost_access",
  deleted_private: "deleted_inbox",
  thread_parent_deleted: "unavailable_thread_parent",
};

/** Thread shapes whose parent channel still exists (the thread itself is the scope). */
const THREAD_UNDER_PARENT_SHAPES: ScopeShape[] = [
  "thread_under_private",
  "thread_only_residue",
  "thread_never_member",
];

/** What the receiver owned before losing access. Every returned or stored value must stay at or below it. */
const RECEIVER_OWNED_MAX = 2;
/** Activity posted after access was lost; the channel's live max ends here. */
const LIVE_MAX = 5;

async function seedServer() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `residue-owner-${randomUUID()}@test.invalid`,
    name: `ResidueOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Residue Boundary",
    slug: `residue-boundary-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  return { owner, server };
}

async function seedPrincipal(kind: ReadMutationPrincipalKind, serverId: string, ownerId: string) {
  if (kind === "agent") {
    const agent = await createAgent(serverId, `residue-agent-${randomUUID().slice(0, 8)}`, {
      runtime: "codex",
      creatorType: "user",
      creatorId: ownerId,
    });
    return agent.id;
  }
  const [user] = await getDb().insert(users).values({
    email: `residue-receiver-${randomUUID()}@test.invalid`,
    name: `ResidueReceiver${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  await getDb().insert(serverMembers).values({ serverId, userId: user.id, role: "member" });
  return user.id;
}

async function addParticipant(kind: ReadMutationPrincipalKind, channelId: string, principalId: string) {
  if (kind === "agent") await getDb().insert(channelAgents).values({ channelId, agentId: principalId });
  else await getDb().insert(channelHumans).values({ channelId, userId: principalId });
}

async function removeParticipant(kind: ReadMutationPrincipalKind, channelId: string, principalId: string) {
  if (kind === "agent") {
    await getDb().delete(channelAgents).where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, principalId)));
  } else {
    await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, principalId)));
  }
}

async function postMessages(channelId: string, senderId: string, seqs: number[]) {
  return getDb().insert(messages).values(seqs.map((seq) => ({
    channelId,
    senderType: "user" as const,
    senderId,
    content: `seq ${seq}`,
    seq,
  }))).returning();
}

/**
 * Builds one scope shape with the receiver as a participant, gives the receiver
 * residue at RECEIVER_OWNED_MAX, removes access the way that shape loses it, then
 * posts newer activity up to LIVE_MAX.
 */
async function seedResidueScope(input: {
  shape: ScopeShape;
  principalKind: ReadMutationPrincipalKind;
  receiverData: ReceiverData;
  pollutedCursorSeq?: number;
}) {
  const db = getDb();
  const { owner, server } = await seedServer();
  const principalId = await seedPrincipal(input.principalKind, server.id, owner.id);
  let scopeId: string;
  let storageId: string;
  let accessId: string;
  let factKind: "channel" | "dm" | "thread" = "channel";

  if (input.shape === "joint") {
    const [canonical, local] = await db.insert(channels).values([
      { serverId: server.id, name: `joint-storage-${randomUUID()}`, type: "joint" },
      { serverId: server.id, name: `joint-local-${randomUUID()}`, type: "joint" },
    ]).returning();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonical.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
      status: "active",
    }).returning();
    await db.insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: server.id,
      localChannelId: local.id,
      role: "host",
      status: "active",
    });
    scopeId = local.id;
    storageId = canonical.id;
    accessId = local.id;
  } else if (THREAD_UNDER_PARENT_SHAPES.includes(input.shape) || input.shape === "thread_parent_deleted") {
    const [parent] = await db.insert(channels).values({
      serverId: server.id,
      name: `thread-parent-${randomUUID().slice(0, 8)}`,
      type: input.shape === "thread_parent_deleted" ? "channel" : "private",
    }).returning();
    const [parentMessage] = await postMessages(parent.id, owner.id, [100]);
    const [thread] = await db.insert(channels).values({
      serverId: server.id,
      name: `thread-${randomUUID().slice(0, 8)}`,
      type: "thread",
      parentMessageId: parentMessage.id,
    }).returning();
    scopeId = thread.id;
    storageId = thread.id;
    accessId = parent.id;
    factKind = "thread";
  } else {
    const [channel] = await db.insert(channels).values({
      serverId: server.id,
      name: `residue-${input.shape}-${randomUUID().slice(0, 8)}`,
      type: input.shape === "dm" ? "dm" : "private",
    }).returning();
    scopeId = channel.id;
    storageId = channel.id;
    accessId = channel.id;
    if (input.shape === "dm") factKind = "dm";
  }

  // `thread_never_member` is never added to the parent at all: its only claim is
  // the rows it owns on the thread. `thread_parent_deleted` loses its parent instead.
  const participantChannelId = input.shape === "thread_parent_deleted" || input.shape === "thread_never_member"
    ? null
    : accessId;
  if (participantChannelId) await addParticipant(input.principalKind, participantChannelId, principalId);
  if (input.shape === "thread_under_private") {
    // A thread under a private parent is admitted on residue evidence for the PARENT
    // (the access channel), not for the thread itself. Give the receiver the parent
    // residue a former member really has, so the thread scope reaches lost_access.
    if (input.principalKind === "agent") {
      await db.insert(agentChannelReadCursors).values({ agentId: principalId, channelId: accessId, lastReadSeq: 100 });
    } else {
      await db.insert(userChannelReadCursors).values({ userId: principalId, channelId: accessId, lastReadSeq: 100 });
    }
  }

  const seen = await postMessages(storageId, owner.id, [1, RECEIVER_OWNED_MAX]);
  const lastSeen = seen[seen.length - 1];
  if (input.receiverData === "cursor" || input.receiverData === "both" || input.pollutedCursorSeq != null) {
    const lastReadSeq = input.pollutedCursorSeq ?? RECEIVER_OWNED_MAX;
    if (input.principalKind === "agent") {
      await db.insert(agentChannelReadCursors).values({ agentId: principalId, channelId: scopeId, lastReadSeq });
    } else {
      await db.insert(userChannelReadCursors).values({ userId: principalId, channelId: scopeId, lastReadSeq });
    }
  }
  if (input.receiverData === "facts" || input.receiverData === "both") {
    await db.insert(inboxNotificationFacts).values({
      receiverType: input.principalKind === "agent" ? "agent" : "user",
      receiverId: principalId,
      serverId: server.id,
      kind: factKind,
      sourceChannelId: scopeId,
      messageId: lastSeen.id,
      messageSeq: RECEIVER_OWNED_MAX,
      activityAt: new Date(),
    });
  }

  if (input.shape === "deleted_private") {
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, scopeId));
  } else if (input.shape === "thread_parent_deleted") {
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, accessId));
  } else if (input.shape === "thread_never_member") {
    // Nothing to remove: this receiver never held parent access in the first place.
  } else {
    await removeParticipant(input.principalKind, accessId, principalId);
  }

  const newerSeqs: number[] = [];
  for (let seq = RECEIVER_OWNED_MAX + 1; seq <= LIVE_MAX; seq += 1) newerSeqs.push(seq);
  await postMessages(storageId, owner.id, newerSeqs);

  return { serverId: server.id, principalId, scopeId };
}

async function readCursor(kind: ReadMutationPrincipalKind, principalId: string, scopeId: string): Promise<number> {
  const rows = kind === "agent"
    ? await getDb().select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, principalId), eq(agentChannelReadCursors.channelId, scopeId)))
    : await getDb().select({ seq: userChannelReadCursors.lastReadSeq }).from(userChannelReadCursors)
      .where(and(eq(userChannelReadCursors.userId, principalId), eq(userChannelReadCursors.channelId, scopeId)));
  return rows[0]?.seq ?? 0;
}

type AckLike = {
  capturedBoundary?: Array<{ scopeId: string; throughSeq: number | string }>;
  scopes?: Array<{ scopeId: string; maxReadSeq?: number }>;
};

/**
 * ⚠️ This helper is the whole point of the file, so it must not be able to pass by finding nothing.
 *
 * It previously walked `capturedBoundary ?? []` and `scopes ?? []` and skipped any scope whose
 * `maxReadSeq` was null. Every one of those is a silent exit: if the ack stopped carrying a
 * boundary, stopped carrying scopes, or started emitting a null cursor, the loops would run zero
 * times and the test would go green while asserting nothing about the leak it exists to catch.
 *
 * ⭐ `ReadMutationAck` declares BOTH fields required, and `scopes[].maxReadSeq` as a plain `number`.
 * So "absent" and "null" are not tolerable shapes to skip past — they are exactly the regression.
 * The local `AckLike` only widens them to optional because this test also reads rows back out of
 * jsonb, where the compiler cannot vouch for what was stored.
 *
 * Returns how many values it actually compared, so callers can refuse a vacuous pass.
 */
function assertAckBounded(
  ack: AckLike | null | undefined,
  ceiling: number,
  label: string,
): { boundaries: number; scopes: number } {
  assert.ok(ack, `${label}: an ack is returned`);
  assert.ok(
    Array.isArray(ack.capturedBoundary),
    `${label}: the ack must still CARRY capturedBoundary — a missing field would skip every bound check below`,
  );
  assert.ok(
    Array.isArray(ack.scopes),
    `${label}: the ack must still CARRY scopes — a missing field would skip every bound check below`,
  );
  for (const boundary of ack.capturedBoundary!) {
    assert.ok(
      Number(boundary.throughSeq) <= ceiling,
      `${label}: capturedBoundary.throughSeq ${boundary.throughSeq} exceeds receiver-owned max ${ceiling} (live max ${LIVE_MAX})`,
    );
  }
  for (const scope of ack.scopes!) {
    // ⛔ Not `continue`: ReadMutationAck says this is a required number. A null here is a real
    // regression in what the sequencer emits, and skipping it is how that regression ships green.
    assert.ok(
      scope.maxReadSeq != null,
      `${label}: scopes[${scope.scopeId}].maxReadSeq is missing; the ack contract declares it required`,
    );
    assert.ok(
      scope.maxReadSeq <= ceiling,
      `${label}: scopes[].maxReadSeq ${scope.maxReadSeq} exceeds receiver-owned max ${ceiling} (live max ${LIVE_MAX})`,
    );
  }
  /**
   * ⭐ §5 observable behaviour: prove the DE-AUTHORIZED branch actually ran, not merely that the
   * numbers came out small (@Tenny: "a green must mean the lost-access branch was really taken").
   *
   * Every principal in this file has lost access, so every scope entry here must be the closed
   * rebuild `residueScopeAck` produces -- exactly these five keys. The live path returns the
   * applied scope object as-is; only the residue path reconstructs it. So an entry carrying any
   * extra key is the live object leaking to a caller who is no longer entitled to it, which is
   * the leak this whole file exists to stop.
   *
   * ⛔ This is why residueScopeAck is a rebuild and not `{ ...applied, maxReadSeq }`: a spread
   * would forward every future field automatically, and no bound check would notice.
   */
  const RESIDUE_SCOPE_KEYS = ["scopeId", "maxReadSeq", "readStateVersion", "lastAppliedAuthoritySeq", "changed"];
  for (const scope of ack.scopes!) {
    assert.deepEqual(
      Object.keys(scope).sort(),
      [...RESIDUE_SCOPE_KEYS].sort(),
      `${label}: a de-authorized scope entry must be the closed residue rebuild, got keys `
      + `[${Object.keys(scope).sort().join(", ")}] — an extra key means the live object was forwarded`,
    );
  }

  // ⭐ Non-vacuity. Every call site in this file acts on exactly one scope, so both arrays carry
  // one entry (measured: boundaries=1 scopes=1 at all five call sites). An empty array would mean
  // the loops above compared nothing -- the same silent pass, one level further in.
  assert.ok(
    ack.capturedBoundary!.length > 0 && ack.scopes!.length > 0,
    `${label}: the ack carried boundaries=${ack.capturedBoundary!.length} scopes=${ack.scopes!.length}; `
    + "an empty array means this check compared NOTHING, which is not a pass",
  );
  return { boundaries: ack.capturedBoundary!.length, scopes: ack.scopes!.length };
}

const SHAPES: ScopeShape[] = [
  "private",
  "dm",
  "joint",
  "thread_under_private",
  "thread_only_residue",
  "thread_never_member",
  "deleted_private",
  "thread_parent_deleted",
];
const PRINCIPALS: ReadMutationPrincipalKind[] = ["human", "agent"];
const RECEIVER_DATA: ReceiverData[] = ["cursor", "facts", "both"];

// Each data variant gets a fresh server, principal and scope. Only the
// database lifecycle is shared within one shape/principal/operation group.
for (const shape of SHAPES) {
  for (const principalKind of PRINCIPALS) {
    const group = `${EXPECTED_AUTHORITY[shape]} / ${shape} / ${principalKind}`;

    test(`task #64 sequenced read-all stays within receiver-owned data: ${group}`, async ({ db }) => {
      assert.ok(db, "the database fixture is initialized");
      for (const receiverData of RECEIVER_DATA) {
        const cell = `${group} / ${receiverData}`;
        const seeded = await seedResidueScope({ shape, principalKind, receiverData });
        const authority = await inspectChannelReadAllScopeAuthorityForTests({ ...seeded, principalKind });
        assert.equal(authority, EXPECTED_AUTHORITY[shape], `${cell}: the intended residue branch resolves`);

        const mutationId = randomUUID();
        const admission = await admitReadMutation({
          serverId: seeded.serverId,
          principalKind,
          principalId: seeded.principalId,
          mutationId,
          mutation: { kind: "channel_read_all", scopeId: seeded.scopeId },
        });
        assert.equal(admission.outcome, "ADMITTED", `${cell}: admission`);
        const claim = await claimNextReadMutation({
          serverId: seeded.serverId,
          principalKind,
          principalId: seeded.principalId,
          leaseOwner: "task64",
          leaseMs: 60_000,
        });
        assert.ok(claim, `${cell}: the admitted mutation is claimable`);
        const ack = await executeReadMutationClaim({ claim });
        assertAckBounded(ack, RECEIVER_OWNED_MAX, `${cell}: applied ack`);

        const replay = await admitReadMutation({
          serverId: seeded.serverId,
          principalKind,
          principalId: seeded.principalId,
          mutationId,
          mutation: { kind: "channel_read_all", scopeId: seeded.scopeId },
        });
        assert.equal(replay.outcome, "ALREADY_TERMINAL", `${cell}: replay`);
        assertAckBounded(replay.ack as AckLike, RECEIVER_OWNED_MAX, `${cell}: replayed ack`);

        const cursor = await readCursor(principalKind, seeded.principalId, seeded.scopeId);
        assert.ok(cursor <= RECEIVER_OWNED_MAX, `${cell}: stored cursor ${cursor} exceeds receiver-owned max ${RECEIVER_OWNED_MAX}`);
      }
    });

    test(`task #64 compatibility read-all (HTTP read-all path) stays within receiver-owned data: ${group}`, async ({ db }) => {
      assert.ok(db, "the database fixture is initialized");
      for (const receiverData of RECEIVER_DATA) {
        const cell = `${group} / ${receiverData}`;
        const seeded = await seedResidueScope({ shape, principalKind, receiverData });
        const authority = await inspectChannelReadAllScopeAuthorityForTests({ ...seeded, principalKind });
        assert.equal(authority, EXPECTED_AUTHORITY[shape], `${cell}: the intended residue branch resolves`);

        const ack = await executeCompatibilityReadMutation({
          serverId: seeded.serverId,
          principalKind,
          principalId: seeded.principalId,
          mutation: { kind: "channel_read_all", scopeId: seeded.scopeId },
        });
        assertAckBounded(ack, RECEIVER_OWNED_MAX, `${cell}: compatibility ack`);
        const cursor = await readCursor(principalKind, seeded.principalId, seeded.scopeId);
        assert.ok(cursor <= RECEIVER_OWNED_MAX, `${cell}: stored cursor ${cursor} exceeds receiver-owned max ${RECEIVER_OWNED_MAX}`);
      }
    });
  }
}

test("task #64 a polluted cursor is not laundered into receiver-owned data", async ({ db }) => {
        assert.ok(db, "the database fixture is initialized");
  // Residue from the defect: the cursor already holds a value the receiver never owned.
  const pollutedCursorSeq = 4;
  const seeded = await seedResidueScope({
    shape: "private",
    principalKind: "human",
    receiverData: "facts",
    pollutedCursorSeq,
  });
  const authority = await inspectChannelReadAllScopeAuthorityForTests({ ...seeded, principalKind: "human" });
  assert.equal(authority, "lost_access");

  const ack = await executeCompatibilityReadMutation({
    serverId: seeded.serverId,
    principalKind: "human",
    principalId: seeded.principalId,
    mutation: { kind: "channel_read_all", scopeId: seeded.scopeId },
  });
  // The ceiling is the receiver's notification data, not the cursor the defect wrote.
  assertAckBounded(ack, RECEIVER_OWNED_MAX, "ack over a polluted cursor");
});

test("task #64 every residue reason has boundary cells (closed list)", async () => {
  const covered = new Set(Object.values(EXPECTED_AUTHORITY));
  for (const reason of READ_SCOPE_RESIDUE_REASONS) {
    assert.ok(covered.has(reason), `residue reason ${reason} has no boundary matrix cell`);
  }
  assert.equal(covered.size, READ_SCOPE_RESIDUE_REASONS.length, "the matrix names no reason the resolver cannot return");
});

test("task #64 replaying an ack stored with the live frontier returns receiver-owned values without rewriting the row", async ({ db }) => {
  assert.ok(db, "the database fixture is initialized");
  const { owner, server } = await seedServer();
  const principalId = await seedPrincipal("human", server.id, owner.id);
  const [channel] = await getDb().insert(channels).values({ serverId: server.id, name: `stored-ack-${randomUUID().slice(0, 8)}`, type: "private" }).returning();
  await addParticipant("human", channel.id, principalId);
  const seen = await postMessages(channel.id, owner.id, [1, RECEIVER_OWNED_MAX]);
  await getDb().insert(inboxNotificationFacts).values({
    receiverType: "user",
    receiverId: principalId,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: seen[1].id,
    messageSeq: RECEIVER_OWNED_MAX,
    activityAt: new Date(),
  });
  await postMessages(channel.id, owner.id, [3, 4, LIVE_MAX]);

  // While still a member the read-all is legitimately live and its ack is stored.
  const mutationId = randomUUID();
  await admitReadMutation({ serverId: server.id, principalId, mutationId, mutation: { kind: "channel_read_all", scopeId: channel.id } });
  const claim = await claimNextReadMutation({ serverId: server.id, principalId, leaseOwner: "task64-stored", leaseMs: 60_000 });
  assert.ok(claim);
  const liveAck = await executeReadMutationClaim({ claim });
  assert.equal(Number(liveAck.capturedBoundary[0]?.throughSeq), LIVE_MAX, "precondition: a member's ack carries the live frontier");

  await removeParticipant("human", channel.id, principalId);
  assert.equal(await inspectChannelReadAllScopeAuthorityForTests({ serverId: server.id, principalKind: "human", principalId, scopeId: channel.id }), "lost_access");

  const replay = await admitReadMutation({ serverId: server.id, principalId, mutationId, mutation: { kind: "channel_read_all", scopeId: channel.id } });
  assert.equal(replay.outcome, "ALREADY_TERMINAL");
  assertAckBounded(replay.ack as AckLike, RECEIVER_OWNED_MAX, "replay after losing access");

  const [stored] = await getDb().select({ ack: readMutations.ack, terminalDigest: readMutations.terminalDigest })
    .from(readMutations)
    .where(and(eq(readMutations.principalId, principalId), eq(readMutations.mutationId, mutationId)));
  const storedBoundary = (stored?.ack as AckLike | null)?.capturedBoundary?.[0]?.throughSeq;
  assert.equal(Number(storedBoundary), LIVE_MAX, "the stored ack is filtered on return, never rewritten");

  /**
   * ⭐ Task #64 decision Q3: the digest pairing. The sequencer notes that a filtered ack no longer
   * matches the stored terminalDigest and that "nothing verifies that pairing" -- this is that check.
   *
   * ⚠️ It deliberately does NOT try to recompute the digest from the stored row. `readMutations.ack`
   * is `jsonb`, and PostgreSQL normalises jsonb key order (shortest key first, then bytewise), so the
   * byte sequence the digest was taken over no longer exists once the row is read back. Measured:
   *   stored key order -> kind,scopes,serverId,mutationId,payloadHash,principalId,...
   *   recomputed sha256 8482a78c... != stored 675a5152...
   * ⛔ So `digest(storedAck) === terminalDigest` can never hold and must not be asserted; it would be
   * a test that fails for a reason that has nothing to do with the property under test.
   *
   * What IS verifiable, and is the property this test is named for: the digest minted when the
   * mutation terminalized must still be the one on the row AND the one replay hands back, even
   * though this replay returned a bounded ack. Equal on both sides -- ⛔ not a `!=` assertion, which
   * would pass for any two different strings.
   */
  assert.ok(liveAck.terminalDigest, "precondition: terminalizing minted a digest");
  assert.equal(
    stored?.terminalDigest,
    liveAck.terminalDigest,
    "the bounded replay must not re-mint the stored digest — the row is evidence of past exposure",
  );
  assert.equal(
    replay.terminalDigest,
    liveAck.terminalDigest,
    "replay must hand back the ORIGINAL terminal digest, not one describing the bounded ack it returned",
  );
});

// Task #66 control. Widening thread admission must not admit anyone whose claim
// is not their OWN residue ON THAT SCOPE. Two strangers are checked: one with no
// receiver-owned rows at all, and one whose rows sit on an unrelated channel.
// The second is the one that fails if the new OR is ever written scope-blind.
test("task #66 a stranger to the thread is still refused, with or without residue elsewhere", async ({ db }) => {
  assert.ok(db, "the database fixture is initialized");
  const { owner, server } = await seedServer();

  const [parent] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `t66-parent-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  const [parentMessage] = await postMessages(parent.id, owner.id, [100]);
  const [thread] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `t66-thread-${randomUUID().slice(0, 8)}`,
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  await postMessages(thread.id, owner.id, [1, RECEIVER_OWNED_MAX, LIVE_MAX]);

  for (const principalKind of PRINCIPALS) {
    const bare = await seedPrincipal(principalKind, server.id, owner.id);
    assert.equal(
      await inspectChannelReadAllScopeAuthorityForTests({
        serverId: server.id,
        principalKind,
        principalId: bare,
        scopeId: thread.id,
      }),
      null,
      `${principalKind}: a stranger with no receiver-owned rows resolves no authority`,
    );

    // Same stranger, but they do own residue -- on a different channel entirely.
    const elsewhere = await seedPrincipal(principalKind, server.id, owner.id);
    const [other] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `t66-other-${randomUUID().slice(0, 8)}`,
      type: "private",
    }).returning();
    const otherSeen = await postMessages(other.id, owner.id, [1, RECEIVER_OWNED_MAX]);
    await getDb().insert(inboxNotificationFacts).values({
      receiverType: principalKind === "agent" ? "agent" : "user",
      receiverId: elsewhere,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: other.id,
      messageId: otherSeen[otherSeen.length - 1].id,
      messageSeq: RECEIVER_OWNED_MAX,
      activityAt: new Date(),
    });
    assert.equal(
      await inspectChannelReadAllScopeAuthorityForTests({
        serverId: server.id,
        principalKind,
        principalId: elsewhere,
        scopeId: thread.id,
      }),
      null,
      `${principalKind}: residue on an unrelated channel grants nothing on this thread`,
    );
  }
});
